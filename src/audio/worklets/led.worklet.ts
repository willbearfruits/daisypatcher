/// <reference path="./worklet.d.ts" />

/**
 * LED sink — digital output driven by an incoming signal.
 *
 * On the Daisy Seed this drives a GPIO/PWM pin bound to a placed LED. The
 * emulator has no physical LED, and this node has no audio outputs, so
 * `process()` is effectively a no-op: it consumes input samples (for
 * future meter/visualiser hooks) and emits silence on any optional output
 * channels the engine attaches. `threshold`, `mode` and `bindingId` are
 * stashed for hardware export only.
 *
 * Registered as `'dp-led'`.
 */

class LedProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'threshold', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private mode = 'gate'
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
      void this.mode
      void this.bindingId
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    // LED is an output sink — no outputs to fill. If the host wires an
    // output anyway we emit silence to keep the graph well-defined.
    const output = outputs[0]
    if (!output) return true
    for (let c = 0; c < output.length; c++) output[c].fill(0)
    return true
  }
}

registerProcessor('dp-led', LedProcessor)
