/**
 * Per-kind emitters. Each emitter turns a NodeInstance into three fragments:
 *
 *   declare  — the DaisySP (or plain) member for this node, if any. Emitted
 *              at file scope.
 *   init     — one-shot setup code that runs in `main()` before the audio
 *              thread starts. Receives the sample rate via `sr`.
 *   process  — per-sample block executed inside AudioCallback's sample loop.
 *              Must produce C++ locals named `<varName>_<socketId>` for each
 *              output socket of the node.
 *
 * No file I/O, no globals, no side effects. The code is pure string building.
 * The `EmitContext` gives each emitter access to (a) the node's params and
 * (b) helpers that resolve upstream output variables for its inputs.
 */
import type { AudioGraph, NodeInstance, NodeKind } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import { hwVar, resolveBinding, valueExprForBinding } from './hardwareBindings'

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Numeric param with clamp and float literal formatting. */
function numParam(node: NodeInstance, id: string, fallback = 0): string {
  const raw = node.params[id]
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  return formatFloat(value)
}

function rawNum(node: NodeInstance, id: string, fallback = 0): number {
  const raw = node.params[id]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function enumParam(node: NodeInstance, id: string, fallback: string): string {
  const raw = node.params[id]
  return typeof raw === 'string' ? raw : fallback
}

/** "0.5f" style float literal — robust for C++ parsing. */
function formatFloat(v: number): string {
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
const NOOP = {
  declare: () => '',
  init: () => '',
  process: () => ''
}

/** Pass-through: first input -> first output. Used for stubs. */
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

// ---------------------------------------------------------------------------
// Source emitters
// ---------------------------------------------------------------------------

const oscillator: NodeEmitter = {
  declare: (ctx) => `Oscillator ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const wave = enumParam(ctx.node, 'waveform', 'sine')
    const waveEnum =
      wave === 'sawtooth'
        ? 'Oscillator::WAVE_POLYBLEP_SAW'
        : wave === 'square'
          ? 'Oscillator::WAVE_POLYBLEP_SQUARE'
          : wave === 'triangle'
            ? 'Oscillator::WAVE_POLYBLEP_TRI'
            : 'Oscillator::WAVE_SIN'
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetWaveform(${waveEnum});`,
      `    ${v}.SetFreq(${numParam(ctx.node, 'frequency', 220)});`,
      `    ${v}.SetAmp(${numParam(ctx.node, 'amplitude', 0.5)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const pitchCv = ctx.inputExpr(ctx.node.id, 'pitch_cv', '0.f')
    const ampCv = ctx.inputExpr(ctx.node.id, 'amp_cv', '1.f')
    const freq = numParam(ctx.node, 'frequency', 220)
    const amp = numParam(ctx.node, 'amplitude', 0.5)
    // pitch CV in 1 V/oct style: octave per unit.
    return (
      `    ${v}.SetFreq(${freq} * powf(2.f, ${pitchCv}));\n` +
      `    ${v}.SetAmp(${amp} * ${ampCv});\n` +
      `    float ${out} = ${v}.Process();\n`
    )
  }
}

const noise: NodeEmitter = {
  declare: (ctx) => `WhiteNoise ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init();`,
      `    ${v}.SetAmp(${numParam(ctx.node, 'amplitude', 0.3)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const color = enumParam(ctx.node, 'color', 'white')
    if (color === 'pink') {
      // Rough pink approximation via one-pole lowpass.
      const state = `${v}_pink_state`
      return (
        `    static float ${state} = 0.f;\n` +
        `    float ${v}_white = ${v}.Process();\n` +
        `    ${state} = 0.98f * ${state} + 0.02f * ${v}_white;\n` +
        `    float ${out} = ${state} * 6.f;\n`
      )
    }
    return `    float ${out} = ${v}.Process();\n`
  }
}

const lfo: NodeEmitter = {
  declare: (ctx) => `Oscillator ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const wave = enumParam(ctx.node, 'waveform', 'sine')
    const waveEnum =
      wave === 'saw'
        ? 'Oscillator::WAVE_POLYBLEP_SAW'
        : wave === 'square'
          ? 'Oscillator::WAVE_POLYBLEP_SQUARE'
          : wave === 'tri'
            ? 'Oscillator::WAVE_POLYBLEP_TRI'
            : 'Oscillator::WAVE_SIN'
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetWaveform(${waveEnum});`,
      `    ${v}.SetFreq(${numParam(ctx.node, 'frequency', 1)});`,
      `    ${v}.SetAmp(1.f);`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const depth = numParam(ctx.node, 'depth', 1)
    const offset = numParam(ctx.node, 'offset', 0)
    return `    float ${out} = ${v}.Process() * ${depth} + ${offset};\n`
  }
}

const constant: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    return `    float ${out} = ${numParam(ctx.node, 'value', 0.5)};\n`
  }
}

const karplus: NodeEmitter = {
  declare: (ctx) => `String ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetFreq(${numParam(ctx.node, 'frequency', 220)});`,
      `    ${v}.SetDamping(${numParam(ctx.node, 'damping', 0.5)});`,
      `    ${v}.SetNonLinearity(0.1f);`,
      `    ${v}.SetBrightness(${numParam(ctx.node, 'feedback', 0.99)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const prev = `${v}_prev_trig`
    return (
      `    static float ${prev} = 0.f;\n` +
      `    float ${v}_trig_in = ${trig};\n` +
      `    bool ${v}_edge = (${v}_trig_in > 0.5f) && (${prev} <= 0.5f);\n` +
      `    ${prev} = ${v}_trig_in;\n` +
      `    float ${out} = ${v}.Process(${v}_edge ? 1.f : 0.f);\n`
    )
  }
}

const fm_op: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_phase = 0.f;\nfloat ${v}_last = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const mod = ctx.inputExpr(ctx.node.id, 'mod', '0.f')
    const pitchCv = ctx.inputExpr(ctx.node.id, 'pitch_cv', '0.f')
    const freq = numParam(ctx.node, 'frequency', 220)
    const ratio = numParam(ctx.node, 'ratio', 1)
    const amp = numParam(ctx.node, 'amplitude', 0.7)
    const fb = numParam(ctx.node, 'feedback', 0)
    return (
      `    {\n` +
      `        float f = ${freq} * ${ratio} * powf(2.f, ${pitchCv});\n` +
      `        float inc = f / sr;\n` +
      `        ${v}_phase += inc;\n` +
      `        if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `        float ph = ${v}_phase + ${mod} + ${v}_last * ${fb};\n` +
      `        ${v}_last = sinf(ph * 2.f * (float)M_PI);\n` +
      `        float ${out} = ${v}_last * ${amp};\n` +
      `        (void)${out};\n` +
      `        float ${out}_out = ${v}_last * ${amp};\n` +
      `        ${out}_out = ${out}_out;\n` +
      `    }\n`
    )
  }
}

// Simpler: re-do fm_op without the awkward block. Use static outside.
const fm_op_clean: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_phase = 0.f;\nfloat ${v}_last = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const mod = ctx.inputExpr(ctx.node.id, 'mod', '0.f')
    const pitchCv = ctx.inputExpr(ctx.node.id, 'pitch_cv', '0.f')
    const freq = numParam(ctx.node, 'frequency', 220)
    const ratio = numParam(ctx.node, 'ratio', 1)
    const amp = numParam(ctx.node, 'amplitude', 0.7)
    const fb = numParam(ctx.node, 'feedback', 0)
    return (
      `    {\n` +
      `        float f = ${freq} * ${ratio} * powf(2.f, ${pitchCv});\n` +
      `        ${v}_phase += f / sr;\n` +
      `        if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `        float ph = ${v}_phase + (${mod}) + ${v}_last * ${fb};\n` +
      `        ${v}_last = sinf(ph * 2.f * (float)M_PI);\n` +
      `    }\n` +
      `    float ${out} = ${v}_last * ${amp};\n`
    )
  }
}

const fm2: NodeEmitter = {
  declare: (ctx) => `Fm2 ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetFrequency(${numParam(ctx.node, 'frequency', 220)});`,
      `    ${v}.SetRatio(${numParam(ctx.node, 'mod_ratio', 2)});`,
      `    ${v}.SetIndex(${numParam(ctx.node, 'mod_index', 3)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const pitchCv = ctx.inputExpr(ctx.node.id, 'pitch_cv', '0.f')
    const ampCv = ctx.inputExpr(ctx.node.id, 'amp_cv', '1.f')
    const freq = numParam(ctx.node, 'frequency', 220)
    const amp = numParam(ctx.node, 'carrier_amp', 0.7)
    return (
      `    ${v}.SetFrequency(${freq} * powf(2.f, ${pitchCv}));\n` +
      `    float ${out} = ${v}.Process() * ${amp} * ${ampCv};\n`
    )
  }
}

