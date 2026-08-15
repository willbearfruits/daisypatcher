/**
 * Hardware layout — a parallel graph to the DSP graph. Describes what
 * physical components are wired to the Daisy Seed's pins, so codegen can
 * produce the right peripheral init + pin bindings.
 *
 * The patch graph (`AudioGraph`) and the hardware layout (`HardwareLayout`)
 * are linked by reference: nodes like `button`, `led`, `knob_in`, `gate_in`,
 * `oled` carry an optional `bindingId` param that points to a placed
 * component in the hardware layout. If the binding is missing or broken,
 * codegen emits a warning and falls back to a sensible default (or no-op).
 *
 * Kept serializable for save/load round-trips.
 */

import type { BoardId } from '../../shared/boards'

export type HardwareKind =
  | 'pot'          // potentiometer / knob (ADC input)
  | 'button'       // momentary pushbutton (GPIO in, active-low)
  | 'switch_3way'  // SPDT/SP3T toggle (2 GPIO ins or 1 ADC)
  | 'led'          // LED (GPIO out, PWM-capable on certain pins)
  | 'gate_jack'    // 3.5mm gate I/O
  | 'cv_jack'      // 3.5mm CV (ADC in or DAC out)
  | 'audio_jack'   // 1/4" or 3.5mm audio
  | 'midi_jack'    // DIN5 or TRS MIDI
  | 'oled_ssd1306' // 128x64 I2C OLED
  | 'i2s_codec'    // external I2S DAC/ADC — generic 5-role stereo codec
  | 'pcm5102a'     // GY-PCM5102 line-out DAC module (stereo, ESP32 only)
  | 'max98357a'    // MAX98357A I2S class-D mono amp (ESP32 only)
  | 'encoder'      // rotary encoder with optional push
  | 'slider'         // linear fader (ADC)
  | 'touch_ribbon'   // SoftPot / capacitive touch strip (ADC)
  | 'ldr'            // light-dependent resistor / photoresistor (ADC)
  | 'gyroscope'      // I2C IMU (MPU-6050 / ICM-20948 / LSM6DSO)
  | 'magnetometer'   // I2C compass (HMC5883L / QMC5883L / LIS3MDL)
  | 'tof'            // time-of-flight distance sensor (VL53L0X / VL53L1X)
  | 'electret'       // electret mic capsule + preamp (ADC)
  | 'piezo'          // piezo disc — input (knock) or output (buzzer)

/**
 * Pin identifier on the Daisy Seed. We key by the Seed's published
 * labeling (D0..D31 for GPIOs, plus named pins for power/audio/usb).
 *
 * Codegen maps these to the physical hardware::dsy_gpio_pin pairs via a
 * lookup table maintained in `src/hardware/daisySeedPinout.ts`.
 */
export type SeedPin =
  | 'D0'  | 'D1'  | 'D2'  | 'D3'  | 'D4'  | 'D5'  | 'D6'  | 'D7'
  | 'D8'  | 'D9'  | 'D10' | 'D11' | 'D12' | 'D13' | 'D14' | 'D15'
  | 'D16' | 'D17' | 'D18' | 'D19' | 'D20' | 'D21' | 'D22' | 'D23'
  | 'D24' | 'D25' | 'D26' | 'D27' | 'D28' | 'D29' | 'D30' | 'D31'

/**
 * ESP32-S3-DevKitC-1 GPIO identifier. The DevKitC board exposes most
 * GPIOs via the two headers: GPIO0..21 and GPIO26..48. A handful are
 * USB-data / strapping / flash-bound pins — see `esp32s3Pinout.ts` for
 * capabilities and warnings.
 */
export type Esp32Pin =
  | `GPIO${number}`

/**
 * Unified board-pin union so storage code (`PlacedComponent.pins`) can
 * describe a pin regardless of target. Kept as a string union rather
 * than a richer type because `pins` round-trips through JSON.
 */
export type BoardPin = SeedPin | Esp32Pin | string

