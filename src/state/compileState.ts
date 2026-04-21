/**
 * Compile / flash / SDK state — lives in its own store, deliberately separate
 * from the editor/graph store so build plumbing never touches patch mutations
 * (and vice versa). Consumed by TopBar (Compile/Flash buttons), the DFU pill
 * in StatusBar, the BuildLogPanel, and the first-run SdkInstallModal.
 *
 * IPC surface is expected to be exposed by the main process as:
 *   window.daisy.sdk      — status() / install() / onProgress()
 *   window.daisy.compile  — build()  / onProgress()
 *   window.daisy.flash    — detect() / run() / onProgress()
 *
 * The preload bridge may not yet advertise these in global.d.ts — in that
 * case we fall back to local narrow types that mirror the service spec in
 * electron/main/buildService.ts and electron/main/sdk.ts. Every IPC call is
 * guarded by a runtime presence check so the web-only dev path (no electron
 * preload) degrades gracefully instead of throwing.
 */

import { create } from 'zustand'
import { generateProject } from '@/codegen/generateProject'
import { useEditorStore } from '@/state/store'
import { getTarget } from '@/codegen/targets'
import type { BoardTarget, DaisyFlashMode } from '@/types/store'

/** Addresses for the three Daisy flash modes — also used for log output. */
const DAISY_FLASH_ADDRS: Record<DaisyFlashMode, string> = {
  internal: '0x08000000',
  qspi: '0x90040000',
  sram: '0x24000000'
}
const DAISY_APP_TYPE: Record<DaisyFlashMode, string> = {
  internal: 'BOOT_NONE',
  qspi: 'BOOT_QSPI',
  sram: 'BOOT_SRAM'
}

/* ---------- local IPC types (mirror main-process spec) ----------------- */

export interface SdkStatus {
  ready: boolean
  libDaisy: boolean
  daisySP: boolean
  libDaisyBuilt: boolean
  toolchain: { gcc: boolean; make: boolean; dfuUtil: boolean }
  issues: string[]
}

