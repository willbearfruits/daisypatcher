import type { NodeInstance } from '@/types/graph'
import type { EmitContext, NodeEmitter } from '../nodeEmitters'
import type { PlacedComponent } from '@/types/hardware'
import { MENU_RUNTIME_CPP, buildMenuModel, emitMenuInit, emitMenuProcess, emitMenuTables, menuDetentFor, menuParamOverrides } from '../menuCodegen'
import { HMC, MPU, QMC, SENSOR_POLL_HZ, SENSOR_RUNTIME_CPP, accelRange, gyroRange, slewCoeff } from '../sensorCodegen'
import { enumParam, formatFloat, numParam, rawNum } from './shared'


/* --------------------------- hardware I/O --------------------------- */

export const audio_in: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const l = ctx.outputVar(ctx.node.id, 'left')
    const r = ctx.outputVar(ctx.node.id, 'right')
    return `    float ${l} = in_l;\n    float ${r} = in_r;\n`
  }
}

export const audio_output: NodeEmitter = { declare: () => '', init: () => '', process: () => '' }

export const knob_in: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const lo = typeof ctx.node.params.min === 'number' ? ctx.node.params.min : 0
    const hi = typeof ctx.node.params.max === 'number' ? ctx.node.params.max : 1
    const expr =
      lo === 0 && hi === 1
        ? `${v}_val`
        : `${lo.toFixed(4)}f + (${v}_val) * ${(hi - lo).toFixed(4)}f`
    return `    float ${out} = ${expr};\n`
  }
}

export const gate_in: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    return `    float ${out} = ${v}_val;\n`
  }
}

export const button: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    return `    float ${out} = ${v}_val;\n`
  }
}

export const led: NodeEmitter = {
  declare: () => '',
  init: () => '',
  process: (ctx) => {
    const input = ctx.inputExpr(ctx.node.id, 'in', '0.f')
    const v = ctx.varName(ctx.node.id)
    return `    ${v}_val = (${input});\n`
  }
}

export const switch_3way: NodeEmitter = {
  declare: (ctx) => `float ${ctx.varName(ctx.node.id)}_val = 0.f;`,
  init: () => '',
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    return `    float ${out} = ${v}_val;\n`
  }
}

/*
 * Encoder -> integrated CV + delta + switch gate (ESP32).
 *
 * No libDaisy Encoder class here, so this emits a small quadrature decoder
 * inline. The 16-entry table is the standard Gray-code transition matrix
 * indexed by (prev << 2 | curr): valid transitions give -1/+1, invalid
 * ones (a contact bounce, or a missed sample) give 0 rather than a bogus
 * count. Sampled once per audio block from loop(), far faster than a human
 * can turn a detented encoder.
 */
const ENCODER_SHARED_HEADER =
  `#ifndef DP_ENCODER_DECLARED\n` +
  `#define DP_ENCODER_DECLARED\n` +
  `static const int8_t dp_enc_table[16] = {\n` +
  `     0, -1,  1,  0,\n` +
  `     1,  0,  0, -1,\n` +
  `    -1,  0,  0,  1,\n` +
  `     0,  1, -1,  0\n` +
  `};\n` +
  `static inline int8_t dp_enc_step(uint8_t &state, bool a, bool b) {\n` +
  `    state = (uint8_t)(((state << 2) | (a ? 2 : 0) | (b ? 1 : 0)) & 0x0F);\n` +
  `    return dp_enc_table[state];\n` +
  `}\n` +
  `#endif`

/** The `encoder` component this node is bound to, if any. */
function encoderComponent(ctx: EmitContext): PlacedComponent | null {
  const bid = ctx.node.params.bindingId
  if (typeof bid !== 'string' || bid === '') return null
  const c = ctx.hardware?.components.find((x: PlacedComponent) => x.id === bid)
  return c && c.kind === 'encoder' ? c : null
}

/** `"GPIO12"` -> `12`; null when the pin isn't an ESP32 pin. */
function esp32Gpio(pin: string | undefined): number | null {
  if (typeof pin !== 'string' || !pin.startsWith('GPIO')) return null
  const n = Number(pin.slice(4))
  return Number.isFinite(n) ? n : null
}

