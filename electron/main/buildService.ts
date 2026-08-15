import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { LIBDAISY_PATH, DAISYSP_PATH, WORKSPACE } from './sdk'
import type { BoardId } from '../../shared/boards'
import { PIO_ENV, WORKSPACE_DIR, coerceBoardId } from '../../shared/boards'

/**
 * Cross-platform containment check. `path.relative()` yields OS-appropriate
 * separators on every platform, so we don't have to special-case Windows
 * backslash paths the way a naive `startsWith(base + '/')` would.
 */
export function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export type BuildTarget = BoardId

export interface BuildInput {
  projectName: string
  files: Record<string, string>
  /** Target board — drives compiler choice + artifact path. */
  target?: BuildTarget
}

/** Per-target build recipe the service uses to dispatch spawn()/artifact lookup. */
interface TargetRecipe {
  /** Sub-directory under WORKSPACE. Keeps seed + esp32 builds from colliding. */
  workspaceDir: string
  /** Argv for the main build command. */
  command: string
  args: string[]
  /** Optional `make clean` preamble. */
  clean?: { command: string; args: string[] }
  /** Where to look for the artifact, relative to the project dir. */
  artifact: (projectName: string) => string
  /** Extra env to merge on top of process.env. */
  env: NodeJS.ProcessEnv
}

/**
 * Build recipe per board.
 *
 * Every Espressif board shares the same `pio run` recipe — only the
 * workspace directory and the artifact path differ, and both are derived
 * from the shared board tables so the PlatformIO env name exists in
 * exactly one place. Each board gets its own workspace dir: three ESP32
 * variants sharing one directory would overwrite each other's
 * `platformio.ini` and meet a warm `.pio` cache built for a different
 * chip, which surfaces as a baffling "it flashed the wrong firmware".
 */
function recipeFor(target: BuildTarget): TargetRecipe {
  const pioEnv = PIO_ENV[target]
  if (pioEnv !== null) {
    return {
      workspaceDir: WORKSPACE_DIR[target],
      command: 'pio',
      args: ['run'],
      artifact: () => `.pio/build/${pioEnv}/firmware.bin`,
      env: {}
    }
  }
  return {
    workspaceDir: WORKSPACE_DIR[target],
    command: 'make',
    args: [],
    clean: { command: 'make', args: ['clean'] },
    artifact: (projectName) => `build/${projectName}.bin`,
    env: {
      LIBDAISY_DIR: LIBDAISY_PATH,
      DAISYSP_DIR: DAISYSP_PATH
    }
  }
}

export interface BuildResult {
  success: boolean
  projectPath: string
  binaryPath?: string
  binarySize?: number
  durationMs: number
  log: string
}

const BUILD_TIMEOUT_MS = 3 * 60 * 1000
const LOG_TAIL_BYTES = 200 * 1024

/**
 * Allowlist: letters, digits, underscore, hyphen. Everything else is
 * replaced with `_`. Reject empty/`.`/`..` defensively. Callers must
 * always pass the sanitized value through `join(WORKSPACE, ...)` and
 * re-verify the resolved path stays inside WORKSPACE before any write.
 */
export function sanitizeProjectName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'project'
  return cleaned.slice(0, 64)
}

/**
 * Bounded log buffer — keeps only the tail so an extra-chatty build
 * doesn't balloon main-process memory. Still streams every line.
 */
class TailBuffer {
  private chunks: string[] = []
  private size = 0
  constructor(private readonly limit: number) {}
  push(line: string): void {
    const entry = line + '\n'
    this.chunks.push(entry)
    this.size += entry.length
    while (this.size > this.limit && this.chunks.length > 1) {
      const head = this.chunks.shift()!
      this.size -= head.length
    }
  }
  toString(): string {
    return this.chunks.join('')
  }
}

function runStreamed(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  emit: (line: string) => void,
  tail: TailBuffer
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const onLine = (line: string): void => {
      tail.push(line)
      emit(line)
    }
    const rlOut = createInterface({ input: child.stdout })
    const rlErr = createInterface({ input: child.stderr })
    rlOut.on('line', onLine)
    rlErr.on('line', onLine)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      onLine(`[timeout] killing ${command} after ${opts.timeoutMs}ms`)
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      rlOut.close()
      rlErr.close()
      if (timedOut) {
        reject(new Error(`${command} timed out`))
        return
      }
      resolvePromise(code ?? -1)
    })
  })
}

