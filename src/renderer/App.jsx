import { useEffect, useRef, useState } from 'react'

function resolveApi() {
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
      onAppUpdateState: desktopApp?.onAppUpdateState,
      getLauncherStatus: desktopApp?.getLauncherStatus || legacyApp?.getLauncherStatus,
      getAppUpdateState: desktopApp?.getAppUpdateState,
      checkAppUpdate: desktopApp?.checkAppUpdate,
      quitAndInstallUpdate: desktopApp?.quitAndInstallUpdate,
      ensureDeps: desktopApp?.ensureDeps || legacyApp?.ensureDeps,
      setToken: desktopApp?.setToken || legacyApp?.setToken,
      startChatSession: desktopApp?.startChatSession || desktopApp?.startAndOpenChat || legacyApp?.startAndOpenChat
    }
  }

  return null
}

function envReady(status) {
  if (!status) return false
  if (status.gatewayRunning) return true
  return Boolean(status.openclawAvailable || (status.nodeOk && status.pnpmAvailable))
}
function VersionCard({ title, required, installed, ok }) {
  return (
    <div className={`version-card ${ok ? 'ok' : 'warn'}`}>
      <div className="version-top">
        <div className="version-title">{title}</div>
        <div className={`version-state ${ok ? 'ok' : 'warn'}`}>{ok ? '已达标' : '需处理'}</div>
      </div>
      <div className="version-row">
        <span>需要</span>
        <strong>{required || '--'}</strong>
      </div>
      <div className="version-row">
        <span>已安装</span>
        <strong>{installed || '--'}</strong>
      </div>
    </div>
  )
}

function extractMessageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const texts = blocks
    .filter((block) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)

  if (texts.length > 0) {
    return texts.join('\n\n')
  }

  if (typeof message?.text === 'string' && message.text.trim()) {
    return message.text.trim()
  }

  return ''
}

function sessionKeyMatches(expected, actual) {
  const expectedKey = String(expected || '').trim()
  const actualKey = String(actual || '').trim()

  if (!expectedKey || !actualKey) return false
  if (expectedKey === actualKey) return true
  if (actualKey.endsWith(`:${expectedKey}`)) return true

  return false
}

function updateTone(status) {
  if (status === 'downloaded' || status === 'ready') return 'ok'
  if (status === 'error' || status === 'disabled' || status === 'unsupported') return 'warn'
  return 'neutral'
}

class GatewaySocketClient {
  constructor({ url, token, sessionKey, onStatus, onHistory, onChatEvent, onDebug }) {
    this.url = url
    this.token = token
    this.sessionKey = sessionKey
    this.onStatus = onStatus
    this.onHistory = onHistory
    this.onChatEvent = onChatEvent
    this.onDebug = onDebug
    this.ws = null
    this.pending = new Map()
    this.challengeTimer = null
    this.connectedOnce = false
  }

  debug(message) {
    this.onDebug?.(`[${new Date().toLocaleTimeString()}] ${message}`)
  }

  connect() {
    this.dispose()
    this.debug(`connect ws ${this.url}`)
    this.debug(`session=${this.sessionKey} token=${this.token ? `len:${this.token.length}` : 'missing'}`)
    this.onStatus?.('connecting')
    this.ws = new WebSocket(this.url)
    this.challengeTimer = window.setTimeout(() => {
      this.debug('connect challenge timeout')
      this.onStatus?.('error', '等待 Gateway challenge 超时')
      this.ws?.close()
    }, 4000)

    this.ws.addEventListener('open', () => {
      this.debug('ws open')
      this.onStatus?.('connecting')
    })

    this.ws.addEventListener('message', (event) => {
      this.debug(`ws message ${String(event.data).slice(0, 160)}`)
      this.handleMessage(event.data)
    })

    this.ws.addEventListener('close', () => {
      this.debug('ws close')
      this.clearPending(new Error('Gateway 连接已关闭'))
      this.onStatus?.(this.connectedOnce ? 'closed' : 'error', this.connectedOnce ? '' : '握手未完成，连接已关闭')
    })

    this.ws.addEventListener('error', () => {
      this.debug('ws error')
      this.onStatus?.('error', 'Gateway WebSocket 连接失败')
    })
  }

