// Small wrapper around the OpenClaw gateway protocol so App.jsx can stay focused on UI state.
export class GatewaySocketClient {
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
