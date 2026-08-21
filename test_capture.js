// Test harness: capture the target URL automatically without needing Ctrl+Shift+S.
const { app, BrowserWindow, session } = require('electron')
const path = require('path')
const fs = require('fs')

app.commandLine.appendSwitch('disable-hid-blocklist')
app.commandLine.appendSwitch('disable-http2')
app.commandLine.appendSwitch('no-proxy-server')

const OUT_DIR = path.join(__dirname, 'test_out')
const DONE_FILE = path.join(__dirname, 'test_done.flag')

function log (m) {
  fs.appendFileSync(path.join(__dirname, 'test_progress.log'), m + '\n')
}

async function run () {
  try {
    fs.rmSync(OUT_DIR, { recursive: true, force: true })
    fs.mkdirSync(OUT_DIR, { recursive: true })
    log('START')

    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        session: session.fromPartition('test-capture')
      }
    })
    log('WIN_OK')

    await win.loadURL('https://h0b11.yjx2012.com/').catch((e) => log('LOAD_ERR ' + e))
    log('LOADED')

    const bodies = new Map() // requestId -> {url, mimeType, status}
    const collected = new Map() // url -> {mimeType, status, data}

    // attach AFTER page loaded (Network.enable hangs on empty target)
    win.webContents.debugger.attach('1.3')
    win.webContents.debugger.on('message', (event, method, params) => {
      if (method === 'Network.responseReceived') {
        const { requestId, response } = params
        if (response && response.url && response.url.startsWith('http')) {
          if (!bodies.has(requestId)) {
            bodies.set(requestId, {
              url: response.url,
              mimeType: response.mimeType || 'application/octet-stream',
              status: response.status
            })
          }
        }
      } else if (method === 'Network.loadingFinished') {
        const requestId = params.requestId
        const meta = bodies.get(requestId)
        if (meta && !collected.has(meta.url)) {
          win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
            .then((res) => {
              const data = res && res.body !== undefined
                ? (res.base64Encoded ? Buffer.from(res.body, 'base64') : Buffer.from(res.body, 'utf8'))
                : null
              if (data && data.length > 0) {
                collected.set(meta.url, { mimeType: meta.mimeType, status: meta.status, data })
              }
            }).catch(() => {})
        }
      }
    })
    await win.webContents.debugger.sendCommand('Network.enable')
    log('NETWORK_ENABLED')

    // reload to re-capture all resources through CDP
    await win.webContents.reload()
    await new Promise((resolve) => setTimeout(resolve, 15000))
    log('COLLECTED=' + collected.size)

    // ensure we have the root HTML even if CDP missed it
    if (![...collected.keys()].some((u) => new URL(u).pathname === '/')) {
      const https = require('https')
      const html = await new Promise((resolve) => {
        https.get('https://h0b11.yjx2012.com/', (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks)))
        }).on('error', () => resolve(null))
      })
      if (html) {
        collected.set('https://h0b11.yjx2012.com/', {
          mimeType: 'text/html',
          status: 200,
          data: html
        })
        log('FETCHED_ROOT_HTML')
      }
    }

    const files = []
    let idx = 0
    for (const [url, item] of collected) {
      const file = String(idx++) + '.bin'
      fs.writeFileSync(path.join(OUT_DIR, file), item.data)
      files.push({ url, mimeType: item.mimeType, status: item.status, size: item.data.length, file })
    }
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
      entryUrl: 'https://h0b11.yjx2012.com/',
      capturedAt: Date.now(),
      files
    }, null, 2))

    console.log('CAPTURED_FILES=' + files.length)
    console.log('TOTAL_BYTES=' + files.reduce((s, f) => s + f.size, 0))
    for (const f of files.slice(0, 30)) {
      console.log(f.url, '->', f.mimeType, f.size)
    }
    log('DONE')
    fs.writeFileSync(DONE_FILE, 'ok')
  } catch (e) {
    log('FATAL ' + e.stack)
    fs.writeFileSync(DONE_FILE, 'err: ' + e)
  }
  app.exit(0)
}

app.whenReady().then(run)
