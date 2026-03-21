const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const DEFAULT_ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

function resolveElectronDir() {
  try {
    const electronPackage = require.resolve('electron/package.json')
    return path.dirname(electronPackage)
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      console.error('Electron package is not installed yet.')
      console.error('Please run `npm install` or `pnpm install` in this project first, then run `npm run fix:electron` again.')
      process.exit(1)
    }
    throw error
  }
}

function readPathFile(electronDir) {
  const pathFile = path.join(electronDir, 'path.txt')

  if (!fs.existsSync(pathFile)) {
    return null
  }

  const binaryRelativePath = fs.readFileSync(pathFile, 'utf8').trim()
  const binaryAbsolutePath = path.join(electronDir, 'dist', binaryRelativePath)

  return fs.existsSync(binaryAbsolutePath) ? binaryAbsolutePath : null
}

function installElectronBinary(electronDir) {
  const installer = path.join(electronDir, 'install.js')
  const env = {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || DEFAULT_ELECTRON_MIRROR
  }

  console.log(`Using Electron mirror: ${env.ELECTRON_MIRROR}`)

  const result = spawnSync(process.execPath, [installer], {
    stdio: 'inherit',
    env
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function main() {
  const electronDir = resolveElectronDir()
  const binary = readPathFile(electronDir)

  if (binary) {
    console.log(`Electron binary is ready: ${binary}`)
    return
  }

  console.log('Electron binary is missing. Running electron/install.js...')
  installElectronBinary(electronDir)

  const installedBinary = readPathFile(electronDir)

  if (!installedBinary) {
    console.error('Electron install completed, but the binary is still missing.')
    process.exit(1)
  }

  console.log(`Electron binary installed: ${installedBinary}`)
}

main()
