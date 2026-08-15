import type { NodeInstance } from '@/types/graph'
import { hwVar, resolveBinding, valueExprForBinding, valueExprForAnalogBinding } from '../hardwareBindings'
import { MENU_RUNTIME_CPP, buildMenuModel, emitMenuInit, emitMenuProcess, emitMenuTables, menuDetentFor, menuParamOverrides } from '../menuCodegen'
import { HMC, MPU, QMC, SENSOR_POLL_HZ, SENSOR_RUNTIME_CPP, accelRange, gyroRange, slewCoeff } from '../sensorCodegen'
import type { EmitContext, NodeEmitter } from './shared'
import { enumParam, formatFloat, numParam, rawNum } from './shared'


// ---------------------------------------------------------------------------
// Hardware I/O
// ---------------------------------------------------------------------------

export const audio_in: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    return `    float ${l} = in_l;\n    float ${r} = in_r;\n`
  }
}

/**
 * audio_output doesn't emit output vars — the emitter main loop picks up its
 * input exprs directly when wiring to `out[0][i]` / `out[1][i]`.
 */
export const audio_output: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: () => ''
}

export const knob_in: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    // Prefer hardware binding when present — `_val` in the binding case
    // comes from the ADC poll loop emitted by emitHardwareInit; the
    // legacy fallback uses the node-local `_val` (0 on the target; the
    // emulator polls it via setParam('value')).
    const bindingId = typeof ctx.node.params.bindingId === 'string'
      ? ctx.node.params.bindingId : ''
    // Role is derived from the bound component's kind, not assumed to be
    // 'wiper' — an LDR / mic / piezo / CV jack carries its analog pin on
    // 'signal'.
    const bound = bindingId && ctx.hardware
      ? valueExprForAnalogBinding(bindingId, ctx.hardware)
      : null
    const normalized = bound ?? `${v}_val`
    // Range-map the normalized 0..1 reading (ADC returns 0..1 via
    // `hw.adc.GetFloat`) to the user's sidebar min/max. Identity when
    // min=0, max=1. Handy presets: 0..4095 (raw 12-bit), 20..20000
    // (Hz sweep), -1..1 (bipolar CV).
    const lo = typeof ctx.node.params.min === 'number' ? ctx.node.params.min : 0
    const hi = typeof ctx.node.params.max === 'number' ? ctx.node.params.max : 1
    const expr =
      lo === 0 && hi === 1
        ? normalized
        : `${lo.toFixed(4)}f + (${normalized}) * ${(hi - lo).toFixed(4)}f`
    return `    float ${out} = ${expr};\n`
  }
}

export const gate_in: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const bindingId = typeof ctx.node.params.bindingId === 'string'
      ? ctx.node.params.bindingId : ''
    const bound = bindingId && ctx.hardware
      ? valueExprForBinding(bindingId, 'io', ctx.hardware)
      : null
    const expr = bound ?? `${v}_val`
    return `    float ${out} = ${expr};\n`
  }
}

// ---------------------------------------------------------------------------
// Hardware-bound digital + I2S + MIDI + scripting / debug emitters
// ---------------------------------------------------------------------------
//
// These cover the 10 nodes added in `defs.hardware.ts`. Each of the
// hardware-bound emitters (button, led, switch_3way, i2s_in, i2s_out)
// looks up its placed component via `resolveBinding` / `valueExprForBinding`
// when a hardware layout is present. When the layout isn't available yet
// (e.g. a parallel agent is still building the hardware view) or the
// binding is missing, the emitter leaves a `// TODO: bind <kind> ...`
// comment and pushes a warning — generated code still compiles.
//
// MIDI nodes assume Daisy's USB-device-class MIDI interface. The
// `midi_in_note` emitter owns the shared `MidiUsbHandler midi;`
// declaration and the `midi.Init()/StartReceive()` init hook. If a
// user places MIDI nodes without a note-in, `midi_in_cc` and
// `midi_out_note` will reference `midi` that doesn't exist — the
// generated main.cpp flags that as a compile error, which is the loud
// behaviour we want until the hardware view integration lands and can
// centralise peripheral init.
//
// Rising-edge detection uses a `static uint32_t <var>_last_gate` pattern
// so it survives AudioCallback invocations between blocks — same idea as
// the worklet's class field.

function bindingIdOf(node: NodeInstance): string {
  const raw = node.params.bindingId
  return typeof raw === 'string' ? raw : ''
}

