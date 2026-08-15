/// <reference path="./worklet.d.ts" />

/**
 * Phaser — a port of DaisySP's `Phaser`.
 *
 * The structure is the surprising part and the reason a hand-written
 * cascade never matched it: DaisySP runs four allpass engines **in
 * parallel and sums them**, rather than chaining them. Each engine also
 * returns its own `(in + ap) * .5` equal mix, so the sum carries 2x the
 * dry signal — which is what made the device clip at a peak of 1.59 while
 * the app showed 0.53. The emitter now scales by the pole count, and this
 * does the same, so the two agree and neither clips.
 *
 * Each engine's allpass delay time is derived from the LFO in the
 * frequency domain — `sr / (lfo + apFreq + 30)` — and then one-pole
 * smoothed with a coefficient of 0.0001. That smoothing is slow enough to
 * be part of the sound, not a de-click: it is why the phaser lags the
 * Rate knob.
 *
 * See the chorus worklet for the sign-flipping triangle LFO these share.
 *
 * Registered as `'dp-phaser'`.
 */

const PHASER_DELAY_LENGTH = 2400 // 50 ms at 48 kHz, as in the original
const PHASER_POLES = 4

/** One `PhaserEngine`: a modulated allpass with feedback and an equal mix. */
class PhaserEngine {
  private readonly line = new Float32Array(PHASER_DELAY_LENGTH)
  private writePtr = 0

  private sr = 48000
  private lfoPhase = 0
  private lfoFreq = 0
  private lfoAmp = 0
  private apFreq = 200
  private feedback = 0.2
  private lastSample = 0
  private delTime = 0
  /** 30 Hz offset — below this the original notes it gets crunchy. */
  private readonly os = 30

  init(sampleRate: number): void {
    this.sr = sampleRate
    this.line.fill(0)
    this.writePtr = 0
    this.lfoAmp = 0
    this.feedback = 0.2
    this.apFreq = 200
    this.delTime = 0
    this.lastSample = 0
    this.lfoPhase = 0
    this.lfoFreq = 0
    this.setLfoFreq(0.3)
    this.setLfoDepth(0.9)
  }

  setLfoDepth(depth: number): void {
    this.lfoAmp = depth < 0 ? 0 : depth > 1 ? 1 : depth
  }

  setLfoFreq(freq: number): void {
    let f = (4 * freq) / this.sr
    f *= this.lfoFreq < 0 ? -1 : 1
    this.lfoFreq = f < -0.25 ? -0.25 : f > 0.25 ? 0.25 : f
  }

  setFreq(f: number): void {
    this.apFreq = f < 0 ? 0 : f > 20000 ? 20000 : f
  }

  /** Clamped to 0.75 by the original, not 1 — above that it self-oscillates. */
  setFeedback(fb: number): void {
    this.feedback = fb < 0 ? 0 : fb > 0.75 ? 0.75 : fb
  }

  private write(sample: number): void {
    this.line[this.writePtr] = sample
    this.writePtr = (this.writePtr - 1 + PHASER_DELAY_LENGTH) % PHASER_DELAY_LENGTH
  }

  /** `DelayLine::Allpass` — integer delay, no interpolation. */
  private allpass(sample: number, delay: number, coefficient: number): number {
    let d = Math.trunc(delay)
    if (d < 0) d = 0
    else if (d >= PHASER_DELAY_LENGTH) d = PHASER_DELAY_LENGTH - 1
    const read = this.line[(this.writePtr + d) % PHASER_DELAY_LENGTH]
    const write = sample + coefficient * read
    this.write(write)
    return -write * coefficient + read
  }

  private processLfo(): number {
    this.lfoPhase += this.lfoFreq
    if (this.lfoPhase > 1) {
      this.lfoPhase = 1 - (this.lfoPhase - 1)
      this.lfoFreq *= -1
    } else if (this.lfoPhase < -1) {
      this.lfoPhase = -1 - (this.lfoPhase + 1)
      this.lfoFreq *= -1
    }
    return this.lfoPhase * this.lfoAmp * this.apFreq
  }

  process(input: number): number {
    const lfoSig = this.processLfo()
    const target = this.sr / (lfoSig + this.apFreq + this.os)
    this.delTime += 0.0001 * (target - this.delTime)
    this.lastSample = this.allpass(input + this.feedback * this.lastSample, this.delTime, 0.3)
    return (input + this.lastSample) * 0.5 // equal mix, as in the original
  }
}

class PhaserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 0.5, minValue: 0.05, maxValue: 8, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 0.9, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly engines = [
    new PhaserEngine(),
    new PhaserEngine(),
    new PhaserEngine(),
    new PhaserEngine()
  ]
  private ready = false

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

    if (!this.ready) {
      for (const e of this.engines) e.init(sampleRate)
      this.ready = true
    }

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const rateCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const depthCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const fbCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined
    const mixCv = inputs[4] && inputs[4].length > 0 ? inputs[4][0] : undefined

    let rate = parameters.rate[0] ?? 0.5
    if (rateCv) rate = rateCv[0]
    if (rate < 0.05) rate = 0.05
    else if (rate > 8) rate = 8
    let depth = parameters.depth[0] ?? 0.7
    if (depthCv) depth = depthCv[0]
    if (depth < 0) depth = 0
    else if (depth > 1) depth = 1
    let fb = parameters.feedback[0] ?? 0.5
    if (fbCv) fb = fbCv[0]
    if (fb < 0) fb = 0
    else if (fb > 0.9) fb = 0.9
    let mix = parameters.mix[0] ?? 0.5
    if (mixCv) mix = mixCv[0]
    if (mix < 0) mix = 0
    else if (mix > 1) mix = 1

    for (const e of this.engines) {
      e.setLfoFreq(rate)
      e.setLfoDepth(depth)
      e.setFeedback(fb)
    }

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      let sig = 0
      for (const e of this.engines) sig += e.process(x)
      // Scale the sum back to a mean — see the header note on clipping.
      let wet = sig * (1 / PHASER_POLES)
      if (!isFinite(wet)) wet = 0
      outCh[i] = x * (1 - mix) + wet * mix
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-phaser', PhaserProcessor)
