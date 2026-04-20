/// <reference path="./worklet.d.ts" />

/**
 * Sinusoidal wavefolder — y = sin(π · (x + bias) · fold). Smooth, bounded,
 * CPU-friendly. `fold_cv` adds to the `fold` amount. Registered as
 * `'dp-wavefolder'`.
 */

class WavefolderProcessor extends AudioWorkletProcessor {
  private readonly PI = Math.PI

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'fold', defaultValue: 1, minValue: 0, maxValue: 8, automationRate: 'k-rate' },
      { name: 'bias', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' }
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
    const foldCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    const baseFold = parameters.fold[0] ?? 1
    const bias = parameters.bias[0] ?? 0
    const pi = this.PI
    const n = outCh.length

    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      let fold = baseFold + (foldCv ? foldCv[i] : 0)
      if (fold < 0) fold = 0
      else if (fold > 16) fold = 16
      let y = Math.sin(pi * (x + bias) * fold)
      if (!isFinite(y)) y = 0
      if (y > 1) y = 1
      else if (y < -1) y = -1
      outCh[i] = y
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-wavefolder', WavefolderProcessor)
