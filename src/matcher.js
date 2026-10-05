// Decide whether a post's text is someone looking for a DJ.

// Spellings of "DJ" people actually write in Hebrew posts.
const DJ_WORD = String.raw`(?:די\s?ג'?\s?יי|דיג'?יי|דיגיי|דיג'י|די\.?ג'י|d\.?j\.?|dj'?s?|תקליטן|תקליטנית)`;

const DEFAULT_INCLUDE = [
  // "מחפש/ת דיג'יי", "צריכים DJ לחתונה", "ממליצים על די ג'יי?"
  String.raw`(?:מחפש|מחפשת|מחפשים|מחפשות|צריך|צריכה|צריכים|דרוש|דרושה|דרושים|` +
    String.raw`ממליצים|ממליצות|המלצה|המלצות|תמליצו|מכירים|מכירות|מישהו מכיר|יש למישהו|יש לכם|` +
    String.raw`looking for|need|recommend)[^\n.!?]{0,40}?` + DJ_WORD,
  // "DJ לחתונה / לבר מצווה / לאירוע ... ?"
  DJ_WORD + String.raw`\s*(?:טוב\s*)?ל(?:חתונה|בר|בת|אירוע|מסיבה|חינה|ברית|יום הולדת)[^\n]{0,60}\?`,
];

// Posts from DJs advertising themselves, not people looking for one.
const DEFAULT_EXCLUDE = [
  String.raw`אני\s+` + DJ_WORD,
  String.raw`(?:פנוי|פנויה|זמין|זמינה)\s+ל(?:אירועים|תאריכים)`,
  String.raw`מחפש(?:ת)?\s+(?:עבודה|אירועים|הופעות|לקוחות)`,
  // Students looking for a DJ teacher / course: "מחפש מורה ל-DJ", "שיעורי DJ"
  String.raw`(?:מורה|מורים|שיעור|שיעורי|קורס|קורסים|ללמוד|לימודי)\s*(?:ל-?|ב-?)?\s*` + DJ_WORD,
  // Buying / selling equipment: "מחפש לקנות עמדת DJ", "מוכר ציוד DJ"
  String.raw`(?:לקנות|קונה|למכור|מוכר|מוכרת|עמדת|עמדה|ציוד|קונטרולר|controller|מיקסר)[^\n.!?]{0,15}` + DJ_WORD,
];

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
    return this.include.some((rx) => rx.test(t));
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
