/// <reference path="./worklet.d.ts" />

/**
 * Slew limiter / portamento — one-pole smoother with asymmetric time
 * constants for rising vs falling segments. `rise`/`fall` = 0 bypasses
 * smoothing for that direction. Registered as `'dp-slew'`.
 */

class SlewProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rise', defaultValue: 0.05, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'fall', defaultValue: 0.05, minValue: 0, maxValue: 2, automationRate: 'k-rate' }
    ]
  }

  private state = 0

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

    const rise = parameters.rise[0] ?? 0.05
    const fall = parameters.fall[0] ?? 0.05
    const riseCoeff = rise > 0 ? Math.exp(-1 / (rise * sampleRate)) : 0
    const fallCoeff = fall > 0 ? Math.exp(-1 / (fall * sampleRate)) : 0

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const coeff = x > this.state ? riseCoeff : fallCoeff
      this.state = x + (this.state - x) * coeff
      outCh[i] = this.state
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-slew', SlewProcessor)
