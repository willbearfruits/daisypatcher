/// <reference path="./worklet.d.ts" />

/**
 * Preset recall — the emulator half.
 *
 * The firmware half writes generated globals directly (see
 * `presetCodegen.ts`). In the app there are no globals to write: a preset
 * lives in the Zustand store and recalling it is a store transaction, on
 * the main thread. So this worklet does not apply anything. It watches the
 * trigger and the morph CV and posts a request out through its port; the
 * engine forwards it to the store.
 *
 * THROTTLING IS NOT OPTIONAL HERE. A morph CV is an audio-rate signal, and
 * a naive implementation would ask the store to rewrite every numeric param
 * in the patch 48,000 times a second — each one an undo entry, each one a
 * React render. So morph posts are rate-limited and quantised: at most one
 * per ~30 ms, and only when the value has actually moved a step. Recalls
 * are edge-driven and rare, so they post immediately.
 *
 * `changed` fires for one sample on a recall, matching the emitter. Morph
 * mode never fires it — a continuous walk has no moment to mark.
 *
 * Inputs:
 *   0  trigger  — gate, rising edge recalls
 *   1  cv_slot  — replaces sidebar `slot`
 *   2  cv_morph — morph position 0..1
 *
 * Registered as `'dp-preset-recall'`.
 */

class PresetRecallProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'slot', defaultValue: 0, minValue: 0, maxValue: 31, automationRate: 'k-rate' },
      { name: 'morph_a', defaultValue: 0, minValue: 0, maxValue: 31, automationRate: 'k-rate' },
      { name: 'morph_b', defaultValue: 1, minValue: 0, maxValue: 31, automationRate: 'k-rate' }
    ]
  }

  private mode: 'recall' | 'morph' = 'recall'
  private trigHigh = false

  /** Frames since the last morph post — the rate limit. */
  private sinceMorph = 0
  /** Last morph value posted, quantised. Avoids reposting a still knob. */
  private lastMorph = -1

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; paramId?: string; value?: unknown }
      if (data?.type === 'param' && data.paramId === 'mode') {
        this.mode = data.value === 'morph' ? 'morph' : 'recall'
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    const outCh = output && output.length > 0 ? output[0] : undefined

    const trigCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const slotCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const morphCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined

    const n = outCh?.length ?? 128

    if (this.mode === 'morph') {
      // ~30 ms at 48 kHz / 128-sample quanta is roughly every 11 blocks.
      const throttleFrames = Math.round(sampleRate * 0.03)
      this.sinceMorph += n
      if (this.sinceMorph >= throttleFrames) {
        this.sinceMorph = 0
        let t = morphCv ? morphCv[0] : 0
        if (t < 0) t = 0
        else if (t > 1) t = 1
        // Quantise to 1/200 — finer than anyone hears on a morph, coarse
        // enough that a noisy CV does not stream redundant updates.
        const q = Math.round(t * 200) / 200
        if (q !== this.lastMorph) {
          this.lastMorph = q
          this.port.postMessage({
            type: 'preset',
            action: 'morph',
            a: Math.round(parameters.morph_a[0] ?? 0),
            b: Math.round(parameters.morph_b[0] ?? 1),
            t: q
          })
        }
      }
      if (outCh) outCh.fill(0)
      return true
    }

    for (let i = 0; i < n; i++) {
      const tv = trigCh ? trigCh[i] : 0
      const nowHigh = tv >= 0.5
      const edge = nowHigh && !this.trigHigh
      this.trigHigh = nowHigh
      if (edge) {
        const slot = slotCv ? slotCv[i] : (parameters.slot[0] ?? 0)
        this.port.postMessage({ type: 'preset', action: 'apply', slot: Math.round(slot) })
      }
      if (outCh) outCh[i] = edge ? 1 : 0
    }

    if (output) for (let c = 1; c < output.length; c++) output[c].set(outCh!)
    return true
  }
}

registerProcessor('dp-preset-recall', PresetRecallProcessor)
