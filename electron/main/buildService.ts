import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { LIBDAISY_PATH, DAISYSP_PATH, WORKSPACE } from './sdk'

/**
 * Cross-platform containment check. `path.relative()` yields OS-appropriate
 * separators on every platform, so we don't have to special-case Windows
 * backslash paths the way a naive `startsWith(base + '/')` would.
 */
export function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export type BuildTarget = 'daisy_seed' | 'esp32_s3'

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

function recipeFor(target: BuildTarget): TargetRecipe {
  if (target === 'esp32_s3') {
    return {
      workspaceDir: 'esp32',
      command: 'pio',
      args: ['run'],
      artifact: () => '.pio/build/esp32-s3-devkitc-1/firmware.bin',
      env: {}
    }
  }
  return {
    workspaceDir: 'seed',
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

  const target: BuildTarget = input.target === 'esp32_s3' ? 'esp32_s3' : 'daisy_seed'
  const recipe = recipeFor(target)

  const safeName = sanitizeProjectName(input.projectName)
  // Per-target subdirectory keeps Seed and ESP32 builds from colliding.
  const targetRoot = join(WORKSPACE, recipe.workspaceDir)
  const projectPath = join(targetRoot, safeName)

  // Defense in depth: re-resolve and verify containment.
  const workspaceAbs = resolve(WORKSPACE)
  const projectAbs = resolve(projectPath)
  if (!isInside(workspaceAbs, projectAbs)) {
    throw new Error(`refusing to build outside workspace: ${projectAbs}`)
  }

  await mkdir(WORKSPACE, { recursive: true })
  await mkdir(targetRoot, { recursive: true })
  await mkdir(projectPath, { recursive: true })
  await cleanProjectDir(projectPath)

  // Write every file; reject keys that try to escape the dir.
  for (const [relPath, contents] of Object.entries(input.files)) {
    const dest = resolve(projectPath, relPath)
    const fileAbs = dest
    if (!isInside(projectAbs, fileAbs)) {
      throw new Error(`refusing to write file outside project: ${relPath}`)
    }
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, contents, 'utf8')
    pushLog(`[write] ${relPath}`)
  }

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