export const button: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const bid = bindingIdOf(ctx.node)
    const bound = bid && ctx.hardware
      ? valueExprForBinding(bid, 'io', ctx.hardware)
      : null
    if (!bound) {
      if (bid) ctx.warn(`button ${ctx.node.id}: binding ${bid} not resolvable; emitting stub`)
      else ctx.warn(`button ${ctx.node.id}: unbound — bind it in the hardware view`)
      return `    // TODO: bind button in hardware view\n    float ${out} = ${v}_val;\n`
    }
    return `    float ${out} = ${bound};\n`
  }
}

export const led: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const bid = bindingIdOf(ctx.node)
    const threshold = numParam(ctx.node, 'threshold', 0.5)
    const mode = enumParam(ctx.node, 'mode', 'gate')
    const inExpr = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const r = bid && ctx.hardware
      ? resolveBinding(ctx.node.id, bid, 'anode', ctx.hardware)
      : null
    if (!r) {
      if (bid) ctx.warn(`led ${ctx.node.id}: binding ${bid} not resolvable; emitting stub`)
      else ctx.warn(`led ${ctx.node.id}: unbound — bind it in the hardware view`)
      return `    // TODO: bind led in hardware view (mode=${mode})\n    (void)(${inExpr});\n`
    }
    const pinVar = `${hwVar(r.component)}_gpio`
    if (mode === 'pwm' || mode === 'follow') {
      // Coarse PWM via a fast phase counter. Real hardware PWM lives on
      // a future pass with a PWM peripheral; this still gives visible
      // brightness feedback.
      return (
        `    {\n` +
        `        static uint32_t ${pinVar}_pwm_phase = 0;\n` +
        `        float mag = (${inExpr}); if (mag < 0.f) mag = -mag;\n` +
        `        ${pinVar}_pwm_phase = (${pinVar}_pwm_phase + 1u) & 0xff;\n` +
        `        float duty = (${pinVar}_pwm_phase / 256.f);\n` +
        `        ${pinVar}.Write(mag > duty ? 1 : 0);\n` +
        `    }\n`
      )
    }
    // gate mode
    return `    ${pinVar}.Write(((${inExpr}) > ${threshold}) ? 1 : 0);\n`
  }
}

export const switch_3way: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const bid = bindingIdOf(ctx.node)
    const r = bid && ctx.hardware
      ? resolveBinding(ctx.node.id, bid, 'pos1', ctx.hardware)
      : null
    if (!r) {
      if (bid) ctx.warn(`switch_3way ${ctx.node.id}: binding ${bid} not resolvable; emitting stub`)
      else ctx.warn(`switch_3way ${ctx.node.id}: unbound — bind it in the hardware view`)
      const posRaw = enumParam(ctx.node, 'position', '0')
      const posNum = posRaw === '-1' ? -1 : posRaw === '1' ? 1 : 0
      return `    // TODO: bind switch_3way in hardware view\n    float ${out} = ${formatFloat(posNum)}; (void)${v}_val;\n`
    }
    const p1 = `${hwVar(r.component)}_pos1_gpio`
    const p2 = `${hwVar(r.component)}_pos2_gpio`
    return (
      `    float ${out};\n` +
      `    {\n` +
      `        bool p1 = !${p1}.Read();\n` +
      `        bool p2 = !${p2}.Read();\n` +
      `        ${out} = p1 ? -1.f : (p2 ? 1.f : 0.f);\n` +
      `    }\n`
    )
  }
}

/*
 * Encoder -> integrated CV + delta + switch gate.
 *
 * The position lives in a persistent float rather than being read from a
 * pin: quadrature only reports CHANGE, so the firmware has to accumulate
 * it. Increment() returns -1/0/+1 per call and is latched by Debounce(),
 * which emitHardwarePoll calls once per main-loop pass.
 */
