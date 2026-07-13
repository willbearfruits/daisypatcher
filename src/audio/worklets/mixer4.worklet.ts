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

    // Wave 2 replace-semantics CV for per-channel levels (indices 4..7).
    const lv1 = inputs[4] && inputs[4].length > 0 ? inputs[4][0] : undefined
    const lv2 = inputs[5] && inputs[5].length > 0 ? inputs[5][0] : undefined
    const lv3 = inputs[6] && inputs[6].length > 0 ? inputs[6][0] : undefined
    const lv4 = inputs[7] && inputs[7].length > 0 ? inputs[7][0] : undefined

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      let gi1 = g1
      if (lv1) { gi1 = lv1[i]; if (gi1 < 0) gi1 = 0; else if (gi1 > 2) gi1 = 2 }
      let gi2 = g2
      if (lv2) { gi2 = lv2[i]; if (gi2 < 0) gi2 = 0; else if (gi2 > 2) gi2 = 2 }
      let gi3 = g3
      if (lv3) { gi3 = lv3[i]; if (gi3 < 0) gi3 = 0; else if (gi3 > 2) gi3 = 2 }
      let gi4 = g4
      if (lv4) { gi4 = lv4[i]; if (gi4 < 0) gi4 = 0; else if (gi4 > 2) gi4 = 2 }
      let s = 0
      if (c1) s += c1[i] * gi1
      if (c2) s += c2[i] * gi2
      if (c3) s += c3[i] * gi3
      if (c4) s += c4[i] * gi4
      outCh[i] = s
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-mixer4', Mixer4Processor)