export interface BuildInput {
  projectName: string
  files: Record<string, string>
  /** Which target to build for — drives compiler choice in the main process. */
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

/** Loosely-typed mirror of the main-process FlashStatus — stays decoupled. */
export interface FlashDetectResult {
  available: boolean
  label?: string
  /** ESP32 ports enumerated (empty on Daisy target). */
  esp32Ports?: string[]
  /** DFU devices — length > 0 implies ready-to-flash Seed. */
  dfuDevices?: unknown[]
}

/**
 * Shape of a single device row surfaced to the StatusBar popover. Mirrors
 * the main-process `FlashDevice` / `FlashSerialInfo`. Kept intentionally
 * loose so the renderer stays buildable if the preload surface drifts.
 */
export interface DeviceDetail {
  kind: 'dfu' | 'serial'
  busId?: string
  serial?: string
  altName?: string
  alt?: number
  path?: string
  devnum?: number
  cfg?: number
  intf?: number
  bcdDevice?: string
  dfuseInterfaceName?: string
  portPath?: string
  vendorId?: string
  productId?: string
  manufacturer?: string
}

export interface FlashResult {
  success: boolean
  durationMs: number
  log: string
}

type Unsub = () => void

interface SdkApi {
  status(): Promise<SdkStatus>
  install(): Promise<void>
  onProgress(cb: (line: string) => void): Unsub
}

interface Esp32Api {
  install(): Promise<{ success: boolean }>
}

interface CompileApi {
  build(input: BuildInput): Promise<BuildResult>
  onProgress(cb: (line: string) => void): Unsub
}

interface RawDfuDevice {
  busId?: string
  serial?: string
  altName?: string
  alt?: number
  devnum?: number
  cfg?: number
  intf?: number
  path?: string
  bcdDevice?: string
  dfuseInterfaceName?: string
}

interface RawSerialInfo {
  path?: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

interface RawFlashStatus {
  dfuUtilInstalled?: boolean
  devices?: RawDfuDevice[]
  esp32Ports?: string[]
  serialPorts?: RawSerialInfo[]
  target?: BoardTarget
}

interface FlashApi {
  detect(target?: BoardTarget): Promise<RawFlashStatus>
  run(
    binaryPath: string,
    target?: BoardTarget,
    daisyFlashMode?: DaisyFlashMode
  ): Promise<FlashResult>
  onProgress(cb: (line: string) => void): Unsub
}

/**
 * Cross-target autodetection — mirrors `DetectionResult` on the main side.
 * Loose typing keeps the renderer buildable even if the preload bridge
 * hasn't been rebuilt yet (the call itself is runtime-guarded).
 */
interface RawDetectionResult {
  seedDfu?: boolean
  seedSerial?: { path: string } | null
  esp32Serial?: { path: string } | null
  detectedBoard?: BoardTarget | null
}

interface DeviceApi {
  detect(): Promise<RawDetectionResult>
}

interface MaybeDaisyApi {
  sdk?: SdkApi
  esp32?: Esp32Api
  compile?: CompileApi
  flash?: FlashApi
  device?: DeviceApi
}

function api(): MaybeDaisyApi {
  // `window.daisy` is typed as DaisyPatcherAPI which may or may not include
  // the build/flash/sdk surfaces yet. We cast through `unknown` so this file
  // keeps compiling while the preload surface is being expanded.
  if (typeof window === 'undefined') return {}
  const w = window as unknown as { daisy?: MaybeDaisyApi }
  return w.daisy ?? {}
}

/* ---------- store shape ------------------------------------------------ */

export interface LogLine {
  stream: 'info' | 'build' | 'flash' | 'sdk' | 'error'
  text: string
  t: number
}

export interface CompileState {
  sdkReady: boolean
  sdkInstalling: boolean
  sdkIssues: string[]
  sdkChecked: boolean
  /** Last install failure — surfaced in the SdkInstallModal. null = no error. */
  sdkInstallError: string | null
  building: boolean
  flashing: boolean
  lastBuildSuccess: boolean | null
  lastBuildFlashUntilMs: number | null
  lastFlashSuccess: boolean | null
  lastFlashUntilMs: number | null
  lastBinaryPath: string | null
  deviceAvailable: boolean
  deviceLabel: string | null
  /**
   * Raw per-device details (DFU alts + nearby serial ports) from the
   * latest detect() tick. Consumed by the StatusBar popover to render
   * "Bootloader / VID:PID / serial / USB path / alt names / DFU ver".
   * `null` until the first successful poll.
   */
  deviceDetails: DeviceDetail[] | null
  /**
   * Cross-target presence flags, updated by `detectBoards()`. Independent
   * of `deviceAvailable` (which is scoped to the current target) so the
   * StatusBar pill can show a "seed also available" / "esp32 also
   * available" secondary indicator when a board is plugged in that isn't
   * the currently-selected target.
   */
  seedAvailable: boolean
  esp32Available: boolean
  log: LogLine[]
  logPanelOpen: boolean
}

export interface CompileActions {
  openLogPanel(): void
  closeLogPanel(): void
  toggleLogPanel(): void
  appendLog(line: LogLine): void
  clearLog(): void

