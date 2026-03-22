const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron')
const {
  readToken,
  writeToken,
  requestHeadOrGet,
  waitForGateway,
  startGateway,
  startGatewayWithLogs,
  readLogTail,
  sanitizeOpenclawConfig,
  isCommandAvailable,
  getCommandVersion,
  normalizeVersion,
  isVersionAtLeast,
  runCommandCapture,
  findExecutableByName,
  findOpenclawBinary,
  ensureNode22,
  ensurePnpm,
  ensureOpenclaw,
  resolvePreferredNodeBinDir
} = require('./openclaw-launcher')

const OPENCLAW_PORT = 18789
const gatewayUrlBase = `http://127.0.0.1:${OPENCLAW_PORT}/`
const gatewayWsUrl = `ws://127.0.0.1:${OPENCLAW_PORT}`
const DEFAULT_SESSION_KEY = 'agent:main:main'
let mainWindow = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()

function getTokenFile(userDataDir) {
  return path.join(userDataDir, 'openclaw.token')
}

function getNodeInstallDir(userDataDir) {
  return path.join(userDataDir, 'node')
}

function getOpenclawAppRoot(userDataDir) {
  return path.join(userDataDir, 'openclaw-cli')
}

function getOpenclawConfigFile() {
  return path.join(app.getPath('home'), '.openclaw', 'openclaw.json')
}

async function readGatewayTokenFromConfig() {
  try {
    const raw = await require('fs/promises').readFile(getOpenclawConfigFile(), 'utf8')
    const config = JSON.parse(raw)
    return String(config?.gateway?.auth?.token || '').trim()
  } catch {
    return ''
  }
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem)
  const spki = key.export({ type: 'spki', format: 'der' })
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length)
  }
  return spki
}

function fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex')
}

function getDesktopIdentityPath() {
  return path.join(app.getPath('userData'), 'identity', 'gateway-device.json')
}

function loadOrCreateDesktopIdentity() {
  const filePath = getDesktopIdentityPath()

  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed?.deviceId && parsed?.publicKeyPem && parsed?.privateKeyPem) {
        return parsed
      }
    }
  } catch {
    // ignore malformed identity and regenerate
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const identity = {
    version: 1,
    deviceId: fingerprintPublicKey(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  return identity
}

function buildDeviceAuthPayloadV3({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily = '' }) {
  return [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAtMs),
    token || '',
    nonce,
    String(platform || '').trim().toLowerCase(),
    String(deviceFamily || '').trim().toLowerCase()
  ].join('|')
}

function createGatewayDeviceAuth({ nonce, token, role = 'operator', scopes = ['operator.read', 'operator.write'], clientId = 'gateway-client', clientMode = 'backend', platform = process.platform }) {
  const identity = loadOrCreateDesktopIdentity()
  const signedAtMs = Date.now()
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs,
    token,
    nonce,
    platform
  })
  const signature = base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem))
  )

  return {
    id: identity.deviceId,
    publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
    signature,
    signedAt: signedAtMs,
    nonce
  }
}

async function readStoredToken(userDataDir) {
  const tokenFile = getTokenFile(userDataDir)
  const raw = await readToken(tokenFile)
  if (!raw) return ''

  if (raw.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = Buffer.from(raw.slice(4), 'base64')
      return safeStorage.decryptString(encrypted).trim()
    } catch {
      return ''
    }
  }

  return raw
}

async function writeStoredToken(userDataDir, token) {
  const tokenFile = getTokenFile(userDataDir)
  const normalized = String(token || '').trim()

  if (!normalized) {
    await writeToken(tokenFile, '')
    return
  }

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(normalized).toString('base64')
    await writeToken(tokenFile, `enc:${encrypted}`)
    return
  }

  await writeToken(tokenFile, normalized)
}

async function getDownloadedNodeBinDir(userDataDir) {
  const metaPath = path.join(getNodeInstallDir(userDataDir), 'node-meta.json')
  try {
    const raw = await require('fs/promises').readFile(metaPath, 'utf8')
    const meta = JSON.parse(raw)
    return meta?.binDir || ''
  } catch {
    return ''
  }
}

