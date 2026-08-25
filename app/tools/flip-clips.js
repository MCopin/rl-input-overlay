// Replays flips in real time in the overlay and films the result.
//
// What it's for: the flip timeline is data that lives in time — the cancel can
// bite early, late, halfway, in fits and starts — and a still capture only
// shows its final state. One video per case makes it possible to check what the
// overlay displays *during* the flip, and serves as a reference when we touch
// it.
//
//   npm run clips              every case
//   npm run clips -- front     the ones whose name contains "front"
//
// Output: tools/clips/*.mp4 (scaled ×2, the render is 340 px wide).
// The physics replayed here is the one from docs/flip.md; the overlay knows
// nothing about it, it only receives what the game would send it.

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const { createServer } = require('../src/main/server')

// Local page served over plain HTTP: the warning teaches nothing here and
// drowns out the test's output.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

const PUBLIC = path.join(__dirname, '..', 'public')
// The page is filmed as it is served, not opened as file://: that's how the
// overlay window and the OBS source load it. A different port from the app's,
// so we can film while it is running.
const PORT = 3948
const OUT = path.join(__dirname, 'clips')
const TMP = path.join(OUT, '.frames')
const ZOOM = 2

// **Game** frames per second targeted in the final file.
const TARGET_FPS = 60

// The scene is played in slow motion: we replace the page's clock with one that
// advances SLOW times slower, then encode that much faster. The page can't tell
// the difference — everything in it goes through performance.now(), fades as
// well as measurements — and every captured frame covers half as much game
// time. Offscreen rendering, on the other hand, doesn't work: with no surface,
// requestAnimationFrame doesn't run and we'd film a frozen image.
const SLOW = 2
const W = 340
const H = 600
const BANNER = 46

// Landmarks of the sequence, common to every case: the flip needs a jump before
// it, and the timeline stays readable for a while afterwards.
const JUMP_AT = 0.35
const RELEASE_AT = 0.47
const FLIP_AT = 1.05
const TAIL = 3.4

