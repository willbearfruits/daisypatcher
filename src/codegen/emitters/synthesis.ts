import type { NodeEmitter } from './shared'
import { enumParam, formatFloat, numParam, sampleInfoOf } from './shared'


// ---------------------------------------------------------------------------
// Source emitters
// ---------------------------------------------------------------------------

export const oscillator: NodeEmitter = {
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
      `    float ${out} = ${sawSign(ctx)}${v}.Process();\n`
    )
  }
}

/**
 * DaisySP's saw runs the other way.
 *
 * `WAVE_POLYBLEP_SAW` ends with `out *= -1.0f` — it is a FALLING ramp,
 * +1 down to -1. The emulator worklet and the ESP32 emitter both produce a
 * RISING one, so on the Daisy every sawtooth was the exact negation of what
 * the app played. Two implementations out of three agree, and rising is
 * what the node's own icon shows, so the Daisy is the one that moves.
 *
 * Negating the output rather than switching to `WAVE_RAMP` keeps the
 * band-limiting: `WAVE_RAMP` is the naive rising ramp and aliases badly at
 * pitch, which would trade a polarity bug for an audible one.
 *
 * Inaudible on its own — a saw and its inversion sound identical in
 * isolation — but not once anything asymmetric is downstream. An overdrive,
 * a wavefolder or a rectifier clips the two differently, which is exactly
 * where `npm run test:audio` found it.
 */
function sawSign(ctx: Parameters<NodeEmitter['process']>[0]): string {
  return enumParam(ctx.node, 'waveform', 'sine') === 'sawtooth' ? '-' : ''
}

/** Same inversion, for the LFO — its saw option is spelled `saw`. */
function lfoSawSign(ctx: Parameters<NodeEmitter['process']>[0]): string {
  return enumParam(ctx.node, 'waveform', 'sine') === 'saw' ? '-' : ''
}

export const noise: NodeEmitter = {
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

export const lfo: NodeEmitter = {
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
      `    float ${out} = ${lfoSawSign(ctx)}${v}.Process() * (${depthExpr}) + (${offsetExpr});\n`
    )
  }
}

export const constant: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    return `    float ${out} = ${numParam(ctx.node, 'value', 0.5)};\n`
  }
}

/*
 * PITCH FLOOR — 50 Hz, not 20.
 *
 * DaisySP's `String` holds a 1024-sample delay line, so at 48 kHz the
 * lowest note it can render is 48000/1024 = 46.9 Hz. Below that the device
 * produces silence while the emulator, whose buffer is longer, plays
 * happily — which is exactly what `npm run test:audio` found when a step
 * sequencer's 0..1 CV clamped the pitch to the old 20 Hz floor and the
 * firmware went quiet.
 *
 * 50 Hz across all three implementations: above the hardware limit with
 * margin, and the app stops offering a note the device cannot play.
 */
/*
 * A pluck is a burst of noise, not an impulse.
 *
 * This used to feed DaisySP's `String` a single sample of 1.0 on the
 * trigger edge, while the emulator filled a whole delay-line period with
 * white noise — which is the classic Karplus-Strong excitation and what
 * the node is named after. One sample carries a period's worth less
 * energy, so the device played the same patch 83% quieter and much
 * thinner. Both sides now excite with one period of noise.
 */
export const karplus: NodeEmitter = {
  declare: (ctx) =>
    `String ${ctx.varName(ctx.node.id)};\n` +
    `Random ${ctx.varName(ctx.node.id)}_rng;`,
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
      : `fmaxf(50.f, fminf(2000.f, ${pitchExpr}))`
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
      // Excitation: one period of noise, not one sample of 1.0. See note above.
      `    static int ${v}_burst = 0;\n` +
      `    if (${v}_edge) ${v}_burst = (int)(sr / fmaxf(50.f, ${fExpr}));\n` +
      `    float ${v}_exc = 0.f;\n` +
      `    if (${v}_burst > 0) { ${v}_exc = ${v}_rng.GetFloat(-1.f, 1.f); ${v}_burst--; }\n` +
      `    float ${out} = ${v}.Process(${v}_exc);\n`
    )
  }
}

