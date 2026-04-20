/// <reference path="./worklet.d.ts" />

/**
 * Sum — adds up to 4 input signals. Each input is optional; missing inputs
 * contribute zero. Registered as `'dp-sum'`.
 */

class SumProcessor extends AudioWorkletProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const c1 = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const c2 = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const c3 = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const c4 = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      let s = 0
      if (c1) s += c1[i]
      if (c2) s += c2[i]
      if (c3) s += c3[i]
      if (c4) s += c4[i]
      outCh[i] = s
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-sum', SumProcessor)
