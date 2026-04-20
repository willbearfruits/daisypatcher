/// <reference path="./worklet.d.ts" />

/**
 * Formant filter — three parallel biquad bandpass filters tuned to the first
 * three formants of a selected vowel. `morph` (0..1) crossfades the formant
 * target frequencies between the selected vowel and the next vowel in the
 * a/e/i/o/u cycle. Wet/dry mixed by `mix`. Registered as `'dp-formant'`.
 */

type Vowel = 'a' | 'e' | 'i' | 'o' | 'u'

const FORMANT_VOWELS: Record<Vowel, [number, number, number]> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240]
}
const FORMANT_ORDER: Vowel[] = ['a', 'e', 'i', 'o', 'u']

class FormantProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'morph', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'q', defaultValue: 5, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private vowel: Vowel = 'a'
  // Per-formant biquad state (Transposed Direct Form II), 3 formants.
  private z1: Float32Array = new Float32Array(3)
  private z2: Float32Array = new Float32Array(3)
  // Preallocated coefficient scratch for 3 formants.
  private b0 = new Float32Array(3)
  private b2 = new Float32Array(3)
  private a1 = new Float32Array(3)
  private a2 = new Float32Array(3)

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'vowel') {
        const v = data.value as string
        if (v === 'a' || v === 'e' || v === 'i' || v === 'o' || v === 'u') {
          this.vowel = v
        }
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const morph = parameters.morph[0] ?? 0
    const q = parameters.q[0] ?? 5
    const mix = parameters.mix[0] ?? 0.6

    // Determine blended formant frequencies.
    const curIdx = FORMANT_ORDER.indexOf(this.vowel)
    const nxtIdx = (curIdx + 1) % FORMANT_ORDER.length
    const cur = FORMANT_VOWELS[FORMANT_ORDER[curIdx]]
    const nxt = FORMANT_VOWELS[FORMANT_ORDER[nxtIdx]]

    const sr = sampleRate
    const nyquistCap = sr * 0.45

    // Precompute biquad coefficients per formant for this block (k-rate params).
    // Constant-0 dB peak gain bandpass (RBJ cookbook).
    // b0 = alpha, b1 = 0, b2 = -alpha, a0 = 1 + alpha, a1 = -2cos(w0), a2 = 1 - alpha
    const b0 = this.b0
    const b2 = this.b2
    const a1 = this.a1
    const a2 = this.a2
    for (let f = 0; f < 3; f++) {
      let freq = cur[f] * (1 - morph) + nxt[f] * morph
      if (freq < 20) freq = 20
      else if (freq > nyquistCap) freq = nyquistCap
      const w0 = (2 * Math.PI * freq) / sr
      const cosW = Math.cos(w0)
      const sinW = Math.sin(w0)
      const alpha = sinW / (2 * q)
      const a0 = 1 + alpha
      b0[f] = alpha / a0
      b2[f] = -alpha / a0
      a1[f] = (-2 * cosW) / a0
      a2[f] = (1 - alpha) / a0
    }

    const z1 = this.z1
    const z2 = this.z2

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      let wet = 0
      for (let f = 0; f < 3; f++) {
        const y = b0[f] * x + z1[f]
        z1[f] = b2[f] * x - a1[f] * y + z2[f]
        z2[f] = -a2[f] * y
        wet += y
      }
      wet *= 1 / 3
      if (!isFinite(wet)) wet = 0
      outCh[i] = x * (1 - mix) + wet * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-formant', FormantProcessor)
