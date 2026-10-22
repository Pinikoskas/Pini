// rounds.json: a short record of every finished round (when, how long, how many posts and
// leads, and how long each page took). The panel draws its chart from it, and the time each
// page took last rounds gives the estimated end of the current round.

const fs = require('fs');

const KEEP = 200;
const RECENT = 5; // rounds used for each page's typical duration

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

class RoundStats {
  constructor(file) {
    this.file = file;
    this.reload();
  }

  reload() {
    this.rounds = [];
    try {
      if (this.file && fs.existsSync(this.file)) this.rounds = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.rounds = [];
    }
  }

  /** round: { started_at, finished_at, duration_ms, pages, posts, leads, dry_run, page_ms: { key: ms } } */
  add(round) {
    this.reload();
    this.rounds.push(round);
    this.rounds = this.rounds.slice(-KEEP);
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.rounds, null, 2), 'utf8');
  }

  /** The latest rounds, oldest first. */
  list(n = 30) {
    return this.rounds.slice(-n);
  }

  /** Typical length of a whole round (median of the recent ones), or null. */
  typicalRoundMs() {
    return median(this.rounds.slice(-RECENT).map((r) => r.duration_ms).filter((ms) => ms > 0));
  }

  /** Typical time for one page: its median over recent rounds, else the median of all pages. */
  pageEstimate(key) {
    const recent = this.rounds.slice(-RECENT);
    const own = recent.map((r) => r.page_ms && r.page_ms[key]).filter((ms) => ms > 0);
    if (own.length) return median(own);
    return median(recent.flatMap((r) => Object.values(r.page_ms || {})).filter((ms) => ms > 0));
  }

  /**
   * Milliseconds left in the round, for the pages from `fromIndex` on. Pages never seen before
   * use the typical page; with no history at all, the pages done so far this round.
   */
  remainingMs(keys, fromIndex, doneThisRound = []) {
    const fallback = this.pageEstimate('__none__') ?? median(doneThisRound);
    let total = 0;
    for (const key of keys.slice(fromIndex)) {
      const ms = this.pageEstimate(key) ?? fallback;
      if (ms == null) return null;
      total += ms;
    }
    return total;
  }
}

module.exports = { RoundStats };
