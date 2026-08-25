// Captures the overlay for the README: one speed flip replayed in the real
// page, one PNG taken just after the torque — the moment when the timeline,
// its readings, the stick trail and the speed bar are all on screen at once.
//
//   npm run shot        → docs/overlay.png
//
// The scene comes from flip-clips.js, played at real speed instead of being
// filmed: a still can't carry the timeline's time dimension (that's what the
// clips are for), but it can carry its result.

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const { createServer } = require('../src/main/server')
const { player, SCENARIOS, FLIP_AT } = require('./flip-clips')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

const PUBLIC = path.join(__dirname, '..', 'public')
// Its own port, so the shot can be taken while the app or the clips run.
const PORT = 3949
const OUT = path.join(__dirname, '..', '..', 'docs', 'overlay.png')

// The page scales its stage to the window: twice the base size renders the
// overlay at ×2, sharp — no post-scaling needed.
const W = 340
const H = 600
const ZOOM = 2

// Just after the torque (0.65 s): the timeline is complete, the readings are
// up, and the trail of the cancel is still on the pad.
const SHOT_AT = FLIP_AT + 0.65 + 0.6

const sleep = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  const scenario = SCENARIOS.find(s => s.name === 'diagonal-speedflip')

  // Visible and on top for the same reason as the clips: Chromium suspends the
  // rendering of a window it considers hidden, and we'd shoot a stale paint.
  const win = new BrowserWindow({
    width: W * ZOOM,
    height: H * ZOOM,
    show: true,
    alwaysOnTop: true,
    frame: false,
    useContentSize: true,
    x: 40,
    y: 40,
    webPreferences: { backgroundThrottling: false, contextIsolation: false },
  })
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 3) console.error(`  [page] ${message}  (${path.basename(source || '')}:${line})`)
  })
  createServer(PUBLIC, PORT)
  await win.loadURL(`http://127.0.0.1:${PORT}/overlay.html`)
  await sleep(600)
  const js = c => win.webContents.executeJavaScript(c)

  // Same dressing as the clips — opaque background, no hint banner — plus the
  // frame counter that catches a frozen rendering.
  await js(`
    document.body.classList.add('rl')
    document.body.style.background = '#141419'
    source.dodgeThreshold = 0.5
    applyLayout(0)
    bandHint.style.opacity = 0
    window.__frames = 0
    const bump = () => { window.__frames++; requestAnimationFrame(bump) }
    requestAnimationFrame(bump)
    true`)

  const marks = { FLIP_AT, SLOW: 1, TORQUE: 0.65, END: SHOT_AT + 2,
    JUMP_AT: 0.35, RELEASE_AT: 0.47 }
  js(`(${String(player)})(${JSON.stringify(scenario)}, ${JSON.stringify(marks)})`)
    .catch(e => { console.error(e); app.exit(1) })

  await sleep(SHOT_AT * 1000)

  // A shot of a scene that didn't play would still be a plausible image:
  // nothing in the file distinguishes it from the real one.
  const frames = await js('window.__frames')
  const flipped = await js('flipCtl.last !== null')
  if (frames < 60 || !flipped) {
    console.error(`No live scene to shoot (${frames} animated frames, `
      + `flip ${flipped ? 'seen' : 'not seen'}). Was the window hidden?`)
    app.exit(1)
    return
  }

  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  const s = img.getSize()
  console.log(`${path.relative(process.cwd(), OUT)}  ${s.width}x${s.height}  `
    + `${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`)
  app.exit(0)
}).catch(e => { console.error(e); app.exit(1) })
