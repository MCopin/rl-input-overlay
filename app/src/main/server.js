const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}

// Serves public/ over local HTTP (for the overlay window AND the OBS browser
// source) and broadcasts action state over WebSocket on the same port.
function createServer(publicDir, port) {
  // Messages replayed to every new client (overlay window, OBS source): without
  // this, a page opened late would be left with no settings and no state.
  //
  // Two families go by here: what the app decides ('display', 'source', keyed
  // on `type`) and what the plugin says, relayed unchanged ('settings',
  // 'input', keyed on `t`). The order matters on replay — settings before the
  // frame that is shaped with them.
  const STICKY = ['display', 'source', 'settings', 'input']
  const kindOf = obj => obj.type || obj.t
  const sticky = new Map()

  const srv = http.createServer((req, res) => {
    let p = (req.url || '/').split('?')[0]
    if (p === '/') p = '/overlay.html'
    const file = path.join(publicDir, path.normalize(p))
    if (!file.startsWith(publicDir)) {
      res.writeHead(403)
      return res.end()
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('not found')
      } else {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
        res.end(data)
      }
    })
  })

  const wss = new WebSocketServer({ server: srv })
  wss.on('connection', ws => {
    for (const type of STICKY) {
      const msg = sticky.get(type)
      if (msg) ws.send(msg)
    }
  })

  srv.listen(port, '127.0.0.1')

  return {
    broadcast(obj) {
      const msg = JSON.stringify(obj)
      const kind = kindOf(obj)
      if (STICKY.includes(kind)) sticky.set(kind, msg)
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(msg)
      }
    },
  }
}

module.exports = { createServer }
