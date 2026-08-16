import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getSdkStatus, installSdk, installEsp32Toolchain, WORKSPACE } from './sdk'
import { addRecent, installAppMenu, readRecent, setRecentGrant } from './appMenu'
import { openExternalSafe, openPathSafe } from './openExternal'
import {
  complete as assistantComplete,
  listLocalModels,
  readConfigSafe,
  saveConfig,
  type CompletionRequest
} from './assistantService'
import {
  deleteSample,
  listSamples,
  readSamplePcm,
  renameSample,
  storeSample,
  type StoreSampleInput
} from './sampleService'
import { buildProject, isInside, writeProjectFiles, type BuildInput } from './buildService'
import { detectFlashDevices, flashBinary } from './flashService'
import { detectAllBoards } from './deviceDetection'
import type { BoardId } from '../../shared/boards'
import { coerceBoardId } from '../../shared/boards'
import {
  listSerialPorts,
  openSerial,
  closeSerial,
  writeSerial
} from './serialService'
import { initAutoUpdater } from './updater'

const isDev = !app.isPackaged

/*
 * Dev only: expose a Chrome DevTools Protocol endpoint so the renderer can
 * be driven and inspected from outside the window. Never in a packaged
 * build — an open debugging port in a shipped app is a remote-code hole.
 */
if (isDev && process.env.DP_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DP_CDP_PORT)
}
/*
 * Dev only: a separate userData so a dev instance can run beside the
 * installed app. Without this the single-instance lock — which is right
 * for users — makes `npm run dev` silently quit whenever the real app is
 * open, and the dev server logs nothing about why.
 */
if (isDev && process.env.DP_USER_DATA) {
  app.setPath('userData', process.env.DP_USER_DATA)
}

const FILE_FILTERS = [
  { name: 'Daisy Patch', extensions: ['dpatch', 'json'] },
  { name: 'All Files', extensions: ['*'] }
]

/**
 * Paths the user explicitly granted through a native open/save dialog this
 * session. The fs bridge only touches files on this list — which makes it a
 * real security boundary, not just a foot-gun guard: a compromised renderer
 * cannot read or clobber arbitrary `*.json` on disk, only files the user
 * has personally picked in a dialog. Every renderer flow (save, open)
 * starts with a dialog, so nothing legitimate is blocked.
 */
const grantedPaths = new Set<string>()

function grantPath(p: string | undefined): void {
  if (p) grantedPaths.add(resolve(p))
}

function hasPatchExt(p: string): boolean {
  const lower = p.toLowerCase()
  return lower.endsWith('.dpatch') || lower.endsWith('.json')
}

/**
 * Force a patch extension onto a path the user typed.
 *
 * GTK's save dialog does not reliably append the filter's extension, so a
 * user who types "mysong" gets back a bare path — which then fails the
 * allow-list below and surfaces as a confusing "not granted via a dialog"
 * error on a file they just picked in a dialog.
 */
function withPatchExt(p: string): string {
  return hasPatchExt(p) ? p : `${p}.dpatch`
}

function isAllowedPath(p: string): boolean {
  const abs = resolve(p)
  return hasPatchExt(abs) && grantedPaths.has(abs)
}


/* =====================================================================
 * Linux file-dialog fallback.
 *
 * Electron's own `dialog.showSaveDialog` / `showOpenDialog` never open a
 * window on some Linux desktops — verified here with a bare Electron app
 * (no daisypatcher code at all): the call is made, no chooser appears, and
 * the promise never settles. Forcing gtk-version 3 or 4, disabling the
 * sandbox, and reparenting the modal all made no difference, while
 * `kdialog` and `zenity` open a chooser on the same session immediately.
 *
 * So on Linux we prefer a desktop file-chooser binary when one exists and
 * fall back to Electron's dialog otherwise. Set DAISY_ELECTRON_DIALOGS=1
 * to always use Electron's, for anyone whose setup is fine.
 * ===================================================================== */

interface PickResult {
  canceled: boolean
  path?: string
}

