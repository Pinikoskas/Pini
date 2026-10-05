"""Facebook DJ agent.

Opens a real Chromium window with your own Facebook login, scrolls the feed (and any
groups listed in config.yaml), and for every post where someone is looking for a DJ
and the post is less than a week old:
  1. writes a comment on the post
  2. sends the author a Messenger message
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import random
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yaml
from playwright.sync_api import BrowserContext, Locator, Page, sync_playwright

from .matcher import PostMatcher
from .post_age import parse_post_age
from .storage import Storage

log = logging.getLogger("dj_agent")

POST_SELECTOR = '[role="article"], div[aria-posinset], div[data-pagelet^="FeedUnit"]'

# Finds new top-level posts on the page, tags them with data-djbot-id and returns the ids.
# Nested articles (comments inside a post) are ignored.
JS_NEW_POSTS = """
(selector) => {
  const out = [];
  let n = window.__djbotCounter || 0;
  for (const el of document.querySelectorAll(selector)) {
    if (el.dataset.djbotId) continue;
    const parent = el.parentElement && el.parentElement.closest(selector);
    if (parent) continue;
    if ((el.innerText || '').trim().length < 30) continue;  // still loading
    el.dataset.djbotId = String(++n);
    out.push(String(n));
  }
  window.__djbotCounter = n;
  return out;
}
"""

JS_EXPAND_SEE_MORE = """
(el) => {
  const labels = ['See more', 'ראה עוד', 'הצג עוד', 'ראו עוד', 'עוד'];
  for (const b of el.querySelectorAll('div[role="button"], span[role="button"]')) {
    if (labels.includes((b.innerText || '').trim())) b.click();
  }
}
"""

JS_POST_INFO = """
(el) => {
  const body = el.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
  const authorA = el.querySelector('h2 a[href], h3 a[href], h4 a[href], strong a[href]');
  const tsRe = /\\/posts\\/|\\/permalink|story_fbid|\\/videos\\/|\\/photo|\\/reel\\/|multi_permalinks|pfbid/;
  const stamps = [];
  let i = 0;
  for (const a of el.querySelectorAll('a[href]')) {
    if (!tsRe.test(a.href)) continue;
    if (a.closest('[role="article"]') !== el && el.matches('[role="article"]')) continue;
    a.dataset.djbotTs = String(i++);
    stamps.push({href: a.href, label: a.getAttribute('aria-label') || '', text: (a.innerText || '').trim()});
    if (i >= 6) break;
  }
  return {
    body: body ? body.innerText : '',
    full: el.innerText || '',
    authorName: authorA ? authorA.innerText.trim() : '',
    authorHref: authorA ? authorA.href : '',
    stamps,
  };
}
"""

COMMENT_BUTTON_LABELS = [
    "Leave a comment", "Comment", "Write a comment", "השארת תגובה", "כתיבת תגובה",
    "הגב", "תגובה", "השאר תגובה", "השאירו תגובה",
]
MESSAGE_BUTTON_NAMES = re.compile(r"^(Message|Send message|הודעה|שליחת הודעה|שלח הודעה)$")


@dataclass
class Post:
    locator: Locator
    key: str
    url: str
    text: str
    author_name: str
    author_url: str
    age_text: str


def human_sleep(rng: tuple[float, float]) -> None:
    time.sleep(random.uniform(*rng))


def human_type(page: Page, text: str) -> None:
    """Type like a person; newlines become Shift+Enter so the message isn't sent early."""
    lines = text.strip().split("\n")
    for i, line in enumerate(lines):
        page.keyboard.type(line, delay=random.randint(35, 110))
        if i < len(lines) - 1:
            page.keyboard.press("Shift+Enter")


def first_name(full: str) -> str:
    return full.split()[0] if full.strip() else ""


def fill_template(template: str, author_name: str) -> str:
    name = first_name(author_name)
    text = template.replace("{name}", name)
    # If we don't know the name, drop the dangling space: "היי !" -> "היי!"
    return re.sub(r" +([!,.])", r"\1", text).strip()


def canonical_post_url(href: str) -> str:
    u = urlparse(href)
    qs = parse_qs(u.query)
    keep = {k: qs[k][0] for k in ("story_fbid", "id", "fbid", "v") if k in qs}
    query = "&".join(f"{k}={v}" for k, v in keep.items())
    return f"https://www.facebook.com{u.path.rstrip('/')}" + (f"?{query}" if query else "")


