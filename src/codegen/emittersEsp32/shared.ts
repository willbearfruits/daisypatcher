import type { NodeInstance } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { NodeEmitter } from '../nodeEmitters'


/* --------------------------- helpers --------------------------- */

/**
 * Params a menu leaf drives at runtime. Mirrors the identically-named hook
 * in `nodeEmitters.ts` — see the long comment there for why this is
 * module-level rather than threaded through `EmitContext`. The two tables
 * are separate because the two emitter files are separate translation
 * units of the same idea; the backends set both.
 */
let PARAM_OVERRIDES: ReadonlyMap<string, string> | null = null

export function setParamOverridesEsp32(m: ReadonlyMap<string, string> | null): void {
  PARAM_OVERRIDES = m
}

/**
 * The live global driving this param, or null when it is still a literal.
 *
 * Emitters that read a param through `rawNum()` — because they need an
 * integer at codegen time, for an array size or a precomputed table — do
 * not get the `numParam()` hook for free. Those few need to ask explicitly
 * and emit a runtime path; `euclidean` is the case that matters, since a
 * rhythm generator whose pulse count cannot change is a much poorer node.
 */
export function paramOverrideOf(node: NodeInstance, id: string): string | null {
  return paramOverride(node, id)
}

function paramOverride(node: NodeInstance, id: string): string | null {
  return PARAM_OVERRIDES?.get(`${node.id}|${id}`) ?? null
}

export function numParam(node: NodeInstance, id: string, fallback = 0): string {
  const ov = paramOverride(node, id)
  if (ov) return ov
  const raw = node.params[id]
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  return formatFloat(value)
}

export function rawNum(node: NodeInstance, id: string, fallback = 0): number {
  const raw = node.params[id]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

export function enumParam(node: NodeInstance, id: string, fallback: string): string {
  const raw = node.params[id]
  return typeof raw === 'string' ? raw : fallback
}

export function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return '0.f'
  if (Number.isInteger(v)) return `${v}.f`
  let s = v.toPrecision(9)
  if (s.includes('e') || s.includes('E')) s = v.toFixed(9)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0')
  return `${s}f`
}

function makePassthrough(reason: string): NodeEmitter {
  return {
    declare: () => '',
    init: () => '',
    process: (ctx) => {
      const def = NODE_DEFINITIONS[ctx.node.kind]
      if (!def || def.outputs.length === 0) {
        return `    // ${ctx.node.kind}: ${reason} (no outputs)\n`
      }
      const inSocket = def.inputs[0]?.id
      const expr = inSocket ? ctx.inputExpr(ctx.node.id, inSocket, '0.f') : '0.f'
      const lines: string[] = [`    // ${ctx.node.kind}: ${reason}`]
      for (const out of def.outputs) {
        lines.push(`    float ${ctx.outputVar(ctx.node.id, out.id)} = ${expr};`)
      }
      return lines.join('\n') + '\n'
    }
  }
}

/** Loud warning + passthrough: "this kind isn't viable on the MCU." */
export function unsupported(kind: string, why: string): NodeEmitter {
  const base = makePassthrough(`not supported on ESP32-S3 (${why}) — passthrough`)
  return {
    declare: base.declare,
    init: base.init,
    process: (ctx) => {
      ctx.warn(`${kind}: ${why} — passthrough on ESP32-S3`)
      return base.process(ctx)
    }
  }
}


/**
 * Samples emitted for this build, keyed by node id.
 *
 * Same shape and same reasoning as `PARAM_OVERRIDES` above: the PCM arrays
 * are produced once at file scope by `sampleCodegen.ts`, and the player's
 * `process` needs to know the variable name and length it should read. A
 * module-level handoff beats threading a bank of megabytes through every
 * emitter signature to reach one of them.
 *
 * Cleared when a build has no samples, so a stale bank from a previous
 * generate cannot make a sample-free patch reference an array that is no
 * longer emitted.
 */
let SAMPLE_INFO: ReadonlyMap<string, { varName: string; frames: number; sampleRate: number }> | null =
  null

export function setSampleInfo(
  m: ReadonlyMap<string, { varName: string; frames: number; sampleRate: number }> | null
): void {
  SAMPLE_INFO = m
}

export function sampleInfoOf(
  nodeId: string
): { varName: string; frames: number; sampleRate: number } | null {
  return SAMPLE_INFO?.get(nodeId) ?? null
}
