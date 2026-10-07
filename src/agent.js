// Facebook DJ agent.
//
// Opens a real Chromium window with your own Facebook login, scrolls the feed and the
// groups listed in groups.txt / config.yaml, and sends every recent post where someone
// is looking for a DJ to your own WhatsApp. It only reads Facebook; it never posts there.

const crypto = require('crypto');
const path = require('path');
const { chromium } = require('playwright');

const { PostMatcher } = require('./matcher');
const { parsePostAge, describeAge, DAY, HOUR } = require('./postAge');
const { Storage } = require('./storage');
const { formatPostMessage, checkWhatsAppSettings } = require('./whatsapp');
const { WhatsAppWeb } = require('./whatsappWeb');
const { loadGroupsFile, addGroupsToFile, collectJoinedGroups, groupKey, GroupsLastSeen } = require('./groups');
const { forTerminal, setTerminalHebrewFix } = require('./terminal');
const { log, events, setLogFile } = require('./log');
const { loadConfig } = require('./configFile');

const POST_SELECTOR = '[role="article"], div[aria-posinset], div[data-pagelet^="FeedUnit"]';
const OLD_POSTS_TO_STOP = 3;
// "Interested" marks per round, so the account doesn't act faster than a person would.
const MAX_INTERESTED_PER_ROUND = 15;
const POST_MENU_BUTTON = /Actions for this post|פעולות עבור פוסט|פעולות לפוסט/i;
const INTERESTED_ITEM = /^\s*(Interested|Show more|מעניין אותי|מעוניין|מעוניינת|הצג יותר|להציג יותר|יותר כאלה)/i;

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
    this.notificationsSent = 0;
    this.sendFailures = 0;
    this.seenThisRun = new Set();
    this.interestedThisRound = 0;
    this.stopRequested = false;
    this.wakeUp = null;
    this.status = { state: 'stopped', detail: '', nextRoundAt: null, sent: 0, dryRun };
  }

  applyConfig(cfg) {
    this.cfg = cfg;
    this.matcher = new PostMatcher(cfg.include_patterns, cfg.exclude_patterns);
    this.maxAgeMs = Number(cfg.max_post_age_days ?? 3) * DAY;
    this.whatsapp = cfg.whatsapp || {};
    this.markInterestedOn = cfg.mark_interested ?? true;
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
    this.status = { ...this.status, state, detail, nextRoundAt: null, ...extra, sent: this.notificationsSent };
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
    this.wa = new WhatsAppWeb(context, this.whatsapp.phone, { log });
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
        const phoneBefore = this.whatsapp.phone;
        this.reloadConfig();
        this.storage.reload(); // history / bookmarks may have been cleared from the panel
        this.lastSeen.reload();
        this.interestedThisRound = 0;
        if (this.wa && this.whatsapp.phone !== phoneBefore) {
          log(`מספר הטלפון השתנה – מתחבר לצ'אט החדש בווצאפ`);
          await this.wa.setPhone(this.whatsapp.phone);
        }
        const sources = buildSources(this.cfg);
        log(`מתחיל סבב: ${sources.length} עמודים לסריקה`);
        for (const [i, source] of sources.entries()) {
          if (this.stopRequested) break;
          this.setStatus('scanning', `${source.label} (${i + 1}/${sources.length})`);
          try {
            await this.scanSource(page, source);
          } catch (e) {
            if (browserClosed || page.isClosed()) throw e;
            // One page that fails to load must not stop the whole round.
            log(`   ✘ שגיאה בסריקת ${source.label}, ממשיך לעמוד הבא: ${e.message.split('\n')[0]}`);
          }
        }
        const everyMinutes = Number(this.cfg.run_every_minutes || 0);
        if (this.stopRequested || !everyMinutes) break;
        const nextRoundAt = Date.now() + everyMinutes * 60 * 1000;
        log(`סבב הסתיים. נשלחו לווצאפ עד עכשיו: ${this.notificationsSent}. סבב הבא בעוד ${everyMinutes} דקות`);
        this.setStatus('waiting', `ממתין לסבב הבא`, { nextRoundAt });
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
    const { newest, ages } = await this.scrollAndCheck(page, source);
    if (source.groupId) this.reportOrder(ages);
    // Remember the newest post of the group for next time – unless this is a test run or a
    // WhatsApp send failed here (then the next scan must reach that post again).
    if (source.groupId && newest && !this.dryRun && !this.stopRequested && this.sendFailures === failuresBefore) {
      this.lastSeen.save(source.groupId, source.groupName, newest.key);
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
    if (outOfOrder <= 1) log(`   ✔ הקבוצה מסודרת מהחדש לישן (${ages.length} פוסטים נבדקו)`);
    else log(`   ⚠ הקבוצה לא מסודרת לפי זמן: ${outOfOrder} מתוך ${ages.length} פוסטים יצאו מהסדר`);
  }

  /** Scrolls one page and checks its posts. Returns { newest: { age, key } | null, ages }. */
  async scrollAndCheck(page, { maxScrolls, untilOld, groupId }) {
    const lastSeenKey = groupId ? this.lastSeen.newestPost(groupId) : null;
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
    return { newest, ages };
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
      this.storage.record(post.key, post.authorUrl, 'notify', post.text, { authorName: post.authorName, groupName: post.groupName });
      events.emit('lead', this.storage.recentLeads(1)[0]);
      this.setStatus(this.status.state, this.status.detail);
      log('   ✔ נשלח אליך לווצאפ');
    } catch (e) {
      this.sendFailures++;
      log(`   ✘ שליחה לווצאפ נכשלה: ${e.message.split('\n')[0]}`);
    }
    await page.bringToFront();
    if (this.markInterestedOn) await this.markInterested(page, el);
    return { age, key: post.key };
  }

  /**
   * Tells Facebook "show me more like this": the post's ⋯ menu → "Interested". A private
   * feed preference (nothing is posted). Not every post has it (mostly posts in the main feed).
   */
  async markInterested(page, el) {
    if (this.interestedThisRound >= MAX_INTERESTED_PER_ROUND) return;
    try {
      const button = el.getByRole('button', { name: POST_MENU_BUTTON }).first();
      if ((await button.count()) === 0) return log('   ℹ לא מצאתי את תפריט ⋯ של הפוסט – לא סומן "מעניין אותי"');
      await sleep(800 + Math.random() * 1200);
      await button.click({ timeout: 5000 });
      const menu = page.locator('[role="menu"]').last();
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      await sleep(500 + Math.random() * 800);
      const item = menu.getByRole('menuitem', { name: INTERESTED_ITEM }).first();
      if ((await item.count()) === 0) {
        const options = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.split('\n')[0].trim()).filter(Boolean);
        await page.keyboard.press('Escape');
        return log(`   ℹ אין בפוסט הזה "מעניין אותי" (בתפריט: ${options.slice(0, 8).join(' | ') || 'ריק'})`);
      }
      await item.click({ timeout: 5000 });
      this.interestedThisRound++;
      log('   👍 סומן "מעניין אותי" – פייסבוק יציג עוד פוסטים כאלה');
      await sleep(1000 + Math.random() * 1500);
    } catch (e) {
      await page.keyboard.press('Escape').catch(() => {});
      log(`   ℹ לא הצלחתי לסמן "מעניין אותי": ${e.message.split('\n')[0]}`);
    }
  }

  printPost(post, matched, ageDesc) {
    const preview = post.text.replace(/\s+/g, ' ').slice(0, 250);
    const bar = '='.repeat(70);
    const lines = [
      `🎯 נמצא פוסט מתאים  |  ${post.authorName || '?'}${post.groupName ? `  |  ${post.groupName}` : ''}  |  עלה: ${ageDesc}`,
      `   ביטוי שזוהה: «${matched}»`,
      `   ${preview}`,
    ];
    if (post.url) lines.push(`   ${post.url}`);
    console.log(`\n${bar}\n${forTerminal(lines.join('\n'))}\n${bar}`);
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

module.exports = { main, canonicalPostUrl, canonicalProfileUrl, buildSources, groupUrl, jsNewPosts, jsPostInfo, DJAgent, POST_SELECTOR };
