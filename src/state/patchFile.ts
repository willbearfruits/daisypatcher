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

import type { AudioGraph } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import { emptyHardwareLayout } from '@/types/hardware'
import type { LayoutSizes } from '@/types/store'
import { useEditorStore } from './store'

type Store = typeof useEditorStore

interface DpatchEnvelope {
  dpatch: 2
  graph: AudioGraph
  hardware: HardwareLayout
  /** Optional — absent on older saves; the store falls back to defaults. */
  layout?: Partial<LayoutSizes>
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
function extractLayout(raw: unknown): Partial<LayoutSizes> | undefined {
  if (!isObject(raw)) return undefined
  const out: Partial<LayoutSizes> = {}
  const src = raw as Record<string, unknown>
  if (typeof src.paletteW === 'number') out.paletteW = src.paletteW
  if (typeof src.inspectorW === 'number') out.inspectorW = src.inspectorW
  if (typeof src.buildLogH === 'number') out.buildLogH = src.buildLogH
  if (typeof src.serialMonitorH === 'number') out.serialMonitorH = src.serialMonitorH
  return Object.keys(out).length ? out : undefined
}

/** Parse a file, handling v1 (bare graph) and v2 (envelope) formats. */
function parseDpatch(parsed: unknown): {
  graph: AudioGraph
  hardware: HardwareLayout
  layout?: Partial<LayoutSizes>
} | null {
  if (!isObject(parsed)) return null
  // v2 envelope — either a `dpatch` version marker OR a top-level `graph` field.
  if ('dpatch' in parsed || 'graph' in parsed) {
    const envelope = parsed as Partial<DpatchEnvelope>
    if (!validateGraph(envelope.graph)) return null
    const hardware = validateHardware(envelope.hardware) ? envelope.hardware : emptyHardwareLayout()
    const layout = extractLayout(envelope.layout)
    return { graph: envelope.graph, hardware, layout }
  }
  // v1 — whole file is the graph.
  if (validateGraph(parsed)) {
    return { graph: parsed, hardware: emptyHardwareLayout() }
  }
  return null
}

export async function savePatch(
  store: Store = useEditorStore
): Promise<{ saved: boolean; path?: string }> {
  const s = store.getState()
  const defaultName = (s.graph.meta.name || 'untitled') + '.dpatch'

  const { canceled, path } = await window.daisy.dialogs.save(defaultName)
  if (canceled || !path) return { saved: false }

  const name = stripExt(basename(path))
  const graphToSave: AudioGraph = { ...s.graph, meta: { ...s.graph.meta, name } }
  const hardwareToSave: HardwareLayout = {
    ...s.hardware,
    meta: { ...s.hardware.meta, name }
  }
  const envelope: DpatchEnvelope = {
    dpatch: 2,
    graph: graphToSave,
    hardware: hardwareToSave,
    // Persist the user's preferred rail/panel sizes so reopening the patch
    // restores their shell. Safe to omit on load (store falls back to default).
    layout: { ...s.layout }
  }
  try {
    await window.daisy.fs.writeFile(path, JSON.stringify(envelope, null, 2))
    store.setState({
      graph: graphToSave,
      hardware: hardwareToSave,
      filePath: path,
      isDirty: false
    })
    s.setStatus({ kind: 'info', message: `saved ${basename(path)}` })
    return { saved: true, path }
  } catch (err) {
    s.setStatus({
      kind: 'error',
      message: `save failed: ${(err as Error).message}`
    })
    return { saved: false }
  }
}

export async function openPatch(
  store: Store = useEditorStore
): Promise<{ loaded: boolean; path?: string }> {
  const s = store.getState()
  const { canceled, path } = await window.daisy.dialogs.open()
  if (canceled || !path) return { loaded: false }

  try {
    const text = await window.daisy.fs.readFile(path)
    const parsed: unknown = JSON.parse(text)
    const loaded = parseDpatch(parsed)
    if (!loaded) {
      s.setStatus({ kind: 'error', message: 'not a valid patch file' })
      return { loaded: false }
    }
    const name = stripExt(basename(path))
    const graph: AudioGraph = {
      ...loaded.graph,
      meta: { ...loaded.graph.meta, name }
    }
    const hardware: HardwareLayout = {
      ...loaded.hardware,
      meta: { ...loaded.hardware.meta, name }
    }
    s.loadGraph(graph, path, hardware)
    if (loaded.layout) s.setLayout(loaded.layout)
    s.setStatus({ kind: 'info', message: `opened ${basename(path)}` })
    return { loaded: true, path }
  } catch (err) {
    s.setStatus({
      kind: 'error',
      message: `open failed: ${(err as Error).message}`
    })
    return { loaded: false }
  }
}

export function newPatch(store: Store = useEditorStore): void {
  const s = store.getState()
  if (s.isDirty || s.history.past.length > 0) {
    const ok = window.confirm('Discard unsaved changes?')
    if (!ok) return
  }
  s.resetGraph()
  s.setStatus({ kind: 'idle', message: 'ready' })
}
