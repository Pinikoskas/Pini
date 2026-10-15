const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePostAge, isRecent, MINUTE, HOUR, DAY, WEEK } = require('../src/postAge');
const { PostMatcher } = require('../src/matcher');
const { canonicalPostUrl, canonicalProfileUrl } = require('../src/agent');

const NOW = new Date(2026, 9, 5, 12, 0); // Monday 5 Oct 2026
const age = (t) => parsePostAge(t, NOW);
const days = (ms) => Math.floor(ms / DAY);

test('relative Hebrew timestamps', () => {
  assert.equal(age('עכשיו'), 0);
  assert.equal(age("5 דק'"), 5 * MINUTE);
  assert.equal(age('3 ש׳'), 3 * HOUR);
  assert.equal(age("2 י'"), 2 * DAY);
  assert.equal(age("1 שב'"), WEEK);
  assert.equal(age('לפני 4 שעות'), 4 * HOUR);
  assert.equal(age('יומיים'), 2 * DAY);
  assert.equal(age('אתמול בשעה 14:00'), DAY);
  assert.equal(age('3 ימים'), 3 * DAY);
});

test('relative English timestamps', () => {
  assert.equal(age('5m'), 5 * MINUTE);
  assert.equal(age('3h'), 3 * HOUR);
  assert.equal(age('6d'), 6 * DAY);
  assert.equal(age('2w'), 2 * WEEK);
  assert.equal(age('Yesterday at 2:00 PM'), DAY);
  assert.equal(age('3 hours ago'), 3 * HOUR);
});

test('weekday timestamps', () => {
  assert.equal(age('יום שישי בשעה 10:00'), 3 * DAY);
  assert.equal(age('Friday at 10:00'), 3 * DAY);
});

test('absolute dates', () => {
  assert.equal(days(age('1 באוקטובר')), 4);
  assert.equal(days(age('יום ראשון, 28 בספטמבר 2026 בשעה 10:00')), 7);
  assert.equal(days(age('September 30')), 5);
  assert.ok(days(age('28 בדצמבר')) > 200); // last year
  assert.ok(days(age('12 March 2024')) > 365);
});

test('unknown timestamps return null', () => {
  assert.equal(age(''), null);
  assert.equal(age('ממומן'), null);
  assert.equal(age('פיני כהן'), null);
});

test('3-day limit', () => {
  assert.equal(isRecent("3 ש'", 3, NOW), true);
  assert.equal(isRecent('אתמול בשעה 14:00', 3, NOW), true);
  assert.equal(isRecent("2 י'", 3, NOW), true);
  assert.equal(isRecent('3 ימים', 3, NOW), true);
  assert.equal(isRecent("4 י'", 3, NOW), false);
  assert.equal(isRecent("1 שב'", 3, NOW), false);
  assert.equal(isRecent('15 בספטמבר', 3, NOW), false);
  assert.equal(isRecent('לא ידוע', 3, NOW), false);
});

test('matcher finds DJ requests', () => {
  const m = new PostMatcher();
  for (const text of [
    "מחפש דיג'יי לחתונה באוגוסט, המלצות?",
    "מחפשת די ג'יי טוב לבת מצווה",
    'צריכים DJ לאירוע חברה בתל אביב',
    'מישהו מכיר דיג׳יי טוב באזור הצפון?',
    'ממליצים על תקליטן לחינה?',
    'Looking for a DJ for my wedding',
    'dj לבר מצווה במרכז, מישהו?',
    'מחפש Dj לחינה עד 1000',
    'היי, מחפש דיג׳יי למסיבת בת מצווה רק ילדים',
  ]) {
    assert.ok(m.match(text), text);
  }
});

test('matcher ignores unrelated posts and DJ ads', () => {
  const m = new PostMatcher();
  for (const text of [
    'איזה ערב מדהים היה אתמול',
    "אני דיג'יי עם 10 שנות ניסיון, פנוי לאירועים",
    "מחפש עבודה כדיג'יי",
    'מחפש צלם לחתונה',
    'מחפש מורה ל-DJ באזור הצפון, שיעורים אחד על אחד',
    'היי מחפש לקנות עמדת dj אם מישהו מוכר אשמח לשמוע',
    "מוכר ציוד דיג'יי במצב מעולה",
  ]) {
    assert.equal(m.match(text), null, text);
  }
});