// dir = dodgeDir in the car frame [forward, right], as the game freezes it.
// cancel = [start, end, stick travel], in seconds since the start of the flip.
// A 4th element makes a ramp: travel slides linearly from the 3rd value to the
// 4th over the window — for a progressive cancel rather than a held one.
const SCENARIOS = [
  {
    name: 'front-no-cancel',
    title: 'Front flip — no cancel',
    note: 'the torque runs to the end: 0.65 s of pitch, 205°',
    dir: [1, 0], speed: 0, cancel: [],
  },
  {
    name: 'front-cancel-early',
    title: 'Front flip — cancel at 120 ms, stick fully deflected',
    note: 'human reaction floor; the torque is cut dead',
    dir: [1, 0], speed: 0, cancel: [[0.12, 9, 1]],
  },
  {
    name: 'front-cancel-late',
    title: 'Front flip — cancel at 350 ms',
    note: 'more than half the torque has already gone through',
    dir: [1, 0], speed: 0, cancel: [[0.35, 9, 1]],
  },
  {
    name: 'front-cancel-half',
    title: 'Front flip — cancel held halfway',
    note: 'pitchScale = 1 - |pitch|: only half the torque',
    dir: [1, 0], speed: 0, cancel: [[0.12, 9, 0.5]],
  },
  {
    name: 'front-cancel-released',
    title: 'Front flip — cancel released at 300 ms',
    note: 'the torque comes back: the cancel is re-evaluated every tick',
    dir: [1, 0], speed: 0, cancel: [[0.12, 0.3, 1]],
  },
  {
    name: 'front-cancel-ramp',
    title: 'Front flip — stick pulled down slowly',
    note: 'opposition rises from 0 to 1 over the torque: the whole gradient scrolls by',
    dir: [1, 0], speed: 0, cancel: [[0.05, 0.65, 0, 1]],
  },
  {
    name: 'diagonal-speedflip',
    title: '45° diagonal — cancel at 100 ms (speed flip)',
    note: 'only the pitch share is cut, the roll happens no matter what',
    dir: [0.7071, 0.7071], speed: 1900, cancel: [[0.10, 9, 1]],
  },
  {
    name: 'side-flip',
    title: 'Side flip — cancel attempted, no effect',
    note: 'pure roll: there is no pitch to cancel',
    dir: [0, 1], speed: 1900, cancel: [[0.12, 9, 1]],
  },
  {
    name: 'backflip',
    title: 'Backflip at speed — braking',
    note: 'backward impulse ×2.5: the speed gain is a braking',
    dir: [-1, 0], speed: 1900, cancel: [],
  },
  {
    name: 'double-jump-neutral',
    title: 'Neutral double jump — no flip',
    note: 'under the threshold: no torque, hence no timeline',
    dir: [0, 0], speed: 0, cancel: [],
  },
  {
    // stall = the dodge fires (and is consumed) but its direction is null: the
    // held air roll cancels the stick's component. stick = what the hand does
    // during that time, in screen coordinates.
    name: 'stall',
    title: 'Stall — ARL + stick right, dodge with a null direction',
    note: 'the components cancel out: dodge consumed, no rotation',
    dir: [0, 0], speed: 1400, stall: true, stick: [1, 0], cancel: [],
  },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Code injected into the page: replays a scenario in real time, at 120 Hz like
// the game would, using only the normal way in (handleState).
function player(spec, marks) {
  return new Promise((resolve, reject) => {
    const { JUMP_AT, RELEASE_AT, FLIP_AT, END, TORQUE, SLOW } = marks

    flipCtl.current = null
    flipCtl.last = null
    dodgeCtl.active = false
    markers.length = 0
    trail.length = 0
    jumpCtl.prev = 0
    jumpCtl.flipArmed = false
    jumpCtl.firstPressAt = 0
    jumpCtl.holding = false
    jumpCtl.holdShownUntil = 0

    // The flip's impulse, applied once: without it the speed gauge would stay
    // frozen while the overlay announces a gain.
    const impulse = () => {
      const ratio = Math.min(1, Math.abs(spec.speed) / 2300)
      const dx = Math.abs(spec.dir[0]) < 0.1 ? 0 : spec.dir[0]
      const dy = Math.abs(spec.dir[1]) < 0.1 ? 0 : spec.dir[1]
      const back = Math.abs(spec.speed) < 100 ? dx < 0 : (dx >= 0) !== (spec.speed >= 0)
      let vx = dx * 500 * (((back ? 2.5 : 1) - 1) * ratio + 1)
      const vy = dy * 500 * ((1.9 - 1) * ratio + 1)
      if (back) vx *= 16 / 15
      return [vx, vy]
    }

    const flipped = spec.dir[0] !== 0 || spec.dir[1] !== 0
    // Absent when the scene isn't being filmed (readme-shot borrows this player).
    const banner = document.getElementById('clipState')
    let boost = [0, 0]
    let boosted = false
    // The timeline erases itself once past its display delay: the measurement
    // has to be taken while it's alive, not at the end of the clip.
    let reading = null
    const t0 = performance.now()

    // An exception inside a timer tick would surface nowhere: the clip would be
    // filmed to the end on a dead scene.
    const timer = setInterval(() => {
      try {
        tick()
      } catch (e) {
        clearInterval(timer)
        reject(new Error('during playback: ' + (e && e.message ? e.message : e)))
      }
    }, 8 * SLOW) // 8 ms of game time: the clock step is real, the target rate isn't

    function tick() {
      const t = (performance.now() - t0) / 1000
      if (t >= END) {
        clearInterval(timer)
        resolve(reading)
        return
      }

      const dodging = flipped || spec.stall
      const dodgeT = dodging && t >= FLIP_AT && t < FLIP_AT + TORQUE ? t - FLIP_AT : 0

      // The stick aims at the flip's direction just before the press, then the
      // cancel takes over the pitch.
      let sx = 0
      let sy = 0
      if (t >= FLIP_AT - 0.1 && t < FLIP_AT + 0.12) {
        sx = spec.dir[1]
        sy = -spec.dir[0]
        // Stall: the hand does hold the stick deflected, it's the dodge that
        // comes out at zero because the air roll cancels the component.
        if (spec.stick) { sx = spec.stick[0]; sy = spec.stick[1] }
      }
      for (const [from, to, amp, ampEnd] of spec.cancel) {
        if (dodgeT >= from && dodgeT < to) {
          const a = ampEnd == null
            ? amp
            : amp + (ampEnd - amp) * ((dodgeT - from) / (to - from))
          sy = Math.sign(spec.dir[0] || 1) * a
        }
      }

      const inAir = t >= RELEASE_AT + 0.02
      const jump = (t >= JUMP_AT && t < RELEASE_AT) || (t >= FLIP_AT && t < FLIP_AT + 0.06)

      rl = {
        vel: [spec.speed + boost[0], boost[1], 0],
        rot: [0, 0, 0],
        onGround: !inAir,
        hasFlip: t < FLIP_AT,
        dodgeT,
        dodgeDir: [spec.dir[0], spec.dir[1], 0],
        dodgeTorqueTime: TORQUE,
        minDodgeTorqueTime: 0.41,
        maxJumpHold: 0.2,
        maxDodgeTime: 1.25,
        rates: [0, 0, 0],
        boostAmt: 0.5,
      }

      handleState({
        jump: jump ? 1 : 0,
        throttle: 1,
        airRollLeft: spec.stall && t >= FLIP_AT - 0.1 && t < FLIP_AT + TORQUE ? 1 : 0,
        stickRight: sx > 0 ? sx : 0,
        stickLeft: sx < 0 ? -sx : 0,
        stickDown: sy > 0 ? sy : 0,
        stickUp: sy < 0 ? -sy : 0,
      })

      // The caption gives the phase and the flip clock: without a time
      // reference a 4 s video doesn't say where the cancel landed.
      // The impulse only takes effect on the next tick: the overlay must see
      // the speed from *before* the flip to compute its gain, as the game does.
      // Applying it on this tick would skew the speed ratio — a backflip at
      // speed would announce +28 km/h instead of +43.
      if (dodgeT > 0 && !boosted) {
        boosted = true
        boost = impulse()
      }

      if (flipCtl.last && !reading) {
        const f = flipCtl.last
        reading = {
          cxl: f.cancelRatio, lat: f.latencyS, samples: f.samples.length,
          pitch: f.pitchDeg, roll: f.rollDeg, gain: f.speedGain,
        }
      }

      let phase = 'on the ground'
      if (dodgeT > 0) phase = `FLIP · ${Math.round(dodgeT * 1000)} ms`
      else if (reading) phase = 'torque over'
      else if (inAir) phase = 'airborne'
      if (banner) banner.textContent = phase
    }
  })
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true })

  const filter = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const todo = filter.length
    ? SCENARIOS.filter(s => filter.some(f => s.name.includes(f)))
    : SCENARIOS
  if (!todo.length) {
    console.error(`No case matches ${filter.join(', ')}`)
    console.error('Available cases:\n  ' + SCENARIOS.map(s => s.name).join('\n  '))
    app.exit(1)
    return
  }

  // A clearly visible window: a hidden window has its rendering suspended, and
  // we'd film a frozen image.
  const win = new BrowserWindow({
    width: W,
    height: H + BANNER,
    show: true,
    // In front of everything else: Chromium suspends the animation of a window
    // it considers hidden, and we'd film a frozen image.
    alwaysOnTop: true,
    frame: false,
    useContentSize: true,
    x: 40,
    y: 40,
    webPreferences: { backgroundThrottling: false, contextIsolation: false },
  })
  // The page's errors surface nowhere otherwise, and a half-loaded page would
  // produce silently wrong clips.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 3) console.error(`  [page] ${message}  (${path.basename(source || '')}:${line})`)
  })
  createServer(PUBLIC, PORT)
  await win.loadURL(`http://127.0.0.1:${PORT}/overlay.html`)
  await sleep(600)
  const js = c => win.webContents.executeJavaScript(c)

  // Slowed clock, installed once and for all: the whole page follows it,
  // rendering and measurements included, without knowing it is being filmed.
  //
  // The frame counter is the safety net: if Chromium suspends the animation —
  // which it does as soon as it believes the window is hidden — the film would
  // be a frozen image, and nothing in the produced file would say so.
  await js(`
    (() => {
      const real = performance.now.bind(performance)
      const t0 = real()
      performance.now = () => t0 + (real() - t0) / ${SLOW}
      window.__frames = 0
      const bump = () => { window.__frames++; requestAnimationFrame(bump) }
      requestAnimationFrame(bump)
    })()
    true`)

  // Opaque background and a caption banner: the overlay page is transparent,
  // which makes no sense in a video file.
  await js(`
    document.body.classList.add('rl')
    document.body.style.background = '#141419'
    source.dodgeThreshold = 0.5
    applyLayout(0)
    bandHint.style.opacity = 0
    const b = document.createElement('div')
    b.id = 'clipBanner'
    b.style.cssText = 'position:absolute;left:0;right:0;top:${H}px;height:${BANNER}px;'
      + 'background:#0b0b0f;color:#8a8a94;font:600 12px system-ui;'
      + 'display:flex;align-items:center;justify-content:space-between;padding:0 14px;'
      + 'border-top:1px solid #24242c'
    b.innerHTML = '<span id="clipTitle"></span><span id="clipState" style="color:#e8e8e8"></span>'
    document.body.appendChild(b)
    true`)

  const done = []
  for (const s of todo) {
    await js(`clipTitle.textContent = ${JSON.stringify(s.title)}; true`)
    const out = await record(win, js, s)
    done.push(out)
  }

  console.log(`\n${done.length} clip(s) in ${OUT}`)
  fs.rmSync(TMP, { recursive: true, force: true })
  app.exit(0)
}