const wavetable: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_phase = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const pitchCv = ctx.inputExpr(ctx.node.id, 'pitch_cv', '0.f')
    const morphCv = ctx.inputExpr(ctx.node.id, 'morph_cv', '0.f')
    const freq = numParam(ctx.node, 'frequency', 220)
    const amp = numParam(ctx.node, 'amplitude', 0.5)
    const morph = numParam(ctx.node, 'morph', 0)
    // Four tables represented as mixes of harmonics.
    return (
      `    {\n` +
      `        float f = ${freq} * powf(2.f, ${pitchCv});\n` +
      `        ${v}_phase += f / sr;\n` +
      `        if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `        float p = ${v}_phase * 2.f * (float)M_PI;\n` +
      `        float t0 = sinf(p);\n` +
      `        float t1 = sinf(p) * 0.7f + sinf(2.f * p) * 0.3f;\n` +
      `        float t2 = sinf(p) * 0.5f + sinf(3.f * p) * 0.35f + sinf(5.f * p) * 0.15f;\n` +
      `        float t3 = sinf(p) * 0.4f + sinf(2.f * p) * 0.3f + sinf(4.f * p) * 0.2f + sinf(7.f * p) * 0.1f;\n` +
      `        float m = ${morph} + (${morphCv});\n` +
      `        if (m < 0.f) m = 0.f; if (m > 1.f) m = 1.f;\n` +
      `        float seg = m * 3.f;\n` +
      `        int i = (int)seg;\n` +
      `        float frac = seg - (float)i;\n` +
      `        float a = (i <= 0) ? t0 : (i == 1) ? t1 : (i == 2) ? t2 : t3;\n` +
      `        float b = (i <= 0) ? t1 : (i == 1) ? t2 : t3;\n` +
      `        float ${out} = (a + (b - a) * frac) * ${amp};\n`
    ) + `    }\n`
  }
}

function drumEmitter(klass: string, template: '<>' | '' = ''): NodeEmitter {
  return {
    declare: (ctx) => `${klass}${template} ${ctx.varName(ctx.node.id)};`,
    init: (ctx) => `    ${ctx.varName(ctx.node.id)}.Init(sr);`,
    process: (ctx) => {
      const v = ctx.varName(ctx.node.id)
      const out = ctx.outputVar(ctx.node.id, 'out')
      const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
      const prev = `${v}_prev_trig`
      return (
        `    static float ${prev} = 0.f;\n` +
        `    float ${v}_tin = ${trig};\n` +
        `    bool ${v}_edge = (${v}_tin > 0.5f) && (${prev} <= 0.5f);\n` +
        `    ${prev} = ${v}_tin;\n` +
        `    ${v}.SetSustain(0);\n` +
        `    ${v}.SetTrigger(${v}_edge);\n` +
        `    float ${out} = ${v}.Process(${v}_edge);\n`
      )
    }
  }
}

const drum_kick = drumEmitter('AnalogBassDrum')
const drum_snare = drumEmitter('AnalogSnareDrum')
const drum_hat = drumEmitter('HiHat', '<>')

// ---------------------------------------------------------------------------
// Utility / math
// ---------------------------------------------------------------------------

const gain: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'cv', '1.f')
    const g = numParam(ctx.node, 'gain', 0.8)
    return `    float ${out} = (${i}) * ${g} * (${cv});\n`
  }
}

const vca: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'cv', '0.f')
    const bias = numParam(ctx.node, 'bias', 0)
    return `    float ${out} = (${i}) * ((${cv}) + ${bias});\n`
  }
}

const mixer4: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const parts: string[] = []
    for (let i = 1; i <= 4; i++) {
      const sig = ctx.inputExpr(ctx.node.id, `in${i}`, '0.f')
      const g = numParam(ctx.node, `gain${i}`, 1)
      parts.push(`(${sig}) * ${g}`)
    }
    return `    float ${out} = ${parts.join(' + ')};\n`
  }
}

const pan: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'cv', '0.f')
    const pn = numParam(ctx.node, 'pan', 0)
    return (
      `    float ${l}, ${r};\n` +
      `    {\n` +
      `        float p = ${pn} + (${cv});\n` +
      `        if (p < -1.f) p = -1.f; if (p > 1.f) p = 1.f;\n` +
      `        float ang = (p + 1.f) * 0.25f * (float)M_PI;\n` +
      `        float s = ${i};\n` +
      `        ${l} = s * cosf(ang);\n` +
      `        ${r} = s * sinf(ang);\n` +
      `    }\n`
    )
  }
}

const clip: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const drive = numParam(ctx.node, 'drive', 1)
    const mode = enumParam(ctx.node, 'mode', 'hard')
    if (mode === 'tanh') {
      return `    float ${out} = tanhf((${i}) * ${drive});\n`
    }
    if (mode === 'soft') {
      return (
        `    float ${out};\n` +
        `    {\n` +
        `        float x = (${i}) * ${drive};\n` +
        `        ${out} = x / (1.f + fabsf(x));\n` +
        `    }\n`
      )
    }
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float x = (${i}) * ${drive};\n` +
      `        if (x > 1.f) x = 1.f; if (x < -1.f) x = -1.f;\n` +
      `        ${out} = x;\n` +
      `    }\n`
    )
  }
}

const sumNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const parts = [1, 2, 3, 4].map((n) => `(${ctx.inputExpr(ctx.node.id, `in${n}`, '0.f')})`)
    return `    float ${out} = ${parts.join(' + ')};\n`
  }
}

const multiplyNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    return `    float ${out} = (${a}) * (${b});\n`
  }
}

const crossfade: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'cv', '0.f')
    const mix = numParam(ctx.node, 'mix', 0.5)
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float m = ${mix} + (${cv});\n` +
      `        if (m < 0.f) m = 0.f; if (m > 1.f) m = 1.f;\n` +
      `        ${out} = (${a}) * (1.f - m) + (${b}) * m;\n` +
      `    }\n`
    )
  }
}

const ring_mod: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    const mix = numParam(ctx.node, 'mix', 1)
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float dry = ${a};\n` +
      `        float wet = (${a}) * (${b});\n` +
      `        ${out} = dry * (1.f - ${mix}) + wet * ${mix};\n` +
      `    }\n`
    )
  }
}

const wavefolder: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'fold_cv', '0.f')
    const fold = numParam(ctx.node, 'fold', 1)
    const bias = numParam(ctx.node, 'bias', 0)
    return `    float ${out} = sinf((float)M_PI * ((${i}) + ${bias}) * (${fold} + (${cv})));\n`
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const filter_svf: NodeEmitter = {
  declare: (ctx) => `Svf ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetFreq(${numParam(ctx.node, 'frequency', 1000)});`,
      `    ${v}.SetRes(${numParam(ctx.node, 'resonance', 0.2)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lp = ctx.outputVar(ctx.node.id, 'lp')
    const hp = ctx.outputVar(ctx.node.id, 'hp')
    const bp = ctx.outputVar(ctx.node.id, 'bp')
    const nt = ctx.outputVar(ctx.node.id, 'notch')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'freq_cv', '0.f')
    const base = numParam(ctx.node, 'frequency', 1000)
    return (
      `    ${v}.SetFreq(${base} * powf(2.f, ${cv}));\n` +
      `    ${v}.Process(${i});\n` +
      `    float ${lp} = ${v}.Low();\n` +
      `    float ${hp} = ${v}.High();\n` +
      `    float ${bp} = ${v}.Band();\n` +
      `    float ${nt} = ${v}.Notch();\n`
    )
  }
}

const filter_moog: NodeEmitter = {
  declare: (ctx) => `MoogLadder ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetFreq(${numParam(ctx.node, 'frequency', 1000)});`,
      `    ${v}.SetRes(${numParam(ctx.node, 'resonance', 0.3)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'freq_cv', '0.f')
    const base = numParam(ctx.node, 'frequency', 1000)
    return (
      `    ${v}.SetFreq(${base} * powf(2.f, ${cv}));\n` +
      `    float ${out} = ${v}.Process(${i});\n`
    )
  }
}

const formant: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `Svf ${v}_f1;\nSvf ${v}_f2;\nSvf ${v}_f3;`
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const q = numParam(ctx.node, 'q', 5)
    return [
      `    ${v}_f1.Init(sr);`,
      `    ${v}_f2.Init(sr);`,
      `    ${v}_f3.Init(sr);`,
      `    ${v}_f1.SetRes(${q} * 0.05f);`,
      `    ${v}_f2.SetRes(${q} * 0.05f);`,
      `    ${v}_f3.SetRes(${q} * 0.05f);`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const vowel = enumParam(ctx.node, 'vowel', 'a')
    const mix = numParam(ctx.node, 'mix', 0.6)
    const table: Record<string, [number, number, number]> = {
      a: [730, 1090, 2440],
      e: [530, 1840, 2480],
      i: [270, 2290, 3010],
      o: [570, 840, 2410],
      u: [300, 870, 2240]
    }
    const [f1, f2, f3] = table[vowel] ?? table.a
    return (
      `    ${v}_f1.SetFreq(${formatFloat(f1)});\n` +
      `    ${v}_f2.SetFreq(${formatFloat(f2)});\n` +
      `    ${v}_f3.SetFreq(${formatFloat(f3)});\n` +
      `    ${v}_f1.Process(${i});\n` +
      `    ${v}_f2.Process(${i});\n` +
      `    ${v}_f3.Process(${i});\n` +
      `    float ${v}_wet = ${v}_f1.Band() + ${v}_f2.Band() * 0.8f + ${v}_f3.Band() * 0.6f;\n` +
      `    float ${out} = (${i}) * (1.f - ${mix}) + ${v}_wet * ${mix};\n`
    )
  }
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

