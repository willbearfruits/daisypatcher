/// <reference path="./worklet.d.ts" />

/**
 * Kick drum — a port of DaisySP's `AnalogBassDrum`.
 *
 * This used to be a hand-written 808-ish sine-with-pitch-sweep, which is a
 * perfectly good kick and was not the one the device plays. `npm run
 * test:audio` measured the gap at 98.7%: the emulator peaked at 1.0 and the
 * firmware at 0.06, because DaisySP models the circuit (a pulse exciting a
 * resonant filter through a diode) rather than synthesizing the result, and
 * a circuit's natural output level is whatever it happens to be.
 *
 * Matching the level alone would have left the two sounding different —
 * a swept sine and a struck resonator are not the same instrument. So this
 * is the same algorithm, transliterated, and the preview is now the thing
 * you are previewing.
 *
 * `sweep` is kept as a param for patch compatibility but no longer does
 * anything: the model's pitch movement comes out of its self-FM and attack
 * FM terms, and there is no separate sweep amount to expose. The emitter
 * ignores it for the same reason.
 *
 * Inputs:
 *   0  trigger  — gate
 *   1  cv_tune  — replaces sidebar `tune` (Hz, clamped 30..200)
 *   2  cv_decay — replaces sidebar `decay` (s, clamped 0.05..2)
 *   3  cv_punch — replaces sidebar `punch` (0..1)
 *
 * Registered as `'dp-drum-kick'`.
 */

/**
 * DaisySP's `Svf`, inlined.
 *
 * Worklets cannot import — each file is loaded standalone into
 * `AudioWorkletGlobalScope` — so the shared filter is copied into each
 * drum that needs one rather than factored out. Three copies of forty
 * lines is the cost of the isolation contract.
 *
 * Note the double-sampling: `Process` runs the difference equation twice
 * per input sample and averages, which is why `SetFreq` divides by
 * `sr * 2`. Getting that wrong detunes every resonance.
 */
class KickSvf {
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
  outLow = 0
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
    this.outLow = 0
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
    // First pass.
    this.notch = input - this.damp * this.band
    this.low = this.low + this.freq * this.band
    this.high = this.notch - this.low
    this.band = this.freq * this.high + this.band - this.drive * this.band * this.band * this.band
    this.outLow = 0.5 * this.low
    this.outBand = 0.5 * this.band
    // Second pass.
    this.notch = input - this.damp * this.band
    this.low = this.low + this.freq * this.band
    this.high = this.notch - this.low
    this.band = this.freq * this.high + this.band - this.drive * this.band * this.band * this.band
    this.outLow += 0.5 * this.low
    this.outBand += 0.5 * this.band
  }
}

class DrumKickProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'tune', defaultValue: 60, minValue: 30, maxValue: 200, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.35, minValue: 0.05, maxValue: 2, automationRate: 'k-rate' },
      { name: 'punch', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'sweep', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly resonator = new KickSvf()
  private ready = false

  private trigHigh = false
  private pulseRemaining = 0
  private fmPulseRemaining = 0
  private pulse = 0
  private pulseHeight = 0
  private pulseLp = 0
  private fmPulseLp = 0
  private retrigPulse = 0
  private lpOut = 0
  private toneLp = 0

  /**
   * Accent, held at full scale.
   *
   * DaisySP's `Init` leaves it at 0.1 for this voice, which is where most
   * of the original level gap came from. The emitter sets it to 1
   * explicitly for the same reason: a voice's level should be the patch's
   * business, not a library default nothing in the UI mentions.
   */
  private readonly accent = 1
  /** `tone_` — not exposed as a param; DaisySP's own default. */
  private readonly tone = 0.1
  /**
   * `SetSelfFmAmount(1)` in the emitter's init, and DaisySP's setter
   * multiplies by 50 before storing. Every one of this voice's setters
   * rescales its argument on the way in — `SetDecay` is `x * 0.1 - 0.1`,
   * `SetAttackFmAmount` is `x * 50` — so a port that stores what the
   * caller passed models a different drum. That mistake alone accounted
   * for most of the level gap this port was written to close.
   */
  private readonly selfFmAmount = 50

  private diode(x: number): number {
    if (x >= 0) return x
    const y = x * 2
    return (0.7 * y) / (1 + Math.abs(y))
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
      this.resonator.init(sampleRate)
      this.ready = true
    }

    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const tuneCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const decayCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const punchCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined

    // Replace-semantics: CV first-sample overrides sidebar, clamped to param range.
    let tune = parameters.tune[0] ?? 60
    if (tuneCv) {
      tune = tuneCv[0]
      if (tune < 30) tune = 30
      else if (tune > 200) tune = 200
    }
    let decay = parameters.decay[0] ?? 0.35
    if (decayCv) decay = decayCv[0]
    if (decay < 0.05) decay = 0.05
    else if (decay > 2) decay = 2
    let punch = parameters.punch[0] ?? 0.5
    if (punchCv) {
      punch = punchCv[0]
      if (punch < 0) punch = 0
      else if (punch > 1) punch = 1
    }

    // `SetFreq` normalises to cycles/sample and clamps at Nyquist.
    let f0 = tune / sampleRate
    if (f0 < 0) f0 = 0
    else if (f0 > 0.5) f0 = 0.5

    const kTriggerPulseDuration = Math.trunc(1.0e-3 * sampleRate)
    const kFMPulseDuration = Math.trunc(6.0e-3 * sampleRate)
    const kPulseDecayTime = 0.2e-3 * sampleRate
    const kPulseFilterTime = 0.1e-3 * sampleRate
    const kRetrigPulseDuration = 0.05 * sampleRate
    const kOneTwelfth = 1 / 12

    // The setter transforms, applied exactly as DaisySP applies them.
    const decayScaled = decay * 0.1 - 0.1
    const attackFmAmount = punch * 50

    const scale = 0.001 / f0
    const q = 1500 * Math.pow(2, kOneTwelfth * decayScaled * 80)
    const toneFRaw = 4 * f0 * Math.pow(2, kOneTwelfth * this.tone * 108)
    const toneF = toneFRaw < 1 ? toneFRaw : 1
    const exciterLeak = 0.08 * (this.tone + 0.25)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      if (nowHigh && !this.trigHigh) {
        this.pulseRemaining = kTriggerPulseDuration
        this.fmPulseRemaining = kFMPulseDuration
        this.pulseHeight = 3 + 7 * this.accent
        this.lpOut = 0
      }
      this.trigHigh = nowHigh

      // Q39 / Q40 — the trigger pulse and its decay tail.
      let pulse: number
      if (this.pulseRemaining) {
        this.pulseRemaining--
        pulse = this.pulseRemaining ? this.pulseHeight : this.pulseHeight - 1
        this.pulse = pulse
      } else {
        this.pulse *= 1 - 1 / kPulseDecayTime
        pulse = this.pulse
      }

      // C40 / R163 / R162 / D83 — high-pass through a diode.
      this.pulseLp += (1 / kPulseFilterTime) * (pulse - this.pulseLp)
      pulse = this.diode(pulse - this.pulseLp + pulse * 0.044)

      // Q41 / Q42 — the FM pulse that gives the attack its pitch drop.
      let fmPulse = 0
      if (this.fmPulseRemaining) {
        this.fmPulseRemaining--
        fmPulse = 1
        this.retrigPulse = this.fmPulseRemaining ? 0 : -0.8
      } else {
        this.retrigPulse *= 1 - 1 / kRetrigPulseDuration
      }
      this.fmPulseLp += (1 / kPulseFilterTime) * (fmPulse - this.fmPulseLp)

      // Q43 / R170 leakage, then R165 — the two FM terms.
      const punchTerm = 0.7 + this.diode(10 * this.lpOut - 1)
      const attackFm = this.fmPulseLp * 1.7 * attackFmAmount
      const selfFm = punchTerm * 0.08 * this.selfFmAmount
      let f = f0 * (1 + attackFm + selfFm)
      if (f < 0) f = 0
      else if (f > 0.4) f = 0.4

      this.resonator.setFreq(f * sampleRate)
      this.resonator.setRes(0.4 * q * f)
      this.resonator.process((pulse - this.retrigPulse * 0.2) * scale)
      const resonatorOut = this.resonator.outBand
      this.lpOut = this.resonator.outLow

      this.toneLp += toneF * (pulse * exciterLeak + resonatorOut - this.toneLp)

      let y = this.toneLp
      if (!isFinite(y)) {
        y = 0
        this.toneLp = 0
        this.lpOut = 0
        this.pulse = 0
        this.resonator.init(sampleRate)
      }
      outCh[i] = y
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-drum-kick', DrumKickProcessor)
