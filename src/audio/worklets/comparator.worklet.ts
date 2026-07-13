/// <reference path="./worklet.d.ts" />

/**
 * Comparator — out = 1 if in > ref + threshold, else 0. If `ref` is not
 * connected, uses 0 for ref (so effectively compares in against threshold).
 * Registered as `'dp-comparator'`.
 */

class ComparatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'threshold', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' }
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
    const refCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    // Wave 2 cv_threshold at index 2 — replace-semantics override, clamped -1..1.
    const thrCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const threshold = parameters.threshold[0] ?? 0

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const r = refCh ? refCh[i] : 0
      let t = threshold
      if (thrCv) {
        t = thrCv[i]
        if (t < -1) t = -1
        else if (t > 1) t = 1
      }
      outCh[i] = x > r + t ? 1 : 0
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-comparator', ComparatorProcessor)
