/// <reference path="./worklet.d.ts" />

/**
 * Envelope follower — one-pole asymmetric smoother over |in|.
 * Uses separate attack/release time constants. Output clamped to [0,1].
 * Registered as `'dp-envelope-follower'`.
 */

class EnvelopeFollowerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'attack', defaultValue: 0.01, minValue: 0.001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' }
    ]
  }

  private env = 0

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined

    const aT = Math.max(0.001, parameters.attack[0] ?? 0.01)
    const rT = Math.max(0.001, parameters.release[0] ?? 0.1)
    const aCoeff = Math.exp(-1 / (aT * sampleRate))
    const rCoeff = Math.exp(-1 / (rT * sampleRate))

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? Math.abs(inCh[i]) : 0
      const coeff = x > this.env ? aCoeff : rCoeff
      this.env = x + (this.env - x) * coeff
      let v = this.env
      if (v < 0) v = 0
      else if (v > 1) v = 1
      outCh[i] = v
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-envelope-follower', EnvelopeFollowerProcessor)
