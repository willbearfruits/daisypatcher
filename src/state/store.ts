/**
 * Zustand store implementing EditorStore. Single source of truth for the
 * graph, selection, transport state, status line, history, clipboard,
 * AND the hardware layout (physical components wired to Seed pins).
 *
 * History coalescing: the store exposes `beginTransaction()` /
 * `endTransaction()`. While a transaction is open, mutations are applied
 * in-place (no history push) and the snapshot taken at
 * `beginTransaction()` is committed on `endTransaction()`. Rete calls
 * these on drag start/end, the Inspector calls them on slider
 * pointerdown/pointerup, and the HardwareView calls them on hardware-card
 * drags, so a 200-event drag becomes one undo step.
 *
 * For one-shot mutations (addNode, connect, setParam, addHardware, etc.
 * called outside a transaction), each call pushes a snapshot of both
 * graph AND hardware onto `past` and clears `future`.
 */

import { create } from 'zustand'
import { nanoid } from 'nanoid'

import type { BoardTarget, DaisyFlashMode, EditorStore, HistorySnapshot, LayoutSizes } from '@/types/store'
import type { AudioGraph, Connection, NodeInstance, NodeKind } from '@/types/graph'
import { emptyGraph } from '@/types/graph'
import type { BoardPin, HardwareKind, HardwareLayout, PlacedComponent } from '@/types/hardware'
import { emptyHardwareLayout, KIND_ROLES } from '@/types/hardware'
import { getBoardPinout } from '@/hardware/boardPinout'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { boardForTarget, targetForBoard } from '@/codegen/targets'

const HISTORY_LIMIT = 50

/**
 * Default shell sizes. The numbers mirror `shared.panelW` / `shared.inspectorW`
 * in the token file; we keep a typed copy here so the store's initial state
 * is free of CSS-string parsing.
 */
const DEFAULT_LAYOUT: LayoutSizes = {
  paletteW: 240,
  inspectorW: 280,
  buildLogH: 220,
  serialMonitorH: 260,
  paletteCollapsed: false,
  // Compact = grid tiles (icon + short label) instead of one line per kind
  // with a description. Default ON so the 70+ catalog is browsable at a
  // glance — resizing the palette wider automatically adds more columns.
  paletteCompact: true,
  categoriesCollapsed: [],
  paletteFilter: 'available',
  recentKinds: []
}

/** FIFO cap for `layout.recentKinds`. */
const RECENT_KINDS_LIMIT = 8

/** Resize clamps, tuned to keep the shell usable on a 1280x720 display. */
const LAYOUT_LIMITS = {
  paletteW: { min: 160, max: 480 },
  inspectorW: { min: 200, max: 520 },
  /** Build log height is clamped to 70% of the viewport at apply time. */
  buildLogH: { min: 120, max: 2000 },
  serialMonitorH: { min: 160, max: 2000 }
} as const

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function initialParams(kind: NodeKind): Record<string, number | string> {
  const def = NODE_DEFINITIONS[kind]
  const out: Record<string, number | string> = {}
  for (const p of def.params) out[p.id] = p.default
  return out
}

/**
 * Detect whether adding `from -> to` would create a cycle via simple DFS.
 */
function wouldCycle(
  connections: Connection[],
  from: Connection['from'],
  to: Connection['to']
): boolean {
  if (from.nodeId === to.nodeId) return true
  const adj = new Map<string, string[]>()
  for (const c of connections) {
    const list = adj.get(c.from.nodeId) ?? []
    list.push(c.to.nodeId)
    adj.set(c.from.nodeId, list)
  }
  const stack = [to.nodeId]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === from.nodeId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of adj.get(cur) ?? []) stack.push(next)
  }
  return false
}

function socketSignal(
  graph: AudioGraph,
  endpoint: { nodeId: string; socketId: string },
  direction: 'input' | 'output'
): string | null {
  const node = graph.nodes.find((n) => n.id === endpoint.nodeId)
  if (!node) return null
  const def = NODE_DEFINITIONS[node.kind]
  const sockets = direction === 'input' ? def.inputs : def.outputs
  const s = sockets.find((x) => x.id === endpoint.socketId)
  return s ? s.signal : null
}

/* ---------- history bookkeeping ---------- */

