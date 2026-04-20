/// <reference path="./worklet.d.ts" />

/**
 * Sample & hold — on every rising edge of `trigger` (crosses 0.5),
 * latches the current `in` value and holds it until the next trigger.
 * Registered as `'dp-sample-hold'`.
 */

class SampleHoldProcessor extends AudioWorkletProcessor {
  private held = 0
  private trigHigh = false

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
    const trigCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      if (nowHigh && !this.trigHigh) {
        this.held = inCh ? inCh[i] : 0
      }
      this.trigHigh = nowHigh
      outCh[i] = this.held
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-sample-hold', SampleHoldProcessor)
