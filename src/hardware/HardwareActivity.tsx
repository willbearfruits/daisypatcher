/**
 * HardwareActivity — a thin tap-manager used by the HardwareView to wire
 * placed components to the live audio signal that drives them.
 *
 * Motivation
 * ----------
 * Per-frame animations (LED glow, button press flash, MIDI jack blink)
 * must NOT go through React state, otherwise each rAF tick triggers a
 * reconcile and the hardware view drops frames. Instead this helper:
 *
 *   1. For each placed component with a linked graph node, opens exactly
 *      ONE `AudioEngine.tap()` on the correct source (the node itself, or
 *      its upstream driver for sink nodes like `led`).
 *   2. Fans the frame out to registered subscribers keyed by placed-
 *      component id. Subscribers receive an `ActivityFrame` — a lightweight
 *      object carrying the scalar activity value (0..1 for audio RMS, 0/1
 *      for gates, or the raw sample for CV) plus the rising-edge flag.
 *   3. On connectivity changes (binding added/removed, connection added to
 *      an LED's input) the taps are reopened.
 *
 * Subscribers attach ref-based DOM mutators, not React state setters. A
 * typical subscriber updates a CSS custom property like
 * `--hw-activity-level` on its root element; the component's CSS transforms
 * that into glow intensity / rotation / fill.
 */

import * as React from 'react'
import type { AudioGraph } from '@/types/graph'
import type { HardwareLayout, PlacedComponent } from '@/types/hardware'
import type { AudioEngine, ScopeFrame, Tap } from '@/types/store'
import { findGraphNodeForBinding } from './hardwareBindingLabels'
import { useAudioEngine } from '@/audio/AudioEngineContext'
import { useEditorStore } from '@/state/store'

/** What a placed component needs from the engine to drive its animation. */
export type ActivityMode =
  | { kind: 'none' }
  /** Tap the graph node's own output (first channel) and pass RMS. */
  | { kind: 'rms'; nodeId: string }
  /** Tap the input connection's upstream source and pass RMS. Used by LEDs. */
  | { kind: 'rms-input'; nodeId: string; socketId: string }
  /** Tap an output and look for a gate rising edge (frame[0] > 0.5). */
  | { kind: 'gate'; nodeId: string }
  /** Tap an output and pass through the scalar value (cv). */
  | { kind: 'cv'; nodeId: string }

/** Per-frame payload delivered to subscribers. */
export interface ActivityFrame {
  /**
   * Normalised activity scalar. For audio/cv this is the RMS of the
   * frame (0..1 clipped); for gates this equals the last edge's target
   * (0 or 1); for "none" this stays 0.
   */
  level: number
  /** True on the frame a gate transitioned from low to high. */
  risingEdge: boolean
  /** Monotonic time (ms) of this frame, for decay animations. */
  tMs: number
}

/**
 * Decide the activity mode for a placed component. Returns `{kind:'none'}`
 * when no useful tap source exists (no linked graph node, or kind doesn't
 * benefit from animation).
 */
export function activityModeFor(
  comp: PlacedComponent,
  graph: AudioGraph
): ActivityMode {
  const node = findGraphNodeForBinding(graph, comp.id)
  if (!node) return { kind: 'none' }

  switch (comp.kind) {
    case 'led':
      // LED is a pure sink; its input signal is what we animate. Walk the
      // connection graph to the upstream source of its `in` socket.
      return { kind: 'rms-input', nodeId: node.id, socketId: 'in' }
    case 'button':
    case 'gate_jack':
      return { kind: 'gate', nodeId: node.id }
    case 'pot':
      // Knobs are "static" unless driven by CV. `knob_in` currently has no
      // CV input socket, so there's nothing to animate — return none to
      // skip the tap entirely. (If a future kind exposes a value_cv input
      // we'd switch to `rms-input` on that socket here.)
      return { kind: 'none' }
    case 'cv_jack':
      return { kind: 'cv', nodeId: node.id }
    case 'audio_jack':
      return { kind: 'rms', nodeId: node.id }
    case 'midi_jack':
      // MIDI-in: graph node is `midi_in_note` (3 outputs: pitch/gate/vel).
      // We watch the gate output for the rising-edge blink.
      if (node.kind === 'midi_in_note') return { kind: 'gate', nodeId: node.id }
      if (node.kind === 'midi_in_cc')   return { kind: 'cv', nodeId: node.id }
      return { kind: 'none' }
    case 'i2s_codec':
      // i2s_in outputs stereo audio; pick left.
      if (node.kind === 'i2s_in') return { kind: 'rms', nodeId: node.id }
      return { kind: 'none' }
    case 'switch_3way':
    case 'oled_ssd1306':
    case 'encoder':
    default:
      return { kind: 'none' }
  }
}

