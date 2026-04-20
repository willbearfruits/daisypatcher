import { execFile, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { listSerialPorts } from './serialService'

export type FlashTarget = 'daisy_seed' | 'esp32_s3'

/**
 * Daisy-only flash mode (mirror of `DaisyFlashMode` in the renderer's
 * store types — kept local so the main process doesn't pull from `src/`).
 *   - 'internal' — BOOT_NONE / internal flash @ 0x08000000.
 *   - 'qspi'     — BOOT_QSPI / QSPI flash    @ 0x90040000 (default; Daisy Bootloader).
 *   - 'sram'     — BOOT_SRAM / SRAM          @ 0x24000000 (volatile).
 */
export type DaisyFlashMode = 'internal' | 'qspi' | 'sram'

export const DAISY_FLASH_ADDRS: Record<DaisyFlashMode, string> = {
  internal: '0x08000000',
  qspi: '0x90040000',
  sram: '0x24000000'
}

/**
 * DFU flashing for the Daisy Seed. Seed sits on the STM32H7 bootloader
 * which enumerates as vendor:product `0483:df11`. We parse `dfu-util -l`
 * to list candidates. Typical line shape:
 *
 *   Found DFU: [0483:df11] ver=0200, devnum=42, cfg=1, intf=0, path="1-2",
 *     alt=0, name="@Internal Flash  /0x08000000/16*128Kg", serial="DFU..."
 *
 * Platform-specific notes (do NOT implement now):
 *   - macOS: dfu-util is commonly /opt/homebrew/bin/dfu-util (Apple Silicon)
 *     or /usr/local/bin/dfu-util (Intel). `libusb` is a prereq.
 *   - Windows: requires the WinUSB driver via Zadig to see Daisy in DFU.
 *     dfu-util is typically shipped with Electro-Smith's toolchain bundle.
 *   - Linux: udev rule for 0483:df11 may be needed to flash without sudo.
 */

const DFU_TIMEOUT_MS = 2 * 60 * 1000
const DETECT_TIMEOUT_MS = 10 * 1000

export interface FlashDevice {
  busId: string
  serial?: string
  altName?: string
  /** Alt-setting number (`alt=0`, `alt=1`, ...). */
  alt?: number
  /** libusb device number — stable per-connection, not across unplug. */
  devnum?: number
  /** DFU config index (`cfg=1`). */
  cfg?: number
  /** DFU interface index (`intf=0`). */
  intf?: number
  /** USB topology path (`path="1-2"`). */
  path?: string
  /** Raw DFU version (`ver=0x011a`). Some builds print `ver=011a`. */
  bcdDevice?: string
  /**
   * DfuSe interface-name string (`DfuSe interface name: "Flash "`).
   * Used to distinguish the Electro-Smith Daisy Bootloader ("Flash ")
   * from STMicro's system bootloader ("Internal Flash"). Populated by
   * a secondary `dfu-util -l -v` capture.
   */
  dfuseInterfaceName?: string
}

/** Extra detail to include alongside the pure DFU device list. */
export interface FlashSerialInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
}

export interface FlashStatus {
  dfuUtilInstalled: boolean
  devices: FlashDevice[]
  /** Serial ports where an ESP32 would enumerate (ttyACM*, ttyUSB*, cu.usbserial*). */
  esp32Ports: string[]
  /**
   * Richer serial-port enumeration — populated on both targets so the
   * StatusBar popover can show the ESP32's `/dev/ttyACM*` VID:PID, and
   * so the Daisy popover can surface any co-present STMicro CDC.
   */
  serialPorts?: FlashSerialInfo[]
  /** Which target the renderer asked about (echoed for label logic). */
  target?: FlashTarget
}

function whichBin(name: string): Promise<boolean> {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'where' : 'which'
  return new Promise((resolve) => {
    execFile(cmd, [name], (err, stdout) => {
      resolve(!err && stdout.trim().length > 0)
    })
  })
}

/**
 * Parse a full `dfu-util -l` (optionally `-v`) capture into a list of
 * per-alt devices. A typical line looks like:
 *
 *   Found DFU: [0483:df11] ver=0200, devnum=42, cfg=1, intf=0, path="1-2", \
 *     alt=0, name="@Internal Flash /0x08000000/16*128Kg", serial="3866364F3432"
 *
 * We also scan for the companion `DfuSe interface name: "<value>"` line
 * — dfu-util emits it when run verbosely. It's what tells us apart the
 * Daisy Bootloader ("Flash ") from STMicro's system bootloader
 * ("Internal Flash") without having to parse the `name=...` heuristically.
 */
