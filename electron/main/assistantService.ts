/**
 * LLM providers, in the main process.
 *
 * WHY NOT THE RENDERER. Two reasons, both hard:
 *
 *   1. The built app's CSP is `default-src 'self'`. A `fetch` to
 *      api.anthropic.com from the renderer is blocked, and the fix people
 *      reach for — loosening the CSP — is the same fix that would let any
 *      future XSS exfiltrate a patch. The CSP stays.
 *   2. API keys. Keeping them out of the renderer means they are never in a
 *      React state tree, never in a devtools heap snapshot, and never in a
 *      crash report. The renderer asks for a completion; it never holds the
 *      credential.
 *
 * LOCAL IS A FIRST-CLASS OPTION, not a fallback. Ollama on localhost needs
 * no key, no account and no network, and for "add a filter after the
 * oscillator" a small local model is entirely sufficient. It is listed
 * first for that reason.
 *
 * Keys live in `~/.config/daisypatcher/assistant.json`, mode 0600. That is
 * the same place every other CLI keeps them and it is honest about what it
 * is: not a keychain, but not world-readable either. Nothing in this file
 * ever logs a key.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'

export type ProviderId = 'ollama' | 'anthropic' | 'openai'

export interface AssistantConfig {
  provider: ProviderId
  model: string
  /** Ollama or any OpenAI-compatible server. Ignored by the Anthropic path. */
  baseUrl: string
  /** Per-provider. Never returned to the renderer — see `readConfigSafe`. */
  keys: Partial<Record<ProviderId, string>>
}

/** What the renderer is allowed to see: everything except the keys. */
export interface SafeAssistantConfig {
  provider: ProviderId
  model: string
  baseUrl: string
  /** Which providers have a key stored, not what it is. */
  hasKey: Record<ProviderId, boolean>
}

const DEFAULTS: AssistantConfig = {
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  baseUrl: 'http://127.0.0.1:11434',
  keys: {}
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'assistant.json')
}

function readConfig(): AssistantConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<AssistantConfig>
    return {
      provider: raw.provider ?? DEFAULTS.provider,
      model: typeof raw.model === 'string' ? raw.model : DEFAULTS.model,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULTS.baseUrl,
      keys: raw.keys && typeof raw.keys === 'object' ? raw.keys : {}
    }
  } catch {
    return { ...DEFAULTS, keys: {} }
  }
}

function writeConfig(cfg: AssistantConfig): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = configPath()
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8')
  try {
    chmodSync(p, 0o600)
  } catch {
    // Best effort — Windows has no equivalent and failing here would be
    // worse than a slightly-too-readable file on a single-user machine.
  }
}

export function readConfigSafe(): SafeAssistantConfig {
  const c = readConfig()
  return {
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    hasKey: {
      ollama: true, // needs none
      anthropic: Boolean(c.keys.anthropic),
      openai: Boolean(c.keys.openai)
    }
  }
}

/** Update settings. A key of `''` clears it; `undefined` leaves it alone. */
export function saveConfig(patch: {
  provider?: ProviderId
  model?: string
  baseUrl?: string
  key?: { provider: ProviderId; value: string }
}): SafeAssistantConfig {
  const c = readConfig()
  if (patch.provider) c.provider = patch.provider
  if (typeof patch.model === 'string') c.model = patch.model
  if (typeof patch.baseUrl === 'string') c.baseUrl = patch.baseUrl
  if (patch.key) {
    if (patch.key.value) c.keys[patch.key.provider] = patch.key.value
    else delete c.keys[patch.key.provider]
  }
  writeConfig(c)
  return readConfigSafe()
}

export interface CompletionRequest {
  system: string
  user: string
}

export interface CompletionResult {
  text?: string
  error?: string
}

/**
 * Strip anything key-shaped out of an error before it reaches the renderer.
 *
 * Providers echo the offending request in some error bodies, and an error
 * toast is exactly the kind of thing that ends up pasted into a bug report.
 */
function scrub(msg: string): string {
  return msg
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer ***')
    .replace(/"x-api-key"\s*:\s*"[^"]*"/gi, '"x-api-key":"***"')
}

const TIMEOUT_MS = 120_000

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; json: unknown; text: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      /* leave null; caller reports the text */
    }
    return { status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  const cfg = readConfig()
  try {
    switch (cfg.provider) {
      case 'ollama': {
        const { status, json, text } = await postJson(
          `${cfg.baseUrl.replace(/\/$/, '')}/api/chat`,
          {},
          {
            model: cfg.model,
            stream: false,
            // Ollama honours this for models that support it, and it turns
            // "usually JSON" into "always JSON".
            format: 'json',
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user }
            ]
          }
        )
        if (status !== 200) {
          return {
            error:
              status === 404
                ? `Ollama has no model "${cfg.model}". Run: ollama pull ${cfg.model}`
                : `Ollama returned ${status}: ${scrub(text.slice(0, 300))}`
          }
        }
        const content = (json as { message?: { content?: string } })?.message?.content
        return content ? { text: content } : { error: 'Ollama returned an empty reply' }
      }

      case 'anthropic': {
        const key = cfg.keys.anthropic
        if (!key) return { error: 'No Anthropic API key set — add one in the assistant settings.' }
        const { status, json, text } = await postJson(
          'https://api.anthropic.com/v1/messages',
          { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          {
            model: cfg.model,
            max_tokens: 4096,
            system: req.system,
            messages: [{ role: 'user', content: req.user }]
          }
        )
        if (status !== 200) return { error: `Anthropic returned ${status}: ${scrub(text.slice(0, 300))}` }
        const blocks = (json as { content?: { type: string; text?: string }[] })?.content ?? []
        const out = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
        return out ? { text: out } : { error: 'Anthropic returned an empty reply' }
      }

      case 'openai': {
        const key = cfg.keys.openai
        if (!key) return { error: 'No OpenAI API key set — add one in the assistant settings.' }
        const base = cfg.baseUrl.includes('11434')
          ? 'https://api.openai.com'
          : cfg.baseUrl.replace(/\/$/, '')
        const { status, json, text } = await postJson(
          `${base}/v1/chat/completions`,
          { authorization: `Bearer ${key}` },
          {
            model: cfg.model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user }
            ]
          }
        )
        if (status !== 200) return { error: `Provider returned ${status}: ${scrub(text.slice(0, 300))}` }
        const content = (json as { choices?: { message?: { content?: string } }[] })?.choices?.[0]
          ?.message?.content
        return content ? { text: content } : { error: 'The provider returned an empty reply' }
      }

      default:
        return { error: `unknown provider "${cfg.provider}"` }
    }
  } catch (err) {
    const e = err as Error
    if (e.name === 'AbortError') return { error: `The request timed out after ${TIMEOUT_MS / 1000}s.` }
    // A local provider that is not running is the single most likely
    // failure, so name the fix rather than the errno.
    if (cfg.provider === 'ollama' && /ECONNREFUSED|fetch failed/i.test(e.message)) {
      return { error: `Could not reach Ollama at ${cfg.baseUrl}. Is it running? (\`ollama serve\`)` }
    }
    return { error: scrub(e.message) }
  }
}

/** Models the local server actually has, for the settings dropdown. */
export async function listLocalModels(): Promise<string[]> {
  const cfg = readConfig()
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/api/tags`)
    if (!res.ok) return []
    const json = (await res.json()) as { models?: { name?: string }[] }
    return (json.models ?? []).map((m) => m.name ?? '').filter(Boolean)
  } catch {
    return []
  }
}
