/**
 * Serial monitor service for the Daisy Seed.
 *
 * In app mode the Seed enumerates as a USB CDC device:
 *   Linux   — /dev/ttyACM*
 *   macOS   — /dev/cu.usbmodem*
 *   Windows — COM*
 *
 * The firmware decides the VID/PID, so we DON'T auto-filter — the UI
 * shows every serial port and lets the user pick.
 *
 * Only one port is held open at a time. A second `openSerial` call will
 * close the prior port before opening the new one. A close-fn is also
 * returned for the caller's convenience but the service owns the canonical
 * handle so the IPC layer can keep a single mental model.
 *
 * Line parsing: `@serialport/parser-readline` splits on `\n`; we additionally
 * trim a trailing `\r` so CRLF-framed output (most Daisy examples) renders
 * cleanly in the monitor without blank spacer lines.
 */

import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

interface ActiveHandle {
  port: SerialPort
  parser: ReadlineParser
  path: string
}

let active: ActiveHandle | null = null

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  try {
    const ports = await SerialPort.list()
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      vendorId: p.vendorId,
      productId: p.productId
    }))
  } catch {
    return []
  }
}

async function closeActive(): Promise<void> {
  if (!active) return
  const { port, parser } = active
  active = null
  try {
    parser.removeAllListeners('data')
  } catch {
    /* noop */
  }
  await new Promise<void>((resolve) => {
    if (!port.isOpen) {
      resolve()
      return
    }
    port.close(() => resolve())
  })
}

export async function openSerial(
  path: string,
  baud: number,
  onLine: (line: string) => void
): Promise<() => void> {
  await closeActive()

  const port = new SerialPort({
    path,
    baudRate: baud,
    autoOpen: false
  })

  await new Promise<void>((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()))
  })

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }))
  parser.on('data', (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    const trimmed = text.endsWith('\r') ? text.slice(0, -1) : text
    onLine(trimmed)
  })

  active = { port, parser, path }

  // Surface unexpected disconnects as a synthetic line so the UI can render
  // something useful without the caller having to subscribe to port events.
  port.on('close', () => {
    if (active && active.port === port) {
      active = null
      onLine('[serial] port closed')
    }
  })
  port.on('error', (err) => {
    onLine(`[serial] error: ${err.message}`)
  })

  return async () => {
    if (active && active.port === port) {
      await closeActive()
    }
  }
}

export async function closeSerial(): Promise<void> {
  await closeActive()
}

export async function writeSerial(data: string): Promise<void> {
  if (!active) throw new Error('no serial port open')
  const { port } = active
  await new Promise<void>((resolve, reject) => {
    port.write(data, (err) => (err ? reject(err) : resolve()))
  })
  await new Promise<void>((resolve, reject) => {
    port.drain((err) => (err ? reject(err) : resolve()))
  })
}

export function isSerialOpen(): boolean {
  return active !== null && active.port.isOpen
}

export function activeSerialPath(): string | null {
  return active ? active.path : null
}
