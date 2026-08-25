const { app, BrowserWindow, ipcMain, globalShortcut, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const { createServer } = require('./server')
const { BakkesBridge } = require('./bakkes')

const PORT = 3947
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public')
const OVERLAY_BASE = { width: 340, height: 600 }
// Layouts offered for the overlay. Must track LAYOUTS in overlay.js.
const ROW_ORDER_COUNT = 5

let configWin = null
let overlayWin = null
let editMode = false

// The overlay has a single source: the game, through BakkesMod. Controller
// settings (deadzone, dodge threshold, sensitivities) come from RL and
// therefore have no business here — see docs/sources.md for why the controller
// path was removed.
function defaultConfig() {
  return {
    trailSeconds: 2,
    // The flip figures under the plane (cancel, latency, P/R, gain). They are
    // what you read after the fact, not while you play, so they are worth
    // turning off — the plane and the timeline still say what happened.
    flipNumbers: true,
    // 'kmh' | 'mph' | 'uu'. The game reports uu/s and the overlay converts on
    // the way to the screen only; km/h to match RL's own speedometer.
    speedUnit: 'kmh',
    rowOrder: 0, // permutation of the overlay's three top bands
    overlayBounds: null,
  }
}

const configPath = () => path.join(app.getPath('userData'), 'config.json')

function loadConfig() {
  try {
    return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }
  } catch {
    return defaultConfig()
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}

let config = null
let server = null
let bakkes = null

function createOverlayWindow() {
  const bounds = config.overlayBounds
  overlayWin = new BrowserWindow({
    width: bounds?.width || OVERLAY_BASE.width,
    height: bounds?.height || OVERLAY_BASE.height,
    x: bounds?.x,
    y: bounds?.y,
    transparent: true,
    frame: false,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      backgroundThrottling: false,
    },
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.setIgnoreMouseEvents(true)
  overlayWin.loadURL(`http://127.0.0.1:${PORT}/overlay.html`)

  const persistBounds = () => {
    if (!overlayWin) return
    config.overlayBounds = overlayWin.getBounds()
    saveConfig(config)
  }
  overlayWin.on('moved', persistBounds)
  overlayWin.on('resized', persistBounds)
  overlayWin.on('closed', () => { overlayWin = null })
}

function createConfigWindow() {
  configWin = new BrowserWindow({
    width: 760,
    height: 820,
    title: 'RL Input Overlay — Configuration',
    // Packaged, the window wears the exe's icon; in dev there is no exe
    // carrying one, so without this the taskbar shows Electron's. build/ does
    // not ship in the package, hence the guard rather than a dead path.
    icon: app.isPackaged ? undefined : path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-config.js'),
    },
  })
  configWin.loadFile(path.join(__dirname, '..', 'config', 'config.html'))

  // A link clicked in here must leave for the system browser, never navigate
  // this window: it has no way back — no address bar, no reload — and the
  // configuration would simply be gone. Both routes are covered, and both
  // refuse anything that isn't https, so a page can't be talked into opening
  // a file:// or a custom protocol on the machine.
  const openExternal = url => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url)
  }
  configWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  configWin.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    openExternal(url)
  })

  // Closing this window quits the app, overlay included. It is the only window
  // with a close button: the overlay has no frame, no taskbar entry and lets
  // clicks through, so once this one is gone nothing on screen can reach the
  // app any more — waiting on window-all-closed would leave an overlay nobody
  // can close.
  configWin.on('closed', () => {
    configWin = null
    app.quit()
  })
}

function setEditMode(on) {
  editMode = on
  if (!overlayWin) return
  overlayWin.setIgnoreMouseEvents(!on)
  overlayWin.webContents.send('edit-mode', on)
  if (on) overlayWin.focus()
  configWin?.webContents.send('status', statusPayload())
}

// Display settings sent to every overlay page (window and OBS).
function broadcastDisplay() {
  server.broadcast({
    type: 'display',
    trailSeconds: config.trailSeconds,
    // Explicit rather than falsy-tested on the page: `false` has to survive the
    // trip, and a config written before this setting existed must still mean
    // "shown", which is what the overlay does on its own.
    flipNumbers: config.flipNumbers !== false,
    speedUnit: config.speedUnit || 'kmh',
    rowOrder: config.rowOrder || 0,
  })
}

