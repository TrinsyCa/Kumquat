import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { app, clipboard, shell, BrowserWindow } from 'electron';

const isWin = process.platform === 'win32';

function which(cmd) {
  try {
    return execFileSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

function detached(cmd, args, options = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...options });
  child.on('error', () => {});
  child.unref();
}

/** Puts files on the clipboard so they can be pasted in Explorer / the file manager. */
export async function copyFilesToClipboard(files) {
  if (isWin) {
    const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
    await new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath ${list}`], { windowsHide: true });
      ps.on('error', reject);
      ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Could not copy files to the clipboard'))));
    });
    return;
  }
  const uris = files.map((f) => pathToFileURL(f).href);
  const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  // GNOME/Nautilus-family file managers read their own format; KDE, Thunar and others use text/uri-list.
  if (/gnome|unity|cinnamon|mate|budgie|pantheon/.test(desktop)) {
    clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(`copy\n${uris.join('\n')}`));
  } else {
    clipboard.writeBuffer('text/uri-list', Buffer.from(uris.join('\r\n') + '\r\n'));
  }
}

/** Opens a terminal window in the given directory. */
export function openTerminal(dir) {
  if (isWin) {
    if (which('wt.exe')) return detached('wt.exe', ['-d', dir]);
    return detached('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/K', `cd /d "${dir}"`], { shell: false });
  }
  const candidates = [
    ['x-terminal-emulator', []],
    ['gnome-terminal', [`--working-directory=${dir}`]],
    ['konsole', ['--workdir', dir]],
    ['xfce4-terminal', [`--working-directory=${dir}`]],
    ['tilix', [`--working-directory=${dir}`]],
    ['kitty', ['--directory', dir]],
    ['alacritty', ['--working-directory', dir]],
    ['wezterm', ['start', '--cwd', dir]],
    ['foot', [`--working-directory=${dir}`]],
    ['xterm', []],
  ];
  for (const [cmd, args] of candidates) {
    if (which(cmd)) return detached(cmd, args, { cwd: dir });
  }
  throw new Error('No terminal emulator found');
}

/** Moves a file, falling back to copy + delete across drives. */
export async function moveFile(src, destDir) {
  const target = uniqueIn(destDir, path.basename(src));
  try {
    await fsp.rename(src, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(src, target, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
  return target;
}

export async function copyFile(src, destDir) {
  const target = uniqueIn(destDir, path.basename(src));
  await fsp.cp(src, target, { recursive: true });
  return target;
}

function uniqueIn(dir, base) {
  const ext = path.extname(base);
  const name = base.slice(0, base.length - ext.length);
  let candidate = path.join(dir, base);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${name} (${i})${ext}`);
  return candidate;
}

/** Command + args that relaunch this app with extra file arguments (dev and packaged). */
export function launchCommand() {
  return app.isPackaged ? { target: process.execPath, args: '' } : { target: process.execPath, args: `"${app.getAppPath()}"` };
}

/** Adds or removes the Explorer “Send to → Kumquat” shortcut on Windows. */
export function setSendTo(enabled) {
  if (!isWin) return;
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'Kumquat.lnk');
  try {
    if (enabled) {
      const { target, args } = launchCommand();
      shell.writeShortcutLink(link, 'create', { target, args, description: 'Convert, compress and share with Kumquat', icon: process.execPath, iconIndex: 0 });
    } else if (fs.existsSync(link)) {
      fs.unlinkSync(link);
    }
  } catch (e) {
    console.error('Send To shortcut failed:', e);
  }
}

export function setLaunchAtLogin(enabled) {
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    const file = path.join(dir, 'kumquat.desktop');
    if (enabled) {
      const exec = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Kumquat\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

/** Renders HTML to PDF with Chromium's print engine in a hidden window. */
export async function htmlToPdf(html, { landscape = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kumquat-html-'));
  const file = path.join(dir, 'document.html');
  await fsp.writeFile(file, html);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false, sandbox: true } });
  try {
    await win.loadFile(file);
    return await win.webContents.printToPDF({
      landscape,
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
  } finally {
    win.destroy();
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Turns command-line arguments into existing file paths (handles file:// URIs from Linux launchers). */
export function filesFromArgv(argv) {
  return argv
    .filter((a) => a && !a.startsWith('-'))
    .map((a) => (a.startsWith('file://') ? decodeURIComponent(new URL(a).pathname).replace(/^\/([A-Za-z]:)/, '$1') : a))
    .map((a) => path.resolve(a))
    .filter((a) => a !== path.resolve(app.getAppPath()) && a !== process.execPath && fs.existsSync(a));
}
