# The plugin's protocol

What `rloverlayplugin` puts on its WebSocket, field by field. This is the
contract: the overlay is one consumer of it, and anything else that connects is
another.

**Endpoint** — `ws://127.0.0.1:49200`, port on the `rloverlay_ws_port` cvar.
Loopback only. Connections are refused unless their `Origin` names a loopback
host (`127.0.0.1`, `localhost`, `[::1]`, any port), is `file://`/`null`, or is
absent — the last being how a non-browser client identifies itself.

The host is matched whole, never by prefix: `http://localhost.example.com` is
refused.

Pages with no origin of their own are a group of three: `null`, `file://`, and
`http://absolute` — the last being what OBS sends, since obs-browser serves a
local file under a host it invents rather than as `file://`. A sandboxed iframe
on a hostile page also reports `null` and cannot be told apart from a real local
file, so all three move together and are refused by
`rloverlay_ws_allow_file_origin 0`.

**Framing** — one JSON object per WebSocket text message. No newline, no length
prefix, no envelope. `t` names the type. The plugin never reads what you send,
beyond closes and pings.

**Rates** — `input` at 120 Hz while a local car exists and is being driven,
nothing otherwise. `settings` on connect, then only when a value changes.

## Units and frames of reference

Read this before the tables; most mistakes with this protocol live here.

| | |
|---|---|
| Distance | Unreal units (uu). 1 uu ≈ 1 cm |
| Speed | uu/s. Supersonic is 2200, the car's ceiling 2300 |
| Angles | degrees, converted from UE3 rotators by the plugin |
| Angular velocity | rad/s. The game's ceiling is 5.5 |
| Time | seconds |
| Stick axes | −1 to 1, **raw** — the deadzone has *not* been applied |
| `vel`, `angVel` | **world** frame, `[x, y, z]` |
| `rates`, `dodgeDir` | **car** frame — see below |

The car frame is the one that matters for anything about flips. Its axes are
X forward, Y right, Z up, and `rates` is `[pitch, yaw, roll]` — the projection
of the world angular velocity onto the car's right, up and forward axes
respectively. Without that projection there is no telling a pitch from a roll:
only the component around the car's right axis measures how far a forward flip
actually turned, which is what a cancel leaves behind.

## `t: "input"`

One physics tick. Emitted only for the **local** car, and only while driving —
`SetVehicleInput` does not fire while spectating, and a replay does not contain
inputs at all ([`sources.md` §4](sources.md)).

### What the player asked for

`ControllerInput`, i.e. the actions **already resolved by the game**. They are
independent of key bindings: a value here is what the car was asked to do, not
which button was pressed.

| Field | Type | Meaning |
|---|---|---|
| `throttle` | −1…1 | positive accelerates, negative brakes/reverses |
| `steer` | −1…1 | positive right |
| `pitch` | −1…1 | **positive = nose up** = stick pulled toward you |
| `yaw` | −1…1 | positive right |
| `roll` | −1…1 | positive right. Merges the dedicated air-roll binds *and* free air roll, which copies `steer` into it while its button is held |
| `dodgeF`, `dodgeS` | −1…1 | dodge axes, forward and strafe |
| `handbrake` | 0/1 | powerslide on the ground, free air roll in the air — the same input, `onGround` decides which |
| `jump` | 0/1 | held |
| `boost` | 0/1 | pressed this tick |
| `holdBoost` | 0/1 | held. This is the one to draw; `boost` is an edge |
| `jumped` | 0/1 | the game's own flag |

These carry the **raw** deflection, including values under the deadzone that the
car never receives. To show what the car actually got, remove the deadzone,
renormalise over `[0,1]`, multiply by the sensitivity and saturate at 1 —
`shape()` in [`../app/public/actions.js`](../app/public/actions.js) is that,
and `toActions()` resolves the handbrake and roll ambiguities above.

### What only the game knows

