// A post's text as Facebook's page gives it carries interface text around it: the author line with
// "לפני 2 שעות · משותף עם: קבוצה ציבורית", "כתיבת תגובה בתור ...", "19 תגובות נוספות", "פחות".
// cleanPostText() keeps the post itself; samePost() tells whether two texts are the same post.

const UI_TAIL = [
  /\s*(?:כתיבת תגובה בתור|כתוב תגובה|כתיבת תגובה|Write a comment|Comment as)[\s\S]*$/i,
  /\s*(?:\d+\s+)?(?:תגובות נוספות|הצג תגובות נוספות|View more comments|more comments)[\s\S]*$/i,
  /\s*(?:ראה עוד|ראו עוד|הצג עוד|פחות|See more|See less)\s*$/i,
];

// "חן כהן לפני כשעה ‏1 שעות · משותף עם: קבוצה ציבורית" at the start of the text.
const HEADER = /^[^\n]{0,120}?·\s*(?:משותף עם:?\s*)?(?:קבוצה ציבורית|קבוצה פרטית|ציבורי|פרטי|Public group|Private group|Public|Shared with:?[^\n]{0,30})\s*/i;

/** Drops broken halves of emoji (shown as "�") and replacement characters. */
function fixBrokenChars(text) {
  return String(text || '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/�/g, '');
}

function cleanPostText(text) {
  let t = fixBrokenChars(text).replace(/[‎‏]/g, '');
  for (const rx of UI_TAIL) t = t.replace(rx, '');
  t = t.replace(HEADER, '');
  return t.trim();
}

/** Letters only, without times like "לפני 2 שעות" and without numbers (likes, comments). */
function letters(text) {
  return cleanPostText(text)
    .replace(/לפני\s+\S+(?:\s+(?:שעות|שעה|דקות|דקה|ימים|יום))?|אתמול|כשעה|\d+\s*(?:שעות|שעה|דקות|דקה|ימים|יום|ש'|י'|דק')/g, '')
    .replace(/[^\p{L}]+/gu, '')
    .toLowerCase();
}

/**
 * True when both texts are the same post (the same ad shared to several groups), even when the
 * interface text around them differs. Compares a stretch from the middle of the shorter text.
 */
function samePost(a, b) {
  const x = letters(a);
  const y = letters(b);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // A short post ("אשמח לדיג'י למסיבה מומלץ מניסיון תודה") must match exactly.
  if (short.length < 40) return short.length >= 12 && short === long;
  const start = Math.floor(short.length * 0.25);
  const piece = short.slice(start, start + Math.min(150, short.length - start));
  return long.includes(piece);
}

module.exports = { cleanPostText, samePost, fixBrokenChars };
