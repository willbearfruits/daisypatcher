/**
 * Socket-kind helpers. Each signal kind gets its own `SignalSocket` subclass so
 * connections can reject mismatched types. Colors are always read from
 * `--dp-signal-*` CSS variables — no hardcoded values.
 */

import { ClassicPreset } from 'rete'
import type { SignalKind } from '@/theme'

/**
 * Resolve a signal kind to its corresponding CSS variable expression.
 * Consumers pass the result straight into `color`, `fill`, `stroke`, etc.
 */
export function signalColorVar(kind: SignalKind): string {
  return `var(--dp-signal-${kind})`
}

/**
 * Classic Rete socket carrying its signal kind. Sockets with the same `signal`
 * are compatible; anything else is rejected by {@link canConnectSockets}.
 */
export class SignalSocket extends ClassicPreset.Socket {
  readonly signal: SignalKind

  constructor(signal: SignalKind) {
    super(signal)
    this.signal = signal
  }

  isCompatibleWith(other: ClassicPreset.Socket): boolean {
    return other instanceof SignalSocket && other.signal === this.signal
  }
}

/** Shared socket instances, one per kind, so nodes don't allocate duplicates. */
export const SOCKETS: Record<SignalKind, SignalSocket> = {
  audio: new SignalSocket('audio'),
  cv: new SignalSocket('cv'),
  gate: new SignalSocket('gate'),
  clock: new SignalSocket('clock')
}

export function socketFor(kind: SignalKind): SignalSocket {
  return SOCKETS[kind]
}

/**
 * Compatibility predicate fed to `rete-connection-plugin`'s `ClassicFlow`.
 * Must return true only when both ends carry the same signal kind.
 */
export function canConnectSockets(
  from: ClassicPreset.Socket | undefined,
  to: ClassicPreset.Socket | undefined
): boolean {
  if (!from || !to) return false
  if (from instanceof SignalSocket && to instanceof SignalSocket) {
    return from.signal === to.signal
  }
  return false
}
