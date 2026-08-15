/// <reference path="./worklet.d.ts" />

/**
 * Boolean logic on two gates. Threshold 0.5, matching every other gate in
 * the catalog — an unconnected input reads as low, which makes AND with one
 * cable a permanent low and OR with one cable a passthrough. Both are the
 * arithmetically honest answers and both are what you want.
 *
 * Registered as `'dp-logic'`.
 */

class LogicProcessor extends AudioWorkletProcessor {
  private op = 'and'

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; paramId?: string; value?: unknown }
      if (d?.type === 'param' && d.paramId === 'op') this.op = String(d.value)
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const out = output[0]
    if (!out) return true

    const a = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const b = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const op = this.op
    const n = out.length

    for (let i = 0; i < n; i++) {
      const av = (a ? a[i] : 0) >= 0.5
      const bv = (b ? b[i] : 0) >= 0.5
      let r: boolean
      switch (op) {
        case 'or': r = av || bv; break
        case 'xor': r = av !== bv; break
        case 'nand': r = !(av && bv); break
        case 'nor': r = !(av || bv); break
        case 'not': r = !av; break
        default: r = av && bv
      }
      out[i] = r ? 1 : 0
    }
    return true
  }
}

registerProcessor('dp-logic', LogicProcessor)
