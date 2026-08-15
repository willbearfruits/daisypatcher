import {
  CODE_RUNTIME_CPP,
  emitCodeProcess,
  emitCodeState,
  type CppNames
} from '../codeNode/toCpp'
import { tryParseCode, writtenOutputs } from '../codeNode/lang'
import type { EmitContext, NodeEmitter } from './shared'
import { enumParam, formatFloat, numParam } from './shared'


// --- Expression (mini math language) ------------------------------------

type ExprAst =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: 'a' | 'b' | 'c' | 'd' }
  | { kind: 'const'; name: 'PI' | 'E' }
  | { kind: 'unary'; op: '+' | '-'; arg: ExprAst }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '%'; lhs: ExprAst; rhs: ExprAst }
  | { kind: 'call'; fn: string; args: ExprAst[] }

const EXPR_FUNCS = new Set(['sin', 'cos', 'tan', 'abs', 'min', 'max', 'pow', 'sqrt', 'exp', 'log', 'floor', 'ceil', 'round', 'sign'])
const EXPR_FUNC_ARITY: Record<string, [number, number]> = {
  sin: [1, 1], cos: [1, 1], tan: [1, 1], abs: [1, 1],
  min: [1, 8], max: [1, 8], pow: [2, 2], sqrt: [1, 1],
  exp: [1, 1], log: [1, 1], floor: [1, 1], ceil: [1, 1],
  round: [1, 1], sign: [1, 1]
}
const EXPR_CONSTS = new Set(['PI', 'E'])
const EXPR_VARS = new Set(['a', 'b', 'c', 'd'])

class ExprParser {
  private pos = 0
  constructor(private src: string) {}
  parse(): ExprAst {
    const n = this.add()
    this.ws()
    if (this.pos < this.src.length) throw new Error(`unexpected '${this.src[this.pos]}' at ${this.pos}`)
    return n
  }
  private ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++
  }
  private peek(): string {
    this.ws()
    return this.pos < this.src.length ? this.src[this.pos] : ''
  }
  private eat(ch: string): boolean {
    this.ws()
    if (this.src[this.pos] === ch) { this.pos++; return true }
    return false
  }
  private add(): ExprAst {
    let lhs = this.mul()
    while (true) {
      const p = this.peek()
      if (p === '+' || p === '-') { this.pos++; lhs = { kind: 'bin', op: p as '+' | '-', lhs, rhs: this.mul() } }
      else break
    }
    return lhs
  }
  private mul(): ExprAst {
    let lhs = this.unary()
    while (true) {
      const p = this.peek()
      if (p === '*' || p === '/' || p === '%') { this.pos++; lhs = { kind: 'bin', op: p as '*' | '/' | '%', lhs, rhs: this.unary() } }
      else break
    }
    return lhs
  }
  private unary(): ExprAst {
    const p = this.peek()
    if (p === '+' || p === '-') { this.pos++; return { kind: 'unary', op: p as '+' | '-', arg: this.unary() } }
    return this.primary()
  }
  private primary(): ExprAst {
    this.ws()
    if (this.pos >= this.src.length) throw new Error('unexpected end of expression')
    const ch = this.src[this.pos]
    if (ch === '(') {
      this.pos++
      const inner = this.add()
      if (!this.eat(')')) throw new Error(`expected ')' at ${this.pos}`)
      return inner
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') return this.number()
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') return this.ident()
    throw new Error(`unexpected '${ch}' at ${this.pos}`)
  }
  private number(): ExprAst {
    const start = this.pos
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) this.pos++
    if (this.pos < this.src.length && (this.src[this.pos] === 'e' || this.src[this.pos] === 'E')) {
      this.pos++
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos++
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) this.pos++
    }
    const v = Number(this.src.slice(start, this.pos))
    if (!Number.isFinite(v)) throw new Error(`invalid number at ${start}`)
    return { kind: 'num', value: v }
  }
  private ident(): ExprAst {
    const start = this.pos
    while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos])) this.pos++
    const name = this.src.slice(start, this.pos)
    this.ws()
    if (this.src[this.pos] === '(') {
      this.pos++
      const args: ExprAst[] = []
      this.ws()
      if (this.src[this.pos] !== ')') {
        args.push(this.add())
        while (this.eat(',')) args.push(this.add())
      }
      if (!this.eat(')')) throw new Error(`expected ')' in call to ${name}`)
      if (!EXPR_FUNCS.has(name)) throw new Error(`unknown function '${name}'`)
      const [lo, hi] = EXPR_FUNC_ARITY[name]
      if (args.length < lo || args.length > hi) throw new Error(`'${name}' expects ${lo}..${hi} args`)
      return { kind: 'call', fn: name, args }
    }
    if (EXPR_VARS.has(name)) return { kind: 'var', name: name as 'a' | 'b' | 'c' | 'd' }
    if (EXPR_CONSTS.has(name)) return { kind: 'const', name: name as 'PI' | 'E' }
    throw new Error(`unknown identifier '${name}'`)
  }
}

