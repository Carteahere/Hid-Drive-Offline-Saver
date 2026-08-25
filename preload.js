const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  captureStart: (url) => ipcRenderer.invoke('capture:start', url),
  listArchives: () => ipcRenderer.invoke('archive:list'),
  openArchive: (id) => ipcRenderer.invoke('archive:open', id),
  setNote: (id, note) => ipcRenderer.invoke('archive:setNote', id, note),
  deleteArchive: (id) => ipcRenderer.invoke('archive:delete', id),
  openFolder: () => ipcRenderer.invoke('archive:openFolder'),
  onArchivesChanged: (cb) => ipcRenderer.on('archives-changed', () => cb())
})
