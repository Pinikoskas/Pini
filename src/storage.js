// Remember which posts were already sent to you, so you never get the same post twice.
// Stored as a plain JSON file (history.json) so there is nothing extra to install.
// The file is the source of truth: every write re-reads it first, so entries deleted from the
// control panel while the agent runs are not written back.

const fs = require('fs');

// The start of a post's text, ignoring spacing, punctuation and "See more / See less".
const sameText = (t) =>
  String(t || '')
    .replace(/(?:ראה עוד|ראו עוד|הצג עוד|פחות|see more|see less)\s*$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase()
    .slice(0, 300);

class Storage {
  constructor(path) {
    this.path = path;
    this.actions = [];
    this.reload();
  }

  reload() {
    this.actions = [];
    if (this.path && fs.existsSync(this.path)) {
      try {
        this.actions = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      } catch {
        this.actions = [];
      }
    }
  }

  save() {
    if (this.path) fs.writeFileSync(this.path, JSON.stringify(this.actions, null, 2), 'utf8');
  }

  postHandled(postKey) {
    return this.actions.some((a) => a.postKey === postKey);
  }

  /** True when a post with the same text was already sent (the same ad posted in many groups). */
  textHandled(text) {
    const t = sameText(text);
    return t.length >= 40 && this.actions.some((a) => sameText(a.postText) === t);
  }

  record(postKey, authorUrl, action, postText = '', { authorName = '', groupName = '', groupId = null, broad = false } = {}) {
    this.reload();
    this.actions.push({
      postKey,
      authorUrl: authorUrl || '',
      authorName,
      groupName,
      ...(groupId ? { groupId } : {}),
      ...(broad ? { broad: true } : {}),
      action,
      createdAt: new Date().toISOString(),
      postText: postText.slice(0, 500),
    });
    this.save();
  }

  /** The latest posts sent to WhatsApp, newest first. */
  recentLeads(n = 30) {
    return this.actions.filter((a) => a.action === 'notify').slice(-n).reverse();
  }

  /** Forgets the given posts (or all with all=true); they may be sent again if still recent. */
  forget({ postKeys = [], all = false } = {}) {
    this.reload();
    const keys = new Set(postKeys);
    const before = this.actions.length;
    this.actions = all ? [] : this.actions.filter((a) => !keys.has(a.postKey));
    this.save();
    return before - this.actions.length;
  }
}

module.exports = { Storage };
