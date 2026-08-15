/// <reference path="./worklet.d.ts" />

/**
 * Snare drum — a port of DaisySP's `AnalogSnareDrum`.
 *
 * Same story as the kick: the emulator used to synthesize a snare (noise
 * burst + tuned tone) while the device ran a modal model — five resonators
 * excited by a pulse, plus a band-passed noise channel, summed through a
 * soft clipper. `npm run test:audio` measured 59.8% apart on level, and,
 * worse, the firmware peaked at **1.29** — it was clipping on hardware
 * while the app showed a clean 0.955. That is the failure mode this whole
 * test layer exists to catch: a patch you approve by ear in the app and
 * that distorts on the device.
 *
 * Two details that are easy to get wrong and were:
 *   - the node's `tone` param drives `SetSnappy`, not `SetTone`. DaisySP's
 *     `tone_` is left at its `Init` default (0.5, doubled by the setter to
 *     1.0) because nothing ever sets it.
 *   - `SetTone` multiplies by 2 on the way in, and `Process` then branches
 *     on `tone < 0.666667`, so the stored value and the knob value live in
 *     different domains.
 *
 * The noise channel uses `rand()` on the device and `Math.random()` here,
 * so the two will never agree sample-for-sample. Level and character do,
 * which is what a preview owes you.
 *
 * Inputs:
 *   0  trigger  — gate
 *   1  cv_tune  — replaces sidebar `tune` (Hz, clamped 100..400)
 *   2  cv_decay — replaces sidebar `decay` (clamped 0.05..1)
 *   3  cv_noise — replaces sidebar `tone` → snappy (0..1)
 *
 * Registered as `'dp-drum-snare'`.
 */

/** DaisySP's `Svf`, inlined — worklets cannot import. See drum_kick for notes. */
class SnareSvf {
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
    this.notch = input - this.damp * this.band
    this.low = this.low + this.freq * this.band
    this.high = this.notch - this.low
    this.band = this.freq * this.high + this.band - this.drive * this.band * this.band * this.band
    this.outBand += 0.5 * this.band
  }
}

class DrumSnareProcessor extends AudioWorkletProcessor {
  private readonly NUM_MODES = 5

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'tune', defaultValue: 200, minValue: 100, maxValue: 400, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.2, minValue: 0.05, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly resonators = [
    new SnareSvf(),
    new SnareSvf(),
    new SnareSvf(),
    new SnareSvf(),
    new SnareSvf()
  ]
  private readonly noiseFilter = new SnareSvf()
  private readonly phase = [0, 0, 0, 0, 0]
  private ready = false

  private trigHigh = false
  private pulseRemaining = 0
  private pulse = 0
  private pulseHeight = 0
  private pulseLp = 0
  private noiseEnvelope = 0

  /** See the accent note in drum_kick — the emitter sets this to 1. */
  private readonly accent = 1
  /** `tone_` after DaisySP's `SetTone(.5)` in `Init`, which doubles it. */
  private readonly toneInternal = 1

  private softClip(x: number): number {
    if (x < -3) return -1
    if (x > 3) return 1
    return (x * (27 + x * x)) / (27 + 9 * x * x)
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
      for (const r of this.resonators) r.init(sampleRate)
      this.noiseFilter.init(sampleRate)
      this.ready = true
    }

    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const tuneCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const decayCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const noiseCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    let tune = parameters.tune[0] ?? 200
    if (tuneCv) {
      tune = tuneCv[0]
      if (tune < 100) tune = 100
      else if (tune > 400) tune = 400
    }
    let decay = parameters.decay[0] ?? 0.2
    if (decayCv) decay = decayCv[0]
    if (decay < 0.05) decay = 0.05
    else if (decay > 1) decay = 1
    let snappyKnob = parameters.tone[0] ?? 0.5
    if (noiseCv) snappyKnob = noiseCv[0]
    if (snappyKnob < 0) snappyKnob = 0
    else if (snappyKnob > 1) snappyKnob = 1

    // `SetFreq` normalises and clamps at 0.4 (not 0.5) for this voice.
    let f0 = tune / sampleRate
    if (f0 < 0) f0 = 0
    else if (f0 > 0.4) f0 = 0.4

    // `SetDecay` only clamps to >= 0 here — no rescale, unlike the kick's.
    const decayScaled = decay < 0 ? 0 : decay
    const snappyStored = snappyKnob

