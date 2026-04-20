/// <reference path="./worklet.d.ts" />

/**
 * Scope worklet — pure pass-through. The waveform display is driven by a
 * main-thread `AnalyserNode` attached via `AudioEngine.tap()`; this
 * processor only forwards audio so the node can be chained (in -> thru).
 * Registered as `'dp-scope'`.
 */

class ScopeProcessor extends AudioWorkletProcessor {
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

registerProcessor('dp-scope', ScopeProcessor)
