const { contextBridge, ipcRenderer, shell } = require('electron')

contextBridge.exposeInMainWorld('desktopApp', {
  openExternal: (url) => shell.openExternal(url),
  platform: process.platform,
  getLauncherStatus: () => ipcRenderer.invoke('launcher:getStatus'),
  ensureDeps: (payload) => ipcRenderer.invoke('launcher:ensureDeps', payload),
  getAppUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  checkAppUpdate: (payload) => ipcRenderer.invoke('appUpdate:check', payload),
  quitAndInstallUpdate: () => ipcRenderer.invoke('appUpdate:quitAndInstall'),
  getGatewayLogTail: () => ipcRenderer.invoke('launcher:getGatewayLogTail'),
  createGatewayDeviceAuth: (payload) => ipcRenderer.invoke('gateway:createDeviceAuth', payload),
  setToken: (token) => ipcRenderer.invoke('launcher:setToken', token),
  startChatSession: (payload) => ipcRenderer.invoke('launcher:startChatSession', payload),
  startAndOpenChat: (payload) => ipcRenderer.invoke('launcher:startChatSession', payload),
  onAppUpdateState: (cb) => {
    const listener = (_event, data) => cb?.(data)
    ipcRenderer.on('app-update:state', listener)
    return () => ipcRenderer.removeListener('app-update:state', listener)
  },
  onInstallProgress: (cb) => {
    const listener = (_event, data) => cb?.(data)
    ipcRenderer.on('install:progress', listener)
    return () => ipcRenderer.removeListener('install:progress', listener)
  }
})
