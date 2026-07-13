/// <reference path="./worklet.d.ts" />

/**
 * Range remap — Max/PD-style `scale`.
 *
 *   out = out_min + (in - in_min) * (out_max - out_min) / (in_max - in_min)
 *
 * When `clamp` is on (default), the output is held inside
 * [min(out_min,out_max), max(out_min,out_max)] so a knob at its rails
 * doesn't drive a frequency negative or a gain past its useful ceiling.
 *
 * Registered as `'dp-range'`.
 */

class RangeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    const common = {
      minValue: -1e6,
      maxValue: 1e6,
      automationRate: 'k-rate' as const
    }
    return [
      { name: 'in_min',  defaultValue: 0, ...common },
      { name: 'in_max',  defaultValue: 1, ...common },
      { name: 'out_min', defaultValue: 0, ...common },
      { name: 'out_max', defaultValue: 1, ...common },
      // Clamp on/off encoded as 0/1 (enum param 'on'/'off' mapped in the
      // inspector/worklet bridge). Default 1 = clamp on.
      {
        name: 'clamp',
        defaultValue: 1,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate' as const
      }
    ]
  }

  // Enum bridge: when the `clamp` enum param mutates, the engine posts a
  // message to the worklet. We translate 'on'/'off' into the k-rate AudioParam.
  private clampOn = 1
  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'clamp') {
        this.clampOn = data.value === 'off' ? 0 : 1
      }
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

    const inMin  = parameters.in_min[0]  ?? 0
    const inMax  = parameters.in_max[0]  ?? 1
    const outMin = parameters.out_min[0] ?? 0
    const outMax = parameters.out_max[0] ?? 1
    const clampOn = (parameters.clamp[0] ?? this.clampOn) > 0.5

    const inSpan  = inMax  - inMin
    const outSpan = outMax - outMin
    const invSpan = inSpan === 0 ? 0 : 1 / inSpan

    const lo = Math.min(outMin, outMax)
    const hi = Math.max(outMin, outMax)

    const inCh = inputs[0]?.[0]
    const n = out.length
    if (inCh && inCh.length > 0) {
      for (let i = 0; i < n; i++) {
        let v = outMin + (inCh[i] - inMin) * outSpan * invSpan
        if (clampOn) v = v < lo ? lo : v > hi ? hi : v
        out[i] = v
      }
    } else {
      // Nothing connected — emit a steady out_min so downstream doesn't
      // freak out on NaNs/unknowns.
      out.fill(outMin)
    }
    for (let c = 1; c < output.length; c++) output[c].set(out)
    return true
  }
}

registerProcessor('dp-range', RangeProcessor)
