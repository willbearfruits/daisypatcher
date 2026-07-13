/**
 * ESP32-S3 per-kind emitters. Parallel to `nodeEmitters.ts` but producing
 * Arduino-framework C++ that does not depend on libDaisy / DaisySP. DSP
 * lives inline — the same math the Web Audio worklets use, expressed in
 * plain C++. This is the source of parity between the browser emulator
 * and the ESP32 firmware.
 *
 * Conventions match `nodeEmitters.ts`:
 *
 *   declare  — file-scope state for this node (float members, buffers).
 *   init     — one-shot setup inside `setup()`.
 *   process  — per-sample body inside the render-block loop. Emits
 *              `float <var>_<outSocket> = ...;` for each output.
 *
 * SAMPLE_RATE is a runtime constant injected by `targets/esp32s3.ts` at
 * the top of main.cpp. Delay-line / buffer sizes pick a max that fits at
 * any supported sample rate (up to 48 kHz), then clamp/scale at runtime.
 *
 * Any emitter that genuinely can't be inlined in this pass keeps the
 * passthrough + `c.warn()` and an explicit TODO comment, minimised.
 */
import type { NodeInstance, NodeKind } from '@/types/graph'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { NodeEmitter } from './nodeEmitters'

/* --------------------------- helpers --------------------------- */

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

function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return '0.f'
  if (Number.isInteger(v)) return `${v}.f`
  let s = v.toPrecision(9)
  if (s.includes('e') || s.includes('E')) s = v.toFixed(9)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0')
  return `${s}f`
}

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

/** Loud warning + passthrough: "this kind isn't viable on the MCU." */
function unsupported(kind: string, why: string): NodeEmitter {
  const base = makePassthrough(`not supported on ESP32-S3 (${why}) — passthrough`)
  return {
    declare: base.declare,
    init: base.init,
    process: (ctx) => {
      ctx.warn(`${kind}: ${why} — passthrough on ESP32-S3`)
      return base.process(ctx)
    }
  }
}

/* --------------------------- sources --------------------------- */

const oscillator: NodeEmitter = {
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

const noise: NodeEmitter = {
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
        `    {\n` +
        `        ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
        `        float _w = ((${v}_rng >> 8) / 16777216.f) * 2.f - 1.f;\n` +
        `        ${v}_pink = 0.98f * ${v}_pink + 0.02f * _w;\n` +
        `        float ${out} = ${v}_pink * 6.f * ${amp};\n` +
        `    }\n`
      )
    }
    return (
      `    ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `    float ${out} = (((${v}_rng >> 8) / 16777216.f) * 2.f - 1.f) * ${amp};\n`
    )
  }
}

const lfo: NodeEmitter = {
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

const constant: NodeEmitter = {
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

const karplus: NodeEmitter = {
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
    const fExpr = pitchExpr === '__NC__' ? freq : `fmaxf(20.f, fminf(2000.f, ${pitchExpr}))`
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
      `    {\n` +
      `        float _freq = ${fExpr};\n` +
      `        float _fb = ${fbExpr};\n` +
      `        float _damping = ${dExpr};\n` +
      `        int _target = (int)((float)SAMPLE_RATE / fmaxf(_freq, 20.f));\n` +
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
      `        float ${out} = _s;\n` +
      `    }\n`
    )
  }
}

// ---- FM operator ---------------------------------------------------------

const fm_op: NodeEmitter = {
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
      `        float ${out} = _y;\n` +
      `    }\n`
    )
  }
}

// ---- FM2 (2-operator DX-style) ------------------------------------------

const fm2: NodeEmitter = {
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
      `        float ${out} = _y;\n` +
      `    }\n`
    )
  }
}

// ---- Wavetable morph -----------------------------------------------------
//
// Four tables of 2048 samples each built once in setup(): sine, saw-like,
// square-like, complex. Morph picks a neighbour pair + fractional blend.

const wavetable: NodeEmitter = {
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
      `        float ${out} = _y;\n` +
      `    }\n`
    )
  }
}

// ---- Drums ---------------------------------------------------------------

const drum_kick: NodeEmitter = {
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
      `        float ${out} = _y;\n` +
      `    }\n`
    )
  }
}

const drum_snare: NodeEmitter = {
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
      `        float ${out} = _y;\n` +
      `    }\n`
    )
  }
}

const drum_hat: NodeEmitter = {
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
      `        float ${out} = _y;\n` +
      `    }\n`
    )
  }
}

/* --------------------------- amp / utility --------------------------- */

const gain: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const amt = numParam(ctx.node, 'gain', 1)
    const gainCvExpr = ctx.inputExpr(ctx.node.id, 'cv_gain', '__NC__')
    const gE = gainCvExpr === '__NC__'
      ? `${amt}`
      : `fmaxf(0.f, fminf(2.f, ${gainCvExpr}))`
    return `    float ${out} = (${input}) * (${gE});\n`
  }
}

const vca: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'cv', '1.f')
    return `    float ${out} = (${a}) * (${cv});\n`
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
      const gE = lvlExpr === '__NC__'
        ? `${g}`
        : `fmaxf(0.f, fminf(2.f, ${lvlExpr}))`
      parts.push(`(${sig}) * (${gE})`)
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
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const p = numParam(ctx.node, 'pan', 0)
    const cv = ctx.inputExpr(ctx.node.id, 'cv', '0.f')
    const panCvExpr = ctx.inputExpr(ctx.node.id, 'cv_pan', '__NC__')
    const rootExpr = panCvExpr === '__NC__'
      ? `${p}`
      : `fmaxf(-1.f, fminf(1.f, ${panCvExpr}))`
    return (
      `    float ${l}, ${r};\n` +
      `    {\n` +
      `        float _pn = (${rootExpr}) + (${cv});\n` +
      `        if (_pn < -1.f) _pn = -1.f; else if (_pn > 1.f) _pn = 1.f;\n` +
      `        float _p = _pn * 0.5f + 0.5f;\n` +
      `        float _gl = cosf(_p * 1.5707963268f);\n` +
      `        float _gr = sinf(_p * 1.5707963268f);\n` +
      `        ${l} = (${input}) * _gl;\n` +
      `        ${r} = (${input}) * _gr;\n` +
      `    }\n`
    )
  }
}

const clip: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const drive = numParam(ctx.node, 'drive', 1)
    const mode = enumParam(ctx.node, 'mode', 'hard')
    const driveCvExpr = ctx.inputExpr(ctx.node.id, 'cv_drive', '__NC__')
    const dE = driveCvExpr === '__NC__'
      ? `${drive}`
      : `fmaxf(1.f, fminf(20.f, ${driveCvExpr}))`
    if (mode === 'tanh') {
      return `    float ${out} = tanhf((${input}) * (${dE}));\n`
    }
    if (mode === 'soft') {
      return (
        `    float ${out};\n` +
        `    {\n` +
        `        float _x = (${input}) * (${dE});\n` +
        `        ${out} = _x / (1.f + fabsf(_x));\n` +
        `    }\n`
      )
    }
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _x = (${input}) * (${dE});\n` +
      `        if (_x > 1.f) _x = 1.f; else if (_x < -1.f) _x = -1.f;\n` +
      `        ${out} = _x;\n` +
      `    }\n`
    )
  }
}

const sumNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    return `    float ${out} = (${a}) + (${b});\n`
  }
}

const multiplyNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '1.f')
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
      `        float _m = (${mBase}) + (${cv});\n` +
      `        if (_m < 0.f) _m = 0.f; else if (_m > 1.f) _m = 1.f;\n` +
      `        ${out} = (${a}) * (1.f - _m) + (${b}) * _m;\n` +
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
      `        float _a = (${a});\n` +
      `        float _b = (${b});\n` +
      `        ${out} = _a * (1.f - _m) + (_a * _b) * _m;\n` +
      `    }\n`
    )
  }
}

const wavefolder: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const amt = numParam(ctx.node, 'amount', 1)
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _v = (${input}) * ${amt};\n` +
      `        ${out} = sinf(_v * 1.5707963268f);\n` +
      `    }\n`
    )
  }
}

/* --------------------------- filters --------------------------- */

// Chamberlin state-variable: one-pass. LP/HP/BP/Notch from the same state.
const filter_svf: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_lpS = 0.f; float ${v}_bpS = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lp = ctx.outputVar(ctx.node.id, 'lp')
    const hp = ctx.outputVar(ctx.node.id, 'hp')
    const bp = ctx.outputVar(ctx.node.id, 'bp')
    const notch = ctx.outputVar(ctx.node.id, 'notch')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'freq_cv', '0.f')
    const freq = numParam(ctx.node, 'frequency', 1000)
    const q = numParam(ctx.node, 'resonance', 0.2)
    const cutoffExpr = ctx.inputExpr(ctx.node.id, 'cv_cutoff', '__NC__')
    const resExpr = ctx.inputExpr(ctx.node.id, 'cv_res', '__NC__')
    const fBase = cutoffExpr === '__NC__'
      ? `${freq}`
      : `fmaxf(20.f, fminf(20000.f, ${cutoffExpr}))`
    const qBase = resExpr === '__NC__'
      ? `${q}`
      : `fmaxf(0.f, fminf(1.f, ${resExpr}))`
    return (
      `    float ${lp}, ${hp}, ${bp}, ${notch};\n` +
      `    {\n` +
      `        float _maxF = (float)SAMPLE_RATE * 0.45f;\n` +
      `        float _fc = (${fBase}) * powf(2.f, ${cv});\n` +
      `        if (_fc < 20.f) _fc = 20.f; else if (_fc > _maxF) _fc = _maxF;\n` +
      `        float _f = 2.f * sinf(3.14159265f * _fc / (float)SAMPLE_RATE);\n` +
      `        float _r = (${qBase}); if (_r < 0.f) _r = 0.f; else if (_r > 1.f) _r = 1.f;\n` +
      `        float _damp = 2.f * (1.f - _r);\n` +
      `        float _x = (${input});\n` +
      `        float _hpV = _x - ${v}_lpS - _damp * ${v}_bpS;\n` +
      `        ${v}_bpS += _f * _hpV;\n` +
      `        ${v}_lpS += _f * ${v}_bpS;\n` +
      `        if (${v}_lpS > 100.f || ${v}_lpS < -100.f) ${v}_lpS = 0.f;\n` +
      `        if (${v}_bpS > 100.f || ${v}_bpS < -100.f) ${v}_bpS = 0.f;\n` +
      `        ${lp} = ${v}_lpS; ${hp} = _hpV; ${bp} = ${v}_bpS; ${notch} = _hpV + ${v}_lpS;\n` +
      `    }\n`
    )
  }
}

