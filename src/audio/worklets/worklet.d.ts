/**
 * Minimal ambient declarations for the AudioWorklet global scope.
 * These are not shipped in `lib.dom` by default. We avoid pulling in
 * `@types/audioworklet` so the types stay narrow and local to the
 * worklet source files.
 */

declare const sampleRate: number
declare const currentTime: number
declare const currentFrame: number

interface AudioParamDescriptor {
  name: string
  defaultValue?: number
  minValue?: number
  maxValue?: number
  automationRate?: 'a-rate' | 'k-rate'
}

interface AudioWorkletProcessorConstructor {
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor
  parameterDescriptors?: AudioParamDescriptor[]
}

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: AudioWorkletNodeOptions)
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: AudioWorkletProcessorConstructor
): void
