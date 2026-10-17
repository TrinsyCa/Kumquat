// Simulates an OS file drag onto the orb (via the DevTools protocol) to test the full drop flow.
// Usage: KUMQUAT_SHOTS=<outDir> electron test/ui-drag.mjs <file>
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import '../src/main/main.js';

const file = path.resolve(process.argv.at(-1));
const outDir = path.resolve(process.env.KUMQUAT_SHOTS ?? '.');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = { none: 0, alt: 1, ctrl: 2, shift: 8 };

async function shot(win, name) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  console.log('captured', name, JSON.stringify(win.getBounds()));
}

app.whenReady().then(async () => {
  await wait(2500);
  const orb = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Kumquat');
  const dbg = orb.webContents.debugger;
  dbg.attach('1.3');
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  const drag = (type, x, y, modifiers = 0) => dbg.sendCommand('Input.dispatchDragEvent', { type, x, y, data, modifiers });
  // Wedge centre for index i of n, in viewport coordinates (wheel is centred in the 640px window).
  const wedge = (i, n, r = 210) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [320 + r * Math.cos(a), 320 + r * Math.sin(a)];
  };

  await drag('dragEnter', 52, 52);
  await wait(700);
  await drag('dragOver', ...wedge(1, 7));
  await wait(300);
  await shot(orb, 'd1-drag-convert');
  await drag('dragOver', ...wedge(5, 10), MOD.ctrl);
  await wait(300);
  await shot(orb, 'd2-drag-tools-ctrl');
  await drag('dragOver', ...wedge(2, 8), MOD.alt);
  await wait(300);
  await shot(orb, 'd3-drag-actions-alt');
  await drag('dragOver', ...wedge(5, 10), MOD.ctrl);
  await wait(200);
  await drag('drop', ...wedge(5, 10), MOD.ctrl);
  await wait(2500);
  await shot(orb, 'd4-dropped');
  const out = path.join(path.dirname(file), `${path.parse(file).name} (grayscale)${path.extname(file)}`);
  console.log('grayscale output exists:', fs.existsSync(out));
  app.exit(0);
});
