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
import { defaultHardwareConfig } from '@/hardware/defaultConfig'
import { nanoid } from 'nanoid'

import type { BoardTarget, DaisyFlashMode, EditorStore, HistorySnapshot, LayoutSizes } from '@/types/store'
import type { AudioGraph, Connection, NodeInstance, NodeKind } from '@/types/graph'
import { emptyGraph } from '@/types/graph'
import type { BoardPin, HardwareKind, HardwareLayout, PlacedComponent } from '@/types/hardware'
import { emptyHardwareLayout, KIND_ROLES } from '@/types/hardware'
import { getBoardPinout } from '@/hardware/boardPinout'
import { nextFreePosition } from '@/hardware/autoPlace'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import {
  captureFrom,
  morphEdits,
  prunePresets,
  recallEdits,
  rekeyPresets,
  setParamAtPath,
  type Preset
} from '@/state/presets'
import { boardForTarget, targetForBoard } from '@/codegen/targets'
import {
  SUB_INPUTS,
  SUB_OUTPUTS,
  bodyOf,
  collapseSelection,
  expandSubpatch,
  withBody
} from '@/state/subpatch'

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
  // Tall by default: this is for reading a 700-line file, not peeking.
  codePanelH: 380,
  paletteCollapsed: false,
  // Compact = grid tiles (icon + short label) instead of one line per kind
  // with a description. Default ON so the 70+ catalog is browsable at a
  // glance — resizing the palette wider automatically adds more columns.
  paletteCompact: true,
  categoriesCollapsed: [],
  paletteFilter: 'available',
  recentKinds: [],
  // Grid on, snap off by default: the guides help you line things up, but
  // forcing every drop onto a lattice is a preference, not a default.
  gridShow: true,
  gridSnap: false,
  gridSize: 20,
  marqueeSelect: true
}

/** FIFO cap for `layout.recentKinds`. */
const RECENT_KINDS_LIMIT = 8

