// Runs the engine smoke test inside Electron so HTML→PDF conversions are exercised too.
import { app } from 'electron';
import { htmlToPdf } from '../src/main/platform.js';
import { smoke } from './smoke.mjs';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // the hidden PDF windows must not end the run
app.whenReady().then(async () => {
  const { fail } = await smoke({ htmlToPdf });
  app.exit(fail ? 1 : 0);
});