export const encoder_in: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      ENCODER_SHARED_HEADER + `\n` +
      // Only position + decoder state persist; delta/sw are per-block and
      // would collide with the output-socket variable names.
      `float ${v}_pos = ${numParam(ctx.node, 'value', 0.5)};\n` +
      `uint8_t ${v}_encstate = 0;`
    )
  },
  init: (ctx) => {
    const comp = encoderComponent(ctx)
    if (!comp) return ''
    const lines: string[] = []
    for (const role of ['a', 'b', 'sw']) {
      const g = esp32Gpio(comp.pins[role] as string | undefined)
      if (g !== null) lines.push(`    pinMode(${g}, INPUT_PULLUP); // ${comp.label} ${role}`)
    }
    return lines.join('\n')
  },
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const out = ctx.outputVar(ctx.node.id, 'out')
    const outDelta = ctx.outputVar(ctx.node.id, 'delta')
    const outSw = ctx.outputVar(ctx.node.id, 'sw')
    const step = rawNum(ctx.node, 'step', 0.02)
    const lo = rawNum(ctx.node, 'min', 0)
    const hi = rawNum(ctx.node, 'max', 1)
    const span = hi - lo
    const wrap = enumParam(ctx.node, 'wrap', 'clamp') === 'wrap'

    const comp = encoderComponent(ctx)
    const pa = comp ? esp32Gpio(comp.pins['a'] as string | undefined) : null
    const pb = comp ? esp32Gpio(comp.pins['b'] as string | undefined) : null
    if (pa === null || pb === null) {
      ctx.warn(`encoder_in ${ctx.node.id}: unbound or missing A/B pins — emitting held value`)
      return (
        `    float ${out} = ${formatFloat(lo)} + ${v}_pos * ${formatFloat(span)};\n` +
        `    float ${outDelta} = 0.f;\n` +
        `    float ${outSw} = 0.f;\n`
      )
    }
    const psw = comp ? esp32Gpio(comp.pins['sw'] as string | undefined) : null
    const bound = wrap
      ? `        if (${v}_pos < 0.f) ${v}_pos += 1.f;\n` +
        `        if (${v}_pos > 1.f) ${v}_pos -= 1.f;\n`
      : `        if (${v}_pos < 0.f) ${v}_pos = 0.f;\n` +
        `        if (${v}_pos > 1.f) ${v}_pos = 1.f;\n`
    return (
      `    float ${out};\n` +
      `    float ${outDelta};\n` +
      `    float ${outSw};\n` +
      `    {\n` +
      `        int8_t inc = dp_enc_step(${v}_encstate, digitalRead(${pa}), digitalRead(${pb}));\n` +
      `        float d = (float)inc * ${formatFloat(step)};\n` +
      `        ${v}_pos += d;\n` +
      bound +
      `        ${out} = ${formatFloat(lo)} + ${v}_pos * ${formatFloat(span)};\n` +
      `        ${outDelta} = d * ${formatFloat(span)};\n` +
      // Switch is wired to GND with INPUT_PULLUP, so pressed reads LOW.
      `        ${outSw} = ${psw !== null ? `(digitalRead(${psw}) ? 0.f : 1.f)` : '0.f'};\n` +
      `    }\n`
    )
  }
}

