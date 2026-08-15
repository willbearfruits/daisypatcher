/**
 * Store + engine interfaces. Defined here so the layout shell, Rete.js
 * integration, and audio engine can be built in parallel against stable
 * contracts — each agent implements one side of these interfaces.
 */

import type { AudioGraph, Connection, NodeInstance, NodeKind } from './graph'
import type { Preset } from '@/state/presets'
import type { BoardPin, HardwareKind, HardwareLayout, PerformPlacement } from './hardware'
import type { BoardId as BoardTarget } from '../../shared/boards'

/**
 * Target-filter mode for the palette + command palette.
 *   - 'all'       — every kind is visible; unsupported kinds render dimmed
 *                   with a red dot
 *   - 'available' — native + stub kinds; unsupported hidden (default)
 *   - 'native'    — only kinds with full, tuned DSP for the current target
 */
export type PaletteFilterMode = 'all' | 'available' | 'native'

/**
 * Compile target selected in the TopBar. Drives codegen, build-command
 * dispatch, and device detection.
 *
 * Identical to the hardware layout's `BoardId` — one board, one target.
 * Declared in `shared/boards.ts` so the Electron main process and the
 * renderer read from the same list.
 */
export type { BoardTarget }

/**
 * Daisy-only flash mode. Controls the linker script libDaisy emits
 * (via `APP_TYPE` in the Makefile) AND the DFU target address.
 *   - 'internal' — BOOT_NONE, internal flash at 0x08000000 (128 KB).
 *                  Works only when the Daisy Bootloader is NOT present;
 *                  device must be in system DFU mode.
 *   - 'qspi'     — BOOT_QSPI, QSPI flash at 0x90040000 (8 MB). Factory
 *                  default for Daisy Seeds shipped with the Electro-Smith
 *                  Daisy Bootloader (the common case).
 *   - 'sram'     — BOOT_SRAM, SRAM at 0x24000000 (512 KB). Fast iterate;
 *                  app is volatile across reboots.
 *
 * Ignored by the ESP32 target.
 */
export type DaisyFlashMode = 'internal' | 'qspi' | 'sram'

export interface HistoryState {
  /**
   * Per-entry snapshot of BOTH graph and hardware layout. Keeping them
   * paired means undoing across a cross-domain edit (e.g. a hardware drag
   * that triggered a graph rename) restores both halves atomically.
   */
  past: HistorySnapshot[]
  future: HistorySnapshot[]
}

export interface HistorySnapshot {
  graph: AudioGraph
  hardware: HardwareLayout
  /**
   * Presets ride in the snapshot because capturing or deleting one is an
   * edit to the patch, and undoing a capture that left the preset behind
   * would be worse than not offering undo at all.
   */
  presets: Preset[]
}

export interface Clipboard {
  nodes: NodeInstance[]
  connections: Connection[]
}

export type SelectMode = 'replace' | 'add' | 'toggle'

/**
 * UI-preference-only layout sizes. Kept outside `history` so resize gestures
 * never pollute undo with view-state churn. Persisted through `.dpatch` when
 * a patch is saved so the next open restores the user's shell.
 */
export interface LayoutSizes {
  /** Left palette rail width in px. */
  paletteW: number
  /** Right inspector rail width in px. */
  inspectorW: number
  /** Bottom build-log panel height in px (applied only while open). */
  buildLogH: number
  /** Bottom-right serial-monitor panel height in px (applied only while open). */
  serialMonitorH: number
  /** Generated-code panel height in px (applied only while open). */
  codePanelH: number
  /**
   * Palette whole-panel collapse. When true the palette rail renders as a
   * thin 44px vertical bar; the grid template still consumes the same
   * track, the width is just overridden at the CSS level.
   */
  paletteCollapsed: boolean
  /**
   * Compact / icons-only rendering for palette cards. Independent of
   * `paletteCollapsed` — collapsed wins visually when both are on.
   */
  paletteCompact: boolean
  /** Category-header names that are currently collapsed. */
  categoriesCollapsed: string[]
  /** Active target-support filter. Default: 'available'. */
  paletteFilter: PaletteFilterMode
  /**
   * Last 8 kinds the user dropped, front = most recent. Used by the
   * palette's "RECENT" strip and the command palette's quick-pick.
   */
  recentKinds: NodeKind[]

