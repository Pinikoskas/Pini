// What the WhatsApp messages "הבוט הופעל" / "הבוט נעצר" / "הבוט חזר מעדכון" need to know.
// bot_state.json (on this computer): is the bot running, why it stopped last, which update notes were sent.
// UPDATE_NOTES.json (comes with each update): what changed, and missed posts found in the review.

const fs = require('fs');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const readState = (file) => readJson(file, {});
const writeState = (file, state) => fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');

/** { id, changes: [..], missed_posts: [{ url, text }] }, or null when there is none. */
function readUpdateNotes(file) {
  const notes = readJson(file, null);
  return notes && notes.id ? notes : null;
}

const STOP_TEXT = {
  update: '🔄 הבוט נעצר לצורך עדכון',
  user: '⏹ הבוט נעצר',
  closed: '⏹ הבוט נעצר (חלון הבוט נסגר)',
};

/** The WhatsApp messages to send when the bot starts: the first one, then one per missed post. */
function startMessages(state, notes) {
  const newNotes = notes && notes.id !== state.update_id;
  const fromUpdate = newNotes || state.stop_reason === 'update';
  let first = fromUpdate ? '✅ הבוט חזר מעדכון והופעל' : '▶️ הבוט הופעל';
  if (state.running) first += '\n(בפעם הקודמת הבוט נסגר בלי עצירה רגילה: כיבוי מחשב, קריסה או סגירה בכוח)';
  if (!newNotes) return [first];
  const changes = notes.changes || [];
  const missed = notes.missed_posts || [];
  if (changes.length) first += `\n\nמה היה בעדכון:\n${changes.map((c) => `• ${c}`).join('\n')}`;
  if (missed.length) first += `\n\nפוסטים שפוספסו ונמצאו בבדיקה (${missed.length}) – נשלחים עכשיו:`;
  return [first, ...missed.map((p) => `📌 פוסט שפוספס${p.group ? ` – ${p.group}` : ''}\n${String(p.text || '').trim()}\n${p.url}`)];
}

module.exports = { readState, writeState, readUpdateNotes, startMessages, STOP_TEXT };
