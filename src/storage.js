// Remember which posts / people were already handled, so nobody gets messaged twice.
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

  authorMessagedRecently(authorUrl, days) {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.actions.some(
      (a) => a.authorUrl === authorUrl && a.action === 'message' && new Date(a.createdAt).getTime() >= since,
    );
  }

  record(postKey, authorUrl, action, postText = '') {
    this.actions.push({
      postKey,
      authorUrl: authorUrl || '',
      action, // comment / message / skip
      createdAt: new Date().toISOString(),
      postText: postText.slice(0, 500),
    });
    if (this.path) fs.writeFileSync(this.path, JSON.stringify(this.actions, null, 2), 'utf8');
  }
}

module.exports = { Storage };
