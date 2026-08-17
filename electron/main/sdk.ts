import { app } from 'electron'
import { spawn } from 'node:child_process'
import { access, mkdir, rm, stat } from 'node:fs/promises'
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
  toolchain: {
    gcc: boolean
    make: boolean
    dfuUtil: boolean
    pio?: boolean
    python3?: boolean
    git?: boolean
  }
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

/**
 * How to get a missing tool, per OS.
 *
 * The status list said "arm-none-eabi-gcc not found on PATH" and stopped
 * — accurate, and useless to someone who has never heard of it. Windows
 * gets one answer for all three Daisy tools because Electro-Smith ships
 * them together and hunting them down separately is how you end up with
 * a make that cannot find its shell.
 */
function installHint(tool: 'git' | 'gcc' | 'make' | 'dfu-util' | 'python3'): string {
  const os = process.platform
  const DAISY_TOOLCHAIN =
    'install the Daisy Toolchain (github.com/electro-smith/DaisyToolchain) — it bundles gcc, make and dfu-util'
  switch (tool) {
    case 'git':
      return os === 'win32'
        ? 'install Git for Windows (git-scm.com or `winget install Git.Git`)'
        : os === 'darwin'
          ? 'run `xcode-select --install`'
          : 'install git with your package manager (`sudo apt install git`)'
    case 'gcc':
      return os === 'win32'
        ? DAISY_TOOLCHAIN
        : os === 'darwin'
          ? '`brew install --cask gcc-arm-embedded`'
          : '`sudo apt install gcc-arm-none-eabi` (Fedora: arm-none-eabi-gcc-cs + arm-none-eabi-newlib; Arch: arm-none-eabi-gcc + arm-none-eabi-newlib)'
    case 'make':
      return os === 'win32'
        ? DAISY_TOOLCHAIN
        : os === 'darwin'
          ? 'run `xcode-select --install`'
          : '`sudo apt install build-essential`'
    case 'dfu-util':
      return os === 'win32'
        ? `${DAISY_TOOLCHAIN}; then run Zadig once to bind WinUSB to the Seed in DFU mode`
        : os === 'darwin'
          ? '`brew install dfu-util`'
          : '`sudo apt install dfu-util`'
    case 'python3':
      return os === 'win32'
        ? 'install Python 3 from python.org and tick "Add to PATH"'
        : 'install python3 with your package manager'
  }
}

