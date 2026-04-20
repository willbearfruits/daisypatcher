import { contextBridge, ipcRenderer } from 'electron'

/**
 * Types exposed to the renderer. These mirror the canonical defs in
 * `electron/main/sdk.ts`, `electron/main/buildService.ts`, and
 * `electron/main/flashService.ts`. We redeclare them here (rather than
 * importing from `../main/*`) so the renderer's TypeScript project
 * doesn't have to include the main-process sources. Keep in sync.
 */
export type BoardTarget = 'daisy_seed' | 'esp32_s3'

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
}

export interface FlashStatus {
  dfuUtilInstalled: boolean
  devices: FlashDevice[]
  esp32Ports: string[]
  target?: BoardTarget
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

export interface SerialOpenResult {
  success: boolean
  error?: string
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
  compile: {
    build: (input: BuildInput): Promise<BuildResult> =>
      ipcRenderer.invoke('build:run', input),
    onProgress: (cb: (line: string) => void): (() => void) =>
      onChannel('build:progress', cb)
  },
  flash: {
    detect: (target?: BoardTarget): Promise<FlashStatus> =>
      ipcRenderer.invoke('flash:detect', target),
    run: (binaryPath: string, target?: BoardTarget): Promise<{ success: boolean; log: string }> =>
      ipcRenderer.invoke('flash:run', { binaryPath, target }),
    onProgress: (cb: (line: string) => void): (() => void) =>
      onChannel('flash:progress', cb)
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
  }
}

export type DaisyPatcherAPI = typeof api

try {
  contextBridge.exposeInMainWorld('daisy', api)
} catch (err) {
  console.error('Failed to expose preload API:', err)
}
