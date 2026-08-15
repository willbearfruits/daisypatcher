import type { NodeEmitter } from '../nodeEmitters'
import { enumParam, formatFloat, numParam, rawNum, sampleInfoOf } from './shared'


/* --------------------------- sources --------------------------- */

export const oscillator: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_phase = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const freq = numParam(ctx.node, 'frequency', 220)
    const amp = numParam(ctx.node, 'amplitude', 0.5)
    const pitchCv = ctx.inputExpr(ctx.node.id, 'pitch_cv', '0.f')
    const ampCv = ctx.inputExpr(ctx.node.id, 'amp_cv', '1.f')
    const wave = enumParam(ctx.node, 'waveform', 'sine')
    const waveExpr =
      wave === 'sawtooth'
        ? `(2.f * ${v}_phase - 1.f)`
        : wave === 'square'
          ? `(${v}_phase < 0.5f ? 1.f : -1.f)`
          : wave === 'triangle'
            ? `(4.f * fabsf(${v}_phase - 0.5f) - 1.f)`
            : `sinf(${v}_phase * 6.28318530718f)`
    return (
      `    {\n` +
      `        float _f = ${freq} * powf(2.f, ${pitchCv});\n` +
      `        ${v}_phase += _f / (float)SAMPLE_RATE;\n` +
      `        if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `        if (${v}_phase < 0.f) ${v}_phase += 1.f;\n` +
      `    }\n` +
      `    float ${out} = ${waveExpr} * ${amp} * ${ampCv};\n`
    )
  }
}

export const noise: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `uint32_t ${v}_rng = 0x12345678u; float ${v}_pink = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const amp = numParam(ctx.node, 'amplitude', 0.3)
    const color = enumParam(ctx.node, 'color', 'white')
    if (color === 'pink') {
      return (
        `    float ${out};\n` +
      `    {\n` +
        `        ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
        `        float _w = ((${v}_rng >> 8) / 16777216.f) * 2.f - 1.f;\n` +
        `        ${v}_pink = 0.98f * ${v}_pink + 0.02f * _w;\n` +
        `        ${out} = ${v}_pink * 6.f * ${amp};\n` +
        `    }\n`
      )
    }
    return (
      `    ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `    float ${out} = (((${v}_rng >> 8) / 16777216.f) * 2.f - 1.f) * ${amp};\n`
    )
  }
}

export const lfo: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_phase = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const freq = numParam(ctx.node, 'frequency', 1)
    const depth = numParam(ctx.node, 'depth', 1)
    const offset = numParam(ctx.node, 'offset', 0)
    const wave = enumParam(ctx.node, 'waveform', 'sine')
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const offsetCvExpr = ctx.inputExpr(ctx.node.id, 'cv_offset', '__NC__')
    const freqExpr = rateCvExpr === '__NC__' ? `${freq}` : `fmaxf(0.01f, fminf(20.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    const offsetExpr = offsetCvExpr === '__NC__' ? `${offset}` : `fmaxf(-1.f, fminf(1.f, ${offsetCvExpr}))`
    const waveExpr =
      wave === 'saw'
        ? `(2.f * ${v}_phase - 1.f)`
        : wave === 'square'
          ? `(${v}_phase < 0.5f ? 1.f : -1.f)`
          : wave === 'tri'
            ? `(4.f * fabsf(${v}_phase - 0.5f) - 1.f)`
            : `sinf(${v}_phase * 6.28318530718f)`
    return (
      `    ${v}_phase += (${freqExpr}) / (float)SAMPLE_RATE;\n` +
      `    if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `    float ${out} = ${waveExpr} * (${depthExpr}) + (${offsetExpr});\n`
    )
  }
}

export const constant: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const v = numParam(ctx.node, 'value', 0)
    return `    float ${out} = ${v};\n`
  }
}

