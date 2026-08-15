import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { EmitContext, NodeEmitter } from '../nodeEmitters'
import { enumParam, numParam, rawNum } from './shared'


/* --------------------------- effects (core) --------------------------- */

/**
 * Per-node delay-line budget, in samples (float, so x4 for bytes).
 *
 * The Daisy has 64 MB of SDRAM and can afford a fixed two-second line on
 * every delay node. An ESP32-S3 has roughly 250 KB of DRAM left once the
 * Arduino framework has taken its share — and a two-second line is 384 KB,
 * so `delay` simply did not link. That went unnoticed for as long as it did
 * because the snapshot tests compare text and never invoke a linker.
 *
 * 32768 samples is 128 KB, or about 0.68 s at 48 kHz: comfortably the
 * largest single line that leaves room for the rest of a patch.
 */
const ESP32_DELAY_BUDGET = 32768

/**
 * Samples to allocate for one delay line.
 *
 * Sized from what the patch actually asks for rather than the worst case, so
 * a 0.25 s delay costs 48 KB instead of 384. When a CV is patched into the
 * time input the runtime value is unknowable, so the param's declared
 * maximum is used instead. Exceeding the budget is reported, never silently
 * truncated — a delay that quietly plays back at a third of its dial
 * position is worse than one that tells you why.
 */
function esp32DelaySamples(
  ctx: EmitContext,
  timeParamId: string,
  channels: number,
  fallbackSeconds: number
): number {
  const def = NODE_DEFINITIONS[ctx.node.kind]
  const param = def?.params.find((p) => p.id === timeParamId)
  const paramMax = typeof param?.max === 'number' ? param.max : fallbackSeconds
  const cvConnected =
    ctx.inputExpr(ctx.node.id, `cv_${timeParamId}`, '__NC__') !== '__NC__' ||
    ctx.inputExpr(ctx.node.id, `${timeParamId}_cv`, '__NC__') !== '__NC__'

  const wanted = cvConnected ? paramMax : rawNum(ctx.node, timeParamId, fallbackSeconds)
  // +2 for the interpolation read-ahead some emitters do at the wrap point.
  const samples = Math.ceil(Math.max(0.001, wanted) * 48000) + 2
  const budget = Math.floor(ESP32_DELAY_BUDGET / Math.max(1, channels))
  if (samples > budget) {
    ctx.warn(
      `${ctx.node.kind} ${ctx.node.id}: ${wanted.toFixed(2)}s needs ` +
        `${Math.round((samples * 4 * channels) / 1024)} KB of delay memory; this board has ` +
        `${Math.round((ESP32_DELAY_BUDGET * 4) / 1024)} KB to spend, so the line is capped at ` +
        `${(budget / 48000).toFixed(2)}s`
    )
    return budget
  }
  return Math.max(64, samples)
}

export const delay: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const n = esp32DelaySamples(ctx, 'time', 1, 0.25)
    return (
      `static constexpr int ${v}_LEN = ${n};\n` +
      `static float ${v}_buf[${v}_LEN] = {0}; int ${v}_idx = 0;`
    )
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
      `        int _len = (int)((${timeExpr}) * (float)SAMPLE_RATE); if (_len < 1) _len = 1; if (_len > ${v}_LEN) _len = ${v}_LEN;\n` +
      `        int _ri = ${v}_idx - _len; if (_ri < 0) _ri += ${v}_LEN;\n` +
      `        float _wet = ${v}_buf[_ri];\n` +
      `        float _in = (${input});\n` +
      `        ${v}_buf[${v}_idx] = _in + _wet * (${fbExpr});\n` +
      `        ${v}_idx = (${v}_idx + 1) % ${v}_LEN;\n` +
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