export const encoder_in: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    /*
     * Only the position persists. `delta` and `sw` are recomputed every
     * block, and naming them `<v>_delta` / `<v>_sw` would collide with the
     * output-socket variables (`outputVar(id,'delta')` is exactly that
     * string) — the block-scope output would shadow the file-scope state
     * and produce a self-assignment.
     */
    return `float ${v}_pos = ${numParam(ctx.node, 'value', 0.5)};`
  },
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const outDelta = ctx.outputVar(ctx.node.id, 'delta')
    const outSw = ctx.outputVar(ctx.node.id, 'sw')
    const step = rawNum(ctx.node, 'step', 0.02)
    const lo = rawNum(ctx.node, 'min', 0)
    const hi = rawNum(ctx.node, 'max', 1)
    const wrap = enumParam(ctx.node, 'wrap', 'clamp') === 'wrap'

    const bid = bindingIdOf(ctx.node)
    const r = bid && ctx.hardware
      ? resolveBinding(ctx.node.id, bid, 'a', ctx.hardware)
      : null

    if (!r) {
      if (bid) ctx.warn(`encoder_in ${ctx.node.id}: binding ${bid} not resolvable; emitting held value`)
      else ctx.warn(`encoder_in ${ctx.node.id}: unbound — bind it in the hardware view`)
      return (
        `    // TODO: bind encoder in hardware view\n` +
        `    float ${out} = ${formatFloat(lo)} + ${v}_pos * ${formatFloat(hi - lo)};\n` +
        `    float ${outDelta} = 0.f;\n` +
        `    float ${outSw} = 0.f;\n`
      )
    }

    const enc = `${hwVar(r.component)}_enc`
    const clampOrWrap = wrap
      ? `        if (${v}_pos < 0.f) ${v}_pos += 1.f;\n` +
        `        if (${v}_pos > 1.f) ${v}_pos -= 1.f;\n`
      : `        if (${v}_pos < 0.f) ${v}_pos = 0.f;\n` +
        `        if (${v}_pos > 1.f) ${v}_pos = 1.f;\n`
    return (
      `    float ${out};\n` +
      `    float ${outDelta};\n` +
      `    float ${outSw};\n` +
      `    {\n` +
      // Drain, don't sample: the main loop accumulates into _enc_pending and
      // this runs once per audio sample, so reading Increment() here counted
      // one physical click up to blockSize times.
      `        int32_t inc = ${enc}_pending;\n` +
      `        ${enc}_pending -= inc;\n` +
      `        float d = (float)inc * ${formatFloat(step)};\n` +
      `        ${v}_pos += d;\n` +
      clampOrWrap +
      `        ${out} = ${formatFloat(lo)} + ${v}_pos * ${formatFloat(hi - lo)};\n` +
      `        ${outDelta} = d * ${formatFloat(hi - lo)};\n` +
      `        ${outSw} = ${enc}.Pressed() ? 1.f : 0.f;\n` +
      `    }\n`
    )
  }
}

/**
 * Encoder-driven menu.
 *
 * All of the behaviour lives in `menuCodegen.ts`, shared with the ESP32
 * emitter — the state machine there is a transliteration of the same
 * `editor/menu/machine.ts` the emulator runs, so a physical encoder and the
 * in-node preview cannot drift apart. This emitter is only the wiring:
 * tables, the DpMenu instance, and per-sample plumbing.
 *
 * The four CV outputs are always produced. Leaves that instead target a node
 * param reach it through the globals `menuParamOverrides()` sets up, which
 * the target's own emitter picks up in place of its literal.
 */
export const menu: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const model = buildMenuModel(ctx.node)
    if (model.empty) ctx.warn(`menu ${ctx.node.id}: tree is empty — nothing to navigate`)
    return [
      MENU_RUNTIME_CPP,
      emitMenuTables(v, model),
      `uint16_t ${v}_tick = 0;`
    ].join('\n')
  },

  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return emitMenuInit(v, buildMenuModel(ctx.node), menuDetentFor(ctx.graph, ctx.node.id))
  },

  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const model = buildMenuModel(ctx.node)
    const overrides = menuOverridesForNode(ctx, model, v)
    return emitMenuProcess({
      v,
      deltaExpr: ctx.inputExpr(ctx.node.id, 'delta', '0.f'),
      swExpr: ctx.inputExpr(ctx.node.id, 'click', '0.f'),
      nowExpr: 'System::GetNow()',
      outVars: [
        ctx.outputVar(ctx.node.id, 'a'),
        ctx.outputVar(ctx.node.id, 'b'),
        ctx.outputVar(ctx.node.id, 'c'),
        ctx.outputVar(ctx.node.id, 'd')
      ],
      overrides
    })
  }
}

/**
 * The param globals this menu writes each sample.
 *
 * Recomputed from the graph rather than threaded through the context so both
 * emitters can call it identically; `menuParamOverrides` is the single place
 * that decides which targets are drivable in firmware.
 */
