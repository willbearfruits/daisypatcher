/**
 * Frontend wrapper around the Electron file-dialog + fs IPC surface.
 *
 * Keeps UI components free of `window.daisy.*` plumbing; all persistence
 * happens through these three functions plus the store's `loadGraph` /
 * `resetGraph`.
 *
 * File format (`.dpatch`) — v2 envelope:
 *
 *   { "dpatch": 2, "graph": AudioGraph, "hardware": HardwareLayout }
 *
 * v1 files (legacy) are the AudioGraph at the top level — no envelope,
 * no hardware section. We detect by shape: presence of `dpatch` marker
 * OR a top-level `graph` field means v2; otherwise treat the whole file
 * as an AudioGraph and synthesize an empty hardware layout.
 */

import type { AudioGraph, NodeKind } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import { coerceBoardId } from '../../shared/boards'
import { emptyHardwareLayout } from '@/types/hardware'
import type { DaisyFlashMode, LayoutSizes, PaletteFilterMode } from '@/types/store'
import { parsePresets, type Preset } from '@/state/presets'
import { requestConfirm } from '@/components/layout/ConfirmDialog'
import { rootGraphOf, useEditorStore } from './store'

type Store = typeof useEditorStore

/**
 * Layout section of the `.dpatch` envelope. Carries UI preferences
 * (rail/panel sizes, palette prefs) AND `daisyFlashMode` so the user's
 * flash-mode choice travels with a patch. Older saves may omit
 * `daisyFlashMode`; the store falls back to the default `'qspi'`.
 */
interface DpatchLayoutSection extends Partial<LayoutSizes> {
  daisyFlashMode?: DaisyFlashMode
}

export interface DpatchEnvelope {
  dpatch: 2
  graph: AudioGraph
  hardware: HardwareLayout
  /**
   * Named parameter snapshots. Optional and additive: a file written
   * before presets existed simply has none, and one written with them
   * still loads in an older build, which is why this did not need a
   * version bump.
   */
  presets?: Preset[]
  /** Optional — absent on older saves; the store falls back to defaults. */
  layout?: DpatchLayoutSection
}

