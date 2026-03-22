import { envReady } from './launcher'

export async function refreshLauncherStatus({ api, setStatus, setToken }) {
  const nextStatus = await api?.getLauncherStatus?.()
  setStatus(nextStatus)
  setToken((prev) => prev || nextStatus?.tokenValue || '')
  return nextStatus
}

export async function checkLauncherEnvironment({
  api,
  silent = false,
  setBusy,
  setLogs,
  setProgress,
  setStatus,
  setToken,
  setCheckedOnce
}) {
  if (!api) return null

  setBusy(true)
  if (!silent) {
    setLogs([])
  }
  setProgress({ percent: 0, stage: '正在检查环境…' })

  try {
    const nextStatus = await refreshLauncherStatus({ api, setStatus, setToken })
    setStatus(nextStatus)
    setCheckedOnce(true)
    setProgress({ percent: 100, stage: '环境检查完成' })

    if (!silent) {
      setLogs((prev) => [...prev, envReady(nextStatus) ? '环境已通过。' : '环境未通过，可继续自动安装。'])
    }

    return nextStatus
  } catch (error) {
    setProgress({ percent: 0, stage: '失败' })
    if (!silent) {
      setLogs((prev) => [...prev, `失败：${error?.message || String(error)}`])
    }
    return null
  } finally {
    setBusy(false)
  }
}

// Wrap the launcher flow so the page component only needs to manage UI state.
export async function startLauncherChat({
  api,
  status,
  token,
  checkEnvironment,
  refreshStatus,
  setBusy,
  setLogs,
  setProgress,
  setStatus,
  setChatUrl,
  setSessionKey,
  setMode
}) {
  if (!api) return

  setBusy(true)
  setLogs([])
  setProgress({ percent: 0, stage: '准备中…' })

  try {
    let nextStatus = status || await checkEnvironment()

    if (!envReady(nextStatus)) {
      setProgress({ percent: 5, stage: '正在安装环境…' })
      setLogs([])
      if (typeof api.ensureDeps === 'function') {
        nextStatus = await api.ensureDeps()
        setStatus(nextStatus)
      } else {
        setLogs((prev) => [...prev, '当前 preload 未暴露 ensureDeps，跳过自动补环境，直接尝试启动。'])
      }
      if (!envReady(nextStatus) && typeof api.ensureDeps === 'function') {
        throw new Error('环境仍未就绪，请查看日志。')
      }
    }

    const currentToken = token.trim()
    if (!currentToken && !nextStatus?.tokenConfigured) {
      throw new Error('请先填写 OpenClaw gateway token。')
    }

    if (currentToken) {
      await api.setToken(currentToken)
      nextStatus = await refreshStatus()
    }

    setProgress({ percent: 80, stage: '正在启动对话…' })
    const startChat = typeof api.startChatSession === 'function'
      ? api.startChatSession
      : api.startAndOpenChat

    if (typeof startChat !== 'function') {
      throw new Error('preload 未注入启动对话接口，请完全退出 Electron 后重新打开。')
    }

    const result = await startChat({ token: currentToken || undefined })
    setChatUrl(result.wsUrl)
    setSessionKey(result.sessionKey)
    setMode('chat')
    setProgress({ percent: 100, stage: '对话已就绪' })
    setLogs((prev) => [...prev, 'OpenClaw WebSocket 对话已连接。'])
  } catch (error) {
    const message = error?.message || String(error)
    setProgress({ percent: 0, stage: '失败' })
    setLogs((prev) => [...prev, `失败：${message}`])
  } finally {
    setBusy(false)
  }
}
