/**
 * I²C sensor register maps, shared by both emitters.
 *
 * The three sensor components — gyroscope, magnetometer and time-of-flight —
 * could be placed, pinned, wired and saved for a long time while generating
 * no firmware at all and having no patch-side node. That is the worst
 * possible state for a feature: it looks finished. This module is the half
 * of the fix that both targets share; the per-target halves are the two
 * emitter tables, which differ only in how they say "read N bytes from
 * register R".
 *
 * Scope, honestly stated:
 *
 *   imu_in      — MPU-6050 family (also the register layout of the
 *                 MPU-6500/9250). Wake via PWR_MGMT_1, then a 14-byte burst
 *                 from ACCEL_XOUT_H gives accel, temperature and gyro in one
 *                 transaction. Small enough to write out in full, so there
 *                 is no library dependency on either target.
 *
 *   compass_in  — QMC5883L, the chip actually fitted to the blue "HMC5883L"
 *                 breakouts sold today. Continuous mode, 6-byte burst from
 *                 0x00. The genuine Honeywell HMC5883L is selectable because
 *                 the two are not register-compatible and guessing wrong
 *                 yields plausible-looking noise rather than an error.
 *
 *   distance_in — VL53L0X. NOT hand-rolled: its initialisation is a long
 *                 vendor tuning sequence, and every open implementation is a
 *                 transcription of ST's. On ESP32 the Pololu library is
 *                 pulled in through `lib_deps`; on the Daisy there is no
 *                 equivalent, so the kind is declared unsupported there
 *                 rather than silently emitting a sensor that never reads.
 */

/** MPU-6050 / MPU-6500 registers. */
export const MPU = {
  ADDR: 0x68,
  PWR_MGMT_1: 0x6b,
  WHO_AM_I: 0x75,
  ACCEL_XOUT_H: 0x3b,
  ACCEL_CONFIG: 0x1c,
  GYRO_CONFIG: 0x1b,
  /** Burst length covering accel(6) + temp(2) + gyro(6). */
  BURST: 14
} as const

/** QMC5883L registers (the chip on most "HMC5883L" modules). */
export const QMC = {
  ADDR: 0x0d,
  DATA: 0x00,
  STATUS: 0x06,
  CONTROL_1: 0x09,
  SET_RESET: 0x0b,
  /** Continuous, 200 Hz, ±8 G, 512 oversampling. */
  CONTROL_1_VALUE: 0x1d
} as const

/** Honeywell HMC5883L — different chip, different registers, same module. */
export const HMC = {
  ADDR: 0x1e,
  CONFIG_A: 0x00,
  CONFIG_B: 0x01,
  MODE: 0x02,
  DATA: 0x03
} as const

/** Full-scale ranges, as (config register value, LSB per unit). */
export const ACCEL_RANGES: Record<string, { cfg: number; lsbPerG: number }> = {
  '2': { cfg: 0x00, lsbPerG: 16384 },
  '4': { cfg: 0x08, lsbPerG: 8192 },
  '8': { cfg: 0x10, lsbPerG: 4096 },
  '16': { cfg: 0x18, lsbPerG: 2048 }
}

export const GYRO_RANGES: Record<string, { cfg: number; lsbPerDps: number }> = {
  '250': { cfg: 0x00, lsbPerDps: 131 },
  '500': { cfg: 0x08, lsbPerDps: 65.5 },
  '1000': { cfg: 0x10, lsbPerDps: 32.8 },
  '2000': { cfg: 0x18, lsbPerDps: 16.4 }
}

export function accelRange(v: unknown): { cfg: number; lsbPerG: number } {
  return ACCEL_RANGES[String(v)] ?? ACCEL_RANGES['2']
}

export function gyroRange(v: unknown): { cfg: number; lsbPerDps: number } {
  return GYRO_RANGES[String(v)] ?? GYRO_RANGES['250']
}

/**
 * How often to read a sensor, in Hz.
 *
 * A blocking 14-byte I²C burst at 400 kHz is roughly 400 µs, and the audio
 * block at 48 kHz / 48 samples is 1 ms. Reading every block would spend
 * nearly half the budget on a device whose data is meaningless above about
 * 100 Hz, so the poll is throttled and the last sample is held. Motion
 * sensors driving CV want smoothing anyway.
 */
export const SENSOR_POLL_HZ = 100

/**
 * Shared C++ helpers: a signed 16-bit assembler and a one-pole smoother.
 *
 * Guarded so any number of sensor nodes can emit it. Kept target-neutral —
 * neither function touches an I²C API.
 */
export const SENSOR_RUNTIME_CPP = `#ifndef DP_SENSOR_RUNTIME
#define DP_SENSOR_RUNTIME 1
#include <stdint.h>

/** Big-endian signed 16-bit, the layout every one of these sensors uses. */
static inline int16_t dp_be16(const uint8_t* p) {
    return (int16_t)(((uint16_t)p[0] << 8) | (uint16_t)p[1]);
}

/** Little-endian signed 16-bit — the QMC5883L is the odd one out. */
static inline int16_t dp_le16(const uint8_t* p) {
    return (int16_t)(((uint16_t)p[1] << 8) | (uint16_t)p[0]);
}

/**
 * One-pole smoother applied to every sensor axis.
 *
 * The poll runs at a fraction of the audio rate, so an unsmoothed output is
 * a staircase — and a staircase modulating a filter cutoff is audible as
 * zipper noise. This turns the held value into a ramp.
 */
static inline float dp_slew(float current, float target, float coeff) {
    return current + (target - current) * coeff;
}
#endif // DP_SENSOR_RUNTIME
`

/** Smoothing coefficient for a per-sample slew reaching ~63% in `ms`. */
export function slewCoeff(sampleRate: number, ms: number): number {
  const tau = Math.max(1, ms) * 0.001 * sampleRate
  return 1 - Math.exp(-1 / tau)
}
