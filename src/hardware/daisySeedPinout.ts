/**
 * Daisy Seed pin-to-STM32 mapping + capability flags. Labels match the
 * silkscreen on the board. This drives the hardware view renderer AND
 * the codegen pin map (so we keep the two in sync).
 *
 * Source: Electro-Smith Daisy Seed pinout diagram (rev 1.1 / rev 2).
 *   https://electro-smith.github.io/libDaisy/md_doc_2md_2__hardware__daisy__seed.html
 *
 * Capabilities reflect what the STM32H750 can do on each broken-out pin,
 * not what codegen currently emits. ADC channels are named ADC_0..ADC_11
 * as per the libDaisy hw.GetPin(...) table. I2C1 is the default peripheral
 * bus on the Seed (SDA=D11, SCL=D12). I2S2 is wired to D27..D31 on the
 * rev 2 board, sharing pins with SAI1 in the audio codec path — we flag
 * them as i2s-capable but GPIO-reusable since most projects pick one.
 */
import type { PinCapabilities, SeedPin } from '@/types/hardware'

/**
 * Authoritative pin-capability table.
 *
 * Every Daisy Seed GPIO breakout (D0..D31) is listed. `gpio` is true for
 * all of them — every broken-out pin is usable as a digital I/O when not
 * multiplexed into a peripheral. ADC-capable pins are D15..D21 and D24..D30
 * (12-bit ADC). PWM (timer-capable) is marked on pins whose STM32 mux has
 * a TIM channel; this is a best-effort "safe to use for LED PWM" hint,
 * not a full STM32 timer map.
 *
 * TODO: exhaustive verification of PWM-capable pins against libDaisy's
 * dsy_gpio -> TIM mapping; current list is the documented-safe subset.
 */