// Permutes the overlay's three top bands, to try out layouts without touching
// the CSS. The choice is kept in the config.
function cycleRowOrder() {
  config.rowOrder = ((config.rowOrder || 0) + 1) % ROW_ORDER_COUNT
  saveConfig(config)
  broadcastDisplay()
}

// The page fits its fixed 340x600 stage to whatever window it finds itself in,
// so "scaling the overlay" is nothing more than resizing the window — which is
// also why there is no scale in the config: the persisted bounds already carry
// it. OBS is untouched on purpose; there, the source's own size does this job.
function overlayScale() {
  const b = overlayWin?.getBounds() || config.overlayBounds
  if (!b?.width || !b?.height) return 1
  // min: the same fit the page computes, whatever aspect a manual drag left.
  return Math.min(b.width / OVERLAY_BASE.width, b.height / OVERLAY_BASE.height)
}

function setOverlayScale(s) {
  s = Math.min(2, Math.max(0.5, s))
  const width = Math.round(OVERLAY_BASE.width * s)
  const height = Math.round(OVERLAY_BASE.height * s)
  if (overlayWin) {
    const { x, y } = overlayWin.getBounds()
    overlayWin.setBounds({ x, y, width, height })
    config.overlayBounds = overlayWin.getBounds()
  } else {
    config.overlayBounds = { ...config.overlayBounds, width, height }
  }
  saveConfig(config)
}

function toggleOverlay() {
  if (!overlayWin) return createOverlayWindow()
  if (overlayWin.isVisible()) overlayWin.hide()
  else overlayWin.show()
  configWin?.webContents.send('status', statusPayload())
}

function statusPayload() {
  return {
    port: PORT,
    overlayUrl: `http://127.0.0.1:${PORT}/overlay.html`,
    overlayVisible: !!overlayWin?.isVisible(),
    overlayScale: overlayScale(),
    editMode,
    // The bridge to the game: without it the overlay has nothing to show.
    connected: !!bakkes?.connected,
    rlSettings: bakkes?.settings || null,
  }
}

// Whether the bridge to the game is alive. Only the app can say: its own
// WebSocket answers whether or not RL is running, so a page it serves cannot
// tell from the socket alone. A page wired straight to the plugin has no need
// of this — there, the socket being up *is* the answer.
//
// The settings that go with it are relayed as the plugin sent them; the page
// projects the dodge threshold itself, next to the shaping it must stay
// comparable with.
function sourcePayload() {
  return {
    type: 'source',
    connected: !!bakkes?.connected,
  }
}

function setupIpc() {
  ipcMain.handle('get-init', () => ({
    config,
    status: statusPayload(),
  }))

  ipcMain.handle('save-config', (_e, cfg) => {
    config = { ...config, ...cfg }
    saveConfig(config)
    broadcastDisplay()
    return config
  })

  ipcMain.handle('toggle-overlay', () => {
    toggleOverlay()
    return statusPayload()
  })

  ipcMain.handle('set-edit-mode', (_e, on) => {
    setEditMode(on)
    return statusPayload()
  })

  ipcMain.handle('set-overlay-scale', (_e, s) => {
    setOverlayScale(Number(s) || 1)
    return statusPayload()
  })

  ipcMain.handle('get-status', () => statusPayload())
}

app.whenReady().then(() => {
  config = loadConfig()
  server = createServer(PUBLIC_DIR, PORT)

  bakkes = new BakkesBridge()
  // Relayed as they stand. The page reads the plugin's frames whether they come
  // through here or straight off its WebSocket, so there is nothing to
  // translate — and translating would only mean a second reading of the
  // protocol to keep in step with the page's.
  bakkes.on('input', raw => server.broadcast(raw))
  bakkes.on('settings', msg => server.broadcast(msg))
  bakkes.on('status', () => {
    server.broadcast(sourcePayload())
    configWin?.webContents.send('status', statusPayload())
  })
  bakkes.start()
  server.broadcast(sourcePayload())

  setupIpc()
  createConfigWindow()
  createOverlayWindow()

  broadcastDisplay()

  globalShortcut.register('CommandOrControl+Shift+O', toggleOverlay)
  globalShortcut.register('CommandOrControl+Shift+E', () => setEditMode(!editMode))
  globalShortcut.register('CommandOrControl+Shift+L', cycleRowOrder)

  setInterval(() => configWin?.webContents.send('status', statusPayload()), 1000)

  app.on('activate', () => {
    if (!configWin) createConfigWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  bakkes?.stop()
})