test('url helpers', () => {
  assert.equal(
    canonicalProfileUrl('https://www.facebook.com/groups/555/user/123456/?__cft__=x'),
    'https://www.facebook.com/profile.php?id=123456',
  );
  assert.equal(canonicalProfileUrl('https://www.facebook.com/dana.levi?__tn__=R'), 'https://www.facebook.com/dana.levi');
  assert.equal(canonicalProfileUrl('https://www.facebook.com/groups/555/'), '');
  assert.equal(
    canonicalPostUrl('https://www.facebook.com/groups/555/posts/777/?__cft__[0]=abc&__tn__=R'),
    'https://www.facebook.com/groups/555/posts/777',
  );
  assert.equal(
    canonicalPostUrl('https://www.facebook.com/permalink.php?story_fbid=9&id=8&__cft__=x'),
    'https://www.facebook.com/permalink.php?story_fbid=9&id=8',
  );
});

const { formatPostMessage, checkWhatsAppSettings } = require('../src/whatsapp');

test('whatsapp message format', () => {
  const msg = formatPostMessage(
    { authorName: 'דנה לוי', text: "מחפשת דיג'יי\nלחתונה", url: 'https://www.facebook.com/groups/1/posts/2', authorUrl: '' },
    "2 י' (~2 ימים)",
  );
  assert.match(msg, /דנה לוי/);
  assert.match(msg, /מחפשת דיג'יי לחתונה/);
  assert.match(msg, /groups\/1\/posts\/2/);
  assert.doesNotMatch(msg, /פרופיל/);
});

test('whatsapp settings check', () => {
  assert.ok(checkWhatsAppSettings(undefined));
  assert.ok(checkWhatsAppSettings({ phone: '' }));
  assert.equal(checkWhatsAppSettings({ phone: '0501234567' }), null);
});

test('whatsapp web phone normalization', () => {
  const { normalizePhone } = require('../src/whatsappWeb');
  assert.equal(normalizePhone('050-123 4567'), '972501234567');
  assert.equal(normalizePhone('+972 50 123 4567'), '972501234567');
  assert.equal(normalizePhone('00972501234567'), '972501234567');
});


test('sources: feed by scroll count, groups newest-first until old', () => {
  const { buildSources, groupUrl } = require('../src/agent');
  const s = buildSources({ groups: ['https://www.facebook.com/groups/123/'] });
  assert.deepEqual(
    s.map((x) => [x.label, x.maxScrolls, x.untilOld]),
    [
      ['פיד ראשי', 40, false],
      ['קבוצה 123', 100, true],
    ],
  );
  assert.equal(new URL(groupUrl('https://www.facebook.com/groups/123/')).searchParams.get('sorting_setting'), 'CHRONOLOGICAL');
  assert.equal(buildSources({ feed_scrolls: 0 }).length, 0);
});

test('groups.txt: import, switch off with #, re-import keeps it off', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { addGroupsToFile, loadGroupsFile } = require('../src/groups');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djgroups-')), 'groups.txt');

  assert.equal(addGroupsToFile(file, [{ id: '111', name: 'חתונות בצפון' }, { id: 'bar.mitzva', name: 'בר מצווה' }]), 2);
  assert.deepEqual(loadGroupsFile(file), [
    { url: 'https://www.facebook.com/groups/111/', name: 'חתונות בצפון' },
    { url: 'https://www.facebook.com/groups/bar.mitzva/', name: 'בר מצווה' },
  ]);
  assert.match(fs.readFileSync(file, 'utf8'), /groups\/111\/ +# חתונות בצפון/);

  // Switch one off, then import again with one new group.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('https://www.facebook.com/groups/111/', '# https://www.facebook.com/groups/111/'));
  assert.equal(addGroupsToFile(file, [{ id: '111', name: 'חתונות בצפון' }, { id: '222', name: 'אירועים' }]), 1);
  assert.deepEqual(loadGroupsFile(file).map((g) => g.url), ['https://www.facebook.com/groups/bar.mitzva/', 'https://www.facebook.com/groups/222/']);
  assert.deepEqual(loadGroupsFile(path.join(path.dirname(file), 'missing.txt')), []);
});

test('groups_last_seen.json remembers the newest post per group', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { GroupsLastSeen } = require('../src/groups');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djseen-')), 'groups_last_seen.json');
  const a = new GroupsLastSeen(file);
  assert.equal(a.newestPost('111'), null);
  a.save('111', 'חתונות בצפון', 'https://www.facebook.com/groups/111/posts/9');
  const b = new GroupsLastSeen(file); // reloaded from disk
  assert.equal(b.newestPost('111'), 'https://www.facebook.com/groups/111/posts/9');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['111'].name, 'חתונות בצפון');
});

