// Overlay client: receives action state over WebSocket, renders:
// - the instantaneous state (pills, buttons, stick, throttle/brake gauge)
// - the stick trail over time (grid)
// - flip markers (angle, neutral) — the requested input, nothing else
// - the flip timeline (torque, cancel over time), beside the plane
// - first jump size (hold duration)

const BASE_W = 340
const BASE_H = 600

// Fallback values, used only when RL isn't the source. They aren't guesses:
// these are the ones read from the game through BakkesMod (MaxTimeForDodge,
// DodgeInputThreshold, JumpForceTime, DodgeTorqueTime).
const FLIP_WINDOW_MS = 1250   // second jump window, counted from the END of the first
const JUMP_MIN_MS = 25        // JUMP_MIN_TIME: floor duration of the jump thrust
const GROUND_RESET_MS = 150   // delay before forgetting a jump once back on the ground
const GROUND_GRACE_MS = 60    // "still on the ground" grace at press time, tick offset
const DODGE_DEADZONE = 0.55   // min stick deflection for a directional flip
const HOLD_MAX_MS = 200       // first jump hold that modulates height

// ---------- Flip physics ----------
// Taken from the RocketSim code, which replays RL's physics tick by tick.
// Everything is detailed in docs/flip.md; the essentials come down to three
// points: the torque crosses the stick's components (lateral -> roll,
// forward/backward -> pitch), it saturates the game's rotation ceiling in
// 25 ms, and only pitch can be cancelled.
const FLIP_TORQUE_S = 0.65    // FLIP_TORQUE_TIME: torque duration
const FLIP_ROLL_ACCEL = 260   // FLIP_TORQUE_X: roll acceleration (lateral share)
const FLIP_PITCH_ACCEL = 224  // FLIP_TORQUE_Y: pitch acceleration (forward/backward share)
const MAX_ANG_SPEED = 5.5     // CAR_MAX_ANG_SPEED: ceiling that every flip saturates
const FLIP_IMPULSE = 500      // FLIP_INITIAL_VEL_SCALE: base impulse, in uu/s
const FLIP_SIDE_SCALE = 1.9   // lateral multiplier at max speed
const FLIP_BACK_SCALE = 2.5   // backward multiplier at max speed
const FLIP_BACK_EXTRA = 16 / 15 // extra backward bonus
const FLIP_IMPULSE_EPS = 0.1  // below this threshold a component stops pushing (impulse only)
const CANCEL_MIN_INPUT = 0.15 // stick travel from which we date the cancel

// Persistence, shared by the marker on the plane and by the timeline: both
// carry the same flip, so they must be born and die together. The count starts
// from the **end** of the torque, not from the trigger — the marker therefore
// stays full while the flip plays out, then the two fade in one gesture, fast
// enough not to linger over the next action.
const FLIP_SHOW_MS = 900      // persistence after the end of the flip
const FLIP_FADE_MS = 300      // final fade, included in FLIP_SHOW_MS

let state = {}
let rl = null       // game data; null as long as the BakkesMod bridge is silent
let trailSeconds = 2
let flipNumbers = true  // the figures under the plane; only the app can turn them off
const trail = []    // {x, y, t}
const markers = []  // {x, y, t, neutral, angle} — the flip's input, nothing more

// Settings coming from the game. The threshold keeps a fallback: it's used to
// draw the diamond, and a page opened before the bridge speaks must hold up.
const source = { dodgeThreshold: DODGE_DEADZONE }

// Tracking of the current dodge. `current` is the flip playing out, `last` the
// one still displayed long enough to be read.
const dodgeCtl = { active: false }
const flipCtl = { current: null, last: null }

// Last instant the game told us "on the ground", to judge where a jump starts from.
const groundCtl = { lastOnGroundAt: 0 }

// Same grace for flip availability: the game consumes it on the very tick of
// the press, so state can reach us with jump=1 and hasFlip already down.
const flipAvail = { lastAt: 0 }

const jumpCtl = {
  prev: 0,
  lastPressAt: 0,
  flipArmed: false, // first jump done, awaiting a possible second
  firstPressAt: 0,
  holding: false,
  holdMs: 0,
  holdShownUntil: 0,
}

// ---------- WebSocket ----------
// Two ways in, and the page has to hold up through either.
//
// Served over HTTP, it is the Electron app talking: it relays the plugin's
// frames unchanged and adds what only it knows — the chosen layout, the trail
// duration. Opened as a file — an OBS source with no app running — there is
// nobody to relay, so the page goes to the plugin's own server and does without
// the display settings. `?ws=host:port` forces the endpoint either way.
//
// The frames are the same in both cases, which is the whole point: one parsing
// path, one shaping, no second implementation to keep in step.
const PLUGIN_WS = '127.0.0.1:49200'   // must track rloverlay_ws_port in the plugin

// Controller settings, straight from the game. Null until they arrive.
let settings = null

// Being served over HTTP is not enough to conclude the app is there: OBS does
// not open a local file as file://, it serves it under a made-up host of its
// own, `http://absolute/C:/…`. A page there would ask ws://absolute, fail, and
// never fall back — which is exactly what happened. So the app is recognised by
// its host being loopback, and everything else goes to the plugin.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

