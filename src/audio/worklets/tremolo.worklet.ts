/// <reference path="./worklet.d.ts" />

/**
 * Tremolo — amplitude modulation with an internal LFO. Effective rate is
 * `rate * 2^rate_cv` per sample when CV is connected, else just `rate`.
 * Output = in * (1 - depth + depth * lfo_0_to_1), where lfo_0_to_1 maps
 * the chosen shape (sine/triangle/square) into [0, 1]. depth=0 yields a
 * straight pass-through.
 * Registered as `'dp-tremolo'`.
 */

type TremoloShape = 'sine' | 'triangle' | 'square'

class TremoloProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 4, minValue: 0.1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private shape: TremoloShape = 'sine'
  private phase = 0 // 0..1

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'shape') {
        const v = data.value as string
        if (v === 'sine' || v === 'triangle' || v === 'square') this.shape = v
      }
    }
  }

  private lfoValue(p: number): number {
    // p in [0,1), returns value in [0,1].
    switch (this.shape) {
      case 'sine':
        return 0.5 + 0.5 * Math.sin(Math.PI * 2 * p)
      case 'triangle':
        return 1 - Math.abs(2 * p - 1) * 1 // tri in [0,1]
      case 'square':
        return p < 0.5 ? 1 : 0
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const cvCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    let rate = parameters.rate[0] ?? 4
    if (rate < 0.01) rate = 0.01
    let depth = parameters.depth[0] ?? 0.5
    if (depth < 0) depth = 0
    else if (depth > 1) depth = 1

    const invSr = 1 / sampleRate
    const n = out.length
    for (let i = 0; i < n; i++) {
      const cv = cvCh ? cvCh[i] : 0
      const effRate = rate * Math.pow(2, cv)
      this.phase += effRate * invSr
      if (this.phase >= 1) this.phase -= Math.floor(this.phase)
      else if (this.phase < 0) this.phase -= Math.floor(this.phase)

      const lfo01 = this.lfoValue(this.phase)
      const gain = 1 - depth + depth * lfo01
      const x = inCh ? inCh[i] : 0
      out[i] = x * gain
    }

    for (let c = 1; c < (outputs[0]?.length ?? 1); c++) outputs[0][c].set(out)
    return true
  }
}

registerProcessor('dp-tremolo', TremoloProcessor)
