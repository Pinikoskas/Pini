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
const { loadGroupsFile, addGroupsToFile, collectJoinedGroups } = require('./groups');

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

// Facebook's "Recent posts" search filter (newest first).
const RECENT_POSTS_FILTER = Buffer.from(
  JSON.stringify({ 'recent_posts:0': JSON.stringify({ name: 'recent_posts', args: '' }) }),
).toString('base64');

function searchUrl(query) {
  return `https://www.facebook.com/search/posts?q=${encodeURIComponent(query)}&filters=${encodeURIComponent(RECENT_POSTS_FILTER)}`;
}

function groupUrl(url) {
  const u = new URL(url);
  u.searchParams.set('sorting_setting', 'CHRONOLOGICAL'); // newest posts first
  return u.toString();
}

/**
 * The pages to scan, in order:
 *  - the feed: a fixed number of scrolls (it never ends and isn't sorted by time);
 *  - searches and groups: sorted newest first, scrolled until posts get older than
 *    max_post_age_days (or the results run out).
 */
function buildSources(cfg) {
  const sources = [];
  const feedScrolls = Number(cfg.feed_scrolls ?? 40);
  if (feedScrolls > 0) {
    sources.push({ label: 'פיד ראשי', url: 'https://www.facebook.com/', maxScrolls: feedScrolls, untilOld: false });
  }
  const cap = Number(cfg.max_scrolls_per_search ?? 100);
  for (const q of cfg.searches || []) {
    sources.push({ label: `חיפוש "${q}"`, url: searchUrl(q), maxScrolls: cap, untilOld: true });
  }
  const groups = [...new Set([...(cfg.groups || []), ...loadGroupsFile(cfg.groups_file)])];
  for (const g of groups) {
    sources.push({ label: `קבוצה ${g}`, url: groupUrl(g), maxScrolls: cap, untilOld: true });
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
    this.notificationsSent = 0;
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

  async scanSource(page, { label, url, maxScrolls, untilOld }) {
    log(`סורק: ${label}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    let totalPosts = 0;
    let oldInARow = 0; // untilOld: consecutive posts older than the limit
    let emptyScrolls = 0; // scrolls that brought no new posts
    for (let s = 0; s < maxScrolls; s++) {
      const ids = await page.evaluate(jsNewPosts, POST_SELECTOR);
      totalPosts += ids.length;
      emptyScrolls = ids.length ? 0 : emptyScrolls + 1;
      if ((s + 1) % 10 === 0) log(`   גלילה ${s + 1} – נסרקו ${totalPosts} פוסטים`);
      for (const id of ids) {
        let age = null;
        try {
          age = await this.handlePost(page, page.locator(`[data-djbot-id="${id}"]`), { alwaysReadAge: untilOld });
        } catch (e) {
          // One broken post must not stop the run.
          log(`שגיאה בטיפול בפוסט: ${e.message.split('\n')[0]}`);
        }
        if (!untilOld || age === null) continue;
        oldInARow = age > this.maxAgeMs ? oldInARow + 1 : 0;
        // A single older post can slip in between new ones, so wait for a few in a row.
        if (oldInARow >= OLD_POSTS_TO_STOP) {
          log(`   הגענו לפוסטים ישנים מ-${this.cfg.max_post_age_days ?? 3} ימים – עוצר את העמוד הזה (${totalPosts} פוסטים)`);
          return;
        }
      }
      if (untilOld && emptyScrolls >= 5) {
        log(`   אין עוד תוצאות – עוצר את העמוד הזה (${totalPosts} פוסטים)`);
        return;
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

  /**
   * Checks one post and sends it to WhatsApp if it's a recent DJ request.
   * Returns the post's age in ms when it was read (null otherwise). With alwaysReadAge,
   * the age is read even for posts that don't mention a DJ (used to know when to stop).
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
    if (!matched) return age;
    if (this.seenThisRun.has(post.key)) return age;
    this.seenThisRun.add(post.key);

    const who = post.authorName || '?';
    if (age === null) {
      log(`⏭  דילוג – לא הצלחתי לזהות מתי הפוסט עלה (${who})`);
      return age;
    }
    if (age > this.maxAgeMs) {
      log(`⏭  דילוג – פוסט ישן (${post.ageText}): ${who}`);
      return age;
    }
    if (this.storage.postHandled(post.key)) {
      log(`⏭  דילוג – כבר טיפלנו בפוסט הזה: ${who}`);
      return age;
    }

    const ageDesc = `${post.ageText} (~${describeAge(age)})`;
    this.printPost(post, matched, ageDesc);

    if (this.dryRun) {
      log('   [בדיקה] היה נשלח אליך לווצאפ');
      return age;
    }
    try {
      await this.notify(formatPostMessage(post, ageDesc));
      this.notificationsSent++;
      this.storage.record(post.key, post.authorUrl, 'notify', post.text);
      log('   ✔ נשלח אליך לווצאפ');
    } catch (e) {
      log(`   ✘ שליחה לווצאפ נכשלה: ${e.message.split('\n')[0]}`);
    }
    await page.bringToFront();
    return age;
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
}

// ---------- entry point ----------

function loadConfig(file) {
  const cfg = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const base = path.dirname(path.resolve(file));
  cfg.browser_profile_dir = path.resolve(base, cfg.browser_profile_dir || './browser_profile');
  cfg.history_file = path.resolve(base, cfg.history_file || './history.json');
  cfg.groups_file = path.resolve(base, cfg.groups_file || './groups.txt');
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