  dispose() {
    if (this.challengeTimer) {
      window.clearTimeout(this.challengeTimer)
      this.challengeTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.clearPending(new Error('Gateway client disposed'))
  }

  clearPending(error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        window.clearTimeout(pending.timer)
      }
      pending.reject(error)
    }
    this.pending.clear()
  }

  handleMessage(raw) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.debug(`json parse failed: ${error?.message || String(error)}`)
      return
    }

    if (parsed?.type === 'event') {
      if (parsed.event === 'connect.challenge') {
        const nonce = parsed?.payload?.nonce
        this.debug(`received challenge nonce=${nonce ? 'yes' : 'no'}`)
        if (this.challengeTimer) {
          window.clearTimeout(this.challengeTimer)
          this.challengeTimer = null
        }
        this.sendConnect(nonce)
        return
      }

      if (parsed.event === 'chat') {
        this.debug(`chat event state=${parsed?.payload?.state || 'unknown'}`)
        this.onChatEvent?.(parsed.payload)
      }

      if (parsed.event !== 'connect.challenge' && parsed.event !== 'chat') {
        this.debug(`event ${parsed.event || 'unknown'}`)
      }

      return
    }

    if (parsed?.type !== 'res') return

    const pending = this.pending.get(parsed.id)
    if (!pending) {
      this.debug(`response without pending id=${parsed.id || 'unknown'}`)
      return
    }

    const status = parsed?.payload?.status
    if (pending.expectFinal && status === 'accepted') {
      this.debug(`request accepted id=${parsed.id}`)
      return
    }

    this.pending.delete(parsed.id)
    if (pending.timer) {
      window.clearTimeout(pending.timer)
    }
    if (parsed.ok) {
      this.debug(`request ok id=${parsed.id}`)
      pending.resolve(parsed.payload)
    } else {
      this.debug(`request error id=${parsed.id} message=${parsed?.error?.message || 'unknown'}`)
      pending.reject(new Error(parsed?.error?.message || 'Gateway request failed'))
    }
  }

  async sendConnect(nonce) {
    if (!nonce) {
      this.debug('sendConnect aborted: missing nonce')
      this.onStatus?.('error', 'Gateway challenge 缺少 nonce')
      return
    }

    try {
      this.debug('creating device auth')
      const device = await window.desktopApp?.createGatewayDeviceAuth?.({
        nonce,
        token: this.token,
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        clientId: 'gateway-client',
        clientMode: 'backend',
        platform: window.desktopApp?.platform || 'macos'
      })

      this.debug(`connect request with device=${device ? 'yes' : 'no'}`)

      await this.request('connect', {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'gateway-client',
          displayName: 'OpenClaw Desktop',
          version: '0.1.0',
          platform: window.desktopApp?.platform || 'macos',
          mode: 'backend'
        },
        auth: { token: this.token },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        device,
        locale: navigator.language,
        userAgent: navigator.userAgent
      })
      this.connectedOnce = true
      this.debug('connect ok, requesting chat.history')
      this.onStatus?.('connected')
      const payload = await this.request('chat.history', {
        sessionKey: this.sessionKey,
        limit: 100
      })
      this.debug(`history loaded count=${Array.isArray(payload?.messages) ? payload.messages.length : 0}`)
      this.onHistory?.(payload?.messages || [])
    } catch (error) {
      this.debug(`connect chain failed: ${error?.message || String(error)}`)
      this.onStatus?.('error', error?.message || String(error))
    }
  }

  request(method, params, { expectFinal = false } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.debug(`request blocked ${method}: socket not open`)
      return Promise.reject(new Error('Gateway 尚未连接'))
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    this.debug(`request ${method} id=${id}`)
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        this.debug(`request timeout ${method} id=${id}`)
        reject(new Error(`${method} 请求超时`))
      }, method === 'connect' ? 12000 : 10000)
      this.pending.set(id, { resolve, reject, expectFinal, timer })
      this.ws.send(JSON.stringify({
        type: 'req',
        id,
        method,
        params
      }))
    })
  }
}

