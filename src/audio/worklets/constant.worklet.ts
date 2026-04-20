/// <reference path="./worklet.d.ts" />

/**
 * Constant DC source — emits a steady CV value. Registered as `'dp-constant'`.
 */

class ConstantProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'value',
        defaultValue: 0.5,
        minValue: -1,
        maxValue: 1,
        automationRate: 'k-rate'
      }
    ]
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const ch = output[0]
    if (!ch) return true

    const v = parameters.value[0] ?? 0.5
    ch.fill(v)
    for (let c = 1; c < output.length; c++) output[c].set(ch)
    return true
  }
}

registerProcessor('dp-constant', ConstantProcessor)