function endpoint() {
  const forced = new URLSearchParams(location.search).get('ws')
  if (forced) return `ws://${forced}`
  if (/^https?:$/.test(location.protocol) && LOOPBACK.test(location.host)) {
    return `ws://${location.host}`
  }
  return `ws://${PLUGIN_WS}`
}

// The badge doesn't say which source is talking — there's only one — but
// whether the game is there. When off, everything shown is stale.
function setConnected(on) {
  document.body.classList.toggle('rl', !!on)
  el('srcBadge').textContent = on ? 'RL' : '—'
}

function applySettings(msg) {
  settings = msg
  const shown = dodgeThresholdShown(msg)
  source.dodgeThreshold = shown != null ? shown : DODGE_DEADZONE
}

function applyInput(m) {
  // The frame *is* the game data: dodgeT, dodgeDir, rates, vel, rot are already
  // in it under those names. Splitting it into an "actions" half and an "RL"
  // half on the way here was work for nothing.
  rl = m
  handleState(toActions(m, settings))
}

function connect() {
  const url = endpoint()
  const relayed = url === `ws://${location.host}`
  let ws
  try {
    ws = new WebSocket(url)
  } catch {
    // No endpoint to be had. We give up the connection, but not the page —
    // without this guard the exception aborts the script and nothing renders.
    return
  }

  // Straight to the plugin, the socket *is* the bridge: it is up exactly when
  // the game is. Through the app it says nothing, since the app answers whether
  // or not RL is running — hence the 'source' message in that case.
  if (!relayed) ws.onopen = () => setConnected(true)

  ws.onmessage = e => {
    const msg = JSON.parse(e.data)
    if (msg.t === 'input') applyInput(msg)
    else if (msg.t === 'settings') applySettings(msg)
    else if (msg.type === 'display') {
      trailSeconds = msg.trailSeconds || 2
      // Only the app knows this one, so a page talking straight to the plugin
      // never hears about it: `!== false` keeps the numbers on there, which is
      // the behaviour that page has always had.
      flipNumbers = msg.flipNumbers !== false
      setSpeedUnit(msg.speedUnit)
      applyLayout(msg.rowOrder || 0)
    } else if (msg.type === 'source') setConnected(msg.connected)
  }
  ws.onclose = () => {
    setConnected(false)
    setTimeout(connect, 1000)
  }
  ws.onerror = () => ws.close()
}
connect()

// ---------- Layouts ----------
// Can be tried in game (⌘⇧L) without touching the CSS.
//
// The first one, the default, is a structure of its own described in
// overlay.css: a single checkerboard grid, gauge standing vertically.
//
// The others only reorder the three top bands: `bands` gives the order assigned
// to each, in HTML order (gauge, buttons, air roll). Only the orders that keep
// the throttle gauge **against** the button band are offered — it comments on
// what those buttons do, separating them makes no sense, which rules out two of
// the six permutations.
const LAYOUTS = [
  { alt: true, name: 'checker · vertical gauge' },
  { bands: [0, 1, 2], name: 'gauge · buttons · air roll' },
  { bands: [1, 0, 2], name: 'buttons · gauge · air roll' },
  { bands: [1, 2, 0], name: 'air roll · gauge · buttons' },
  { bands: [2, 1, 0], name: 'air roll · buttons · gauge' },
]
let bandHintTimer = 0

function applyLayout(i) {
  // Brought back within bounds: a config kept from before may point at a
  // layout that is no longer offered.
  const n = LAYOUTS.length
  const idx = ((Math.trunc(i) % n) + n) % n
  const layout = LAYOUTS[idx]

  el('panel').classList.toggle('alt', !!layout.alt)

  if (layout.bands) {
    const bands = [...document.querySelectorAll('#bands > .row.cols')]
    // Negative orders: the bands stay ahead of the grid and the speed block,
    // which keep the default order.
    bands.forEach((band, k) => { band.style.order = layout.bands[k] - layout.bands.length })
  }

  const hint = el('bandHint')
  hint.textContent = `${idx + 1}/${n} · ${layout.name}`
  hint.style.opacity = 1
  clearTimeout(bandHintTimer)
  bandHintTimer = setTimeout(() => { hint.style.opacity = 0 }, 1800)
}

function stickXY(a) {
  return {
    x: (a.stickRight || 0) - (a.stickLeft || 0),
    y: (a.stickDown || 0) - (a.stickUp || 0),
  }
}

function handleState(a) {
  const now = performance.now()
  const jump = a.jump || 0

  if (rl?.onGround) groundCtl.lastOnGroundAt = now
  if (rl?.hasFlip) flipAvail.lastAt = now

  if (jump >= 0.5 && jumpCtl.prev < 0.5) onJumpPress(now, a)
  if (jump < 0.5 && jumpCtl.prev >= 0.5) onJumpRelease(now)
  jumpCtl.prev = jump

  if (rl) trackRealDodge(now, a)

  state = a
}

