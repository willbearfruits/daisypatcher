// Render a patch through the REAL emulator worklets, headlessly.
//
// The worklets are the thing the app plays, so this is not a model of the
// emulator — it is the emulator, driven from Node instead of from an
// AudioContext. They are self-contained by contract (no imports, no window,
// no shared singletons), which is exactly what makes that possible: the
// whole `AudioWorkletGlobalScope` surface they touch is five names, shimmed
// below.
//
// Used by `scripts/audio-parity.mjs` to check the emulator against firmware
// compiled for the host, and available on its own for any test that wants
// deterministic audio out of a patch.

import { readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

/** WebAudio's fixed render quantum. Worklets may assume it. */
export const QUANTUM = 128

/**
 * Install the AudioWorklet globals and load every registered processor.
 *
 * Returns a map of processorName -> class. Loading is a side effect of
 * importing the module, because that is how `registerProcessor` works; the
 * shim captures the registrations as they happen.
 */
/**
 * Registrations, cached across calls.
 *
 * `registerProcessor` runs as a side effect of importing the module, and ES
 * modules evaluate exactly once per URL — so a second call would import
 * nothing, register nothing, and hand back an empty map. Everything after
 * it would then render silence, which looks like a DSP bug rather than a
 * loader one. Caching is not an optimisation here; it is the correctness
 * fix.
 */
let registeredCache = null

export async function loadWorklets(workletDir, _registry, sampleRate = 48000) {
  // The clock is reset per render regardless, so a cached load is still a
  // clean start for the caller.
  globalThis.sampleRate = sampleRate
  if (registeredCache) return registeredCache
  const registered = new Map()

  // The five globals the worklets actually use. `currentFrame`/`currentTime`
  // advance per block so anything time-based behaves as it does in-app.
  globalThis.sampleRate = sampleRate
  globalThis.currentFrame = 0
  globalThis.currentTime = 0
  globalThis.registerProcessor = (name, ctor) => registered.set(name, ctor)
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      // A minimal MessagePort: worklets only ever read `onmessage` and, in
      // a couple of cases, post back. Nothing here consumes those.
      this.port = {
        onmessage: null,
        postMessage() {},
        start() {},
        close() {}
      }
    }
  }

  /*
   * Every compiled worklet in the directory, rather than the ones the
   * registry names. The registry's `moduleUrl` is built from
   * `import.meta.url`, which is meaningless once this is loaded outside a
   * module graph — and the registry is only needed for `processorName`
   * anyway, since registration is keyed on that. Globbing also means a
   * worklet added without a registry entry still loads, which is the
   * forgiving direction for a test harness.
   */
  const files = readdirSync(workletDir)
    .filter((f) => f.endsWith('.worklet.js'))
    .sort()
  if (files.length === 0) {
    // Rendering with no worklets would be silence for every node, and a
    // test that compares against silence can pass by accident. It did:
    // the release workflow ran the gate before `build:worklets` and 100 of
    // 102 checks went green with nothing loaded.
    throw new Error(
      `no compiled worklets in ${workletDir} — run \`npm run build:worklets\` first`
    )
  }
  for (const f of files) {
    await import(pathToFileURL(path.join(workletDir, f)).href)
  }
  registeredCache = registered
  return registered
}

/**
 * Advance the worklet clock. Worklets read these as globals, so they have
 * to be updated between blocks rather than passed in.
 */
function tickClock(frames, sampleRate) {
  globalThis.currentFrame += frames
  globalThis.currentTime = globalThis.currentFrame / sampleRate
}

/**
 * Render `seconds` of a patch and return interleaved-free stereo floats.
 *
 * Mirrors `AudioEngine` exactly where it matters: one worklet per node with
 * `numberOfInputs = def.inputs.length` and one channel per output socket,
 * numeric params as AudioParams and everything else posted to the port, and
 * an UNCONNECTED input delivered as an empty array rather than a buffer of
 * zeros — several emitters branch on that distinction and treating them the
 * same is a real behavioural difference, not a detail.
 */