/* --------------------------- menu --------------------------- */
//
// Identical to the Daisy emitter apart from the millisecond clock, because
// the behaviour it wires up lives in `menuCodegen.ts` — one C++ state
// machine shared by both targets, transliterated from the same
// `editor/menu/machine.ts` the emulator runs.

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
    const overrides: { varName: string; entryIndex: number }[] = []
    for (const o of menuParamOverrides(ctx.graph, () => {}).values()) {
      if (o.menuVar !== v) continue
      if (o.entryIndex >= model.entries.length) continue
      overrides.push({ varName: o.varName, entryIndex: o.entryIndex })
    }
    return emitMenuProcess({
      v,
      deltaExpr: ctx.inputExpr(ctx.node.id, 'delta', '0.f'),
      swExpr: ctx.inputExpr(ctx.node.id, 'click', '0.f'),
      nowExpr: 'millis()',
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

/* --------------------------- I2C sensors --------------------------- */
//
// Same design as the Daisy emitters, and the same register maps out of
// `sensorCodegen.ts` — only the transport differs (Wire instead of
// I2CHandle). Reads run from the `loop` hook, which on this target lands at
// the top of Arduino's loop() before render_block(), so a ~400 us blocking
// transfer never eats into the 1 ms audio block.
//
// `Wire.begin()` comes from the target's hardware-init block whenever an
// I2C component is placed; the sensors reuse that bus rather than starting
// a second one, which is why SHARED_BUS_ROLES lets them share sda/scl.

/** Bus pins for a sensor's binding, falling back to the board profile. */
function sensorI2cPins(ctx: EmitContext): { sda: number; scl: number; label: string } | null {
  const bid = ctx.node.params.bindingId
  const comp =
    typeof bid === 'string' && ctx.hardware
      ? ctx.hardware.components.find((c) => c.id === bid)
      : undefined
  const sda = esp32Gpio(comp?.pins['sda'] as string | undefined)
  const scl = esp32Gpio(comp?.pins['scl'] as string | undefined)
  if (sda === null || scl === null) return null
  return { sda, scl, label: comp?.label ?? 'sensor' }
}

/**
 * Shared bus setup.
 *
 * Guarded so N sensors emit it once. When the sensor is unbound we do NOT
 * guess pins: an I2C device on the wrong two GPIOs is a device that never
 * answers, and a silent never-answering sensor is precisely the failure
 * this whole exercise is about.
 */
function esp32SensorBusInit(ctx: EmitContext, kind: string): string {
  const pins = sensorI2cPins(ctx)
  if (!pins) {
    ctx.warn(
      `${kind} ${ctx.node.id}: not bound to a pinned sensor — no I2C bus configured, ` +
        `so it will read nothing. Place the component in the hardware view and assign SDA/SCL.`
    )
    return ''
  }
  return [
    `    // --- I2C sensor bus: ${pins.label} ---`,
    `    #ifndef DP_SENSOR_BUS_INIT`,
    `    #define DP_SENSOR_BUS_INIT 1`,
    `    Wire.begin(${pins.sda}, ${pins.scl});`,
    `    Wire.setClock(400000);`,
    `    #endif`
  ].join('\n')
}

const SENSOR_WIRE_CPP =
  `#ifndef DP_SENSOR_WIRE\n` +
  `#define DP_SENSOR_WIRE 1\n` +
  `#include <Wire.h>\n` +
  `/** Register burst read. Returns false if the device did not answer. */\n` +
  `static bool dp_i2c_read(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t n) {\n` +
  `    Wire.beginTransmission(addr);\n` +
  `    Wire.write(reg);\n` +
  `    if (Wire.endTransmission(false) != 0) return false;\n` +
  `    if (Wire.requestFrom((int)addr, (int)n) != n) return false;\n` +
  `    for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();\n` +
  `    return true;\n` +
  `}\n` +
  `static void dp_i2c_write(uint8_t addr, uint8_t reg, uint8_t val) {\n` +
  `    Wire.beginTransmission(addr);\n` +
  `    Wire.write(reg);\n` +
  `    Wire.write(val);\n` +
  `    Wire.endTransmission();\n` +
  `}\n` +
  `#endif\n`

/** Per-sample slew from the polled value toward the audio-rate output. */
function esp32SlewLine(v: string, axis: string, out: string, node: NodeInstance): string {
  const ms = Math.max(0, rawNum(node, 'smooth', 20))
  const coeff = ms <= 0 ? 1 : slewCoeff(48000, ms)
  return (
    `    ${v}_s_${axis} = dp_slew(${v}_s_${axis}, ${v}_p_${axis}, ${formatFloat(coeff)});\n` +
    `    float ${out} = ${v}_s_${axis};\n`
  )
}

const ESP32_IMU_AXES = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'] as const

export const imu_in: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lines = [SENSOR_RUNTIME_CPP, SENSOR_WIRE_CPP]
    for (const a of ESP32_IMU_AXES) lines.push(`volatile float ${v}_p_${a} = 0.f;`)
    for (const a of ESP32_IMU_AXES) lines.push(`float ${v}_s_${a} = 0.f;`)
    lines.push(`uint32_t ${v}_next_ms = 0;`)
    return lines.join('\n')
  },

  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const bus = esp32SensorBusInit(ctx, 'imu_in')
    if (!bus) return ''
    const ar = accelRange(ctx.node.params.accel_range)
    const gr = gyroRange(ctx.node.params.gyro_range)
    return [
      bus,
      `    // --- IMU ${v}: wake the MPU-6050 and set full-scale ranges ---`,
      // PWR_MGMT_1 = 0 clears SLEEP; the part boots asleep and every
      // register otherwise reads back its reset value forever.
      `    dp_i2c_write(0x${MPU.ADDR.toString(16)}, 0x${MPU.PWR_MGMT_1.toString(16)}, 0x00);`,
      `    dp_i2c_write(0x${MPU.ADDR.toString(16)}, 0x${MPU.ACCEL_CONFIG.toString(16)}, 0x${ar.cfg.toString(16).padStart(2, '0')});`,
      `    dp_i2c_write(0x${MPU.ADDR.toString(16)}, 0x${MPU.GYRO_CONFIG.toString(16)}, 0x${gr.cfg.toString(16).padStart(2, '0')});`,
      `    ${v}_s_az = 1.f;`
    ].join('\n')
  },

  loop: (ctx) => {
    if (!sensorI2cPins(ctx)) return ''
    const v = ctx.varName(ctx.node.id)
    const ar = accelRange(ctx.node.params.accel_range)
    const gr = gyroRange(ctx.node.params.gyro_range)
    const periodMs = Math.max(1, Math.round(1000 / SENSOR_POLL_HZ))
    return [
      `    { // IMU ${v}: one ${MPU.BURST}-byte burst at ${SENSOR_POLL_HZ} Hz`,
      `        uint32_t _now = millis();`,
      `        if (_now - ${v}_next_ms >= ${periodMs}) {`,
      `            ${v}_next_ms = _now;`,
      `            uint8_t _b[${MPU.BURST}];`,
      `            if (dp_i2c_read(0x${MPU.ADDR.toString(16)}, 0x${MPU.ACCEL_XOUT_H.toString(16)}, _b, ${MPU.BURST})) {`,
      // Bytes 6..7 are temperature; the gyro block starts at offset 8.
      `                ${v}_p_ax = (float)dp_be16(&_b[0])  / ${formatFloat(ar.lsbPerG)};`,
      `                ${v}_p_ay = (float)dp_be16(&_b[2])  / ${formatFloat(ar.lsbPerG)};`,
      `                ${v}_p_az = (float)dp_be16(&_b[4])  / ${formatFloat(ar.lsbPerG)};`,
      `                ${v}_p_gx = (float)dp_be16(&_b[8])  / ${formatFloat(gr.lsbPerDps)};`,
      `                ${v}_p_gy = (float)dp_be16(&_b[10]) / ${formatFloat(gr.lsbPerDps)};`,
      `                ${v}_p_gz = (float)dp_be16(&_b[12]) / ${formatFloat(gr.lsbPerDps)};`,
      `            }`,
      `        }`,
      `    }`
    ].join('\n')
  },

  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    let out = `    // --- IMU ${v}: slew the polled axes to audio rate ---\n`
    for (const a of ESP32_IMU_AXES) {
      out += esp32SlewLine(v, a, ctx.outputVar(ctx.node.id, a), ctx.node)
    }
    return out
  }
}