    const kOneTwelfth = 1 / 12
    const decayXt = decayScaled * (1 + decayScaled * (decayScaled - 1))
    const kTriggerPulseDuration = Math.trunc(1.0e-3 * sampleRate)
    const kPulseDecayTime = 0.1e-3 * sampleRate
    const q = 2000 * Math.pow(2, kOneTwelfth * decayXt * 84)
    const noiseEnvelopeDecay =
      1 - 0.0017 * Math.pow(2, kOneTwelfth * (-decayScaled * (50 + snappyStored * 10)))
    const exciterLeak = snappyStored * (2 - snappyStored) * 0.1

    let snappy = snappyStored * 1.1 - 0.05
    if (snappy < 0) snappy = 0
    else if (snappy > 1) snappy = 1

    // Mode frequencies and gains are constant for the block — the knobs are
    // k-rate, so recomputing them per sample would only cost time.
    const modeRatios = [1.0, 2.0, 3.18, 4.16, 5.62]
    const f: number[] = []
    for (let m = 0; m < this.NUM_MODES; m++) {
      const fm = f0 * modeRatios[m]
      f.push(fm < 0.499 ? fm : 0.499)
      this.resonators[m].setFreq(f[m] * sampleRate)
      this.resonators[m].setRes(f[m] * (m === 0 ? q : q * 0.25) * 0.2)
    }

    const gain: number[] = []
    let tone = this.toneInternal
    if (tone < 0.666667) {
      // 808-style: two modes only.
      tone *= 1.5
      gain.push(1.5 + (1 - tone) * (1 - tone) * 4.5)
      gain.push(2 * tone + 0.15)
      for (let m = 2; m < this.NUM_MODES; m++) gain.push(0)
    } else {
      tone = (tone - 0.666667) * 3
      gain.push(1.5 - tone * 0.5)
      gain.push(2.15 - tone * 0.7)
      for (let m = 2; m < this.NUM_MODES; m++) {
        gain.push(tone)
        tone *= tone
      }
    }

    const fNoise = f0 * 16
    this.noiseFilter.setFreq(fNoise * sampleRate)
    this.noiseFilter.setRes(fNoise * 1.5)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      if (nowHigh && !this.trigHigh) {
        this.pulseRemaining = kTriggerPulseDuration
        this.pulseHeight = 3 + 7 * this.accent
        this.noiseEnvelope = 2
      }
      this.trigHigh = nowHigh

      // Q45 / Q46.
      let pulse: number
      if (this.pulseRemaining) {
        this.pulseRemaining--
        pulse = this.pulseRemaining ? this.pulseHeight : this.pulseHeight - 1
        this.pulse = pulse
      } else {
        this.pulse *= 1 - 1 / kPulseDecayTime
        pulse = this.pulse
      }

      // R189 / C57 / R190 — note this is a clamp, not a filter, despite the
      // name: `fclamp(pulse_lp_, pulse, 0.75f)` with the CURRENT pulse as
      // the lower bound.
      let plp = this.pulseLp
      if (plp < pulse) plp = pulse
      if (plp > 0.75) plp = 0.75
      this.pulseLp = plp

      let shell = 0
      for (let m = 0; m < this.NUM_MODES; m++) {
        const excitation = m === 0 ? pulse - plp + 0.006 * pulse : 0.026 * pulse
        this.phase[m] += f[m]
        if (this.phase[m] >= 1) this.phase[m] -= 1
        this.resonators[m].process(excitation)
        shell += gain[m] * (this.resonators[m].outBand + excitation * exciterLeak)
      }
      shell = this.softClip(shell)

      // C56 / R194 / Q48 — half-wave rectified noise into its own envelope.
      let noise = 2 * Math.random() - 1
      if (noise < 0) noise = 0
      this.noiseEnvelope *= noiseEnvelopeDecay
      noise *= this.noiseEnvelope * snappy * 2

      // C66 / R201 / Q49.
      this.noiseFilter.process(noise)
      noise = this.noiseFilter.outBand

      let y = noise + shell * (1 - snappy)
      if (!isFinite(y)) {
        y = 0
        this.pulse = 0
        this.noiseEnvelope = 0
        for (const r of this.resonators) r.init(sampleRate)
        this.noiseFilter.init(sampleRate)
      }
      outCh[i] = y
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-drum-snare', DrumSnareProcessor)