| Field | Type | Meaning |
|---|---|---|
| `onGround` | 0/1 | wheels on a surface |
| `hasFlip` | 0/1 | a flip is available. **Correct through flip resets** — wheels on the ball, a wall or the ceiling give it back, which no reading of the inputs could ever see |
| `boostAmt` | 0…1 | boost in the tank |
| `vel` | `[x,y,z]` uu/s | world velocity |
| `rot` | `[pitch,yaw,roll]` deg | orientation |
| `angVel` | `[x,y,z]` rad/s | world angular velocity |
| `rates` | `[pitch,yaw,roll]` rad/s | the same, in the car frame |

### The dodge

The flip as the game applies it, not as inferred from stick position.

| Field | Type | Meaning |
|---|---|---|
| `dodgeT` | s | time since the dodge fired, 0 when none is running |
| `dodgeDir` | `[x,y,z]` | the direction the game **committed to**, car frame, X forward / Y right. `[0,0,0]` means a dodge with no direction — a stall |
| `dodgeTorqueTime` | s | how long torque is applied, 0.65 in a normal game. The window in which an opposite pitch can still cancel |
| `minDodgeTorqueTime` | s | floor on that window |
| `maxDodgeTime` | s | how long the second jump stays available, 1.25 by default |
| `maxJumpHold` | s | `JumpForceTime`, 0.2 — how long holding jump keeps adding thrust, hence the real "size" of a jump. **Not** `MaxJumpHeightTime` (~0.9 s), the time to the apex |

The physics these describe — the torque crossing the stick's components, the
`1 - abs(pitch)` cancel scale, the impulse — is documented in
[`flip.md`](flip.md), with sources and reference values.

### Example

```json
{"t":"input","throttle":1.000,"steer":0.812,"pitch":-0.300,"yaw":0.000,
 "roll":0.000,"dodgeF":0.000,"dodgeS":0.000,"handbrake":1,"jump":1,"boost":0,
 "holdBoost":1,"jumped":1,"onGround":0,"hasFlip":1,"boostAmt":0.470,
 "dodgeT":0.120,"dodgeDir":[1.000,0.000,0.000],"dodgeTorqueTime":0.650,
 "minDodgeTorqueTime":0.410,"maxJumpHold":0.200,"maxDodgeTime":1.250,
 "vel":[1500.0,0.0,200.0],"rot":[0.00,0.00,0.00],"angVel":[0.000,0.000,0.000],
 "rates":[3.200,0.000,0.000]}
```

## `t: "settings"`

The controller settings, read from the game rather than configured by hand, so a
change in the menus follows on its own. Sent to every client on connect, then
whenever the blob changes.

| Field | Type | Meaning |
|---|---|---|
| `deadzone` | 0…1 | `ControllerDeadzone` |
| `dodgeThreshold` | 0…1 | `DodgeInputThreshold` — minimum **raw** deflection for a directional flip |
| `steerSens` | | `SteeringSensitivity`, applies on the ground |
| `airSens` | | `AirControlSensitivity`, applies in the air |
| `bindings` | `[[key, action], …]` | the raw list |

`dodgeThreshold` is a threshold on the **raw** stick. If you draw shaped values,
push it through the same shaping with air sensitivity before comparing, or the
threshold you draw won't line up with the stick you draw inside it.

`bindings` is deliberately unfiltered: the same key appears several times
because the game also binds the editor, dance and replay contexts. Keep the
actions you care about.

## Stability

There is no version field yet, and that is a decision to revisit before anyone
else depends on this. Field names have been stable since the socket appeared,
and renaming one is no longer a local edit — see
[`architecture.md` §9](architecture.md).

## Reading it yourself

Nothing about this is specific to the overlay:

```js
const ws = new WebSocket('ws://127.0.0.1:49200')
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.t === 'input' && m.dodgeT > 0) console.log('flipping', m.dodgeDir)
}
```

From Node, `ws` sends no `Origin` and is accepted as a non-browser client.
From a page, serve it over `http://127.0.0.1` or open it as a file.
