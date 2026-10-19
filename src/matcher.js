// Decide whether a post's text is someone looking for a DJ.

// Spellings of "DJ" people actually write in Hebrew posts.
// Supports all common variations with/without geresh, spaces, hyphens, and plurals:
// דיג'יי, דיג'י, די ג'יי, די ג'י, די גי, דיגיי, דיגי, די-ג'י, דייג'י, דייגי, דייג'יים, דייגיים,
// תקליטן, תקליטנית, תקליטנים, תקליטניות, פעלים (לתקלט, שיתקלט), and English (DJ, DJs, deejay).
const DJ_WORD = String.raw`(?:` +
  // די / די- / די עם או בלי גרש: די ג'י, דיג'י, די גי, דיגי, דיג'יי, דיגיי, דיג'יים, דיגיים
  String.raw`די[\s.-]?ג'?(?:יי|אי|י)(?:[וֹ]?ת|[יִ]?ם)?(?![א-ת])|` +
  // דיי עם גרש: דייג'י, דייג'יי, דייג'ים, דייג'יים, דיי ג'י, דיי ג'יי...
  String.raw`דיי[\s.-]?ג'(?:יי|אי|י)(?:[וֹ]?ת|[יִ]?ם)?(?![א-ת])|` +
  // דיי בלי גרש: דייגי, דייגיי, דייגיים (אך לא "דייג" סתמי ולא "דייגים" בלי הקשר אירוע)
  String.raw`דיי[\s.-]?ג(?:יי|אי|י(?![םן]))(?:[וֹ]?ת|ם)?(?![א-ת])|` +
  // דג'י, דג'יי (חובה גרש כדי לא לתפוס דג/דגים)
  String.raw`דג'(?:יי|אי|י)(?:[וֹ]?ת|[יִ]?ם)?(?![א-ת])|` +
  // תקליטן / תקליטנים / תקליטנית / תקליטניות
  String.raw`תקליטן|תקליטנית|תקליטנים|תקליטניות|` +
  // פעלים של תקלוט
  // "לתקלט / שיתקלט" – not "מתקלט", which describes someone DJing ("איתן מתקלט")
  String.raw`(?:ל|ש|שי|י|ת)?תקלט(?:ת|ו|ה|ים|ות)?(?![א-ת])|` +
  String.raw`תקלוט(?![א-ת])|` +
  // English: dj, djs, d.j., deejay, dee jay
  String.raw`(?<![a-z])(?:d\.?j\.?s?|dj's|dee[\s-]?jay?s?)(?![a-z])` +
  `)`;

// Ways of asking for something: "מחפשים", "מי מכיר", "אשמח להמלצה", "כמה עולה", "חייבים"...
const ASK = String.raw`(?:` +
  String.raw`מחפש|מחפשת|מחפשים|מחפשות|מחפש/ת|מחפשים/ות|(?:ב|מ)חיפוש|` +
  String.raw`צריך|צריכה|צריכים|צריכות|צריך/ה|` +
  String.raw`חייב|חייבת|חייבים|חייבות|` +
  String.raw`דרוש|דרושה|דרושים|דרושות|` +
  String.raw`מבקש|מבקשת|מבקשים|מבקשות|` +
  String.raw`מעוניין|מעוניינת|מעוניינים|מעוניינות|` +
  String.raw`רוצה|רוצים|רוצות|` +
  String.raw`אשמח|נשמח|` +
  // Not "ממליץ/ממליצה" (I recommend) or a bare "מכיר" (I know one): people offering use them.
  String.raw`ממליצים|ממליצות|תמליץ|תמליצי|תמליצו|להמליץ|המלצה|המלצות|מומלץ|מומלצת|מומלצים|מומלצות|` +
  String.raw`מכירים|מכירות|מי\s+ש?מכיר|מישהו\s+ש?מכיר|מישהי\s+ש?מכירה|` +
  // Asking about a DJ before booking: "מישהו לקח את X?", "מה אתם חושבים על הדיגיי X?"
  String.raw`מישהו\s+ש?(?:לקח|סגר|עבד\s+עם)|מישהי\s+ש?(?:לקחה|סגרה|עבדה\s+עם)|` +
  String.raw`מה\s+(?:אתם|את|אתן)\s+חושב(?:ים|ת|ות)?|מה\s+דעתכם|דעתכם|חוות\s+דעת|איך\s+(?:ידעתם|בחרתם|בחרת)|` +
  String.raw`מה\s+(?:ה)?מחיר|מחיר\s+(?:הגיוני|סביר|ממוצע|מקובל)|` +
  String.raw`מישהו\s+יכול|מישהי\s+יכולה|מי\s+יכול|יכולים\s+להמליץ|מי\s+עושה|מישהו\s+עושה|מישהי\s+עושה|` +
  String.raw`אפשר\s+המלצה|אפשר\s+המלצות|יש\s+המלצה|יש\s+המלצות|` +
  String.raw`יש\s+למישהו|יש\s+למישהי|יש\s+לכם|יש\s+לך|` +
  // Not a bare "מחיר/מחירים": every ad has prices ("מחירים מעולים").
  String.raw`כמה\s+עולה|כמה\s+עולים|כמה\s+לוקח|כמה\s+גובה|` +
  String.raw`הצעות\s+מחיר|הצעת\s+מחיר|עלויות|טווח\s+מחירים` +
  `)`;

