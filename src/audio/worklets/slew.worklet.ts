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
    // Wave 2 CV: cv_rise at index 1, cv_fall at index 2.
    const riseCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const fallCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    const riseBase = parameters.rise[0] ?? 0.05
    const fallBase = parameters.fall[0] ?? 0.05
    // Precompute block-rate coeffs; recomputed per-sample if CV is present.
    const riseCoeffK = riseBase > 0 ? Math.exp(-1 / (riseBase * sampleRate)) : 0
    const fallCoeffK = fallBase > 0 ? Math.exp(-1 / (fallBase * sampleRate)) : 0

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      let riseCoeff = riseCoeffK
      if (riseCv) {
        let r = riseCv[i]
        if (r < 0) r = 0
        else if (r > 2) r = 2
        riseCoeff = r > 0 ? Math.exp(-1 / (r * sampleRate)) : 0
      }
      let fallCoeff = fallCoeffK
      if (fallCv) {
        let f = fallCv[i]
        if (f < 0) f = 0
        else if (f > 2) f = 2
        fallCoeff = f > 0 ? Math.exp(-1 / (f * sampleRate)) : 0
      }
      const coeff = x > this.state ? riseCoeff : fallCoeff
      this.state = x + (this.state - x) * coeff
      outCh[i] = this.state
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-slew', SlewProcessor)