export async function getSdkStatus(): Promise<SdkStatus> {
  const [gcc, make, dfuUtil, pio, python3, git] = await Promise.all([
    whichBin('arm-none-eabi-gcc'),
    whichBin('make'),
    whichBin('dfu-util'),
    whichBin('pio'),
    whichBin('python3'),
    whichBin('git')
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
  if (!git) issues.push(`git not found on PATH — required to install the SDK; ${installHint('git')}`)
  if (!gcc) issues.push(`arm-none-eabi-gcc not found on PATH — ${installHint('gcc')}`)
  if (!make) issues.push(`make not found on PATH — ${installHint('make')}`)
  if (!dfuUtil) issues.push(`dfu-util not found on PATH — needed to flash; ${installHint('dfu-util')}`)
  if (!libDaisyDir) issues.push('libDaisy not cloned')
  if (!daisySPDir) issues.push('DaisySP not cloned')
  if (libDaisyDir && !libDaisyBuilt) issues.push('libDaisy not built')
  if (daisySPDir && !daisySPBuilt) issues.push('DaisySP not built (libdaisysp.a)')
  if (daisySPDir && !daisySPLgplBuilt) issues.push('DaisySP-LGPL not built (libdaisysp-lgpl.a)')

  // ESP32 issues are surfaced separately — the renderer picks them up
  // via `esp32Ready` + the filtered-by-keyword "pio" items in `issues`.
  if (!pio) issues.push('platformio (pio) not found on PATH — use the ESP32 installer in the top bar, or `pipx install platformio`')
  if (!python3) issues.push(`python3 not found on PATH — ${installHint('python3')}`)

  const toolchain = { gcc, make, dfuUtil, pio, python3, git }
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

async function cloneFresh(
  repoUrl: string,
  destPath: string,
  emit: (line: string) => void
): Promise<void> {
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

async function ensureRepo(
  repoUrl: string,
  destPath: string,
  emit: (line: string) => void
): Promise<void> {
  // Interrupted-clone recovery: a dir WITHOUT `.git` (clone killed mid-way,
  // timeouts use SIGKILL) wedges `git clone` forever with "destination path
  // already exists". Delete it and start clean.
  if (!(await isDir(join(destPath, '.git'))) && (await isDir(destPath))) {
    emit(`[git] removing partial clone at ${destPath}`)
    await rm(destPath, { recursive: true, force: true })
  }

  if (await isDir(join(destPath, '.git'))) {
    try {
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
    } catch (err) {
      // Corrupt repo (killed mid-fetch, broken objects) — fetch/reset can't
      // heal it. One recovery path: wipe and re-clone.
      emit(`[git] update failed (${(err as Error).message}) — re-cloning fresh`)
      await rm(destPath, { recursive: true, force: true })
      await cloneFresh(repoUrl, destPath, emit)
    }
  } else {
    await cloneFresh(repoUrl, destPath, emit)
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
  // Preflight: a missing git otherwise surfaces as a raw `spawn git ENOENT`
  // in the install modal, and a missing compiler surfaces as
  // `arm-none-eabi-gcc: not found` three minutes and fifty megabytes into
  // the build. Check everything the build will need BEFORE cloning.
  if (!(await whichBin('git'))) {
    throw new Error(`git not found on PATH — ${installHint('git')}, then retry the SDK install`)
  }
  if (!(await whichBin('arm-none-eabi-gcc'))) {
    throw new Error(
      `arm-none-eabi-gcc not found on PATH — the SDK cannot be built without the ARM compiler. ` +
        `${installHint('gcc')}, restart Daisypatcher, then retry.`
    )
  }
  if (!(await whichBin('make'))) {
    throw new Error(`make not found on PATH — ${installHint('make')}, restart Daisypatcher, then retry`)
  }

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

/* -------------------------------------------------------------------------
 * ESP32-S3 toolchain installer
 *
 * PlatformIO is a Python package. Unlike the libDaisy flow (git clone + make)
 * we rely on the user's Python for install. Strategy, per platform:
 *   1. Prefer `pipx install platformio` — isolated venv, user-level, no sudo.
 *   2. Fall back to `<python> -m pip install --user platformio`.
 *   3. Detect Python via common executable names; on Windows, try `py` first
 *      (Python Launcher) which handles multi-version selection cleanly.
 *
 * After install we also run `pio platform install espressif32` so the first
 * compile doesn't stall downloading ~250 MB of toolchain inside make. The
 * `resolvePioCommand` helper locates `pio` even when the user's shell PATH
 * hasn't been reloaded yet (pipx / pip --user deposit to ~/.local/bin or
 * %APPDATA%\Python\...\Scripts, neither of which is guaranteed in the
 * running Electron process environment).
 * --------------------------------------------------------------------- */

interface PythonInstaller {
  cmd: string
  args: string[]
  kind: 'pipx' | 'pip-user'
}

async function findPythonInstaller(): Promise<PythonInstaller | null> {
  // pipx is the cleanest install path — it creates an isolated venv, exposes
  // `pio` as a shim, and won't pollute the user's global site-packages.
  if (await whichBin('pipx')) {
    return { cmd: 'pipx', args: ['install', 'platformio'], kind: 'pipx' }
  }
  const isWin = process.platform === 'win32'
  // On Windows the Python Launcher (`py`) is preferred — it picks the
  // highest installed version automatically and is always on PATH when
  // Python was installed from python.org.
  const pyCandidates = isWin
    ? ['py', 'python', 'python3']
    : ['python3', 'python']
  for (const py of pyCandidates) {
    if (await whichBin(py)) {
      return {
        cmd: py,
        args: ['-m', 'pip', 'install', '--user', 'platformio'],
        kind: 'pip-user'
      }
    }
  }
  return null
}

async function resolvePioCommand(): Promise<string | null> {
  if (await whichBin('pio')) return 'pio'
  // When pipx / pip --user deposits the pio shim into a user-local bin dir
  // that isn't on the currently-running process's PATH, search the common
  // locations directly. Restarting the app normally picks up the new PATH,
  // but walking the fs lets us finish the install in this same session.
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) return null
  const isWin = process.platform === 'win32'
  const candidates = isWin
    ? [
        // pipx on Windows
        join(home, '.local', 'bin', 'pio.exe'),
        join(home, 'pipx', 'venvs', 'platformio', 'Scripts', 'pio.exe'),
        // py -m pip install --user — Scripts dir varies by Python version
        join(home, 'AppData', 'Roaming', 'Python', 'Python313', 'Scripts', 'pio.exe'),
        join(home, 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts', 'pio.exe'),
        join(home, 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts', 'pio.exe'),
        join(home, 'AppData', 'Roaming', 'Python', 'Python310', 'Scripts', 'pio.exe')
      ]
    : [
        join(home, '.local', 'bin', 'pio'),
        '/usr/local/bin/pio',
        '/opt/homebrew/bin/pio'
      ]
  for (const c of candidates) {
    if (await exists(c)) return c
  }
  return null
}

export async function installEsp32Toolchain(
  emit: (line: string) => void
): Promise<void> {
  emit('[esp32] detecting Python…')
  const installer = await findPythonInstaller()
  if (!installer) {
    throw new Error(
      process.platform === 'win32'
        ? 'No Python detected. Install Python 3 from python.org (check "Add to PATH") and try again.'
        : 'No Python detected on PATH. Install python3 via your package manager (apt/brew/dnf) and try again.'
    )
  }
  emit(`[esp32] using ${installer.kind} via ${installer.cmd}`)

  // If pio already exists we don't reinstall — only top up the platform.
  const preExisting = await resolvePioCommand()
  if (preExisting) {
    emit('[esp32] platformio already present, skipping install step')
  } else {
    emit('[esp32] installing platformio (3–5 min on a fresh system)')
    await runStreamed(
      installer.cmd,
      installer.args,
      { timeoutMs: 15 * 60 * 1000 },
      emit
    )
    if (installer.kind === 'pipx') {
      // Permanently add pipx's bin dir to the user's shell PATH. Harmless
      // if already present; swallow failure because some pipx variants
      // don't ship this subcommand.
      try {
        await runStreamed(
          'pipx',
          ['ensurepath'],
          { timeoutMs: 60 * 1000 },
          emit
        )
      } catch {
        emit('[esp32] pipx ensurepath skipped (non-fatal)')
      }
    }
  }

  const pio = await resolvePioCommand()
  if (!pio) {
    throw new Error(
      'platformio installed but the `pio` command is not yet on PATH. ' +
        'Restart Daisypatcher (or log out/in on Windows) and re-run the install.'
    )
  }

  emit('[esp32] downloading ESP32-S3 platform (~250 MB, 5–15 min on first run)')
  await runStreamed(
    pio,
    ['platform', 'install', 'espressif32'],
    { timeoutMs: 30 * 60 * 1000 },
    emit
  )

  emit('[esp32] done')
}
