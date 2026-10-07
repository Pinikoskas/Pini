// One log for everything: the console (Hebrew fixed for Windows), dj_agent.log, and the
// control panel (which listens to `events` and reads the recent lines).

const fs = require('fs');
const { EventEmitter } = require('events');
const { forTerminal } = require('./terminal');

const events = new EventEmitter();
const recent = [];
const KEEP = 500;
let stream = null;

function setLogFile(file) {
  stream = fs.createWriteStream(file, { flags: 'a' });
}

function log(...parts) {
  const time = new Date().toTimeString().slice(0, 8);
  const text = parts.join(' ');
  console.log(`${time}  ${forTerminal(text)}`);
  if (stream) stream.write(`${time}  ${text}\n`);
  const entry = { time, text };
  recent.push(entry);
  if (recent.length > KEEP) recent.shift();
  events.emit('log', entry);
}

module.exports = { log, events, recentLogs: () => recent.slice(), setLogFile };
