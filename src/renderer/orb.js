import { icon } from './icons.js';

const api = window.kumquat;
const $ = (id) => document.getElementById(id);
const MODES = ['convert', 'tools', 'actions'];
const SIZE = 600;
const C = SIZE / 2;

let S = {}; // strings
let settings = {};
let state = 'idle'; // idle | dragging | picking | params | running | done | error
let mode = 'convert';
let manualMode = null; // mode chosen with a tab during a drag
let options = null; // { convert, tools, actions }
let files = []; // real paths once dropped
let fileCount = 0;
let hot = -1;
let layout = []; // [{ index, r0, r1, a0, a1 }]
let leaveTimer = null;
let doneTimer = null;
let tabDwell = null;
let optionsKey = '';

const t = (key, vars = {}) => (S[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

// ------------------------------------------------------------------ setup

const init = await api.init();
S = init.strings;
settings = init.settings;
document.documentElement.lang = init.locale;
mode = settings.defaultWheel;
buildTabs();

function keyFor(m) {
  return Object.entries(settings.keys).find(([wheel]) => wheel === m)?.[1];
}

function buildTabs() {
  $('tabs').innerHTML = MODES.map((m) => `<button data-mode="${m}" title="${t(m)}">${icon(m, 17)}<kbd>${t(keyFor(m) ?? '')}</kbd></button>`).join('');
  for (const b of $('tabs').children) {
    b.addEventListener('click', () => setMode(b.dataset.mode, true));
    b.addEventListener('dragover', () => {
      if (tabDwell?.mode === b.dataset.mode) return;
      clearTimeout(tabDwell?.timer);
      tabDwell = { mode: b.dataset.mode, timer: setTimeout(() => setMode(b.dataset.mode, true), 220) };
    });
    b.addEventListener('dragleave', () => { clearTimeout(tabDwell?.timer); tabDwell = null; });
  }
}

// ------------------------------------------------------------------ geometry

function arcPath(r0, r1, a0, a1) {
  if (a1 - a0 > Math.PI * 2 - 0.01) {
    // A single option fills the whole ring: draw a donut instead of a degenerate arc.
    const ring = (r, sweep) => `M ${C + r} ${C} A ${r} ${r} 0 1 ${sweep} ${C - r} ${C} A ${r} ${r} 0 1 ${sweep} ${C + r} ${C} Z`;
    return `${ring(r1, 1)} ${ring(r0, 0)}`;
  }
  const p = (r, a) => `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

function computeLayout(n) {
  const rings = n <= 12 ? [[n, 122, 296]] : [[Math.ceil(n * 0.4), 122, 205], [n - Math.ceil(n * 0.4), 209, 296]];
  const out = [];
  let index = 0;
  for (const [count, r0, r1] of rings) {
    const step = (Math.PI * 2) / count;
    const pad = count > 1 ? 0.012 : 0;
    for (let i = 0; i < count; i++) {
      const a0 = -Math.PI / 2 - step / 2 + i * step + pad;
      out.push({ index: index++, r0, r1, a0, a1: a0 + step - pad * 2, rings: rings.length });
    }
  }
  return out;
}

/** Returns the wedge index at a client point, -2 for the centre, -1 for outside. */
function hitTest(x, y) {
  const box = $('wedges').getBoundingClientRect();
  const dx = x - (box.left + box.width / 2);
  const dy = y - (box.top + box.height / 2);
  const r = Math.hypot(dx, dy);
  if (r < 118) return -2;
  if (r > 300) return -1;
  let a = Math.atan2(dy, dx);
  for (const w of layout) {
    if (r < w.r0 - 2 || r > w.r1 + 2) continue;
    let ang = a;
    while (ang < w.a0) ang += Math.PI * 2;
    while (ang > w.a0 + Math.PI * 2) ang -= Math.PI * 2;
    if (ang <= w.a1 + 0.02) return w.index;
  }
  return -1;
}

// ------------------------------------------------------------------ rendering

function currentList() {
  return options ? options[mode] : null;
}

function render() {
  const list = currentList();
  const svg = $('wedges');
  const defs = `<defs><linearGradient id="hotGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ffc06a"/></linearGradient></defs>`;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.mode === mode);

  if (!list || !list.length) {
    layout = [];
    svg.innerHTML = `${defs}<circle class="track" cx="${C}" cy="${C}" r="209" stroke-width="174" fill="none" style="stroke: rgba(28,20,15,.94)"/>`;
    $('labels').innerHTML = '';
    setCenter(t(mode), list ? t('noOptions') : t('dropForOptions'));
    return;
  }
  layout = computeLayout(list.length);
  svg.innerHTML = defs + layout.map((w) => {
    const op = list[w.index];
    return `<path d="${arcPath(w.r0, w.r1, w.a0, w.a1)}" data-i="${w.index}" class="${w.index === hot ? 'hot' : ''} ${op.needs ? 'disabled' : ''}"/>`;
  }).join('');
  $('labels').innerHTML = layout.map((w) => {
    const op = list[w.index];
    const mid = (w.a0 + w.a1) / 2;
    const r = (w.r0 + w.r1) / 2 + (w.rings === 1 ? 6 : 0);
    const x = C + r * Math.cos(mid);
    const y = C + r * Math.sin(mid);
    const small = w.rings > 1 || list.length > 9;
    const inner = mode === 'convert'
      ? `<span class="fmt">${esc(op.label)}</span>${op.sub || op.needs ? `<span class="sub">${esc(op.needs ? t('needs', { app: op.needs }) : op.sub)}</span>` : ''}`
      : `${icon(op.icon, small ? 19 : 22)}<span class="name">${esc(op.label)}</span>`;
    return `<div class="label ${small ? 'small' : ''} ${w.index === hot ? 'hot' : ''} ${op.needs ? 'disabled' : ''}" style="left:${x}px;top:${y}px">${inner}</div>`;
  }).join('');
  updateCenter();
}

function setHot(i) {
  if (i === hot) return;
  hot = i;
  $('wedges').querySelectorAll('path').forEach((p) => p.classList.toggle('hot', +p.dataset.i === hot));
  [...$('labels').children].forEach((l, idx) => l.classList.toggle('hot', idx === hot));
  updateCenter();
}

function updateCenter() {
  const list = currentList();
  const op = list && hot >= 0 ? list[hot] : null;
  const count = fileCount === 1 ? t('file') : t('files', { n: fileCount });
  if (op) setCenter(op.label, mode === 'convert' ? `${t('convert')} · ${count}` : count);
  else setCenter(t(mode), fileCount ? count : '');
}

function setCenter(title, subtitle) {
  $('title').textContent = title;
  $('subtitle').textContent = subtitle;
  $('hint').textContent = state === 'dragging' ? t('dropHint') : state === 'picking' ? t('keyHelp') : '';
}

function setMode(m, manual = false) {
  if (!MODES.includes(m) || (m === mode && !manual)) return;
  mode = m;
  if (manual) manualMode = m;
  hot = state === 'picking' ? 0 : -1;
  if (state === 'dragging' || state === 'picking') render();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ------------------------------------------------------------------ open / close

function expand() {
  clearTimeout(doneTimer);
  if (document.body.classList.contains('collapsed')) {
    document.body.classList.remove('collapsed');
    api.expand();
  }
}

function collapse() {
  clearTimeout(leaveTimer);
  clearTimeout(doneTimer);
  state = 'idle';
  options = null;
  files = [];
  fileCount = 0;
  hot = -1;
  manualMode = null;
  optionsKey = '';
  $('panel').hidden = true;
  $('wheel').classList.remove('dim');
  document.body.classList.add('collapsed');
  document.body.classList.remove('drag-hover');
  api.collapse();
}

function modeFromModifiers(e) {
  for (const [wheel, key] of Object.entries(settings.keys)) {
    if ((key === 'shift' && e.shiftKey) || (key === 'ctrl' && e.ctrlKey) || (key === 'alt' && e.altKey)) return wheel;
  }
  return null;
}

// ------------------------------------------------------------------ drag & drop

function hasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}

document.addEventListener('dragenter', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  clearTimeout(leaveTimer);
  if (state === 'dragging') return trackDrag(e);
  if (state !== 'idle' && state !== 'picking') return;
  state = 'dragging';
  mode = settings.defaultWheel;
  const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
  fileCount = items.length;
  const mimes = items.map((i) => i.type);
  const key = mimes.join('|');
  expand();
  render();
  if (key !== optionsKey) {
    optionsKey = key;
    options = await api.optionsForMimes(mimes);
    if (state === 'dragging') render();
  }
  if (state === 'dragging') trackDrag(e);
});

/** Picks the wheel from held modifier keys and highlights the wedge under the pointer. */
function trackDrag(e) {
  const wanted = modeFromModifiers(e) ?? manualMode ?? settings.defaultWheel;
  if (wanted !== mode) setMode(wanted);
  const i = hitTest(e.clientX, e.clientY);
  setHot(i >= 0 && !currentList()?.[i]?.needs ? i : -1);
}

document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  clearTimeout(leaveTimer);
  if (state !== 'dragging' && state !== 'picking') return;
  if (state === 'picking') state = 'dragging';
  trackDrag(e);
});

document.addEventListener('dragleave', (e) => {
  // dragleave also fires when moving between child elements (relatedTarget is then the element entered);
  // only a leave towards outside the window has no relatedTarget.
  if (state !== 'dragging' || e.relatedTarget) return;
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    if (state === 'dragging') collapse();
  }, 150);
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  clearTimeout(leaveTimer);
  if (state !== 'dragging') return;
  const dropped = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
  if (!dropped.length) return collapse();
  trackDrag(e);
  const index = hitTest(e.clientX, e.clientY);
  const guessed = index >= 0 ? currentList()?.[index] : null;
  files = dropped;
  fileCount = files.length;
  options = await api.optionsForFiles(files);
  const real = guessed && options[mode]?.find((o) => o.id === guessed.id);
  if (real) return execute(real);
  startPicking();
});

function startPicking() {
  state = 'picking';
  hot = currentList()?.length ? 0 : -1;
  render();
  window.focus();
}

// Files handed over from the command line, "Send to", "Open with" or the file picker.
api.onWheelOpen((data) => {
  clearTimeout(doneTimer);
  files = data.files;
  fileCount = files.length;
  options = data.options;
  mode = settings.defaultWheel;
  manualMode = null;
  $('panel').hidden = true;
  $('wheel').classList.remove('dim');
  expand();
  startPicking();
});

// ------------------------------------------------------------------ pointer & keyboard

$('wheel').addEventListener('mousemove', (e) => {
  if (state !== 'picking') return;
  const i = hitTest(e.clientX, e.clientY);
  if (i >= 0) setHot(i);
});

document.addEventListener('mousedown', (e) => {
  if (state === 'picking' || state === 'done' || state === 'error') {
    if (e.button !== 0) return;
    if ($('panel').contains(e.target) || $('center').contains(e.target)) return;
    const i = hitTest(e.clientX, e.clientY);
    if (i >= 0 && state === 'picking') {
      const op = currentList()?.[i];
      if (op) execute(op);
    } else if (i === -1) {
      collapse();
    }
  }
});

window.addEventListener('blur', () => {
  if (state === 'picking') collapse();
});

document.addEventListener('keydown', (e) => {
  if (state === 'params') {
    if (e.key === 'Escape') collapse();
    return;
  }
  if (state === 'running') {
    if (e.key === 'Escape') api.cancel();
    return;
  }
  if (state === 'done' || state === 'error') {
    if (e.key === 'Escape' || e.key === 'Enter') collapse();
    return;
  }
  if (state !== 'picking') return;
  const list = currentList() ?? [];
  const pressed = { Shift: 'shift', Control: 'ctrl', Alt: 'alt' }[e.key];
  if (pressed) {
    const wheel = Object.entries(settings.keys).find(([, k]) => k === pressed)?.[0];
    if (wheel) setMode(wheel, true);
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      if (list.length) setHot((hot + 1 + list.length) % list.length);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      if (list.length) setHot((hot - 1 + list.length) % list.length);
      break;
    case 'Tab': {
      const next = MODES[(MODES.indexOf(mode) + (e.shiftKey ? 2 : 1)) % 3];
      setMode(next, true);
      break;
    }
    case 'Enter':
      if (list[hot]) execute(list[hot]);
      break;
    case 'Escape':
      collapse();
      break;
    default:
      return;
  }
  e.preventDefault();
});

// Orb: click opens the file picker, drag moves it, right-click shows the menu.
let press = null;
$('orb').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, moved: false };
  $('orb').setPointerCapture(e.pointerId);
  api.dragOrb('start', e.screenX, e.screenY);
});
$('orb').addEventListener('pointermove', (e) => {
  if (!press) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) press.moved = true;
  if (press.moved) api.dragOrb('move', e.screenX, e.screenY);
});
$('orb').addEventListener('pointerup', (e) => {
  if (!press) return;
  if (press.moved) api.dragOrb('end', e.screenX, e.screenY);
  else api.orbMenu();
  press = null;
});
$('orb').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.orbMenu();
});
document.addEventListener('dragenter', () => document.body.classList.add('drag-hover'));

// ------------------------------------------------------------------ running operations

function execute(op) {
  if (op.needs) return showError(t('needs', { app: op.needs }), op.needs);
  if (op.params?.length) return showParams(op);
  run(op, {});
}

function openPanel(html) {
  $('wheel').classList.add('dim');
  const panel = $('panel');
  panel.innerHTML = html;
  panel.hidden = false;
  return panel;
}

function showParams(op) {
  state = 'params';
  const values = Object.fromEntries(op.params.map((p) => [p.key, p.default]));
  const fields = op.params.map((p) => {
    const id = `f-${p.key}`;
    let control;
    if (p.type === 'range') {
      control = `<input id="${id}" type="range" min="${p.min}" max="${p.max}" value="${p.default}">`;
    } else if (p.type === 'select' && p.options.length <= 4) {
      control = `<div class="segments" data-key="${p.key}">${p.options.map((o) => `<button type="button" data-v="${esc(o)}" class="${o === p.default ? 'on' : ''}">${esc(p.labels?.[o] ?? `${o}${p.unit ?? ''}`)}</button>`).join('')}</div>`;
    } else if (p.type === 'select') {
      control = `<select id="${id}">${p.options.map((o) => `<option value="${esc(o)}" ${o === p.default ? 'selected' : ''}>${esc(p.labels?.[o] ?? `${o}${p.unit ?? ''}`)}</option>`).join('')}</select>`;
    } else {
      control = `<input id="${id}" type="${p.type === 'number' ? 'number' : 'text'}" value="${esc(p.default)}" placeholder="${esc(p.placeholder ?? '')}" ${p.min != null ? `min="${p.min}"` : ''} ${p.step ? `step="${p.step}"` : ''}>`;
    }
    const value = p.type === 'range' ? `<span id="${id}-v">${p.default}${p.unit ?? ''}</span>` : '';
    return `<div class="field"><label for="${id}"><span>${esc(p.label)}</span>${value}</label>${control}</div>`;
  }).join('');
  const panel = openPanel(`<form><h2>${icon(op.icon ?? 'convert', 18)}${esc(op.label)}</h2>${fields}
    <div class="buttons"><button type="button" class="cancel">${t('cancel')}</button><button type="submit" class="primary">${t('run')}</button></div></form>`);
  for (const p of op.params) {
    const el = panel.querySelector(`#f-${p.key}`);
    if (el) {
      el.addEventListener('input', () => {
        values[p.key] = el.value;
        const v = panel.querySelector(`#f-${p.key}-v`);
        if (v) v.textContent = `${el.value}${p.unit ?? ''}`;
      });
      el.addEventListener('change', () => (values[p.key] = el.value));
    }
  }
  panel.querySelectorAll('.segments').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      values[group.dataset.key] = b.dataset.v;
    });
  });
  panel.querySelector('.cancel').addEventListener('click', collapse);
  panel.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    run(op, values);
  });
  window.focus();
  (panel.querySelector('input[type=text], input[type=number]') ?? panel.querySelector('.primary')).focus();
}

