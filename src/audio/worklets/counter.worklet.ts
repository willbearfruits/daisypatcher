/// <reference path="./worklet.d.ts" />

/**
 * Counter.
 *
 * `count` is normalised by `max - 1` rather than by `max`, so the last step
 * reads exactly 1.0. Dividing by `max` would make an 8-step counter top out
 * at 0.875 and quietly lose the top of the range of whatever it drives.
 *
 * Registered as `'dp-counter'`.
 */

class CounterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [{ name: 'max', defaultValue: 8, minValue: 2, maxValue: 64, automationRate: 'k-rate' }]
  }

  private value = 0
  private mode = 'wrap'
  private incHigh = false
  private decHigh = false
  private resetHigh = false

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; paramId?: string; value?: unknown }
      if (d?.type === 'param' && d.paramId === 'mode') this.mode = String(d.value)
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const countOut = outputs[0]?.[0]
    const indexOut = outputs[1]?.[0]
    const carryOut = outputs[2]?.[0]
    const n = countOut?.length ?? indexOut?.length ?? carryOut?.length ?? 0
    if (n === 0) return true

    const inc = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const dec = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const rst = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    let max = Math.round(parameters.max[0] ?? 8)
    if (max < 2) max = 2
    else if (max > 64) max = 64
    const wrap = this.mode !== 'clamp'

    for (let i = 0; i < n; i++) {
      let carry = 0

      const rv = (rst ? rst[i] : 0) >= 0.5
      if (rv && !this.resetHigh) this.value = 0
      this.resetHigh = rv

      const iv = (inc ? inc[i] : 0) >= 0.5
      if (iv && !this.incHigh) {
        this.value++
        if (this.value >= max) {
          carry = 1
          this.value = wrap ? 0 : max - 1
        }
      }
      this.incHigh = iv

      const dv = (dec ? dec[i] : 0) >= 0.5
      if (dv && !this.decHigh) {
        this.value--
        if (this.value < 0) {
          carry = 1
          this.value = wrap ? max - 1 : 0
        }
      }
      this.decHigh = dv

      if (countOut) countOut[i] = max > 1 ? this.value / (max - 1) : 0
      if (indexOut) indexOut[i] = this.value
      if (carryOut) carryOut[i] = carry
    }
    return true
  }
}

registerProcessor('dp-counter', CounterProcessor)
