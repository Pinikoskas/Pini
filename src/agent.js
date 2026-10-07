// Facebook DJ agent.
//
// Opens a real Chromium window with your own Facebook login, scrolls the feed, search
// results and any groups listed in config.yaml, and sends every recent post where someone
// is looking for a DJ to your own WhatsApp. It only reads Facebook; it never posts there.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { chromium } = require('playwright');

const { PostMatcher } = require('./matcher');
const { parsePostAge, describeAge, DAY } = require('./postAge');
const { Storage } = require('./storage');
const { formatPostMessage, checkWhatsAppSettings } = require('./whatsapp');
const { WhatsAppWeb } = require('./whatsappWeb');
const { loadGroupsFile, addGroupsToFile, collectJoinedGroups, groupKey, GroupsLastSeen } = require('./groups');

const POST_SELECTOR = '[role="article"], div[aria-posinset], div[data-pagelet^="FeedUnit"]';
const OLD_POSTS_TO_STOP = 3;

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
  const tsRe = /\/posts\/|\/permalink|story_fbid|\/videos\/|\/photo|\/reel\/|multi_permalinks|pfbid/;
  // Author and group: walk the post's own links in order. A link to the group itself
  // ("/groups/<id>/") is the group; the first link to a person's profile is the author.
  const isGroupLink = (h) => /facebook\.com\/groups\/[^/?#]+\/?(?:[?#]|$)/.test(h);
  const isProfileLink = (h) =>
    /\/groups\/[^/]+\/user\/\d+/.test(h) ||
    /\/profile\.php\?id=\d+/.test(h) ||
    /facebook\.com\/(?!groups|watch|events|hashtag|stories|reel|photo|search|marketplace|pages|gaming)[A-Za-z0-9.]{3,}\/?(?:[?#]|$)/.test(h);
  let authorA = null;
  let groupA = null;
  for (const a of el.querySelectorAll('a[href]')) {
    if (el.matches('[role="article"]') && a.closest('[role="article"]') !== el) continue; // a comment
    const name = (a.innerText || '').trim();
    if (!name || name.length > 80 || tsRe.test(a.href)) continue;
    if (!groupA && isGroupLink(a.href)) groupA = a;
    else if (!authorA && isProfileLink(a.href)) authorA = a;
    if (authorA && groupA) break;
  }
  if (!authorA) {
    authorA = [...el.querySelectorAll('h2 a[href], h3 a[href], h4 a[href], strong a[href]')].find(
      (a) => a !== groupA && !isGroupLink(a.href) && !tsRe.test(a.href) && (a.innerText || '').trim(),
    ) || null;
  }
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
  // Post text without the comments under it (comments are nested role="article" elements).
  const root = el.matches('[role="article"]') ? el : el.querySelector('[role="article"]') || el;
  const parts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const owner = n.parentElement && n.parentElement.closest('[role="article"]');
    if (owner && owner !== root) continue;
    const t = n.textContent.trim();
    if (t) parts.push(t);
  }
  return {
    body: body ? body.innerText : '',
    full: parts.join(' ') || el.innerText || '',
    authorName: authorA ? authorA.innerText.trim().split('\n')[0] : '',
    authorHref: authorA ? authorA.href : '',
    groupName: groupA ? groupA.innerText.trim().split('\n')[0] : '',
    stamps,
  };
}

// ---------- pure helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const humanSleep = ([min, max]) => sleep(rand(min, max) * 1000);

function searchUrl(query) {
  return `https://www.facebook.com/search/posts?q=${encodeURIComponent(query)}`;
}

function groupUrl(url) {
  const u = new URL(url);
  u.searchParams.set('sorting_setting', 'CHRONOLOGICAL'); // newest posts first
  return u.toString();
}

/**
 * The pages to scan, in order:
 *  - the feed and searches: a fixed number of scrolls (they aren't sorted by time;
 *    Facebook has no "recent posts" filter in search);
 *  - groups: sorted newest first, scrolled until posts get older than max_post_age_days
 *    (or the results run out), and until the newest post seen on the previous scan
 *    (groups_last_seen.json).
 */
function buildSources(cfg) {
  const sources = [];
  const feedScrolls = Number(cfg.feed_scrolls ?? 40);
  if (feedScrolls > 0) {
    sources.push({ label: 'פיד ראשי', url: 'https://www.facebook.com/', maxScrolls: feedScrolls, untilOld: false });
  }
  const searchScrolls = Number(cfg.search_scrolls ?? 10);
  for (const q of cfg.searches || []) {
    sources.push({ label: `חיפוש "${q}"`, url: searchUrl(q), maxScrolls: searchScrolls, untilOld: false });
  }
  const cap = Number(cfg.max_scrolls_per_group ?? 100);
  const seen = new Set();
  for (const g of [...(cfg.groups || []).map((url) => ({ url, name: '' })), ...loadGroupsFile(cfg.groups_file)]) {
    const id = groupKey(g.url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sources.push({ label: `קבוצה ${g.name || id}`, url: groupUrl(g.url), maxScrolls: cap, untilOld: true, groupId: id, groupName: g.name });
  }
  return sources;
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
  constructor(cfg, { dryRun = false } = {}) {
    this.cfg = cfg;
    this.dryRun = dryRun;
    this.matcher = new PostMatcher(cfg.include_patterns, cfg.exclude_patterns);
    this.storage = new Storage(cfg.history_file);
    this.maxAgeMs = Number(cfg.max_post_age_days ?? 3) * DAY;
    this.whatsapp = cfg.whatsapp || {};
    this.lastSeen = new GroupsLastSeen(cfg.groups_last_seen_file);
    this.notificationsSent = 0;
    this.sendFailures = 0;
    this.seenThisRun = new Set();
  }

  async setupNotifier(context) {
    log('פותח ווצאפ ווב...');
    const wa = new WhatsAppWeb(context, this.whatsapp.phone, { log });
    await wa.ensureReady();
    log('ווצאפ ווב מחובר ✔');
    this.notify = (text) => wa.send(text);
  }

  async run({ testWhatsappOnly = false, importGroupsOnly = false } = {}) {
    const context = await chromium.launchPersistentContext(this.cfg.browser_profile_dir, {
      headless: false,
      locale: 'he-IL',
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = context.pages()[0] || (await context.newPage());
    try {
      if (importGroupsOnly) {
        await this.ensureLoggedIn(page);
        log('אוסף את הקבוצות שאתה חבר בהן...');
        const groups = await collectJoinedGroups(page, { log, sleep });
        const added = addGroupsToFile(this.cfg.groups_file, groups);
        log(`נמצאו ${groups.length} קבוצות, ${added} חדשות נוספו לקובץ ${this.cfg.groups_file}`);
        return;
      }
      if (!this.dryRun || testWhatsappOnly) await this.setupNotifier(context);
      if (testWhatsappOnly) {
        await this.notify("✅ בדיקה: סוכן הדיג'יי מחובר לווצאפ שלך");
        log('הודעת בדיקה נשלחה לווצאפ ✔');
        return;
      }
      await page.bringToFront();
      await this.ensureLoggedIn(page);
      const everyMinutes = Number(this.cfg.run_every_minutes || 0);
      for (;;) {
        for (const source of buildSources(this.cfg)) {
          await this.scanSource(page, source);
        }
        if (!everyMinutes) break;
        log(`סבב הסתיים. נשלחו לווצאפ עד עכשיו: ${this.notificationsSent}. סבב הבא בעוד ${everyMinutes} דקות (Ctrl+C לעצירה)`);
        await sleep(everyMinutes * 60 * 1000);
      }
    } finally {
      log(`סיום. נשלחו לווצאפ: ${this.notificationsSent}`);
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

  // ---------- scanning ----------

  async scanSource(page, source) {
    log(`סורק: ${source.label}`);
    await page.goto(source.url, { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    const failuresBefore = this.sendFailures;
    const newest = await this.scrollAndCheck(page, source);
    // Remember the newest post of the group for next time – unless this is a test run or a
    // WhatsApp send failed here (then the next scan must reach that post again).
    if (source.groupId && newest && !this.dryRun && this.sendFailures === failuresBefore) {
      this.lastSeen.save(source.groupId, source.groupName, newest.key);
    }
  }

  /** Scrolls one page and checks its posts. Returns the newest post read ({ age, key }) or null. */
  async scrollAndCheck(page, { maxScrolls, untilOld, groupId }) {
    const lastSeenKey = groupId ? this.lastSeen.newestPost(groupId) : null;
    let newest = null;
    let totalPosts = 0;
    let oldInARow = 0; // untilOld: consecutive posts older than the limit
    let emptyScrolls = 0; // scrolls that brought no new posts
    for (let s = 0; s < maxScrolls; s++) {
      const ids = await page.evaluate(jsNewPosts, POST_SELECTOR);
      totalPosts += ids.length;
      emptyScrolls = ids.length ? 0 : emptyScrolls + 1;
      if ((s + 1) % 10 === 0) log(`   גלילה ${s + 1} – נסרקו ${totalPosts} פוסטים`);
      for (const id of ids) {
        let res = null;
        try {
          res = await this.handlePost(page, page.locator(`[data-djbot-id="${id}"]`), { alwaysReadAge: untilOld });
        } catch (e) {
          // One broken post must not stop the run.
          log(`שגיאה בטיפול בפוסט: ${e.message.split('\n')[0]}`);
        }
        if (!untilOld || !res) continue;
        // Newest by date, not by position: a pinned post at the top may be old.
        if (res.age !== null && (!newest || res.age < newest.age)) newest = res;
        if (lastSeenKey && res.key === lastSeenKey) {
          log(`   הגענו לפוסט האחרון שנבדק בסריקה הקודמת – עוצר את הקבוצה (${totalPosts} פוסטים)`);
          return newest;
        }
        if (res.age === null) continue;
        oldInARow = res.age > this.maxAgeMs ? oldInARow + 1 : 0;
        // A single older post can slip in between new ones, so wait for a few in a row.
        if (oldInARow >= OLD_POSTS_TO_STOP) {
          log(`   הגענו לפוסטים ישנים מ-${this.cfg.max_post_age_days ?? 3} ימים – עוצר את העמוד הזה (${totalPosts} פוסטים)`);
          return newest;
        }
      }
      if (untilOld && emptyScrolls >= 5) {
        log(`   אין עוד תוצאות – עוצר את העמוד הזה (${totalPosts} פוסטים)`);
        return newest;
      }
      await page.mouse.wheel(0, randInt(700, 1300));
      await humanSleep(this.cfg.delay_between_scrolls || [3, 7]);
    }
    return newest;
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
      key,
      url,
      text,
      authorName: info.authorName,
      groupName: info.groupName,
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

  /**
   * Checks one post and sends it to WhatsApp if it's a recent DJ request.
   * Returns { age, key } when the post was read (null otherwise). With alwaysReadAge,
   * every post is read, even ones that don't mention a DJ (used to know when to stop).
   */
  async handlePost(page, el, { alwaysReadAge = false } = {}) {
    // Facebook removes/hides posts that scrolled far away, so read the text straight from
    // the DOM (no visibility needed) and skip posts that are already gone.
    if ((await el.count()) === 0) return null;
    const quickText = await el.evaluate((e) => (e.isConnected ? e.innerText : null), null, { timeout: 2000 }).catch(() => null);
    if (!quickText) return null;
    const maybeDj = this.matcher.mightMatch(quickText);
    if (!maybeDj && !alwaysReadAge) return null;

    const post = await this.readPost(page, el);
    const age = parsePostAge(post.ageText);
    const matched = maybeDj && this.matcher.match(post.text);
    if (!matched) return { age, key: post.key };
    if (this.seenThisRun.has(post.key)) return { age, key: post.key };
    this.seenThisRun.add(post.key);

    const who = [post.authorName, post.groupName && `בקבוצה ${post.groupName}`].filter(Boolean).join(' ') || '?';
    if (age === null) {
      log(`⏭  דילוג – לא הצלחתי לזהות מתי הפוסט עלה (${who})`);
      return { age, key: post.key };
    }
    if (age > this.maxAgeMs) {
      log(`⏭  דילוג – פוסט ישן (${post.ageText}): ${who}`);
      return { age, key: post.key };
    }
    if (this.storage.postHandled(post.key)) {
      log(`⏭  דילוג – כבר טיפלנו בפוסט הזה: ${who}`);
      return { age, key: post.key };
    }

    const ageDesc = `${post.ageText} (~${describeAge(age)})`;
    this.printPost(post, matched, ageDesc);

    if (this.dryRun) {
      log('   [בדיקה] היה נשלח אליך לווצאפ');
      return { age, key: post.key };
    }
    try {
      await this.notify(formatPostMessage(post, ageDesc));
      this.notificationsSent++;
      this.storage.record(post.key, post.authorUrl, 'notify', post.text);
      log('   ✔ נשלח אליך לווצאפ');
    } catch (e) {
      this.sendFailures++;
      log(`   ✘ שליחה לווצאפ נכשלה: ${e.message.split('\n')[0]}`);
    }
    await page.bringToFront();
    return { age, key: post.key };
  }

  printPost(post, matched, ageDesc) {
    const preview = post.text.replace(/\s+/g, ' ').slice(0, 250);
    const bar = '='.repeat(70);
    console.log(`\n${bar}`);
    console.log(`🎯 נמצא פוסט מתאים  |  ${post.authorName || '?'}${post.groupName ? `  |  ${post.groupName}` : ''}  |  עלה: ${ageDesc}`);
    console.log(`   ביטוי שזוהה: «${matched}»`);
    console.log(`   ${preview}`);
    if (post.url) console.log(`   ${post.url}`);
    console.log(bar);
  }
}

// ---------- entry point ----------

function loadConfig(file) {
  const cfg = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const base = path.dirname(path.resolve(file));
  cfg.browser_profile_dir = path.resolve(base, cfg.browser_profile_dir || './browser_profile');
  cfg.history_file = path.resolve(base, cfg.history_file || './history.json');
  cfg.groups_file = path.resolve(base, cfg.groups_file || './groups.txt');
  cfg.groups_last_seen_file = path.resolve(base, cfg.groups_last_seen_file || './groups_last_seen.json');
  return cfg;
}

function parseArgs(argv) {
  const args = { config: 'config.yaml', dryRun: false, testWhatsapp: false, importGroups: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--test-whatsapp') args.testWhatsapp = true;
    else if (argv[i] === '--import-groups') args.importGroups = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config);
  if ((!args.dryRun && !args.importGroups) || args.testWhatsapp) {
    const problem = checkWhatsAppSettings(cfg.whatsapp);
    if (problem) throw new Error(problem);
  }
  logStream = fs.createWriteStream(path.resolve(path.dirname(path.resolve(args.config)), 'dj_agent.log'), { flags: 'a' });
  log(`${args.dryRun ? 'מצב בדיקה (לא שולח לווצאפ) | ' : ''}גיל פוסט מקסימלי: ${cfg.max_post_age_days ?? 3} ימים`);
  await new DJAgent(cfg, { dryRun: args.dryRun }).run({ testWhatsappOnly: args.testWhatsapp, importGroupsOnly: args.importGroups });
}

module.exports = { main, canonicalPostUrl, canonicalProfileUrl, buildSources, searchUrl, groupUrl, jsNewPosts, jsPostInfo, DJAgent, POST_SELECTOR };
