/// <reference path="./worklet.d.ts" />

/**
 * 4-channel mixer — sums in1..in4 each scaled by gain1..gain4.
 * Registered as `'dp-mixer4'`.
 */

class Mixer4Processor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'gain1', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'gain2', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'gain3', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'gain4', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' }
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const g1 = parameters.gain1[0] ?? 1
    const g2 = parameters.gain2[0] ?? 1
    const g3 = parameters.gain3[0] ?? 1
    const g4 = parameters.gain4[0] ?? 1

    const c1 = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const c2 = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const c3 = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const c4 = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      let s = 0
      if (c1) s += c1[i] * g1
      if (c2) s += c2[i] * g2
      if (c3) s += c3[i] * g3
      if (c4) s += c4[i] * g4
      outCh[i] = s
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-mixer4', Mixer4Processor)
