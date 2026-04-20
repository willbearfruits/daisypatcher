/// <reference path="./worklet.d.ts" />

/**
 * Hardware audio input — stereo.
 *
 * On the Daisy Seed this maps to the codec's L/R ADC inputs. In the browser
 * emulator we would need `getUserMedia` to route a mic stream into the
 * graph; that's out of scope for Phase 1, so this worklet emits silence on
 * both outputs. Graphs that reference `audio_in` therefore still connect
 * cleanly — they just hear nothing on that branch.
 *
 * Registered as `'dp-audio-in'`.
 */

class AudioInProcessor extends AudioWorkletProcessor {
  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0]?.[0]
    const outR = outputs[1]?.[0]
    if (outL) outL.fill(0)
    if (outR) outR.fill(0)
    return true
  }
}

registerProcessor('dp-audio-in', AudioInProcessor)