// --- RL source: the game gives us the applied dodge, we infer nothing ---
function trackRealDodge(now, a) {
  const active = (rl.dodgeT || 0) > 0
  const [dx, dy] = rl.dodgeDir || [0, 0]

  if (active && !dodgeCtl.active) {
    // Start of the dodge: dodgeDir is in the car frame (X forward, Y right).
    // On screen x = right, y = down, so forward points up.
    const m = {
      x: dy,
      y: -dx,
      t: now,
      // As long as the flip plays out the marker doesn't age: its persistence
      // only starts at `endedAt`, set by endFlip — the same bound as the
      // timeline's, the only way for the two to fade together.
      endedAt: null,
      // Dodge triggered with a null direction: that's a stall (air roll +
      // opposite stick, the components cancel out), not a double jump — that
      // one activates no dodge and is marked in onJumpPress.
      stall: Math.hypot(dx, dy) < 1e-3,
      angle: Math.round((Math.atan2(dy, dx) * 180) / Math.PI),
    }
    markers.push(m)
    flipCtl.current = beginFlip(dx, dy)
    flipCtl.current.marker = m
  }

  if (active && flipCtl.current) sampleFlip(flipCtl.current, a, Math.max(0, rl.dodgeT || 0))
  else if (!active && flipCtl.current) endFlip(now)

  dodgeCtl.active = active
}

// A flip freezes its direction at trigger time: moving the stick afterwards no
// longer changes it. Everything that follows derives from that and stays
// constant — the torque split, and the impulse, already banked.
function beginFlip(dx, dy) {
  const n = Math.hypot(dx, dy)
  const ux = n ? dx / n : 0
  const uy = n ? dy / n : 0

  // The torque crosses the components: the lateral one rolls, the
  // forward/backward one pitches, and not with the same strength.
  const aRoll = Math.abs(uy) * FLIP_ROLL_ACCEL
  const aPitch = Math.abs(ux) * FLIP_PITCH_ACCEL
  const norm = Math.hypot(aRoll, aPitch)
  const torqueS = rl?.dodgeTorqueTime > 0 ? rl.dodgeTorqueTime : FLIP_TORQUE_S

  // The car saturates the game's ceiling in 25 ms whatever the flip, so the
  // total rotation is the same every time (~205°). What changes from one flip
  // to the next is only the axis it turns about, and splitting that total onto
  // pitch and roll is a projection — hence the norm. The two figures are the
  // sides of a right triangle whose hypotenuse is the 205°, not two halves of
  // a cake: they don't add up to it, they square up to it.
  const totalDeg = (MAX_ANG_SPEED * torqueS * 180) / Math.PI

  return {
    dx: ux, // = sign of the pitch torque, hence the opposite of the stick that flipped
    torqueS,
    // Degrees, not percentages. This used to show the L1 split
    // `aRoll / (aRoll + aPitch)`, a share of torque — which is not a share of
    // rotation and understated the roll by up to 15 points in the middle of
    // the range (R40 against 55 % really rolled, measured in game at −29°).
    // Degrees dodge the question: they are the rotation itself, and they
    // compare against the 205° rather than against each other.
    //
    // Both are what an unhindered flip would produce: the cancel eats into the
    // pitch afterwards, and it has its own number.
    pitchDeg: norm ? (totalDeg * aPitch) / norm : 0,
    rollDeg: norm ? (totalDeg * aRoll) / norm : 0,
    // The impulse grows with the speed already gained: without `vel` it can't
    // be estimated, and a "+0" would read as a measurement. null = dash.
    speedGain: rl?.vel ? flipSpeedGain(ux, uy) : null,
    samples: [],
    integral: 0,
    observedS: 0,
    cancelRatio: 0,
    latencyS: null,
    endedAt: 0,
  }
}

// The game recomputes on every tick the share of pitch torque it suppresses:
// `pitchScale = 1 - |pitch|`, as soon as the pitch input pushes in the
// direction of the torque — that is, opposite to the stick that started the
// flip. We apply the same formula to the input we receive: nothing is inferred
// any more, and the full profile is kept, the only way to show *when* the
// cancel bit. `t` is supplied by the caller: the active time the game gives
// when it's there, a local clock otherwise. Integration is weighted by time —
// a sample holds until the next one — so the rate doesn't have to be regular:
// the game's 120 Hz and rAF's ~60 Hz give the same integral.
function sampleFlip(f, a, t) {
  const pitchInput = (a.stickDown || 0) - (a.stickUp || 0)
  const sign = Math.sign(f.dx)
  const cut =
    sign !== 0 && Math.sign(pitchInput) === sign ? Math.min(1, Math.abs(pitchInput)) : 0

  // Staircase integration: a sample holds until the next one.
  const prev = f.samples[f.samples.length - 1]
  if (prev && t > prev.t) {
    f.integral += prev.cut * (t - prev.t)
    f.observedS = t
  }
  f.samples.push({ t, cut })
  if (f.latencyS == null && cut >= CANCEL_MIN_INPUT) f.latencyS = t

  // Related to the duration actually observed, not to the nominal window: a
  // shortened flip must not look less cancelled than it was.
  f.cancelRatio = f.observedS > 0 ? f.integral / f.observedS : 0
}

function endFlip(now) {
  flipCtl.current.endedAt = now
  // The marker on the plane shares the bound: one single end for both views.
  if (flipCtl.current.marker) flipCtl.current.marker.endedAt = now
  flipCtl.last = flipCtl.current
  flipCtl.current = null
}

