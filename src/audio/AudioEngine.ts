/**
 * Browser-side DSP emulation engine. Owns an `AudioContext` and a live
 * WebAudio node graph that mirrors the canonical `AudioGraph` data.
 *
 * Design notes:
 * - Lazy context: we can't construct the context before a user gesture, so
 *   `state` stays `'stopped'` until `start()` is first called.
 * - Diffed updates: `setGraph` compares the incoming graph to the last
 *   applied one and only adds/removes nodes that actually changed. This
 *   prevents click/pop artifacts while the user is editing.
 * - `audio_output` is not a worklet — its sockets `left`/`right` feed into
 *   a `ChannelMergerNode` wired to `ctx.destination`.
 */

import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { tryParseCode } from '@/codegen/codeNode/lang'
import type { AudioGraph, Connection, NodeInstance, NodeKind } from '@/types/graph'
import type {
  AudioEngine as AudioEngineInterface,
  EngineState,
  ScopeFrame,
  Tap
} from '@/types/store'
import { WORKLET_REGISTRY, workletEntriesToLoad } from './worklets/registry'

const ANALYSER_FFT = 512
const TIME_DOMAIN_BINS = 256
const FREQ_BINS = 128

interface TapEntry {
  nodeId: string
  onFrame: (f: ScopeFrame) => void
  wantFrequency: boolean
  analyser: AnalyserNode | null
  attachedTo: AudioNode | null
  /** Set to true once `stop()` has been called — skipped by the rAF loop. */
  stopped: boolean
  /** Reusable buffers for pulling analyser data each frame. */
  timeBuf: Float32Array<ArrayBuffer>
  freqBuf: Float32Array<ArrayBuffer> | null
}

const PARAM_RAMP_SECONDS = 0.02

interface LiveNode {
  kind: NodeKind
  /** For worklet-backed nodes. */
  worklet?: AudioWorkletNode
  /** For `audio_output`: the stereo merger that collects L/R. */
  merger?: ChannelMergerNode
}

interface LiveConnection {
  /** id from the serialized Connection */
  id: string
  source: AudioNode
  target: AudioNode
  /** Output index on source (worklets are single-output, so always 0). */
  outputIndex: number
  /** Input index on target — used for `audio_output` L/R via the merger. */
  inputIndex: number
}

type Listener = (state: EngineState, error?: Error) => void

/** What a `preset_recall` node asks the app to do. Slots are indices. */
export type PresetRequest =
  | { action: 'apply'; slot: number }
  | { action: 'morph'; a: number; b: number; t: number }

export type PresetRequestHandler = (req: PresetRequest) => void

/** Deinterleaved PCM, matching `state/sampleStore.ts`. */
export interface EnginePcm {
  channels: Float32Array[]
  sampleRate: number
  frames: number
}

export type SampleReader = (id: string) => Promise<EnginePcm | null>

export class AudioEngine implements AudioEngineInterface {
  private ctx: AudioContext | null = null
  private nodes: Map<string, LiveNode> = new Map()
  private connections: Map<string, LiveConnection> = new Map()
  private currentGraph: AudioGraph = {
    nodes: [],
    connections: [],
    meta: { name: 'untitled', sampleRate: 48000, blockSize: 48 }
  }
  private _state: EngineState = 'stopped'
  private listeners: Set<Listener> = new Set()
  private modulesLoaded = false

  /**
   * Where a `preset_recall` node's requests go.
   *
   * The engine cannot import the store — the store imports the engine's
   * types, and closing that loop would make the module graph cyclic — so
   * the owner wires this up, the same way `setMenuEngine` hands the engine
   * to the menu runtime. Null until then, and a recall with no handler is
   * silently ignored rather than throwing inside an audio callback.
   */
  private presetHandler: PresetRequestHandler | null = null

  /** Set by the app; see `setSampleReader`. */
  private sampleReader: SampleReader | null = null

  /** All active taps, keyed by a monotonically-increasing id. */
  private taps: Map<number, TapEntry> = new Map()
  private nextTapId = 1
  private rafId: number | null = null