function LobsterLogo({ className }) {
  return (
    <div className={className} aria-hidden="true">
      <svg viewBox="0 0 64 64" className="lobster-svg">
        <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M24 18c-6-6-13-3-14 3 5 1 10-1 13-6 1 5-1 10-6 13" />
          <path d="M40 18c6-6 13-3 14 3-5 1-10-1-13-6-1 5 1 10 6 13" />
          <path d="M32 19c-5 0-9 4-9 9 0 3 1 5 3 7-4 2-7 6-7 10 0 6 6 11 13 11s13-5 13-11c0-4-3-8-7-10 2-2 3-4 3-7 0-5-4-9-9-9Z" />
          <path d="M26 38c2 2 4 3 6 3s4-1 6-3" />
          <path d="M28 12l-3-5" />
          <path d="M36 12l3-5" />
          <path d="M20 39l-7 4" />
          <path d="M21 45l-8 2" />
          <path d="M44 39l7 4" />
          <path d="M43 45l8 2" />
          <path d="M29 56l-3 5" />
          <path d="M35 56l3 5" />
          <circle cx="28" cy="27" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="36" cy="27" r="1.5" fill="currentColor" stroke="none" />
        </g>
      </svg>
    </div>
  )
}

function App() {
  const api = resolveApi()
  const [status, setStatus] = useState(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, stage: '' })
  const [logs, setLogs] = useState([])
  const [mode, setMode] = useState('launcher')
  const [chatUrl, setChatUrl] = useState('')
  const [chatTitle, setChatTitle] = useState('OpenClaw')
  const [chatState, setChatState] = useState('idle')
  const [chatError, setChatError] = useState('')
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const [appUpdate, setAppUpdate] = useState({
    supported: true,
    enabled: false,
    status: 'idle',
    message: '更新模块未初始化',
    currentVersion: '',
    availableVersion: '',
    downloadedVersion: '',
    percent: 0,
    channel: 'latest',
    feedUrl: ''
  })
  const [chatDebugLogs, setChatDebugLogs] = useState([])
  const [gatewayLogTail, setGatewayLogTail] = useState('')
  const gatewayClientRef = useRef(null)
  const draftRunMapRef = useRef(new Map())
  const activeSessionKeyRef = useRef('')
  const chatMessagesRef = useRef(null)
  const [checkedOnce, setCheckedOnce] = useState(false)

  function scrollMessagesToBottom() {
    const container = chatMessagesRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }

  async function refreshGatewayLogTail() {
    if (!api?.getGatewayLogTail) return
    try {
      const result = await api.getGatewayLogTail()
      setGatewayLogTail(result?.log || '')
    } catch (error) {
      setGatewayLogTail(`读取失败：${error?.message || String(error)}`)
    }
  }

  async function refreshStatus() {
    const nextStatus = await api?.getLauncherStatus?.()
    setStatus(nextStatus)
    setToken((prev) => prev || nextStatus?.tokenValue || '')
    return nextStatus
  }

  async function checkEnvironment({ silent = false } = {}) {
    if (!api) return null
    setBusy(true)
    if (!silent) {
      setLogs([])
    }
    setProgress({ percent: 0, stage: '正在检查环境…' })
    try {
      const nextStatus = await refreshStatus()
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

  useEffect(() => {
    if (!api?.onInstallProgress) return undefined
    const off = api.onInstallProgress((payload) => {
      setProgress({
        percent: payload?.percent ?? 0,
        stage: payload?.stage ?? ''
      })
      if (payload?.log) {
        setLogs((prev) => [...prev, payload.log])
      }
    })
    return off
  }, [api])

  useEffect(() => {
    if (!api?.getLauncherStatus) return
    checkEnvironment({ silent: true }).catch(() => {})
  }, [api])

  useEffect(() => {
    if (!api?.getAppUpdateState) return undefined

    let active = true
    api.getAppUpdateState()
      .then((state) => {
        if (active && state) {
          setAppUpdate((prev) => ({ ...prev, ...state }))
        }
      })
      .catch(() => {})

    const off = typeof api.onAppUpdateState === 'function'
      ? api.onAppUpdateState((state) => {
          if (state) {
            setAppUpdate((prev) => ({ ...prev, ...state }))
          }
        })
      : undefined

    return () => {
      active = false
      off?.()
    }
  }, [api])

  useEffect(() => {
    if (mode !== 'chat' || !chatUrl || !sessionKey || !token.trim()) return undefined

    activeSessionKeyRef.current = sessionKey
    setMessages([])
    setChatDebugLogs([
      `[${new Date().toLocaleTimeString()}] 初始化聊天连接`,
      `[${new Date().toLocaleTimeString()}] ws=${chatUrl}`,
      `[${new Date().toLocaleTimeString()}] session=${sessionKey}`
    ])
    setGatewayLogTail('')

    const client = new GatewaySocketClient({
      url: chatUrl,
      token: token.trim(),
      sessionKey,
      onDebug: (line) => {
        setChatDebugLogs((prev) => [...prev.slice(-119), line])
      },
      onStatus: (state, message) => {
        setChatState(state)
        setChatError(message || '')
        if (state === 'error' || state === 'closed') {
          refreshGatewayLogTail().catch(() => {})
        }
      },
      onHistory: (historyMessages) => {
        const nextMessages = historyMessages
          .map((message, index) => ({
            id: `history-${index}`,
            role: message?.role === 'assistant' ? 'assistant' : 'user',
            text: extractMessageText(message),
            error: ''
          }))
          .filter((message) => message.text)
        setMessages(nextMessages)
      },
      onChatEvent: (payload) => {
        if (!payload) return

        const payloadSessionKey = String(payload.sessionKey || '').trim()
        const activeSessionKey = activeSessionKeyRef.current
        if (payloadSessionKey && !sessionKeyMatches(activeSessionKey, payloadSessionKey)) {
          setChatDebugLogs((prev) => [...prev.slice(-119), `[${new Date().toLocaleTimeString()}] ignore chat event session=${payloadSessionKey}`])
          return
        }

        if (payloadSessionKey && payloadSessionKey !== activeSessionKey) {
          activeSessionKeyRef.current = payloadSessionKey
          setSessionKey(payloadSessionKey)
        }

        if (payload.state === 'error') {
          const pendingId = draftRunMapRef.current.get(payload.runId)
          if (pendingId) {
            setMessages((prev) => prev.map((msg) => msg.id === pendingId ? { ...msg, error: payload.errorMessage || '发送失败' } : msg))
            draftRunMapRef.current.delete(payload.runId)
          }
          return
        }

        if (payload.state === 'delta') {
          const assistantText = extractMessageText(payload.message)
          if (!assistantText) return
          setMessages((prev) => {
            const nextId = `assistant-${payload.runId}`
            const exists = prev.find((message) => message.id === nextId)
            if (exists) {
              return prev.map((message) => message.id === nextId ? {
                ...message,
                text: assistantText,
                error: ''
              } : message)
            }

            return [...prev, {
              id: nextId,
              role: 'assistant',
              text: assistantText,
              error: ''
            }]
          })
          return
        }

        if (payload.state === 'final') {
          const assistantText = extractMessageText(payload.message)
          if (!assistantText) return
          setMessages((prev) => {
            const nextId = `assistant-${payload.runId}`
            const exists = prev.find((message) => message.id === nextId)
            if (exists) {
              return prev.map((message) => message.id === nextId ? {
                ...message,
                text: assistantText,
                error: ''
              } : message)
            }

            return [...prev, {
              id: nextId,
              role: 'assistant',
              text: assistantText,
              error: ''
            }]
          })
          draftRunMapRef.current.delete(payload.runId)
        }
      }
    })

    gatewayClientRef.current = client
    client.connect()

    return () => {
      client.dispose()
      gatewayClientRef.current = null
    }
  }, [mode, chatUrl, sessionKey, token])

  useEffect(() => {
    if (mode !== 'chat') return

    const timer = window.setTimeout(() => {
      scrollMessagesToBottom()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [mode, messages])

  async function handleStartChat() {
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

  async function handleCheckAppUpdate() {
    if (typeof api?.checkAppUpdate !== 'function') return

    try {
      await api.checkAppUpdate()
    } catch (error) {
      setLogs((prev) => [...prev, `更新检查失败：${error?.message || String(error)}`])
    }
  }

  async function handleInstallUpdate() {
    if (typeof api?.quitAndInstallUpdate !== 'function') return

    try {
      await api.quitAndInstallUpdate()
    } catch (error) {
      setLogs((prev) => [...prev, `更新安装失败：${error?.message || String(error)}`])
    }
  }

  async function handleSendMessage() {
    const text = draft.trim()
    if (!text || !gatewayClientRef.current || chatState !== 'connected') return

    const tempId = `user-${Date.now()}`
    setMessages((prev) => [...prev, {
      id: tempId,
      role: 'user',
      text,
      error: ''
    }])
    setDraft('')

    try {
      const response = await gatewayClientRef.current.request('chat.send', {
        sessionKey,
        message: text,
        idempotencyKey: `desktop-${Date.now()}`,
        deliver: false
      }, { expectFinal: true })

      if (response?.runId) {
        draftRunMapRef.current.set(response.runId, tempId)
      }
    } catch (error) {
      setMessages((prev) => prev.map((msg) => msg.id === tempId ? {
        ...msg,
        error: error?.message || String(error)
      } : msg))
    }
  }

  const ready = envReady(status)
  const tokenReady = Boolean(token.trim() || status?.tokenConfigured)
  const canEnterChat = ready && tokenReady && !busy
  const primaryButtonText = !checkedOnce
    ? '正在检查环境'
    : ready
      ? '开始使用'
      : '一键安装环境'
  const updateStatusBusy = appUpdate.status === 'checking' || appUpdate.status === 'downloading'

  if (mode === 'chat' && chatUrl) {
    return (
      <div className="app-shell app-shell-chat app-shell-chat-plain">
        <main className="chat-layout">
          <section className="chat-panel">
            <div className="chat-panel-status">
              <div className="chat-status-main">
                <span className={chatState === 'connected' ? 'dot' : 'dot loading'} />
                <span>{chatState === 'connected' ? '已连接' : '连接中…'}</span>
                {chatError ? <span className="chat-status-error">{chatError}</span> : null}
              </div>
              <button type="button" className="ghost-btn chat-log-trigger" onClick={() => setShowLogs(true)}>
                查看日志
              </button>
            </div>
            <div className="chat-content">
              <div ref={chatMessagesRef} className="chat-messages">
                {messages.length === 0 ? (
                  <div className="empty-state">还没有消息，先发一句试试。</div>
                ) : messages.map((message) => (
                  <div key={message.id} className={`chat-bubble ${message.role}`}>
                    <div className="chat-role">{message.role === 'assistant' ? 'OpenClaw' : '我'}</div>
                    <div className="chat-text">{message.text}</div>
                    {message.error ? <div className="chat-error">{message.error}</div> : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="chat-composer">
              <textarea
                className="chat-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    handleSendMessage().catch(() => {})
                  }
                }}
                placeholder="输入消息，Cmd/Ctrl + Enter 发送"
              />
              <button
                type="button"
                className="primary-btn chat-send"
                disabled={!draft.trim() || chatState !== 'connected'}
                onClick={() => handleSendMessage().catch(() => {})}
              >
                发送
              </button>
            </div>
          </section>

          {showLogs ? (
            <div className="chat-log-modal-backdrop" onClick={() => setShowLogs(false)}>
              <section className="chat-log-modal" onClick={(event) => event.stopPropagation()}>
                <div className="chat-log-modal-head">
                  <div className="chat-log-modal-title">连接状态与日志</div>
                  <div className="chat-log-modal-actions">
                    <button type="button" className="ghost-btn" onClick={() => refreshGatewayLogTail()}>
                      刷新 Gateway 日志
                    </button>
                    <button type="button" className="ghost-btn" onClick={() => setShowLogs(false)}>
                      关闭
                    </button>
                  </div>
                </div>

                <div className="chat-log-modal-status">
                  <span className={chatState === 'connected' ? 'dot' : 'dot loading'} />
                  <span>{chatState === 'connected' ? '已连接' : '连接中…'}</span>
                  {chatError ? <span className="chat-status-error">{chatError}</span> : null}
                </div>

                <div className="chat-log-modal-body">
                  <div className="chat-debug">
                    <div className="chat-debug-title">连接日志</div>
                    <pre className="chat-debug-pre">{chatDebugLogs.length ? chatDebugLogs.join('\n') : '等待连接日志…'}</pre>
                  </div>
                  <div className="chat-debug">
                    <div className="chat-debug-title">Gateway 日志</div>
                    <pre className="chat-debug-pre">{gatewayLogTail || '等待 Gateway 日志…'}</pre>
                  </div>
                </div>
              </section>
            </div>
          ) : null}
        </main>
      </div>
    )
  }

  return (
    <div className="launcher-shell">
      <div className="launcher-card">
        <div className="launcher-ambient launcher-ambient-a" aria-hidden="true" />
        <div className="launcher-ambient launcher-ambient-b" aria-hidden="true" />
        <div className="launcher-top-tools">
          <span className="hero-version">v{appUpdate.currentVersion || '0.1.0'}</span>
          <button
            type="button"
            className="ghost-btn hero-tool-btn"
            onClick={handleCheckAppUpdate}
            disabled={!api?.checkAppUpdate || updateStatusBusy}
          >
            {appUpdate.status === 'checking' ? '检查中…' : '检查更新'}
          </button>
          {appUpdate.status === 'downloaded' ? (
            <button type="button" className="primary-btn hero-install-btn" onClick={handleInstallUpdate}>
              重启安装
            </button>
          ) : null}
        </div>
        <div className="hero">
          <LobsterLogo className="hero-mark" />
          <div className="hero-copy">
            <div className="hero-kicker">OpenClaw Desktop</div>
            <h1>OpenClaw</h1>
            <p>把环境检查、Gateway 和主会话入口收成一个桌面工作台。</p>
          </div>
        </div>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>检查环境</h2>
              <p>{ready ? '环境已通过。填好 token 后直接开始使用。' : '进入页面后会自动检查环境；如果本机版本低于最低要求，点击按钮会一键安装环境。'}</p>
            </div>
          </div>

          <div className={`launcher-status-banner ${busy || !checkedOnce ? 'scanning' : ready ? 'ready' : 'warn'}`}>
            <div className="launcher-status-orb" />
            <div className="launcher-status-copy">
              <div className="launcher-status-title">
                {busy || !checkedOnce ? '系统自检中' : ready ? '环境已就绪' : '环境需要处理'}
              </div>
              <div className="launcher-status-text">
                {busy || !checkedOnce
                  ? '正在扫描 Node、pnpm、OpenClaw 和本地配置。'
                  : ready
                    ? '可以直接进入主会话，后续动作会与官方网页使用同一条会话。'
                    : '当前有依赖或配置未达标，继续下一步会自动尝试修复。'}
              </div>
            </div>
          </div>

          {!api ? (
            <div className="notice notice-warn">
              没有拿到 Electron preload 接口。
              不要直接在浏览器打开 `http://127.0.0.1:5173`，请关闭所有 Electron 窗口后重新运行 `npm run dev`。
            </div>
          ) : null}

          {appUpdate.message && appUpdate.status !== 'dev' && appUpdate.status !== 'idle' ? (
            <div className={`hint-line ${updateTone(appUpdate.status) === 'ok' ? 'success' : ''}`}>
              {appUpdate.message}
              {appUpdate.availableVersion ? ` 最新版本 v${appUpdate.availableVersion}` : ''}
            </div>
          ) : null}

          {appUpdate.status === 'downloading' ? (
            <div className="progress-wrap update-progress">
              <div className="progress-top">
                <div className="progress-stage">更新下载中</div>
                <div className="progress-percent">{appUpdate.percent || 0}%</div>
              </div>
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{ width: `${appUpdate.percent || 0}%` }} />
              </div>
            </div>
          ) : null}

          <div className="versions-grid">
            <VersionCard
              title="Node"
              required={`v${status?.requiredNodeVersion || '22.x'}`}
              installed={status?.nodeVersion ? `v${status.nodeVersion}` : '--'}
              ok={Boolean(status?.nodeOk)}
            />
            <VersionCard
              title="pnpm"
              required={status?.requiredPnpmVersion || 'latest'}
              installed={status?.pnpmVersion || '--'}
              ok={Boolean(status?.pnpmAvailable)}
            />
            <VersionCard
              title="OpenClaw"
              required={status?.requiredOpenclawVersion || 'latest'}
              installed={status?.openclawVersion || '--'}
              ok={Boolean(status?.openclawAvailable || status?.gatewayRunning)}
            />
          </div>

          <label className="field">
            <span>OpenClaw Token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="自动读取或手动填写 OpenClaw token"
              disabled={busy}
              autoComplete="off"
              spellCheck="false"
            />
          </label>

          {logs.length ? (
            <div className="log">
              <div className="log-title">运行日志</div>
              <pre className="log-pre">{logs.join('\n')}</pre>
            </div>
          ) : null}

          {!busy && !checkedOnce ? (
            <div className="hint-line">正在自动检查环境。</div>
          ) : null}

          {!busy && status && !ready ? (
            <div className="hint-line">当前环境未达到最低要求，点击下面按钮会一键安装环境。</div>
          ) : null}

          {!busy && ready && !tokenReady ? (
            <div className="hint-line">环境已通过，还差 token。</div>
          ) : null}

          {!busy && canEnterChat ? (
            <div className="hint-line success">环境和 token 都已就绪，可以直接进入对话。</div>
          ) : null}

          <div className="panel-actions">
            <button type="button" className="primary-btn" onClick={handleStartChat} disabled={busy || !api || !checkedOnce}>
              {busy ? '处理中…' : canEnterChat ? '开始使用' : primaryButtonText}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

export default App
