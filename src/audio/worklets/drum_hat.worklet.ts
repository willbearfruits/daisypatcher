/// <reference path="./worklet.d.ts" />

/**
 * Hi-hat — a port of DaisySP's `HiHat<>` (SquareNoise + LinearVCA,
 * resonance on, which is what the bare `HiHat<>` in the emitter resolves to).
 *
 * The device builds its metallic noise from six square oscillators at
 * inharmonic ratios, band-passes it, mixes in clocked sample-and-hold
 * noise, applies a VCA, and high-passes the result. The emulator used to
 * play filtered white noise with an exponential envelope, which is a fine
 * hi-hat and about 89% quieter than what actually came out of the board.
 *
 * The six-oscillator noise runs on wrapping uint32 phase accumulators,
 * which is not incidental — the ratios beat against each other through
 * integer overflow, and that beating IS the metallic character. JS numbers
 * are doubles, so the accumulators are kept in `Uint32Array` and advanced
 * with `>>> 0` arithmetic to wrap the same way.
 *
 * Inputs:
 *   0  trigger  — gate
 *   1  cv_decay — replaces sidebar `decay` (clamped 0.01..0.5)
 *   2  cv_tone  — replaces sidebar `tone` (clamped 0.3..1)
 *
 * Registered as `'dp-drum-hat'`.
 */

/** DaisySP's `Svf`, inlined — worklets cannot import. See drum_kick for notes. */
class HatSvf {
  private sr = 48000
  private fcMax = 16000
  private freq = 0.25
  private damp = 0
  private res = 0.5
  private drive = 0.5
  private preDrive = 0.5
  private low = 0
  private high = 0
  private band = 0
  private notch = 0
  outBand = 0
  outHigh = 0

  init(sampleRate: number): void {
    this.sr = sampleRate
    this.fcMax = sampleRate / 3
    this.freq = 0.25
    this.damp = 0
    this.res = 0.5
    this.drive = 0.5
    this.preDrive = 0.5
    this.low = 0
    this.high = 0
    this.band = 0
    this.notch = 0
    this.outBand = 0
    this.outHigh = 0
  }

  setFreq(f: number): void {
    const fc = f < 1e-6 ? 1e-6 : f > this.fcMax ? this.fcMax : f
    const arg = fc / (this.sr * 2)
    this.freq = 2 * Math.sin(Math.PI * (arg < 0.25 ? arg : 0.25))
    this.recalcDamp()
  }

  setRes(r: number): void {
    this.res = r < 0 ? 0 : r > 1 ? 1 : r
    this.recalcDamp()
    this.drive = this.preDrive * this.res
  }

  private recalcDamp(): void {
    const a = 2 * (1 - Math.pow(this.res, 0.25))
    const b = 2 / this.freq - this.freq * 0.5
    const inner = 2 < b ? 2 : b
    this.damp = a < inner ? a : inner
  }

  process(input: number): void {
    this.notch = input - this.damp * this.band
    this.low = this.low + this.freq * this.band
    this.high = this.notch - this.low
    this.band = this.freq * this.high + this.band - this.drive * this.band * this.band * this.band
    this.outBand = 0.5 * this.band
    this.outHigh = 0.5 * this.high
    this.notch = input - this.damp * this.band
    this.low = this.low + this.freq * this.band
    this.high = this.notch - this.low
    this.band = this.freq * this.high + this.band - this.drive * this.band * this.band * this.band
    this.outBand += 0.5 * this.band
    this.outHigh += 0.5 * this.high
  }
}

class DrumHatProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'decay', defaultValue: 0.08, minValue: 0.01, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.7, minValue: 0.3, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  /** Six square oscillators at the 808's inharmonic ratios. */
  private readonly noisePhase = new Uint32Array(6)
  private readonly RATIOS = [1.0, 1.304, 1.466, 1.787, 1.932, 2.536]

  private readonly coloration = new HatSvf()
  private readonly hpf = new HatSvf()
  private ready = false

  private trigHigh = false
  private envelope = 0
  private noiseClock = 0
  private noiseSample = 0

  /** See the accent note in drum_kick — the emitter sets this to 1. */
  private readonly accent = 1
  /** `f0_` from `Init`'s `SetFreq(3000)`; the emitter never overrides it. */
  private f0 = 3000 / 48000
  /** `noisiness_` from `Init`'s `SetNoisiness(.8)`, squared by the setter. */
  private readonly noisiness = 0.8 * 0.8

  /** `SquareNoise::Process` — six wrapping accumulators, summed as sign bits. */
  private metallicNoise(f0: number): number {
    let noise = 0
    for (let i = 0; i < 6; i++) {
      let f = f0 * this.RATIOS[i]
      if (f >= 0.499) f = 0.499
      const increment = f * 4294967296
      this.noisePhase[i] = (this.noisePhase[i] + increment) >>> 0
      noise += this.noisePhase[i] >>> 31
    }
    return 0.33 * noise - 1
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

    if (!this.ready) {
      this.coloration.init(sampleRate)
      this.hpf.init(sampleRate)
      this.f0 = 3000 / sampleRate
      this.ready = true
    }

    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const decayCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const toneCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    let decay = parameters.decay[0] ?? 0.08
    if (decayCv) decay = decayCv[0]
    if (decay < 0.01) decay = 0.01
    else if (decay > 0.5) decay = 0.5
    let tone = parameters.tone[0] ?? 0.7
    if (toneCv) tone = toneCv[0]
    if (tone < 0.3) tone = 0.3
    else if (tone > 1) tone = 1

    // `SetDecay`: max(x, 0) * 1.7 - 1.2. Negative for every value this node
    // can produce, which is why the envelope decays as fast as it does.
    const decayScaled = (decay < 0 ? 0 : decay) * 1.7 - 1.2

    // `SemitonesToRatio(x)` is 2^(x/12).
    const envelopeDecay = 1 - 0.003 * Math.pow(2, (-decayScaled * 84) / 12)
    const cutDecay = 1 - 0.0025 * Math.pow(2, (-decayScaled * 36) / 12)

    let cutoff = (150 / sampleRate) * Math.pow(2, (tone * 72) / 12)
    const cutoffMax = 16000 / sampleRate
    if (cutoff < 0) cutoff = 0
    else if (cutoff > cutoffMax) cutoff = cutoffMax

    this.coloration.setFreq(cutoff * sampleRate)
    this.coloration.setRes(3 + 6 * tone)
    this.hpf.setFreq(cutoff * sampleRate)
    this.hpf.setRes(0.5)

    let noiseF = this.f0 * (16 + 16 * (1 - this.noisiness))
    if (noiseF < 0) noiseF = 0
    else if (noiseF > 0.5) noiseF = 0.5

    const sustainGain = this.accent * decayScaled
    void sustainGain // sustain_ is false; kept to mirror the source's shape.

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      if (nowHigh && !this.trigHigh) {
        this.envelope = (1.5 + 0.5 * (1 - decayScaled)) * (0.3 + 0.7 * this.accent)
      }
      this.trigHigh = nowHigh

      let out = this.metallicNoise(2 * this.f0)

      this.coloration.process(out)
      out = this.coloration.outBand

      // Not part of the 808 — clocked S&H noise blended in for variety.
      this.noiseClock += noiseF
      if (this.noiseClock >= 1) {
        this.noiseClock -= 1
        this.noiseSample = Math.random() - 0.5
      }
      out += this.noisiness * (this.noiseSample - out)

      // LinearVCA: s * gain.
      this.envelope *= this.envelope > 0.5 ? envelopeDecay : cutDecay
      out = out * this.envelope

      this.hpf.process(out)
      out = this.hpf.outHigh

      if (!isFinite(out)) {
        out = 0
        this.envelope = 0
        this.coloration.init(sampleRate)
        this.hpf.init(sampleRate)
      }
      outCh[i] = out
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-drum-hat', DrumHatProcessor)
