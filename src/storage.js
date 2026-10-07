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

  record(postKey, authorUrl, action, postText = '') {
    this.actions.push({
      postKey,
      authorUrl: authorUrl || '',
      action,
      createdAt: new Date().toISOString(),
      postText: postText.slice(0, 500),
    });
    if (this.path) fs.writeFileSync(this.path, JSON.stringify(this.actions, null, 2), 'utf8');
  }
}

module.exports = { Storage };