export async function renderGraph(opts) {
  const {
    graph,
    definitions,
    registry,
    workletDir,
    sampleRate = 48000,
    seconds = 1,
    processors
  } = opts

  const classes = processors ?? (await loadWorklets(workletDir, registry, sampleRate))

  // Topological order. Cycles are broken the same way codegen breaks them:
  // drop the lowest in-degree node in and carry on, so a feedback patch
  // still renders instead of throwing.
  const order = topoOrder(graph)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  /** nodeId -> { proc, outputs: Float32Array[][], params } */
  const live = new Map()
  for (const id of order) {
    const node = byId.get(id)
    const def = definitions[node.kind]
    const entry = registry[node.kind]
    if (!def || !entry) continue
    const Ctor = classes.get(entry.processorName)
    if (!Ctor) {
      throw new Error(
        `worklet ${entry.processorName} for kind '${node.kind}' is not compiled — ` +
          `run \`npm run build:worklets\` (a missing worklet renders silence, which is not a result)`
      )
    }

    const proc = new Ctor({})
    const descriptors = Ctor.parameterDescriptors ?? []
    const params = {}
    for (const d of descriptors) {
      const raw = node.params[d.name]
      const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : (d.defaultValue ?? 0)
      // k-rate is one value per block; a-rate is one per frame. Worklets
      // detect which by comparing lengths, so the length is the contract.
      params[d.name] = new Float32Array(d.automationRate === 'a-rate' ? QUANTUM : 1).fill(v)
    }
    // Non-numeric params (enums, JSON blobs) arrive over the port.
    for (const p of def.params) {
      const val = node.params[p.id] ?? p.default
      if (p.kind === 'number' && typeof val === 'number') continue
      proc.port.onmessage?.({ data: { type: 'param', paramId: p.id, value: val } })
    }
    /*
     * Anything the ENGINE posts beyond the raw params has to be posted here
     * too, or this renders a different patch from the one the app plays.
     * The `code` node is the case: its worklet needs a parsed AST, not the
     * source text, because worklets cannot import a parser and the CSP
     * rules out building one at runtime. The caller supplies the hook so
     * this file stays ignorant of the language.
     */
    opts.postExtras?.(
      node,
      (paramId, value) => {
        proc.port.onmessage?.({ data: { type: 'param', paramId, value } })
      },
      /*
       * Raw port message. Not every extra the engine posts is a param —
       * a `sample_player` gets `{type:'sample', pcm}` — and squeezing
       * those through the param shape would mean the worklet had to
       * accept a message format nothing else sends it.
       */
      (msg) => {
        proc.port.onmessage?.({ data: msg })
      }
    )

    const outputs = def.outputs.map(() => [new Float32Array(QUANTUM)])
    live.set(id, { node, def, proc, outputs, params })
  }

  // Where each input socket gets its samples from.
  const sourceOf = new Map()
  for (const c of graph.connections) {
    const src = live.get(c.from.nodeId)
    const dstDef = definitions[byId.get(c.to.nodeId)?.kind ?? '']
    if (!src || !dstDef) continue
    const outIdx = src.def.outputs.findIndex((s) => s.id === c.from.socketId)
    const inIdx = dstDef.inputs.findIndex((s) => s.id === c.to.socketId)
    if (outIdx < 0 || inIdx < 0) continue
    sourceOf.set(`${c.to.nodeId}|${inIdx}`, { nodeId: c.from.nodeId, outIdx })
  }

  const sink = graph.nodes.find((n) => n.kind === 'audio_output')
  const total = Math.max(1, Math.round(seconds * sampleRate))
  const left = new Float32Array(total)
  const right = new Float32Array(total)

  globalThis.currentFrame = 0
  globalThis.currentTime = 0

  for (let written = 0; written < total; written += QUANTUM) {
    for (const id of order) {
      const L = live.get(id)
      if (!L) continue
      const inputs = L.def.inputs.map((_s, i) => {
        const src = sourceOf.get(`${id}|${i}`)
        if (!src) return [] // unconnected — the empty-array contract
        const from = live.get(src.nodeId)
        return from ? from.outputs[src.outIdx] : []
      })
      for (const out of L.outputs) out[0].fill(0)
      L.proc.process(inputs, L.outputs, L.params)
    }

    // The sink has no worklet of its own; the engine wires its inputs
    // straight to the destination, so read them the same way here.
    const n = Math.min(QUANTUM, total - written)
    if (sink) {
      const sinkDef = definitions.audio_output
      const grab = (socketId) => {
        const i = sinkDef.inputs.findIndex((s) => s.id === socketId)
        const src = sourceOf.get(`${sink.id}|${i}`)
        if (!src) return null
        const from = live.get(src.nodeId)
        return from ? from.outputs[src.outIdx][0] : null
      }
      const l = grab('left')
      // A patch wired only to `left` is mono, and the app plays it on both
      // sides; matching that here keeps the parity check honest.
      const r = grab('right') ?? l
      for (let i = 0; i < n; i++) {
        left[written + i] = l ? l[i] : 0
        right[written + i] = r ? r[i] : 0
      }
    }
    tickClock(QUANTUM, sampleRate)
  }

  return { left, right, sampleRate }
}

