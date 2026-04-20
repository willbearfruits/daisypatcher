/// <reference path="./worklet.d.ts" />

/**
 * VU worklet — pure pass-through. The meter is driven by a main-thread
 * `AnalyserNode` attached via `AudioEngine.tap()`; RMS and peak are computed
 * in the React renderer from the time-domain buffer. Registered as `'dp-vu'`.
 */

class VuProcessor extends AudioWorkletProcessor {
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
    if (!inCh) {
      outCh.fill(0)
    } else {
      outCh.set(inCh)
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-vu', VuProcessor)
