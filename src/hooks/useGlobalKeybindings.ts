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
import { newPatch, openPatch, savePatch } from '@/state/patchFile'

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
      const mod = ev.metaKey || ev.ctrlKey
      const key = ev.key

      // Escape always clears selection, even from inputs (it's also the
      // universal "close/dismiss" key and doesn't interfere with typing).
      if (key === 'Escape' && !editable) {
        useEditorStore.getState().select(null)
        return
      }

      if (!mod) {
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

      // Cmd/Ctrl+K — focus the palette filter input. Works even from
      // within other inputs: users expect a "jump to search" to override
      // current focus.
      if (k === 'k') {
        const el = document.getElementById('dp-palette-search')
        if (el instanceof HTMLInputElement) {
          ev.preventDefault()
          el.focus()
          el.select()
          return
        }
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
        void savePatch()
        return
      }
      if (k === 'o') {
        ev.preventDefault()
        void openPatch()
        return
      }
      if (k === 'n') {
        ev.preventDefault()
        newPatch()
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
        useEditorStore.getState().paste()
        return
      }
      if (k === 'a') {
        ev.preventDefault()
        useEditorStore.getState().selectAll()
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