const COMPASS_AXES = ['x', 'y', 'z', 'heading'] as const

export const compass_in: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const lines = [SENSOR_RUNTIME_CPP, SENSOR_WIRE_CPP]
    for (const a of COMPASS_AXES) lines.push(`volatile float ${v}_p_${a} = 0.f;`)
    for (const a of COMPASS_AXES) lines.push(`float ${v}_s_${a} = 0.f;`)
    lines.push(`uint32_t ${v}_next_ms = 0;`)
    return lines.join('\n')
  },

  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const bus = esp32SensorBusInit(ctx, 'compass_in')
    if (!bus) return ''
    const hmc = enumParam(ctx.node, 'chip', 'qmc5883l') === 'hmc5883l'
    const body = hmc
      ? [
          `    dp_i2c_write(0x${HMC.ADDR.toString(16)}, 0x${HMC.CONFIG_A.toString(16)}, 0x70);`,
          `    dp_i2c_write(0x${HMC.ADDR.toString(16)}, 0x${HMC.CONFIG_B.toString(16)}, 0x20);`,
          `    dp_i2c_write(0x${HMC.ADDR.toString(16)}, 0x${HMC.MODE.toString(16)}, 0x00);`
        ]
      : [
          // SET/RESET period 0x01 is mandatory per the datasheet, and the
          // usual reason a QMC5883L returns nothing but zeroes.
          `    dp_i2c_write(0x${QMC.ADDR.toString(16)}, 0x${QMC.SET_RESET.toString(16)}, 0x01);`,
          `    dp_i2c_write(0x${QMC.ADDR.toString(16)}, 0x${QMC.CONTROL_1.toString(16)}, 0x${QMC.CONTROL_1_VALUE.toString(16)});`
        ]
    return [bus, `    // --- Compass ${v}: ${hmc ? 'HMC5883L' : 'QMC5883L'} continuous mode ---`, ...body].join('\n')
  },

  loop: (ctx) => {
    if (!sensorI2cPins(ctx)) return ''
    const v = ctx.varName(ctx.node.id)
    const hmc = enumParam(ctx.node, 'chip', 'qmc5883l') === 'hmc5883l'
    const addr = hmc ? HMC.ADDR : QMC.ADDR
    const reg = hmc ? HMC.DATA : QMC.DATA
    const periodMs = Math.max(1, Math.round(1000 / SENSOR_POLL_HZ))
    /*
     * The two chips differ in byte order AND axis order: the HMC5883L
     * streams X, Z, Y big-endian, the QMC5883L X, Y, Z little-endian.
     * Reading one as the other yields plausible-looking noise, which is why
     * the chip is a param rather than something to autodetect.
     */
    const decode = hmc
      ? [
          `                float _x = (float)dp_be16(&_b[0]);`,
          `                float _z = (float)dp_be16(&_b[2]);`,
          `                float _y = (float)dp_be16(&_b[4]);`
        ]
      : [
          `                float _x = (float)dp_le16(&_b[0]);`,
          `                float _y = (float)dp_le16(&_b[2]);`,
          `                float _z = (float)dp_le16(&_b[4]);`
        ]
    return [
      `    { // Compass ${v}: 6-byte burst at ${SENSOR_POLL_HZ} Hz`,
      `        uint32_t _now = millis();`,
      `        if (_now - ${v}_next_ms >= ${periodMs}) {`,
      `            ${v}_next_ms = _now;`,
      `            uint8_t _b[6];`,
      `            if (dp_i2c_read(0x${addr.toString(16)}, 0x${reg.toString(16).padStart(2, '0')}, _b, 6)) {`,
      ...decode,
      `                float _mag = sqrtf(_x * _x + _y * _y + _z * _z);`,
      `                if (_mag < 1.f) _mag = 1.f;`,
      `                ${v}_p_x = _x / _mag;`,
      `                ${v}_p_y = _y / _mag;`,
      `                ${v}_p_z = _z / _mag;`,
      // atan2 gives -pi..pi; the output contract is 0..1 turns.
      `                float _h = atan2f(_y, _x) / 6.28318530718f;`,
      `                if (_h < 0.f) _h += 1.f;`,
      `                ${v}_p_heading = _h;`,
      `            }`,
      `        }`,
      `    }`
    ].join('\n')
  },

  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    let out = `    // --- Compass ${v} ---\n`
    for (const a of COMPASS_AXES) {
      out += esp32SlewLine(v, a, ctx.outputVar(ctx.node.id, a), ctx.node)
    }
    return out
  }
}