async function getDownloadedNodeMeta(userDataDir) {
  const metaPath = path.join(getNodeInstallDir(userDataDir), 'node-meta.json')
  try {
    const raw = await require('fs/promises').readFile(metaPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function getOpenclawExec(userDataDir) {
  const openclawRoot = getOpenclawAppRoot(userDataDir)
  const localBin = await findOpenclawBinary(openclawRoot)
  if (localBin) return { exec: localBin, source: 'app' }

  const pathCommandExists = await isCommandAvailable('openclaw')
  if (pathCommandExists) return { exec: 'openclaw', source: 'path' }

  const fallback = await findExecutableByName(path.join(userDataDir, 'openclaw'), 'openclaw', 3)
  if (fallback) return { exec: fallback, source: 'bundle' }

  return null
}

async function computeLauncherStatus() {
  const userDataDir = app.getPath('userData')
  const savedToken = await readStoredToken(userDataDir)
  const configToken = await readGatewayTokenFromConfig()
  const token = configToken || savedToken
  const gatewayRes = await requestHeadOrGet(gatewayUrlBase, 1200)
  const openclawExec = await getOpenclawExec(userDataDir)
  const requiredNodeVersion = process.env.OPENCLAW_NODE_VERSION || '22.22.1'
  const requiredPnpmVersion = process.env.OPENCLAW_PNPM_VERSION || '9.0.0'
  const requiredOpenclawVersion = 'latest'
  const downloadedNodeMeta = await getDownloadedNodeMeta(userDataDir)
  const preferredNodeBinDir = await resolvePreferredNodeBinDir(requiredNodeVersion, process.env)
  const nodeEnv = preferredNodeBinDir
    ? { ...process.env, PATH: `${preferredNodeBinDir}:${process.env.PATH}` }
    : process.env
  const systemNodeVersion = normalizeVersion(await getCommandVersion('node', ['-v'], { env: nodeEnv }))
  const effectiveNodeVersion = normalizeVersion(downloadedNodeMeta?.version) || systemNodeVersion
  const nodeMajor = Number(String(effectiveNodeVersion || '0').split('.')[0] || 0)
  const nodeOk = isVersionAtLeast(effectiveNodeVersion, requiredNodeVersion)
  const pnpmVersion = normalizeVersion(await getCommandVersion('pnpm', ['-v'], { env: nodeEnv }))
  const openclawVersion = openclawExec
    ? normalizeVersion(await getCommandVersion(openclawExec.exec, ['--version'], { env: nodeEnv }))
    : ''
  const pnpmOk = Boolean(pnpmVersion) && isVersionAtLeast(pnpmVersion, requiredPnpmVersion)

  return {
    gatewayRunning: Boolean(gatewayRes.ok),
    openclawAvailable: Boolean(openclawExec),
    nodeOk,
    nodeMajor,
    nodeVersion: effectiveNodeVersion,
    systemNodeVersion,
    downloadedNodeVersion: normalizeVersion(downloadedNodeMeta?.version),
    pnpmAvailable: pnpmOk,
    pnpmVersion,
    openclawVersion,
    requiredNodeVersion,
    requiredPnpmVersion,
    requiredOpenclawVersion,
    tokenConfigured: Boolean(token),
    tokenValue: token,
    openclawPort: OPENCLAW_PORT,
    openclawNpmPkg: process.env.OPENCLAW_NPM_PKG || 'openclaw'
  }
}

async function ensureLauncherDeps(event, payload) {
  const userDataDir = app.getPath('userData')
  const nodeInstallDir = getNodeInstallDir(userDataDir)
  const openclawRoot = getOpenclawAppRoot(userDataDir)
  const nodeVersion = payload?.nodeVersion || process.env.OPENCLAW_NODE_VERSION || '22.22.1'
  const pnpmVersion = payload?.pnpmVersion || process.env.OPENCLAW_PNPM_VERSION || 'latest'
  const npmPkg = payload?.npmPkg || process.env.OPENCLAW_NPM_PKG || 'openclaw'

  event.sender.send('install:progress', { stage: '开始环境安装', percent: 0, log: '检查 Node / pnpm / openclaw…' })

  const nodeRes = await ensureNode22({ nodeVersion, nodeInstallDir, event, env: process.env })
  const nodeBinDir = nodeRes.nodeBinDir || ''

  await ensurePnpm({ event, env: process.env, cwd: openclawRoot, pnpmVersion, nodeBinDir })
  await ensureOpenclaw({ event, env: process.env, openclawRoot, npmPkg, nodeBinDir })

  event.sender.send('install:progress', { stage: '环境安装完成', percent: 100, log: '依赖已就绪。' })
  return computeLauncherStatus()
}

async function startChatSession(payload) {
  const userDataDir = app.getPath('userData')
  const gatewayLogFile = path.join(userDataDir, 'openclaw-gateway.log')
  const openclawConfigFile = getOpenclawConfigFile()
  const configToken = await readGatewayTokenFromConfig()
  const savedToken = await readStoredToken(userDataDir)
  const token = payload?.token
    ? String(payload.token).trim()
    : configToken || savedToken

  if (!token) {
    throw new Error('请先填写 OpenClaw gateway token。')
  }

  await writeStoredToken(userDataDir, token)

  const gatewayRes = await requestHeadOrGet(gatewayUrlBase, 1200)
  if (!gatewayRes.ok) {
    const openclawExecInfo = await getOpenclawExec(userDataDir)
    if (!openclawExecInfo) {
      throw new Error('本机未发现 openclaw 可执行文件，请先安装或补环境。')
    }

    const nodeBinDir = await getDownloadedNodeBinDir(userDataDir)
    const preferredNodeBinDir = await resolvePreferredNodeBinDir(process.env.OPENCLAW_NODE_VERSION || '22.22.1', process.env)
    const pathSegments = [nodeBinDir, preferredNodeBinDir, process.env.PATH].filter(Boolean)
    const gatewayEnv = { ...process.env, PATH: pathSegments.join(':') }
    const versionProbe = await getCommandVersion(openclawExecInfo.exec, ['--version'], { env: gatewayEnv })
    if (!normalizeVersion(versionProbe)) {
      throw new Error(`OpenClaw 无法在当前环境下启动。${versionProbe ? ` 输出：${versionProbe}` : ''}`)
    }

    await sanitizeOpenclawConfig(openclawConfigFile)

    const startOnce = async () => {
      await require('fs/promises').writeFile(gatewayLogFile, '', 'utf8')
      await startGatewayWithLogs({
        openclawExec: openclawExecInfo.exec,
        token,
        port: OPENCLAW_PORT,
        pathPrefix: nodeBinDir || '',
        logFile: gatewayLogFile
      })

      const waitResult = await waitForGateway({
        urlBase: gatewayUrlBase,
        timeoutMs: 20000,
        intervalMs: 1000
      })

      if (waitResult.running) {
        return { running: true, tail: '' }
      }

      const tail = await readLogTail(gatewayLogFile)
      return { running: false, tail }
    }

    let startResult = await startOnce()

    if (!startResult.running && /gateway already running|service appears loaded|lock timeout/i.test(startResult.tail)) {
      await runCommandCapture(openclawExecInfo.exec, ['gateway', 'stop'], {
        env: gatewayEnv,
        timeoutMs: 15000
      })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      startResult = await startOnce()
    }

    if (!startResult.running) {
      throw new Error(`OpenClaw gateway 启动超时。${startResult.tail ? ` 日志：\n${startResult.tail}` : ''}`)
    }
  }

  return {
    ok: true,
    wsUrl: gatewayWsUrl,
    sessionKey: DEFAULT_SESSION_KEY
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    title: 'OpenClaw Desktop',
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL

  if (rendererUrl) {
    win.loadURL(rendererUrl)
  } else {
    win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.once('ready-to-show', () => {
    win.show()
    if (win.isMinimized()) {
      win.restore()
    }
    win.focus()
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show()
    }
    app.focus({ steal: true })
  })

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  mainWindow = win
  return win
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.show()
    mainWindow.focus()
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show()
    }
    app.focus({ steal: true })
  })
}

app.whenReady().then(() => {
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
    return { ok: true }
  })
  ipcMain.handle('window:maximizeToggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, maximized: false }
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
    return { ok: true, maximized: win.isMaximized() }
  })
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    return { ok: true }
  })
  ipcMain.handle('window:getState', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return {
      maximized: Boolean(win?.isMaximized()),
      minimized: Boolean(win?.isMinimized?.())
    }
  })
  ipcMain.handle('launcher:getStatus', () => computeLauncherStatus())
  ipcMain.handle('launcher:ensureDeps', (event, payload) => ensureLauncherDeps(event, payload))
  ipcMain.handle('launcher:getGatewayLogTail', async () => {
    const userDataDir = app.getPath('userData')
    const gatewayLogFile = path.join(userDataDir, 'openclaw-gateway.log')
    return {
      log: await readLogTail(gatewayLogFile, 120)
    }
  })
  ipcMain.handle('gateway:createDeviceAuth', (_event, payload) => createGatewayDeviceAuth(payload || {}))
  ipcMain.handle('launcher:setToken', (_event, token) => {
    const userDataDir = app.getPath('userData')
    return writeStoredToken(userDataDir, token).then(() => ({ ok: true }))
  })
  ipcMain.handle('launcher:startChatSession', (_event, payload) => startChatSession(payload))
  ipcMain.handle('appUpdate:getState', () => updateState)
  ipcMain.handle('appUpdate:check', async (_event, payload) => checkForAppUpdates(payload || {}))
  ipcMain.handle('appUpdate:quitAndInstall', async () => {
    const autoUpdater = await ensureAutoUpdaterConfigured()
    if (!autoUpdater || updateState.status !== 'downloaded') {
      throw new Error('更新尚未下载完成。')
    }

    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true)
    })

    return { ok: true }
  })

  createWindow()
  ensureAutoUpdaterConfigured()
    .then((autoUpdater) => {
      if (!autoUpdater) return
      setTimeout(() => {
        checkForAppUpdates({ silent: true }).catch(() => {})
      }, 2500)
    })
    .catch((error) => {
      setUpdateState({
        supported: true,
        enabled: false,
        status: 'error',
        message: `更新初始化失败：${error?.message || String(error)}`
      })
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
