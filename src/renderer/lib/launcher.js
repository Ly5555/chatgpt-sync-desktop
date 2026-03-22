export function resolveApi() {
  if (typeof window === 'undefined') return null

  const desktopApp = window.desktopApp
  const legacyApp = window.openclawInstaller

  if (desktopApp?.getLauncherStatus || desktopApp?.startChatSession) {
    return desktopApp
  }

  if (desktopApp || legacyApp) {
    return {
      openExternal: desktopApp?.openExternal,
      onInstallProgress: desktopApp?.onInstallProgress || legacyApp?.onInstallProgress,
      getLauncherStatus: desktopApp?.getLauncherStatus || legacyApp?.getLauncherStatus,
      ensureDeps: desktopApp?.ensureDeps || legacyApp?.ensureDeps,
      setToken: desktopApp?.setToken || legacyApp?.setToken,
      startChatSession: desktopApp?.startChatSession || desktopApp?.startAndOpenChat || legacyApp?.startAndOpenChat
    }
  }

  return null
}

export function envReady(status) {
  if (!status) return false
  if (status.gatewayRunning) return true
  return Boolean(status.openclawAvailable || (status.nodeOk && status.pnpmAvailable))
}

export function getPrimaryButtonText({ checkedOnce, ready, busy, canEnterChat }) {
  if (busy) return '处理中…'
  if (!checkedOnce) return '正在检查环境'
  if (canEnterChat || ready) return '开始使用'
  return '一键安装环境'
}
