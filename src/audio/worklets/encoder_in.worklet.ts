/// <reference path="./worklet.d.ts" />

/**
 * Rotary encoder → CV (emulator side).
 *
 * On hardware the A/B quadrature pair yields +1/-1 per detent and the
 * firmware integrates those into a position. There is no encoder attached
 * to a laptop, so the inspector's `value` slider stands in for the
 * integrated position directly, and `delta` is derived by differencing it
 * between blocks — turning the slider produces exactly the pulse train a
 * real detent would.
 *
 * `min`/`max` scale the position on the way out, matching `knob_in`, so an
 * encoder can drive a frequency in Hz as easily as a 0..1 amount.
 *
 * Registered as `'dp-encoder-in'`. Three outputs, in socket order:
 * 0 = out, 1 = delta, 2 = sw.
 */

class EncoderInProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'value',    defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'sw_value', defaultValue: 0,   minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  /** Previous block's normalized position, for the delta difference. */
  private lastValue = 0.5
  private min = 0
  private max = 1
  private wrap = 'clamp'
  private bindingId = ''

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type !== 'param') return
      // `step` is a hardware-side concern (how far one detent moves the
      // position). In the emulator the slider IS the position, so there
      // are no detents to scale — it's accepted and ignored.
      if (data.paramId === 'min') this.min = Number(data.value)
      else if (data.paramId === 'max') this.max = Number(data.value)
      else if (data.paramId === 'wrap') this.wrap = String(data.value)
      else if (data.paramId === 'bindingId') this.bindingId = String(data.value)
    }
    // Stashed for hardware export; unused in the emulator DSP path.
    void this.bindingId
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const outPos = outputs[0]
    const outDelta = outputs[1]
    const outSw = outputs[2]

    let v = parameters.value[0] ?? 0.5
    if (this.wrap === 'wrap') v = v - Math.floor(v)
    else v = v < 0 ? 0 : v > 1 ? 1 : v

    // Difference against the previous block. Under 'wrap', take the short
    // way round so a 0.99 -> 0.01 turn reads as +0.02, not -0.98.
    let d = v - this.lastValue
    if (this.wrap === 'wrap') {
      if (d > 0.5) d -= 1
      else if (d < -0.5) d += 1
    }
    this.lastValue = v

    const scaled = this.min + v * (this.max - this.min)
    const scaledDelta = d * (this.max - this.min)
    const sw = (parameters.sw_value[0] ?? 0) >= 0.5 ? 1 : 0

    if (outPos && outPos.length > 0 && outPos[0]) {
      outPos[0].fill(scaled)
      for (let c = 1; c < outPos.length; c++) outPos[c].set(outPos[0])
    }
    if (outDelta && outDelta.length > 0 && outDelta[0]) {
      outDelta[0].fill(scaledDelta)
      for (let c = 1; c < outDelta.length; c++) outDelta[c].set(outDelta[0])
    }
    if (outSw && outSw.length > 0 && outSw[0]) {
      outSw[0].fill(sw)
      for (let c = 1; c < outSw.length; c++) outSw[c].set(outSw[0])
    }
    return true
  }
}

registerProcessor('dp-encoder-in', EncoderInProcessor)
