import { app } from 'electron'
import { spawn } from 'node:child_process'
import { access, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * SDK layout — single, app-owned copy of libDaisy + DaisySP so we can
 * guarantee a known-good toolchain state across machines. Cloned on
 * first run; rebuilt on explicit install.
 *
 * Note: platform-specific toolchain paths (dfu-util/arm-gcc/make) vary:
 *   - macOS: dfu-util often at /opt/homebrew/bin or /usr/local/bin
 *   - Windows: dfu-util typically shipped via zadig or arm-none-eabi bundle
 * For now we resolve via `which` on the user's PATH and surface clear
 * errors when missing. A future bundled-toolchain story can live here.
 */

export const SDK_ROOT = join(app.getPath('userData'), 'sdk')
export const LIBDAISY_PATH = join(SDK_ROOT, 'libDaisy')
export const DAISYSP_PATH = join(SDK_ROOT, 'DaisySP')
export const WORKSPACE = join(app.getPath('userData'), 'workspace')

const LIBDAISY_REPO = 'https://github.com/electro-smith/libDaisy'
const DAISYSP_REPO = 'https://github.com/electro-smith/DaisySP'

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes: git clone + make can be slow

export interface SdkStatus {
  ready: boolean
  libDaisy: boolean
  daisySP: boolean
  libDaisyBuilt: boolean
  toolchain: { gcc: boolean; make: boolean; dfuUtil: boolean; pio?: boolean; python3?: boolean }
  /** Per-target readiness flags. Lets the renderer gate UI without another IPC. */
  esp32Ready?: boolean
  issues: string[]
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * Run a command via `which` (POSIX) or `where` (Windows) and return
 * whether it was found. We don't use the spawned exit code alone because
 * on some shells a missing binary still exits 0 with empty stdout.
 */
function whichBin(name: string): Promise<boolean> {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'where' : 'which'
  return new Promise((resolve) => {
    const child = spawn(cmd, [name], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0 && out.trim().length > 0))
  })
}

export async function getSdkStatus(): Promise<SdkStatus> {
  const [gcc, make, dfuUtil, pio, python3] = await Promise.all([
    whichBin('arm-none-eabi-gcc'),
    whichBin('make'),
    whichBin('dfu-util'),
    whichBin('pio'),
    whichBin('python3')
  ])

  const [libDaisyDir, daisySPDir] = await Promise.all([
    isDir(LIBDAISY_PATH),
    isDir(DAISYSP_PATH)
  ])

  const libDaisyBuilt =
    libDaisyDir &&
    ((await exists(join(LIBDAISY_PATH, 'build', 'libdaisy.a'))) ||
      (await exists(join(LIBDAISY_PATH, 'build', 'libDaisy.a'))))

  // DaisySP ships two libs — the core (libdaisysp.a, from DaisySP/Makefile)
  // and the LGPL subset (libdaisysp-lgpl.a, from DaisySP/DaisySP-LGPL/Makefile).
  // Our generated Makefile uses `USE_DAISYSP_LGPL = 1` which links BOTH, so
  // both must exist or the link step fails with `cannot find -ldaisysp`.
  const daisySPBuilt =
    daisySPDir && (await exists(join(DAISYSP_PATH, 'build', 'libdaisysp.a')))
  const daisySPLgplBuilt =
    daisySPDir &&
    (await exists(join(DAISYSP_PATH, 'DaisySP-LGPL', 'build', 'libdaisysp-lgpl.a')))

  const issues: string[] = []
  if (!gcc) issues.push('arm-none-eabi-gcc not found on PATH')
  if (!make) issues.push('make not found on PATH')
  if (!dfuUtil) issues.push('dfu-util not found on PATH')
  if (!libDaisyDir) issues.push('libDaisy not cloned')
  if (!daisySPDir) issues.push('DaisySP not cloned')
  if (libDaisyDir && !libDaisyBuilt) issues.push('libDaisy not built')
  if (daisySPDir && !daisySPBuilt) issues.push('DaisySP not built (libdaisysp.a)')
  if (daisySPDir && !daisySPLgplBuilt) issues.push('DaisySP-LGPL not built (libdaisysp-lgpl.a)')

  // ESP32 issues are surfaced separately — the renderer picks them up
  // via `esp32Ready` + the filtered-by-keyword "pio" items in `issues`.
  if (!pio) issues.push('platformio (pio) not found on PATH — run `pip install platformio`')
  if (!python3) issues.push('python3 not found on PATH')

  const toolchain = { gcc, make, dfuUtil, pio, python3 }
  const ready =
    gcc && make && dfuUtil && libDaisyDir && daisySPDir &&
    libDaisyBuilt && daisySPBuilt && daisySPLgplBuilt
  const esp32Ready = pio && python3

  return {
    ready,
    libDaisy: libDaisyDir,
    daisySP: daisySPDir,
    libDaisyBuilt,
    toolchain,
    esp32Ready,
    issues
  }
}

/**
 * Run a child process, streaming stdout and stderr line-by-line to the
 * emitter. Rejects on non-zero exit, spawn error, or timeout. Kills the
 * process on timeout so we don't leak handles.
 */
function runStreamed(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  emit: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const onLine = (line: string): void => emit(line)
    const rlOut = createInterface({ input: child.stdout })
    const rlErr = createInterface({ input: child.stderr })
    rlOut.on('line', onLine)
    rlErr.on('line', onLine)

    let timedOut = false
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            emit(`[timeout] killing ${command} after ${opts.timeoutMs}ms`)
            child.kill('SIGKILL')
          }, opts.timeoutMs)
        : null

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      rlOut.close()
      rlErr.close()
      if (timedOut) {
        reject(new Error(`${command} timed out`))
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

async function ensureRepo(
  repoUrl: string,
  destPath: string,
  emit: (line: string) => void
): Promise<void> {
  if (await isDir(join(destPath, '.git'))) {
    emit(`[git] updating ${destPath}`)
    // Update to latest on default branch. Electro-Smith uses `master`.
    await runStreamed(
      'git',
      ['-C', destPath, 'fetch', '--depth', '1', 'origin'],
      { timeoutMs: 5 * 60 * 1000 },
      emit
    )
    await runStreamed(
      'git',
      ['-C', destPath, 'reset', '--hard', 'origin/master'],
      { timeoutMs: 60 * 1000 },
      emit
    )
  } else {
    emit(`[git] cloning ${repoUrl} -> ${destPath}`)
    await runStreamed(
      'git',
      [
        'clone',
        '--depth', '1',
        '--recurse-submodules',
        '--shallow-submodules',
        repoUrl,
        destPath
      ],
      { timeoutMs: 15 * 60 * 1000 },
      emit
    )
  }

  // Always ensure submodules are populated. libDaisy's Makefile pulls
  // STM32 HAL, CMSIS-Device, CMSIS_5, etc. from submodules; if any are
  // empty `make` bails with exit 2 complaining about missing headers.
  // Running this is idempotent — if the submodules are already up to
  // date, it's a near-instant no-op.
  emit(`[git] init submodules in ${destPath}`)
  await runStreamed(
    'git',
    [
      '-C', destPath,
      'submodule', 'update',
      '--init',
      '--recursive',
      '--depth', '1'
    ],
    { timeoutMs: 15 * 60 * 1000 },
    emit
  )
}

export async function installSdk(emit: (msg: string) => void): Promise<void> {
  await mkdir(SDK_ROOT, { recursive: true })
  await mkdir(WORKSPACE, { recursive: true })

  const deadline = Date.now() + INSTALL_TIMEOUT_MS
  const remaining = (): number => Math.max(1000, deadline - Date.now())

  emit('[sdk] ensuring libDaisy')
  await ensureRepo(LIBDAISY_REPO, LIBDAISY_PATH, emit)

  emit('[sdk] ensuring DaisySP')
  await ensureRepo(DAISYSP_REPO, DAISYSP_PATH, emit)

  emit('[sdk] building libDaisy')
  await runStreamed(
    'make',
    ['-C', LIBDAISY_PATH],
    { timeoutMs: remaining() },
    emit
  )

  // DaisySP has its own Makefile producing libdaisysp.a. Without this the
  // final link step fails with `cannot find -ldaisysp`.
  emit('[sdk] building DaisySP')
  await runStreamed(
    'make',
    ['-C', DAISYSP_PATH],
    { timeoutMs: remaining() },
    emit
  )

  // DaisySP-LGPL is a separate sub-library (Moog ladder, ReverbSc, etc.).
  // Our generated Makefile sets `USE_DAISYSP_LGPL = 1` so we always need
  // libdaisysp-lgpl.a too.
  emit('[sdk] building DaisySP-LGPL')
  await runStreamed(
    'make',
    ['-C', join(DAISYSP_PATH, 'DaisySP-LGPL')],
    { timeoutMs: remaining() },
    emit
  )

  emit('[sdk] done')
}
