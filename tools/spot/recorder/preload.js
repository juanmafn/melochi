const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spot', {
  save: (data) => ipcRenderer.invoke('spot:save', data),
  log: (msg) => ipcRenderer.send('spot:log', msg),
});
