const crypto = require('crypto')
const fs = require('fs/promises')
const fssync = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { spawn } = require('child_process')

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fssync.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function requestHeadOrGet(urlStr, timeoutMs = 1500) {
  const isHttps = urlStr.startsWith('https:')
  const lib = isHttps ? https : http

  return new Promise((resolve) => {
    const req = lib.request(
      urlStr,
      { method: 'GET', timeout: timeoutMs },
      (res) => {
        resolve({ ok: true, statusCode: res.statusCode })
        res.resume()
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, statusCode: null })
    })
    req.on('error', () => resolve({ ok: false, statusCode: null }))
    req.end()
  })
}

async function isCommandAvailable(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

async function getCommandVersion(command, args = ['--version'], options = {}) {
  try {
    const result = await runCommandCapture(command, args, options)
    if (result.code !== 0) return ''
    const raw = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    return raw.split('\n').find(Boolean)?.trim() || ''
  } catch {
    return ''
  }
}

async function resolvePreferredNodeBinDir(requiredVersion = '22.22.1', env = process.env) {
  const baseEnv = { ...env }
  const currentVersion = await getCommandVersion('node', ['-v'], { env: baseEnv })
  if (isVersionAtLeast(currentVersion, requiredVersion)) {
    return ''
  }

  const candidates = []
  const nvmDir = path.join(process.env.HOME || '', '.nvm', 'versions', 'node')
  try {
    const entries = await fs.readdir(nvmDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const match = entry.name.match(/^v(\d+\.\d+\.\d+)$/)
      if (!match) continue
      const binDir = path.join(nvmDir, entry.name, 'bin')
      const nodePath = path.join(binDir, 'node')
      if (!fssync.existsSync(nodePath)) continue
      candidates.push({
        version: match[1],
        binDir
      })
    }
  } catch {
    // ignore missing nvm dir
  }

  const eligible = candidates
    .filter((candidate) => isVersionAtLeast(candidate.version, requiredVersion))
    .sort((a, b) => compareVersions(b.version, a.version))

  return eligible[0]?.binDir || ''
}

function normalizeVersion(raw) {
  if (!raw) return ''
  const match = String(raw).match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : ''
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map((n) => Number(n || 0))
  const pb = normalizeVersion(b).split('.').map((n) => Number(n || 0))
  const len = Math.max(pa.length, pb.length)

  for (let i = 0; i < len; i += 1) {
    const av = pa[i] || 0
    const bv = pb[i] || 0
    if (av > bv) return 1
    if (av < bv) return -1
  }

  return 0
}

function isVersionAtLeast(installed, required) {
  const normalizedInstalled = normalizeVersion(installed)
  const normalizedRequired = normalizeVersion(required)
  if (!normalizedInstalled || !normalizedRequired) return false
  return compareVersions(normalizedInstalled, normalizedRequired) >= 0
}

function runCommandCapture(command, args, { cwd, env, timeoutMs = 0, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    const cut = (s) => (s.length > maxOutputBytes ? s.slice(-maxOutputBytes) : s)
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8')
      stdout = cut(stdout)
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
      stderr = cut(stderr)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function downloadToFile(urlStr, destPath, { timeoutMs = 15000, onProgress } = {}) {
  const isHttps = urlStr.startsWith('https:')
  const lib = isHttps ? https : http
  const tmp = `${destPath}.part`

  await fs.mkdir(path.dirname(destPath), { recursive: true })

  await new Promise((resolve, reject) => {
    const req = lib.get(urlStr, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        reject(new Error(`重定向未处理：HTTP ${res.statusCode} -> ${res.headers.location}`))
        res.resume()
        return
      }

      if (res.statusCode && res.statusCode !== 200) {
        reject(new Error(`下载失败：HTTP ${res.statusCode}`))
        res.resume()
        return
      }

      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      const file = fssync.createWriteStream(tmp)

      res.on('data', (chunk) => {
        received += chunk.length
        if (total > 0) {
          onProgress?.(Math.max(0, Math.min(95, Math.round((received / total) * 95))))
        }
      })

      res.on('error', reject)
      file.on('error', reject)
      file.on('finish', resolve)
      res.pipe(file)
    })

    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')))
  })

  await fs.rename(tmp, destPath)
}

async function ensureNode22({ nodeVersion, nodeInstallDir, event, env }) {
  const baseEnv = env || { ...process.env }
  const preferredNodeBinDir = await resolvePreferredNodeBinDir(nodeVersion || '22.22.1', baseEnv)
  const effectiveEnv = preferredNodeBinDir
    ? { ...baseEnv, PATH: `${preferredNodeBinDir}:${baseEnv.PATH}` }
    : baseEnv
  const systemNodeVersion = await getCommandVersion('node', ['-v'], { env: effectiveEnv })
  if (isVersionAtLeast(systemNodeVersion, nodeVersion || '22.22.1')) {
    return {
      nodeBinDir: preferredNodeBinDir || '',
      nodeUsed: preferredNodeBinDir ? 'nvm' : 'current',
      version: normalizeVersion(systemNodeVersion)
    }
  }

  const metaPath = path.join(nodeInstallDir, 'node-meta.json')
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    if (meta?.binDir && fssync.existsSync(meta.binDir)) {
      return { nodeBinDir: meta.binDir, nodeUsed: 'downloaded', version: normalizeVersion(meta.version) }
    }
  } catch {
    // ignore cached metadata read errors
  }

  const ver = nodeVersion || '22.22.1'
  const tarball = `node-v${ver}-darwin-x64.tar.gz`
  const url = `https://nodejs.org/dist/v${ver}/${tarball}`
  const extractRoot = path.join(nodeInstallDir, `node-v${ver}-darwin-x64`)
  const markerFile = path.join(extractRoot, 'bin', 'node')

  if (!fssync.existsSync(markerFile)) {
    const tmpDir = path.join(nodeInstallDir, 'tmp')
    await fs.mkdir(tmpDir, { recursive: true })
    const tarPath = path.join(tmpDir, tarball)

    event?.sender?.send('install:progress', { stage: '下载 Node.js', percent: 5, log: `下载 ${url}` })
    await downloadToFile(url, tarPath, {
      onProgress: (p) => event?.sender?.send('install:progress', { stage: '下载 Node.js', percent: p || 5 })
    })
    event?.sender?.send('install:progress', { stage: '解压 Node.js', percent: 20, log: '开始解压…' })
    await runCommandCapture('tar', ['-xzf', tarPath, '-C', nodeInstallDir])
  }

  const binDir = path.join(extractRoot, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  await fs.writeFile(metaPath, JSON.stringify({ version: ver, binDir }), 'utf8')
  return { nodeBinDir: binDir, nodeUsed: 'downloaded', version: normalizeVersion(ver) }
}

async function ensurePnpm({ event, env, pnpmVersion = 'latest', cwd, nodeBinDir }) {
  const baseEnv = env || { ...process.env }
  if (nodeBinDir) baseEnv.PATH = `${nodeBinDir}:${baseEnv.PATH}`

  const check = await runCommandCapture('pnpm', ['-v'], { env: baseEnv })
  if (check.code === 0) return { pnpmBinDir: nodeBinDir || '', pnpmAvailable: true }

  const hasCorepack = await runCommandCapture('corepack', ['--version'], { env: baseEnv })
  if (hasCorepack.code === 0) {
    event?.sender?.send('install:progress', { stage: '准备 pnpm', percent: 25, log: '启用 corepack…' })
    await runCommandCapture('corepack', ['enable'], { env: baseEnv })
    await runCommandCapture('corepack', ['prepare', `pnpm@${pnpmVersion}`, '--activate'], { env: baseEnv })
    const after = await runCommandCapture('pnpm', ['-v'], { env: baseEnv })
    if (after.code === 0) return { pnpmBinDir: nodeBinDir || '', pnpmAvailable: true }
  }

  event?.sender?.send('install:progress', { stage: '安装 pnpm', percent: 30, log: 'corepack 不可用，尝试 npm 安装…' })
  const prefixDir = nodeBinDir ? path.join(nodeBinDir, '..') : undefined
  const args = ['install', '-g', `pnpm@${pnpmVersion}`]
  if (prefixDir) {
    args.push('--prefix', prefixDir)
  }
  const result = await runCommandCapture('npm', args, { cwd, env: baseEnv, timeoutMs: 0 })
  if (result.code !== 0) {
    throw new Error(`安装 pnpm 失败：${result.stderr || result.stdout}`)
  }

  return { pnpmBinDir: nodeBinDir || '', pnpmAvailable: true }
}

async function findOpenclawBinary(openclawRoot) {
  const candidates = [
    path.join(openclawRoot, 'node_modules', '.bin', 'openclaw'),
    path.join(openclawRoot, 'node_modules', '.bin', 'openClaw'),
    path.join(openclawRoot, 'node_modules', '.bin', 'openclaw-cli')
  ]

  for (const candidate of candidates) {
    try {
      if (fssync.existsSync(candidate)) return candidate
    } catch {
      // ignore
    }
  }

  return null
}

async function ensureOpenclaw({ event, env, openclawRoot, npmPkg, nodeBinDir }) {
  const baseEnv = env || { ...process.env }
  if (nodeBinDir) baseEnv.PATH = `${nodeBinDir}:${baseEnv.PATH}`

  const openclawBin = await findOpenclawBinary(openclawRoot)
  if (openclawBin) return { openclawBin, installed: false }

  await fs.mkdir(openclawRoot, { recursive: true })
  event?.sender?.send('install:progress', { stage: '安装 openclaw', percent: 50, log: `pnpm add ${npmPkg}@latest` })

  const result = await runCommandCapture('pnpm', ['add', `${npmPkg}@latest`], {
    cwd: openclawRoot,
    env: baseEnv,
    timeoutMs: 0
  })
  if (result.code !== 0) {
    throw new Error(`pnpm 安装 openclaw 失败：${result.stderr || result.stdout}`)
  }

  const installedBin = await findOpenclawBinary(openclawRoot)
  if (!installedBin) {
    throw new Error('openclaw 安装完成但未找到 openclaw 可执行文件。')
  }

  return { openclawBin: installedBin, installed: true }
}

async function findExecutableByName(rootDir, executableName, maxDepth = 3) {
  async function walk(dir, depth) {
    if (depth > maxDepth) return null

    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }

    for (const entry of entries) {
      const candidatePath = path.join(dir, entry.name)
      if (entry.isFile() && entry.name === executableName) {
        return candidatePath
      }
      if (entry.isDirectory()) {
        const found = await walk(candidatePath, depth + 1)
        if (found) return found
      }
    }

    return null
  }

  return walk(rootDir, 0)
}

