/// <reference path="./worklet.d.ts" />

/**
 * OLED worklet — no-op sink. The node carries six CV/audio inputs but has
 * no outputs; this processor exists so the engine instantiates a live
 * worklet that main-thread taps can attach analysers to (for live preview).
 *
 * Registered as `'dp-oled'`.
 */

class OledProcessor extends AudioWorkletProcessor {
  process(
    _inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    // Intentionally do nothing. Inputs arrive but are ignored; the display
    // view samples the UPSTREAM source node's output via engine.tap().
    return true
  }
}

registerProcessor('dp-oled', OledProcessor)