/**
 * A pin's capabilities — used by the hardware view to gate which
 * components can be dropped where.
 *
 * `pin` is widened to a bare string so the same shape works for both
 * Seed (SeedPin) and ESP32-S3 (Esp32Pin) pins. The board-specific
 * pinout tables still use their own union for their own table,
 * narrowed where relevant.
 */
export interface PinCapabilities {
  pin: string
  gpio: boolean
  adc: boolean
  dac: boolean
  pwm: boolean
  i2c?: 'sda' | 'scl'
  spi?: 'sck' | 'miso' | 'mosi' | 'cs'
  uart?: 'tx' | 'rx'
  i2s?: 'sck' | 'ws' | 'sd' | 'mclk'
  /** ESP32-S3: pin doubles as a boot-strap — flag visible warning in UI. */
  strapping?: boolean
  /** ESP32-S3: pin is reserved by the on-board USB CDC / JTAG peripheral. */
  usbReserved?: boolean
  /** Underlying MCU pin, e.g. "PB12" on STM32H750 (Daisy Seed). Present for
   *  Seed entries so codegen can reference the true pin identifier. */
  stm32Pin?: string
  label?: string     // e.g. "ADC_0"
}

/**
 * A placed hardware component on the layout canvas.
 *
 * `pins` maps the component's logical role ("wiper", "button", "anode",
 * "sda", "scl", "left", "right") to a specific Seed pin. Each `kind` has
 * a small set of required roles; the view validates the mapping.
 */
export interface PlacedComponent {
  id: string
  kind: HardwareKind
  label: string           // user-visible name, e.g. "Cutoff Knob"
  position: { x: number; y: number }
  /**
   * Role -> bound pin on the current board. Stored as a plain string so
   * the same shape works for Seed (`D15`), ESP32-S3 (`GPIO8`), and any
   * future board we add without schema churn. Codegen + the hardware view
   * validate the binding against the active board's pinout table.
   */
  pins: Partial<Record<string, BoardPin>>
  /** Kind-specific config (e.g. pot taper, LED color, switch state count). */
  config: Record<string, number | string | boolean>

  /**
   * Where this control sits on the PERFORMANCE surface, and how big.
   *
   * Separate from `position`, which is where the part physically sits on
   * the panel. Those are different questions and conflating them was the
   * central flaw in the Perform view: arranging for playability moved the
   * drill holes, and laying out the panel sensibly scattered the surface.
   * A panel wants the pot where the shaft fits; a surface wants the control
   * you reach for most under your hand, at a size you can hit without
   * looking.
   *
   * Absent means "follow the panel", so every existing patch is unchanged
   * until something is actually moved in Perform.
   */
  perform?: PerformPlacement
}

/** Performance-surface placement. All fields optional; absent = inherit. */
export interface PerformPlacement {
  /** Canvas units, same space as `position`. */
  x?: number
  y?: number
  /**
   * Visual weight. A performance surface is scanned at arm's length and
   * under stage light: the control you need mid-song should be bigger than
   * the one you set once.
   */
  size?: 'sm' | 'md' | 'lg'
  /** Not every part on the panel belongs on the surface (trim pots, LEDs). */
  hidden?: boolean
  /** Performance name, when the silkscreen label is not the useful one. */
  label?: string
}

/**
 * Which target board this layout targets.
 *
 * This used to be a separate union from the editor-store's `target`. They
 * are now the same type, defined once in `shared/boards.ts` so the Electron
 * main process and the renderer cannot drift apart. Re-exported here
 * because this is where the rest of the app already imports it from.
 */
export type { BoardId }

export interface HardwareLayout {
  board: BoardId
  components: PlacedComponent[]
  meta: {
    name: string
  }
}

export function emptyHardwareLayout(board: BoardId = 'daisy_seed'): HardwareLayout {
  return {
    board,
    components: [],
    meta: { name: 'untitled' }
  }
}

/**
 * Returns the subset of roles a given hardware kind needs. Used by the
 * hardware view to render correct docking points.
 */