function findHelper(): { bin: string; kind: 'kdialog' | 'zenity' } | null {
  if (process.platform !== 'linux') return null
  if (process.env.DAISY_ELECTRON_DIALOGS === '1') return null
  /*
   * zenity first, even on KDE, where kdialog would look more native.
   *
   * Chromium's own KDE file-dialog path shells out to kdialog, and on a
   * system where kdialog is broken that call never returns — the observed
   * failure was a kdialog child spinning at ~99% CPU for over an hour
   * without ever mapping a window, which is exactly why Electron's
   * built-in dialog hung too. zenity is GTK, independent of that stack,
   * and works on both desktops. DAISY_FILE_DIALOG=kdialog|zenity|electron
   * overrides the choice.
   */
  const forced = process.env.DAISY_FILE_DIALOG
  const zenity = { bin: '/usr/bin/zenity', kind: 'zenity' as const }
  const kdialog = { bin: '/usr/bin/kdialog', kind: 'kdialog' as const }
  if (forced === 'electron') return null
  if (forced === 'kdialog') return existsSync(kdialog.bin) ? kdialog : null
  if (forced === 'zenity') return existsSync(zenity.bin) ? zenity : null
  return [zenity, kdialog].find((c) => existsSync(c.bin)) ?? null
}

/** Run a chooser binary. Exit 0 = picked, anything else = cancelled. */
function runHelper(bin: string, args: string[]): Promise<PickResult> {
  return new Promise((resolvePromise) => {
    let settled = false
    const child = execFile(bin, args, { timeout: 10 * 60 * 1000 }, (err, stdout) => {
      if (settled) return
      settled = true
      const picked = String(stdout ?? '').trim().split('\n')[0]
      if (err || !picked) return resolvePromise({ canceled: true })
      resolvePromise({ canceled: false, path: picked })
    })
    /*
     * A chooser that never draws is indistinguishable from one the user is
     * still reading, so we can't time out on "slow". What we CAN catch is a
     * helper that dies or spins without ever producing a window: if the
     * process is gone and nothing was returned, settle rather than leaving
     * the renderer's promise pending forever, which is what made Save look
     * like it did nothing at all.
     */
    child.on('error', () => {
      if (settled) return
      settled = true
      resolvePromise({ canceled: true })
    })
  })
}

async function pickSavePath(defaultName: string): Promise<PickResult> {
  const helper = findHelper()
  if (!helper) return { canceled: true }
  const start = join(homedir(), defaultName || 'untitled.dpatch')
  return helper.kind === 'kdialog'
    ? runHelper(helper.bin, ['--getsavefilename', start, '*.dpatch *.json|Daisy Patch'])
    : runHelper(helper.bin, [
        '--file-selection',
        '--save',
        '--confirm-overwrite',
        `--filename=${start}`,
        '--file-filter=Daisy Patch | *.dpatch *.json'
      ])
}

async function pickOpenPath(): Promise<PickResult> {
  const helper = findHelper()
  if (!helper) return { canceled: true }
  const start = join(homedir(), '')
  return helper.kind === 'kdialog'
    ? runHelper(helper.bin, ['--getopenfilename', start, '*.dpatch *.json|Daisy Patch'])
    : runHelper(helper.bin, [
        '--file-selection',
        `--filename=${start}`,
        '--file-filter=Daisy Patch | *.dpatch *.json'
      ])
}