function basename(p: string): string {
  const sep = p.lastIndexOf('/') >= 0 ? p.lastIndexOf('/') : p.lastIndexOf('\\')
  return sep >= 0 ? p.slice(sep + 1) : p
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/** Minimal structural check — fails fast for obviously-not-a-patch files. */
function validateGraph(data: unknown): data is AudioGraph {
  if (!isObject(data)) return false
  return (
    Array.isArray((data as Record<string, unknown>).nodes) &&
    Array.isArray((data as Record<string, unknown>).connections) &&
    isObject((data as Record<string, unknown>).meta)
  )
}

function validateHardware(data: unknown): data is HardwareLayout {
  if (!isObject(data)) return false
  return (
    Array.isArray((data as Record<string, unknown>).components) &&
    isObject((data as Record<string, unknown>).meta)
  )
}

/**
 * Lenient shape check for the optional layout block. Any missing fields fall
 * through to the store's defaults; non-number values are dropped.
 */
function extractLayout(raw: unknown): DpatchLayoutSection | undefined {
  if (!isObject(raw)) return undefined
  const out: DpatchLayoutSection = {}
  const src = raw as Record<string, unknown>
  if (typeof src.paletteW === 'number') out.paletteW = src.paletteW
  if (typeof src.inspectorW === 'number') out.inspectorW = src.inspectorW
  if (typeof src.buildLogH === 'number') out.buildLogH = src.buildLogH
  if (typeof src.serialMonitorH === 'number') out.serialMonitorH = src.serialMonitorH
  if (typeof src.codePanelH === 'number') out.codePanelH = src.codePanelH
  // Canvas prefs. These were written by every save and dropped by every
  // load until the round-trip test caught it — snap-to-grid came back on
  // each time a patch was reopened.
  if (typeof src.gridShow === 'boolean') out.gridShow = src.gridShow
  if (typeof src.gridSnap === 'boolean') out.gridSnap = src.gridSnap
  if (typeof src.gridSize === 'number' && src.gridSize > 0) out.gridSize = src.gridSize
  if (typeof src.marqueeSelect === 'boolean') out.marqueeSelect = src.marqueeSelect
  if (typeof src.paletteCollapsed === 'boolean') out.paletteCollapsed = src.paletteCollapsed
  if (typeof src.paletteCompact === 'boolean') out.paletteCompact = src.paletteCompact
  if (Array.isArray(src.categoriesCollapsed)) {
    out.categoriesCollapsed = src.categoriesCollapsed.filter(
      (c): c is string => typeof c === 'string'
    )
  }
  if (
    src.paletteFilter === 'all' ||
    src.paletteFilter === 'available' ||
    src.paletteFilter === 'native'
  ) {
    out.paletteFilter = src.paletteFilter as PaletteFilterMode
  }
  if (Array.isArray(src.recentKinds)) {
    out.recentKinds = src.recentKinds.filter(
      (k): k is NodeKind => typeof k === 'string'
    )
  }
  if (
    src.daisyFlashMode === 'internal' ||
    src.daisyFlashMode === 'qspi' ||
    src.daisyFlashMode === 'sram'
  ) {
    out.daisyFlashMode = src.daisyFlashMode
  }
  return Object.keys(out).length ? out : undefined
}

/** Parse a file, handling v1 (bare graph) and v2 (envelope) formats. */
export function parseDpatch(parsed: unknown): {
  graph: AudioGraph
  hardware: HardwareLayout
  presets: Preset[]
  layout?: DpatchLayoutSection
} | null {
  if (!isObject(parsed)) return null
  // v2 envelope — either a `dpatch` version marker OR a top-level `graph` field.
  if ('dpatch' in parsed || 'graph' in parsed) {
    const envelope = parsed as Partial<DpatchEnvelope>
    if (!validateGraph(envelope.graph)) return null
    /*
     * Trust boundary. `board` comes off disk and could be anything —
     * an older spelling, a hand-edited file, a board we dropped. The
     * board lookup tables are now total with no Daisy fallback, so an
     * unrecognised id must be narrowed here rather than blowing up
     * downstream. `coerceBoardId` also maps the legacy 'esp32_s3'
     * spelling onto its current id.
     */
    const hardware = validateHardware(envelope.hardware)
      ? { ...envelope.hardware, board: coerceBoardId(envelope.hardware.board) }
      : emptyHardwareLayout()
    const layout = extractLayout(envelope.layout)
    // Same trust boundary as `hardware`: hand-edited or truncated preset
    // data must not reach the store, so it is validated rather than cast.
    return { graph: envelope.graph, hardware, presets: parsePresets(envelope.presets), layout }
  }
  // v1 — whole file is the graph.
  if (validateGraph(parsed)) {
    return { graph: parsed, hardware: emptyHardwareLayout(), presets: [] }
  }
  return null
}

/**
 * Save.
 *
 * Writes straight back to `filePath` when the patch already has one — this
 * used to open the Save dialog on EVERY Ctrl+S, which is the single most
 * annoying thing a desktop app can do, and made "did that save?" a real
 * question. `savePatchAs` is the dialog path, and this falls through to it
 * for a patch that has never been saved.
 */
export async function savePatch(
  store: Store = useEditorStore
): Promise<{ saved: boolean; path?: string }> {
  const s = store.getState()
  if (s.filePath) return writePatchTo(s.filePath, store)
  return savePatchAs(store)
}

/** Save under a new name, always via the dialog. */
export async function savePatchAs(
  store: Store = useEditorStore
): Promise<{ saved: boolean; path?: string }> {
  const s = store.getState()
  const defaultName = (s.graph.meta.name || 'untitled') + '.dpatch'
  const { canceled, path } = await window.daisy.dialogs.save(defaultName)
  if (canceled || !path) return { saved: false }
  return writePatchTo(path, store)
}

/**
 * The envelope a save writes, from the store's current state.
 *
 * Pure and exported so the round-trip can be tested headlessly: build a
 * rich state, serialise it here, parse it with `parseDpatch`, and compare
 * — the one check that proves a patch survives its own file format.
 */
export function serializePatch(
  s: ReturnType<Store['getState']>,
  name: string
): DpatchEnvelope {
  /*
   * Save the ROOT patch. `s.graph` is whichever level is open, so saving
   * while inside a subpatch would otherwise write the body out as if it
   * were the whole instrument — and lose everything above it.
   */
  const rootGraph = rootGraphOf(s)
  const graphToSave: AudioGraph = { ...rootGraph, meta: { ...rootGraph.meta, name } }
  const hardwareToSave: HardwareLayout = {
    ...s.hardware,
    meta: { ...s.hardware.meta, name }
  }
  return {
    dpatch: 2,
    graph: graphToSave,
    hardware: hardwareToSave,
    presets: s.presets,
    // Persist the user's preferred rail/panel sizes so reopening the patch
    // restores their shell. Safe to omit on load (store falls back to default).
    // `daisyFlashMode` rides in the same section so a patch remembers its
    // intended flash target across saves.
    layout: { ...s.layout, daisyFlashMode: s.daisyFlashMode }
  }
}

async function writePatchTo(
  path: string,
  store: Store
): Promise<{ saved: boolean; path?: string }> {
  const s = store.getState()
  const envelope = serializePatch(s, stripExt(basename(path)))
  try {
    await window.daisy.fs.writeFile(path, JSON.stringify(envelope, null, 2))
    store.setState({
      graph: envelope.graph,
      hardware: envelope.hardware,
      filePath: path,
      isDirty: false
    })
    s.setStatus({ kind: 'info', message: `saved ${basename(path)}` })
    noteRecent(path)
    return { saved: true, path }
  } catch (err) {
    s.setStatus({
      kind: 'error',
      message: `save failed: ${(err as Error).message}`
    })
    return { saved: false }
  }
}

/** Tell main a file was actually used, so File → Open Recent learns it. */
function noteRecent(path: string): void {
  const w = window as unknown as { daisy?: { recent?: { add: (p: string) => void } } }
  w.daisy?.recent?.add(path)
}

/** Should we throw away what is on the canvas? Asks only if there is something to lose. */
async function confirmDiscard(store: Store, title: string): Promise<boolean> {
  const s = store.getState()
  if (!s.isDirty && s.history.past.length === 0) return true
  return requestConfirm({
    title,
    message: 'Discard unsaved changes?',
    confirmLabel: 'Discard',
    danger: true
  })
}

export async function openPatch(
  store: Store = useEditorStore
): Promise<{ loaded: boolean; path?: string }> {
  /*
   * Ask BEFORE the file dialog, not after: picking a file and then being
   * asked whether to discard your work is the wrong order, and cancelling
   * at that point has already cost you the pick. `newPatch` had this
   * guard; `openPatch` did not, so opening a file could silently drop an
   * hour of unsaved patching.
   */
  if (!(await confirmDiscard(store, 'Open patch'))) return { loaded: false }
  const { canceled, path } = await window.daisy.dialogs.open()
  if (canceled || !path) return { loaded: false }
  return openPatchFromPath(path, store)
}

/**
 * Push a parsed file into the store — the load half of the round-trip.
 * Split out from `openPatchFromPath` so the headless test can run the
 * exact code the app runs, not a re-implementation of it.
 */
export function applyLoadedPatch(
  loaded: NonNullable<ReturnType<typeof parseDpatch>>,
  path: string | null,
  store: Store = useEditorStore
): void {
  const s = store.getState()
  const name = path ? stripExt(basename(path)) : loaded.graph.meta.name
  const graph: AudioGraph = {
    ...loaded.graph,
    meta: { ...loaded.graph.meta, name }
  }
  const hardware: HardwareLayout = {
    ...loaded.hardware,
    meta: { ...loaded.hardware.meta, name }
  }
  s.loadGraph(graph, path, hardware, loaded.presets)
  if (loaded.layout) {
    const { daisyFlashMode, ...layoutRest } = loaded.layout
    s.setLayout(layoutRest)
    // Flash-mode lives outside LayoutSizes on the store; apply it
    // separately so older files that omit the field keep the default.
    if (daisyFlashMode) s.setDaisyFlashMode(daisyFlashMode)
  }
}

/**
 * Load a patch the caller already has a path for — a bundled example, a
 * recent file. Does NOT confirm; the caller decides whether there is
 * anything to protect.
 */
export async function openPatchFromPath(
  path: string,
  store: Store = useEditorStore
): Promise<{ loaded: boolean; path?: string }> {
  const s = store.getState()
  try {
    const text = await window.daisy.fs.readFile(path)
    const parsed: unknown = JSON.parse(text)
    const loaded = parseDpatch(parsed)
    if (!loaded) {
      s.setStatus({ kind: 'error', message: 'not a valid patch file' })
      return { loaded: false }
    }
    applyLoadedPatch(loaded, path, store)
    s.setStatus({ kind: 'info', message: `opened ${basename(path)}` })
    noteRecent(path)
    return { loaded: true, path }
  } catch (err) {
    s.setStatus({
      kind: 'error',
      message: `open failed: ${(err as Error).message}`
    })
    return { loaded: false }
  }
}

export async function newPatch(store: Store = useEditorStore): Promise<void> {
  const s = store.getState()
  if (!(await confirmDiscard(store, 'New patch'))) return
  s.resetGraph()
  s.setStatus({ kind: 'idle', message: 'ready' })
}