/**
 * Transaction depth. Zero means "every mutation commits". > 0 means we're
 * inside a drag/slider gesture; mutations skip the history push. The snapshot
 * captured by beginTransaction() is held here and committed on the matching
 * endTransaction().
 */
let txDepth = 0
let txSnapshot: HistorySnapshot | null = null

/** Push `prev` onto the past stack (respecting limit) and clear future. */
function pushHistory(
  past: HistorySnapshot[],
  _future: HistorySnapshot[],
  prev: HistorySnapshot
): { past: HistorySnapshot[]; future: HistorySnapshot[] } {
  const next = past.length >= HISTORY_LIMIT ? past.slice(1) : past.slice()
  next.push(prev)
  return { past: next, future: [] }
}

/**
 * Roles that share a bus with other devices and must NOT be excluded just
 * because another component already uses the pin. I2C `sda`/`scl` are the
 * primary case: an OLED + a gyroscope + a ToF sensor can and should share
 * the same two pins. Everything else (wiper, io, signal, anode, rx, ...)
 * is single-ownership.
 */
const SHARED_BUS_ROLES = new Set(['sda', 'scl', 'sck', 'mclk'])

/**
 * Map a patch-side NodeKind to the HardwareKind it represents physically.
 * Used by `addNode` to auto-create a paired `PlacedComponent` whenever a
 * hardware-category node is dropped in the patch. Returns null for DSP
 * nodes that have no physical counterpart. Multiple node kinds can map to
 * the same hardware kind (e.g. three MIDI node kinds all share one
 * `midi_jack`); first-drop creates, subsequent drops still spawn a new
 * one — users can manually coalesce via the hardware view if desired.
 */
export function hardwareKindForNodeKind(nodeKind: NodeKind): HardwareKind | null {
  switch (nodeKind) {
    case 'knob_in':       return 'pot'
    case 'gate_in':       return 'gate_jack'
    case 'button':        return 'button'
    case 'led':           return 'led'
    case 'switch_3way':   return 'switch_3way'
    case 'i2s_in':        return 'i2s_codec'
    case 'i2s_out':       return 'i2s_codec'
    case 'midi_in_note':  return 'midi_jack'
    case 'midi_in_cc':    return 'midi_jack'
    case 'midi_out_note': return 'midi_jack'
    case 'oled':          return 'oled_ssd1306'
    default:              return null
  }
}

/** Default labels for newly-placed hardware components. */
function defaultHardwareLabel(kind: HardwareKind): string {
  const m: Record<HardwareKind, string> = {
    pot: 'Pot',
    button: 'Button',
    switch_3way: 'Switch',
    led: 'LED',
    gate_jack: 'Gate',
    cv_jack: 'CV',
    audio_jack: 'Audio',
    midi_jack: 'MIDI',
    oled_ssd1306: 'OLED',
    i2s_codec: 'I2S',
    encoder: 'Encoder',
    slider: 'Slider',
    touch_ribbon: 'Ribbon',
    ldr: 'LDR',
    gyroscope: 'Gyro',
    magnetometer: 'Mag',
    tof: 'ToF',
    electret: 'Mic',
    piezo: 'Piezo'
  }
  return m[kind]
}

/**
 * Count placed components whose pin bindings reference pins that don't
 * exist on the target board's pinout. Used by `setTarget` to surface a
 * warn-status when switching boards leaves a patch in an inconsistent
 * state. Implementation is simple prefix-checks so we avoid importing
 * the full pinout tables here (which would create a circular import).
 */
function countInvalidComponentsForBoard(
  layout: HardwareLayout,
  board: HardwareLayout['board']
): number {
  let bad = 0
  for (const c of layout.components) {
    for (const pin of Object.values(c.pins)) {
      if (typeof pin !== 'string') continue
      const isSeed = /^D\d{1,2}$/.test(pin)
      const isEsp = /^GPIO\d+$/.test(pin)
      if (board === 'daisy_seed' && !isSeed) { bad++; break }
      if (board === 'esp32_s3_devkitc' && !isEsp) { bad++; break }
    }
  }
  return bad
}

/** Silence unused-import warning — the helper is pulled in for future use. */
void targetForBoard