/** Compute RMS of a time-domain buffer, clipped 0..1. */
function rms(buf: Float32Array): number {
  if (!buf || buf.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]
    sumSq += v * v
  }
  const r = Math.sqrt(sumSq / buf.length)
  return r > 1 ? 1 : r < 0 ? 0 : r
}

export type ActivityListener = (frame: ActivityFrame) => void

/**
 * Engine-backed tap manager. Owns one `Tap` per placed component and
 * broadcasts per-frame activity to registered listeners.
 *
 * Lifecycle
 * ---------
 *   const mgr = new HardwareActivityManager(engine)
 *   mgr.sync(hardware, graph)           // open/close/reopen taps
 *   const off = mgr.subscribe(id, cb)   // listen for frames
 *   ...
 *   off()                                // unsubscribe
 *   mgr.dispose()                        // stop all taps
 */
export class HardwareActivityManager {
  private engine: AudioEngine | null
  private taps: Map<string, { tap: Tap; key: string }> = new Map()
  private listeners: Map<string, Set<ActivityListener>> = new Map()
  /** Last broadcast frame per component — used to seed late subscribers. */
  private lastFrame: Map<string, ActivityFrame> = new Map()
  private prevGateHigh: Map<string, boolean> = new Map()

  constructor(engine: AudioEngine | null) {
    this.engine = engine
  }

  /**
   * Reconcile taps against the current layout + graph. Closes taps for
   * components that no longer need them, opens new taps, and reopens taps
   * whose source node / connectivity changed.
   */
  sync(hardware: HardwareLayout, graph: AudioGraph): void {
    if (!this.engine) {
      this.closeAll()
      return
    }
    const wanted = new Map<string, { mode: ActivityMode; key: string }>()
    for (const comp of hardware.components) {
      const mode = activityModeFor(comp, graph)
      if (mode.kind === 'none') continue
      // Key includes the source nodeId + (for rms-input) the upstream node
      // so reopening on connectivity changes is automatic.
      const key = computeKey(mode, graph)
      wanted.set(comp.id, { mode, key })
    }

    // Close taps for components that are gone or whose key changed.
    for (const [id, entry] of this.taps) {
      const w = wanted.get(id)
      if (!w || w.key !== entry.key) {
        entry.tap.stop()
        this.taps.delete(id)
        this.prevGateHigh.delete(id)
      }
    }

    // Open taps for newly-interested components.
    for (const [id, w] of wanted) {
      if (this.taps.has(id)) continue
      const tap = this.openTap(id, w.mode, graph)
      if (tap) this.taps.set(id, { tap, key: w.key })
    }
  }

  private openTap(
    compId: string,
    mode: ActivityMode,
    graph: AudioGraph
  ): Tap | null {
    if (!this.engine) return null

    // Resolve the actual node to tap.
    let tapNodeId: string | null = null
    if (mode.kind === 'rms' || mode.kind === 'gate' || mode.kind === 'cv') {
      tapNodeId = mode.nodeId
    } else if (mode.kind === 'rms-input') {
      // Walk to upstream source of the specified input socket.
      const conn = graph.connections.find(
        (c) => c.to.nodeId === mode.nodeId && c.to.socketId === mode.socketId
      )
      if (!conn) return null
      tapNodeId = conn.from.nodeId
    }
    if (!tapNodeId) return null

    return this.engine.tap(tapNodeId, (frame) => {
      this.dispatch(compId, mode, frame)
    })
  }

  private dispatch(compId: string, mode: ActivityMode, frame: ScopeFrame): void {
    const now = performance.now()
    let level = 0
    let risingEdge = false

    switch (mode.kind) {
      case 'rms':
      case 'rms-input':
        level = rms(frame.timeDomain)
        break
      case 'cv': {
        // CV nodes emit a (nearly) DC value; first sample is representative.
        const v = frame.timeDomain[0] ?? 0
        level = v < 0 ? 0 : v > 1 ? 1 : v
        break
      }
      case 'gate': {
        const v = (frame.timeDomain[0] ?? 0) > 0.5 ? 1 : 0
        level = v
        const prev = this.prevGateHigh.get(compId) ?? false
        if (v === 1 && !prev) risingEdge = true
        this.prevGateHigh.set(compId, v === 1)
        break
      }
      case 'none':
        return
    }

    const out: ActivityFrame = { level, risingEdge, tMs: now }
    this.lastFrame.set(compId, out)
    const ls = this.listeners.get(compId)
    if (!ls) return
    for (const l of ls) {
      try {
        l(out)
      } catch {
        /* listener errors must not break the dispatcher */
      }
    }
  }

