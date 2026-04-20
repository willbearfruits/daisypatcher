/**
 * Serial monitor state — sibling of compileState so the build / flash /
 * SDK concerns stay decoupled from the runtime-observe concerns.
 *
 * The preload bridge exposes `window.daisy.serial` with list / open /
 * close / write / onLine. Mirroring compileState's pattern, we register
 * the onLine listener at store construction so lines land in the buffer
 * regardless of which component is currently mounted.
 *
 * Buffer is capped at 2000 lines; on overflow we drop the oldest 10%
 * to amortise the re-copy cost across many pushes.
 *
 * Common baud list lives in BAUD_RATES (9600..230400). 115200 is the
 * default — that's what libDaisy's DaisySeed::StartLog uses.
 */

import { create } from 'zustand'

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

export interface SerialLine {
  t: number
  text: string
}

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400] as const
export const DEFAULT_BAUD = 115200

type Unsub = () => void

interface SerialApi {
  list(): Promise<SerialPortInfo[]>
  open(path: string, baud: number): Promise<{ success: boolean; error?: string }>
  close(): Promise<void>
  write(text: string): Promise<void>
  onLine(cb: (line: string) => void): Unsub
}

interface MaybeDaisyApi {
  serial?: SerialApi
}

function api(): MaybeDaisyApi {
  if (typeof window === 'undefined') return {}
  const w = window as unknown as { daisy?: MaybeDaisyApi }
  return w.daisy ?? {}
}

export interface SerialState {
  ports: SerialPortInfo[]
  connected: boolean
  connecting: boolean
  currentPath: string | null
  baud: number
  monitorOpen: boolean
  lines: SerialLine[]
  lastError: string | null
}

export interface SerialActions {
  refreshPorts(): Promise<void>
  connect(path: string, baud?: number): Promise<void>
  disconnect(): Promise<void>
  send(line: string): Promise<void>
  setBaud(baud: number): void
  setPath(path: string): void
  toggleMonitor(): void
  openMonitor(): void
  closeMonitor(): void
  clearLines(): void
}

const LINE_CAP = 2000

function pushCapped(list: SerialLine[], line: SerialLine): SerialLine[] {
  if (list.length < LINE_CAP) return [...list, line]
  const drop = Math.floor(LINE_CAP / 10)
  const next = list.slice(drop)
  next.push(line)
  return next
}

export const useSerialStore = create<SerialState & SerialActions>((set, get) => {
  const appendLine = (text: string): void => {
    set((s) => ({ lines: pushCapped(s.lines, { t: Date.now(), text }) }))
  }

  const a = api()
  try {
    a.serial?.onLine((text) => appendLine(text))
  } catch {
    /* preload not ready — connect() will no-op gracefully */
  }

  return {
    ports: [],
    connected: false,
    connecting: false,
    currentPath: null,
    baud: DEFAULT_BAUD,
    monitorOpen: false,
    lines: [],
    lastError: null,

    async refreshPorts() {
      const s = api().serial
      if (!s) return
      try {
        const ports = await s.list()
        set({ ports })
        // If the currently-selected port vanished, clear the selection so
        // the dropdown doesn't dangle on a dead entry.
        const cur = get().currentPath
        if (cur && !ports.some((p) => p.path === cur) && !get().connected) {
          set({ currentPath: null })
        }
      } catch {
        /* ignore — transient enumeration failures are fine */
      }
    },

    async connect(path: string, baud?: number) {
      const s = api().serial
      if (!s) {
        set({ lastError: 'serial bridge unavailable' })
        return
      }
      if (get().connecting || get().connected) return
      const chosenBaud = baud ?? get().baud
      set({ connecting: true, lastError: null, currentPath: path, baud: chosenBaud })
      try {
        const res = await s.open(path, chosenBaud)
        if (res.success) {
          set({ connected: true, connecting: false })
        } else {
          set({
            connected: false,
            connecting: false,
            lastError: res.error ?? 'open failed'
          })
        }
      } catch (err) {
        set({
          connected: false,
          connecting: false,
          lastError: (err as Error).message
        })
      }
    },

    async disconnect() {
      const s = api().serial
      if (!s) {
        set({ connected: false })
        return
      }
      try {
        await s.close()
      } catch {
        /* ignore */
      } finally {
        set({ connected: false, connecting: false })
      }
    },

    async send(line: string) {
      const s = api().serial
      if (!s || !get().connected) return
      // Append a newline so the device's own readline parser sees a
      // complete frame. We echo the outgoing text into the buffer so the
      // user has visual confirmation.
      const withNewline = line.endsWith('\n') ? line : line + '\n'
      try {
        await s.write(withNewline)
        set((st) => ({
          lines: pushCapped(st.lines, {
            t: Date.now(),
            text: `> ${line}`
          })
        }))
      } catch (err) {
        set((st) => ({
          lines: pushCapped(st.lines, {
            t: Date.now(),
            text: `[serial] send failed: ${(err as Error).message}`
          })
        }))
      }
    },

    setBaud(baud: number) {
      set({ baud })
    },
    setPath(path: string) {
      set({ currentPath: path })
    },

    toggleMonitor() {
      set((s) => ({ monitorOpen: !s.monitorOpen }))
    },
    openMonitor() {
      set({ monitorOpen: true })
    },
    closeMonitor() {
      set({ monitorOpen: false })
    },
    clearLines() {
      set({ lines: [] })
    }
  }
})