// Impulse applied at trigger time, once and for all. It doesn't depend on the
// cancel — cancelling doesn't cost a single uu/s — and grows with the speed
// already gained, except forwards: hence the braking of a backflip at speed.
function flipSpeedGain(ux, uy) {
  if (!rl?.vel || !rl?.rot) return 0
  const fwd = forwardDir(rl.rot)
  const fwdSpeed = rl.vel[0] * fwd[0] + rl.vel[1] * fwd[1] + rl.vel[2] * fwd[2]
  const ratio = Math.min(1, Math.abs(fwdSpeed) / SPEED_MAX)

  // The game drops components too weak for the impulse — but not for the
  // torque, which keeps the whole direction.
  const dx = Math.abs(ux) < FLIP_IMPULSE_EPS ? 0 : ux
  const dy = Math.abs(uy) < FLIP_IMPULSE_EPS ? 0 : uy
  if (!dx && !dy) return 0

  // "Backward" is judged against the velocity, not against the nose: a front
  // flip while driving in reverse brakes like a backflip.
  const backwards =
    Math.abs(fwdSpeed) < 100 ? dx < 0 : (dx >= 0) !== (fwdSpeed >= 0)

  let vx = dx * FLIP_IMPULSE * (((backwards ? FLIP_BACK_SCALE : 1) - 1) * ratio + 1)
  const vy = dy * FLIP_IMPULSE * ((FLIP_SIDE_SCALE - 1) * ratio + 1)
  if (backwards) vx *= FLIP_BACK_EXTRA
  return Math.hypot(vx, vy)
}

// The car's forward vector, from its Rotator in degrees.
function forwardDir([pitch, yaw]) {
  const p = (pitch * Math.PI) / 180
  const y = (yaw * Math.PI) / 180
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)]
}

// A jump only starts if the car is touching the ground: in RL the thrust
// modulated by the hold is reserved for that jump (RocketSim, `_UpdateJump`:
// `else if (isOnGround && jumpPressed)`). Any press in the air is a second
// jump — double jump or flip — with no notion of amount.
//
// The grace absorbs the tick offset: depending on when the game samples,
// `onGround` may already have gone down by the time the press reaches us.
function jumpedFromGround(now) {
  if (!rl) return true // without RL data we don't know: assume the ground
  return !!rl.onGround || now - groundCtl.lastOnGroundAt < GROUND_GRACE_MS
}

function onJumpPress(now, a) {
  const fromGround = jumpedFromGround(now)
  const secondJump = rl
    ? !fromGround && (!!rl.hasFlip || now - flipAvail.lastAt < GROUND_GRACE_MS)
    : jumpCtl.flipArmed && now - jumpCtl.lastPressAt <= FLIP_WINDOW_MS

  if (secondJump) {
    // Second jump: directional flip or neutral double jump. The game tests the
    // **sum** of the deflections against DodgeInputThreshold, not their norm —
    // the neutral zone is a diamond (see docs/flip.md).
    //
    // Judged on the **raw** stick, where the game judges it — see
    // isNeutralDodge. The shaped projection is only a fallback for a page whose
    // bridge has never spoken, and it is wrong on the diagonal by construction.
    const { x, y } = stickXY(a)
    const fromGame = isNeutralDodge(rl, settings)
    const neutral = fromGame != null
      ? fromGame
      : Math.abs(x) + Math.abs(y) < source.dodgeThreshold
    // The directional marker comes from the real dodge (trackRealDodge): here
    // we only place the neutral double jump, which activates no dodge.
    if (neutral) {
      markers.push({
        x, y, t: now, neutral,
        // No torque to wait for here: the double jump opens no window, so its
        // persistence starts at the press. Same field as for a flip, so that
        // the display has only one clock to read.
        endedAt: now,
        angle: null,
      })
    }
    jumpCtl.flipArmed = false
  } else if (fromGround) {
    // First jump: the only one whose hold we measure.
    jumpCtl.flipArmed = true
    jumpCtl.firstPressAt = now
    jumpCtl.holding = true
  }
  // Press in the air with no jump left: the game does nothing with it, nor do we.
  jumpCtl.lastPressAt = now
}

function onJumpRelease(now) {
  if (jumpCtl.holding) {
    jumpCtl.holding = false
    jumpCtl.holdMs = Math.min(holdMaxMs(), now - jumpCtl.firstPressAt)
    jumpCtl.holdShownUntil = now + 1500
  }
}

// ---------- Rendering ----------
const el = id => document.getElementById(id)
const pills = ['airRollLeft', 'airRoll', 'airRollRight']
const buttons = ['slide', 'jump', 'boost']
const throttleFill = el('throttleFill')
const brakeFill = el('brakeFill')
const holdFill = el('holdFill')
const flipState = el('flipState')
const jumpBtn = el('jump')
const canvas = el('trailCanvas')
const ctx = canvas.getContext('2d')
const flipBar = el('flipBar')
const flipCanvas = el('flipCanvas')
const fctx = flipCanvas.getContext('2d')
const flipInfo = el('flipInfo')
const flipCxl = el('flipCxl')
const flipLat = el('flipLat')
const flipPitch = el('flipPitch')
const flipRoll = el('flipRoll')
const flipGain = el('flipGain')
const flipGainUnit = el('flipGainUnit')

function fitScale() {
  const s = Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H)
  el('stage').style.transform = `scale(${s})`
}
window.addEventListener('resize', fitScale)
fitScale()

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1
  for (const c of [canvas, flipCanvas]) {
    const rect = c.getBoundingClientRect()
    c.width = Math.max(1, Math.round(rect.width * dpr))
    c.height = Math.max(1, Math.round(rect.height * dpr))
  }
}
sizeCanvas()
window.addEventListener('resize', sizeCanvas)

