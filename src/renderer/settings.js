const api = window.kumquat;
const $ = (id) => document.getElementById(id);

const init = await api.init();
let settings = init.settings;
const S = init.strings;
const t = (key, vars = {}) => (S[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

document.body.classList.add(init.platform);
document.documentElement.lang = init.locale;
document.title = t('settings.title');
document.querySelectorAll('[data-t]').forEach((el) => (el.textContent = t(el.dataset.t)));
$('tagline').textContent = init.locale === 'tr' ? 'Sürükle. Tut. Dönüştür.' : 'Drag. Hold. Transform.';
$('version').textContent = t('settings.version', { v: init.version });
$('repo').addEventListener('click', () => api.openLink('https://github.com/TrinsyCa/kumquat'));
$('lo').innerHTML = init.libreoffice ? `<span class="ok">✓ ${t('settings.found')}</span>` : `<span class="no">${t('settings.notFound')}</span>`;

async function save(patch) {
  settings = await api.setSettings(patch);
  render();
}

function render() {
  $('language').value = settings.language;
  $('showOrb').checked = settings.showOrb;
  $('launchAtLogin').checked = settings.launchAtLogin;
  $('sendTo').checked = settings.sendTo;
  $('dragWheel').checked = settings.dragWheel;
  $('shortcut').value = settings.shortcut ?? '';
  $('defaultWheel').value = settings.defaultWheel;
  $('output').value = settings.output;
  $('afterDone').value = settings.afterDone;
  $('customRow').style.display = settings.output === 'custom' ? 'flex' : 'none';
  $('customDir').textContent = settings.customDir || '—';
  document.querySelectorAll('select.key').forEach((sel) => {
    sel.innerHTML = ['shift', 'ctrl', 'alt'].map((k) => `<option value="${k}">${t(k)}</option>`).join('');
    sel.value = settings.keys[sel.dataset.wheel];
  });
}

$('language').addEventListener('change', async (e) => {
  await save({ language: e.target.value });
  location.reload();
});
for (const id of ['showOrb', 'launchAtLogin', 'sendTo', 'dragWheel']) $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
for (const id of ['defaultWheel', 'afterDone']) $(id).addEventListener('change', (e) => save({ [id]: e.target.value }));
$('shortcut').addEventListener('change', (e) => save({ shortcut: e.target.value.trim() }));
$('output').addEventListener('change', async (e) => {
  if (e.target.value === 'custom' && !settings.customDir) {
    const dir = await api.chooseDir();
    if (!dir) return render();
    return save({ output: 'custom', customDir: dir });
  }
  save({ output: e.target.value });
});
$('chooseDir').addEventListener('click', async () => {
  const dir = await api.chooseDir();
  if (dir) save({ customDir: dir });
});
document.querySelectorAll('select.key').forEach((sel) =>
  sel.addEventListener('change', () => {
    // Each key can only drive one wheel, so swap with whichever wheel used it before.
    const keys = { ...settings.keys };
    const wheel = sel.dataset.wheel;
    const other = Object.keys(keys).find((w) => w !== wheel && keys[w] === sel.value);
    if (other) keys[other] = keys[wheel];
    keys[wheel] = sel.value;
    save({ keys });
  })
);

render();