// Events people hire a DJ for.
const EVENT = String.raw`(?:חתונה|החתונה|מתחתן|מתחתנ(?:ים|ות|ת)|בר[\s-]?מצו|בת[\s-]?מצו|אירוע|אירועים|מסיב|חינה|ברית|בריתה|יום[\s-]?הולדת|יומולדת|אירוסין|שבת[\s-]?חתן|רווקות|רווקים|פרום|נשף|wedding|party|event)`;

const DEFAULT_INCLUDE = [
  // "מחפש/ת דיג'יי", "צריכים DJ לחתונה", "מי מכיר די ג'יי טוב?", "כמה עולה תקליטן?", ורשימות ספקים עם ירידות שורה
  // The gap may hold line breaks and list bullets, but not the end of a sentence (. ! ?).
  ASK + String.raw`[^.!?]{0,100}?` + DJ_WORD,
  // "מחפשים מהמלצות בלבד! דיג'יי מצויין..." – the DJ right after a "!" or ":"
  ASK + String.raw`[^.?\n]{0,30}?[!:]\s*(?:\S+\s+){0,2}?` + DJ_WORD,
  // English, only right next to the DJ ("looking for a dj"): a bare "need" was in ads and job posts
  String.raw`(?:looking\s+for|in\s+search\s+of|need|anyone\s+know|recommend(?:ation)?s?\s+(?:for|on))\s+(?:a\s+|an\s+|some\s+)?(?:good\s+|great\s+)?(?:dj|deejay)(?![a-z])`,
  // "דיג'יי מומלץ לחתונה", "תקליטן טוב מי מכיר" – in the same sentence
  DJ_WORD + String.raw`[^\n.!?]{0,60}?(?:מומלץ|מומלצת|מומלצים|מומלצות|מי\s+ש?מכיר|מישהו\s+ש?מכיר|מכירים|ממליצים|ממליצות|ממליצה?\s*\?|המלצות?|דרוש|דרושה|דרושים)`,
  // "DJ לחתונה / לבר מצווה / לאירוע ... ?"
  DJ_WORD + String.raw`[\s\S]{0,40}?ל-?` + EVENT + String.raw`[\s\S]{0,80}\?`,
  // "חתונה בספטמבר, דיג'יי טוב באזור?"
  EVENT + String.raw`[\s\S]{0,60}?` + DJ_WORD + String.raw`[\s\S]{0,50}\?`,
  // "דיג'יי מי פנוי בתאריך...?"
  DJ_WORD + String.raw`[\s\S]{0,30}?(?:מי\s+)?(?:פנוי|פנויה|פנויים|זמין|זמינה|זמינים)`,
  // "איזה דיג'יי מומלץ", "מי הדיג'יי"
  String.raw`(?:איזה|איזו)\s+(?:ה)?` + DJ_WORD,
  // טעויות הקלדה נפוצות כמו "מחפשים דייגים לחתונה" (דייגים בהקשר אירוע)
  ASK + String.raw`[\s\S]{0,30}?דייגים[\s\S]{0,30}?(?:ל-?` + EVENT + `|` + EVENT + `)`
];

