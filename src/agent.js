// Facebook DJ agent.
//
// Opens a real Chromium window with your own Facebook login, scrolls the feed and the
// groups listed in groups.txt / config.yaml, and sends every recent post where someone
// is looking for a DJ to your own WhatsApp. It only reads Facebook; it never posts there.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { PostMatcher } = require('./matcher');
const { parsePostAge, describeAge, DAY, HOUR } = require('./postAge');
const { Storage } = require('./storage');
const { formatPostMessage, checkWhatsAppSettings } = require('./whatsapp');
const { WhatsAppWeb } = require('./whatsappWeb');
const { loadGroupsFile, addGroupsToFile, collectJoinedGroups, groupKey, GroupsLastSeen } = require('./groups');
const { setTerminalHebrewFix } = require('./terminal');
const { log, events, setLogFile } = require('./log');
const { loadConfig } = require('./configFile');
const { RoundStats } = require('./rounds');
const { cleanPostText } = require('./postText');
const { DecisionLog } = require('./decisions');
const { inActiveHours, nextActiveTime, isDueThisRound, orderSources } = require('./schedule');

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
const pageKey = (source) => source.groupId || 'feed';
const NO_INTERNET_GIVE_UP_MIN = 30;
const isNetworkError = (e) =>
  /ERR_(?:INTERNET_DISCONNECTED|CONNECTION_\w+|NETWORK_\w+|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|TIMED_OUT|QUIC_PROTOCOL_ERROR|PROXY_CONNECTION_FAILED)|page\.goto: Timeout/.test(
    String(e && e.message),
  );
const clock = (t) => new Date(t).toTimeString().slice(0, 5);
const activeHoursText = (cfg) => `${cfg.active_from || '08:00'}–${cfg.active_until || '00:00'}`;
const waTarget = (w) => (w.group_name ? `group:${w.group_name}|${w.group_link || ''}` : `phone:${w.phone || ''}`);

/**
 * The browser the agent drives: the Chromium that `npm install` downloads, or, when that
 * download failed (slow or blocked network), the Edge that comes with Windows.
 */
function browserChannel() {
  let bundled = null;
  try {
    bundled = chromium.executablePath();
  } catch {
    // no bundled browser for this platform
  }
  if (bundled && fs.existsSync(bundled)) return {};
  if (process.platform === 'win32') {
    log('הדפדפן של הסוכן לא הותקן – משתמש ב-Microsoft Edge');
    return { channel: 'msedge' };
  }
  return {};
}
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const humanSleep = ([min, max]) => sleep(rand(min, max) * 1000);

function groupUrl(url) {
  const u = new URL(url);
  u.searchParams.set('sorting_setting', 'CHRONOLOGICAL'); // newest posts first
  return u.toString();
}

