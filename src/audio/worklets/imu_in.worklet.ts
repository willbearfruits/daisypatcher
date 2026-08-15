/// <reference path="./worklet.d.ts" />

/**
 * IMU → six CV outputs.
 *
 * There is no accelerometer behind a browser tab, so the six axis params
 * ARE the sensor here — the same substitution `knob_in` makes, where a
 * slider stands in for a physical pot. That is what lets a tilt-controlled
 * patch be built and heard before the hardware exists.
 *
 * The one-pole slew is not cosmetic: on the device the axes update at
 * ~100 Hz and hold between reads, so an unsmoothed output is a staircase,
 * and a staircase modulating a filter cutoff is audible as zipper noise.
 * Smoothing here means the emulator and the firmware share a response
 * curve rather than the emulator sounding better than the device.
 *
 * Registered as `'dp-imu-in'`.
 */

const IMU_AXES = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'] as const

class ImuInProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      ...IMU_AXES.map((name) => ({
        name,
        // az is gravity on a board lying flat; the others rest at zero.
        defaultValue: name === 'az' ? 1 : 0,
        minValue: -1,
        maxValue: 1,
        automationRate: 'k-rate' as const
      })),
      { name: 'smooth', defaultValue: 20, minValue: 0, maxValue: 200, automationRate: 'k-rate' as const }
    ]
  }

  private state = new Float32Array(IMU_AXES.length)

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.state[2] = 1
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const smoothMs = parameters.smooth?.[0] ?? 20
    // Coefficient for a per-sample one-pole reaching ~63% in `smoothMs`.
    const coeff = smoothMs <= 0 ? 1 : 1 - Math.exp(-1 / Math.max(1, (smoothMs * 0.001 * sampleRate)))

    for (let a = 0; a < IMU_AXES.length; a++) {
      const out = outputs[a]?.[0]
      if (!out) continue
      const target = parameters[IMU_AXES[a]]?.[0] ?? 0
      let v = this.state[a]
      for (let i = 0; i < out.length; i++) {
        v += (target - v) * coeff
        out[i] = v
      }
      this.state[a] = v
    }
    return true
  }
}

registerProcessor('dp-imu-in', ImuInProcessor)