const adsr: NodeEmitter = {
  declare: (ctx) => `Adsr ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetTime(ADSR_SEG_ATTACK, ${numParam(ctx.node, 'attack', 0.01)});`,
      `    ${v}.SetTime(ADSR_SEG_DECAY, ${numParam(ctx.node, 'decay', 0.1)});`,
      `    ${v}.SetSustainLevel(${numParam(ctx.node, 'sustain', 0.7)});`,
      `    ${v}.SetTime(ADSR_SEG_RELEASE, ${numParam(ctx.node, 'release', 0.3)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const g = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    return `    float ${out} = ${v}.Process((${g}) > 0.5f);\n`
  }
}

const ar: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_level = 0.f;\nfloat ${v}_prev_gate = 0.f;\nbool ${v}_rising = false;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const g = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const a = numParam(ctx.node, 'attack', 0.01)
    const r = numParam(ctx.node, 'release', 0.3)
    return (
      `    {\n` +
      `        float gi = ${g};\n` +
      `        if (gi > 0.5f && ${v}_prev_gate <= 0.5f) ${v}_rising = true;\n` +
      `        ${v}_prev_gate = gi;\n` +
      `        float atk = 1.f - expf(-1.f / (sr * fmaxf(${a}, 1e-4f)));\n` +
      `        float rel = 1.f - expf(-1.f / (sr * fmaxf(${r}, 1e-4f)));\n` +
      `        if (${v}_rising) {\n` +
      `            ${v}_level += (1.f - ${v}_level) * atk;\n` +
      `            if (${v}_level > 0.999f) ${v}_rising = false;\n` +
      `        } else {\n` +
      `            ${v}_level += (0.f - ${v}_level) * rel;\n` +
      `        }\n` +
      `    }\n` +
      `    float ${out} = ${v}_level;\n`
    )
  }
}

const envelope_follower: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_env = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const a = numParam(ctx.node, 'attack', 0.01)
    const r = numParam(ctx.node, 'release', 0.1)
    return (
      `    {\n` +
      `        float x = fabsf(${i});\n` +
      `        float ca = 1.f - expf(-1.f / (sr * fmaxf(${a}, 1e-4f)));\n` +
      `        float cr = 1.f - expf(-1.f / (sr * fmaxf(${r}, 1e-4f)));\n` +
      `        float c = (x > ${v}_env) ? ca : cr;\n` +
      `        ${v}_env += (x - ${v}_env) * c;\n` +
      `    }\n` +
      `    float ${out} = ${v}_env;\n`
    )
  }
}

// ---------------------------------------------------------------------------
// CV tools
// ---------------------------------------------------------------------------

const slew: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_y = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const rise = numParam(ctx.node, 'rise', 0.05)
    const fall = numParam(ctx.node, 'fall', 0.05)
    return (
      `    {\n` +
      `        float x = ${i};\n` +
      `        float cr = 1.f - expf(-1.f / (sr * fmaxf(${rise}, 1e-4f)));\n` +
      `        float cf = 1.f - expf(-1.f / (sr * fmaxf(${fall}, 1e-4f)));\n` +
      `        float c = (x > ${v}_y) ? cr : cf;\n` +
      `        ${v}_y += (x - ${v}_y) * c;\n` +
      `    }\n` +
      `    float ${out} = ${v}_y;\n`
    )
  }
}

const sample_hold: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_held = 0.f;\nfloat ${v}_prev_trig = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const t = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    return (
      `    {\n` +
      `        float ti = ${t};\n` +
      `        if (ti > 0.5f && ${v}_prev_trig <= 0.5f) ${v}_held = ${i};\n` +
      `        ${v}_prev_trig = ti;\n` +
      `    }\n` +
      `    float ${out} = ${v}_held;\n`
    )
  }
}

const inverter: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = -(${i});\n`
  }
}

const scaleNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const s = numParam(ctx.node, 'scale', 1)
    const o = numParam(ctx.node, 'offset', 0)
    return `    float ${out} = (${i}) * ${s} + ${o};\n`
  }
}

const comparator: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const ref = ctx.inputExpr(ctx.node.id, 'ref', '0.f')
    const thr = numParam(ctx.node, 'threshold', 0)
    return `    float ${out} = ((${i}) > ((${ref}) + ${thr})) ? 1.f : 0.f;\n`
  }
}

// ---------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------

const clockNode: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_phase = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const bpm = numParam(ctx.node, 'bpm', 120)
    const pw = numParam(ctx.node, 'pulse_width', 0.1)
    return (
      `    ${v}_phase += (${bpm} / 60.f) / sr;\n` +
      `    if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `    float ${out} = (${v}_phase < ${pw}) ? 1.f : 0.f;\n`
    )
  }
}

const clock_divider: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `uint32_t ${v}_count = 0;\nfloat ${v}_prev_in = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const d2 = ctx.outputVar(ctx.node.id, 'd2')
    const d4 = ctx.outputVar(ctx.node.id, 'd4')
    const d8 = ctx.outputVar(ctx.node.id, 'd8')
    const d16 = ctx.outputVar(ctx.node.id, 'd16')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return (
      `    {\n` +
      `        float ci = ${i};\n` +
      `        if (ci > 0.5f && ${v}_prev_in <= 0.5f) ${v}_count++;\n` +
      `        ${v}_prev_in = ci;\n` +
      `    }\n` +
      `    float ${d2}  = ((${v}_count >> 1) & 1u) ? 1.f : 0.f;\n` +
      `    float ${d4}  = ((${v}_count >> 2) & 1u) ? 1.f : 0.f;\n` +
      `    float ${d8}  = ((${v}_count >> 3) & 1u) ? 1.f : 0.f;\n` +
      `    float ${d16} = ((${v}_count >> 4) & 1u) ? 1.f : 0.f;\n`
    )
  }
}