function menuOverridesForNode(
  ctx: EmitContext,
  model: ReturnType<typeof buildMenuModel>,
  menuVar: string
): { varName: string; entryIndex: number }[] {
  const all = menuParamOverrides(ctx.graph, () => {})
  const out: { varName: string; entryIndex: number }[] = []
  for (const o of all.values()) {
    if (o.menuVar !== menuVar) continue
    if (o.entryIndex >= model.entries.length) continue
    out.push({ varName: o.varName, entryIndex: o.entryIndex })
  }
  return out
}

/* ---------------------------------------------------------------------------
 * I2C sensors
 * -------------------------------------------------------------------------
 *
 * A shared bus, one `I2CHandle` for all of them, and a read that happens in
 * the MAIN LOOP rather than the audio callback. That last point is the whole
 * design: a blocking 14-byte transfer at 400 kHz is around 400 µs, and an
 * audio block at 48 kHz / 48 samples has 1 ms to spend in total. Reading a
 * sensor inside AudioCallback would eat nearly half the budget for data that
 * is meaningless above about 100 Hz.
 *
 * So the `loop` hook polls into volatile globals and the `process` hook
 * slews toward them, which also removes the staircase an unsmoothed
 * control-rate value would otherwise put on an audio-rate output.
 *
 * Register maps live in `sensorCodegen.ts`, shared with the ESP32 emitters
 * so a chip cannot be initialised two different ways on two boards.
 */

/** Bus pins for a sensor's binding, falling back to the Seed's I2C1. */
function sensorI2cPins(ctx: EmitContext): { sda: number; scl: number; label: string } {
  const bid = bindingIdOf(ctx.node)
  const comp = bid && ctx.hardware ? ctx.hardware.components.find((c) => c.id === bid) : undefined
  const sda = comp?.pins['sda']
  const scl = comp?.pins['scl']
  if (!sda || !scl) {
    ctx.warn(
      `${ctx.node.kind} ${ctx.node.id}: not bound to a pinned sensor; using default I2C1 pins (D11/D12)`
    )
    return { sda: 12, scl: 11, label: comp?.label ?? 'unbound' }
  }
  return {
    sda: parseInt(String(sda).slice(1), 10),
    scl: parseInt(String(scl).slice(1), 10),
    label: comp?.label ?? 'sensor'
  }
}

/**
 * The shared bus handle.
 *
 * Guarded so any number of sensors emit it once. They necessarily share it:
 * the Seed has one I2C1, and every one of these devices is a different
 * address on the same two wires — which is exactly why `SHARED_BUS_ROLES`
 * lets them share `sda`/`scl` in the hardware view.
 */
function sensorBusDecl(): string {
  return (
    `#ifndef DP_SENSOR_BUS\n` +
    `#define DP_SENSOR_BUS 1\n` +
    `I2CHandle dp_sensor_i2c;\n` +
    `uint32_t dp_sensor_last_ms = 0;\n` +
    `#endif`
  )
}

function sensorBusInit(sda: number, scl: number, label: string): string {
  return [
    `    // --- I2C sensor bus: ${label} ---`,
    `    #ifndef DP_SENSOR_BUS_INIT`,
    `    #define DP_SENSOR_BUS_INIT 1`,
    `    {`,
    `        I2CHandle::Config i2c_cfg;`,
    `        i2c_cfg.periph = I2CHandle::Config::Peripheral::I2C_1;`,
    `        i2c_cfg.speed  = I2CHandle::Config::Speed::I2C_400KHZ;`,
    `        i2c_cfg.mode   = I2CHandle::Config::Mode::I2C_MASTER;`,
    `        i2c_cfg.pin_config.scl = hw.GetPin(${scl});`,
    `        i2c_cfg.pin_config.sda = hw.GetPin(${sda});`,
    `        dp_sensor_i2c.Init(i2c_cfg);`,
    `    }`,
    `    #endif`
  ].join('\n')
}

/** Per-sample slew from the polled value toward the audio-rate output. */
function slewLine(v: string, axis: string, out: string, node: NodeInstance): string {
  const ms = Math.max(0, rawNum(node, 'smooth', 20))
  const coeff = ms <= 0 ? 1 : slewCoeff(48000, ms)
  return (
    `    ${v}_s_${axis} = dp_slew(${v}_s_${axis}, ${v}_p_${axis}, ${formatFloat(coeff)});\n` +
    `    float ${out} = ${v}_s_${axis};\n`
  )
}

