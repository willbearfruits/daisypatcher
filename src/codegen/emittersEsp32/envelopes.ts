import type { NodeEmitter } from '../nodeEmitters'
import { enumParam, numParam } from './shared'


/* --------------------------- envelopes --------------------------- */

export const adsr: NodeEmitter = {
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
      `    float ${out};\n` +
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
      `        ${out} = ${v}_val;\n` +
      `    }\n`
    )
  }
}

export const ar: NodeEmitter = {
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
      `    float ${out};\n` +
      `    {\n` +
      `        float _g = (${gate});\n` +
      `        float _a = (${aExpr}); float _r = (${rExpr});\n` +
      `        if (_g > 0.5f && ${v}_last_gate <= 0.5f) ${v}_stage = 1;\n` +
      `        if (_g <= 0.5f && ${v}_last_gate > 0.5f) ${v}_stage = 2;\n` +
      `        ${v}_last_gate = _g;\n` +
      `        float _dt = 1.f / (float)SAMPLE_RATE;\n` +
      `        if (${v}_stage == 1) { ${v}_val += _dt / fmaxf(_a, 1e-4f); if (${v}_val >= 1.f) { ${v}_val = 1.f; } }\n` +
      `        else if (${v}_stage == 2) { ${v}_val -= ${v}_val * _dt / fmaxf(_r, 1e-4f); if (${v}_val < 0.001f) { ${v}_val = 0.f; ${v}_stage = 0; } }\n` +
      `        ${out} = ${v}_val;\n` +
      `    }\n`
    )
  }
}

export const envelope_follower: NodeEmitter = {
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
      `    float ${out};\n` +
      `    {\n` +
      `        float _x = fabsf(${input});\n` +
      `        float _ca = 1.f - expf(-1.f / ((float)SAMPLE_RATE * fmaxf((${aExpr}), 1e-4f)));\n` +
      `        float _cr = 1.f - expf(-1.f / ((float)SAMPLE_RATE * fmaxf((${rExpr}), 1e-4f)));\n` +
      `        float _c = (_x > ${v}_state) ? _ca : _cr;\n` +
      `        ${v}_state += (_x - ${v}_state) * _c;\n` +
      `        ${out} = ${v}_state;\n` +
      `    }\n`
    )
  }
}

/* --------------------------- CV tools --------------------------- */

export const slew: NodeEmitter = {
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

export const sample_hold: NodeEmitter = {
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
      `    float ${out};\n` +
      `    {\n` +
      `        float _t = (${trig});\n` +
      `        if (_t > 0.5f && ${v}_last_trig <= 0.5f) ${v}_held = (${input});\n` +
      `        ${v}_last_trig = _t;\n` +
      `        ${out} = ${v}_held;\n` +
      `    }\n`
    )
  }
}

export const inverter: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = -(${input});\n`
  }
}

export const scaleNode: NodeEmitter = {
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
export const rangeNode: NodeEmitter = {
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

export const comparator: NodeEmitter = {
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
