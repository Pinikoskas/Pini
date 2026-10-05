// Facebook DJ agent.
//
// Opens a real Chromium window with your own Facebook login, scrolls the feed (and any
// groups listed in config.yaml), and for every post where someone is looking for a DJ
// and the post is less than a week old:
//   1. writes a comment on the post
//   2. sends the author a Messenger message

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const yaml = require('js-yaml');
const { chromium } = require('playwright');

const { PostMatcher } = require('./matcher');
const { parsePostAge, describeAge, DAY } = require('./postAge');
const { Storage } = require('./storage');

const POST_SELECTOR = '[role="article"], div[aria-posinset], div[data-pagelet^="FeedUnit"]';

const COMMENT_BUTTON_LABELS = [
  'Leave a comment', 'Comment', 'Write a comment', 'השארת תגובה', 'כתיבת תגובה',
  'הגב', 'תגובה', 'השאר תגובה', 'השאירו תגובה',
];
const MESSAGE_BUTTON_NAMES = /^(Message|Send message|הודעה|שליחת הודעה|שלח הודעה)$/;

// ---------- browser-side helpers (run inside the Facebook page) ----------

// Finds new top-level posts, tags them with data-djbot-id and returns the ids.
// Nested articles (comments inside a post) are ignored.
function jsNewPosts(selector) {
  const out = [];
  let n = window.__djbotCounter || 0;
  for (const el of document.querySelectorAll(selector)) {
    if (el.dataset.djbotId) continue;
    const parent = el.parentElement && el.parentElement.closest(selector);
    if (parent) continue;
    if ((el.innerText || '').trim().length < 30) continue; // still loading
    el.dataset.djbotId = String(++n);
    out.push(String(n));
  }
  window.__djbotCounter = n;
  return out;
}

function jsExpandSeeMore(el) {
  const labels = ['See more', 'ראה עוד', 'הצג עוד', 'ראו עוד', 'עוד'];
  for (const b of el.querySelectorAll('div[role="button"], span[role="button"]')) {
    if (labels.includes((b.innerText || '').trim())) b.click();
  }
}

function jsPostInfo(el) {
  const body = el.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
  const authorA = el.querySelector('h2 a[href], h3 a[href], h4 a[href], strong a[href]');
  const tsRe = /\/posts\/|\/permalink|story_fbid|\/videos\/|\/photo|\/reel\/|multi_permalinks|pfbid/;
  const stamps = [];
  let i = 0;
  for (const a of el.querySelectorAll('a[href]')) {
    if (!tsRe.test(a.href)) continue;
    // Skip links that belong to comments nested inside the post.
    if (el.matches('[role="article"]') && a.closest('[role="article"]') !== el) continue;
    a.dataset.djbotTs = String(i++);
    stamps.push({ href: a.href, label: a.getAttribute('aria-label') || '', text: (a.innerText || '').trim() });
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

// ---------- pure helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const humanSleep = ([min, max]) => sleep(rand(min, max) * 1000);

function firstName(full) {
  return (full || '').trim().split(/\s+/)[0] || '';
}

function fillTemplate(template, authorName) {
  const text = template.replaceAll('{name}', firstName(authorName));
  // If we don't know the name, drop the dangling space: "היי !" -> "היי!"
  return text.replace(/ +([!,.])/g, '$1').trim();
}

function canonicalPostUrl(href) {
  const u = new URL(href);
  const keep = ['story_fbid', 'id', 'fbid', 'v']
    .filter((k) => u.searchParams.has(k))
    .map((k) => `${k}=${u.searchParams.get(k)}`);
  return `https://www.facebook.com${u.pathname.replace(/\/+$/, '')}` + (keep.length ? `?${keep.join('&')}` : '');
}

function canonicalProfileUrl(href) {
  if (!href) return '';
  const u = new URL(href);
  const m = u.pathname.match(/\/groups\/[^/]+\/user\/(\d+)/);
  if (m) return `https://www.facebook.com/profile.php?id=${m[1]}`;
  if (u.pathname.startsWith('/profile.php')) {
    const id = u.searchParams.get('id');
    return id ? `https://www.facebook.com/profile.php?id=${id}` : '';
  }
  const first = u.pathname.replace(/^\/+/, '').split('/')[0];
  if (!first || ['groups', 'watch', 'events', 'photo', 'stories', 'reel', 'hashtag'].includes(first)) return '';
  return `https://www.facebook.com/${first}`;
}

function numericUserId(profileUrl) {
  const m = (profileUrl || '').match(/profile\.php\?id=(\d+)/);
  return m ? m[1] : null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); }));
}

