/// <reference path="./worklet.d.ts" />

/**
 * Magnetometer → three axes plus heading.
 *
 * The emulator drives `heading` from its param and derives X and Y from it,
 * rather than exposing three independent axis sliders. A real compass's
 * axes are not independent — they are one field vector — and three sliders
 * would let you dial in a magnetic field that cannot exist, then wonder why
 * the hardware behaves differently. Z is left flat, which is what a
 * level board reads.
 *
 * Registered as `'dp-compass-in'`.
 */

class CompassInProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'heading', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'smooth', defaultValue: 30, minValue: 0, maxValue: 200, automationRate: 'k-rate' }
    ]
  }

  private sx = 1
  private sy = 0
  private sz = 0
  private sh = 0

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const heading = parameters.heading?.[0] ?? 0
    const smoothMs = parameters.smooth?.[0] ?? 30
    const coeff = smoothMs <= 0 ? 1 : 1 - Math.exp(-1 / Math.max(1, (smoothMs * 0.001 * sampleRate)))

    const angle = heading * Math.PI * 2
    const tx = Math.cos(angle)
    const ty = Math.sin(angle)

    const outX = outputs[0]?.[0]
    const outY = outputs[1]?.[0]
    const outZ = outputs[2]?.[0]
    const outH = outputs[3]?.[0]
    const n = outX?.length ?? outY?.length ?? outZ?.length ?? outH?.length ?? 0

    for (let i = 0; i < n; i++) {
      this.sx += (tx - this.sx) * coeff
      this.sy += (ty - this.sy) * coeff
      this.sz += (0 - this.sz) * coeff
      this.sh += (heading - this.sh) * coeff
      if (outX) outX[i] = this.sx
      if (outY) outY[i] = this.sy
      if (outZ) outZ[i] = this.sz
      if (outH) outH[i] = this.sh
    }
    return true
  }
}

registerProcessor('dp-compass-in', CompassInProcessor)
