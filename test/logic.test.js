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


test('sources: feed by scroll count, searches and groups newest-first until old', () => {
  const { buildSources, searchUrl, groupUrl } = require('../src/agent');
  const s = buildSources({ searches: ["מחפש דיג'יי", 'צריך DJ'], groups: ['https://www.facebook.com/groups/123/'] });
  assert.deepEqual(
    s.map((x) => [x.label, x.maxScrolls, x.untilOld]),
    [
      ['פיד ראשי', 40, false],
      ['חיפוש "מחפש דיג\'יי"', 100, true],
      ['חיפוש "צריך DJ"', 100, true],
      ['קבוצה 123', 100, true],
    ],
  );
  const u = new URL(searchUrl('צריך DJ'));
  assert.equal(u.pathname, '/search/posts');
  assert.equal(u.searchParams.get('q'), 'צריך DJ');
  const filters = JSON.parse(Buffer.from(u.searchParams.get('filters'), 'base64').toString());
  assert.equal(JSON.parse(filters['recent_posts:0']).name, 'recent_posts');
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
