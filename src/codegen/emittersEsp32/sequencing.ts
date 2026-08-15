import type { NodeEmitter } from '../nodeEmitters'
import { enumParam, formatFloat, numParam, paramOverrideOf, rawNum } from './shared'


/* --------------------------- sequencing --------------------------- */

export const clockNode: NodeEmitter = {
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

export const clock_divider: NodeEmitter = {
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

export const step_seq: NodeEmitter = {
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
      /*
       * Reset is DOMINANT — see the note on the euclidean emitter. Both
       * sequencers had the same shape and the same bug.
       */
      `        if (_ri > 0.5f && ${v}_prev_rst <= 0.5f) {\n` +
      `            ${v}_step = 0;\n` +
      `        } else if (_ci > 0.5f && ${v}_prev_clk <= 0.5f) {\n` +
      `            ${v}_step = (${v}_step + 1u) & 7u;\n` +
      `        }\n` +
      `        ${v}_prev_rst = _ri;\n` +
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

export const euclidean: NodeEmitter = {
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
    /*
     * A menu leaf targeting `pulses` or `rotate` drives a global rather
     * than a cable, so the connect-detection above cannot see it. Ask the
     * override hook directly and take the same runtime-rebuild path: the
     * pattern is recomputed in place when either value changes, exactly as
     * it is for a patched CV.
     */
    const pulsesOverride = paramOverrideOf(ctx.node, 'pulses')
    const rotateOverride = paramOverrideOf(ctx.node, 'rotate')
    const hasPulsesCv = pulsesCvExpr !== '__NC__'
    const hasRotateCv = rotateCvExpr !== '__NC__'
    let rebuildBlock = ''
    if (hasPulsesCv || hasRotateCv || pulsesOverride || rotateOverride) {
      const pulsesVal = hasPulsesCv
        ? `(int)fmaxf(0.f, fminf(32.f, ${pulsesCvExpr}))`
        : pulsesOverride
          ? `(int)(${pulsesOverride})`
          : `${pulses}`
      const rotateVal = hasRotateCv
        ? `(int)fmaxf(0.f, fminf(31.f, ${rotateCvExpr}))`
        : rotateOverride
          ? `(int)(${rotateOverride})`
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
      /*
       * Reset is DOMINANT — see the note on the euclidean emitter. Both
       * sequencers had the same shape and the same bug.
       */
      `        if (_ri > 0.5f && ${v}_prev_rst <= 0.5f) {\n` +
      `            ${v}_step = 0;\n` +
      `        } else if (_ci > 0.5f && ${v}_prev_clk <= 0.5f) {\n` +
      `            ${v}_step = (${v}_step + 1u) % ${steps}u;\n` +
      `        }\n` +
      `        ${v}_prev_rst = _ri;\n` +
      `        ${v}_prev_clk = _ci;\n` +
      `    }\n` +
      `    float ${out} = (${v}_pattern[${v}_step] && ((${clk}) > 0.5f)) ? 1.f : 0.f;\n`
    )
  }
}

export const randomNode: NodeEmitter = {
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

// See the `width` note on the Daisy dust emitter.
export const dust: NodeEmitter = {
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
    const width = numParam(ctx.node, 'width', 0.005)
    return (
      `    ${v}_rng = ${v}_rng * 1664525u + 1013904223u;\n` +
      `    static int ${v}_hold = 0;\n` +
      `    if (((${v}_rng >> 8) / 16777216.f) < ((${dExpr}) / (float)SAMPLE_RATE)) ${v}_hold = (int)(${width} * (float)SAMPLE_RATE);\n` +
      `    float ${out} = ${v}_hold > 0 ? 1.f : 0.f;\n` +
      `    if (${v}_hold > 0) ${v}_hold--;\n`
    )
  }
}

export const arp: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return `uint32_t ${v}_idx = 0; float ${v}_prev_clk = 0.f; float ${v}_prev_gate = 0.f; int ${v}_dir = 1; uint32_t ${v}_rng = 0xcaf31u;`
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
        : pattern === 'up_down'
          ? `            {\n` +
            `                int _n = (int)${v}_idx + ${v}_dir;\n` +
            `                if (_n >= ${len}) { _n = ${len} > 1 ? ${len - 2} : 0; ${v}_dir = -1; }\n` +
            `                else if (_n < 0) { _n = ${len} > 1 ? 1 : 0; ${v}_dir = 1; }\n` +
            `                ${v}_idx = (uint32_t)_n;\n` +
            `            }\n`
        : pattern === 'random'
          ? `            ${v}_rng = ${v}_rng * 1664525u + 1013904223u; ${v}_idx = ${v}_rng % ${len}u;\n`
          : `            ${v}_idx = (${v}_idx + 1u) % ${len}u;\n`
      /*
       * Three things the firmware used to get wrong here, all found once
       * `npm run test:audio` started driving BOTH gate inputs:
       *
       *   - a rising `gate_in` restarts the arpeggio. Every arpeggiator
       *     works this way — you play a chord and it starts from the
       *     bottom — and without it the device wandered off the emulator
       *     within a couple of bars.
       *   - `up_down` was not implemented and fell through to `up`, so the
       *     app and the device played different patterns from the same
       *     setting with nothing to indicate it.
       *   - the CV was unclamped, so a high root plus a high octave could
       *     push it past 1.0 where the emulator held.
       */
    return (
      `    static const float ${v}_notes[${len}] = { ${arr} };\n` +
      `    {\n` +
      `        float _ci = ${clk};\n` +
      `        float _gi = ${gIn};\n` +
      `        if (_gi > 0.5f && ${v}_prev_gate <= 0.5f) { ${v}_idx = 0u; ${v}_dir = 1; }\n` +
      `        ${v}_prev_gate = _gi;\n` +
      `        if (_ci > 0.5f && ${v}_prev_clk <= 0.5f && _gi > 0.5f) {\n` +
      stepLine +
      `        }\n` +
      `        ${v}_prev_clk = _ci;\n` +
      `    }\n` +
      `    float ${cvOut} = fmaxf(-1.f, fminf(1.f, ${v}_notes[${v}_idx] + ${root}));\n` +
      `    float ${gateOut} = ((${gIn}) > 0.5f && (${clk}) > 0.5f) ? 1.f : 0.f;\n`
    )
  }
}
