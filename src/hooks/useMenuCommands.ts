/**
 * Application-menu commands → renderer behaviour.
 *
 * The main process owns the menu bar and sends one string per click over
 * `app:command`. This is where those strings become actions, and it is
 * deliberately the ONLY place: every case below calls the same store
 * method, file helper or window event that the keyboard shortcut and the
 * command palette already call, so the three entry points cannot disagree
 * about what "Save" means.
 *
 * Nothing here handles the SHORTCUT itself — `appMenu.ts` refuses
 * accelerator-triggered clicks, and `useGlobalKeybindings` owns the chord,
 * with its focus and text-field rules. A menu item is a discoverable
 * label for a behaviour, not a second implementation of it.
 */

import { useEffect } from 'react'
import { useEditorStore } from '@/state/store'
import { useCompileStore } from '@/state/compileState'
import { useSerialStore } from '@/state/serialState'
import { newPatch, openPatch, openPatchFromPath, savePatch, savePatchAs } from '@/state/patchFile'
import { OPEN_COMMAND_PALETTE_EVENT } from '@/components/layout/CommandPalette'
import { TOGGLE_CODE_PANEL_EVENT } from '@/components/layout/CodePanel'
import { TOGGLE_ASSISTANT_EVENT } from '@/components/layout/AssistantPanel'
import { openAppModal } from '@/components/layout/AppModals'
import { requestChoice } from '@/components/layout/ConfirmDialog'

/** Fired for canvas-level requests the store cannot answer (zoom lives in Rete). */
export const CANVAS_COMMAND_EVENT = 'dp:canvas-command'
export type CanvasCommand = 'zoom_fit' | 'zoom_reset'

interface MenuBridge {
  onCommand(cb: (cmd: string) => void): () => void
}

function bridge(): MenuBridge | null {
  const w = window as unknown as { daisy?: { menu?: MenuBridge } }
  return w.daisy?.menu ?? null
}

export function useMenuCommands(): void {
  /*
   * Closing the window with unsaved work.
   *
   * Main asks; this answers. Three ways out, because two are not enough
   * when one of them is "lose your work": Save (write, then close), Don't
   * Save (close now), Cancel (stay). A clean patch — nothing dirty, no
   * history — closes without a question, which is what makes the question
   * mean something when it does appear.
   *
   * If the user picks Save and then cancels the save dialog, the window
   * stays open: a cancelled save must never fall through to a close.
   */
  useEffect(() => {
    const w = window as unknown as {
      daisy?: {
        onBeforeClose?: (cb: () => void) => () => void
        respondClose?: (d: 'close' | 'cancel') => void
      }
    }
    if (!w.daisy?.onBeforeClose || !w.daisy.respondClose) return
    const respond = w.daisy.respondClose
    return w.daisy.onBeforeClose(() => {
      const st = useEditorStore.getState()
      if (!st.isDirty && st.history.past.length === 0) {
        respond('close')
        return
      }
      void requestChoice({
        title: 'Quit',
        message: `Save changes to ${st.graph.meta.name || 'this patch'} before closing?`,
        confirmLabel: 'Save',
        altLabel: "Don't Save",
        cancelLabel: 'Cancel'
      }).then(async (choice) => {
        if (choice === 'cancel') {
          respond('cancel')
          return
        }
        if (choice === 'alt') {
          respond('close')
          return
        }
        const r = await savePatch()
        respond(r.saved ? 'close' : 'cancel')
      })
    })
  }, [])

  // File → Open Recent → item. Same guard as Open…: ask before discarding.
  useEffect(() => {
    const w = window as unknown as { daisy?: { recent?: { onOpenPath: (cb: (p: string) => void) => () => void } } }
    return w.daisy?.recent?.onOpenPath((path) => {
      void (async () => {
        const st = useEditorStore.getState()
        if (st.isDirty || st.history.past.length > 0) {
          const ok = await requestChoice({
            title: 'Open recent',
            message: 'Discard unsaved changes?',
            confirmLabel: 'Discard',
            danger: true
          })
          if (ok !== 'confirm') return
        }
        await openPatchFromPath(path)
      })()
    })
  }, [])

  // Main-process errors land on the status line, so a failed IPC call is
  // never a button that silently did nothing.
  useEffect(() => {
    const w = window as unknown as { daisy?: { onMainError?: (cb: (m: string) => void) => () => void } }
    return w.daisy?.onMainError?.((msg) => useEditorStore.getState().setStatus({ kind: 'error', message: msg }))
  }, [])

  useEffect(() => {
    const b = bridge()
    if (!b) return

    return b.onCommand((cmd) => {
      const s = useEditorStore.getState()
      const compile = useCompileStore.getState()
      const serial = useSerialStore.getState()

      switch (cmd) {
        /* ---- file ---- */
        case 'new':
          void newPatch()
          break
        case 'open':
          void openPatch()
          break
        case 'save':
          void savePatch()
          break
        case 'save_as':
          void savePatchAs()
          break
        case 'examples':
          openAppModal('examples')
          break
        case 'open_examples': {
          const w = window as unknown as {
            daisy?: { examples?: { open: () => Promise<{ opened: boolean; error?: string }> } }
          }
          void w.daisy?.examples?.open().then((r) => {
            if (r && !r.opened) s.setStatus({ kind: 'warn', message: r.error ?? 'could not open examples' })
          })
          break
        }
        case 'build':
          void compile.build()
          break
        case 'flash':
          void compile.flash()
          break

        /* ---- edit ---- */
        case 'undo':
          s.undo()
          break
        case 'redo':
          s.redo()
          break
        case 'cut':
          s.cutSelection()
          break
        case 'copy':
          s.copySelection()
          break
        case 'paste':
          s.paste()
          break
        case 'duplicate':
          s.copySelection()
          s.paste()
          break
        case 'select_all':
          s.selectAll()
          break
        case 'delete':
          s.deleteSelection()
          break

        /* ---- view ---- */
        case 'view_patch':
          s.setView('patch')
          break
        case 'view_hardware':
          s.setView('hardware')
          break
        case 'view_perform':
          s.setView('perform')
          break
        case 'toggle_palette':
          s.setLayout({ paletteCollapsed: !s.layout.paletteCollapsed })
          break
        case 'toggle_code':
          window.dispatchEvent(new CustomEvent(TOGGLE_CODE_PANEL_EVENT))
          break
        case 'toggle_assistant':
          window.dispatchEvent(new CustomEvent(TOGGLE_ASSISTANT_EVENT))
          break
        case 'toggle_build_log':
          compile.toggleLogPanel()
          break
        case 'toggle_serial':
          serial.toggleMonitor()
          break
        case 'command_palette':
          window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))
          break
        case 'zoom_fit':
        case 'zoom_reset':
          window.dispatchEvent(new CustomEvent(CANVAS_COMMAND_EVENT, { detail: cmd }))
          break

        /* ---- transport ---- */
        case 'transport_toggle':
          s.setPlaying(!s.isPlaying)
          break

        /* ---- app ---- */
        case 'preferences':
          openAppModal('preferences')
          break
        case 'shortcuts':
          openAppModal('shortcuts')
          break
        case 'about':
          openAppModal('about')
          break
        case 'guide':
          openAppModal('guide')
          break

        default:
          // A command the main process knows and this does not is a real
          // mismatch worth hearing about — but not worth a crash.
          console.warn(`[menu] unhandled command "${cmd}"`)
      }
    })
  }, [])
}
