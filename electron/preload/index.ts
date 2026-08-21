import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * Types exposed to the renderer. These mirror the canonical defs in
 * `electron/main/sdk.ts`, `electron/main/buildService.ts`, and
 * `electron/main/flashService.ts`. We redeclare them here (rather than
 * importing from `../main/*`) so the renderer's TypeScript project
 * doesn't have to include the main-process sources. Keep in sync.
 */
import type { BoardId } from '../../shared/boards'
export type BoardTarget = BoardId

/** Mirror of the Daisy flash-mode union on the main side. */
export type DaisyFlashMode = 'internal' | 'qspi' | 'sram'

export interface SdkStatus {
  ready: boolean
  libDaisy: boolean
  daisySP: boolean
  libDaisyBuilt: boolean
  toolchain: { gcc: boolean; make: boolean; dfuUtil: boolean; pio?: boolean; python3?: boolean }
  esp32Ready?: boolean
  issues: string[]
}

export interface BuildInput {
  projectName: string
  files: Record<string, string>
  target?: BoardTarget
}

export interface BuildResult {
  success: boolean
  projectPath: string
  binaryPath?: string
  binarySize?: number
  durationMs: number
  log: string
}

export interface FlashDevice {
  busId: string
  serial?: string
  altName?: string
  alt?: number
  devnum?: number
  cfg?: number
  intf?: number
  path?: string
  bcdDevice?: string
  /** DfuSe interface-name — e.g. "Flash " (Daisy Bootloader) or "Internal Flash". */
  dfuseInterfaceName?: string
}

export interface FlashSerialInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

