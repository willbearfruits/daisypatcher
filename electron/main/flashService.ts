import { execFile, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'

export type FlashTarget = 'daisy_seed' | 'esp32_s3'

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
}

export interface FlashStatus {
  dfuUtilInstalled: boolean
  devices: FlashDevice[]
  /** Serial ports where an ESP32 would enumerate (ttyACM*, ttyUSB*, cu.usbserial*). */
  esp32Ports: string[]
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

function parseDfuList(output: string): FlashDevice[] {
  const devices: FlashDevice[] = []
  const seen = new Set<string>()
  // Prefer the `Found DFU:` lines.
  const re =
    /\[([0-9a-f]{4}:[0-9a-f]{4})\][^]*?(?:alt=\d+,\s*name="([^"]*)")?(?:[^]*?serial="([^"]*)")?/gi
  for (const line of output.split(/\r?\n/)) {
    if (!/Found DFU/i.test(line)) continue
    re.lastIndex = 0
    const m = re.exec(line)
    if (!m) continue
    const busId = m[1].toLowerCase()
    const altName = m[2] || undefined
    const serial = m[3] || undefined
    const key = `${busId}|${serial ?? ''}|${altName ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    devices.push({ busId, altName, serial })
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

export async function detectFlashDevices(target: FlashTarget = 'daisy_seed'): Promise<FlashStatus> {
  // ESP32 path — no DFU; look for a serial port instead.
  if (target === 'esp32_s3') {
    const esp32Ports = await detectEsp32Ports()
    return {
      dfuUtilInstalled: await whichBin('dfu-util'),
      devices: [],
      esp32Ports,
      target
    }
  }

  const dfuUtilInstalled = await whichBin('dfu-util')
  if (!dfuUtilInstalled) {
    return { dfuUtilInstalled: false, devices: [], esp32Ports: [], target }
  }

  const output = await new Promise<string>((resolve) => {
    execFile(
      'dfu-util',
      ['-l'],
      { timeout: DETECT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (_err, stdout, stderr) => {
        // dfu-util returns non-zero when nothing is attached; that's fine.
        resolve(`${stdout ?? ''}\n${stderr ?? ''}`)
      }
    )
  })

  const all = parseDfuList(output)
  // Daisy Seed specifically: STM32 DFU vendor/product.
  const devices = all.filter((d) => d.busId === '0483:df11')
  return { dfuUtilInstalled: true, devices, esp32Ports: [], target }
}

export async function flashBinary(
  binaryPath: string,
  emit: (line: string) => void,
  target: FlashTarget = 'daisy_seed'
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
    // Daisy: dfu-util with the STM32 DFU leave-and-execute dance.
    cmd = 'dfu-util'
    args = ['-a', '0', '-i', '0', '-s', '0x08000000:leave', '-D', binaryPath]
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
