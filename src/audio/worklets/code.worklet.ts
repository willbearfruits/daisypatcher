/// <reference path="./worklet.d.ts" />

/**
 * Code node — runs a user-written body in the emulator.
 *
 * NO EVAL, and that is a constraint rather than a preference: the built
 * app's CSP is `script-src 'self'`, so `new Function` and `eval` are both
 * blocked, and a worklet cannot import a compiler either. What arrives over
 * the port is therefore an AST — parsed once on the main thread by
 * `codegen/codeNode/lang.ts` — and this compiles it into a tree of
 * closures.
 *
 * Closures rather than walking the AST per sample: the walk would re-switch
 * on every node type for every sample, where a closure tree resolves all of
 * that once and leaves a chain of direct calls. Perhaps three times slower
 * than hand-written JS, which for a few dozen operations at 48 kHz is fine.
 *
 * The same AST is compiled to C++ by `codeNode/toCpp.ts`. Every guard here
 * has a counterpart there — division by zero, `log` of zero, `sqrt` of a
 * negative — because an emulator that tolerates something the device turns
 * into NaN is worse than one that refuses it in both places.
 *
 * Registered as `'dp-code'`.
 */

type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; op: string; arg: Expr }
  | { kind: 'bin'; op: string; lhs: Expr; rhs: Expr }
  | { kind: 'cond'; cond: Expr; a: Expr; b: Expr }
  | { kind: 'call'; fn: string; args: Expr[] }

type Stmt =
  | { kind: 'declare'; state: boolean; name: string; init: Expr }
  | { kind: 'assign'; name: string; value: Expr }
  | { kind: 'if'; cond: Expr; then: Stmt[]; otherwise: Stmt[] | null }

interface Program {
  body: Stmt[]
  state: { name: string; init: Expr }[]
}

/** Per-sample evaluation context. Reused; never allocated in the loop. */
interface Env {
  /** Input socket values this sample. */
  a: number
  b: number
  c: number
  d: number
  p1: number
  p2: number
  p3: number
  p4: number
  out: number
  out2: number
  sr: number
  /** Persistent `state` storage plus per-sample locals. */
  vars: Record<string, number>
}

type NumFn = (env: Env) => number
type VoidFn = (env: Env) => void

class CodeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'p1', defaultValue: 0.5, minValue: -1e6, maxValue: 1e6, automationRate: 'k-rate' },
      { name: 'p2', defaultValue: 0.5, minValue: -1e6, maxValue: 1e6, automationRate: 'k-rate' },
      { name: 'p3', defaultValue: 0, minValue: -1e6, maxValue: 1e6, automationRate: 'k-rate' },
      { name: 'p4', defaultValue: 0, minValue: -1e6, maxValue: 1e6, automationRate: 'k-rate' }
    ]
  }

  private compiled: VoidFn[] = []
  private env: Env = {
    a: 0, b: 0, c: 0, d: 0,
    p1: 0, p2: 0, p3: 0, p4: 0,
    out: 0, out2: 0,
    sr: 48000,
    vars: {}
  }
  /** Set when the posted AST could not be compiled; the node goes silent. */
  private broken = false

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.env.sr = sampleRate
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type !== 'param' || data.paramId !== 'ast') return
      try {
        const program: Program = typeof data.value === 'string' ? JSON.parse(data.value) : data.value
        if (!program || !Array.isArray(program.body)) {
          this.broken = true
          return
        }
        // State survives a recompile where the name survives, so editing the
        // body does not reset a phase accumulator you were listening to.
        const vars: Record<string, number> = {}
        for (const s of program.state ?? []) {
          const prev = this.env.vars[s.name]
          vars[s.name] = typeof prev === 'number' ? prev : this.constEval(s.init)
        }
        this.env.vars = vars
        this.compiled = program.body.map((st) => this.stmt(st))
        this.broken = false
      } catch {
        this.broken = true
      }
    }
  }

  /* ---- constant folding for state initialisers ---- */
  private constEval(e: Expr): number {
    const fn = this.expr(e)
    return fn(this.env)
  }

  /* ---- compile: statement -> closure ---- */
  private stmt(s: Stmt): VoidFn {
    if (s.kind === 'declare') {
      const name = s.name
      const init = this.expr(s.init)
      return (env) => {
        env.vars[name] = init(env)
      }
    }
    if (s.kind === 'assign') {
      const value = this.expr(s.value)
      const name = s.name
      if (name === 'out') return (env) => { env.out = value(env) }
      if (name === 'out2') return (env) => { env.out2 = value(env) }
      return (env) => {
        env.vars[name] = value(env)
      }
    }
    const cond = this.expr(s.cond)
    const then = s.then.map((x) => this.stmt(x))
    const other = s.otherwise ? s.otherwise.map((x) => this.stmt(x)) : null
    return (env) => {
      if (cond(env) !== 0) {
        for (let i = 0; i < then.length; i++) then[i](env)
      } else if (other) {
        for (let i = 0; i < other.length; i++) other[i](env)
      }
    }
  }

  /* ---- compile: expression -> closure ---- */
  private expr(e: Expr): NumFn {
    switch (e.kind) {
      case 'num': {
        const v = e.value
        return () => v
      }
      case 'var': {
        const n = e.name
        if (n === 'PI') return () => Math.PI
        if (n === 'E') return () => Math.E
        if (n === 'sr') return (env) => env.sr
        if (n === 'a') return (env) => env.a
        if (n === 'b') return (env) => env.b
        if (n === 'c') return (env) => env.c
        if (n === 'd') return (env) => env.d
        if (n === 'p1') return (env) => env.p1
        if (n === 'p2') return (env) => env.p2
        if (n === 'p3') return (env) => env.p3
        if (n === 'p4') return (env) => env.p4
        if (n === 'out') return (env) => env.out
        if (n === 'out2') return (env) => env.out2
        return (env) => env.vars[n] ?? 0
      }
      case 'unary': {
        const arg = this.expr(e.arg)
        if (e.op === '-') return (env) => -arg(env)
        if (e.op === '!') return (env) => (arg(env) === 0 ? 1 : 0)
        return arg
      }
      case 'bin': {
        const l = this.expr(e.lhs)
        const r = this.expr(e.rhs)
        switch (e.op) {
          case '+': return (env) => l(env) + r(env)
          case '-': return (env) => l(env) - r(env)
          case '*': return (env) => l(env) * r(env)
          // Guarded exactly as the C++ backend guards them — see the note
          // in toCpp.ts. A NaN here would poison every downstream node.
          case '/': return (env) => { const d = r(env); return d > -1e-12 && d < 1e-12 ? 0 : l(env) / d }
          case '%': return (env) => { const d = r(env); return d > -1e-12 && d < 1e-12 ? 0 : l(env) % d }
          case '<': return (env) => (l(env) < r(env) ? 1 : 0)
          case '>': return (env) => (l(env) > r(env) ? 1 : 0)
          case '<=': return (env) => (l(env) <= r(env) ? 1 : 0)
          case '>=': return (env) => (l(env) >= r(env) ? 1 : 0)
          case '==': return (env) => (l(env) === r(env) ? 1 : 0)
          case '!=': return (env) => (l(env) !== r(env) ? 1 : 0)
          case '&&': return (env) => (l(env) !== 0 && r(env) !== 0 ? 1 : 0)
          case '||': return (env) => (l(env) !== 0 || r(env) !== 0 ? 1 : 0)
          default: return () => 0
        }
      }
      case 'cond': {
        const c = this.expr(e.cond)
        const a = this.expr(e.a)
        const b = this.expr(e.b)
        return (env) => (c(env) !== 0 ? a(env) : b(env))
      }
      case 'call': {
        const args = e.args.map((x) => this.expr(x))
        const [x, y, z] = args
        switch (e.fn) {
          case 'sin': return (env) => Math.sin(x(env))
          case 'cos': return (env) => Math.cos(x(env))
          case 'tan': return (env) => Math.tan(x(env))
          case 'tanh': return (env) => Math.tanh(x(env))
          case 'abs': return (env) => Math.abs(x(env))
          case 'sqrt': return (env) => Math.sqrt(Math.max(0, x(env)))
          case 'exp': return (env) => Math.exp(x(env))
          case 'log': return (env) => Math.log(Math.max(1e-9, x(env)))
          case 'floor': return (env) => Math.floor(x(env))
          case 'ceil': return (env) => Math.ceil(x(env))
          case 'round': return (env) => Math.round(x(env))
          case 'sign': return (env) => Math.sign(x(env))
          case 'min': return (env) => Math.min(x(env), y(env))
          case 'max': return (env) => Math.max(x(env), y(env))
          case 'pow': return (env) => Math.pow(x(env), y(env))
          case 'fmod': return (env) => { const d = y(env); return d === 0 ? 0 : x(env) % d }
          case 'clamp': return (env) => Math.min(Math.max(x(env), y(env)), z(env))
          default: return () => 0
        }
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out1 = outputs[0]?.[0]
    const out2 = outputs[1]?.[0]
    const n = out1?.length ?? out2?.length ?? 0
    if (n === 0) return true

    if (this.broken || this.compiled.length === 0) {
      out1?.fill(0)
      out2?.fill(0)
      return true
    }

    // Unconnected inputs arrive as an empty array, not a buffer of zeros —
    // see CLAUDE.md. Reading the length is what distinguishes them.
    const ia = inputs[0]?.[0]
    const ib = inputs[1]?.[0]
    const ic = inputs[2]?.[0]
    const id = inputs[3]?.[0]

    const env = this.env
    env.sr = sampleRate
    env.p1 = parameters.p1[0] ?? 0
    env.p2 = parameters.p2[0] ?? 0
    env.p3 = parameters.p3[0] ?? 0
    env.p4 = parameters.p4[0] ?? 0

    const body = this.compiled
    const len = body.length

    for (let i = 0; i < n; i++) {
      env.a = ia ? ia[i] : 0
      env.b = ib ? ib[i] : 0
      env.c = ic ? ic[i] : 0
      env.d = id ? id[i] : 0
      env.out = 0
      env.out2 = 0
      for (let s = 0; s < len; s++) body[s](env)
      // A body that diverges (an unstable filter, a runaway accumulator)
      // must not put NaN on the bus, where it would spread to everything
      // downstream and stay until the engine restarts.
      const o1 = env.out
      const o2 = env.out2
      if (out1) out1[i] = o1 === o1 ? o1 : 0
      if (out2) out2[i] = o2 === o2 ? o2 : 0
    }
    return true
  }
}

registerProcessor('dp-code', CodeProcessor)
