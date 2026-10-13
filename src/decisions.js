// decisions.jsonl: one line per post the agent decided about, so missed and wrong posts can be
// found afterwards. Sent posts, posts it meant to send but skipped (old, no time, same text),
// posts ruled out by an exclusion, and posts that mention a DJ / music but weren't recognized.
// The panel's "reset" button empties it (after sending it for review).

const fs = require('fs');

class DecisionLog {
  constructor(file) {
    this.file = file;
    this.seen = new Set(); // "key|decision", so a post that stays on the page isn't written every round
    this.load();
  }

  load() {
    this.seen.clear();
    if (!this.file || !fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      try {
        const d = JSON.parse(line);
        this.seen.add(`${d.url}|${d.decision}`);
      } catch {
        // an empty or broken line
      }
    }
  }

  /** entry: { decision, reason, url, group, author, age, text, phrase, by } */
  add(entry) {
    if (!this.file) return;
    if (!fs.existsSync(this.file)) this.seen.clear(); // reset from the panel
    const id = `${entry.url}|${entry.decision}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const line = { time: new Date().toISOString(), ...entry, text: String(entry.text || '').slice(0, 1500) };
    fs.appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8');
  }

  /** { count, bytes, since } for the panel. */
  summary() {
    if (!this.file || !fs.existsSync(this.file)) return { count: 0, bytes: 0, since: null };
    const text = fs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    let since = null;
    try {
      since = lines.length ? JSON.parse(lines[0]).time : null;
    } catch {
      // ignore
    }
    return { count: lines.length, bytes: Buffer.byteLength(text), since };
  }

  reset() {
    if (this.file && fs.existsSync(this.file)) fs.unlinkSync(this.file);
    this.seen.clear();
  }
}

module.exports = { DecisionLog };
