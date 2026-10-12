// Decide whether a post's text is someone looking for a DJ.

// Spellings of "DJ" people actually write in Hebrew posts.
// The English forms must be whole words, so "dji" (drones) or "djembe" don't count.
const DJ_WORD = String.raw`(?:די[\s-]?ג'?\s?(?:יי|אי)|דיג'?(?:יי|אי)|דיגיי|דיג'י|דג'יי|די\.?ג'י|(?<![a-z])(?:d\.?j\.?|dj'?s?)(?![a-z])|תקליטן|תקליטנית|תקליטנים)`;

// Ways of asking for something: "מחפשים", "מי מכיר", "אשמח להמלצה", "כמה עולה"...
const ASK = String.raw`(?:מחפש|מחפשת|מחפשים|מחפשות|צריך|צריכה|צריכים|צריכות|דרוש|דרושה|דרושים|` +
  String.raw`מבקש|מבקשת|מבקשים|מעוניין|מעוניינת|מעוניינים|רוצים|אשמח|נשמח|` +
  String.raw`ממליצים|ממליצות|תמליצו|תמליצי|להמליץ|המלצה|המלצות|מומלץ|מומלצת|מומלצים|` +
  String.raw`מכירים|מכירות|מי מכיר|מישהו מכיר|מישהי מכירה|יש למישהו|יש למישהי|יש לכם|יש לך|` +
  String.raw`כמה עולה|כמה עולים|כמה לוקח|כמה גובה|הצעות מחיר|הצעת מחיר|` +
  String.raw`looking for|need|recommend|anyone know)`;

// Events people hire a DJ for.
const EVENT = String.raw`(?:חתונה|החתונה|בר מצו|בת מצו|בר-מצו|בת-מצו|אירוע|מסיב|חינה|ברית|יום הולדת|יומולדת|אירוסין|שבת חתן|רווקות|רווקים|פרום|wedding|party|event)`;

const DEFAULT_INCLUDE = [
  // "מחפש/ת דיג'יי", "צריכים DJ לחתונה", "מי מכיר די ג'יי טוב?", "כמה עולה תקליטן?"
  ASK + String.raw`[^\n.!]{0,60}?` + DJ_WORD,
  // "DJ לחתונה / לבר מצווה / לאירוע ... ?"
  DJ_WORD + String.raw`[^\n.!?]{0,20}?ל-?` + EVENT + String.raw`[^\n]{0,80}\?`,
  // "חתונה בספטמבר, דיג'יי טוב באזור?"
  EVENT + String.raw`[^\n.!?]{0,60}?` + DJ_WORD + String.raw`[^\n.!?]{0,40}\?`,
];

// Posts that mention a DJ but aren't someone looking to hire one.
const DEFAULT_EXCLUDE = [
  // DJs advertising themselves
  String.raw`(?:אני|אנחנו)\s+(?:ה)?` + DJ_WORD,
  String.raw`(?:פנוי|פנויה|פנויים|זמין|זמינה|זמינים)\s+ל(?:אירועים|תאריכים|הזמנות)`,
  String.raw`תאריכים\s+(?:אחרונים\s+)?(?:פנויים|אחרונים)`,
  String.raw`להזמנות|לתיאום אירוע|לקבלת הצעת מחיר|צרו (?:איתי |איתנו )?קשר|חייגו|חבילות|מבצע מיוחד`,
  // DJs looking for work, partners or gigs
  String.raw`מחפש(?:ת|ים)?\s+(?:עבודה|אירועים|הופעות|לקוחות|שותף|שותפה|להצטרף|משרה|גיגים)`,
  // Job ads: "דרושים מלצרים ודיג'יי לחברת אירועים, שכר גבוה"
  String.raw`(?:דרוש|דרושה|דרושים|דרושות)[^\n]{0,60}(?:לעבודה|למשרה|משמרות|שכר|לצוות|לחברת)`,
  // Students looking for a DJ teacher / course: "מחפש מורה ל-DJ", "שיעורי DJ"
  String.raw`(?:מורה|מורים|שיעור|שיעורי|קורס|קורסים|ללמוד|לימודי)\s*(?:ל-?|ב-?)?\s*` + DJ_WORD,
  // Buying / selling equipment: "מחפש לקנות עמדת DJ", "מוכר ציוד DJ"
  String.raw`(?:לקנות|קונה|למכור|מוכר|מוכרת|עמדת|עמדה|ציוד|קונטרולר|controller|מיקסר)[^\n.!?]{0,15}` + DJ_WORD,
  // Recommending or thanking a DJ after the event: "ממליצה בחום על הדיג'יי", "תודה לדיג'יי"
  String.raw`(?:ממליץ|ממליצה|ממליצים|ממליצות)\s+בחום|(?:רוצה|רציתי|רוצים|רצינו)\s+(?:להמליץ|לפרגן)|לפרגן\s+ל|תודה(?:\s+רבה)?\s+ל(?:ה)?` + DJ_WORD,
  // Already have one: "את הדיג'יי כבר סגרנו", "יש לנו דיג'יי, מחפשים צלם"
  String.raw`(?:סגרנו|הזמנו|יש לנו|יש לי)\s+(?:כבר\s+)?(?:את\s+)?(?:ה)?` + DJ_WORD + String.raw`|(?:את\s+)?(?:ה)?` + DJ_WORD + String.raw`\s+(?:כבר\s+)?(?:סגרנו|סגור|הזמנו|יש)`,
  // Tips / marketing posts: "איך בוחרים דיג'יי לבת מצווה ולא מתחרטים? בקשו לראות סרטונים, בדקו המלצות..."
  String.raw`איך\s+(?:בוחרים|לבחור|למצוא|מוצאים)|טיפים|מדריך|לפני\s+(?:ש|שאתם\s+)סוגרים|(?:בקשו|בדקו|ודאו|תוודאו|אל תסתכלו)\s|חוגגים\s+פעם\s+אחת`,
  // Looking for a song, not a DJ: "מחפשת את השיר שהדיג'יי שם"
  String.raw`מחפש(?:ת|ים)?\s+(?:את\s+)?(?:ה)?(?:שיר|רמיקס|סט|פלייליסט)`,
];

// A post cut off by "See more" whose visible start hints at a request: read all of it.
const TRUNCATED = /(?:ראה עוד|ראו עוד|הצג עוד|עוד\.\.\.|see more|…)\s*$/i;
const REQUEST_HINT = new RegExp(ASK + '|' + EVENT, 'i');

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[׳’`´"״]/g, "'")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[ \t]+/g, ' ');
}

class PostMatcher {
  constructor(include, exclude) {
    const compile = (list) => list.map((p) => new RegExp(p, 'i'));
    this.include = compile(include && include.length ? include : DEFAULT_INCLUDE);
    this.exclude = compile(exclude && exclude.length ? exclude : DEFAULT_EXCLUDE);
  }

  /** Cheap pre-check (ignores exclusions) used before reading the post in detail. */
  mightMatch(text) {
    const t = normalize(text);
    if (this.include.some((rx) => rx.test(t))) return true;
    return TRUNCATED.test(t.trim()) && REQUEST_HINT.test(t);
  }

  /** Returns the matched phrase, or null if the post isn't a DJ request. */
  match(text) {
    const t = normalize(text);
    if (this.exclude.some((rx) => rx.test(t))) return null;
    for (const rx of this.include) {
      const m = t.match(rx);
      if (m) return m[0];
    }
    return null;
  }
}

module.exports = { PostMatcher, DEFAULT_INCLUDE, DEFAULT_EXCLUDE };