const step_seq: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `uint32_t ${v}_step = 0;\nfloat ${v}_prev_clk = 0.f;\nfloat ${v}_prev_rst = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const cvOut = ctx.outputVar(ctx.node.id, 'cv')
    const gateOut = ctx.outputVar(ctx.node.id, 'gate')
    const clk = ctx.inputExpr(ctx.node.id, 'clock', '0.f')
    const rst = ctx.inputExpr(ctx.node.id, 'reset', '0.f')
    const steps: string[] = []
    for (let i = 1; i <= 8; i++) {
      steps.push(`${numParam(ctx.node, `s${i}`, 0)}`)
    }
    const gates: string[] = []
    for (let i = 1; i <= 8; i++) {
      const g = enumParam(ctx.node, `g${i}`, i <= 4 ? 'on' : 'off')
      gates.push(g === 'on' ? '1.f' : '0.f')
    }
    return (
      `    static const float ${v}_steps[8] = { ${steps.join(', ')} };\n` +
      `    static const float ${v}_gates[8] = { ${gates.join(', ')} };\n` +
      `    {\n` +
      `        float ci = ${clk};\n` +
      `        float ri = ${rst};\n` +
      `        if (ri > 0.5f && ${v}_prev_rst <= 0.5f) ${v}_step = 0;\n` +
      `        ${v}_prev_rst = ri;\n` +
      `        if (ci > 0.5f && ${v}_prev_clk <= 0.5f) ${v}_step = (${v}_step + 1u) & 7u;\n` +
      `        ${v}_prev_clk = ci;\n` +
      `    }\n` +
      `    float ${cvOut} = ${v}_steps[${v}_step];\n` +
      `    float ${gateOut} = ${v}_gates[${v}_step] * ((${clk}) > 0.5f ? 1.f : 0.f);\n`
    )
  }
}

const euclidean: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const steps = Math.max(2, Math.floor(rawNum(ctx.node, 'steps', 16)))
    const pulses = Math.max(0, Math.min(steps, Math.floor(rawNum(ctx.node, 'pulses', 4))))
    const rot = Math.max(0, Math.floor(rawNum(ctx.node, 'rotate', 0))) % steps
    const pattern = buildEuclidean(steps, pulses, rot)
    const arr = pattern.map((b) => (b ? '1' : '0')).join(', ')
    return (
      `const uint8_t ${v}_pattern[${steps}] = { ${arr} };\n` +
      `uint32_t ${v}_step = 0;\n` +
      `float ${v}_prev_clk = 0.f;\n` +
      `float ${v}_prev_rst = 0.f;`
    )
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const clk = ctx.inputExpr(ctx.node.id, 'clock', '0.f')
    const rst = ctx.inputExpr(ctx.node.id, 'reset', '0.f')
    const steps = Math.max(2, Math.floor(rawNum(ctx.node, 'steps', 16)))
    return (
      `    {\n` +
      `        float ci = ${clk};\n` +
      `        float ri = ${rst};\n` +
      `        if (ri > 0.5f && ${v}_prev_rst <= 0.5f) ${v}_step = 0;\n` +
      `        ${v}_prev_rst = ri;\n` +
      `        if (ci > 0.5f && ${v}_prev_clk <= 0.5f) ${v}_step = (${v}_step + 1u) % ${steps}u;\n` +
      `        ${v}_prev_clk = ci;\n` +
      `    }\n` +
      `    float ${out} = (${v}_pattern[${v}_step] && ((${clk}) > 0.5f)) ? 1.f : 0.f;\n`
    )
  }
}

function buildEuclidean(steps: number, pulses: number, rotate: number): boolean[] {
  const n = Math.max(1, steps)
  const k = Math.max(0, Math.min(pulses, n))
  const out: boolean[] = new Array(n).fill(false)
  if (k === 0) return out
  let bucket = 0
  for (let i = 0; i < n; i++) {
    bucket += k
    if (bucket >= n) {
      bucket -= n
      out[i] = true
    }
  }
  if (rotate > 0) {
    const r = rotate % n
    const rotated = out.slice(n - r).concat(out.slice(0, n - r))
    return rotated
  }
  return out
}

const randomNode: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `Random ${v}_rng;\nfloat ${v}_val = 0.f;\nfloat ${v}_prev_clk = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const clk = ctx.inputExpr(ctx.node.id, 'clock', '0.f')
    const range = numParam(ctx.node, 'range', 1)
    return (
      `    {\n` +
      `        float ci = ${clk};\n` +
      `        if (ci > 0.5f && ${v}_prev_clk <= 0.5f) ${v}_val = (${v}_rng.NextFloat() * 2.f - 1.f) * ${range};\n` +
      `        ${v}_prev_clk = ci;\n` +
      `    }\n` +
      `    float ${out} = ${v}_val;\n`
    )
  }
}

const dust: NodeEmitter = {
  declare: (ctx) => `Random ${ctx.varName(ctx.node.id)}_rng;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const density = numParam(ctx.node, 'density', 5)
    return (
      `    {\n` +
      `        float p = ${density} / sr;\n` +
      `        float r = ${v}_rng.NextFloat();\n` +
      `        float ${out} = (r < p) ? 1.f : 0.f;\n` +
      `        (void)${out};\n` +
      `    }\n` +
      `    float ${out} = ((${v}_rng.NextFloat()) < (${density} / sr)) ? 1.f : 0.f;\n`
    )
  }
}

// Simplified dust
const dustClean: NodeEmitter = {
  declare: (ctx) => `Random ${ctx.varName(ctx.node.id)}_rng;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const density = numParam(ctx.node, 'density', 5)
    return `    float ${out} = (${v}_rng.NextFloat() < (${density} / sr)) ? 1.f : 0.f;\n`
  }
}

const arp: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `uint32_t ${v}_idx = 0;\nfloat ${v}_prev_clk = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const cvOut = ctx.outputVar(ctx.node.id, 'cv')
    const gateOut = ctx.outputVar(ctx.node.id, 'gate_out')
    const clk = ctx.inputExpr(ctx.node.id, 'clock', '0.f')
    const gIn = ctx.inputExpr(ctx.node.id, 'gate_in', '0.f')
    const root = numParam(ctx.node, 'root', 0)
    const octaves = Math.max(1, Math.floor(rawNum(ctx.node, 'octaves', 1)))
    const scale = enumParam(ctx.node, 'scale', 'major')
    const scales: Record<string, number[]> = {
      major: [0, 2, 4, 5, 7, 9, 11],
      minor: [0, 2, 3, 5, 7, 8, 10],
      pentatonic: [0, 2, 4, 7, 9],
      chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    }
    const intervals = scales[scale] ?? scales.major
    const notes: number[] = []
    for (let o = 0; o < octaves; o++) {
      for (const st of intervals) notes.push((o * 12 + st) / 12)
    }
    const pattern = enumParam(ctx.node, 'pattern', 'up')
    const len = notes.length
    const arr = notes.map((n) => formatFloat(n)).join(', ')
    return (
      `    static const float ${v}_notes[${len}] = { ${arr} };\n` +
      `    {\n` +
      `        float ci = ${clk};\n` +
      `        if (ci > 0.5f && ${v}_prev_clk <= 0.5f && (${gIn}) > 0.5f) {\n` +
      (pattern === 'down'
        ? `            ${v}_idx = (${v}_idx == 0) ? ${len - 1}u : ${v}_idx - 1u;\n`
        : pattern === 'random'
          ? `            ${v}_idx = (uint32_t)(rand() % ${len});\n`
          : `            ${v}_idx = (${v}_idx + 1u) % ${len}u;\n`) +
      `        }\n` +
      `        ${v}_prev_clk = ci;\n` +
      `    }\n` +
      `    float ${cvOut} = ${v}_notes[${v}_idx] + ${root};\n` +
      `    float ${gateOut} = ((${gIn}) > 0.5f && (${clk}) > 0.5f) ? 1.f : 0.f;\n`
    )
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const delay: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `DelayLine<float, CODEGEN_MAX_DELAY> ${v} DSY_SDRAM_BSS;`
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init();`,
      `    ${v}.SetDelay(${numParam(ctx.node, 'time', 0.25)} * sr);`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'time_cv', '0.f')
    const time = numParam(ctx.node, 'time', 0.25)
    const fb = numParam(ctx.node, 'feedback', 0.4)
    const mix = numParam(ctx.node, 'mix', 0.5)
    return (
      `    ${v}.SetDelay(fmaxf(1.f, fminf((float)CODEGEN_MAX_DELAY - 1.f, (${time} + (${cv})) * sr)));\n` +
      `    float ${v}_r = ${v}.Read();\n` +
      `    ${v}.Write((${i}) + ${v}_r * ${fb});\n` +
      `    float ${out} = (${i}) * (1.f - ${mix}) + ${v}_r * ${mix};\n`
    )
  }
}

const reverb: NodeEmitter = {
  declare: (ctx) => `ReverbSc ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    // ReverbSc requires USE_DAISYSP_LGPL=1 in the Makefile.`,
      `    ${v}.Init(sr);`,
      `    ${v}.SetFeedback(0.5f + ${numParam(ctx.node, 'size', 0.5)} * 0.45f);`,
      `    ${v}.SetLpFreq(1000.f + (1.f - ${numParam(ctx.node, 'damp', 0.5)}) * 15000.f);`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const mix = numParam(ctx.node, 'mix', 0.3)
    return (
      `    float ${v}_wl = 0.f, ${v}_wr = 0.f;\n` +
      `    ${v}.Process(${i}, ${i}, &${v}_wl, &${v}_wr);\n` +
      `    float ${out} = (${i}) * (1.f - ${mix}) + 0.5f * (${v}_wl + ${v}_wr) * ${mix};\n`
    )
  }
}

const overdrive: NodeEmitter = {
  declare: (ctx) => `Overdrive ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `    ${v}.Init();\n    ${v}.SetDrive(${numParam(ctx.node, 'drive', 0.3)});`
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = ${v}.Process(${i});\n`
  }
}

const chorus: NodeEmitter = {
  declare: (ctx) => `Chorus ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetLfoFreq(${numParam(ctx.node, 'rate', 0.8)});`,
      `    ${v}.SetLfoDepth(${numParam(ctx.node, 'depth', 0.5)});`,
      `    ${v}.SetFeedback(0.1f);`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const mix = numParam(ctx.node, 'mix', 0.5)
    return (
      `    ${v}.Process(${i});\n` +
      `    float ${v}_wet = 0.5f * (${v}.GetLeft() + ${v}.GetRight());\n` +
      `    float ${out} = (${i}) * (1.f - ${mix}) + ${v}_wet * ${mix};\n`
    )
  }
}

const bitcrush: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_hold = 0.f;\nfloat ${v}_phase = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const bits = numParam(ctx.node, 'bits', 8)
    const rate = numParam(ctx.node, 'rate', 0.5)
    const mix = numParam(ctx.node, 'mix', 1)
    return (
      `    {\n` +
      `        ${v}_phase += ${rate};\n` +
      `        if (${v}_phase >= 1.f) {\n` +
      `            ${v}_phase -= 1.f;\n` +
      `            float levels = powf(2.f, ${bits}) - 1.f;\n` +
      `            float q = roundf((${i}) * levels) / levels;\n` +
      `            ${v}_hold = q;\n` +
      `        }\n` +
      `    }\n` +
      `    float ${out} = (${i}) * (1.f - ${mix}) + ${v}_hold * ${mix};\n`
    )
  }
}