// ---- Karplus-Strong ------------------------------------------------------
//
// Fixed max buffer sized for 20 Hz fundamental at 48 kHz (+ pad), matching
// the worklet. Active line length is (SR / frequency). A rising edge on
// trigger OR the optional periodic retrigger fills the active region with
// white noise; the loop is a 1-pole LP inside feedback.

/*
 * PITCH FLOOR — 50 Hz, not 20.
 *
 * The Daisy's DaisySP `String` holds a 1024-sample delay line, so at 48 kHz the
 * lowest note it can render is 48000/1024 = 46.9 Hz. Below that the device
 * produces silence while the emulator, whose buffer is longer, plays
 * happily — which is exactly what `npm run test:audio` found when a step
 * sequencer's 0..1 CV clamped the pitch to the old 20 Hz floor and the
 * firmware went quiet.
 *
 * 50 Hz across all three implementations: above the hardware limit with
 * margin, and the app stops offering a note the device cannot play.
 */
export const karplus: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `static float ${v}_buf[2404] = {0};\n` +
      `int ${v}_wr = 0; int ${v}_len = 2;\n` +
      `float ${v}_lp = 0.f; float ${v}_prev_trig = 0.f;\n` +
      `int ${v}_auto_ctr = 0; uint32_t ${v}_rng = 0x2fe9ab01u;`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const f = rawNum(ctx.node, 'frequency', 220)
    const initLen = Math.max(2, Math.min(2400, Math.floor(48000 / Math.max(20, f))))
    return `    ${v}_len = ${initLen};`
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const freq = numParam(ctx.node, 'frequency', 220)
    const damping = numParam(ctx.node, 'damping', 0.5)
    const feedback = numParam(ctx.node, 'feedback', 0.99)
    const pitchExpr = ctx.inputExpr(ctx.node.id, 'cv_pitch', '__NC__')
    const decayExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const dampExpr = ctx.inputExpr(ctx.node.id, 'cv_damp', '__NC__')
    const fExpr = pitchExpr === '__NC__' ? freq : `fmaxf(50.f, fminf(2000.f, ${pitchExpr}))`
    const fbExpr = decayExpr === '__NC__' ? feedback : `fmaxf(0.9f, fminf(0.999f, ${decayExpr}))`
    const dExpr = dampExpr === '__NC__' ? damping : `fmaxf(0.f, fminf(1.f, ${dampExpr}))`
    const retrig = enumParam(ctx.node, 'retrigger', 'manual')
    const autoExpr =
      retrig === '1s'
        ? '(int)SAMPLE_RATE'
        : retrig === '500ms'
          ? '(int)(SAMPLE_RATE / 2)'
          : retrig === '250ms'
            ? '(int)(SAMPLE_RATE / 4)'
            : '0'
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _freq = ${fExpr};\n` +
      `        float _fb = ${fbExpr};\n` +
      `        float _damping = ${dExpr};\n` +
      `        int _target = (int)((float)SAMPLE_RATE / fmaxf(_freq, 50.f));\n` +
      `        if (_target < 2) _target = 2; if (_target > 2400) _target = 2400;\n` +
      `        ${v}_len = _target;\n` +
      `        float _lp_coef = _damping * 0.95f;\n` +
      `        int _auto_period = ${autoExpr};\n` +
      `        float _tv = (${trig});\n` +
      `        bool _edge = (_tv >= 0.5f) && (${v}_prev_trig < 0.5f);\n` +
      `        ${v}_prev_trig = _tv;\n` +
      `        if (_edge) {\n` +
      `            for (int _k = 0; _k < ${v}_len; _k++) {\n` +
      `                ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `                ${v}_buf[_k] = ((${v}_rng >> 8) / 16777216.f) * 2.f - 1.f;\n` +
      `            }\n` +
      `            ${v}_wr = 0; ${v}_lp = 0.f;\n` +
      `        }\n` +
      `        if (_auto_period > 0) {\n` +
      `            ${v}_auto_ctr++;\n` +
      `            if (${v}_auto_ctr >= _auto_period) {\n` +
      `                ${v}_auto_ctr = 0;\n` +
      `                for (int _k = 0; _k < ${v}_len; _k++) {\n` +
      `                    ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `                    ${v}_buf[_k] = ((${v}_rng >> 8) / 16777216.f) * 2.f - 1.f;\n` +
      `                }\n` +
      `                ${v}_wr = 0; ${v}_lp = 0.f;\n` +
      `            }\n` +
      `        } else {\n` +
      `            ${v}_auto_ctr = 0;\n` +
      `        }\n` +
      `        int _ri = ${v}_wr % ${v}_len;\n` +
      `        float _s = ${v}_buf[_ri];\n` +
      `        ${v}_lp = _s * (1.f - _lp_coef) + ${v}_lp * _lp_coef;\n` +
      `        float _next = ${v}_lp * _fb;\n` +
      `        if (_next > 1.f) _next = 1.f; else if (_next < -1.f) _next = -1.f;\n` +
      `        ${v}_buf[_ri] = _next;\n` +
      `        ${v}_wr++; if (${v}_wr >= ${v}_len) ${v}_wr -= ${v}_len;\n` +
      `        ${out} = _s;\n` +
      `    }\n`
    )
  }
}

// ---- FM operator ---------------------------------------------------------

export const fm_op: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_phase = 0.f; float ${v}_last = 0.f;`
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
    const ampExpr = ampCvExpr === '__NC__' ? amp : `fmaxf(0.f, fminf(1.f, ${ampCvExpr}))`
    const fbExpr = modIdxExpr === '__NC__' ? fb : `fmaxf(0.f, fminf(1.f, ${modIdxExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _f = ${freq} * ${ratio} * powf(2.f, ${pitchCv});\n` +
      `        float _ny = (float)SAMPLE_RATE * 0.5f;\n` +
      `        if (_f < 0.f) _f = 0.f; else if (_f > _ny) _f = _ny;\n` +
      `        float _inc = 6.28318530718f * _f / (float)SAMPLE_RATE;\n` +
      `        float _amp = ${ampExpr};\n` +
      `        float _fb = ${fbExpr};\n` +
      `        float _y = sinf(${v}_phase + (${mod}) + _fb * ${v}_last) * _amp;\n` +
      `        if (_y > 1.f) _y = 1.f; else if (_y < -1.f) _y = -1.f;\n` +
      `        ${v}_last = _y;\n` +
      `        ${v}_phase += _inc;\n` +
      `        if (${v}_phase >= 6.28318530718f) ${v}_phase -= 6.28318530718f;\n` +
      `        ${out} = _y;\n` +
      `    }\n`
    )
  }
}

