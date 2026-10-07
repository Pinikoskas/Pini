// The control panel: a small web server on this computer only (127.0.0.1) that serves
// panel.html and lets it start/stop the agent, edit settings and groups, and watch the log.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec, spawn } = require('child_process');

const { DJAgent } = require('./agent');
const { loadConfig, editableValues, updateConfigValues } = require('./configFile');
const { readAllGroups, setGroupsEnabled } = require('./groups');
const { checkWhatsAppSettings } = require('./whatsapp');
const { Storage } = require('./storage');
const { log, events, recentLogs } = require('./log');

const PAGE = path.join(__dirname, 'panel.html');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

function startPanel({ configPath, port }) {
  let bot = null; // the agent that is running (or ran last)
  let importing = false;

  const status = () =>
    importing
      ? { state: 'importing', detail: 'אוסף את הקבוצות שלך מפייסבוק', sent: 0 }
      : bot
        ? bot.status
        : { state: 'stopped', detail: '', sent: 0 };
  const running = () => importing || (bot && bot.status.state !== 'stopped');

  function snapshot() {
    const cfg = loadConfig(configPath);
    return {
      status: status(),
      settings: editableValues(cfg),
      groups: readAllGroups(cfg.groups_file),
      leads: new Storage(cfg.history_file).recentLeads(30),
      logs: recentLogs(),
    };
  }

  const actions = {
    'GET /api/state': () => snapshot(),

    'POST /api/start': ({ dryRun }) => {
      if (running()) throw httpError(409, 'הסוכן כבר פועל');
      const cfg = loadConfig(configPath);
      if (!dryRun) {
        const problem = checkWhatsAppSettings(cfg.whatsapp);
        if (problem) throw httpError(400, problem);
      }
      log(`▶ הסוכן הופעל מהפאנל${dryRun ? ' (מצב בדיקה – בלי שליחה לווצאפ)' : ''}`);
      bot = new DJAgent(cfg, { dryRun: !!dryRun, configPath });
      bot.run().catch((e) => log(`✘ הסוכן נעצר בגלל שגיאה: ${e.message.split('\n')[0]}`));
      return { ok: true };
    },

    'POST /api/stop': () => {
      if (bot) bot.stop();
      return { ok: true };
    },

    'POST /api/settings': (body) => {
      const saved = updateConfigValues(configPath, body);
      log(`⚙ ההגדרות נשמרו${running() ? ' – יחולו מהסבב הבא' : ''}`);
      return { ok: true, settings: saved };
    },

    'POST /api/groups': ({ changes }) => {
      const cfg = loadConfig(configPath);
      if (!fs.existsSync(cfg.groups_file)) throw httpError(404, 'אין עדיין קובץ קבוצות – לחץ "ייבוא קבוצות מפייסבוק"');
      setGroupsEnabled(cfg.groups_file, changes || {});
      const on = Object.values(changes || {}).filter(Boolean).length;
      const off = Object.keys(changes || {}).length - on;
      log(`⚙ קבוצות עודכנו (${on ? `${on} הופעלו` : ''}${on && off ? ', ' : ''}${off ? `${off} כובו` : ''})${running() ? ' – יחול מהסבב הבא' : ''}`);
      return { ok: true, groups: readAllGroups(cfg.groups_file) };
    },

    'POST /api/import-groups': () => {
      if (running()) throw httpError(409, 'עצור את הסוכן לפני ייבוא קבוצות');
      importing = true;
      events.emit('status', status());
      const agent = new DJAgent(loadConfig(configPath), { configPath });
      agent
        .run({ importGroupsOnly: true })
        .catch((e) => log(`✘ ייבוא הקבוצות נכשל: ${e.message.split('\n')[0]}`))
        .finally(() => {
          importing = false;
          events.emit('status', status());
          events.emit('groups');
        });
      return { ok: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(PAGE));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/icon.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(fs.readFileSync(ICON));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') return streamEvents(req, res);
      const action = actions[`${req.method} ${url.pathname}`];
      if (!action) throw httpError(404, 'לא נמצא');
      const result = await action(req.method === 'POST' ? await readJson(req) : {});
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, e.status || 500, { error: e.message });
    }
  });

  // Live updates to the page: log lines, status changes, new leads.
  function streamEvents(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const send = (type) => (data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    const handlers = { log: send('log'), status: send('status'), lead: send('lead'), groups: send('groups') };
    for (const [type, fn] of Object.entries(handlers)) events.on(type, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      for (const [type, fn] of Object.entries(handlers)) events.off(type, fn);
    });
  }

  // Closing the program: stop the agent cleanly (it finishes the post it's on), then exit.
  async function shutdown() {
    if (bot && bot.status.state !== 'stopped') {
      log('סוגר – עוצר את הסוכן...');
      bot.stop();
      for (let i = 0; i < 40 && bot.status.state !== 'stopped'; i++) await new Promise((r) => setTimeout(r, 500));
    }
    process.exit(0);
  }

  const windowProfile = path.join(path.dirname(configPath), 'panel_window');
  return new Promise((resolve, reject) => {
    const address = `http://localhost:${port}`;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        // Already running (e.g. the icon was double-clicked twice): just show its window.
        log(`הסוכן כבר פתוח – מציג את החלון שלו`);
        openAppWindow(address, windowProfile, { fallback: false });
        setTimeout(() => process.exit(0), 3000);
        resolve();
      } else reject(e);
    });
    server.listen(port, '127.0.0.1', () => {
      log(`פאנל הבקרה פועל: ${address}`);
      openAppWindow(address, windowProfile, { onClosed: shutdown });
      process.on('SIGINT', shutdown); // Ctrl+C in the black window
      resolve();
    });
  });
}

/**
 * Opens the panel in its own app window (no address bar or tabs), using the Chromium that
 * came with the agent, or Edge. Closing that window calls onClosed. If no app window can
 * be opened, falls back to the normal browser.
 */
function openAppWindow(url, profileDir, { onClosed = null, fallback = true } = {}) {
  const exe = findAppBrowser();
  if (!exe) {
    if (fallback) openInBrowser(url);
    return;
  }
  const args = [`--app=${url}`, `--user-data-dir=${profileDir}`, '--window-size=1280,860', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox'); // Chromium refuses to run as root otherwise (Linux)
  const started = Date.now();
  // No "Google API keys are missing" bar in the bundled Chromium.
  const env = { ...process.env, GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' };
  const proc = spawn(exe, args, { stdio: 'ignore', env });
  const failed = () => {
    if (fallback) {
      log('לא הצלחתי לפתוח חלון תוכנה – פותח את הפאנל בדפדפן');
      openInBrowser(url);
    }
  };
  proc.on('error', failed);
  proc.on('exit', () => {
    // A window that closes within seconds never really opened.
    if (Date.now() - started < 4000) failed();
    else if (onClosed) onClosed();
  });
}

/** Edge (on every Windows 10/11) for the cleanest app window, else the Chromium that came with the agent. */
function findAppBrowser() {
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      const edge = base && path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      if (edge && fs.existsSync(edge)) return edge;
    }
  }
  try {
    const bundled = require('playwright').chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // no bundled browser either
  }
  return null;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(httpError(400, 'בקשה לא תקינה'));
      }
    });
  });
}

function openInBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

module.exports = { startPanel };
