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
  | 'i2s_codec'    // external I2S DAC/ADC (e.g. PCM5102)
  | 'encoder'      // rotary encoder with optional push

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
}

/**
 * Which target board this layout targets. Separate from the editor-store's
 * `target` so a layout saved with an ESP32 board can round-trip through
 * open/save without losing its identity.
 */
export type BoardId = 'daisy_seed' | 'esp32_s3_devkitc'

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
  encoder:      ['a', 'b', 'sw']
}
