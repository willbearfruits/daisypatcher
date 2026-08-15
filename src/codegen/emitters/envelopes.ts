import type { NodeEmitter } from './shared'
import { enumParam, numParam } from './shared'


// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export const adsr: NodeEmitter = {
  declare: (ctx) => `Adsr ${ctx.varName(ctx.node.id)};`,
  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      `    ${v}.Init(sr);`,
      `    ${v}.SetTime(ADSR_SEG_ATTACK, ${numParam(ctx.node, 'attack', 0.01)});`,
      `    ${v}.SetTime(ADSR_SEG_DECAY, ${numParam(ctx.node, 'decay', 0.1)});`,
      `    ${v}.SetSustainLevel(${numParam(ctx.node, 'sustain', 0.7)});`,
      `    ${v}.SetTime(ADSR_SEG_RELEASE, ${numParam(ctx.node, 'release', 0.3)});`
    ].join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const g = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const decCvExpr = ctx.inputExpr(ctx.node.id, 'cv_decay', '__NC__')
    const susCvExpr = ctx.inputExpr(ctx.node.id, 'cv_sustain', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const lines: string[] = []
    if (atkCvExpr !== '__NC__') lines.push(`    ${v}.SetTime(ADSR_SEG_ATTACK, fmaxf(0.001f, fminf(4.f, ${atkCvExpr})));`)
    if (decCvExpr !== '__NC__') lines.push(`    ${v}.SetTime(ADSR_SEG_DECAY, fmaxf(0.001f, fminf(4.f, ${decCvExpr})));`)
    if (susCvExpr !== '__NC__') lines.push(`    ${v}.SetSustainLevel(fmaxf(0.f, fminf(1.f, ${susCvExpr})));`)
    if (relCvExpr !== '__NC__') lines.push(`    ${v}.SetTime(ADSR_SEG_RELEASE, fmaxf(0.001f, fminf(8.f, ${relCvExpr})));`)
    const prefix = lines.length > 0 ? lines.join('\n') + '\n' : ''
    return (
      prefix +
      `    float ${out} = ${v}.Process((${g}) > 0.5f);\n`
    )
  }
}

export const ar: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_level = 0.f;\nfloat ${v}_prev_gate = 0.f;\nbool ${v}_rising = false;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const g = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const a = numParam(ctx.node, 'attack', 0.01)
    const r = numParam(ctx.node, 'release', 0.3)
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const aExpr = atkCvExpr === '__NC__' ? `${a}` : `fmaxf(0.001f, fminf(4.f, ${atkCvExpr}))`
    const rExpr = relCvExpr === '__NC__' ? `${r}` : `fmaxf(0.001f, fminf(8.f, ${relCvExpr}))`
    return (
      `    {\n` +
      `        float gi = ${g};\n` +
      `        if (gi > 0.5f && ${v}_prev_gate <= 0.5f) ${v}_rising = true;\n` +
      `        ${v}_prev_gate = gi;\n` +
      `        float atk = 1.f - expf(-1.f / (sr * fmaxf((${aExpr}), 1e-4f)));\n` +
      `        float rel = 1.f - expf(-1.f / (sr * fmaxf((${rExpr}), 1e-4f)));\n` +
      `        if (${v}_rising) {\n` +
      `            ${v}_level += (1.f - ${v}_level) * atk;\n` +
      `            if (${v}_level > 0.999f) ${v}_rising = false;\n` +
      `        } else {\n` +
      `            ${v}_level += (0.f - ${v}_level) * rel;\n` +
      `        }\n` +
      `    }\n` +
      `    float ${out} = ${v}_level;\n`
    )
  }
}