// Posts that mention a DJ but aren't someone looking to hire one.
const DEFAULT_EXCLUDE = [
  // DJs advertising themselves: "אני דיג'יי", "נעים מאוד, אני תומר, דיג'יי עם...", "לאירוע שלכם"
  String.raw`(?:אני|אנחנו)\s+(?:ה)?` + DJ_WORD,
  String.raw`(?:אני|אנחנו)\s+[^\n.!?]{1,30}?[,\-–]\s*(?:ה)?` + DJ_WORD,
  String.raw`(?:שמי|נעים\s+מאוד[,\s]+אני)\s+[^\n.!?]{1,25}?` + DJ_WORD,
  String.raw`(?:ל|ב)?(?:אירוע|אירועים|חתונה|מסיבה)\s+שלכ[םן]|מתמח(?:ה|ים|ות)\s+ב|אני כאן`,
  String.raw`(?:פנוי|פנויה|פנויים|זמין|זמינה|זמינים)\s+ל(?:אירועים|תאריכים|הזמנות)`,
  String.raw`תאריכים\s+(?:אחרונים\s+)?(?:פנויים|אחרונים)|נשארו\s+תאריכים`,
  String.raw`להזמנות|לתיאום\s+(?:אירוע|פגישה)|לשריון\s+תאריך|סגירת\s+אירועים`,
  String.raw`חבילות\s+(?:אירוע|ספקים|משתלמות)|מבצע\s+(?:מיוחד|חורף|קיץ)|רק\s+אצל|במחירי\s+(?:היכרות|השקה)|במחיר\s+(?:ללא\s+תחרות|מנצח|מוזל)`,
  // Ad-specific contact prompts (do NOT exclude legitimate client posts that say "לפרטים בפרטי" or "צרו איתי קשר בפרטי")
  String.raw`לפרטים\s+(?:והזמנות|נוספים\s+חייגו|בטלפון|בפלאפון|בוואטסאפ\s+חייגו)|לפרטים:\s*0\d`,
  String.raw`חייגו\s+עכשיו|התקשרו\s+עכשיו|צרו\s+קשר\s+עוד\s+היום`,
  String.raw`לינק\s+בביו|קישור\s+בביו|סט\s+חדש|מיקס\s+חדש|הרגע\s+עלה|מוזמנים\s+להאזין`,
  String.raw`תייגו\s+(?:זוגות|חברים|כלות|חתנים)`,
  String.raw`(?:יעשה|נעשה|נסדר|נדאג|נתאים|ניתן)\s+לכ[םן]\s+(?:בראש|שמח|קרחנה)`,

  // From the decisions file (13–14/10): DJ teams, link-in-bio ads, apps for DJs, stories
  String.raw`(?:אני|אנחנו)\s+(?:צוות|חברת|להקת|הרכב)\s+(?:של\s+)?(?:ה)?` + DJ_WORD + String.raw`|פותחים\s+תאריכים`,
  String.raw`linktr\.ee|זה\s+הזמן\s+ל(?:בדוק|הזמין|סגור)|הצטרפו\s+ל|בתגובה\s+הראשונה`,
  String.raw`כל\s+מה\s+ש(?:ה)?` + DJ_WORD + String.raw`\s+צריך`,
  String.raw`ה?המלצה\s+(?:היא|שלי)\s+(?:על|ל)`,

  // DJs looking for work, partners or gigs
  String.raw`מחפש(?:ת|ים)?\s+(?:עבודה|אירועים|הופעות|לקוחות|שותף|שותפה|להצטרף|משרה|גיגים|לתקלט)`,

  // Job ads: "דרושים מלצרים ודיג'יי לחברת אירועים, שכר גבוה"
  String.raw`(?:דרוש|דרושה|דרושים|דרושות)[\s\S]{0,60}?(?:לעבודה|למשרה|משמרות|שכר|לצוות|לחברת\s+אירועים)`,

  // Students looking for a DJ teacher / course: "מחפש מורה ל-DJ", "שיעורי DJ"
  String.raw`(?:מורה|מורים|שיעור|שיעורי|קורס|קורסים|ללמוד|לימודי)\s*(?:ל-?|ב-?)?\s*` + DJ_WORD,

  // Buying / selling equipment: "מחפש לקנות עמדת DJ", "מוכר ציוד DJ"
  // "אשמח להמלצות על עמדת אפטר לדיג'י" is someone looking for a DJ station, not for a DJ (owner's call).
  String.raw`(?:לקנות|קונה|למכור|מוכר|מוכרת|קונטרולר|controller|מיקסר)[\s\S]{0,20}?` + DJ_WORD,
  // "עמדת אפטר לדיג'י", "ציוד DJ" – but not "...שמגיעה עם כל הציוד. מחפשת דייגית"
  String.raw`(?:עמדת|עמדה|ציוד)\s+(?:\S+\s+)?(?:ל|של\s+)?(?:ה)?` + DJ_WORD,
  DJ_WORD + String.raw`[\s\S]{0,20}?(?:למכירה|יד\s+2|יד\s+שנייה|במצב\s+מעולה)`,

  // Recommending or thanking a DJ after the event: "ממליצה בחום על הדיג'יי", "תודה לדיג'יי"
  String.raw`(?:ממליץ|ממליצה|ממליצים|ממליצות)\s+בחום|(?<!(?:מי|מישהו|מישהי)\s)(?:רוצה|רציתי|רוצים|רצינו|חייבת|חייב|חייבים)\s+להמליץ|פוסט\s+המלצה|הבחירה\s+הכי\s+טובה\s+שלנו|(?:רוצה|רציתי|רוצים|רצינו)\s+לפרגן|לפרגן\s+ל|תודה(?:\s+רבה)?\s+ל(?:ה)?` + DJ_WORD,
  String.raw`אין\s+על\s+(?:ה)?` + DJ_WORD + String.raw`|הדיג\x27יי\s+שלנו\s+היה`,

  // Already have one: "את הדיג'יי כבר סגרנו", "יש לנו דיג'יי, מחפשים צלם"
  String.raw`(?:סגרנו|הזמנו|יש לנו|יש לי)\s+(?:כבר\s+)?(?:את\s+)?(?:ה)?` + DJ_WORD + String.raw`|(?:את\s+)?(?:ה)?` + DJ_WORD + String.raw`\s+(?:כבר\s+)?(?:סגרנו|סגור|הזמנו|יש)`,

  // Tips / marketing posts: "איך בוחרים דיג'יי לבת מצווה ולא מתחרטים? בקשו לראות סרטונים, בדקו המלצות..."
  // From the decisions file (14–19/10): hashtags and deals, portfolio ads, events with sign-up,
  // a memorial call, and people looking for a venue who will bring their own DJ
  String.raw`#[\u0590-\u05ffa-z0-9_]{3,}|עושים\s+לך|דיל\s+מטורף|תיק\s+(?:ה)?עבודות|ואתם\s+מרוויחים|לאור\s+הביקוש`,
  String.raw`ההרשמה\s+נפתחה|לרכישת\s+כרטיסים|קול\s+קורא|ארכיון|כדאי\s+שנדבר|סגרתם\s+כבר`,
  String.raw`להביא\s+(?:את\s+)?(?:ה)?` + DJ_WORD,

  // Looking for a song, not a DJ: "מחפשת את השיר שהדיג'יי שם"
  String.raw`מחפש(?:ת|ים)?\s+(?:את\s+)?(?:ה)?(?:שיר|רמיקס|סט|טראק|פלייליסט)`,
];

