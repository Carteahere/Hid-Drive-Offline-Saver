const { app, BrowserWindow, ipcMain, dialog, Menu, session, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')

app.commandLine.appendSwitch('disable-hid-blocklist')
app.commandLine.appendSwitch('disable-http2')
app.commandLine.appendSwitch('no-proxy-server')

const ARCHIVES_DIR = path.join(app.getPath('userData'), 'archives')

let mainWindow = null
let captureState = null

function ensureArchivesDir () {
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true })
}

function sanitizeName (name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 120)
}

function readArchives () {
  ensureArchivesDir()
  const out = []
  for (const id of fs.readdirSync(ARCHIVES_DIR)) {
    const dir = path.join(ARCHIVES_DIR, id)
    const manifestPath = path.join(dir, 'manifest.json')
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(manifestPath)) continue
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      out.push({
        id,
        entryUrl: m.entryUrl,
        capturedAt: m.capturedAt,
        fileCount: m.files.length,
        size: m.files.reduce((s, f) => s + f.size, 0)
      })
    } catch (e) {}
  }
  return out.sort((a, b) => b.capturedAt - a.capturedAt)
}

// ---------- CDP capture ----------

// Grant WebHID + common permissions to a session, with device picker.
function setupHidPermission (ses) {
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (permission === 'hid') return true
    if (permission === 'fullscreen') return true
    if (permission === 'pointerLock') return true
    if (permission === 'notifications') return true
    if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') return true
    return false
  })

  ses.setDevicePermissionHandler((details) => {
    return details.deviceType === 'hid'
  })

  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault()
    const devices = details.deviceList || []
    if (devices.length === 0) {
      callback()
      return
    }
    if (devices.length === 1 || process.env.E2E === '1') {
      callback(devices[0].deviceId)
      return
    }
    const items = devices.map((d, i) => ({
      label: `${d.name || 'HID device'} (${d.vendorId ? '0x' + d.vendorId.toString(16) : '?'}:${d.productId ? '0x' + d.productId.toString(16) : '?'})`,
      value: i
    }))
    const bwin = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    dialog.showMessageBox(bwin, {
      type: 'question',
      buttons: [...items.map((i) => i.label), '取消'],
      title: '选择 HID 设备',
      message: '页面请求访问多个 HID 设备，请选择：'
    }).then(({ response }) => {
      if (response < devices.length) {
        callback(devices[response].deviceId)
      } else {
        callback()
      }
    })
  })
}

// Menu bar for windows showing a live/offline HID page.
function buildHidMenu (win, onCapture) {
  return Menu.buildFromTemplate([
    {
      label: '采集',
      click: onCapture
    },
    { type: 'separator' },
    {
      label: '刷新',
      click: () => win.webContents.reload()
    },
    { type: 'separator' },
    {
      label: '放大',
      click: () => {
        const level = win.webContents.getZoomLevel() + 0.5
        win.webContents.setZoomLevel(Math.max(-3, Math.min(3, level)))
      }
    },
    {
      label: '缩小',
      click: () => {
        const level = win.webContents.getZoomLevel() - 0.5
        win.webContents.setZoomLevel(Math.max(-3, Math.min(3, level)))
      }
    }
  ])
}

async function startCapture (url) {
  if (captureState) {
    captureState.win.focus()
    return captureState
  }

  const captureSession = session.fromPartition('capture-partition')
  setupHidPermission(captureSession)

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: '采集窗口 - 操作完按 Ctrl+Shift+S 保存',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: captureSession
    }
  })

  win.setMenu(buildHidMenu(win, () => finalizeCapture()))

  const state = {
    win,
    url,
    bodies: new Map(), // requestId -> {url, mimeType, status}
    collected: new Map() // url -> {mimeType, status, data}
  }
  captureState = state

  // Load a blank page first so the debugger target is ready (Network.enable
  // hangs on an empty target), then attach before navigating to the real URL.
  win.webContents.debugger.attach('1.3')
  await win.webContents.loadURL('about:blank')

  win.webContents.debugger.on('message', (event, method, params) => {
    if (method === 'Network.responseReceived') {
      const { requestId, response } = params
      if (response && response.url && response.url.startsWith('http')) {
        if (!state.bodies.has(requestId)) {
          state.bodies.set(requestId, {
            url: response.url,
            mimeType: response.mimeType || 'application/octet-stream',
            status: response.status
          })
        }
      }
    } else if (method === 'Network.loadingFinished') {
      const requestId = params.requestId
      const meta = state.bodies.get(requestId)
      if (meta && !state.collected.has(meta.url)) {
        getBody(win.webContents, requestId).then((data) => {
          if (data && data.length > 0) {
            state.collected.set(meta.url, {
              mimeType: meta.mimeType,
              status: meta.status,
              data
            })
          }
        }).catch(() => {})
      }
    }
  })
  await win.webContents.debugger.sendCommand('Network.enable')

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 's') {
      event.preventDefault()
      finalizeCapture()
    }
  })

  win.on('closed', () => {
    captureState = null
  })

  win.loadURL(url)
  return state
}

