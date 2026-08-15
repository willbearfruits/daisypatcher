import type { NodeEmitter } from './shared'
import { enumParam, numParam } from './shared'


// ---------------------------------------------------------------------------
// Utility / math
// ---------------------------------------------------------------------------

export const gain: NodeEmitter = {
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

export const vca: NodeEmitter = {
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

export const mixer4: NodeEmitter = {
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

export const pan: NodeEmitter = {
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

export const clip: NodeEmitter = {
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

export const sumNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const parts = [1, 2, 3, 4].map((n) => `(${ctx.inputExpr(ctx.node.id, `in${n}`, '0.f')})`)
    return `    float ${out} = ${parts.join(' + ')};\n`
  }
}

export const multiplyNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    return `    float ${out} = (${a}) * (${b});\n`
  }
}

/*
 * EQUAL POWER, not linear.
 *
 * `cos(t*pi/2)` / `sin(t*pi/2)` keeps perceived loudness constant across
 * the sweep; a linear `(1-m)`/`m` pair dips ~3 dB in the middle, which is
 * audible as a hole as you cross over. The emulator worklet has always used
 * equal power and both emitters used linear, so the device dipped where the
 * app did not — a factor of sqrt(2) at the midpoint, which is exactly the
 * 1.43x `npm run test:audio` measured.
 */
export const crossfade: NodeEmitter = {
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
      `        float _ga = cosf(m * 1.57079632679f);\n` +
      `        float _gb = sinf(m * 1.57079632679f);\n` +
      `        ${out} = (${a}) * _ga + (${b}) * _gb;\n` +
      `    }\n`
    )
  }
}

export const ring_mod: NodeEmitter = {
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

export const wavefolder: NodeEmitter = {
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
