'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The only bridge between the page and the desktop. Each call maps to one main-process handler.
contextBridge.exposeInMainWorld('pdfEditor', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  readPath: p => ipcRenderer.invoke('read-path', p),
  save: (path, data) => ipcRenderer.invoke('save', { path, data }),
  saveAs: (suggestedName, data) => ipcRenderer.invoke('save-as', { suggestedName, data }),
  print: () => ipcRenderer.invoke('print'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setTheme: t => ipcRenderer.invoke('set-theme', t),
  removeRecent: p => ipcRenderer.invoke('remove-recent', p),
  showInFolder: p => ipcRenderer.invoke('show-in-folder', p),
  setDirty: v => ipcRenderer.send('dirty', v),
  pathForFile: file => webUtils.getPathForFile(file),
  onMenu: fn => ipcRenderer.on('menu', (_e, name) => fn(name)),
  onOpenPaths: fn => ipcRenderer.on('open-paths', (_e, paths) => fn(paths)),
});