export const reverb: NodeEmitter = {
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
      `            int _dlen = (int)((float)_comb_44k[_k] * _scale + 0.5f);\n` +
      `            if (_dlen < 1) _dlen = 1;\n` +
      `            if (_dlen > ${v}_comb_maxlen[_k]) _dlen = ${v}_comb_maxlen[_k];\n` +
      `            ${v}_comb_len[_k] = _dlen;\n` +
      `        }\n` +
      `        for (int _k = 0; _k < 4; _k++) {\n` +
      `            int _dlen = (int)((float)_ap_44k[_k] * _scale + 0.5f);\n` +
      `            if (_dlen < 1) _dlen = 1;\n` +
      `            if (_dlen > ${v}_ap_maxlen[_k]) _dlen = ${v}_ap_maxlen[_k];\n` +
      `            ${v}_ap_len[_k] = _dlen;\n` +
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

/*
 * Overdrive, matched to DaisySP's `Overdrive` (which the Daisy target
 * links and this one cannot) plus the `tone` one-pole.
 *
 * There were three different overdrives before this: a tanh in the
 * emulator, DaisySP's pre/post-gain soft clipper on Seed, and
 * `tanhf(in * (1 + drive * 10))` here. Same node, same knob, three
 * sounds. The soft clipper is written out inline because ESP32 builds do
 * not link DaisySP.
 */
export const overdrive: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const drive = numParam(ctx.node, 'drive', 0.5)
    const tone = numParam(ctx.node, 'tone', 0.5)
    const driveCvExpr = ctx.inputExpr(ctx.node.id, 'cv_drive', '__NC__')
    const dE = driveCvExpr === '__NC__'
      ? `${drive}`
      : `fmaxf(0.f, fminf(1.f, ${driveCvExpr}))`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `      const float _d = 2.f * fmaxf(0.f, fminf(1.f, ${dE}));\n` +
      `      const float _sq = _d * _d;\n` +
      `      const float _pa = _d * 0.5f;\n` +
      `      const float _pb = _sq * _sq * _d * 24.f;\n` +
      `      const float _pre = _pa + (_pb - _pa) * _sq;\n` +
      `      const float _sqh = _d * (2.f - _d);\n` +
      `      const float _pin = 0.33f + _sqh * (_pre - 0.33f);\n` +
      `      const float _post = 1.f / dp_soft_clip(_pin);\n` +
      `      ${out} = dp_soft_clip(_pre * (${input})) * _post;\n` +
      `      static float ${v}_lp = 0.f;\n` +
      `      const float _cut = 500.f + ${tone} * 9500.f;\n` +
      `      const float _rc = 1.f / (2.f * 3.14159265f * _cut);\n` +
      `      const float _dt = 1.f / (float)SAMPLE_RATE;\n` +
      `      const float _a = _dt / (_rc + _dt);\n` +
      `      ${v}_lp += _a * (${out} - ${v}_lp);\n` +
      `      ${out} = ${v}_lp;\n` +
      `    }\n`
    )
  }
}

export const bitcrush: NodeEmitter = {
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
      `    float ${out};\n` +
      `    {\n` +
      `        int _step = (int)(1.f / fmaxf((${rE}), 0.001f));\n` +
      `        if (${v}_ctr >= _step) { ${v}_ctr = 0; float _levels = powf(2.f, (${bE})); ${v}_held = floorf((${input}) * _levels) / _levels; }\n` +
      `        ${v}_ctr++;\n` +
      `        ${out} = ${v}_held;\n` +
      `    }\n`
    )
  }
}