async function readToken(tokenFile) {
  try {
    const raw = await fs.readFile(tokenFile, 'utf8')
    return raw.trim()
  } catch {
    return ''
  }
}

async function writeToken(tokenFile, token) {
  await fs.mkdir(path.dirname(tokenFile), { recursive: true })
  await fs.writeFile(tokenFile, String(token || '').trim(), 'utf8')
}

async function waitForGateway({ urlBase, timeoutMs = 30000, intervalMs = 1000 }) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await requestHeadOrGet(urlBase, 1500)
    if (result.ok) return { running: true, statusCode: result.statusCode }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return { running: false, statusCode: null }
}

async function startGateway({ openclawExec, token, port, pathPrefix }) {
  const env = { ...process.env }
  if (token) env.OPENCLAW_GATEWAY_TOKEN = token
  if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH}`

  const child = spawn(openclawExec, ['gateway', '--port', String(port)], {
    env,
    detached: true,
    stdio: 'ignore'
  })

  child.unref()
  return true
}

async function startGatewayWithLogs({ openclawExec, token, port, pathPrefix, logFile }) {
  const env = { ...process.env }
  if (token) env.OPENCLAW_GATEWAY_TOKEN = token
  if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH}`

  await fs.mkdir(path.dirname(logFile), { recursive: true })
  const fd = fssync.openSync(logFile, 'a')

  const child = spawn(openclawExec, ['gateway', '--port', String(port)], {
    env,
    detached: true,
    stdio: ['ignore', fd, fd]
  })

  child.unref()
  fssync.closeSync(fd)
  return true
}