export interface FlashStatus {
  dfuUtilInstalled: boolean
  devices: FlashDevice[]
  esp32Ports: string[]
  /** Enriched serial-port enumeration (VID:PID + manufacturer). */
  serialPorts?: FlashSerialInfo[]
  target?: BoardTarget
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

/**
 * Cross-target device autodetection result. Mirrored from
 * `electron/main/deviceDetection.ts`. `detectedBoard` is `null` when nothing
 * is plugged in OR when both a Daisy and an ESP32 are present
 * simultaneously (ambiguous — renderer must not auto-switch).
 */
export interface DetectionResult {
  seedDfu: boolean
  seedSerial: { path: string } | null
  esp32Serial: { path: string } | null
  detectedBoard: BoardTarget | null
}

export interface SerialOpenResult {
  success: boolean
  error?: string
}

/**
 * Lifecycle of an update check, mirrored from electron-updater events. The
 * renderer drives UI state off this single union.
 */
export type UpdateStatusPayload =
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes: string | null }
  | { state: 'none'; version: string | null }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export interface UpdateProgressPayload {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

/**
 * Tiny helper: subscribe to a main-process broadcast channel and return
 * an unsubscribe function. We intentionally do NOT forward the raw
 * IpcRendererEvent to the callback — the renderer shouldn't touch it.
 */
function onChannel(channel: string, cb: (line: string) => void): () => void {
  const listener = (_e: unknown, line: string): void => cb(line)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * Same idea as `onChannel` but for structured object payloads. We keep them
 * separate so call sites stay self-documenting (string = a log line, object
 * = a status/progress event).
 */
function onObjectChannel<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  dialogs: {
    save: (defaultName: string): Promise<{ canceled: boolean; path?: string }> =>
      ipcRenderer.invoke('dialog:save', defaultName),
    open: (): Promise<{ canceled: boolean; path?: string }> =>
      ipcRenderer.invoke('dialog:open')
  },
  fs: {
    writeFile: (path: string, content: string): Promise<void> =>
      ipcRenderer.invoke('fs:writeFile', path, content),
    readFile: (path: string): Promise<string> =>
      ipcRenderer.invoke('fs:readFile', path)
  },
  sdk: {
    status: (): Promise<SdkStatus> => ipcRenderer.invoke('sdk:status'),
    install: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('sdk:install'),
    onProgress: (cb: (line: string) => void): (() => void) =>
      onChannel('sdk:progress', cb)
  },
  esp32: {
    // Progress streams over the same `sdk:progress` channel — see main.
    install: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('esp32:install')
  },
  compile: {
    build: (input: BuildInput): Promise<BuildResult> =>
      ipcRenderer.invoke('build:run', input),
    onProgress: (cb: (line: string) => void): (() => void) =>
      onChannel('build:progress', cb)
  },
  project: {
    /**
     * Write the generated project to the workspace and open the folder.
     * One-way: nothing reads edits back into the graph.
     */
    eject: (input: BuildInput): Promise<{ path: string; opened: boolean; error?: string }> =>
      ipcRenderer.invoke('project:eject', input)
  },
  flash: {
    detect: (target?: BoardTarget): Promise<FlashStatus> =>
      ipcRenderer.invoke('flash:detect', target),
    run: (
      binaryPath: string,
      target?: BoardTarget,
      daisyFlashMode?: DaisyFlashMode
    ): Promise<{ success: boolean; log: string }> =>
      ipcRenderer.invoke('flash:run', { binaryPath, target, daisyFlashMode }),
    onProgress: (cb: (line: string) => void): (() => void) =>
      onChannel('flash:progress', cb)
  },
  device: {
    detect: (): Promise<DetectionResult> => ipcRenderer.invoke('device:detect')
  },
  serial: {
    list: (): Promise<SerialPortInfo[]> => ipcRenderer.invoke('serial:list'),
    open: (path: string, baud: number): Promise<SerialOpenResult> =>
      ipcRenderer.invoke('serial:open', { path, baud }),
    close: (): Promise<void> => ipcRenderer.invoke('serial:close'),
    write: (text: string): Promise<void> =>
      ipcRenderer.invoke('serial:write', { text }),
    onLine: (cb: (line: string) => void): (() => void) =>
      onChannel('serial:line', cb)
  },
  updates: {
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    download: (): Promise<void> => ipcRenderer.invoke('update:download'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onStatus: (cb: (payload: UpdateStatusPayload) => void): (() => void) =>
      onObjectChannel<UpdateStatusPayload>('update:status', cb),
    onProgress: (cb: (payload: UpdateProgressPayload) => void): (() => void) =>
      onObjectChannel<UpdateProgressPayload>('update:progress', cb)
  },
  verification: {
    load: (): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('verification:load'),
    save: (table: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke('verification:save', table)
  },
  /**
   * Sample library. Decoding stays in the renderer (see sampleService.ts);
   * what crosses this boundary is already raw interleaved Float32 PCM.
   */
  /**
   * Application-menu commands. The main process owns the menu bar; the
   * renderer owns every behaviour. One channel, one string per click.
   */
  menu: {
    onCommand: (cb: (cmd: string) => void): (() => void) => onChannel('app:command', cb)
  },
  /** Open an http(s) URL in the system browser via main's detached opener. */
  openExternal: (url: string): void => ipcRenderer.send('app:open-external', url),
  /**
   * A `.dpatch` dropped onto the window from the OS.
   *
   * `webUtils.getPathForFile` is the only sanctioned way to learn a
   * dropped File's path under contextIsolation. The path is then granted
   * by main (same allow-list `fs:readFile` checks) and returned; a
   * non-.dpatch drop returns null and is granted nothing.
   */
  pathForDroppedPatch: (file: File): Promise<string | null> => {
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      return Promise.resolve(null)
    }
    if (!path || !/\.(dpatch|json)$/i.test(path)) return Promise.resolve(null)
    return ipcRenderer.invoke('fs:grantDropped', path)
  },
  recent: {
    add: (path: string): void => ipcRenderer.send('recent:add', path),
    list: (): Promise<string[]> => ipcRenderer.invoke('recent:list'),
    /** File → Open Recent → item, or a file opened from the OS: main hands the path over. */
    onOpenPath: (cb: (path: string) => void): (() => void) => {
      const off = onChannel('app:open-path', cb)
      // Now that someone is listening, main may drain a path that arrived
      // before the window existed (double-click launch, argv).
      ipcRenderer.send('app:ready-for-open')
      return off
    }
  },
  window: {
    /** Represented file + edited flag: macOS proxy icon and title-bar dot. */
    setDocument: (p: { path: string | null; edited: boolean }): void =>
      ipcRenderer.send('window:document', p),
    // Custom drag region (see TopBar.module.css) has no native title bar
    // behind it, so double-click-to-zoom needs to be wired up by hand.
    titlebarDoubleClick: (): Promise<void> =>
      ipcRenderer.invoke('window:titlebarDoubleClick')
  },
  /** Errors the main process caught instead of dying from. */
  onMainError: (cb: (msg: string) => void): (() => void) => onChannel('app:main-error', cb),
  /**
   * The window is about to close. Answer with `respondClose('close')` to
   * let it, or `'cancel'` to keep it open. Not answering closes it anyway
   * after a timeout, so a hung renderer cannot trap the user.
   */
  onBeforeClose: (cb: () => void): (() => void) => {
    const listener = (): void => {
      // Ack at once so main knows the renderer is alive; the decision
      // comes when the user makes it, however long that takes.
      ipcRenderer.send('app:close-ack')
      cb()
    }
    ipcRenderer.on('app:before-close', listener)
    return () => ipcRenderer.removeListener('app:before-close', listener)
  },
  respondClose: (decision: 'close' | 'cancel'): void =>
    ipcRenderer.send('app:close-decision', decision),
  examples: {
    open: (): Promise<{ opened: boolean; error?: string }> => ipcRenderer.invoke('examples:open'),
    list: (): Promise<{ name: string; path: string; board?: string; description?: string }[]> =>
      ipcRenderer.invoke('examples:list')
  },
  /**
   * Assistant. Network calls and API keys stay in the main process — see
   * `electron/main/assistantService.ts` for why. The renderer never holds a
   * credential and `config()` never returns one.
   */
  assistant: {
    config: (): Promise<SafeAssistantConfig> => ipcRenderer.invoke('assistant:config'),
    saveConfig: (patch: {
      provider?: 'ollama' | 'anthropic' | 'openai'
      model?: string
      baseUrl?: string
      key?: { provider: 'ollama' | 'anthropic' | 'openai'; value: string }
    }): Promise<SafeAssistantConfig> => ipcRenderer.invoke('assistant:saveConfig', patch),
    models: (): Promise<string[]> => ipcRenderer.invoke('assistant:models'),
    complete: (req: { system: string; user: string }): Promise<{ text?: string; error?: string }> =>
      ipcRenderer.invoke('assistant:complete', req)
  },
  samples: {
    list: (): Promise<SampleMeta[]> => ipcRenderer.invoke('sample:list'),
    store: (input: {
      name: string
      sampleRate: number
      channels: number
      pcm: ArrayBuffer
    }): Promise<SampleMeta> => ipcRenderer.invoke('sample:store', input),
    read: (id: string): Promise<ArrayBuffer | null> => ipcRenderer.invoke('sample:read', id),
    rename: (id: string, name: string): Promise<SampleMeta[]> =>
      ipcRenderer.invoke('sample:rename', id, name),
    remove: (id: string): Promise<SampleMeta[]> => ipcRenderer.invoke('sample:delete', id)
  }
}

/** Mirrors `electron/main/sampleService.ts`. Duplicated rather than imported:
 *  the preload bundle must not pull in main-process modules. */
export interface SampleMeta {
  id: string
  name: string
  sampleRate: number
  channels: number
  frames: number
  duration: number
  importedAt: number
}

/** Mirrors `electron/main/assistantService.ts`; keys are never included. */
export interface SafeAssistantConfig {
  provider: 'ollama' | 'anthropic' | 'openai'
  model: string
  baseUrl: string
  hasKey: Record<'ollama' | 'anthropic' | 'openai', boolean>
}

export type DaisyPatcherAPI = typeof api

try {
  contextBridge.exposeInMainWorld('daisy', api)
} catch (err) {
  console.error('Failed to expose preload API:', err)
}
