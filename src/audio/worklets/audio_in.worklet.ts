/// <reference path="./worklet.d.ts" />

/**
 * Hardware audio input — stereo.
 *
 * On the device this is the codec's L/R ADC. In the app the engine opens
 * the chosen capture device with `getUserMedia`, splits it to two mono
 * channels and feeds them into THIS worklet's two inputs — inputs that
 * exist on the worklet but not on the node (`inputs: []` in the
 * definition), so no socket appears and nothing in the graph can wire
 * into it. The worklet just copies input → output, which keeps every
 * downstream consumer, the tap system and codegen exactly as they were:
 * `audio_in` is still "the two hardware channels", it is only where they
 * come from that changed.
 *
 * With no stream attached (permission denied, no device, headless
 * renderer) the inputs are empty and the outputs are silence — the old
 * behaviour, and the honest one.
 *
 * Registered as `'dp-audio-in'`.
 */

class AudioInProcessor extends AudioWorkletProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0]?.[0]
    const outR = outputs[1]?.[0]
    const inL = inputs[0]?.[0]
    const inR = inputs[1]?.[0]
    if (outL) {
      if (inL && inL.length === outL.length) outL.set(inL)
      else outL.fill(0)
    }
    if (outR) {
      // A mono device only fills the first channel; mirror it so a mono
      // mic reaches both sides the way a TS jack into the Seed's L does not
      // — but a user who patched R expecting signal is better served by
      // hearing something than by silence they will blame on the patch.
      const src = inR && inR.length === outR.length ? inR : inL
      if (src && src.length === outR.length) outR.set(src)
      else outR.fill(0)
    }
    return true
  }
}

registerProcessor('dp-audio-in', AudioInProcessor)
