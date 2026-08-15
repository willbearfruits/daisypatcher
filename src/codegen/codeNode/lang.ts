/**
 * The little language the `code` node is written in.
 *
 * WHY A LANGUAGE AND NOT JUST C++: the code node has to run in the emulator
 * as well as on the device, or it stops being a node — you would lose the
 * one thing that makes this app worth using, which is hearing the patch
 * before you flash it. Raw C++ cannot run in a browser, and the built app's
 * CSP forbids `eval`, so a user-authored worklet cannot be compiled at
 * runtime either.
 *
 * So: parse once here, on the main thread, into an AST. The AST goes two
 * ways — `toCpp.ts` turns it into firmware, and the `code` worklet compiles
 * it into a tree of closures it can run per sample without eval. One source
 * of truth, two backends, and the same semantics on both by construction.
 *
 * The dialect is C-shaped on purpose. Anyone writing DSP for a Daisy is
 * already reading C++, and a novel syntax would be one more thing to learn
 * for no benefit. What it deliberately does NOT have: loops, pointers,
 * arrays, function definitions, strings. Every one of those is either
 * unbounded (a `while` in an audio callback is a dropout waiting to happen)
 * or needs memory management that a node body has no business doing.
 *
 * ```
 *   state float phase = 0;      // persists between samples
 *   float inc = p1 / sr;        // local, per sample
 *   phase = phase + inc;
 *   if (phase > 1) { phase = phase - 1; }
 *   out = sin(phase * 2 * PI) * a;
 * ```
 */

/* ---------------------------------------------------------------- AST -- */

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; op: '-' | '+' | '!'; arg: Expr }
  | { kind: 'bin'; op: BinOp; lhs: Expr; rhs: Expr }
  | { kind: 'cond'; cond: Expr; a: Expr; b: Expr }
  | { kind: 'call'; fn: string; args: Expr[] }

export type BinOp =
  | '+' | '-' | '*' | '/' | '%'
  | '<' | '>' | '<=' | '>=' | '==' | '!='
  | '&&' | '||'

export type Stmt =
  | { kind: 'declare'; state: boolean; name: string; init: Expr }
  | { kind: 'assign'; name: string; value: Expr }
  | { kind: 'if'; cond: Expr; then: Stmt[]; otherwise: Stmt[] | null }

export interface Program {
  body: Stmt[]
  /** `state` declarations, hoisted — they become persistent storage. */
  state: { name: string; init: Expr }[]
}

/* ---------------------------------------------------- names + builtins -- */

/**
 * Input sockets. Fixed at four rather than user-declared, and that is a
 * deliberate limit: sockets live on the node DEFINITION, which is per-kind
 * and shared by every instance, so per-instance sockets would mean
 * threading an instance-specific definition through the editor, the engine,
 * the connection index and both emitters. Four in and two out covers the
 * overwhelming majority of what a node body wants, at a fraction of the
 * cost — and an unconnected input reads 0, so unused ones are free.
 */
export const CODE_INPUTS = ['a', 'b', 'c', 'd'] as const
export const CODE_OUTPUTS = ['out', 'out2'] as const
export const CODE_PARAMS = ['p1', 'p2', 'p3', 'p4'] as const

/** Read-only values the body can reference. */
export const CODE_READONLY = new Set<string>([
  ...CODE_INPUTS,
  ...CODE_PARAMS,
  'sr', // sample rate
  'PI',
  'E'
])

/** Whitelisted maths, with arity. Everything here exists on both targets. */
export const CODE_FUNCS: Record<string, [number, number]> = {
  sin: [1, 1], cos: [1, 1], tan: [1, 1], tanh: [1, 1],
  abs: [1, 1], sqrt: [1, 1], exp: [1, 1], log: [1, 1],
  floor: [1, 1], ceil: [1, 1], round: [1, 1], sign: [1, 1],
  min: [2, 2], max: [2, 2], pow: [2, 2], fmod: [2, 2],
  clamp: [3, 3]
}

const KEYWORDS = new Set(['state', 'float', 'if', 'else'])

/** Guard against a body big enough to blow the audio budget. */
const MAX_STATEMENTS = 400
const MAX_DEPTH = 12

export class CodeError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(`line ${line}:${col} — ${message}`)
  }
}

/* --------------------------------------------------------- tokenizer -- */

type Tok = {
  t: 'num' | 'id' | 'punct' | 'eof'
  v: string
  line: number
  col: number
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  let line = 1
  let col = 1
  const push = (t: Tok['t'], v: string, l: number, c: number) => out.push({ t, v, line: l, col: c })

  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      i++
      line++
      col = 1
      continue
    }
    if (/\s/.test(c)) {
      i++
      col++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++
          col = 1
        }
        i++
      }
      i += 2
      continue
    }
    const startLine = line
    const startCol = col
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      // Exponent, so 1e-3 is one token rather than three.
      if (/[eE]/.test(src[j] ?? '')) {
        j++
        if (/[+-]/.test(src[j] ?? '')) j++
        while (j < src.length && /[0-9]/.test(src[j])) j++
      }
      // Trailing `f` is allowed so C++ habits do not trip people up.
      if (/[fF]/.test(src[j] ?? '')) j++
      const text = src.slice(i, j).replace(/[fF]$/, '')
      push('num', text, startLine, startCol)
      col += j - i
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      push('id', src.slice(i, j), startLine, startCol)
      col += j - i
      i = j
      continue
    }
    const two = src.slice(i, i + 2)
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      push('punct', two, startLine, startCol)
      i += 2
      col += 2
      continue
    }
    if ('+-*/%<>!=(){};,?:'.includes(c)) {
      push('punct', c, startLine, startCol)
      i++
      col++
      continue
    }
    throw new CodeError(`unexpected character '${c}'`, line, col)
  }
  push('eof', '', line, col)
  return out
}

