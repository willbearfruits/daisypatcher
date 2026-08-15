/**
 * The system prompt: the node catalog, as data.
 *
 * A model cannot patch with nodes it does not know exist, and it will
 * cheerfully invent a `reverb_hall` if left to guess. So the catalog is
 * generated from `NODE_DEFINITIONS` at call time rather than written by
 * hand — which also means a node added tomorrow is available to the
 * assistant with no second place to update. Every time a catalog has been
 * duplicated in this codebase it has drifted.
 *
 * The catalog is emitted in a compact line format rather than JSON. It is
 * roughly a third of the tokens for the same information, and the shape is
 * regular enough that models read it without trouble.
 *
 * TARGET FILTERING MATTERS. Suggesting a granulator on an ESP32-C3 wastes
 * everyone's turn: the support matrix already knows it will not fit, so
 * unsupported kinds are left out entirely rather than being offered and
 * then rejected at build time.
 */

import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { supportLevel } from '@/nodes/targetSupport'
import type { AudioGraph, NodeKind } from '@/types/graph'
import type { BoardTarget } from '@/types/store'

/**
 * Kinds the assistant should not offer.
 *
 * Structural kinds are edited by entering them, not by wiring — an
 * assistant that emitted a `subpatch` would produce a box with an empty
 * body and no way to have filled it. Hardware-bound kinds are excluded for
 * a different reason: dropping one silently creates a paired physical
 * component and assigns pins, which is a change to the hardware layout the
 * user did not ask a chat box to make.
 */
const EXCLUDED = new Set<string>(['subpatch', 'sub_in', 'sub_out', 'poly', 'voice_id', 'code'])

function catalogFor(target: BoardTarget): string {
  const lines: string[] = []
  for (const kind of Object.keys(NODE_DEFINITIONS) as NodeKind[]) {
    if (EXCLUDED.has(kind)) continue
    const def = NODE_DEFINITIONS[kind]
    if (!def) continue
    if (supportLevel(kind, target) === 'unsupported') continue
    if (def.category === 'hardware') continue

    const ins = def.inputs.map((s) => `${s.id}:${s.signal}`).join(' ')
    const outs = def.outputs.map((s) => `${s.id}:${s.signal}`).join(' ')
    const params = def.params
      .map((p) =>
        p.kind === 'number'
          ? `${p.id}=${p.default}[${p.min}..${p.max}]`
          : `${p.id}=${p.default}{${(p.options ?? []).map((o) => o.value).join('|')}}`
      )
      .join(' ')
    lines.push(`${kind} | in: ${ins || '-'} | out: ${outs || '-'} | params: ${params || '-'}`)
  }
  return lines.join('\n')
}

/** The graph as the model needs to see it: ids, kinds, cables. */
export function describeGraph(graph: AudioGraph): string {
  if (graph.nodes.length === 0) return '(the patch is empty)'
  const nodes = graph.nodes
    .map((n) => {
      // Only non-default params — the defaults are already in the catalog,
      // and repeating them for every node is most of the prompt for none of
      // the information.
      const def = NODE_DEFINITIONS[n.kind]
      const changed = (def?.params ?? [])
        .filter((p) => n.params[p.id] !== undefined && n.params[p.id] !== p.default)
        .map((p) => `${p.id}=${JSON.stringify(n.params[p.id])}`)
        .join(' ')
      return `  ${n.id} : ${n.kind}${changed ? ` (${changed})` : ''}`
    })
    .join('\n')
  const cables =
    graph.connections
      .map((c) => `  ${c.from.nodeId}.${c.from.socketId} -> ${c.to.nodeId}.${c.to.socketId}`)
      .join('\n') || '  (nothing wired)'
  return `NODES:\n${nodes}\n\nCABLES:\n${cables}`
}

export function systemPrompt(target: BoardTarget): string {
  return `You are a patching assistant inside Daisypatcher, a visual node editor that compiles DSP patches to firmware for the ${target} board.

You do NOT write code. You emit edits to the user's node graph. Reply with a single JSON object and nothing else:

{
  "summary": "one sentence describing what you did",
  "edits": [
    { "op": "add_node", "ref": "osc1", "kind": "oscillator", "params": { "frequency": 220 } },
    { "op": "connect", "from": "osc1", "fromSocket": "out", "to": "out1", "toSocket": "left" },
    { "op": "set_param", "id": "existing_node_id", "param": "frequency", "value": 440 },
    { "op": "remove_node", "id": "existing_node_id" },
    { "op": "disconnect", "from": "a", "fromSocket": "out", "to": "b", "toSocket": "in" }
  ]
}

RULES:
- \`ref\` is your own short name for a node you are creating in this batch. Use it to wire that node up. Existing nodes are addressed by the id shown in the patch below — never invent an id.
- Only use node kinds from the catalog. There are no others.
- A cable's two ends must have the SAME signal kind (audio, cv, gate, clock). Check the catalog before wiring.
- Sockets are named. Use the exact names from the catalog.
- Audio reaches the user's ears only through \`audio_output\`. If the patch has none and you are making sound, add one.
- Prefer editing what is already there over rebuilding it. The user keeps their patch.
- Keep it small. A handful of nodes that work beats a large patch that might.
- If the request is unclear or you cannot do it with these nodes, return an empty \`edits\` array and say why in \`summary\`.

CATALOG (kind | inputs | outputs | params):
${catalogFor(target)}`
}

export function userPrompt(graph: AudioGraph, request: string): string {
  return `CURRENT PATCH:
${describeGraph(graph)}

REQUEST:
${request}`
}
