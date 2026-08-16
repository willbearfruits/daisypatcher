/**
 * Command registry for the Cmd/Ctrl+K palette.
 *
 * Until now the palette could only drop node kinds, which meant every
 * *action* in the app was either a toolbar icon or a keyboard shortcut with
 * nowhere to look it up. The list below is the discoverable index: it names
 * what the app can do, shows the shortcut where one exists, and runs it.
 *
 * Built fresh on each open rather than declared statically, because half of
 * these need live state to decide their label ("Show grid" vs "Hide grid"),
 * whether they are available (Flash needs a device), or which board they
 * would switch to.
 */

import { useEditorStore } from '@/state/store'
import { useCompileStore } from '@/state/compileState'
import { useSerialStore } from '@/state/serialState'
import { newPatch, openPatch, savePatch, savePatchAs } from '@/state/patchFile'
import { openAppModal } from './AppModals'
import { TOGGLE_CODE_PANEL_EVENT } from './CodePanel'
import { TOGGLE_ASSISTANT_EVENT } from './AssistantPanel'
import { TARGETS } from '@/codegen/targets'
import { BOARD_IDS } from '../../../shared/boards'
import { THEMES } from '@/theme/themes'

export interface Command {
  id: string
  label: string
  /** Grouping shown as the row's right-hand tag. */
  group: 'File' | 'Edit' | 'View' | 'Canvas' | 'Build' | 'Board' | 'Theme'
  /** Extra words the fuzzy matcher should consider — synonyms, mostly. */
  keywords?: string
  /** Rendered as a keycap when present. */
  shortcut?: string
  disabled?: boolean
  run: () => void
}

const MOD = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'

/** Live handles the palette owns and the registry cannot reach on its own. */
export interface CommandContext {
  setSkinId: (id: string) => void
  currentSkinId: string
}

