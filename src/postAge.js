// Parse Facebook post timestamps (Hebrew + English) into an age in milliseconds.
//
// Facebook shows timestamps in many forms:
//   "עכשיו", "5 דק'", "3 ש'", "2 י'", "שבוע", "אתמול בשעה 14:00",
//   "28 בספטמבר", "יום ראשון, 28 בספטמבר 2025 בשעה 10:00",
//   "Just now", "5m", "3h", "2d", "1w", "Yesterday at 2:00 PM", "September 28".
//
// parsePostAge() returns the age in ms, or null when the text can't be understood.
// Callers treat null as "unknown age" and skip the post (safe default).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const HEB_MONTHS = {
  ינואר: 1, פברואר: 2, מרץ: 3, מרס: 3, אפריל: 4, מאי: 5, יוני: 6,
  יולי: 7, אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12,
};
const EN_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
// JS getDay(): Sunday=0 .. Saturday=6
const WEEKDAYS = {
  ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const NUM = String.raw`(\d+)\s*`;
// Order matters: weeks ("שב'") must be checked before hours ("ש'").
const RELATIVE = [
  [new RegExp(NUM + String.raw`(שב'|שבוע|שבועות|w|wk|wks|week|weeks)$`), WEEK],
  [new RegExp(NUM + String.raw`(ד'|דק'|דקה|דקות|m|min|mins|minute|minutes)$`), MINUTE],
  [new RegExp(NUM + String.raw`(ש'|שעה|שעות|h|hr|hrs|hour|hours)$`), HOUR],
  [new RegExp(NUM + String.raw`(י'|יום|ימים|d|day|days)$`), DAY],
  [new RegExp(NUM + String.raw`(ח'|חודש|חודשים|mo|mos|month|months)$`), 30 * DAY],
  [new RegExp(NUM + String.raw`(שנה|שנים|y|yr|yrs|year|years)$`), 365 * DAY],
];
const WORDS = {
  עכשיו: 0, 'ממש עכשיו': 0, 'just now': 0, now: 0, היום: 0, today: 0,
  אתמול: DAY, yesterday: DAY,
  דקה: MINUTE, שעה: HOUR, שעתיים: 2 * HOUR,
  יום: DAY, יומיים: 2 * DAY, שבוע: WEEK, שבועיים: 2 * WEEK,
  חודש: 30 * DAY, חודשיים: 60 * DAY, שנה: 365 * DAY,
  'a minute': MINUTE, 'an hour': HOUR, 'a day': DAY, 'a week': WEEK,
};

const HEB_DATE = new RegExp(String.raw`(\d{1,2})\s*ב?(` + Object.keys(HEB_MONTHS).join('|') + String.raw`)(?:\s*,?\s*(\d{4}))?`);
const EN_NAMES = Object.keys(EN_MONTHS).join('|');
const EN_DATE_MD = new RegExp(String.raw`(` + EN_NAMES + String.raw`)\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b`);
const EN_DATE_DM = new RegExp(String.raw`\b(\d{1,2})\s+(` + EN_NAMES + String.raw`)\.?(?:\s*,?\s*(\d{4}))?\b`);
const NUMERIC_DATE = /\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/;
const TIME_SUFFIX = /\s*(בשעה|at|ב-?)\s*\d{1,2}:\d{2}.*$/;

function normalize(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[׳’`´]/g, "'")                                  // geresh variants
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // direction marks
    .replace(/\s+/g, ' ')
    .replace(/^לפני\s+/, '')                                  // "לפני 3 שעות"
    .replace(/\s+ago$/, '')                                   // "3 hours ago"
    .replace(/^[\s·.]+|[\s·.]+$/g, '');
}

function fromDate(day, month, year, now) {
  let when = new Date(year || now.getFullYear(), month - 1, day);
  if (when.getMonth() !== month - 1) return null; // invalid date like 31/2
  // "28 בדצמבר" seen in January means last year.
  if (!year && when.getTime() > now.getTime() + DAY) {
    when = new Date(now.getFullYear() - 1, month - 1, day);
  }
  return Math.max(now.getTime() - when.getTime(), 0);
}

function parsePostAge(text, now = new Date()) {
  if (!text) return null;
  const t = normalize(text);
  if (!t) return null;
  const short = t.replace(TIME_SUFFIX, '').trim();

  if (short in WORDS) return WORDS[short];

  for (const [regex, unit] of RELATIVE) {
    const m = short.match(regex);
    if (m) return Number(m[1]) * unit;
  }

  // Weekday only ("יום שישי בשעה 10:00" / "Friday at 10:00") = within the last week.
  const weekday = WEEKDAYS[short.replace(/^יום /, '')];
  if (weekday !== undefined) {
    const daysBack = ((now.getDay() - weekday + 7) % 7) || 7;
    return daysBack * DAY;
  }

  let m = t.match(HEB_DATE);
  if (m) return fromDate(Number(m[1]), HEB_MONTHS[m[2]], m[3] && Number(m[3]), now);
  m = t.match(EN_DATE_MD);
  if (m) return fromDate(Number(m[2]), EN_MONTHS[m[1]], m[3] && Number(m[3]), now);
  m = t.match(EN_DATE_DM);
  if (m) return fromDate(Number(m[1]), EN_MONTHS[m[2]], m[3] && Number(m[3]), now);
  m = t.match(NUMERIC_DATE);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return fromDate(Number(m[1]), Number(m[2]), year, now); // Israeli format: day/month/year
  }
  return null;
}

/** True only when the age is known AND at most maxDays ("3 ימים" counts as 3 days). */
function isRecent(text, maxDays = 3, now = new Date()) {
  const age = parsePostAge(text, now);
  return age !== null && age <= maxDays * DAY;
}

function describeAge(ms) {
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} דקות`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} שעות`;
  return `${Math.round(ms / DAY)} ימים`;
}

module.exports = { parsePostAge, isRecent, describeAge, MINUTE, HOUR, DAY, WEEK };
