// Remember which posts were already sent to you, so you never get the same post twice.
// Stored as a plain JSON file (history.json) so there is nothing extra to install.

const fs = require('fs');

class Storage {
  constructor(path) {
    this.path = path;
    this.actions = [];
    if (path && fs.existsSync(path)) {
      try {
        this.actions = JSON.parse(fs.readFileSync(path, 'utf8'));
      } catch {
        this.actions = [];
      }
    }
  }

  postHandled(postKey) {
    return this.actions.some((a) => a.postKey === postKey);
  }

  record(postKey, authorUrl, action, postText = '', { authorName = '', groupName = '' } = {}) {
    this.actions.push({
      postKey,
      authorUrl: authorUrl || '',
      authorName,
      groupName,
      action,
      createdAt: new Date().toISOString(),
      postText: postText.slice(0, 500),
    });
    if (this.path) fs.writeFileSync(this.path, JSON.stringify(this.actions, null, 2), 'utf8');
  }

  /** The latest posts sent to WhatsApp, newest first. */
  recentLeads(n = 30) {
    return this.actions.filter((a) => a.action === 'notify').slice(-n).reverse();
  }
}

module.exports = { Storage };