  /** Register a listener for per-frame activity updates. */
  subscribe(compId: string, cb: ActivityListener): () => void {
    let set = this.listeners.get(compId)
    if (!set) {
      set = new Set()
      this.listeners.set(compId, set)
    }
    set.add(cb)
    // Fire one synthetic idle frame so subscribers can initialise.
    const last = this.lastFrame.get(compId)
    try {
      cb(last ?? { level: 0, risingEdge: false, tMs: performance.now() })
    } catch {
      /* swallow */
    }
    return () => {
      const s = this.listeners.get(compId)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.listeners.delete(compId)
    }
  }

  /** Swap the active engine reference. Closes all taps on the old engine. */
  setEngine(engine: AudioEngine | null): void {
    if (this.engine === engine) return
    this.closeAll()
    this.engine = engine
  }

  private closeAll(): void {
    for (const entry of this.taps.values()) {
      try {
        entry.tap.stop()
      } catch {
        /* ignore */
      }
    }
    this.taps.clear()
    this.prevGateHigh.clear()
    this.lastFrame.clear()
  }

  dispose(): void {
    this.closeAll()
    this.listeners.clear()
  }
}

function computeKey(mode: ActivityMode, graph: AudioGraph): string {
  switch (mode.kind) {
    case 'rms':
    case 'cv':
    case 'gate':
      return `${mode.kind}:${mode.nodeId}`
    case 'rms-input': {
      // Key includes the upstream source so a user wiring a new source
      // into the LED's input reopens the tap automatically.
      const conn = graph.connections.find(
        (c) => c.to.nodeId === mode.nodeId && c.to.socketId === mode.socketId
      )
      return `rms-input:${mode.nodeId}:${mode.socketId}:${conn?.from.nodeId ?? '-'}`
    }
    case 'none':
      return 'none'
  }
}

/* =====================================================================
 * React integration.
 * ===================================================================== */

const HardwareActivityContext = React.createContext<HardwareActivityManager | null>(null)

/**
 * Top-level provider — creates one manager per HardwareView mount. Reads
 * the engine + hardware layout + graph connectivity out of their
 * respective stores, reconciles taps when connectivity changes.
 *
 * IMPORTANT: the selector subscribes to a stable string key (not a new
 * array per render) so `useSyncExternalStore` doesn't loop. The actual
 * reconcile runs in `useEffect`, outside React's render cycle.
 */
export function HardwareActivityProvider(props: {
  children: React.ReactNode
}): React.JSX.Element {
  const engine = useAudioEngine()
  const mgrRef = React.useRef<HardwareActivityManager | null>(null)
  if (mgrRef.current === null) mgrRef.current = new HardwareActivityManager(engine)
  const mgr = mgrRef.current

  React.useEffect(() => {
    mgr.setEngine(engine)
  }, [engine, mgr])

  // Re-sync when bindings, components, or connectivity change. We pull a
  // stable key off the store — new objects per render would cause the
  // useSyncExternalStore infinite-loop bug CLAUDE.md calls out.
  const syncKey = useEditorStore((s) => {
    const parts: string[] = []
    for (const c of s.hardware.components) {
      parts.push(`${c.id}:${c.kind}`)
    }
    parts.push('|')
    for (const n of s.graph.nodes) {
      const bid = typeof n.params.bindingId === 'string' ? n.params.bindingId : ''
      if (bid) parts.push(`${n.id}:${n.kind}:${bid}`)
    }
    parts.push('|')
    for (const c of s.graph.connections) {
      parts.push(`${c.from.nodeId}>${c.to.nodeId}.${c.to.socketId}`)
    }
    return parts.join(',')
  })

  React.useEffect(() => {
    const { graph, hardware } = useEditorStore.getState()
    mgr.sync(hardware, graph)
  }, [syncKey, mgr, engine])

  React.useEffect(() => {
    return () => {
      mgr.dispose()
    }
  }, [mgr])

  return (
    <HardwareActivityContext.Provider value={mgr}>
      {props.children}
    </HardwareActivityContext.Provider>
  )
}

export function useHardwareActivityManager(): HardwareActivityManager | null {
  return React.useContext(HardwareActivityContext)
}

/**
 * Subscribe to activity frames for a single placed component. The callback
 * fires on every animation frame (via the engine's tap rAF loop) with the
 * latest `ActivityFrame`. Callback MUST mutate DOM via refs — setting
 * React state per frame will hurt.
 *
 * Stable callback recommended but not required — we register/unregister
 * whenever the callback identity changes, which is cheap.
 */
export function useHardwareActivity(
  componentId: string,
  cb: ActivityListener
): void {
  const mgr = useHardwareActivityManager()
  const cbRef = React.useRef(cb)
  React.useEffect(() => {
    cbRef.current = cb
  }, [cb])

  React.useEffect(() => {
    if (!mgr) return
    return mgr.subscribe(componentId, (frame) => cbRef.current(frame))
  }, [mgr, componentId])
}