/**
 * VL53L0X through the Pololu library.
 *
 * Deliberately not hand-rolled: the part's init is a long vendor tuning
 * sequence and every open implementation is a transcription of ST's. The
 * library is added to `platformio.ini` by the target when a `distance_in`
 * node is present — see `graphFeatures.hasTof`.
 *
 * Out-of-range reads (`timeoutOccurred`, or the 8190 mm sentinel) HOLD the
 * previous value rather than snapping to zero: a ranger pointed at open
 * space would otherwise slam whatever it modulates to one end every time a
 * hand leaves the beam.
 */
export const distance_in: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return [
      SENSOR_RUNTIME_CPP,
      SENSOR_WIRE_CPP,
      `#ifndef DP_VL53L0X_INCLUDED`,
      `#define DP_VL53L0X_INCLUDED 1`,
      `#include <VL53L0X.h>`,
      `#endif`,
      `VL53L0X ${v}_dev;`,
      `bool ${v}_ready = false;`,
      `volatile float ${v}_p_dist = 0.f;`,
      `volatile float ${v}_p_mm = 0.f;`,
      `float ${v}_s_dist = 0.f;`,
      `float ${v}_s_mm = 0.f;`,
      `uint32_t ${v}_next_ms = 0;`
    ].join('\n')
  },

  init: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const bus = esp32SensorBusInit(ctx, 'distance_in')
    if (!bus) return ''
    return [
      bus,
      `    // --- Distance ${v}: VL53L0X continuous ranging ---`,
      `    ${v}_dev.setTimeout(100);`,
      `    ${v}_ready = ${v}_dev.init();`,
      `    if (${v}_ready) ${v}_dev.startContinuous();`,
      `    ${v}_s_dist = ${numParam(ctx.node, 'dist', 0.5)};`
    ].join('\n')
  },

  loop: (ctx) => {
    if (!sensorI2cPins(ctx)) return ''
    const v = ctx.varName(ctx.node.id)
    const lo = rawNum(ctx.node, 'min_mm', 50)
    const hi = Math.max(lo + 1, rawNum(ctx.node, 'max_mm', 800))
    const periodMs = Math.max(1, Math.round(1000 / SENSOR_POLL_HZ))
    return [
      `    { // Distance ${v}: read at ${SENSOR_POLL_HZ} Hz, hold on timeout`,
      `        uint32_t _now = millis();`,
      `        if (${v}_ready && _now - ${v}_next_ms >= ${periodMs}) {`,
      `            ${v}_next_ms = _now;`,
      `            uint16_t _mm = ${v}_dev.readRangeContinuousMillimeters();`,
      `            if (!${v}_dev.timeoutOccurred() && _mm < 8000) {`,
      `                float _d = ((float)_mm - ${formatFloat(lo)}) / ${formatFloat(hi - lo)};`,
      `                if (_d < 0.f) _d = 0.f; else if (_d > 1.f) _d = 1.f;`,
      `                ${v}_p_dist = _d;`,
      `                ${v}_p_mm = (float)_mm;`,
      `            }`,
      `        }`,
      `    }`
    ].join('\n')
  },

  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return (
      `    // --- Distance ${v} ---\n` +
      esp32SlewLine(v, 'dist', ctx.outputVar(ctx.node.id, 'dist'), ctx.node) +
      esp32SlewLine(v, 'mm', ctx.outputVar(ctx.node.id, 'mm'), ctx.node)
    )
  }
}