test('terminal: Hebrew lines are pre-reversed for a left-to-right console', () => {
  const { toVisual } = require('../src/terminal');
  assert.equal(toVisual('גיל פוסט מקסימלי: 3 ימים'), 'םימי 3 :ילמיסקמ טסופ ליג');
  assert.equal(
    toVisual('דילוג – פוסט ישן (26 בספטמבר ב-20:40): Netzor Leshonha בקבוצה dj בישראל'),
    'לארשיב dj הצובקב Netzor Leshonha :(20:40-ב רבמטפסב 26) ןשי טסופ – גוליד',
  );
  assert.equal(toVisual('   עוצר (30 פוסטים)'), '   (םיטסופ 30) רצוע'); // indentation stays, brackets mirrored
  assert.equal(toVisual('https://www.facebook.com/groups/1/posts/2'), 'https://www.facebook.com/groups/1/posts/2');
  assert.equal(toVisual('ווצאפ ווב מחובר ✔'), '✔ רבוחמ בוו פאצוו');
});

test('matcher: DJ must be a whole word (not "dji" drones)', () => {
  const m = new PostMatcher();
  assert.equal(m.match('אהלן חברים, מחפש תצלומים (קובץ) של רחפני dji עם טלמטריה'), null);
  assert.ok(m.match('מחפש DJ לחתונה'));
  assert.ok(m.match("מחפש dj's לאירוע"));
});

test('config: panel edits single values and keeps comments; bad values rejected', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { updateConfigValues, loadConfig, editableValues } = require('../src/configFile');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djcfg-')), 'config.yaml');
  fs.writeFileSync(file, '# הסבר\nmax_post_age_days: 3\n\n# ווצאפ\nwhatsapp:\n  phone: ""\n\nrun_every_minutes: 60\n');
  updateConfigValues(file, { phone: '050-1234567', max_post_age_days: '2', run_every_minutes: 30, feed_scrolls: 10 });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# הסבר\nmax_post_age_days: 2\n/);
  assert.match(text, /# ווצאפ\nwhatsapp:\n  phone: "050-1234567"\n/);
  assert.deepEqual(editableValues(loadConfig(file)), {
    phone: '050-1234567', group_name: '', group_link: '', max_post_age_days: 2, run_every_minutes: 30, feed_scrolls: 10, max_scrolls_per_group: 100, active_from: '08:00', active_until: '00:00',
  });
  assert.throws(() => updateConfigValues(file, { max_post_age_days: 0 }));
  assert.throws(() => updateConfigValues(file, { run_every_minutes: 'abc' }));
  assert.throws(() => updateConfigValues(file, { something_else: 1 }));
  assert.equal(loadConfig(file).max_post_age_days, 2); // unchanged by the rejected edits
});

test('groups.txt: panel lists all groups and switches them on/off', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readAllGroups, setGroupsEnabled, loadGroupsFile } = require('../src/groups');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djg-')), 'groups.txt');
  fs.writeFileSync(file, '# כותרת\n\nhttps://www.facebook.com/groups/1/   # דיג\'יים\n# https://www.facebook.com/groups/2/   # אייפונס\n');
  assert.deepEqual(readAllGroups(file).map((g) => [g.id, g.name, g.enabled]), [['1', "דיג'יים", true], ['2', 'אייפונס', false]]);
  setGroupsEnabled(file, { 1: false, 2: true });
  assert.deepEqual(readAllGroups(file).map((g) => [g.id, g.enabled]), [['1', false], ['2', true]]);
  assert.deepEqual(loadGroupsFile(file).map((g) => g.url), ['https://www.facebook.com/groups/2/']);
  assert.match(fs.readFileSync(file, 'utf8'), /^# כותרת\n/); // header kept
});

test('agent re-reads config.yaml (changes apply from the next round)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { DJAgent } = require('../src/agent');
  const { loadConfig, updateConfigValues } = require('../src/configFile');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djr-')), 'config.yaml');
  fs.writeFileSync(file, 'max_post_age_days: 3\nwhatsapp:\n  phone: "0501111111"\n');
  const agent = new DJAgent(loadConfig(file), { configPath: file });
  updateConfigValues(file, { max_post_age_days: 5, phone: '0502222222' });
  assert.equal(agent.maxAgeMs, 3 * DAY); // not in the middle of a round
  agent.reloadConfig(); // what the agent does at the start of each round
  assert.equal(agent.maxAgeMs, 5 * DAY);
  assert.equal(agent.whatsapp.phone, '0502222222');
});