function render() {
  const now = performance.now()
  const a = state

  for (const id of pills) el(id).classList.toggle('on', (a[id] || 0) >= 0.5)
  for (const id of buttons) el(id).classList.toggle('on', (a[id] || 0) >= 0.5)

  throttleFill.style.setProperty('--v', a.throttle || 0)
  brakeFill.style.setProperty('--v', a.brake || 0)

  renderSpeed()

  // JMP button fill = first jump size. The useful duration comes from the game
  // when RL is the source (JumpForceTime), otherwise we fall back on the estimate.
  const holdMax = holdMaxMs()
  let p = 0, o = 0
  if (jumpCtl.holding) {
    p = Math.min(1, (now - jumpCtl.firstPressAt) / holdMax)
    o = 1
  } else if (now < jumpCtl.holdShownUntil) {
    // After release, the level reached stays readable then fades out.
    p = Math.min(1, jumpCtl.holdMs / holdMax)
    o = Math.min(1, (jumpCtl.holdShownUntil - now) / 500)
  }
  holdFill.style.setProperty('--p', p)
  holdFill.style.setProperty('--o', o)

  renderFlipWindow(now)
  renderFlipBar(now)

  // Trail
  trail.push({ ...stickXY(a), t: now })
  const keepFrom = now - trailSeconds * 1000
  while (trail.length && trail[0].t < keepFrom) trail.shift()

  drawGrid(now)
  requestAnimationFrame(render)
}
requestAnimationFrame(render)

// RL works in units/s; 1 uu/s = 0.036 km/h, exactly. Everything the game gives
// us is in uu/s and every threshold below is too — the unit is a matter of
// presentation, applied at the last moment, and never of arithmetic.
//
// `uu` is in the list because it is the unit the numbers people quote are in:
// supersonic is 2200, not 79. Choosing it makes the graduations match what you
// read everywhere else about the game.
const SPEED_UNITS = {
  kmh: { label: 'km/h', factor: 0.036 },
  mph: { label: 'mph', factor: 0.036 / 1.609344 },
  uu: { label: 'uu/s', factor: 1 },
}
let speedUnit = 'kmh'

const toSpeed = v => Math.round(v * SPEED_UNITS[speedUnit].factor)

// The game's speed thresholds, in uu/s. They structure the bar: engine thrust
// alone saturates at 1410, beyond that you need boost; supersonic engages at
// 2200 and is only lost by dropping back under 2100 (or after a second between
// the two); 2300 is the car's ceiling, hence the end of the bar. Same
// thresholds as CinderBlocc's Speedometer.
const THROTTLE_MAX = 1410
const SUPERSONIC = 2200
const SUPERSONIC_OUT = 2100
const SUPERSONIC_GRACE_MS = 1000
const SPEED_MAX = 2300

const spdTotal = el('spdTotal')
const spdH = el('spdH')
const spdV = el('spdV')
const spdNow = document.querySelector('.spd-now')
const spdUnit = el('spdUnit')
const spdFill = el('spdFill')
const speedBox = el('speed')
const speedParts = el('spdParts')

// Supersonic hangs on: we keep the state as long as speed doesn't drop back
// under 2100, with a second of grace between the two thresholds.
const sonicCtl = { on: false, since: 0 }

// The bar is built once from the thresholds: positions, gradient and
// graduations all come from the same constants.
function setupSpeedScale() {
  const pct = v => (v / SPEED_MAX) * 100
  const t = pct(THROTTLE_MAX)
  const s = pct(SUPERSONIC)
  const o = pct(SUPERSONIC_OUT)

  spdFill.style.background =
    `linear-gradient(90deg, #e8e8e8 0 ${t}%, #f0a63c ${t}% ${s}%, #8cd8ff ${s}% 100%)`
  el('spdSonic').style.left = `${s}%`
  el('spdHold').style.left = `${o}%`
  el('spdHold').style.right = `${100 - s}%`
  el('spdTick').style.left = `${t}%`
  el('spdTickOut').style.left = `${o}%`
  el('spdTickLabel').style.left = `${t}%`
  el('spdSonicLabel').style.left = `${s}%`
  el('spdTickLabel').textContent = toSpeed(THROTTLE_MAX)
  el('spdSonicLabel').textContent = toSpeed(SUPERSONIC)
}
setupSpeedScale()

// Only the graduations and the two unit captions depend on the unit; the live
// numbers are converted as they are drawn. Unknown value = leave things alone,
// so a page ahead of its app doesn't blank its own scale.
function setSpeedUnit(unit) {
  if (!SPEED_UNITS[unit] || unit === speedUnit) return
  speedUnit = unit
  spdUnit.textContent = SPEED_UNITS[unit].label
  flipGainUnit.textContent = SPEED_UNITS[unit].label
  setupSpeedScale()
}

