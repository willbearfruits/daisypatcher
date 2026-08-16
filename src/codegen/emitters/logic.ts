/**
 * Logic emitters — see `nodes/defs.logic.ts` for what these nodes are for.
 *
 * These use no DaisySP and no platform API, so the Daisy and ESP32 versions
 * are the same code with a different sample-rate token. That is deliberate:
 * the whole class of bugs `npm run test:audio` was built to catch comes from
 * two implementations of one node drifting, and the cheapest way not to
 * drift is not to have two.
 *
 * Every node here keeps state in a function-local `static`, which is how the
 * rest of the catalog does it — the audio callback is the only caller, so
 * there is no reentrancy to worry about, and it keeps the declaration next
 * to the use instead of in a file-scope block far away.
 */

import type { NodeEmitter } from './shared'
import { enumParam, numParam } from './shared'

export const logic: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const a = ctx.inputExpr(ctx.node.id, 'a', '0.f')
    const b = ctx.inputExpr(ctx.node.id, 'b', '0.f')
    const op = enumParam(ctx.node, 'op', 'and')
    const av = `((${a}) >= 0.5f)`
    const bv = `((${b}) >= 0.5f)`
    const expr =
      op === 'or' ? `(${av} || ${bv})`
      : op === 'xor' ? `(${av} != ${bv})`
      : op === 'nand' ? `(!(${av} && ${bv}))`
      : op === 'nor' ? `(!(${av} || ${bv}))`
      : op === 'not' ? `(!${av})`
      : `(${av} && ${bv})`
    return `    float ${out} = ${expr} ? 1.f : 0.f;\n`
  }
}

export const toggle: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const inv = ctx.outputVar(ctx.node.id, 'inv')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const rst = ctx.inputExpr(ctx.node.id, 'reset', '0.f')
    const initial = enumParam(ctx.node, 'initial', 'low') === 'high' ? 'true' : 'false'
    return (
      `    static bool ${v}_state = ${initial};\n` +
      `    static bool ${v}_tprev = false;\n` +
      `    static bool ${v}_rprev = false;\n` +
      `    {\n` +
      `        bool _r = (${rst}) >= 0.5f;\n` +
      `        if (_r && !${v}_rprev) ${v}_state = ${initial};\n` +
      `        ${v}_rprev = _r;\n` +
      `        bool _t = (${trig}) >= 0.5f;\n` +
      `        if (_t && !${v}_tprev) ${v}_state = !${v}_state;\n` +
      `        ${v}_tprev = _t;\n` +
      `    }\n` +
      `    float ${out} = ${v}_state ? 1.f : 0.f;\n` +
      `    float ${inv} = ${v}_state ? 0.f : 1.f;\n`
    )
  }
}

export const counter: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const count = ctx.outputVar(ctx.node.id, 'count')
    const index = ctx.outputVar(ctx.node.id, 'index')
    const carry = ctx.outputVar(ctx.node.id, 'carry')
    const inc = ctx.inputExpr(ctx.node.id, 'inc', '0.f')
    const dec = ctx.inputExpr(ctx.node.id, 'dec', '0.f')
    const rst = ctx.inputExpr(ctx.node.id, 'reset', '0.f')
    const max = numParam(ctx.node, 'max', 8)
    const wrap = enumParam(ctx.node, 'mode', 'wrap') !== 'clamp'
    return (
      `    static int ${v}_val = 0;\n` +
      `    static bool ${v}_iprev = false;\n` +
      `    static bool ${v}_dprev = false;\n` +
      `    static bool ${v}_rprev = false;\n` +
      `    float ${carry} = 0.f;\n` +
      `    {\n` +
      `        const int _max = (int)(${max});\n` +
      `        bool _r = (${rst}) >= 0.5f;\n` +
      `        if (_r && !${v}_rprev) ${v}_val = 0;\n` +
      `        ${v}_rprev = _r;\n` +
      `        bool _i = (${inc}) >= 0.5f;\n` +
      `        if (_i && !${v}_iprev) {\n` +
      `            ${v}_val++;\n` +
      `            if (${v}_val >= _max) { ${carry} = 1.f; ${v}_val = ${wrap ? '0' : '_max - 1'}; }\n` +
      `        }\n` +
      `        ${v}_iprev = _i;\n` +
      `        bool _d = (${dec}) >= 0.5f;\n` +
      `        if (_d && !${v}_dprev) {\n` +
      `            ${v}_val--;\n` +
      `            if (${v}_val < 0) { ${carry} = 1.f; ${v}_val = ${wrap ? '_max - 1' : '0'}; }\n` +
      `        }\n` +
      `        ${v}_dprev = _d;\n` +
      `    }\n` +
      // Normalised by max-1 so the last step reads exactly 1.0.
      `    float ${count} = ((${max}) > 1.f) ? ((float)${v}_val / ((${max}) - 1.f)) : 0.f;\n` +
      `    float ${index} = (float)${v}_val;\n`
    )
  }
}

