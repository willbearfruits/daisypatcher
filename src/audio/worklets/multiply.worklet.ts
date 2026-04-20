/// <reference path="./worklet.d.ts" />

/**
 * Multiply — out = a * b. Either input missing → silence.
 * Registered as `'dp-multiply'`.
 */

class MultiplyProcessor extends AudioWorkletProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const a = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const b = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    const n = outCh.length
    if (!a || !b) {
      outCh.fill(0)
    } else {
      for (let i = 0; i < n; i++) {
        outCh[i] = a[i] * b[i]
      }
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-multiply', MultiplyProcessor)
