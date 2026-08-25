// Checks what the plugin's WebSocket accepts, and what it turns away.
//
//   npm run origins
//
// The socket sits inside an online game, so it is reachable from any page the
// user happens to have open. `Origin` is the only thing separating the overlay
// from a hostile site, and it was once tested as a prefix — which accepted
// `http://localhost.evil.com`, a domain anybody can register. These cases exist
// so that never comes back.
//
// Raw sockets rather than a WebSocket client: the point is to control the
// header exactly, including sending none at all.
const net = require('net')
const crypto = require('crypto')

const PORT = Number(process.env.RLOVERLAY_PORT) || 49200

// [origin, shouldBeAccepted, why]. `null` means: send no Origin header.
//
// The "null" origin is deliberately absent: it is the one case
// `rloverlay_ws_allow_file_origin` moves, so it is probed separately and
// whichever way it answers is read as the cvar's current setting. Asserting it
// here would make this test fail on a correctly locked-down plugin.
const CASES = [
  [`http://127.0.0.1:3947`, true, 'the app'],
  ['http://localhost:3947', true, 'the app, by name'],
  ['http://LOCALHOST:3947', true, 'host case is not significant'],
  ['http://[::1]:3947', true, 'loopback over IPv6'],
  ['http://127.0.0.1', true, 'no port'],
  [null, true, 'no Origin at all: a script, not a page'],

  ['https://evil.com', false, 'a plain hostile site'],
  ['http://localhost.evil.com', false, 'registrable domain behind a prefix'],
  ['http://127.0.0.1.evil.com', false, 'registrable domain behind a prefix'],
  ['http://localhostevil.com', false, 'no separator at all'],
  ['http://localhost@evil.com', false, 'real host hidden behind userinfo'],
  ['http://localhost:3947.evil.com', false, 'port position abused'],
  ['http://evil.com/http://localhost', false, 'loopback pushed into the path'],
  ['http://evil.com#http://localhost', false, 'loopback pushed into a fragment'],
  ['ws://localhost:3947', false, 'a scheme no page is ever served over'],
  ['http://localhost:99999999999999999999', false, 'port that cannot be one'],
  // OBS's made-up host is accepted, but only in the exact form obs-browser
  // uses. Anything wearing it as a prefix is a real domain again.
  ['http://absolute.evil.com', false, "OBS's host with a domain appended"],
  ['https://absolute', false, 'OBS serves local files over http, not https'],
]

function reachable() {
  return new Promise(resolve => {
    const s = net.connect(PORT, '127.0.0.1')
    const done = ok => { s.destroy(); resolve(ok) }
    s.setTimeout(1500, () => done(false))
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  })
}

// Resolves to the status line of the plugin's answer, e.g. "HTTP/1.1 101 ...".
function handshake(origin) {
  return new Promise(resolve => {
    const key = crypto.randomBytes(16).toString('base64')
    const s = net.connect(PORT, '127.0.0.1')
    let buf = ''
    const finish = v => { clearTimeout(timer); s.destroy(); resolve(v) }
    const timer = setTimeout(() => finish('no answer'), 3000)
    s.on('connect', () => {
      let req = `GET / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
      if (origin !== null) req += `Origin: ${origin}\r\n`
      s.write(req + '\r\n')
    })
    s.on('data', d => {
      buf += d.toString()
      if (buf.includes('\r\n\r\n')) finish(buf.split('\r\n')[0])
    })
    // A refusal the plugin closes on before we read it still counts as refused.
    s.on('close', () => finish('closed'))
    s.on('error', e => finish('error: ' + e.message))
  })
}

;(async () => {
  if (!(await reachable())) {
    console.log(`\nnothing listening on 127.0.0.1:${PORT} — skipped.`)
    console.log('Start Rocket League with the plugin loaded, then run this again.\n')
    process.exit(0)
  }

  // Read the cvar's effect rather than assume it: whichever way "null" answers
  // is the setting, and the run is checked against that.
  const opaqueOk = (await handshake('null')).includes('101')

  console.log(`\nOrigin policy on 127.0.0.1:${PORT}`)
  console.log(`rloverlay_ws_allow_file_origin looks ${opaqueOk ? 'ON' : 'OFF'}`
    + ` — file:// pages are ${opaqueOk ? 'accepted' : 'refused'}\n`)
  let failed = 0
  for (const [origin, expected, why] of CASES) {
    const status = await handshake(origin)
    const accepted = status.includes('101')
    const ok = accepted === expected
    if (!ok) failed++
    const shown = (origin === null ? '(no Origin)' : origin).padEnd(32)
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${shown} ${accepted ? 'accepted' : 'refused '}  ${why}`)
  }

  // A file:// URL and the bare "null" are the same thing to a browser, and the
  // switch has to treat them alike or the cvar would only half close the door.
  // OBS's http://absolute is the third form of the same thing: a local file,
  // served under a host obs-browser invents. All three move together.
  for (const [origin, why] of [
    ['file:///C:/overlay.html', 'follows the same switch as "null"'],
    ['http://absolute', 'OBS local file — same switch again'],
  ]) {
    const ok = (await handshake(origin)).includes('101')
    const consistent = ok === opaqueOk
    if (!consistent) failed++
    const shown = (origin.length > 30 ? origin.slice(0, 29) + '…' : origin).padEnd(32)
    console.log(`  ${consistent ? 'ok  ' : 'FAIL'} ${shown}${ok ? 'accepted' : 'refused '}  ${why}`)
  }

  if (failed) {
    console.log(`\n${failed} case(s) behaved the wrong way.\n`)
    process.exit(1)
  }
  console.log('\nall origins behaved as intended\n')
})()
