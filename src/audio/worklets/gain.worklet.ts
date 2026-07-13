/// <reference path="./worklet.d.ts" />

/**
 * Gain worklet — linear mono multiplier. `gain` is a-rate so automation
 * ramps are click-free. Registered as `'dp-gain'`.
 */

class GainProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'gain',
        defaultValue: 0.8,
        minValue: 0,
        maxValue: 2,
        automationRate: 'a-rate'
      }
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const gainValues = parameters.gain
    const aRate = gainValues.length === outCh.length

    // CV input at index 1: legacy symmetric mod — effective gain = gain * (cv * 0.5 + 1)
    // so cv=-1 halves, cv=0 unchanged, cv=+1 adds 50%. No cable → bypass entirely.
    const cvCh = inputs[1]?.[0]
    const hasCv = !!(cvCh && cvCh.length > 0)
    // Wave 2 cv_gain at index 2 — replace semantics, clamped to 0..2.
    const gainCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    if (!input || input.length === 0 || !input[0]) {
      // No input connected — emit silence.
      outCh.fill(0)
    } else {
      const inCh = input[0]
      const n = outCh.length
      for (let i = 0; i < n; i++) {
        let base: number
        if (gainCv) {
          base = gainCv[i]
          if (base < 0) base = 0
          else if (base > 2) base = 2
        } else {
          base = aRate ? gainValues[i] : gainValues[0]
        }
        const g = base * (hasCv ? (cvCh![i] * 0.5 + 1) : 1)
        outCh[i] = inCh[i] * g
      }
    }

    for (let c = 1; c < output.length; c++) {
      output[c].set(outCh)
    }

    return true
  }
}

registerProcessor('dp-gain', GainProcessor)