// Moog ladder (Stilson/Smith): 4 one-poles + tanh-limited feedback.
const filter_moog: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_s1 = 0.f, ${v}_s2 = 0.f, ${v}_s3 = 0.f, ${v}_s4 = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'freq_cv', '0.f')
    const freq = numParam(ctx.node, 'frequency', 1000)
    const res = numParam(ctx.node, 'resonance', 0.3)
    const cutoffExpr = ctx.inputExpr(ctx.node.id, 'cv_cutoff', '__NC__')
    const resCvExpr = ctx.inputExpr(ctx.node.id, 'cv_res', '__NC__')
    const fBase = cutoffExpr === '__NC__'
      ? `${freq}`
      : `fmaxf(20.f, fminf(20000.f, ${cutoffExpr}))`
    const rBase = resCvExpr === '__NC__'
      ? `${res}`
      : `fmaxf(0.f, fminf(1.f, ${resCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _maxF = (float)SAMPLE_RATE * 0.45f;\n` +
      `        float _fc = (${fBase}) * powf(2.f, ${cv});\n` +
      `        if (_fc < 20.f) _fc = 20.f; else if (_fc > _maxF) _fc = _maxF;\n` +
      `        float _f = 2.f * sinf(3.14159265f * _fc / (float)SAMPLE_RATE);\n` +
      `        if (_f > 1.f) _f = 1.f;\n` +
      `        float _r = (${rBase}); if (_r < 0.f) _r = 0.f; else if (_r > 1.f) _r = 1.f;\n` +
      `        float _k = _r * 4.f;\n` +
      `        float _fb = tanhf(${v}_s4) * _k;\n` +
      `        float _x = (${input}) - _fb;\n` +
      `        ${v}_s1 += _f * (_x - ${v}_s1);\n` +
      `        ${v}_s2 += _f * (${v}_s1 - ${v}_s2);\n` +
      `        ${v}_s3 += _f * (${v}_s2 - ${v}_s3);\n` +
      `        ${v}_s4 += _f * (${v}_s3 - ${v}_s4);\n` +
      `        if (${v}_s1 > 100.f || ${v}_s1 < -100.f) ${v}_s1 = 0.f;\n` +
      `        if (${v}_s2 > 100.f || ${v}_s2 < -100.f) ${v}_s2 = 0.f;\n` +
      `        if (${v}_s3 > 100.f || ${v}_s3 < -100.f) ${v}_s3 = 0.f;\n` +
      `        if (${v}_s4 > 100.f || ${v}_s4 < -100.f) ${v}_s4 = 0.f;\n` +
      `        ${out} = ${v}_s4;\n` +
      `    }\n`
    )
  }
}

// ---- Formant -------------------------------------------------------------
// Three parallel biquad bandpass filters (RBJ cookbook), summed into the wet
// signal and blended with dry by `mix`. Morph crossfades target frequencies
// between the current vowel and the next in a/e/i/o/u rotation.

const VOWELS: Record<string, [number, number, number]> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240]
}
const VOWEL_ORDER = ['a', 'e', 'i', 'o', 'u'] as const

const formant: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_z1[3] = {0}; float ${v}_z2[3] = {0};`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const vowel = enumParam(ctx.node, 'vowel', 'a')
    const morph = numParam(ctx.node, 'morph', 0)
    const q = numParam(ctx.node, 'q', 5)
    const mix = numParam(ctx.node, 'mix', 0.6)
    const morphCvExpr = ctx.inputExpr(ctx.node.id, 'cv_morph', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const morphExpr = morphCvExpr === '__NC__' ? `${morph}` : `fmaxf(0.f, fminf(1.f, ${morphCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    const curIdx = Math.max(0, VOWEL_ORDER.indexOf(vowel as 'a'))
    const nxtIdx = (curIdx + 1) % VOWEL_ORDER.length
    const cur = VOWELS[VOWEL_ORDER[curIdx]]
    const nxt = VOWELS[VOWEL_ORDER[nxtIdx]]
    const curFs = cur.map(formatFloat).join(', ')
    const nxtFs = nxt.map(formatFloat).join(', ')
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        const float _cur[3] = { ${curFs} };\n` +
      `        const float _nxt[3] = { ${nxtFs} };\n` +
      `        float _ny = (float)SAMPLE_RATE * 0.45f;\n` +
      `        float _x = (${input});\n` +
      `        float _morph = (${morphExpr});\n` +
      `        float _mix = (${mixExpr});\n` +
      `        float _wet = 0.f;\n` +
      `        for (int _k = 0; _k < 3; _k++) {\n` +
      `            float _f = _cur[_k] * (1.f - _morph) + _nxt[_k] * _morph;\n` +
      `            if (_f < 20.f) _f = 20.f; else if (_f > _ny) _f = _ny;\n` +
      `            float _w0 = 6.28318530718f * _f / (float)SAMPLE_RATE;\n` +
      `            float _cosW = cosf(_w0); float _sinW = sinf(_w0);\n` +
      `            float _alpha = _sinW / (2.f * ${q});\n` +
      `            float _a0 = 1.f + _alpha;\n` +
      `            float _b0 = _alpha / _a0;\n` +
      `            float _b2 = -_alpha / _a0;\n` +
      `            float _a1 = (-2.f * _cosW) / _a0;\n` +
      `            float _a2 = (1.f - _alpha) / _a0;\n` +
      `            float _y = _b0 * _x + ${v}_z1[_k];\n` +
      `            ${v}_z1[_k] = _b2 * _x - _a1 * _y + ${v}_z2[_k];\n` +
      `            ${v}_z2[_k] = -_a2 * _y;\n` +
      `            _wet += _y;\n` +
      `        }\n` +
      `        _wet *= (1.f / 3.f);\n` +
      `        ${out} = _x * (1.f - _mix) + _wet * _mix;\n` +
      `    }\n`
    )
  }
}

/* --------------------------- envelopes --------------------------- */

const adsr: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_val = 0.f; int ${v}_stage = 0; float ${v}_last_gate = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const gate = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const a = numParam(ctx.node, 'attack', 0.01)
    const d = numParam(ctx.node, 'decay', 0.1)
    const s = numParam(ctx.node, 'sustain', 0.6)
    const r = numParam(ctx.node, 'release', 0.2)
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const decCvExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const susCvExpr = ctx.inputExpr(ctx.node.id, 'cv_sustain', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const aExpr = atkCvExpr === '__NC__' ? `${a}` : `fmaxf(0.001f, fminf(4.f, ${atkCvExpr}))`
    const dExpr = decCvExpr === '__NC__' ? `${d}` : `fmaxf(0.001f, fminf(4.f, ${decCvExpr}))`
    const sExpr = susCvExpr === '__NC__' ? `${s}` : `fmaxf(0.f, fminf(1.f, ${susCvExpr}))`
    const rExpr = relCvExpr === '__NC__' ? `${r}` : `fmaxf(0.001f, fminf(8.f, ${relCvExpr}))`
    return (
      `    {\n` +
      `        float _g = (${gate});\n` +
      `        float _a = (${aExpr}); float _d = (${dExpr}); float _s = (${sExpr}); float _r = (${rExpr});\n` +
      `        if (_g > 0.5f && ${v}_last_gate <= 0.5f) ${v}_stage = 1;\n` +
      `        if (_g <= 0.5f && ${v}_last_gate > 0.5f) ${v}_stage = 4;\n` +
      `        ${v}_last_gate = _g;\n` +
      `        float _dt = 1.f / (float)SAMPLE_RATE;\n` +
      `        if (${v}_stage == 1) { ${v}_val += _dt / fmaxf(_a, 1e-4f); if (${v}_val >= 1.f) { ${v}_val = 1.f; ${v}_stage = 2; } }\n` +
      `        else if (${v}_stage == 2) { ${v}_val -= (1.f - _s) * _dt / fmaxf(_d, 1e-4f); if (${v}_val <= _s) { ${v}_val = _s; ${v}_stage = 3; } }\n` +
      `        else if (${v}_stage == 3) { ${v}_val = _s; }\n` +
      `        else if (${v}_stage == 4) { ${v}_val -= ${v}_val * _dt / fmaxf(_r, 1e-4f); if (${v}_val < 0.001f) { ${v}_val = 0.f; ${v}_stage = 0; } }\n` +
      `        float ${out} = ${v}_val;\n` +
      `    }\n`
    )
  }
}

const ar: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_val = 0.f; int ${v}_stage = 0; float ${v}_last_gate = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const gate = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const a = numParam(ctx.node, 'attack', 0.01)
    const r = numParam(ctx.node, 'release', 0.2)
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const aExpr = atkCvExpr === '__NC__' ? `${a}` : `fmaxf(0.001f, fminf(4.f, ${atkCvExpr}))`
    const rExpr = relCvExpr === '__NC__' ? `${r}` : `fmaxf(0.001f, fminf(8.f, ${relCvExpr}))`
    return (
      `    {\n` +
      `        float _g = (${gate});\n` +
      `        float _a = (${aExpr}); float _r = (${rExpr});\n` +
      `        if (_g > 0.5f && ${v}_last_gate <= 0.5f) ${v}_stage = 1;\n` +
      `        if (_g <= 0.5f && ${v}_last_gate > 0.5f) ${v}_stage = 2;\n` +
      `        ${v}_last_gate = _g;\n` +
      `        float _dt = 1.f / (float)SAMPLE_RATE;\n` +
      `        if (${v}_stage == 1) { ${v}_val += _dt / fmaxf(_a, 1e-4f); if (${v}_val >= 1.f) { ${v}_val = 1.f; } }\n` +
      `        else if (${v}_stage == 2) { ${v}_val -= ${v}_val * _dt / fmaxf(_r, 1e-4f); if (${v}_val < 0.001f) { ${v}_val = 0.f; ${v}_stage = 0; } }\n` +
      `        float ${out} = ${v}_val;\n` +
      `    }\n`
    )
  }
}

const envelope_follower: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_state = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const a = numParam(ctx.node, 'attack', 0.01)
    const r = numParam(ctx.node, 'release', 0.1)
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const aExpr = atkCvExpr === '__NC__' ? `${a}` : `fmaxf(0.001f, fminf(1.f, ${atkCvExpr}))`
    const rExpr = relCvExpr === '__NC__' ? `${r}` : `fmaxf(0.001f, fminf(2.f, ${relCvExpr}))`
    return (
      `    {\n` +
      `        float _x = fabsf(${input});\n` +
      `        float _ca = 1.f - expf(-1.f / ((float)SAMPLE_RATE * fmaxf((${aExpr}), 1e-4f)));\n` +
      `        float _cr = 1.f - expf(-1.f / ((float)SAMPLE_RATE * fmaxf((${rExpr}), 1e-4f)));\n` +
      `        float _c = (_x > ${v}_state) ? _ca : _cr;\n` +
      `        ${v}_state += (_x - ${v}_state) * _c;\n` +
      `        float ${out} = ${v}_state;\n` +
      `    }\n`
    )
  }
}

/* --------------------------- CV tools --------------------------- */

const slew: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_state = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const rise = numParam(ctx.node, 'rise', 0.05)
    const fall = numParam(ctx.node, 'fall', 0.05)
    const riseCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rise', '__NC__')
    const fallCvExpr = ctx.inputExpr(ctx.node.id, 'cv_fall', '__NC__')
    const rE = riseCvExpr === '__NC__'
      ? `${rise}`
      : `fmaxf(0.f, fminf(2.f, ${riseCvExpr}))`
    const fE = fallCvExpr === '__NC__'
      ? `${fall}`
      : `fmaxf(0.f, fminf(2.f, ${fallCvExpr}))`
    return (
      `    {\n` +
      `        float _x = (${input});\n` +
      `        float _cr = 1.f - expf(-1.f / ((float)SAMPLE_RATE * fmaxf((${rE}), 1e-4f)));\n` +
      `        float _cf = 1.f - expf(-1.f / ((float)SAMPLE_RATE * fmaxf((${fE}), 1e-4f)));\n` +
      `        float _c = (_x > ${v}_state) ? _cr : _cf;\n` +
      `        ${v}_state += (_x - ${v}_state) * _c;\n` +
      `    }\n` +
      `    float ${out} = ${v}_state;\n`
    )
  }
}

const sample_hold: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_held = 0.f; float ${v}_last_trig = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    return (
      `    {\n` +
      `        float _t = (${trig});\n` +
      `        if (_t > 0.5f && ${v}_last_trig <= 0.5f) ${v}_held = (${input});\n` +
      `        ${v}_last_trig = _t;\n` +
      `        float ${out} = ${v}_held;\n` +
      `    }\n`
    )
  }
}

const inverter: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = -(${input});\n`
  }
}

const scaleNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const mul = numParam(ctx.node, 'multiply', 1)
    const add = numParam(ctx.node, 'add', 0)
    return `    float ${out} = (${input}) * ${mul} + ${add};\n`
  }
}

/** Range remap — Max/PD `scale` with optional clamp. Mirrors the Daisy version. */
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
    const inp = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const ref = ctx.inputExpr(ctx.node.id, 'ref', '0.f')
    const thr = numParam(ctx.node, 'threshold', 0)
    const thrCvExpr = ctx.inputExpr(ctx.node.id, 'cv_threshold', '__NC__')
    const tE = thrCvExpr === '__NC__'
      ? `${thr}`
      : `fmaxf(-1.f, fminf(1.f, ${thrCvExpr}))`
    return `    float ${out} = ((${inp}) > ((${ref}) + (${tE}))) ? 1.f : 0.f;\n`
  }
}

/* --------------------------- sequencing --------------------------- */

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
      `    ${v}_phase += ((${bpmExpr}) / 60.f) / (float)SAMPLE_RATE;\n` +
      `    if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `    float ${out} = (${v}_phase < ${pw}) ? 1.f : 0.f;\n`
    )
  }
}

const clock_divider: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `uint32_t ${v}_count = 0; float ${v}_prev_in = 0.f;`
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
      `        float _ci = ${i};\n` +
      `        if (_ci > 0.5f && ${v}_prev_in <= 0.5f) ${v}_count++;\n` +
      `        ${v}_prev_in = _ci;\n` +
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
    return `uint32_t ${v}_step = 0; float ${v}_prev_clk = 0.f; float ${v}_prev_rst = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const cvOut = ctx.outputVar(ctx.node.id, 'cv')
    const gateOut = ctx.outputVar(ctx.node.id, 'gate')
    const clk = ctx.inputExpr(ctx.node.id, 'clock', '0.f')
    const rst = ctx.inputExpr(ctx.node.id, 'reset', '0.f')
    const steps: string[] = []
    for (let i = 1; i <= 8; i++) steps.push(numParam(ctx.node, `s${i}`, 0))
    const gates: string[] = []
    for (let i = 1; i <= 8; i++) {
      const g = enumParam(ctx.node, `g${i}`, i <= 4 ? 'on' : 'off')
      gates.push(g === 'on' ? '1.f' : '0.f')
    }
    return (
      `    static const float ${v}_steps[8] = { ${steps.join(', ')} };\n` +
      `    static const float ${v}_gates[8] = { ${gates.join(', ')} };\n` +
      `    {\n` +
      `        float _ci = ${clk}; float _ri = ${rst};\n` +
      `        if (_ri > 0.5f && ${v}_prev_rst <= 0.5f) ${v}_step = 0;\n` +
      `        ${v}_prev_rst = _ri;\n` +
      `        if (_ci > 0.5f && ${v}_prev_clk <= 0.5f) ${v}_step = (${v}_step + 1u) & 7u;\n` +
      `        ${v}_prev_clk = _ci;\n` +
      `    }\n` +
      `    float ${cvOut} = ${v}_steps[${v}_step];\n` +
      `    float ${gateOut} = ${v}_gates[${v}_step] * ((${clk}) > 0.5f ? 1.f : 0.f);\n`
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
    return out.slice(n - r).concat(out.slice(0, n - r))
  }
  return out
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
      `uint32_t ${v}_step = 0; float ${v}_prev_clk = 0.f; float ${v}_prev_rst = 0.f;`
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
      `        float _ci = ${clk}; float _ri = ${rst};\n` +
      `        if (_ri > 0.5f && ${v}_prev_rst <= 0.5f) ${v}_step = 0;\n` +
      `        ${v}_prev_rst = _ri;\n` +
      `        if (_ci > 0.5f && ${v}_prev_clk <= 0.5f) ${v}_step = (${v}_step + 1u) % ${steps}u;\n` +
      `        ${v}_prev_clk = _ci;\n` +
      `    }\n` +
      `    float ${out} = (${v}_pattern[${v}_step] && ((${clk}) > 0.5f)) ? 1.f : 0.f;\n`
    )
  }
}

const randomNode: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `uint32_t ${v}_rng = 0x1f2e3d4cu; float ${v}_val = 0.f;\n` +
      `float ${v}_prev_clk = 0.f; float ${v}_phase = 0.f;`
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
      return (
        `    {\n` +
        `        float _ci = ${clkExpr};\n` +
        `        if (_ci > 0.5f && ${v}_prev_clk <= 0.5f) {\n` +
        `            ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
        `            float _r = (${v}_rng >> 8) / 16777216.f;\n` +
        `            ${v}_val = (_r * 2.f - 1.f) * ${range};\n` +
        `        }\n` +
        `        ${v}_prev_clk = _ci;\n` +
        `    }\n` +
        `    float ${out} = ${v}_val;\n`
      )
    }
    return (
      `    {\n` +
      `        ${v}_phase += (${rateExpr}) / (float)SAMPLE_RATE;\n` +
      `        if (${v}_phase >= 1.f) {\n` +
      `            ${v}_phase -= 1.f;\n` +
      `            ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `            float _r = (${v}_rng >> 8) / 16777216.f;\n` +
      `            ${v}_val = (_r * 2.f - 1.f) * ${range};\n` +
      `        }\n` +
      `    }\n` +
      `    float ${out} = ${v}_val;\n`
    )
  }
}

const dust: NodeEmitter = {
  declare: (ctx) => `uint32_t ${ctx.varName(ctx.node.id)}_rng = 0xabc12345u;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const density = numParam(ctx.node, 'density', 5)
    const densityCvExpr = ctx.inputExpr(ctx.node.id, 'cv_density', '__NC__')
    const dExpr = densityCvExpr === '__NC__'
      ? `${density}`
      : `fmaxf(0.1f, fminf(50.f, ${densityCvExpr}))`
    return (
      `    ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `    float ${out} = (((${v}_rng >> 8) / 16777216.f) < ((${dExpr}) / (float)SAMPLE_RATE)) ? 1.f : 0.f;\n`
    )
  }
}

const arp: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `uint32_t ${v}_idx = 0; float ${v}_prev_clk = 0.f; uint32_t ${v}_rng = 0xcaf31u;`
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
    for (let o = 0; o < octaves; o++) for (const st of intervals) notes.push((o * 12 + st) / 12)
    const pattern = enumParam(ctx.node, 'pattern', 'up')
    const len = notes.length
    const arr = notes.map(formatFloat).join(', ')
    const stepLine =
      pattern === 'down'
        ? `            ${v}_idx = (${v}_idx == 0) ? ${len - 1}u : ${v}_idx - 1u;\n`
        : pattern === 'random'
          ? `            ${v}_rng = ${v}_rng * 1664525u + 1013904223u; ${v}_idx = ${v}_rng % ${len}u;\n`
          : `            ${v}_idx = (${v}_idx + 1u) % ${len}u;\n`
    return (
      `    static const float ${v}_notes[${len}] = { ${arr} };\n` +
      `    {\n` +
      `        float _ci = ${clk};\n` +
      `        if (_ci > 0.5f && ${v}_prev_clk <= 0.5f && (${gIn}) > 0.5f) {\n` +
      stepLine +
      `        }\n` +
      `        ${v}_prev_clk = _ci;\n` +
      `    }\n` +
      `    float ${cvOut} = ${v}_notes[${v}_idx] + ${root};\n` +
      `    float ${gateOut} = ((${gIn}) > 0.5f && (${clk}) > 0.5f) ? 1.f : 0.f;\n`
    )
  }
}

/* --------------------------- effects (core) --------------------------- */

