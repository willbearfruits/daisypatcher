/**
 * The application menu.
 *
 * There was none: the window set `autoHideMenuBar: true` and never called
 * `Menu.setApplicationMenu`, so Electron showed its stock menu — hidden
 * behind Alt on Linux and Windows, and full of items (Reload, Toggle
 * DevTools, Actual Size) that mean nothing to someone building a synth. A
 * desktop app with no File menu reads as a web page in a frame.
 *
 * DESIGN: the menu is a THIN dispatcher. Every item does exactly one thing:
 * `webContents.send('app:command', 'save')`. The renderer owns the actual
 * behaviour, because that is where the store, the dialogs and the undo
 * history live — duplicating "save" logic in the main process would mean
 * two implementations of the one operation that must never disagree. The
 * command names are the same ones the renderer's keybindings and command
 * palette already dispatch, so a menu item and its shortcut cannot drift.
 *
 * Accelerators are shown next to items so people learn the shortcuts
 * exist. Whether the chord is handled by the menu or by the renderer's
 * keydown differs by platform, but it is always exactly one of them — see
 * `onClick` for the measurement that established that, and why the click
 * handler therefore has no guard.
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { openExternalSafe } from './openExternal'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Commands the renderer understands. Keep in sync with `src/app/commands.ts`. */
export type AppCommand =
  | 'new'
  | 'open'
  | 'save'
  | 'save_as'
  | 'open_examples'
  | 'examples'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'select_all'
  | 'delete'
  | 'view_patch'
  | 'view_hardware'
  | 'view_perform'
  | 'toggle_palette'
  | 'toggle_code'
  | 'toggle_assistant'
  | 'toggle_build_log'
  | 'toggle_serial'
  | 'command_palette'
  | 'zoom_fit'
  | 'zoom_reset'
  | 'transport_toggle'
  | 'build'
  | 'flash'
  | 'preferences'
  | 'shortcuts'
  | 'about'

const isMac = process.platform === 'darwin'

/* ---------------- recent files ---------------- */

const MAX_RECENT = 10

function recentPath(): string {
  return join(app.getPath('userData'), 'recent.json')
}

/**
 * Most-recent first, existing files only.
 *
 * Filtered on read rather than on write, so a file deleted or moved after
 * it was recorded silently drops out of the menu instead of opening to
 * "no such file". Kept small: ten is what fits a submenu without a scroll.
 */