function registerIpcHandlers(): void {
  ipcMain.handle('dialog:save', async (evt, defaultName: string) => {
    /*
     * Parent the modal to the window that MADE the call, not to whatever
     * happens to be focused. DevTools opens as its own detached
     * BrowserWindow in this app, so `getFocusedWindow()` can hand back the
     * DevTools window — the sheet then attaches there and looks, from the
     * app window, like clicking Save did nothing at all.
     */
    if (findHelper()) {
      const picked = await pickSavePath(defaultName)
      if (picked.canceled || !picked.path) return { canceled: true }
      const path = withPatchExt(picked.path)
      grantPath(path)
      return { canceled: false, path }
    }
    const owner = BrowserWindow.fromWebContents(evt.sender)
    const opts = {
      title: 'Save Patch',
      defaultPath: defaultName || 'untitled.dpatch',
      filters: FILE_FILTERS
    }
    const result = owner
      ? await dialog.showSaveDialog(owner, opts)
      : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { canceled: true }
    const path = withPatchExt(result.filePath)
    grantPath(path)
    return { canceled: false, path }
  })

  ipcMain.handle('dialog:open', async (evt) => {
    // Same window-ownership reasoning as dialog:save above.
    if (findHelper()) {
      const picked = await pickOpenPath()
      if (picked.canceled || !picked.path) return { canceled: true }
      grantPath(picked.path)
      return { canceled: false, path: picked.path }
    }
    const owner = BrowserWindow.fromWebContents(evt.sender)
    const opts = {
      title: 'Open Patch',
      properties: ['openFile'] as const,
      filters: FILE_FILTERS
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, { ...opts, properties: ['openFile'] })
      : await dialog.showOpenDialog({ ...opts, properties: ['openFile'] })
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return { canceled: true }
    grantPath(picked)
    return { canceled: false, path: picked }
  })

  ipcMain.handle('fs:writeFile', async (_evt, path: string, content: string) => {
    if (!isAllowedPath(path)) {
      // Say which rule failed — "not granted" on a file the user just
      // picked sends people hunting in the wrong place.
      throw new Error(
        hasPatchExt(path)
          ? `refusing to write a path not granted via a dialog: ${path}`
          : `refusing to write: not a .dpatch/.json path: ${path}`
      )
    }
    await writeFile(path, content, 'utf8')
  })

  ipcMain.handle('fs:readFile', async (_evt, path: string) => {
    if (!isAllowedPath(path)) {
      throw new Error(
        hasPatchExt(path)
          ? `refusing to read a path not granted via a dialog: ${path}`
          : `refusing to read: not a .dpatch/.json path: ${path}`
      )
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

  // Re-entrancy guards. The renderer's `building` flag is UI state, not a
  // gate — a second window, a devtools call, or a re-render race could
  // invoke these while a child process is still running, and two builds in
  // one project dir race cleanProjectDir deleting sources mid-compile.
  let sdkBusy = false
  let buildBusy = false
  let flashBusy = false

  ipcMain.handle('sdk:install', async (evt) => {
    if (sdkBusy) throw new Error('an SDK install is already running')
    sdkBusy = true
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
    } finally {
      sdkBusy = false
    }
  })

  // ESP32 toolchain install reuses the sdk:progress channel so the modal's
  // existing log-tail UI picks up output without a second subscription path.
  ipcMain.handle('esp32:install', async (evt) => {
    if (sdkBusy) throw new Error('an SDK install is already running')
    sdkBusy = true
    const emit = emitter('sdk:progress', evt)
    try {
      await installEsp32Toolchain(emit)
      return { success: true }
    } catch (err) {
      const msg = (err as Error).message || String(err)
      emit(`[error] ${msg}`)
      throw new Error(msg)
    } finally {
      sdkBusy = false
    }
  })

  ipcMain.handle('build:run', async (evt, input: BuildInput) => {
    if (buildBusy) throw new Error('a build is already running')
    buildBusy = true
    try {
      const emit = emitter('build:progress', evt)
      const result = await buildProject(input, emit)
      // Log still goes over the wire so the caller can store scrollback
      // without a second round-trip — it's already tail-bounded.
      return result
    } finally {
      buildBusy = false
    }
  })

  /**
   * Write the generated project to disk and reveal it in the file manager.
   *
   * The one-way door out of the patcher: from here the project is ordinary
   * C++ that any editor can open and any toolchain can build. Nothing reads
   * it back — the graph does not learn about edits made out there, which is
   * why the UI says so before calling this.
   *
   * `shell.openPath` on the directory rather than launching an editor: there
   * is no portable way to know which editor someone uses, and opening the
   * folder works everywhere and is one click from any of them.
   */
  ipcMain.handle('project:eject', async (_evt, input: BuildInput) => {
    const projectPath = await writeProjectFiles(input)
    const r = await openPathSafe(projectPath)
    const err = r.ok ? '' : (r.error ?? 'could not open')
    // A non-empty string is Electron's way of reporting failure here. The
    // path is still returned so the UI can show it even when no file
    // manager is registered — common on a bare Linux install.
    return { path: projectPath, opened: err === '', error: err || undefined }
  })

  ipcMain.handle('flash:detect', async (_evt, target?: BoardId) => {
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
        target?: BoardId
        daisyFlashMode?: 'internal' | 'qspi' | 'sram'
      }
    ) => {
      if (flashBusy) throw new Error('a flash is already running')
      flashBusy = true
      try {
        const emit = emitter('flash:progress', evt)
        // Back-compat: accept a bare string as the Daisy path for callers
        // that haven't adopted the new payload yet.
        const binaryPath = typeof payload === 'string' ? payload : payload.binaryPath
        // coerceBoardId, not a cast: this is a trust boundary and the
        // target tables no longer carry a silent Daisy fallback.
        const target: BoardId = coerceBoardId(
          typeof payload === 'string' ? 'daisy_seed' : payload.target
        )
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
      } finally {
        flashBusy = false
      }
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

  // ---- Verification table ----
  //
  // Persists the per-(kind, target) test-rig pass/fail table. File lives
  // next to the app's other user data so it travels with the install.
  // Read returns {} when the file doesn't exist yet — the renderer treats
  // "no entry" as unknown status.
  const VERIFICATION_PATH = join(app.getPath('userData'), 'verified.json')

  /* ---------------- dropped files ---------------- */

  // A file the user physically dragged onto the window is as deliberate a
  // choice as one picked in a dialog; grant it on the same terms.
  ipcMain.handle('fs:grantDropped', async (_evt, path: string) => {
    if (typeof path !== 'string' || !hasPatchExt(path) || !existsSync(path)) return null
    const abs = resolve(path)
    grantPath(abs)
    return abs
  })

  /* ---------------- recent files ---------------- */

  // The renderer reports a successful open/save; a cancelled dialog or a
  // failed write never reaches here, so "recent" means "actually used".
  ipcMain.on('recent:add', (_evt, path: string) => {
    if (typeof path === 'string' && hasPatchExt(path)) addRecent(resolve(path))
  })

  ipcMain.handle('recent:list', async () => {
    const list = readRecent()
    // Anything the menu can offer to open, the renderer must be able to read.
    for (const p of list) grantPath(p)
    return list
  })

  /* ---------------- external links ---------------- */

  // Renderer-requested URLs (the guide's links). http(s) only, enforced in
  // `openExternalSafe`; the renderer cannot make main open anything else.
  ipcMain.on('app:open-external', (_evt, url: string) => {
    if (typeof url === 'string') void openExternalSafe(url)
  })

  /* ---------------- window chrome ---------------- */

  ipcMain.on('window:document', (evt, p: { path?: string | null; edited?: boolean }) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    if (!win) return
    // Both are no-ops off macOS; harmless to call everywhere.
    win.setRepresentedFilename(typeof p?.path === 'string' ? p.path : '')
    win.setDocumentEdited(Boolean(p?.edited))
  })

  /* ---------------- examples ---------------- */

  /**
   * Where the bundled example patches live.
   *
   * In a packaged app they are copied to `resources/examples` by
   * electron-builder's `extraResources`; in dev they are the repo folder.
   * Opening the folder rather than a picker means the user sees the README
   * next to the patches, which is what explains what each one is.
   */
  const examplesDir = (): string =>
    app.isPackaged ? join(process.resourcesPath, 'examples') : join(app.getAppPath(), 'examples')

  ipcMain.handle('examples:open', async () => {
    const dir = examplesDir()
    if (!existsSync(dir)) return { opened: false, error: `no examples folder at ${dir}` }
    const r = await openPathSafe(dir)
    return { opened: r.ok, error: r.error }
  })

  ipcMain.handle('examples:list', async () => {
    const dir = examplesDir()
    if (!existsSync(dir)) return []
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(dir)
    const { readFile: rf } = await import('node:fs/promises')
    const out: { name: string; path: string; board?: string; description?: string }[] = []
    for (const n of names.filter((x) => x.endsWith('.dpatch')).sort()) {
      const path = join(dir, n)
      let board: string | undefined
      let description: string | undefined
      try {
        // Only the two fields the picker shows. A malformed example is
        // still listed — the open path will report what is wrong with it.
        const d = JSON.parse(await rf(path, 'utf8')) as {
          graph?: { meta?: { description?: string } }
          hardware?: { board?: string }
        }
        board = d.hardware?.board
        description = d.graph?.meta?.description
      } catch {
        /* listed without metadata */
      }
      out.push({ name: n, path, board, description })
    }
    /*
     * Grant these the same way a dialog pick would. `fs:readFile` refuses
     * any path the user did not choose through a dialog — the right rule —
     * so an example the app itself lists has to be admitted here or the
     * "open example" flow lists files it then refuses to open. Bundled
     * examples are the app's own files; letting the renderer read them is
     * not a widening of anything.
     */
    for (const e of out) grantPath(e.path)
    return out
  })

  /* ---------------- assistant ---------------- */

  ipcMain.handle('assistant:config', async () => readConfigSafe())

  ipcMain.handle('assistant:saveConfig', async (_evt, patch: Parameters<typeof saveConfig>[0]) =>
    saveConfig(patch ?? {})
  )

  ipcMain.handle('assistant:models', async () => listLocalModels())

  ipcMain.handle('assistant:complete', async (_evt, req: CompletionRequest) => {
    if (!req || typeof req.system !== 'string' || typeof req.user !== 'string') {
      return { error: 'assistant:complete expects { system, user }' }
    }
    return assistantComplete(req)
  })

  /* ---------------- sample library ---------------- */

  ipcMain.handle('sample:list', async () => listSamples())

  ipcMain.handle('sample:store', async (_evt, input: StoreSampleInput) => {
    if (!input || !(input.pcm instanceof ArrayBuffer)) {
      throw new Error('sample:store expects an ArrayBuffer of PCM')
    }
    return storeSample(input)
  })

  ipcMain.handle('sample:read', async (_evt, id: string) => readSamplePcm(id))

  ipcMain.handle('sample:rename', async (_evt, id: string, name: string) =>
    renameSample(id, name)
  )

  ipcMain.handle('sample:delete', async (_evt, id: string) => deleteSample(id))

  ipcMain.handle('verification:load', async () => {
    try {
      const content = await readFile(VERIFICATION_PATH, 'utf8')
      const parsed = JSON.parse(content)
      if (parsed && typeof parsed === 'object') return parsed
      return {}
    } catch {
      // File missing or corrupt — return an empty table, do not throw.
      return {}
    }
  })

  ipcMain.handle('verification:save', async (_evt, table: unknown) => {
    // Defensive: reject anything that isn't a plain object so a rogue
    // payload can't blow up the file with unserialisable content.
    if (!table || typeof table !== 'object') {
      throw new Error('verification:save expects an object table')
    }
    const text = JSON.stringify(table, null, 2)
    await mkdir(dirname(VERIFICATION_PATH), { recursive: true })
    await writeFile(VERIFICATION_PATH, text, 'utf8')
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    /*
     * 1360, not 1100: the top bar carries three view tabs, four boards, a
     * filename, flash mode and eight controls, and below ~1350px they
     * physically overlap. A minimum the layout cannot honour is worse than
     * a larger one — the window let you shrink into a state where buttons
     * sat on top of each other and half of them were unclickable.
     */
    minWidth: 1360,
    minHeight: 700,
    show: false,
    /*
     * The menu bar is VISIBLE on Linux and Windows. `autoHideMenuBar: true`
     * hid it behind Alt, and a menu nobody can see is a menu that does not
     * exist — "there is no File menu" was the exact report. macOS puts it in
     * the system bar regardless.
     */
    autoHideMenuBar: false,
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

  /*
   * A dead renderer is a blank window with no way out. Reload it — the
   * store re-hydrates from nothing, which loses unsaved edits, but that is
   * strictly better than a frozen frame the user has to force-quit. The
   * message names the loss so nobody wonders where their patch went.
   */
  win.webContents.on('render-process-gone', (_evt, details) => {
    if (details.reason === 'clean-exit') return
    console.error(`[main] renderer gone: ${details.reason}`)
    dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'Daisypatcher stopped responding',
        message: `The editor crashed (${details.reason}).`,
        detail: 'Reloading will recover the app. Unsaved changes since your last save are lost.',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1
      })
      .then(({ response }) => {
        if (response === 0) win.webContents.reload()
        else app.quit()
      })
      .catch(() => win.webContents.reload())
  })

  win.on('unresponsive', () => {
    console.warn('[main] renderer unresponsive')
  })

  /*
   * Closing with unsaved work.
   *
   * There was NOTHING here: Ctrl+Q, the title-bar X and File > Quit all
   * dropped an unsaved patch on the floor without a word. The renderer is
   * the only thing that knows whether the patch is dirty (and it owns the
   * save dialog), so close is a two-step handshake: main asks over
   * `app:before-close`, the renderer answers `app:close-decision` with
   * 'close' | 'cancel' after showing its own confirm. If the renderer is
   * gone or does not answer within a few seconds, close anyway — a hung
   * page must not make the window unclosable.
   */
  let closeApproved = false
  win.on('close', (ev) => {
    if (closeApproved) return
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return
    ev.preventDefault()
    /*
     * Two-phase: the renderer first ACKs that it received the question
     * (`app:close-ack`, immediate), then later ANSWERS (`app:close-decision`,
     * whenever the user decides). The timeout guards only the first — a
     * hung renderer never acks and the window closes anyway. It must NOT
     * guard the second: a person reading "Save changes?" for six seconds is
     * not a hang, and closing under them (which a single timer did) throws
     * away exactly the work the dialog exists to protect.
     */
    let acked = false
    const onAck = (): void => {
      acked = true
    }
    const onDecision = (_e: Electron.IpcMainEvent, decision: string): void => {
      cleanup()
      if (decision === 'close') {
        closeApproved = true
        win.close()
      }
      // 'cancel': leave the window open; the next close asks again.
    }
    const timer = setTimeout(() => {
      if (acked) return // the renderer is alive and the user is deciding
      cleanup()
      closeApproved = true
      win.close()
    }, 3000)
    const cleanup = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener('app:close-ack', onAck)
      ipcMain.removeListener('app:close-decision', onDecision)
    }
    ipcMain.once('app:close-ack', onAck)
    ipcMain.once('app:close-decision', onDecision)
    win.webContents.send('app:before-close')
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
    // Web links only — never forward file:// or custom protocol handlers
    // to the OS from renderer-controlled URLs.
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void openExternalSafe(url)
    }
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/*
 * Last-resort error handling in the main process.
 *
 * An unhandled rejection in main used to be a silent nothing — Electron
 * prints it and carries on, and the user sees a button that did not work
 * with no explanation. An uncaught exception is worse: the default is to
 * kill the process, taking an unsaved patch with it. Neither is a reason
 * to die. Log both, tell the renderer so it can show a status line, and
 * keep the window up — a save is one keystroke away and that is the thing
 * to protect.
 */
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error('[main] unhandled rejection:', msg)
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('app:main-error', `internal error: ${msg}`)
  }
})
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('app:main-error', `internal error: ${err.message}`)
  }
})

