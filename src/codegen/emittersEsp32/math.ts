import type { NodeEmitter } from '../nodeEmitters'
import { enumParam, numParam } from './shared'


/* --------------------------- amp / utility --------------------------- */

export const gain: NodeEmitter = {
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

export const vca: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const cv = ctx.inputExpr(ctx.node.id, 'cv', '1.f')
    return `    float ${out} = (${a}) * (${cv});\n`
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
      const gE = lvlExpr === '__NC__'
        ? `${g}`
        : `fmaxf(0.f, fminf(2.f, ${lvlExpr}))`
      parts.push(`(${sig}) * (${gE})`)
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

export const clip: NodeEmitter = {
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

export const sumNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    return `    float ${out} = (${a}) + (${b});\n`
  }
}

export const multiplyNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '1.f')
    return `    float ${out} = (${a}) * (${b});\n`
  }
}

/*
 * EQUAL POWER, not linear. See the matching note in emitters/math.ts: a
 * linear crossfade dips ~3 dB at the midpoint where the emulator's
 * equal-power one does not, so the device had a hole in the sweep that the
 * app did not.
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
      `        float _m = (${mBase}) + (${cv});\n` +
      `        if (_m < 0.f) _m = 0.f; else if (_m > 1.f) _m = 1.f;\n` +
      `        float _ga = cosf(_m * 1.57079632679f);\n` +
      `        float _gb = sinf(_m * 1.57079632679f);\n` +
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
      `        float _a = (${a});\n` +
      `        float _b = (${b});\n` +
      `        ${out} = _a * (1.f - _m) + (_a * _b) * _m;\n` +
      `    }\n`
    )
  }
}

export const wavefolder: NodeEmitter = {
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