const phaser: NodeEmitter = {
  declare: (ctx) => `Phaser ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetLfoFreq(${numParam(ctx.node, 'rate', 0.5)});`,
      `    ${v}.SetLfoDepth(${numParam(ctx.node, 'depth', 0.7)});`,
      `    ${v}.SetFeedback(${numParam(ctx.node, 'feedback', 0.5)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const mix = numParam(ctx.node, 'mix', 0.5)
    return (
      `    float ${v}_wet = ${v}.Process(${i});\n` +
      `    float ${out} = (${i}) * (1.f - ${mix}) + ${v}_wet * ${mix};\n`
    )
  }
}

const flanger: NodeEmitter = {
  declare: (ctx) => `Flanger ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetLfoFreq(${numParam(ctx.node, 'rate', 0.3)});`,
      `    ${v}.SetLfoDepth(${numParam(ctx.node, 'depth', 0.6)});`,
      `    ${v}.SetFeedback(${numParam(ctx.node, 'feedback', 0.5)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const mix = numParam(ctx.node, 'mix', 0.5)
    return (
      `    float ${v}_wet = ${v}.Process(${i});\n` +
      `    float ${out} = (${i}) * (1.f - ${mix}) + ${v}_wet * ${mix};\n`
    )
  }
}

const ping_pong: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `DelayLine<float, CODEGEN_MAX_DELAY> ${v}_dl DSY_SDRAM_BSS;\n` +
      `DelayLine<float, CODEGEN_MAX_DELAY> ${v}_dr DSY_SDRAM_BSS;`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}_dl.Init();`,
      `    ${v}_dr.Init();`,
      `    ${v}_dl.SetDelay(${numParam(ctx.node, 'time', 0.3)} * sr);`,
      `    ${v}_dr.SetDelay(${numParam(ctx.node, 'time', 0.3)} * sr);`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const fb = numParam(ctx.node, 'feedback', 0.45)
    const mix = numParam(ctx.node, 'mix', 0.4)
    return (
      `    float ${v}_rl = ${v}_dl.Read();\n` +
      `    float ${v}_rr = ${v}_dr.Read();\n` +
      `    ${v}_dl.Write((${i}) + ${v}_rr * ${fb});\n` +
      `    ${v}_dr.Write(${v}_rl * ${fb});\n` +
      `    float ${l} = (${i}) * (1.f - ${mix}) + ${v}_rl * ${mix};\n` +
      `    float ${r} = (${i}) * (1.f - ${mix}) + ${v}_rr * ${mix};\n`
    )
  }
}

const stereo_widener: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `DelayLine<float, 2048> ${v}_dl DSY_SDRAM_BSS;`
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const ms = numParam(ctx.node, 'haas_ms', 8)
    return `    ${v}_dl.Init();\n    ${v}_dl.SetDelay(${ms} * 0.001f * sr);`
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const width = numParam(ctx.node, 'width', 1.2)
    return (
      `    float ${v}_d = ${v}_dl.Read();\n` +
      `    ${v}_dl.Write(${i});\n` +
      `    float ${l} = (${i});\n` +
      `    float ${r} = (${i}) * (1.f - ${width} * 0.5f) + ${v}_d * ${width} * 0.5f;\n`
    )
  }
}

const freeze: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `static constexpr size_t ${v}_SIZE = 48000;\n` +
      `float ${v}_buf[${v}_SIZE] DSY_SDRAM_BSS;\n` +
      `size_t ${v}_w = 0;\n` +
      `size_t ${v}_r = 0;\n` +
      `bool ${v}_frozen = false;\n` +
      `float ${v}_prev_gate = 0.f;`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `    for (size_t k = 0; k < ${v}_SIZE; ++k) ${v}_buf[k] = 0.f;`
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const g = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const bufMs = numParam(ctx.node, 'buffer_ms', 120)
    return (
      `    {\n` +
      `        size_t span = (size_t)(${bufMs} * 0.001f * sr);\n` +
      `        if (span < 1) span = 1;\n` +
      `        if (span >= ${v}_SIZE) span = ${v}_SIZE - 1;\n` +
      `        float gi = ${g};\n` +
      `        if (gi > 0.5f && ${v}_prev_gate <= 0.5f) {\n` +
      `            ${v}_frozen = true; ${v}_r = 0;\n` +
      `        }\n` +
      `        if (gi <= 0.5f && ${v}_prev_gate > 0.5f) {\n` +
      `            ${v}_frozen = false;\n` +
      `        }\n` +
      `        ${v}_prev_gate = gi;\n` +
      `        if (!${v}_frozen) {\n` +
      `            ${v}_buf[${v}_w] = ${i};\n` +
      `            ${v}_w = (${v}_w + 1) % span;\n` +
      `        }\n` +
      `        float s = ${v}_frozen ? ${v}_buf[${v}_r] : ${i};\n` +
      `        if (${v}_frozen) ${v}_r = (${v}_r + 1) % span;\n` +
      `        float ${out} = s;\n` +
      `        (void)${out};\n` +
      `    }\n` +
      `    float ${out};\n` +
      `    {\n` +
      `        size_t span = (size_t)(${bufMs} * 0.001f * sr);\n` +
      `        if (span < 1) span = 1;\n` +
      `        if (span >= ${v}_SIZE) span = ${v}_SIZE - 1;\n` +
      `        ${out} = ${v}_frozen ? ${v}_buf[(${v}_r == 0) ? span - 1 : ${v}_r - 1] : ${i};\n` +
      `    }\n`
    )
  }
}

// Cleaner freeze without double-declaration.
const freezeClean: NodeEmitter = {
  declare: freeze.declare,
  init: freeze.init,
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const g = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const bufMs = numParam(ctx.node, 'buffer_ms', 120)
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        size_t span = (size_t)(${bufMs} * 0.001f * sr);\n` +
      `        if (span < 1) span = 1;\n` +
      `        if (span >= ${v}_SIZE) span = ${v}_SIZE - 1;\n` +
      `        float gi = ${g};\n` +
      `        if (gi > 0.5f && ${v}_prev_gate <= 0.5f) { ${v}_frozen = true; ${v}_r = 0; }\n` +
      `        if (gi <= 0.5f && ${v}_prev_gate > 0.5f) { ${v}_frozen = false; }\n` +
      `        ${v}_prev_gate = gi;\n` +
      `        if (!${v}_frozen) { ${v}_buf[${v}_w] = ${i}; ${v}_w = (${v}_w + 1) % span; }\n` +
      `        if (${v}_frozen) { ${out} = ${v}_buf[${v}_r]; ${v}_r = (${v}_r + 1) % span; }\n` +
      `        else ${out} = ${i};\n` +
      `    }\n`
    )
  }
}

const pitch_shifter: NodeEmitter = {
  declare: (ctx) => `PitchShifter ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetTransposition(${numParam(ctx.node, 'semitones', 0)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const mix = numParam(ctx.node, 'mix', 1)
    return (
      `    float ${v}_wet = ${v}.Process(${i});\n` +
      `    float ${out} = (${i}) * (1.f - ${mix}) + ${v}_wet * ${mix};\n`
    )
  }
}

const tremolo: NodeEmitter = {
  declare: (ctx) => `Tremolo ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetFreq(${numParam(ctx.node, 'rate', 4)});`,
      `    ${v}.SetDepth(${numParam(ctx.node, 'depth', 0.5)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = ${v}.Process(${i});\n`
  }
}

const vibrato: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `DelayLine<float, 2048> ${v}_dl DSY_SDRAM_BSS;\n` +
      `float ${v}_phase = 0.f;`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `    ${v}_dl.Init();`
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const rate = numParam(ctx.node, 'rate', 6)
    const depth = numParam(ctx.node, 'depth', 0.3)
    return (
      `    {\n` +
      `        ${v}_phase += ${rate} / sr;\n` +
      `        if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `        float mod = sinf(${v}_phase * 2.f * (float)M_PI) * ${depth} * 0.005f * sr + 0.01f * sr;\n` +
      `        if (mod < 1.f) mod = 1.f;\n` +
      `        if (mod > 2046.f) mod = 2046.f;\n` +
      `        ${v}_dl.SetDelay(mod);\n` +
      `        ${v}_dl.Write(${i});\n` +
      `    }\n` +
      `    float ${out} = ${v}_dl.Read();\n`
    )
  }
}

const compressor: NodeEmitter = {
  declare: (ctx) => `Compressor ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetThreshold(${numParam(ctx.node, 'threshold', -20)});`,
      `    ${v}.SetRatio(${numParam(ctx.node, 'ratio', 4)});`,
      `    ${v}.SetAttack(${numParam(ctx.node, 'attack', 0.01)});`,
      `    ${v}.SetRelease(${numParam(ctx.node, 'release', 0.1)});`,
      `    ${v}.SetMakeup(${numParam(ctx.node, 'makeup', 0)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = ${v}.Process(${i});\n`
  }
}

