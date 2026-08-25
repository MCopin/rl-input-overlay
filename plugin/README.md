# Input Bridge

A BakkesMod plugin that puts Rocket League's **driver inputs** on a local
WebSocket, so anything can read them: an overlay, a stream graphic, a coaching
tool, a script.

It draws nothing in game. It is a data source.

## What it gives you that other plugins don't

[SOS](https://gitlab.com/bakkesplugins/sos/sos-plugin) and its relatives expose
**match state** — score, clock, players, positions. Nothing in that family
exposes what the driver is doing. This one does:

- **Actions already resolved by the game** (`ControllerInput`): throttle, steer,
  pitch, yaw, roll, handbrake, jump, boost. Independent of key bindings — you
  get what the car was asked to do, not which button was pressed.
- **The real dodge** (`DodgeComponent`): the direction the game committed to,
  the time since it fired, the torque window. The flip angle is *read*, not
  guessed from stick position.
- **`HasFlip()`, correct through flip resets** — wheels on the ball, a wall or
  the ceiling give the flip back, which no reading of inputs could ever see.
- **Controller settings from the game**: deadzone, dodge threshold, steering and
  air sensitivities. A change in the menus follows on its own, so consumers
  never ask the user to type them in.
- **Angular velocity in the car's frame**, `[pitch, yaw, roll]` — without that
  projection there is no telling a pitch from a roll.

120 Hz while driving. Full field list, with units and frames of reference, in
[`../docs/protocol.md`](../docs/protocol.md).

## Using it

Connect to `ws://127.0.0.1:49200` and read JSON:

```js
const ws = new WebSocket('ws://127.0.0.1:49200')
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.t === 'input' && m.dodgeT > 0) console.log('flipping', m.dodgeDir)
}
```

One JSON object per message. `t` is `"input"` or `"settings"`. The plugin never
reads what you send.

| cvar | default | |
|---|---|---|
| `rloverlay_ws_port` | 49200 | Rebinds on the spot when changed |
| `rloverlay_ws_allow_file_origin` | 1 | Accept pages that have no origin of their own |

The port was chosen to stay clear of SOS (49122) and RocketLink (49124).

## Security

It binds **127.0.0.1 only** — nothing is reachable from the network, and
`SO_EXCLUSIVEADDRUSE` keeps another local process from binding the same address
and taking the connections meant for it.

A listening socket inside an online game is still reachable from any page the
user happens to visit, so the handshake checks `Origin` and accepts only
loopback hosts. The host is matched **whole**: `http://localhost.example.com` is
refused, prefix or no prefix. A client that sends no `Origin` at all is taken to
be a script rather than a page, and allowed — browsers always send one.

`file://` pages report `Origin: null`. So does a sandboxed iframe on a hostile
page, and the handshake cannot tell them apart. OBS is a third case: it does not
open a local file as `file://` but serves it under a host of its own,
`http://absolute/C:/…`, so its pages arrive with that as their origin.

All three are local files as far as this is concerned, and all three are
accepted by default — running an overlay straight off disk is a normal way to
use this. Set `rloverlay_ws_allow_file_origin 0` in the BakkesMod console to
refuse the lot. `http://absolute` is matched in that exact form only:
`http://absolute.evil.com` is a real domain and stays refused.

What a page could get if it did reach the socket is telemetry: your driving
inputs, your controller settings and your gamepad bindings, while you play. The
plugin never reads what a client sends and exposes nothing else.

The game thread never blocks on the socket: it hands off a string and returns.
A client that stops reading costs a buffer and is eventually dropped, never a
frame of gameplay. A client that floods the socket is dropped once it has sent
more than a handshake's worth.

## Installing

[Input Bridge on bakkesplugins.com](https://bakkesplugins.com/plugin/875) — that
is the whole install. By hand: `RLOverlayPlugin.dll` in
`%APPDATA%\bakkesmod\bakkesmod\plugins\`.

## Building

Requires the **VS 2022 Build Tools** (C++ workload) and the BakkesMod SDK, which
ships with BakkesMod.

```powershell
.\build.ps1            # build, copy the DLL, hot-reload over RCON
.\build.ps1 -NoReload  # build only
```

No dependency to fetch. The WebSocket server is written against Winsock, and
SHA-1 comes from Windows CNG — the DLL links `ws2_32` and `bcrypt`, both part of
the system.

Load at startup with `plugin load rloverlayplugin` in
`%APPDATA%\bakkesmod\bakkesmod\cfg\plugins.cfg`.

## License

MIT — see [`../LICENSE`](../LICENSE).

## The overlay that uses it

**RL Input Overlay** ([`../app`](../app)) is built on this protocol — throttle,
boost, air roll, and a flip timeline that shows how much of a dodge's torque a
cancel actually suppressed. It is one consumer, not a requirement.
