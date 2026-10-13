// When the agent works: active hours (e.g. 08:00–00:00), and which groups to scan this round.

const { isDjGroupName } = require('./matcher');

const DAY = 24 * 60 * 60 * 1000;

/** "08:00" -> minutes since midnight (480). "00:00" as an end time means midnight (1440). */
function parseClock(text, { isEnd = false } = {}) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return isEnd && minutes === 0 ? 1440 : minutes;
}

function hours(cfg) {
  const from = parseClock(cfg.active_from ?? '08:00');
  const until = parseClock(cfg.active_until ?? '00:00', { isEnd: true });
  return from == null || until == null || from === until ? null : { from, until }; // null = always
}

function inActiveHours(cfg, date = new Date()) {
  const h = hours(cfg);
  if (!h) return true;
  const m = date.getHours() * 60 + date.getMinutes();
  return h.from < h.until ? m >= h.from && m < h.until : m >= h.from || m < h.until;
}

/** The next moment (from `date` on) inside the active hours. */
function nextActiveTime(cfg, date = new Date()) {
  if (inActiveHours(cfg, date)) return date;
  const h = hours(cfg);
  const start = new Date(date);
  start.setHours(Math.floor(h.from / 60), h.from % 60, 0, 0);
  if (start <= date) start.setTime(start.getTime() + DAY);
  return start;
}

/**
 * Groups that brought a matching post in the last `strongDays` days, and groups about DJs, are
 * scanned every round.
 * Other groups every `weakEvery` rounds: only when their last scan is older than that many
 * round intervals (a group never scanned is always scanned).
 */
function isDueThisRound(source, { leads, lastCheckedAt, everyMinutes, now = Date.now(), strongDays = 30, weakEvery = 3 }) {
  if (!source.groupId) return true; // the main feed
  const since = now - strongDays * DAY;
  const strong = leads.some(
    (a) => Date.parse(a.createdAt) > since && (a.groupId === source.groupId || String(a.postKey).includes(`/groups/${source.groupId}/`)),
  );
  if (strong || isDjGroupName(source.groupName) || !lastCheckedAt || !everyMinutes) return true;
  // A little slack so a round that started slightly early doesn't skip the group again.
  return now - Date.parse(lastCheckedAt) >= (weakEvery - 0.5) * everyMinutes * 60 * 1000;
}

/**
 * The order of a round: the feed, then groups that brought matching posts in the last 30 days
 * (most first), then groups about DJs, then the rest as in groups.txt. So the most useful pages
 * are scanned first, even when the round runs long.
 */
function orderSources(sources, leads, { now = Date.now(), strongDays = 30 } = {}) {
  const since = now - strongDays * DAY;
  const count = (s) =>
    leads.filter((a) => Date.parse(a.createdAt) > since && (a.groupId === s.groupId || String(a.postKey).includes(`/groups/${s.groupId}/`))).length;
  const rank = (s) => (!s.groupId ? [0, 0] : count(s) ? [1, -count(s)] : isDjGroupName(s.groupName) ? [2, 0] : [3, 0]);
  return sources
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
    .map((x) => x.s);
}

module.exports = { parseClock, inActiveHours, nextActiveTime, isDueThisRound, orderSources };
