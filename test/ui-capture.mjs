// Launches the real app with a file, drives the wheel with the keyboard and saves screenshots.
// Usage: KUMQUAT_SHOTS=<outDir> electron test/ui-capture.mjs <file>
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import '../src/main/main.js';

const outDir = path.resolve(process.env.KUMQUAT_SHOTS ?? '.');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  console.log('captured', name, image.getSize());
}

function key(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

app.whenReady().then(async () => {
  await wait(3000);
  const orb = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Kumquat');
  await shot(orb, '1-convert');
  key(orb, 'Right'); key(orb, 'Right');
  await wait(300);
  await shot(orb, '2-convert-hot');
  key(orb, 'Tab');
  await wait(400);
  await shot(orb, '3-tools');
  key(orb, 'Right');
  await wait(200);
  key(orb, 'Return');
  await wait(600);
  await shot(orb, '4-params');
  key(orb, 'Escape');
  await wait(400);
  await shot(orb, '5-collapsed');
  ipcMain.emit('settings:open');
  await wait(2500);
  const settings = BrowserWindow.getAllWindows().find((w) => w !== orb && w.isVisible());
  if (settings) await shot(settings, '6-settings');
  app.exit(0);
});