test('panel deletes: bookmarks and history, and a running agent does not write them back', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { GroupsLastSeen } = require('../src/groups');
  const { Storage } = require('../src/storage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djdel-'));

  const seenFile = path.join(dir, 'groups_last_seen.json');
  const agentSeen = new GroupsLastSeen(seenFile); // the running agent's copy
  agentSeen.save('111', 'א', 'p1');
  agentSeen.save('222', 'ב', 'p2');
  assert.deepEqual(new GroupsLastSeen(seenFile).list().map((b) => b.id).sort(), ['111', '222']);
  assert.equal(new GroupsLastSeen(seenFile).remove({ ids: ['111'] }), 1); // the panel deletes one
  agentSeen.save('333', 'ג', 'p3'); // the agent saves another group afterwards
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(seenFile, 'utf8'))).sort(), ['222', '333']);
  assert.equal(new GroupsLastSeen(seenFile).remove({ all: true }), 2);
  assert.deepEqual(new GroupsLastSeen(seenFile).list(), []);

  const histFile = path.join(dir, 'history.json');
  const agentHist = new Storage(histFile);
  agentHist.record('k1', '', 'notify', 'טקסט', { authorName: 'דנה', groupName: 'א' });
  agentHist.record('k2', '', 'notify');
  assert.equal(new Storage(histFile).forget({ postKeys: ['k1'] }), 1);
  agentHist.record('k3', '', 'notify');
  assert.deepEqual(new Storage(histFile).recentLeads().map((a) => a.postKey), ['k3', 'k2']);
  new Storage(histFile).forget({ all: true });
  agentHist.reload();
  assert.equal(agentHist.postHandled('k2'), false);
});

test('matcher: more ways of asking, and posts that only mention a DJ', () => {
  const m = new PostMatcher();
  for (const text of [
    "מי יכול להמליץ על דיג'יי טוב?",
    "מי מכיר די-ג'יי לבר מצווה?",
    "אשמח להמלצה על דיג'אי לחתונה",
    "כמה עולה דיג'יי לחתונה של 200 איש?",
    "חתונה בספטמבר באזור השרון, דיג'יי מומלץ?",
    "מחפשים לחתונה שלנו באוגוסט באזור המרכז דיג'יי",
    'יש למישהו המלצה על תקליטנית למסיבת רווקות?',
    "בת מצווה בדצמבר, מחפשת צלמת ודיג'יי במחיר סביר",
    "מעוניינים בהצעות מחיר לדיג'יי לאירוע של 100 איש",
  ]) {
    assert.ok(m.match(text), text);
  }
  for (const text of [
    "רוצה להמליץ בחום על הדיג'יי שלנו, הרים את החתונה!",
    "תודה לדיג'יי מושיק על ערב מטורף",
    "מחפשים צלם לחתונה, את הדיג'יי כבר סגרנו",
    "דרושים מלצרים ודיג'יי לחברת אירועים, שכר גבוה",
    "מחפשת את השיר שהדיג'יי שם בסוף החתונה",
    'DJ לאירועים - תאריכים אחרונים פנויים לקיץ! להזמנות 050-1234567',
    "מחפש שותף לעסק של דיג'יי",
    "איך בוחרים דיג'יי לבת מצווה ולא מתחרטים? לפני שסוגרים דיג'יי, אל תסתכלו רק על המחיר. בקשו לראות סרטונים מאירועים אמיתיים. בדקו שיש המלצות מלקוחות אמיתיים.",
  ]) {
    assert.equal(m.match(text), null, text);
  }
  // A long post cut at "See more" is opened when its start looks like a request.
  assert.ok(m.mightMatch('היי לכולם, אנחנו מתחתנים באוגוסט ומחפשים ספקים... ראה עוד'));
  assert.ok(!m.mightMatch('איזה כיף היה בים היום... ראה עוד'));
});