/**
 * The pages to scan, in order:
 *  - the feed: a fixed number of scrolls (it never ends and isn't sorted by time);
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

/** A link to one post (not to a group or a profile). */
function isPostUrl(href) {
  return /\/(?:posts|permalink|videos|reel|p)\/|story_fbid=|[?&]fbid=|pfbid|multi_permalinks=|\/photo/.test(String(href || ''));
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

// ---------- the agent ----------

class DJAgent {
  /**
   * configPath: when given, config.yaml is re-read at the start of every round, so changes
   * (from the control panel or by hand) apply from the next round.
   */
  constructor(cfg, { dryRun = false, configPath = null } = {}) {
    this.dryRun = dryRun;
    this.configPath = configPath;
    this.applyConfig(cfg);
    this.storage = new Storage(cfg.history_file);
    this.lastSeen = new GroupsLastSeen(cfg.groups_last_seen_file);
    this.rounds = new RoundStats(cfg.rounds_file);
    this.decisions = new DecisionLog(cfg.decisions_file);
    this.postsThisRound = 0;
    this.leadsThisRound = 0;
    this.notificationsSent = 0;
    this.sendFailures = 0;
    this.seenThisRun = new Set();
    this.stopRequested = false;
    this.wakeUp = null;
    this.status = { state: 'stopped', detail: '', nextRoundAt: null, sent: 0, dryRun };
  }

  applyConfig(cfg) {
    this.cfg = cfg;
    this.matcher = new PostMatcher(cfg.include_patterns, cfg.exclude_patterns);
    this.maxAgeMs = Number(cfg.max_post_age_days ?? 3) * DAY;
    this.whatsapp = cfg.whatsapp || {};
  }

  reloadConfig() {
    if (!this.configPath) return;
    try {
      this.applyConfig(loadConfig(this.configPath));
    } catch (e) {
      log(`⚠ לא הצלחתי לקרוא את config.yaml, ממשיך עם ההגדרות הקודמות: ${e.message.split('\n')[0]}`);
    }
  }

  /** What the agent is doing now, for the control panel. */
  setStatus(state, detail = '', extra = {}) {
    const base = { ...this.status, state, detail, nextRoundAt: null };
    if (state !== 'scanning') Object.assign(base, { progress: null, etaAt: null }); // a round's progress, while scanning
    this.status = { ...base, ...extra, sent: this.notificationsSent };
    events.emit('status', this.status);
  }

  /** Asks the agent to stop; it finishes the post it's on and exits within seconds. */
  stop() {
    if (this.status.state === 'stopped') return;
    this.stopRequested = true;
    this.setStatus('stopping', 'עוצר...');
    if (this.wakeUp) this.wakeUp();
  }

  /** Sleeps, but returns early when stop() is called. */
  waitOrStop(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wakeUp = done;
    }).finally(() => (this.wakeUp = null));
  }

  async setupNotifier(context) {
    log('פותח ווצאפ ווב...');
    this.setStatus('starting', 'מתחבר לווצאפ ווב');
    this.wa = new WhatsAppWeb(context, this.whatsapp, { log });
    await this.wa.ensureReady();
    log('ווצאפ ווב מחובר ✔');
    this.notify = (text) => this.wa.send(text);
  }

  async run({ testWhatsappOnly = false, importGroupsOnly = false } = {}) {
    this.stopRequested = false;
    this.setStatus('starting', 'פותח דפדפן');
    let context;
    try {
      context = await chromium.launchPersistentContext(this.cfg.browser_profile_dir, {
        ...browserChannel(),
        headless: false,
        locale: 'he-IL',
        viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch (e) {
      this.setStatus('stopped');
      // Chrome won't open a profile that is already open: it hands over to that window and exits.
      if (/has been closed|existing browser session|ProcessSingleton|profile.*in use/i.test(e.message)) {
        throw new Error(
          'הדפדפן של הסוכן כבר פתוח – כנראה הסוכן כבר רץ בחלון אחר. ' +
            'סגור אותו (Ctrl+C בחלון השחור שלו, וסגור את חלון הדפדפן שלו) ונסה שוב.',
        );
      }
      throw e;
    }
    let browserClosed = false;
    context.on('close', () => (browserClosed = true));
    const page = context.pages()[0] || (await context.newPage());
    try {
      if (importGroupsOnly) {
        this.setStatus('importing', 'אוסף את הקבוצות שלך מפייסבוק');
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
      this.setStatus('starting', 'מתחבר לפייסבוק');
      await this.ensureLoggedIn(page);
      for (;;) {
        // Settings and groups changed since the last round take effect now.
        const targetBefore = waTarget(this.whatsapp);
        this.reloadConfig();
        this.storage.reload(); // history / bookmarks may have been cleared from the panel
        this.lastSeen.reload();
        if (this.wa && waTarget(this.whatsapp) !== targetBefore) {
          log(`יעד הווצאפ השתנה – מתחבר ל${this.whatsapp.group_name ? 'קבוצה' : "צ'אט"} החדש`);
          await this.wa.setTarget(this.whatsapp);
        }
        if (!inActiveHours(this.cfg)) {
          const resumeAt = nextActiveTime(this.cfg).getTime();
          log(`⏸ מחוץ לשעות הפעילות (${activeHoursText(this.cfg)}) – ממשיך ב-${clock(resumeAt)}`);
          this.setStatus('waiting', `מחוץ לשעות הפעילות – ממשיך ב-${clock(resumeAt)}`, { nextRoundAt: resumeAt });
          await this.waitOrStop(resumeAt - Date.now());
          if (this.stopRequested) break;
          continue; // re-read the settings and check the hours again
        }
        const everyMinutesNow = Number(this.cfg.run_every_minutes || 0);
        const leads = this.storage.actions.filter((a) => a.action === 'notify');
        const all = buildSources(this.cfg);
        const sources = orderSources(
          all.filter((s) =>
            isDueThisRound(s, { leads, lastCheckedAt: s.groupId && this.lastSeen.checkedAt(s.groupId), everyMinutes: everyMinutesNow }),
          ),
          leads,
        );
        const keys = sources.map(pageKey);
        const skipped = all.length - sources.length;
        log(`מתחיל סבב: ${sources.length} עמודים לסריקה` + (skipped ? ` (${skipped} קבוצות בלי פוסטים מתאימים ב-30 יום נסרקות כל סבב שלישי – לא בסבב הזה)` : ''));
        const usualMs = this.rounds.typicalRoundMs();
        let failedPages = 0;
        let offline = false;
        let slowAlertSent = false;
        const roundStart = Date.now();
        const pageMs = {};
        this.postsThisRound = 0;
        this.leadsThisRound = 0;
        for (const [i, source] of sources.entries()) {
          if (this.stopRequested) break;
          const tookMs = Date.now() - roundStart;
          if (!slowAlertSent && usualMs && tookMs > Math.max(2 * usualMs, usualMs + 30 * 60 * 1000)) {
            slowAlertSent = true;
            await this.alert(
              `⚠️ הסבב נמשך כבר ${Math.round(tookMs / 60000)} דקות (בדרך כלל ${Math.round(usualMs / 60000)}). ` +
                `ייתכן שהבוט נתקע או שהאינטרנט איטי – כדאי להציץ במחשב.`,
              page,
            );
          }
          const left = this.rounds.remainingMs(keys, i, Object.values(pageMs));
          this.setStatus('scanning', `${source.label} (${i + 1}/${sources.length})`, {
            progress: { done: i, total: sources.length },
            etaAt: left == null ? null : Date.now() + left,
          });
          let pageStart = Date.now();
          let ok = false;
          for (let attempt = 0; attempt < 2 && !ok && !this.stopRequested; attempt++) {
            try {
              await this.scanSource(page, source);
              ok = true;
            } catch (e) {
              if (browserClosed || page.isClosed()) throw e;
              if (isNetworkError(e) && attempt === 0) {
                // No internet: wait for it to come back, then scan the same page again.
                if (!(await this.waitForInternet(page))) {
                  offline = true;
                  break;
                }
                pageStart = Date.now();
                continue;
              }
              // One page that fails to load must not stop the whole round.
              log(`   ✘ שגיאה בסריקת ${source.label}, ממשיך לעמוד הבא: ${e.message.split('\n')[0]}`);
              failedPages++;
              break;
            }
          }
          if (offline) break;
          if (ok && !this.stopRequested) pageMs[keys[i]] = Date.now() - pageStart;
        }
        this.failedPagesNote = failedPages ? ` (${failedPages} עמודים נכשלו)` : '';
        if (offline) {
          log(`✘ הסבב הופסק: אין חיבור לאינטרנט כבר ${NO_INTERNET_GIVE_UP_MIN} דקות. ינסה שוב בסבב הבא`);
        } else if (!this.stopRequested) {
          this.rounds.add({
            started_at: new Date(roundStart).toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - roundStart,
            pages: sources.length,
            posts: this.postsThisRound,
            leads: this.leadsThisRound,
            dry_run: this.dryRun,
            page_ms: pageMs,
          });
          events.emit('rounds');
          log(`סבב נמשך ${Math.round((Date.now() - roundStart) / 60000)} דקות: ${this.postsThisRound} פוסטים נבדקו, ${this.leadsThisRound} מתאימים`);
          await this.reportRoundDone(page);
        }
        const everyMinutes = Number(this.cfg.run_every_minutes || 0);
        if (this.stopRequested || !everyMinutes) break;
        let nextRoundAt = Date.now() + everyMinutes * 60 * 1000;
        if (!inActiveHours(this.cfg, new Date(nextRoundAt))) {
          nextRoundAt = nextActiveTime(this.cfg, new Date(nextRoundAt)).getTime();
          log(`סבב הסתיים. נשלחו לווצאפ עד עכשיו: ${this.notificationsSent}. ⏸ הבוט מושהה עד ${clock(nextRoundAt)} (שעות פעילות ${activeHoursText(this.cfg)})`);
        } else {
          log(`סבב הסתיים. נשלחו לווצאפ עד עכשיו: ${this.notificationsSent}. סבב הבא בעוד ${everyMinutes} דקות`);
        }
        this.setStatus('waiting', inActiveHours(this.cfg, new Date(nextRoundAt - 1)) ? 'ממתין לסבב הבא' : `מושהה עד ${clock(nextRoundAt)}`, { nextRoundAt });
        await this.waitOrStop(nextRoundAt - Date.now());
        if (this.stopRequested) break;
      }
    } catch (e) {
      if (!browserClosed && !page.isClosed()) throw e;
      log('חלון הדפדפן נסגר – הסוכן נעצר.');
    } finally {
      log(`סיום. נשלחו לווצאפ: ${this.notificationsSent}`);
      await context.close().catch(() => {});
      this.stopRequested = false;
      this.setStatus('stopped');
    }
  }

  /** "סיימתי את הסבב בשעה 14:05" to WhatsApp after every full round. */
  async reportRoundDone(page) {
    if (this.dryRun || !this.notify) return;
    try {
      await this.notify(`סיימתי את הסבב בשעה ${new Date().toTimeString().slice(0, 5)}${this.failedPagesNote || ''}`);
      log('   ✔ הודעת סיום הסבב נשלחה לווצאפ');
    } catch (e) {
      log(`   ✘ הודעת סיום הסבב לא נשלחה: ${e.message.split('\n')[0]}`);
    }
    await page.bringToFront().catch(() => {});
  }

  /**
   * Waits for the internet to come back (checks every minute). False if it didn't within
   * NO_INTERNET_GIVE_UP_MIN minutes. WhatsApp can't be reached without internet either, so the
   * alert is only in the log.
   */
  async waitForInternet(page) {
    log(`📶 אין חיבור לאינטרנט – ממתין שיחזור (בודק כל דקה, עד ${NO_INTERNET_GIVE_UP_MIN} דקות)`);
    this.setStatus('scanning', 'אין חיבור לאינטרנט – ממתין שיחזור', { progress: this.status.progress, etaAt: null });
    const deadline = Date.now() + NO_INTERNET_GIVE_UP_MIN * 60 * 1000;
    while (Date.now() < deadline && !this.stopRequested) {
      await this.waitOrStop(60 * 1000);
      try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        log('📶 החיבור חזר ✔ – ממשיך מאותו עמוד');
        return true;
      } catch (e) {
        if (!isNetworkError(e)) return true; // some other problem: let the page try (and report it)
      }
    }
    return false;
  }

  async isLoginPage(page) {
    return /login|checkpoint/.test(page.url()) || (await page.locator('input[name="email"], input[name="pass"]').count()) > 0;
  }

  async ensureLoggedIn(page) {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    if (!(await this.isLoginPage(page))) return;
    log('לא מחובר לפייסבוק. התחבר בחלון הדפדפן שנפתח – הסוכן ימשיך לבד אחרי ההתחברות.');
    await this.waitForLogin(page);
  }

  async waitForLogin(page, minutes = 10) {
    const deadline = Date.now() + minutes * 60 * 1000;
    while (Date.now() < deadline && !this.stopRequested) {
      await sleep(3000);
      if (!(await this.isLoginPage(page))) {
        log('התחברות זוהתה ✔');
        this.fbAlertSent = false;
        await sleep(3000);
        return;
      }
    }
    throw new Error(`לא בוצעה התחברות לפייסבוק תוך ${minutes} דקות.`);
  }

  /** A warning to WhatsApp (not in test mode). A failure here never stops the scan. */
  async alert(text, page) {
    log(text);
    if (this.dryRun || !this.notify) return;
    try {
      await this.notify(text);
    } catch (e) {
      log(`   ✘ ההתראה לא נשלחה לווצאפ: ${e.message.split('\n')[0]}`);
    }
    if (page) await page.bringToFront().catch(() => {});
  }

  // ---------- scanning ----------

  async scanSource(page, source) {
    this.currentSource = source;
    log(`סורק: ${source.label}`);
    await page.goto(source.url, { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    if (await this.isLoginPage(page)) {
      // Facebook logged the agent out (or asks to confirm the account) in the middle of a round.
      if (!this.fbAlertSent) {
        this.fbAlertSent = true;
        await this.alert('⚠️ פייסבוק התנתק – צריך להתחבר מחדש בחלון הדפדפן של הבוט במחשב. הסבב ימשיך לבד אחרי ההתחברות.', page);
      }
      await this.waitForLogin(page, 30);
      await page.goto(source.url, { waitUntil: 'domcontentloaded' });
      await sleep(4000);
    }
    const failuresBefore = this.sendFailures;
    const { newest, ages } = await this.scrollAndCheck(page, source);
    if (source.groupId) this.reportOrder(ages);
    // Remember the newest post of the group for next time – unless this is a test run or a
    // WhatsApp send failed here (then the next scan must reach that post again).
    if (source.groupId && newest && !this.dryRun && !this.stopRequested && this.sendFailures === failuresBefore) {
      this.lastSeen.save(source.groupId, source.groupName, newest.key, Date.now() - newest.age);
      events.emit('bookmarks');
    }
  }

  /**
   * Logs whether a group's posts really came newest-first. Allows for Facebook's rounded
   * ages ("3 ש'") and ignores the first post, which may be pinned.
   */
  reportOrder(ages) {
    if (ages.length < 3) return; // the first post may be pinned, so 3 is the least that says anything
    let outOfOrder = 0;
    for (let i = 2; i < ages.length; i++) {
      const slack = ages[i - 1] < DAY ? HOUR : DAY;
      if (ages[i] < ages[i - 1] - slack) outOfOrder++;
    }
    if (outOfOrder <= 1) log(`   ✔ הקבוצה מסודרת מהחדש לישן (לפי ${ages.length} פוסטים עם תאריך)`);
    else log(`   ⚠ הקבוצה לא מסודרת לפי זמן: ${outOfOrder} מתוך ${ages.length} פוסטים יצאו מהסדר`);
  }

  /** Scrolls one page and checks its posts. Returns { newest: { age, key } | null, ages }. */
  async scrollAndCheck(page, { maxScrolls, untilOld, groupId }) {
    const lastSeenKey = groupId ? this.lastSeen.newestPost(groupId) : null;
    // Also stop by time: posts older than last scan's newest post were checked then, even if that
    // post itself is gone (deleted, or Facebook changed its link). An hour of slack for rounded ages.
    const lastSeenAt = groupId ? this.lastSeen.newestPostedAt(groupId) : null;
    let seenInARow = 0;
    const ages = [];
    let newest = null;
    let totalPosts = 0;
    let oldInARow = 0; // untilOld: consecutive posts older than the limit
    let emptyScrolls = 0; // scrolls that brought no new posts
    for (let s = 0; s < maxScrolls && !this.stopRequested; s++) {
      const ids = await page.evaluate(jsNewPosts, POST_SELECTOR);
      totalPosts += ids.length;
      emptyScrolls = ids.length ? 0 : emptyScrolls + 1;
      if ((s + 1) % 10 === 0) log(`   גלילה ${s + 1} – נסרקו ${totalPosts} פוסטים`);
      for (const id of ids) {
        if (this.stopRequested) break;
        let res = null;
        try {
          res = await this.handlePost(page, page.locator(`[data-djbot-id="${id}"]`), { alwaysReadAge: untilOld });
        } catch (e) {
          // One broken post must not stop the run.
          log(`שגיאה בטיפול בפוסט: ${e.message.split('\n')[0]}`);
        }
        if (!untilOld || !res) continue;
        if (res.age !== null) ages.push(res.age);
        // Newest by date, not by position: a pinned post at the top may be old.
        if (res.age !== null && (!newest || res.age < newest.age)) newest = res;
        if (lastSeenKey && res.key === lastSeenKey) {
          log(`   הגענו לפוסט האחרון שנבדק בסריקה הקודמת – עוצר את הקבוצה (${totalPosts} פוסטים)`);
          return { newest, ages };
        }
        if (res.age === null) continue;
        if (lastSeenAt) {
          seenInARow = Date.now() - res.age < lastSeenAt - HOUR ? seenInARow + 1 : 0;
          if (seenInARow >= OLD_POSTS_TO_STOP) {
            log(`   הגענו לפוסטים שכבר נבדקו בסריקה הקודמת (לפי הזמן) – עוצר את הקבוצה (${totalPosts} פוסטים)`);
            return { newest, ages };
          }
        }
        oldInARow = res.age > this.maxAgeMs ? oldInARow + 1 : 0;
        // A single older post can slip in between new ones, so wait for a few in a row.
        if (oldInARow >= OLD_POSTS_TO_STOP) {
          log(`   הגענו לפוסטים ישנים מ-${this.cfg.max_post_age_days ?? 3} ימים – עוצר את העמוד הזה (${totalPosts} פוסטים)`);
          return { newest, ages };
        }
      }
      if (untilOld && emptyScrolls >= 5) {
        log(`   אין עוד תוצאות – עוצר את העמוד הזה (${totalPosts} פוסטים)`);
        return { newest, ages };
      }
      await page.mouse.wheel(0, randInt(700, 1300));
      await humanSleep(this.cfg.delay_between_scrolls || [3, 7]);
    }
    if (untilOld && !this.stopRequested) log(`   הגענו למקסימום ${maxScrolls} גלילות – עוצר את הקבוצה (${totalPosts} פוסטים)`);
    return { newest, ages };
  }

  async readPost(page, el) {
    await el.evaluate(jsExpandSeeMore);
    await sleep(500);
    const info = await el.evaluate(jsPostInfo);
    const text = cleanPostText(info.body || info.full);

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

    // The post's own link. Facebook often fills the time link in only on hover (before that it
    // points at the group), so hover it when it isn't a post link yet.
    let url = '';
    for (let i = 0; i < info.stamps.length && !url; i++) {
      let href = info.stamps[i].href;
      if (!isPostUrl(href)) {
        const link = el.locator(`a[data-djbot-ts="${i}"]`).first();
        await link.hover({ timeout: 3000 }).catch(() => {});
        await sleep(400);
        href = (await link.evaluate((a) => a.href).catch(() => '')) || href;
      }
      if (isPostUrl(href)) url = canonicalPostUrl(href);
    }
    // Never a group's link as the post's identity: then all such posts would look like one post.
    const key = url || 'hash:' + crypto.createHash('sha1').update(info.authorHref + text.slice(0, 300)).digest('hex');

    return {
      key,
      url,
      text,
      authorName: info.authorName,
      // Inside a group the post itself doesn't link the group: use the group being scanned.
      groupName: info.groupName || (this.currentSource && this.currentSource.groupName) || '',
      // When the post's own link couldn't be read: at least the group it's in.
      groupLink: (this.currentSource && this.currentSource.groupId && `https://www.facebook.com/groups/${this.currentSource.groupId}`) || '',
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
    this.postsThisRound++;
    const maybeDj = this.matcher.mightMatch(quickText) || this.matcher.isCandidate(quickText);
    if (!maybeDj && !alwaysReadAge) return null;

    const post = await this.readPost(page, el);
    const age = parsePostAge(post.ageText);
    const decision = this.matcher.classify(post.text);
    const recent = age === null || age <= this.maxAgeMs;
    const note = (code, reason, extra = {}) => this.recordDecision(post, code, reason, { phrase: decision.phrase, by: decision.by, ...extra });
    if (decision.kind === 'none') {
      if (decision.candidate && recent) note('not_recognized', 'מזכיר דיג׳יי/מוזיקה אבל לא זוהה כבקשה');
      return { age, key: post.key };
    }
    if (decision.kind === 'excluded') {
      if (recent) note('excluded', `נפסל בגלל «${decision.by}»`);
      return { age, key: post.key };
    }
    const matched = decision.phrase;
    post.broad = decision.kind === 'broad';
    if (this.seenThisRun.has(post.key)) return { age, key: post.key };
    this.seenThisRun.add(post.key);

    const who = [post.authorName, post.groupName && `בקבוצה ${post.groupName}`].filter(Boolean).join(' ') || '?';
    if (age === null) {
      log(`⏭  דילוג – לא הצלחתי לזהות מתי הפוסט עלה (${who})`);
      note('skipped_no_time', 'לא זוהה מתי הפוסט עלה');
      return { age, key: post.key };
    }
    if (age > this.maxAgeMs) {
      log(`⏭  דילוג – פוסט ישן (${post.ageText}): ${who}`);
      note('skipped_old', `ישן מ-${this.cfg.max_post_age_days ?? 3} ימים`);
      return { age, key: post.key };
    }
    if (this.storage.postHandled(post.key)) {
      log(`⏭  דילוג – כבר טיפלנו בפוסט הזה: ${who}`);
      return { age, key: post.key };
    }
    if (this.storage.textHandled(post.text)) {
      log(`⏭  דילוג – אותו טקסט כבר נשלח אליך (פוסט שפורסם בכמה מקומות): ${who}`);
      note('skipped_same_text', 'אותו טקסט כבר נשלח (פוסט שפורסם בכמה מקומות)');
      return { age, key: post.key };
    }

    const ageDesc = `${post.ageText} (~${describeAge(age)})`;
    this.printPost(post, matched, ageDesc);
    this.leadsThisRound++;

    if (this.dryRun) {
      log('   [בדיקה] היה נשלח אליך לווצאפ');
      note('test_mode', 'מצב בדיקה – היה נשלח');
      return { age, key: post.key };
    }
    try {
      await this.notify(formatPostMessage(post, ageDesc));
      this.notificationsSent++;
      this.storage.record(post.key, post.authorUrl, 'notify', post.text, {
        authorName: post.authorName,
        groupName: post.groupName,
        groupId: this.currentSource && this.currentSource.groupId,
        broad: post.broad,
      });
      events.emit('lead', this.storage.recentLeads(1)[0]);
      this.setStatus(this.status.state, this.status.detail);
      log('   ✔ נשלח אליך לווצאפ');
      this.recordDecision(post, post.broad ? 'sent_broad' : 'sent', post.broad ? 'נשלח כליד רחב' : 'נשלח', { phrase: matched });
    } catch (e) {
      this.sendFailures++;
      log(`   ✘ שליחה לווצאפ נכשלה: ${e.message.split('\n')[0]}`);
      this.recordDecision(post, 'send_failed', `השליחה נכשלה: ${e.message.split('\n')[0]}`, { phrase: matched });
    }
    await page.bringToFront();
    return { age, key: post.key };
  }

  recordDecision(post, decision, reason, { phrase = null, by = null } = {}) {
    try {
      this.decisions.add({
        id: post.key,
        decision,
        reason,
        url: post.url || post.groupLink || '',
        group: post.groupName || '',
        author: post.authorName || '',
        age: post.ageText || '',
        phrase,
        by,
        text: post.text,
      });
    } catch (e) {
      log(`   ✘ לא הצלחתי לכתוב לקובץ ההחלטות: ${e.message.split('\n')[0]}`);
    }
  }

  /** The post that was found, in the terminal and in dj_agent.log (for checking afterwards). */
  printPost(post, matched, ageDesc) {
    const preview = post.text.replace(/\s+/g, ' ').slice(0, 250);
    log(`${post.broad ? '🔎 ליד רחב' : '🎯 נמצא פוסט מתאים'}  |  ${post.authorName || '?'}${post.groupName ? `  |  ${post.groupName}` : ''}  |  עלה: ${ageDesc}`);
    log(`   ביטוי שזוהה: «${matched}»`);
    log(`   ${preview}`);
    if (post.url) log(`   ${post.url}`);
  }
}

// ---------- entry point ----------

function parseArgs(argv) {
  const args = { config: 'config.yaml', dryRun: false, testWhatsapp: false, importGroups: false, noPanel: false, createShortcut: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--test-whatsapp') args.testWhatsapp = true;
    else if (argv[i] === '--import-groups') args.importGroups = true;
    else if (argv[i] === '--no-panel') args.noPanel = true;
    else if (argv[i] === '--create-shortcut') args.createShortcut = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config);
  const cfg = loadConfig(configPath);
  setTerminalHebrewFix(cfg.terminal_hebrew_fix);
  setLogFile(path.join(path.dirname(configPath), 'dj_agent.log'));

  if (args.createShortcut) {
    const link = require('./shortcut').createDesktopShortcut(path.dirname(configPath));
    log(`✔ נוצר קיצור דרך בשולחן העבודה: ${link}`);
    return;
  }

  // Plain `node index.js` (or run.bat): the control panel, where the agent is started and stopped.
  if (!args.noPanel && !args.testWhatsapp && !args.importGroups && !args.dryRun) {
    await require('./panel').startPanel({ configPath, port: Number(cfg.panel_port || 3210) });
    return;
  }

  if ((!args.dryRun && !args.importGroups) || args.testWhatsapp) {
    const problem = checkWhatsAppSettings(cfg.whatsapp);
    if (problem) throw new Error(problem);
  }
  log(`${args.dryRun ? 'מצב בדיקה (לא שולח לווצאפ) | ' : ''}גיל פוסט מקסימלי: ${cfg.max_post_age_days ?? 3} ימים`);
  await new DJAgent(cfg, { dryRun: args.dryRun, configPath }).run({
    testWhatsappOnly: args.testWhatsapp,
    importGroupsOnly: args.importGroups,
  });
}

module.exports = { main, isPostUrl, canonicalPostUrl, canonicalProfileUrl, buildSources, groupUrl, jsNewPosts, jsPostInfo, DJAgent, POST_SELECTOR };
