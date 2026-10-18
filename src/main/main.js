import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, Menu, Tray, ipcMain, screen, shell, dialog, clipboard, nativeImage, globalShortcut } from 'electron';
import { getOptions, runOperation } from '../engine/index.js';
import { findSoffice } from '../engine/libreoffice.js';
import { STRINGS, translator } from '../shared/i18n.js';
import { getSettings, updateSettings, resolveLocale, outputDirFor } from './settings.js';
import { copyFilesToClipboard, openTerminal, moveFile, copyFile, setSendTo, setLaunchAtLogin, htmlToPdf, filesFromArgv } from './platform.js';
import { startShare } from './share.js';
import { MIME_EXT } from './mime.js';
import { startDragWatch } from './dragwatch.js';

const ROOT = path.join(import.meta.dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const ORB = 104;
const WHEEL = 640;

let orb = null;
let tray = null;
let settingsWin = null;
let expanded = false;
let dragOrigin = null;
let stopDragWatch = null;
const running = new Map();
const shares = new Map();

const t = (key, vars) => translator(resolveLocale())(key, vars);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const files = filesFromArgv(argv.slice(app.isPackaged ? 1 : 2));
    if (files.length) openWheelFor(files);
    else showOrb();
  });
  if (process.platform === 'win32') app.setAppUserModelId('com.trinsyca.kumquat');
  // Transparent windows need this on many Linux setups to avoid a black square behind the orb.
  if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');
  // Native Wayland doesn't let apps position or pin their windows, which the floating orb needs; use XWayland when available.
  if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland' && process.env.DISPLAY && !process.env.KUMQUAT_WAYLAND) {
    app.commandLine.appendSwitch('ozone-platform', 'x11');
  }
  app.whenReady().then(start);
}

// ---------------------------------------------------------------- windows

function orbCenter() {
  const saved = getSettings().orb;
  const displays = screen.getAllDisplays();
  if (saved && displays.some((d) => contains(d.workArea, saved))) return saved;
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - 80, y: workArea.y + workArea.height - 140 };
}

function contains(r, p) {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

function boundsAround(center, size) {
  const { workArea } = screen.getDisplayNearestPoint(center);
  const half = Math.round(size / 2);
  const x = Math.min(Math.max(center.x - half, workArea.x), workArea.x + workArea.width - size);
  const y = Math.min(Math.max(center.y - half, workArea.y), workArea.y + workArea.height - size);
  return { x: Math.round(x), y: Math.round(y), width: size, height: size };
}

function createOrb() {
  orb = new BrowserWindow({
    ...boundsAround(orbCenter(), ORB),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'Kumquat',
    icon: ICON,
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  orb.setAlwaysOnTop(true, 'floating');
  orb.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  orb.loadFile(path.join(RENDERER, 'orb.html'));
  orb.once('ready-to-show', () => {
    if (getSettings().showOrb && !process.argv.includes('--hidden')) orb.showInactive();
  });
  orb.on('closed', () => (orb = null));
}

function expandOrb() {
  if (!orb || expanded) return;
  expanded = true;
  orb.setBounds(boundsAround(orbCenter(), WHEEL));
}

function collapseOrb() {
  if (!orb || !expanded) return;
  expanded = false;
  orb.setBounds(boundsAround(orbCenter(), ORB));
  if (!getSettings().showOrb) orb.hide();
}

/** Opens the (still invisible) wheel under the cursor while a file drag is in progress elsewhere. */
function armWheelAtCursor() {
  // Leave a wheel that is already open (picking, running, showing a result) alone.
  if (!orb || expanded || orb.webContents.isLoading()) return;
  expanded = true;
  orb.setBounds(boundsAround(screen.getCursorScreenPoint(), WHEEL));
  orb.showInactive();
  orb.moveTop();
  orb.webContents.send('wheel:arm');
}

function updateDragWatch() {
  stopDragWatch?.();
  stopDragWatch = null;
  if (!getSettings().dragWheel) return;
  stopDragWatch = startDragWatch({
    getKeys: () => getSettings().keys,
    onArm: armWheelAtCursor,
    onRelease: () => orb?.webContents.send('wheel:release'),
  });
}

function showOrb() {
  if (!orb) createOrb();
  orb.showInactive();
}

function openWheelFor(files) {
  if (!orb) createOrb();
  const send = () => {
    expandOrb();
    orb.show();
    orb.focus();
    orb.webContents.send('wheel:open', { files, options: optionsFor(files) });
  };
  if (orb.webContents.isLoading()) orb.webContents.once('did-finish-load', send);
  else send();
}

function openSettings() {
  if (settingsWin) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 480,
    minHeight: 480,
    title: t('settings.title'),
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#17110d',
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
}

function popupWindow(page, query, { width, height, onClosed } = {}) {
  const center = orbCenter();
  const { workArea } = screen.getDisplayNearestPoint(center);
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(Math.min(Math.max(center.x - width / 2, workArea.x), workArea.x + workArea.width - width)),
    y: Math.round(Math.min(Math.max(center.y - height - 70, workArea.y), workArea.y + workArea.height - height)),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: page === 'float',
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Kumquat',
    icon: ICON,
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  win.loadFile(path.join(RENDERER, `${page}.html`), { query });
  if (onClosed) win.on('closed', onClosed);
  return win;
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(ROOT, 'assets', process.platform === 'win32' ? 'tray.png' : 'tray@2x.png'));
  tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 22 }) : image);
  tray.setToolTip('Kumquat');
  tray.on('click', () => (orb?.isVisible() ? orb.hide() : showOrb()));
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(appMenuTemplate()));
}