const delay: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `static float ${v}_buf[96000] = {0}; int ${v}_idx = 0;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const time = numParam(ctx.node, 'time', 0.25)
    const fb = numParam(ctx.node, 'feedback', 0.4)
    const mix = numParam(ctx.node, 'mix', 0.5)
    const legacyTimeCvExpr = ctx.inputExpr(ctx.node.id, 'time_cv', '__NC__')
    const timeReplaceExpr = ctx.inputExpr(ctx.node.id, 'cv_time', '__NC__')
    const fbCvExpr = ctx.inputExpr(ctx.node.id, 'cv_feedback', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    // Replace-semantics cv_time wins; else legacy octave-scaled time_cv; else sidebar.
    let timeExpr: string
    if (timeReplaceExpr !== '__NC__') {
      timeExpr = `fmaxf(0.001f, fminf(2.f, ${timeReplaceExpr}))`
    } else if (legacyTimeCvExpr !== '__NC__') {
      timeExpr = `fmaxf(0.001f, fminf(2.f, (${time}) * powf(2.f, ${legacyTimeCvExpr})))`
    } else {
      timeExpr = `${time}`
    }
    const fbExpr = fbCvExpr === '__NC__' ? `${fb}` : `fmaxf(0.f, fminf(0.95f, ${fbCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        int _len = (int)((${timeExpr}) * (float)SAMPLE_RATE); if (_len < 1) _len = 1; if (_len > 96000) _len = 96000;\n` +
      `        int _ri = ${v}_idx - _len; if (_ri < 0) _ri += 96000;\n` +
      `        float _wet = ${v}_buf[_ri];\n` +
      `        float _in = (${input});\n` +
      `        ${v}_buf[${v}_idx] = _in + _wet * (${fbExpr});\n` +
      `        ${v}_idx = (${v}_idx + 1) % 96000;\n` +
      `        ${out} = _in * (1.f - (${mixExpr})) + _wet * (${mixExpr});\n` +
      `    }\n`
    )
  }
}

// ---- Reverb (FreeVerb) --------------------------------------------------
//
// 8 parallel lowpass-feedback combs summed into 4 series allpasses.
// Comb/allpass lengths from the classic 44.1 kHz template, scaled to the
// runtime sample rate at init. Buffers live in DRAM (~15 KB total per
// reverb instance at 48 kHz, fp32).

const reverb: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    // Max lengths chosen to fit a 48 kHz sample rate comfortably.
    return (
      `static const int ${v}_comb_maxlen[8] = { 1214, 1293, 1389, 1475, 1547, 1622, 1694, 1759 };\n` +
      `static const int ${v}_ap_maxlen[4] = { 605, 480, 371, 245 };\n` +
      `static float ${v}_comb_buf[8][1760] = {{0}};\n` +
      `static int ${v}_comb_idx[8] = {0};\n` +
      `static int ${v}_comb_len[8] = {0};\n` +
      `static float ${v}_comb_store[8] = {0};\n` +
      `static float ${v}_ap_buf[4][608] = {{0}};\n` +
      `static int ${v}_ap_idx[4] = {0};\n` +
      `static int ${v}_ap_len[4] = {0};`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `    {\n` +
      `        static const int _comb_44k[8] = { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };\n` +
      `        static const int _ap_44k[4] = { 556, 441, 341, 225 };\n` +
      `        float _scale = (float)SAMPLE_RATE / 44100.f;\n` +
      `        for (int _k = 0; _k < 8; _k++) {\n` +
      `            int _L = (int)((float)_comb_44k[_k] * _scale + 0.5f);\n` +
      `            if (_L < 1) _L = 1;\n` +
      `            if (_L > ${v}_comb_maxlen[_k]) _L = ${v}_comb_maxlen[_k];\n` +
      `            ${v}_comb_len[_k] = _L;\n` +
      `        }\n` +
      `        for (int _k = 0; _k < 4; _k++) {\n` +
      `            int _L = (int)((float)_ap_44k[_k] * _scale + 0.5f);\n` +
      `            if (_L < 1) _L = 1;\n` +
      `            if (_L > ${v}_ap_maxlen[_k]) _L = ${v}_ap_maxlen[_k];\n` +
      `            ${v}_ap_len[_k] = _L;\n` +
      `        }\n` +
      `    }`
    )
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
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
      `    float ${out};\n` +
      `    {\n` +
      `        float _size = (${sizeExpr}); if (_size < 0.f) _size = 0.f; else if (_size > 1.f) _size = 1.f;\n` +
      `        float _damp = (${dampExpr}); if (_damp < 0.f) _damp = 0.f; else if (_damp > 1.f) _damp = 1.f;\n` +
      `        float _m = (${mixExpr}); if (_m < 0.f) _m = 0.f; else if (_m > 1.f) _m = 1.f;\n` +
      `        float _roomsize = _size * 0.28f + 0.7f;\n` +
      `        float _d1 = _damp * 0.4f;\n` +
      `        float _d2 = 1.f - _d1;\n` +
      `        float _dry = (${input});\n` +
      `        float _in = _dry * 0.015f;\n` +
      `        float _wet = 0.f;\n` +
      `        for (int _k = 0; _k < 8; _k++) {\n` +
      `            int _idx = ${v}_comb_idx[_k];\n` +
      `            float _o = ${v}_comb_buf[_k][_idx];\n` +
      `            ${v}_comb_store[_k] = _o * _d2 + ${v}_comb_store[_k] * _d1;\n` +
      `            ${v}_comb_buf[_k][_idx] = _in + ${v}_comb_store[_k] * _roomsize;\n` +
      `            _idx++; if (_idx >= ${v}_comb_len[_k]) _idx = 0;\n` +
      `            ${v}_comb_idx[_k] = _idx;\n` +
      `            _wet += _o;\n` +
      `        }\n` +
      `        for (int _k = 0; _k < 4; _k++) {\n` +
      `            int _idx = ${v}_ap_idx[_k];\n` +
      `            float _bo = ${v}_ap_buf[_k][_idx];\n` +
      `            float _o = -_wet + _bo;\n` +
      `            ${v}_ap_buf[_k][_idx] = _wet + _bo * 0.5f;\n` +
      `            _idx++; if (_idx >= ${v}_ap_len[_k]) _idx = 0;\n` +
      `            ${v}_ap_idx[_k] = _idx;\n` +
      `            _wet = _o;\n` +
      `        }\n` +
      `        ${out} = _dry * (1.f - _m) + _wet * _m;\n` +
      `    }\n`
    )
  }
}

const overdrive: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const drive = numParam(ctx.node, 'drive', 0.5)
    const driveCvExpr = ctx.inputExpr(ctx.node.id, 'cv_drive', '__NC__')
    const dE = driveCvExpr === '__NC__'
      ? `${drive}`
      : `fmaxf(0.f, fminf(1.f, ${driveCvExpr}))`
    return `    float ${out} = tanhf((${input}) * (1.f + (${dE}) * 10.f));\n`
  }
}

const bitcrush: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_held = 0.f; int ${v}_ctr = 0;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const bits = numParam(ctx.node, 'bits', 8)
    const rate = numParam(ctx.node, 'rate', 1)
    const bitsCvExpr = ctx.inputExpr(ctx.node.id, 'cv_bits', '__NC__')
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const bE = bitsCvExpr === '__NC__'
      ? `${bits}`
      : `fmaxf(1.f, fminf(16.f, ${bitsCvExpr}))`
    const rE = rateCvExpr === '__NC__'
      ? `${rate}`
      : `fmaxf(0.01f, fminf(1.f, ${rateCvExpr}))`
    return (
      `    {\n` +
      `        int _step = (int)(1.f / fmaxf((${rE}), 0.001f));\n` +
      `        if (${v}_ctr >= _step) { ${v}_ctr = 0; float _levels = powf(2.f, (${bE})); ${v}_held = floorf((${input}) * _levels) / _levels; }\n` +
      `        ${v}_ctr++;\n` +
      `        float ${out} = ${v}_held;\n` +
      `    }\n`
    )
  }
}

const tremolo: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_phase = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const rate = numParam(ctx.node, 'rate', 4)
    const depth = numParam(ctx.node, 'depth', 0.5)
    const rateOctExpr = ctx.inputExpr(ctx.node.id, 'rate_cv', '__NC__')
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
      `    ${v}_phase += (${rateExpr}) / (float)SAMPLE_RATE;\n` +
      `    if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `    float ${out} = (${input}) * (1.f - (${depthExpr}) * (0.5f - 0.5f * sinf(${v}_phase * 6.28318530718f)));\n`
    )
  }
}

// ---- Chorus --------------------------------------------------------------
//
// Fixed 2048-sample circular buffer (~42 ms at 48 kHz). Sine LFO modulates
// a tap around an 8 ms centre by ±6 ms * depth. Linear-interpolated read.

const chorus: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `static float ${v}_buf[2048] = {0}; int ${v}_wr = 0; float ${v}_lfo = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
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
      `    float ${out};\n` +
      `    {\n` +
      `        float _x = (${input});\n` +
      `        ${v}_buf[${v}_wr] = _x;\n` +
      `        float _base = 0.008f * (float)SAMPLE_RATE;\n` +
      `        float _mod = 0.006f * (float)SAMPLE_RATE * (${depthExpr});\n` +
      `        float _d = _base + sinf(${v}_lfo) * _mod;\n` +
      `        if (_d < 1.f) _d = 1.f; if (_d > 2046.f) _d = 2046.f;\n` +
      `        float _rp = (float)${v}_wr - _d;\n` +
      `        while (_rp < 0.f) _rp += 2048.f;\n` +
      `        int _r0 = (int)_rp; float _frac = _rp - (float)_r0;\n` +
      `        int _r1 = (_r0 + 1) & 2047;\n` +
      `        float _d0 = ${v}_buf[_r0 & 2047];\n` +
      `        float _d1 = ${v}_buf[_r1];\n` +
      `        float _dy = _d0 * (1.f - _frac) + _d1 * _frac;\n` +
      `        float _m = (${mixExpr});\n` +
      `        ${out} = _x * (1.f - _m) + _dy * _m;\n` +
      `        ${v}_wr = (${v}_wr + 1) & 2047;\n` +
      `        ${v}_lfo += 6.28318530718f * (${rateExpr}) / (float)SAMPLE_RATE;\n` +
      `        if (${v}_lfo >= 6.28318530718f) ${v}_lfo -= 6.28318530718f;\n` +
      `    }\n`
    )
  }
}

// ---- Phaser --------------------------------------------------------------
// N cascaded 1-pole allpasses swept by a sine LFO, with feedback.

const phaser: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_z[8] = {0}; float ${v}_lfo = 0.f; float ${v}_fb = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const rate = numParam(ctx.node, 'rate', 0.5)
    const depth = numParam(ctx.node, 'depth', 0.7)
    const feedback = numParam(ctx.node, 'feedback', 0.5)
    const mix = numParam(ctx.node, 'mix', 0.5)
    const stagesStr = enumParam(ctx.node, 'stages', '4')
    const stages = stagesStr === '6' ? 6 : stagesStr === '8' ? 8 : 4
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const fbCvExpr = ctx.inputExpr(ctx.node.id, 'cv_feedback', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const rateExpr = rateCvExpr === '__NC__' ? `${rate}` : `fmaxf(0.05f, fminf(8.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    const fbExpr = fbCvExpr === '__NC__' ? `${feedback}` : `fmaxf(0.f, fminf(0.9f, ${fbCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _x = (${input});\n` +
      `        float _lfoV = sinf(${v}_lfo);\n` +
      `        float _logMin = 5.2983174f; /* ln(200) */\n` +
      `        float _logMax = 8.2940497f; /* ln(4000) */\n` +
      `        float _center = 0.5f * (_logMin + _logMax);\n` +
      `        float _half = 0.5f * (_logMax - _logMin);\n` +
      `        float _logF = _center + _lfoV * _half * (${depthExpr});\n` +
      `        float _f = expf(_logF);\n` +
      `        float _ny = (float)SAMPLE_RATE * 0.45f;\n` +
      `        if (_f < 20.f) _f = 20.f; else if (_f > _ny) _f = _ny;\n` +
      `        float _t = tanf(3.14159265f * _f / (float)SAMPLE_RATE);\n` +
      `        float _a1 = (_t - 1.f) / (_t + 1.f);\n` +
      `        float _vv = _x + ${v}_fb * (${fbExpr});\n` +
      `        for (int _s = 0; _s < ${stages}; _s++) {\n` +
      `            float _y = _a1 * _vv + ${v}_z[_s];\n` +
      `            ${v}_z[_s] = _vv - _a1 * _y;\n` +
      `            _vv = _y;\n` +
      `        }\n` +
      `        ${v}_fb = _vv;\n` +
      `        float _m = (${mixExpr});\n` +
      `        ${out} = _x * (1.f - _m) + _vv * _m;\n` +
      `        ${v}_lfo += 6.28318530718f * (${rateExpr}) / (float)SAMPLE_RATE;\n` +
      `        if (${v}_lfo >= 6.28318530718f) ${v}_lfo -= 6.28318530718f;\n` +
      `    }\n`
    )
  }
}

// ---- Flanger -------------------------------------------------------------
// Short modulated delay + signed feedback.