  /**
   * Patch-canvas grid. Separate from the Hardware view's grid, which is in
   * millimetres and describes a physical panel; this one is in canvas units
   * and exists purely to line nodes up.
   */
  gridShow: boolean
  gridSnap: boolean
  /** Grid pitch in canvas units. Also the snap increment. */
  gridSize: number
  /**
   * Left-drag on empty canvas draws a selection rectangle instead of
   * panning. Panning stays available on middle-drag and space-drag, so this
   * is a preference about which gesture is primary, not which is possible.
   */
  marqueeSelect: boolean
}

export interface EditorStoreState {
  graph: AudioGraph
  /** Kept for back-compat: mirrors `selection` when it has exactly one id. */
  selectedNodeId: string | null
  /** Authoritative multi-selection. `selectedNodeId` is derived from this. */
  selection: Set<string>
  history: HistoryState
  clipboard: Clipboard | null
  /** True when the graph has unsaved changes since last save/open/reset. */
  isDirty: boolean
  /** Last on-disk path the current graph was saved to / loaded from. */
  filePath: string | null
  isPlaying: boolean
  status: { kind: 'idle' | 'info' | 'warn' | 'error'; message: string }

  /** Parallel layout describing physical components wired to Seed pins. */
  hardware: HardwareLayout
  /** Which canvas is currently visible. */
  view: 'patch' | 'hardware' | 'perform'
  /** Currently-selected placed-component id, or null. */
  selectedHardwareId: string | null

  /**
   * Outer levels, while editing inside a subpatch.
   *
   * `graph` is always the level you are LOOKING at, so every existing
   * reader keeps working unchanged — the editor, the inspector, selection,
   * undo. What changes is that the engine and codegen must ask for the root
   * instead (`rootGraphOf`), because editing inside a box should not
   * silence the rest of the instrument.
   */
  subpatchStack: { nodeId: string; label: string; graph: AudioGraph }[]

  /**
   * Named parameter snapshots. Travel with the patch; see state/presets.ts
   * for what they do and do not capture.
   */
  presets: Preset[]
  /**
   * Preset the patch was last set from, for UI affordance only. Cleared as
   * soon as any param moves — a dot next to a name that no longer describes
   * what you are hearing is worse than no dot.
   */
  activePresetId: string | null

  /**
   * Shell panel sizes. Not history-tracked — resizing a rail is a UI
   * preference, not a patch edit. Serialised into `.dpatch` so preferred
   * layout travels with a patch.
   */
  layout: LayoutSizes

  /**
   * Currently-selected compile target. Defaults to 'daisy_seed' so
   * existing patches behave identically to the single-target era.
   */
  target: BoardTarget

  /**
   * True when the user has explicitly picked a target via the TopBar
   * dropdown. While true, autodetect MUST NOT override the selection —
   * the explicit pick "wins" until the user releases the lock.
   */
  targetLockedByUser: boolean

  /**
   * Latest unambiguous autodetection result (mirrors
   * `DetectionResult.detectedBoard` from the preload bridge). `null` when
   * nothing is plugged in or when multiple targets are simultaneously
   * present (ambiguous — user must pick manually).
   */
  detectedBoard: BoardTarget | null

  /**
   * Daisy-only — selected flash mode (internal / qspi / sram). Drives
   * both the generated Makefile's `APP_TYPE` and the DFU target address
   * used by the flash service. Default `'qspi'` matches the factory
   * Daisy-Bootloader default for stock Seeds. Persisted to `.dpatch`.
   */
  daisyFlashMode: DaisyFlashMode
}