// ---- FM2 (2-operator DX-style) ------------------------------------------

export const fm2: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_cph = 0.f; float ${v}_mph = 0.f;`
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
    const idxExpr = modIdxExpr === '__NC__' ? modIndex : `fmaxf(0.f, fminf(20.f, ${modIdxExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _ny = (float)SAMPLE_RATE * 0.5f;\n` +
      `        float _cf = ${freq} * powf(2.f, ${pitchCv});\n` +
      `        if (_cf < 0.f) _cf = 0.f; else if (_cf > _ny) _cf = _ny;\n` +
      `        float _mf = _cf * ${modRatio}; if (_mf > _ny) _mf = _ny;\n` +
      `        float _cinc = 6.28318530718f * _cf / (float)SAMPLE_RATE;\n` +
      `        float _minc = 6.28318530718f * _mf / (float)SAMPLE_RATE;\n` +
      `        float _idx = ${idxExpr};\n` +
      `        float _mod = sinf(${v}_mph) * _idx;\n` +
      `        float _a = ${amp} * fmaxf(0.f, ${ampCv});\n` +
      `        float _y = sinf(${v}_cph + _mod) * _a;\n` +
      `        if (_y > 1.f) _y = 1.f; else if (_y < -1.f) _y = -1.f;\n` +
      `        ${v}_cph += _cinc; if (${v}_cph >= 6.28318530718f) ${v}_cph -= 6.28318530718f;\n` +
      `        ${v}_mph += _minc; if (${v}_mph >= 6.28318530718f) ${v}_mph -= 6.28318530718f;\n` +
      `        ${out} = _y;\n` +
      `    }\n`
    )
  }
}

// ---- Wavetable morph -----------------------------------------------------
//
// Four tables of 2048 samples each built once in setup(): sine, saw-like,
// square-like, complex. Morph picks a neighbour pair + fractional blend.

export const wavetable: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `#ifndef DP_WT_SIZE\n#define DP_WT_SIZE 2048\n#endif\n` +
      `float ${v}_t[4][DP_WT_SIZE];\n` +
      `float ${v}_phase = 0.f;`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `    {\n` +
      `        float _maxT1 = 0.f, _maxT2 = 0.f, _maxT3 = 0.f;\n` +
      `        for (int _i = 0; _i < DP_WT_SIZE; _i++) {\n` +
      `            float _ph = (float)_i / (float)DP_WT_SIZE * 6.28318530718f;\n` +
      `            ${v}_t[0][_i] = sinf(_ph);\n` +
      `            float _s1 = 0.f;\n` +
      `            for (int _h = 1; _h <= 8; _h++) _s1 += sinf(_ph * _h) / (float)_h;\n` +
      `            ${v}_t[1][_i] = _s1;\n` +
      `            if (fabsf(_s1) > _maxT1) _maxT1 = fabsf(_s1);\n` +
      `            float _s2 = 0.f;\n` +
      `            for (int _h = 1; _h <= 15; _h += 2) _s2 += sinf(_ph * _h) / (float)_h;\n` +
      `            ${v}_t[2][_i] = _s2;\n` +
      `            if (fabsf(_s2) > _maxT2) _maxT2 = fabsf(_s2);\n` +
      `            float _s3 = sinf(_ph) * 0.6f + sinf(_ph * 2.17f) * 0.3f\n` +
      `                      + sinf(_ph * 3.41f) * 0.25f + sinf(_ph * 5.63f) * 0.15f\n` +
      `                      + sinf(_ph * 7.11f) * 0.1f;\n` +
      `            ${v}_t[3][_i] = _s3;\n` +
      `            if (fabsf(_s3) > _maxT3) _maxT3 = fabsf(_s3);\n` +
      `        }\n` +
      `        if (_maxT1 > 0.f) for (int _i = 0; _i < DP_WT_SIZE; _i++) ${v}_t[1][_i] /= _maxT1;\n` +
      `        if (_maxT2 > 0.f) for (int _i = 0; _i < DP_WT_SIZE; _i++) ${v}_t[2][_i] /= _maxT2;\n` +
      `        if (_maxT3 > 0.f) for (int _i = 0; _i < DP_WT_SIZE; _i++) ${v}_t[3][_i] /= _maxT3;\n` +
      `    }`
    )
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const pitchCv = ctx.inputExpr(ctx.node.id, 'pitch_cv', '0.f')
    const morphCv = ctx.inputExpr(ctx.node.id, 'morph_cv', '0.f')
    const freq = numParam(ctx.node, 'frequency', 220)
    const amp = numParam(ctx.node, 'amplitude', 0.5)
    const morph = numParam(ctx.node, 'morph', 0)
    return (
      // Declared OUTSIDE the braces: the scope exists to keep the locals
      // from colliding across nodes, but the output has to outlive it or
      // nothing downstream can read it.
      `    float ${out};\n` +
      `    {\n` +
      `        float _f = ${freq} * powf(2.f, ${pitchCv});\n` +
      `        float _ny = (float)SAMPLE_RATE * 0.5f;\n` +
      `        if (_f < 0.f) _f = 0.f; else if (_f > _ny) _f = _ny;\n` +
      `        float _m = ${morph} + (${morphCv});\n` +
      `        if (_m < 0.f) _m = 0.f; else if (_m > 1.f) _m = 1.f;\n` +
      `        float _pos = _m * 3.f;\n` +
      `        int _idx = (int)_pos; if (_idx > 3) _idx = 3;\n` +
      `        float _frac = _pos - (float)_idx;\n` +
      `        int _nxt = _idx < 3 ? _idx + 1 : 3;\n` +
      `        int _i0 = (int)${v}_phase; if (_i0 >= DP_WT_SIZE) _i0 = DP_WT_SIZE - 1;\n` +
      `        int _i1 = _i0 + 1; if (_i1 >= DP_WT_SIZE) _i1 = 0;\n` +
      `        float _pf = ${v}_phase - (float)_i0;\n` +
      `        float _sa = ${v}_t[_idx][_i0] * (1.f - _pf) + ${v}_t[_idx][_i1] * _pf;\n` +
      `        float _sb = ${v}_t[_nxt][_i0] * (1.f - _pf) + ${v}_t[_nxt][_i1] * _pf;\n` +
      `        float _y = (_sa * (1.f - _frac) + _sb * _frac) * ${amp};\n` +
      `        if (_y > 1.f) _y = 1.f; else if (_y < -1.f) _y = -1.f;\n` +
      `        float _inc = (_f * (float)DP_WT_SIZE) / (float)SAMPLE_RATE;\n` +
      `        ${v}_phase += _inc;\n` +
      `        while (${v}_phase >= (float)DP_WT_SIZE) ${v}_phase -= (float)DP_WT_SIZE;\n` +
      `        while (${v}_phase < 0.f) ${v}_phase += (float)DP_WT_SIZE;\n` +
      `        ${out} = _y;\n` +
      `    }\n`
    )
  }
}