const limiter: NodeEmitter = {
  declare: (ctx) => `Limiter ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => `    ${ctx.varName(ctx.node.id)}.Init();`,
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return (
      `    float ${v}_tmp = ${i};\n` +
      `    ${v}.ProcessBlock(&${v}_tmp, 1, 1.f);\n` +
      `    float ${out} = ${v}_tmp;\n`
    )
  }
}

const noise_gate: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_env = 0.f;\nfloat ${v}_hold_count = 0.f;\nfloat ${v}_gain = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const key = ctx.inputExpr(ctx.node.id, 'key', `(${i})`)
    const thrDb = numParam(ctx.node, 'threshold', -40)
    const atk = numParam(ctx.node, 'attack', 0.005)
    const hold = numParam(ctx.node, 'hold', 0.05)
    const rel = numParam(ctx.node, 'release', 0.1)
    return (
      `    {\n` +
      `        float k = fabsf(${key});\n` +
      `        float ca = 1.f - expf(-1.f / (sr * fmaxf(${atk}, 1e-4f)));\n` +
      `        float cr = 1.f - expf(-1.f / (sr * fmaxf(${rel}, 1e-4f)));\n` +
      `        float c = (k > ${v}_env) ? ca : cr;\n` +
      `        ${v}_env += (k - ${v}_env) * c;\n` +
      `        float thr = powf(10.f, ${thrDb} / 20.f);\n` +
      `        if (${v}_env > thr) { ${v}_gain = 1.f; ${v}_hold_count = ${hold} * sr; }\n` +
      `        else if (${v}_hold_count > 0.f) { ${v}_hold_count -= 1.f; }\n` +
      `        else { ${v}_gain += (0.f - ${v}_gain) * cr; }\n` +
      `    }\n` +
      `    float ${out} = (${i}) * ${v}_gain;\n`
    )
  }
}

// ---------------------------------------------------------------------------
// Visual / passthrough nodes
// ---------------------------------------------------------------------------

const visualPassthrough: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = ${i}; // ${ctx.node.kind}: emulator-only, passthrough on hardware\n`
  }
}

// ---------------------------------------------------------------------------
// OLED (SSD1306 over I2C)
// ---------------------------------------------------------------------------
//
// Produces libDaisy `OledDisplay<SSD130xI2c128x64Driver>` init and a
// `DrawFrame()` that renders the user-designed element list. Per-frame
// input sampling goes through `static float` caches updated each
// AudioCallback — not sample-accurate, but fine for a 30 Hz display.
//
// The emitter is defensive: if there is no hardware layout yet (parallel
// agent in flight) OR the node's `bindingId` doesn't resolve to a placed
// OLED with `sda`+`scl` pins, we emit default I2C1 pins (D11/D12 on the
// Daisy Seed) and attach a `warn(...)` so the user sees it.

const OLED_INPUT_SOCKETS: ReadonlyArray<'a' | 'b' | 'c' | 'd' | 'e' | 'f'> = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f'
]

interface OledElement {
  kind: string
  x?: number
  y?: number
  text?: string
  size?: number
  binding?: string
  decimals?: number
  unit?: string
  width?: number
  height?: number
  orientation?: string
  radius?: number
  fill?: boolean
  x2?: number
  y2?: number
  cols?: number
  rows?: number
  cellSize?: number
}

function parseOledElements(raw: unknown): OledElement[] {
  if (typeof raw !== 'string') return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data as OledElement[]
  } catch {
    return []
  }
}

function sanitizeCString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function bindingToCache(b: unknown, v: string): string {
  if (typeof b !== 'string') return '0.f'
  const idx = OLED_INPUT_SOCKETS.indexOf(b as 'a')
  if (idx < 0) return '0.f'
  return `${v}_in_${b}`
}

const oled: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lines: string[] = []
    lines.push(`using ${v}_Type = OledDisplay<SSD130xI2c128x64Driver>;`)
    lines.push(`${v}_Type ${v};`)
    for (const sock of OLED_INPUT_SOCKETS) {
      lines.push(`float ${v}_in_${sock} = 0.f;`)
    }
    lines.push(`uint32_t ${v}_last_frame_ms = 0;`)
    return lines.join('\n')
  },

  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const bindingId =
      typeof ctx.node.params.bindingId === 'string'
        ? ctx.node.params.bindingId
        : ''
    const hw = ctx.hardware

    let sdaPin: string | null = null
    let sclPin: string | null = null
    let bindingLabel: string | null = null
    if (bindingId && hw) {
      const comp = hw.components.find((c) => c.id === bindingId)
      if (comp) {
        const sda = comp.pins['sda']
        const scl = comp.pins['scl']
        if (sda) sdaPin = sda
        if (scl) sclPin = scl
        bindingLabel = comp.label
      }
    }

    if (!sdaPin || !sclPin) {
      ctx.warn('oled not bound to hardware; using default I2C1 pins (D11/D12)')
      sdaPin = sdaPin ?? 'D12'
      sclPin = sclPin ?? 'D11'
    }

    const sdaD = parseInt(sdaPin.slice(1), 10)
    const sclD = parseInt(sclPin.slice(1), 10)

    return [
      `    // --- OLED: ${bindingLabel ?? 'unbound — default I2C1 pins'} ---`,
      `    {`,
      `        ${v}_Type::Config oled_cfg;`,
      `        oled_cfg.driver_config.transport_config.i2c_config.mode   = I2CHandle::Config::Mode::I2C_MASTER;`,
      `        oled_cfg.driver_config.transport_config.i2c_config.periph = I2CHandle::Config::Peripheral::I2C_1;`,
      `        oled_cfg.driver_config.transport_config.i2c_config.speed  = I2CHandle::Config::Speed::I2C_400KHZ;`,
      `        oled_cfg.driver_config.transport_config.i2c_config.pin_config.scl = hw.GetPin(${sclD});`,
      `        oled_cfg.driver_config.transport_config.i2c_config.pin_config.sda = hw.GetPin(${sdaD});`,
      `        oled_cfg.driver_config.transport_config.i2c_address = 0x3C;`,
      `        ${v}.Init(oled_cfg);`,
      `    }`
    ].join('\n')
  },

  /**
   * Per-AudioCallback sample: latch the current input values into the
   * per-node caches so `DrawFrame()` (invoked outside AudioCallback) sees
   * stable values. No audio outputs — the node is a sink.
   */
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const elements = parseOledElements(ctx.node.params.elements)
    if (elements.length > 12) {
      ctx.warn('oled draw is approximate at high element counts')
    }

    const lines: string[] = []
    lines.push(`    // --- OLED ${v}: latch input samples for DrawFrame() ---`)
    for (const sock of OLED_INPUT_SOCKETS) {
      const expr = ctx.inputExpr(ctx.node.id, sock, '0.f')
      lines.push(`    ${v}_in_${sock} = ${expr};`)
    }

    // Emit a DrawFrame() body as a block-comment guide for the hardware-
    // integration pass. Inlining the real call here would fire from
    // AudioCallback which is too expensive; the while(1) in main() is the
    // right place (to be wired by the hardware-view integration).
    const drawBody: string[] = []
    drawBody.push(`    // DrawFrame body (call from while(1) at ~30 Hz):`)
    drawBody.push(`    //   ${v}.Fill(false);`)
    for (const el of elements) {
      const k = el.kind
      const x = typeof el.x === 'number' ? el.x | 0 : 0
      const y = typeof el.y === 'number' ? el.y | 0 : 0
      if (k === 'text') {
        const t = sanitizeCString(typeof el.text === 'string' ? el.text : '')
        const fontExpr = el.size === 2 ? 'Font_11x18' : 'Font_6x8'
        drawBody.push(
          `    //   ${v}.SetCursor(${x}, ${y}); ${v}.WriteString("${t}", ${fontExpr}, true);`
        )
      } else if (k === 'value') {
        const cache = bindingToCache(el.binding, v)
        const decimals = typeof el.decimals === 'number' ? el.decimals | 0 : 2
        const unit = sanitizeCString(typeof el.unit === 'string' ? el.unit : '')
        const fontExpr = el.size === 2 ? 'Font_11x18' : 'Font_6x8'
        drawBody.push(
          `    //   { char buf[24]; snprintf(buf, sizeof buf, "%.${decimals}f${unit}", ${cache});`
        )
        drawBody.push(
          `    //     ${v}.SetCursor(${x}, ${y}); ${v}.WriteString(buf, ${fontExpr}, true); }`
        )
      } else if (k === 'meter') {
        const cache = bindingToCache(el.binding, v)
        const w = typeof el.width === 'number' ? el.width | 0 : 40
        const h = typeof el.height === 'number' ? el.height | 0 : 8
        if (el.orientation === 'v') {
          drawBody.push(`    //   { float mv = fabsf(${cache}); if (mv > 1.f) mv = 1.f;`)
          drawBody.push(`    //     int fh = (int)(mv * (float)(${h - 2}));`)
          drawBody.push(`    //     ${v}.DrawRect(${x}, ${y}, ${x + w}, ${y + h}, true, false);`)
          drawBody.push(
            `    //     ${v}.DrawRect(${x + 1}, ${y + h - 1} - fh, ${x + w - 1}, ${y + h - 1}, true, true); }`
          )
        } else {
          drawBody.push(`    //   { float mv = fabsf(${cache}); if (mv > 1.f) mv = 1.f;`)
          drawBody.push(`    //     int fw = (int)(mv * (float)(${w - 2}));`)
          drawBody.push(`    //     ${v}.DrawRect(${x}, ${y}, ${x + w}, ${y + h}, true, false);`)
          drawBody.push(
            `    //     ${v}.DrawRect(${x + 1}, ${y + 1}, ${x + 1} + fw, ${y + h - 1}, true, true); }`
          )
        }
      } else if (k === 'scope') {
        const cache = bindingToCache(el.binding, v)
        const w = typeof el.width === 'number' ? el.width | 0 : 64
        const h = typeof el.height === 'number' ? el.height | 0 : 24
        drawBody.push(`    //   { // scope placeholder — single-sample sparkline:`)
        drawBody.push(
          `    //     int midY = ${y + (h >> 1)}; int pxY = midY - (int)(${cache} * (float)(${h >> 1}));`
        )
        drawBody.push(
          `    //     for (int xx = 0; xx < ${w}; xx++) ${v}.DrawPixel(${x} + xx, pxY, true); }`
        )
      } else if (k === 'rect') {
        const w = typeof el.width === 'number' ? el.width | 0 : 20
        const h = typeof el.height === 'number' ? el.height | 0 : 12
        const fillArg = el.fill === true ? 'true' : 'false'
        drawBody.push(
          `    //   ${v}.DrawRect(${x}, ${y}, ${x + w}, ${y + h}, true, ${fillArg});`
        )
      } else if (k === 'circle') {
        const r = typeof el.radius === 'number' ? el.radius | 0 : 6
        drawBody.push(`    //   ${v}.DrawCircle(${x}, ${y}, ${r}, true);`)
      } else if (k === 'line') {
        const x2 = typeof el.x2 === 'number' ? el.x2 | 0 : x + 8
        const y2 = typeof el.y2 === 'number' ? el.y2 | 0 : y
        drawBody.push(`    //   ${v}.DrawLine(${x}, ${y}, ${x2}, ${y2}, true);`)
      } else if (k === 'pattern') {
        const cache = bindingToCache(el.binding, v)
        const cols = typeof el.cols === 'number' ? el.cols | 0 : 8
        const rows = typeof el.rows === 'number' ? el.rows | 0 : 2
        const cell = typeof el.cellSize === 'number' ? el.cellSize | 0 : 4
        drawBody.push(`    //   { float pv = fabsf(${cache}); if (pv > 1.f) pv = 1.f;`)
        drawBody.push(`    //     int lit = (int)(pv * (float)(${cols * rows}));`)
        drawBody.push(
          `    //     for (int rr = 0; rr < ${rows}; rr++) for (int cc = 0; cc < ${cols}; cc++) {`
        )
        drawBody.push(`    //       int idx = rr * ${cols} + cc;`)
        drawBody.push(
          `    //       ${v}.DrawRect(${x} + cc * ${cell}, ${y} + rr * ${cell}, ${x} + cc * ${cell} + ${cell - 1}, ${y} + rr * ${cell} + ${cell - 1}, true, idx < lit);`
        )
        drawBody.push(`    //     } }`)
      }
    }
    drawBody.push(`    //   ${v}.Update();`)
    lines.push(drawBody.join('\n'))
    return lines.join('\n') + '\n'
  }
}