export interface EditorStoreActions {
  addNode(kind: NodeKind, position: { x: number; y: number }): string
  removeNode(id: string): void
  moveNode(id: string, position: { x: number; y: number }): void
  updateNode(id: string, patch: Partial<NodeInstance>): void
  setParam(id: string, paramId: string, value: number | string): void

  connect(from: Connection['from'], to: Connection['to']): string | null
  disconnect(connId: string): void

  selectNode(id: string | null): void
  select(ids: string[] | string | null, mode?: SelectMode): void
  setPlaying(playing: boolean): void
  setStatus(status: EditorStoreState['status']): void

  loadGraph(
    graph: AudioGraph,
    filePath?: string | null,
    hardware?: HardwareLayout,
    presets?: Preset[]
  ): void
  resetGraph(): void

  /* hardware view */
  setView(view: 'patch' | 'hardware' | 'perform'): void
  addHardware(kind: HardwareKind, position: { x: number; y: number }): string
  removeHardware(id: string): void
  moveHardware(id: string, position: { x: number; y: number }): void
  renameHardware(id: string, label: string): void
  setHardwarePin(id: string, role: string, pin: BoardPin | null): void
  setHardwareConfig(id: string, key: string, value: number | string | boolean): void
  selectHardware(id: string | null): void
  /**
   * Reassign pin bindings that don't exist on the current board, leaving
   * valid ones untouched. The escape hatch after a board switch.
   */
  repinForBoard(): void
  resetHardware(): void

  /**
   * Move / resize / hide a control on the PERFORMANCE surface.
   *
   * Separate from `moveHardware`, which moves the physical part. Arranging
   * for playability must not move a drill hole. Passing `null` clears the
   * override so the control follows the panel again.
   */
  setPerformPlacement(id: string, patch: PerformPlacement | null): void

  /* subpatches — see state/subpatch.ts */
  /** Pull the current selection into a new subpatch. No-op if it needs too many ports. */
  collapseSelectionToSubpatch(): string | null
  /** Dissolve a subpatch back into this level. */
  expandSubpatchNode(id: string): void
  /** Descend into a subpatch; `graph` becomes its body. */
  enterSubpatch(id: string): void
  /** Come back up one level, writing the edited body back. */
  exitSubpatch(): void
  /** Drop every performance override; the surface mirrors the panel again. */
  resetPerformLayout(): void

  /* presets — see state/presets.ts */
  capturePreset(name?: string): string
  recallPreset(id: string): void
  deletePreset(id: string): void
  renamePreset(id: string, name: string): void
  reorderPreset(id: string, toIndex: number): void
  /** Overwrite an existing preset with the current parameter state. */
  updatePreset(id: string): void
  /** Interpolate between two presets. `t` runs 0 (a) to 1 (b). */
  morphPresets(aId: string, bId: string, t: number): void

  /* history */
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
  /**
   * Drag-gesture coalescing. Rete calls `beginTransaction()` at drag start
   * and `endTransaction()` at drag end. Between them, graph mutations do
   * NOT push onto the history stack — only `endTransaction` commits a
   * single entry representing the whole drag. Same mechanism is used by
   * slider drags in the Inspector (pointerdown / pointerup).
   */
  beginTransaction(): void
  endTransaction(): void

  /* clipboard / multi-select ops */
  copySelection(): void
  cutSelection(): void
  paste(position?: { x: number; y: number }): void
  deleteSelection(): void
  selectAll(): void

  /* file meta */
  setFilePath(path: string | null): void
  markClean(): void

  /* layout (UI sizes — not history-tracked) */
  setPaletteW(px: number): void
  setInspectorW(px: number): void
  setBuildLogH(px: number): void
  setSerialMonitorH(px: number): void
  setCodePanelH(px: number): void
  /** Replace layout wholesale (used when loading a `.dpatch`). */
  setLayout(layout: Partial<LayoutSizes>): void

