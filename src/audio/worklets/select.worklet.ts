/// <reference path="./worklet.d.ts" />

/**
 * Four-way router.
 *
 * `sel` is 0..1 across the four inputs, which is what a `counter` or a
 * `state_machine` emits without anything in between — that is the whole
 * point of normalising those outputs.
 *
 * Crossfade mode blends between neighbours instead of switching. Switching
 * a live audio signal produces a click at the discontinuity; for a mode
 * selector that is fine and for a signal path it is not, so both are here
 * and neither is the default for the other's job.
 *
 * Registered as `'dp-select'`.
 */

class SelectProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [{ name: 'index', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' }]
  }

  private mode = 'switch'

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; paramId?: string; value?: unknown }
      if (d?.type === 'param' && d.paramId === 'mode') this.mode = String(d.value)
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const out = output[0]
    if (!out) return true

    const src = [0, 1, 2, 3].map((k) =>
      inputs[k] && inputs[k].length > 0 ? inputs[k][0] : undefined
    )
    const sel = inputs[4] && inputs[4].length > 0 ? inputs[4][0] : undefined
    const fade = this.mode === 'crossfade'
    const n = out.length
    const fixed = Math.round(parameters.index[0] ?? 0)

    for (let i = 0; i < n; i++) {
      let pos: number
      if (sel) {
        let s = sel[i]
        if (s < 0) s = 0
        else if (s > 1) s = 1
        pos = s * 3
      } else {
        pos = fixed < 0 ? 0 : fixed > 3 ? 3 : fixed
      }

      let v: number
      if (fade) {
        const i0 = Math.floor(pos)
        const i1 = i0 + 1 <= 3 ? i0 + 1 : 3
        const f = pos - i0
        const a = src[i0] ? src[i0]![i] : 0
        const b = src[i1] ? src[i1]![i] : 0
        v = a * (1 - f) + b * f
      } else {
        const k = Math.round(pos)
        v = src[k] ? src[k]![i] : 0
      }
      if (!isFinite(v)) v = 0
      out[i] = v
    }

    for (let c = 1; c < output.length; c++) output[c].set(out)
    return true
  }
}

registerProcessor('dp-select', SelectProcessor)
