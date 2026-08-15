import {
  CODE_RUNTIME_CPP,
  emitCodeProcess,
  emitCodeState,
  type CppNames
} from '../codeNode/toCpp'
import { tryParseCode, writtenOutputs } from '../codeNode/lang'
import type { EmitContext, NodeEmitter } from '../nodeEmitters'
import { enumParam, numParam } from './shared'
import { sanitizeCString } from './visual'


/* --------------------------- expression / print --------------------------- */
//
// Expression: we keep the passthrough for this pass — porting the Daisy
// expression parser to C++ inline is a whole separate unit of work and it
// isn't a DSP node. Print is a Serial.print wrapper.

/* --------------------------- code node --------------------------- */
//
// The escape hatch. The body is parsed ONCE by `codeNode/lang.ts` and this
// walks the resulting AST; the emulator worklet walks the same AST. Neither
// side re-parses, so there is no second set of semantics to drift.
//
// A body that does not parse emits silence and a warning rather than
// failing the build: the patch is otherwise valid, and refusing to generate
// firmware because one node has a typo in it would block flashing the other
// forty nodes that are fine.

export const code: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const parsed = tryParseCode(String(ctx.node.params.source ?? ''))
    if ('error' in parsed) return ''
    const names = codeNames(ctx, v)
    const state = emitCodeState(parsed.program, names)
    return [CODE_RUNTIME_CPP, state].filter(Boolean).join('\n')
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const parsed = tryParseCode(String(ctx.node.params.source ?? ''))
    const names = codeNames(ctx, v)
    if ('error' in parsed) {
      ctx.warn(`code ${ctx.node.id}: ${parsed.error.message} — emitting silence`)
      return (
        `    // code node did not parse: ${parsed.error.message.replace(/\n/g, ' ')}\n` +
        `    float ${names.output('out')} = 0.f;\n` +
        `    float ${names.output('out2')} = 0.f;\n`
      )
    }
    return emitCodeProcess(parsed.program, names, writtenOutputs(parsed.program))
  }
}

/** Bind the language's names to this node's generated identifiers. */
function codeNames(ctx: EmitContext, v: string): CppNames {
  return {
    input: (socket) => ctx.inputExpr(ctx.node.id, socket, '0.f'),
    param: (id) => numParam(ctx.node, id, 0),
    output: (socket) => ctx.outputVar(ctx.node.id, socket),
    statePrefix: `${v}_u_`,
    sampleRate: '(float)SAMPLE_RATE'
  }
}

/* --------------------------- subpatch ports --------------------------- */
//
// These three exist for the EDITOR, not the compiler. `flattenGraph` splices
// every one of them away before a backend sees the graph — see
// state/subpatch.ts — so reaching an emitter means the node was stray: a
// port sitting at the root with no parent to carry a signal to or from.
//
// Emitting silence rather than nothing at all, because a stray port is a
// half-finished edit, not a reason to refuse to build the other forty nodes
// that are fine. `sub_out` and `subpatch` are pure sinks in that state.

export const sub_in: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    ctx.warn(
      `sub_in ${ctx.node.id}: an inlet outside a subpatch has nothing feeding it — emitting silence`
    )
    return `    float ${ctx.outputVar(ctx.node.id, 'out')} = 0.f;\n`
  }
}

export const sub_out: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    ctx.warn(`sub_out ${ctx.node.id}: an outlet outside a subpatch goes nowhere`)
    return ''
  }
}

export const subpatch: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    // Unreachable in practice: flattening removes every subpatch. If one
    // arrives, something bypassed `generateProject` and the honest thing is
    // to say so rather than emit a plausible-looking passthrough.
    ctx.warn(
      `subpatch ${ctx.node.id}: reached codegen unflattened — its body was NOT compiled`
    )
    return (
      `    float ${ctx.outputVar(ctx.node.id, 'out')} = 0.f;\n` +
      `    float ${ctx.outputVar(ctx.node.id, 'out2')} = 0.f;\n`
    )
  }
}

/*
 * Preset recall. The table and the two functions it calls live in
 * `presetCodegen.ts`; this is only the trigger logic.
 *
 * `changed` fires for one sample on a recall so downstream can react — an
 * LED flash, an envelope retrigger. Morph mode never fires it: a continuous
 * walk has no moment to mark, and a gate that is high whenever the knob
 * moves is not a trigger.
 *
 * When the patch has no presets the runtime functions are not emitted at
 * all, so this degrades to a nop rather than failing to link.
 */
export const preset_recall: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'changed')
    const mode = enumParam(ctx.node, 'mode', 'recall')
    const slot = numParam(ctx.node, 'slot', 0)
    const a = numParam(ctx.node, 'morph_a', 0)
    const b = numParam(ctx.node, 'morph_b', 1)
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const slotCv = ctx.inputExpr(ctx.node.id, 'cv_slot', '__NC__')
    const morphCv = ctx.inputExpr(ctx.node.id, 'cv_morph', '__NC__')

    if (mode === 'morph') {
      const tExpr = morphCv === '__NC__' ? '0.f' : `fmaxf(0.f, fminf(1.f, ${morphCv}))`
      return (
        `#ifdef DP_PRESET_COUNT_OK\n` +
        `    dp_preset_morph((int)(${a}), (int)(${b}), ${tExpr});\n` +
        `#endif\n` +
        `    float ${out} = 0.f;\n`
      )
    }

    const slotExpr = slotCv === '__NC__' ? `(int)(${slot})` : `(int)(${slotCv})`
    return (
      `    static float ${v}_prev = 0.f;\n` +
      `    float ${v}_t = ${trig};\n` +
      `    bool ${v}_edge = (${v}_t >= 0.5f) && (${v}_prev < 0.5f);\n` +
      `    ${v}_prev = ${v}_t;\n` +
      `#ifdef DP_PRESET_COUNT_OK\n` +
      `    if (${v}_edge) dp_preset_apply(${slotExpr});\n` +
      `#endif\n` +
      `    float ${out} = ${v}_edge ? 1.f : 0.f;\n`
    )
  }
}

export const poly: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    ctx.warn(`poly ${ctx.node.id}: reached codegen unflattened — its voices were NOT compiled`)
    return (
      `    float ${ctx.outputVar(ctx.node.id, 'out')} = 0.f;\n` +
      `    float ${ctx.outputVar(ctx.node.id, 'out2')} = 0.f;\n`
    )
  }
}

export const voice_id: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    ctx.warn(`voice_id ${ctx.node.id}: outside a poly body there is no voice to identify`)
    return (
      `    float ${ctx.outputVar(ctx.node.id, 'norm')} = 0.f;\n` +
      `    float ${ctx.outputVar(ctx.node.id, 'index')} = 0.f;\n`
    )
  }
}

export const printNode: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `uint32_t ${v}_print_ctr = 0;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const label = enumParam(ctx.node, 'label', 'value')
    const safe = sanitizeCString(label)
    // Print at ~1 Hz so we don't flood the UART at the audio rate.
    return (
      `    ${v}_print_ctr++;\n` +
      `    if (${v}_print_ctr >= (uint32_t)SAMPLE_RATE) {\n` +
      `        ${v}_print_ctr = 0;\n` +
      `        Serial.print("${safe}: "); Serial.println(${input});\n` +
      `    }\n`
    )
  }
}