async function readLogTail(logFile, maxChars = 2000) {
  try {
    const raw = await fs.readFile(logFile, 'utf8')
    return raw.length > maxChars ? raw.slice(-maxChars) : raw
  } catch {
    return ''
  }
}

async function sanitizeOpenclawConfig(configPath) {
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const config = JSON.parse(raw)
    let changed = false

    const pluginPaths = config?.plugins?.load?.paths
    if (Array.isArray(pluginPaths)) {
      const validPaths = pluginPaths.filter((pluginPath) => {
        const exists = Boolean(pluginPath) && fssync.existsSync(pluginPath)
        if (!exists) changed = true
        return exists
      })
      config.plugins.load.paths = validPaths
    }

    const installs = config?.plugins?.installs
    if (installs && typeof installs === 'object') {
      for (const [key, value] of Object.entries(installs)) {
        const installPath = value?.installPath || value?.sourcePath
        if (installPath && !fssync.existsSync(installPath)) {
          delete installs[key]
          changed = true
        }
      }
    }

    if (changed) {
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    }

    return { changed }
  } catch {
    return { changed: false }
  }
}

module.exports = {
  sha256Hex,
  sha256File,
  requestHeadOrGet,
  isCommandAvailable,
  getCommandVersion,
  normalizeVersion,
  compareVersions,
  isVersionAtLeast,
  runCommandCapture,
  downloadToFile,
  ensureNode22,
  ensurePnpm,
  findOpenclawBinary,
  ensureOpenclaw,
  findExecutableByName,
  resolvePreferredNodeBinDir,
  readToken,
  writeToken,
  waitForGateway,
  startGateway,
  startGatewayWithLogs,
  readLogTail,
  sanitizeOpenclawConfig
}
