// BakkesMod RCON client: sends commands to the game's console.
// Used by build.ps1 to reload the plugin without restarting Rocket League.
// `ws` lives with the app: the plugin has no package.json of its own, and this
// script is a build tool rather than part of what ships.
const path = require('path')
const WebSocket = require(path.join(__dirname, '..', 'app', 'node_modules', 'ws'))

const password = process.env.BM_RCON_PASSWORD
const port = process.env.BM_RCON_PORT || 9002
const commands = process.argv.slice(2)

if (!password) {
  console.error('BM_RCON_PASSWORD missing (use rcon.ps1)')
  process.exit(1)
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`)
const timer = setTimeout(() => {
  console.error('rcon timeout: is Rocket League running?')
  process.exit(1)
}, 8000)

ws.on('open', () => ws.send(`rcon_password ${password}`))

ws.on('message', data => {
  const msg = data.toString().trim()
  if (msg === 'authno') {
    console.error('rcon password refused')
    process.exit(1)
  }
  if (msg !== 'authyes') return
  for (const c of commands) ws.send(c)
  // Give the game time to process before hanging up.
  setTimeout(() => {
    clearTimeout(timer)
    ws.close()
    process.exit(0)
  }, 1200)
})

ws.on('error', e => {
  console.error('rcon error:', e.message)
  process.exit(1)
})
