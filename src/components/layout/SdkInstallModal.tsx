/**
 * SdkInstallModal — first-run gate for the libDaisy + DaisySP SDK.
 *
 * Visibility is driven entirely by local state (`dismissed`) xor the store's
 * `sdkReady` flag. The store's `sdkChecked` guard keeps us from flashing the
 * modal before the first status probe resolves.
 *
 * Behaviour:
 *   - Escape / click-outside dismisses when not installing.
 *   - While installing, the Install button turns into a busy state and the
 *     latest SDK log line is rendered under the progress strip so the user
 *     has visible forward motion.
 *   - Successful install auto-closes (sdkReady becomes true, the component
 *     simply unmounts).
 *   - Skip closes for this session only; next launch re-prompts.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useCompileStore } from '@/state/compileState'
import { useEditorStore } from '@/state/store'
import { getTarget } from '@/codegen/targets'
import styles from './SdkInstallModal.module.css'

export function SdkInstallModal() {
  const sdkReady = useCompileStore((s) => s.sdkReady)
  const sdkChecked = useCompileStore((s) => s.sdkChecked)
  const sdkInstalling = useCompileStore((s) => s.sdkInstalling)
  const sdkInstallError = useCompileStore((s) => s.sdkInstallError)
  const issues = useCompileStore((s) => s.sdkIssues)
  const log = useCompileStore((s) => s.log)
  const installSdk = useCompileStore((s) => s.installSdk)
  const installEsp32Toolchain = useCompileStore((s) => s.installEsp32Toolchain)
  const target = useEditorStore((s) => s.target)
  const isEsp32 = target === 'esp32_s3'

  const [dismissed, setDismissed] = useState(false)

  const open = sdkChecked && !sdkReady && !dismissed

  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Escape closes when not installing.
  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape' && !sdkInstalling) {
        setDismissed(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, sdkInstalling])

  // Auto-close on successful install (sdkReady flips true).
  useEffect(() => {
    if (sdkReady) setDismissed(false)
  }, [sdkReady])

  // Latest SDK/build log line for visible forward motion during install.
  const latest = useMemo(() => {
    for (let i = log.length - 1; i >= 0; i--) {
      const line = log[i]
      if (line.stream === 'sdk' || line.stream === 'error') return line.text
    }
    return null
  }, [log])

  if (!open) return null

  const onBackdrop = (): void => {
    if (!sdkInstalling) setDismissed(true)
  }

  return (
    <div
      className={styles.backdrop}
      onMouseDown={onBackdrop}
      role="presentation"
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dp-sdk-title"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="dp-sdk-title" className={styles.title}>
          {isEsp32 ? 'ESP32-S3 Toolchain' : 'Install Daisy SDK'}
        </h2>
        <p className={styles.body}>
          {isEsp32 ? (
            <>
              Daisypatcher uses PlatformIO to build for the ESP32-S3. Click
              Install and we&rsquo;ll pull PlatformIO via your Python
              (pipx preferred, <code>pip&nbsp;--user</code> fallback) and
              pre-download the ESP32-S3 toolchain so the first compile
              doesn&rsquo;t stall. <strong>This takes 5&ndash;15 minutes</strong>{' '}
              on first run and needs about <strong>300&nbsp;MB</strong> of
              disk. Python 3 must already be on your PATH &mdash; install
              from <code>python.org</code> (Windows) or your package
              manager (macOS/Linux) first if missing.
            </>
          ) : (
            <>
              Daisypatcher needs libDaisy and DaisySP to compile patches for your
              Daisy Seed. Click Install to download and build them
              ({'\u007E'}50MB, one-time setup). Emulation works without the SDK, but
              the Compile and Flash buttons remain disabled until it&rsquo;s ready.
            </>
          )}
        </p>

        {isEsp32 ? (
          <ul className={styles.issues}>
            {getTarget('esp32_s3').toolchainCheck().map((c, i) => (
              <li key={i}>
                <span className={styles.issueDot} aria-hidden />
                <span>
                  <strong>{c.name}</strong>
                  {c.required ? '' : ' (optional)'}
                  {': '}
                  <code>{c.installHint}</code>
                </span>
              </li>
            ))}
          </ul>
        ) : issues.length > 0 ? (
          <ul className={styles.issues}>
            {issues.map((issue, i) => (
              <li key={i}>
                <span className={styles.issueDot} aria-hidden />
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {sdkInstalling ? (
          <div className={styles.progress}>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} />
            </div>
            <div className={styles.progressLine}>
              {latest ?? 'starting\u2026'}
            </div>
          </div>
        ) : null}

        {sdkInstallError && !sdkInstalling ? (
          <div className={styles.errorBox}>
            <strong>Install failed:</strong> {sdkInstallError}
            <div className={styles.errorHint}>
              Open the build log (Ctrl+`) for full output, or DevTools (F12) for the underlying error.
            </div>
          </div>
        ) : null}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => setDismissed(true)}
            disabled={sdkInstalling}
          >
            Skip
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() =>
              void (isEsp32 ? installEsp32Toolchain() : installSdk())
            }
            disabled={sdkInstalling}
            aria-busy={sdkInstalling || undefined}
          >
              {sdkInstalling ? 'Installing\u2026' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  )
}
