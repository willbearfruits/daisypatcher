/**
 * ESP32-S3 per-kind emitters. Parallel to `nodeEmitters.ts` but
 * producing Arduino-framework C++ that does not depend on libDaisy /
 * DaisySP. DSP lives inline — same math the Web Audio worklets use,
 * expressed in plain C++.
 *
 * Conventions match `nodeEmitters.ts`:
 *
 *   declare  — file-scope state for this node (float members, buffers).
 *   init     — one-shot setup inside `setup()`.
 *   process  — per-sample body inside the render-block loop. Emits
 *              `float <var>_<outSocket> = ...;` for each output.
 *
 * Anything that requires a DaisySP class (ReverbSc, MoogLadder, Granular,
 * etc.) falls back to a passthrough + explicit warning — the MCU doesn't
 * have the library or the horsepower, and silently miscompiling would
 * be worse than a loud "not supported" in the build log.
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
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const amp = numParam(ctx.node, 'amplitude', 0.3)
    return `    float ${out} = ((float)esp_random() / (float)UINT32_MAX * 2.f - 1.f) * ${amp};\n`
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
    const waveExpr =
      wave === 'saw'
        ? `(2.f * ${v}_phase - 1.f)`
        : wave === 'square'
          ? `(${v}_phase < 0.5f ? 1.f : -1.f)`
          : wave === 'tri'
            ? `(4.f * fabsf(${v}_phase - 0.5f) - 1.f)`
            : `sinf(${v}_phase * 6.28318530718f)`
    return (
      `    ${v}_phase += ${freq} / (float)SAMPLE_RATE;\n` +
      `    if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `    float ${out} = ${waveExpr} * ${depth} + ${offset};\n`
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

/* --------------------------- amp / utility --------------------------- */

const gain: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const amt = numParam(ctx.node, 'gain', 1)
    return `    float ${out} = (${input}) * ${amt};\n`
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
      parts.push(`(${sig}) * ${g}`)
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
    return (
      `    {\n` +
      `        float _p = ${p} * 0.5f + 0.5f;\n` +
      `        float _gl = cosf(_p * 1.5707963268f);\n` +
      `        float _gr = sinf(_p * 1.5707963268f);\n` +
      `        float ${l} = (${input}) * _gl;\n` +
      `        float ${r} = (${input}) * _gr;\n` +
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
    const lo = numParam(ctx.node, 'min', -1)
    const hi = numParam(ctx.node, 'max', 1)
    return `    float ${out} = fmaxf(${lo}, fminf(${hi}, (${input})));\n`
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
    const x = ctx.inputExpr(ctx.node.id, 'x', formatFloat(rawNum(ctx.node, 'x', 0.5)))
    return `    float ${out} = (${a}) * (1.f - (${x})) + (${b}) * (${x});\n`
  }
}

const ring_mod: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    return `    float ${out} = (${a}) * (${b});\n`
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
      `    {\n` +
      `        float _v = (${input}) * ${amt};\n` +
      `        _v = sinf(_v * 1.5707963268f);\n` +
      `        float ${out} = _v;\n` +
      `    }\n`
    )
  }
}

/* --------------------------- filters --------------------------- */

// Simple one-pole LP + HP + BP built from a state-variable topology.
const filter_svf: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_low = 0.f, ${v}_band = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lp = ctx.outputVar(ctx.node.id, 'lp')
    const hp = ctx.outputVar(ctx.node.id, 'hp')
    const bp = ctx.outputVar(ctx.node.id, 'bp')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const freq = numParam(ctx.node, 'frequency', 1000)
    const q = numParam(ctx.node, 'resonance', 0.5)
    return (
      `    {\n` +
      `        float _f = 2.f * sinf(3.14159265f * ${freq} / (float)SAMPLE_RATE);\n` +
      `        float _q = 1.f - ${q};\n` +
      `        float _hp = (${input}) - ${v}_low - ${v}_band * _q;\n` +
      `        ${v}_band += _f * _hp;\n` +
      `        ${v}_low += _f * ${v}_band;\n` +
      `        float ${lp} = ${v}_low;\n` +
      `        float ${hp} = _hp;\n` +
      `        float ${bp} = ${v}_band;\n` +
      `    }\n`
    )
  }
}

