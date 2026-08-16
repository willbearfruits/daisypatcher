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
 * Accelerators are DECLARATIVE ONLY. Electron would fire the menu item AND
 * the renderer's own keydown handler for the same chord, so every item's
 * `click` is guarded to run only when the menu was actually opened — the
 * shortcut path stays with the renderer, which already handles focus and
 * text-field exclusion correctly. Showing the accelerator next to the item
 * is the whole point: it is how people learn the shortcuts exist.
 */

import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'

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
 * Menu-click-only handler.
 *
 * `click` receives (menuItem, browserWindow, event); the event carries
 * `triggeredByAccelerator` when the chord fired it. We refuse those, so the
 * renderer's keydown path is the ONLY thing that acts on a shortcut and
 * nothing fires twice. Electron still shows the accelerator label, which
 * is what we want from it.
 */
function onClick(cmd: AppCommand) {
  return (_item: unknown, _win: unknown, ev: { triggeredByAccelerator?: boolean } | undefined) => {
    if (ev?.triggeredByAccelerator) return
    send(cmd)
  }
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
        click: () => void shell.openExternal('https://electro-smith.github.io/libDaisy/')
      },
      {
        label: 'DaisySP Reference',
        click: () => void shell.openExternal('https://electro-smith.github.io/DaisySP/')
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
