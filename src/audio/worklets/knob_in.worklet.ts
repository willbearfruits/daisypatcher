/// <reference path="./worklet.d.ts" />

/**
 * Hardware knob → CV.
 *
 * On the Daisy Seed this reads an ADC channel (1..6). In the emulator the
 * `value` param drives the CV output directly — a slider in the inspector
 * takes the place of turning a physical knob. `channel` is stashed for when
 * the hardware target is wired up; it has no effect in the emulator.
 *
 * Registered as `'dp-knob-in'`.
 */

class KnobInProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'value',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      }
    ]
  }

  // Stashed for hardware export; unused in the emulator DSP path.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

    const v = parameters.value[0] ?? 0.5
    ch.fill(v)
    for (let c = 1; c < output.length; c++) output[c].set(ch)
    return true
  }
}

registerProcessor('dp-knob-in', KnobInProcessor)