// Tips and marketing ("איך בוחרים דיג'יי? בקשו לראות סרטונים..."). Not applied to a personal question
// ("אשמח לקבל טיפים לבחירת די-ג'יי?", "איך בוחרים דייגי אם אין לנו מושג?"), which is a lead.
const ADVICE_EXCLUDE = new RegExp(
  String.raw`איך\s+(?:בוחרים|לבחור|למצוא|מוצאים)|טיפים\s+ל|מדריך|לפני\s+(?:ש|שאתם\s+)סוגרים|(?:בקשו|בדקו|ודאו|תוודאו|אל תסתכלו)\s|חוגגים\s+פעם\s+אחת`,
  'i',
);
// Signs of someone asking for themselves. Not "נשמח" / "תודה": ads write "נשמח לעזור".
const PERSONAL_WORDS = /אשמח|אודה|עזרה|מושג|מתלבט|(?<![א-ת])לנו(?![א-ת])/;
const isAdvicePost = (t) => ADVICE_EXCLUDE.test(t) && !PERSONAL_WORDS.test(t);

// Real fishing ("דייגים" is also a phone's autocorrect of "דיג'יים"). Only checked when "דייגים" is
// the only DJ-like word, so "חתונה בכנרת, מחפשים דיג'יי" still passes.
const FISHING = /לדוג|דגים|חכה|חכות|פיתיון|פיתיונות|רשת\s+דייג|סירת\s+דייג|ציוד\s+דייג|סירה|לדיג|דיג\s/;