const flanger: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `static float ${v}_buf[2048] = {0}; int ${v}_wr = 0; float ${v}_lfo = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const rate = numParam(ctx.node, 'rate', 0.3)
    const depth = numParam(ctx.node, 'depth', 0.6)
    const feedback = numParam(ctx.node, 'feedback', 0.5)
    const mix = numParam(ctx.node, 'mix', 0.5)
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const fbCvExpr = ctx.inputExpr(ctx.node.id, 'cv_feedback', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const rateExpr = rateCvExpr === '__NC__' ? `${rate}` : `fmaxf(0.05f, fminf(5.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    const fbExpr = fbCvExpr === '__NC__' ? `${feedback}` : `fmaxf(-0.95f, fminf(0.95f, ${fbCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _fb = (${fbExpr});\n` +
      `        if (_fb > 0.95f) _fb = 0.95f; else if (_fb < -0.95f) _fb = -0.95f;\n` +
      `        float _x = (${input});\n` +
      `        float _base = 0.0015f * (float)SAMPLE_RATE;\n` +
      `        float _mod = 0.004f * (float)SAMPLE_RATE * (${depthExpr});\n` +
      `        float _lfoV = (sinf(${v}_lfo) + 1.f) * 0.5f;\n` +
      `        float _d = _base + _lfoV * _mod;\n` +
      `        if (_d < 1.f) _d = 1.f; if (_d > 2046.f) _d = 2046.f;\n` +
      `        float _rp = (float)${v}_wr - _d;\n` +
      `        while (_rp < 0.f) _rp += 2048.f;\n` +
      `        int _r0 = (int)_rp & 2047; float _frac = _rp - (float)((int)_rp);\n` +
      `        int _r1 = (_r0 + 1) & 2047;\n` +
      `        float _dy = ${v}_buf[_r0] * (1.f - _frac) + ${v}_buf[_r1] * _frac;\n` +
      `        float _w = _x + _dy * _fb;\n` +
      `        ${v}_buf[${v}_wr] = _w;\n` +
      `        ${v}_wr = (${v}_wr + 1) & 2047;\n` +
      `        float _m = (${mixExpr});\n` +
      `        ${out} = _x * (1.f - _m) + _dy * _m;\n` +
      `        ${v}_lfo += 6.28318530718f * (${rateExpr}) / (float)SAMPLE_RATE;\n` +
      `        if (${v}_lfo >= 6.28318530718f) ${v}_lfo -= 6.28318530718f;\n` +
      `    }\n`
    )
  }
}

// ---- Vibrato -------------------------------------------------------------

const vibrato: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `static float ${v}_buf[1024] = {0}; int ${v}_wr = 0; float ${v}_lfo = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const rate = numParam(ctx.node, 'rate', 6)
    const depth = numParam(ctx.node, 'depth', 0.3)
    const rateCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rate', '__NC__')
    const depthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_depth', '__NC__')
    const rateExpr = rateCvExpr === '__NC__' ? `${rate}` : `fmaxf(0.1f, fminf(15.f, ${rateCvExpr}))`
    const depthExpr = depthCvExpr === '__NC__' ? `${depth}` : `fmaxf(0.f, fminf(1.f, ${depthCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _x = (${input});\n` +
      `        ${v}_buf[${v}_wr] = _x;\n` +
      `        float _centre = 0.005f * (float)SAMPLE_RATE;\n` +
      `        float _mod = 0.002f * (float)SAMPLE_RATE * (${depthExpr});\n` +
      `        float _d = _centre + sinf(${v}_lfo) * _mod;\n` +
      `        if (_d < 1.f) _d = 1.f; if (_d > 1022.f) _d = 1022.f;\n` +
      `        float _rp = (float)${v}_wr - _d;\n` +
      `        while (_rp < 0.f) _rp += 1024.f;\n` +
      `        int _r0 = (int)_rp & 1023; float _frac = _rp - (float)((int)_rp);\n` +
      `        int _r1 = (_r0 + 1) & 1023;\n` +
      `        ${out} = ${v}_buf[_r0] * (1.f - _frac) + ${v}_buf[_r1] * _frac;\n` +
      `        ${v}_wr = (${v}_wr + 1) & 1023;\n` +
      `        ${v}_lfo += 6.28318530718f * fmaxf((${rateExpr}), 0.01f) / (float)SAMPLE_RATE;\n` +
      `        if (${v}_lfo >= 6.28318530718f) ${v}_lfo -= 6.28318530718f;\n` +
      `    }\n`
    )
  }
}

// ---- Ping-pong (stereo) --------------------------------------------------

const ping_pong: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `static float ${v}_bufL[96000] = {0};\n` +
      `static float ${v}_bufR[96000] = {0};\n` +
      `int ${v}_idx = 0; float ${v}_smoothed = 0.f;`
    )
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const time = numParam(ctx.node, 'time', 0.3)
    const fb = numParam(ctx.node, 'feedback', 0.45)
    const mix = numParam(ctx.node, 'mix', 0.4)
    const width = numParam(ctx.node, 'width', 1)
    const timeCvExpr = ctx.inputExpr(ctx.node.id, 'cv_time', '__NC__')
    const fbCvExpr = ctx.inputExpr(ctx.node.id, 'cv_feedback', '__NC__')
    const mixCvExpr = ctx.inputExpr(ctx.node.id, 'cv_mix', '__NC__')
    const timeExpr = timeCvExpr === '__NC__' ? `${time}` : `fmaxf(0.02f, fminf(2.f, ${timeCvExpr}))`
    const fbExpr = fbCvExpr === '__NC__' ? `${fb}` : `fmaxf(0.f, fminf(0.95f, ${fbCvExpr}))`
    const mixExpr = mixCvExpr === '__NC__' ? `${mix}` : `fmaxf(0.f, fminf(1.f, ${mixCvExpr}))`
    return (
      `    float ${l}, ${r};\n` +
      `    {\n` +
      `        float _x = (${input});\n` +
      `        float _target = (${timeExpr}) * (float)SAMPLE_RATE;\n` +
      `        if (_target < 1.f) _target = 1.f; if (_target > 95998.f) _target = 95998.f;\n` +
      `        if (${v}_smoothed < 1.f) ${v}_smoothed = _target;\n` +
      `        ${v}_smoothed += (_target - ${v}_smoothed) * 0.002f;\n` +
      `        float _d = ${v}_smoothed;\n` +
      `        float _rp = (float)${v}_idx - _d;\n` +
      `        while (_rp < 0.f) _rp += 96000.f;\n` +
      `        int _r0 = ((int)_rp) % 96000; float _frac = _rp - (float)((int)_rp);\n` +
      `        int _r1 = (_r0 + 1) % 96000;\n` +
      `        float _delL = ${v}_bufL[_r0] * (1.f - _frac) + ${v}_bufL[_r1] * _frac;\n` +
      `        float _delR = ${v}_bufR[_r0] * (1.f - _frac) + ${v}_bufR[_r1] * _frac;\n` +
      `        float _fb = (${fbExpr});\n` +
      `        float _wL = _x + _delR * _fb * ${width} + _delL * _fb * (1.f - ${width});\n` +
      `        float _wR = _x + _delL * _fb * ${width} + _delR * _fb * (1.f - ${width});\n` +
      `        ${v}_bufL[${v}_idx] = _wL; ${v}_bufR[${v}_idx] = _wR;\n` +
      `        ${v}_idx = (${v}_idx + 1) % 96000;\n` +
      `        float _m = (${mixExpr});\n` +
      `        ${l} = _x * (1.f - _m) + _delL * _m;\n` +
      `        ${r} = _x * (1.f - _m) + _delR * _m;\n` +
      `    }\n`
    )
  }
}

// ---- Stereo widener ------------------------------------------------------

const stereo_widener: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `static float ${v}_buf[2048] = {0}; int ${v}_wr = 0;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const width = numParam(ctx.node, 'width', 1.2)
    const haas = numParam(ctx.node, 'haas_ms', 8)
    const widthCvExpr = ctx.inputExpr(ctx.node.id, 'cv_width', '__NC__')
    const widthExpr = widthCvExpr === '__NC__' ? `${width}` : `fmaxf(0.f, fminf(2.f, ${widthCvExpr}))`
    return (
      `    float ${l}, ${r};\n` +
      `    {\n` +
      `        float _x = (${input});\n` +
      `        ${v}_buf[${v}_wr] = _x;\n` +
      `        float _haasMs = ${haas}; if (_haasMs < 0.f) _haasMs = 0.f; else if (_haasMs > 30.f) _haasMs = 30.f;\n` +
      `        float _d = (_haasMs / 1000.f) * (float)SAMPLE_RATE;\n` +
      `        if (_d > 2046.f) _d = 2046.f;\n` +
      `        float _rp = (float)${v}_wr - _d;\n` +
      `        while (_rp < 0.f) _rp += 2048.f;\n` +
      `        int _r0 = (int)_rp & 2047; float _frac = _rp - (float)((int)_rp);\n` +
      `        int _r1 = (_r0 + 1) & 2047;\n` +
      `        float _del = ${v}_buf[_r0] * (1.f - _frac) + ${v}_buf[_r1] * _frac;\n` +
      `        ${v}_wr = (${v}_wr + 1) & 2047;\n` +
      `        float _w = (${widthExpr});\n` +
      `        float _mid = (_x + _del) * 0.5f;\n` +
      `        float _side = (_x - _del) * 0.5f * _w;\n` +
      `        ${l} = _mid + _side;\n` +
      `        ${r} = _mid - _side;\n` +
      `    }\n`
    )
  }
}

// ---- Freeze --------------------------------------------------------------
// 500 ms max buffer (~24 KB at 48 kHz fp32). Gate rising edge starts a
// fresh capture; loops while gate is high and buffer is captured; passes
// through otherwise.

const freeze: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `static float ${v}_buf[24002] = {0};\n` +
      `int ${v}_wr = 0; int ${v}_play = 0; int ${v}_captured = 0;\n` +
      `int ${v}_rec = 0; float ${v}_prev_gate = 0.f;`
    )
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const gate = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const buffer = numParam(ctx.node, 'buffer_ms', 120)
    const lenCvExpr = ctx.inputExpr(ctx.node.id, 'cv_length', '__NC__')
    const lenExpr = lenCvExpr === '__NC__' ? `${buffer}` : `fmaxf(20.f, fminf(500.f, ${lenCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _ms = (${lenExpr}); if (_ms < 20.f) _ms = 20.f; else if (_ms > 500.f) _ms = 500.f;\n` +
      `        int _tgt = (int)((_ms / 1000.f) * (float)SAMPLE_RATE);\n` +
      `        if (_tgt > 24000) _tgt = 24000;\n` +
      `        float _x = (${input});\n` +
      `        float _g = (${gate}); bool _h = _g > 0.5f;\n` +
      `        if (_h && ${v}_prev_gate <= 0.5f) { ${v}_rec = 1; ${v}_wr = 0; ${v}_captured = 0; }\n` +
      `        if (!_h && ${v}_prev_gate > 0.5f) { ${v}_rec = 0; }\n` +
      `        ${v}_prev_gate = _g;\n` +
      `        if (${v}_rec) {\n` +
      `            if (${v}_wr < _tgt) { ${v}_buf[${v}_wr++] = _x; ${v}_captured = ${v}_wr; }\n` +
      `            else { ${v}_rec = 0; }\n` +
      `        }\n` +
      `        if (${v}_captured > 0 && _h) {\n` +
      `            if (${v}_play >= ${v}_captured) ${v}_play = 0;\n` +
      `            ${out} = ${v}_buf[${v}_play++];\n` +
      `        } else {\n` +
      `            ${out} = _x; ${v}_play = 0;\n` +
      `        }\n` +
      `    }\n`
    )
  }
}