// ---- Drums ---------------------------------------------------------------

export const drum_kick: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `float ${v}_phase = 0.f; float ${v}_amp = 0.f; float ${v}_pitch_env = 0.f;\n` +
      `float ${v}_atk = 0.f; int ${v}_attacking = 0; float ${v}_prev = 0.f;`
    )
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const tune = numParam(ctx.node, 'tune', 60)
    const decay = numParam(ctx.node, 'decay', 0.35)
    const punch = numParam(ctx.node, 'punch', 0.5)
    const sweep = numParam(ctx.node, 'sweep', 0.6)
    const tuneExpr = ctx.inputExpr(ctx.node.id, 'cv_tune', '__NC__')
    const decayExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const punchExpr = ctx.inputExpr(ctx.node.id, 'cv_punch', '__NC__')
    const tExpr = tuneExpr === '__NC__' ? tune : `fmaxf(30.f, fminf(200.f, ${tuneExpr}))`
    const dExpr = decayExpr === '__NC__' ? decay : `fmaxf(0.05f, fminf(2.f, ${decayExpr}))`
    const pExpr = punchExpr === '__NC__' ? punch : `fmaxf(0.f, fminf(1.f, ${punchExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _tune = ${tExpr};\n` +
      `        float _decay_s = ${dExpr};\n` +
      `        float _punch = ${pExpr};\n` +
      `        float _dec = fmaxf(0.05f, _decay_s);\n` +
      `        float _amp_coef = expf(-1.f / (_dec * (float)SAMPLE_RATE));\n` +
      `        float _pitch_coef = expf(-1.f / (0.03f * (float)SAMPLE_RATE));\n` +
      `        float _atk_seconds = 0.008f - _punch * 0.007f;\n` +
      `        float _atk_inc = 1.f / (_atk_seconds * (float)SAMPLE_RATE);\n` +
      `        float _topMul = 1.f + ${sweep} * 2.f;\n` +
      `        float _tv = (${trig});\n` +
      `        if (_tv >= 0.5f && ${v}_prev < 0.5f) {\n` +
      `            ${v}_pitch_env = 1.f; ${v}_amp = 0.f; ${v}_atk = 0.f; ${v}_attacking = 1; ${v}_phase = 0.f;\n` +
      `        }\n` +
      `        ${v}_prev = _tv;\n` +
      `        if (${v}_attacking) {\n` +
      `            ${v}_atk += _atk_inc;\n` +
      `            if (${v}_atk >= 1.f) { ${v}_atk = 1.f; ${v}_attacking = 0; ${v}_amp = 1.f; }\n` +
      `            else ${v}_amp = ${v}_atk;\n` +
      `        } else {\n` +
      `            ${v}_amp *= _amp_coef;\n` +
      `        }\n` +
      `        ${v}_pitch_env *= _pitch_coef;\n` +
      `        float _f = _tune * (1.f + (_topMul - 1.f) * ${v}_pitch_env);\n` +
      `        float _inc = 6.28318530718f * _f / (float)SAMPLE_RATE;\n` +
      `        float _y = sinf(${v}_phase) * ${v}_amp;\n` +
      `        if (_y > 1.f) _y = 1.f; else if (_y < -1.f) _y = -1.f;\n` +
      `        ${v}_phase += _inc;\n` +
      `        if (${v}_phase >= 6.28318530718f) ${v}_phase -= 6.28318530718f;\n` +
      `        ${out} = _y;\n` +
      `    }\n`
    )
  }
}