function renderSpeed() {
  if (!rl?.vel) {
    speedBox.style.opacity = 0.25
    speedParts.style.opacity = 0.25
    return
  }
  speedBox.style.opacity = 1
  speedParts.style.opacity = 1
  const [vx, vy, vz] = rl.vel
  const horizontal = Math.hypot(vx, vy)
  const total = Math.hypot(vx, vy, vz)

  spdTotal.textContent = toSpeed(total)
  spdH.textContent = toSpeed(horizontal)
  // Signed: we want to tell climbing from falling.
  spdV.textContent = toSpeed(vz)
  spdFill.style.setProperty('--p', Math.min(1, total / SPEED_MAX))
  spdNow.classList.toggle('sonic', isSupersonic(total, performance.now()))
}

// The game doesn't cut supersonic as soon as you drop back under 2200: it
// holds as long as you stay above 2100, and for no more than a second.
function isSupersonic(speed, now) {
  if (speed >= SUPERSONIC) {
    sonicCtl.on = true
    sonicCtl.since = now
  } else if (speed < SUPERSONIC_OUT || now - sonicCtl.since > SUPERSONIC_GRACE_MS) {
    sonicCtl.on = false
  }
  return sonicCtl.on
}

// Useful hold duration of the first jump: the game's value if available.
function holdMaxMs() {
  return rl?.maxJumpHold > 0 ? rl.maxJumpHold * 1000 : HOLD_MAX_MS
}

// The instant the first jump ends. That's where the second jump window starts
// from, not takeoff: the game counts time spent in the air "once the jump is
// finished" (RocketSim, `airTimeSinceJump` / `DOUBLEJUMP_MAX_DELAY`). Hence the
// 1.25 s of a tap against ~1.45 s of a fully held jump — the gap is exactly
// JumpForceTime.
//
// Returns 0 while the jump thrust lasts, or if no jump is in play.
function jumpEndedAt(now) {
  if (!jumpCtl.firstPressAt) return 0
  if (jumpCtl.holding) {
    // Button still held: the thrust runs until JumpForceTime.
    const end = jumpCtl.firstPressAt + holdMaxMs()
    return end <= now ? end : 0
  }
  const phase = Math.min(holdMaxMs(), Math.max(JUMP_MIN_MS, jumpCtl.holdMs))
  return jumpCtl.firstPressAt + phase
}

// Share of the second jump window still open. Equals 1 — hence a full
// indicator — as long as no countdown is running: either the jump thrust is
// still going, or the ground was left without jumping, in which case the flip
// stays available with no time limit until landing.
function flipRemaining(now) {
  const jumpEnd = jumpCtl.firstPressAt ? jumpEndedAt(now) : 0
  if (!jumpEnd) return 1
  const windowMs = (rl?.maxDodgeTime > 0 ? rl.maxDodgeTime : FLIP_WINDOW_MS / 1000) * 1000
  return Math.max(0, 1 - (now - jumpEnd) / windowMs)
}

// FLIP indicator: visible only in the air and as long as a flip is left. It
// carries the countdown in its fill. `hasFlip` is authoritative — the countdown
// is only an illustration of what the game applies.
function renderFlipWindow(now) {
  if (!rl) {
    flipState.style.opacity = 0
    jumpBtn.classList.remove('spent')
    return
  }

  // `hasFlip` comes from the game, and that's essential: a flip reset — four
  // wheels on the ball, a wall or the ceiling — gives it back mid-climb. No
  // reading of the inputs would ever see that happen (see docs/sources.md).
  const airborne = !rl.onGround
  const hasFlip = !!rl.hasFlip

  if (!airborne) {
    // Back on the ground: the previous jump no longer counts. We leave a short
    // delay after the press, long enough for the car to really take off.
    if (now - jumpCtl.lastPressAt > GROUND_RESET_MS) jumpCtl.firstPressAt = 0
    flipState.style.opacity = 0
    jumpBtn.classList.remove('spent')
    return
  }

  jumpBtn.classList.toggle('spent', !hasFlip)

  if (!hasFlip) {
    flipState.style.opacity = 0
    return
  }

  flipState.style.opacity = 1
  flipState.style.setProperty('--p', flipRemaining(now))
}

// ---------- Flip timeline ----------
// The current flip if we're in one, otherwise the last, long enough to read it.
function renderFlipBar(now) {
  const f = flipCtl.current || flipCtl.last
  const age = f && f.endedAt ? now - f.endedAt : 0

  if (!f || age > FLIP_SHOW_MS) {
    flipBar.style.opacity = 0
    flipInfo.style.opacity = 0
    if (f && !flipCtl.current) flipCtl.last = null
    return
  }

  const fade = age > FLIP_SHOW_MS - FLIP_FADE_MS ? (FLIP_SHOW_MS - age) / FLIP_FADE_MS : 1
  flipBar.style.opacity = fade
  flipInfo.style.opacity = flipNumbers ? fade : 0

  drawFlipBar(f, !!flipCtl.current)

  // Turned off, the row is invisible and there is nothing to keep up to date.
  // The timeline stays: it is a shape, not a figure, and it reads at a glance.
  if (!flipNumbers) return

  flipCxl.textContent = `${Math.round(f.cancelRatio * 100)}%`
  flipLat.textContent = f.latencyS != null ? `${Math.round(f.latencyS * 1000)}ms` : '—'
  flipPitch.textContent = Math.round(f.pitchDeg)
  flipRoll.textContent = Math.round(f.rollDeg)
  // The impulse depends on the speed at trigger time: without the game, nothing.
  flipGain.textContent = f.speedGain != null ? `+${toSpeed(f.speedGain)}` : '—'
}