const IMU_AXES = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'] as const

export const imu_in: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lines = [SENSOR_RUNTIME_CPP, sensorBusDecl()]
    // `volatile`: written from the main loop, read from the audio ISR.
    for (const a of IMU_AXES) lines.push(`volatile float ${v}_p_${a} = 0.f;`)
    for (const a of IMU_AXES) lines.push(`float ${v}_s_${a} = 0.f;`)
    lines.push(`uint32_t ${v}_next_ms = 0;`)
    return lines.join('\n')
  },

  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const { sda, scl, label } = sensorI2cPins(ctx)
    const ar = accelRange(ctx.node.params.accel_range)
    const gr = gyroRange(ctx.node.params.gyro_range)
    return [
      sensorBusInit(sda, scl, label),
      `    // --- IMU ${v}: wake the MPU-6050 and set full-scale ranges ---`,
      `    {`,
      `        uint8_t b;`,
      // PWR_MGMT_1 = 0 clears SLEEP. The part boots asleep; without this
      // every register reads back as its reset value forever.
      `        b = 0x00; dp_sensor_i2c.WriteDataAtAddress(0x${MPU.ADDR.toString(16)}, 0x${MPU.PWR_MGMT_1.toString(16)}, 1, &b, 1, 100);`,
      `        b = 0x${ar.cfg.toString(16).padStart(2, '0')}; dp_sensor_i2c.WriteDataAtAddress(0x${MPU.ADDR.toString(16)}, 0x${MPU.ACCEL_CONFIG.toString(16)}, 1, &b, 1, 100);`,
      `        b = 0x${gr.cfg.toString(16).padStart(2, '0')}; dp_sensor_i2c.WriteDataAtAddress(0x${MPU.ADDR.toString(16)}, 0x${MPU.GYRO_CONFIG.toString(16)}, 1, &b, 1, 100);`,
      `        ${v}_s_az = 1.f;`,
      `    }`
    ].join('\n')
  },

  loop: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const ar = accelRange(ctx.node.params.accel_range)
    const gr = gyroRange(ctx.node.params.gyro_range)
    const periodMs = Math.max(1, Math.round(1000 / SENSOR_POLL_HZ))
    return [
      `        { // IMU ${v}: one 14-byte burst at ${SENSOR_POLL_HZ} Hz`,
      `            uint32_t _now = System::GetNow();`,
      `            if (_now - ${v}_next_ms >= ${periodMs}) {`,
      `                ${v}_next_ms = _now;`,
      `                uint8_t _b[${MPU.BURST}];`,
      `                if (dp_sensor_i2c.ReadDataAtAddress(0x${MPU.ADDR.toString(16)}, 0x${MPU.ACCEL_XOUT_H.toString(16)}, 1, _b, ${MPU.BURST}, 10)`,
      `                    == I2CHandle::Result::OK) {`,
      // Bytes 6..7 are temperature, deliberately skipped — the gyro block
      // starts at offset 8.
      `                    ${v}_p_ax = (float)dp_be16(&_b[0])  / ${formatFloat(ar.lsbPerG)};`,
      `                    ${v}_p_ay = (float)dp_be16(&_b[2])  / ${formatFloat(ar.lsbPerG)};`,
      `                    ${v}_p_az = (float)dp_be16(&_b[4])  / ${formatFloat(ar.lsbPerG)};`,
      `                    ${v}_p_gx = (float)dp_be16(&_b[8])  / ${formatFloat(gr.lsbPerDps)};`,
      `                    ${v}_p_gy = (float)dp_be16(&_b[10]) / ${formatFloat(gr.lsbPerDps)};`,
      `                    ${v}_p_gz = (float)dp_be16(&_b[12]) / ${formatFloat(gr.lsbPerDps)};`,
      `                }`,
      `            }`,
      `        }`
    ].join('\n')
  },

  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    let out = `    // --- IMU ${v}: slew the polled axes to audio rate ---\n`
    for (const a of IMU_AXES) {
      out += slewLine(v, a, ctx.outputVar(ctx.node.id, a), ctx.node)
    }
    return out
  }
}

