/// <reference path="./worklet.d.ts" />

/**
 * Hardware pushbutton → gate.
 *
 * On the Daisy Seed this reads a GPIO input bound to a placed button. In
 * the emulator there is no physical button — the inspector mutates the
 * `value` param (0/1) on click and this worklet reflects it directly as a
 * gate signal. `mode` (momentary/toggle/latch) and `bindingId` are stashed
 * for hardware export; they do not affect emulator behaviour because the
 * inspector already mediates the click-to-value mapping.
 *
 * Registered as `'dp-button'`.
 */

class ButtonProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'value',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      }
    ]
  }

  // Stashed for hardware export; unused in the emulator DSP path.
  private mode = 'momentary'
  private bindingId = ''

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param') {
        if (data.paramId === 'mode') this.mode = String(data.value)
        else if (data.paramId === 'bindingId') this.bindingId = String(data.value)
      }
      // Hardware export reads both.
      void this.mode
      void this.bindingId
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const ch = output[0]
    if (!ch) return true

    const v = (parameters.value[0] ?? 0) >= 0.5 ? 1 : 0
    ch.fill(v)
    for (let c = 1; c < output.length; c++) output[c].set(ch)
    return true
  }
}

registerProcessor('dp-button', ButtonProcessor)
