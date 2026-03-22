const { contextBridge, ipcRenderer, shell } = require('electron')

contextBridge.exposeInMainWorld('desktopApp', {
  openExternal: (url) => shell.openExternal(url),
  platform: process.platform,
  getLauncherStatus: () => ipcRenderer.invoke('launcher:getStatus'),
  ensureDeps: (payload) => ipcRenderer.invoke('launcher:ensureDeps', payload),
  getGatewayLogTail: () => ipcRenderer.invoke('launcher:getGatewayLogTail'),
  getWindowState: () => ipcRenderer.invoke('window:getState'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:maximizeToggle'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  createGatewayDeviceAuth: (payload) => ipcRenderer.invoke('gateway:createDeviceAuth', payload),
  setToken: (token) => ipcRenderer.invoke('launcher:setToken', token),
  startChatSession: (payload) => ipcRenderer.invoke('launcher:startChatSession', payload),
  startAndOpenChat: (payload) => ipcRenderer.invoke('launcher:startChatSession', payload),
  onInstallProgress: (cb) => {
    const listener = (_event, data) => cb?.(data)
    ipcRenderer.on('install:progress', listener)
    return () => ipcRenderer.removeListener('install:progress', listener)
  }
})