export const compass_in: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lines = [SENSOR_RUNTIME_CPP, sensorBusDecl()]
    for (const a of ['x', 'y', 'z', 'heading']) lines.push(`volatile float ${v}_p_${a} = 0.f;`)
    for (const a of ['x', 'y', 'z', 'heading']) lines.push(`float ${v}_s_${a} = 0.f;`)
    lines.push(`uint32_t ${v}_next_ms = 0;`)
    return lines.join('\n')
  },

  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const { sda, scl, label } = sensorI2cPins(ctx)
    const hmc = enumParam(ctx.node, 'chip', 'qmc5883l') === 'hmc5883l'
    const body = hmc
      ? [
          `        b = 0x70; dp_sensor_i2c.WriteDataAtAddress(0x${HMC.ADDR.toString(16)}, 0x${HMC.CONFIG_A.toString(16)}, 1, &b, 1, 100);`,
          `        b = 0x20; dp_sensor_i2c.WriteDataAtAddress(0x${HMC.ADDR.toString(16)}, 0x${HMC.CONFIG_B.toString(16)}, 1, &b, 1, 100);`,
          `        b = 0x00; dp_sensor_i2c.WriteDataAtAddress(0x${HMC.ADDR.toString(16)}, 0x${HMC.MODE.toString(16)}, 1, &b, 1, 100);`
        ]
      : [
          // SET/RESET period 0x01 is mandatory per the datasheet and the
          // usual reason a QMC5883L returns nothing but zeroes.
          `        b = 0x01; dp_sensor_i2c.WriteDataAtAddress(0x${QMC.ADDR.toString(16)}, 0x${QMC.SET_RESET.toString(16)}, 1, &b, 1, 100);`,
          `        b = 0x${QMC.CONTROL_1_VALUE.toString(16)}; dp_sensor_i2c.WriteDataAtAddress(0x${QMC.ADDR.toString(16)}, 0x${QMC.CONTROL_1.toString(16)}, 1, &b, 1, 100);`
        ]
    return [
      sensorBusInit(sda, scl, label),
      `    // --- Compass ${v}: ${hmc ? 'HMC5883L' : 'QMC5883L'} continuous mode ---`,
      `    {`,
      `        uint8_t b;`,
      ...body,
      `    }`
    ].join('\n')
  },

  loop: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const hmc = enumParam(ctx.node, 'chip', 'qmc5883l') === 'hmc5883l'
    const addr = hmc ? HMC.ADDR : QMC.ADDR
    const reg = hmc ? HMC.DATA : QMC.DATA
    const periodMs = Math.max(1, Math.round(1000 / SENSOR_POLL_HZ))
    /*
     * The two chips differ in byte order AND axis order: the HMC5883L
     * streams X, Z, Y big-endian, the QMC5883L X, Y, Z little-endian.
     * Reading one as the other gives plausible-looking noise, which is why
     * the chip is a param rather than something to autodetect.
     */
    const decode = hmc
      ? [
          `                    float _x = (float)dp_be16(&_b[0]);`,
          `                    float _z = (float)dp_be16(&_b[2]);`,
          `                    float _y = (float)dp_be16(&_b[4]);`
        ]
      : [
          `                    float _x = (float)dp_le16(&_b[0]);`,
          `                    float _y = (float)dp_le16(&_b[2]);`,
          `                    float _z = (float)dp_le16(&_b[4]);`
        ]
    return [
      `        { // Compass ${v}: 6-byte burst at ${SENSOR_POLL_HZ} Hz`,
      `            uint32_t _now = System::GetNow();`,
      `            if (_now - ${v}_next_ms >= ${periodMs}) {`,
      `                ${v}_next_ms = _now;`,
      `                uint8_t _b[6];`,
      `                if (dp_sensor_i2c.ReadDataAtAddress(0x${addr.toString(16)}, 0x${reg.toString(16).padStart(2, '0')}, 1, _b, 6, 10)`,
      `                    == I2CHandle::Result::OK) {`,
      ...decode,
      `                    float _mag = sqrtf(_x * _x + _y * _y + _z * _z);`,
      `                    if (_mag < 1.f) _mag = 1.f;`,
      `                    ${v}_p_x = _x / _mag;`,
      `                    ${v}_p_y = _y / _mag;`,
      `                    ${v}_p_z = _z / _mag;`,
      // atan2 gives -pi..pi; the output contract is 0..1 turns.
      `                    float _h = atan2f(_y, _x) / 6.28318530718f;`,
      `                    if (_h < 0.f) _h += 1.f;`,
      `                    ${v}_p_heading = _h;`,
      `                }`,
      `            }`,
      `        }`
    ].join('\n')
  },

  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    let out = `    // --- Compass ${v} ---\n`
    for (const a of ['x', 'y', 'z', 'heading']) {
      out += slewLine(v, a, ctx.outputVar(ctx.node.id, a), ctx.node)
    }
    return out
  }
}