function defaultHardwareConfig(kind: HardwareKind): Record<string, number | string | boolean> {
  // `rotation` and kind-specific defaults. Rotation lives in config to keep
  // the `PlacedComponent` schema stable (optional config keys tolerate
  // unknown kinds cleanly).
  const base: Record<string, number | string | boolean> = { rotation: 0 }
  switch (kind) {
    case 'pot':          return { ...base, taper: 'linear' }
    case 'led':          return { ...base, color: 'white', pwm: false }
    case 'switch_3way':  return { ...base, positions: 3 }
    case 'encoder':      return { ...base, detents: 24, withSwitch: true }
    case 'oled_ssd1306': return { ...base, width: 128, height: 64, address: '0x3C' }
    case 'i2s_codec':    return { ...base, model: 'pcm3060' }
    case 'slider':       return { ...base, orientation: 'vertical', travel: 60 }
    case 'touch_ribbon': return { ...base, orientation: 'vertical', length: 80 }
    case 'ldr':          return { ...base }
    case 'gyroscope':    return { ...base, address: '0x68', rate: 200, pullup: true, hasInt: true }
    case 'magnetometer': return { ...base, address: '0x1E', offsetX: 0, offsetY: 0, offsetZ: 0 }
    case 'tof':          return { ...base, address: '0x29', profile: 'short', hasXshut: true }
    case 'electret':     return { ...base, gainDb: 20, acCouple: true }
    case 'piezo':        return { ...base, direction: 'input', threshold: 0.2 }
    default:             return base
  }
}