function drawFlipBar(f, live) {
  const dpr = window.devicePixelRatio || 1
  const w = flipCanvas.width / dpr
  const h = flipCanvas.height / dpr
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  fctx.clearRect(0, 0, w, h)

  // The bar only carries the **pitch** torque: it's the only one the cancel
  // touches. It takes the full width as soon as there is any — its width does
  // not encode the pitch share: on 10 px, a half-thin column reads like a bug,
  // and the P/R numbers under the plane already carry the split. The rail stays
  // empty only for a pure side flip: nothing to cancel, nothing to read.
  // 11° is where the old 5 % L1 threshold sat once converted, so the flips that
  // used to get a bar still get one.
  const wPitch = f.pitchDeg > 11 ? w : 0
  const xPitch = 0

  // The rail carries the whole torque window, lived through or not: two flips
  // then compare on the same scale. Pill shape, and everything drawn afterwards
  // is clipped inside it: the fill inherits the rounded ends.
  fctx.fillStyle = 'rgba(255,255,255,0.10)'
  fctx.beginPath()
  fctx.roundRect(0, 0, w, h, w / 2)
  fctx.fill()
  fctx.save()
  fctx.clip()

  // Bottom = trigger, top = end of torque. Rounded to the pixel: two
  // neighbouring slices must land exactly on each other, otherwise their
  // antialiased edges stack up into stripes.
  const yAt = t => Math.round(h - Math.min(1, t / f.torqueS) * h)

  // A single gradient over the whole column, with one colour stop per sample:
  // that's where you read *when* the cancel happened, and how hard. Samples are
  // regular (120 Hz) and yAt is linear in t, so the stops spread out evenly. A
  // sharp cancel stays visible — the transition fits in one sample — but blends
  // instead of cutting.
  if (wPitch > 0 && f.samples.length) {
    const last = f.samples[f.samples.length - 1]
    const yEnd = yAt(last.t + 1 / 120)
    if (f.samples.length < 2 || h - yEnd < 1) {
      fctx.fillStyle = cutColor(f.samples[0].cut)
      fctx.fillRect(xPitch, yEnd, wPitch, Math.max(1, h - yEnd))
    } else {
      const g = fctx.createLinearGradient(0, h, 0, yEnd)
      const span = f.samples.length - 1
      f.samples.forEach((s, i) => g.addColorStop(i / span, cutColor(s.cut)))
      fctx.fillStyle = g
      fctx.fillRect(xPitch, yEnd, wPitch, h - yEnd)
    }
  }

  // Progress cursor: how far through the torque window we are, while the flip
  // is running — it's what makes the timeline feel alive. The start of the
  // cancel no longer has a frozen line: it reads straight off the colour, and
  // latency stays as a number under the plane.
  if (live && f.samples.length) {
    const y = Math.max(1, yAt(f.samples[f.samples.length - 1].t)) + 0.5
    fctx.strokeStyle = 'rgba(255,255,255,0.9)'
    fctx.lineWidth = 2
    fctx.beginPath()
    fctx.moveTo(0, y)
    fctx.lineTo(w, y)
    fctx.stroke()
  }

  fctx.restore()
}

// Red = torque suppressed, and its intensity literally follows the game's
// `1 - |pitch|`: a stick held halfway only cuts half, and reads as half. The
// torque delivered stays transparent — it's the rail showing through, not a
// second colour to interpret.
function cutColor(cut) {
  return `rgba(255, 70, 70, ${cut.toFixed(3)})`
}