async function getBody (webContents, requestId) {
  try {
    const res = await webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
    if (!res || res.body === undefined) return null
    if (res.base64Encoded) return Buffer.from(res.body, 'base64')
    return Buffer.from(res.body, 'utf8')
  } catch (e) {
    return null
  }
}

async function finalizeCapture () {
  if (!captureState) return
  const state = captureState
  captureState = null

  const { win } = state
  const collected = state.collected

  // wait briefly for in-flight getBody promises to settle
  await new Promise((resolve) => setTimeout(resolve, 500))

  try {
    if (win.webContents.debugger.isAttached()) {
      win.webContents.debugger.detach()
    }
  } catch (e) {}

  win.destroy()

  if (collected.size === 0) {
    if (process.env.E2E !== '1') {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: '没有采集到任何资源',
        detail: '请确认网络可访问该页面。'
      })
    }
    return null
  }

  const id = `${Date.now()}_${sanitizeName(new URL(state.url).hostname)}`
  const dir = path.join(ARCHIVES_DIR, id)
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const files = []
  let idx = 0
  for (const [url, item] of collected) {
    const file = String(idx++) + '.bin'
    fs.writeFileSync(path.join(dataDir, file), item.data)
    files.push({ url, mimeType: item.mimeType, status: item.status, size: item.data.length, file })
  }

  const manifest = { entryUrl: state.url, capturedAt: Date.now(), files }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('archives-changed')
  }

  if (process.env.E2E !== '1') {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: '采集完成',
      detail: `已保存 ${files.length} 个资源到离线存档。现在可以在列表中打开它（离线 + WebHID 可用）。`
    })
  }

  return id
}