// ---------------------------------------------------------------------------
// Hardware I/O
// ---------------------------------------------------------------------------

const audio_in: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    return `    float ${l} = in_l;\n    float ${r} = in_r;\n`
  }
}

/**
 * audio_output doesn't emit output vars — the emitter main loop picks up its
 * input exprs directly when wiring to `out[0][i]` / `out[1][i]`.
 */
const audio_output: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: () => ''
}

const knob_in: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    // Prefer hardware binding when present — `_val` in the binding case
    // comes from the ADC poll loop emitted by emitHardwareInit; the
    // legacy fallback uses the node-local `_val` (0 on the target; the
    // emulator polls it via setParam('value')).
    const bindingId = typeof ctx.node.params.bindingId === 'string'
      ? ctx.node.params.bindingId : ''
    const bound = bindingId && ctx.hardware
      ? valueExprForBinding(bindingId, 'wiper', ctx.hardware)
      : null
    const expr = bound ?? `${v}_val`
    return `    float ${out} = ${expr};\n`
  }
}

const gate_in: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const bindingId = typeof ctx.node.params.bindingId === 'string'
      ? ctx.node.params.bindingId : ''
    const bound = bindingId && ctx.hardware
      ? valueExprForBinding(bindingId, 'io', ctx.hardware)
      : null
    const expr = bound ?? `${v}_val`
    return `    float ${out} = ${expr};\n`
  }
}

// ---------------------------------------------------------------------------
// Hardware-bound digital + I2S + MIDI + scripting / debug emitters
// ---------------------------------------------------------------------------
//
// These cover the 10 nodes added in `defs.hardware.ts`. Each of the
// hardware-bound emitters (button, led, switch_3way, i2s_in, i2s_out)
// looks up its placed component via `resolveBinding` / `valueExprForBinding`
// when a hardware layout is present. When the layout isn't available yet
// (e.g. a parallel agent is still building the hardware view) or the
// binding is missing, the emitter leaves a `// TODO: bind <kind> ...`
// comment and pushes a warning — generated code still compiles.
//
// MIDI nodes assume Daisy's USB-device-class MIDI interface. The
// `midi_in_note` emitter owns the shared `MidiUsbHandler midi;`
// declaration and the `midi.Init()/StartReceive()` init hook. If a
// user places MIDI nodes without a note-in, `midi_in_cc` and
// `midi_out_note` will reference `midi` that doesn't exist — the
// generated main.cpp flags that as a compile error, which is the loud
// behaviour we want until the hardware view integration lands and can
// centralise peripheral init.
//
// Rising-edge detection uses a `static uint32_t <var>_last_gate` pattern
// so it survives AudioCallback invocations between blocks — same idea as
// the worklet's class field.

function bindingIdOf(node: NodeInstance): string {
  const raw = node.params.bindingId
  return typeof raw === 'string' ? raw : ''
}

const button: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const bid = bindingIdOf(ctx.node)
    const bound = bid && ctx.hardware
      ? valueExprForBinding(bid, 'io', ctx.hardware)
      : null
    if (!bound) {
      if (bid) ctx.warn(`button ${ctx.node.id}: binding ${bid} not resolvable; emitting stub`)
      else ctx.warn(`button ${ctx.node.id}: unbound — bind it in the hardware view`)
      return `    // TODO: bind button in hardware view\n    float ${out} = ${v}_val;\n`
    }
    return `    float ${out} = ${bound};\n`
  }
}

const led: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const bid = bindingIdOf(ctx.node)
    const threshold = numParam(ctx.node, 'threshold', 0.5)
    const mode = enumParam(ctx.node, 'mode', 'gate')
    const inExpr = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const r = bid && ctx.hardware
      ? resolveBinding(ctx.node.id, bid, 'anode', ctx.hardware)
      : null
    if (!r) {
      if (bid) ctx.warn(`led ${ctx.node.id}: binding ${bid} not resolvable; emitting stub`)
      else ctx.warn(`led ${ctx.node.id}: unbound — bind it in the hardware view`)
      return `    // TODO: bind led in hardware view (mode=${mode})\n    (void)(${inExpr});\n`
    }
    const pinVar = `${hwVar(r.component)}_gpio`
    if (mode === 'pwm' || mode === 'follow') {
      // Coarse PWM via a fast phase counter. Real hardware PWM lives on
      // a future pass with a PWM peripheral; this still gives visible
      // brightness feedback.
      return (
        `    {\n` +
        `        static uint32_t ${pinVar}_pwm_phase = 0;\n` +
        `        float mag = (${inExpr}); if (mag < 0.f) mag = -mag;\n` +
        `        ${pinVar}_pwm_phase = (${pinVar}_pwm_phase + 1u) & 0xff;\n` +
        `        float duty = (${pinVar}_pwm_phase / 256.f);\n` +
        `        ${pinVar}.Write(mag > duty ? 1 : 0);\n` +
        `    }\n`
      )
    }
    // gate mode
    return `    ${pinVar}.Write(((${inExpr}) > ${threshold}) ? 1 : 0);\n`
  }
}