/** Render AST → C++ expression string (floats throughout). */
function exprToCpp(ast: ExprAst, vars: Record<'a' | 'b' | 'c' | 'd', string>): string {
  switch (ast.kind) {
    case 'num':
      return formatFloat(ast.value)
    case 'const':
      return ast.name === 'PI' ? '(float)M_PI' : '(float)M_E'
    case 'var':
      return `(${vars[ast.name]})`
    case 'unary':
      return `(${ast.op}(${exprToCpp(ast.arg, vars)}))`
    case 'bin': {
      const l = exprToCpp(ast.lhs, vars)
      const r = exprToCpp(ast.rhs, vars)
      if (ast.op === '%') return `fmodf(${l}, ${r})`
      return `(${l} ${ast.op} ${r})`
    }
    case 'call': {
      const renderedArgs = ast.args.map((a) => exprToCpp(a, vars))
      const cppFnMap: Record<string, string> = {
        sin: 'sinf', cos: 'cosf', tan: 'tanf', abs: 'fabsf',
        pow: 'powf', sqrt: 'sqrtf', exp: 'expf', log: 'logf',
        floor: 'floorf', ceil: 'ceilf', round: 'roundf'
      }
      if (ast.fn === 'sign') {
        const x = renderedArgs[0]
        return `((${x} > 0.f) ? 1.f : ((${x} < 0.f) ? -1.f : 0.f))`
      }
      if (ast.fn === 'min' || ast.fn === 'max') {
        const fold = ast.fn === 'min' ? 'fminf' : 'fmaxf'
        return renderedArgs.reduce(
          (acc, cur) => (acc === '' ? cur : `${fold}(${acc}, ${cur})`),
          ''
        )
      }
      const cppName = cppFnMap[ast.fn]
      return `${cppName}(${renderedArgs.join(', ')})`
    }
  }
}

export const expression: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const srcRaw = ctx.node.params.expr
    const src = typeof srcRaw === 'string' ? srcRaw : 'a'
    const aExpr = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const bExpr = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    const cExpr = ctx.inputExpr(ctx.node.id, 'c', '0.f')
    const dExpr = ctx.inputExpr(ctx.node.id, 'd', '0.f')
    let ast: ExprAst
    try {
      ast = new ExprParser(src).parse()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.warn(`expression ${ctx.node.id}: parse error — ${msg}`)
      const sanitised = src.replace(/\*\//g, '* /')
      return `    // TODO: fix expression '${sanitised}': ${msg}\n    float ${out} = 0.f;\n`
    }
    const cpp = exprToCpp(ast, { a: aExpr, b: bExpr, c: cExpr, d: dExpr })
    return `    float ${out} = ${cpp};\n`
  }
}

// --- Print (debug) ------------------------------------------------------

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
    sampleRate: 'sr'
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
  declare: (ctx) => `static uint32_t ${ctx.varName(ctx.node.id)}_last_gate = 0;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const label = enumParam(ctx.node, 'label', 'val')
    const safeLabel = label.replace(/"/g, '\\"')
    const trigExpr = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const valExpr = ctx.inputExpr(ctx.node.id, 'value', '0.f')
    return (
      `    {\n` +
      `        float trigger = ${trigExpr};\n` +
      `        float value = ${valExpr};\n` +
      `        if (trigger > 0.5f && ${v}_last_gate == 0) {\n` +
      `            hw.PrintLine("%s: %f", "${safeLabel}", value);\n` +
      `        }\n` +
      `        ${v}_last_gate = (trigger > 0.5f) ? 1 : 0;\n` +
      `    }\n`
    )
  }
}
