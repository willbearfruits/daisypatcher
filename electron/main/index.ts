import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getSdkStatus, installSdk, installEsp32Toolchain, WORKSPACE } from './sdk'
import { buildProject, isInside, type BuildInput } from './buildService'
import { detectFlashDevices, flashBinary } from './flashService'
import { detectAllBoards } from './deviceDetection'
import {
  listSerialPorts,
  openSerial,
  closeSerial,
  writeSerial
} from './serialService'
import { initAutoUpdater } from './updater'

const isDev = !app.isPackaged

const FILE_FILTERS = [
  { name: 'Daisy Patch', extensions: ['dpatch', 'json'] },
  { name: 'All Files', extensions: ['*'] }
]

/**
 * Minimal extension gate for the renderer-side fs bridge. We only let the
 * renderer read/write `.dpatch` and `.json` paths — every other path is
 * rejected. This is not a security boundary (a compromised renderer could
 * still bypass via other APIs), it's a foot-gun guard so bugs in the
 * frontend can't scribble on arbitrary files.
 */
function isAllowedPath(p: string): boolean {
  const lower = p.toLowerCase()
  return lower.endsWith('.dpatch') || lower.endsWith('.json')
}

function registerIpcHandlers(): void {
  ipcMain.handle('dialog:save', async (_evt, defaultName: string) => {
    const focused = BrowserWindow.getFocusedWindow()
    const result = focused
      ? await dialog.showSaveDialog(focused, {
          title: 'Save Patch',
          defaultPath: defaultName || 'untitled.dpatch',
          filters: FILE_FILTERS
        })
      : await dialog.showSaveDialog({
          title: 'Save Patch',
          defaultPath: defaultName || 'untitled.dpatch',
          filters: FILE_FILTERS
        })
    return { canceled: result.canceled, path: result.filePath }
  })

  ipcMain.handle('dialog:open', async () => {
    const focused = BrowserWindow.getFocusedWindow()
    const result = focused
      ? await dialog.showOpenDialog(focused, {
          title: 'Open Patch',
          properties: ['openFile'],
          filters: FILE_FILTERS
        })
      : await dialog.showOpenDialog({
          title: 'Open Patch',
          properties: ['openFile'],
          filters: FILE_FILTERS
        })
    return { canceled: result.canceled, path: result.filePaths[0] }
  })

  ipcMain.handle('fs:writeFile', async (_evt, path: string, content: string) => {
    if (!isAllowedPath(path)) {
      throw new Error(`refusing to write non-patch file: ${path}`)
    }
    await writeFile(path, content, 'utf8')
  })

  ipcMain.handle('fs:readFile', async (_evt, path: string) => {
    if (!isAllowedPath(path)) {
      throw new Error(`refusing to read non-patch file: ${path}`)
    }
    return await readFile(path, 'utf8')
  })

  // ---- SDK / compile / flash ----
  //
  // Progress is always broadcast to the BrowserWindow that owns the
  // invoking WebContents. This is the idiomatic Electron pattern and
  // keeps us from having to track window IDs ourselves.
  const emitter = (channel: string, event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return (line: string): void => {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, line)
      }
    }
  }

  ipcMain.handle('sdk:status', async () => {
    return await getSdkStatus()
  })

  ipcMain.handle('sdk:install', async (evt) => {
    const emit = emitter('sdk:progress', evt)
    try {
      await installSdk(emit)
      return { success: true }
    } catch (err) {
      const msg = (err as Error).message || String(err)
      emit(`[error] ${msg}`)
      // Re-throw so ipcRenderer.invoke rejects and the renderer's
      // `catch` sees a real error. Previously we returned {success:false}
      // silently which made the modal look like nothing happened.
      throw new Error(msg)
    }
  })

  // ESP32 toolchain install reuses the sdk:progress channel so the modal's
  // existing log-tail UI picks up output without a second subscription path.
  ipcMain.handle('esp32:install', async (evt) => {
    const emit = emitter('sdk:progress', evt)
    try {
      await installEsp32Toolchain(emit)
      return { success: true }
    } catch (err) {
      const msg = (err as Error).message || String(err)
      emit(`[error] ${msg}`)
      throw new Error(msg)
    }
  })

  ipcMain.handle('build:run', async (evt, input: BuildInput) => {
    const emit = emitter('build:progress', evt)
    const result = await buildProject(input, emit)
    // Log still goes over the wire so the caller can store scrollback
    // without a second round-trip — it's already tail-bounded.
    return result
  })

  ipcMain.handle('flash:detect', async (_evt, target?: 'daisy_seed' | 'esp32_s3') => {
    return await detectFlashDevices(target ?? 'daisy_seed')
  })

  // Cross-target autodetection. Non-breaking sibling of flash:detect — this
  // one is target-agnostic and drives the renderer's auto-target-switch.
  ipcMain.handle('device:detect', async () => {
    return await detectAllBoards()
  })

  ipcMain.handle(
    'flash:run',
    async (
      evt,
      payload: {
        binaryPath: string
        target?: 'daisy_seed' | 'esp32_s3'
        daisyFlashMode?: 'internal' | 'qspi' | 'sram'
      }
    ) => {
      const emit = emitter('flash:progress', evt)
      // Back-compat: accept a bare string as the Daisy path for callers
      // that haven't adopted the new payload yet.
      const binaryPath = typeof payload === 'string' ? payload : payload.binaryPath
      const target: 'daisy_seed' | 'esp32_s3' =
        typeof payload === 'string' ? 'daisy_seed' : payload.target ?? 'daisy_seed'
      const daisyFlashMode: 'internal' | 'qspi' | 'sram' =
        typeof payload === 'string' ? 'qspi' : payload.daisyFlashMode ?? 'qspi'

      // Defense in depth: refuse to flash anything outside WORKSPACE. Stops
      // a compromised renderer from asking us to spawn dfu-util against an
      // arbitrary file on disk.
      const workspaceAbs = resolve(WORKSPACE)
      const fileAbs = resolve(binaryPath)
      if (!isInside(workspaceAbs, fileAbs)) {
        throw new Error(`refusing to flash outside workspace: ${binaryPath}`)
      }

      return await flashBinary(binaryPath, emit, target, daisyFlashMode)
    }
  )

  // ---- Serial monitor ----
  //
  // A single port is held open by serialService; repeated `serial:open`
  // calls auto-close the prior. Each complete line is forwarded to the
  // renderer that invoked the open — we resolve the window at open time
  // and cache the `emit` so late-arriving lines still land correctly even
  // if another window later takes focus.
  ipcMain.handle('serial:list', async () => {
    return await listSerialPorts()
  })

  ipcMain.handle(
    'serial:open',
    async (evt, payload: { path: string; baud: number }) => {
      const emit = emitter('serial:line', evt)
      try {
        await openSerial(payload.path, payload.baud, emit)
        return { success: true }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('serial:close', async () => {
    await closeSerial()
  })

  ipcMain.handle('serial:write', async (_evt, payload: { text: string }) => {
    await writeSerial(payload.text)
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#07090c',
    webPreferences: {
      // Preload is forced to CJS (electron.vite.config.ts) because
      // sandboxed preload scripts must be CommonJS in Electron. Keep this
      // path as `.js`.
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    // Pop DevTools open in dev so runtime errors (and main→renderer IPC
    // progress) are immediately visible. Closed on release builds.
    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
    // Auto-updater is a hard no-op in dev — electron-updater throws on
    // unsigned/dev builds because there's no `app-update.yml` on disk.
    // Guard the entire wire-up behind `app.isPackaged`.
    if (app.isPackaged) {
      initAutoUpdater(win)
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
