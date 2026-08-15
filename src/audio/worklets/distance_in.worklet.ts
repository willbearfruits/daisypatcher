/// <reference path="./worklet.d.ts" />

/**
 * Time-of-flight ranger → normalised distance + raw millimetres.
 *
 * `dist` is the param in the emulator; `mm` is derived from it through the
 * same near/far mapping the firmware inverts, so a patch that reads `mm`
 * sees plausible numbers here instead of a constant.
 *
 * Registered as `'dp-distance-in'`.
 */

class DistanceInProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'dist', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'min_mm', defaultValue: 50, minValue: 0, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'max_mm', defaultValue: 800, minValue: 20, maxValue: 4000, automationRate: 'k-rate' },
      { name: 'smooth', defaultValue: 40, minValue: 0, maxValue: 200, automationRate: 'k-rate' }
    ]
  }

  private s = 0.5

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const target = parameters.dist?.[0] ?? 0.5
    const lo = parameters.min_mm?.[0] ?? 50
    const hi = parameters.max_mm?.[0] ?? 800
    const smoothMs = parameters.smooth?.[0] ?? 40
    const coeff = smoothMs <= 0 ? 1 : 1 - Math.exp(-1 / Math.max(1, (smoothMs * 0.001 * sampleRate)))
    // A far value at or below near would divide by zero on the firmware
    // side too; both clamp to a 1 mm span rather than emitting NaN.
    const span = Math.max(1, hi - lo)

    const outD = outputs[0]?.[0]
    const outMm = outputs[1]?.[0]
    const n = outD?.length ?? outMm?.length ?? 0

    for (let i = 0; i < n; i++) {
      this.s += (target - this.s) * coeff
      if (outD) outD[i] = this.s
      if (outMm) outMm[i] = lo + this.s * span
    }
    return true
  }
}

registerProcessor('dp-distance-in', DistanceInProcessor)
