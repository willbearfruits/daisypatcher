/// <reference path="./worklet.d.ts" />

/**
 * T flip-flop.
 *
 * State survives across blocks and across param changes — that is the whole
 * point. It does NOT survive a graph rebuild, because a rebuild constructs
 * a new processor; a toggle that remembered its position through an edit
 * would be remembering state the patch file does not contain.
 *
 * Registered as `'dp-toggle'`.
 */

class ToggleProcessor extends AudioWorkletProcessor {
  private state = false
  private initialised = false
  private initialHigh = false
  private trigHigh = false
  private resetHigh = false

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; paramId?: string; value?: unknown }
      if (d?.type === 'param' && d.paramId === 'initial') {
        this.initialHigh = d.value === 'high'
        // Only adopt the new default before the first edge — after that the
        // live state is the truth and changing the sidebar must not jump it.
        if (!this.initialised) this.state = this.initialHigh
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const out = output[0]
    if (!out) return true
    const inv = outputs[1]?.[0]

    const trig = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const rst = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const n = out.length

    for (let i = 0; i < n; i++) {
      const rv = (rst ? rst[i] : 0) >= 0.5
      if (rv && !this.resetHigh) {
        this.state = this.initialHigh
        this.initialised = true
      }
      this.resetHigh = rv

      const tv = (trig ? trig[i] : 0) >= 0.5
      if (tv && !this.trigHigh) {
        this.state = !this.state
        this.initialised = true
      }
      this.trigHigh = tv

      out[i] = this.state ? 1 : 0
      if (inv) inv[i] = this.state ? 0 : 1
    }
    return true
  }
}

registerProcessor('dp-toggle', ToggleProcessor)