export const timer: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const running = ctx.outputVar(ctx.node.id, 'running')
    const trig = ctx.inputExpr(ctx.node.id, 'trigger', '0.f')
    const timeCv = ctx.inputExpr(ctx.node.id, 'cv_time', '__NC__')
    const time = numParam(ctx.node, 'time', 250)
    const mode = enumParam(ctx.node, 'mode', 'delay')
    const restart = enumParam(ctx.node, 'retrigger', 'restart') === 'restart'
    const msExpr = timeCv === '__NC__' ? `${time}` : `fmaxf(1.f, fminf(10000.f, ${timeCv}))`

    let body: string
    if (mode === 'gateoff') {
      body =
        `        (void)_rise;\n` +
        `        if (_t) { ${v}_held = true; ${v}_rem = 0; }\n` +
        `        else if (${v}_tprev) { ${v}_rem = _n; }\n` +
        `        else if (${v}_rem > 0) { ${v}_rem--; if (${v}_rem == 0) ${v}_held = false; }\n` +
        `        ${out} = ${v}_held ? 1.f : 0.f;\n`
    } else if (mode === 'pulse') {
      body =
        `        if (_rise${restart ? '' : ` && ${v}_rem == 0`}) ${v}_rem = _n;\n` +
        `        if (${v}_rem > 0) { ${out} = 1.f; ${v}_rem--; }\n`
    } else {
      body =
        `        if (_rise${restart ? '' : ` && ${v}_rem == 0`}) ${v}_rem = _n;\n` +
        `        if (${v}_rem > 0) { ${v}_rem--; if (${v}_rem == 0) ${out} = 1.f; }\n`
    }

    return (
      `    static int ${v}_rem = 0;\n` +
      `    static bool ${v}_tprev = false;\n` +
      // `_held` is gate-off state; the other modes never touch it.
      (mode === 'gateoff' ? `    static bool ${v}_held = false;\n` : '') +
      `    float ${out} = 0.f;\n` +
      `    {\n` +
      `        const int _n = (int)(((${msExpr}) / 1000.f) * sr);\n` +
      `        bool _t = (${trig}) >= 0.5f;\n` +
      `        bool _rise = _t && !${v}_tprev;\n` +
      body +
      `        ${v}_tprev = _t;\n` +
      `    }\n` +
      `    float ${running} = ${v}_rem > 0 ? 1.f : 0.f;\n`
    )
  }
}

