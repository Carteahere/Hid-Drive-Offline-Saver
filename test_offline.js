// Verify offline serving + WebHID availability from a captured archive.
const { app, BrowserWindow, session } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')

app.commandLine.appendSwitch('disable-hid-blocklist')
app.commandLine.appendSwitch('disable-http2')
app.commandLine.appendSwitch('no-proxy-server')

const ARCHIVE_DIR = path.join(__dirname, 'test_out')

function log (m) {
  fs.appendFileSync(path.join(__dirname, 'offline_progress.log'), m + '\n')
}

function createOfflineServer (archiveDir, manifest) {
  const byPath = new Map()
  const byUrl = new Map()
  for (const f of manifest.files) {
    byUrl.set(f.url, f)
    try {
      const u = new URL(f.url)
      let p = u.pathname
      if (u.search) p += u.search
      if (!byPath.has(p)) byPath.set(p, f)
      if (u.pathname === '/' && p === '/') byPath.set('/', f)
    } catch (e) {}
  }
  const server = http.createServer((req, res) => {
    let reqUrl
    try { reqUrl = new URL(req.url, 'http://127.0.0.1') } catch (e) { res.writeHead(400); res.end(); return }
    const uParam = reqUrl.searchParams.get('u')
    if (uParam) {
      const f = byUrl.get(uParam)
      if (f) return sendFile(res, f)
    }
    let key = reqUrl.pathname
    if (reqUrl.search) key += reqUrl.search
    let f = byPath.get(key)
    if (!f && key === '/') f = byPath.get('/')
    if (!f) { res.writeHead(404); res.end('not found'); return }
    sendFile(res, f)
  })
  function sendFile (res, f) {
    let p = path.join(archiveDir, 'data', path.basename(f.file))
    if (!fs.existsSync(p)) p = path.join(archiveDir, path.basename(f.file))
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return }
      res.writeHead(f.status || 200, {
        'Content-Type': f.mimeType || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(data)
    })
  }
  return server
}

async function run () {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, 'manifest.json'), 'utf8'))
    const server = createOfflineServer(ARCHIVE_DIR, manifest)
    const ses = session.fromPartition('offline-test')

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      const origin = `http://127.0.0.1:${port}`
      log('SERVER ' + origin)

      ses.webRequest.onBeforeRequest((details, callback) => {
        const u = details.url
        if (u.startsWith(origin)) { callback({}); return }
        const f = manifest.files.find((x) => x.url === u)
        if (f) callback({ redirectURL: `${origin}?u=${encodeURIComponent(u)}` })
        else callback({})
      })

      ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
        if (permission === 'hid') return true
        if (permission === 'fullscreen') return true
        if (permission === 'pointerLock') return true
        return false
      })
      ses.setDevicePermissionHandler((details) => details.deviceType === 'hid')
      ses.on('select-hid-device', (event, details, callback) => {
        event.preventDefault()
        const devices = details.deviceList || []
        callback(devices.length > 0 ? devices[0].deviceId : '')
      })

      const win = new BrowserWindow({
        width: 1280, height: 900, show: false,
        webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false }
      })

      win.webContents.on('did-finish-load', async () => {
        await new Promise((r) => setTimeout(r, 3000))
        const title = await win.webContents.executeJavaScript('document.title').catch(() => 'ERR')
        const hidAvailable = await win.webContents.executeJavaScript(
          'typeof navigator !== "undefined" && typeof navigator.hid !== "undefined"'
        ).catch(() => 'ERR')
        const bodyLen = await win.webContents.executeJavaScript('document.body ? document.body.innerHTML.length : -1').catch(() => -1)
        const httpStatus = await win.webContents.executeJavaScript(
          'fetch("/", {method:"GET"}).then(r => r.status).catch(e => "fetch-err:" + e)'
        ).catch(() => 'ERR')
        log('TITLE=' + title)
        log('HID_AVAILABLE=' + hidAvailable)
        log('BODY_LEN=' + bodyLen)
        log('FETCH_ROOT_STATUS=' + httpStatus)
        console.log('TITLE=' + title)
        console.log('HID_AVAILABLE=' + hidAvailable)
        console.log('BODY_LEN=' + bodyLen)
        console.log('FETCH_ROOT_STATUS=' + httpStatus)
        fs.writeFileSync(path.join(__dirname, 'offline_done.flag'), 'ok')
        server.close()
        app.exit(0)
      })

      win.webContents.on('did-fail-load', (e, code, desc) => {
        log('FAIL_LOAD code=' + code + ' desc=' + desc)
        fs.writeFileSync(path.join(__dirname, 'offline_done.flag'), 'fail')
        server.close()
        app.exit(1)
      })

      win.loadURL(origin + '/')
    })
  } catch (e) {
    log('FATAL ' + e.stack)
    fs.writeFileSync(path.join(__dirname, 'offline_done.flag'), 'err: ' + e)
    app.exit(1)
  }
}

app.whenReady().then(run)
