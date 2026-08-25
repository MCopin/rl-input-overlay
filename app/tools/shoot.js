// Renders an HTML page to a PNG, using the Electron the repo already has.
//
//   npx electron tools/shoot.js build/icon.html build/icon.png 512 512
//
// Used for the app icon, so what ships is regenerated from a file under version
// control rather than from a binary nobody can edit.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

const [pageArg, outArg, wArg, hArg] = process.argv.slice(2)
if (!pageArg || !outArg) {
  console.error('usage: electron tools/shoot.js <page.html> <out.png> [width] [height]')
  process.exit(1)
}
const PAGE = path.resolve(pageArg)
const OUT = path.resolve(outArg)
const W = Number(wArg) || 512
const H = Number(hArg) || 512

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H,
    useContentSize: true,
    frame: false,
    show: true,            // an offscreen window never paints: the shot would be blank
    transparent: true,     // icons need the corners to be see-through
    backgroundColor: '#00000000',
  })
  await win.loadFile(PAGE)
  await new Promise(r => setTimeout(r, 800))
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, img.toPNG())
  const s = img.getSize()
  console.log(`${path.relative(process.cwd(), OUT)}  ${s.width}x${s.height}  `
    + `${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`)
  app.quit()
}).catch(e => { console.error(e); app.exit(1) })
