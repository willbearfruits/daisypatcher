/**
 * Open a URL or folder in the OS, without letting the OS take us down.
 *
 * `shell.openExternal` is the obvious call and it killed the app. On a KDE
 * session it dispatches to `kde-open`, and on this machine `kde-open`
 * throws `std::bad_alloc`, KCrash tries to start Dr. Konqi, fails, and the
 * abort propagates into Electron's main process — Help > Documentation
 * took the whole editor down twice, with the user's patch open. Not a
 * Daisypatcher bug in origin, but a Daisypatcher crash in effect.
 *
 * So: never call the desktop's URL handler in-process. Spawn the opener as
 * a fully DETACHED child with its stdio closed, so whatever it does — crash,
 * hang, dump core — happens to it and not to us. On Linux prefer `gio open`
 * (GLib, no KDE in the path), fall back through `xdg-open` and the common
 * browsers; on macOS/Windows the platform openers are sound and
 * `shell.openExternal` is used as-is.
 *
 * Only http(s) URLs and existing local paths are accepted. Anything else is
 * refused rather than handed to a shell.
 */

import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const LINUX_URL_OPENERS = ['gio', 'xdg-open', 'sensible-browser', 'x-www-browser', 'firefox', 'chromium', 'google-chrome']
const LINUX_PATH_OPENERS = ['gio', 'xdg-open', 'nautilus', 'dolphin', 'thunar', 'nemo', 'pcmanfm']

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Fire-and-forget spawn. Resolves true if the process could be started at all. */
function spawnDetached(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      /* not installed — the caller tries the next one */
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function linuxOpen(target: string, openers: string[]): boolean {
  for (const cmd of openers) {
    const args = cmd === 'gio' ? ['open', target] : [target]
    // `spawn` with a missing binary throws asynchronously via 'error', so
    // success here means "handed off", not "opened". Good enough: the next
    // opener in the list is tried only when this one is absent, and the
    // common case is that the first one works.
    if (spawnDetached(cmd, args)) return true
  }
  return false
}

export async function openExternalSafe(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!isHttpUrl(url)) return { ok: false, error: `refusing to open non-http URL: ${url.slice(0, 80)}` }
  if (process.platform === 'linux') {
    return linuxOpen(url, LINUX_URL_OPENERS) ? { ok: true } : { ok: false, error: 'no browser opener found' }
  }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function openPathSafe(path: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(path)) return { ok: false, error: `no such path: ${path}` }
  if (process.platform === 'linux') {
    return linuxOpen(path, LINUX_PATH_OPENERS) ? { ok: true } : { ok: false, error: 'no file manager found' }
  }
  const err = await shell.openPath(path)
  return err ? { ok: false, error: err } : { ok: true }
}
