# Why BakkesMod is the only source

A decision file: the overlay had two sources for a long time — the game through
BakkesMod, and a fallback controller/keyboard path (Gamepad API + `uiohook-napi`)
used when RL wasn't running. That second path has been **removed**. This
document says why, so that nobody rewrites it in six months.

The controller path wasn't broken: it displayed buttons, the stick, air roll and
the trail correctly. What it couldn't do is the **time** half of the overlay —
the half that makes the project interesting.

## 1. What doesn't exist in the inputs

`vel`, `rot`, `angVel`, `onGround`, `hasFlip`, `boostAmt`.

These values depend on the field, on bounces, on bumps and on pads picked up. No
controller carries them. Without them the overlay lost the speed bar,
supersonic, the impulse's speed gain, the `FLIP` indicator and its countdown,
the "spent" JMP button, the `STALL` marker, and the powerslide / free air roll
distinction — only the game knows which of the two applies, it's the same
button.

## 2. What could have been reconstructed

A real part of it, and that's what made the decision hard. The **flip timeline**
barely depends on the game: `sampleFlip` only reads the pitch input and a clock,
and the formula `pitchScale = 1 - |pitch|` comes from the physics documented in
[`flip.md`](flip.md), not from a measurement. A local timer and the stick
direction at the second jump were enough to produce the cancel profile, the
latency and the pitch / roll split.

It was implemented, then undone. The reason is in §3.

## 3. The flip reset, which settles the question

To know whether a press in the air is a flip, you need to know whether the flip
is still available. A state machine on jump presses manages that for a takeoff
from the ground — and fails everywhere else:

- **Flip reset**: four wheels touching the ball in the air, and the game gives
  the flip back. That's the general rule, not an edge case — wheels touching
  **any surface** restores it: the ball, a wall, the ceiling, the roof of
  another car. None of that appears in the inputs.
- **Leaving without jumping** (ramp, ledge): the first press *is* the flip, but
  it's read as a first jump.
- **Landing between two jumps**: two presses less than 1.25 s apart display a
  complete flip timeline for a flip that never happened.

The failure mode is therefore not a gap, it's a **wrong value** that nothing
distinguishes from a measurement. A training tool that gets the very mechanic it
is supposed to teach wrong is worse than a blank panel — and it would get it
wrong precisely on the advanced mechanics you'd want to work on.

With the game, all of that is free: the plugin reads `car.HasFlip()`, which is
already right, flip resets included, without a single dedicated line of code.

## 4. Replays aren't a source either

A question asked separately: can the plugin run on a replay, to analyse a game
after the fact? No.

Two immediate blockers, both on the plugin's only data path: the hook
`Function TAGame.Car_TA.SetVehicleInput` (`plugin/src/RLOverlayPlugin.cpp`)
doesn't fire when you're not driving — from the BakkesMod docs: "This event is
called every physics tick **while you are playing** […] It doesn't fire while
spectating matches" — and the handler then filters on
`gameWrapper->GetLocalCar()`, which doesn't exist in a replay.

But the real obstacle is upstream. A `.replay` is a trace of **network
replication** — positions, rotations, velocities, at ~30 frames/s in keyframes
and deltas — not a recording of the commands. Rolv-Arild (author of RLGym), on
his replay pre-training project: "Replays do not contain all the player inputs.
Some of them are included, and it's theoretically possible to infer the rest
algorithmically" — but replays are lossy reconstructions, the game's
interpolation does most of the work, and the error that accumulates demands
unreasonable precision.

It's exactly the wrong way round: the replay carries the physics and not the
commands, while the overlay is a command overlay. We'd get `vel`, `rot`,
`angVel` out of it — by hooking `Function Engine.GameViewportClient.Tick`, which
also runs during replays, and reading the cars through `ReplayServerWrapper` —
which is precisely the column from §1. The stick, held boost, the jump and the
entire flip timeline would still be missing.

The only existing workaround is [JumpInReplay](https://github.com/Atomus48/JumpInReplay),
which converts a replay into a private match and lets you take control of a car:
`SetVehicleInput` fires again and the overlay works — but then those are *our*
inputs, not the original player's.

## 5. Consequence

**Seeing a player's commands requires the live session, with BakkesMod.** The
app therefore has a single source, and the overlay badge no longer says *which*
one is talking but *whether* the game is there — when it's off, everything on
screen is stale.

What was removed along with the controller path: `src/main/engine.js`,
`src/main/keyboard.js`, `src/main/presets.js`, `src/capture/`, the bindings table
and the presets in the config window, and the native `uiohook-napi` dependency —
hence also the macOS accessibility permissions.

Sources: [Commonly Hooked Functions](https://bakkesplugins.com/wiki/bakkesmod-sdk/functions/commonly-hooked-functions),
[replay-pretraining](https://github.com/Rolv-Arild/replay-pretraining),
[ReplayServerWrapper](https://bakkesplugins.com/wiki/bakkesmod-sdk/classes/wrappers/replayserverwrapper),
[carball](https://github.com/SaltieRL/carball).
