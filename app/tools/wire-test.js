// Checks the overlay page's two ways in, which the clips harness cannot: it
// injects straight into the page and never touches a socket.
//
//   relayed — served by the app, fed the plugin's frames relayed verbatim
//   direct  — opened as a file, wired straight to the plugin's WebSocket
//
//   npm run wire
//
// The direct half needs RL running with the plugin loaded; the rest doesn't.
// What it guards is the seam the two modes share: one reading of the protocol,
// one shaping, whichever end the frames came from.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const net = require('net')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

const PUBLIC = path.join(__dirname, '..', 'public')
const { createServer } = require('../src/main/server')
// A different port from the app's, so this can run while it is up.
const PORT = 3949
const PLUGIN_WS = '127.0.0.1:49200'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// "The plugin isn't running" and "the plugin is running and wrong" deserve
// different words: this is a test a human launches, and a bare FAIL for a game
// that isn't open sends them hunting for a bug that isn't there.
function reachable(hostPort) {
  const [host, port] = hostPort.split(':')
  return new Promise(resolve => {
    const sock = net.connect({ host, port: Number(port) })
    const done = ok => { sock.destroy(); resolve(ok) }
    sock.setTimeout(1000)
    sock.on('connect', () => done(true))
    sock.on('timeout', () => done(false))
    sock.on('error', () => done(false))
  })
}

// A plugin frame, field for field as RLOverlayPlugin.cpp emits it.
const SETTINGS = {
  t: 'settings', deadzone: 0.1, dodgeThreshold: 0.55,
  steerSens: 1.7, airSens: 1.7, bindings: [['XboxTypeS_A', 'Jump']],
}
const INPUT = {
  t: 'input', throttle: 1, steer: 0.8, pitch: -0.3, yaw: 0, roll: 0,
  dodgeF: 0, dodgeS: 0, handbrake: 1, jump: 1, boost: 0, holdBoost: 1, jumped: 1,
  onGround: 0, hasFlip: 1, boostAmt: 0.47,
  dodgeT: 0.12, dodgeDir: [1, 0, 0], dodgeTorqueTime: 0.65, minDodgeTorqueTime: 0.41,
  maxJumpHold: 0.2, maxDodgeTime: 1.25,
  vel: [1500, 0, 200], rot: [0, 0, 0], angVel: [0, 0, 0], rates: [3.2, 0, 0],
}

const fails = []
function check(name, got, want) {
  const ok = typeof got === 'number' && typeof want === 'number'
    ? Math.abs(got - want) < 1e-9
    : JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
  if (!ok) fails.push(name)
}

async function main() {
  const server = createServer(PUBLIC, PORT)
  const win = new BrowserWindow({
    width: 340, height: 600, show: true, alwaysOnTop: true, frame: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: false },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.error(`  [page] ${message}`)
  })
  const js = c => win.webContents.executeJavaScript(c)

  // ---- relayed: served over HTTP, the app forwards the plugin's frames ----
  console.log('\nrelayed (served by the app)')
  await win.loadURL(`http://127.0.0.1:${PORT}/overlay.html`)
  await sleep(500)

  server.broadcast(SETTINGS)
  server.broadcast({ type: 'source', connected: true })
  server.broadcast(INPUT)
  await sleep(300)

  // The shaping the page now does for itself: steer 0.8 with deadzone 0.1 and
  // air sensitivity 1.7 saturates at 1.
  check('stickRight', await js('state.stickRight'), 1)
  // pitch -0.3 -> (0.3-0.1)/0.9*1.7 = 0.378, nose down -> up the screen
  check('stickUp', await js('state.stickUp'), 0.378)
  check('throttle', await js('state.throttle'), 1)
  check('boost (holdBoost)', await js('state.boost'), 1)
  // handbrake in the air is a free air roll, and must not light ARL/ARR
  check('airRoll', await js('state.airRoll'), 1)
  check('slide', await js('state.slide'), 0)
  // The frame itself is now the game data, no split on the way
  check('rl.dodgeT', await js('rl.dodgeT'), 0.12)
  check('rl.dodgeDir', await js('JSON.stringify(rl.dodgeDir)'), '[1,0,0]')
  check('rl.vel', await js('JSON.stringify(rl.vel)'), '[1500,0,200]')
  // Projected into the same space as what is drawn: (0.55-0.1)/0.9*1.7
  check('dodgeThreshold', await js('source.dodgeThreshold'), 0.85)
  check('badge', await js("document.getElementById('srcBadge').textContent"), 'RL')

  // Replayed to a page that opens late: without it, nothing to draw.
  console.log('\nsticky replay (page opened after the fact)')
  const late = new BrowserWindow({ width: 340, height: 600, show: true, alwaysOnTop: true, frame: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: false } })
  await late.loadURL(`http://127.0.0.1:${PORT}/overlay.html`)
  await sleep(600)
  const lateJs = c => late.webContents.executeJavaScript(c)
  check('late stickRight', await lateJs('state.stickRight'), 1)
  check('late dodgeThreshold', await lateJs('source.dodgeThreshold'), 0.85)
  late.close()

  // ---- direct: no app in the loop, straight to the plugin ----
  console.log('\ndirect (straight to the plugin, no relay)')
  let skipped = false
  if (!(await reachable(PLUGIN_WS))) {
    skipped = true
    console.log(`  skipped — nothing listening on ${PLUGIN_WS}.`)
    console.log('  Start Rocket League with BakkesMod and the plugin loaded, or check')
    console.log('  rloverlay_ws_port in the BakkesMod console (F6) if you moved it.')
  } else {
    await win.loadURL(`file://${PUBLIC.replace(/\\/g, '/')}/overlay.html?ws=${PLUGIN_WS}`)
    await sleep(1200)
    check('settings arrived', await js('settings ? settings.t : null'), 'settings')
    check('badge from the socket alone', await js("document.getElementById('srcBadge').textContent"), 'RL')
    console.log(`  (deadzone read from the game: ${await js('settings ? settings.deadzone : null')})`)
  }

  if (fails.length) console.log(`\n${fails.length} FAILED: ${fails.join(', ')}`)
  else console.log(skipped ? '\nall checks passed (direct route not covered)' : '\nall checks passed')
  app.exit(fails.length ? 1 : 0)
}

app.whenReady().then(main).catch(e => { console.error(e); app.exit(1) })
