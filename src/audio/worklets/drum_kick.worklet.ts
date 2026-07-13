/// <reference path="./worklet.d.ts" />

/**
 * Kick drum. On every rising edge of the trigger input we retrigger:
 *   - amp env: fast attack shaped by `punch`, exponential decay of length
 *     `decay` seconds.
 *   - pitch env: starts at tune * (1 + sweep * 2), falls exponentially to
 *     `tune` over ~30 ms.
 * A single sine oscillator tracks the swept pitch.
 *
 * Inputs:
 *   0  trigger  — gate
 *   1  cv_tune  — replaces sidebar `tune` (Hz, clamped 30..200)
 *   2  cv_decay — replaces sidebar `decay` (s, clamped 0.05..2)
 *   3  cv_punch — replaces sidebar `punch` (0..1)
 *
 * Registered as `'dp-drum-kick'`.
 */

class DrumKickProcessor extends AudioWorkletProcessor {
  private readonly TWO_PI = Math.PI * 2

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'tune', defaultValue: 60, minValue: 30, maxValue: 200, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.35, minValue: 0.05, maxValue: 2, automationRate: 'k-rate' },
      { name: 'punch', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'sweep', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private phase = 0
  private trigHigh = false
  // Pitch env state: exponential decay from 1 (top of sweep) to 0 (bottom).
  private pitchEnv = 0
  // Amp env state: attack in [0,1] then exp-decay.
  private ampEnv = 0
  // `attacking` flag keeps the envelope in a short attack phase shaped by
  // punch. Higher punch = shorter attack.
  private ampAttack = 0 // 0..1; when >=1, attack is done
  private attacking = false

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outCh = output[0]
    if (!outCh) return true

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
    if (decayCv) {
      decay = decayCv[0]
    }
    if (decay < 0.05) decay = 0.05
    else if (decay > 2) decay = 2
    let punch = parameters.punch[0] ?? 0.5
    if (punchCv) {
      punch = punchCv[0]
      if (punch < 0) punch = 0
      else if (punch > 1) punch = 1
    }
    const sweep = parameters.sweep[0] ?? 0.6

    // Exponential decay coefficients: env *= coef each sample.
    // After N samples we want env ≈ exp(-N / tau) — solve coef = exp(-1 / (tau*SR)).
    const ampCoef = Math.exp(-1 / (decay * sampleRate))
    const pitchTau = 0.03 // ~30 ms sweep
    const pitchCoef = Math.exp(-1 / (pitchTau * sampleRate))

    // Attack rate: higher punch = steeper (reach 1 in fewer samples).
    // punch=0 → ~8 ms, punch=1 → ~1 ms.
    const attackSeconds = 0.008 - punch * 0.007
    const attackInc = 1 / (attackSeconds * sampleRate)

    const twoPi = this.TWO_PI
    const topMul = 1 + sweep * 2
    const n = outCh.length

    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      if (nowHigh && !this.trigHigh) {
        this.pitchEnv = 1
        this.ampEnv = 0
        this.ampAttack = 0
        this.attacking = true
        this.phase = 0
      }
      this.trigHigh = nowHigh

      // Update amp envelope.
      if (this.attacking) {
        this.ampAttack += attackInc
        if (this.ampAttack >= 1) {
          this.ampAttack = 1
          this.attacking = false
          this.ampEnv = 1
        } else {
          this.ampEnv = this.ampAttack
        }
      } else {
        this.ampEnv *= ampCoef
      }
      // Update pitch envelope.
      this.pitchEnv *= pitchCoef

      // Instantaneous frequency = tune * (1 + sweep*2 * pitchEnv), but we want
      // it to settle at `tune`. So freq = tune * (1 + (topMul - 1) * pitchEnv).
      const freq = tune * (1 + (topMul - 1) * this.pitchEnv)
      const inc = (twoPi * freq) / sampleRate
      let y = Math.sin(this.phase) * this.ampEnv
      if (!isFinite(y)) { y = 0; this.ampEnv = 0; this.pitchEnv = 0; this.phase = 0 }
      if (y > 1) y = 1
      else if (y < -1) y = -1
      outCh[i] = y

      this.phase += inc
      if (this.phase >= twoPi) this.phase -= twoPi
      else if (this.phase < 0) this.phase += twoPi
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-drum-kick', DrumKickProcessor)