const RING = 2 * Math.PI * 34;

function showProgress(op) {
  state = 'running';
  const panel = openPanel(`<h2>${icon(op.icon ?? 'convert', 18)}${esc(op.label)}</h2>
    <div class="progress indeterminate"><svg width="84" height="84" viewBox="0 0 84 84">
      <defs><linearGradient id="progressGradient"><stop offset="0" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ffc06a"/></linearGradient></defs>
      <circle class="bg" cx="42" cy="42" r="34" fill="none" stroke-width="7"/>
      <circle class="fg" cx="42" cy="42" r="34" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${RING}" stroke-dashoffset="${RING * 0.75}"/>
    </svg><span class="pct"></span></div>
    <div class="status">${t('working')}</div>
    <div class="buttons"><button class="cancel">${t('cancel')}</button></div>`);
  panel.querySelector('.cancel').addEventListener('click', () => api.cancel());
}

api.onProgress((f) => {
  if (state !== 'running') return;
  const box = $('panel').querySelector('.progress');
  if (!box) return;
  box.classList.remove('indeterminate');
  box.querySelector('.fg').setAttribute('stroke-dashoffset', String(RING * (1 - f)));
  box.querySelector('.pct').textContent = `${Math.round(f * 100)}%`;
});

async function run(op, params) {
  showProgress(op);
  const result = await api.run(op.id, files, params);
  if (state !== 'running') return;
  if (!result.ok) return showError(result.error, result.needs);
  if (result.error) return showError(result.error);
  if (result.cancelled || result.collapse) return collapse();
  showDone(result);
}