export function buildCommands(ctx: CommandContext): Command[] {
  const s = useEditorStore.getState()
  const compile = useCompileStore.getState()
  const serial = useSerialStore.getState()
  const L = s.layout
  const hasSelection = s.selection.size > 0
  const nSel = s.selection.size

  const out: Command[] = [
    /* ---- file ---- */
    { id: 'file.new', label: 'New patch', group: 'File', shortcut: `${MOD}+N`, run: () => void newPatch() },
    { id: 'file.open', label: 'Open patch…', group: 'File', shortcut: `${MOD}+O`, run: () => void openPatch() },
    { id: 'file.save', label: 'Save patch', group: 'File', shortcut: `${MOD}+S`, run: () => void savePatch() },
    { id: 'file.saveAs', label: 'Save patch as…', group: 'File', shortcut: `${MOD}+Shift+S`, run: () => void savePatchAs() },
    { id: 'file.examples', label: 'Open an example patch…', group: 'File', keywords: 'demo sample template starter', run: () => openAppModal('examples') },

    /* ---- edit ---- */
    {
      id: 'edit.undo',
      label: 'Undo',
      group: 'Edit',
      shortcut: `${MOD}+Z`,
      disabled: !s.canUndo(),
      run: () => s.undo()
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      group: 'Edit',
      shortcut: `${MOD}+Shift+Z`,
      disabled: !s.canRedo(),
      run: () => s.redo()
    },
    {
      id: 'edit.copy',
      label: nSel > 1 ? `Copy ${nSel} nodes` : 'Copy',
      group: 'Edit',
      shortcut: `${MOD}+C`,
      disabled: !hasSelection,
      run: () => s.copySelection()
    },
    {
      id: 'edit.cut',
      label: nSel > 1 ? `Cut ${nSel} nodes` : 'Cut',
      group: 'Edit',
      shortcut: `${MOD}+X`,
      disabled: !hasSelection,
      run: () => s.cutSelection()
    },
    {
      id: 'edit.paste',
      label: 'Paste',
      group: 'Edit',
      shortcut: `${MOD}+V`,
      disabled: s.clipboard === null,
      run: () => s.paste()
    },
    {
      id: 'edit.duplicate',
      label: 'Duplicate selection',
      group: 'Edit',
      keywords: 'clone copy',
      disabled: !hasSelection,
      run: () => {
        s.copySelection()
        s.paste()
      }
    },
    {
      id: 'edit.selectAll',
      label: 'Select all',
      group: 'Edit',
      shortcut: `${MOD}+A`,
      disabled: s.graph.nodes.length === 0,
      run: () => s.selectAll()
    },
    {
      id: 'edit.deselect',
      label: 'Deselect',
      group: 'Edit',
      shortcut: 'Esc',
      disabled: !hasSelection,
      run: () => s.select(null)
    },
    {
      id: 'edit.delete',
      label: nSel > 1 ? `Delete ${nSel} nodes` : 'Delete selection',
      group: 'Edit',
      shortcut: 'Del',
      keywords: 'remove',
      disabled: !hasSelection,
      run: () => s.deleteSelection()
    },
    {
      id: 'edit.subpatch',
      label: nSel > 1 ? `Collapse ${nSel} nodes into a subpatch` : 'Collapse selection into a subpatch',
      group: 'Edit',
      shortcut: `${MOD}+G`,
      keywords: 'group nest box fold',
      disabled: !hasSelection,
      run: () => s.collapseSelectionToSubpatch()
    },
    {
      id: 'edit.exitSubpatch',
      label: 'Leave subpatch',
      group: 'Edit',
      shortcut: 'Esc',
      keywords: 'up out parent',
      disabled: s.subpatchStack.length === 0,
      run: () => s.exitSubpatch()
    },
    {
      id: 'edit.collapse',
      label: 'Collapse / expand selection',
      group: 'Edit',
      shortcut: `${MOD}+.`,
      disabled: !hasSelection,
      run: () => {
        const ids = Array.from(s.selection)
        const anyExpanded = s.graph.nodes.some((n) => s.selection.has(n.id) && !n.collapsed)
        s.setCollapsed(ids, anyExpanded)
      }
    },

    /* ---- view ---- */
    { id: 'view.patch', label: 'Go to Patch view', group: 'View', keywords: 'nodes graph', run: () => s.setView('patch') },
    { id: 'view.hardware', label: 'Go to Hardware view', group: 'View', keywords: 'controllers pins board', run: () => s.setView('hardware') },
    { id: 'view.perform', label: 'Go to Perform view', group: 'View', keywords: 'panel play', run: () => s.setView('perform') },
    {
      id: 'view.palette',
      label: L.paletteCollapsed ? 'Show node palette' : 'Hide node palette',
      group: 'View',
      shortcut: `${MOD}+B`,
      run: () => s.togglePaletteCollapsed()
    },
    {
      id: 'view.paletteCompact',
      label: L.paletteCompact ? 'Palette: full rows' : 'Palette: compact tiles',
      group: 'View',
      run: () => s.togglePaletteCompact()
    },
    {
      id: 'view.code',
      label: 'Show generated code',
      group: 'View',
      shortcut: `${MOD}+Shift+C`,
      keywords: 'c++ source firmware inspect read',
      run: () => window.dispatchEvent(new CustomEvent(TOGGLE_CODE_PANEL_EVENT))
    },
    {
      id: 'help.guide',
      label: 'Open the guide',
      group: 'View',
      shortcut: 'F1',
      keywords: 'help docs documentation manual how to',
      run: () => openAppModal('guide')
    },
    {
      id: 'view.assistant',
      label: 'Ask the assistant',
      group: 'View',
      shortcut: `${MOD}+Shift+K`,
      keywords: 'ai llm chat help suggest generate patch ollama claude',
      run: () => window.dispatchEvent(new CustomEvent(TOGGLE_ASSISTANT_EVENT))
    },
    {
      id: 'view.buildLog',
      label: 'Toggle build log',
      group: 'View',
      shortcut: '`',
      keywords: 'console output errors',
      run: () => compile.toggleLogPanel()
    },
    {
      id: 'view.serial',
      label: 'Toggle serial monitor',
      group: 'View',
      shortcut: `${MOD}+M`,
      keywords: 'uart console print',
      run: () => serial.toggleMonitor()
    },

    /* ---- canvas ---- */
    {
      id: 'canvas.grid',
      label: L.gridShow ? 'Hide grid' : 'Show grid',
      group: 'Canvas',
      run: () => s.setCanvasPrefs({ gridShow: !L.gridShow })
    },
    {
      id: 'canvas.snap',
      label: L.gridSnap ? 'Turn off snap to grid' : 'Snap to grid',
      group: 'Canvas',
      keywords: 'align',
      run: () => s.setCanvasPrefs({ gridSnap: !L.gridSnap })
    },
    {
      id: 'canvas.marquee',
      label: L.marqueeSelect ? 'Drag pans the canvas' : 'Drag selects (rubber band)',
      group: 'Canvas',
      keywords: 'rubber band marquee pan',
      run: () => s.setCanvasPrefs({ marqueeSelect: !L.marqueeSelect })
    },
    {
      id: 'canvas.gridSize',
      label: `Grid pitch: ${L.gridSize} → ${nextGridSize(L.gridSize)}`,
      group: 'Canvas',
      keywords: 'spacing size',
      run: () => s.setCanvasPrefs({ gridSize: nextGridSize(L.gridSize) })
    },

    /* ---- build ---- */
    {
      id: 'build.build',
      label: 'Build firmware',
      group: 'Build',
      keywords: 'compile make',
      disabled: compile.building,
      run: () => void compile.build()
    },
    {
      id: 'build.flash',
      label: 'Flash device',
      group: 'Build',
      keywords: 'upload program dfu',
      disabled: compile.flashing,
      run: () => void compile.flash()
    },
    {
      id: 'build.detect',
      label: 'Detect connected board',
      group: 'Build',
      keywords: 'usb device probe',
      run: () => void compile.detectDevice()
    },

    /* ---- board ---- */
    ...BOARD_IDS.map((id) => ({
      id: `board.${id}`,
      label: `Target: ${TARGETS[id].label}`,
      group: 'Board' as const,
      keywords: `${TARGETS[id].description} switch target compile for`,
      disabled: s.target === id,
      run: () => s.setTarget(id)
    })),
    {
      id: 'board.repin',
      label: 'Reassign pins for this board',
      group: 'Board',
      keywords: 'repin fix invalid gpio',
      run: () => s.repinForBoard()
    },
    {
      id: 'board.unlock',
      label: 'Follow the connected board again',
      group: 'Board',
      keywords: 'autodetect unlock target',
      disabled: !s.targetLockedByUser,
      run: () => s.releaseTargetLock()
    },

    /* ---- theme ---- */
    ...Object.entries(THEMES).map(([id, skin]) => ({
      id: `theme.${id}`,
      label: `Theme: ${skin.name}`,
      group: 'Theme' as const,
      keywords: `skin colours appearance ${skin.description}`,
      disabled: ctx.currentSkinId === id,
      run: () => ctx.setSkinId(id)
    }))
  ]

  return out
}

/** Cycle through the pitches that divide a typical node width evenly. */
function nextGridSize(current: number): number {
  const steps = [10, 20, 40, 80]
  const i = steps.indexOf(current)
  return steps[(i + 1) % steps.length] ?? 20
}