/*
 * The GPU process can die under us — seen here on Linux when the
 * compositor is torn down mid-session ("GPU process isn't usable.
 * Goodbye."), and it is the default Chromium response to a driver reset.
 * Without this, Electron exits and the patch is gone. Falling back to
 * software compositing keeps the window alive; the canvas is slower but
 * the work is still there to save.
 */
app.on('child-process-gone', (_evt, details) => {
  if (details.type === 'GPU' && details.reason !== 'clean-exit') {
    console.error(`[main] GPU process gone (${details.reason}); disabling hardware acceleration`)
    app.disableHardwareAcceleration()
  }
})

/*
 * Opening a .dpatch from the OS: double-click in a file manager, drag onto
 * the dock icon, `daisypatcher foo.dpatch`. macOS delivers `open-file`
 * (possibly before the window exists); Linux and Windows put it in argv,
 * and a second launch arrives via `second-instance` with ITS argv. All
 * three funnel into one queue that drains once the renderer says it is
 * listening — a path sent before that is a message to nobody.
 */
const pendingOpen: string[] = []
let rendererReadyForOpen = false
function patchArgFrom(argv: string[]): string | null {
  // Skip the binary and any electron/chromium flags; take the first .dpatch.
  return argv.slice(1).find((a) => !a.startsWith('-') && hasPatchExt(a) && existsSync(a)) ?? null
}
function openFromOs(path: string): void {
  const abs = resolve(path)
  grantPath(abs)
  const win = BrowserWindow.getAllWindows()[0]
  if (rendererReadyForOpen && win && !win.webContents.isDestroyed()) {
    win.webContents.send('app:open-path', abs)
  } else {
    pendingOpen.push(abs)
  }
}
app.on('open-file', (ev, path) => {
  ev.preventDefault()
  openFromOs(path)
})
ipcMain.on('app:ready-for-open', (evt) => {
  rendererReadyForOpen = true
  const win = BrowserWindow.fromWebContents(evt.sender)
  for (const p of pendingOpen.splice(0)) win?.webContents.send('app:open-path', p)
})
{
  // Through `openFromOs`, not a raw push: it is what grants the path.
  const fromArgv = patchArgFrom(process.argv)
  if (fromArgv) openFromOs(fromArgv)
}

// Two instances share one workspace and SDK dir — a second app racing the
// first mid-build corrupts project dirs. Single-instance, focus the first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_evt, argv) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    // "Open with Daisypatcher" while it is already running lands here.
    const p = patchArgFrom(argv)
    if (p) openFromOs(p)
  })

  app.whenReady().then(() => {
    setRecentGrant(grantPath)
    installAppMenu()
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