function appMenuTemplate() {
  return [
    { label: t('openFiles'), click: pickFiles },
    { label: orb?.isVisible() ? t('hideOrb') : t('showOrb'), click: () => (orb?.isVisible() ? orb.hide() : showOrb()) },
    { type: 'separator' },
    { label: t('settings'), click: openSettings },
    { label: t('about'), click: () => shell.openExternal('https://github.com/TrinsyCa/kumquat') },
    { type: 'separator' },
    { label: t('quit'), click: () => app.quit() },
  ];
}

async function pickFiles() {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
  if (!canceled && filePaths.length) openWheelFor(filePaths);
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const { shortcut } = getSettings();
  if (!shortcut) return;
  try {
    globalShortcut.register(shortcut, pickFiles);
  } catch (e) {
    console.warn('Could not register shortcut', shortcut, e.message);
  }
}

// ---------------------------------------------------------------- options & actions

const ACTIONS = [
  { id: 'share', icon: 'share' },
  { id: 'float', icon: 'float' },
  { id: 'copy', icon: 'copy' },
  { id: 'copy-path', icon: 'link' },
  { id: 'move', icon: 'move' },
  { id: 'copy-to', icon: 'copy-to' },
  { id: 'terminal', icon: 'terminal' },
  { id: 'reveal', icon: 'reveal' },
];

function actionOptions() {
  return ACTIONS.map((a) => ({ id: `action.${a.id}`, group: 'actions', icon: a.icon, label: t(`action.${a.id}`) }));
}

function optionsFor(files) {
  const opts = getOptions(files, resolveLocale());
  return { ...opts, actions: actionOptions() };
}

/** Options for a drag in progress, where only MIME types are known. */
function optionsForMimes(mimes) {
  const pseudo = [];
  for (const mime of mimes) {
    const ext = MIME_EXT[mime?.toLowerCase()] ?? MIME_EXT[`${(mime || '').split('/')[0]}/*`];
    if (!ext) return { convert: null, tools: null, actions: actionOptions() };
    pseudo.push(path.join(app.getPath('temp'), `kumquat-probe.${ext}`));
  }
  return optionsFor(pseudo);
}