async function record(win, js, s) {
  const marks = {
    JUMP_AT, RELEASE_AT, FLIP_AT, SLOW,
    TORQUE: 0.65,
    END: FLIP_AT + TAIL,
  }

  // Playback runs while we capture: neither one drives the other's time, we
  // just record the actual rate obtained, for the encoding.
  await js('window.__frames = 0; true')
  const playing = js(`(${String(player)})(${JSON.stringify(s)}, ${JSON.stringify(marks)})`)

  // Raw frames accumulated in a single file, through the frame subscription:
  // Chromium pushes them as it paints them, at the screen's rate. Asking for
  // frames one by one with capturePage() capped out at 22 fps — the cost is in
  // the round trip, not in the encoding — which samples a 0.65 s torque far too
  // coarsely.
  const raw = path.join(TMP, 'frames.raw')
  const stream = fs.createWriteStream(raw)
  let n = 0
  let dim = null
  const started = Date.now()

  // One frame every 1/60 s **of game time**, i.e. SLOW times more real time:
  // enough for the capture to keep up without fighting the page's rendering for
  // the processor.
  const period = (1000 / TARGET_FPS) * SLOW
  let capturing = true
  const capture = (async () => {
    while (capturing) {
      const at = Date.now()
      const img = await win.webContents.capturePage()
      if (!dim) dim = img.getSize()
      if (!stream.write(img.toBitmap())) {
        await new Promise(r => stream.once('drain', r))
      }
      n++
      const left = period - (Date.now() - at)
      if (left > 0) await sleep(left)
    }
  })()

  const reading = await playing
  capturing = false
  await capture
  await new Promise(r => stream.end(r))

  // Without this, a frozen clip would pass for a good one: nothing in the
  // produced file distinguishes a motionless animation from a scene where
  // nothing happens.
  const animated = await js('window.__frames')
  if (animated < 60) {
    throw new Error(
      `${s.name}: rendering stayed frozen (${animated} animated frames). ` +
      'The window must have been hidden during the capture.')
  }
  const expected = s.dir[0] !== 0 || s.dir[1] !== 0 || s.stall
  if (expected && !reading) {
    throw new Error(`${s.name}: no flip was detected by the overlay.`)
  }
  // The game time covered is the real time divided by the slowdown: encoding at
  // that rate restores the game's speed.
  const rate = (n * SLOW) / ((Date.now() - started) / 1000)

  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${s.name}.mp4`)
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pixel_format', 'bgra',
    '-video_size', `${dim.width}x${dim.height}`,
    // The real, measured rate: the video then plays at the game's speed.
    '-framerate', rate.toFixed(3),
    '-i', raw,
    // Nearest-neighbour upscaling: the bar is 10 px wide, smoothing would erase
    // exactly what we're trying to read.
    '-vf', `scale=${W * ZOOM}:${(H + BANNER) * ZOOM}:flags=neighbor`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
    file,
  ])
  fs.unlinkSync(raw)

  const size = (fs.statSync(file).size / 1024).toFixed(0)
  console.log(`  ${s.name.padEnd(22)} ${n} frames · ${rate.toFixed(1)} fps · ${size} KB`)
  if (reading) {
    const lat = reading.lat != null ? `${Math.round(reading.lat * 1000)} ms` : '—'
    console.log(`  ${' '.repeat(22)} cancel ${(reading.cxl * 100).toFixed(0)} % · latency ${lat}`
      + ` · P${Math.round(reading.pitch)}° R${Math.round(reading.roll)}°`
      + ` · +${Math.round(reading.gain)} uu/s · ${reading.samples} samples`)
  }
  console.log(`  ${' '.repeat(22)} ${s.note}`)
  return file
}

// readme-shot.js replays the same scenarios to capture a still: the physics
// lives here only.
module.exports = { player, SCENARIOS, JUMP_AT, RELEASE_AT, FLIP_AT }

if (require.main === module) {
  app.whenReady().then(main).catch(err => {
    console.error(err)
    app.exit(1)
  })
}