/* --------------------------- MIDI --------------------------- */
//
// Uses the Arduino ESP32 USB MIDI class. One shared `USBMIDI` instance is
// declared by whichever MIDI node is emitted first in topo order; the
// follow-up declarations guard with `#ifndef DP_USBMIDI_DECLARED`. A small
// shared dispatcher polls the class in loop() and updates globals.
//
// To keep the emitter side effect-free, we simply emit the globals and the
// polling call inside `process()` once per node. The polling relies on the
// `midi_port` symbol, which the declare() output defines on first emit.

const MIDI_SHARED_HEADER =
  `#ifndef DP_USBMIDI_DECLARED\n` +
  `#define DP_USBMIDI_DECLARED 1\n` +
  `#include <USB.h>\n` +
  `#include <USBMIDI.h>\n` +
  `USBMIDI midi_port;\n` +
  `volatile int  midi_latched_note = -1;\n` +
  `volatile float midi_latched_vel = 0.f;\n` +
  `volatile float midi_latched_gate = 0.f;\n` +
  `static float midi_cc_table[128] = {0};\n` +
  `static bool  midi_cc_received = false;\n` +
  `static inline void dp_midi_poll() {\n` +
  `  midiEventPacket_t ev;\n` +
  `  while (midi_port.readPacket(&ev)) {\n` +
  `    uint8_t st = ev.byte1 & 0xf0;\n` +
  `    if (st == 0x90 && ev.byte3 > 0) {\n` +
  `      midi_latched_note = ev.byte2;\n` +
  `      midi_latched_vel  = (float)ev.byte3 / 127.f;\n` +
  `      midi_latched_gate = 1.f;\n` +
  `    } else if (st == 0x80 || (st == 0x90 && ev.byte3 == 0)) {\n` +
  `      midi_latched_gate = 0.f;\n` +
  `    } else if (st == 0xb0) {\n` +
  `      if (ev.byte2 < 128) {\n` +
  `        midi_cc_table[ev.byte2] = (float)ev.byte3 / 127.f;\n` +
  `        midi_cc_received = true;\n` +
  `      }\n` +
  `    }\n` +
  `  }\n` +
  `}\n` +
  `#endif\n`

