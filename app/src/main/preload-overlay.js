const { contextBridge, ipcRenderer } = require('electron')

// Present only in the Electron window (not in OBS): the overlay page uses it
// for edit mode (moving the window).
contextBridge.exposeInMainWorld('overlayAPI', {
  onEditMode: cb => ipcRenderer.on('edit-mode', (_e, on) => cb(on)),
})