export function readRecent(): string[] {
  try {
    const raw = JSON.parse(readFileSync(recentPath(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((p): p is string => typeof p === 'string' && existsSync(p)).slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

/** Record a file as just-used and rebuild the menu so it shows at once. */
export function addRecent(path: string): void {
  const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, MAX_RECENT)
  try {
    writeFileSync(recentPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // Not worth failing a save over.
  }
  // macOS Dock menu / Windows jump list get it too.
  app.addRecentDocument(path)
  installAppMenu()
}

export function clearRecent(): void {
  try {
    writeFileSync(recentPath(), '[]', 'utf8')
  } catch {
    /* nop */
  }
  app.clearRecentDocuments()
  installAppMenu()
}

/**
 * The renderer opens the path itself, through the same guarded read as
 * Open…. `onGrant` is how this module (which does not own the path
 * allow-list) admits the file first — set by `index.ts` at startup.
 */
let onGrant: ((p: string) => void) | null = null
export function setRecentGrant(fn: (p: string) => void): void {
  onGrant = fn
}
function sendOpenPath(path: string): void {
  onGrant?.(path)
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('app:open-path', path)
}

function recentSubmenu(): MenuItemConstructorOptions[] {
  const files = readRecent()
  if (files.length === 0) return [{ label: 'No Recent Patches', enabled: false }]
  return [
    ...files.map((p) => ({
      label: basename(p).replace(/\.dpatch$/, ''),
      sublabel: p,
      toolTip: p,
      click: () => sendOpenPath(p)
    })),
    { type: 'separator' as const },
    { label: 'Clear Menu', click: () => clearRecent() }
  ]
}

/**
 * Send a command to the focused window's renderer.
 *
 * Only ever the focused window: a menu click is a statement about the
 * window in front of you, and broadcasting would save every open patch
 * when you asked to save one.
 */
function send(cmd: AppCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('app:command', cmd)
}

/**
 * Every activation of a menu item runs its command. Mouse, keyboard
 * Enter, or accelerator chord — all of them.
 *
 * The first version refused `triggeredByAccelerator` events to stop a
 * chord (Ctrl+S) firing both the menu item and the renderer's keydown
 * handler. That guard was wrong twice over. On Linux GTK, pressing Enter
 * on a highlighted item is ALSO reported as accelerator-triggered, so the
 * menu was unusable from the keyboard: arrow down, Enter, nothing. And the
 * double-fire it guarded against does not happen: measured here, a bare
 * Ctrl+N never reaches the menu's click at all — the renderer's keydown
 * consumes it first — and on platforms where the menu DOES claim the chord
 * (macOS), Electron eats the keydown so the renderer never sees it. Exactly
 * one side acts, on every platform, without any guard. So there is none.
 */
function onClick(cmd: AppCommand) {
  return () => send(cmd)
}

export function buildAppMenu(): Menu {
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { label: 'About Daisypatcher', click: onClick('about') },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: onClick('preferences') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: '&File',
    submenu: [
      { label: 'New Patch', accelerator: 'CmdOrCtrl+N', click: onClick('new') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: onClick('open') },
      { label: 'Open Recent', submenu: recentSubmenu() },
      { label: 'Open Example…', click: onClick('examples') },
      { label: 'Show Examples Folder', click: onClick('open_examples') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: onClick('save') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: onClick('save_as') },
      { type: 'separator' },
      { label: 'Build', accelerator: 'CmdOrCtrl+Enter', click: onClick('build') },
      { label: 'Build and Flash', accelerator: 'CmdOrCtrl+Shift+Enter', click: onClick('flash') },
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            { label: 'Preferences…', accelerator: 'Ctrl+,', click: onClick('preferences') },
            { type: 'separator' },
            { role: 'quit' }
          ] as MenuItemConstructorOptions[]))
    ]
  })

  template.push({
    label: '&Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: onClick('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: onClick('redo') },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: onClick('cut') },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: onClick('copy') },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: onClick('paste') },
      { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: onClick('duplicate') },
      // No accelerator on purpose: a registered `Delete` would swallow the key
      // in text fields before the renderer saw it. The keybinding lives there.
      { label: 'Delete', click: onClick('delete') },
      { type: 'separator' },
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: onClick('select_all') }
    ]
  })

  template.push({
    label: '&View',
    submenu: [
      { label: 'Patch', accelerator: 'CmdOrCtrl+1', click: onClick('view_patch') },
      { label: 'Hardware', accelerator: 'CmdOrCtrl+2', click: onClick('view_hardware') },
      { label: 'Perform', accelerator: 'CmdOrCtrl+3', click: onClick('view_perform') },
      { type: 'separator' },
      { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: onClick('command_palette') },
      { label: 'Assistant', accelerator: 'CmdOrCtrl+Shift+K', click: onClick('toggle_assistant') },
      { label: 'Generated Code', accelerator: 'CmdOrCtrl+Shift+C', click: onClick('toggle_code') },
      { type: 'separator' },
      { label: 'Node Palette', accelerator: 'CmdOrCtrl+B', click: onClick('toggle_palette') },
      { label: 'Build Log', click: onClick('toggle_build_log') },
      { label: 'Serial Monitor', accelerator: 'CmdOrCtrl+M', click: onClick('toggle_serial') },
      { type: 'separator' },
      { label: 'Zoom to Fit', accelerator: 'CmdOrCtrl+0', click: onClick('zoom_fit') },
      { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+Shift+0', click: onClick('zoom_reset') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      // Kept, but at the bottom: useful for a bug report, not for patching.
      ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
    ]
  })

  template.push({
    label: '&Transport',
    // Same reasoning as Delete: `Space` as an accelerator would eat the
    // spacebar in every input. Shown in the shortcuts sheet instead.
    submenu: [{ label: 'Play / Stop', click: onClick('transport_toggle') }]
  })

  if (isMac) {
    template.push({ role: 'windowMenu' })
  }

  template.push({
    label: '&Help',
    submenu: [
      { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: onClick('shortcuts') },
      { type: 'separator' },
      {
        label: 'Daisy Seed Documentation',
        click: () => void openExternalSafe('https://electro-smith.github.io/libDaisy/')
      },
      {
        label: 'DaisySP Reference',
        click: () => void openExternalSafe('https://electro-smith.github.io/DaisySP/')
      },
      { type: 'separator' },
      ...(isMac ? [] : ([{ label: 'About Daisypatcher', click: onClick('about') }] as MenuItemConstructorOptions[]))
    ]
  })

  return Menu.buildFromTemplate(template)
}

export function installAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu())
}
