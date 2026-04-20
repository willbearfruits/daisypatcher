/// <reference path="./worklet.d.ts" />

/**
 * External I2S codec stereo output.
 *
 * On hardware this feeds the external codec's DAC channels via a second
 * `SaiHandle`. In the emulator there is nowhere to send it, so this
 * worklet is a sink — it accepts stereo input and emits no output.
 *
 * Registered as `'dp-i2s-out'`.
 */

class I2sOutProcessor extends AudioWorkletProcessor {
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
    // No outputs declared by the definition, but the engine may allocate
    // an extra output channel in some configurations — fill with silence.
    const output = outputs[0]
    if (output) {
      for (let c = 0; c < output.length; c++) output[c].fill(0)
    }
    return true
  }
}

registerProcessor('dp-i2s-out', I2sOutProcessor)
