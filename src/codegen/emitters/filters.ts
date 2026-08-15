import type { NodeEmitter } from './shared'
import { enumParam, formatFloat, numParam } from './shared'


// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const filter_svf: NodeEmitter = {
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

export const filter_moog: NodeEmitter = {
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

/**
 * First three formant frequencies per vowel, in Hz.
 *
 * Duplicated from the ESP32 emitter rather than shared: the two emitter
 * trees are deliberately independent, and a shared constants module
 * between them would be the first thread of a coupling that has bitten
 * this codebase before. If these ever disagree, `npm run test:audio`
 * catches it.
 */
const VOWELS: Record<string, [number, number, number]> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240]
}
const VOWEL_ORDER = ['a', 'e', 'i', 'o', 'u'] as const

/*
 * Three RBJ constant-peak-gain bandpass biquads, matching the emulator and
 * the ESP32 target exactly.
 *
 * This node used to run DaisySP's `Svf` here — three band outputs weighted
 * 1.0 / 0.8 / 0.6 and summed without normalising — while the emulator and
 * the ESP32 emitter both ran the biquad below. Three implementations of
 * one node, and the Daisy one was 49.8% off the app on level. The biquad
 * is written out rather than delegated because it has to be identical on a
 * target that links DaisySP and one that cannot.
 */
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
      `        float _ny = sr * 0.45f;\n` +
      `        float _x = (${input});\n` +
      `        float _morph = (${morphExpr});\n` +
      `        float _mix = (${mixExpr});\n` +
      `        float _wet = 0.f;\n` +
      `        for (int _k = 0; _k < 3; _k++) {\n` +
      `            float _f = _cur[_k] * (1.f - _morph) + _nxt[_k] * _morph;\n` +
      `            if (_f < 20.f) _f = 20.f; else if (_f > _ny) _f = _ny;\n` +
      `            float _w0 = 6.28318530718f * _f / sr;\n` +
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
