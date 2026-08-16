/**
 * The assistant panel.
 *
 * THE INTERACTION IS: ask, read what it proposes, apply or discard. There
 * is no auto-apply, and there will not be one. A patch is a thing the user
 * is building; an assistant that rewrites it while they read the reply is a
 * tool you stop trusting the first time it guesses wrong. The proposed
 * edits are listed in plain language — "add Filter", "wire Osc.out ->
 * Filter.in" — because a list you can check in three seconds is what makes
 * accepting cheap.
 *
 * Applying is one undo entry (see `applyPlan`), so "never mind" is one
 * keystroke. Those two properties together are what let someone use this
 * on a patch they care about.
 *
 * Errors are shown in full rather than swallowed. A model that returns
 * malformed JSON, or names a socket that does not exist, is a normal
 * Tuesday; the useful response is to show what was wrong so the user can
 * rephrase, not to pretend nothing happened.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@/state/store'
import {
  applyPlan,
  type ApplyResult
} from '@/assistant/applyPlan'
import {
  describePlan,
  parseEditPlan,
  validatePlan,
  type EditPlan
} from '@/assistant/editSchema'
import { systemPrompt, userPrompt } from '@/assistant/prompt'
import styles from './AssistantPanel.module.css'

export const TOGGLE_ASSISTANT_EVENT = 'dp:toggle-assistant'

type ProviderId = 'ollama' | 'anthropic' | 'openai'

interface SafeConfig {
  provider: ProviderId
  model: string
  baseUrl: string
  hasKey: Record<ProviderId, boolean>
}

interface AssistantApi {
  config(): Promise<SafeConfig>
  saveConfig(patch: {
    provider?: ProviderId
    model?: string
    baseUrl?: string
    key?: { provider: ProviderId; value: string }
  }): Promise<SafeConfig>
  models(): Promise<string[]>
  complete(req: { system: string; user: string }): Promise<{ text?: string; error?: string }>
}

function api(): AssistantApi | null {
  const w = window as unknown as { daisy?: { assistant?: AssistantApi } }
  return w.daisy?.assistant ?? null
}

interface Proposal {
  plan: EditPlan
  lines: string[]
  warnings: string[]
}

export function AssistantPanel() {
  const [open, setOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [cfg, setCfg] = useState<SafeConfig | null>(null)
  // `null` = not asked yet; `[]` = asked and Ollama had nothing (or was down).
  const [localModels, setLocalModels] = useState<string[] | null>(null)
  const [keyDraft, setKeyDraft] = useState('')

  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [applied, setApplied] = useState<ApplyResult | null>(null)

  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const toggle = () => setOpen((v) => !v)
    window.addEventListener(TOGGLE_ASSISTANT_EVENT, toggle)
    return () => window.removeEventListener(TOGGLE_ASSISTANT_EVENT, toggle)
  }, [])

  useEffect(() => {
    if (!open) return
    const a = api()
    if (!a) return
    void a.config().then(setCfg)
    setLocalModels(null)
    void a.models().then(setLocalModels)
    inputRef.current?.focus()
  }, [open])

  const ask = useCallback(async () => {
    const a = api()
    if (!a || !request.trim()) return
    setBusy(true)
    setError(null)
    setProposal(null)
    setApplied(null)

    // The graph is read at ASK time and validated again at apply time. If
    // the user edits between the two, apply re-checks against what is
    // actually there rather than what was there when they asked.
    const st = useEditorStore.getState()
    const res = await a.complete({
      system: systemPrompt(st.target),
      user: userPrompt(st.graph, request.trim())
    })

    if (res.error || !res.text) {
      setError(res.error ?? 'the provider returned nothing')
      setBusy(false)
      return
    }

    const parsed = parseEditPlan(res.text)
    if ('error' in parsed) {
      setError(`${parsed.error}\n\nThe model replied:\n${res.text.slice(0, 600)}`)
      setBusy(false)
      return
    }

    const check = validatePlan(parsed, useEditorStore.getState().graph)
    if (!check.ok) {
      setError(
        `The suggestion would not work on this patch:\n· ${check.errors.join('\n· ')}` +
          `\n\nIt said: ${parsed.summary || '(nothing)'}`
      )
      setBusy(false)
      return
    }

    setProposal({
      plan: parsed,
      lines: describePlan(parsed, useEditorStore.getState().graph),
      warnings: check.warnings
    })
    setBusy(false)
  }, [request])

  const accept = useCallback(() => {
    if (!proposal) return
    // Re-validate: the canvas may have moved since the model saw it.
    const check = validatePlan(proposal.plan, useEditorStore.getState().graph)
    if (!check.ok) {
      setError(
        `The patch changed since this was suggested, and it no longer applies:\n· ` +
          check.errors.join('\n· ')
      )
      setProposal(null)
      return
    }
    setApplied(applyPlan(proposal.plan))
    setProposal(null)
    setRequest('')
  }, [proposal])

  if (!open) return null

  const noBridge = api() === null

  /*
   * The single most likely first-run failure: Ollama is running, the
   * default model is not pulled, and the first Ask fails with a 404. Say so
   * BEFORE the ask, with the exact command, whenever the configured model
   * is not in the local list. Only for Ollama — a cloud provider's model
   * list is not something we can see.
   */
  const models = localModels ?? []
  const missingLocalModel =
    cfg?.provider === 'ollama' &&
    localModels !== null &&
    models.length > 0 &&
    !models.some((m) => m === cfg.model || m.split(':')[0] === cfg.model.split(':')[0])
  // Only after the list has actually come back — an empty list before the
  // fetch resolves is "loading", not "down", and must not flash a warning.
  const ollamaDown = cfg?.provider === 'ollama' && localModels !== null && models.length === 0

  return (
    <aside className={styles.root} aria-label="Assistant">
      <header className={styles.head}>
        <span className={styles.title}>ASSISTANT</span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setShowSettings((v) => !v)}
          title="Provider and model"
        >
          settings
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setOpen(false)}
          title="Close"
        >
          ✕
        </button>
      </header>

      {noBridge ? (
        <p className={styles.note}>
          The assistant needs the desktop app — it is not available in a browser
          preview.
        </p>
      ) : null}

      {ollamaDown ? (
        <p className={styles.warn}>
          Ollama is not reachable at {cfg?.baseUrl}. Start it (<code>ollama serve</code>) or
          pick a cloud provider in settings.
        </p>
      ) : missingLocalModel ? (
        <p className={styles.warn}>
          Ollama does not have <code>{cfg?.model}</code>. Pull it first:{' '}
          <code>ollama pull {cfg?.model}</code>
          {models.length > 0 ? (
            <>
              {' '}
              — or pick one you have: {models.slice(0, 3).join(', ')}
              {models.length > 3 ? '…' : ''}
            </>
          ) : null}
        </p>
      ) : null}

      {showSettings && cfg ? (
        <section className={styles.settings}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Provider</span>
            <select
              className={styles.select}
              value={cfg.provider}
              onChange={(e) => {
                const provider = e.target.value as ProviderId
                void api()
                  ?.saveConfig({ provider })
                  .then(setCfg)
              }}
            >
              <option value="ollama">Ollama (local, no key)</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Model</span>
            <input
              className={styles.input}
              value={cfg.model}
              list="dp-local-models"
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              onBlur={() => void api()?.saveConfig({ model: cfg.model }).then(setCfg)}
            />
            <datalist id="dp-local-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

          {cfg.provider === 'ollama' || cfg.provider === 'openai' ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Server</span>
              <input
                className={styles.input}
                value={cfg.baseUrl}
                onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
                onBlur={() => void api()?.saveConfig({ baseUrl: cfg.baseUrl }).then(setCfg)}
              />
            </label>
          ) : null}

          {cfg.provider !== 'ollama' ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                API key {cfg.hasKey[cfg.provider] ? '(saved)' : ''}
              </span>
              <input
                className={styles.input}
                type="password"
                placeholder={cfg.hasKey[cfg.provider] ? '••••••••  (stored)' : 'paste to store'}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => {
                  if (!keyDraft) return
                  void api()
                    ?.saveConfig({ key: { provider: cfg.provider, value: keyDraft } })
                    .then((c) => {
                      setCfg(c)
                      setKeyDraft('')
                    })
                }}
              />
              <span className={styles.hint}>
                Stored in ~/.config/daisypatcher/assistant.json, readable only by you.
                It never enters the app window.
              </span>
            </label>
          ) : null}
        </section>
      ) : null}

      <textarea
        ref={inputRef}
        className={styles.input2}
        rows={3}
        value={request}
        placeholder="e.g. add a lowpass after the oscillator and sweep it with an LFO"
        disabled={busy || noBridge}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void ask()
          }
          e.stopPropagation()
        }}
      />
      <div className={styles.row}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || noBridge || !request.trim()}
          onClick={() => void ask()}
        >
          {busy ? 'Thinking…' : 'Ask'}
        </button>
        <span className={styles.hint}>{cfg ? `${cfg.provider} · ${cfg.model}` : ''}</span>
      </div>

      {error ? <pre className={styles.error}>{error}</pre> : null}

      {proposal ? (
        <section className={styles.proposal}>
          <p className={styles.summary}>{proposal.plan.summary}</p>
          {proposal.lines.length > 0 ? (
            <ul className={styles.list}>
              {proposal.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.note}>It proposed no changes.</p>
          )}
          {proposal.warnings.length > 0 ? (
            <ul className={styles.warnList}>
              {proposal.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          {proposal.lines.length > 0 ? (
            <div className={styles.row}>
              <button type="button" className={styles.primary} onClick={accept}>
                Apply
              </button>
              <button type="button" className={styles.btn} onClick={() => setProposal(null)}>
                Discard
              </button>
              <span className={styles.hint}>one undo step</span>
            </div>
          ) : null}
        </section>
      ) : null}

      {applied ? (
        <section className={styles.proposal}>
          <p className={styles.summary}>
            Applied. {applied.addedNodeIds.length} node
            {applied.addedNodeIds.length === 1 ? '' : 's'} added — Ctrl+Z to undo it all.
          </p>
          {applied.skipped.length > 0 ? (
            <ul className={styles.warnList}>
              {applied.skipped.map((s, i) => (
                <li key={i}>
                  {s.edit.op}: {s.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </aside>
  )
}
