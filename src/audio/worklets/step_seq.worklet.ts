/// <reference path="./worklet.d.ts" />

/**
 * 8-step sequencer — advances step on rising edge of `clock` input
 * (prev<0.5, curr>=0.5). Optional `reset` input forces step back to 0 on
 * its rising edge. CV output holds the current step's value. Gate output
 * is the input clock masked by the current step's gate toggle, so the
 * emitted gate matches the clock's pulse width.
 * Registered as `'dp-step-seq'`.
 */

class StepSeqProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 's1', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 's2', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 's3', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 's4', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 's5', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 's6', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 's7', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 's8', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private step = 0
  private clkHigh = false
  private rstHigh = false
  private gates: boolean[] = [true, true, true, true, false, false, false, false]

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && typeof data.paramId === 'string') {
        const id = data.paramId as string
        const v = data.value
        if (id.length === 2 && id.charCodeAt(0) === 103 /* 'g' */) {
          const idx = parseInt(id.slice(1), 10) - 1
          if (idx >= 0 && idx < 8 && (v === 'on' || v === 'off')) {
            this.gates[idx] = v === 'on'
          }
        }
      }
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const cvOut = outputs[0]?.[0]
    const gateOut = outputs[1]?.[0]
    const n = cvOut?.length ?? gateOut?.length ?? 0
    if (n === 0) return true

    const clkCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const rstCh = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined

    const s1 = parameters.s1[0] ?? 0
    const s2 = parameters.s2[0] ?? 0
    const s3 = parameters.s3[0] ?? 0
    const s4 = parameters.s4[0] ?? 0
    const s5 = parameters.s5[0] ?? 0
    const s6 = parameters.s6[0] ?? 0
    const s7 = parameters.s7[0] ?? 0
    const s8 = parameters.s8[0] ?? 0

    for (let i = 0; i < n; i++) {
      const clkV = clkCh ? clkCh[i] : 0
      const rstV = rstCh ? rstCh[i] : 0
      const clkNow = clkV >= 0.5
      const rstNow = rstV >= 0.5

      if (rstNow && !this.rstHigh) {
        this.step = 0
      } else if (clkNow && !this.clkHigh) {
        this.step = (this.step + 1) & 7
      }
      this.clkHigh = clkNow
      this.rstHigh = rstNow

      let cv = 0
      switch (this.step) {
        case 0: cv = s1; break
        case 1: cv = s2; break
        case 2: cv = s3; break
        case 3: cv = s4; break
        case 4: cv = s5; break
        case 5: cv = s6; break
        case 6: cv = s7; break
        case 7: cv = s8; break
      }

      if (cvOut) cvOut[i] = cv
      if (gateOut) gateOut[i] = this.gates[this.step] ? clkV : 0
    }

    return true
  }
}

registerProcessor('dp-step-seq', StepSeqProcessor)