/**
 * VL53L0X on the Daisy: declared unsupported, and this says why.
 *
 * The part's initialisation is a long vendor tuning sequence rather than a
 * handful of register writes — every open implementation is a transcription
 * of ST's, and ST's is not something to retype from memory. The ESP32 build
 * pulls in the Pololu library through `lib_deps`; libDaisy has no equivalent
 * and no package manager to fetch one.
 *
 * The honest failure is a node that says so, holds its param value, and
 * shows red in the palette — not one that compiles and reads nothing.
 */
export const distance_in: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    ctx.warn(
      `distance_in ${ctx.node.id}: the VL53L0X driver is ESP32-only (its init sequence ` +
        `needs the vendor library, which has no libDaisy port) — this node holds its ` +
        `sidebar value on the Seed`
    )
    const lo = rawNum(ctx.node, 'min_mm', 50)
    const hi = Math.max(lo + 1, rawNum(ctx.node, 'max_mm', 800))
    const d = numParam(ctx.node, 'dist', 0.5)
    return (
      `    // distance_in: unsupported on Daisy — holding the sidebar value\n` +
      `    float ${ctx.outputVar(ctx.node.id, 'dist')} = ${d};\n` +
      `    float ${ctx.outputVar(ctx.node.id, 'mm')} = ` +
      `${formatFloat(lo)} + ${d} * ${formatFloat(hi - lo)};\n`
    )
  }
}

export const i2s_in: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    const bid = bindingIdOf(ctx.node)
    if (!bid || !ctx.hardware || !resolveBinding(ctx.node.id, bid, 'sd_in', ctx.hardware)) {
      if (bid) ctx.warn(`i2s_in ${ctx.node.id}: binding ${bid} not resolvable; emitting silence`)
      else ctx.warn(`i2s_in ${ctx.node.id}: unbound — bind an i2s_codec in the hardware view`)
      return `    // TODO: bind i2s_in in hardware view\n    float ${l} = 0.f;\n    float ${r} = 0.f;\n`
    }
    // Secondary SAI callback updates globals `i2s_in_l` / `i2s_in_r`.
    return `    float ${l} = i2s_in_l;\n    float ${r} = i2s_in_r;\n`
  }
}

export const i2s_out: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const lExpr = ctx.inputExpr(ctx.node.id, 'left', '0.f')
    const rExpr = ctx.inputExpr(ctx.node.id, 'right', '0.f')
    const bid = bindingIdOf(ctx.node)
    if (!bid || !ctx.hardware || !resolveBinding(ctx.node.id, bid, 'sd_out', ctx.hardware)) {
      if (bid) ctx.warn(`i2s_out ${ctx.node.id}: binding ${bid} not resolvable; emitting stub`)
      else ctx.warn(`i2s_out ${ctx.node.id}: unbound — bind an i2s_codec in the hardware view`)
      return `    // TODO: bind i2s_out in hardware view\n    (void)(${lExpr}); (void)(${rExpr});\n`
    }
    return `    i2s_out_l = ${lExpr};\n    i2s_out_r = ${rExpr};\n`
  }
}

// --- MIDI ---------------------------------------------------------------

/** Channel string ('1'..'16'|'all') -> zero-based channel or -1 for all. */
function midiChannelNum(node: NodeInstance): number {
  const raw = enumParam(node, 'channel', '1')
  if (raw === 'all') return -1
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > 16) return 0
  return n - 1
}

// Shared prelude for any MIDI node — declares the USB MIDI handler and the
// latched note/CC state used by _in_note and _in_cc. Any of the three MIDI
// kinds may emit this; the #ifndef guard ensures one definition only.
const MIDI_SHARED_DECL =
  '#ifndef DP_MIDI_SHARED_DECL\n' +
  '#define DP_MIDI_SHARED_DECL 1\n' +
  'MidiUsbHandler midi;\n' +
  '// MIDI note-in latched state (channel-filtered in main loop).\n' +
  'volatile int midi_latched_note = -1;\n' +
  'volatile float midi_latched_vel = 0.f;\n' +
  'volatile float midi_latched_gate = 0.f;\n' +
  '// MIDI CC table — written by the USB MIDI dispatcher.\n' +
  'float midi_cc_table[128] = {0};\n' +
  'bool midi_cc_received = false;\n' +
  '#endif'