function showDone(result) {
  state = 'done';
  const outputs = result.outputs ?? [];
  const names = outputs.map((o) => o.split(/[\\/]/).pop());
  const body = result.message ?? (names.length > 3 ? `${names.slice(0, 3).join('\n')}\n+${names.length - 3}` : names.join('\n'));
  const panel = openPanel(`<div class="result-icon ok">${icon('check', 28)}</div>
    <div class="result-title">${t('done')}</div>
    <div class="result-body">${esc(body)}</div>
    <div class="buttons">${outputs.length ? `<button class="show">${icon('reveal', 15)}${t('show')}</button><button class="open primary">${icon('open', 15)}${t('open')}</button>` : `<button class="primary close">${t('done')}</button>`}</div>`);
  panel.querySelector('.show')?.addEventListener('click', () => { api.reveal(outputs[0]); collapse(); });
  panel.querySelector('.open')?.addEventListener('click', () => { api.open(outputs[0]); collapse(); });
  panel.querySelector('.close')?.addEventListener('click', collapse);
  const arm = () => { clearTimeout(doneTimer); doneTimer = setTimeout(collapse, 6000); };
  panel.addEventListener('mouseenter', () => clearTimeout(doneTimer));
  panel.addEventListener('mouseleave', arm);
  arm();
}

function showError(message, needs) {
  state = 'error';
  const link = needs === 'LibreOffice' ? `\n<a class="get">libreoffice.org ↗</a>` : '';
  const panel = openPanel(`<div class="result-icon err">${icon('alert', 28)}</div>
    <div class="result-title">${t('failed')}</div>
    <div class="result-body">${esc(message)}${link}</div>
    <div class="buttons"><button class="primary close">${t('dismiss')}</button></div>`);
  panel.querySelector('.close').addEventListener('click', collapse);
  panel.querySelector('.get')?.addEventListener('click', () => api.openLink('https://www.libreoffice.org/download/'));
}
