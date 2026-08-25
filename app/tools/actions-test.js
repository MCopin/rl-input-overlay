// Unit checks on the page's reading of a frame — no browser, no game.
//
//   npm run actions
//
// actions.js is the only place a frame is turned into what gets drawn, on both
// routes into the page, so its arithmetic is worth pinning down on its own.
const assert = require('assert')
const path = require('path')
const {
  shape, sensFor, toActions, dodgeThresholdShown, isNeutralDodge,
} = require(path.join(__dirname, '..', 'public', 'actions.js'))

// The settings the game actually reports, so the numbers below are the ones a
// player sees rather than round ones chosen to be easy.
const S = { deadzone: 0.1, dodgeThreshold: 0.55, steerSens: 1.7, airSens: 1.7 }

const near = (a, b) => Math.abs(a - b) < 1e-9

let failed = 0
function check(name, got, want) {
  const ok = typeof want === 'number' && typeof got === 'number'
    ? near(got, want) : got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`
    + (ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}

console.log('\nshaping')
check('under the deadzone is nothing', shape(0.09, 0.1, 1.7), 0)
check('the deadzone is removed, not scaled around', shape(0.1, 0.1, 1.7), 0)
check('sensitivity saturates at 1', shape(0.9, 0.1, 1.7), 1)
check('sign is kept', shape(-0.55, 0.1, 1.7), -0.85)
check('air sensitivity applies off the ground', sensFor(S, false), 1.7)
check('steering sensitivity applies on it', sensFor(S, true), 1.7)

console.log('\nthe dodge threshold, drawn')
// Where the boundary meets an axis, in the space the grid draws in.
check('projected onto an axis', dodgeThresholdShown(S), 0.85)

console.log('\nthe dodge threshold, judged')
// The rule is on the raw stick. These are the cases that matter.
check('stick centred is neutral', isNeutralDodge({ steer: 0, pitch: 0 }, S), true)
check('just under, on an axis', isNeutralDodge({ steer: 0.54, pitch: 0 }, S), true)
check('just over, on an axis', isNeutralDodge({ steer: 0.56, pitch: 0 }, S), false)
check('sum, not norm: 0.3 + 0.3 flips', isNeutralDodge({ steer: 0.3, pitch: 0.3 }, S), false)
check('signs do not cancel out', isNeutralDodge({ steer: -0.3, pitch: 0.3 }, S), false)

// The regression this file exists for. A diagonal at 0.28/0.28 is a real flip:
// the raw sum is 0.56, over the game's 0.55. Judged in shaped space it summed
// to 0.66 against a 0.85 threshold and came back "neutral", because shaping
// subtracts the deadzone once per axis and a diagonal pays it twice.
console.log('\nthe diagonal that used to read NEUTRAL')
const diag = { steer: 0.28, pitch: 0.28 }
check('raw sum clears the threshold', 0.28 + 0.28 > S.dodgeThreshold, true)
check('so it is not neutral', isNeutralDodge(diag, S), false)
const shapedSum = Math.abs(shape(0.28, S.deadzone, 1.7)) + Math.abs(shape(0.28, S.deadzone, 1.7))
check('while the shaped sum falls short of 0.85', shapedSum < dodgeThresholdShown(S), true)

console.log('\nnothing to judge with')
check('no frame', isNeutralDodge(null, S), null)
check('no settings', isNeutralDodge({ steer: 1, pitch: 0 }, null), null)

console.log('\na frame becomes actions')
const a = toActions({ steer: 0.55, pitch: -0.55, throttle: 1, holdBoost: 1, onGround: 0 }, S)
check('steer right', a.stickRight, 0.85)
check('nothing on the left', a.stickLeft, 0)
check('negative pitch draws upwards', a.stickUp, 0.85)
check('throttle', a.throttle, 1)
check('boost follows the hold', a.boost, 1)
check('no powerslide in the air', a.slide, 0)

if (failed) {
  console.log(`\n${failed} FAILED\n`)
  process.exit(1)
}
console.log('\nall checks passed\n')