export const midi_in_note: NodeEmitter = {
  declare: () => MIDI_SHARED_HEADER,
  init: () =>
    `    #ifndef DP_USBMIDI_INIT\n    #define DP_USBMIDI_INIT 1\n    USB.begin();\n    midi_port.begin();\n    #endif`,
  process: (ctx) => {
    const pitchOut = ctx.outputVar(ctx.node.id, 'pitch')
    const gateOut = ctx.outputVar(ctx.node.id, 'gate')
    const velOut = ctx.outputVar(ctx.node.id, 'velocity')
    return (
      `    dp_midi_poll();\n` +
      `    float ${pitchOut} = midi_latched_note >= 0 ? ((float)midi_latched_note - 60.f) / 12.f : 0.f;\n` +
      `    float ${gateOut} = midi_latched_gate;\n` +
      `    float ${velOut} = midi_latched_vel;\n`
    )
  }
}

export const midi_in_cc: NodeEmitter = {
  declare: () => MIDI_SHARED_HEADER,
  init: () =>
    `    #ifndef DP_USBMIDI_INIT\n    #define DP_USBMIDI_INIT 1\n    USB.begin();\n    midi_port.begin();\n    #endif`,
  process: (ctx) => {
    const out = ctx.outputVar(ctx.node.id, 'out')
    const ccIdx = Math.max(0, Math.min(127, Math.floor(rawNum(ctx.node, 'cc', 1))))
    const testValue = numParam(ctx.node, 'test_value', 0)
    return (
      `    dp_midi_poll();\n` +
      `    float ${out} = midi_cc_received ? midi_cc_table[${ccIdx}] : ${testValue};\n`
    )
  }
}

export const midi_out_note: NodeEmitter = {
  declare: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    return MIDI_SHARED_HEADER + `float ${v}_prev_gate = 0.f; int ${v}_last_note = -1;`
  },
  init: () =>
    `    #ifndef DP_USBMIDI_INIT\n    #define DP_USBMIDI_INIT 1\n    USB.begin();\n    midi_port.begin();\n    #endif`,
  process: (ctx) => {
    const v = ctx.varName(ctx.node.id)
    const pitch = ctx.inputExpr(ctx.node.id, 'pitch', '0.f')
    const gate = ctx.inputExpr(ctx.node.id, 'gate', '0.f')
    const vel = ctx.inputExpr(ctx.node.id, 'velocity', '1.f')
    const chanStr = enumParam(ctx.node, 'channel', '1')
    const chan = chanStr === 'all' ? 0 : Math.max(0, Math.min(15, parseInt(chanStr, 10) - 1))
    return (
      `    {\n` +
      `        float _g = (${gate});\n` +
      `        if (_g > 0.5f && ${v}_prev_gate <= 0.5f) {\n` +
      `            int _n = (int)(((${pitch}) * 12.f) + 60.f + 0.5f);\n` +
      `            if (_n < 0) _n = 0; else if (_n > 127) _n = 127;\n` +
      `            int _v = (int)(fminf(1.f, fmaxf(0.f, (${vel}))) * 127.f);\n` +
      `            midiEventPacket_t _pkt = { (uint8_t)0x09, (uint8_t)(0x90 | ${chan}), (uint8_t)_n, (uint8_t)_v };\n` +
      `            midi_port.writePacket(&_pkt);\n` +
      `            ${v}_last_note = _n;\n` +
      `        }\n` +
      `        if (_g <= 0.5f && ${v}_prev_gate > 0.5f && ${v}_last_note >= 0) {\n` +
      `            midiEventPacket_t _pkt = { (uint8_t)0x08, (uint8_t)(0x80 | ${chan}), (uint8_t)${v}_last_note, (uint8_t)0 };\n` +
      `            midi_port.writePacket(&_pkt);\n` +
      `            ${v}_last_note = -1;\n` +
      `        }\n` +
      `        ${v}_prev_gate = _g;\n` +
      `    }\n`
    )
  }
}
