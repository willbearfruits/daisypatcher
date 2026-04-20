/// <reference path="./worklet.d.ts" />

/**
 * Expression evaluator — maths-script lite.
 *
 * Parses a user-supplied expression string into an AST at load time
 * (and on every `expr` param change) and evaluates it per-sample with
 * the four CV inputs bound to `a`, `b`, `c`, `d`.
 *
 * Grammar (recursive-descent):
 *
 *   expr    := add
 *   add     := mul ( ('+'|'-') mul )*
 *   mul     := unary ( ('*'|'/'|'%') unary )*
 *   unary   := ('+'|'-') unary | primary
 *   primary := number | ident ( '(' arglist ')' )? | '(' expr ')'
 *   arglist := expr ( ',' expr )*
 *
 * Whitelist:
 *   vars:   a b c d
 *   consts: PI E
 *   funcs:  sin cos tan abs min max pow sqrt exp log floor ceil round sign
 *   ops:    + - * / %
 *
 * Anything else fails parsing — the processor stashes the error, posts it
 * back to the main thread for surfacing in the UI, and emits 0 per-sample
 * until a valid expression arrives.
 *
 * Registered as `'dp-expression'`.
 */

type AstNum = { kind: 'num'; value: number }
type AstVar = { kind: 'var'; name: 'a' | 'b' | 'c' | 'd' }
type AstConst = { kind: 'const'; value: number }
type AstUnary = { kind: 'unary'; op: '+' | '-'; arg: Ast }
type AstBin = { kind: 'bin'; op: '+' | '-' | '*' | '/' | '%'; lhs: Ast; rhs: Ast }
type AstCall = { kind: 'call'; fn: string; args: Ast[] }
type Ast = AstNum | AstVar | AstConst | AstUnary | AstBin | AstCall

/**
 * Each function reads its arguments from a slice of the shared CALL_STACK
 * (indices [base, base+n)). This avoids allocating a fresh args array per
 * call, which matters because `process()` is on the audio-rendering path.
 */
type FnImpl = (base: number, n: number) => number

const FUNCS: Record<string, FnImpl> = {
  sin: (b) => Math.sin(CALL_STACK[b]),
  cos: (b) => Math.cos(CALL_STACK[b]),
  tan: (b) => Math.tan(CALL_STACK[b]),
  abs: (b) => Math.abs(CALL_STACK[b]),
  min: (b, n) => {
    let m = CALL_STACK[b]
    for (let i = 1; i < n; i++) if (CALL_STACK[b + i] < m) m = CALL_STACK[b + i]
    return m
  },
  max: (b, n) => {
    let m = CALL_STACK[b]
    for (let i = 1; i < n; i++) if (CALL_STACK[b + i] > m) m = CALL_STACK[b + i]
    return m
  },
  pow: (b) => Math.pow(CALL_STACK[b], CALL_STACK[b + 1]),
  sqrt: (b) => Math.sqrt(CALL_STACK[b]),
  exp: (b) => Math.exp(CALL_STACK[b]),
  log: (b) => Math.log(CALL_STACK[b]),
  floor: (b) => Math.floor(CALL_STACK[b]),
  ceil: (b) => Math.ceil(CALL_STACK[b]),
  round: (b) => Math.round(CALL_STACK[b]),
  sign: (b) => Math.sign(CALL_STACK[b])
}

const FUNC_ARITY: Record<string, { min: number; max: number }> = {
  sin: { min: 1, max: 1 },
  cos: { min: 1, max: 1 },
  tan: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  min: { min: 1, max: 8 },
  max: { min: 1, max: 8 },
  pow: { min: 2, max: 2 },
  sqrt: { min: 1, max: 1 },
  exp: { min: 1, max: 1 },
  log: { min: 1, max: 1 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  round: { min: 1, max: 1 },
  sign: { min: 1, max: 1 }
}

const CONSTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E
}

const VARS = new Set(['a', 'b', 'c', 'd'])

class Parser {
  private pos = 0

  constructor(private src: string) {}

  parse(): Ast {
    const n = this.expr()
    this.skipWs()
    if (this.pos < this.src.length) {
      throw new Error(`unexpected character '${this.src[this.pos]}' at ${this.pos}`)
    }
    return n
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++
  }

  private peek(): string {
    this.skipWs()
    return this.pos < this.src.length ? this.src[this.pos] : ''
  }

  private eat(ch: string): boolean {
    this.skipWs()
    if (this.src[this.pos] === ch) {
      this.pos++
      return true
    }
    return false
  }

  private expr(): Ast {
    return this.add()
  }

  private add(): Ast {
    let lhs = this.mul()
    while (true) {
      const p = this.peek()
      if (p === '+' || p === '-') {
        this.pos++
        const rhs = this.mul()
        lhs = { kind: 'bin', op: p, lhs, rhs }
      } else break
    }
    return lhs
  }

  private mul(): Ast {
    let lhs = this.unary()
    while (true) {
      const p = this.peek()
      if (p === '*' || p === '/' || p === '%') {
        this.pos++
        const rhs = this.unary()
        lhs = { kind: 'bin', op: p, lhs, rhs }
      } else break
    }
    return lhs
  }

