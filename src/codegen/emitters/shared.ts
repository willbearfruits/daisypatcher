import type { AudioGraph, NodeInstance } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import { NODE_DEFINITIONS } from '@/nodes/definitions'


export interface EmitContext {
  node: NodeInstance
  graph: AudioGraph
  /** Parallel hardware layout — used by hardware I/O emitters to resolve pin bindings. */
  hardware?: HardwareLayout
  /** Canonical C++ identifier for a given node (used for members AND outputs). */
  varName: (nodeId: string) => string
  /** Expression for an input socket: upstream output var, or `defaultExpr`. */
  inputExpr: (nodeId: string, socketId: string, defaultExpr?: string) => string
  /** Canonical output var name for a node's output socket. */
  outputVar: (nodeId: string, socketId: string) => string
  /** Push a warning to the generator's warning list. */
  warn: (msg: string) => void
}

export interface NodeEmitter {
  declare: (ctx: EmitContext) => string
  init: (ctx: EmitContext) => string
  process: (ctx: EmitContext) => string
  /**
   * Optional main-loop hook. Emitted inside main()'s `while(1)` — never
   * inside AudioCallback. Use for peripherals whose update is too slow /
   * blocking for the audio thread (OLED refresh over I2C). Code runs every
   * loop pass; throttle inside the emitted block (e.g. `System::GetNow()`).
   */
  loop?: (ctx: EmitContext) => string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Params something else drives at runtime, keyed `${nodeId}|${paramId}` and
 * valued with the C++ global that holds the live value.
 *
 * Emitters bake params in as float literals, which is right for everything
 * except a param a menu leaf targets. Routing `numParam` through this map is
 * a two-line hook that gives every numeric param on every node live control,
 * instead of threading a context argument through three thousand lines.
 *
 * Deliberately module-level and deliberately reset by the caller around each
 * emitter call: `declare` runs with it cleared, because a param used to size
 * a buffer at file scope must stay a compile-time constant. See
 * `withParamOverrides()` in the target backends.
 */
let PARAM_OVERRIDES: ReadonlyMap<string, string> | null = null

export function setParamOverrides(m: ReadonlyMap<string, string> | null): void {
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

/** Numeric param with clamp and float literal formatting. */
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

/** "0.5f" style float literal — robust for C++ parsing. */
export function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return '0.f'
  if (Number.isInteger(v)) return `${v}.f`
  // Avoid scientific notation on small numbers.
  let s = v.toPrecision(9)
  if (s.includes('e') || s.includes('E')) s = v.toFixed(9)
  // Trim trailing zeros after decimal but keep at least one digit.
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0')
  return `${s}f`
}

/** Empty emitter that declares/inits nothing. Used for pure I/O and stubs. */
export const NOOP = {
  declare: () => '',
  init: () => '',
  process: () => ''
}

/** Pass-through: first input -> first output. Used for stubs. */
export function makePassthrough(reason: string): NodeEmitter {
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
