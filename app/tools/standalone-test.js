// Opens the packed overlay the way an OBS user would, and checks it works with
// no app in the loop.
//
//   npm run pack && npm run standalone
//
// It extracts the ZIP from dist/ rather than reading app/public/, so a file
// left out of the archive fails here instead of failing for whoever downloads
// it. And it opens the page with **no query string**: wire-test's direct half
// passes ?ws=..., so the endpoint fallback in overlay.js — the only thing a
// real user relies on — is exercised nowhere else.
//
// Needs Rocket League running with the plugin loaded; skips otherwise.
const { app, BrowserWindow, protocol, net: enet } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const { pathToFileURL } = require('url')
const { execFileSync } = require('child_process')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

const PLUGIN_PORT = 49200
const DIST = path.join(__dirname, '..', '..', 'dist')
const FILES = ['overlay.html', 'overlay.css', 'overlay.js', 'actions.js']

const sleep = ms => new Promise(r => setTimeout(r, ms))

function reachable(port) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1')
    const done = ok => { s.destroy(); resolve(ok) }
    s.setTimeout(1500, () => done(false))
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  })
}

function newestZip() {
  if (!fs.existsSync(DIST)) return null
  const zips = fs.readdirSync(DIST)
    .filter(f => /^rl-input-overlay-.*\.zip$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(DIST, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return zips.length ? path.join(DIST, zips[0].f) : null
}

const fails = []
function check(name, got, want) {
  const ok = got === want
  if (!ok) fails.push(name)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`
    + (ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}

app.whenReady().then(async () => {
  const zip = newestZip()
  if (!zip) {
    console.log('\nno packed overlay in dist/ — run `npm run pack` first.\n')
    return app.exit(1)
  }

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-pack-'))
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`])

  console.log(`\n${path.basename(zip)}\n`)
  for (const f of FILES) {
    check(`${f} is in the archive`, fs.existsSync(path.join(out, f)), true)
  }
  if (fails.length) {
    console.log(`\n${fails.length} FAILED: ${fails.join(', ')}\n`)
    return app.exit(1)
  }

  if (!(await reachable(PLUGIN_PORT))) {
    console.log(`\n  skipped — nothing listening on ${PLUGIN_PORT}.`)
    console.log('  Start Rocket League with BakkesMod and the plugin loaded.\n')
    return app.exit(0)
  }

  const win = new BrowserWindow({
    width: 340, height: 600, show: true, frame: false, alwaysOnTop: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: false },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.error(`  [page] ${message}`)
  })
  const js = c => win.webContents.executeJavaScript(c)

  await win.loadURL(`file://${out.replace(/\\/g, '/')}/overlay.html`)
  await sleep(1500)

  check('endpoint falls back to the plugin', await js('endpoint()'),
    `ws://127.0.0.1:${PLUGIN_PORT}`)
  check('settings arrived, no app involved', await js('settings ? settings.t : null'), 'settings')
  check('badge shows the source', await js("document.getElementById('srcBadge').textContent"), 'RL')
  console.log(`  (deadzone read from the game: ${await js('settings ? settings.deadzone : null')})`)

  // ---- the same page the way OBS actually loads it ----
  //
  // obs-browser does not open a local file as file://. It serves it under a
  // host of its own invention, `http://absolute/C:/…` (the string is in
  // obs-browser.dll). A page there is on http, so a naive "http means the app
  // is serving me" test sends it to ws://absolute, which answers nothing and
  // never falls back. That shipped, and only a real OBS caught it.
  console.log('\nas OBS loads it (http://absolute/…)')
  protocol.handle('http', request => {
    const u = new URL(request.url)
    if (u.hostname !== 'absolute') {
      return enet.fetch(request, { bypassCustomProtocolHandlers: true })
    }
    const file = decodeURIComponent(u.pathname).replace(/^\/+/, '')
    return enet.fetch(pathToFileURL(file).toString())
  })

  const obs = new BrowserWindow({
    width: 340, height: 600, show: true, frame: false, alwaysOnTop: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: false },
  })
  obs.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.error(`  [page] ${message}`)
  })
  const ojs = c => obs.webContents.executeJavaScript(c)

  await obs.loadURL(`http://absolute/${out.replace(/\\/g, '/')}/overlay.html`)
  await sleep(1500)

  check('page really is on OBS\'s made-up host', await ojs('location.host'), 'absolute')
  check('endpoint still finds the plugin', await ojs('endpoint()'),
    `ws://127.0.0.1:${PLUGIN_PORT}`)
  check('settings arrived under OBS', await ojs('settings ? settings.t : null'), 'settings')
  check('badge shows the source', await ojs("document.getElementById('srcBadge').textContent"), 'RL')
  obs.close()

  console.log(fails.length
    ? `\n${fails.length} FAILED: ${fails.join(', ')}\n`
    : '\nthe packed overlay works with nothing but RL and the plugin\n')
  app.exit(fails.length ? 1 : 0)
}).catch(e => { console.error(e); app.exit(1) })
