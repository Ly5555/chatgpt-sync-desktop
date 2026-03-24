import { useEffect, useRef, useState } from 'react'
import styles from './index.module.css'
import { sessionKeyMatches } from './lib/chat-utils'
import { GatewaySocketClient } from './lib/gateway-socket'
import { TitleBar } from './components/TitleBar'
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
  const autoEnterStartedRef = useRef(false)
  const [checkedOnce, setCheckedOnce] = useState(false)
  const ready = envReady(status)
  const tokenReady = Boolean(token.trim() || status?.tokenConfigured)
  const canEnterChat = ready && tokenReady && !busy
  const primaryButtonText = getPrimaryButtonText({ checkedOnce, ready, busy, canEnterChat })
  const titleBarTitle = mode === 'chat' ? (chatTitle || 'OpenClaw') : 'OpenClaw'
  const titleBarVersion = '0.1.3'
  const gatewayEndpoint = status?.gatewayWsUrl || 'ws://127.0.0.1:18789'
  const environmentItems = [
    {
      key: 'node',
      label: 'Node.js 环境',
      ok: Boolean(status?.nodeOk),
      required: `>= v${status?.requiredNodeVersion || '22.x'}`,
      installed: status?.nodeVersion ? `v${status.nodeVersion}` : '--'
    },
    {
      key: 'openclaw',
      label: 'OpenClaw 版本',
      ok: Boolean(status?.openclawAvailable || status?.gatewayRunning),
      required: status?.requiredOpenclawVersion || 'latest',
      installed: status?.openclawVersion || '--'
    },
    {
      key: 'token',
      label: 'API 配置',
      ok: tokenReady,
      required: '已填写 API Key',
      installed: tokenReady ? '已配置' : '--'
    }
  ]
  const titleBarActions = mode === 'chat'
    ? (
        <button type="button" className="ghost-btn chat-log-trigger" onClick={() => setShowLogs(true)}>
          查看日志
        </button>
      )
    : null
  const enteringChat = mode === 'launcher' && busy && ready && tokenReady

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
    if (mode !== 'launcher') return

    if (checkedOnce && ready && tokenReady && !busy) {
      if (autoEnterStartedRef.current) return
      autoEnterStartedRef.current = true
      handleStartChat().catch(() => {
        autoEnterStartedRef.current = false
      })
      return
    }

    autoEnterStartedRef.current = false
  }, [mode, checkedOnce, ready, tokenReady, busy])

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
        {enteringChat ? (
          <div className={styles.launcherLoadingWrap}>
            <div className={styles.launcherLoadingCard}>
              <LobsterLogo className={styles.loadingMark} />
              <div className={styles.loadingTitle}>正在进入对话</div>
              <div className={styles.loadingText}>{progress.stage || '正在连接 OpenClaw，请稍候…'}</div>
              <div className={styles.loadingBar}>
                <div className={styles.loadingBarInner} />
              </div>
            </div>
          </div>
        ) : (
        <div className={styles.launcherContent}>
          <header className={styles.launcherHero}>
            <LobsterLogo className={styles.heroMark} />
            <div className={styles.heroCopyCentered}>
              <h1>OpenClaw 客户端</h1>
              <p>{ready ? '环境检查完成，请完成配置' : '正在检查环境，请稍候配置'}</p>
            </div>
          </header>

          <section className={styles.setupCard}>
            <div className={styles.resultHeader}>
              <div className={styles.resultTitle}>环境检查结果</div>
              <button
                type="button"
                className={styles.inlineRefresh}
                onClick={() => checkEnvironment().catch(() => {})}
                disabled={busy || !api}
              >
                重新检查
              </button>
            </div>

            <div className={styles.resultList}>
              {environmentItems.map((item) => (
                <div key={item.key} className={styles.resultItem}>
                  <span className={cx(styles.resultIcon, item.ok ? styles.resultIconOk : styles.resultIconWarn)}>
                    {item.ok ? '✓' : '!' }
                  </span>
                  <div className={styles.resultContent}>
                    <div className={styles.resultItemLabel}>{item.label}</div>
                    <div className={styles.resultMeta}>
                      <span>最低要求：{item.required}</span>
                      <span>当前：{item.installed}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {!api ? (
              <div className={styles.inlineError}>
                没有拿到 Electron preload 接口，请关闭 Electron 后重新运行 `npm run dev`。
              </div>
            ) : null}
          </section>

          <div className={styles.formStack}>
            <label className={styles.field}>
              <span>API 端点</span>
              <input
                type="text"
                value={gatewayEndpoint}
                readOnly
                disabled
              />
            </label>

            <label className={styles.field}>
              <span>API Key</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="sk-xxxxxxxxxxxxxxxx"
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
              <div className={styles.hintLine}>环境已通过，还差 API Key。</div>
            ) : null}
            {!busy && canEnterChat ? (
              <div className={cx(styles.hintLine, styles.hintLineSuccess)}>环境和 API Key 都已就绪，可以直接进入对话。</div>
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
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

export default App
