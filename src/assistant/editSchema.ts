/**
 * The assistant's output format: graph edits, never code.
 *
 * THIS IS THE SAFETY BOUNDARY AND IT IS THE WHOLE POINT OF THE FEATURE.
 *
 * The obvious way to build an LLM feature in a codegen tool is to have the
 * model write C++. That would be worse in every way that matters here. It
 * would bypass the node catalog, so the emulator could not preview it; it
 * would bypass `test:audio`, so nothing would check the app and the device
 * agree; it would bypass the type system, so failures would surface as
 * compiler errors about generated code the user never wrote; and it would
 * be unreviewable — a wall of DSP is not something you can glance at and
 * approve.
 *
 * So the model emits a small, closed set of operations over the graph the
 * user already has. Every one is validated against `NODE_DEFINITIONS`
 * BEFORE anything is applied: a node kind that does not exist, a param that
 * is not on that node, a cable between mismatched signal kinds — all
 * rejected with a reason, and the whole batch is rejected together. A patch
 * is a connected thing; half-applying an edit list leaves you worse off
 * than not applying it.
 *
 * The result is that the worst case is a bad patch you can undo, rather
 * than firmware you cannot read.
 */

import type { AudioGraph, NodeKind } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'

/**
 * One operation.
 *
 * `ref` is the model's own name for a node it is creating — a local alias,
 * not a real id, so it can wire up nodes in the same batch it creates them.
 * Existing nodes are addressed by their real id. Keeping those separate
 * means a hallucinated id can never silently resolve to a real node.
 */
export type GraphEdit =
  | { op: 'add_node'; ref: string; kind: string; x?: number; y?: number; params?: Record<string, unknown> }
  | { op: 'remove_node'; id: string }
  | { op: 'set_param'; id: string; param: string; value: number | string }
  | { op: 'connect'; from: string; fromSocket: string; to: string; toSocket: string }
  | { op: 'disconnect'; from: string; fromSocket: string; to: string; toSocket: string }

export interface EditPlan {
  /** One sentence for the user, from the model. */
  summary: string
  edits: GraphEdit[]
}

export interface ValidationResult {
  ok: boolean
  /** Human-readable problems. Non-empty exactly when `ok` is false. */
  errors: string[]
  /** Things worth saying but not worth rejecting over. */
  warnings: string[]
}

/** Parse the model's reply. Tolerant of prose and code fences around the JSON. */
export function parseEditPlan(raw: string): EditPlan | { error: string } {
  let text = raw.trim()

  // Models wrap JSON in ```json fences roughly half the time regardless of
  // instructions. Stripping them here is cheaper than fighting it in the
  // prompt and failing on the times it loses.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()

  // A reply that opens with a sentence and then gives JSON is common enough
  // to be worth recovering from.
  if (!text.startsWith('{')) {
    const brace = text.indexOf('{')
    if (brace >= 0) text = text.slice(brace)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { error: `the reply was not valid JSON: ${(err as Error).message}` }
  }

  if (!parsed || typeof parsed !== 'object') return { error: 'the reply was not an object' }
  const o = parsed as Record<string, unknown>
  if (!Array.isArray(o.edits)) return { error: 'the reply had no `edits` array' }

  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    edits: o.edits as GraphEdit[]
  }
}

const OPS = new Set(['add_node', 'remove_node', 'set_param', 'connect', 'disconnect'])

/**
 * Check a plan against the graph it would be applied to.
 *
 * Simulates the edits so that later operations are checked against the
 * state earlier ones would produce — otherwise "add a filter, then wire it"
 * would fail validation on the wire, and the model would be blamed for
 * something it got right.
 */
