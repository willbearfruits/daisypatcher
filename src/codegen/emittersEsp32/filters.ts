import type { NodeEmitter } from '../nodeEmitters'
import { enumParam, formatFloat, numParam } from './shared'


/* --------------------------- filters --------------------------- */

// Chamberlin state-variable: one-pass. LP/HP/BP/Notch from the same state.
export const filter_svf: NodeEmitter = {
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
export const filter_moog: NodeEmitter = {
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

export const formant: NodeEmitter = {
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