// Worth a look even when it isn't recognized as a request: any DJ-like word, even misspelled, or
// music / sound. These go to the decisions file, to find requests the patterns miss.
const CANDIDATE = new RegExp(DJ_WORD + String.raw`|דיג|דייג|די\s?ג|דג'|ג'יי|תקליט|תקלט|deejay|\bdj|מוזיקה|מוסיקה|הגברה|רמקול|פלייליסט`, 'i');

// A post cut off by "See more" whose visible start hints at a request: read all of it.
const TRUNCATED = /(?:ראה עוד|ראו עוד|הצג עוד|עוד\.\.\.|see more|…)\s*$/i;
const REQUEST_HINT = new RegExp(ASK + '|' + EVENT, 'i');

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[׳’`´"״]/g, "'")
    .replace(/'+/g, "'")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[–—־]/g, '-')
    .replace(/([\u05d0-\u05ea])\1{2,}/g, '$1$1') // "דיג'ייייי" -> "דיג'יי"
    .replace(/[ \t]+/g, ' ');
}

class PostMatcher {
  constructor(include, exclude) {
    const compile = (list) => list.map((p) => new RegExp(p, 'i'));
    this.include = compile(include && include.length ? include : DEFAULT_INCLUDE);
    this.exclude = compile(exclude && exclude.length ? exclude : DEFAULT_EXCLUDE);
    this.djWord = new RegExp(DJ_WORD, 'i');
  }

  /** Mentions a DJ (even misspelled) or music / sound: recorded in the decisions file. */
  isCandidate(text) {
    return CANDIDATE.test(normalize(text));
  }

  /** Cheap pre-check (ignores exclusions) used before reading the post in detail. */
  mightMatch(text) {
    const t = normalize(text);
    if (this.include.some((rx) => rx.test(t))) return true;
    return TRUNCATED.test(t.trim()) && REQUEST_HINT.test(t);
  }

  /**
   * The full decision, with the reason, for the decisions file:
   *   { kind: 'dj', phrase }                      – a request (to send)
   *   { kind: 'excluded', phrase, by }            – looked like a request, ruled out by `by`
   *   { kind: 'none', candidate: true|false }     – not a request; candidate = mentions DJ / music
   */
  classify(text) {
    const t = normalize(text);
    const first = (list) => {
      for (const rx of list) {
        const m = t.match(rx);
        if (m) return m[0];
      }
      return null;
    };
    const dj = first(this.include);
    const excludedBy = first(this.exclude) || (isAdvicePost(t) ? (t.match(ADVICE_EXCLUDE) || [''])[0] : null);
    if (dj) {
      if (excludedBy) return { kind: 'excluded', phrase: dj, by: excludedBy };
      if (FISHING.test(t) && !this.djWord.test(t)) return { kind: 'excluded', phrase: dj, by: (t.match(FISHING) || [''])[0] };
      return { kind: 'dj', phrase: dj };
    }
    return { kind: 'none', candidate: CANDIDATE.test(t) };
  }

  /** Returns the matched phrase, or null if the post isn't a DJ request. */
  match(text) {
    const t = normalize(text);
    if (this.exclude.some((rx) => rx.test(t)) || isAdvicePost(t)) return null;
    if (FISHING.test(t) && !this.djWord.test(t)) return null;
    for (const rx of this.include) {
      const m = t.match(rx);
      if (m) return m[0];
    }
    return null;
  }
}

/** A group about DJs (scanned early in the round): its name has "דיג'יי", "DJ", "תקליטן"... */
function isDjGroupName(name) {
  return new RegExp(DJ_WORD, 'i').test(normalize(String(name || '')));
}

module.exports = { PostMatcher, DEFAULT_INCLUDE, DEFAULT_EXCLUDE, DJ_WORD, ASK, EVENT, isDjGroupName };
