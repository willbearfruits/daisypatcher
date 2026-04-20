/// <reference path="./worklet.d.ts" />

/**
 * Noise worklet — white or pink. Pink uses the Paul Kellet economy filter
 * (7 poles). Enum `color` arrives via port message. Registered as `'dp-noise'`.
 */

type NoiseColor = 'white' | 'pink'

class NoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'amplitude',
        defaultValue: 0.3,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      }
    ]
  }

  private color: NoiseColor = 'white'
  // Paul Kellet pink noise state
  private b0 = 0
  private b1 = 0
  private b2 = 0
  private b3 = 0
  private b4 = 0
  private b5 = 0
  private b6 = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'color') {
        const v = data.value as string
        if (v === 'white' || v === 'pink') this.color = v
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

    const ampArr = parameters.amplitude
    const amp = ampArr.length > 0 ? ampArr[0] : 0.3

    if (this.color === 'white') {
      for (let i = 0; i < ch.length; i++) {
        ch[i] = (Math.random() * 2 - 1) * amp
      }
    } else {
      for (let i = 0; i < ch.length; i++) {
        const white = Math.random() * 2 - 1
        this.b0 = 0.99886 * this.b0 + white * 0.0555179
        this.b1 = 0.99332 * this.b1 + white * 0.0750759
        this.b2 = 0.96900 * this.b2 + white * 0.1538520
        this.b3 = 0.86650 * this.b3 + white * 0.3104856
        this.b4 = 0.55000 * this.b4 + white * 0.5329522
        this.b5 = -0.7616 * this.b5 - white * 0.0168980
        const pink = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362
        this.b6 = white * 0.115926
        // Output is roughly in [-1,1] after this scale; 0.11 rolls it down.
        ch[i] = pink * 0.11 * amp
      }
    }

    for (let c = 1; c < output.length; c++) output[c].set(ch)
    return true
  }
}

registerProcessor('dp-noise', NoiseProcessor)
