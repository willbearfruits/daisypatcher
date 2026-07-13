/// <reference path="./worklet.d.ts" />

/**
 * Phaser — N cascaded 1-pole allpass filters swept by an internal sine LFO.
 * Break frequency sweeps between ~200 Hz and ~4000 Hz, scaled by `depth`.
 * Feedback from the last stage's output into the first stage's input.
 * `stages` (enum, 4/6/8) selects how many allpass stages cascade.
 * Registered as `'dp-phaser'`.
 */

class PhaserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 0.5, minValue: 0.05, maxValue: 8, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 0.9, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ]
  }

  private readonly TWO_PI = Math.PI * 2
  private readonly MAX_STAGES = 8
  private stages = 4
  private z: Float32Array = new Float32Array(this.MAX_STAGES)
  private lfoPhase = 0
  private fbState = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'stages') {
        const v = data.value as string
        if (v === '4') this.stages = 4
        else if (v === '6') this.stages = 6
        else if (v === '8') this.stages = 8
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
    const outCh = output[0]
    if (!outCh) return true

    const inCh = inputs[0] && inputs[0].length > 0 ? inputs[0][0] : undefined
    const rateCv = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : undefined
    const depthCv = inputs[2] && inputs[2].length > 0 ? inputs[2][0] : undefined
    const fbCv = inputs[3] && inputs[3].length > 0 ? inputs[3][0] : undefined
    const mixCv = inputs[4] && inputs[4].length > 0 ? inputs[4][0] : undefined

    const rateBase = parameters.rate[0] ?? 0.5
    const depthBase = parameters.depth[0] ?? 0.7
    const fbBase = parameters.feedback[0] ?? 0.5
    const mixBase = parameters.mix[0] ?? 0.5

    const sr = sampleRate
    const stages = this.stages
    const z = this.z

    // Log-sweep between 200 Hz and 4000 Hz. LFO in [-1,1] scaled by depth.
    const logMin = Math.log(200)
    const logMax = Math.log(4000)
    const center = (logMin + logMax) * 0.5
    const halfRange = (logMax - logMin) * 0.5

    const n = outCh.length
    for (let i = 0; i < n; i++) {
      const x = inCh ? inCh[i] : 0

      let rate = rateBase
      if (rateCv) {
        rate = rateCv[i]
        if (rate < 0.05) rate = 0.05
        else if (rate > 8) rate = 8
      }
      let depth = depthBase
      if (depthCv) {
        depth = depthCv[i]
        if (depth < 0) depth = 0
        else if (depth > 1) depth = 1
      }
      let fb = fbBase
      if (fbCv) {
        fb = fbCv[i]
        if (fb < 0) fb = 0
        else if (fb > 0.9) fb = 0.9
      }
      let mix = mixBase
      if (mixCv) {
        mix = mixCv[i]
        if (mix < 0) mix = 0
        else if (mix > 1) mix = 1
      }
      const phaseInc = (this.TWO_PI * rate) / sr

      const lfo = Math.sin(this.lfoPhase)
      const logF = center + lfo * halfRange * depth
      let f = Math.exp(logF)
      if (f < 20) f = 20
      else if (f > sr * 0.45) f = sr * 0.45

      // 1-pole allpass coefficient: a1 = (tan(pi*f/sr) - 1) / (tan(pi*f/sr) + 1)
      const t = Math.tan(Math.PI * f / sr)
      const a1 = (t - 1) / (t + 1)

      // Feedback: inject previous output of the last stage back into the chain.
      let v = x + this.fbState * fb
      // Cascade allpass stages: y = a1 * v + z, z = v - a1 * y
      for (let s = 0; s < stages; s++) {
        const y = a1 * v + z[s]
        z[s] = v - a1 * y
        v = y
      }
      // Denormal / NaN guard.
      if (!isFinite(v)) v = 0
      this.fbState = v

      outCh[i] = x * (1 - mix) + v * mix

      this.lfoPhase += phaseInc
      if (this.lfoPhase >= this.TWO_PI) this.lfoPhase -= this.TWO_PI
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-phaser', PhaserProcessor)