function drawGrid(now) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.width / dpr
  const h = canvas.height / dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const cx = w / 2
  const cy = h / 2
  const rx = w / 2 - 8
  const ry = h / 2 - 8

  drawThresholdRings(cx, cy, rx, ry)

  // Stick trail (fades with age, vitals-style)
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  for (let i = 1; i < trail.length; i++) {
    const s0 = trail[i - 1]
    const s1 = trail[i]
    const age = (now - s1.t) / (trailSeconds * 1000)
    ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, (1 - age) * 0.55)})`
    ctx.beginPath()
    ctx.moveTo(cx + s0.x * rx, cy + s0.y * ry)
    ctx.lineTo(cx + s1.x * rx, cy + s1.y * ry)
    ctx.stroke()
  }

  // Flip markers
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i]
    const age = m.endedAt ? now - m.endedAt : 0
    if (age > FLIP_SHOW_MS) {
      markers.splice(i, 1)
      continue
    }
    const alpha = age < FLIP_SHOW_MS - FLIP_FADE_MS ? 1 : (FLIP_SHOW_MS - age) / FLIP_FADE_MS

    if (m.neutral) {
      ctx.strokeStyle = `rgba(140,245,166,${alpha})`
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(cx, cy, 14, 0, Math.PI * 2)
      ctx.stroke()
      drawLabel('NEUTRAL', cx, cy - 22, `rgba(140,245,166,${alpha})`)
      continue
    }

    // Stall: dodge consumed but null direction, the car freezes. Amber with a
    // cross, so it isn't confused with the neutral double jump.
    if (m.stall) {
      const amber = `rgba(240,166,60,${alpha})`
      ctx.strokeStyle = amber
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(cx, cy, 14, 0, Math.PI * 2)
      ctx.stroke()
      const r = 6
      strokeLine(cx - r, cy - r, cx + r, cy + r, amber, 3)
      strokeLine(cx - r, cy + r, cx + r, cy - r, amber, 3)
      drawLabel('STALL', cx, cy - 22, amber)
      continue
    }

    // The plane only carries the input: the direction asked for, at full size.
    // What the game did with it — and what the cancel took away — is read in
    // the timeline on the right, which has room to say *when* the torque was cut.
    const ex = cx + m.x * rx
    const ey = cy + m.y * ry
    strokeLine(cx, cy, ex, ey, `rgba(120,200,255,${alpha})`, 4)
    dot(ex, ey, `rgba(120,200,255,${alpha})`)

    // The angle is placed next to the tip, pulled back towards the centre and
    // offset perpendicularly on whichever side leaves the most room: placed
    // along the vector's axis, it left the canvas on a full front, back or side
    // flip and got clipped. Clamping as a last resort.
    const len = Math.hypot(ex - cx, ey - cy) || 1
    const ux = (ex - cx) / len
    const uy = (ey - cy) / len
    const spots = [1, -1].map(s => ({
      x: ex - ux * 26 - uy * 15 * s,
      y: ey - uy * 26 + ux * 15 * s,
    }))
    const room = p => Math.min(p.x, w - p.x, p.y, h - p.y)
    const p = room(spots[0]) >= room(spots[1]) ? spots[0] : spots[1]
    const lx = Math.min(w - 15, Math.max(15, p.x))
    const ly = Math.min(h - 5, Math.max(11, p.y))
    drawLabel(`${m.angle}°`, lx, ly, `rgba(120,200,255,${alpha})`)
  }

  // Instantaneous position: small white square (like the original)
  const { x, y } = stickXY(state)
  const px = cx + x * rx
  const py = cy + y * ry
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#555'
  ctx.lineWidth = 1
  ctx.fillRect(px - 6, py - 6, 12, 12)
  ctx.strokeRect(px - 6, py - 6, 12, 12)
}

// Reading guide for the stick: beyond the dodge threshold, the second jump
// becomes a directional flip. No deadzone circle — the values displayed are the
// effective input, already cleaned up by the game, there'd be nothing to circle.
// The boundary lives on the **raw** stick — the game tests |steer| + |pitch|
// against DodgeInputThreshold — while this grid draws shaped values. The two
// spaces are not related by a scale: shaping subtracts the deadzone once per
// axis, so a point on the diagonal pays it twice and the raw diamond arrives
// here pinched inwards.
//
// Drawing a straight-sided diamond through the axis points therefore put the
// boundary well outside where flips actually begin. So the raw edge is sampled
// and every point pushed through the same shaping the rest of the page draws
// with: exact by construction, and the pinch it shows is a fact about the
// input rather than an artefact of the drawing.
//
// Falls back to the plain diamond when the bridge hasn't spoken yet — there is
// no deadzone to account for until the game says what it is.
function thresholdQuarter() {
  if (!settings || !(settings.dodgeThreshold > 0)) return null
  const T = settings.dodgeThreshold
  const dz = settings.deadzone || 0
  const sens = sensFor(settings, false)
  const STEPS = 24
  const pts = []
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS
    pts.push([shape(T * (1 - t), dz, sens), shape(T * t, dz, sens)])
  }
  return pts
}

function drawThresholdRings(cx, cy, rx, ry) {
  const quarter = thresholdQuarter()
  const d = source.dodgeThreshold
  if (!quarter && !(d > 0)) return

  ctx.save()
  // Bright enough to be read against the grid: it is the line that decides
  // whether a second jump flips or not, which is the point of the plane.
  ctx.strokeStyle = 'rgba(140,216,255,0.6)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.beginPath()

  if (quarter) {
    // One quarter, mirrored around: (+,+) then (−,+) then (−,−) then (+,−),
    // reversing every other pass so the path stays a single loop.
    const ring = [
      ...quarter.map(([x, y]) => [x, y]),
      ...[...quarter].reverse().map(([x, y]) => [-x, y]),
      ...quarter.map(([x, y]) => [-x, -y]),
      ...[...quarter].reverse().map(([x, y]) => [x, -y]),
    ]
    ring.forEach(([x, y], i) => {
      const px = cx + x * rx
      const py = cy + y * ry
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
  } else {
    ctx.moveTo(cx + d * rx, cy)
    ctx.lineTo(cx, cy + d * ry)
    ctx.lineTo(cx - d * rx, cy)
    ctx.lineTo(cx, cy - d * ry)
  }

  ctx.closePath()
  ctx.stroke()
  ctx.restore()
}

function strokeLine(x0, y0, x1, y1, style, width) {
  ctx.strokeStyle = style
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
}

function dot(x, y, style) {
  ctx.fillStyle = style
  ctx.beginPath()
  ctx.arc(x, y, 5, 0, Math.PI * 2)
  ctx.fill()
}

function drawLabel(text, x, y, style) {
  ctx.font = '700 12px system-ui'
  ctx.textAlign = 'center'
  ctx.fillStyle = style
  ctx.fillText(text, x, y)
}

// ---------- Electron window only ----------
if (window.overlayAPI) {
  window.overlayAPI.onEditMode(on => document.body.classList.toggle('edit', on))
}