/** Kahn, with the same cycle tolerance codegen has. */
function topoOrder(graph) {
  const ids = graph.nodes.map((n) => n.id)
  const indeg = new Map(ids.map((id) => [id, 0]))
  const adj = new Map(ids.map((id) => [id, []]))
  for (const c of graph.connections) {
    if (!indeg.has(c.from.nodeId) || !indeg.has(c.to.nodeId)) continue
    if (c.from.nodeId === c.to.nodeId) continue
    adj.get(c.from.nodeId).push(c.to.nodeId)
    indeg.set(c.to.nodeId, indeg.get(c.to.nodeId) + 1)
  }
  const out = []
  const placed = new Set()
  while (placed.size < ids.length) {
    let next = ids.find((id) => !placed.has(id) && indeg.get(id) <= 0)
    if (!next) {
      let best = null
      let min = Infinity
      for (const id of ids) {
        if (placed.has(id)) continue
        if (indeg.get(id) < min) {
          min = indeg.get(id)
          best = id
        }
      }
      next = best
      if (!next) break
    }
    out.push(next)
    placed.add(next)
    for (const d of adj.get(next) ?? []) indeg.set(d, indeg.get(d) - 1)
  }
  return out
}

/** Peak, RMS and the largest sample-wise difference between two renders. */
export function compare(a, b) {
  const n = Math.min(a.length, b.length)
  let peakA = 0
  let peakB = 0
  let sumSqA = 0
  let sumSqB = 0
  let maxDiff = 0
  let sumSqDiff = 0
  for (let i = 0; i < n; i++) {
    peakA = Math.max(peakA, Math.abs(a[i]))
    peakB = Math.max(peakB, Math.abs(b[i]))
    sumSqA += a[i] * a[i]
    sumSqB += b[i] * b[i]
    const d = a[i] - b[i]
    sumSqDiff += d * d
    maxDiff = Math.max(maxDiff, Math.abs(d))
  }
  const rmsA = Math.sqrt(sumSqA / n)
  const rmsB = Math.sqrt(sumSqB / n)
  const rmsDiff = Math.sqrt(sumSqDiff / n)
  return {
    samples: n,
    peakA,
    peakB,
    rmsA,
    rmsB,
    maxDiff,
    rmsDiff,
    // Relative to the louder of the two, so a quiet patch is not flattered.
    rmsDiffRelative: rmsDiff / Math.max(1e-9, Math.max(rmsA, rmsB))
  }
}