const switch_3way: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const bid = bindingIdOf(ctx.node)
    const r = bid && ctx.hardware
      ? resolveBinding(ctx.node.id, bid, 'pos1', ctx.hardware)
      : null
    if (!r) {
      if (bid) ctx.warn(`switch_3way ${ctx.node.id}: binding ${bid} not resolvable; emitting stub`)
      else ctx.warn(`switch_3way ${ctx.node.id}: unbound — bind it in the hardware view`)
      const posRaw = enumParam(ctx.node, 'position', '0')
      const posNum = posRaw === '-1' ? -1 : posRaw === '1' ? 1 : 0
      return `    // TODO: bind switch_3way in hardware view\n    float ${out} = ${formatFloat(posNum)}; (void)${v}_val;\n`
    }
    const p1 = `${hwVar(r.component)}_pos1_gpio`
    const p2 = `${hwVar(r.component)}_pos2_gpio`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        bool p1 = !${p1}.Read();\n` +
      `        bool p2 = !${p2}.Read();\n` +
      `        ${out} = p1 ? -1.f : (p2 ? 1.f : 0.f);\n` +
      `    }\n`
    )
  }
}

const i2s_in: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    const bid = bindingIdOf(ctx.node)
    if (!bid || !ctx.hardware || !resolveBinding(ctx.node.id, bid, 'sd_in', ctx.hardware)) {
      if (bid) ctx.warn(`i2s_in ${ctx.node.id}: binding ${bid} not resolvable; emitting silence`)
      else ctx.warn(`i2s_in ${ctx.node.id}: unbound — bind an i2s_codec in the hardware view`)
      return `    // TODO: bind i2s_in in hardware view\n    float ${l} = 0.f;\n    float ${r} = 0.f;\n`
    }
    // Secondary SAI callback updates globals `i2s_in_l` / `i2s_in_r`.
    return `    float ${l} = i2s_in_l;\n    float ${r} = i2s_in_r;\n`
  }
}

const i2s_out: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const lExpr = ctx.inputExpr(ctx.node.id, 'left', '0.f')
    const rExpr = ctx.inputExpr(ctx.node.id, 'right', '0.f')
    const bid = bindingIdOf(ctx.node)
    if (!bid || !ctx.hardware || !resolveBinding(ctx.node.id, bid, 'sd_out', ctx.hardware)) {
      if (bid) ctx.warn(`i2s_out ${ctx.node.id}: binding ${bid} not resolvable; emitting stub`)
      else ctx.warn(`i2s_out ${ctx.node.id}: unbound — bind an i2s_codec in the hardware view`)
      return `    // TODO: bind i2s_out in hardware view\n    (void)(${lExpr}); (void)(${rExpr});\n`
    }
    return `    i2s_out_l = ${lExpr};\n    i2s_out_r = ${rExpr};\n`
  }
}

// --- MIDI ---------------------------------------------------------------

/** Channel string ('1'..'16'|'all') -> zero-based channel or -1 for all. */
function midiChannelNum(node: NodeInstance): number {
  const raw = enumParam(node, 'channel', '1')
  if (raw === 'all') return -1
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > 16) return 0
  return n - 1
}

const midi_in_note: NodeEmitter = {
  declare: () => [
    'MidiUsbHandler midi;',
    '// MIDI note-in latched state (channel-filtered in main loop).',
    'volatile int midi_latched_note = -1;',
    'volatile float midi_latched_vel = 0.f;',
    'volatile float midi_latched_gate = 0.f;'
  ].join('\n'),
  init: () => '    midi.Init();\n    midi.StartReceive();',
  process: (ctx) => {
    const pitchOut = ctx.outputVar(ctx.node.id, 'pitch')
    const gateOut = ctx.outputVar(ctx.node.id, 'gate')
    const velOut = ctx.outputVar(ctx.node.id, 'velocity')
    // Channel filtering happens in the (not-yet-generated) main() MIDI
    // event dispatcher; the audio callback just reads the latched values.
    void midiChannelNum(ctx.node)
    return (
      `    float ${pitchOut} = midi_latched_note >= 0 ? ((float)midi_latched_note - 60.f) / 12.f : 0.f;\n` +
      `    float ${gateOut} = midi_latched_gate;\n` +
      `    float ${velOut} = midi_latched_vel;\n`
    )
  }
}

const midi_in_cc: NodeEmitter = {
  declare: () =>
    'static float midi_cc_table[128] = {0};\n' +
    'static bool midi_cc_received = false;',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const ccIdx = Math.max(0, Math.min(127, rawNum(ctx.node, 'cc', 1) | 0))
    const testValue = numParam(ctx.node, 'test_value', 0)
    return (
      `    float ${out} = midi_cc_received ? midi_cc_table[${ccIdx}] : ${testValue};\n`
    )
  }
}

const midi_out_note: NodeEmitter = {
  declare: (ctx) =>
    `static uint32_t ${ctx.varName(ctx.node.id)}_last_gate = 0;\n` +
    `static int ${ctx.varName(ctx.node.id)}_active_note = -1;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const ch = midiChannelNum(ctx.node)
    const chByte = ch < 0 ? 0 : ch
    const pitchExpr = ctx.inputExpr(ctx.node.id, 'pitch', '0.f')
    const gateExpr = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const velExpr = ctx.inputExpr(ctx.node.id, 'velocity', '1.f')
    return (
      `    {\n` +
      `        uint32_t now = ((${gateExpr}) > 0.5f) ? 1 : 0;\n` +
      `        if (now && !${v}_last_gate) {\n` +
      `            int note = 60 + (int)lroundf((${pitchExpr}) * 12.f);\n` +
      `            if (note < 0) note = 0; if (note > 127) note = 127;\n` +
      `            float vel = ${velExpr}; if (vel < 0.f) vel = 0.f; if (vel > 1.f) vel = 1.f;\n` +
      `            uint8_t msg[3] = { (uint8_t)(0x90 | ${chByte}), (uint8_t)note, (uint8_t)(vel * 127.f) };\n` +
      `            midi.SendMessage(msg, 3);\n` +
      `            ${v}_active_note = note;\n` +
      `        } else if (!now && ${v}_last_gate) {\n` +
      `            if (${v}_active_note >= 0) {\n` +
      `                uint8_t msg[3] = { (uint8_t)(0x80 | ${chByte}), (uint8_t)${v}_active_note, 0 };\n` +
      `                midi.SendMessage(msg, 3);\n` +
      `                ${v}_active_note = -1;\n` +
      `            }\n` +
      `        }\n` +
      `        ${v}_last_gate = now;\n` +
      `    }\n`
    )
  }
}

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

const expression: NodeEmitter = {
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

const printNode: NodeEmitter = {
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

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

export const NODE_EMITTERS: Partial<Record<NodeKind, NodeEmitter>> = {
  // Sources
  oscillator,
  noise,
  lfo,
  constant,
  karplus,
  fm_op: fm_op_clean,
  fm2,
  wavetable,
  drum_kick,
  drum_snare,
  drum_hat,
  // Utility
  gain,
  vca,
  mixer4,
  pan,
  clip,
  sum: sumNode,
  multiply: multiplyNode,
  crossfade,
  ring_mod,
  wavefolder,
  // Filters
  filter_svf,
  filter_moog,
  formant,
  // Envelopes
  adsr,
  ar,
  envelope_follower,
  // CV
  slew,
  sample_hold,
  inverter,
  scale: scaleNode,
  comparator,
  // Sequencing
  clock: clockNode,
  clock_divider,
  step_seq,
  euclidean,
  random: randomNode,
  dust: dustClean,
  arp,
  // Effects
  delay,
  reverb,
  overdrive,
  chorus,
  bitcrush,
  phaser,
  flanger,
  ping_pong,
  stereo_widener,
  freeze: freezeClean,
  granulator: makePassthrough('granulator not yet supported in codegen — passthrough'),
  pitch_shifter,
  tremolo,
  vibrato,
  // Dynamics
  compressor,
  limiter,
  noise_gate,
  // Visual
  scope: visualPassthrough,
  vu: visualPassthrough,
  spectrum_scope: visualPassthrough,
  oled,
  // Hardware I/O
  audio_in,
  audio_output,
  knob_in,
  gate_in,
  button,
  led,
  switch_3way,
  i2s_in,
  i2s_out,
  // MIDI
  midi_in_note,
  midi_in_cc,
  midi_out_note,
  // Scripting / debug
  expression,
  print: printNode
}

// Prevent unused warnings for the retained-but-superseded helpers.
void fm_op
void dust
void freeze
void NOOP