test('whatsapp group: invite link instead of a phone number', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { groupInviteCode } = require('../src/whatsappWeb');
  const { checkWhatsAppSettings } = require('../src/whatsapp');
  const { updateConfigValues, loadConfig, editableValues } = require('../src/configFile');
  assert.equal(groupInviteCode('https://chat.whatsapp.com/F9zUQLdamYLIf5QgfYeqSN'), 'F9zUQLdamYLIf5QgfYeqSN');
  assert.equal(groupInviteCode('chat.whatsapp.com/invite/F9zUQLdamYLIf5QgfYeqSN?x=1'), 'F9zUQLdamYLIf5QgfYeqSN');
  assert.equal(groupInviteCode('https://www.facebook.com/'), null);
  assert.equal(checkWhatsAppSettings({ phone: '', group_name: 'לידים' }), null);
  assert.ok(checkWhatsAppSettings({ phone: '050', group_link: 'https://chat.whatsapp.com/F9zUQLdamYLIf5QgfYeqSN' })); // the name is needed
  // An older config.yaml without group_link: the panel adds it under "whatsapp:".
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djgrp-')), 'config.yaml');
  fs.writeFileSync(file, 'max_post_age_days: 3\nwhatsapp:\n  phone: "0501111111"\n\nrun_every_minutes: 60\n');
  updateConfigValues(file, { group_name: "לידים לדיג'יי", group_link: 'https://chat.whatsapp.com/F9zUQLdamYLIf5QgfYeqSN' });
  assert.deepEqual(loadConfig(file).whatsapp, { phone: '0501111111', group_name: "לידים לדיג'יי", group_link: 'https://chat.whatsapp.com/F9zUQLdamYLIf5QgfYeqSN' });
  updateConfigValues(file, { group_link: '' });
  assert.equal(editableValues(loadConfig(file)).group_link, '');
  assert.throws(() => updateConfigValues(file, { group_link: 'https://example.com/x' }));
});

test('rounds.json: estimated time left from the pages of previous rounds', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { RoundStats } = require('../src/rounds');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djrounds-')), 'rounds.json');
  const r = new RoundStats(file);
  assert.equal(r.remainingMs(['feed', '111'], 0), null); // no history yet
  assert.equal(r.remainingMs(['feed', '111'], 1, [60000]), 60000); // pages done this round
  r.add({ duration_ms: 1, page_ms: { feed: 300000, 111: 60000 } });
  r.add({ duration_ms: 1, page_ms: { feed: 200000, 111: 40000 } });
  r.add({ duration_ms: 1, page_ms: { feed: 250000, 111: 50000 } });
  const again = new RoundStats(file); // read back from disk
  assert.equal(again.list().length, 3);
  assert.equal(again.remainingMs(['feed', '111'], 0), 250000 + 50000); // median per page
  assert.equal(again.remainingMs(['feed', '111', 'new'], 1), 50000 + 130000); // a new group: the typical page (median of all)
});

test('a DJ ad posted in many groups: filtered, and the same text is never sent twice', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Storage } = require('../src/storage');
  const ad =
    'מחפשים דיג׳יי לאירוע שלכם? נעים מאוד, אני Tomer Amiel, דיג׳יי עם אהבה ענקית למוזיקה ולאווירה טובה! ' +
    'מתמחה במוזיקה מקפיצה. חתונות | ימי הולדת. לפרטים, הצעות מחיר בפרטי או בוואטסאפ. 058-6233584 פחות';
  assert.equal(new PostMatcher().match(ad), null);
  assert.ok(new PostMatcher().match("אני כלה מתחתנת בספטמבר, מחפשת דיג'יי טוב"));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djdup-')), 'history.json');
  const s = new Storage(file);
  const request = "היי, מחפשת דיג'יי לבת מצווה בדצמבר באזור ירושלים, אשמח להמלצות והצעות מחיר";
  s.record('group1/post1', '', 'notify', request);
  assert.ok(s.textHandled(request + ' ראה עוד')); // the same post in another group
  assert.ok(!s.textHandled("מחפשים דיג'יי לחתונה באוגוסט באזור המרכז, תשלחו הצעות"));
});

test('group names without Facebook notification text', () => {
  const { cleanGroupName } = require('../src/groups');
  assert.equal(cleanGroupName('לא נקראו‏בקבוצה ‏אמהות מעלה אדומים‏ יש פוסט חדש.‏‏10 דקות'), 'אמהות מעלה אדומים');
  assert.equal(cleanGroupName('לא נקראו‏‏מאורסים 25/26‏‏: "‏אלכוהול למכירה‏"‏1 שעות'), 'מאורסים 25/26');
  assert.equal(cleanGroupName('♣ ירושלמים וירושלמיות'), '♣ ירושלמים וירושלמיות');
});

test('matcher: "נעים מאוד" alone does not filter a real request', () => {
  assert.ok(new PostMatcher().match("נעים מאוד, מחפש דיג'יי לחתונה באוגוסט"));
});

