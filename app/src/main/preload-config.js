const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getInit: () => ipcRenderer.invoke('get-init'),
  saveConfig: cfg => ipcRenderer.invoke('save-config', cfg),
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  setEditMode: on => ipcRenderer.invoke('set-edit-mode', on),
  setOverlayScale: s => ipcRenderer.invoke('set-overlay-scale', s),
  getStatus: () => ipcRenderer.invoke('get-status'),
  onStatus: cb => ipcRenderer.on('status', (_e, s) => cb(s)),
})
