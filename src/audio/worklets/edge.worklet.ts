/// <reference path="./worklet.d.ts" />

/**
 * Edge detector — turns a gate of any length into a one-sample trigger.
 *
 * Registered as `'dp-edge'`.
 */

class EdgeProcessor extends AudioWorkletProcessor {
  private mode = 'rising'
  private high = false

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; paramId?: string; value?: unknown }
      if (d?.type === 'param' && d.paramId === 'mode') this.mode = String(d.value)
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const out = output[0]
    if (!out) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const mode = this.mode
    const n = out.length

    for (let i = 0; i < n; i++) {
      const v = (inCh ? inCh[i] : 0) >= 0.5
      const rising = v && !this.high
      const falling = !v && this.high
      this.high = v
      const fire =
        mode === 'falling' ? falling : mode === 'both' ? rising || falling : rising
      out[i] = fire ? 1 : 0
    }
    return true
  }
}

registerProcessor('dp-edge', EdgeProcessor)
