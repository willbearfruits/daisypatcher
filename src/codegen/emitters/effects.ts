import type { NodeEmitter } from './shared'
import { numParam } from './shared'


// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export const delay: NodeEmitter = {
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

export const reverb: NodeEmitter = {
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

/*
 * `tone` used to be emitted nowhere. The node showed the knob, the
 * emulator filtered with it, and the firmware ignored it entirely — so a
 * patch tuned by ear in the app arrived on the device bright and wrong.
 * DaisySP's `Overdrive` has no tone stage, so this is the same one-pole
 * the worklet runs, written out alongside it.
 */
export const overdrive: NodeEmitter = {
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
    const tone = numParam(ctx.node, 'tone', 0.5)
    const driveCvExpr = ctx.inputExpr(ctx.node.id, 'cv_drive', '__NC__')
    const dExpr = driveCvExpr === '__NC__'
      ? `${drive}`
      : `fmaxf(0.f, fminf(1.f, ${driveCvExpr}))`
    return (
      `    ${v}.SetDrive(${dExpr});\n` +
      `    float ${out} = ${v}.Process(${i});\n` +
      // One-pole low-pass, block-rate coefficient. See the tone note above.
      `    static float ${v}_lp = 0.f;\n` +
      `    {\n` +
      `      const float _cut = 500.f + ${tone} * 9500.f;\n` +
      `      const float _rc = 1.f / (2.f * 3.14159265f * _cut);\n` +
      `      const float _dt = 1.f / sr;\n` +
      `      const float _a = _dt / (_rc + _dt);\n` +
      `      ${v}_lp += _a * (${out} - ${v}_lp);\n` +
      `      ${out} = ${v}_lp;\n` +
      `    }\n`
    )
  }
}

export const chorus: NodeEmitter = {
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

export const bitcrush: NodeEmitter = {
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

/*
 * DaisySP's `Phaser::Process` SUMS its four allpass engines rather than
 * cascading them, and each engine already returns `(in + ap) * .5` — an
 * equal dry/wet mix of its own. Four of those summed carries 2x the dry
 * signal before the node's own `mix` knob has done anything, so the
 * default patch left the board at a peak of 1.59 and clipped, while the
 * app showed a clean 0.53.
 *
 * Scaling by the pole count turns the sum back into a mean, which is the
 * canonical phaser: dry plus the averaged allpass, at unity. `SetPoles` is
 * never called, so 4 is fixed — if that ever becomes a param, this
 * constant has to follow it.
 */
export const phaser: NodeEmitter = {
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
      // See the pole-count note above: Process() sums, so scale it back.
      `    float ${v}_wet = ${v}.Process(${i}) * (1.f / 4.f);\n` +
      `    float ${out} = (${i}) * (1.f - (${mixExpr})) + ${v}_wet * (${mixExpr});\n`
    )
  }
}

export const flanger: NodeEmitter = {
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

/*
 * Cross-feed weighted by `width`, matching the emulator.
 *
 * Two things were wrong here. `width` is a param on this node and the
 * emitter ignored it completely, so the knob did nothing once flashed.
 * And the topology differed: only the L line was fed the dry signal, so
 * the R line was a pure echo of L rather than a delay of its own — a
 * different effect, 9.1% off on level and further off in stereo image.
 *
 * The delay time is smoothed with the same one-pole the emulator uses.
 * Without it a moving Time knob steps the read pointer and clicks.
 */
export const ping_pong: NodeEmitter = {
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
    const width = numParam(ctx.node, 'width', 1)
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
      // One-pole on the delay length; a stepped read pointer clicks.
      `        static float ${v}_smooth = 0.f;\n` +
      `        if (${v}_smooth <= 0.f) ${v}_smooth = _t;\n` +
      `        ${v}_smooth += (_t - ${v}_smooth) * 0.002f;\n` +
      `        ${v}_dl.SetDelay(${v}_smooth);\n` +
      `        ${v}_dr.SetDelay(${v}_smooth);\n` +
      `    }\n` +
      `    float ${v}_rl = ${v}_dl.Read();\n` +
      `    float ${v}_rr = ${v}_dr.Read();\n` +
      // Cross-feed: at width=1 each line is fed the OTHER line's tail.
      `    ${v}_dl.Write((${i}) + ${v}_rr * (${fbExpr}) * ${width} + ${v}_rl * (${fbExpr}) * (1.f - ${width}));\n` +
      `    ${v}_dr.Write((${i}) + ${v}_rl * (${fbExpr}) * ${width} + ${v}_rr * (${fbExpr}) * (1.f - ${width}));\n` +
      `    float ${l} = (${i}) * (1.f - (${mixExpr})) + ${v}_rl * (${mixExpr});\n` +
      `    float ${r} = (${i}) * (1.f - (${mixExpr})) + ${v}_rr * (${mixExpr});\n`
    )
  }
}

/*
 * Haas delay into a mid/side width matrix — matching the emulator, which
 * is also what this node's own description promises.
 *
 * The emitter used to do something else entirely: `L = in` and
 * `R = in * (1 - w/2) + delayed * w/2`, with no mid/side stage at all.
 * That is a crossfade, not a widener — at `width = 0` it collapses to the
 * dry signal in both channels instead of to mono, and the two sides were
 * 10.8% apart on level.
 */
export const stereo_widener: NodeEmitter = {
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
      // Haas: L dry, R delayed. Then mid/side, width scaling the side.
      `    float ${v}_mid = ((${i}) + ${v}_d) * 0.5f;\n` +
      `    float ${v}_side = ((${i}) - ${v}_d) * 0.5f * (${widthExpr});\n` +
      `    float ${l} = ${v}_mid + ${v}_side;\n` +
      `    float ${r} = ${v}_mid - ${v}_side;\n`
    )
  }
}


export const freeze: NodeEmitter = {
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
export const freezeClean: NodeEmitter = {
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
export const granulator: NodeEmitter = {
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

export const pitch_shifter: NodeEmitter = {
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

export const tremolo: NodeEmitter = {
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

export const vibrato: NodeEmitter = {
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

export const compressor: NodeEmitter = {
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
export const limiter: NodeEmitter = {
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

export const noise_gate: NodeEmitter = {
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