test('active hours 08:00–00:00, and weak groups every third round', () => {
  const { inActiveHours, nextActiveTime, isDueThisRound } = require('../src/schedule');
  const cfg = { active_from: '08:00', active_until: '00:00' };
  const at = (h, m = 0) => new Date(2026, 9, 12, h, m);
  assert.ok(inActiveHours(cfg, at(8)));
  assert.ok(inActiveHours(cfg, at(23, 59)));
  assert.ok(!inActiveHours(cfg, at(0, 0)));
  assert.ok(!inActiveHours(cfg, at(7, 59)));
  assert.equal(nextActiveTime(cfg, at(0, 30)).getTime(), at(8).getTime());
  assert.equal(nextActiveTime(cfg, at(23, 50 + 40)).getTime(), new Date(2026, 9, 13, 8).getTime()); // 00:30 next day
  assert.ok(inActiveHours({ active_from: '22:00', active_until: '06:00' }, at(2))); // overnight hours
  assert.ok(inActiveHours({}, at(9))); // defaults

  const now = Date.parse('2026-10-12T12:00:00Z');
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const g = { groupId: '111' };
  const opts = { everyMinutes: 30, now };
  assert.ok(isDueThisRound({}, { ...opts, leads: [] })); // the feed
  assert.ok(isDueThisRound(g, { ...opts, leads: [], lastCheckedAt: null })); // never scanned
  assert.ok(!isDueThisRound(g, { ...opts, leads: [], lastCheckedAt: ago(30) })); // weak, scanned last round
  assert.ok(isDueThisRound(g, { ...opts, leads: [], lastCheckedAt: ago(90) })); // weak, 3 rounds ago
  const lead = { action: 'notify', groupId: '111', createdAt: ago(60 * 24 * 5) };
  assert.ok(isDueThisRound(g, { ...opts, leads: [lead], lastCheckedAt: ago(30) })); // strong: a lead 5 days ago
});

test('config: active hours from the panel are saved as text', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { updateConfigValues, loadConfig } = require('../src/configFile');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djhours-')), 'config.yaml');
  fs.writeFileSync(file, 'run_every_minutes: 60\n');
  updateConfigValues(file, { active_from: '8:00', active_until: '00:00' });
  assert.equal(loadConfig(file).active_from, '08:00');
  assert.equal(loadConfig(file).active_until, '00:00');
  assert.throws(() => updateConfigValues(file, { active_from: '25:00' }));
});

test('review report 13/10: ads are not sent, real requests are', () => {
  const m = new PostMatcher();
  for (const ad of [
    'חן עלמה ציפורה לפני כשעה ‏1 שעות · משותף עם: קבוצה ציבורית מחפשת זוגות מאורסים שרוצים לקבל הפקת אירוע (לא ניהול ביום האירוע, הפקה שלמה!) במחירי היכרות באמת מצחיקים תייגו אותם או אם אלו אתם דברו איתי ישירות 0504227099',
    'היי אשמח להמלצה לספק אלכוהול לקנות ממנו במחיר טוב וגם שתהיה את האופציה להחזיר אליו בקבוקים סגורים בסוף אירוע',
    'מחפשים מפעיל שיעשה לכם אחלה אירוע רק אצל נאור הפקות שברו איתי נסדר לכם אירוע 0519585993',
    'לכל הכלות שמתכננות חתונה כרגע - זה בשבילכן פתחתי מחדש את הקבוצות הסגורות שלי לכלות. מקום שבו אפשר לקבל המלצות, ספקים, מציאות, רעיונות',
  ]) {
    assert.equal(m.match(ad), null, ad);
  }
  assert.ok(m.match('מחפשת בדחיפות דיג׳אית אישה לאירוע מחר, 13.10, במעלה אדומים'));
  assert.ok(m.match('מחפשת המלצה לdj מומלץ ולצלם בר מצווה'));
  assert.ok(m.match('מחפשת דייגי לבת מצווה ברחובות')); // spelling from the report
  assert.ok(m.match("צריכים דיי ג'יי לחינה"));
  assert.equal(m.match('מחפש דייגים לשיט בכנרת'), null); // fishermen
});

test('review report 13/10: the same shared post with a different header is one post', () => {
  const { cleanPostText, samePost } = require('../src/postText');
  const a = 'חן עלמה ציפורה לפני כשעה ‏1 שעות · משותף עם: קבוצה ציבורית מחפשת זוגות מאורסים שרוצים לקבל הפקת אירוע (לא ניהול ביום האירוע, הפקה שלמה!) במחירי היכרות באמת מצחיקים תייגו אותם או אם אלו אתם דברו איתי ישירות 0504227099 כתיבת תגובה בתור ‏פִּינִי‏';
  const b = 'חן עלמה ציפורה לפני 2 שעות ‏2 שעות · משותף עם: קבוצה ציבורית מחפשת זוגות מאורסים שרוצים לקבל הפקת אירוע (לא ניהול ביום האירוע, הפקה שלמה!) במחירי היכרות באמת מצחיקים תייגו אותם או אם אלו אתם דברו איתי ישירות 0504227099 כתיבת תגובה בתור ‏פִּינִי‏';
  assert.ok(samePost(a, b));
  assert.ok(cleanPostText(a).startsWith('מחפשת זוגות מאורסים'));
  assert.ok(!cleanPostText(a).includes('כתיבת תגובה'));
  assert.ok(!samePost(a, "מחפשים דיג'יי לחתונה באוגוסט באזור המרכז, תשלחו הצעות מחיר בבקשה"));
  assert.equal(cleanPostText('\uD83C \uDF89 מחפשת בדחיפות'), 'מחפשת בדחיפות'); // broken emoji halves
});

