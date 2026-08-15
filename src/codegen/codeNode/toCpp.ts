/**
 * Code node → C++.
 *
 * One of the two backends behind `lang.ts`; the other is the closure
 * compiler inside `code.worklet.ts`. Both walk the same AST, which is the
 * only reason the emulator and the device can be trusted to agree — there
 * is no second parse and no second set of semantics to drift.
 *
 * Target-neutral. The generated fragment uses `sinf`/`fmaxf`-style calls
 * and nothing else, so it drops into the Daisy and ESP32 emitters
 * unchanged. Both already include `<cmath>`/`<math.h>`.
 */

import type { BinOp, Expr, Program, Stmt } from './lang'
import { CODE_INPUTS, CODE_OUTPUTS, CODE_PARAMS } from './lang'

/** How a name in the source resolves to something in the generated file. */
export interface CppNames {
  /** Input socket id -> the upstream C++ expression (or a literal). */
  input: (socket: string) => string
  /** Param id -> C++ expression. */
  param: (id: string) => string
  /** Output socket id -> the C++ variable to assign. */
  output: (socket: string) => string
  /** Prefix for this node's persistent state, so two code nodes never clash. */
  statePrefix: string
  /** Expression yielding the sample rate. */
  sampleRate: string
}

/** float literal that always parses as a float, never an int. */
function f(v: number): string {
  if (!Number.isFinite(v)) return '0.f'
  if (Number.isInteger(v)) return `${v}.f`
  let s = v.toPrecision(9)
  if (s.includes('e') || s.includes('E')) s = v.toFixed(9)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0')
  return `${s}f`
}

/** C++ spelling of each whitelisted function. */
const FN: Record<string, (a: string[]) => string> = {
  sin: (a) => `sinf(${a[0]})`,
  cos: (a) => `cosf(${a[0]})`,
  tan: (a) => `tanf(${a[0]})`,
  tanh: (a) => `tanhf(${a[0]})`,
  abs: (a) => `fabsf(${a[0]})`,
  sqrt: (a) => `sqrtf(fmaxf(0.f, ${a[0]}))`,
  exp: (a) => `expf(${a[0]})`,
  // Guarded: log(0) is -inf and one inf in an audio buffer is a click on
  // every speaker downstream. The emulator guards identically.
  log: (a) => `logf(fmaxf(1e-9f, ${a[0]}))`,
  floor: (a) => `floorf(${a[0]})`,
  ceil: (a) => `ceilf(${a[0]})`,
  round: (a) => `roundf(${a[0]})`,
  sign: (a) => `((${a[0]}) < 0.f ? -1.f : ((${a[0]}) > 0.f ? 1.f : 0.f))`,
  min: (a) => `fminf(${a[0]}, ${a[1]})`,
  max: (a) => `fmaxf(${a[0]}, ${a[1]})`,
  pow: (a) => `powf(${a[0]}, ${a[1]})`,
  fmod: (a) => `fmodf(${a[0]}, ${a[1]})`,
  clamp: (a) => `fminf(fmaxf(${a[0]}, ${a[1]}), ${a[2]})`
}

const BIN: Record<BinOp, (l: string, r: string) => string> = {
  '+': (l, r) => `(${l} + ${r})`,
  '-': (l, r) => `(${l} - ${r})`,
  '*': (l, r) => `(${l} * ${r})`,
  // Division and modulo are guarded rather than trusted. A zero denominator
  // in an audio callback produces inf/NaN that propagates through every
  // downstream node for the rest of the session.
  '/': (l, r) => `dp_code_div(${l}, ${r})`,
  '%': (l, r) => `dp_code_mod(${l}, ${r})`,
  '<': (l, r) => `((${l} < ${r}) ? 1.f : 0.f)`,
  '>': (l, r) => `((${l} > ${r}) ? 1.f : 0.f)`,
  '<=': (l, r) => `((${l} <= ${r}) ? 1.f : 0.f)`,
  '>=': (l, r) => `((${l} >= ${r}) ? 1.f : 0.f)`,
  '==': (l, r) => `((${l} == ${r}) ? 1.f : 0.f)`,
  '!=': (l, r) => `((${l} != ${r}) ? 1.f : 0.f)`,
  '&&': (l, r) => `(((${l}) != 0.f && (${r}) != 0.f) ? 1.f : 0.f)`,
  '||': (l, r) => `(((${l}) != 0.f || (${r}) != 0.f) ? 1.f : 0.f)`
}