/* ------------------------------------------------------------ parser -- */

class Parser {
  private i = 0
  private declared = new Set<string>()
  private stateDecls: { name: string; init: Expr }[] = []
  private stmtCount = 0

  constructor(private toks: Tok[]) {}

  parse(): Program {
    const body = this.block(0, true)
    this.expect('eof')
    return { body, state: this.stateDecls }
  }

  /* -- helpers -- */
  private peek(): Tok {
    return this.toks[this.i]
  }
  private next(): Tok {
    return this.toks[this.i++]
  }
  private at(v: string): boolean {
    const t = this.peek()
    return (t.t === 'punct' || t.t === 'id') && t.v === v
  }
  private eat(v: string): boolean {
    if (this.at(v)) {
      this.i++
      return true
    }
    return false
  }
  private expect(v: string): Tok {
    const t = this.peek()
    if (t.t === 'eof' && v === 'eof') return this.next()
    if (!this.at(v)) throw new CodeError(`expected '${v}' but found '${t.v || 'end of input'}'`, t.line, t.col)
    return this.next()
  }
  private err(msg: string): never {
    const t = this.peek()
    throw new CodeError(msg, t.line, t.col)
  }

  /* -- statements -- */
  private block(depth: number, top = false): Stmt[] {
    if (depth > MAX_DEPTH) this.err('nested too deeply')
    const out: Stmt[] = []
    while (true) {
      const t = this.peek()
      if (t.t === 'eof') {
        if (top) break
        this.err("expected '}'")
      }
      if (!top && this.at('}')) break
      out.push(this.statement(depth))
      if (++this.stmtCount > MAX_STATEMENTS) {
        this.err(`too many statements (limit ${MAX_STATEMENTS}) — this runs once per sample`)
      }
    }
    return out
  }

  private statement(depth: number): Stmt {
    if (this.at('if')) return this.ifStatement(depth)

    // `state float x = ...;` / `float x = ...;`
    const isState = this.at('state')
    if (isState) this.next()
    if (this.at('float')) {
      this.next()
      const nameTok = this.next()
      if (nameTok.t !== 'id') throw new CodeError('expected a variable name', nameTok.line, nameTok.col)
      const name = nameTok.v
      if (KEYWORDS.has(name)) throw new CodeError(`'${name}' is a keyword`, nameTok.line, nameTok.col)
      if (CODE_READONLY.has(name)) {
        throw new CodeError(`'${name}' is a built-in and cannot be declared`, nameTok.line, nameTok.col)
      }
      if ((CODE_OUTPUTS as readonly string[]).includes(name)) {
        throw new CodeError(`'${name}' is an output; assign to it without declaring`, nameTok.line, nameTok.col)
      }
      if (this.declared.has(name)) {
        throw new CodeError(`'${name}' is already declared`, nameTok.line, nameTok.col)
      }
      this.expect('=')
      const init = this.expression(0)
      this.expect(';')
      this.declared.add(name)
      if (isState) {
        /*
         * A `state` initialiser has to be a constant. It runs once, at init,
         * where no input has a value yet — allowing `a` there would read as
         * "seed from the input" and silently mean "seed from zero".
         */
        if (!isConstant(init)) {
          throw new CodeError(
            'a state initialiser must be a constant — it runs once, before any input exists',
            nameTok.line,
            nameTok.col
          )
        }
        this.stateDecls.push({ name, init })
        return { kind: 'assign', name, value: { kind: 'var', name } } // no-op placeholder
      }
      return { kind: 'declare', state: false, name, init }
    }
    if (isState) this.err("expected 'float' after 'state'")

    // assignment
    const t = this.next()
    if (t.t !== 'id') throw new CodeError(`unexpected '${t.v || 'end of input'}'`, t.line, t.col)
    if (CODE_READONLY.has(t.v)) {
      throw new CodeError(`'${t.v}' is read-only`, t.line, t.col)
    }
    if (!this.declared.has(t.v) && !(CODE_OUTPUTS as readonly string[]).includes(t.v)) {
      throw new CodeError(`'${t.v}' is not declared`, t.line, t.col)
    }
    this.expect('=')
    const value = this.expression(0)
    this.expect(';')
    return { kind: 'assign', name: t.v, value }
  }

