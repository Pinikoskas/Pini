// `node index.js --create-shortcut`: puts a "סוכן הדיג'יי" icon on the Windows desktop that
// starts the agent (via start.vbs, so without a black console window).

const { execFileSync } = require('child_process');
const path = require('path');

const NAME = "סוכן הדיג'יי";

function createDesktopShortcut(appDir) {
  if (process.platform !== 'win32') throw new Error('יצירת קיצור דרך נתמכת רק ב-Windows');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string
  const script = [
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    `$link = Join-Path $desktop ${q(NAME + '.lnk')}`,
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($link)',
    "$s.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'",
    `$s.Arguments = ${q(`"${path.join(appDir, 'start.vbs')}"`)}`,
    `$s.WorkingDirectory = ${q(appDir)}`,
    `$s.IconLocation = ${q(path.join(appDir, 'assets', 'icon.ico') + ',0')}`,
    `$s.Description = ${q(NAME)}`,
    '$s.Save()',
    'Write-Output $link',
  ].join('; ');
  // -EncodedCommand (UTF-16LE) keeps the Hebrew name intact whatever the console code page is.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' }).trim();
}

module.exports = { createDesktopShortcut };