// ---- Pitch shifter (2-tap granular overlap-add) --------------------------
// 100 ms buffer (~4800 samples at 48 kHz). Two read heads phase-offset by
// 50%, Hann-windowed, summed.

const pitch_shifter: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `#ifndef DP_PS_SIZE\n#define DP_PS_SIZE 4802\n#endif\n` +
      `static float ${v}_buf[DP_PS_SIZE] = {0};\n` +
      `int ${v}_wr = 0; int ${v}_len = DP_PS_SIZE - 2;\n` +
      `float ${v}_h1 = 0.f; float ${v}_h2 = 0.f;`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `    {\n` +
      `        int _L = (int)(0.1f * (float)SAMPLE_RATE);\n` +
      `        if (_L > DP_PS_SIZE - 2) _L = DP_PS_SIZE - 2;\n` +
      `        if (_L < 2) _L = 2;\n` +
      `        ${v}_len = _L;\n` +
      `        ${v}_h2 = (float)_L * 0.5f;\n` +
      `    }`
    )
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const semis = numParam(ctx.node, 'semitones', 0)
    const mix = numParam(ctx.node, 'mix', 1)
    const pitchCvExpr = ctx.inputExpr(ctx.node.id, 'cv_pitch', '__NC__')
    const semisExpr = pitchCvExpr === '__NC__' ? `${semis}` : `fmaxf(-24.f, fminf(24.f, ${pitchCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _ratio = powf(2.f, (${semisExpr}) / 12.f);\n` +
      `        float _step = 1.f - _ratio;\n` +
      `        int _bufLen = DP_PS_SIZE;\n` +
      `        int _L = ${v}_len;\n` +
      `        float _x = (${input});\n` +
      `        ${v}_buf[${v}_wr] = _x;\n` +
      `        ${v}_h1 += _step; ${v}_h2 += _step;\n` +
      `        while (${v}_h1 < 0.f) ${v}_h1 += (float)_L;\n` +
      `        while (${v}_h1 >= (float)_L) ${v}_h1 -= (float)_L;\n` +
      `        while (${v}_h2 < 0.f) ${v}_h2 += (float)_L;\n` +
      `        while (${v}_h2 >= (float)_L) ${v}_h2 -= (float)_L;\n` +
      `        float _pA = (float)${v}_wr - ${v}_h1; while (_pA < 0.f) _pA += (float)_bufLen;\n` +
      `        while (_pA >= (float)_bufLen) _pA -= (float)_bufLen;\n` +
      `        float _pB = (float)${v}_wr - ${v}_h2; while (_pB < 0.f) _pB += (float)_bufLen;\n` +
      `        while (_pB >= (float)_bufLen) _pB -= (float)_bufLen;\n` +
      `        int _a0 = (int)_pA; float _af = _pA - (float)_a0;\n` +
      `        int _a1 = (_a0 + 1) % _bufLen;\n` +
      `        float _sA = ${v}_buf[_a0] * (1.f - _af) + ${v}_buf[_a1] * _af;\n` +
      `        int _b0 = (int)_pB; float _bf = _pB - (float)_b0;\n` +
      `        int _b1 = (_b0 + 1) % _bufLen;\n` +
      `        float _sB = ${v}_buf[_b0] * (1.f - _bf) + ${v}_buf[_b1] * _bf;\n` +
      `        float _wA = 0.5f - 0.5f * cosf(6.28318530718f * ${v}_h1 / (float)_L);\n` +
      `        float _wB = 0.5f - 0.5f * cosf(6.28318530718f * ${v}_h2 / (float)_L);\n` +
      `        float _wet = _sA * _wA + _sB * _wB;\n` +
      `        ${v}_wr = (${v}_wr + 1) % _bufLen;\n` +
      `        ${out} = _x * (1.f - ${mix}) + _wet * ${mix};\n` +
      `    }\n`
    )
  }
}

// ---- Granulator ----------------------------------------------------------
// 4-second capture buffer. At ~48 kHz that's ~770 KB fp32 — requires PSRAM.
// EXT_RAM_ATTR places it there; the platformio.ini emits qio_opi to enable
// octal PSRAM on the DevKitC. Up to 8 grains sum in parallel.

const granulator: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `#ifndef DP_GR_BUF\n#define DP_GR_BUF 192002\n#endif\n` +
      `EXT_RAM_ATTR static float ${v}_buf[DP_GR_BUF];\n` +
      `int ${v}_wr = 0; float ${v}_spawn_ctr = 0.f;\n` +
      `int ${v}_active[8] = {0};\n` +
      `float ${v}_gpos[8] = {0}; float ${v}_gstart[8] = {0};\n` +
      `float ${v}_glen[8] = {0}; float ${v}_grate[8] = {0};\n` +
      `uint32_t ${v}_rng = 0xbabebeefu;`
    )
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `    for (int _k = 0; _k < DP_GR_BUF; _k++) ${v}_buf[_k] = 0.f;\n` +
      `    for (int _k = 0; _k < 8; _k++) ${v}_active[_k] = 0;`
    )
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const grainMs = numParam(ctx.node, 'grain_size', 80)
    const density = numParam(ctx.node, 'density', 8)
    const pitch = numParam(ctx.node, 'pitch', 0)
    const jitter = numParam(ctx.node, 'jitter', 0.3)
    const mix = numParam(ctx.node, 'mix', 1)
    const sizeCvExpr = ctx.inputExpr(ctx.node.id, 'cv_grain_size', '__NC__')
    const densityCvExpr = ctx.inputExpr(ctx.node.id, 'cv_density', '__NC__')
    const pitchCvExpr = ctx.inputExpr(ctx.node.id, 'cv_pitch', '__NC__')
    const sprayCvExpr = ctx.inputExpr(ctx.node.id, 'cv_spray', '__NC__')
    const grainMsExpr = sizeCvExpr === '__NC__' ? `${grainMs}` : `fmaxf(10.f, fminf(200.f, ${sizeCvExpr}))`
    const densityExpr = densityCvExpr === '__NC__' ? `${density}` : `fmaxf(1.f, fminf(30.f, ${densityCvExpr}))`
    const pitchExpr = pitchCvExpr === '__NC__' ? `${pitch}` : `fmaxf(-12.f, fminf(12.f, ${pitchCvExpr}))`
    const jitterExpr = sprayCvExpr === '__NC__' ? `${jitter}` : `fmaxf(0.f, fminf(1.f, ${sprayCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _x = (${input});\n` +
      `        ${v}_buf[${v}_wr] = _x;\n` +
      `        ${v}_wr++; if (${v}_wr >= DP_GR_BUF) ${v}_wr = 0;\n` +
      `        float _jitter = (${jitterExpr});\n` +
      `        float _pitchParam = (${pitchExpr});\n` +
      `        float _gs = fmaxf(1.f, ((${grainMsExpr}) / 1000.f) * (float)SAMPLE_RATE);\n` +
      `        float _spawnInt = (float)SAMPLE_RATE / fmaxf(0.001f, (${densityExpr}));\n` +
      `        ${v}_spawn_ctr -= 1.f;\n` +
      `        if (${v}_spawn_ctr <= 0.f) {\n` +
      `            int _slot = -1;\n` +
      `            for (int _s = 0; _s < 8; _s++) if (!${v}_active[_s]) { _slot = _s; break; }\n` +
      `            if (_slot >= 0) {\n` +
      `                ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `                float _r1 = (${v}_rng >> 8) / 16777216.f;\n` +
      `                ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `                float _r2 = (${v}_rng >> 8) / 16777216.f;\n` +
      `                float _jit = (_r1 * 2.f - 1.f) * _jitter;\n` +
      `                float _back = _gs * (1.f + 2.f * _jitter) + _r2 * _jitter * ((float)DP_GR_BUF - _gs - 2.f);\n` +
      `                float _start = (float)${v}_wr - _gs - _back;\n` +
      `                while (_start < 0.f) _start += (float)DP_GR_BUF;\n` +
      `                while (_start >= (float)DP_GR_BUF) _start -= (float)DP_GR_BUF;\n` +
      `                float _pj = _pitchParam + _jit * 2.f;\n` +
      `                ${v}_active[_slot] = 1;\n` +
      `                ${v}_gpos[_slot] = 0.f;\n` +
      `                ${v}_gstart[_slot] = _start;\n` +
      `                ${v}_glen[_slot] = _gs;\n` +
      `                ${v}_grate[_slot] = powf(2.f, _pj / 12.f);\n` +
      `            }\n` +
      `            ${v}_spawn_ctr += _spawnInt;\n` +
      `        }\n` +
      `        float _wet = 0.f;\n` +
      `        for (int _s = 0; _s < 8; _s++) {\n` +
      `            if (!${v}_active[_s]) continue;\n` +
      `            float _pos = ${v}_gpos[_s]; float _len = ${v}_glen[_s];\n` +
      `            if (_pos >= _len) { ${v}_active[_s] = 0; continue; }\n` +
      `            float _rp = ${v}_gstart[_s] + _pos;\n` +
      `            while (_rp >= (float)DP_GR_BUF) _rp -= (float)DP_GR_BUF;\n` +
      `            while (_rp < 0.f) _rp += (float)DP_GR_BUF;\n` +
      `            int _r0 = (int)_rp; float _frac = _rp - (float)_r0;\n` +
      `            int _r1 = (_r0 + 1) % DP_GR_BUF;\n` +
      `            float _smp = ${v}_buf[_r0] * (1.f - _frac) + ${v}_buf[_r1] * _frac;\n` +
      `            float _env = 0.5f - 0.5f * cosf(6.28318530718f * _pos / _len);\n` +
      `            _wet += _smp * _env;\n` +
      `            ${v}_gpos[_s] = _pos + ${v}_grate[_s];\n` +
      `        }\n` +
      `        ${out} = _x * (1.f - ${mix}) + _wet * ${mix};\n` +
      `    }\n`
    )
  }
}

/* --------------------------- dynamics --------------------------- */

