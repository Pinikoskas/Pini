// `node index.js --create-shortcut`: puts a "סוכן הדיג'יי" icon on the Windows desktop that
// starts the agent (via start.vbs, so without a black console window).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAME = "סוכן הדיג'יי";

// The shortcut is written through the Unicode shell API (IShellLinkW). The usual WScript.Shell
// way can't save Hebrew names or paths on a Windows set to a non-Hebrew language.
const LNK_CS = `
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr fd, int fl);
  void GetIDList(out IntPtr p);
  void SetIDList(IntPtr p);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int c);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int c);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
  void GetHotkey(out short h);
  void SetHotkey(short h);
  void GetShowCmd(out int s);
  void SetShowCmd(int s);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int r);
  void Resolve(IntPtr h, int f);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
}
public static class DjShortcut {
  public static void Create(string link, string target, string args, string dir, string icon, string desc) {
    IShellLinkW l = (IShellLinkW)new CShellLink();
    l.SetPath(target);
    l.SetArguments(args);
    l.SetWorkingDirectory(dir);
    l.SetIconLocation(icon, 0);
    l.SetDescription(desc);
    ((IPersistFile)l).Save(link, true);
  }
}`;

function createDesktopShortcut(appDir) {
  if (process.platform !== 'win32') throw new Error('יצירת קיצור דרך נתמכת רק ב-Windows');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `Add-Type -TypeDefinition ${q(LNK_CS)}`,
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    `$link = Join-Path $desktop ${q(NAME + '.lnk')}`,
    "$wscript = Join-Path $env:WINDIR 'System32\\wscript.exe'",
    `[DjShortcut]::Create($link, $wscript, ${q(`"${path.join(appDir, 'start.vbs')}"`)}, ${q(appDir)}, ${q(path.join(appDir, 'assets', 'icon.ico'))}, ${q(NAME)})`,
    // Printed as UTF-16 code points so the path survives any console code page.
    "Write-Output (($link.ToCharArray() | ForEach-Object { [int]$_ }) -join ',')",
  ].join('\n');
  // -EncodedCommand (UTF-16LE) keeps the Hebrew intact whatever the console code page is.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const why = String(e.stderr || e.message).split(/\r?\n/).find((l) => l.trim()) || e.message;
    throw new Error(`לא הצלחתי ליצור את קיצור הדרך: ${why.trim()}`);
  }
  const codes = out.trim().split(/\r?\n/).pop();
  const link = String.fromCharCode(...codes.split(',').map(Number));
  if (!fs.existsSync(link)) throw new Error('לא הצלחתי ליצור את קיצור הדרך בשולחן העבודה');
  return link;
}

module.exports = { createDesktopShortcut, LNK_CS };