export const DAISY_SEED_PINS: PinCapabilities[] = [
  // --- Left header, top to bottom (after power rails) ---
  { pin: 'D0',  gpio: true, adc: false, dac: false, pwm: false, uart: 'tx', label: 'D0 / USART1_TX' },
  { pin: 'D1',  gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', label: 'D1 / USART1_RX' },
  { pin: 'D2',  gpio: true, adc: false, dac: false, pwm: false, label: 'D2' },
  { pin: 'D3',  gpio: true, adc: false, dac: false, pwm: false, label: 'D3' },
  { pin: 'D4',  gpio: true, adc: false, dac: false, pwm: false, label: 'D4' },
  { pin: 'D5',  gpio: true, adc: false, dac: false, pwm: false, label: 'D5' },
  { pin: 'D6',  gpio: true, adc: false, dac: false, pwm: false, label: 'D6' },
  { pin: 'D7',  gpio: true, adc: false, dac: false, pwm: false, spi: 'miso', label: 'D7 / SPI1_MISO' },
  { pin: 'D8',  gpio: true, adc: false, dac: false, pwm: false, spi: 'mosi', label: 'D8 / SPI1_MOSI' },
  { pin: 'D9',  gpio: true, adc: false, dac: false, pwm: false, spi: 'sck',  label: 'D9 / SPI1_SCK'  },
  { pin: 'D10', gpio: true, adc: false, dac: false, pwm: false, spi: 'cs',   label: 'D10 / SPI1_CS'  },
  { pin: 'D11', gpio: true, adc: false, dac: false, pwm: false, i2c: 'scl',  label: 'D11 / I2C1_SCL' },
  { pin: 'D12', gpio: true, adc: false, dac: false, pwm: false, i2c: 'sda',  label: 'D12 / I2C1_SDA' },
  { pin: 'D13', gpio: true, adc: false, dac: false, pwm: false, uart: 'tx', label: 'D13 / USART2_TX' },
  { pin: 'D14', gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', label: 'D14 / USART2_RX' },

  // --- Right header: the analog-rich side ---
  // D15..D21 and D24..D30 are ADC-capable per the Seed pinout diagram.
  { pin: 'D15', gpio: true, adc: true,  dac: false, pwm: true,  label: 'D15 / ADC_0'  },
  { pin: 'D16', gpio: true, adc: true,  dac: false, pwm: true,  label: 'D16 / ADC_1'  },
  { pin: 'D17', gpio: true, adc: true,  dac: false, pwm: true,  label: 'D17 / ADC_2'  },
  { pin: 'D18', gpio: true, adc: true,  dac: false, pwm: true,  label: 'D18 / ADC_3'  },
  { pin: 'D19', gpio: true, adc: true,  dac: false, pwm: true,  label: 'D19 / ADC_4'  },
  { pin: 'D20', gpio: true, adc: true,  dac: false, pwm: true,  label: 'D20 / ADC_5'  },
  { pin: 'D21', gpio: true, adc: true,  dac: false, pwm: true,  label: 'D21 / ADC_6'  },
  { pin: 'D22', gpio: true, adc: false, dac: true,  pwm: false, label: 'D22 / DAC_OUT_1' },
  { pin: 'D23', gpio: true, adc: false, dac: true,  pwm: false, label: 'D23 / DAC_OUT_2' },
  { pin: 'D24', gpio: true, adc: true,  dac: false, pwm: false, label: 'D24 / ADC_7'  },
  { pin: 'D25', gpio: true, adc: true,  dac: false, pwm: false, label: 'D25 / ADC_8'  },
  { pin: 'D26', gpio: true, adc: true,  dac: false, pwm: false, label: 'D26 / ADC_9'  },
  // D27..D30 host I2S2 on rev 2 (overlaps SAI1 on rev 1 — same electrical lines).
  { pin: 'D27', gpio: true, adc: true,  dac: false, pwm: false, i2s: 'mclk', label: 'D27 / ADC_10 / I2S_MCLK' },
  { pin: 'D28', gpio: true, adc: true,  dac: false, pwm: false, i2s: 'sck',  label: 'D28 / ADC_11 / I2S_SCK'  },
  { pin: 'D29', gpio: true, adc: false, dac: false, pwm: false, i2s: 'ws',   label: 'D29 / I2S_WS' },
  { pin: 'D30', gpio: true, adc: false, dac: false, pwm: false, i2s: 'sd',   label: 'D30 / I2S_SD' },
  { pin: 'D31', gpio: true, adc: false, dac: false, pwm: false, label: 'D31' }
]

/** Fast lookup. Populated once at module load. */
export const PIN_CAPS: Record<SeedPin, PinCapabilities> = (() => {
  const out = {} as Record<SeedPin, PinCapabilities>
  for (const c of DAISY_SEED_PINS) out[c.pin as SeedPin] = c
  return out
})()

/**
 * Map a SeedPin to its ADC channel index (0..11) for codegen. Returns -1
 * if the pin is not ADC-capable.
 */
export function adcChannelOf(pin: SeedPin): number {
  const map: Partial<Record<SeedPin, number>> = {
    D15: 0, D16: 1, D17: 2, D18: 3, D19: 4, D20: 5, D21: 6,
    D24: 7, D25: 8, D26: 9, D27: 10, D28: 11
  }
  return map[pin] ?? -1
}

/**
 * Physical 40-pin header layout as screen-printed on the Seed. Two pin
 * headers of 20 pins each. Index 0 is the USB-end of the board; index 19
 * is the opposite end. The physical pin order is taken from the official
 * pinout diagram.
 *
 * Non-GPIO positions (power rails, audio jacks, USB) are included so the
 * renderer can draw them in their correct physical slots.
 */
export interface PhysicalPinPosition {
  pin:
    | SeedPin
    | 'VIN'
    | '3V3'
    | '3V3_A'
    | 'DGND'
    | 'AGND'
    | 'USB_DP'
    | 'USB_DM'
    | 'AUDIO_IN_L'
    | 'AUDIO_IN_R'
    | 'AUDIO_OUT_L'
    | 'AUDIO_OUT_R'
  side: 'left' | 'right'
  index: number
  label: string
}

/**
 * Physical layout of the 40-pin Seed. Matches the pinout diagram: left
 * header runs D0..D14 plus power/USB; right header runs D15..D31 plus
 * audio jacks and the second 3V3 + AGND rail.
 */
export const PHYSICAL_PIN_LAYOUT: PhysicalPinPosition[] = [
  // ------------- LEFT SIDE (silkscreen top-to-bottom) -------------
  { pin: 'D0',        side: 'left', index: 0,  label: 'D0'  },
  { pin: 'D1',        side: 'left', index: 1,  label: 'D1'  },
  { pin: 'D2',        side: 'left', index: 2,  label: 'D2'  },
  { pin: 'D3',        side: 'left', index: 3,  label: 'D3'  },
  { pin: 'D4',        side: 'left', index: 4,  label: 'D4'  },
  { pin: 'D5',        side: 'left', index: 5,  label: 'D5'  },
  { pin: 'D6',        side: 'left', index: 6,  label: 'D6'  },
  { pin: 'D7',        side: 'left', index: 7,  label: 'D7'  },
  { pin: 'D8',        side: 'left', index: 8,  label: 'D8'  },
  { pin: 'D9',        side: 'left', index: 9,  label: 'D9'  },
  { pin: 'D10',       side: 'left', index: 10, label: 'D10' },
  { pin: 'D11',       side: 'left', index: 11, label: 'D11' },
  { pin: 'D12',       side: 'left', index: 12, label: 'D12' },
  { pin: 'D13',       side: 'left', index: 13, label: 'D13' },
  { pin: 'D14',       side: 'left', index: 14, label: 'D14' },
  { pin: 'AGND',      side: 'left', index: 15, label: 'AGND' },
  { pin: 'DGND',      side: 'left', index: 16, label: 'DGND' },
  { pin: 'VIN',       side: 'left', index: 17, label: 'VIN'  },
  { pin: '3V3',       side: 'left', index: 18, label: '3V3 D' },
  { pin: 'USB_DP',    side: 'left', index: 19, label: 'USB'  },

  // ------------- RIGHT SIDE -------------
  { pin: 'D30',         side: 'right', index: 0,  label: 'D30' },
  { pin: 'D29',         side: 'right', index: 1,  label: 'D29' },
  { pin: 'D28',         side: 'right', index: 2,  label: 'D28' },
  { pin: 'D27',         side: 'right', index: 3,  label: 'D27' },
  { pin: 'D26',         side: 'right', index: 4,  label: 'D26' },
  { pin: 'D25',         side: 'right', index: 5,  label: 'D25' },
  { pin: 'D24',         side: 'right', index: 6,  label: 'D24' },
  { pin: 'D23',         side: 'right', index: 7,  label: 'D23' },
  { pin: 'D22',         side: 'right', index: 8,  label: 'D22' },
  { pin: 'D21',         side: 'right', index: 9,  label: 'D21' },
  { pin: 'D20',         side: 'right', index: 10, label: 'D20' },
  { pin: 'D19',         side: 'right', index: 11, label: 'D19' },
  { pin: 'D18',         side: 'right', index: 12, label: 'D18' },
  { pin: 'D17',         side: 'right', index: 13, label: 'D17' },
  { pin: 'D16',         side: 'right', index: 14, label: 'D16' },
  { pin: 'D15',         side: 'right', index: 15, label: 'D15' },
  { pin: 'D31',         side: 'right', index: 16, label: 'D31' },
  { pin: 'AUDIO_OUT_L', side: 'right', index: 17, label: 'AUD_OUT_L' },
  { pin: 'AUDIO_OUT_R', side: 'right', index: 18, label: 'AUD_OUT_R' },
  { pin: '3V3_A',       side: 'right', index: 19, label: '3V3 A' }
  // TODO: Audio IN pads — on the Seed rev2 these are physical contacts
  // on the underside, not 2.54mm headers. Omitted from the visual grid;
  // can be rendered as side annotations if needed.
]

/**
 * Convenience: all strictly-addressable SeedPins (D0..D31), sorted by
 * physical order on the left header then right header. Useful for the
 * inspector's pin dropdown so options appear in a consistent order.
 */
export const SEED_PINS_IN_ORDER: SeedPin[] = PHYSICAL_PIN_LAYOUT
  .filter((p): p is PhysicalPinPosition & { pin: SeedPin } =>
    /^D\d+$/.test(p.pin as string)
  )
  .map((p) => p.pin as SeedPin)

/**
 * Which pins satisfy a component role. The hardware inspector uses this
 * to filter its "Pin" dropdown; the hardware view uses it to highlight
 * valid drop targets when dragging a role onto the PCB.
 */
export function pinsForRole(
  role: string,
  kind: string
): SeedPin[] {
  const r = role.toLowerCase()
  return DAISY_SEED_PINS.filter((cap) => {
    switch (kind) {
      case 'pot':
      case 'cv_jack':
        return cap.adc
      case 'button':
      case 'switch_3way':
      case 'gate_jack':
      case 'encoder':
        return cap.gpio
      case 'led':
        return cap.gpio  // PWM is optional, not required
      case 'oled_ssd1306':
        if (r === 'sda') return cap.i2c === 'sda'
        if (r === 'scl') return cap.i2c === 'scl'
        return !!cap.i2c
      case 'i2s_codec':
        if (r === 'sck')   return cap.i2s === 'sck'
        if (r === 'ws')    return cap.i2s === 'ws'
        if (r === 'mclk')  return cap.i2s === 'mclk'
        if (r === 'sd_in' || r === 'sd_out') return cap.i2s === 'sd' || cap.gpio
        return !!cap.i2s
      case 'midi_jack':
        return cap.uart === 'rx' || cap.uart === 'tx'
      case 'audio_jack':
        // Audio jacks bind to the hard-wired audio codec channels; we
        // allow any GPIO as a fallback so codegen can still reference them.
        return cap.gpio
      default:
        return cap.gpio
    }
  }).map((c) => c.pin as SeedPin)
}
