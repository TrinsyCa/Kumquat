// Windows: notices when the user presses a wheel key (Shift / Ctrl / Alt) while dragging files in
// File Explorer or on the desktop, so Kumquat can open its wheel right under the cursor.
// The wheel window then becomes the drop target, which is what stops Explorer's own
// copy / move / shortcut behaviour for those keys.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const EVENT = { KEY_PRESSED: 4, MOUSE_PRESSED: 7, MOUSE_RELEASED: 8, MOUSE_DRAGGED: 10 };
const KEYCODES = {
  shift: [0x002a, 0x0036],
  ctrl: [0x001d, 0x0e1d],
  alt: [0x0038, 0x0e38],
};
// Top-level window classes of File Explorer and the desktop.
const SHELL_CLASSES = new Set(['CabinetWClass', 'ExploreWClass', 'Progman', 'WorkerW']);
// Classic and Windows 11 (XAML) context menus.
const MENU_CLASSES = ['#32768', 'Xaml_WindowedPopupClass'];
const GA_ROOT = 2;
const SM_CXDRAG = 68;
const SM_CYDRAG = 69;

let user32Api = null;

// Loaded once: koffi refuses to define the same struct type twice (e.g. when the setting is toggled).
function loadUser32() {
  if (user32Api) return user32Api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const POINT = koffi.struct('KQ_POINT', { x: 'long', y: 'long' });
  user32Api = {
    WindowFromPoint: user32.func('void* __stdcall WindowFromPoint(KQ_POINT pt)'),
    GetAncestor: user32.func('void* __stdcall GetAncestor(void* hwnd, uint32_t flags)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(void* hwnd, void* name, int max)'),
    FindWindowW: user32.func('void* __stdcall FindWindowW(str16 cls, str16 title)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void* hwnd)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
    POINT,
  };
  return user32Api;
}

/**
 * Turns raw global input events into "arm the wheel" / "mouse released" callbacks.
 * Kept free of native calls so it can be unit-tested.
 */
export function createDragTracker({ shellAt, contextMenuOpen, threshold, getKeys, onArm, onRelease }) {
  // The current left-button press: where it started, whether it began in Explorer, whether it became a drag.
  let press = null;
  return (e) => {
    switch (e.type) {
      case EVENT.MOUSE_PRESSED:
        if (e.button === 1) press = { x: e.x, y: e.y, shell: shellAt(e.x, e.y), moved: false, armed: false };
        break;
      case EVENT.MOUSE_DRAGGED:
        if (press && !press.moved && (Math.abs(e.x - press.x) >= threshold.x || Math.abs(e.y - press.y) >= threshold.y)) press.moved = true;
        break;
      case EVENT.MOUSE_RELEASED:
        if (e.button === 1 && press) {
          const wasArmed = press.armed;
          press = null;
          if (wasArmed) onRelease();
        }
        break;
      case EVENT.KEY_PRESSED: {
        if (!press?.shell || !press.moved || press.armed) return;
        const keys = Object.values(getKeys());
        if (!keys.some((k) => KEYCODES[k]?.includes(e.keycode))) return;
        if (contextMenuOpen()) return;
        press.armed = true;
        onArm();
        break;
      }
    }
  };
}

/**
 * Starts watching global input. `getKeys()` returns the settings' { convert, tools, actions } key map;
 * `onArm()` is called once per drag when a wheel key goes down; `onRelease()` when the mouse button is let go.
 * Returns a stop function, or null when unsupported.
 */
export function startDragWatch({ getKeys, onArm, onRelease }) {
  if (process.platform !== 'win32') return null;
  let uIOhook;
  let api;
  try {
    ({ uIOhook } = require('uiohook-napi'));
    api = loadUser32();
  } catch (e) {
    console.error('Drag wheel unavailable:', e.message);
    return null;
  }

  const className = (hwnd) => {
    if (!hwnd) return '';
    const buf = Buffer.alloc(512);
    const n = api.GetClassNameW(hwnd, buf, 256);
    return buf.toString('utf16le', 0, n * 2);
  };
  const rootClassAt = (x, y) => {
    try {
      return className(api.GetAncestor(api.WindowFromPoint({ x, y }), GA_ROOT));
    } catch {
      return '';
    }
  };
  const contextMenuOpen = () =>
    MENU_CLASSES.some((cls) => {
      const hwnd = api.FindWindowW(cls, null);
      return hwnd && api.IsWindowVisible(hwnd);
    });
  const threshold = {
    x: Math.max(4, api.GetSystemMetrics(SM_CXDRAG)),
    y: Math.max(4, api.GetSystemMetrics(SM_CYDRAG)),
  };

  uIOhook.on('input', createDragTracker({ shellAt: (x, y) => SHELL_CLASSES.has(rootClassAt(x, y)), contextMenuOpen, threshold, getKeys, onArm, onRelease }));
  uIOhook.start();
  return () => {
    uIOhook.removeAllListeners('input');
    uIOhook.stop();
  };
}
