import { useEffect, useRef, useState } from 'react'
import styles from './index.module.css'
import { sessionKeyMatches } from './lib/chat-utils'
import { GatewaySocketClient } from './lib/gateway-socket'
import { TitleBar } from './components/TitleBar'
import { VersionCard } from './components/VersionCard'
import { LobsterLogo } from './components/LobsterLogo'
import { envReady, getPrimaryButtonText, resolveApi } from './lib/launcher'
import { createOptimisticUserMessage, mapHistoryMessages, markMessageError, mergeAssistantMessage } from './lib/chat-state'
import { checkLauncherEnvironment, refreshLauncherStatus, startLauncherChat } from './lib/launcher-service'

function cx(...values) {
  return values.filter(Boolean).join(' ')
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
    return refreshLauncherStatus({
      api,
      setStatus,
      setToken
    })
  }

  async function checkEnvironment({ silent = false } = {}) {
    return checkLauncherEnvironment({
      api,
      silent,
      setBusy,
      setLogs,
      setProgress,
      setStatus,
      setToken,
      setCheckedOnce
    })
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
    if (mode !== 'chat' || !chatUrl || !sessionKey || !token.trim()) return undefined

    // Recreate the gateway client when the chat entry context changes.
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
        setMessages(mapHistoryMessages(historyMessages))
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
          setChatDebugLogs((prev) => [
            ...prev.slice(-119),
            `[${new Date().toLocaleTimeString()}] adopt event session=${payloadSessionKey}`
          ])
        }

        if (payload.state === 'error') {
          const pendingId = draftRunMapRef.current.get(payload.runId)
          if (pendingId) {
            setMessages((prev) => markMessageError(prev, pendingId, payload.errorMessage || '发送失败'))
            draftRunMapRef.current.delete(payload.runId)
          }
          return
        }

        if (payload.state === 'delta') {
          setMessages((prev) => mergeAssistantMessage(prev, payload))
          return
        }

        if (payload.state === 'final') {
          setMessages((prev) => mergeAssistantMessage(prev, payload))
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
    await startLauncherChat({
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
    })
  }

  async function handleSendMessage() {
    const text = draft.trim()
    if (!text || !gatewayClientRef.current || chatState !== 'connected') return

    // Show the outbound user message immediately so the UI does not wait on gateway roundtrips.
    const optimisticMessage = createOptimisticUserMessage(text)
    setMessages((prev) => [...prev, optimisticMessage])
    setDraft('')

    try {
      const response = await gatewayClientRef.current.request('chat.send', {
        sessionKey,
        message: text,
        idempotencyKey: `desktop-${Date.now()}`,
        deliver: true
      }, { expectFinal: true })

      if (response?.runId) {
        draftRunMapRef.current.set(response.runId, optimisticMessage.id)
      }
    } catch (error) {
      setMessages((prev) => markMessageError(prev, optimisticMessage.id, error?.message || String(error)))
    }
  }

  const ready = envReady(status)
  const tokenReady = Boolean(token.trim() || status?.tokenConfigured)
  const canEnterChat = ready && tokenReady && !busy
  const primaryButtonText = getPrimaryButtonText({ checkedOnce, ready, busy, canEnterChat })
  const titleBarTitle = mode === 'chat' ? (chatTitle || 'OpenClaw') : 'OpenClaw'
  const titleBarVersion = '0.1.3'
  const titleBarActions = mode === 'chat'
    ? (
        <button type="button" className="ghost-btn chat-log-trigger" onClick={() => setShowLogs(true)}>
          查看日志
        </button>
      )
    : null

  if (mode === 'chat' && chatUrl) {
    return (
      <div className="app-shell app-shell-chat app-shell-chat-plain">
        <main className="chat-layout">
          <div className="chat-layout-status">
            <div className="chat-status-main">
              <span className={chatState === 'connected' ? 'dot' : 'dot loading'} />
              <span>{chatState === 'connected' ? '已连接' : '连接中…'}</span>
              {chatError && <span className="chat-status-error">{chatError}</span>}
              {/* 查看日志 */}
              {titleBarActions}
            </div>
          </div>
          <section className="chat-panel">
            <div className="chat-content">
              <div ref={chatMessagesRef} className="chat-messages">
                {messages.length === 0 ? (
                  <div className="empty-state">还没有消息，先发一句试试。</div>
                ) : messages.map((message) => (
                  <div key={message.id} className={`chat-bubble ${message.role}`}>
                    {/* <div className="chat-role">{message.role === 'assistant' ? 'OpenClaw' : ''}</div> */}
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
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    handleSendMessage().catch(() => {})
                  }
                }}
                placeholder="输入消息，回车发送，Shift + Enter 换行"
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
    <div className={styles.launcherShell}>
      <div className={styles.launcherCard}>
        <TitleBar
          title={titleBarTitle}
          version={titleBarVersion}
        >
          {titleBarActions}
        </TitleBar>
        <header className={styles.launcherAppbar}>
          <div className={styles.launcherBrand}>
            <LobsterLogo className={styles.heroMark} />
            <div className={styles.heroCopy}>
              <h1>OpenClaw</h1>
            </div>
          </div>
        </header>
        <div className={styles.stack}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <div>
                <h2>环境</h2>
                <p>启动时自动检查最低版本要求。</p>
              </div>
            </div>

            {!api ? (
              <div className="notice notice-warn">
                没有拿到 Electron preload 接口。
                不要直接在浏览器打开 `http://127.0.0.1:5173`，请关闭所有 Electron 窗口后重新运行 `npm run dev`。
              </div>
            ) : null}

            <div className={styles.versionsGrid}>
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
          </section>

          <section className={cx(styles.panel, styles.entryPanel)}>
            <div className={styles.panelHead}>
              <div>
                <h2>进入会话</h2>
                <p>{ready ? '环境已通过，确认 token 后直接进入。' : '环境不足时，点击按钮会先自动补齐依赖。'}</p>
              </div>
            </div>

            <label className={styles.field}>
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

            {!busy && !checkedOnce ? (
              <div className={styles.hintLine}>正在自动检查环境。</div>
            ) : null}

            {!busy && status && !ready ? (
              <div className={styles.hintLine}>当前环境未达到最低要求，点击下面按钮会一键安装环境。</div>
            ) : null}

            {!busy && ready && !tokenReady ? (
              <div className={styles.hintLine}>环境已通过，还差 token。</div>
            ) : null}

            {!busy && canEnterChat ? (
              <div className={cx(styles.hintLine, styles.hintLineSuccess)}>环境和 token 都已就绪，可以直接进入对话。</div>
            ) : null}

            <div className={styles.panelActions}>
              <button type="button" className="primary-btn" onClick={handleStartChat} disabled={busy || !api || !checkedOnce}>
                {primaryButtonText}
              </button>
            </div>

            {logs.length ? (
              <details className={styles.logPanel}>
                <summary>查看运行日志</summary>
                <div className="log">
                  <pre className="log-pre">{logs.join('\n')}</pre>
                </div>
              </details>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}

export default App
