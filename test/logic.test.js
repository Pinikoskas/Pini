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
    phone: '050-1234567', max_post_age_days: 2, run_every_minutes: 30, feed_scrolls: 10, max_scrolls_per_group: 100,
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