  /* palette UI prefs (not history-tracked — same story as resize) */
  setPaletteCollapsed(collapsed: boolean): void
  togglePaletteCollapsed(): void
  setPaletteCompact(compact: boolean): void
  togglePaletteCompact(): void
  toggleCategoryCollapsed(category: string): void
  setPaletteFilter(mode: PaletteFilterMode): void
  /** Push a kind onto the recent-drops list (front, deduped, cap 8). */
  noteRecentKind(kind: NodeKind): void

  /** Patch-canvas grid / selection-gesture preferences. */
  setCanvasPrefs(
    patch: Partial<Pick<LayoutSizes, 'gridShow' | 'gridSnap' | 'gridSize' | 'marqueeSelect'>>
  ): void

  /* per-node view state — collapse chevron on a Rete node */
  toggleCollapsed(id: string): void
  setCollapsed(ids: string[], collapsed: boolean): void

  /**
   * Switch compile target (explicit USER action — e.g. TopBar dropdown).
   * Also sets `targetLockedByUser = true` so subsequent autodetect ticks
   * respect the pick. Also updates the hardware layout's `board` field
   * so saved patches remember their target. Pin assignments stay intact —
   * the HardwareView flags any that are invalid on the new board instead
   * of clearing them.
   */
  setTarget(target: BoardTarget): void

  /**
   * Switch compile target from an AUTOMATED source (autodetect). Applies
   * the change only if the user hasn't locked the target. Does NOT set
   * `targetLockedByUser`. The underlying hardware-board flip and status
   * bookkeeping match `setTarget()`.
   */
  autoSetTarget(target: BoardTarget): void

  /**
   * Release the "user pick" lock. The next autodetect tick that yields
   * an unambiguous board will apply automatically. Used by the TopBar
   * lock affordance.
   */
  releaseTargetLock(): void

  /** Mirror the current autodetection result. Called by `detectBoards()`. */
  setDetectedBoard(board: BoardTarget | null): void

  /**
   * Daisy-only flash mode picker. Writes into the same store slot used
   * by both the TopBar segmented control and the StatusBar popover —
   * keeps both UIs in sync through one store field.
   */
  setDaisyFlashMode(mode: DaisyFlashMode): void
}

export type EditorStore = EditorStoreState & EditorStoreActions

export type EngineState = 'stopped' | 'starting' | 'running' | 'error'

/**
 * A single frame pulled off a tap's `AnalyserNode`. `timeDomain` is always
 * populated (length 256, -1..1). `frequency` is only produced when the tap
 * was created with `wantFrequency: true`; values are normalised to 0..1.
 */
export interface ScopeFrame {
  timeDomain: Float32Array
  frequency?: Float32Array
}

/**
 * Handle returned by {@link AudioEngine.tap}. Call `stop()` to disconnect the
 * analyser, remove the frame-callback from the global rAF loop, and release
 * queued requests for nodes that never came live.
 */
export interface Tap {
  stop: () => void
}

export interface AudioEngine {
  readonly state: EngineState
  start(): Promise<void>
  stop(): Promise<void>
  setGraph(graph: AudioGraph): void
  updateParam(nodeId: string, paramId: string, value: number | string): void
  onStateChange(listener: (state: EngineState, error?: Error) => void): () => void
  /**
   * Fork the first output of the node identified by `nodeId` into an
   * `AnalyserNode` and invoke `onFrame` on every animation frame with the
   * latest time-domain (and optionally frequency) data. The original signal
   * flow is NOT disrupted — the analyser sits as a branch.
   *
   * If the node is not currently live (engine stopped or graph hasn't been
   * applied yet) the tap is queued and attaches when the node is created.
   */
  tap(
    nodeId: string,
    onFrame: (f: ScopeFrame) => void,
    opts?: { wantFrequency?: boolean }
  ): Tap
}