def canonical_profile_url(href: str) -> str:
    if not href:
        return ""
    u = urlparse(href)
    m = re.search(r"/groups/[^/]+/user/(\d+)", u.path)
    if m:
        return f"https://www.facebook.com/profile.php?id={m.group(1)}"
    if u.path.startswith("/profile.php"):
        uid = parse_qs(u.query).get("id", [""])[0]
        return f"https://www.facebook.com/profile.php?id={uid}" if uid else ""
    path = u.path.strip("/").split("/")[0]
    if not path or path in ("groups", "watch", "events", "photo", "stories", "reel", "hashtag"):
        return ""
    return f"https://www.facebook.com/{path}"


def numeric_user_id(profile_url: str) -> str | None:
    m = re.search(r"profile\.php\?id=(\d+)", profile_url)
    return m.group(1) if m else None


class DJAgent:
    def __init__(self, config: dict, mode: str):
        self.cfg = config
        self.mode = mode
        self.matcher = PostMatcher(config.get("include_patterns") or None, config.get("exclude_patterns") or None)
        self.storage = Storage(config["database_file"])
        self.max_age_days = float(config.get("max_post_age_days", 7))
        self.comments_sent = 0
        self.messages_sent = 0
        self.seen_this_run: set[str] = set()
        self.quit = False

    # ---------- browser ----------

    def run(self) -> None:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                user_data_dir=self.cfg["browser_profile_dir"],
                headless=False,
                locale="he-IL",
                viewport={"width": 1280, "height": 900},
                args=["--disable-blink-features=AutomationControlled"],
            )
            page = context.pages[0] if context.pages else context.new_page()
            try:
                self.ensure_logged_in(page)
                for source in self.cfg.get("sources") or ["https://www.facebook.com/"]:
                    if self.quit or self.limits_reached():
                        break
                    self.scan_source(context, page, source)
            finally:
                log.info("סיום. תגובות שנשלחו: %d, הודעות שנשלחו: %d", self.comments_sent, self.messages_sent)
                context.close()

    def ensure_logged_in(self, page: Page) -> None:
        page.goto("https://www.facebook.com/", wait_until="domcontentloaded")
        time.sleep(3)
        if not self.is_login_page(page):
            return
        log.warning("לא מחובר לפייסבוק. התחבר בחלון הדפדפן שנפתח – הסוכן ימשיך לבד אחרי ההתחברות.")
        deadline = time.time() + 600
        while time.time() < deadline:
            time.sleep(3)
            if not self.is_login_page(page):
                log.info("התחברות זוהתה ✔")
                time.sleep(3)
                return
        raise SystemExit("לא בוצעה התחברות תוך 10 דקות.")

    @staticmethod
    def is_login_page(page: Page) -> bool:
        return "login" in page.url or page.locator('input[name="email"], input[name="pass"]').count() > 0

    def limits_reached(self) -> bool:
        if self.mode == "dry_run":
            return False
        comments_done = not self.cfg.get("send_comment") or self.comments_sent >= self.cfg["max_comments_per_run"]
        messages_done = not self.cfg.get("send_messenger") or self.messages_sent >= self.cfg["max_messages_per_run"]
        return comments_done and messages_done

    # ---------- scanning ----------

    def scan_source(self, context: BrowserContext, page: Page, url: str) -> None:
        log.info("סורק: %s", url)
        page.goto(url, wait_until="domcontentloaded")
        time.sleep(4)
        for _ in range(int(self.cfg.get("max_scrolls_per_source", 40))):
            for post_id in page.evaluate(JS_NEW_POSTS, POST_SELECTOR):
                if self.quit or self.limits_reached():
                    return
                try:
                    self.handle_post(context, page, page.locator(f'[data-djbot-id="{post_id}"]'))
                except Exception as e:  # one broken post must not stop the run
                    log.warning("שגיאה בטיפול בפוסט: %s", e)
            page.mouse.wheel(0, random.randint(700, 1300))
            human_sleep(tuple(self.cfg.get("delay_between_scrolls", [3, 7])))

    def read_post(self, page: Page, el: Locator) -> Post | None:
        el.evaluate(JS_EXPAND_SEE_MORE)
        time.sleep(0.5)
        info = el.evaluate(JS_POST_INFO)
        text = info["body"] or info["full"]

        age_text = ""
        for i, stamp in enumerate(info["stamps"]):
            for candidate in (stamp["label"], stamp["text"]):
                if parse_post_age(candidate) is not None:
                    age_text = candidate
                    break
            if not age_text:
                # Facebook often hides the real time in a tooltip; hover to reveal it.
                age_text = self.hover_tooltip(page, el.locator(f'a[data-djbot-ts="{i}"]').first)
                if parse_post_age(age_text) is None:
                    age_text = ""
            if age_text:
                break

        if info["stamps"]:
            url = canonical_post_url(info["stamps"][0]["href"])
            key = url
        else:
            url = ""
            key = "hash:" + hashlib.sha1((info["authorHref"] + text[:300]).encode()).hexdigest()

        return Post(
            locator=el,
            key=key,
            url=url,
            text=text.strip(),
            author_name=info["authorName"],
            author_url=canonical_profile_url(info["authorHref"]),
            age_text=age_text,
        )

    @staticmethod
    def hover_tooltip(page: Page, link: Locator) -> str:
        try:
            link.hover(timeout=3000)
            tip = page.locator('[role="tooltip"]').last
            tip.wait_for(state="visible", timeout=2500)
            text = tip.inner_text().strip()
            page.mouse.move(5, 5)
            return text
        except Exception:
            return ""

    def handle_post(self, context: BrowserContext, page: Page, el: Locator) -> None:
        el.scroll_into_view_if_needed(timeout=5000)
        quick_text = el.inner_text(timeout=5000)
        if not self.matcher.might_match(quick_text):
            return

        post = self.read_post(page, el)
        if not post:
            return
        matched = self.matcher.match(post.text)
        if not matched:
            return
        if post.key in self.seen_this_run:
            return
        self.seen_this_run.add(post.key)

        age = parse_post_age(post.age_text)
        age_desc = post.age_text or "לא ידוע"
        if age is None:
            log.info("⏭  דילוג – לא הצלחתי לזהות מתי הפוסט עלה (%s)", post.author_name)
            return
        if age.total_seconds() >= self.max_age_days * 86400:
            log.info("⏭  דילוג – פוסט ישן (%s): %s", age_desc, post.author_name)
            return
        if self.storage.post_handled(post.key):
            log.info("⏭  דילוג – כבר טיפלנו בפוסט הזה: %s", post.author_name)
            return

        self.print_post(post, matched, age_desc)

        do_comment = bool(self.cfg.get("send_comment")) and self.comments_sent < self.cfg["max_comments_per_run"]
        do_message = (
            bool(self.cfg.get("send_messenger"))
            and self.messages_sent < self.cfg["max_messages_per_run"]
            and bool(post.author_url)
            and not self.storage.author_messaged_recently(post.author_url, self.cfg.get("dont_message_same_person_days", 30))
        )

        if self.mode == "dry_run":
            log.info("   [dry_run] היה נשלח: תגובה=%s, הודעה=%s", do_comment, do_message)
            return

        if self.mode == "confirm":
            answer = self.ask(do_comment, do_message)
            if answer == "q":
                self.quit = True
                return
            if answer == "n":
                self.storage.record(post.key, post.author_url, "skip", post.text)
                return
            do_comment = do_comment and answer in ("y", "c")
            do_message = do_message and answer in ("y", "m")

        if do_comment:
            if self.post_comment(page, post):
                self.comments_sent += 1
                self.storage.record(post.key, post.author_url, "comment", post.text)
                log.info("   ✔ תגובה נשלחה")
            human_sleep(tuple(self.cfg.get("delay_between_actions", [45, 120])))

        if do_message:
            if self.send_message(context, post):
                self.messages_sent += 1
                self.storage.record(post.key, post.author_url, "message", post.text)
                log.info("   ✔ הודעה במסנג'ר נשלחה")
            human_sleep(tuple(self.cfg.get("delay_between_actions", [45, 120])))

        if not do_comment and not do_message:
            self.storage.record(post.key, post.author_url, "skip", post.text)

    @staticmethod
    def print_post(post: Post, matched: str, age_desc: str) -> None:
        preview = re.sub(r"\s+", " ", post.text)[:250]
        print("\n" + "=" * 70)
        print(f"🎯 נמצא פוסט מתאים  |  {post.author_name or '?'}  |  עלה: {age_desc}")
        print(f"   ביטוי שזוהה: «{matched}»")
        print(f"   {preview}")
        if post.url:
            print(f"   {post.url}")
        print("=" * 70)

    @staticmethod
    def ask(do_comment: bool, do_message: bool) -> str:
        options = "y=הכל"
        if do_comment:
            options += ", c=רק תגובה"
        if do_message:
            options += ", m=רק הודעה"
        options += ", n=דלג, q=יציאה"
        while True:
            answer = input(f"   לשלוח? ({options}): ").strip().lower()
            if answer in ("y", "c", "m", "n", "q"):
                return answer

    # ---------- actions ----------

    def post_comment(self, page: Page, post: Post) -> bool:
        text = fill_template(self.cfg["comment_text"], post.author_name)
        el = post.locator
        try:
            el.scroll_into_view_if_needed(timeout=5000)
            box = el.locator('div[role="textbox"][contenteditable="true"]').first
            opened_dialog = False
            if not box.is_visible():
                selector = ", ".join(f'[role="button"][aria-label="{label}"]' for label in COMMENT_BUTTON_LABELS)
                el.locator(selector).first.click(timeout=5000)
                time.sleep(2.5)
                box = el.locator('div[role="textbox"][contenteditable="true"]').first
                if not box.is_visible():
                    # Newer Facebook opens the post in a dialog.
                    box = page.locator('[role="dialog"] div[role="textbox"][contenteditable="true"]').last
                    opened_dialog = True
            box.click(timeout=5000)
            time.sleep(random.uniform(0.5, 1.5))
            human_type(page, text)
            time.sleep(random.uniform(0.8, 2))
            page.keyboard.press("Enter")
            time.sleep(3)
            if opened_dialog:
                page.keyboard.press("Escape")
                time.sleep(1)
            return True
        except Exception as e:
            log.warning("   ✘ לא הצלחתי להגיב על הפוסט: %s", e)
            page.keyboard.press("Escape")
            return False

    def send_message(self, context: BrowserContext, post: Post) -> bool:
        text = fill_template(self.cfg["messenger_text"], post.author_name)
        tab = context.new_page()
        try:
            uid = numeric_user_id(post.author_url)
            if uid:
                tab.goto(f"https://www.facebook.com/messages/t/{uid}", wait_until="domcontentloaded")
                time.sleep(5)
            else:
                tab.goto(post.author_url, wait_until="domcontentloaded")
                time.sleep(4)
                button = tab.get_by_role("button", name=MESSAGE_BUTTON_NAMES).first
                button.click(timeout=8000)
                time.sleep(4)

            box = tab.locator('div[role="textbox"][contenteditable="true"]').last
            box.click(timeout=8000)
            time.sleep(random.uniform(0.5, 1.5))
            human_type(tab, text)
            time.sleep(random.uniform(0.8, 2))
            tab.keyboard.press("Enter")
            time.sleep(3)
            return True
        except Exception as e:
            log.warning("   ✘ לא הצלחתי לשלוח הודעה ל-%s: %s", post.author_name, e)
            return False
        finally:
            tab.close()


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    base = Path(path).resolve().parent
    for key in ("browser_profile_dir", "database_file"):
        cfg[key] = str((base / cfg.get(key, f"./{key}")).resolve())
    cfg.setdefault("max_comments_per_run", 5)
    cfg.setdefault("max_messages_per_run", 5)
    return cfg


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="סוכן פייסבוק שמוצא אנשים שמחפשים דיג'יי")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--mode", choices=["dry_run", "confirm", "auto"], help="עוקף את mode בקובץ ההגדרות")
    args = parser.parse_args()

    cfg = load_config(args.config)
    mode = args.mode or cfg.get("mode", "confirm")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler("dj_agent.log", encoding="utf-8")],
    )
    log.info("מצב עבודה: %s | גיל פוסט מקסימלי: %s ימים", mode, cfg.get("max_post_age_days", 7))
    DJAgent(cfg, mode).run()


if __name__ == "__main__":
    main()
