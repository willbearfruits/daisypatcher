/**
 * Which capture device stands in for the codec's line-in.
 *
 * `audio_in` declares a placeholder `device` enum (one option, "System
 * default") because the real list only exists at runtime; this renders the
 * live list from `enumerateDevices()` — the same escape hatch the sample
 * picker uses for the sample library.
 *
 * Two things about `enumerateDevices()` shape this component: it returns
 * devices with EMPTY labels until the page has been granted capture once
 * (a privacy rule), and it does not tell you when the list changes — that
 * is `devicechange`. So the picker asks the engine's status (which flips
 * to `ok` after the first successful `getUserMedia`) and re-enumerates on
 * both that and `devicechange`, which is what makes plugging an interface
 * in while the Inspector is open just work.
 */

import { useEffect, useState } from 'react'
import type { NodeInstance } from '@/types/graph'
import { useEditorStore } from '@/state/store'
import { useAudioEngine } from '@/audio/AudioEngineContext'
import type { AudioEngine } from '@/audio/AudioEngine'
import styles from './Inspector.module.css'
import pick from './SamplePicker.module.css'

interface DeviceOption {
  id: string
  label: string
}

export function InputDevicePicker({ node }: { node: NodeInstance }) {
  const setParam = useEditorStore((s) => s.setParam)
  const engine = useAudioEngine() as AudioEngine | null
  const value = typeof node.params.device === 'string' ? node.params.device : ''
  const [devices, setDevices] = useState<DeviceOption[]>([])
  const [status, setStatus] = useState<{ state: 'ok' | 'error'; detail: string } | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        if (!alive) return
        const ins = all.filter((d) => d.kind === 'audioinput')
        setDevices(
          ins.map((d, i) => ({
            id: d.deviceId,
            // Unlabelled = capture not yet granted; number them so two
            // interfaces are at least distinguishable.
            label: d.label || `Input ${i + 1}`
          }))
        )
      } catch {
        /* no device access at all — leave the default option */
      }
    }
    void refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    const unsub = engine?.subscribeCaptureStatus?.(() => {
      setStatus(engine.getCaptureStatus(node.id))
      void refresh() // labels appear once capture has been granted
    })
    setStatus(engine?.getCaptureStatus?.(node.id) ?? null)
    return () => {
      alive = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
      unsub?.()
    }
  }, [engine, node.id])

  // A stored id for a device that is not present right now still shows,
  // greyed, rather than silently snapping to default — the interface may
  // simply be unplugged, and re-saving the patch should not forget it.
  const known = devices.some((d) => d.id === value)

  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>Input device</span>
      </div>
      <select
        className={styles.select}
        value={value}
        onChange={(e) => setParam(node.id, 'device', e.target.value)}
        aria-label="Input device"
      >
        <option value="">System default</option>
        {devices
          .filter((d) => d.id !== 'default' && d.id !== '')
          .map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        {!known && value ? (
          <option value={value} disabled>
            (not connected)
          </option>
        ) : null}
      </select>
      {status ? (
        <span className={status.state === 'ok' ? pick.hint : pick.error}>
          {status.state === 'ok' ? `listening: ${status.detail}` : status.detail}
        </span>
      ) : (
        <span className={pick.hint}>
          plays into the patch where the device's line-in would; press Play to open it
        </span>
      )}
    </div>
  )
}
