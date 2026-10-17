import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export const DEFAULTS = {
  language: 'auto',
  keys: { convert: 'shift', tools: 'ctrl', actions: 'alt' },
  defaultWheel: 'convert',
  output: 'same',
  customDir: '',
  afterDone: 'nothing',
  showOrb: true,
  orb: null, // { x, y } centre of the orb in screen coordinates
  launchAtLogin: false,
  sendTo: true,
  shortcut: 'CommandOrControl+Alt+K',
};

const file = () => path.join(app.getPath('userData'), 'settings.json');
let current;

export function getSettings() {
  if (!current) {
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      current = { ...DEFAULTS, ...saved, keys: { ...DEFAULTS.keys, ...saved.keys } };
    } catch {
      current = structuredClone(DEFAULTS);
    }
  }
  return current;
}

export function updateSettings(patch, { persist = true } = {}) {
  current = { ...getSettings(), ...patch };
  if (!persist) return current;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(current, null, 2));
  return current;
}

export function resolveLocale() {
  const { language } = getSettings();
  if (language !== 'auto') return language;
  return app.getLocale().toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

/** Where results of an operation on `file` should be written. */
export function outputDirFor(file) {
  const s = getSettings();
  if (s.output === 'downloads') return app.getPath('downloads');
  if (s.output === 'custom' && s.customDir && fs.existsSync(s.customDir)) return s.customDir;
  const dir = path.dirname(file);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    // Read-only source location (e.g. a CD or a protected folder): fall back to Downloads.
    return app.getPath('downloads');
  }
}