  refreshSdkStatus(): Promise<void>
  installSdk(): Promise<void>
  /**
   * ESP32-S3 toolchain installer — shells out via IPC to the main process,
   * which uses pipx (preferred) or `python -m pip install --user` to fetch
   * platformio, then pre-installs the espressif32 platform so the first
   * compile doesn't stall on a ~250 MB download inside `pio run`. Progress
   * is streamed over the same `sdk` log channel.
   */
  installEsp32Toolchain(): Promise<void>
  build(): Promise<void>
  detectDevice(): Promise<void>
  /**
   * Cross-target autodetection. Polls `window.daisy.device.detect()`,
   * updates `detectedBoard` + `seedAvailable` + `esp32Available`, and
   * (with debounce) calls `autoSetTarget()` to switch the compile target
   * when the user hasn't locked it manually.
   */
  detectBoards(): Promise<void>
  flash(): Promise<void>
}

const LOG_CAP = 2000

function pushCapped(list: LogLine[], line: LogLine): LogLine[] {
  if (list.length < LOG_CAP) return [...list, line]
  // Drop oldest 1/10th when we hit the cap so we don't re-copy every push.
  const drop = Math.floor(LOG_CAP / 10)
  const next = list.slice(drop)
  next.push(line)
  return next
}

export const useCompileStore = create<CompileState & CompileActions>((set, get) => {
  /* ---------- log helpers ---------- */

  const append = (line: LogLine): void => {
    set((s) => ({ log: pushCapped(s.log, line) }))
  }

  /*
   * Debounce ring buffer for `detectBoards()`. We require TWO consecutive
   * identical detections before auto-switching the target so a hotplug
   * glitch (brief double-presence during a power-up) doesn't thrash the
   * compile target. Kept on the closure rather than in store state — it's
   * an implementation detail of the poller, not something the UI renders.
   */
  const recentDetections: (BoardTarget | null)[] = []

  /* ---------- onProgress listeners ----------
   *
   * Registered once at store construction. Each main-process channel pushes
   * a typed LogLine into the single log buffer so the BuildLogPanel renders
   * a unified stream. HMR cleanup intentionally deferred (Phase 1).
   */
  const a = api()
  try {
    a.sdk?.onProgress((text) => append({ stream: 'sdk', text, t: Date.now() }))
    a.compile?.onProgress((text) =>
      append({
        stream: /\b(error|failed|fatal)\b/i.test(text) ? 'error' : 'build',
        text,
        t: Date.now()
      })
    )
    a.flash?.onProgress((text) => append({ stream: 'flash', text, t: Date.now() }))
  } catch {
    // Preload surface not ready — this is fine; actions below re-check.
  }

  return {
    sdkReady: false,
    sdkInstalling: false,
    sdkIssues: [],
    sdkChecked: false,
    sdkInstallError: null,
    building: false,
    flashing: false,
    lastBuildSuccess: null,
    lastBuildFlashUntilMs: null,
    lastFlashSuccess: null,
    lastFlashUntilMs: null,
    lastBinaryPath: null,
    deviceAvailable: false,
    deviceLabel: null,
    deviceDetails: null,
    seedAvailable: false,
    esp32Available: false,
    log: [],
    logPanelOpen: false,

    /* ---------- log panel ---------- */

    openLogPanel() {
      set({ logPanelOpen: true })
    },
    closeLogPanel() {
      set({ logPanelOpen: false })
    },
    toggleLogPanel() {
      set((s) => ({ logPanelOpen: !s.logPanelOpen }))
    },
    appendLog(line) {
      append(line)
    },
    clearLog() {
      set({ log: [] })
    },

    /* ---------- SDK ---------- */

    async refreshSdkStatus() {
      const sdk = api().sdk
      const target = useEditorStore.getState().target

      // ESP32 path: we don't manage a bundled SDK — PlatformIO owns its
      // own toolchain. "ready" collapses to "pio on PATH". Status probe
      // is done via the flash bridge's `sdk.status()` channel which
      // returns the Daisy toolchain flags; we reuse the generic `gcc`
      // shape and just ignore its DaisySP-specific fields.
      if (target === 'esp32_s3') {
        if (!sdk) {
          set({
            sdkReady: false,
            sdkChecked: true,
            sdkIssues: ['SDK bridge not available']
          })
          return
        }
        try {
          const status = await sdk.status()
          // We shoehorn "pio presence" into `toolchain.make` for now —
          // the main process returns a synthesised status for ESP32
          // target detection (see electron/main/sdk.ts). If the bridge
          // doesn't yet know about targets, fall back: mark ready and
          // let the build surface the real error.
          const checks = getTarget('esp32_s3').toolchainCheck()
          const issues = status.issues.filter((i) =>
            i.toLowerCase().includes('platformio') || i.toLowerCase().includes('pio')
          )
          const ready = issues.length === 0
          const tips = checks.map((c) => `${c.name}: ${c.installHint}`)
          set({
            sdkReady: ready,
            sdkIssues: ready ? [] : issues.length ? issues : tips,
            sdkChecked: true
          })
        } catch (err) {
          append({
            stream: 'error',
            text: `[sdk] status failed: ${(err as Error).message}`,
            t: Date.now()
          })
          set({ sdkChecked: true })
        }
        return
      }

      if (!sdk) {
        // No bridge available — assume not ready so the install modal still
        // shows (it will also be non-functional, which is the correct story).
        set({
          sdkReady: false,
          sdkChecked: true,
          sdkIssues: ['SDK bridge not available']
        })
        return
      }
      try {
        const status = await sdk.status()
        set({
          sdkReady: status.ready,
          sdkIssues: status.issues,
          sdkChecked: true
        })
      } catch (err) {
        append({
          stream: 'error',
          text: `[sdk] status failed: ${(err as Error).message}`,
          t: Date.now()
        })
        set({ sdkChecked: true })
      }
    },

    async installSdk() {
      const sdk = api().sdk
      if (!sdk) {
        const msg = 'SDK bridge unavailable (preload not exposing window.daisy.sdk)'
        append({ stream: 'error', text: `[sdk] ${msg}`, t: Date.now() })
        set({ sdkInstallError: msg })
        return
      }
      if (get().sdkInstalling) return
      set({ sdkInstalling: true, sdkInstallError: null, logPanelOpen: true })
      append({ stream: 'sdk', text: '[sdk] install started', t: Date.now() })
      try {
        await sdk.install()
        append({ stream: 'sdk', text: '[sdk] install complete', t: Date.now() })
        await get().refreshSdkStatus()
      } catch (err) {
        const msg = (err as Error).message || String(err)
        append({
          stream: 'error',
          text: `[sdk] install failed: ${msg}`,
          t: Date.now()
        })
        set({ sdkInstallError: msg })
      } finally {
        set({ sdkInstalling: false })
      }
    },

    /**
     * Shares `sdkInstalling` / `sdkInstallError` state with the libDaisy flow.
     * The modal already keys off those flags — target-awareness lives in the
     * modal, not here — so the same busy / error UI works for both paths.
     */
    async installEsp32Toolchain() {
      const esp32 = api().esp32
      if (!esp32) {
        const msg = 'ESP32 bridge unavailable (preload missing window.daisy.esp32)'
        append({ stream: 'error', text: `[esp32] ${msg}`, t: Date.now() })
        set({ sdkInstallError: msg })
        return
      }
      if (get().sdkInstalling) return
      set({ sdkInstalling: true, sdkInstallError: null, logPanelOpen: true })
      append({ stream: 'sdk', text: '[esp32] install started', t: Date.now() })
      try {
        await esp32.install()
        append({ stream: 'sdk', text: '[esp32] install complete', t: Date.now() })
        await get().refreshSdkStatus()
      } catch (err) {
        const msg = (err as Error).message || String(err)
        append({
          stream: 'error',
          text: `[esp32] install failed: ${msg}`,
          t: Date.now()
        })
        set({ sdkInstallError: msg })
      } finally {
        set({ sdkInstalling: false })
      }
    },

    /* ---------- compile ---------- */

    async build() {
      const compile = api().compile
      if (!compile) {
        append({ stream: 'error', text: '[compile] bridge unavailable', t: Date.now() })
        set({ lastBuildSuccess: false, logPanelOpen: true })
        return
      }
      if (get().building) return

      set({ building: true, lastBuildSuccess: null })

      // Codegen: run generateProject against the current graph, pipe warnings
      // into the log as [codegen] info lines. Failure here is fatal before
      // even spawning make.
      const graph = useEditorStore.getState().graph
      const hardware = useEditorStore.getState().hardware
      const target = useEditorStore.getState().target
      const daisyFlashMode = useEditorStore.getState().daisyFlashMode

      if (target === 'daisy_seed') {
        append({
          stream: 'build',
          text:
            `[build] mode=${daisyFlashMode} ` +
            `(APP_TYPE=${DAISY_APP_TYPE[daisyFlashMode]}, ` +
            `addr=${DAISY_FLASH_ADDRS[daisyFlashMode]})`,
          t: Date.now()
        })
      }

      let project: { projectName: string; files: Record<string, string>; warnings: string[] }
      try {
        project = generateProject(graph, hardware, undefined, target, { daisyFlashMode })
      } catch (err) {
        append({
          stream: 'error',
          text: `[codegen] failed: ${(err as Error).message}`,
          t: Date.now()
        })
        set({ building: false, lastBuildSuccess: false, logPanelOpen: true })
        return
      }

      for (const w of project.warnings) {
        append({ stream: 'info', text: `[codegen] ${w}`, t: Date.now() })
      }

      append({
        stream: 'build',
        text: `[build] starting ${project.projectName}`,
        t: Date.now()
      })

      try {
        const result = await compile.build({
          projectName: project.projectName,
          files: project.files,
          target
        })
        const now = Date.now()
        if (result.success) {
          set({
            lastBuildSuccess: true,
            lastBuildFlashUntilMs: now + 1500,
            lastBinaryPath: result.binaryPath ?? null
          })
          append({
            stream: 'build',
            text: `[build] ok (${result.binarySize ?? '?'}B, ${result.durationMs}ms)`,
            t: now
          })
        } else {
          set({
            lastBuildSuccess: false,
            lastBuildFlashUntilMs: now + 1500,
            lastBinaryPath: null,
            logPanelOpen: true
          })
          append({
            stream: 'error',
            text: `[build] failed after ${result.durationMs}ms`,
            t: now
          })
        }
      } catch (err) {
        const now = Date.now()
        set({
          lastBuildSuccess: false,
          lastBuildFlashUntilMs: now + 1500,
          logPanelOpen: true
        })
        append({
          stream: 'error',
          text: `[build] ${(err as Error).message}`,
          t: now
        })
      } finally {
        set({ building: false })
      }
    },

    /* ---------- flash ---------- */

    async detectDevice() {
      const flash = api().flash
      if (!flash) {
        set({ deviceAvailable: false, deviceLabel: null, deviceDetails: null })
        return
      }
      const target = useEditorStore.getState().target
      try {
        const res = await flash.detect(target)
        const dfuDevices: DeviceDetail[] = (res.devices ?? []).map((d) => ({
          kind: 'dfu',
          busId: d.busId,
          serial: d.serial,
          altName: d.altName,
          alt: d.alt,
          path: d.path,
          devnum: d.devnum,
          cfg: d.cfg,
          intf: d.intf,
          bcdDevice: d.bcdDevice,
          dfuseInterfaceName: d.dfuseInterfaceName
        }))
        const serialDevices: DeviceDetail[] = (res.serialPorts ?? []).map((p) => ({
          kind: 'serial',
          portPath: p.path,
          manufacturer: p.manufacturer,
          vendorId: p.vendorId,
          productId: p.productId
        }))
        const deviceDetails: DeviceDetail[] = [...dfuDevices, ...serialDevices]

        if (target === 'esp32_s3') {
          const ports = res.esp32Ports ?? []
          const first = ports[0]
          set({
            deviceAvailable: ports.length > 0,
            deviceLabel: first ? `ESP32 \u00B7 ${first.replace(/^\/dev\//, '')}` : null,
            deviceDetails: deviceDetails.length > 0 ? deviceDetails : null
          })
        } else {
          const devices = res.devices ?? []
          set({
            deviceAvailable: devices.length > 0,
            deviceLabel: devices.length > 0 ? 'Daisy Seed \u00B7 DFU' : null,
            deviceDetails: deviceDetails.length > 0 ? deviceDetails : null
          })
        }
      } catch {
        set({ deviceAvailable: false, deviceLabel: null, deviceDetails: null })
      }
    },

    async detectBoards() {
      const device = api().device
      const ed = useEditorStore.getState()
      if (!device) {
        // No bridge — nothing detected. Clear everything so stale state
        // from a previous run doesn't linger.
        ed.setDetectedBoard(null)
        set({ seedAvailable: false, esp32Available: false })
        recentDetections.length = 0
        return
      }
      try {
        const res = await device.detect()
        const seedPresent = !!(res.seedDfu || res.seedSerial)
        const esp32Present = !!res.esp32Serial
        const board = (res.detectedBoard ?? null) as BoardTarget | null

        // Presence flags are immediate — no debounce needed; they're used
        // only for the StatusBar secondary indicator and don't mutate the
        // compile target.
        set({ seedAvailable: seedPresent, esp32Available: esp32Present })
        ed.setDetectedBoard(board)

        /*
         * Debounce: `autoSetTarget` is only called after the SAME board
         * has been detected for two consecutive polls. Stops a hotplug
         * glitch (e.g. Seed briefly visible during an ESP32 power-up)
         * from flipping the target mid-work. History is intentionally
         * size-2 and stored on the closure so it survives across calls
         * without polluting store state.
         */
        recentDetections.push(board)
        while (recentDetections.length > 2) recentDetections.shift()

        if (
          board !== null &&
          recentDetections.length === 2 &&
          recentDetections[0] === board &&
          recentDetections[1] === board &&
          !ed.targetLockedByUser
        ) {
          ed.autoSetTarget(board)
        }
      } catch {
        // Transient IPC failure — don't wipe presence flags, just skip
        // this tick. The next 3s poll will try again.
      }
    },

    async flash() {
      const flash = api().flash
      const binary = get().lastBinaryPath
      if (!binary) {
        append({
          stream: 'error',
          text: '[flash] no binary — run Compile first',
          t: Date.now()
        })
        set({ logPanelOpen: true })
        return
      }
      if (!flash) {
        append({ stream: 'error', text: '[flash] bridge unavailable', t: Date.now() })
        return
      }
      if (get().flashing) return

      set({ flashing: true, lastFlashSuccess: null })
      append({ stream: 'flash', text: `[flash] ${binary}`, t: Date.now() })

      try {
        const target = useEditorStore.getState().target
        const daisyFlashMode = useEditorStore.getState().daisyFlashMode
        const result = await flash.run(binary, target, daisyFlashMode)
        const now = Date.now()
        if (result.success) {
          set({
            lastFlashSuccess: true,
            lastFlashUntilMs: now + 1500
          })
          append({
            stream: 'flash',
            text: `[flash] ok (${result.durationMs}ms)`,
            t: now
          })
        } else {
          set({
            lastFlashSuccess: false,
            lastFlashUntilMs: now + 1500,
            logPanelOpen: true
          })
          append({
            stream: 'error',
            text: `[flash] failed after ${result.durationMs}ms`,
            t: now
          })
        }
      } catch (err) {
        const now = Date.now()
        set({
          lastFlashSuccess: false,
          lastFlashUntilMs: now + 1500,
          logPanelOpen: true
        })
        append({
          stream: 'error',
          text: `[flash] ${(err as Error).message}`,
          t: now
        })
      } finally {
        set({ flashing: false })
      }
    }
  }
})