  private unary(): Ast {
    const p = this.peek()
    if (p === '+' || p === '-') {
      this.pos++
      return { kind: 'unary', op: p, arg: this.unary() }
    }
    return this.primary()
  }

  private primary(): Ast {
    this.skipWs()
    if (this.pos >= this.src.length) throw new Error('unexpected end of expression')
    const ch = this.src[this.pos]
    if (ch === '(') {
      this.pos++
      const inner = this.expr()
      if (!this.eat(')')) throw new Error(`expected ')' at ${this.pos}`)
      return inner
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      return this.number()
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      return this.identOrCall()
    }
    throw new Error(`unexpected character '${ch}' at ${this.pos}`)
  }

  private number(): AstNum {
    const start = this.pos
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) this.pos++
    // Scientific notation.
    if (this.pos < this.src.length && (this.src[this.pos] === 'e' || this.src[this.pos] === 'E')) {
      this.pos++
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos++
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) this.pos++
    }
    const raw = this.src.slice(start, this.pos)
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`invalid number '${raw}'`)
    return { kind: 'num', value }
  }

  private identOrCall(): Ast {
    const start = this.pos
    while (
      this.pos < this.src.length &&
      /[A-Za-z0-9_]/.test(this.src[this.pos])
    ) {
      this.pos++
    }
    const name = this.src.slice(start, this.pos)
    // Function call?
    this.skipWs()
    if (this.src[this.pos] === '(') {
      this.pos++
      const args: Ast[] = []
      this.skipWs()
      if (this.src[this.pos] !== ')') {
        args.push(this.expr())
        while (this.eat(',')) args.push(this.expr())
      }
      if (!this.eat(')')) throw new Error(`expected ')' in call to ${name}`)
      if (!(name in FUNCS)) throw new Error(`unknown function '${name}'`)
      const arity = FUNC_ARITY[name]
      if (args.length < arity.min || args.length > arity.max) {
        throw new Error(`'${name}' expects ${arity.min}..${arity.max} args, got ${args.length}`)
      }
      return { kind: 'call', fn: name, args }
    }
    // Variable or constant.
    if (VARS.has(name)) return { kind: 'var', name: name as 'a' | 'b' | 'c' | 'd' }
    if (name in CONSTS) return { kind: 'const', value: CONSTS[name] }
    throw new Error(`unknown identifier '${name}'`)
  }
}

// Small stack for call args. Each recursive evalAst() call that hits
// the `call` branch reserves its args at the current `top`, then
// restores `top` after the function runs. Alloc-free, and nested calls
// stack cleanly without trampling parents' frames.
const CALL_STACK_CAPACITY = 64
const CALL_STACK: number[] = new Array(CALL_STACK_CAPACITY).fill(0)
let callStackTop = 0

function evalAst(ast: Ast, a: number, b: number, c: number, d: number): number {
  switch (ast.kind) {
    case 'num':
      return ast.value
    case 'const':
      return ast.value
    case 'var':
      return ast.name === 'a' ? a : ast.name === 'b' ? b : ast.name === 'c' ? c : d
    case 'unary': {
      const v = evalAst(ast.arg, a, b, c, d)
      return ast.op === '-' ? -v : v
    }
    case 'bin': {
      const l = evalAst(ast.lhs, a, b, c, d)
      const r = evalAst(ast.rhs, a, b, c, d)
      switch (ast.op) {
        case '+':
          return l + r
        case '-':
          return l - r
        case '*':
          return l * r
        case '/':
          return r === 0 ? 0 : l / r
        case '%':
          return r === 0 ? 0 : l % r
      }
      return 0
    }
    case 'call': {
      const n = ast.args.length
      if (callStackTop + n > CALL_STACK_CAPACITY) return 0
      const base = callStackTop
      callStackTop += n
      for (let i = 0; i < n; i++) {
        CALL_STACK[base + i] = evalAst(ast.args[i], a, b, c, d)
      }
      const result = FUNCS[ast.fn](base, n)
      callStackTop = base
      return result
    }
  }
}

class ExpressionProcessor extends AudioWorkletProcessor {
  private ast: Ast | null = null

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    // Default to just passing `a` through.
    this.compile('a')
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'expr') {
        this.compile(String(data.value ?? 'a'))
      }
    }
  }

  private compile(src: string): void {
    try {
      this.ast = new Parser(src).parse()
      this.port.postMessage({ type: 'expression:ok' })
    } catch (err) {
      this.ast = null
      const message = err instanceof Error ? err.message : String(err)
      this.port.postMessage({ type: 'expression:error', message })
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const ch = output[0]
    if (!ch) return true

    const ast = this.ast
    if (!ast) {
      ch.fill(0)
      for (let c = 1; c < output.length; c++) output[c].set(ch)
      return true
    }

    const aCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const bCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const cCh = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const dCh = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    const n = ch.length
    for (let i = 0; i < n; i++) {
      const a = aCh ? aCh[i] : 0
      const b = bCh ? bCh[i] : 0
      const c = cCh ? cCh[i] : 0
      const d = dCh ? dCh[i] : 0
      ch[i] = evalAst(ast, a, b, c, d)
    }
    for (let c = 1; c < output.length; c++) output[c].set(ch)
    return true
  }
}

registerProcessor('dp-expression', ExpressionProcessor)