// ---------- logging ----------

let logStream = null;
function log(...parts) {
  const time = new Date().toTimeString().slice(0, 8);
  const line = `${time}  ${parts.join(' ')}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

// ---------- the agent ----------

class DJAgent {
  constructor(cfg, mode) {
    this.cfg = cfg;
    this.mode = mode;
    this.matcher = new PostMatcher(cfg.include_patterns, cfg.exclude_patterns);
    this.storage = new Storage(cfg.history_file);
    this.maxAgeMs = Number(cfg.max_post_age_days ?? 7) * DAY;
    this.commentsSent = 0;
    this.messagesSent = 0;
    this.seenThisRun = new Set();
    this.quit = false;
  }

  async run() {
    const context = await chromium.launchPersistentContext(this.cfg.browser_profile_dir, {
      headless: false,
      locale: 'he-IL',
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = context.pages()[0] || (await context.newPage());
    try {
      await this.ensureLoggedIn(page);
      for (const source of this.cfg.sources || ['https://www.facebook.com/']) {
        if (this.quit || this.limitsReached()) break;
        await this.scanSource(context, page, source);
      }
    } finally {
      log(`סיום. תגובות שנשלחו: ${this.commentsSent}, הודעות שנשלחו: ${this.messagesSent}`);
      await context.close();
    }
  }

  async isLoginPage(page) {
    return page.url().includes('login') || (await page.locator('input[name="email"], input[name="pass"]').count()) > 0;
  }

  async ensureLoggedIn(page) {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    if (!(await this.isLoginPage(page))) return;
    log('לא מחובר לפייסבוק. התחבר בחלון הדפדפן שנפתח – הסוכן ימשיך לבד אחרי ההתחברות.');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      if (!(await this.isLoginPage(page))) {
        log('התחברות זוהתה ✔');
        await sleep(3000);
        return;
      }
    }
    throw new Error('לא בוצעה התחברות תוך 10 דקות.');
  }

  limitsReached() {
    if (this.mode === 'dry_run') return false;
    const commentsDone = !this.cfg.send_comment || this.commentsSent >= this.cfg.max_comments_per_run;
    const messagesDone = !this.cfg.send_messenger || this.messagesSent >= this.cfg.max_messages_per_run;
    return commentsDone && messagesDone;
  }

  // ---------- scanning ----------

  async scanSource(context, page, url) {
    log(`סורק: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    const scrolls = Number(this.cfg.max_scrolls_per_source ?? 40);
    let totalPosts = 0;
    for (let s = 0; s < scrolls; s++) {
      const ids = await page.evaluate(jsNewPosts, POST_SELECTOR);
      totalPosts += ids.length;
      if ((s + 1) % 10 === 0) log(`   גלילה ${s + 1}/${scrolls} – נסרקו ${totalPosts} פוסטים`);
      for (const id of ids) {
        if (this.quit || this.limitsReached()) return;
        try {
          await this.handlePost(context, page, page.locator(`[data-djbot-id="${id}"]`));
        } catch (e) {
          // One broken post must not stop the run.
          log(`שגיאה בטיפול בפוסט: ${e.message.split('\n')[0]}`);
        }
      }
      await page.mouse.wheel(0, randInt(700, 1300));
      await humanSleep(this.cfg.delay_between_scrolls || [3, 7]);
    }
  }

  async readPost(page, el) {
    await el.evaluate(jsExpandSeeMore);
    await sleep(500);
    const info = await el.evaluate(jsPostInfo);
    const text = (info.body || info.full).trim();

    let ageText = '';
    for (let i = 0; i < info.stamps.length && !ageText; i++) {
      const stamp = info.stamps[i];
      ageText = [stamp.label, stamp.text].find((c) => parsePostAge(c) !== null) || '';
      if (!ageText) {
        // Facebook often hides the real time in a tooltip; hover to reveal it.
        const tip = await this.hoverTooltip(page, el.locator(`a[data-djbot-ts="${i}"]`).first());
        if (parsePostAge(tip) !== null) ageText = tip;
      }
    }

    let url = '';
    let key;
    if (info.stamps.length) {
      url = canonicalPostUrl(info.stamps[0].href);
      key = url;
    } else {
      key = 'hash:' + crypto.createHash('sha1').update(info.authorHref + text.slice(0, 300)).digest('hex');
    }

    return {
      locator: el,
      key,
      url,
      text,
      authorName: info.authorName,
      authorUrl: canonicalProfileUrl(info.authorHref),
      ageText,
    };
  }

  async hoverTooltip(page, link) {
    try {
      await link.hover({ timeout: 3000 });
      const tip = page.locator('[role="tooltip"]').last();
      await tip.waitFor({ state: 'visible', timeout: 2500 });
      const text = (await tip.innerText()).trim();
      await page.mouse.move(5, 5);
      return text;
    } catch {
      return '';
    }
  }

  async handlePost(context, page, el) {
    // Facebook removes/hides posts that scrolled far away, so read the text straight from
    // the DOM (no visibility needed) and skip posts that are already gone.
    if ((await el.count()) === 0) return;
    const quickText = await el.evaluate((e) => (e.isConnected ? e.innerText : null), null, { timeout: 2000 }).catch(() => null);
    if (!quickText || !this.matcher.mightMatch(quickText)) return;

    const post = await this.readPost(page, el);
    const matched = this.matcher.match(post.text);
    if (!matched) return;
    if (this.seenThisRun.has(post.key)) return;
    this.seenThisRun.add(post.key);

    const who = post.authorName || '?';
    const age = parsePostAge(post.ageText);
    if (age === null) {
      log(`⏭  דילוג – לא הצלחתי לזהות מתי הפוסט עלה (${who})`);
      return;
    }
    if (age >= this.maxAgeMs) {
      log(`⏭  דילוג – פוסט ישן (${post.ageText}): ${who}`);
      return;
    }
    if (this.storage.postHandled(post.key)) {
      log(`⏭  דילוג – כבר טיפלנו בפוסט הזה: ${who}`);
      return;
    }

    this.printPost(post, matched, `${post.ageText} (~${describeAge(age)})`);

    let doComment = !!this.cfg.send_comment && this.commentsSent < this.cfg.max_comments_per_run;
    let doMessage =
      !!this.cfg.send_messenger &&
      this.messagesSent < this.cfg.max_messages_per_run &&
      !!post.authorUrl &&
      !this.storage.authorMessagedRecently(post.authorUrl, this.cfg.dont_message_same_person_days ?? 30);

    if (this.mode === 'dry_run') {
      log(`   [dry_run] היה נשלח: תגובה=${doComment ? 'כן' : 'לא'}, הודעה=${doMessage ? 'כן' : 'לא'}`);
      return;
    }

    if (this.mode === 'confirm') {
      const answer = await this.askUser(doComment, doMessage);
      if (answer === 'q') {
        this.quit = true;
        return;
      }
      if (answer === 'n') {
        this.storage.record(post.key, post.authorUrl, 'skip', post.text);
        return;
      }
      doComment = doComment && (answer === 'y' || answer === 'c');
      doMessage = doMessage && (answer === 'y' || answer === 'm');
    }

    const actionDelay = this.cfg.delay_between_actions || [45, 120];
    if (doComment) {
      if (await this.postComment(page, post)) {
        this.commentsSent++;
        this.storage.record(post.key, post.authorUrl, 'comment', post.text);
        log('   ✔ תגובה נשלחה');
      }
      await humanSleep(actionDelay);
    }
    if (doMessage) {
      if (await this.sendMessage(context, post)) {
        this.messagesSent++;
        this.storage.record(post.key, post.authorUrl, 'message', post.text);
        log("   ✔ הודעה במסנג'ר נשלחה");
      }
      await humanSleep(actionDelay);
    }
    if (!doComment && !doMessage) this.storage.record(post.key, post.authorUrl, 'skip', post.text);
  }

  printPost(post, matched, ageDesc) {
    const preview = post.text.replace(/\s+/g, ' ').slice(0, 250);
    const bar = '='.repeat(70);
    console.log(`\n${bar}`);
    console.log(`🎯 נמצא פוסט מתאים  |  ${post.authorName || '?'}  |  עלה: ${ageDesc}`);
    console.log(`   ביטוי שזוהה: «${matched}»`);
    console.log(`   ${preview}`);
    if (post.url) console.log(`   ${post.url}`);
    console.log(bar);
  }

  async askUser(doComment, doMessage) {
    let options = 'y=הכל';
    if (doComment) options += ', c=רק תגובה';
    if (doMessage) options += ', m=רק הודעה';
    options += ', n=דלג, q=יציאה';
    for (;;) {
      const answer = await ask(`   לשלוח? (${options}): `);
      if (['y', 'c', 'm', 'n', 'q'].includes(answer)) return answer;
    }
  }

  // ---------- actions ----------

  async humanType(page, text) {
    // Newlines become Shift+Enter so the message isn't sent early.
    const lines = text.trim().split('\n');
    for (let i = 0; i < lines.length; i++) {
      await page.keyboard.type(lines[i], { delay: randInt(35, 110) });
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
  }

  async postComment(page, post) {
    const text = fillTemplate(this.cfg.comment_text, post.authorName);
    const el = post.locator;
    try {
      await el.evaluate((e) => e.scrollIntoView({ block: 'center' }), null, { timeout: 3000 });
      await sleep(1000);
      let box = el.locator('div[role="textbox"][contenteditable="true"]').first();
      let openedDialog = false;
      if (!(await box.isVisible())) {
        const selector = COMMENT_BUTTON_LABELS.map((l) => `[role="button"][aria-label="${l}"]`).join(', ');
        await el.locator(selector).first().click({ timeout: 5000 });
        await sleep(2500);
        box = el.locator('div[role="textbox"][contenteditable="true"]').first();
        if (!(await box.isVisible())) {
          // Newer Facebook opens the post in a dialog.
          box = page.locator('[role="dialog"] div[role="textbox"][contenteditable="true"]').last();
          openedDialog = true;
        }
      }
      await box.click({ timeout: 5000 });
      await sleep(rand(500, 1500));
      await this.humanType(page, text);
      await sleep(rand(800, 2000));
      await page.keyboard.press('Enter');
      await sleep(3000);
      if (openedDialog) {
        await page.keyboard.press('Escape');
        await sleep(1000);
      }
      return true;
    } catch (e) {
      log(`   ✘ לא הצלחתי להגיב על הפוסט: ${e.message.split('\n')[0]}`);
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
  }

  async sendMessage(context, post) {
    const text = fillTemplate(this.cfg.messenger_text, post.authorName);
    const tab = await context.newPage();
    try {
      const uid = numericUserId(post.authorUrl);
      if (uid) {
        await tab.goto(`https://www.facebook.com/messages/t/${uid}`, { waitUntil: 'domcontentloaded' });
        await sleep(5000);
      } else {
        await tab.goto(post.authorUrl, { waitUntil: 'domcontentloaded' });
        await sleep(4000);
        await tab.getByRole('button', { name: MESSAGE_BUTTON_NAMES }).first().click({ timeout: 8000 });
        await sleep(4000);
      }
      const box = tab.locator('div[role="textbox"][contenteditable="true"]').last();
      await box.click({ timeout: 8000 });
      await sleep(rand(500, 1500));
      await this.humanType(tab, text);
      await sleep(rand(800, 2000));
      await tab.keyboard.press('Enter');
      await sleep(3000);
      return true;
    } catch (e) {
      log(`   ✘ לא הצלחתי לשלוח הודעה ל-${post.authorName}: ${e.message.split('\n')[0]}`);
      return false;
    } finally {
      await tab.close();
    }
  }
}

// ---------- entry point ----------

function loadConfig(file) {
  const cfg = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const base = path.dirname(path.resolve(file));
  cfg.browser_profile_dir = path.resolve(base, cfg.browser_profile_dir || './browser_profile');
  cfg.history_file = path.resolve(base, cfg.history_file || './history.json');
  cfg.max_comments_per_run ??= 5;
  cfg.max_messages_per_run ??= 5;
  return cfg;
}

function parseArgs(argv) {
  const args = { config: 'config.yaml', mode: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i].startsWith('--mode=')) args.mode = argv[i].slice(7);
  }
  if (args.mode && !['dry_run', 'confirm', 'auto'].includes(args.mode)) {
    throw new Error(`mode לא חוקי: ${args.mode} (אפשר: dry_run / confirm / auto)`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config);
  const mode = args.mode || cfg.mode || 'confirm';
  logStream = fs.createWriteStream(path.resolve(path.dirname(path.resolve(args.config)), 'dj_agent.log'), { flags: 'a' });
  log(`מצב עבודה: ${mode} | גיל פוסט מקסימלי: ${cfg.max_post_age_days ?? 7} ימים`);
  await new DJAgent(cfg, mode).run();
}

module.exports = { main, fillTemplate, canonicalPostUrl, canonicalProfileUrl, numericUserId, jsNewPosts, jsPostInfo, DJAgent, POST_SELECTOR };
