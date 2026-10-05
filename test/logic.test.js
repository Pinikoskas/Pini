const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePostAge, isRecent, MINUTE, HOUR, DAY, WEEK } = require('../src/postAge');
const { PostMatcher } = require('../src/matcher');
const { canonicalPostUrl, canonicalProfileUrl, fillTemplate } = require('../src/agent');

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

test('one-week limit', () => {
  assert.equal(isRecent("6 י'", 7, NOW), true);
  assert.equal(isRecent("3 ש'", 7, NOW), true);
  assert.equal(isRecent("1 שב'", 7, NOW), false);
  assert.equal(isRecent('2 שבועות', 7, NOW), false);
  assert.equal(isRecent('15 בספטמבר', 7, NOW), false);
  assert.equal(isRecent('לא ידוע', 7, NOW), false);
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

test('message template', () => {
  assert.equal(fillTemplate('היי {name}! מה נשמע', 'דנה לוי'), 'היי דנה! מה נשמע');
  assert.equal(fillTemplate('היי {name}! מה נשמע', ''), 'היי! מה נשמע');
});