// Ladder approximation: 4 cascaded one-poles with feedback.
const filter_moog: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `float ${v}_s0 = 0.f, ${v}_s1 = 0.f, ${v}_s2 = 0.f, ${v}_s3 = 0.f;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const freq = numParam(ctx.node, 'frequency', 1000)
    const res = numParam(ctx.node, 'resonance', 0.5)
    return (
      `    {\n` +
      `        float _f = 2.f * sinf(3.14159265f * ${freq} / (float)SAMPLE_RATE);\n` +
      `        float _r = ${res} * 4.f;\n` +
      `        float _x = (${input}) - _r * ${v}_s3;\n` +
      `        ${v}_s0 += _f * (_x - ${v}_s0);\n` +
      `        ${v}_s1 += _f * (${v}_s0 - ${v}_s1);\n` +
      `        ${v}_s2 += _f * (${v}_s1 - ${v}_s2);\n` +
      `        ${v}_s3 += _f * (${v}_s2 - ${v}_s3);\n` +
      `        float ${out} = ${v}_s3;\n` +
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
    return (
      `    {\n` +
      `        float _g = (${gate});\n` +
      `        if (_g > 0.5f && ${v}_last_gate <= 0.5f) ${v}_stage = 1;\n` +
      `        if (_g <= 0.5f && ${v}_last_gate > 0.5f) ${v}_stage = 4;\n` +
      `        ${v}_last_gate = _g;\n` +
      `        float _dt = 1.f / (float)SAMPLE_RATE;\n` +
      `        if (${v}_stage == 1) { ${v}_val += _dt / fmaxf(${a}, 1e-4f); if (${v}_val >= 1.f) { ${v}_val = 1.f; ${v}_stage = 2; } }\n` +
      `        else if (${v}_stage == 2) { ${v}_val -= (1.f - ${s}) * _dt / fmaxf(${d}, 1e-4f); if (${v}_val <= ${s}) { ${v}_val = ${s}; ${v}_stage = 3; } }\n` +
      `        else if (${v}_stage == 3) { ${v}_val = ${s}; }\n` +
      `        else if (${v}_stage == 4) { ${v}_val -= ${v}_val * _dt / fmaxf(${r}, 1e-4f); if (${v}_val < 0.001f) { ${v}_val = 0.f; ${v}_stage = 0; } }\n` +
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
    return (
      `    {\n` +
      `        float _g = (${gate});\n` +
      `        if (_g > 0.5f && ${v}_last_gate <= 0.5f) ${v}_stage = 1;\n` +
      `        if (_g <= 0.5f && ${v}_last_gate > 0.5f) ${v}_stage = 2;\n` +
      `        ${v}_last_gate = _g;\n` +
      `        float _dt = 1.f / (float)SAMPLE_RATE;\n` +
      `        if (${v}_stage == 1) { ${v}_val += _dt / fmaxf(${a}, 1e-4f); if (${v}_val >= 1.f) { ${v}_val = 1.f; } }\n` +
      `        else if (${v}_stage == 2) { ${v}_val -= ${v}_val * _dt / fmaxf(${r}, 1e-4f); if (${v}_val < 0.001f) { ${v}_val = 0.f; ${v}_stage = 0; } }\n` +
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
    return (
      `    {\n` +
      `        float _x = fabsf(${input});\n` +
      `        float _c = (_x > ${v}_state) ? ${a} : ${r};\n` +
      `        ${v}_state += (_x - ${v}_state) * fminf(1.f, _c);\n` +
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
    const rate = numParam(ctx.node, 'rate', 0.01)
    return (
      `    ${v}_state += ((${input}) - ${v}_state) * fminf(1.f, ${rate});\n` +
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

const comparator: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', formatFloat(rawNum(ctx.node, 'threshold', 0)))
    return `    float ${out} = (${a}) > (${b}) ? 1.f : 0.f;\n`
  }
}

/* --------------------------- effects (core) --------------------------- */

const delay: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `static float ${v}_buf[48000 * 2] = {0}; int ${v}_idx = 0;`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const time = numParam(ctx.node, 'time', 0.25)
    const fb = numParam(ctx.node, 'feedback', 0.4)
    const mix = numParam(ctx.node, 'mix', 0.5)
    return (
      `    {\n` +
      `        int _len = (int)(${time} * (float)SAMPLE_RATE); if (_len < 1) _len = 1; if (_len > 96000) _len = 96000;\n` +
      `        int _ri = ${v}_idx - _len; if (_ri < 0) _ri += 96000;\n` +
      `        float _wet = ${v}_buf[_ri];\n` +
      `        float _in = (${input});\n` +
      `        ${v}_buf[${v}_idx] = _in + _wet * ${fb};\n` +
      `        ${v}_idx = (${v}_idx + 1) % 96000;\n` +
      `        float ${out} = _in * (1.f - ${mix}) + _wet * ${mix};\n` +
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
    return `    float ${out} = tanhf((${input}) * (1.f + ${drive} * 10.f));\n`
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
    return (
      `    {\n` +
      `        int _step = (int)(1.f / fmaxf(${rate}, 0.001f));\n` +
      `        if (${v}_ctr >= _step) { ${v}_ctr = 0; float _levels = powf(2.f, ${bits}); ${v}_held = floorf((${input}) * _levels) / _levels; }\n` +
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
    return (
      `    ${v}_phase += ${rate} / (float)SAMPLE_RATE;\n` +
      `    if (${v}_phase >= 1.f) ${v}_phase -= 1.f;\n` +
      `    float ${out} = (${input}) * (1.f - ${depth} * (0.5f - 0.5f * sinf(${v}_phase * 6.28318530718f)));\n`
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
    return (
      `    {\n` +
      `        float _x = fabsf(${input});\n` +
      `        ${v}_env += (_x - ${v}_env) * 0.01f;\n` +
      `        float _env_db = 20.f * log10f(fmaxf(${v}_env, 1e-6f));\n` +
      `        float _gain = 1.f;\n` +
      `        if (_env_db > ${thresh}) { float _over = _env_db - ${thresh}; float _comp_db = _over * (1.f - 1.f/fmaxf(${ratio},1.f)); _gain = powf(10.f, -_comp_db/20.f); }\n` +
      `        float ${out} = (${input}) * _gain;\n` +
      `    }\n`
    )
  }
}

const limiter: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const ceil = numParam(ctx.node, 'ceiling', 0.95)
    return `    float ${out} = tanhf((${input}) * (1.f / fmaxf(${ceil}, 0.001f))) * ${ceil};\n`
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
    // ESP32 knob value is updated by analogRead() in loop() — see main.cpp.
    return `    float ${out} = ${v}_val;\n`
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
    // On ESP32, we stash per-node "last value" for the main loop to
    // digitalWrite/ledcWrite. Declared via state variable below.
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

/* --------------------------- stubs --------------------------- */

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

/* --------------------------- export table --------------------------- */

export const ESP32_NODE_EMITTERS: Partial<Record<NodeKind, NodeEmitter>> = {
  // Sources
  oscillator,
  noise,
  lfo,
  constant,
  karplus:   unsupported('karplus', 'DaisySP Karplus unavailable'),
  fm_op:     unsupported('fm_op', 'DaisySP Fm2 unavailable'),
  fm2:       unsupported('fm2', 'DaisySP Fm2 unavailable'),
  wavetable: unsupported('wavetable', 'wavetable emitter Daisy-specific'),
  drum_kick: unsupported('drum_kick', 'DaisySP AnalogBassDrum unavailable'),
  drum_snare: unsupported('drum_snare', 'DaisySP AnalogSnareDrum unavailable'),
  drum_hat:  unsupported('drum_hat', 'DaisySP HiHat unavailable'),
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
  formant: unsupported('formant', 'formant bank too heavy for MCU'),
  // Envelopes
  adsr,
  ar,
  envelope_follower,
  // CV
  slew,
  sample_hold,
  inverter,
  scale: scaleNode,
  comparator,
  // Sequencing / clock — not yet ported to ESP32; safe passthroughs.
  clock:         unsupported('clock', 'clock emitter Daisy-specific'),
  clock_divider: unsupported('clock_divider', 'clock emitter Daisy-specific'),
  step_seq:      unsupported('step_seq', 'step_seq emitter Daisy-specific'),
  euclidean:     unsupported('euclidean', 'euclidean emitter Daisy-specific'),
  random:        unsupported('random', 'random emitter Daisy-specific'),
  dust:          unsupported('dust', 'dust emitter Daisy-specific'),
  arp:           unsupported('arp', 'arp emitter Daisy-specific'),
  // Effects
  delay,
  reverb:     unsupported('reverb', 'DaisySP ReverbSc unavailable on ESP32 — no FreeVerb'),
  overdrive,
  chorus:     unsupported('chorus', 'DaisySP Chorus unavailable'),
  bitcrush,
  phaser:     unsupported('phaser', 'DaisySP Phaser unavailable'),
  flanger:    unsupported('flanger', 'DaisySP Flanger unavailable'),
  ping_pong:  unsupported('ping_pong', 'stereo delay not yet ported'),
  stereo_widener: unsupported('stereo_widener', 'not yet ported'),
  freeze:     unsupported('freeze', 'not yet ported'),
  granulator: unsupported('granulator', 'too heavy for MCU without PSRAM buffering'),
  pitch_shifter: unsupported('pitch_shifter', 'DaisySP PitchShifter unavailable'),
  tremolo,
  vibrato:    unsupported('vibrato', 'not yet ported'),
  // Dynamics
  compressor,
  limiter,
  noise_gate: unsupported('noise_gate', 'not yet ported'),
  // Visual — no-op
  scope: visualPassthrough,
  vu: visualPassthrough,
  spectrum_scope: visualPassthrough,
  oled: unsupported('oled', 'OLED codegen requires Adafruit_SSD1306 — wire it via platformio.ini'),
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
  // MIDI — future work via Serial or BLE MIDI
  midi_in_note: unsupported('midi_in_note', 'MIDI on ESP32 not yet implemented'),
  midi_in_cc:   unsupported('midi_in_cc', 'MIDI on ESP32 not yet implemented'),
  midi_out_note: unsupported('midi_out_note', 'MIDI on ESP32 not yet implemented'),
  // Scripting
  expression: unsupported('expression', 'expression parser reuses Daisy emitter; port pending'),
  print: unsupported('print', 'use Serial.print directly; codegen port pending')
}
