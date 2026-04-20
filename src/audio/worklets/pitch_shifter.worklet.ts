/// <reference path="./worklet.d.ts" />

/**
 * Pitch shifter — classic 2-tap granular (overlap-add) pitch shift. Two
 * read heads move at rate 1 - pitchRatio through a delay line; their
 * positions are phase-offset by 50% and Hann-windowed so the sum stays
 * energy-constant. When a head wraps past the delay length it resets.
 * Registered as `'dp-pitch-shifter'`.
 */

const PS_DELAY_SECONDS = 0.1

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'semitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly TWO_PI = Math.PI * 2
  private buffer: Float32Array
  private writeIdx = 0
  private delayLen: number
  private readHead1: number
  private readHead2: number

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const size = Math.ceil(PS_DELAY_SECONDS * sampleRate) + 2
    this.buffer = new Float32Array(size)
    this.delayLen = size - 2
    // Heads offset by half the delay line length.
    this.readHead1 = 0
    this.readHead2 = this.delayLen * 0.5
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
    const semis = parameters.semitones[0] ?? 0
    const mix = parameters.mix[0] ?? 1

    const ratio = Math.pow(2, semis / 12)
    // Read advance per sample, relative to write: if ratio > 1 (up-pitch),
    // read heads advance faster than 1, so they approach write and wrap more.
    // Delta = 1 - ratio: negative for up-pitch means read falls behind write
    // which means we reach fresher samples faster. Standard formulation.
    const readStep = 1 - ratio

    const buf = this.buffer
    const bufLen = buf.length
    const delayLen = this.delayLen

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      buf[this.writeIdx] = x

      // Head positions are offsets BEHIND the write pointer.
      // Advance the head offsets.
      this.readHead1 += readStep
      this.readHead2 += readStep
      // Wrap heads within [0, delayLen).
      while (this.readHead1 < 0) this.readHead1 += delayLen
      while (this.readHead1 >= delayLen) this.readHead1 -= delayLen
      while (this.readHead2 < 0) this.readHead2 += delayLen
      while (this.readHead2 >= delayLen) this.readHead2 -= delayLen

      const readPosA = (this.writeIdx - this.readHead1 + bufLen) % bufLen
      const readPosB = (this.writeIdx - this.readHead2 + bufLen) % bufLen

      const a0 = Math.floor(readPosA)
      const af = readPosA - a0
      const a1 = (a0 + 1) % bufLen
      const sA = buf[a0] * (1 - af) + buf[a1] * af

      const b0 = Math.floor(readPosB)
      const bf = readPosB - b0
      const b1 = (b0 + 1) % bufLen
      const sB = buf[b0] * (1 - bf) + buf[b1] * bf

      // Hann window on each head, using its phase through delayLen.
      const winA = 0.5 - 0.5 * Math.cos((this.TWO_PI * this.readHead1) / delayLen)
      const winB = 0.5 - 0.5 * Math.cos((this.TWO_PI * this.readHead2) / delayLen)
      let wet = sA * winA + sB * winB
      if (!isFinite(wet)) wet = 0

      outCh[i] = x * (1 - mix) + wet * mix

      this.writeIdx++
      if (this.writeIdx >= bufLen) this.writeIdx = 0
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-pitch-shifter', PitchShifterProcessor)