test('review report 13/10: round order, network errors, bookmark by time', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { orderSources } = require('../src/schedule');
  const { GroupsLastSeen } = require('../src/groups');
  const now = Date.now();
  const sources = [
    { label: 'feed' },
    { groupId: 'city', groupName: 'מעלה אדומים ♣' },
    { groupId: 'dj', groupName: "דיג'יים ישראלים - לכל סוגי האירועים" },
    { groupId: 'brides', groupName: 'מאורסים 25/26' },
  ];
  const leads = [{ action: 'notify', groupId: 'brides', createdAt: new Date(now - 864e5).toISOString() }];
  assert.deepEqual(orderSources(sources, leads, { now }).map((s) => s.groupId || 'feed'), ['brides', 'dj', 'city', 'feed']);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djseen2-')), 'groups_last_seen.json');
  const seen = new GroupsLastSeen(file);
  seen.save('1', 'א', 'p1', now - 3 * 3600e3);
  assert.equal(new GroupsLastSeen(file).newestPostedAt('1'), now - 3 * 3600e3);
  seen.save('2', 'ב', 'p2'); // without a time (older bookmarks)
  assert.equal(new GroupsLastSeen(file).newestPostedAt('2'), null);
});

test("matcher (user's version, 13/10): more spellings and phrasings, ads still filtered", () => {
  const m = new PostMatcher();
  for (const text of [
    "די ג'י לחתונה מישהו?",
    'מחפשים די גי לבר מצווה',
    "מחפשים לחתונה:\n- דיג'יי\n- צלם\n- מגנטים",
    "דיג'יי מומלץ לחתונה בצפון",
    "דיג'יי מי פנוי ב-12/11?",
    "איזה דיג'יי הכי מומלץ לחינה",
    'מחפשים דייגים לחתונה באוגוסט', // a phone's autocorrect
    "מחפשים דיג'יי לחתונה, לפרטים בפרטי",
    "מחפשת דיג'יי, צרו איתי קשר בפרטי",
    "חייבים דיג'יי לאירוע ביום שישי",
    'מי יכול לתקלט באירוע שלנו בשבת?',
    'מי עושה דיגיי טוב באזור הצפון', // found through the decisions file
    "חתונה בכנרת בספטמבר, מחפשים דיג'יי",
  ]) {
    assert.ok(m.match(text), text);
  }
  for (const text of [
    "דיג'יי מקצועי לאירועים, מחירים מעולים, חייגו 050-1234567",
    "רוצה להמליץ בחום על הדיג'יי שלנו, הרים את החתונה!",
    "אני מכיר דיג'יי מעולה, שלחו לי פרטי",
    'מחפש שותף לדיג בכנרת, יש לי סירה',
    "מחיר מיוחד לחודש נובמבר! דיג'יי + הגברה + תאורה",
    "הדיג'יי בחתונה של אחי היה מושלם, ממליצה",
    "רוצים חתונה מושלמת? דיג'יי רון יקפיץ לכם את הרחבה",
    "מחפשים דיג'יי? אני כאן בשבילכם! 054-1112233",
  ]) {
    assert.equal(m.match(text), null, text);
  }
});

