// groups.txt: the Facebook groups to scan, one per line ("URL  # name").
// `node index.js --import-groups` fills it from the list of groups you've joined.
// A line starting with # is ignored, so you can switch a group off without losing it.

const fs = require('fs');

const JOINED_GROUPS_URL = 'https://www.facebook.com/groups/joins/';

// Runs in the page: every group link on the "groups you've joined" page.
function jsGroupLinks() {
  const skip = new Set(['joins', 'feed', 'discover', 'create', 'notifications', 'search', 'you', 'learn', 'category']);
  const found = new Map();
  for (const a of document.querySelectorAll('a[href*="/groups/"]')) {
    const m = a.href.match(/facebook\.com\/groups\/([^/?#]+)/);
    if (!m || skip.has(m[1])) continue;
    const name = (a.getAttribute('aria-label') || a.innerText || '').trim().split('\n')[0];
    if (!found.get(m[1])) found.set(m[1], name);
  }
  return [...found].map(([id, name]) => ({ id, name }));
}

function groupKey(url) {
  const m = String(url).match(/facebook\.com\/groups\/([^/?#\s]+)/);
  return m ? m[1] : null;
}

/** Active (not commented-out) groups from groups.txt, as { url, name }. */
function loadGroupsFile(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [url, ...rest] = line.split(/\s+#\s*/);
      return { url: url.trim(), name: rest.join(' #').trim() };
    })
    .filter((g) => groupKey(g.url));
}

/** Every group line in groups.txt, switched on or off: [{ id, url, name, enabled }]. */
function readAllGroups(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const enabled = !line.startsWith('#');
    const body = line.replace(/^#\s*/, '');
    const id = /^https?:\/\//.test(body) ? groupKey(body) : null; // skip plain comment lines
    if (!id) continue;
    const [url, ...rest] = body.split(/\s+#\s*/);
    out.push({ id, url: url.trim(), name: rest.join(' #').trim(), enabled });
  }
  return out;
}

/** Switches groups on/off in groups.txt ({ groupId: true|false }), keeping everything else. */
function setGroupsEnabled(file, changes) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = lines.map((raw) => {
    const body = raw.trim().replace(/^#\s*/, '');
    const id = /^https?:\/\//.test(body) ? groupKey(body) : null;
    if (!id || !(id in changes)) return raw;
    return changes[id] ? body : `# ${body}`;
  });
  fs.writeFileSync(file, out.join('\n'), 'utf8');
}

/**
 * groups_last_seen.json: per group, the newest post checked on the previous scan.
 * The next scan of that group stops when it reaches this post, so it only reads
 * the handful of posts added since.
 */
class GroupsLastSeen {
  constructor(file) {
    this.file = file;
    this.reload();
  }

  reload() {
    this.data = {};
    try {
      if (this.file && fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  write() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  newestPost(groupId) {
    return (this.data[groupId] && this.data[groupId].newest_post) || null;
  }

  // Re-reads the file first, so a bookmark deleted from the control panel isn't written back.
  save(groupId, name, postKey) {
    this.reload();
    this.data[groupId] = { name: name || '', newest_post: postKey, checked_at: new Date().toISOString() };
    this.write();
  }

  /** All bookmarks: [{ id, name, newest_post, checked_at }], most recently checked first. */
  list() {
    return Object.entries(this.data)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)));
  }

  /** Deletes bookmarks (those groups are scanned from scratch next round). */
  remove({ ids = [], all = false } = {}) {
    this.reload();
    const before = Object.keys(this.data).length;
    if (all) this.data = {};
    else for (const id of ids) delete this.data[id];
    this.write();
    return before - Object.keys(this.data).length;
  }
}

/** Adds groups to groups.txt, keeping every line already there (including switched-off ones). */
function addGroupsToFile(file, groups) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const known = new Set(existing.split(/\r?\n/).map(groupKey).filter(Boolean));
  const fresh = groups.filter((g) => !known.has(g.id));
  const header = existing
    ? ''
    : [
        '# הקבוצות שהסוכן סורק – שורה לכל קבוצה.',
        '# כדי שהסוכן לא יסרוק קבוצה, הוסף # בתחילת השורה שלה (עדיף על מחיקה:',
        '# קבוצה שנמחקה תחזור בייבוא הבא, קבוצה עם # תישאר כבויה).',
        '',
      ].join('\n') + '\n';
  const lines = fresh.map((g) => `https://www.facebook.com/groups/${g.id}/` + (g.name ? `   # ${g.name.replace(/\s+/g, ' ')}` : ''));
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, existing + sep + header + lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return fresh.length;
}

/** Scrolls the "groups you've joined" page to the end and returns every group on it. */
async function collectJoinedGroups(page, { log, sleep }) {
  await page.goto(JOINED_GROUPS_URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  let groups = [];
  let unchanged = 0;
  for (let i = 0; i < 150 && unchanged < 4; i++) {
    const now = await page.evaluate(jsGroupLinks);
    unchanged = now.length > groups.length ? 0 : unchanged + 1;
    groups = now;
    if (i % 5 === 4) log(`   נמצאו עד עכשיו ${groups.length} קבוצות...`);
    await page.mouse.wheel(0, 1500);
    await sleep(1500 + Math.random() * 1500);
  }
  return groups;
}

module.exports = {
  loadGroupsFile,
  readAllGroups,
  setGroupsEnabled,
  addGroupsToFile,
  collectJoinedGroups,
  groupKey,
  jsGroupLinks,
  GroupsLastSeen,
  JOINED_GROUPS_URL,
};
