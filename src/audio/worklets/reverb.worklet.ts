/// <reference path="./worklet.d.ts" />

/**
 * FreeVerb-style reverb (Jezar at Dreampoint, public domain).
 * 8 parallel lowpass-feedback comb filters summed into 4 series allpass
 * filters. Single channel (mono) output. Comb/allpass lengths are scaled
 * from the 44.1 kHz originals to the current sampleRate at init.
 *
 * Params:
 *   size → comb feedback gain (room size): 0.7..0.98
 *   damp → lowpass damping inside combs: 0..0.4
 *   mix  → dry/wet blend.
 *
 * Registered as `'dp-reverb'`.
 */

const COMB_LENGTHS_44K = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_LENGTHS_44K = [556, 441, 341, 225]
const FIXED_GAIN = 0.015 // Freeverb's input scaling — keeps wet level sane.
const ALLPASS_FEEDBACK = 0.5

class Comb {
  buffer: Float32Array
  idx = 0
  filterStore = 0
  feedback = 0.84
  damp1 = 0
  damp2 = 1

  constructor(size: number) {
    this.buffer = new Float32Array(size)
  }

  setDamp(d: number): void {
    this.damp1 = d
    this.damp2 = 1 - d
  }

  process(input: number): number {
    const out = this.buffer[this.idx]
    // 1-pole lowpass inside the feedback loop.
    this.filterStore = out * this.damp2 + this.filterStore * this.damp1
    if (!isFinite(this.filterStore)) this.filterStore = 0
    this.buffer[this.idx] = input + this.filterStore * this.feedback
    if (!isFinite(this.buffer[this.idx])) this.buffer[this.idx] = 0
    this.idx++
    if (this.idx >= this.buffer.length) this.idx = 0
    return out
  }
}

class Allpass {
  buffer: Float32Array
  idx = 0
  feedback = ALLPASS_FEEDBACK

  constructor(size: number) {
    this.buffer = new Float32Array(size)
  }

  process(input: number): number {
    const bufOut = this.buffer[this.idx]
    const out = -input + bufOut
    let v = input + bufOut * this.feedback
    if (!isFinite(v)) v = 0
    this.buffer[this.idx] = v
    this.idx++
    if (this.idx >= this.buffer.length) this.idx = 0
    return out
  }
}

class ReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'size', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'damp', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private combs: Comb[]
  private allpasses: Allpass[]

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const scale = sampleRate / 44100
    this.combs = COMB_LENGTHS_44K.map((L) => new Comb(Math.max(1, Math.round(L * scale))))
    this.allpasses = ALLPASS_LENGTHS_44K.map((L) => new Allpass(Math.max(1, Math.round(L * scale))))
    this.port.onmessage = (_event: MessageEvent) => {
      /* no enum params for reverb */
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

    let size = parameters.size[0] ?? 0.5
    let damp = parameters.damp[0] ?? 0.5
    let mix = parameters.mix[0] ?? 0.3
    if (size < 0) size = 0
    else if (size > 1) size = 1
    if (damp < 0) damp = 0
    else if (damp > 1) damp = 1
    if (mix < 0) mix = 0
    else if (mix > 1) mix = 1

    const roomsize = size * 0.28 + 0.7 // 0.7 .. 0.98
    const dampVal = damp * 0.4
    const combs = this.combs
    const allpasses = this.allpasses
    for (let i = 0; i < combs.length; i++) {
      combs[i].feedback = roomsize
      combs[i].setDamp(dampVal)
    }

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const dry = inCh ? inCh[i] : 0
      const input = dry * FIXED_GAIN

      let wet = 0
      // Parallel combs.
      wet += combs[0].process(input)
      wet += combs[1].process(input)
      wet += combs[2].process(input)
      wet += combs[3].process(input)
      wet += combs[4].process(input)
      wet += combs[5].process(input)
      wet += combs[6].process(input)
      wet += combs[7].process(input)

      // Serial allpasses.
      wet = allpasses[0].process(wet)
      wet = allpasses[1].process(wet)
      wet = allpasses[2].process(wet)
      wet = allpasses[3].process(wet)

      if (!isFinite(wet)) wet = 0

      outCh[i] = dry * (1 - mix) + wet * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-reverb', ReverbProcessor)
