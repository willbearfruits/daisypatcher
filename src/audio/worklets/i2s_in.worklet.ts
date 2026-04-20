/// <reference path="./worklet.d.ts" />

/**
 * External I2S codec stereo input.
 *
 * On hardware this routes the codec's ADC channels into the graph via a
 * second `SaiHandle`. The browser emulator has no second codec, so this
 * worklet emits silence on both outputs. Graphs that reference `i2s_in`
 * therefore still connect cleanly — the branch is simply silent.
 *
 * Registered as `'dp-i2s-in'`.
 */

class I2sInProcessor extends AudioWorkletProcessor {
  private bindingId = ''

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'bindingId') {
        this.bindingId = String(data.value)
      }
      void this.bindingId
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0]?.[0]
    const outR = outputs[1]?.[0]
    if (outL) outL.fill(0)
    if (outR) outR.fill(0)
    return true
  }
}

registerProcessor('dp-i2s-in', I2sInProcessor)
