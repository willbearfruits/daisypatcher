/// <reference path="./worklet.d.ts" />

/**
 * Hardware gate input.
 *
 * On the Daisy Seed this reads a digital gate pin (channel 1 or 2). In the
 * emulator the `value` param (0 or 1) drives the gate output directly so
 * you can trigger envelopes by toggling the inspector button. `channel` is
 * stashed for hardware export only.
 *
 * Registered as `'dp-gate-in'`.
 */

class GateInProcessor extends AudioWorkletProcessor {
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
  private channel = '1'

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'channel') {
        this.channel = String(data.value)
        // Hardware target reads this.channel on export.
        void this.channel
      }
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

registerProcessor('dp-gate-in', GateInProcessor)
