// ControllerInput -> the actions the overlay displays.
//
// This is the page's own reading of the plugin's frames, and the only one: the
// app relays them without interpreting, so the numbers drawn don't depend on
// whether they arrived through Electron or straight off the plugin's
// WebSocket.
//
// Nothing here reaches for the DOM or for Node — it's arithmetic on a frame —
// and the export at the bottom keeps it usable from a script, which is what a
// headless consumer of the protocol would want.

const pos = v => (v > 0 ? v : 0)
const neg = v => (v < 0 ? -v : 0)
const r3 = v => Math.round(v * 1000) / 1000

// ControllerInput delivers the raw stick deflection: a value below the deadzone
// still shows up in it. What matters for the display is the input actually sent
// to the car, so we apply the deadzone then the sensitivity.
//
// Model: dead zone removed then renormalized over [0,1], sensitivity as a
// linear multiplier, saturation at 1 — RL's behaviour as observed.
function shape(v, deadzone, sens) {
  const a = Math.abs(v)
  if (a <= deadzone) return 0
  const normalized = (a - deadzone) / (1 - deadzone)
  return Math.sign(v) * Math.min(1, normalized * sens)
}

// Which sensitivity applies depends on context: steering on the ground, air
// control in the air. RL exposes both separately.
function sensFor(settings, onGround) {
  if (!settings) return 1
  return (onGround ? settings.steerSens : settings.airSens) || 1
}

// ControllerInput -> the action ids the overlay knows how to display.
function toActions(m, settings) {
  const onGround = !!m.onGround
  const dz = settings ? settings.deadzone : 0
  const sens = sensFor(settings, onGround)

  const steer = shape(m.steer, dz, sens)
  const pitch = shape(m.pitch, dz, sens)
  const roll = shape(m.roll, dz, sens)

  // Free air roll only exists in the air, with the button held.
  const freeAirRoll = !onGround && !!m.handbrake
  const directionalRoll = !onGround && !m.handbrake ? roll : 0

  return {
    stickLeft: r3(neg(steer)),
    stickRight: r3(pos(steer)),
    // Positive pitch = nose rising = stick pulled towards you = bottom of the screen.
    stickUp: r3(neg(pitch)),
    stickDown: r3(pos(pitch)),

    throttle: r3(pos(m.throttle)),
    brake: r3(neg(m.throttle)),

    boost: m.holdBoost ? 1 : 0,
    jump: m.jump ? 1 : 0,

    // The same input drives the powerslide on the ground and the free air roll
    // in the air: the game tells us which of the two applies, something the
    // mapping alone doesn't know.
    slide: onGround && m.handbrake ? 1 : 0,
    airRoll: freeAirRoll ? 1 : 0,

    // ControllerInput.Roll merges two origins: the dedicated binds (X / B) and
    // the free air roll, which copies steer into Roll as long as its button is
    // held. So we only show directional roll when it really comes from the
    // dedicated binds — otherwise a powerslide on the ground or a free air roll
    // would light up ARL/ARR by mistake.
    airRollLeft: r3(neg(directionalRoll)),
    airRollRight: r3(pos(directionalRoll)),
  }
}

// The dodge threshold is a threshold on the **raw** stick, while the overlay
// draws the effective input — deadzone removed, sensitivity applied. To stay
// comparable with what is on screen it has to be projected into that same
// space. Air sensitivity is the one that counts: you only flip in the air.
//
// No deadzone circle to go with it: anything under the threshold already
// arrives at zero, there would be nothing to circle.
function dodgeThresholdShown(settings) {
  if (!settings) return null
  return shape(settings.dodgeThreshold, settings.deadzone, sensFor(settings, false))
}

// A second jump becomes a directional flip when the **sum** of the deflections
// passes DodgeInputThreshold — not their norm, so the neutral zone is a diamond
// (docs/flip.md).
//
// The rule is about the **raw** stick, and has to be applied there. Comparing
// shaped values against `dodgeThresholdShown` looks equivalent and is not:
// shaping subtracts the deadzone once per axis, so a point on the diagonal pays
// it twice and falls under a threshold that only ever described the axes. With
// a 0.1 deadzone, a 0.55 threshold and 1.7 sensitivity, the boundary sits at
// 0.85 along an axis but at 0.66 on the diagonal — everything between the two
// was a real flip being called neutral.
//
// Returns null when there is nothing to judge with.
function isNeutralDodge(m, settings) {
  if (!m || !settings || !(settings.dodgeThreshold > 0)) return null
  return Math.abs(m.steer) + Math.abs(m.pitch) < settings.dodgeThreshold
}

// Loaded as a classic script in the browser, the declarations above are already
// globals; under Node they need saying out loud. Nothing in the app requires
// this today — the door is left open, not propped.
if (typeof module === 'object' && module.exports) {
  module.exports = { shape, sensFor, toActions, dodgeThresholdShown, isNeutralDodge }
}