export const KIND_ROLES: Record<HardwareKind, string[]> = {
  pot:          ['wiper'],
  button:       ['io'],
  switch_3way:  ['pos1', 'pos2'],
  led:          ['anode'],
  gate_jack:    ['io'],
  cv_jack:      ['signal'],
  audio_jack:   ['left', 'right'],
  midi_jack:    ['rx'],
  oled_ssd1306: ['sda', 'scl'],
  i2s_codec:    ['sck', 'ws', 'sd_in', 'sd_out', 'mclk'],
  /*
   * PCM5102A / MAX98357A are output-only I2S sinks: three wires from the
   * MCU and nothing back. Roles keep the canonical bus names (`sck`/`ws`/
   * `sd_out`) because `pinsForRole` and the ESP32 `walkHardware` emitter
   * key off them — the module's actual silkscreen (BCK/LCK/DIN, BCLK/LRC/
   * DIN) is a display concern, see ROLE_LABELS below.
   *
   * Deliberately NOT roles: the PCM5102A's FLT/DEMP/XSMT/FMT and the
   * MAX98357A's GAIN/SD. Those are strap pins normally left at their
   * default or jumpered, and `KIND_ROLES` is static — a listed role can
   * never be optional, so anything here that the user doesn't wire leaves
   * the component reading "PINS?" forever. They live in `config` instead.
   */
  pcm5102a:     ['sck', 'ws', 'sd_out'],
  max98357a:    ['sck', 'ws', 'sd_out'],
  encoder:      ['a', 'b', 'sw'],
  slider:       ['wiper'],
  touch_ribbon: ['wiper'],
  ldr:          ['signal'],
  gyroscope:    ['sda', 'scl', 'int'],
  magnetometer: ['sda', 'scl'],
  tof:          ['sda', 'scl', 'xshut'],
  electret:     ['signal'],
  piezo:        ['signal']
}

/**
 * Kinds that are, electrically, "a voltage on an ADC pin" — mapped to the
 * role carrying that voltage.
 *
 * A pot, a fader, a SoftPot, an LDR, an electret and a piezo all do the
 * same thing from the MCU's point of view: one analog pin, one normalized
 * float. Treating them as one family is what lets a single `knob_in` node
 * read any of them, and it keeps the two code generators honest — the ADC
 * bank, the poll loop and the node auto-link all derive from this table
 * rather than each hardcoding its own list of kinds.
 *
 * Previously only `pot` and `cv_jack` appeared in the codegen lists, so a
 * placed Ribbon or Slider was pinned in the UI and then silently absent
 * from the generated firmware.
 */
export const ANALOG_INPUT_ROLE: Partial<Record<HardwareKind, string>> = {
  pot: 'wiper',
  slider: 'wiper',
  touch_ribbon: 'wiper',
  ldr: 'signal',
  electret: 'signal',
  piezo: 'signal',
  cv_jack: 'signal'
}

/** The ADC role for `kind`, or null if it isn't an analog input. */
export function analogRoleFor(kind: HardwareKind): string | null {
  return ANALOG_INPUT_ROLE[kind] ?? null
}

/**
 * Per-kind display names for role keys.
 *
 * Role keys are load-bearing — `pinsForRole` on every board and the ESP32
 * `walkHardware` emitter both switch on `sck` / `ws` / `sd_in` / `sd_out` /
 * `mclk`, so they must stay canonical. But a user looking at a GY-PCM5102
 * sees `BCK`, not `sck`. This map is the translation layer, consulted
 * wherever a role is shown to the user (role dots, binding labels, the
 * hardware inspector). Kinds absent from the map fall back to the raw key.
 */
export const ROLE_LABELS: Partial<Record<HardwareKind, Record<string, string>>> = {
  pcm5102a:  { sck: 'BCK',  ws: 'LCK', sd_out: 'DIN' },
  max98357a: { sck: 'BCLK', ws: 'LRC', sd_out: 'DIN' }
}

/** Display name for a component role — silkscreen name where we have one. */
export function roleLabel(kind: HardwareKind, role: string): string {
  return ROLE_LABELS[kind]?.[role] ?? role
}
