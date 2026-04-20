/**
 * Public entry point for the audio emulation engine.
 *
 * The store instantiates the engine once, subscribes via `onStateChange`,
 * and drives it with `setGraph` / `updateParam` / `start` / `stop`.
 */

import { AudioEngine } from './AudioEngine'

export { AudioEngine }

export function createAudioEngine(): AudioEngine {
  return new AudioEngine()
}
