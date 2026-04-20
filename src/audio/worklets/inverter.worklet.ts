/// <reference path="./worklet.d.ts" />

/**
 * Inverter — out = -in. Registered as `'dp-inverter'`.
 */

class InverterProcessor extends AudioWorkletProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined

    const n = outCh.length
    if (!inCh) {
      outCh.fill(0)
    } else {
      for (let i = 0; i < n; i++) {
        outCh[i] = -inCh[i]
      }
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-inverter', InverterProcessor)