// MidiHandler<>::Init() requires a Config argument. Build a default one
// and call StartReceive() to begin accepting USB packets. Guarded so that
// patches with multiple MIDI nodes don't double-init.
const MIDI_SHARED_INIT =
  '    {\n' +
  '        static bool midi_inited = false;\n' +
  '        if (!midi_inited) {\n' +
  '            MidiUsbHandler::Config midi_cfg;\n' +
  '            midi.Init(midi_cfg);\n' +
  '            midi.StartReceive();\n' +
  '            midi_inited = true;\n' +
  '        }\n' +
  '    }'

export const midi_in_note: NodeEmitter = {
  declare: () => MIDI_SHARED_DECL,
  init: () => MIDI_SHARED_INIT,
  process: (ctx) => {
    const pitchOut = ctx.outputVar(ctx.node.id, 'pitch')
    const gateOut = ctx.outputVar(ctx.node.id, 'gate')
    const velOut = ctx.outputVar(ctx.node.id, 'velocity')
    // Channel filtering happens in the (not-yet-generated) main() MIDI
    // event dispatcher; the audio callback just reads the latched values.
    void midiChannelNum(ctx.node)
    return (
      `    float ${pitchOut} = midi_latched_note >= 0 ? ((float)midi_latched_note - 60.f) / 12.f : 0.f;\n` +
      `    float ${gateOut} = midi_latched_gate;\n` +
      `    float ${velOut} = midi_latched_vel;\n`
    )
  }
}

export const midi_in_cc: NodeEmitter = {
  declare: () => MIDI_SHARED_DECL,
  init: () => MIDI_SHARED_INIT,
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const ccIdx = Math.max(0, Math.min(127, rawNum(ctx.node, 'cc', 1) | 0))
    const testValue = numParam(ctx.node, 'test_value', 0)
    return (
      `    float ${out} = midi_cc_received ? midi_cc_table[${ccIdx}] : ${testValue};\n`
    )
  }
}

export const midi_out_note: NodeEmitter = {
  declare: (ctx) =>
    MIDI_SHARED_DECL + '\n' +
    `static uint32_t ${ctx.varName(ctx.node.id)}_last_gate = 0;\n` +
    `static int ${ctx.varName(ctx.node.id)}_active_note = -1;`,
  init: () => MIDI_SHARED_INIT,
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const ch = midiChannelNum(ctx.node)
    const chByte = ch < 0 ? 0 : ch
    const pitchExpr = ctx.inputExpr(ctx.node.id, 'pitch', '0.f')
    const gateExpr = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const velExpr = ctx.inputExpr(ctx.node.id, 'velocity', '1.f')
    return (
      `    {\n` +
      `        uint32_t now = ((${gateExpr}) > 0.5f) ? 1 : 0;\n` +
      `        if (now && !${v}_last_gate) {\n` +
      `            int note = 60 + (int)lroundf((${pitchExpr}) * 12.f);\n` +
      `            if (note < 0) note = 0; if (note > 127) note = 127;\n` +
      `            float vel = ${velExpr}; if (vel < 0.f) vel = 0.f; if (vel > 1.f) vel = 1.f;\n` +
      `            uint8_t msg[3] = { (uint8_t)(0x90 | ${chByte}), (uint8_t)note, (uint8_t)(vel * 127.f) };\n` +
      `            midi.SendMessage(msg, 3);\n` +
      `            ${v}_active_note = note;\n` +
      `        } else if (!now && ${v}_last_gate) {\n` +
      `            if (${v}_active_note >= 0) {\n` +
      `                uint8_t msg[3] = { (uint8_t)(0x80 | ${chByte}), (uint8_t)${v}_active_note, 0 };\n` +
      `                midi.SendMessage(msg, 3);\n` +
      `                ${v}_active_note = -1;\n` +
      `            }\n` +
      `        }\n` +
      `        ${v}_last_gate = now;\n` +
      `    }\n`
    )
  }
}
