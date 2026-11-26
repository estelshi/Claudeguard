const { contextBridge, ipcRenderer } = require('electron')
const calls = ['boot', 'detect-clash', 'detect-v2rayn', 'copy-template', 'catalogue', 'save-setup', 'confirm-relay', 'pick-script', 'reveal-script', 'copy-script', 'import-verge-subscription', 'guard', 'probes', 'login', 'set-theme',
  'env-check', 'env-baseline', 'env-repair-preview', 'env-repair-apply', 'env-history', 'env-restore', 'env-open-settings']
contextBridge.exposeInMainWorld('guardnook', Object.fromEntries(calls.map(name => [name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), input => ipcRenderer.invoke(`guardnook:${name}`, input)])))
contextBridge.exposeInMainWorld('guardnookEvents', {
  onState(callback) {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('guardnook:state', listener)
    return () => ipcRenderer.removeListener('guardnook:state', listener)
  },
})
