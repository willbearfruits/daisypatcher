import { execFile, spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { listSerialPorts } from './serialService'
import type { BoardId } from '../../shared/boards'
import { isEsp32Family } from '../../shared/boards'

export type FlashTarget = BoardId

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

/**
 * Fast Linux sysfs probe for the Daisy Seed's DFU enumeration. Reads
 * `/sys/bus/usb/devices/<n>/idVendor` + `/idProduct` to see if a device
 * with vendor `0483` and product `df11` is present. Runs in single-digit
 * milliseconds — compared to `dfu-util -l -v` which regularly takes 200
 * ms to several seconds depending on USB bus state. Good enough for the
 * 1 Hz poll; the richer dfu-util details (alt names, DfuSe interface,
 * bcdDevice) are only needed when the user opens the device popover or
 * initiates a flash.
 *
 * Returns `undefined` on non-Linux so callers fall back to dfu-util.
 */
async function linuxHasDaisyDfu(): Promise<boolean | undefined> {
  if (process.platform !== 'linux') return undefined
  const base = '/sys/bus/usb/devices'
  let entries: string[] = []
  try {
    entries = await readdir(base)
  } catch {
    return undefined
  }
  for (const e of entries) {
    // Skip interface entries like "1-2:1.0" — device nodes have no ':'.
    if (e.includes(':')) continue
    try {
      const [vid, pid] = await Promise.all([
        readFile(`${base}/${e}/idVendor`, 'utf8'),
        readFile(`${base}/${e}/idProduct`, 'utf8')
      ])
      if (vid.trim() === '0483' && pid.trim() === 'df11') return true
    } catch {
      // Device entry without idVendor/idProduct (hubs, interfaces). Skip.
    }
  }
  return false
}

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
  if (isEsp32Family(target)) {
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

  /*
   * Fast path: on Linux, check sysfs for `0483:df11`. When absent we
   * return instantly — the 1 Hz poll stays cheap and the cache clears.
   *
   * When sysfs says present but we don't yet have a dfu-util cache, run
   * dfu-util synchronously THIS ONCE so the device is truly confirmed
   * reachable before we flag `deviceAvailable=true`. Reason: sysfs sees
   * the device a moment before libusb/dfu-util can actually open it, so
   * an earlier version of this code flipped the Flash button on too
   * early and clicking it raced libusb. Subsequent polls (with a warm
   * cache) short-circuit — no dfu-util spawn while the device stays
   * plugged in.
   */
  const sysfsPresent = await linuxHasDaisyDfu()
  if (sysfsPresent === false) {
    dfuDetailsCache = []
    const serialPorts = await enumerateSerialInfo()
    return { dfuUtilInstalled: true, devices: [], esp32Ports: [], serialPorts, target }
  }
  if (sysfsPresent === true) {
    if (dfuDetailsCache.length === 0) {
      await refreshDfuDetails()
    } else {
      // Cache is warm — let a background refresh keep it current so
      // alts / DfuSe names stay accurate across re-plugs.
      void refreshDfuDetails()
    }
    const serialPorts = await enumerateSerialInfo()
    return {
      dfuUtilInstalled: true,
      devices: dfuDetailsCache,
      esp32Ports: [],
      serialPorts,
      target
    }
  }
  // sysfs unavailable (non-Linux or fs read failed) — fall through to
  // the synchronous dfu-util path.

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

/* ------------------------------------------------------------------
 * Background dfu-util details cache.
 *
 * The sysfs probe tells us presence in milliseconds, but the rich
 * details (alts, DfuSe interface name, bcdDevice) only come from
 * `dfu-util -l -v`. We keep the last dfu-util result in a module
 * cache and refresh it asynchronously so the detect() path never
 * blocks waiting on dfu-util.
 * ------------------------------------------------------------------ */
let dfuDetailsCache: FlashDevice[] = []
let dfuRefreshInFlight = false

async function refreshDfuDetails(): Promise<void> {
  if (dfuRefreshInFlight) return
  dfuRefreshInFlight = true
  try {
    const output = await new Promise<string>((resolve) => {
      execFile(
        'dfu-util',
        ['-l', '-v'],
        { timeout: DETECT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (_err, stdout, stderr) => resolve(`${stdout ?? ''}\n${stderr ?? ''}`)
      )
    })
    const all = parseDfuList(output)
    dfuDetailsCache = all.filter((d) => d.busId === '0483:df11')
  } catch {
    // Leave the cache as-is on failure; the next sysfs-false sweep clears it.
  } finally {
    dfuRefreshInFlight = false
  }
}

/* ------------------------------------------------------------------
 * Linux permission-failure detection — the #1 first-run trap.
 *
 * Without a udev rule, the Seed's DFU bootloader (0483:df11) is
 * root-only; dfu-util fails with "Cannot open DFU device ...
 * (LIBUSB_ERROR_ACCESS)" (older libusb prints "Access denied
 * (insufficient permissions)"). Without dialout-group membership,
 * pio's upload fails with pyserial's "[Errno 13] Permission denied:
 * '/dev/ttyACM0'". Both look like a generic flash failure unless we
 * name the fix.
 *
 * NOTE: DAISY_UDEV_RULE is copied VERBATIM from README.md, section
 * "Flashing permissions (Linux)". If you edit either, update the
 * other — the two strings must never drift.
 * ------------------------------------------------------------------ */
const DAISY_UDEV_RULE =
  'SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"'

/**
 * Returns copy-pasteable fix-it lines when `log` shows a Linux USB or
 * serial-port permission failure, or `undefined` when it doesn't (or
 * when off-Linux). Only consulted after a flash already failed, so a
 * rare false positive merely adds a hint under the real error.
 */
function linuxPermissionHint(log: string, target: FlashTarget): string[] | undefined {
  if (process.platform !== 'linux') return undefined

  if (isEsp32Family(target)) {
    const serialDenied =
      (/permission denied/i.test(log) && /\/dev\/tty/i.test(log)) ||
      /\[Errno 13\]/i.test(log) ||
      /EACCES/.test(log)
    if (!serialDenied) return undefined
    return [
      '[error] no permission to open the serial port (user not in the dialout group). One-time fix:',
      '[error]   sudo usermod -aG dialout $USER',
      '[error] then log out and back in, and unplug/replug the device.'
    ]
  }

  const usbDenied =
    /LIBUSB_ERROR_ACCESS/i.test(log) ||
    /Access denied/i.test(log) ||
    /insufficient permissions/i.test(log) ||
    /EACCES/.test(log)
  if (!usbDenied) return undefined
  return [
    '[error] no permission to open the DFU device (missing udev rule). One-time fix:',
    `[error]   echo '${DAISY_UDEV_RULE}' | sudo tee /etc/udev/rules.d/50-daisy-dfu.rules`,
    '[error]   sudo udevadm control --reload-rules && sudo udevadm trigger',
    '[error] then unplug/replug the device and flash again.'
  ]
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

  if (isEsp32Family(target)) {
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
      const success = !timedOut && code === 0 && successRegex.test(logLines.join('\n'))
      if (!success) {
        // Permission failures deserve a named fix, not a generic error.
        // push() both streams the lines to the renderer's log panel
        // (which auto-opens on flash failure) and appends them to the
        // returned log.
        const hint = linuxPermissionHint(logLines.join('\n'), target)
        if (hint) for (const line of hint) push(line)
      }
      resolve({ success, log: logLines.join('\n') })
    })
  })
}

/**
 * Given an ESP32 artifact path `.../<projectRoot>/.pio/build/<env>/firmware.bin`,
 * return the project root. Used by the flash service to choose the cwd
 * for `pio run --target upload`.
 */
function findProjectDirFor(binaryPath: string): string | undefined {
  // Normalize separators before searching — on Windows join() produces
  // backslashes and a '/.pio/' literal never matches, which used to leave
  // cwd undefined and run `pio run -t upload` in the app's own directory.
  const normalized = binaryPath.replace(/\\/g, '/')
  const idx = normalized.indexOf('/.pio/')
  if (idx < 0) return undefined
  return binaryPath.slice(0, idx)
}
