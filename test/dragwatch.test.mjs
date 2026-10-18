import test from 'node:test';
import assert from 'node:assert/strict';
import { createDragTracker, EVENT } from '../src/main/dragwatch.js';

const CTRL = 0x001d;
const SHIFT = 0x002a;
const KEY_A = 0x001e;

function setup({ shell = true, menu = false } = {}) {
  const calls = [];
  const handle = createDragTracker({
    shellAt: () => shell,
    contextMenuOpen: () => menu,
    threshold: { x: 4, y: 4 },
    getKeys: () => ({ convert: 'shift', tools: 'ctrl', actions: 'alt' }),
    onArm: () => calls.push('arm'),
    onRelease: () => calls.push('release'),
  });
  const press = () => handle({ type: EVENT.MOUSE_PRESSED, button: 1, x: 100, y: 100 });
  const drag = (dx = 30) => handle({ type: EVENT.MOUSE_DRAGGED, x: 100 + dx, y: 100 });
  const key = (keycode) => handle({ type: EVENT.KEY_PRESSED, keycode });
  const release = () => handle({ type: EVENT.MOUSE_RELEASED, button: 1, x: 130, y: 100 });
  return { calls, press, drag, key, release, handle };
}

test('arms once when a wheel key is pressed during an Explorer drag', () => {
  const t = setup();
  t.press(); t.drag(); t.key(CTRL); t.key(CTRL); t.key(SHIFT); t.release();
  assert.deepEqual(t.calls, ['arm', 'release']);
});

test('ignores keys before the pointer moved past the drag threshold', () => {
  const t = setup();
  t.press(); t.drag(2); t.key(CTRL); t.release();
  assert.deepEqual(t.calls, []);
});

test('ignores drags that did not start in Explorer or on the desktop', () => {
  const t = setup({ shell: false });
  t.press(); t.drag(); t.key(CTRL); t.release();
  assert.deepEqual(t.calls, []);
});

test('ignores non-wheel keys and open context menus', () => {
  const a = setup();
  a.press(); a.drag(); a.key(KEY_A); a.release();
  assert.deepEqual(a.calls, []);
  const b = setup({ menu: true });
  b.press(); b.drag(); b.key(CTRL); b.release();
  assert.deepEqual(b.calls, []);
});

test('right-button drags never arm the wheel', () => {
  const t = setup();
  t.handle({ type: EVENT.MOUSE_PRESSED, button: 2, x: 100, y: 100 });
  t.drag(); t.key(CTRL);
  assert.deepEqual(t.calls, []);
});

test('a new drag can arm again after the previous one ended', () => {
  const t = setup();
  t.press(); t.drag(); t.key(CTRL); t.release();
  t.press(); t.drag(); t.key(SHIFT); t.release();
  assert.deepEqual(t.calls, ['arm', 'release', 'arm', 'release']);
});
