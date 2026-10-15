// The Windows console draws every line left-to-right, so Hebrew comes out backwards.
// toVisual() pre-reverses a line for display: the line is mirrored as a right-to-left
// paragraph, while runs of English/digits ("Eran Levi", "DJ", "3", URLs) keep their order.
// Used only for what is printed to the console; dj_agent.log keeps the normal text.

const HEBREW = /[\u0590-\u05FF]/;
// One English/number "word": starts and ends with a letter/digit (or "/" for URLs), may contain
// URL and time punctuation inside ("20:40", "dj.israel", "https://...").
const LTR_WORD = /[A-Za-z0-9](?:[A-Za-z0-9.,:/\-_@%?=&#+~'!*]*[A-Za-z0-9/])?/g;
const HAS_LETTER = /[A-Za-z]/;
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
const DIRECTION_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (s) => Array.from(segmenter.segment(s), (x) => x.segment);

/** Splits text into [{ ltr, text }] runs. English words separated by single spaces form one run. */
function runs(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(LTR_WORD)) {
    const gap = text.slice(last, m.index);
    const prev = out[out.length - 1];
    if (prev && prev.ltr && gap === ' ' && HAS_LETTER.test(prev.text) && HAS_LETTER.test(m[0])) {
      prev.text += gap + m[0]; // "Eran Levi" stays one run
    } else {
      if (gap) out.push({ ltr: false, text: gap });
      out.push({ ltr: true, text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ ltr: false, text: text.slice(last) });
  return out;
}

let enabled = process.platform === 'win32';

function setTerminalHebrewFix(value) {
  if (value === true || value === false) enabled = value;
}

/** One line of text as it should be printed so a left-to-right console shows it right. */
function toVisual(line) {
  const clean = line.replace(DIRECTION_MARKS, '');
  if (!HEBREW.test(clean)) return clean;
  const lead = clean.match(/^\s*/)[0]; // keep indentation on the left
  const out = runs(clean.slice(lead.length))
    .reverse()
    .map((r) => (r.ltr ? r.text : graphemes(r.text).reverse().map((c) => MIRROR[c] || c).join('')))
    .join('');
  return lead + out;
}

/** Text for the console: every line converted when the fix is on. */
function forTerminal(text) {
  if (!enabled) return text;
  return String(text).split('\n').map(toVisual).join('\n');
}

module.exports = { toVisual, forTerminal, setTerminalHebrewFix };
