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

    // CV input at index 1: symmetric mod — effective gain = gain * (cv * 0.5 + 1)
    // so cv=-1 halves, cv=0 unchanged, cv=+1 adds 50%. No cable → bypass entirely.
    const cvCh = inputs[1]?.[0]
    const hasCv = !!(cvCh && cvCh.length > 0)

    if (!input || input.length === 0 || !input[0]) {
      // No input connected — emit silence.
      outCh.fill(0)
    } else {
      const inCh = input[0]
      const n = outCh.length
      if (aRate) {
        for (let i = 0; i < n; i++) {
          const g = gainValues[i] * (hasCv ? (cvCh![i] * 0.5 + 1) : 1)
          outCh[i] = inCh[i] * g
        }
      } else {
        const base = gainValues[0]
        for (let i = 0; i < n; i++) {
          const g = base * (hasCv ? (cvCh![i] * 0.5 + 1) : 1)
          outCh[i] = inCh[i] * g
        }
      }
    }

    for (let c = 1; c < output.length; c++) {
      output[c].set(outCh)
    }

    return true
  }
}

registerProcessor('dp-gain', GainProcessor)
