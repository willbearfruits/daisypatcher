/// <reference path="./worklet.d.ts" />

/**
 * Menu node — emulator output stage.
 *
 * Deliberately dumb: it holds the four CV-out values and nothing else. The
 * menu state machine itself runs on the MAIN thread (`src/state/menuRuntime.ts`),
 * for two reasons:
 *
 *  1. Worklets are compiled with `bundle: false` and cannot import, so any
 *     logic in here would be a hand-copied duplicate of `editor/menu/machine.ts`
 *     — which already has to stay in step with two C++ emitters. A fourth
 *     copy that drifts silently is the worst outcome available.
 *  2. A menu is control-rate. Navigating a tree and writing node params are
 *     main-thread concerns; running them per audio block buys nothing and
 *     would need a port round-trip to reach the store anyway.
 *
 * Registered as `'dp-menu'`. Four outputs, in socket order: a, b, c, d.
 */

class MenuProcessor extends AudioWorkletProcessor {
  /** Latest values for outputs A..D, pushed from the main thread. */
  private outs = [0, 0, 0, 0]

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      /*
       * Rides the engine's existing string-param path
       * (`engine.updateParam(id, 'outs', json)`), so no new transport is
       * needed. The whole bank arrives in one message, so the four
       * outputs can never be observed half-updated.
       */
      if (data.type !== 'param' || data.paramId !== 'outs') return
      let parsed: unknown
      try {
        parsed = JSON.parse(String(data.value))
      } catch {
        return
      }
      if (!Array.isArray(parsed)) return
      for (let i = 0; i < 4; i++) {
        const v = Number(parsed[i])
        this.outs[i] = Number.isFinite(v) ? v : 0
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (let i = 0; i < 4; i++) {
      const out = outputs[i]
      if (!out || out.length === 0) continue
      const ch = out[0]
      if (!ch) continue
      ch.fill(this.outs[i])
      for (let c = 1; c < out.length; c++) out[c].set(ch)
    }
    return true
  }
}

registerProcessor('dp-menu', MenuProcessor)