  get state(): EngineState {
    return this._state
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(state: EngineState, error?: Error): void {
    this._state = state
    for (const l of this.listeners) {
      try {
        l(state, error)
      } catch {
        // Listener errors must not break the engine.
      }
    }
  }

  async start(): Promise<void> {
    if (this._state === 'running' || this._state === 'starting') return
    this.setState('starting')
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext({ sampleRate: this.currentGraph.meta.sampleRate })
      }
      if (!this.modulesLoaded) {
        const entries = workletEntriesToLoad()
        await Promise.all(
          entries.map((e) => this.ctx!.audioWorklet.addModule(e.moduleUrl.href))
        )
        this.modulesLoaded = true
      }
      // Rebuild graph from scratch now that the context exists.
      this.teardownLiveGraph()
      this.applyGraphFull(this.currentGraph)

      if (this.ctx.state === 'suspended') {
        await this.ctx.resume()
      }
      this.setState('running')
    } catch (err) {
      this.setState('error', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  async stop(): Promise<void> {
    if (!this.ctx) {
      this.setState('stopped')
      return
    }
    try {
      if (this.ctx.state !== 'suspended') {
        await this.ctx.suspend()
      }
      this.setState('stopped')
    } catch (err) {
      this.setState('error', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  setGraph(graph: AudioGraph): void {
    const prev = this.currentGraph
    this.currentGraph = graph

    if (!this.ctx || this._state !== 'running') {
      // Not live yet — just stash. start() will apply fresh.
      return
    }

    this.diffAndApply(prev, graph)
  }

  updateParam(nodeId: string, paramId: string, value: number | string): void {
    // Always mirror into currentGraph so a future start() sees latest values.
    const gNode = this.currentGraph.nodes.find((n) => n.id === nodeId)
    if (gNode) {
      gNode.params = { ...gNode.params, [paramId]: value }
    }

    const live = this.nodes.get(nodeId)
    if (!live || !live.worklet || !this.ctx) return

    if (typeof value === 'number') {
      const audioParam = live.worklet.parameters.get(paramId)
      if (audioParam) {
        const now = this.ctx.currentTime
        try {
          audioParam.cancelScheduledValues(now)
          audioParam.setValueAtTime(audioParam.value, now)
          audioParam.linearRampToValueAtTime(value, now + PARAM_RAMP_SECONDS)
        } catch {
          audioParam.value = value
        }
        return
      }
    }

    // Enum or unknown param → forward to the processor via port.
    live.worklet.port.postMessage({ type: 'param', paramId, value })
    /*
     * A `code` node's body has to be PARSED before the worklet can run it —
     * worklets cannot import a parser, and the CSP forbids compiling one at
     * runtime. So the main thread parses and posts the AST; editing the
     * source has to re-post it or the node keeps playing the old body.
     */
    if (live.kind === 'code' && paramId === 'source') {
      const node = this.currentGraph.nodes.find((n) => n.id === nodeId)
      if (node) this.postCodeAst(live.worklet, node)
    }
  }

  // ---------- internals ----------

  private teardownLiveGraph(): void {
    // Detach every tap's analyser; they'll reattach when nodes come back.
    for (const [, tap] of this.taps) {
      this.detachTapAnalyser(tap)
    }

    for (const conn of this.connections.values()) {
      try {
        conn.source.disconnect(conn.target, conn.outputIndex, conn.inputIndex)
      } catch {
        /* ignore */
      }
    }
    this.connections.clear()

    for (const node of this.nodes.values()) {
      try {
        node.worklet?.disconnect()
      } catch {
        /* ignore */
      }
      try {
        node.merger?.disconnect()
      } catch {
        /* ignore */
      }
    }
    this.nodes.clear()
  }

  private applyGraphFull(graph: AudioGraph): void {
    for (const n of graph.nodes) {
      this.createLiveNode(n)
    }
    for (const c of graph.connections) {
      this.createLiveConnection(c)
    }
  }

  private diffAndApply(prev: AudioGraph, next: AudioGraph): void {
    const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
    const nextNodes = new Map(next.nodes.map((n) => [n.id, n]))

    // Remove connections that no longer exist or whose endpoints changed
    // before touching nodes, so we don't leak disconnect calls.
    const prevConns = new Map(prev.connections.map((c) => [c.id, c]))
    const nextConns = new Map(next.connections.map((c) => [c.id, c]))

    for (const [id, c] of prevConns) {
      const nc = nextConns.get(id)
      if (!nc || !connectionEquals(c, nc)) {
        this.removeLiveConnection(id)
      }
    }

    // Drop nodes that are gone or changed kind.
    for (const [id, prevNode] of prevNodes) {
      const nextNode = nextNodes.get(id)
      if (!nextNode || nextNode.kind !== prevNode.kind) {
        this.removeLiveNode(id)
      }
    }

    // Create new / re-created nodes.
    for (const [id, nextNode] of nextNodes) {
      if (!this.nodes.has(id)) {
        this.createLiveNode(nextNode)
      } else {
        // Same node: push any changed param values through.
        const prevNode = prevNodes.get(id)
        if (prevNode) {
          for (const [pid, val] of Object.entries(nextNode.params)) {
            if (prevNode.params[pid] !== val) {
              this.updateParam(id, pid, val)
            }
          }
        }
      }
    }

    // (Re-)create connections that are new or were torn down.
    for (const [id, c] of nextConns) {
      if (!this.connections.has(id)) {
        this.createLiveConnection(c)
      }
    }
  }

  private createLiveNode(node: NodeInstance): void {
    if (!this.ctx) return
    const def = NODE_DEFINITIONS[node.kind]
    if (!def) return

    if (node.kind === 'audio_output') {
      const merger = this.ctx.createChannelMerger(2)
      merger.connect(this.ctx.destination)
      this.nodes.set(node.id, { kind: node.kind, merger })
      return
    }

    const entry = WORKLET_REGISTRY[node.kind]
    if (!entry) return

    const worklet = new AudioWorkletNode(this.ctx, entry.processorName, {
      numberOfInputs: def.inputs.length,
      numberOfOutputs: def.outputs.length,
      outputChannelCount: def.outputs.length > 0 ? def.outputs.map(() => 1) : []
    })

    // Seed every param from its current value in the graph (or the default).
    for (const p of def.params) {
      const val = node.params[p.id] ?? p.default
      if (p.kind === 'number' && typeof val === 'number') {
        const ap = worklet.parameters.get(p.id)
        if (ap) ap.value = val
      } else {
        worklet.port.postMessage({ type: 'param', paramId: p.id, value: val })
      }
    }
    this.postCodeAst(worklet, node)
    this.attachPresetPort(worklet, node)
    void this.postSamplePcm(worklet, node)

    this.nodes.set(node.id, { kind: node.kind, worklet })

    // Any taps that were queued for this node can now attach their analyser.
    this.attachPendingTaps(node.id)
  }

  /**
   * Ship a sample player's PCM to its worklet.
   *
   * Async and fire-and-forget: reading a few megabytes off disk must not
   * block graph construction, and the worklet plays silence until the
   * buffer arrives — which is the honest behaviour for "this sample is
   * still loading" and takes one frame in practice, since the library
   * caches after the first read.
   *
   * The buffer is TRANSFERRED, not copied. A copy would double the peak
   * memory of a big sample for no benefit, and the store's cached original
   * is untouched because `.slice()` hands over a fresh one.
   */
  private async postSamplePcm(worklet: AudioWorkletNode, node: NodeInstance): Promise<void> {
    if (node.kind !== 'sample_player') return
    const id = typeof node.params.sampleId === 'string' ? node.params.sampleId : ''
    if (!id) {
      worklet.port.postMessage({ type: 'sample', pcm: null })
      return
    }
    const pcm = await this.sampleReader?.(id)
    if (!pcm || pcm.channels.length === 0) {
      worklet.port.postMessage({ type: 'sample', pcm: null })
      return
    }
    // Mono, matching what the firmware compiles in — see sampleCodegen.ts.
    let mono: Float32Array
    if (pcm.channels.length === 1) {
      mono = pcm.channels[0].slice()
    } else {
      mono = new Float32Array(pcm.frames)
      for (let i = 0; i < pcm.frames; i++) {
        let sum = 0
        for (const ch of pcm.channels) sum += ch[i] ?? 0
        mono[i] = sum / pcm.channels.length
      }
    }
    worklet.port.postMessage(
      { type: 'sample', pcm: mono, sampleRate: pcm.sampleRate },
      [mono.buffer]
    )
  }

  /** Where the engine gets sample PCM from. Wired by the app, like the preset handler. */
  setSampleReader(fn: SampleReader | null): void {
    this.sampleReader = fn
  }

  /** Register the handler a `preset_recall` node's messages are routed to. */
  setPresetHandler(fn: PresetRequestHandler | null): void {
    this.presetHandler = fn
  }

  /**
   * Route a preset node's outbound messages to the handler.
   *
   * Only `preset_recall` gets a listener: attaching one to every worklet
   * would mean every node paid for a message channel it never uses, and
   * `port.onmessage` is single-slot — a second assignment would silently
   * replace whatever else was listening.
   */
  private attachPresetPort(worklet: AudioWorkletNode, node: NodeInstance): void {
    if (node.kind !== 'preset_recall') return
    worklet.port.onmessage = (event: MessageEvent) => {
      const d = event.data as {
        type?: string
        action?: string
        slot?: number
        a?: number
        b?: number
        t?: number
      }
      if (d?.type !== 'preset' || !this.presetHandler) return
      if (d.action === 'apply' && typeof d.slot === 'number') {
        this.presetHandler({ action: 'apply', slot: d.slot })
      } else if (
        d.action === 'morph' &&
        typeof d.a === 'number' &&
        typeof d.b === 'number' &&
        typeof d.t === 'number'
      ) {
        this.presetHandler({ action: 'morph', a: d.a, b: d.b, t: d.t })
      }
    }
  }

  /**
   * Parse a `code` node's body and hand the AST to its worklet.
   *
   * The worklet cannot do this itself: it has no imports, and the built
   * app's CSP (`script-src 'self'`) rules out compiling a parser at
   * runtime. So the main thread parses and posts an AST, which the worklet
   * turns into closures. A body that does not parse posts nothing and the
   * node stays silent — the in-node editor is where the error is shown.
   */
  private postCodeAst(worklet: AudioWorkletNode, node: NodeInstance): void {
    if (node.kind !== 'code') return
    const parsed = tryParseCode(String(node.params.source ?? ''))
    if ('error' in parsed) return
    worklet.port.postMessage({ type: 'param', paramId: 'ast', value: parsed.program })
  }

  private removeLiveNode(id: string): void {
    const live = this.nodes.get(id)
    if (!live) return

    // Detach analysers belonging to any taps pointing at this node so their
    // `AnalyserNode` isn't left dangling off a disconnected worklet.
    this.detachTapsFor(id)

    // Also drop any connections that reference it.
    for (const [cid, conn] of this.connections) {
      if (
        conn.source === live.worklet ||
        conn.target === live.worklet ||
        conn.target === live.merger
      ) {
        this.removeLiveConnection(cid)
      }
    }

    try {
      live.worklet?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      live.merger?.disconnect()
    } catch {
      /* ignore */
    }
    this.nodes.delete(id)
  }

  private createLiveConnection(c: Connection): void {
    const src = this.nodes.get(c.from.nodeId)
    const dst = this.nodes.get(c.to.nodeId)
    if (!src || !dst) return

    const source = src.worklet
    if (!source) return // audio_output has no output socket

    // Resolve outputIndex from the source socket id via its NodeDefinition.
    const srcDef = NODE_DEFINITIONS[src.kind]
    const outputIndex = srcDef
      ? Math.max(0, srcDef.outputs.findIndex((s) => s.id === c.from.socketId))
      : 0

    let target: AudioNode | undefined
    let inputIndex = 0

    if (dst.kind === 'audio_output') {
      if (!dst.merger) return
      target = dst.merger
      inputIndex = c.to.socketId === 'right' ? 1 : 0
    } else {
      target = dst.worklet
      const dstDef = NODE_DEFINITIONS[dst.kind]
      inputIndex = dstDef
        ? Math.max(0, dstDef.inputs.findIndex((s) => s.id === c.to.socketId))
        : 0
    }
    if (!target) return

    try {
      source.connect(target, outputIndex, inputIndex)
    } catch {
      return
    }
    this.connections.set(c.id, {
      id: c.id,
      source,
      target,
      outputIndex,
      inputIndex
    })
  }

  private removeLiveConnection(id: string): void {
    const conn = this.connections.get(id)
    if (!conn) return
    try {
      conn.source.disconnect(conn.target, conn.outputIndex, conn.inputIndex)
    } catch {
      /* ignore */
    }
    this.connections.delete(id)
  }

  // ---------- taps ----------

  tap(
    nodeId: string,
    onFrame: (f: ScopeFrame) => void,
    opts?: { wantFrequency?: boolean }
  ): Tap {
    const wantFrequency = opts?.wantFrequency === true
    // Construct through an ArrayBuffer so the result is typed
    // `Float32Array<ArrayBuffer>` (what `AnalyserNode.getFloat*Data` accepts
    // in current TS lib.dom), not `Float32Array<ArrayBufferLike>`.
    const timeBuf = new Float32Array(new ArrayBuffer(TIME_DOMAIN_BINS * 4))
    const freqBuf = wantFrequency
      ? new Float32Array(new ArrayBuffer(FREQ_BINS * 4))
      : null

    const entry: TapEntry = {
      nodeId,
      onFrame,
      wantFrequency,
      analyser: null,
      attachedTo: null,
      stopped: false,
      timeBuf,
      freqBuf
    }

    const id = this.nextTapId++
    this.taps.set(id, entry)

    // If the node is already live, attach immediately.
    this.tryAttachTap(entry)

    // Ensure the rAF dispatcher is running.
    this.ensureTapLoop()

    return {
      stop: () => {
        if (entry.stopped) return
        entry.stopped = true
        this.detachTapAnalyser(entry)
        this.taps.delete(id)
        if (this.taps.size === 0) {
          this.stopTapLoop()
        }
      }
    }
  }

  private ensureTapLoop(): void {
    if (this.rafId !== null) return
    if (typeof requestAnimationFrame === 'undefined') return
    const tick = () => {
      this.rafId = requestAnimationFrame(tick)
      this.dispatchTapFrames()
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopTapLoop(): void {
    if (this.rafId === null) return
    if (typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId)
    }
    this.rafId = null
  }

  private dispatchTapFrames(): void {
    for (const tap of this.taps.values()) {
      if (tap.stopped) continue
      const a = tap.analyser
      if (!a) {
        // No analyser attached yet — emit a zeroed frame so the renderer can
        // still paint a flat line rather than stall on undefined.
        tap.timeBuf.fill(0)
        if (tap.freqBuf) tap.freqBuf.fill(0)
        try {
          tap.onFrame({
            timeDomain: tap.timeBuf,
            frequency: tap.freqBuf ?? undefined
          })
        } catch {
          /* swallow callback errors */
        }
        continue
      }
      try {
        a.getFloatTimeDomainData(tap.timeBuf)
        if (tap.wantFrequency && tap.freqBuf) {
          a.getFloatFrequencyData(tap.freqBuf)
          // dB -100..0 -> 0..1 for drawing. Any NaN/-Infinity floors to 0.
          const buf = tap.freqBuf
          for (let i = 0; i < buf.length; i++) {
            const v = buf[i]
            const norm = (v + 100) / 100
            buf[i] = norm < 0 ? 0 : norm > 1 ? 1 : norm
          }
        }
        tap.onFrame({
          timeDomain: tap.timeBuf,
          frequency: tap.freqBuf ?? undefined
        })
      } catch {
        /* swallow — analyser may have been detached mid-frame */
      }
    }
  }

  private tryAttachTap(tap: TapEntry): void {
    if (!this.ctx) return
    if (tap.analyser) return
    const live = this.nodes.get(tap.nodeId)
    const source = live?.worklet
    if (!source) return

    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = ANALYSER_FFT
    analyser.smoothingTimeConstant = 0.6
    try {
      // Connect output 0 as a fork — does NOT interrupt existing connections.
      source.connect(analyser, 0)
    } catch {
      return
    }
    tap.analyser = analyser
    tap.attachedTo = source
  }

  private attachPendingTaps(nodeId: string): void {
    for (const tap of this.taps.values()) {
      if (tap.stopped) continue
      if (tap.nodeId !== nodeId) continue
      if (tap.analyser) continue
      this.tryAttachTap(tap)
    }
  }

  private detachTapsFor(nodeId: string): void {
    for (const tap of this.taps.values()) {
      if (tap.nodeId !== nodeId) continue
      this.detachTapAnalyser(tap)
    }
  }

  private detachTapAnalyser(tap: TapEntry): void {
    if (tap.analyser && tap.attachedTo) {
      try {
        tap.attachedTo.disconnect(tap.analyser)
      } catch {
        /* ignore */
      }
    }
    tap.analyser = null
    tap.attachedTo = null
  }
}

function connectionEquals(a: Connection, b: Connection): boolean {
  return (
    a.from.nodeId === b.from.nodeId &&
    a.from.socketId === b.from.socketId &&
    a.to.nodeId === b.to.nodeId &&
    a.to.socketId === b.to.socketId
  )
}
