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
    const freq = numParam(ctx.node, 'frequency', 1)
    const depth = numParam(ctx.node, 'depth', 1)
    const offset = numParam(ctx.node, 'offset', 0)
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const offsetCvExpr = ctx.inputExpr(ctx.node.id, 'cv_offset', '__NC__')
    const freqExpr = rateCvExpr === '__NC__' ? `${freq}` : `fmaxf(0.01f, fminf(20.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    const offsetExpr = offsetCvExpr === '__NC__' ? `${offset}` : `fmaxf(-1.f, fminf(1.f, ${offsetCvExpr}))`
    const setFreqLine = rateCvExpr === '__NC__' ? `` : `    ${v}.SetFreq(${freqExpr});\n`
    return (
      `${setFreqLine}` +
      `    float ${out} = ${v}.Process() * (${depthExpr}) + (${offsetExpr});\n`
    )
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
    const freq = numParam(ctx.node, 'frequency', 220)
    const damping = numParam(ctx.node, 'damping', 0.5)
    const feedback = numParam(ctx.node, 'feedback', 0.99)
    const pitchExpr = ctx.inputExpr(ctx.node.id, 'cv_pitch', '__NC__')
    const decayExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const dampExpr = ctx.inputExpr(ctx.node.id, 'cv_damp', '__NC__')
    const fExpr = pitchExpr === '__NC__'
      ? freq
      : `fmaxf(20.f, fminf(2000.f, ${pitchExpr}))`
    const fbExpr = decayExpr === '__NC__'
      ? feedback
      : `fmaxf(0.9f, fminf(0.999f, ${decayExpr}))`
    const dExpr = dampExpr === '__NC__'
      ? damping
      : `fmaxf(0.f, fminf(1.f, ${dampExpr}))`
    return (
      `    static float ${prev} = 0.f;\n` +
      `    ${v}.SetFreq(${fExpr});\n` +
      `    ${v}.SetBrightness(${fbExpr});\n` +
      `    ${v}.SetDamping(${dExpr});\n` +
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

// 1:1 port of `src/audio/worklets/fm_op.worklet.ts`. Phase is tracked in
// RADIANS so modulation and feedback sum cleanly before the sin() call —
// that matches the worklet (prior version tracked phase in 0..1 which made
// the mod/feedback contribution the wrong scale and produced harsh noise).
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
    const ampCvExpr = ctx.inputExpr(ctx.node.id, 'cv_amp', '__NC__')
    const modIdxExpr = ctx.inputExpr(ctx.node.id, 'cv_mod_index', '__NC__')
    const freq = numParam(ctx.node, 'frequency', 220)
    const ratio = numParam(ctx.node, 'ratio', 1)
    const amp = numParam(ctx.node, 'amplitude', 0.7)
    const fb = numParam(ctx.node, 'feedback', 0)
    const ampExpr = ampCvExpr === '__NC__'
      ? amp
      : `fmaxf(0.f, fminf(1.f, ${ampCvExpr}))`
    const fbExpr = modIdxExpr === '__NC__'
      ? fb
      : `fmaxf(0.f, fminf(1.f, ${modIdxExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        const float TWO_PI = 2.f * (float)M_PI;\n` +
      `        float f = ${freq} * ${ratio} * powf(2.f, ${pitchCv});\n` +
      `        if (f < 0.f) f = 0.f;\n` +
      `        float nyq = sr * 0.5f;\n` +
      `        if (f > nyq) f = nyq;\n` +
      `        float inc = TWO_PI * f / sr;\n` +
      `        float _amp = ${ampExpr};\n` +
      `        float _fb = ${fbExpr};\n` +
      `        float y = sinf(${v}_phase + (${mod}) + _fb * ${v}_last) * _amp;\n` +
      `        if (!isfinite(y)) y = 0.f;\n` +
      `        if (y > 1.f) y = 1.f; else if (y < -1.f) y = -1.f;\n` +
      `        ${v}_last = y;\n` +
      `        ${v}_phase += inc;\n` +
      `        if (${v}_phase >= TWO_PI) ${v}_phase -= TWO_PI;\n` +
      `        else if (${v}_phase < 0.f) ${v}_phase += TWO_PI;\n` +
      `        ${out} = y;\n` +
      `    }\n`
    )
  }
}

// 1:1 port of `src/audio/worklets/fm2.worklet.ts`. Two sine operators: a
// modulator phase-modulates the carrier. Carrier phase, mod phase kept as
// file-scope float state so they persist across callback invocations.
// (DaisySP's Fm2 was previously used here but produced audible noise for
// the user — porting the worklet math directly removes that surprise.)
const fm2: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_carrier_phase = 0.f;\nfloat ${v}_mod_phase = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const pitchCv = ctx.inputExpr(ctx.node.id, 'pitch_cv', '0.f')
    const ampCv = ctx.inputExpr(ctx.node.id, 'amp_cv', '1.f')
    const modIdxExpr = ctx.inputExpr(ctx.node.id, 'cv_mod_index', '__NC__')
    const freq = numParam(ctx.node, 'frequency', 220)
    const modRatio = numParam(ctx.node, 'mod_ratio', 2)
    const modIndex = numParam(ctx.node, 'mod_index', 3)
    const amp = numParam(ctx.node, 'carrier_amp', 0.7)
    const idxExpr = modIdxExpr === '__NC__'
      ? modIndex
      : `fmaxf(0.f, fminf(20.f, ${modIdxExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        const float TWO_PI = 2.f * (float)M_PI;\n` +
      `        float cvPitch = ${pitchCv};\n` +
      `        float carrierFreq = ${freq} * powf(2.f, cvPitch);\n` +
      `        if (carrierFreq < 0.f) carrierFreq = 0.f;\n` +
      `        float nyq = sr * 0.5f;\n` +
      `        if (carrierFreq > nyq) carrierFreq = nyq;\n` +
      `        float modFreq = carrierFreq * ${modRatio};\n` +
      `        if (modFreq > nyq) modFreq = nyq;\n` +
      `        float cInc = TWO_PI * carrierFreq / sr;\n` +
      `        float mInc = TWO_PI * modFreq / sr;\n` +
      `        float _idx = ${idxExpr};\n` +
      `        float mod = sinf(${v}_mod_phase) * _idx;\n` +
      `        float y = sinf(${v}_carrier_phase + mod) * (${amp}) * (${ampCv});\n` +
      `        if (!isfinite(y)) y = 0.f;\n` +
      `        if (y > 1.f) y = 1.f; else if (y < -1.f) y = -1.f;\n` +
      `        ${v}_carrier_phase += cInc;\n` +
      `        if (${v}_carrier_phase >= TWO_PI) ${v}_carrier_phase -= TWO_PI;\n` +
      `        else if (${v}_carrier_phase < 0.f) ${v}_carrier_phase += TWO_PI;\n` +
      `        ${v}_mod_phase += mInc;\n` +
      `        if (${v}_mod_phase >= TWO_PI) ${v}_mod_phase -= TWO_PI;\n` +
      `        else if (${v}_mod_phase < 0.f) ${v}_mod_phase += TWO_PI;\n` +
      `        ${out} = y;\n` +
      `    }\n`
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
    // Four tables represented as mixes of harmonics. Declare `${out}`
    // at callback scope (not inside the block) so downstream nodes can
    // reference it.
    return (
      `    float ${out};\n` +
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
      `        ${out} = (a + (b - a) * frac) * ${amp};\n` +
      `    }\n`
    )
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
      // DaisySP drum voices expose `Trig()` (level-independent edge), not
      // `SetTrigger(bool)`. We detect the rising edge of the input gate and
      // call Trig() once per edge — matches the JS worklet's behavior.
      return (
        `    static float ${prev} = 0.f;\n` +
        `    float ${v}_tin = ${trig};\n` +
        `    bool ${v}_edge = (${v}_tin >= 0.5f) && (${prev} < 0.5f);\n` +
        `    ${prev} = ${v}_tin;\n` +
        `    if (${v}_edge) ${v}.Trig();\n` +
        `    float ${out} = ${v}.Process(false);\n`
      )
    }
  }
}

// Keep factory reference to avoid unused-symbol errors.
void drumEmitter

const drum_kick: NodeEmitter = {
  declare: (ctx) => `AnalogBassDrum ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetFreq(${numParam(ctx.node, 'tune', 60)});`,
      `    ${v}.SetDecay(${numParam(ctx.node, 'decay', 0.35)});`,
      `    ${v}.SetAttackFmAmount(${numParam(ctx.node, 'punch', 0.5)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const prev = `${v}_prev_trig`
    const tune = numParam(ctx.node, 'tune', 60)
    const decay = numParam(ctx.node, 'decay', 0.35)
    const punch = numParam(ctx.node, 'punch', 0.5)
    const tuneExpr = ctx.inputExpr(ctx.node.id, 'cv_tune', '__NC__')
    const decayExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const punchExpr = ctx.inputExpr(ctx.node.id, 'cv_punch', '__NC__')
    const fExpr = tuneExpr === '__NC__' ? tune : `fmaxf(30.f, fminf(200.f, ${tuneExpr}))`
    const dExpr = decayExpr === '__NC__' ? decay : `fmaxf(0.05f, fminf(2.f, ${decayExpr}))`
    const pExpr = punchExpr === '__NC__' ? punch : `fmaxf(0.f, fminf(1.f, ${punchExpr}))`
    return (
      `    static float ${prev} = 0.f;\n` +
      `    ${v}.SetFreq(${fExpr});\n` +
      `    ${v}.SetDecay(${dExpr});\n` +
      `    ${v}.SetAttackFmAmount(${pExpr});\n` +
      `    float ${v}_tin = ${trig};\n` +
      `    bool ${v}_edge = (${v}_tin >= 0.5f) && (${prev} < 0.5f);\n` +
      `    ${prev} = ${v}_tin;\n` +
      `    if (${v}_edge) ${v}.Trig();\n` +
      `    float ${out} = ${v}.Process(false);\n`
    )
  }
}

const drum_snare: NodeEmitter = {
  declare: (ctx) => `AnalogSnareDrum ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetFreq(${numParam(ctx.node, 'tune', 200)});`,
      `    ${v}.SetDecay(${numParam(ctx.node, 'decay', 0.2)});`,
      `    ${v}.SetSnappy(${numParam(ctx.node, 'tone', 0.5)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const prev = `${v}_prev_trig`
    const tune = numParam(ctx.node, 'tune', 200)
    const decay = numParam(ctx.node, 'decay', 0.2)
    const tone = numParam(ctx.node, 'tone', 0.5)
    const tuneExpr = ctx.inputExpr(ctx.node.id, 'cv_tune', '__NC__')
    const decayExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const noiseExpr = ctx.inputExpr(ctx.node.id, 'cv_noise', '__NC__')
    const fExpr = tuneExpr === '__NC__' ? tune : `fmaxf(100.f, fminf(400.f, ${tuneExpr}))`
    const dExpr = decayExpr === '__NC__' ? decay : `fmaxf(0.05f, fminf(1.f, ${decayExpr}))`
    const nExpr = noiseExpr === '__NC__' ? tone : `fmaxf(0.f, fminf(1.f, ${noiseExpr}))`
    return (
      `    static float ${prev} = 0.f;\n` +
      `    ${v}.SetFreq(${fExpr});\n` +
      `    ${v}.SetDecay(${dExpr});\n` +
      `    ${v}.SetSnappy(${nExpr});\n` +
      `    float ${v}_tin = ${trig};\n` +
      `    bool ${v}_edge = (${v}_tin >= 0.5f) && (${prev} < 0.5f);\n` +
      `    ${prev} = ${v}_tin;\n` +
      `    if (${v}_edge) ${v}.Trig();\n` +
      `    float ${out} = ${v}.Process(false);\n`
    )
  }
}

const drum_hat: NodeEmitter = {
  declare: (ctx) => `HiHat<> ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetDecay(${numParam(ctx.node, 'decay', 0.08)});`,
      `    ${v}.SetTone(${numParam(ctx.node, 'tone', 0.7)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const prev = `${v}_prev_trig`
    const decay = numParam(ctx.node, 'decay', 0.08)
    const tone = numParam(ctx.node, 'tone', 0.7)
    const decayExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const toneExpr = ctx.inputExpr(ctx.node.id, 'cv_tone', '__NC__')
    const dExpr = decayExpr === '__NC__' ? decay : `fmaxf(0.01f, fminf(0.5f, ${decayExpr}))`
    const tExpr = toneExpr === '__NC__' ? tone : `fmaxf(0.3f, fminf(1.f, ${toneExpr}))`
    return (
      `    static float ${prev} = 0.f;\n` +
      `    ${v}.SetDecay(${dExpr});\n` +
      `    ${v}.SetTone(${tExpr});\n` +
      `    float ${v}_tin = ${trig};\n` +
      `    bool ${v}_edge = (${v}_tin >= 0.5f) && (${prev} < 0.5f);\n` +
      `    ${prev} = ${v}_tin;\n` +
      `    if (${v}_edge) ${v}.Trig();\n` +
      `    float ${out} = ${v}.Process(false);\n`
    )
  }
}

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
    const gainExpr = ctx.inputExpr(ctx.node.id, 'cv_gain', '__NC__')
    // cv_gain replaces sidebar directly; legacy `cv` still multiplies.
    const baseExpr = gainExpr === '__NC__' ? `${g}` : `fmaxf(0.f, fminf(2.f, ${gainExpr}))`
    return `    float ${out} = (${i}) * (${baseExpr}) * (${cv});\n`
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
      const lvlExpr = ctx.inputExpr(ctx.node.id, `cv_level${i}`, '__NC__')
      const gExpr = lvlExpr === '__NC__'
        ? `${g}`
        : `fmaxf(0.f, fminf(2.f, ${lvlExpr}))`
      parts.push(`(${sig}) * (${gExpr})`)
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
    const panExpr = ctx.inputExpr(ctx.node.id, 'cv_pan', '__NC__')
    // cv_pan replaces sidebar; legacy `cv` still offsets.
    const rootExpr = panExpr === '__NC__'
      ? `${pn}`
      : `fmaxf(-1.f, fminf(1.f, ${panExpr}))`
    return (
      `    float ${l}, ${r};\n` +
      `    {\n` +
      `        float p = (${rootExpr}) + (${cv});\n` +
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
    const driveCvExpr = ctx.inputExpr(ctx.node.id, 'cv_drive', '__NC__')
    const dExpr = driveCvExpr === '__NC__'
      ? `${drive}`
      : `fmaxf(1.f, fminf(20.f, ${driveCvExpr}))`
    if (mode === 'tanh') {
      return `    float ${out} = tanhf((${i}) * (${dExpr}));\n`
    }
    if (mode === 'soft') {
      return (
        `    float ${out};\n` +
        `    {\n` +
        `        float x = (${i}) * (${dExpr});\n` +
        `        ${out} = x / (1.f + fabsf(x));\n` +
        `    }\n`
      )
    }
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float x = (${i}) * (${dExpr});\n` +
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
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const mBase = mixCvExpr === '__NC__'
      ? `${mix}`
      : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float m = (${mBase}) + (${cv});\n` +
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
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _m = (${mixExpr});\n` +
      `        float dry = ${a};\n` +
      `        float wet = (${a}) * (${b});\n` +
      `        ${out} = dry * (1.f - _m) + wet * _m;\n` +
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
    const biasCvExpr = ctx.inputExpr(ctx.node.id, 'cv_bias', '__NC__')
    const fold = numParam(ctx.node, 'fold', 1)
    const bias = numParam(ctx.node, 'bias', 0)
    const biasExpr = biasCvExpr === '__NC__'
      ? bias
      : `fmaxf(-1.f, fminf(1.f, ${biasCvExpr}))`
    return `    float ${out} = sinf((float)M_PI * ((${i}) + (${biasExpr})) * (${fold} + (${cv})));\n`
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
    const res = numParam(ctx.node, 'resonance', 0.2)
    const cutoffExpr = ctx.inputExpr(ctx.node.id, 'cv_cutoff', '__NC__')
    const resExpr = ctx.inputExpr(ctx.node.id, 'cv_res', '__NC__')
    // cv_cutoff replaces sidebar directly; freq_cv still applies as octave-scaling on top.
    const fBase = cutoffExpr === '__NC__'
      ? `${base}`
      : `fmaxf(20.f, fminf(20000.f, ${cutoffExpr}))`
    const rExpr = resExpr === '__NC__'
      ? res
      : `fmaxf(0.f, fminf(1.f, ${resExpr}))`
    return (
      `    ${v}.SetFreq((${fBase}) * powf(2.f, ${cv}));\n` +
      `    ${v}.SetRes(${rExpr});\n` +
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
    const res = numParam(ctx.node, 'resonance', 0.3)
    const cutoffExpr = ctx.inputExpr(ctx.node.id, 'cv_cutoff', '__NC__')
    const resExpr = ctx.inputExpr(ctx.node.id, 'cv_res', '__NC__')
    const fBase = cutoffExpr === '__NC__'
      ? `${base}`
      : `fmaxf(20.f, fminf(20000.f, ${cutoffExpr}))`
    const rExpr = resExpr === '__NC__'
      ? res
      : `fmaxf(0.f, fminf(1.f, ${resExpr}))`
    return (
      `    ${v}.SetFreq((${fBase}) * powf(2.f, ${cv}));\n` +
      `    ${v}.SetRes(${rExpr});\n` +
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
    const morphParam = numParam(ctx.node, 'morph', 0)
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const morphCvExpr = ctx.inputExpr(ctx.node.id, 'cv_morph', '__NC__')
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    const morphExpr = morphCvExpr === '__NC__' ? `${morphParam}` : `fmaxf(0.f, fminf(1.f, ${morphCvExpr}))`
    const table: Record<string, [number, number, number]> = {
      a: [730, 1090, 2440],
      e: [530, 1840, 2480],
      i: [270, 2290, 3010],
      o: [570, 840, 2410],
      u: [300, 870, 2240]
    }
    const order = ['a', 'e', 'i', 'o', 'u']
    const curIdx = Math.max(0, order.indexOf(vowel))
    const nxtIdx = (curIdx + 1) % order.length
    const cur = table[order[curIdx]] ?? table.a
    const nxt = table[order[nxtIdx]] ?? table.a
    return (
      `    {\n` +
      `        float _m = (${morphExpr});\n` +
      `        float _f1 = ${formatFloat(cur[0])} * (1.f - _m) + ${formatFloat(nxt[0])} * _m;\n` +
      `        float _f2 = ${formatFloat(cur[1])} * (1.f - _m) + ${formatFloat(nxt[1])} * _m;\n` +
      `        float _f3 = ${formatFloat(cur[2])} * (1.f - _m) + ${formatFloat(nxt[2])} * _m;\n` +
      `        ${v}_f1.SetFreq(_f1);\n` +
      `        ${v}_f2.SetFreq(_f2);\n` +
      `        ${v}_f3.SetFreq(_f3);\n` +
      `    }\n` +
      `    ${v}_f1.Process(${i});\n` +
      `    ${v}_f2.Process(${i});\n` +
      `    ${v}_f3.Process(${i});\n` +
      `    float ${v}_wet = ${v}_f1.Band() + ${v}_f2.Band() * 0.8f + ${v}_f3.Band() * 0.6f;\n` +
      `    float ${out} = (${i}) * (1.f - (${mixExpr})) + ${v}_wet * (${mixExpr});\n`
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
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const decCvExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const susCvExpr = ctx.inputExpr(ctx.node.id, 'cv_sustain', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const lines: string[] = []
    if (atkCvExpr !== '__NC__') lines.push(`    ${v}.SetTime(ADSR_SEG_ATTACK, fmaxf(0.001f, fminf(4.f, ${atkCvExpr})));`)
    if (decCvExpr !== '__NC__') lines.push(`    ${v}.SetTime(ADSR_SEG_DECAY, fmaxf(0.001f, fminf(4.f, ${decCvExpr})));`)
    if (susCvExpr !== '__NC__') lines.push(`    ${v}.SetSustainLevel(fmaxf(0.f, fminf(1.f, ${susCvExpr})));`)
    if (relCvExpr !== '__NC__') lines.push(`    ${v}.SetTime(ADSR_SEG_RELEASE, fmaxf(0.001f, fminf(8.f, ${relCvExpr})));`)
    const prefix = lines.length > 0 ? lines.join('\n') + '\n' : ''
    return (
      prefix +
      `    float ${out} = ${v}.Process((${g}) > 0.5f);\n`
    )
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
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const aExpr = atkCvExpr === '__NC__' ? `${a}` : `fmaxf(0.001f, fminf(4.f, ${atkCvExpr}))`
    const rExpr = relCvExpr === '__NC__' ? `${r}` : `fmaxf(0.001f, fminf(8.f, ${relCvExpr}))`
    return (
      `    {\n` +
      `        float gi = ${g};\n` +
      `        if (gi > 0.5f && ${v}_prev_gate <= 0.5f) ${v}_rising = true;\n` +
      `        ${v}_prev_gate = gi;\n` +
      `        float atk = 1.f - expf(-1.f / (sr * fmaxf((${aExpr}), 1e-4f)));\n` +
      `        float rel = 1.f - expf(-1.f / (sr * fmaxf((${rExpr}), 1e-4f)));\n` +
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
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const aExpr = atkCvExpr === '__NC__' ? `${a}` : `fmaxf(0.001f, fminf(1.f, ${atkCvExpr}))`
    const rExpr = relCvExpr === '__NC__' ? `${r}` : `fmaxf(0.001f, fminf(2.f, ${relCvExpr}))`
    return (
      `    {\n` +
      `        float x = fabsf(${i});\n` +
      `        float ca = 1.f - expf(-1.f / (sr * fmaxf((${aExpr}), 1e-4f)));\n` +
      `        float cr = 1.f - expf(-1.f / (sr * fmaxf((${rExpr}), 1e-4f)));\n` +
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
    const riseCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rise', '__NC__')
    const fallCvExpr = ctx.inputExpr(ctx.node.id, 'cv_fall', '__NC__')
    const rExpr = riseCvExpr === '__NC__'
      ? `${rise}`
      : `fmaxf(0.f, fminf(2.f, ${riseCvExpr}))`
    const fExpr = fallCvExpr === '__NC__'
      ? `${fall}`
      : `fmaxf(0.f, fminf(2.f, ${fallCvExpr}))`
    return (
      `    {\n` +
      `        float x = ${i};\n` +
      `        float cr = 1.f - expf(-1.f / (sr * fmaxf((${rExpr}), 1e-4f)));\n` +
      `        float cf = 1.f - expf(-1.f / (sr * fmaxf((${fExpr}), 1e-4f)));\n` +
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

/**
 * Range remap — Max/PD `scale` with optional clamp. Emits a guarded divide
 * so `in_max == in_min` doesn't blow up (division-by-zero in float returns
 * +/-inf; we'd rather collapse the output to `out_min`).
 */
const rangeNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const inMin  = numParam(ctx.node, 'in_min',  0)
    const inMax  = numParam(ctx.node, 'in_max',  1)
    const outMin = numParam(ctx.node, 'out_min', 0)
    const outMax = numParam(ctx.node, 'out_max', 1)
    const clamp = enumParam(ctx.node, 'clamp', 'on') === 'on'
    const inSpanExpr = `((${inMax}) - (${inMin}))`
    const outSpanExpr = `((${outMax}) - (${outMin}))`
    const rawExpr =
      `((${inSpanExpr}) != 0.f ` +
      `? ((${outMin}) + ((${i}) - (${inMin})) * (${outSpanExpr}) / (${inSpanExpr})) ` +
      `: (${outMin}))`
    const expr = clamp
      ? `fmaxf(fminf(${outMin}, ${outMax}), fminf(fmaxf(${outMin}, ${outMax}), ${rawExpr}))`
      : rawExpr
    return `    float ${out} = ${expr};\n`
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
    const thrCvExpr = ctx.inputExpr(ctx.node.id, 'cv_threshold', '__NC__')
    const tExpr = thrCvExpr === '__NC__'
      ? `${thr}`
      : `fmaxf(-1.f, fminf(1.f, ${thrCvExpr}))`
    return `    float ${out} = ((${i}) > ((${ref}) + (${tExpr}))) ? 1.f : 0.f;\n`
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
    const bpmCvExpr = ctx.inputExpr(ctx.node.id, 'cv_bpm', '__NC__')
    const bpmExpr = bpmCvExpr === '__NC__' ? `${bpm}` : `fmaxf(20.f, fminf(300.f, ${bpmCvExpr}))`
    return (
      `    ${v}_phase += ((${bpmExpr}) / 60.f) / sr;\n` +
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
    // Runtime-mutable pattern so CV inputs can rebuild it in place.
    return (
      `uint8_t ${v}_pattern[${steps}] = { ${arr} };\n` +
      `int ${v}_last_pulses = ${pulses};\n` +
      `int ${v}_last_rotate = ${rot};\n` +
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
    const pulses = Math.max(0, Math.min(steps, Math.floor(rawNum(ctx.node, 'pulses', 4))))
    const rot = Math.max(0, Math.floor(rawNum(ctx.node, 'rotate', 0))) % steps
    const pulsesCvExpr = ctx.inputExpr(ctx.node.id, 'cv_pulses', '__NC__')
    const rotateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rotate', '__NC__')
    const hasPulsesCv = pulsesCvExpr !== '__NC__'
    const hasRotateCv = rotateCvExpr !== '__NC__'
    let rebuildBlock = ''
    if (hasPulsesCv || hasRotateCv) {
      const pulsesVal = hasPulsesCv
        ? `(int)fmaxf(0.f, fminf(32.f, ${pulsesCvExpr}))`
        : `${pulses}`
      const rotateVal = hasRotateCv
        ? `(int)fmaxf(0.f, fminf(31.f, ${rotateCvExpr}))`
        : `${rot}`
      rebuildBlock =
        `    {\n` +
        `        int _p = ${pulsesVal};\n` +
        `        int _r = ${rotateVal};\n` +
        `        if (_p > ${steps}) _p = ${steps};\n` +
        `        if (_p != ${v}_last_pulses || _r != ${v}_last_rotate) {\n` +
        `            uint8_t _tmp[${steps}] = {0};\n` +
        `            int _bucket = 0;\n` +
        `            for (int _i = 0; _i < ${steps}; _i++) {\n` +
        `                _bucket += _p;\n` +
        `                if (_bucket >= ${steps}) { _bucket -= ${steps}; _tmp[_i] = 1; }\n` +
        `            }\n` +
        `            int _rr = _r % ${steps}; if (_rr < 0) _rr += ${steps};\n` +
        `            for (int _i = 0; _i < ${steps}; _i++) {\n` +
        `                int _src = (_i - _rr + ${steps}) % ${steps};\n` +
        `                ${v}_pattern[_i] = _tmp[_src];\n` +
        `            }\n` +
        `            ${v}_last_pulses = _p; ${v}_last_rotate = _r;\n` +
        `        }\n` +
        `    }\n`
    }
    return (
      rebuildBlock +
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
    return (
      `Random ${v}_rng;\n` +
      `float ${v}_val = 0.f;\n` +
      `float ${v}_prev_clk = 0.f;\n` +
      `float ${v}_phase = 0.f;`
    )
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const clkExpr = ctx.inputExpr(ctx.node.id, 'clock', '__NC__')
    const range = numParam(ctx.node, 'range', 1)
    const rate = numParam(ctx.node, 'rate', 2)
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const rateExpr = rateCvExpr === '__NC__' ? `${rate}` : `fmaxf(0.1f, fminf(20.f, ${rateCvExpr}))`
    if (clkExpr !== '__NC__') {
      // Clock-driven.
      return (
        `    {\n` +
        `        float ci = ${clkExpr};\n` +
        `        if (ci > 0.5f && ${v}_prev_clk <= 0.5f) ${v}_val = (${v}_rng.GetFloat() * 2.f - 1.f) * ${range};\n` +
        `        ${v}_prev_clk = ci;\n` +
        `    }\n` +
        `    float ${out} = ${v}_val;\n`
      )
    }
    // Free-run at `rate` Hz; rate responds to cv_rate when connected.
    return (
      `    {\n` +
      `        ${v}_phase += (${rateExpr}) / sr;\n` +
      `        if (${v}_phase >= 1.f) {\n` +
      `            ${v}_phase -= 1.f;\n` +
      `            ${v}_val = (${v}_rng.GetFloat() * 2.f - 1.f) * ${range};\n` +
      `        }\n` +
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
    const densityCvExpr = ctx.inputExpr(ctx.node.id, 'cv_density', '__NC__')
    const dExpr = densityCvExpr === '__NC__'
      ? `${density}`
      : `fmaxf(0.1f, fminf(50.f, ${densityCvExpr}))`
    return `    float ${out} = (${v}_rng.GetFloat() < ((${dExpr}) / sr)) ? 1.f : 0.f;\n`
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
    const timeReplaceExpr = ctx.inputExpr(ctx.node.id, 'cv_time', '__NC__')
    const fbCvExpr = ctx.inputExpr(ctx.node.id, 'cv_feedback', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    // cv_time replaces (time + time_cv); fall back to legacy formula otherwise.
    const timeBase = timeReplaceExpr === '__NC__'
      ? `(${time} + (${cv}))`
      : `fmaxf(0.001f, fminf(2.f, ${timeReplaceExpr}))`
    const fbExpr = fbCvExpr === '__NC__' ? `${fb}` : `fmaxf(0.f, fminf(0.95f, ${fbCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    ${v}.SetDelay(fmaxf(1.f, fminf((float)CODEGEN_MAX_DELAY - 1.f, (${timeBase}) * sr)));\n` +
      `    float ${v}_r = ${v}.Read();\n` +
      `    ${v}.Write((${i}) + ${v}_r * (${fbExpr}));\n` +
      `    float ${out} = (${i}) * (1.f - (${mixExpr})) + ${v}_r * (${mixExpr});\n`
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
    const size = numParam(ctx.node, 'size', 0.5)
    const damp = numParam(ctx.node, 'damp', 0.5)
    const mix = numParam(ctx.node, 'mix', 0.3)
    const sizeCvExpr = ctx.inputExpr(ctx.node.id, 'cv_size', '__NC__')
    const dampCvExpr = ctx.inputExpr(ctx.node.id, 'cv_damp', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const sizeExpr = sizeCvExpr === '__NC__' ? `${size}` : `fmaxf(0.f, fminf(1.f, ${sizeCvExpr}))`
    const dampExpr = dampCvExpr === '__NC__' ? `${damp}` : `fmaxf(0.f, fminf(1.f, ${dampCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    ${v}.SetFeedback(0.5f + (${sizeExpr}) * 0.45f);\n` +
      `    ${v}.SetLpFreq(1000.f + (1.f - (${dampExpr})) * 15000.f);\n` +
      `    float ${v}_wl = 0.f, ${v}_wr = 0.f;\n` +
      `    ${v}.Process(${i}, ${i}, &${v}_wl, &${v}_wr);\n` +
      `    float ${out} = (${i}) * (1.f - (${mixExpr})) + 0.5f * (${v}_wl + ${v}_wr) * (${mixExpr});\n`
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
    const drive = numParam(ctx.node, 'drive', 0.3)
    const driveCvExpr = ctx.inputExpr(ctx.node.id, 'cv_drive', '__NC__')
    const dExpr = driveCvExpr === '__NC__'
      ? `${drive}`
      : `fmaxf(0.f, fminf(1.f, ${driveCvExpr}))`
    return (
      `    ${v}.SetDrive(${dExpr});\n` +
      `    float ${out} = ${v}.Process(${i});\n`
    )
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
    const rate = numParam(ctx.node, 'rate', 0.8)
    const depth = numParam(ctx.node, 'depth', 0.5)
    const mix = numParam(ctx.node, 'mix', 0.5)
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const rateExpr = rateCvExpr === '__NC__' ? `${rate}` : `fmaxf(0.05f, fminf(8.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    ${v}.SetLfoFreq(${rateExpr});\n` +
      `    ${v}.SetLfoDepth(${depthExpr});\n` +
      `    ${v}.Process(${i});\n` +
      `    float ${v}_wet = 0.5f * (${v}.GetLeft() + ${v}.GetRight());\n` +
      `    float ${out} = (${i}) * (1.f - (${mixExpr})) + ${v}_wet * (${mixExpr});\n`
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
    const bitsCvExpr = ctx.inputExpr(ctx.node.id, 'cv_bits', '__NC__')
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const bExpr = bitsCvExpr === '__NC__'
      ? `${bits}`
      : `fmaxf(1.f, fminf(16.f, ${bitsCvExpr}))`
    const rExpr = rateCvExpr === '__NC__'
      ? `${rate}`
      : `fmaxf(0.01f, fminf(1.f, ${rateCvExpr}))`
    return (
      `    {\n` +
      `        ${v}_phase += (${rExpr});\n` +
      `        if (${v}_phase >= 1.f) {\n` +
      `            ${v}_phase -= 1.f;\n` +
      `            float levels = powf(2.f, (${bExpr})) - 1.f;\n` +
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
    const rate = numParam(ctx.node, 'rate', 0.5)
    const depth = numParam(ctx.node, 'depth', 0.7)
    const fb = numParam(ctx.node, 'feedback', 0.5)
    const mix = numParam(ctx.node, 'mix', 0.5)
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const fbCvExpr = ctx.inputExpr(ctx.node.id, 'cv_feedback', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const rateExpr = rateCvExpr === '__NC__' ? `${rate}` : `fmaxf(0.05f, fminf(8.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    const fbExpr = fbCvExpr === '__NC__' ? `${fb}` : `fmaxf(0.f, fminf(0.9f, ${fbCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    ${v}.SetLfoFreq(${rateExpr});\n` +
      `    ${v}.SetLfoDepth(${depthExpr});\n` +
      `    ${v}.SetFeedback(${fbExpr});\n` +
      `    float ${v}_wet = ${v}.Process(${i});\n` +
      `    float ${out} = (${i}) * (1.f - (${mixExpr})) + ${v}_wet * (${mixExpr});\n`
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
    const rate = numParam(ctx.node, 'rate', 0.3)
    const depth = numParam(ctx.node, 'depth', 0.6)
    const fb = numParam(ctx.node, 'feedback', 0.5)
    const mix = numParam(ctx.node, 'mix', 0.5)
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const fbCvExpr = ctx.inputExpr(ctx.node.id, 'cv_feedback', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const rateExpr = rateCvExpr === '__NC__' ? `${rate}` : `fmaxf(0.05f, fminf(5.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    const fbExpr = fbCvExpr === '__NC__' ? `${fb}` : `fmaxf(-0.95f, fminf(0.95f, ${fbCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    ${v}.SetLfoFreq(${rateExpr});\n` +
      `    ${v}.SetLfoDepth(${depthExpr});\n` +
      `    ${v}.SetFeedback(${fbExpr});\n` +
      `    float ${v}_wet = ${v}.Process(${i});\n` +
      `    float ${out} = (${i}) * (1.f - (${mixExpr})) + ${v}_wet * (${mixExpr});\n`
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
    const time = numParam(ctx.node, 'time', 0.3)
    const fb = numParam(ctx.node, 'feedback', 0.45)
    const mix = numParam(ctx.node, 'mix', 0.4)
    const timeCvExpr = ctx.inputExpr(ctx.node.id, 'cv_time', '__NC__')
    const fbCvExpr = ctx.inputExpr(ctx.node.id, 'cv_feedback', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const timeExpr = timeCvExpr === '__NC__' ? `${time}` : `fmaxf(0.02f, fminf(2.f, ${timeCvExpr}))`
    const fbExpr = fbCvExpr === '__NC__' ? `${fb}` : `fmaxf(0.f, fminf(0.95f, ${fbCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    {\n` +
      `        float _t = (${timeExpr}) * sr;\n` +
      `        if (_t < 1.f) _t = 1.f; if (_t > (float)CODEGEN_MAX_DELAY - 1.f) _t = (float)CODEGEN_MAX_DELAY - 1.f;\n` +
      `        ${v}_dl.SetDelay(_t);\n` +
      `        ${v}_dr.SetDelay(_t);\n` +
      `    }\n` +
      `    float ${v}_rl = ${v}_dl.Read();\n` +
      `    float ${v}_rr = ${v}_dr.Read();\n` +
      `    ${v}_dl.Write((${i}) + ${v}_rr * (${fbExpr}));\n` +
      `    ${v}_dr.Write(${v}_rl * (${fbExpr}));\n` +
      `    float ${l} = (${i}) * (1.f - (${mixExpr})) + ${v}_rl * (${mixExpr});\n` +
      `    float ${r} = (${i}) * (1.f - (${mixExpr})) + ${v}_rr * (${mixExpr});\n`
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
    const widthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_width', '__NC__')
    const widthExpr = widthCvExpr === '__NC__' ? `${width}` : `fmaxf(0.f, fminf(2.f, ${widthCvExpr}))`
    return (
      `    float ${v}_d = ${v}_dl.Read();\n` +
      `    ${v}_dl.Write(${i});\n` +
      `    float ${l} = (${i});\n` +
      `    float ${r} = (${i}) * (1.f - (${widthExpr}) * 0.5f) + ${v}_d * (${widthExpr}) * 0.5f;\n`
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
    const lenCvExpr = ctx.inputExpr(ctx.node.id, 'cv_length', '__NC__')
    const lenExpr = lenCvExpr === '__NC__' ? `${bufMs}` : `fmaxf(20.f, fminf(500.f, ${lenCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        size_t span = (size_t)((${lenExpr}) * 0.001f * sr);\n` +
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

// ---------------------------------------------------------------------------
// Granulator — 1:1 port of `src/audio/worklets/granulator.worklet.ts`.
// A ~4s circular capture buffer in SDRAM; at `density` Hz spawns a new
// Hann-windowed grain reading back from a random-ish offset at a
// pitch-shifted rate. Up to 8 simultaneous grains. Wet mixed with dry.
// ---------------------------------------------------------------------------
const granulator: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    // 4s @ 48kHz = 192000 floats = ~770 KB — comfortably in SDRAM.
    return (
      `constexpr size_t ${v}_BUF = 192000;\n` +
      `constexpr size_t ${v}_MAX_GRAINS = 8;\n` +
      `float ${v}_buf[${v}_BUF] DSY_SDRAM_BSS;\n` +
      `size_t ${v}_w = 0;\n` +
      `float ${v}_spawn_cd = 0.f;\n` +
      `uint32_t ${v}_rng_state = 0x9e3779b9u;\n` +
      `struct ${v}_Grain {\n` +
      `    bool  active;\n` +
      `    float pos;\n` +
      `    float start;\n` +
      `    float len;\n` +
      `    float rate;\n` +
      `};\n` +
      `${v}_Grain ${v}_grains[${v}_MAX_GRAINS] = {};`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `    for (size_t zi = 0; zi < ${v}_BUF; zi++) ${v}_buf[zi] = 0.f;\n` +
      `    for (size_t gi = 0; gi < ${v}_MAX_GRAINS; gi++) ${v}_grains[gi].active = false;`
    )
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const inExpr = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const grainMs = numParam(ctx.node, 'grain_size', 80)
    const density = numParam(ctx.node, 'density', 8)
    const pitchP = numParam(ctx.node, 'pitch', 0)
    const jitter = numParam(ctx.node, 'jitter', 0.3)
    const mix = numParam(ctx.node, 'mix', 1)
    const sizeCvExpr = ctx.inputExpr(ctx.node.id, 'cv_grain_size', '__NC__')
    const densityCvExpr = ctx.inputExpr(ctx.node.id, 'cv_density', '__NC__')
    const pitchCvExpr = ctx.inputExpr(ctx.node.id, 'cv_pitch', '__NC__')
    const sprayCvExpr = ctx.inputExpr(ctx.node.id, 'cv_spray', '__NC__')
    const grainMsExpr = sizeCvExpr === '__NC__' ? `${grainMs}` : `fmaxf(10.f, fminf(200.f, ${sizeCvExpr}))`
    const densityExpr = densityCvExpr === '__NC__' ? `${density}` : `fmaxf(1.f, fminf(30.f, ${densityCvExpr}))`
    const pitch = pitchCvExpr === '__NC__' ? `${pitchP}` : `fmaxf(-12.f, fminf(12.f, ${pitchCvExpr}))`
    const spray = sprayCvExpr === '__NC__' ? `${jitter}` : `fmaxf(0.f, fminf(1.f, ${sprayCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        const float TWO_PI = 2.f * (float)M_PI;\n` +
      `        float x = ${inExpr};\n` +
      `        // write into circular buffer\n` +
      `        ${v}_buf[${v}_w] = x;\n` +
      `        ${v}_w = (${v}_w + 1) % ${v}_BUF;\n` +
      `        float _jitter = (${spray});\n` +
      `        float grainSamples = ((${grainMsExpr}) * 0.001f) * sr;\n` +
      `        if (grainSamples < 1.f) grainSamples = 1.f;\n` +
      `        float spawnInterval = sr / (((${densityExpr})) > 0.001f ? ((${densityExpr})) : 0.001f);\n` +
      `        ${v}_spawn_cd -= 1.f;\n` +
      `        if (${v}_spawn_cd <= 0.f) {\n` +
      `            // xorshift32 for cheap PRNG — not calling daisy::Random here\n` +
      `            // because grain spawn runs at audio rate.\n` +
      `            ${v}_rng_state ^= ${v}_rng_state << 13;\n` +
      `            ${v}_rng_state ^= ${v}_rng_state >> 17;\n` +
      `            ${v}_rng_state ^= ${v}_rng_state << 5;\n` +
      `            float r0 = (float)${v}_rng_state * (1.f / 4294967296.f); // [0,1)\n` +
      `            ${v}_rng_state ^= ${v}_rng_state << 13;\n` +
      `            ${v}_rng_state ^= ${v}_rng_state >> 17;\n` +
      `            ${v}_rng_state ^= ${v}_rng_state << 5;\n` +
      `            float r1 = (float)${v}_rng_state * (1.f / 4294967296.f);\n` +
      `            int slot = -1;\n` +
      `            for (int s = 0; s < (int)${v}_MAX_GRAINS; s++) {\n` +
      `                if (!${v}_grains[s].active) { slot = s; break; }\n` +
      `            }\n` +
      `            if (slot >= 0) {\n` +
      `                float jit = (r0 * 2.f - 1.f) * _jitter;\n` +
      `                float back = grainSamples * (1.f + 2.f * _jitter) + r1 * _jitter * (float)(${v}_BUF - (size_t)grainSamples - 2);\n` +
      `                float start = (float)${v}_w - grainSamples - back;\n` +
      `                while (start < 0.f) start += (float)${v}_BUF;\n` +
      `                while (start >= (float)${v}_BUF) start -= (float)${v}_BUF;\n` +
      `                float pitchJit = (${pitch}) + jit * 2.f;\n` +
      `                float rate = powf(2.f, pitchJit / 12.f);\n` +
      `                ${v}_grains[slot].active = true;\n` +
      `                ${v}_grains[slot].pos = 0.f;\n` +
      `                ${v}_grains[slot].start = start;\n` +
      `                ${v}_grains[slot].len = grainSamples;\n` +
      `                ${v}_grains[slot].rate = rate;\n` +
      `            }\n` +
      `            ${v}_spawn_cd += spawnInterval;\n` +
      `        }\n` +
      `        float wet = 0.f;\n` +
      `        for (size_t s = 0; s < ${v}_MAX_GRAINS; s++) {\n` +
      `            if (!${v}_grains[s].active) continue;\n` +
      `            float pos = ${v}_grains[s].pos;\n` +
      `            float len = ${v}_grains[s].len;\n` +
      `            if (pos >= len) { ${v}_grains[s].active = false; continue; }\n` +
      `            float readPos = ${v}_grains[s].start + pos;\n` +
      `            while (readPos >= (float)${v}_BUF) readPos -= (float)${v}_BUF;\n` +
      `            while (readPos < 0.f) readPos += (float)${v}_BUF;\n` +
      `            size_t ri0 = (size_t)readPos;\n` +
      `            float frac = readPos - (float)ri0;\n` +
      `            size_t ri1 = (ri0 + 1) % ${v}_BUF;\n` +
      `            float sample = ${v}_buf[ri0] * (1.f - frac) + ${v}_buf[ri1] * frac;\n` +
      `            float env = 0.5f - 0.5f * cosf((TWO_PI * pos) / len);\n` +
      `            wet += sample * env;\n` +
      `            ${v}_grains[s].pos = pos + ${v}_grains[s].rate;\n` +
      `        }\n` +
      `        if (!isfinite(wet)) wet = 0.f;\n` +
      `        ${out} = x * (1.f - (${mix})) + wet * (${mix});\n` +
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
    const semis = numParam(ctx.node, 'semitones', 0)
    const mix = numParam(ctx.node, 'mix', 1)
    const pitchCvExpr = ctx.inputExpr(ctx.node.id, 'cv_pitch', '__NC__')
    const semisExpr = pitchCvExpr === '__NC__' ? `${semis}` : `fmaxf(-24.f, fminf(24.f, ${pitchCvExpr}))`
    return (
      `    ${v}.SetTransposition(${semisExpr});\n` +
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
    const rate = numParam(ctx.node, 'rate', 4)
    const depth = numParam(ctx.node, 'depth', 0.5)
    // Legacy 'rate_cv' (octave-scaling on base rate) stays supported.
    const rateOctExpr = ctx.inputExpr(ctx.node.id, 'rate_cv', '__NC__')
    // Wave 3 replace-semantics CVs.
    const rateReplaceExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    let rateExpr: string
    if (rateReplaceExpr !== '__NC__') {
      rateExpr = `fmaxf(0.1f, fminf(20.f, ${rateReplaceExpr}))`
    } else if (rateOctExpr !== '__NC__') {
      rateExpr = `(${rate}) * powf(2.f, ${rateOctExpr})`
    } else {
      rateExpr = `${rate}`
    }
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    return (
      `    ${v}.SetFreq(${rateExpr});\n` +
      `    ${v}.SetDepth(${depthExpr});\n` +
      `    float ${out} = ${v}.Process(${i});\n`
    )
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
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const rateExpr = rateCvExpr === '__NC__' ? `${rate}` : `fmaxf(0.1f, fminf(15.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    return (
      `    {\n` +
      `        ${v}_phase += (${rateExpr}) / sr;\n` +
      `        if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `        float mod = sinf(${v}_phase * 2.f * (float)M_PI) * (${depthExpr}) * 0.005f * sr + 0.01f * sr;\n` +
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
    // Wave 2: each continuous param gets a replace-semantics CV.
    const thr = numParam(ctx.node, 'threshold', -20)
    const ratio = numParam(ctx.node, 'ratio', 4)
    const atk = numParam(ctx.node, 'attack', 0.01)
    const rel = numParam(ctx.node, 'release', 0.1)
    const make = numParam(ctx.node, 'makeup', 0)
    const thrExpr = ctx.inputExpr(ctx.node.id, 'cv_threshold', '__NC__')
    const ratExpr = ctx.inputExpr(ctx.node.id, 'cv_ratio', '__NC__')
    const atkExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const mkExpr = ctx.inputExpr(ctx.node.id, 'cv_makeup', '__NC__')
    const tE = thrExpr === '__NC__' ? `${thr}` : `fmaxf(-60.f, fminf(0.f, ${thrExpr}))`
    const rE = ratExpr === '__NC__' ? `${ratio}` : `fmaxf(1.f, fminf(20.f, ${ratExpr}))`
    const aE = atkExpr === '__NC__' ? `${atk}` : `fmaxf(0.001f, fminf(0.5f, ${atkExpr}))`
    const relE = relExpr === '__NC__' ? `${rel}` : `fmaxf(0.01f, fminf(3.f, ${relExpr}))`
    const mE = mkExpr === '__NC__' ? `${make}` : `fmaxf(0.f, fminf(24.f, ${mkExpr}))`
    return (
      `    ${v}.SetThreshold(${tE});\n` +
      `    ${v}.SetRatio(${rE});\n` +
      `    ${v}.SetAttack(${aE});\n` +
      `    ${v}.SetRelease(${relE});\n` +
      `    ${v}.SetMakeup(${mE});\n` +
      `    float ${out} = ${v}.Process(${i});\n`
    )
  }
}

// Custom peak-limiter with soft-knee — matches the worklet so cv_ceiling /
// cv_release actually influence gain. libDaisy's `Limiter` class hides its
// parameters so we roll our own 1-pole detector + gain computer here.
const limiter: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_env = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const ceilDb = numParam(ctx.node, 'ceiling', -0.3)
    const rel = numParam(ctx.node, 'release', 0.05)
    const ceilExpr = ctx.inputExpr(ctx.node.id, 'cv_ceiling', '__NC__')
    const relExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const cE = ceilExpr === '__NC__' ? `${ceilDb}` : `fmaxf(-12.f, fminf(0.f, ${ceilExpr}))`
    const rE = relExpr === '__NC__' ? `${rel}` : `fmaxf(0.01f, fminf(2.f, ${relExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _cdb = (${cE});\n` +
      `        float _rel = (${rE});\n` +
      `        float _ceilLin = powf(10.f, _cdb / 20.f);\n` +
      `        float _kneeLin = powf(10.f, (_cdb - 2.f) / 20.f);\n` +
      `        float _atkCoef = 1.f - expf(-1.f / (0.001f * sr));\n` +
      `        float _relCoef = 1.f - expf(-1.f / (_rel * sr));\n` +
      `        float _x = (${i});\n` +
      `        float _ax = fabsf(_x);\n` +
      `        if (_ax > ${v}_env) ${v}_env += (_ax - ${v}_env) * _atkCoef;\n` +
      `        else ${v}_env += (_ax - ${v}_env) * _relCoef;\n` +
      `        if (${v}_env < 0.f) ${v}_env = 0.f;\n` +
      `        float _g = 1.f;\n` +
      `        if (${v}_env > _kneeLin) {\n` +
      `            if (${v}_env >= _ceilLin) { _g = _ceilLin / ${v}_env; }\n` +
      `            else { float _t = (${v}_env - _kneeLin) / (_ceilLin - _kneeLin);\n` +
      `                   float _hg = _ceilLin / ${v}_env;\n` +
      `                   float _s = _t * _t * (3.f - 2.f * _t);\n` +
      `                   _g = 1.f * (1.f - _s) + _hg * _s; }\n` +
      `        }\n` +
      `        float _y = _x * _g;\n` +
      `        if (_y > _ceilLin) _y = _ceilLin; else if (_y < -_ceilLin) _y = -_ceilLin;\n` +
      `        ${out} = _y;\n` +
      `    }\n`
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
    const thrCvExpr = ctx.inputExpr(ctx.node.id, 'cv_threshold', '__NC__')
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const tE = thrCvExpr === '__NC__' ? `${thrDb}` : `fmaxf(-80.f, fminf(0.f, ${thrCvExpr}))`
    const aE = atkCvExpr === '__NC__' ? `${atk}` : `fmaxf(0.001f, fminf(0.1f, ${atkCvExpr}))`
    const rE = relCvExpr === '__NC__' ? `${rel}` : `fmaxf(0.01f, fminf(2.f, ${relCvExpr}))`
    return (
      `    {\n` +
      `        float k = fabsf(${key});\n` +
      `        float ca = 1.f - expf(-1.f / (sr * fmaxf((${aE}), 1e-4f)));\n` +
      `        float cr = 1.f - expf(-1.f / (sr * fmaxf((${rE}), 1e-4f)));\n` +
      `        float c = (k > ${v}_env) ? ca : cr;\n` +
      `        ${v}_env += (k - ${v}_env) * c;\n` +
      `        float thr = powf(10.f, (${tE}) / 20.f);\n` +
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
    // daisy_seed.h pulls in OledDisplay<> but not the SSD130x driver
    // header — bring it in at file scope so the template arg resolves.
    lines.push(`#include "dev/oled_ssd130x.h"`)
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
    const normalized = bound ?? `${v}_val`
    // Range-map the normalized 0..1 reading (ADC returns 0..1 via
    // `hw.adc.GetFloat`) to the user's sidebar min/max. Identity when
    // min=0, max=1. Handy presets: 0..4095 (raw 12-bit), 20..20000
    // (Hz sweep), -1..1 (bipolar CV).
    const lo = typeof ctx.node.params.min === 'number' ? ctx.node.params.min : 0
    const hi = typeof ctx.node.params.max === 'number' ? ctx.node.params.max : 1
    const expr =
      lo === 0 && hi === 1
        ? normalized
        : `${lo.toFixed(4)}f + (${normalized}) * ${(hi - lo).toFixed(4)}f`
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

// Shared prelude for any MIDI node — declares the USB MIDI handler and the
// latched note/CC state used by _in_note and _in_cc. Any of the three MIDI
// kinds may emit this; the #ifndef guard ensures one definition only.
const MIDI_SHARED_DECL =
  '#ifndef DP_MIDI_SHARED_DECL\n' +
  '#define DP_MIDI_SHARED_DECL 1\n' +
  'MidiUsbHandler midi;\n' +
  '// MIDI note-in latched state (channel-filtered in main loop).\n' +
  'volatile int midi_latched_note = -1;\n' +
  'volatile float midi_latched_vel = 0.f;\n' +
  'volatile float midi_latched_gate = 0.f;\n' +
  '// MIDI CC table — written by the USB MIDI dispatcher.\n' +
  'float midi_cc_table[128] = {0};\n' +
  'bool midi_cc_received = false;\n' +
  '#endif'

// MidiHandler<>::Init() requires a Config argument. Build a default one
// and call StartReceive() to begin accepting USB packets. Guarded so that
// patches with multiple MIDI nodes don't double-init.
const MIDI_SHARED_INIT =
  '    {\n' +
  '        static bool midi_inited = false;\n' +
  '        if (!midi_inited) {\n' +
  '            MidiUsbHandler::Config midi_cfg;\n' +
  '            midi.Init(midi_cfg);\n' +
  '            midi.StartReceive();\n' +
  '            midi_inited = true;\n' +
  '        }\n' +
  '    }'

const midi_in_note: NodeEmitter = {
  declare: () => MIDI_SHARED_DECL,
  init: () => MIDI_SHARED_INIT,
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
  declare: () => MIDI_SHARED_DECL,
  init: () => MIDI_SHARED_INIT,
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
    MIDI_SHARED_DECL + '\n' +
    `static uint32_t ${ctx.varName(ctx.node.id)}_last_gate = 0;\n` +
    `static int ${ctx.varName(ctx.node.id)}_active_note = -1;`,
  init: () => MIDI_SHARED_INIT,
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
  range: rangeNode,
  comparator,
  // Sequencing
  clock: clockNode,
  clock_divider,
  step_seq,
  euclidean,
  random: randomNode,
  dust,
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
  granulator,
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
void makePassthrough
