const WebSocket = require('ws')
const { EventEmitter } = require('events')

// Must track rloverlay_ws_port in the plugin, and PLUGIN_WS in overlay.js.
const PLUGIN_PORT = 49200
const PLUGIN_WS = `ws://127.0.0.1:${PLUGIN_PORT}`
const RETRY_MS = 1000

// Bridge to the BakkesMod plugin, and the overlay's only source. The plugin
// serves a WebSocket and pushes one JSON document per message; we just keep
// reconnecting as long as RL isn't there.
//
// This used to be a named pipe client, and the pipe's limit is why it isn't:
// a pipe serves one client, so the app had to be the sole reader and relay to
// everyone else. Now a page can reach the plugin without us — see
// docs/architecture.md.
//
// There was also a time when a controller/keyboard path served as a fallback.
// It has been removed: ground contact, speed and flip availability don't exist
// in the inputs, and a flip reset puts them out of reach on principle
// (docs/sources.md).
class BakkesBridge extends EventEmitter {
  constructor(url = PLUGIN_WS) {
    super()
    this.url = url
    this.socket = null
    this.connected = false
    this.settings = null
    this.stopped = false
    this.retryTimer = null
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.terminate()
    }
    this.socket = null
  }

  connect() {
    if (this.stopped) return
    const ws = new WebSocket(this.url)
    this.socket = ws

    ws.on('open', () => {
      this.connected = true
      this.emit('status', this.statusPayload())
    })

    ws.on('message', data => this.onMessage(data))

    // ECONNREFUSED as long as RL/BakkesMod isn't running: stay silent, retry.
    // 'close' follows an error, so the retry is scheduled there.
    ws.on('error', () => {})

    ws.on('close', () => {
      const wasConnected = this.connected
      this.connected = false
      this.settings = null
      if (wasConnected) this.emit('status', this.statusPayload())
      this.scheduleRetry()
    })
  }

  scheduleRetry() {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.connect(), RETRY_MS)
  }

  onMessage(data) {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return // malformed: drop it rather than take the connection down
    }
    // Relayed as it stands: the app no longer interprets the frames, it
    // carries them. Shaping them here as well would be a second
    // implementation to keep in step with the page's, for nothing.
    if (msg.t === 'input') this.emit('input', msg)
    else if (msg.t === 'settings') {
      this.settings = msg
      this.emit('settings', msg)
      this.emit('status', this.statusPayload())
    }
  }

  statusPayload() {
    return {
      connected: this.connected,
      settings: this.settings,
    }
  }
}

module.exports = { BakkesBridge, PLUGIN_WS, PLUGIN_PORT }
