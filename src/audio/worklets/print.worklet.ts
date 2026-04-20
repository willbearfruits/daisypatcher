/// <reference path="./worklet.d.ts" />

/**
 * Print — debug output on rising trigger edge.
 *
 * In the emulator, logs the current `value` input via `console.log` on
 * each rising edge of `trigger`. On hardware, codegen emits an equivalent
 * call into the Daisy's USB serial (`hw.PrintLine`). The node has no
 * audio outputs.
 *
 * Registered as `'dp-print'`.
 */

class PrintProcessor extends AudioWorkletProcessor {
  private label = 'val'
  private prevTrig = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'label') {
        this.label = String(data.value ?? 'val')
      }
    }
  }

  process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const valCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    const n = trigCh ? trigCh.length : 0
    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5 ? 1 : 0
      if (this.prevTrig < 0.5 && nowHigh >= 0.5) {
        const v = valCh ? valCh[i] : 0
        // Post to the main thread so the console shows it in the
        // inspector without pulling AudioWorkletGlobalScope off the
        // hot path.
        this.port.postMessage({ type: 'print', label: this.label, value: v })
      }
      this.prevTrig = nowHigh
    }
    return true
  }
}

registerProcessor('dp-print', PrintProcessor)
