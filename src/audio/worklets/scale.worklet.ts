/// <reference path="./worklet.d.ts" />

/**
 * Scale + offset — out = clamp(in * scale + offset, -1, 1).
 * Registered as `'dp-scale'`.
 */

class ScaleProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'scale', defaultValue: 1, minValue: -2, maxValue: 2, automationRate: 'k-rate' },
      { name: 'offset', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' }
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

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const scale = parameters.scale[0] ?? 1
    const offset = parameters.offset[0] ?? 0

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      let v = x * scale + offset
      if (v > 1) v = 1
      else if (v < -1) v = -1
      outCh[i] = v
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-scale', ScaleProcessor)