export const tremolo: NodeEmitter = {
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

export const chorus: NodeEmitter = {
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

export const phaser: NodeEmitter = {
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

export const flanger: NodeEmitter = {
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

export const vibrato: NodeEmitter = {
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

export const ping_pong: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `static constexpr int ${v}_LEN = ${esp32DelaySamples(ctx, 'time', 2, 0.3)};\n` +
      `static float ${v}_bufL[${v}_LEN] = {0};\n` +
      `static float ${v}_bufR[${v}_LEN] = {0};\n` +
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
      `        if (_target < 1.f) _target = 1.f; if (_target > (float)(${v}_LEN - 2)) _target = (float)(${v}_LEN - 2);\n` +
      `        if (${v}_smoothed < 1.f) ${v}_smoothed = _target;\n` +
      `        ${v}_smoothed += (_target - ${v}_smoothed) * 0.002f;\n` +
      `        float _d = ${v}_smoothed;\n` +
      `        float _rp = (float)${v}_idx - _d;\n` +
      `        while (_rp < 0.f) _rp += (float)${v}_LEN;\n` +
      `        int _r0 = ((int)_rp) % ${v}_LEN; float _frac = _rp - (float)((int)_rp);\n` +
      `        int _r1 = (_r0 + 1) % ${v}_LEN;\n` +
      `        float _delL = ${v}_bufL[_r0] * (1.f - _frac) + ${v}_bufL[_r1] * _frac;\n` +
      `        float _delR = ${v}_bufR[_r0] * (1.f - _frac) + ${v}_bufR[_r1] * _frac;\n` +
      `        float _fb = (${fbExpr});\n` +
      `        float _wL = _x + _delR * _fb * ${width} + _delL * _fb * (1.f - ${width});\n` +
      `        float _wR = _x + _delL * _fb * ${width} + _delR * _fb * (1.f - ${width});\n` +
      `        ${v}_bufL[${v}_idx] = _wL; ${v}_bufR[${v}_idx] = _wR;\n` +
      `        ${v}_idx = (${v}_idx + 1) % ${v}_LEN;\n` +
      `        float _m = (${mixExpr});\n` +
      `        ${l} = _x * (1.f - _m) + _delL * _m;\n` +
      `        ${r} = _x * (1.f - _m) + _delR * _m;\n` +
      `    }\n`
    )
  }
}

// ---- Stereo widener ------------------------------------------------------

export const stereo_widener: NodeEmitter = {
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

export const freeze: NodeEmitter = {
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

export const pitch_shifter: NodeEmitter = {
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
      `        int _dlen = (int)(0.1f * (float)SAMPLE_RATE);\n` +
      `        if (_dlen > DP_PS_SIZE - 2) _dlen = DP_PS_SIZE - 2;\n` +
      `        if (_dlen < 2) _dlen = 2;\n` +
      `        ${v}_len = _dlen;\n` +
      `        ${v}_h2 = (float)_dlen * 0.5f;\n` +
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
      `        int _dlen = ${v}_len;\n` +
      `        float _x = (${input});\n` +
      `        ${v}_buf[${v}_wr] = _x;\n` +
      `        ${v}_h1 += _step; ${v}_h2 += _step;\n` +
      `        while (${v}_h1 < 0.f) ${v}_h1 += (float)_dlen;\n` +
      `        while (${v}_h1 >= (float)_dlen) ${v}_h1 -= (float)_dlen;\n` +
      `        while (${v}_h2 < 0.f) ${v}_h2 += (float)_dlen;\n` +
      `        while (${v}_h2 >= (float)_dlen) ${v}_h2 -= (float)_dlen;\n` +
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
      `        float _wA = 0.5f - 0.5f * cosf(6.28318530718f * ${v}_h1 / (float)_dlen);\n` +
      `        float _wB = 0.5f - 0.5f * cosf(6.28318530718f * ${v}_h2 / (float)_dlen);\n` +
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

export const granulator: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      /*
       * Allocated at runtime, not declared as a static array.
       *
       * A static EXT_RAM_BSS_ATTR buffer only lands in PSRAM if the board
       * definition says the chip has PSRAM — and PlatformIO's
       * `esp32-s3-devkitc-1` is the N8 variant, which does NOT. The result
       * was 768 KB of .dram0.bss and a link that failed by half a megabyte
       * on the very board the profile claimed had PSRAM. Boards in this
       * family ship as N8, N8R2 and N8R8 and nothing at build time can tell
       * them apart.
       *
       * So: ask PSRAM first, fall back to a shorter window on the ordinary
       * heap. That links on every variant, uses the big buffer where it
       * exists, and degrades to a shorter capture rather than to a
       * firmware that will not build.
       */
      `#ifndef DP_GR_BUF\n#define DP_GR_BUF 192002\n#endif\n` +
      `#ifndef DP_GR_BUF_FALLBACK\n#define DP_GR_BUF_FALLBACK 24000\n#endif\n` +
      `float* ${v}_buf = nullptr;\n` +
      `int ${v}_buf_len = 0;\n` +
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
      `    // Granulator capture buffer: PSRAM if the board has it, heap if not.\n` +
      `    ${v}_buf_len = DP_GR_BUF;\n` +
      `    ${v}_buf = (float*)ps_malloc((size_t)${v}_buf_len * sizeof(float));\n` +
      `    if (!${v}_buf) {\n` +
      `        ${v}_buf_len = DP_GR_BUF_FALLBACK;\n` +
      `        ${v}_buf = (float*)malloc((size_t)${v}_buf_len * sizeof(float));\n` +
      `    }\n` +
      `    if (${v}_buf) memset(${v}_buf, 0, (size_t)${v}_buf_len * sizeof(float));\n` +
      `    else ${v}_buf_len = 0;\n` +
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
      // No buffer means no PSRAM and a failed heap allocation too; pass the
      // input through rather than dereferencing null in the audio path.
      `        if (!${v}_buf) { ${out} = _x; } else {\n` +
      `        ${v}_buf[${v}_wr] = _x;\n` +
      `        ${v}_wr++; if (${v}_wr >= ${v}_buf_len) ${v}_wr = 0;\n` +
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
      `                float _back = _gs * (1.f + 2.f * _jitter) + _r2 * _jitter * ((float)${v}_buf_len - _gs - 2.f);\n` +
      `                float _start = (float)${v}_wr - _gs - _back;\n` +
      `                while (_start < 0.f) _start += (float)${v}_buf_len;\n` +
      `                while (_start >= (float)${v}_buf_len) _start -= (float)${v}_buf_len;\n` +
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
      `            while (_rp >= (float)${v}_buf_len) _rp -= (float)${v}_buf_len;\n` +
      `            while (_rp < 0.f) _rp += (float)${v}_buf_len;\n` +
      `            int _r0 = (int)_rp; float _frac = _rp - (float)_r0;\n` +
      `            int _r1 = (_r0 + 1) % ${v}_buf_len;\n` +
      `            float _smp = ${v}_buf[_r0] * (1.f - _frac) + ${v}_buf[_r1] * _frac;\n` +
      `            float _env = 0.5f - 0.5f * cosf(6.28318530718f * _pos / _len);\n` +
      `            _wet += _smp * _env;\n` +
      `            ${v}_gpos[_s] = _pos + ${v}_grate[_s];\n` +
      `        }\n` +
      `        ${out} = _x * (1.f - ${mix}) + _wet * ${mix};\n` +
      `        }\n` +
      `    }\n`
    )
  }
}

/* --------------------------- dynamics --------------------------- */

export const compressor: NodeEmitter = {
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

export const limiter: NodeEmitter = {
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

export const noise_gate: NodeEmitter = {
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
