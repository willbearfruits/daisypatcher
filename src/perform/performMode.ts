/**
 * performMode — tiny UI-state store for the Perform view's PLAY / ARRANGE
 * toggle.
 *
 * Lives in its own Zustand store (not `useEditorStore`) deliberately:
 *   - It's pure view state — it must NOT participate in undo history or
 *     round-trip through `.dpatch`.
 *   - `App.tsx` also reads it (ARRANGE un-collapses the right panel to
 *     host the HardwareInspector), and keeping it out of the editor store
 *     avoids touching the shared store files for a perform-only concern.
 *
 * PLAY  — the pedal is an instrument: knobs sweep, buttons press.
 * ARRANGE — the pedal is a workbench: components select, drag, rotate.
 */

import { create } from 'zustand'

export type PerformMode = 'play' | 'arrange'

interface PerformModeState {
  mode: PerformMode
  setMode(mode: PerformMode): void
}

export const usePerformMode = create<PerformModeState>((set) => ({
  mode: 'play',
  setMode: (mode) => set({ mode })
}))
