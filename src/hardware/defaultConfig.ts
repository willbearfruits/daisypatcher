/**
 * Per-kind default `config` for a placed hardware component.
 *
 * Its own module, dependency-free, because two things need it that must
 * not import the store: `loadGraph` backfills it under whatever a file
 * carries (so a component saved with `config: {}` gets width/height/address
 * rather than `undefined`), and `scripts/build-examples.mjs` uses it so the
 * example files are correct at rest — the store pulls in React through
 * zustand, which the headless builder cannot load.
 *
 * `rotation` lives in config rather than on `PlacedComponent` to keep that
 * schema stable; optional config keys tolerate unknown kinds cleanly.
 */

import type { HardwareKind } from '@/types/hardware'

export function defaultHardwareConfig(kind: HardwareKind): Record<string, number | string | boolean> {
  // `rotation` and kind-specific defaults. Rotation lives in config to keep
  // the `PlacedComponent` schema stable (optional config keys tolerate
  // unknown kinds cleanly).
  const base: Record<string, number | string | boolean> = { rotation: 0 }
  switch (kind) {
    case 'pot':          return { ...base, taper: 'linear' }
    case 'led':          return { ...base, color: 'white', pwm: false }
    case 'switch_3way':  return { ...base, positions: 3 }
    case 'encoder':      return { ...base, detents: 24, withSwitch: true }
    case 'oled_ssd1306': return { ...base, width: 128, height: 64, address: '0x3C' }
    case 'i2s_codec':    return { ...base, model: 'pcm3060' }
    /*
     * GY-PCM5102 straps. `xsmt` is the one that actually bites people:
     * the purple board ships jumper 3 on the LOW side, which holds the
     * DAC muted, so a correctly-wired module is silent until it's moved
     * HIGH. Default to the working configuration and surface it.
     */
    case 'pcm5102a':     return { ...base, xsmtHigh: true, fmt: 'i2s', flt: 'normal', deemphasis: false, sckToGnd: true }
    /*
     * MAX98357A straps. `gainDb` and `channel` are set by resistors on the
     * GAIN and SD pins, not by the MCU — config, not roles.
     */
    // gainDb is a string: the GAIN pad has five discrete resistor taps, so
    // the inspector renders it as an enum (a slider would imply a range).
    case 'max98357a':    return { ...base, gainDb: '9', channel: 'stereo_avg', i2sOnly: false }
    case 'slider':       return { ...base, orientation: 'vertical', travel: 60 }
    case 'touch_ribbon': return { ...base, orientation: 'vertical', length: 80 }
    case 'ldr':          return { ...base }
    case 'gyroscope':    return { ...base, address: '0x68', rate: 200, pullup: true, hasInt: true }
    case 'magnetometer': return { ...base, address: '0x1E', offsetX: 0, offsetY: 0, offsetZ: 0 }
    case 'tof':          return { ...base, address: '0x29', profile: 'short', hasXshut: true }
    case 'electret':     return { ...base, gainDb: 20, acCouple: true }
    case 'piezo':        return { ...base, direction: 'input', threshold: 0.2 }
    default:             return base
  }
}
