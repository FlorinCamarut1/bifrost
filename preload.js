const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vp', {
  init: () => ipcRenderer.invoke('init'),
  act: (name, arg) => ipcRenderer.invoke('action', name, arg),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  on: cb => ipcRenderer.on('event', (_e, ch, data) => cb(ch, data)),
});
