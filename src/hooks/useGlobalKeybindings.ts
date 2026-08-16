/**
 * Global keyboard shortcuts. Mounted once in App.tsx. Attaches a single
 * `keydown` listener on `document`; skips when focus is in an input-like
 * element so text editing / parameter entry is never hijacked.
 *
 * Any key that conflicts with a form control (Delete, Backspace, Cmd+A,
 * etc.) early-exits when the activeElement is editable.
 */

import { useEffect } from 'react'
import { useEditorStore } from '@/state/store'
import { useCompileStore } from '@/state/compileState'
import { useSerialStore } from '@/state/serialState'
import { newPatch, openPatch, savePatch, savePatchAs } from '@/state/patchFile'
import { openAppModal } from '@/components/layout/AppModals'
import { CANVAS_COMMAND_EVENT } from '@/hooks/useMenuCommands'
import { OPEN_COMMAND_PALETTE_EVENT } from '@/components/layout/CommandPalette'
import { TOGGLE_CODE_PANEL_EVENT } from '@/components/layout/CodePanel'
import { TOGGLE_ASSISTANT_EVENT } from '@/components/layout/AssistantPanel'
import { canvasPastePosition } from '@/editor/ReteEditor'

function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

export function useGlobalKeybindings(): void {
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const editable = isEditableTarget(document.activeElement)

      // F1 — the guide. The one help key every desktop app honours, and it
      // is safe from any text field because nothing types an F1.
      if (ev.key === 'F1') {
        ev.preventDefault()
        openAppModal('guide')
        return
      }
      const mod = ev.metaKey || ev.ctrlKey
      const key = ev.key

      // Escape always clears selection, even from inputs (it's also the
      // universal "close/dismiss" key and doesn't interfere with typing).
      if (key === 'Escape' && !editable) {
        const st = useEditorStore.getState()
        /*
         * Escape means "get me out of here", and being inside a subpatch is
         * the more enclosing state — so it unwinds a level first and only
         * clears the selection once you are at the root.
         */
        if (st.selection.size === 0 && st.subpatchStack.length > 0) st.exitSubpatch()
        else st.select(null)
        return
      }

      if (!mod) {
        // Space — transport toggle (play/stop), the universal DAW binding.
        // Guarded by isEditableTarget so typing a space in any input never
        // fires it; preventDefault stops the page from scrolling and stops
        // a focused button from re-triggering via its default Space action.
        if (key === ' ' && !editable) {
          ev.preventDefault()
          const state = useEditorStore.getState()
          state.setPlaying(!state.isPlaying)
          return
        }

        // Delete / Backspace — only when not in an input.
        if ((key === 'Delete' || key === 'Backspace') && !editable) {
          const state = useEditorStore.getState()
          if (state.selection.size > 0) {
            ev.preventDefault()
            state.deleteSelection()
          }
        }
        return
      }

      // From here on, `mod` is true.
      const k = key.toLowerCase()

      // Cmd/Ctrl+K — open the floating command palette (fuzzy picker).
      // Works from anywhere, including text inputs: it's a "jump to
      // command" that should override current focus.
      if (k === 'k' && !ev.shiftKey) {
        ev.preventDefault()
        window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))
        return
      }

      // Cmd/Ctrl+Shift+C — show the generated code. Shift because plain
      // Cmd+C is copy and always will be; this is a view toggle, so it
      // works from anywhere including a text field.
      if (k === 'c' && ev.shiftKey) {
        ev.preventDefault()
        window.dispatchEvent(new CustomEvent(TOGGLE_CODE_PANEL_EVENT))
        return
      }

      // Cmd/Ctrl+Shift+K — the assistant. K for "ask", and Shift for the
      // same reason as the code panel: plain Cmd+K is a search binding
      // people expect elsewhere. The plain-K branch above MUST exclude
      // Shift, or this one is unreachable — which it was, and "I can't
      // find the assistant" was the symptom.
      if (k === 'k' && ev.shiftKey) {
        ev.preventDefault()
        window.dispatchEvent(new CustomEvent(TOGGLE_ASSISTANT_EVENT))
        return
      }

      // Cmd/Ctrl+B — toggle palette collapse (universal sidebar-toggle
      // binding). Also works from inputs so the rail can always collapse.
      if (k === 'b') {
        ev.preventDefault()
        useEditorStore.getState().togglePaletteCollapsed()
        return
      }

      // Build-log panel toggle. `ev.key` for backtick is literally "`".
      // Works from anywhere, including text inputs — it's a developer
      // console like Cmd+Option+I, so deliberately global.
      if (key === '`') {
        ev.preventDefault()
        useCompileStore.getState().toggleLogPanel()
        return
      }

      // Cmd/Ctrl+M — serial monitor toggle. Global by the same rationale
      // as the build log: it's a developer console, not a text command.
      if (k === 'm') {
        ev.preventDefault()
        useSerialStore.getState().toggleMonitor()
        return
      }

      // Save / open / new work regardless of focus — they're global app
      // commands and users expect Cmd+S to save even when a param slider
      // happens to be focused.
      if (k === 's') {
        ev.preventDefault()
        // Shift+S is Save As — the dialog every time; plain S writes back
        // to the file the patch came from (see patchFile.savePatch).
        void (ev.shiftKey ? savePatchAs() : savePatch())
        return
      }
      // Cmd/Ctrl+0 — zoom to fit; Shift adds reset. The menu shows both.
      if (k === '0') {
        ev.preventDefault()
        window.dispatchEvent(
          new CustomEvent(CANVAS_COMMAND_EVENT, { detail: ev.shiftKey ? 'zoom_reset' : 'zoom_fit' })
        )
        return
      }
      // Cmd/Ctrl+1/2/3 — the three views. Digit keys are how every tabbed
      // app switches tabs, and the menu shows these as accelerators.
      if (k === '1' || k === '2' || k === '3') {
        ev.preventDefault()
        useEditorStore.getState().setView(k === '1' ? 'patch' : k === '2' ? 'hardware' : 'perform')
        return
      }
      // Cmd/Ctrl+/ — the shortcut list. `/` is the convention (GitHub,
      // Slack, Linear); `?` needs Shift and reads as a question.
      if (k === '/') {
        ev.preventDefault()
        openAppModal('shortcuts')
        return
      }
      // Cmd/Ctrl+, — preferences, the macOS-universal binding.
      if (k === ',') {
        ev.preventDefault()
        openAppModal('preferences')
        return
      }
      if (k === 'o') {
        ev.preventDefault()
        void openPatch()
        return
      }
      if (k === 'n') {
        ev.preventDefault()
        void newPatch()
        return
      }

      // Editing commands — skip when focus is on a form control so native
      // copy/paste/undo behaviour is preserved in text inputs.
      if (editable) return

      if (k === 'z' && !ev.shiftKey) {
        ev.preventDefault()
        useEditorStore.getState().undo()
        return
      }
      if ((k === 'z' && ev.shiftKey) || k === 'y') {
        ev.preventDefault()
        useEditorStore.getState().redo()
        return
      }
      if (k === 'c') {
        ev.preventDefault()
        useEditorStore.getState().copySelection()
        return
      }
      if (k === 'x') {
        ev.preventDefault()
        useEditorStore.getState().cutSelection()
        return
      }
      if (k === 'v') {
        ev.preventDefault()
        // Paste where the pointer is. `paste()` always accepted a position,
        // but nothing passed one, so repeated pastes stacked at a fixed
        // +40,+40 offset from the original into an unreadable pile.
        useEditorStore.getState().paste(canvasPastePosition())
        return
      }
      if (k === 'a') {
        ev.preventDefault()
        useEditorStore.getState().selectAll()
        return
      }
      // Cmd/Ctrl+G — collapse the selection into a subpatch. `G` for group,
      // which is what it is called everywhere else this gesture exists.
      if (k === 'g') {
        ev.preventDefault()
        useEditorStore.getState().collapseSelectionToSubpatch()
        return
      }

      // Cmd/Ctrl + "." — collapse/expand all selected Rete nodes. The
      // target state is computed from the majority: if any selected node
      // is expanded, collapse them all; otherwise expand them. A single
      // transaction wraps the batch so undo rewinds in one hop.
      if (key === '.' || k === '.') {
        ev.preventDefault()
        const state = useEditorStore.getState()
        const ids = Array.from(state.selection)
        if (ids.length === 0) return
        const anyExpanded = state.graph.nodes.some(
          (n) => state.selection.has(n.id) && !n.collapsed
        )
        state.setCollapsed(ids, anyExpanded)
        return
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}