async function runAction(id, files, win) {
  switch (id) {
    case 'share': {
      let session;
      try {
        session = await startShare(files, { onDownload: () => shareWin?.webContents.send('share:downloaded') });
      } catch (e) {
        if (e.code === 'NO_NETWORK') return { error: t('shareNoNetwork') };
        throw e;
      }
      const shareWin = popupWindow('share', { url: session.url }, { width: 360, height: 480 });
      const winId = shareWin.id;
      shares.set(winId, session);
      shareWin.on('closed', () => {
        session.stop();
        shares.delete(winId);
      });
      return { collapse: true };
    }
    case 'float':
      popupWindow('float', { files: JSON.stringify(files) }, { width: 190, height: 210 });
      return { collapse: true };
    case 'copy':
      await copyFilesToClipboard(files);
      return { message: t('copied') };
    case 'copy-path':
      clipboard.writeText(files.join(process.platform === 'win32' ? '\r\n' : '\n'));
      return { message: t('copied') };
    case 'move':
    case 'copy-to': {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      if (canceled || !filePaths[0]) return { cancelled: true };
      const outputs = [];
      for (const f of files) outputs.push(await (id === 'move' ? moveFile(f, filePaths[0]) : copyFile(f, filePaths[0])));
      return { outputs };
    }
    case 'terminal': {
      const first = files[0];
      openTerminal(fs.statSync(first).isDirectory() ? first : path.dirname(first));
      return { collapse: true };
    }
    case 'reveal':
      shell.showItemInFolder(files[0]);
      return { collapse: true };
    default:
      throw new Error(`Unknown action ${id}`);
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('init', () => ({
    locale: resolveLocale(),
    strings: STRINGS[resolveLocale()],
    settings: getSettings(),
    platform: process.platform,
    version: app.getVersion(),
    libreoffice: findSoffice(),
  }));

  ipcMain.on('orb:expand', expandOrb);
  ipcMain.on('orb:collapse', collapseOrb);
  ipcMain.on('orb:drag', (e, { phase, x, y }) => {
    if (!orb || expanded) return;
    if (phase === 'start') dragOrigin = { pointer: { x, y }, center: orbCenter() };
    else if (dragOrigin) {
      const center = { x: dragOrigin.center.x + x - dragOrigin.pointer.x, y: dragOrigin.center.y + y - dragOrigin.pointer.y };
      orb.setBounds(boundsAround(center, ORB));
      const b = orb.getBounds();
      // Keep the position in memory while moving and write it to disk once the drag ends.
      updateSettings({ orb: { x: b.x + ORB / 2, y: b.y + ORB / 2 } }, { persist: phase === 'end' });
      if (phase === 'end') dragOrigin = null;
    }
  });
  ipcMain.on('orb:menu', () => Menu.buildFromTemplate(appMenuTemplate()).popup({ window: orb }));

  ipcMain.handle('options:mimes', (e, mimes) => optionsForMimes(mimes));
  ipcMain.handle('options:files', (e, files) => optionsFor(files));

  ipcMain.handle('op:run', async (e, { id, files, params }) => {
    const sender = e.sender;
    const controller = new AbortController();
    running.set(sender.id, controller);
    let last = 0;
    const progress = (f) => {
      const now = Date.now();
      if (now - last > 80 || f >= 1) {
        last = now;
        if (!sender.isDestroyed()) sender.send('op:progress', f);
      }
    };
    try {
      if (id.startsWith('action.')) {
        const result = await runAction(id.slice(7), files, BrowserWindow.fromWebContents(sender));
        return { ok: true, ...result };
      }
      const result = await runOperation(id, files, params, { outDir: outputDirFor, progress, htmlToPdf, signal: controller.signal }, resolveLocale());
      if (result.copy) clipboard.writeText(result.copy);
      if (getSettings().afterDone === 'reveal' && result.outputs[0]) shell.showItemInFolder(result.outputs[0]);
      return { ok: true, ...result };
    } catch (err) {
      console.error(err);
      return { ok: false, error: controller.signal.aborted ? t('cancel') : err.message, needs: err.code === 'NEEDS_LIBREOFFICE' ? 'LibreOffice' : undefined };
    } finally {
      running.delete(sender.id);
    }
  });
  ipcMain.on('op:cancel', (e) => running.get(e.sender.id)?.abort());

  ipcMain.on('path:reveal', (e, p) => shell.showItemInFolder(p));
  ipcMain.on('path:open', (e, p) => shell.openPath(p));
  ipcMain.on('link:open', (e, url) => /^https:\/\//.test(url) && shell.openExternal(url));

  ipcMain.handle('settings:set', (e, patch) => {
    const before = getSettings();
    const next = updateSettings(patch);
    if ('showOrb' in patch) (next.showOrb ? showOrb() : orb?.hide());
    if ('launchAtLogin' in patch) setLaunchAtLogin(next.launchAtLogin);
    if ('sendTo' in patch) setSendTo(next.sendTo);
    if ('shortcut' in patch) registerShortcut();
    if ('dragWheel' in patch) updateDragWatch();
    // The orb caches settings and strings, so reload it (it's collapsed while the settings window is used).
    if ('keys' in patch || 'defaultWheel' in patch || ('language' in patch && patch.language !== before.language)) {
      if (expanded) collapseOrb();
      orb?.webContents.reload();
      refreshTrayMenu();
    }
    return next;
  });
  ipcMain.handle('settings:chooseDir', async (e) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'] });
    return canceled ? null : filePaths[0];
  });
  ipcMain.on('settings:open', openSettings);

  ipcMain.handle('share:info', (e) => {
    const s = shares.get(BrowserWindow.fromWebContents(e.sender)?.id);
    return s ? { url: s.url, qr: s.qr } : null;
  });
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

  ipcMain.handle('float:info', async (e, files) =>
    Promise.all(files.map(async (f) => ({
      path: f,
      name: path.basename(f),
      icon: (await app.getFileIcon(f, { size: 'large' }).catch(() => null))?.toDataURL() ?? null,
      image: /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(f),
    })))
  );
  ipcMain.on('float:drag', async (e, files) => {
    const icon = await app.getFileIcon(files[0], { size: 'normal' }).catch(() => nativeImage.createFromPath(ICON).resize({ width: 32 }));
    e.sender.startDrag({ file: files[0], files, icon });
  });
}

// ---------------------------------------------------------------- startup

function start() {
  registerIpc();
  createOrb();
  createTray();
  registerShortcut();
  updateDragWatch();
  const s = getSettings();
  if (!fs.existsSync(path.join(app.getPath('userData'), 'settings.json'))) {
    // First run: install integrations with their defaults.
    updateSettings({});
    if (app.isPackaged) setSendTo(s.sendTo);
  }
  const files = filesFromArgv(process.argv.slice(app.isPackaged ? 1 : 2));
  if (files.length) openWheelFor(files);
}

app.on('window-all-closed', (e) => e.preventDefault?.());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopDragWatch?.();
});