export const fm_op: NodeEmitter = {
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
export const fm_op_clean: NodeEmitter = {
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
export const fm2: NodeEmitter = {
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

export const wavetable: NodeEmitter = {
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

/*
 * ACCENT. DaisySP's drum voices carry an "accent" that scales the whole
 * voice, and `Init()` leaves it at a per-voice default the patch never
 * mentions: 0.1 for the bass drum, 0.6 for the snare, 0.8 for the hi-hat.
 * Nothing here ever raised it, so the device played the kick at a tenth of
 * the level the emulator did — which is exactly the spread
 * `npm run test:audio` measured across the three (99%, 59%, 82% apart).
 *
 * Set explicitly to full scale so the voice's level is the patch's
 * business, not a library default. Velocity, when there is one, belongs on
 * top of this rather than hidden inside it.
 */
export const drum_kick: NodeEmitter = {
  declare: (ctx) => `AnalogBassDrum ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      // See the ACCENT note above drum_kick.
      `    ${v}.SetAccent(1.f);`,
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

export const drum_snare: NodeEmitter = {
  declare: (ctx) => `AnalogSnareDrum ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      // See the ACCENT note above drum_kick.
      `    ${v}.SetAccent(1.f);`,
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

export const drum_hat: NodeEmitter = {
  declare: (ctx) => `HiHat<> ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      // See the ACCENT note above drum_kick.
      `    ${v}.SetAccent(1.f);`,
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


/*
 * Sample player.
 *
 * The PCM array itself is emitted at file scope by `sampleCodegen.ts`; this
 * only reads it. Linear interpolation so `speed` is continuous, matching
 * the worklet exactly — a stepped read pointer would make the emulator and
 * the device disagree the moment anyone modulated pitch.
 *
 * With no sample selected, or a sample the library no longer has, the node
 * emits silence and codegen warns. It does NOT fail the build: a patch with
 * one unassigned slot should still flash, so you can hear the rest of it.
 */
export const sample_player: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const eoc = ctx.outputVar(ctx.node.id, 'eoc')
    const info = sampleInfoOf(ctx.node.id)

    if (!info) {
      return `    float ${out} = 0.f;\n    float ${eoc} = 0.f;\n`
    }

    const mode = enumParam(ctx.node, 'mode', 'oneshot')
    const speed = numParam(ctx.node, 'speed', 1)
    const start = numParam(ctx.node, 'start', 0)
    const end = numParam(ctx.node, 'end', 1)
    const level = numParam(ctx.node, 'level', 0.8)
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const speedCv = ctx.inputExpr(ctx.node.id, 'cv_speed', '__NC__')
    const startCv = ctx.inputExpr(ctx.node.id, 'cv_start', '__NC__')
    const levelCv = ctx.inputExpr(ctx.node.id, 'cv_level', '__NC__')
    const spExpr = speedCv === '__NC__' ? `${speed}` : `fmaxf(0.25f, fminf(4.f, ${speedCv}))`
    const stExpr = startCv === '__NC__' ? `${start}` : `fmaxf(0.f, fminf(1.f, ${startCv}))`
    const lvExpr = levelCv === '__NC__' ? `${level}` : `fmaxf(0.f, fminf(1.f, ${levelCv}))`
    /*
     * The library resamples to the engine rate on import, so this is
     * normally exactly 1. It is computed rather than assumed because a
     * sample stored at a different rate would otherwise play sharp or flat
     * on the device only — the kind of divergence `test:audio` exists for.
     */
    const rateRatio = info.sampleRate / (ctx.graph.meta.sampleRate || 48000)

    return (
      `    float ${out} = 0.f;\n` +
      `    float ${eoc} = 0.f;\n` +
      `    {\n` +
      `        static float ${v}_pos = 0.f;\n` +
      `        static bool ${v}_playing = false;\n` +
      `        static float ${v}_prev = 0.f;\n` +
      `        const int ${v}_len = ${info.frames};\n` +
      `        float ${v}_t = ${trig};\n` +
      `        bool ${v}_rise = (${v}_t >= 0.5f) && (${v}_prev < 0.5f);\n` +
      `        bool ${v}_fall = (${v}_t < 0.5f) && (${v}_prev >= 0.5f);\n` +
      `        ${v}_prev = ${v}_t;\n` +
      `        int ${v}_s = (int)((${stExpr}) * (float)(${v}_len - 1));\n` +
      `        int ${v}_e = (int)((${end}) * (float)(${v}_len - 1));\n` +
      `        if (${v}_e <= ${v}_s) ${v}_e = ${v}_len - 1;\n` +
      `        if (${v}_s >= ${v}_len - 1) ${v}_s = 0;\n` +
      `        if (${v}_rise) { ${v}_playing = true; ${v}_pos = (float)${v}_s; }\n` +
      (mode === 'gate' ? `        if (${v}_fall) ${v}_playing = false;\n` : `        (void)${v}_fall;\n`) +
      `        if (${v}_playing) {\n` +
      `            int ${v}_i0 = (int)${v}_pos;\n` +
      `            float ${v}_fr = ${v}_pos - (float)${v}_i0;\n` +
      `            int ${v}_i1 = (${v}_i0 + 1 <= ${v}_e) ? ${v}_i0 + 1 : ${v}_s;\n` +
      `            float ${v}_a = (float)${info.varName}[${v}_i0] * (1.f / 32768.f);\n` +
      `            float ${v}_b = (float)${info.varName}[${v}_i1] * (1.f / 32768.f);\n` +
      `            ${out} = (${v}_a * (1.f - ${v}_fr) + ${v}_b * ${v}_fr) * (${lvExpr});\n` +
      `            ${v}_pos += (${spExpr}) * ${formatFloat(rateRatio)};\n` +
      `            if (${v}_pos >= (float)${v}_e) {\n` +
      `                ${eoc} = 1.f;\n` +
      (mode === 'loop'
        ? `                ${v}_pos = (float)${v}_s + (${v}_pos - (float)${v}_e);\n` +
          `                if (${v}_pos >= (float)${v}_e) ${v}_pos = (float)${v}_s;\n`
        : `                ${v}_playing = false; ${v}_pos = (float)${v}_s;\n`) +
      `            }\n` +
      `        }\n` +
      `    }\n`
    )
  }
}
