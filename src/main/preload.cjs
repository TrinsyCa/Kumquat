const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kumquat', {
  init: () => ipcRenderer.invoke('init'),
  pathFor: (file) => webUtils.getPathForFile(file),

  expand: () => ipcRenderer.send('orb:expand'),
  collapse: () => ipcRenderer.send('orb:collapse'),
  dragOrb: (phase, x, y) => ipcRenderer.send('orb:drag', { phase, x, y }),
  orbMenu: () => ipcRenderer.send('orb:menu'),

  optionsForMimes: (mimes) => ipcRenderer.invoke('options:mimes', mimes),
  optionsForFiles: (files) => ipcRenderer.invoke('options:files', files),
  run: (id, files, params) => ipcRenderer.invoke('op:run', { id, files, params }),
  cancel: () => ipcRenderer.send('op:cancel'),
  onProgress: (fn) => ipcRenderer.on('op:progress', (e, f) => fn(f)),
  onWheelOpen: (fn) => ipcRenderer.on('wheel:open', (e, data) => fn(data)),

  reveal: (p) => ipcRenderer.send('path:reveal', p),
  open: (p) => ipcRenderer.send('path:open', p),
  openLink: (url) => ipcRenderer.send('link:open', url),

  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDir: () => ipcRenderer.invoke('settings:chooseDir'),
  openSettings: () => ipcRenderer.send('settings:open'),

  shareInfo: () => ipcRenderer.invoke('share:info'),
  onShareDownload: (fn) => ipcRenderer.on('share:downloaded', fn),
  closeWindow: () => ipcRenderer.send('window:close'),

  floatInfo: (files) => ipcRenderer.invoke('float:info', files),
  startDrag: (files) => ipcRenderer.send('float:drag', files),
});
