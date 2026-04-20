/**
 * React context plumbing for the `AudioEngine`. Visual nodes
 * (`src/editor/VisualNode.tsx`) reach for the engine through
 * `useAudioEngine()` so they can call `engine.tap()` from inside the Rete
 * scene — we can't forward refs through the Rete preset, so context is the
 * natural channel.
 *
 * The provider is wired once at the top of `App.tsx`, wrapping the rest of
 * the tree after the engine is created.
 */

import * as React from 'react'
import type { AudioEngine } from '@/types/store'

const AudioEngineCtx = React.createContext<AudioEngine | null>(null)

export interface AudioEngineProviderProps {
  engine: AudioEngine
  children: React.ReactNode
}

export function AudioEngineProvider(props: AudioEngineProviderProps): React.JSX.Element {
  return (
    <AudioEngineCtx.Provider value={props.engine}>
      {props.children}
    </AudioEngineCtx.Provider>
  )
}

/**
 * Read the engine. Returns null if no provider is mounted yet — visual
 * nodes handle that case gracefully (flat line / empty meter).
 */
export function useAudioEngine(): AudioEngine | null {
  return React.useContext(AudioEngineCtx)
}