export const drum_snare: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `float ${v}_p1 = 0.f; float ${v}_p2 = 0.f; float ${v}_amp = 0.f;\n` +
      `float ${v}_hp = 0.f; float ${v}_prev = 0.f; uint32_t ${v}_rng = 0x9ab17c1u;`
    )
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const tune = numParam(ctx.node, 'tune', 200)
    const decay = numParam(ctx.node, 'decay', 0.2)
    const tone = numParam(ctx.node, 'tone', 0.5)
    const tuneExpr = ctx.inputExpr(ctx.node.id, 'cv_tune', '__NC__')
    const decayExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const noiseExpr = ctx.inputExpr(ctx.node.id, 'cv_noise', '__NC__')
    const tExpr = tuneExpr === '__NC__' ? tune : `fmaxf(100.f, fminf(400.f, ${tuneExpr}))`
    const dExpr = decayExpr === '__NC__' ? decay : `fmaxf(0.05f, fminf(1.f, ${decayExpr}))`
    const nExpr = noiseExpr === '__NC__' ? tone : `fmaxf(0.f, fminf(1.f, ${noiseExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _tune = ${tExpr};\n` +
      `        float _decay_s = ${dExpr};\n` +
      `        float _tone = ${nExpr};\n` +
      `        float _dec = fmaxf(0.05f, _decay_s);\n` +
      `        float _amp_coef = expf(-1.f / (_dec * (float)SAMPLE_RATE));\n` +
      `        float _lp_coef = expf(-6.28318530718f * 1000.f / (float)SAMPLE_RATE);\n` +
      `        float _inc1 = 6.28318530718f * _tune / (float)SAMPLE_RATE;\n` +
      `        float _inc2 = 6.28318530718f * (_tune * 1.59f) / (float)SAMPLE_RATE;\n` +
      `        float _tv = (${trig});\n` +
      `        if (_tv >= 0.5f && ${v}_prev < 0.5f) { ${v}_amp = 1.f; ${v}_p1 = 0.f; ${v}_p2 = 0.f; }\n` +
      `        ${v}_prev = _tv;\n` +
      `        float _t1 = ${v}_p1 / 6.28318530718f; float _b1 = 4.f * fabsf(_t1 - 0.5f) - 1.f;\n` +
      `        float _t2 = ${v}_p2 / 6.28318530718f; float _b2 = 4.f * fabsf(_t2 - 0.5f) - 1.f;\n` +
      `        float _body = (_b1 + _b2) * 0.5f;\n` +
      `        ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `        float _w = ((${v}_rng >> 8) / 16777216.f) * 2.f - 1.f;\n` +
      `        ${v}_hp = ${v}_hp * _lp_coef + _w * (1.f - _lp_coef);\n` +
      `        float _noise = _w - ${v}_hp;\n` +
      `        float _y = (_body * (1.f - _tone) + _noise * _tone) * ${v}_amp;\n` +
      `        ${v}_amp *= _amp_coef;\n` +
      `        if (_y > 1.f) _y = 1.f; else if (_y < -1.f) _y = -1.f;\n` +
      `        ${v}_p1 += _inc1; if (${v}_p1 >= 6.28318530718f) ${v}_p1 -= 6.28318530718f;\n` +
      `        ${v}_p2 += _inc2; if (${v}_p2 >= 6.28318530718f) ${v}_p2 -= 6.28318530718f;\n` +
      `        ${out} = _y;\n` +
      `    }\n`
    )
  }
}

export const drum_hat: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `float ${v}_ph[6] = {0}; float ${v}_amp = 0.f; float ${v}_prev = 0.f;\n` +
      `float ${v}_bpLow = 0.f; float ${v}_bpBand = 0.f;`
    )
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const decay = numParam(ctx.node, 'decay', 0.08)
    const tone = numParam(ctx.node, 'tone', 0.7)
    const decayExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const toneExpr = ctx.inputExpr(ctx.node.id, 'cv_tone', '__NC__')
    const dExpr = decayExpr === '__NC__' ? decay : `fmaxf(0.01f, fminf(0.5f, ${decayExpr}))`
    const tExpr = toneExpr === '__NC__' ? tone : `fmaxf(0.3f, fminf(1.f, ${toneExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        const float _ratios[6] = { 2.f, 3.f, 4.16f, 5.43f, 6.79f, 8.21f };\n` +
      `        float _decay_s = ${dExpr};\n` +
      `        float _tone = ${tExpr};\n` +
      `        float _dec = fmaxf(0.01f, _decay_s);\n` +
      `        float _amp_coef = expf(-1.f / (_dec * (float)SAMPLE_RATE));\n` +
      `        float _base = 40.f;\n` +
      `        float _ny = (float)SAMPLE_RATE * 0.5f;\n` +
      `        float _bpF = 8000.f * _tone; if (_bpF > _ny * 0.9f) _bpF = _ny * 0.9f;\n` +
      `        float _f = 2.f * sinf(3.14159265f * _bpF / (float)SAMPLE_RATE);\n` +
      `        float _q = 0.5f;\n` +
      `        float _tv = (${trig});\n` +
      `        if (_tv >= 0.5f && ${v}_prev < 0.5f) {\n` +
      `            ${v}_amp = 1.f; ${v}_bpLow = 0.f; ${v}_bpBand = 0.f;\n` +
      `            for (int _k = 0; _k < 6; _k++) ${v}_ph[_k] = 0.f;\n` +
      `        }\n` +
      `        ${v}_prev = _tv;\n` +
      `        float _mix = 0.f;\n` +
      `        for (int _k = 0; _k < 6; _k++) _mix += (${v}_ph[_k] < 3.14159265f ? 1.f : -1.f);\n` +
      `        _mix /= 6.f;\n` +
      `        for (int _k = 0; _k < 6; _k++) {\n` +
      `            ${v}_ph[_k] += 6.28318530718f * _base * _ratios[_k] / (float)SAMPLE_RATE;\n` +
      `            if (${v}_ph[_k] >= 6.28318530718f) ${v}_ph[_k] -= 6.28318530718f;\n` +
      `        }\n` +
      `        float _high = _mix - ${v}_bpLow - _q * ${v}_bpBand;\n` +
      `        ${v}_bpBand += _f * _high;\n` +
      `        ${v}_bpLow  += _f * ${v}_bpBand;\n` +
      `        float _y = ${v}_bpBand * ${v}_amp;\n` +
      `        ${v}_amp *= _amp_coef;\n` +
      `        if (_y > 1.f) _y = 1.f; else if (_y < -1.f) _y = -1.f;\n` +
      `        ${out} = _y;\n` +
      `    }\n`
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