export function validatePlan(plan: EditPlan, graph: AudioGraph): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  /** Node kind by id or ref, including nodes this plan creates. */
  const kindOf = new Map<string, string>()
  for (const n of graph.nodes) kindOf.set(n.id, n.kind)
  const removed = new Set<string>()

  const socketExists = (nodeKey: string, socketId: string, dir: 'in' | 'out'): boolean => {
    const kind = kindOf.get(nodeKey)
    if (!kind) return false
    const def = NODE_DEFINITIONS[kind as NodeKind]
    if (!def) return false
    const list = dir === 'in' ? def.inputs : def.outputs
    return list.some((s) => s.id === socketId)
  }

  const signalOf = (nodeKey: string, socketId: string, dir: 'in' | 'out'): string | null => {
    const kind = kindOf.get(nodeKey)
    if (!kind) return null
    const def = NODE_DEFINITIONS[kind as NodeKind]
    if (!def) return null
    const list = dir === 'in' ? def.inputs : def.outputs
    return list.find((s) => s.id === socketId)?.signal ?? null
  }

  plan.edits.forEach((e, i) => {
    const at = `edit ${i + 1}`
    if (!e || typeof e !== 'object' || !OPS.has((e as GraphEdit).op)) {
      errors.push(`${at}: not a recognised operation`)
      return
    }

    switch (e.op) {
      case 'add_node': {
        if (!e.ref || typeof e.ref !== 'string') {
          errors.push(`${at}: add_node needs a \`ref\` to refer to it by`)
          return
        }
        if (kindOf.has(e.ref)) {
          errors.push(`${at}: \`${e.ref}\` is already used by another node`)
          return
        }
        if (!NODE_DEFINITIONS[e.kind as NodeKind]) {
          errors.push(`${at}: there is no node kind "${e.kind}"`)
          return
        }
        // Params are checked but a bad one is dropped rather than fatal:
        // the node is still worth creating, and the user can see the warning.
        const def = NODE_DEFINITIONS[e.kind as NodeKind]
        for (const [k, v] of Object.entries(e.params ?? {})) {
          const p = def.params.find((q) => q.id === k)
          if (!p) {
            warnings.push(`${at}: ${e.kind} has no param "${k}" — ignored`)
            continue
          }
          if (p.kind === 'number' && typeof v !== 'number') {
            warnings.push(`${at}: ${e.kind}.${k} expects a number — ignored`)
          } else if (p.kind === 'enum' && typeof v !== 'string') {
            warnings.push(`${at}: ${e.kind}.${k} expects one of its options — ignored`)
          }
        }
        kindOf.set(e.ref, e.kind)
        break
      }

      case 'remove_node': {
        if (!kindOf.has(e.id) || removed.has(e.id)) {
          errors.push(`${at}: no node "${e.id}" to remove`)
          return
        }
        removed.add(e.id)
        break
      }

      case 'set_param': {
        const kind = kindOf.get(e.id)
        if (!kind || removed.has(e.id)) {
          errors.push(`${at}: no node "${e.id}"`)
          return
        }
        const def = NODE_DEFINITIONS[kind as NodeKind]
        const p = def?.params.find((q) => q.id === e.param)
        if (!p) {
          errors.push(`${at}: ${kind} has no param "${e.param}"`)
          return
        }
        if (p.kind === 'number') {
          if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
            errors.push(`${at}: ${kind}.${e.param} needs a number`)
          } else if (
            (typeof p.min === 'number' && e.value < p.min) ||
            (typeof p.max === 'number' && e.value > p.max)
          ) {
            // Clamped on apply rather than rejected — the intent is clear
            // and refusing the whole plan over a range would be pedantic.
            warnings.push(
              `${at}: ${kind}.${e.param} = ${e.value} is outside ${p.min}..${p.max}; clamped`
            )
          }
        } else if (typeof e.value !== 'string') {
          errors.push(`${at}: ${kind}.${e.param} needs one of its options`)
        } else if (p.options && !p.options.some((o) => o.value === e.value)) {
          errors.push(
            `${at}: "${e.value}" is not an option for ${kind}.${e.param} ` +
              `(${p.options.map((o) => o.value).join(', ')})`
          )
        }
        break
      }

      case 'connect':
      case 'disconnect': {
        if (!kindOf.has(e.from) || removed.has(e.from)) {
          errors.push(`${at}: no node "${e.from}"`)
          return
        }
        if (!kindOf.has(e.to) || removed.has(e.to)) {
          errors.push(`${at}: no node "${e.to}"`)
          return
        }
        if (!socketExists(e.from, e.fromSocket, 'out')) {
          errors.push(`${at}: ${kindOf.get(e.from)} has no output "${e.fromSocket}"`)
          return
        }
        if (!socketExists(e.to, e.toSocket, 'in')) {
          errors.push(`${at}: ${kindOf.get(e.to)} has no input "${e.toSocket}"`)
          return
        }
        if (e.op === 'connect') {
          const a = signalOf(e.from, e.fromSocket, 'out')
          const b = signalOf(e.to, e.toSocket, 'in')
          if (a && b && a !== b) {
            // The connection plugin would refuse this in the editor too;
            // catching it here means the user sees why instead of watching
            // a cable fail to attach.
            errors.push(
              `${at}: cannot connect a ${a} output to a ${b} input ` +
                `(${kindOf.get(e.from)}.${e.fromSocket} -> ${kindOf.get(e.to)}.${e.toSocket})`
            )
          }
        }
        break
      }
    }
  })

  return { ok: errors.length === 0, errors, warnings }
}

/** A short, readable rendering of a plan, for the confirmation step. */
export function describePlan(plan: EditPlan, graph: AudioGraph): string[] {
  const nameOf = new Map<string, string>()
  for (const n of graph.nodes) nameOf.set(n.id, NODE_DEFINITIONS[n.kind]?.label ?? n.kind)
  for (const e of plan.edits) {
    if (e.op === 'add_node') nameOf.set(e.ref, NODE_DEFINITIONS[e.kind as NodeKind]?.label ?? e.kind)
  }
  const label = (k: string): string => nameOf.get(k) ?? k

  return plan.edits.map((e) => {
    switch (e.op) {
      case 'add_node':
        return `add ${label(e.ref)}`
      case 'remove_node':
        return `remove ${label(e.id)}`
      case 'set_param':
        return `${label(e.id)}: ${e.param} = ${e.value}`
      case 'connect':
        return `wire ${label(e.from)}.${e.fromSocket} -> ${label(e.to)}.${e.toSocket}`
      case 'disconnect':
        return `unwire ${label(e.from)}.${e.fromSocket} -> ${label(e.to)}.${e.toSocket}`
      default:
        return 'unknown edit'
    }
  })
}