/**
 * Clean `projectPath` keeping only an optional `.git` dir (so user
 * customizations tracked with git survive). Never escapes the dir.
 */
async function cleanProjectDir(projectPath: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(projectPath)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((e) => e !== '.git')
      .map((e) => rm(join(projectPath, e), { recursive: true, force: true }))
  )
}

/**
 * Write a generated project into the workspace and return its path.
 *
 * Split out of `buildProject` so "show me this on disk" does not have to
 * run a compiler. Both paths share it, so an ejected project is byte-for-
 * byte the one that would have been built — which is the whole point of
 * offering the button.
 */
export async function writeProjectFiles(
  input: BuildInput,
  emit: (line: string) => void = () => undefined
): Promise<string> {
  // Trust boundary: the renderer supplies this. coerceBoardId also maps
  // the legacy 'esp32_s3' spelling onto the DevKitC id.
  const target: BuildTarget = coerceBoardId(input.target)
  const recipe = recipeFor(target)
  const safeName = sanitizeProjectName(input.projectName)
  const targetRoot = join(WORKSPACE, recipe.workspaceDir)
  const projectPath = join(targetRoot, safeName)

  // Defense in depth: re-resolve and verify containment.
  const workspaceAbs = resolve(WORKSPACE)
  const projectAbs = resolve(projectPath)
  if (!isInside(workspaceAbs, projectAbs)) {
    throw new Error(`refusing to write outside workspace: ${projectAbs}`)
  }

  await mkdir(WORKSPACE, { recursive: true })
  await mkdir(targetRoot, { recursive: true })
  await mkdir(projectPath, { recursive: true })
  await cleanProjectDir(projectPath)

  // Write every file; reject keys that try to escape the dir.
  for (const [relPath, contents] of Object.entries(input.files)) {
    const dest = resolve(projectPath, relPath)
    if (!isInside(projectAbs, dest)) {
      throw new Error(`refusing to write file outside project: ${relPath}`)
    }
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, contents, 'utf8')
    emit(`[write] ${relPath}`)
  }
  return projectPath
}

export async function buildProject(
  input: BuildInput,
  emit: (line: string) => void
): Promise<BuildResult> {
  const started = Date.now()
  const tail = new TailBuffer(LOG_TAIL_BYTES)
  const pushLog = (line: string): void => {
    tail.push(line)
    emit(line)
  }

  // Trust boundary: the renderer supplies this. coerceBoardId also maps
  // the legacy 'esp32_s3' spelling onto the DevKitC id.
  const target: BuildTarget = coerceBoardId(input.target)
  const recipe = recipeFor(target)

  // Per-target subdirectory keeps Seed and ESP32 builds from colliding.
  const safeName = sanitizeProjectName(input.projectName)
  const projectPath = await writeProjectFiles(input, pushLog)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...recipe.env
  }

  const deadline = started + BUILD_TIMEOUT_MS
  const remaining = (): number => Math.max(1000, deadline - Date.now())

  if (recipe.clean) {
    try {
      pushLog(`[${recipe.command}] clean`)
      await runStreamed(
        recipe.clean.command,
        recipe.clean.args,
        { cwd: projectPath, env, timeoutMs: remaining() },
        emit,
        tail
      )
    } catch (err) {
      pushLog(`[${recipe.command}] clean skipped: ${(err as Error).message}`)
    }
  }

  pushLog(`[${recipe.command}] build`)
  let buildCode = -1
  try {
    buildCode = await runStreamed(
      recipe.command,
      recipe.args,
      { cwd: projectPath, env, timeoutMs: remaining() },
      emit,
      tail
    )
  } catch (err) {
    pushLog(`[${recipe.command}] error: ${(err as Error).message}`)
  }

  const binaryPath = join(projectPath, recipe.artifact(safeName))
  let binarySize: number | undefined
  let binaryExists = false
  try {
    const s = await stat(binaryPath)
    binarySize = s.size
    binaryExists = s.isFile()
  } catch {
    binaryExists = false
  }

  const success = buildCode === 0 && binaryExists
  const durationMs = Date.now() - started
  pushLog(
    success
      ? `[ok] built ${binaryPath} (${binarySize} bytes) in ${durationMs}ms`
      : `[fail] ${recipe.command} exit=${buildCode} binaryExists=${binaryExists}`
  )

  return {
    success,
    projectPath,
    binaryPath: binaryExists ? binaryPath : undefined,
    binarySize,
    durationMs,
    log: tail.toString()
  }
}
