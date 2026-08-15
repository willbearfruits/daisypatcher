/// <reference path="./worklet.d.ts" />

/**
 * Overdrive — a port of DaisySP's `Overdrive`, plus the 1-pole low-pass
 * tone control this node has always shown in its sidebar.
 *
 * The saturator used to be `tanh(x * gain) / tanh(gain)`, which is a
 * perfectly reasonable soft clipper and not the one the device runs.
 * DaisySP squares and quintics its way to a pre-gain, soft-clips, then
 * divides by a post-gain derived from the same drive — the result is
 * louder and differently shaped, and `npm run test:audio` measured the two
 * 56% apart.
 *
 * `tone` was worse than a mismatch: the emitter never implemented it at
 * all, so the knob did nothing once you flashed. Both sides now run the
 * same one-pole, cutoff from ~500 Hz to ~10 kHz.
 *
 * Registered as `'dp-overdrive'`.
 */

class OverdriveProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'drive', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private lpZ = 0

  /** DaisySP's `SoftClip`: hard past +/-3, `SoftLimit` inside. */
  private softClip(x: number): number {
    if (x < -3) return -1
    if (x > 3) return 1
    return (x * (27 + x * x)) / (27 + 9 * x * x)
  }

  /**
   * `Overdrive::SetDrive`, verbatim.
   *
   * Returns the pre/post gain pair rather than storing it, because the CV
   * path recomputes per sample and the sidebar path once per block.
   */
  private gainsFor(drive: number): { pre: number; post: number } {
    const d = drive < 0 ? 0 : drive > 1 ? 1 : drive
    const drive2x = 2 * d
    const sq = drive2x * drive2x
    const preA = drive2x * 0.5
    const preB = sq * sq * drive2x * 24
    const pre = preA + (preB - preA) * sq
    const squashed = drive2x * (2 - drive2x)
    const post = 1 / this.softClip(0.33 + squashed * (pre - 0.33))
    return { pre, post }
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
    // Wave 2 cv_drive at index 1 — replace-semantics override, clamped 0..1.
    const driveCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const driveBase = parameters.drive[0] ?? 0.3
    const tone = parameters.tone[0] ?? 0.5

    // Tone: one-pole LP, cutoff from ~500 Hz to ~10 kHz. Block-rate.
    const cutoff = 500 + tone * 9500
    const rc = 1 / (2 * Math.PI * cutoff)
    const dt = 1 / sampleRate
    const alpha = dt / (rc + dt)

    // Precompute block-rate saturation coefs when no CV.
    const gainsK = this.gainsFor(driveBase)

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0
      const g = driveCv ? this.gainsFor(driveCv[i]) : gainsK
      const sat = this.softClip(g.pre * x) * g.post
      this.lpZ = this.lpZ + alpha * (sat - this.lpZ)
      outCh[i] = this.lpZ
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-overdrive', OverdriveProcessor)