test('decisions file: every decision with its reason, each post once, reset from the panel', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { DecisionLog } = require('../src/decisions');
  const m = new PostMatcher();
  assert.deepEqual(m.classify("מחפשים דיג'יי לחתונה"), { kind: 'dj', phrase: "מחפשים דיג'יי" });
  assert.equal(m.classify("רוצה להמליץ בחום על הדיג'יי שלנו").kind, 'excluded');
  assert.equal(m.classify('מחפשים ספקים לחתונה').kind, 'none'); // no broad leads
  assert.deepEqual(m.classify("הדיג'יי היה מעולה"), { kind: 'none', candidate: true });
  assert.deepEqual(m.classify('מתכון לעוגת שוקולד'), { kind: 'none', candidate: false });

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djdec-')), 'decisions.jsonl');
  const d = new DecisionLog(file);
  d.add({ decision: 'sent', url: 'u1', text: 'a' });
  d.add({ decision: 'sent', url: 'u1', text: 'a' }); // the same post next round: not again
  d.add({ decision: 'excluded', url: 'u2', by: 'לפרטים', text: 'b' });
  assert.equal(new DecisionLog(file).summary().count, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[1]).by, 'לפרטים');
  new DecisionLog(file).reset(); // the panel's button, while the agent keeps its own copy
  d.add({ decision: 'sent', url: 'u1', text: 'a' }); // written again after the reset
  assert.equal(new DecisionLog(file).summary().count, 1);
});

test('decisions file 13–14/10: real posts', () => {
  const m = new PostMatcher();
  const send = (t) => m.classify(t).kind === 'dj';
  // a DJ station, not a DJ: stays excluded (the owner checked it)
  assert.ok(!send('אשמח להמלצות על עמדת אפטר לדיג׳י לחתונה מאיזור חיפה קריות'));
  // missed before
  assert.ok(send('משתגעים כבר מחיפוש DJ שיתאים לנו בכיוון של מיינסטרים אנגלית, עברית, מי יכול להתאים?'));
  // still sent
  assert.ok(send('מחפשת די-ג׳יי לחינה ביתית ב22.10'));
  assert.ok(send('אשמח להמלצות לדיגי שמתאים לחינה מרוקאית וצלם במחיר נוח'));
  assert.ok(!send('אשמח להמלצות לתאורה והגברה לחתונה באיזור ירושלים מניסיון אישי')); // no broad leads
  // sent by mistake before
  for (const t of [
    'ממה עשית עניין סה״כ נשיקה! העלאת מוזיקה יומית, הפרדת סטמים, תכנון סטים חכם וכל מה שדיג׳יי צריך במקום אחד! הצטרפו ל-teamix עכשיו בתגובה הראשונה',
    'מחפשים דיג׳יי זה הזמן לבדוק https://linktr.ee/dvirbiton28',
    'תקרית לא נעימה בחתונה שלי ובסופו של דבר לא עזבתי את רחבת הריקודים - כן ההמלצה היא על הדיג׳יי הטוב בעולם',
    "מחפשים זוגות שרוצים חתונה שתדברו עליה! אנחנו צוות של די ג'יי מקצועיים, ועכשיו אנחנו פותחים תאריכים",
    'בנובמבר מדור חדש!!! הספקים המקצועניים לאירוע מושלם! זה הזמן להמליץ על ספקים טובים שאתם עובדים איתם',
    'אני מחפשת הזדמנות להתחיל כעוזרת למפיק/ת אירועים, ללמוד מהשטח ולהוכיח את עצמי',
    'היי. אני ובן זוגי החלטנו לא לקחת מפיק לחתונה. ויש לנו מנהל אירוע מתאם האולם האם הוא דואג לכל מה שצריך במידה שמפיק דואג?',
    'למישהו יש המלצה לקורס פרונטלי של הפקות אירועים? אשמח להמלצות',
    'פוסט מס 6 בדרך לעבודה מי ה dj הכי טוב ? מי הזמר הכי טוב ?',
  ]) {
    assert.ok(!send(t), t);
  }
  // the same short post twice
  const { samePost } = require('../src/postText');
  assert.ok(samePost('אשמח לדיג׳י למסיבה מומלץ מניסיון תודה', 'אשמח לדיג׳י למסיבה מומלץ מניסיון תודה'));
  assert.ok(!samePost('מחפשת דיג׳י לחינה', 'מחפשת דיג׳י לחתונה'));
  // a group's link is never taken as a post's
  const { isPostUrl } = require('../src/agent');
  assert.ok(!isPostUrl('https://www.facebook.com/groups/1150800911722172/'));
  assert.ok(isPostUrl('https://www.facebook.com/groups/meorasim2024/posts/1915915439396108/'));
  assert.ok(isPostUrl('https://www.facebook.com/tomer.amiel/posts/pfbid02fPZ2gm'));
  // "/groups/<id>/?multi_permalinks=<post>": the post's id is in the query (it used to be dropped)
  const { canonicalPostUrl } = require('../src/agent');
  assert.equal(
    canonicalPostUrl('https://www.facebook.com/groups/1150800911722172/?multi_permalinks=2508369069642101&__cft__[0]=AZ'),
    'https://www.facebook.com/groups/1150800911722172/posts/2508369069642101',
  );
});