function parseDfuList(output: string): FlashDevice[] {
  const devices: FlashDevice[] = []
  const seen = new Set<string>()

  // Last-seen DfuSe interface name, applied to the next device entry.
  // dfu-util -v prints the banner immediately before the matching
  // `Found DFU` line, so "last seen wins" is correct here.
  let pendingDfuseName: string | undefined

  const lines = output.split(/\r?\n/)
  const pick = (source: string, key: string): string | undefined => {
    // Non-greedy value between the key and either a comma-followed-by-key
    // or end-of-line. Works for both `key=value` and `key="value"` forms.
    const re = new RegExp(`${key}=("([^"]*)"|([^,\\s]+))`, 'i')
    const m = re.exec(source)
    return m ? (m[2] ?? m[3]) : undefined
  }

  for (const line of lines) {
    const dfuseMatch = /DfuSe interface name:\s*"([^"]*)"/i.exec(line)
    if (dfuseMatch) {
      pendingDfuseName = dfuseMatch[1]
      continue
    }

    if (!/Found DFU/i.test(line)) continue
    const busMatch = /\[([0-9a-f]{4}:[0-9a-f]{4})\]/i.exec(line)
    if (!busMatch) continue
    const busId = busMatch[1].toLowerCase()

    const altRaw = pick(line, 'alt')
    const devnumRaw = pick(line, 'devnum')
    const cfgRaw = pick(line, 'cfg')
    const intfRaw = pick(line, 'intf')
    const path = pick(line, 'path')
    const bcdDevice = pick(line, 'ver')
    const altName = pick(line, 'name')
    const serial = pick(line, 'serial')

    const alt = altRaw !== undefined ? parseInt(altRaw, 10) : undefined
    const devnum = devnumRaw !== undefined ? parseInt(devnumRaw, 10) : undefined
    const cfg = cfgRaw !== undefined ? parseInt(cfgRaw, 10) : undefined
    const intf = intfRaw !== undefined ? parseInt(intfRaw, 10) : undefined

    const key = `${busId}|${serial ?? ''}|${alt ?? ''}|${altName ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    devices.push({
      busId,
      altName,
      serial,
      alt,
      devnum,
      cfg,
      intf,
      path,
      bcdDevice,
      dfuseInterfaceName: pendingDfuseName
    })
  }
  return devices
}

/**
 * Enumerate likely ESP32 serial devices. On Linux the DevKitC shows up
 * as `/dev/ttyACM*` (built-in USB CDC on the S3) or `/dev/ttyUSB*`
 * (older devkits with CP210x / CH340 bridge). On macOS the bridged
 * devkits enumerate as `/dev/cu.usbserial-*`; S3-native CDC as
 * `/dev/cu.usbmodem-*`. We do a light directory scan rather than
 * shelling out to `lsusb`/`ioreg` for simplicity.
 */
async function detectEsp32Ports(): Promise<string[]> {
  const out: string[] = []
  if (process.platform === 'linux') {
    try {
      const entries = await readdir('/dev')
      for (const e of entries) {
        if (/^ttyACM\d+$/.test(e) || /^ttyUSB\d+$/.test(e)) {
          out.push(`/dev/${e}`)
        }
      }
    } catch { /* /dev missing — unreachable on Linux, but keep defensive */ }
  } else if (process.platform === 'darwin') {
    try {
      const entries = await readdir('/dev')
      for (const e of entries) {
        if (e.startsWith('cu.usbserial') || e.startsWith('cu.usbmodem')) {
          out.push(`/dev/${e}`)
        }
      }
    } catch { /* idem */ }
  }
  // Windows: COM ports aren't in the filesystem; detection would hook
  // `serialport` list(), which the renderer already does via
  // `serialService.listSerialPorts`. Leave empty for now; the UI falls
  // back to "no device" and the build log surfaces pio's error.
  return out
}

/**
 * Enumerate serial ports via the `serialport` module. Kept as a tiny
 * wrapper so the flash service stays free of a direct serial import
 * when serial detection fails (e.g. no permissions on a raw TTY).
 */
async function enumerateSerialInfo(): Promise<FlashSerialInfo[]> {
  try {
    const ports = await listSerialPorts()
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

export async function detectFlashDevices(target: FlashTarget = 'daisy_seed'): Promise<FlashStatus> {
  // ESP32 path — no DFU; look for a serial port instead.
  if (target === 'esp32_s3') {
    const [esp32Ports, serialPorts] = await Promise.all([
      detectEsp32Ports(),
      enumerateSerialInfo()
    ])
    return {
      dfuUtilInstalled: await whichBin('dfu-util'),
      devices: [],
      esp32Ports,
      serialPorts,
      target
    }
  }

  const dfuUtilInstalled = await whichBin('dfu-util')
  if (!dfuUtilInstalled) {
    const serialPorts = await enumerateSerialInfo()
    return { dfuUtilInstalled: false, devices: [], esp32Ports: [], serialPorts, target }
  }

  // Prefer verbose output — that's where `DfuSe interface name:` lives,
  // which we use to distinguish the Daisy Bootloader from STMicro's
  // system bootloader. Non-zero exit is expected when nothing is
  // attached; swallow stderr and parse whatever came out.
  const output = await new Promise<string>((resolve) => {
    execFile(
      'dfu-util',
      ['-l', '-v'],
      { timeout: DETECT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (_err, stdout, stderr) => {
        resolve(`${stdout ?? ''}\n${stderr ?? ''}`)
      }
    )
  })

  const all = parseDfuList(output)
  // Daisy Seed specifically: STM32 DFU vendor/product.
  const devices = all.filter((d) => d.busId === '0483:df11')
  const serialPorts = await enumerateSerialInfo()
  return { dfuUtilInstalled: true, devices, esp32Ports: [], serialPorts, target }
}

export async function flashBinary(
  binaryPath: string,
  emit: (line: string) => void,
  target: FlashTarget = 'daisy_seed',
  daisyFlashMode: DaisyFlashMode = 'qspi'
): Promise<{ success: boolean; log: string }> {
  const logLines: string[] = []
  const push = (line: string): void => {
    logLines.push(line)
    emit(line)
  }

  let cmd: string
  let args: string[]
  let cwd: string | undefined
  let successRegex: RegExp

  if (target === 'esp32_s3') {
    // Idiomatic path: `pio run --target upload` auto-detects the port and
    // handles DTR/RTS bootloader entry. We run it inside the project dir
    // that buildProject created — derive it from the binary path by
    // walking up out of `.pio/build/<env>/firmware.bin`.
    const projectDir = findProjectDirFor(binaryPath)
    cmd = 'pio'
    args = ['run', '--target', 'upload']
    cwd = projectDir
    successRegex = /\b(SUCCESS|Hard resetting via RTS pin|Leaving\.\.\.)/i
  } else {
    // Daisy: dfu-util with the STM32 DFU leave-and-execute dance. The
    // target address depends on the flash mode — QSPI (Daisy Bootloader)
    // is the safe default; INTERNAL requires a boot-loader-less Seed
    // sitting in STMicro system DFU.
    const addr = DAISY_FLASH_ADDRS[daisyFlashMode] ?? DAISY_FLASH_ADDRS.qspi
    push(`[flash] mode=${daisyFlashMode} addr=${addr}`)
    cmd = 'dfu-util'
    args = ['-a', '0', '-i', '0', '-s', `${addr}:leave`, '-D', binaryPath]
    successRegex = /Download done/i
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const rlOut = createInterface({ input: child.stdout })
    const rlErr = createInterface({ input: child.stderr })
    rlOut.on('line', push)
    rlErr.on('line', push)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      push(`[timeout] killing ${cmd} after ${DFU_TIMEOUT_MS}ms`)
      child.kill('SIGKILL')
    }, DFU_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      push(`[error] ${err.message}`)
      rlOut.close()
      rlErr.close()
      resolve({ success: false, log: logLines.join('\n') })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      rlOut.close()
      rlErr.close()
      const log = logLines.join('\n')
      const success = !timedOut && code === 0 && successRegex.test(log)
      resolve({ success, log })
    })
  })
}

/**
 * Given an ESP32 artifact path `.../<projectRoot>/.pio/build/<env>/firmware.bin`,
 * return the project root. Used by the flash service to choose the cwd
 * for `pio run --target upload`.
 */
function findProjectDirFor(binaryPath: string): string | undefined {
  const pioMarker = '/.pio/'
  const idx = binaryPath.indexOf(pioMarker)
  if (idx < 0) return undefined
  return binaryPath.slice(0, idx)
}