const compressor: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_env = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const thresh = numParam(ctx.node, 'threshold', -20)
    const ratio = numParam(ctx.node, 'ratio', 4)
    const atk = numParam(ctx.node, 'attack', 0.01)
    const rel = numParam(ctx.node, 'release', 0.1)
    const make = numParam(ctx.node, 'makeup', 0)
    const thrCvExpr = ctx.inputExpr(ctx.node.id, 'cv_threshold', '__NC__')
    const ratioCvExpr = ctx.inputExpr(ctx.node.id, 'cv_ratio', '__NC__')
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const mkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_makeup', '__NC__')
    const tE = thrCvExpr === '__NC__' ? `${thresh}` : `fmaxf(-60.f, fminf(0.f, ${thrCvExpr}))`
    const rE = ratioCvExpr === '__NC__' ? `${ratio}` : `fmaxf(1.f, fminf(20.f, ${ratioCvExpr}))`
    const aE = atkCvExpr === '__NC__' ? `${atk}` : `fmaxf(0.001f, fminf(0.5f, ${atkCvExpr}))`
    const rlE = relCvExpr === '__NC__' ? `${rel}` : `fmaxf(0.01f, fminf(3.f, ${relCvExpr}))`
    const mE = mkCvExpr === '__NC__' ? `${make}` : `fmaxf(0.f, fminf(24.f, ${mkCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _thr = (${tE});\n` +
      `        float _ratio = (${rE});\n` +
      `        float _atk = fmaxf((${aE}), 1e-4f);\n` +
      `        float _rel = fmaxf((${rlE}), 1e-4f);\n` +
      `        float _make = (${mE});\n` +
      `        float _ax = fabsf(${input});\n` +
      `        float _ca = 1.f - expf(-1.f / (_atk * (float)SAMPLE_RATE));\n` +
      `        float _cr = 1.f - expf(-1.f / (_rel * (float)SAMPLE_RATE));\n` +
      `        float _c = (_ax > ${v}_env) ? _ca : _cr;\n` +
      `        ${v}_env += (_ax - ${v}_env) * _c;\n` +
      `        if (${v}_env < 0.f) ${v}_env = 0.f;\n` +
      `        float _env_db = 20.f * log10f(fmaxf(${v}_env, 1e-6f));\n` +
      `        float _slope = 1.f - 1.f / fmaxf(_ratio, 1.0001f);\n` +
      `        float _grDb = (_env_db - _thr) * _slope; if (_grDb < 0.f) _grDb = 0.f;\n` +
      `        float _mkLin = powf(10.f, _make / 20.f);\n` +
      `        float _gain = powf(10.f, -_grDb / 20.f) * _mkLin;\n` +
      `        ${out} = (${input}) * _gain;\n` +
      `    }\n`
    )
  }
}

const limiter: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_env = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const ceilDb = numParam(ctx.node, 'ceiling', -0.3)
    const rel = numParam(ctx.node, 'release', 0.05)
    const ceilCvExpr = ctx.inputExpr(ctx.node.id, 'cv_ceiling', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const cE = ceilCvExpr === '__NC__' ? `${ceilDb}` : `fmaxf(-12.f, fminf(0.f, ${ceilCvExpr}))`
    const rE = relCvExpr === '__NC__' ? `${rel}` : `fmaxf(0.01f, fminf(2.f, ${relCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _cdb = (${cE});\n` +
      `        float _relS = (${rE});\n` +
      `        float _ceilLin = powf(10.f, _cdb / 20.f);\n` +
      `        float _kneeLin = powf(10.f, (_cdb - 2.f) / 20.f);\n` +
      `        float _atk = 1.f - expf(-1.f / (0.001f * (float)SAMPLE_RATE));\n` +
      `        float _rl = 1.f - expf(-1.f / (_relS * (float)SAMPLE_RATE));\n` +
      `        float _x = (${input}); float _ax = fabsf(_x);\n` +
      `        if (_ax > ${v}_env) ${v}_env += (_ax - ${v}_env) * _atk;\n` +
      `        else ${v}_env += (_ax - ${v}_env) * _rl;\n` +
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
    return `float ${v}_env = 0.f; float ${v}_gate = 0.f; int ${v}_hold = 0;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const key = ctx.inputExpr(ctx.node.id, 'key', `(${input})`)
    const thrDb = numParam(ctx.node, 'threshold', -40)
    const attack = numParam(ctx.node, 'attack', 0.005)
    const hold = numParam(ctx.node, 'hold', 0.05)
    const release = numParam(ctx.node, 'release', 0.1)
    const thrCvExpr = ctx.inputExpr(ctx.node.id, 'cv_threshold', '__NC__')
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const tE = thrCvExpr === '__NC__' ? `${thrDb}` : `fmaxf(-80.f, fminf(0.f, ${thrCvExpr}))`
    const aE = atkCvExpr === '__NC__' ? `${attack}` : `fmaxf(0.001f, fminf(0.1f, ${atkCvExpr}))`
    const rE = relCvExpr === '__NC__' ? `${release}` : `fmaxf(0.01f, fminf(2.f, ${relCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        float _x = (${input}); float _k = fabsf(${key});\n` +
      `        float _thr = powf(10.f, (${tE}) / 20.f);\n` +
      `        float _detAtk = 1.f - expf(-1.f / (0.001f * (float)SAMPLE_RATE));\n` +
      `        float _detRel = 1.f - expf(-1.f / (0.03f * (float)SAMPLE_RATE));\n` +
      `        float _gAtk = 1.f - expf(-1.f / (fmaxf((${aE}), 1e-4f) * (float)SAMPLE_RATE));\n` +
      `        float _gRel = 1.f - expf(-1.f / (fmaxf((${rE}), 1e-4f) * (float)SAMPLE_RATE));\n` +
      `        int _holdN = (int)(${hold} * (float)SAMPLE_RATE);\n` +
      `        if (_k > ${v}_env) ${v}_env += (_k - ${v}_env) * _detAtk;\n` +
      `        else ${v}_env += (_k - ${v}_env) * _detRel;\n` +
      `        if (${v}_env < 0.f) ${v}_env = 0.f;\n` +
      `        float _target;\n` +
      `        if (${v}_env >= _thr) { _target = 1.f; ${v}_hold = _holdN; }\n` +
      `        else if (${v}_hold > 0) { _target = 1.f; ${v}_hold--; }\n` +
      `        else _target = 0.f;\n` +
      `        if (_target > ${v}_gate) ${v}_gate += (_target - ${v}_gate) * _gAtk;\n` +
      `        else ${v}_gate += (_target - ${v}_gate) * _gRel;\n` +
      `        if (${v}_gate < 0.f) ${v}_gate = 0.f; if (${v}_gate > 1.f) ${v}_gate = 1.f;\n` +
      `        ${out} = _x * ${v}_gate;\n` +
      `    }\n`
    )
  }
}

/* --------------------------- hardware I/O --------------------------- */

const audio_in: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    return `    float ${l} = in_l;\n    float ${r} = in_r;\n`
  }
}

const audio_output: NodeEmitter = { declare: () => '', init: () => '', process: () => '' }

const knob_in: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const lo = typeof ctx.node.params.min === 'number' ? ctx.node.params.min : 0
    const hi = typeof ctx.node.params.max === 'number' ? ctx.node.params.max : 1
    const expr =
      lo === 0 && hi === 1
        ? `${v}_val`
        : `${lo.toFixed(4)}f + (${v}_val) * ${(hi - lo).toFixed(4)}f`
    return `    float ${out} = ${expr};\n`
  }
}

const gate_in: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    return `    float ${out} = ${v}_val;\n`
  }
}

const button: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    return `    float ${out} = ${v}_val;\n`
  }
}

const led: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const v = ctx.varName(ctx.node.id)
    return `    ${v}_val = (${input});\n`
  }
}

const switch_3way: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    return `    float ${out} = ${v}_val;\n`
  }
}

/* --------------------------- MIDI --------------------------- */
//
// Uses the Arduino ESP32 USB MIDI class. One shared `USBMIDI` instance is
// declared by whichever MIDI node is emitted first in topo order; the
// follow-up declarations guard with `#ifndef DP_USBMIDI_DECLARED`. A small
// shared dispatcher polls the class in loop() and updates globals.
//
// To keep the emitter side effect-free, we simply emit the globals and the
// polling call inside `process()` once per node. The polling relies on the
// `midi_port` symbol, which the declare() output defines on first emit.

const MIDI_SHARED_HEADER =
  `#ifndef DP_USBMIDI_DECLARED\n` +
  `#define DP_USBMIDI_DECLARED 1\n` +
  `#include <USB.h>\n` +
  `#include <USBMIDI.h>\n` +
  `USBMIDI midi_port;\n` +
  `volatile int  midi_latched_note = -1;\n` +
  `volatile float midi_latched_vel = 0.f;\n` +
  `volatile float midi_latched_gate = 0.f;\n` +
  `static float midi_cc_table[128] = {0};\n` +
  `static bool  midi_cc_received = false;\n` +
  `static inline void dp_midi_poll() {\n` +
  `  midiEventPacket_t ev;\n` +
  `  while (midi_port.readPacket(&ev)) {\n` +
  `    uint8_t st = ev.byte1 & 0xf0;\n` +
  `    if (st == 0x90 && ev.byte3 > 0) {\n` +
  `      midi_latched_note = ev.byte2;\n` +
  `      midi_latched_vel  = (float)ev.byte3 / 127.f;\n` +
  `      midi_latched_gate = 1.f;\n` +
  `    } else if (st == 0x80 || (st == 0x90 && ev.byte3 == 0)) {\n` +
  `      midi_latched_gate = 0.f;\n` +
  `    } else if (st == 0xb0) {\n` +
  `      if (ev.byte2 < 128) {\n` +
  `        midi_cc_table[ev.byte2] = (float)ev.byte3 / 127.f;\n` +
  `        midi_cc_received = true;\n` +
  `      }\n` +
  `    }\n` +
  `  }\n` +
  `}\n` +
  `#endif\n`

const midi_in_note: NodeEmitter = {
  declare: () => MIDI_SHARED_HEADER,
  init: () =>
    `    #ifndef DP_USBMIDI_INIT\n    #define DP_USBMIDI_INIT 1\n    USB.begin();\n    midi_port.begin();\n    #endif`,
  process: (ctx) => {
    const pitchOut = ctx.outputVar(ctx.node.id, 'pitch')
    const gateOut = ctx.outputVar(ctx.node.id, 'gate')
    const velOut = ctx.outputVar(ctx.node.id, 'velocity')
    return (
      `    dp_midi_poll();\n` +
      `    float ${pitchOut} = midi_latched_note >= 0 ? ((float)midi_latched_note - 60.f) / 12.f : 0.f;\n` +
      `    float ${gateOut} = midi_latched_gate;\n` +
      `    float ${velOut} = midi_latched_vel;\n`
    )
  }
}

const midi_in_cc: NodeEmitter = {
  declare: () => MIDI_SHARED_HEADER,
  init: () =>
    `    #ifndef DP_USBMIDI_INIT\n    #define DP_USBMIDI_INIT 1\n    USB.begin();\n    midi_port.begin();\n    #endif`,
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const ccIdx = Math.max(0, Math.min(127, Math.floor(rawNum(ctx.node, 'cc', 1))))
    const testValue = numParam(ctx.node, 'test_value', 0)
    return (
      `    dp_midi_poll();\n` +
      `    float ${out} = midi_cc_received ? midi_cc_table[${ccIdx}] : ${testValue};\n`
    )
  }
}

const midi_out_note: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return MIDI_SHARED_HEADER + `float ${v}_prev_gate = 0.f; int ${v}_last_note = -1;`
  },
  init: () =>
    `    #ifndef DP_USBMIDI_INIT\n    #define DP_USBMIDI_INIT 1\n    USB.begin();\n    midi_port.begin();\n    #endif`,
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const pitch = ctx.inputExpr(ctx.node.id, 'pitch', '0.f')
    const gate = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const vel = ctx.inputExpr(ctx.node.id, 'velocity', '1.f')
    const chanStr = enumParam(ctx.node, 'channel', '1')
    const chan = chanStr === 'all' ? 0 : Math.max(0, Math.min(15, parseInt(chanStr, 10) - 1))
    return (
      `    {\n` +
      `        float _g = (${gate});\n` +
      `        if (_g > 0.5f && ${v}_prev_gate <= 0.5f) {\n` +
      `            int _n = (int)(((${pitch}) * 12.f) + 60.f + 0.5f);\n` +
      `            if (_n < 0) _n = 0; else if (_n > 127) _n = 127;\n` +
      `            int _v = (int)(fminf(1.f, fmaxf(0.f, (${vel}))) * 127.f);\n` +
      `            midiEventPacket_t _pkt = { (uint8_t)0x09, (uint8_t)(0x90 | ${chan}), (uint8_t)_n, (uint8_t)_v };\n` +
      `            midi_port.writePacket(&_pkt);\n` +
      `            ${v}_last_note = _n;\n` +
      `        }\n` +
      `        if (_g <= 0.5f && ${v}_prev_gate > 0.5f && ${v}_last_note >= 0) {\n` +
      `            midiEventPacket_t _pkt = { (uint8_t)0x08, (uint8_t)(0x80 | ${chan}), (uint8_t)${v}_last_note, (uint8_t)0 };\n` +
      `            midi_port.writePacket(&_pkt);\n` +
      `            ${v}_last_note = -1;\n` +
      `        }\n` +
      `        ${v}_prev_gate = _g;\n` +
      `    }\n`
    )
  }
}