// ---------- offline server ----------

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
    try {
      reqUrl = new URL(req.url, 'http://127.0.0.1')
    } catch (e) {
      res.writeHead(400)
      res.end()
      return
    }

    // ?u=full-url lookup (used for cross-origin redirects)
    const uParam = reqUrl.searchParams.get('u')
    if (uParam) {
      const f = byUrl.get(uParam)
      if (f) return sendFile(res, f)
    }

    let key = reqUrl.pathname
    if (reqUrl.search) key += reqUrl.search
    let f = byPath.get(key)
    if (!f && key === '/') f = byPath.get('/')
    if (!f) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    sendFile(res, f)
  })

  function sendFile (res, f) {
    // support both <dir>/data/<file> and <dir>/<file> layouts
    let p = path.join(archiveDir, 'data', path.basename(f.file))
    if (!fs.existsSync(p)) p = path.join(archiveDir, path.basename(f.file))
    fs.readFile(p, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end()
        return
      }
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

function openOffline (archiveId) {
  const dir = path.join(ARCHIVES_DIR, archiveId)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    dialog.showErrorBox('错误', '存档不存在: ' + archiveId)
    return
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const server = createOfflineServer(dir, manifest)
  const offlineSession = session.fromPartition('offline-' + archiveId)

  const port = 0
  server.listen(port, '127.0.0.1', () => {
    const actualPort = server.address().port
    const origin = `http://127.0.0.1:${actualPort}`

    // Redirect requests that point back to the original host -> offline copy
    offlineSession.webRequest.onBeforeRequest((details, callback) => {
      const u = details.url
      if (u.startsWith(origin)) {
        callback({})
        return
      }
      const f = manifest.files.find((x) => x.url === u)
      if (f) {
        callback({ redirectURL: `${origin}?u=${encodeURIComponent(u)}` })
      } else {
        callback({})
      }
    })

    setupHidPermission(offlineSession)

    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      title: `离线 - ${manifest.entryUrl}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: offlineSession
      }
    })

    win.setMenu(buildHidMenu(win, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
    }))

    win.on('closed', () => {
      try { server.close() } catch (e) {}
    })

    win.loadURL(origin + '/')
  })
}

// ---------- main window ----------

function createMainWindow () {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 620,
    title: '网页HID离线保存器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.setMenu(null)
  mainWindow.loadFile('index.html')
}

ipcMain.handle('capture:start', async (e, url) => {
  if (!url || !/^https?:\/\//.test(url)) throw new Error('请输入 http(s):// 开头的网址')
  const state = await startCapture(url)
  return state ? true : false
})

ipcMain.handle('archive:list', () => readArchives())

ipcMain.handle('archive:open', (e, id) => {
  openOffline(id)
  return true
})

ipcMain.handle('archive:delete', (e, id) => {
  const dir = path.join(ARCHIVES_DIR, id)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  return true
})

ipcMain.handle('archive:openFolder', () => {
  ensureArchivesDir()
  shell.openPath(ARCHIVES_DIR)
  return true
})

app.whenReady().then(() => {
  ensureArchivesDir()
  Menu.setApplicationMenu(null)
  createMainWindow()
  if (process.env.E2E === '1') runE2E()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// E2E self-test: capture -> save -> open offline -> verify HID, then exit.
async function runE2E () {
  const out = (m) => {
    require('fs').appendFileSync(path.join(__dirname, 'e2e.log'), m + '\n')
    console.log(m)
  }
  try {
    // main window UI sanity check
    if (mainWindow) {
      const ui = await mainWindow.webContents.executeJavaScript(
        `({ url: !!document.getElementById('url'), msgErr: !!document.getElementById('msgError'), msgInfo: !!document.getElementById('msgInfo'), confirm: !!document.getElementById('confirmBar'), sub: document.querySelector('.sub') ? document.querySelector('.sub').textContent : '' })`
      )
      out('MAIN_UI=' + JSON.stringify(ui))
    }

    await startCapture('https://h0b11.yjx2012.com/')
    await new Promise((r) => setTimeout(r, 15000))

    // capture window menu + HID check (must be before finalizeCapture destroys it)
    const capWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('https://h0b11.yjx2012.com/'))
    if (capWin) {
      out('CAPTURE_MENUBAR=' + capWin.isMenuBarVisible())
      const hidInCapture = await capWin.webContents.executeJavaScript('typeof navigator.hid !== "undefined"')
      out('CAPTURE_HID=' + hidInCapture)
    } else {
      out('CAPTURE_MENUBAR=NO_WINDOW')
    }

    await finalizeCapture()
    out('CAPTURE_SAVED')

    const archives = readArchives()
    out('ARCHIVE_COUNT=' + archives.length)
    const id = archives[0].id
    const dir = path.join(ARCHIVES_DIR, id)
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    out('ARCHIVE_FILES=' + manifest.files.length)

    // open offline and verify
    await new Promise((resolve) => {
      openOffline(id)
      // find the offline window by polling
      const timer = setInterval(() => {
        const offWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('http://127.0.0.1'))
        if (offWin) {
          clearInterval(timer)
          setTimeout(async () => {
            try {
              const title = await offWin.webContents.executeJavaScript('document.title')
              const hid = await offWin.webContents.executeJavaScript('typeof navigator.hid !== "undefined"')
              const appMenu = Menu.getApplicationMenu()
              const appMenuLabels = appMenu ? appMenu.items.map((x) => x.type === 'separator' ? '|' : x.label).join(',') : 'NULL'
              const mainMenuBar = mainWindow.isMenuBarVisible()
              const offMenuBar = offWin.isMenuBarVisible()
              out('OFFLINE_TITLE=' + title)
              out('OFFLINE_HID=' + hid)
              out('APP_MENU=' + appMenuLabels)
              out('MAIN_MENUBAR=' + mainMenuBar)
              out('OFFLINE_MENUBAR=' + offMenuBar)
            } catch (e) {
              out('OFFLINE_VERIFY_ERR ' + e)
            }
            resolve()
          }, 4000)
        }
      }, 500)
    })

    out('E2E_DONE')
  } catch (e) {
    out('E2E_FATAL ' + (e && e.stack ? e.stack : e))
  }
  app.exit(0)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
