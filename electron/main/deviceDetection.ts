/**
 * Cross-target device autodetection.
 *
 * This module is deliberately separate from `flashService.ts` so the existing
 * target-scoped `detectFlashDevices(target)` API — used by the StatusBar
 * device pill and the flash gate — stays intact. Autodetection asks a
 * different question: "what's plugged in right now, regardless of the
 * renderer's selected target?". The result is consumed by the renderer to
 * auto-switch the compile target when the user hasn't locked it manually.
 *
 * Detection matrix:
 *
 *   Daisy Seed (DFU, post reset-button): dfu-util -l finds VID:PID 0483:df11
 *   Daisy Seed (running app firmware):   serialport lists VID=0483 (STMicro)
 *                                        OR manufacturer contains "STMicroelectronics"
 *   ESP32-S3 DevKitC-1:                  serialport lists one of:
 *       303a:1001  — Espressif native USB-JTAG/serial (S3 built-in)
 *       1a86:7523  — WCH CH340 UART bridge (common on older devkits)
 *       10c4:ea60  — Silicon Labs CP210x UART bridge
 *
 * Ambiguity rule: if BOTH a Daisy AND an ESP32 are present, `detectedBoard`
 * collapses to `null` and the renderer lets the user pick manually.
 */
import { execFile } from 'node:child_process'
import { listSerialPorts, type SerialPortInfo } from './serialService'

export type DetectedBoard = 'daisy_seed' | 'esp32_s3'

export interface DetectionResult {
  /** Daisy sitting in the STM32 DFU bootloader (0483:df11). */
  seedDfu: boolean
  /** Daisy running its app firmware, visible as a USB CDC port. */
  seedSerial: { path: string } | null
  /** ESP32-S3 DevKitC enumerated as a USB CDC port. */
  esp32Serial: { path: string } | null
  /**
   * Best-guess unambiguous board. `null` when nothing is present OR when
   * multiple targets are present simultaneously (user must pick manually).
   */
  detectedBoard: DetectedBoard | null
}

const DETECT_TIMEOUT_MS = 10 * 1000

/* ---------- VID:PID tables ------------------------------------------------ */

/** STMicro vendor id (Daisy Seed running app firmware). */
const ST_VID = '0483'

/**
 * ESP32-S3 DevKitC-1 observed VID:PID pairs. We match any of these; the
 * specific subvariant doesn't matter for target selection.
 */
const ESP32_VID_PID = new Set<string>([
  '303a:1001', // Espressif native USB (S3 internal)
  '1a86:7523', // WCH CH340 UART bridge
  '10c4:ea60'  // Silicon Labs CP210x UART bridge
])

/* ---------- helpers ------------------------------------------------------- */

function normaliseVidPid(p: SerialPortInfo): string | null {
  if (!p.vendorId || !p.productId) return null
  return `${p.vendorId.toLowerCase()}:${p.productId.toLowerCase()}`
}

function isSeedSerial(p: SerialPortInfo): boolean {
  const vid = (p.vendorId ?? '').toLowerCase()
  if (vid === ST_VID) return true
  const m = (p.manufacturer ?? '').toLowerCase()
  return m.includes('stmicroelectronics') || m.includes('stm32')
}

function isEsp32Serial(p: SerialPortInfo): boolean {
  const key = normaliseVidPid(p)
  if (!key) return false
  return ESP32_VID_PID.has(key)
}

/**
 * Probe `dfu-util -l` and report whether a Daisy DFU device is present.
 * Non-zero exit is expected when nothing is attached — we swallow it and
 * treat empty output as "not present". If `dfu-util` is missing from PATH,
 * execFile rejects and we return false; autodetection silently falls back
 * to serial-only detection in that case.
 */
async function probeSeedDfu(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'dfu-util',
      ['-l'],
      { timeout: DETECT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (_err, stdout, stderr) => {
        const out = `${stdout ?? ''}\n${stderr ?? ''}`
        // Presence is indicated by a `Found DFU: [0483:df11]` line.
        const re = /Found DFU:[^\n]*\[0483:df11\]/i
        resolve(re.test(out))
      }
    )
  }).catch(() => false) as Promise<boolean>
}

/* ---------- public API ---------------------------------------------------- */

export async function detectAllBoards(): Promise<DetectionResult> {
  // Run DFU probe and serial enumeration in parallel — independent paths.
  const [seedDfu, ports] = await Promise.all([probeSeedDfu(), listSerialPorts()])

  let seedSerial: { path: string } | null = null
  let esp32Serial: { path: string } | null = null

  for (const p of ports) {
    if (!seedSerial && isSeedSerial(p)) {
      seedSerial = { path: p.path }
    }
    if (!esp32Serial && isEsp32Serial(p)) {
      esp32Serial = { path: p.path }
    }
  }

  const daisyPresent = seedDfu || seedSerial !== null
  const esp32Present = esp32Serial !== null

  let detectedBoard: DetectedBoard | null
  if (daisyPresent && esp32Present) {
    // Ambiguous — renderer keeps the user's pick / doesn't auto-switch.
    detectedBoard = null
  } else if (daisyPresent) {
    detectedBoard = 'daisy_seed'
  } else if (esp32Present) {
    detectedBoard = 'esp32_s3'
  } else {
    detectedBoard = null
  }

  return { seedDfu, seedSerial, esp32Serial, detectedBoard }
}