export const envelope_follower: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_env = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const a = numParam(ctx.node, 'attack', 0.01)
    const r = numParam(ctx.node, 'release', 0.1)
    const atkCvExpr = ctx.inputExpr(ctx.node.id, 'cv_attack', '__NC__')
    const relCvExpr = ctx.inputExpr(ctx.node.id, 'cv_release', '__NC__')
    const aExpr = atkCvExpr === '__NC__' ? `${a}` : `fmaxf(0.001f, fminf(1.f, ${atkCvExpr}))`
    const rExpr = relCvExpr === '__NC__' ? `${r}` : `fmaxf(0.001f, fminf(2.f, ${relCvExpr}))`
    return (
      `    {\n` +
      `        float x = fabsf(${i});\n` +
      `        float ca = 1.f - expf(-1.f / (sr * fmaxf((${aExpr}), 1e-4f)));\n` +
      `        float cr = 1.f - expf(-1.f / (sr * fmaxf((${rExpr}), 1e-4f)));\n` +
      `        float c = (x > ${v}_env) ? ca : cr;\n` +
      `        ${v}_env += (x - ${v}_env) * c;\n` +
      `    }\n` +
      `    float ${out} = ${v}_env;\n`
    )
  }
}

// ---------------------------------------------------------------------------
// CV tools
// ---------------------------------------------------------------------------

export const slew: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_y = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const rise = numParam(ctx.node, 'rise', 0.05)
    const fall = numParam(ctx.node, 'fall', 0.05)
    const riseCvExpr = ctx.inputExpr(ctx.node.id, 'cv_rise', '__NC__')
    const fallCvExpr = ctx.inputExpr(ctx.node.id, 'cv_fall', '__NC__')
    const rExpr = riseCvExpr === '__NC__'
      ? `${rise}`
      : `fmaxf(0.f, fminf(2.f, ${riseCvExpr}))`
    const fExpr = fallCvExpr === '__NC__'
      ? `${fall}`
      : `fmaxf(0.f, fminf(2.f, ${fallCvExpr}))`
    return (
      `    {\n` +
      `        float x = ${i};\n` +
      `        float cr = 1.f - expf(-1.f / (sr * fmaxf((${rExpr}), 1e-4f)));\n` +
      `        float cf = 1.f - expf(-1.f / (sr * fmaxf((${fExpr}), 1e-4f)));\n` +
      `        float c = (x > ${v}_y) ? cr : cf;\n` +
      `        ${v}_y += (x - ${v}_y) * c;\n` +
      `    }\n` +
      `    float ${out} = ${v}_y;\n`
    )
  }
}

export const sample_hold: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_held = 0.f;\nfloat ${v}_prev_trig = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const t = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    return (
      `    {\n` +
      `        float ti = ${t};\n` +
      `        if (ti > 0.5f && ${v}_prev_trig <= 0.5f) ${v}_held = ${i};\n` +
      `        ${v}_prev_trig = ti;\n` +
      `    }\n` +
      `    float ${out} = ${v}_held;\n`
    )
  }
}

export const inverter: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    return `    float ${out} = -(${i});\n`
  }
}

export const scaleNode: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const s = numParam(ctx.node, 'scale', 1)
    const o = numParam(ctx.node, 'offset', 0)
    return `    float ${out} = (${i}) * ${s} + ${o};\n`
  }
}

/**
 * Range remap — Max/PD `scale` with optional clamp. Emits a guarded divide
 * so `in_max == in_min` doesn't blow up (division-by-zero in float returns
 * +/-inf; we'd rather collapse the output to `out_min`).
 */
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
    const i = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const ref = ctx.inputExpr(ctx.node.id, 'ref', '0.f')
    const thr = numParam(ctx.node, 'threshold', 0)
    const thrCvExpr = ctx.inputExpr(ctx.node.id, 'cv_threshold', '__NC__')
    const tExpr = thrCvExpr === '__NC__'
      ? `${thr}`
      : `fmaxf(-1.f, fminf(1.f, ${thrCvExpr}))`
    return `    float ${out} = ((${i}) > ((${ref}) + (${tExpr}))) ? 1.f : 0.f;\n`
  }
}