export const state_machine: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const state = ctx.outputVar(ctx.node.id, 'state')
    const index = ctx.outputVar(ctx.node.id, 'index')
    const changed = ctx.outputVar(ctx.node.id, 'changed')
    const nxt = ctx.inputExpr(ctx.node.id, 'next', '0.f')
    const prv = ctx.inputExpr(ctx.node.id, 'prev', '0.f')
    const rst = ctx.inputExpr(ctx.node.id, 'reset', '0.f')
    const goto_ = ctx.inputExpr(ctx.node.id, 'cv_goto', '__NC__')
    const states = numParam(ctx.node, 'states', 4)
    const wrap = enumParam(ctx.node, 'mode', 'wrap') !== 'clamp'
    return (
      `    static int ${v}_idx = 0;\n` +
      `    static bool ${v}_nprev = false;\n` +
      `    static bool ${v}_pprev = false;\n` +
      `    static bool ${v}_rprev = false;\n` +
      `    float ${changed} = 0.f;\n` +
      `    {\n` +
      `        const int _n = (int)(${states});\n` +
      `        const int _before = ${v}_idx;\n` +
      `        if (${v}_idx >= _n) ${v}_idx = _n - 1;\n` +
      `        bool _r = (${rst}) >= 0.5f;\n` +
      `        if (_r && !${v}_rprev) ${v}_idx = 0;\n` +
      `        ${v}_rprev = _r;\n` +
      `        bool _nx = (${nxt}) >= 0.5f;\n` +
      `        if (_nx && !${v}_nprev) { ${v}_idx++; if (${v}_idx >= _n) ${v}_idx = ${wrap ? '0' : '_n - 1'}; }\n` +
      `        ${v}_nprev = _nx;\n` +
      `        bool _pv = (${prv}) >= 0.5f;\n` +
      `        if (_pv && !${v}_pprev) { ${v}_idx--; if (${v}_idx < 0) ${v}_idx = ${wrap ? '_n - 1' : '0'}; }\n` +
      `        ${v}_pprev = _pv;\n` +
      (goto_ === '__NC__'
        ? ''
        : // Level-triggered: a knob should scrub, not need its own trigger.
          `        {\n` +
          `            float _g = fmaxf(0.f, fminf(1.f, ${goto_}));\n` +
          `            int _t = (int)(_g * (float)_n);\n` +
          `            ${v}_idx = _t >= _n ? _n - 1 : _t;\n` +
          `        }\n`) +
      `        if (${v}_idx != _before) ${changed} = 1.f;\n` +
      `    }\n` +
      `    float ${state} = ((${states}) > 1.f) ? ((float)${v}_idx / ((${states}) - 1.f)) : 0.f;\n` +
      `    float ${index} = (float)${v}_idx;\n`
    )
  }
}

export const select: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const ins = [0, 1, 2, 3].map((k) => ctx.inputExpr(ctx.node.id, `in${k}`, '0.f'))
    const sel = ctx.inputExpr(ctx.node.id, 'sel', '__NC__')
    const index = numParam(ctx.node, 'index', 0)
    const fade = enumParam(ctx.node, 'mode', 'switch') === 'crossfade'
    const posExpr =
      sel === '__NC__'
        ? `fmaxf(0.f, fminf(3.f, ${index}))`
        : `fmaxf(0.f, fminf(1.f, ${sel})) * 3.f`
    return (
      `    float ${out} = 0.f;\n` +
      `    {\n` +
      `        const float _srcs[4] = { ${ins.join(', ')} };\n` +
      `        float _pos = ${posExpr};\n` +
      (fade
        ? `        int _i0 = (int)_pos;\n` +
          `        if (_i0 > 3) _i0 = 3;\n` +
          `        int _i1 = (_i0 + 1 <= 3) ? _i0 + 1 : 3;\n` +
          `        float _f = _pos - (float)_i0;\n` +
          `        ${out} = _srcs[_i0] * (1.f - _f) + _srcs[_i1] * _f;\n`
        : `        int _k = (int)(_pos + 0.5f);\n` +
          `        if (_k < 0) _k = 0; else if (_k > 3) _k = 3;\n` +
          `        ${out} = _srcs[_k];\n`) +
      `    }\n`
    )
  }
}

export const edge: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const inp = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const mode = enumParam(ctx.node, 'mode', 'rising')
    const fire =
      mode === 'falling' ? '_fall' : mode === 'both' ? '(_rise || _fall)' : '_rise'
    const unused = mode === 'falling' ? '_rise' : mode === 'rising' ? '_fall' : null
    return (
      `    static bool ${v}_prev = false;\n` +
      `    float ${out} = 0.f;\n` +
      `    {\n` +
      `        bool _v = (${inp}) >= 0.5f;\n` +
      `        bool _rise = _v && !${v}_prev;\n` +
      `        bool _fall = !_v && ${v}_prev;\n` +
      (unused ? `        (void)${unused};\n` : '') +
      `        ${v}_prev = _v;\n` +
      `        ${out} = ${fire} ? 1.f : 0.f;\n` +
      `    }\n`
    )
  }
}
