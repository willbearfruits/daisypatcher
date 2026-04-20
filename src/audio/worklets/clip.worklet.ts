/// <reference path="./worklet.d.ts" />

/**
 * Clip/saturator — `drive` scales input before nonlinearity, `mode` picks
 * the shape (hard/soft/tanh). Registered as `'dp-clip'`.
 */

type ClipMode = 'hard' | 'soft' | 'tanh'

class ClipProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'drive',
        defaultValue: 1,
        minValue: 1,
        maxValue: 20,
        automationRate: 'k-rate'
      }
    ]
  }

  private mode: ClipMode = 'hard'

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'param' && data.paramId === 'mode') {
        const v = data.value as string
        if (v === 'hard' || v === 'soft' || v === 'tanh') this.mode = v
      }
    }
  }

  private shape(x: number): number {
    switch (this.mode) {
      case 'hard':
        if (x > 1) return 1
        if (x < -1) return -1
        return x
      case 'soft': {
        // Cubic soft clipper in [-1,1].
        if (x > 1) return 2 / 3
        if (x < -1) return -2 / 3
        return x - (x * x * x) / 3
      }
      case 'tanh':
        return Math.tanh(x)
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

    const drive = parameters.drive[0] ?? 1
    const input = inputs[0]
    const inCh = input && input.length > 0 ? input[0] : undefined
    const n = outCh.length

    if (!inCh) {
      outCh.fill(0)
    } else {
      for (let i = 0; i < n; i++) {
        outCh[i] = this.shape(inCh[i] * drive)
      }
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh)
    return true
  }
}

registerProcessor('dp-clip', ClipProcessor)