/** Resize clamps, tuned to keep the shell usable on a 1280x720 display. */
const LAYOUT_LIMITS = {
  paletteW: { min: 160, max: 480 },
  inspectorW: { min: 200, max: 520 },
  /** Build log height is clamped to 70% of the viewport at apply time. */
  buildLogH: { min: 120, max: 2000 },
  serialMonitorH: { min: 160, max: 2000 },
  codePanelH: { min: 140, max: 2000 }
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
let txSilent = false

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
 *
 * `ws` belongs here for the same reason `sck` does: an I2S bus driving a
 * PCM5102A line-out and a MAX98357A amp shares bit clock AND word select,
 * and only the data line is per-device. Without it the second module gets
 * denied the word-select pin and lands unassigned.
 */
const SHARED_BUS_ROLES = new Set(['sda', 'scl', 'sck', 'ws', 'mclk'])

/**
 * Map a patch-side NodeKind to the HardwareKind it represents physically.
 * Used by `addNode` to auto-create a paired `PlacedComponent` whenever a
 * hardware-category node is dropped in the patch. Returns null for DSP
 * nodes that have no physical counterpart. Multiple node kinds can map to
 * the same hardware kind (e.g. three MIDI node kinds all share one
 * `midi_jack`); first-drop creates, subsequent drops still spawn a new
 * one — users can manually coalesce via the hardware view if desired.
 */
/**
 * The whole patch, regardless of which level is being edited.
 *
 * `state.graph` is the level you are LOOKING at — that is what keeps the
 * editor, inspector and undo working unchanged while you are inside a
 * subpatch. But the engine and codegen want the instrument, so they ask
 * here: re-embed the current level into each outer level, innermost first.
 */
export function rootGraphOf(state: {
  graph: AudioGraph
  subpatchStack: { nodeId: string; graph: AudioGraph }[]
}): AudioGraph {
  let current = state.graph
  for (let i = state.subpatchStack.length - 1; i >= 0; i--) {
    const level = state.subpatchStack[i]
    current = {
      ...level.graph,
      nodes: level.graph.nodes.map((n) => (n.id === level.nodeId ? withBody(n, current) : n))
    }
  }
  return current
}

export function hardwareKindForNodeKind(nodeKind: NodeKind): HardwareKind | null {
  switch (nodeKind) {
    case 'knob_in':       return 'pot'
    case 'gate_in':       return 'gate_jack'
    case 'button':        return 'button'
    case 'led':           return 'led'
    case 'switch_3way':   return 'switch_3way'
    case 'encoder_in':    return 'encoder'
    case 'imu_in':        return 'gyroscope'
    case 'compass_in':    return 'magnetometer'
    case 'distance_in':   return 'tof'
    case 'i2s_in':        return 'i2s_codec'
    case 'i2s_out':       return 'i2s_codec'
    case 'midi_in_note':  return 'midi_jack'
    case 'midi_in_cc':    return 'midi_jack'
    case 'midi_out_note': return 'midi_jack'
    case 'oled':          return 'oled_ssd1306'
    default:              return null
  }
}

/**
 * Inverse of {@link hardwareKindForNodeKind}: the patch node to create
 * when a component is placed from the Hardware view.
 *
 * Declared as its own total table rather than inverted at runtime, because
 * the forward map is many-to-one and its inverse is genuinely ambiguous.
 * `satisfies Record<HardwareKind, …>` makes a new HardwareKind a compile
 * error here instead of a silently node-less component.
 *
 * `null` means "place the component, create no node", which is now the
 * exception rather than the norm — only the four genuinely ambiguous or
 * board-level kinds have no patch-side counterpart.
 *
 * The two ambiguous kinds are deliberately null:
 *   - `i2s_codec` could be `i2s_in` OR `i2s_out` (both stubs on ESP32).
 *   - `midi_jack` could be any of three MIDI node kinds.
 * Guessing here would drop junk into a graph the user isn't looking at,
 * which is worse than creating nothing and saying so in the status line.
 */
const NODE_KIND_FOR_HARDWARE_KIND = {
  pot: 'knob_in',
  button: 'button',
  led: 'led',
  switch_3way: 'switch_3way',
  gate_jack: 'gate_in',
  oled_ssd1306: 'oled',
  /*
   * The analog-input family all read as one normalized CV, which is
   * exactly what `knob_in` emits — its label says "Knob" but it is really
   * "analog pin → CV", with min/max scaling. Routing them here means a
   * placed Ribbon or Slider arrives with something to patch instead of
   * silently doing nothing. Keep in step with ANALOG_INPUT_ROLE.
   */
  slider: 'knob_in',
  touch_ribbon: 'knob_in',
  ldr: 'knob_in',
  electret: 'knob_in',
  piezo: 'knob_in',
  cv_jack: 'knob_in',

  // ambiguous — see above
  i2s_codec: null,
  midi_jack: null,

  // Relative quadrature — its own node kind, with A/B decoding in both
  // emitters (libDaisy Encoder on Seed, an inline Gray-code table on ESP32).
  encoder: 'encoder_in',

  /*
   * Multi-axis I2C sensors. Each gets ONE node that fans its axes out as
   * separate CV outputs — three nodes bound to one physical device would
   * be three chances for them to disagree about which device that is.
   */
  gyroscope: 'imu_in',
  magnetometer: 'compass_in',
  tof: 'distance_in',

  /*
   * No patch-side counterpart.
   *   audio_jack   — the Seed's is hardwired to the onboard codec, and
   *                  in/out is ambiguous.
   *   pcm5102a /
   *   max98357a    — driven at board level by walkHardware, not through
   *                  a node; `audio_output` already feeds the I2S bus.
   */
  audio_jack: null,
  pcm5102a: null,
  max98357a: null
} satisfies Record<HardwareKind, NodeKind | null>

export function nodeKindForHardwareKind(kind: HardwareKind): NodeKind | null {
  return NODE_KIND_FOR_HARDWARE_KIND[kind]
}

/**
 * Every HardwareKind a given node kind can legitimately bind to.
 *
 * The forward map is one-to-one, but several hardware kinds now share a
 * node: a `knob_in` reads a pot, a fader, a ribbon, an LDR, a mic, a
 * piezo or a CV jack. Filtering the Inspector's binding dropdown by the
 * forward map alone would offer only Pots and make the component the node
 * was auto-created for unselectable.
 */
export function hardwareKindsForNodeKind(nodeKind: NodeKind): HardwareKind[] {
  const out: HardwareKind[] = []
  const forward = hardwareKindForNodeKind(nodeKind)
  if (forward) out.push(forward)
  for (const [hw, nk] of Object.entries(NODE_KIND_FOR_HARDWARE_KIND)) {
    if (nk === nodeKind && !out.includes(hw as HardwareKind)) out.push(hw as HardwareKind)
  }
  return out
}

/**
 * Auto-assign each required role to the first free compatible pin.
 *
 * Shared-bus roles (I2C sda/scl, I2S sck/ws/mclk) may reuse a pin another
 * component already holds — that is what a bus is. Single-ownership roles
 * skip anything already taken. Unfillable roles are simply left out; the
 * user wires them by hand.
 *
 * Extracted so both directions behave identically. `addHardware` used to
 * hardcode `pins: {}`, so a pot placed from the Hardware view arrived
 * unwired while an identical pot created from the Patch view arrived
 * fully pinned — a difference with no reason behind it.
 */
function autoAssignPins(
  layout: HardwareLayout,
  kind: HardwareKind
): Record<string, string> {
  const pinout = getBoardPinout(layout.board)

  /*
   * Pins held for exclusive use by an existing component. Shared-bus roles
   * are excluded from this set — that is the whole point of a bus.
   */
  const singleOwned = new Set<string>()
  /*
   * Where each shared bus line already lives, e.g. sda -> GPIO8. A second
   * I2C device should join the EXISTING bus rather than pick a fresh pin,
   * so this is a reuse table, not an exclusion set.
   */
  const busPinForRole = new Map<string, string>()
  /*
   * Reverse index: which bus line a pin is already carrying. Sharing is
   * only legitimate between the SAME role — an I2C `sda` may join another
   * device's `sda`, but must never land on a pin already carrying I2S
   * `sck`. Without this the two buses silently overlap.
   */
  const roleForBusPin = new Map<string, string>()
  /** Pins this component has already claimed for one of its own roles. */
  const takenByThisComponent = new Set<string>()
  for (const c of layout.components) {
    for (const [role, pin] of Object.entries(c.pins)) {
      if (!pin) continue
      if (SHARED_BUS_ROLES.has(role)) {
        busPinForRole.set(role, pin as string)
        roleForBusPin.set(pin as string, role)
      } else singleOwned.add(pin as string)
    }
  }

  /** A pin is free for `role` if nothing else claims it for another purpose. */
  const availableFor = (pin: string, role: string): boolean => {
    if (singleOwned.has(pin)) return false
    if (takenByThisComponent.has(pin)) return false
    const busRole = roleForBusPin.get(pin)
    return busRole === undefined || busRole === role
  }

  /*
   * "Shared" previously meant `shared ? true` — take the first candidate,
   * unconditionally. That happened to work only because on the Seed and S3
   * `pinsForRole` returns a different list per bus role (i2s === 'sck' vs
   * 'ws'), so the roles landed on different pins by accident.
   *
   * On a C3 the I2S peripheral routes through the GPIO matrix, so every
   * role returns the SAME list — and the old rule put BCK, LCK and the
   * pot's wiper all on GPIO0. Sharing has to mean "join the same bus line
   * another device already uses", never "collide with an unrelated pin or
   * with a sibling role on my own component".
   */
  const assigned: Record<string, string> = {}
  for (const role of KIND_ROLES[kind]) {
    const shared = SHARED_BUS_ROLES.has(role)

    // Join an existing bus line if one is already established for this role.
    const existingBusPin = shared ? busPinForRole.get(role) : undefined
    if (existingBusPin && !takenByThisComponent.has(existingBusPin)) {
      assigned[role] = existingBusPin
      takenByThisComponent.add(existingBusPin)
      continue
    }

    /*
     * `pinsForRole` returns candidates in preference order — dedicated
     * function first (the silkscreened SDA/SCL, UART RX, I2S pins), plain
     * GPIO next, boot-strapping pins last (see `hardware/pinPreference.ts`).
     * So the first available candidate is the right one. This used to skip
     * strapping pins here as well, which on the C3 SuperMini rejected the
     * board's own documented I2C pair (GPIO8/9 are both straps, held high
     * by the bus pull-ups) in favour of two random GPIOs.
     */
    const candidates = pinout.pinsForRole(role, kind).filter((p) => availableFor(p, role))
    const chosen = candidates[0]
    if (!chosen) continue
    assigned[role] = chosen
    takenByThisComponent.add(chosen)
    if (shared) {
      // A newly-created bus line becomes the one later devices join.
      busPinForRole.set(role, chosen)
      roleForBusPin.set(chosen, role)
    } else singleOwned.add(chosen)
  }
  return assigned
}

/** "Pot 1", "Pot 2", ... advancing past the highest numeric suffix in use. */
function nextLabelFor(components: PlacedComponent[], kind: HardwareKind): string {
  const existing = components.filter((c) => c.kind === kind)
  let n = 1
  for (const c of existing) {
    const m = c.label.match(/\b(\d+)\s*$/)
    if (m) n = Math.max(n, Number(m[1]) + 1)
    else n = Math.max(n, existing.length + 1)
  }
  return `${defaultHardwareLabel(kind)} ${n}`
}

/**
 * Remove `ids` from the graph, dropping any hardware component left with
 * nothing referencing it.
 *
 * Shared by `removeNode` and `deleteSelection` so the two cannot drift.
 * `deleteSelection` previously had no `hardware` key at all and leaked an
 * orphaned component on every Delete keypress — which is the path users
 * actually take, since `removeNode` is only reached from Rete's
 * `noderemoved` pipe.
 *
 * Orphan detection runs against the SURVIVORS rather than "every node but
 * this one". That matters under multi-select: `paste()` copies params
 * verbatim, so two selected nodes can share a bindingId, and the
 * pairwise test would have each see the other as a live reference and
 * keep the component forever.
 */
function dropNodes(
  s: { graph: AudioGraph; hardware: HardwareLayout },
  ids: Set<string>
): { graph: AudioGraph; hardware?: HardwareLayout } {
  const survivors = s.graph.nodes.filter((n) => !ids.has(n.id))
  const graph: AudioGraph = {
    ...s.graph,
    nodes: survivors,
    connections: s.graph.connections.filter(
      (c) => !ids.has(c.from.nodeId) && !ids.has(c.to.nodeId)
    )
  }
  const bindingOf = (n: NodeInstance): string | null => {
    const b = n.params.bindingId
    return typeof b === 'string' && b !== '' ? b : null
  }
  const stillWanted = new Set(survivors.map(bindingOf).filter((b): b is string => b !== null))
  const orphaned = new Set(
    s.graph.nodes
      .filter((n) => ids.has(n.id))
      .map(bindingOf)
      .filter((b): b is string => b !== null && !stillWanted.has(b))
  )
  if (orphaned.size === 0) return { graph }
  return {
    graph,
    hardware: {
      ...s.hardware,
      components: s.hardware.components.filter((c) => !orphaned.has(c.id))
    }
  }
}


/**
 * Reassign only the pin bindings that don't exist on `layout.board`.
 *
 * Switching boards deliberately leaves bindings dangling rather than
 * silently clearing them (see `applyTargetSwitch`), which is right — but
 * it left the user to repin every role by hand. Moving a patch from an S3
 * DevKitC to a C3 SuperMini invalidates seven roles in a modest layout.
 *
 * Valid pins are kept exactly as they are, so a deliberate assignment
 * survives; only the impossible ones move. Shared bus lines are honoured
 * the same way `autoAssignPins` does, so two I2S devices still land on one
 * clock pair.
 */
function repinLayoutForBoard(layout: HardwareLayout): {
  layout: HardwareLayout
  moved: number
  unfilled: number
} {
  const pinout = getBoardPinout(layout.board)
  const valid = (p: unknown): p is string => typeof p === 'string' && p in pinout.pinCaps

  // Seed the "taken" sets from the bindings we're keeping.
  const singleOwned = new Set<string>()
  const busPinForRole = new Map<string, string>()
  const roleForBusPin = new Map<string, string>()
  for (const c of layout.components) {
    for (const [role, pin] of Object.entries(c.pins)) {
      if (!valid(pin)) continue
      if (SHARED_BUS_ROLES.has(role)) {
        busPinForRole.set(role, pin)
        roleForBusPin.set(pin, role)
      } else singleOwned.add(pin)
    }
  }

  let moved = 0
  let unfilled = 0
  const components = layout.components.map((c) => {
    const taken = new Set<string>()
    for (const pin of Object.values(c.pins)) if (valid(pin)) taken.add(pin)
    const pins: Record<string, string> = {}
    for (const role of KIND_ROLES[c.kind]) {
      const cur = c.pins[role]
      if (valid(cur)) {
        pins[role] = cur
        continue
      }
      if (cur === undefined) continue // never assigned; leave it that way
      const shared = SHARED_BUS_ROLES.has(role)
      const existingBus = shared ? busPinForRole.get(role) : undefined
      if (existingBus && !taken.has(existingBus)) {
        pins[role] = existingBus
        taken.add(existingBus)
        moved++
        continue
      }
      const candidates = pinout
        .pinsForRole(role, c.kind)
        .filter(
          (p) =>
            !singleOwned.has(p) &&
            !taken.has(p) &&
            (roleForBusPin.get(p) === undefined || roleForBusPin.get(p) === role)
        )
      const chosen = candidates.find((p) => !pinout.pinCaps[p]?.strapping) ?? candidates[0]
      if (!chosen) {
        unfilled++
        continue
      }
      pins[role] = chosen
      taken.add(chosen)
      moved++
      if (shared) {
        busPinForRole.set(role, chosen)
        roleForBusPin.set(chosen, role)
      } else singleOwned.add(chosen)
    }
    return { ...c, pins }
  })

  return { layout: { ...layout, components }, moved, unfilled }
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
    pcm5102a: 'Line Out',
    max98357a: 'Amp',
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
 * exist on the target board. Used by `setTarget` to warn when switching
 * boards leaves a patch inconsistent.
 *
 * This used to be a `/^D\d+$/` vs `/^GPIO\d+$/` prefix test, justified by
 * a comment about avoiding a circular import. That constraint was stale —
 * this module already imports `getBoardPinout` — and the heuristic could
 * only tell Seed from ESP32. With three ESP32 boards it would report
 * "0 components need repinning" when switching an S3 DevKitC layout to a
 * C3 SuperMini, even though every GPIO35/GPIO46 binding just died.
 */
function countInvalidComponentsForBoard(
  layout: HardwareLayout,
  board: HardwareLayout['board']
): number {
  const { pinCaps } = getBoardPinout(board)
  let bad = 0
  for (const c of layout.components) {
    for (const pin of Object.values(c.pins)) {
      if (typeof pin !== 'string') continue
      if (!(pin in pinCaps)) { bad++; break }
    }
  }
  return bad
}


export const useEditorStore = create<EditorStore>((set, get) => {
  /**
   * Core mutation helper. Takes a producer over the full `{graph, hardware}`
   * tuple and commits atomically — a single undo step captures both halves.
   */
  function mutate(
    producer: (s: { graph: AudioGraph; hardware: HardwareLayout; presets: Preset[] }) => {
      graph?: AudioGraph
      hardware?: HardwareLayout
      presets?: Preset[]
    } | null,
    opts?: { dirty?: boolean }
  ) {
    const prevGraph = get().graph
    const prevHw = get().hardware
    const prevPresets = get().presets
    const patch = producer({ graph: prevGraph, hardware: prevHw, presets: prevPresets })
    if (!patch) return
    const nextGraph = patch.graph ?? prevGraph
    const nextHw = patch.hardware ?? prevHw
    const nextPresets = patch.presets ?? prevPresets
    if (nextGraph === prevGraph && nextHw === prevHw && nextPresets === prevPresets) return

    if (txDepth > 0) {
      set({
        graph: nextGraph,
        hardware: nextHw,
        presets: nextPresets,
        isDirty: opts?.dirty !== false
      })
      return
    }

    const snapshot: HistorySnapshot = { graph: prevGraph, hardware: prevHw, presets: prevPresets }
    const { past, future } = pushHistory(get().history.past, get().history.future, snapshot)
    set({
      graph: nextGraph,
      hardware: nextHw,
      presets: nextPresets,
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

    subpatchStack: [] as { nodeId: string; label: string; graph: AudioGraph }[],
    presets: [] as Preset[],
    activePresetId: null,

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
        const layout = get().hardware
        // First free slot in the band under the board — see autoPlace.ts.
        // The user moves it later; what matters is that it does not land
        // on top of the pin labels.
        hwComponent = {
          id: hwId,
          kind: hwKind,
          label: nextLabelFor(layout.components, hwKind),
          position: nextFreePosition(layout, hwKind),
          pins: autoAssignPins(layout, hwKind),
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
      mutate((s) => dropNodes(s, new Set([id])))
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
      /*
       * Any parameter move means the patch no longer IS the recalled
       * preset. A highlighted name next to a sound that has since been
       * turned somewhere else is worse than no highlight at all.
       */
      if (get().activePresetId !== null) set({ activePresetId: null })
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
      /*
       * Bail when nothing actually changed. A marquee drag calls this on
       * every animation frame; without the guard each frame publishes a new
       * Set, which re-renders every node and re-runs the Rete selector sync
       * for a selection that is identical to the one already on screen.
       */
      if (next.size === cur.size && [...next].every((id) => cur.has(id))) return
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

    loadGraph(graph, filePath = null, hardware, presets) {
      const raw = hardware ?? emptyHardwareLayout()
      /*
       * Backfill component config with the kind's defaults.
       *
       * A file written by an older build, or by the example generator,
       * can carry `config: {}` for a component whose emitter reads
       * `config.address` or `config.width`. That surfaced as an OLED
       * showing Width 0 / Height 0 and an empty I2C address in the
       * inspector — and would have emitted `Wire.begin()` with nothing.
       * Merging defaults UNDER the stored values means an explicit setting
       * always wins and a missing one becomes the right thing rather than
       * `undefined`.
       */
      const nextHardware: HardwareLayout = {
        ...raw,
        components: raw.components.map((c) => ({
          ...c,
          config: { ...defaultHardwareConfig(c.kind), ...(c.config ?? {}) }
        }))
      }
      // Presets name nodes by id; a preset from another patch would be a
      // pile of references to nodes that do not exist here.
      const nextPresets = prunePresets(presets ?? [], graph)
      /*
       * Adopt the loaded layout's board as the compile target.
       *
       * This was missing entirely: `loadGraph` restored `hardware.board`
       * but left `target` at whatever it happened to be (default
       * 'daisy_seed'), so opening an ESP32 patch on a fresh launch would
       * generate Daisy firmware from an ESP32 layout with no warning.
       * `targetForBoard` existed for exactly this and had never been
       * called — the module had a literal `void targetForBoard` to
       * silence the unused-import lint.
       *
       * A user who explicitly pinned the target keeps their pin, matching
       * how `autoSetTarget` respects the lock.
       */
      const nextTarget = get().targetLockedByUser
        ? get().target
        : targetForBoard(nextHardware.board)
      // Loading wipes history — a freshly opened patch has no prior edits.
      set({
        graph,
        hardware: nextHardware,
        presets: nextPresets,
        // A loaded patch is a fresh root; any level we were inside is gone.
        subpatchStack: [],
        activePresetId: null,
        target: nextTarget,
        selection: new Set(),
        selectedNodeId: null,
        selectedHardwareId: null,
        history: { past: [], future: [] },
        filePath,
        isDirty: false
      })
    },

    resetGraph() {
      /*
       * A new patch keeps the current TARGET. `emptyHardwareLayout()` says
       * daisy_seed, and handing that out as-is left `hardware.board` on the
       * Seed while `target` stayed on the ESP32 — the hardware view drew a
       * Seed, pins were assigned off the Seed table, and the ESP32 build
       * then referenced D-pins. Since `applyTargetSwitch` short-circuits
       * when the target already matches, nothing ever re-synced them.
       */
      set({
        graph: emptyGraph(),
        hardware: { ...emptyHardwareLayout(), board: boardForTarget(get().target) },
        presets: [],
        activePresetId: null,
        subpatchStack: [],
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
      const cur: HistorySnapshot = { graph: get().graph, hardware: get().hardware, presets: get().presets }
      set({
        graph: prev.graph,
        hardware: prev.hardware,
        presets: prev.presets ?? [],
        history: { past: past.slice(0, -1), future: [...future, cur] },
        isDirty: true
      })
    },

    redo() {
      const { past, future } = get().history
      if (future.length === 0) return
      const next = future[future.length - 1]
      const cur: HistorySnapshot = { graph: get().graph, hardware: get().hardware, presets: get().presets }
      set({
        graph: next.graph,
        hardware: next.hardware,
        presets: next.presets ?? [],
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
        txSnapshot = { graph: get().graph, hardware: get().hardware, presets: get().presets }
      }
      txDepth++
    },

    /** A transaction whose net change is applied but never recorded. */
    beginTransactionSilent() {
      get().beginTransaction()
      txSilent = true
    },

    endTransaction() {
      if (txDepth === 0) return
      txDepth--
      if (txDepth > 0) return
      const snapshot = txSnapshot
      txSnapshot = null
      const silent = txSilent
      txSilent = false
      if (!snapshot) return
      /*
       * A silent transaction applies its edits and records nothing. Used
       * for changes the PATCH made to itself — a `preset_recall` node
       * firing off a clock — which are not the user's edits and must not
       * evict the user's edits from undo. At 600 BPM a clocked recall
       * pushed ten history entries a second and emptied the stack of
       * everything real inside five seconds.
       */
      if (silent) return
      const cur: HistorySnapshot = { graph: get().graph, hardware: get().hardware, presets: get().presets }
      // No net change — discard the transaction quietly.
      if (
        snapshot.graph === cur.graph &&
        snapshot.hardware === cur.hardware &&
        snapshot.presets === cur.presets
      ) {
        return
      }
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
      // Routed through `dropNodes` so the Delete key tears down paired
      // hardware exactly like `removeNode` does. It previously returned
      // only a `graph` patch and orphaned a component every time.
      mutate((s) => dropNodes(s, sel))
      set(syncedSelection(new Set()))
    },

    /* ---------- hardware ---------- */

    setView(view) {
      set({ view })
    },

    addHardware(kind, position) {
      const id = nanoid(8)
      const layout = get().hardware
      const component: PlacedComponent = {
        id,
        kind,
        label: nextLabelFor(layout.components, kind),
        position,
        // Was `{}`: a component placed here arrived unwired while the same
        // component created from the Patch view arrived fully pinned.
        pins: autoAssignPins(layout, kind),
        config: defaultHardwareConfig(kind)
      }

      /*
       * The reverse of `addNode`'s auto-link: placing a physical control
       * in the Hardware view also creates the patch node that reads it,
       * already bound. Previously this direction did nothing, so the
       * Hardware view could only ever react to the patch.
       *
       * Built before the commit and returned from ONE `mutate()` alongside
       * the component, so undo reverts the pair atomically — calling
       * `addNode()` separately would be two history entries and two Rete
       * sync passes. Rete itself needs no notification: it stays mounted
       * (hidden) and reconciles off `graph` reference identity.
       *
       * Node position cascades off the graph size, mirroring how `addNode`
       * cascades the hardware side. The two canvases are unrelated
       * coordinate spaces, so reusing the drop point would scatter nodes
       * meaninglessly.
       */
      const nodeKind = nodeKindForHardwareKind(kind)
      let node: NodeInstance | null = null
      if (nodeKind) {
        const n = get().graph.nodes.length
        node = {
          id: nanoid(8),
          kind: nodeKind,
          position: { x: 100 + n * 40, y: 100 + n * 40 },
          params: { ...initialParams(nodeKind), bindingId: id }
        }
      }

      mutate((s) => ({
        hardware: {
          ...s.hardware,
          components: [...s.hardware.components, component]
        },
        graph: node ? { ...s.graph, nodes: [...s.graph.nodes, node] } : undefined
      }))

      /*
       * Say what happened. Most kinds (sensors, jacks, the I2S modules)
       * have no patch-side counterpart, so without this "a node sometimes
       * appears in the other view" reads as a bug rather than a rule.
       */
      /*
       * Select the node we just made, so switching to the Patch tab lands
       * with it highlighted and its Inspector open — the paired node is
       * otherwise easy to miss among an existing patch, and "I added a pot
       * and nothing appeared" is what that reads as.
       */
      set({
        ...(node ? syncedSelection(new Set([node.id])) : {}),
        status: {
          kind: 'info',
          message: node
            ? `${component.label} added \u00B7 ${NODE_DEFINITIONS[nodeKind!].label} node created in Patch`
            : `${component.label} added \u00B7 no patch node for this kind`
        }
      })
      return id
    },

    removeHardware(id) {
      /*
       * Deleting a component deletes the node it drives.
       *
       * The user works hardware-first: lay out the physical controls, then
       * patch what they feed. Under that workflow the hardware layout is
       * the authoritative side, so a control removed from the board should
       * not leave a dangling node behind in the patch for them to hunt
       * down — symmetric with `removeNode`, which already drops the paired
       * component.
       *
       * Both halves go through one `mutate()`, so a single undo brings the
       * component AND its node (and the node's connections) back together.
       */
      mutate((s) => {
        const nextComponents = s.hardware.components.filter((c) => c.id !== id)
        if (nextComponents.length === s.hardware.components.length) return null

        const doomed = new Set(
          s.graph.nodes.filter((n) => n.params.bindingId === id).map((n) => n.id)
        )
        const hardware = { ...s.hardware, components: nextComponents }
        if (doomed.size === 0) return { hardware }

        return {
          hardware,
          graph: {
            ...s.graph,
            nodes: s.graph.nodes.filter((n) => !doomed.has(n.id)),
            connections: s.graph.connections.filter(
              (c) => !doomed.has(c.from.nodeId) && !doomed.has(c.to.nodeId)
            )
          }
        }
      })
      if (get().selectedHardwareId === id) set({ selectedHardwareId: null })
      // Drop any removed node from the selection so the Inspector doesn't
      // keep pointing at something that no longer exists.
      const live = new Set(get().graph.nodes.map((n) => n.id))
      const sel = get().selection
      if ([...sel].some((nid) => !live.has(nid))) {
        set(syncedSelection(new Set([...sel].filter((nid) => live.has(nid)))))
      }
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

    repinForBoard() {
      const before = get().hardware
      const { layout, moved, unfilled } = repinLayoutForBoard(before)
      if (moved === 0 && unfilled === 0) {
        set({ status: { kind: 'info', message: 'all pins are valid for this board' } })
        return
      }
      mutate(() => ({ hardware: layout }))
      const parts = [`repinned ${moved} binding${moved === 1 ? '' : 's'}`]
      if (unfilled > 0) parts.push(`${unfilled} could not be placed — no free pin`)
      set({
        status: { kind: unfilled > 0 ? 'warn' : 'info', message: parts.join(' \u00B7 ') }
      })
    },

    setPerformPlacement(id, patch) {
      mutate((s) => {
        const i = s.hardware.components.findIndex((c) => c.id === id)
        if (i < 0) return null
        const cur = s.hardware.components[i]
        const next = patch === null ? undefined : { ...(cur.perform ?? {}), ...patch }
        const components = s.hardware.components.slice()
        components[i] = { ...cur, perform: next }
        return { hardware: { ...s.hardware, components } }
      })
    },

    resetPerformLayout() {
      mutate((s) => {
        if (!s.hardware.components.some((c) => c.perform)) return null
        return {
          hardware: {
            ...s.hardware,
            components: s.hardware.components.map((c) =>
              c.perform ? { ...c, perform: undefined } : c
            )
          }
        }
      })
    },

    /* ---------------- subpatches ---------------- */

    collapseSelectionToSubpatch() {
      const st = get()
      if (st.selection.size === 0) return null
      const id = nanoid(8)
      // Place the box where the collapsed chunk was, so the patch does not
      // visually jump.
      const picked = st.graph.nodes.filter((n) => st.selection.has(n.id))
      const cx = picked.reduce((a, n) => a + n.position.x, 0) / picked.length
      const cy = picked.reduce((a, n) => a + n.position.y, 0) / picked.length
      const res = collapseSelection(st.graph, st.selection, id, { x: cx, y: cy })
      if (!res) {
        st.setStatus({
          kind: 'warn',
          message: `selection needs more than ${SUB_INPUTS.length} inputs or ${SUB_OUTPUTS.length} outputs`
        })
        return null
      }
      /*
       * The grouped nodes' preset paths move with them: `osc` → `sub/osc`
       * (prefixed by the path of the level we are on, if inside a box).
       * Same mutation, so undo puts both back.
       */
      const here = get().subpatchStack.map((l) => l.nodeId + '/').join('')
      const rename = new Map<string, string>()
      for (const nid of st.selection) rename.set(here + nid, `${here}${id}/${nid}`)
      mutate((s) => ({ graph: res.graph, presets: rekeyPresets(s.presets, rename) }))
      set(syncedSelection(new Set([id])))
      return id
    },

    expandSubpatchNode(id) {
      /*
       * No preset re-keying needed here: `expandSubpatch` goes through
       * `flattenGraph`, so the inner nodes rejoin this level ALREADY named
       * `sub/osc` — and a root-level node whose id is `sub/osc` is reached
       * by the path `sub/osc`. The preset keys stay correct by construction.
       */
      mutate((s) => {
        const next = expandSubpatch(s.graph, id)
        return next ? { graph: next } : null
      })
      set(syncedSelection(new Set()))
    },

    enterSubpatch(id) {
      const st = get()
      const node = st.graph.nodes.find(
        (n) => n.id === id && (n.kind === 'subpatch' || n.kind === 'poly')
      )
      if (!node) return
      /*
       * `poly` is entered by exactly the same gesture. Its body IS a
       * subpatch body — one voice of it — and giving it a second, parallel
       * way in would be two mechanisms for one idea.
       */
      const fallback = node.kind === 'poly' ? 'Poly' : 'Subpatch'
      const label = typeof node.params.label === 'string' ? node.params.label : fallback
      set({
        subpatchStack: [...st.subpatchStack, { nodeId: id, label, graph: st.graph }],
        graph: bodyOf(node),
        ...syncedSelection(new Set())
      })
    },

    exitSubpatch() {
      const st = get()
      const top = st.subpatchStack[st.subpatchStack.length - 1]
      if (!top) return
      /*
       * Write the edited body back into the node it came from. This is a
       * real edit to the outer graph, so it goes through history like any
       * other — leaving a subpatch and pressing undo should put back what
       * you changed inside it.
       */
      const outer: AudioGraph = {
        ...top.graph,
        nodes: top.graph.nodes.map((n) => (n.id === top.nodeId ? withBody(n, st.graph) : n))
      }
      set({ subpatchStack: st.subpatchStack.slice(0, -1) })
      mutate(() => ({ graph: outer }))
      set(syncedSelection(new Set([top.nodeId])))
    },

    /* ---------------- presets ---------------- */

    /*
     * Presets are TREE-WIDE. Capture reads the root (every subpatch and
     * poly body included, keyed by path); recall and morph write the root
     * and re-derive whichever level is open. So a preset taken while
     * inside a box, or taken at the top of a patch whose voice lives in a
     * poly, moves every knob it saw — which is what "preset" has to mean
     * once the patch has any structure at all.
     */
    capturePreset(name) {
      const id = nanoid(8)
      const preset = captureFrom(
        rootGraphOf(get()),
        name?.trim() || `Preset ${get().presets.length + 1}`,
        id
      )
      mutate((st) => ({ presets: [...st.presets, preset] }))
      set({ activePresetId: id })
      return id
    },

    recallPreset(id, opts) {
      const preset = get().presets.find((p) => p.id === id)
      if (!preset) return
      const edits = recallEdits(rootGraphOf(get()), preset)
      if (edits.length === 0) {
        set({ activePresetId: id })
        return
      }
      // One transaction for the whole recall: sixty params is one undo
      // step, not sixty.
      get().beginTransaction()
      if (opts?.silent) txSilent = true
      applyPathEdits(edits)
      get().endTransaction()
      set({ activePresetId: id })
    },

    updatePreset(id) {
      const root = rootGraphOf(get())
      mutate((st) => {
        const i = st.presets.findIndex((p) => p.id === id)
        if (i < 0) return null
        const next = st.presets.slice()
        next[i] = captureFrom(root, st.presets[i].name, id)
        return { presets: next }
      })
      set({ activePresetId: id })
    },

    deletePreset(id) {
      mutate((st) => {
        if (!st.presets.some((p) => p.id === id)) return null
        return { presets: st.presets.filter((p) => p.id !== id) }
      })
      if (get().activePresetId === id) set({ activePresetId: null })
    },

    renamePreset(id, name) {
      mutate((st) => {
        const i = st.presets.findIndex((p) => p.id === id)
        if (i < 0 || st.presets[i].name === name) return null
        const next = st.presets.slice()
        next[i] = { ...next[i], name }
        return { presets: next }
      })
    },

    reorderPreset(id, toIndex) {
      mutate((st) => {
        const from = st.presets.findIndex((p) => p.id === id)
        if (from < 0) return null
        const to = Math.max(0, Math.min(st.presets.length - 1, toIndex))
        if (from === to) return null
        const next = st.presets.slice()
        const [item] = next.splice(from, 1)
        next.splice(to, 0, item)
        return { presets: next }
      })
    },

    morphPresets(aId, bId, t) {
      const presets = get().presets
      const a = presets.find((p) => p.id === aId)
      const b = presets.find((p) => p.id === bId)
      if (!a || !b) return
      const edits = morphEdits(rootGraphOf(get()), a, b, t)
      if (edits.length === 0) return
      /*
       * A morph is a gesture, not an edit: dragging the slider produces a
       * continuous stream of these. The caller brackets the whole drag in
       * one transaction (see the Presets panel), so this deliberately does
       * not open its own — nesting would make each frame an undo entry.
       */
      applyPathEdits(edits)
      set({ activePresetId: null })
    },

    resetHardware() {
      /*
       * Clearing the board clears the controls it drove — same rule as
       * `removeHardware`, applied wholesale. Keeps `emptyHardwareLayout`
       * on the CURRENT board too; calling it bare defaults to 'daisy_seed'
       * and would silently reset the target's board.
       */
      mutate((s) => {
        const bound = new Set(s.hardware.components.map((c) => c.id))
        const doomed = new Set(
          s.graph.nodes
            .filter((n) => typeof n.params.bindingId === 'string' && bound.has(n.params.bindingId))
            .map((n) => n.id)
        )
        return {
          hardware: emptyHardwareLayout(s.hardware.board),
          graph: {
            ...s.graph,
            nodes: s.graph.nodes.filter((n) => !doomed.has(n.id)),
            connections: s.graph.connections.filter(
              (c) => !doomed.has(c.from.nodeId) && !doomed.has(c.to.nodeId)
            )
          }
        }
      })
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

    setCodePanelH(px) {
      const cur = get().layout
      const next = clamp(px, LAYOUT_LIMITS.codePanelH.min, LAYOUT_LIMITS.codePanelH.max)
      if (next === cur.codePanelH) return
      set({ layout: { ...cur, codePanelH: next } })
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
        codePanelH: clamp(
          patch.codePanelH ?? cur.codePanelH,
          LAYOUT_LIMITS.codePanelH.min,
          LAYOUT_LIMITS.codePanelH.max
        ),
        paletteCollapsed: patch.paletteCollapsed ?? cur.paletteCollapsed,
        paletteCompact: patch.paletteCompact ?? cur.paletteCompact,
        categoriesCollapsed: patch.categoriesCollapsed ?? cur.categoriesCollapsed,
        paletteFilter: patch.paletteFilter ?? cur.paletteFilter,
        recentKinds: patch.recentKinds ?? cur.recentKinds,
        gridShow: patch.gridShow ?? cur.gridShow,
        gridSnap: patch.gridSnap ?? cur.gridSnap,
        gridSize: clamp(patch.gridSize ?? cur.gridSize, 5, 200),
        marqueeSelect: patch.marqueeSelect ?? cur.marqueeSelect
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

    setCanvasPrefs(patch) {
      const cur = get().layout
      const next = {
        ...cur,
        ...patch,
        gridSize: clamp(patch.gridSize ?? cur.gridSize, 5, 200)
      }
      if (
        next.gridShow === cur.gridShow &&
        next.gridSnap === cur.gridSnap &&
        next.gridSize === cur.gridSize &&
        next.marqueeSelect === cur.marqueeSelect
      ) {
        return
      }
      set({ layout: next })
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
   * Write preset edits (keyed by tree path) into the ROOT graph, then put
   * the store back on whichever level is open.
   *
   * `state.graph` is the open level and `subpatchStack` holds the outer
   * ones, so a recall while inside a box has to: rebuild the root
   * (`rootGraphOf`), apply every edit there (`setParamAtPath` rewrites the
   * container bodies outward), then re-split — the stack's stored outer
   * graphs are replaced by the new root's levels and `graph` by the new
   * body at the same depth. One `mutate`, so it is one history entry.
   */
  function applyPathEdits(edits: { path: string; paramId: string; value: number | string }[]): void {
    if (edits.length === 0) return
    const st = get()
    let root = rootGraphOf(st)
    for (const e of edits) root = setParamAtPath(root, e.path, e.paramId, e.value)
    // Re-derive the open level from the new root by walking the stack's
    // container ids down from the top.
    const stack = st.subpatchStack
    const newStack: typeof stack = []
    let cur = root
    for (const level of stack) {
      newStack.push({ ...level, graph: cur })
      const c = cur.nodes.find((n) => n.id === level.nodeId)
      if (!c) {
        // Container vanished — cannot happen from a param edit, but never
        // leave the store pointing at a body that is not in the tree.
        cur = emptyGraph()
        break
      }
      cur = bodyOf(c)
    }
    set({ subpatchStack: newStack })
    mutate(() => ({ graph: cur }))
    if (get().activePresetId !== null) set({ activePresetId: null })
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
