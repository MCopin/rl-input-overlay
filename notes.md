# Universal RL overlay — design notes

## Goal

Build an input overlay like maktuf's (a mashup of two BakkesMod overlays:
[Revela's Input HUD](https://bakkesplugins.com/plugin/764) and
[Controller Overlay](https://bakkesplugins.com/plugin/59) by Haltepunkt), but
**universal** (game-independent, device-agnostic: we show the *action* — boost,
drift… — not the button) and enriched with a **time dimension**: inputs don't
just show up at instant T, they leave a readable trace over time.

## Wanted improvements

### 1. Stick trail (inputs over time)

Clearly see the joystick inputs for a few more seconds after letting go of the
stick — like network "vitals", a trace that fades.

- **V1**: stick position on a simple 2D plane, with a fading trail.
- **Later**: a view as a function of time (timeline).

### 2. Flip angles

Visualize the angle used for each flip:

- Neutral flip → a "neutral" indicator visible for a while.
- Diagonal flip → the exact diagonal angle used.
- Like the stick trail, the info persists for a few seconds.

### 3. Flip cancel

In RL you can cancel the vertical component of a flip. We need a visual
indicator of the cancel: did we cancel, and by how much.

**Lead**: a bar/marker that freezes on the joystick grid for the duration of the
flip, and shrinks depending on whether and how much we cancel. Ideally we'd
retrieve the rotation actually applied to the car for each flip (→ BakkesMod
telemetry); until then it can be inferred from the inputs (opposite pitch input
right after the flip).

### 4. First jump size

In RL, how long you hold jump modulates jump height. We need a visual indicator
of the first jump's hold duration.

## Test feedback — BakkesMod session

Observations in game, with the RL source active:

1. **ARL/ARR light up on the ground during a powerslide.** Cause: `ToggleRoll`
   and `Handbrake` share LB, so RL copies steer into `Roll` as soon as LB is
   held — even on the ground where it has no effect. → only show directional
   roll while airborne.
2. **ARL/ARR also light up during a free air roll.** Same cause: free roll goes
   through the same axis. The ARL/ARR pills should represent the dedicated binds
   (X / B), not the roll axis in general. → hide them when free air roll is
   active.
3. **The big joystick is redundant** with the 2D plane. → remove it.
4. **The first jump hold looks too long.** Should be based on the game's real
   value (`JumpComponent::GetMaxJumpHeightTime`) instead of a constant.
5. **Second jump**: show a countdown (time left before losing the right to the
   second jump, cf. `CarWrapper::GetMaxTimeForDodge`) and grey out the button
   when there's no jump left (`CarWrapper::HasFlip`).
6. **Speed indicator**: total speed, horizontal component and vertical
   component.
7. **Flip cancel**: cancelling is done by holding the stick opposite to the
   flip. The bar should shrink over time depending on how long the opposite hold
   lasts, instead of a frozen percentage.
8. **Only the forward/backward component of a flip can be cancelled.** A dodge
   creates two rotations: the forward/backward component turns the car in
   *pitch*, the lateral component in *roll*. The cancel acts on pitch by holding
   the stick the other way; the lateral barrel roll happens no matter what.

   > The conclusion drawn here — shrinking the marker's vertical component — has
   > since been abandoned: the 2D plane only shows the **input**, at constant
   > size, and everything about the cancel lives in the timeline to its right
   > (see [`docs/flip.md`](docs/flip.md)). A shrinking vector mixed two things
   > together, what was asked for and what the game did with it.

## Flip cancel measurements (taken in game, 40+ flips)

> These measurements have since been checked against the physics source code
> (RocketSim / RLUtilities): see [`docs/flip.md`](docs/flip.md). The 5.50 rad/s
> peak isn't a property of the dodge but the game's rotation ceiling
> (`CAR_MAX_ANG_SPEED`), which every flip saturates in 25 ms — which explains
> the 204° down to the constant.

The cancel is measured on the **rotation actually performed**, not on how long
the opposite hold lasted — that was the mistake in the first model, which showed
a far too short bar.

Constants measured through BakkesMod:

- an uncancelled front flip turns **204°** of pitch, with a constant peak of
  **5.50 rad/s**; that peak shows up whether you cancel or not, the dodge
  imparting its angular velocity as an impulse;
- `DodgeTorqueTime` = **0.65 s**, and 5.50 × 0.65 = 204.8°: the expected
  rotation therefore follows from `peak × DodgeTorqueTime`, with no hardcoded
  constant.

**A total cancel is physically impossible.** Regression on the lower envelope
(best result per latency, R² = 0.98):

```
rotation = 0.284 °/ms × reaction_latency + 86°
```

- a floor of **86° (42 % of the flip)** even with an instantaneous reaction:
  pitch air control is too weak to cancel the dodge's impulse, only to slow it
  down;
- every **10 ms** of reaction costs **2.8°** of extra rotation.

Hence showing latency next to the percentage: it's the only trainable part.

## Origin of the second jump window

The second jump ring used to start at **takeoff**. That's wrong: the game counts
time spent in the air **once the jump is finished**. Verified in
[RocketSim](https://github.com/ZealanL/RocketSim), which replays RL's physics
tick by tick:

```cpp
DOUBLEJUMP_MAX_DELAY = 1.25f, // Can be at most 1.25 seconds after the jump is finished

if (hasJumped && !isJumping) airTimeSinceJump += tickTime;
else                         airTimeSinceJump = 0;
if (jumpPressed && airTimeSinceJump < DOUBLEJUMP_MAX_DELAY) { ... }
```

`isJumping` stays true as long as the button is held, capped at `JUMP_MAX_TIME`
(0.2 s) and floored at `JUMP_MIN_TIME` (0.025 s). Two consequences:

- a **tap** leaves 1.25 s, a **fully held jump** ~1.45 s. The gap is exactly
  JumpForceTime — the same number the
  [RLBot wiki](https://wiki.rlbot.org/v4/botmaking/jumping-physics/) gives;
- `airTimeSinceJump` only runs if `hasJumped`. **Leaving the ground without
  jumping** (ramp, ledge) therefore starts no countdown: the flip stays
  available with no time limit, and the overlay shows no ring in that case.

## To do

### Make the overlay work on replays

Today the bridge reports nothing during a replay. Three known obstacles:

1. **Plugin type** — declared `PLUGINTYPE_FREEPLAY` in `RLOverlayPlugin.cpp`.
   `PLUGINTYPE_REPLAY` needs to be added.
2. **Tracked car** — the hook filters on `gameWrapper->GetLocalCar()`, which
   makes no sense in a replay. Go through `ReplayServerWrapper::GetViewTarget()`
   (see also `GetReplayTimeElapsed` / `GetReplayFPS`) to follow the car being
   watched, and handle the camera switching from one player to another.
3. **Inputs vs physics** — to be checked: a replay replays the physics
   (position, rotation, velocity), but nothing guarantees `ControllerInput` is
   replicated. If the raw inputs are missing, everything derived from
   **rotation** still holds (flip angle, cancel measurement, speeds); it's the
   boost / drift / air roll pills that would fall over. They'd then have to be
   deduced from the physics, or hidden during replays.

A replay can be paused/rewound: the cancel measurement integrates over time, so
it will have to be based on replay time rather than on `performance.now()`,
otherwise slow motion or a rewind skews the integration.

## Visual leads

- Take inspiration from a helicopter / flight game to nicely display yaw and
  other 3D rotations?
- Think **control by control** about the optimal display: as pretty / clear as
  possible.
- Mood reference: OSU, where elements disappear as you go.