export const useEditorStore = create<EditorStore>((set, get) => {
  /**
   * Core mutation helper. Takes a producer over the full `{graph, hardware}`
   * tuple and commits atomically — a single undo step captures both halves.
   */
  function mutate(
    producer: (s: { graph: AudioGraph; hardware: HardwareLayout }) => {
      graph?: AudioGraph
      hardware?: HardwareLayout
    } | null,
    opts?: { dirty?: boolean }
  ) {
    const prevGraph = get().graph
    const prevHw = get().hardware
    const patch = producer({ graph: prevGraph, hardware: prevHw })
    if (!patch) return
    const nextGraph = patch.graph ?? prevGraph
    const nextHw = patch.hardware ?? prevHw
    if (nextGraph === prevGraph && nextHw === prevHw) return

    if (txDepth > 0) {
      set({
        graph: nextGraph,
        hardware: nextHw,
        isDirty: opts?.dirty !== false
      })
      return
    }

    const snapshot: HistorySnapshot = { graph: prevGraph, hardware: prevHw }
    const { past, future } = pushHistory(get().history.past, get().history.future, snapshot)
    set({
      graph: nextGraph,
      hardware: nextHw,
      history: { past, future },
      isDirty: opts?.dirty !== false
    })
  }

  /**
   * Keep the back-compat `selectedNodeId` in sync with the `selection` set.
   * Rule: single selection reveals its id; zero or multi selection -> null.
   */
  function syncedSelection(sel: Set<string>): { selection: Set<string>; selectedNodeId: string | null } {
    const only = sel.size === 1 ? sel.values().next().value ?? null : null
    return { selection: sel, selectedNodeId: only }
  }

  return {
    graph: emptyGraph(),
    selectedNodeId: null,
    selection: new Set<string>(),
    history: { past: [], future: [] },
    clipboard: null,
    isDirty: false,
    filePath: null,
    isPlaying: false,
    status: { kind: 'idle', message: 'ready' },

    hardware: emptyHardwareLayout(),
    view: 'patch',
    selectedHardwareId: null,

    layout: { ...DEFAULT_LAYOUT },

    target: 'daisy_seed' as BoardTarget,
    targetLockedByUser: false,
    detectedBoard: null,
    // Default to QSPI — safe for factory-default Seeds shipped with the
    // Electro-Smith Daisy Bootloader. Users with a bootloader-less Seed
    // switch to 'internal' via the TopBar / StatusBar popover.
    daisyFlashMode: 'qspi' as DaisyFlashMode,

    addNode(kind, position) {
      const id = nanoid(8)
      const params = initialParams(kind)

      /*
       * Auto-link hardware-category nodes to a paired `PlacedComponent`.
       * Dropping a `knob_in` also creates a `pot` in the hardware layout,
       * and the new node's `bindingId` points at it — so the user's intent
       * ("this parameter is driven by a physical control") is expressed
       * once, in the patch, and the hardware view just needs a pin
       * assignment. Both mutations go through the same `mutate()` so undo
       * reverts the pair atomically.
       */
      const hwKind = hardwareKindForNodeKind(kind)
      let hwComponent: PlacedComponent | null = null
      if (hwKind) {
        const hwId = nanoid(8)
        const existingOfKind = get().hardware.components.filter((c) => c.kind === hwKind)
        // Auto-number the label: "Pot 1", "Pot 2" — match `addHardware`.
        let n = 1
        for (const c of existingOfKind) {
          const m = c.label.match(/\b(\d+)\s*$/)
          if (m) n = Math.max(n, Number(m[1]) + 1)
          else n = Math.max(n, existingOfKind.length + 1)
        }
        // Cascade placement so multiple drops don't stack exactly on top
        // of each other in the hardware view. User moves them later.
        const totalPlaced = get().hardware.components.length
        /*
         * Auto-assign each required role to the first free compatible
         * pin on the active board. I2C-ish roles (sda/scl/sck/mclk)
         * share buses — an OLED placed when another I2C sensor already
         * occupies SDA/SCL will reuse the same pins (that's the point
         * of a bus). Single-ownership roles exclude any pin already
         * bound for that role by another component. If no compatible
         * pin is free, the role stays unassigned — user wires manually
         * in the hardware view.
         */
        const pinout = getBoardPinout(get().hardware.board)
        const allExisting = get().hardware.components
        const usedSingleOwnershipPins = new Set<string>()
        for (const c of allExisting) {
          for (const [role, pin] of Object.entries(c.pins)) {
            if (!pin) continue
            if (!SHARED_BUS_ROLES.has(role)) usedSingleOwnershipPins.add(pin as string)
          }
        }
        const assigned: Record<string, string> = {}
        for (const role of KIND_ROLES[hwKind]) {
          const candidates = pinout.pinsForRole(role, hwKind)
          const shared = SHARED_BUS_ROLES.has(role)
          const chosen = candidates.find((p) =>
            shared ? true : !usedSingleOwnershipPins.has(p)
          )
          if (chosen) {
            assigned[role] = chosen
            if (!shared) usedSingleOwnershipPins.add(chosen)
          }
        }

        hwComponent = {
          id: hwId,
          kind: hwKind,
          label: `${defaultHardwareLabel(hwKind)} ${n}`,
          position: { x: 100 + totalPlaced * 40, y: 100 + totalPlaced * 40 },
          pins: assigned,
          config: defaultHardwareConfig(hwKind)
        }
        params.bindingId = hwId
      }

      const node: NodeInstance = { id, kind, position, params }

      mutate((s) => ({
        graph: { ...s.graph, nodes: [...s.graph.nodes, node] },
        hardware: hwComponent
          ? { ...s.hardware, components: [...s.hardware.components, hwComponent] }
          : undefined
      }))

      // Track the drop in the palette's recent-kinds strip. This is a UI
      // pref (not history-tracked), so we patch `layout` directly rather
      // than routing through `mutate`.
      const layout = get().layout
      const dedup = layout.recentKinds.filter((k) => k !== kind)
      const next = [kind, ...dedup].slice(0, RECENT_KINDS_LIMIT)
      if (next.length !== layout.recentKinds.length ||
          next.some((k, i) => k !== layout.recentKinds[i])) {
        set({ layout: { ...layout, recentKinds: next } })
      }
      return id
    },

    removeNode(id) {
      // If this node auto-created a paired hardware component and no other
      // graph node still references that component, remove the hardware
      // side too — symmetric with the auto-link in `addNode`. Preserves
      // the rule: hardware components that live in the layout are exactly
      // the ones the patch graph wants. Undo restores both halves.
      mutate((s) => {
        const leaving = s.graph.nodes.find((n) => n.id === id)
        const bindingId = leaving?.params.bindingId
        const stillReferenced = bindingId
          ? s.graph.nodes.some((n) => n.id !== id && n.params.bindingId === bindingId)
          : false
        const nextGraph = {
          ...s.graph,
          nodes: s.graph.nodes.filter((n) => n.id !== id),
          connections: s.graph.connections.filter(
            (c) => c.from.nodeId !== id && c.to.nodeId !== id
          )
        }
        const dropHw = bindingId && !stillReferenced
        const nextHardware = dropHw
          ? {
              ...s.hardware,
              components: s.hardware.components.filter((c) => c.id !== bindingId)
            }
          : undefined
        return { graph: nextGraph, hardware: nextHardware }
      })
      const sel = new Set(get().selection)
      if (sel.delete(id)) set(syncedSelection(sel))
    },

    moveNode(id, position) {
      mutate((s) => ({
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === id ? { ...n, position } : n))
        }
      }))
    },

    updateNode(id, patch) {
      mutate((s) => ({
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n))
        }
      }))
    },

    setParam(id, paramId, value) {
      mutate((s) => ({
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) =>
            n.id === id ? { ...n, params: { ...n.params, [paramId]: value } } : n
          )
        }
      }))
    },

    connect(from, to) {
      const { graph } = get()
      const dup = graph.connections.some(
        (c) =>
          c.from.nodeId === from.nodeId &&
          c.from.socketId === from.socketId &&
          c.to.nodeId === to.nodeId &&
          c.to.socketId === to.socketId
      )
      if (dup) return null
      const fromSig = socketSignal(graph, from, 'output')
      const toSig = socketSignal(graph, to, 'input')
      if (!fromSig || !toSig || fromSig !== toSig) return null
      if (wouldCycle(graph.connections, from, to)) return null

      const conn: Connection = { id: nanoid(8), from, to }
      mutate((s) => ({ graph: { ...s.graph, connections: [...s.graph.connections, conn] } }))
      return conn.id
    },

    disconnect(connId) {
      mutate((s) => ({
        graph: { ...s.graph, connections: s.graph.connections.filter((c) => c.id !== connId) }
      }))
    },

    selectNode(id) {
      get().select(id, 'replace')
    },

    select(ids, mode = 'replace') {
      const list =
        ids == null ? [] : Array.isArray(ids) ? ids : [ids]
      const cur = get().selection
      let next: Set<string>
      if (mode === 'replace') {
        next = new Set(list)
      } else if (mode === 'add') {
        next = new Set(cur)
        for (const id of list) next.add(id)
      } else {
        next = new Set(cur)
        for (const id of list) {
          if (next.has(id)) next.delete(id)
          else next.add(id)
        }
      }
      set(syncedSelection(next))
    },

    selectAll() {
      const ids = get().graph.nodes.map((n) => n.id)
      set(syncedSelection(new Set(ids)))
    },

    setPlaying(playing) {
      set({ isPlaying: playing })
    },

    setStatus(status) {
      set({ status })
    },

    loadGraph(graph, filePath = null, hardware) {
      // Loading wipes history — a freshly opened patch has no prior edits.
      set({
        graph,
        hardware: hardware ?? emptyHardwareLayout(),
        selection: new Set(),
        selectedNodeId: null,
        selectedHardwareId: null,
        history: { past: [], future: [] },
        filePath,
        isDirty: false
      })
    },

    resetGraph() {
      set({
        graph: emptyGraph(),
        hardware: emptyHardwareLayout(),
        selection: new Set(),
        selectedNodeId: null,
        selectedHardwareId: null,
        history: { past: [], future: [] },
        filePath: null,
        isDirty: false
      })
    },

    /* ---------- history ---------- */

    undo() {
      const { past, future } = get().history
      if (past.length === 0) return
      const prev = past[past.length - 1]
      const cur: HistorySnapshot = { graph: get().graph, hardware: get().hardware }
      set({
        graph: prev.graph,
        hardware: prev.hardware,
        history: { past: past.slice(0, -1), future: [...future, cur] },
        isDirty: true
      })
    },

    redo() {
      const { past, future } = get().history
      if (future.length === 0) return
      const next = future[future.length - 1]
      const cur: HistorySnapshot = { graph: get().graph, hardware: get().hardware }
      set({
        graph: next.graph,
        hardware: next.hardware,
        history: { past: [...past, cur], future: future.slice(0, -1) },
        isDirty: true
      })
    },

    canUndo() {
      return get().history.past.length > 0
    },

    canRedo() {
      return get().history.future.length > 0
    },

    beginTransaction() {
      if (txDepth === 0) {
        txSnapshot = { graph: get().graph, hardware: get().hardware }
      }
      txDepth++
    },

    endTransaction() {
      if (txDepth === 0) return
      txDepth--
      if (txDepth > 0) return
      const snapshot = txSnapshot
      txSnapshot = null
      if (!snapshot) return
      const cur: HistorySnapshot = { graph: get().graph, hardware: get().hardware }
      // No net change — discard the transaction quietly.
      if (snapshot.graph === cur.graph && snapshot.hardware === cur.hardware) return
      const { past, future } = pushHistory(get().history.past, get().history.future, snapshot)
      set({ history: { past, future }, isDirty: true })
    },

    /* ---------- clipboard ---------- */

    copySelection() {
      const { graph, selection } = get()
      if (selection.size === 0) return
      const nodes = graph.nodes.filter((n) => selection.has(n.id))
      const connections = graph.connections.filter(
        (c) => selection.has(c.from.nodeId) && selection.has(c.to.nodeId)
      )
      set({
        clipboard: {
          // Deep-clone so later mutations to the graph don't touch clipboard.
          nodes: nodes.map((n) => ({ ...n, params: { ...n.params }, position: { ...n.position } })),
          connections: connections.map((c) => ({ ...c, from: { ...c.from }, to: { ...c.to } }))
        }
      })
    },

    cutSelection() {
      get().copySelection()
      get().deleteSelection()
    },

    paste(position) {
      const clip = get().clipboard
      if (!clip || clip.nodes.length === 0) return

      // Remap old ids -> new ids so we can rewire connections.
      const idMap = new Map<string, string>()
      for (const n of clip.nodes) idMap.set(n.id, nanoid(8))

      const offset = { x: 40, y: 40 }
      let anchor: { x: number; y: number } | null = null
      if (position) {
        let minX = Infinity
        let minY = Infinity
        for (const n of clip.nodes) {
          if (n.position.x < minX) minX = n.position.x
          if (n.position.y < minY) minY = n.position.y
        }
        anchor = { x: minX, y: minY }
      }

      const pastedNodes: NodeInstance[] = clip.nodes.map((n) => {
        const newPos = anchor && position
          ? { x: position.x + (n.position.x - anchor.x), y: position.y + (n.position.y - anchor.y) }
          : { x: n.position.x + offset.x, y: n.position.y + offset.y }
        return {
          id: idMap.get(n.id)!,
          kind: n.kind,
          position: newPos,
          params: { ...n.params }
        }
      })

      const pastedConns: Connection[] = clip.connections.map((c) => ({
        id: nanoid(8),
        from: { nodeId: idMap.get(c.from.nodeId)!, socketId: c.from.socketId },
        to: { nodeId: idMap.get(c.to.nodeId)!, socketId: c.to.socketId }
      }))

      mutate((s) => ({
        graph: {
          ...s.graph,
          nodes: [...s.graph.nodes, ...pastedNodes],
          connections: [...s.graph.connections, ...pastedConns]
        }
      }))

      set(syncedSelection(new Set(pastedNodes.map((n) => n.id))))
    },

    deleteSelection() {
      const sel = get().selection
      if (sel.size === 0) return
      mutate((s) => ({
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.filter((n) => !sel.has(n.id)),
          connections: s.graph.connections.filter(
            (c) => !sel.has(c.from.nodeId) && !sel.has(c.to.nodeId)
          )
        }
      }))
      set(syncedSelection(new Set()))
    },

    /* ---------- hardware ---------- */

    setView(view) {
      set({ view })
    },

    addHardware(kind, position) {
      const id = nanoid(8)
      // Auto-number the label from existing same-kind components so the
      // first "Pot 1", second "Pot 2" etc. If the user renames one, the
      // counter still advances past the highest numeric suffix found.
      const existing = get().hardware.components.filter((c) => c.kind === kind)
      const base = defaultHardwareLabel(kind)
      let n = 1
      for (const c of existing) {
        const m = c.label.match(/\b(\d+)\s*$/)
        if (m) n = Math.max(n, Number(m[1]) + 1)
        else n = Math.max(n, existing.length + 1)
      }
      const component: PlacedComponent = {
        id,
        kind,
        label: `${base} ${n}`,
        position,
        pins: {},
        config: defaultHardwareConfig(kind)
      }
      mutate((s) => ({
        hardware: {
          ...s.hardware,
          components: [...s.hardware.components, component]
        }
      }))
      return id
    },

    removeHardware(id) {
      mutate((s) => ({
        hardware: {
          ...s.hardware,
          components: s.hardware.components.filter((c) => c.id !== id)
        }
      }))
      if (get().selectedHardwareId === id) set({ selectedHardwareId: null })
    },

    moveHardware(id, position) {
      mutate((s) => ({
        hardware: {
          ...s.hardware,
          components: s.hardware.components.map((c) =>
            c.id === id ? { ...c, position } : c
          )
        }
      }))
    },

    renameHardware(id, label) {
      mutate((s) => ({
        hardware: {
          ...s.hardware,
          components: s.hardware.components.map((c) =>
            c.id === id ? { ...c, label } : c
          )
        }
      }))
    },

    setHardwarePin(id, role, pin) {
      mutate((s) => ({
        hardware: {
          ...s.hardware,
          components: s.hardware.components.map((c) => {
            if (c.id !== id) return c
            const nextPins: PlacedComponent['pins'] = { ...c.pins }
            if (pin === null) delete nextPins[role]
            else nextPins[role] = pin as BoardPin
            return { ...c, pins: nextPins }
          })
        }
      }))
    },

    setHardwareConfig(id, key, value) {
      mutate((s) => ({
        hardware: {
          ...s.hardware,
          components: s.hardware.components.map((c) =>
            c.id === id ? { ...c, config: { ...c.config, [key]: value } } : c
          )
        }
      }))
    },

    selectHardware(id) {
      set({ selectedHardwareId: id })
    },

    resetHardware() {
      mutate(() => ({ hardware: emptyHardwareLayout() }))
      set({ selectedHardwareId: null })
    },

    /* ---------- file meta ---------- */

    setFilePath(path) {
      set({ filePath: path })
    },

    markClean() {
      set({ isDirty: false })
    },

    /* ---------- layout (not history-tracked) ---------- */

    setPaletteW(px) {
      const cur = get().layout
      const next = clamp(px, LAYOUT_LIMITS.paletteW.min, LAYOUT_LIMITS.paletteW.max)
      if (next === cur.paletteW) return
      set({ layout: { ...cur, paletteW: next } })
    },

    setInspectorW(px) {
      const cur = get().layout
      const next = clamp(px, LAYOUT_LIMITS.inspectorW.min, LAYOUT_LIMITS.inspectorW.max)
      if (next === cur.inspectorW) return
      set({ layout: { ...cur, inspectorW: next } })
    },

    setBuildLogH(px) {
      const cur = get().layout
      // Viewport-relative upper clamp so the panel can never cover the whole
      // app. `window` is guaranteed here (renderer process), but be defensive
      // in case this ever runs during SSR-style setup.
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800
      const max = Math.min(LAYOUT_LIMITS.buildLogH.max, Math.floor(vh * 0.7))
      const next = clamp(px, LAYOUT_LIMITS.buildLogH.min, max)
      if (next === cur.buildLogH) return
      set({ layout: { ...cur, buildLogH: next } })
    },

    setSerialMonitorH(px) {
      const cur = get().layout
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800
      const max = Math.min(LAYOUT_LIMITS.serialMonitorH.max, Math.floor(vh * 0.7))
      const next = clamp(px, LAYOUT_LIMITS.serialMonitorH.min, max)
      if (next === cur.serialMonitorH) return
      set({ layout: { ...cur, serialMonitorH: next } })
    },

    setLayout(patch) {
      const cur = get().layout
      const merged: LayoutSizes = {
        paletteW: clamp(
          patch.paletteW ?? cur.paletteW,
          LAYOUT_LIMITS.paletteW.min,
          LAYOUT_LIMITS.paletteW.max
        ),
        inspectorW: clamp(
          patch.inspectorW ?? cur.inspectorW,
          LAYOUT_LIMITS.inspectorW.min,
          LAYOUT_LIMITS.inspectorW.max
        ),
        buildLogH: clamp(
          patch.buildLogH ?? cur.buildLogH,
          LAYOUT_LIMITS.buildLogH.min,
          LAYOUT_LIMITS.buildLogH.max
        ),
        serialMonitorH: clamp(
          patch.serialMonitorH ?? cur.serialMonitorH,
          LAYOUT_LIMITS.serialMonitorH.min,
          LAYOUT_LIMITS.serialMonitorH.max
        ),
        paletteCollapsed: patch.paletteCollapsed ?? cur.paletteCollapsed,
        paletteCompact: patch.paletteCompact ?? cur.paletteCompact,
        categoriesCollapsed: patch.categoriesCollapsed ?? cur.categoriesCollapsed,
        paletteFilter: patch.paletteFilter ?? cur.paletteFilter,
        recentKinds: patch.recentKinds ?? cur.recentKinds
      }
      set({ layout: merged })
    },

    setPaletteCollapsed(collapsed) {
      const cur = get().layout
      if (cur.paletteCollapsed === collapsed) return
      set({ layout: { ...cur, paletteCollapsed: collapsed } })
    },

    togglePaletteCollapsed() {
      const cur = get().layout
      set({ layout: { ...cur, paletteCollapsed: !cur.paletteCollapsed } })
    },

    setPaletteCompact(compact) {
      const cur = get().layout
      if (cur.paletteCompact === compact) return
      set({ layout: { ...cur, paletteCompact: compact } })
    },

    togglePaletteCompact() {
      const cur = get().layout
      set({ layout: { ...cur, paletteCompact: !cur.paletteCompact } })
    },

    toggleCategoryCollapsed(category) {
      const cur = get().layout
      const list = cur.categoriesCollapsed
      const next = list.includes(category)
        ? list.filter((c) => c !== category)
        : [...list, category]
      set({ layout: { ...cur, categoriesCollapsed: next } })
    },

    setPaletteFilter(mode) {
      const cur = get().layout
      if (cur.paletteFilter === mode) return
      set({ layout: { ...cur, paletteFilter: mode } })
    },

    noteRecentKind(kind) {
      const cur = get().layout
      const dedup = cur.recentKinds.filter((k) => k !== kind)
      const next = [kind, ...dedup].slice(0, RECENT_KINDS_LIMIT)
      set({ layout: { ...cur, recentKinds: next } })
    },

    /* ---------- per-node view state ---------- */

    toggleCollapsed(id) {
      // Collapse IS a graph edit (undo should walk back accidental collapses),
      // so we route through `mutate` to pick up history. Single toggles
      // commit immediately; a Cmd+. batch wraps these in a transaction via
      // `setCollapsed` below so N toggles coalesce into one undo step.
      mutate((s) => {
        const nodes = s.graph.nodes.map((n) =>
          n.id === id ? { ...n, collapsed: !n.collapsed } : n
        )
        return { graph: { ...s.graph, nodes } }
      })
    },

    setCollapsed(ids, collapsed) {
      if (ids.length === 0) return
      const idSet = new Set(ids)
      // Wrap in a transaction so a keyboard shortcut that toggles a dozen
      // nodes shows up as a single undo step instead of twelve.
      const tx = txDepth === 0
      if (tx) get().beginTransaction()
      mutate((s) => {
        const nodes = s.graph.nodes.map((n) =>
          idSet.has(n.id) ? { ...n, collapsed } : n
        )
        return { graph: { ...s.graph, nodes } }
      })
      if (tx) get().endTransaction()
    },

    /* ---------- compile target ---------- */

    setTarget(target) {
      applyTargetSwitch(target)
      set({ targetLockedByUser: true })
    },

    autoSetTarget(target) {
      // Autodetect MUST NOT override an explicit user pick.
      if (get().targetLockedByUser) return
      applyTargetSwitch(target)
    },

    releaseTargetLock() {
      if (!get().targetLockedByUser) return
      set({ targetLockedByUser: false })
    },

    setDetectedBoard(board) {
      if (get().detectedBoard === board) return
      set({ detectedBoard: board })
    },

    setDaisyFlashMode(mode) {
      if (get().daisyFlashMode === mode) return
      set({ daisyFlashMode: mode })
    }
  }

  /**
   * Core target-switch: flip the hardware board id alongside `target`,
   * surface a status line, and keep pin assignments intact. Shared by
   * the explicit `setTarget` and the autodetect-driven `autoSetTarget`.
   */
  function applyTargetSwitch(target: BoardTarget): void {
    const cur = get().target
    if (cur === target) return
    const boardId = boardForTarget(target)
    const hw = get().hardware
    mutate((s) => ({
      hardware: { ...s.hardware, board: boardId }
    }))
    set({ target })
    const invalid = countInvalidComponentsForBoard(hw, boardId)
    const msg = invalid > 0
      ? `target: ${target} — ${invalid} component${invalid === 1 ? '' : 's'} may need repinning`
      : `target: ${target}`
    set({ status: { kind: invalid > 0 ? 'warn' : 'info', message: msg } })
  }
})

/** Re-export so consumers outside the store have a convenient source. */
export { KIND_ROLES }