/* --------------------------- OLED --------------------------- */
//
// Uses Adafruit_SSD1306 over I2C (Wire.h). The target emits `Wire.begin(sda, scl)`
// in its hardware init block when an OLED component is placed. This emitter
// instantiates the device and renders the configured element list in the
// audio callback's per-sample loop — once per block is enough in practice;
// rendering on every sample is wasteful but keeps the emitter local and
// deterministic. We throttle with a counter so display.display() fires at
// ~30 Hz rather than every sample.

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

function bindingCacheName(b: unknown, v: string): string {
  if (typeof b !== 'string') return '0.f'
  const idx = OLED_INPUT_SOCKETS.indexOf(b as 'a')
  if (idx < 0) return '0.f'
  return `${v}_in_${b}`
}

const oled: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lines: string[] = []
    lines.push(`#ifndef DP_OLED_INCLUDED`)
    lines.push(`#define DP_OLED_INCLUDED 1`)
    lines.push(`#include <Adafruit_SSD1306.h>`)
    lines.push(`#endif`)
    lines.push(`Adafruit_SSD1306 ${v}(128, 64, &Wire);`)
    for (const sock of OLED_INPUT_SOCKETS) lines.push(`float ${v}_in_${sock} = 0.f;`)
    lines.push(`int ${v}_draw_ctr = 0;`)
    return lines.join('\n')
  },
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `    ${v}.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n    ${v}.clearDisplay();\n    ${v}.display();`
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const elements = parseOledElements(ctx.node.params.elements)
    if (elements.length > 12) ctx.warn('oled draw is approximate at high element counts')

    const lines: string[] = []
    lines.push(`    // --- OLED ${v}: latch inputs, render at ~30 Hz ---`)
    for (const sock of OLED_INPUT_SOCKETS) {
      const expr = ctx.inputExpr(ctx.node.id, sock, '0.f')
      lines.push(`    ${v}_in_${sock} = ${expr};`)
    }
    // Throttle: SAMPLE_RATE / 30 ≈ 1600 samples at 48 kHz.
    lines.push(`    ${v}_draw_ctr++;`)
    lines.push(`    if (${v}_draw_ctr >= (SAMPLE_RATE / 30)) {`)
    lines.push(`        ${v}_draw_ctr = 0;`)
    lines.push(`        ${v}.clearDisplay();`)
    for (const el of elements) {
      const x = typeof el.x === 'number' ? el.x | 0 : 0
      const y = typeof el.y === 'number' ? el.y | 0 : 0
      if (el.kind === 'text') {
        const t = sanitizeCString(typeof el.text === 'string' ? el.text : '')
        const sz = el.size === 2 ? 2 : 1
        lines.push(`        ${v}.setTextSize(${sz});`)
        lines.push(`        ${v}.setTextColor(SSD1306_WHITE);`)
        lines.push(`        ${v}.setCursor(${x}, ${y});`)
        lines.push(`        ${v}.print("${t}");`)
      } else if (el.kind === 'value') {
        const cache = bindingCacheName(el.binding, v)
        const decimals = typeof el.decimals === 'number' ? el.decimals | 0 : 2
        const unit = sanitizeCString(typeof el.unit === 'string' ? el.unit : '')
        const sz = el.size === 2 ? 2 : 1
        lines.push(`        { char _buf[24]; snprintf(_buf, sizeof _buf, "%.${decimals}f${unit}", ${cache});`)
        lines.push(`          ${v}.setTextSize(${sz}); ${v}.setTextColor(SSD1306_WHITE);`)
        lines.push(`          ${v}.setCursor(${x}, ${y}); ${v}.print(_buf); }`)
      } else if (el.kind === 'meter') {
        const cache = bindingCacheName(el.binding, v)
        const w = typeof el.width === 'number' ? el.width | 0 : 40
        const h = typeof el.height === 'number' ? el.height | 0 : 8
        lines.push(`        { float _mv = fabsf(${cache}); if (_mv > 1.f) _mv = 1.f;`)
        lines.push(`          ${v}.drawRect(${x}, ${y}, ${w}, ${h}, SSD1306_WHITE);`)
        if (el.orientation === 'v') {
          lines.push(`          int _fh = (int)(_mv * (float)(${h - 2}));`)
          lines.push(`          ${v}.fillRect(${x + 1}, ${y + h - 1} - _fh, ${w - 2}, _fh, SSD1306_WHITE); }`)
        } else {
          lines.push(`          int _fw = (int)(_mv * (float)(${w - 2}));`)
          lines.push(`          ${v}.fillRect(${x + 1}, ${y + 1}, _fw, ${h - 2}, SSD1306_WHITE); }`)
        }
      } else if (el.kind === 'scope') {
        const cache = bindingCacheName(el.binding, v)
        const w = typeof el.width === 'number' ? el.width | 0 : 64
        const h = typeof el.height === 'number' ? el.height | 0 : 24
        lines.push(`        { int _midY = ${y + (h >> 1)};`)
        lines.push(`          int _pxY = _midY - (int)((${cache}) * (float)(${h >> 1}));`)
        lines.push(`          for (int _xx = 0; _xx < ${w}; _xx++) ${v}.drawPixel(${x} + _xx, _pxY, SSD1306_WHITE); }`)
      } else if (el.kind === 'rect') {
        const w = typeof el.width === 'number' ? el.width | 0 : 20
        const h = typeof el.height === 'number' ? el.height | 0 : 12
        if (el.fill === true) {
          lines.push(`        ${v}.fillRect(${x}, ${y}, ${w}, ${h}, SSD1306_WHITE);`)
        } else {
          lines.push(`        ${v}.drawRect(${x}, ${y}, ${w}, ${h}, SSD1306_WHITE);`)
        }
      } else if (el.kind === 'circle') {
        const r = typeof el.radius === 'number' ? el.radius | 0 : 6
        lines.push(`        ${v}.drawCircle(${x}, ${y}, ${r}, SSD1306_WHITE);`)
      } else if (el.kind === 'line') {
        const x2 = typeof el.x2 === 'number' ? el.x2 | 0 : x + 8
        const y2 = typeof el.y2 === 'number' ? el.y2 | 0 : y
        lines.push(`        ${v}.drawLine(${x}, ${y}, ${x2}, ${y2}, SSD1306_WHITE);`)
      } else if (el.kind === 'pattern') {
        const cache = bindingCacheName(el.binding, v)
        const cols = typeof el.cols === 'number' ? el.cols | 0 : 8
        const rows = typeof el.rows === 'number' ? el.rows | 0 : 2
        const cell = typeof el.cellSize === 'number' ? el.cellSize | 0 : 4
        lines.push(`        { float _pv = fabsf(${cache}); if (_pv > 1.f) _pv = 1.f;`)
        lines.push(`          int _lit = (int)(_pv * (float)(${cols * rows}));`)
        lines.push(`          for (int _rr = 0; _rr < ${rows}; _rr++) for (int _cc = 0; _cc < ${cols}; _cc++) {`)
        lines.push(`            int _idx = _rr * ${cols} + _cc;`)
        lines.push(`            if (_idx < _lit) ${v}.fillRect(${x} + _cc * ${cell}, ${y} + _rr * ${cell}, ${cell - 1}, ${cell - 1}, SSD1306_WHITE);`)
        lines.push(`            else ${v}.drawRect(${x} + _cc * ${cell}, ${y} + _rr * ${cell}, ${cell - 1}, ${cell - 1}, SSD1306_WHITE);`)
        lines.push(`          } }`)
      }
    }
    lines.push(`        ${v}.display();`)
    lines.push(`    }`)
    return lines.join('\n') + '\n'
  }
}

/* --------------------------- visual stubs --------------------------- */

const visualPassthrough: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const def = NODE_DEFINITIONS[ctx.node.kind]
    if (!def) return ''
    const input = ctx.inputExpr(ctx.node.id, def.inputs[0]?.id ?? '', '0.f')
    const lines: string[] = [`    // ${ctx.node.kind}: no-op on ESP32 (visual-only)`]
    for (const out of def.outputs) {
      lines.push(`    float ${ctx.outputVar(ctx.node.id, out.id)} = ${input};`)
    }
    return lines.join('\n') + '\n'
  }
}

/* --------------------------- expression / print --------------------------- */
//
// Expression: we keep the passthrough for this pass — porting the Daisy
// expression parser to C++ inline is a whole separate unit of work and it
// isn't a DSP node. Print is a Serial.print wrapper.

const printNode: NodeEmitter = {
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

/* --------------------------- export table --------------------------- */

export const ESP32_NODE_EMITTERS: Partial<Record<NodeKind, NodeEmitter>> = {
  // Sources
  oscillator,
  noise,
  lfo,
  constant,
  karplus,
  fm_op,
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
  // Sequencing / clock
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
  freeze,
  granulator,
  pitch_shifter,
  tremolo,
  vibrato,
  // Dynamics
  compressor,
  limiter,
  noise_gate,
  // Visual — no-op
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
  i2s_in: unsupported('i2s_in', 'use audio_in / I2S codec binding instead'),
  i2s_out: unsupported('i2s_out', 'use audio_output — I2S is the default sink'),
  // MIDI
  midi_in_note,
  midi_in_cc,
  midi_out_note,
  // Scripting
  expression: unsupported(
    'expression',
    'expression parser reuses Daisy emitter; port pending'
  ),
  print: printNode
}