/**
 * Shared helpers, emitted once per project.
 *
 * Include-guarded so any number of code nodes can emit it.
 */
export const CODE_RUNTIME_CPP = `#ifndef DP_CODE_RUNTIME
#define DP_CODE_RUNTIME 1
/**
 * Guarded division and modulo for code-node bodies.
 *
 * A divide by zero here is not a crash, it is worse: inf or NaN enters the
 * audio buffer and every node downstream of it stays poisoned for the rest
 * of the session. Returning 0 keeps a mistake local and audible as silence
 * rather than as a dead output.
 */
static inline float dp_code_div(float a, float b) {
    return (b > -1e-12f && b < 1e-12f) ? 0.f : a / b;
}
static inline float dp_code_mod(float a, float b) {
    return (b > -1e-12f && b < 1e-12f) ? 0.f : fmodf(a, b);
}
#endif // DP_CODE_RUNTIME
`

function expr(e: Expr, n: CppNames): string {
  switch (e.kind) {
    case 'num':
      return f(e.value)
    case 'var': {
      if (e.name === 'PI') return '3.14159265358979323846f'
      if (e.name === 'E') return '2.71828182845904523536f'
      if (e.name === 'sr') return n.sampleRate
      if ((CODE_INPUTS as readonly string[]).includes(e.name)) return `(${n.input(e.name)})`
      if ((CODE_PARAMS as readonly string[]).includes(e.name)) return `(${n.param(e.name)})`
      if ((CODE_OUTPUTS as readonly string[]).includes(e.name)) return n.output(e.name)
      // Locals and state both resolve to plain C++ identifiers; the prefix
      // is what keeps two code nodes in one patch from colliding.
      return `${n.statePrefix}${e.name}`
    }
    case 'unary':
      if (e.op === '!') return `(((${expr(e.arg, n)}) == 0.f) ? 1.f : 0.f)`
      return `(${e.op}${expr(e.arg, n)})`
    case 'bin':
      return BIN[e.op](expr(e.lhs, n), expr(e.rhs, n))
    case 'cond':
      return `(((${expr(e.cond, n)}) != 0.f) ? (${expr(e.a, n)}) : (${expr(e.b, n)}))`
    case 'call':
      return FN[e.fn](e.args.map((a) => expr(a, n)))
  }
}

function stmts(list: Stmt[], n: CppNames, indent: string, stateNames: Set<string>): string[] {
  const out: string[] = []
  for (const s of list) {
    if (s.kind === 'declare') {
      out.push(`${indent}float ${n.statePrefix}${s.name} = ${expr(s.init, n)};`)
    } else if (s.kind === 'assign') {
      // The parser leaves a self-assignment placeholder where a `state`
      // declaration was, since its storage is hoisted to file scope.
      if (stateNames.has(s.name) && s.value.kind === 'var' && s.value.name === s.name) continue
      const target = (CODE_OUTPUTS as readonly string[]).includes(s.name)
        ? n.output(s.name)
        : `${n.statePrefix}${s.name}`
      out.push(`${indent}${target} = ${expr(s.value, n)};`)
    } else {
      out.push(`${indent}if ((${expr(s.cond, n)}) != 0.f) {`)
      out.push(...stmts(s.then, n, indent + '    ', stateNames))
      if (s.otherwise) {
        out.push(`${indent}} else {`)
        out.push(...stmts(s.otherwise, n, indent + '    ', stateNames))
      }
      out.push(`${indent}}`)
    }
  }
  return out
}

/** File-scope persistent storage for a code node's `state` variables. */
export function emitCodeState(p: Program, n: CppNames): string {
  if (p.state.length === 0) return ''
  return p.state
    .map((s) => `float ${n.statePrefix}${s.name} = ${expr(s.init, n)};`)
    .join('\n')
}

/**
 * The per-sample body.
 *
 * Outputs are declared here whatever the body does with them: a body that
 * writes only `out` still has to leave `out2` defined, or every downstream
 * node referencing it fails to compile. Unwritten means silence, which is
 * the sane reading of "I did not use that output".
 */
export function emitCodeProcess(p: Program, n: CppNames, written: Set<string>): string {
  const stateNames = new Set(p.state.map((s) => s.name))
  const lines: string[] = []
  for (const o of CODE_OUTPUTS) {
    lines.push(`    float ${n.output(o)} = 0.f;`)
  }
  lines.push('    {')
  lines.push(...stmts(p.body, n, '        ', stateNames))
  lines.push('    }')
  void written
  return lines.join('\n') + '\n'
}