  private ifStatement(depth: number): Stmt {
    this.expect('if')
    this.expect('(')
    const cond = this.expression(0)
    this.expect(')')
    this.expect('{')
    const then = this.block(depth + 1)
    this.expect('}')
    let otherwise: Stmt[] | null = null
    if (this.eat('else')) {
      if (this.at('if')) {
        otherwise = [this.ifStatement(depth + 1)]
      } else {
        this.expect('{')
        otherwise = this.block(depth + 1)
        this.expect('}')
      }
    }
    return { kind: 'if', cond, then, otherwise }
  }

  /* -- expressions, precedence climbing -- */
  private expression(depth: number): Expr {
    if (depth > MAX_DEPTH) this.err('expression nested too deeply')
    return this.ternary(depth)
  }

  private ternary(depth: number): Expr {
    const cond = this.binary(0, depth)
    if (this.eat('?')) {
      const a = this.expression(depth + 1)
      this.expect(':')
      const b = this.expression(depth + 1)
      return { kind: 'cond', cond, a, b }
    }
    return cond
  }

  private binary(minPrec: number, depth: number): Expr {
    let lhs = this.unary(depth)
    while (true) {
      const t = this.peek()
      if (t.t !== 'punct') break
      const prec = PRECEDENCE[t.v]
      if (prec === undefined || prec < minPrec) break
      this.next()
      const rhs = this.binary(prec + 1, depth + 1)
      lhs = { kind: 'bin', op: t.v as BinOp, lhs, rhs }
    }
    return lhs
  }

  private unary(depth: number): Expr {
    const t = this.peek()
    if (t.t === 'punct' && (t.v === '-' || t.v === '+' || t.v === '!')) {
      this.next()
      return { kind: 'unary', op: t.v as '-' | '+' | '!', arg: this.unary(depth + 1) }
    }
    return this.primary(depth)
  }

  private primary(depth: number): Expr {
    const t = this.next()
    if (t.t === 'num') return { kind: 'num', value: Number(t.v) }
    if (t.t === 'punct' && t.v === '(') {
      const e = this.expression(depth + 1)
      this.expect(')')
      return e
    }
    if (t.t === 'id') {
      if (this.at('(')) {
        const arity = CODE_FUNCS[t.v]
        if (!arity) throw new CodeError(`unknown function '${t.v}'`, t.line, t.col)
        this.expect('(')
        const args: Expr[] = []
        if (!this.at(')')) {
          do {
            args.push(this.expression(depth + 1))
          } while (this.eat(','))
        }
        this.expect(')')
        if (args.length < arity[0] || args.length > arity[1]) {
          const want = arity[0] === arity[1] ? `${arity[0]}` : `${arity[0]}..${arity[1]}`
          throw new CodeError(`${t.v}() takes ${want} argument(s), got ${args.length}`, t.line, t.col)
        }
        return { kind: 'call', fn: t.v, args }
      }
      if (CODE_READONLY.has(t.v) || this.declared.has(t.v) || (CODE_OUTPUTS as readonly string[]).includes(t.v)) {
        return { kind: 'var', name: t.v }
      }
      throw new CodeError(`'${t.v}' is not declared`, t.line, t.col)
    }
    throw new CodeError(`unexpected '${t.v || 'end of input'}'`, t.line, t.col)
  }
}

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6
}

/** Can this expression be evaluated with no inputs? */
function isConstant(e: Expr): boolean {
  switch (e.kind) {
    case 'num':
      return true
    case 'var':
      return e.name === 'PI' || e.name === 'E'
    case 'unary':
      return isConstant(e.arg)
    case 'bin':
      return isConstant(e.lhs) && isConstant(e.rhs)
    case 'cond':
      return isConstant(e.cond) && isConstant(e.a) && isConstant(e.b)
    case 'call':
      return e.args.every(isConstant)
  }
}

export function parseCode(src: string): Program {
  return new Parser(tokenize(src)).parse()
}

/** Parse, returning the error instead of throwing. For live UI feedback. */
export function tryParseCode(src: string): { program: Program } | { error: CodeError } {
  try {
    return { program: parseCode(src) }
  } catch (err) {
    if (err instanceof CodeError) return { error: err }
    return { error: new CodeError((err as Error).message, 1, 1) }
  }
}

/** Which outputs the body actually writes. Unwritten ones emit silence. */
export function writtenOutputs(p: Program): Set<string> {
  const out = new Set<string>()
  const walk = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      if (s.kind === 'assign' && (CODE_OUTPUTS as readonly string[]).includes(s.name)) out.add(s.name)
      else if (s.kind === 'if') {
        walk(s.then)
        if (s.otherwise) walk(s.otherwise)
      }
    }
  }
  walk(p.body)
  return out
}

/** The default body, which is also the tutorial. */
export const CODE_DEFAULT_SOURCE = `// Inputs a b c d · params p1..p4 · outputs out out2
// 'state' persists between samples; 'sr' is the sample rate.
// Try patching something into 'a'.

state float phase = 0;

float freq = 40 + p1 * 400;
phase = phase + freq / sr;
if (phase > 1) { phase = phase - 1; }

out = sin(phase * 2 * PI) * p2 + a;
`
