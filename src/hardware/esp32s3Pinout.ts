/**
 * ESP32-S3-DevKitC-1 pin-to-GPIO mapping + capability flags. Mirrors the
 * shape of `daisySeedPinout.ts` so the hardware view renderer and the
 * codegen pin map can consume either table through the same interface.
 *
 * Source: Espressif ESP32-S3-DevKitC-1 v1.1 pinout diagram + the S3
 * datasheet's GPIO matrix.
 *
 * Practical notes:
 *   - ADC1 is on GPIO 1..10 (12-bit, usable while WiFi is on).
 *   - ADC2 is on GPIO 11..20 but becomes unreliable when WiFi is active;
 *     we still mark it ADC-capable and flag the caveat in the label.
 *   - PWM is available on every GPIO via the LEDC peripheral — we mark
 *     `pwm: true` for every general-purpose pin.
 *   - Strapping pins (GPIO 0, 3, 45, 46) influence boot mode and reset
 *     behaviour — the hardware view renders them with a warning glyph.
 *   - GPIO 19/20 default to USB D-/D+. Using them for other purposes
 *     breaks the built-in USB CDC console; marked `usbReserved`.
 *   - GPIO 26..32 are used by the on-module SPI flash/PSRAM on the
 *     standard devkit — **not** broken out as safe-to-use pins. We
 *     omit them from the table entirely rather than mark them bad.
 *   - GPIO 43 / 44 are the default UART0 TX/RX used by the USB-UART
 *     bridge silkscreened on the board.
 *   - Default I2C: SDA=GPIO8, SCL=GPIO9 (Arduino Wire default on S3).
 *   - Default SPI (HSPI on Arduino): MOSI=11, MISO=13, SCK=12, CS=10.
 */
import type { PinCapabilities, Esp32Pin } from '@/types/hardware'

/**
 * All "safe-to-use" GPIOs on the DevKitC-1. We skip the flash/PSRAM
 * pins (26..32 on the -N8 modules) entirely.
 */
export const ESP32_S3_PINS: PinCapabilities[] = [
  // --- ADC1 + general I/O, GPIO 0..10 ---
  { pin: 'GPIO0',  gpio: true,  adc: false, dac: false, pwm: true,  strapping: true, label: 'GPIO0 (strap)' },
  { pin: 'GPIO1',  gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO1 / ADC1_0' },
  { pin: 'GPIO2',  gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO2 / ADC1_1' },
  { pin: 'GPIO3',  gpio: true,  adc: true,  dac: false, pwm: true,  strapping: true, label: 'GPIO3 (strap) / ADC1_2' },
  { pin: 'GPIO4',  gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO4 / ADC1_3' },
  { pin: 'GPIO5',  gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO5 / ADC1_4' },
  { pin: 'GPIO6',  gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO6 / ADC1_5' },
  { pin: 'GPIO7',  gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO7 / ADC1_6' },
  { pin: 'GPIO8',  gpio: true,  adc: true,  dac: false, pwm: true,  i2c: 'sda', label: 'GPIO8 / ADC1_7 / I2C_SDA' },
  { pin: 'GPIO9',  gpio: true,  adc: true,  dac: false, pwm: true,  i2c: 'scl', label: 'GPIO9 / ADC1_8 / I2C_SCL' },
  { pin: 'GPIO10', gpio: true,  adc: true,  dac: false, pwm: true,  spi: 'cs',  label: 'GPIO10 / ADC1_9 / SPI_CS' },

  // --- ADC2 + general I/O + SPI, GPIO 11..18 ---
  { pin: 'GPIO11', gpio: true,  adc: true,  dac: false, pwm: true,  spi: 'mosi', label: 'GPIO11 / ADC2_0 / SPI_MOSI' },
  { pin: 'GPIO12', gpio: true,  adc: true,  dac: false, pwm: true,  spi: 'sck',  label: 'GPIO12 / ADC2_1 / SPI_SCK' },
  { pin: 'GPIO13', gpio: true,  adc: true,  dac: false, pwm: true,  spi: 'miso', label: 'GPIO13 / ADC2_2 / SPI_MISO' },
  { pin: 'GPIO14', gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO14 / ADC2_3' },
  { pin: 'GPIO15', gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO15 / ADC2_4' },
  { pin: 'GPIO16', gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO16 / ADC2_5' },
  { pin: 'GPIO17', gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO17 / ADC2_6' },
  { pin: 'GPIO18', gpio: true,  adc: true,  dac: false, pwm: true,  label: 'GPIO18 / ADC2_7' },

  // --- USB pins (default D-/D+) ---
  { pin: 'GPIO19', gpio: true,  adc: true,  dac: false, pwm: true,  usbReserved: true, label: 'GPIO19 / USB_D-' },
  { pin: 'GPIO20', gpio: true,  adc: true,  dac: false, pwm: true,  usbReserved: true, label: 'GPIO20 / USB_D+' },

  // --- GPIO 21: LED on many DevKitC-1 variants ---
  { pin: 'GPIO21', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO21' },

  // --- GPIO 26..32 are SPI-flash / PSRAM on standard modules; skipped ---

  // --- Top-side general I/O, GPIO 33..48 ---
  { pin: 'GPIO33', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO33' },
  { pin: 'GPIO34', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO34' },
  { pin: 'GPIO35', gpio: true,  adc: false, dac: false, pwm: true,  i2s: 'sd',   label: 'GPIO35 / I2S_SD' },
  { pin: 'GPIO36', gpio: true,  adc: false, dac: false, pwm: true,  i2s: 'sck',  label: 'GPIO36 / I2S_SCK' },
  { pin: 'GPIO37', gpio: true,  adc: false, dac: false, pwm: true,  i2s: 'ws',   label: 'GPIO37 / I2S_WS' },
  { pin: 'GPIO38', gpio: true,  adc: false, dac: false, pwm: true,  i2s: 'mclk', label: 'GPIO38 / I2S_MCLK' },
  { pin: 'GPIO39', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO39' },
  { pin: 'GPIO40', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO40' },
  { pin: 'GPIO41', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO41' },
  { pin: 'GPIO42', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO42' },
  { pin: 'GPIO43', gpio: true,  adc: false, dac: false, pwm: true,  uart: 'tx', label: 'GPIO43 / U0_TX' },
  { pin: 'GPIO44', gpio: true,  adc: false, dac: false, pwm: true,  uart: 'rx', label: 'GPIO44 / U0_RX' },
  { pin: 'GPIO45', gpio: true,  adc: false, dac: false, pwm: true,  strapping: true, label: 'GPIO45 (strap)' },
  { pin: 'GPIO46', gpio: true,  adc: false, dac: false, pwm: true,  strapping: true, label: 'GPIO46 (strap)' },
  { pin: 'GPIO47', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO47' },
  { pin: 'GPIO48', gpio: true,  adc: false, dac: false, pwm: true,  label: 'GPIO48' }
]

/** Fast lookup. Populated once at module load. */
export const ESP32_S3_PIN_CAPS: Record<string, PinCapabilities> = (() => {
  const out: Record<string, PinCapabilities> = {}
  for (const c of ESP32_S3_PINS) out[c.pin] = c
  return out
})()

/**
 * ADC1 channel number (0..9) for ADC1-capable pins, or ADC2 channel
 * (100..107 offset) for ADC2-capable pins, else -1. The offset lets
 * codegen distinguish the two peripherals without a second lookup.
 *
 *   GPIO 1..10  -> ADC1 channels 0..9
 *   GPIO 11..18 -> ADC2 channels 0..7 (returned as 100..107)
 */
export function esp32AdcChannelOf(pin: string): number {
  if (!pin.startsWith('GPIO')) return -1
  const n = Number(pin.slice(4))
  if (!Number.isFinite(n)) return -1
  if (n >= 1 && n <= 10) return n - 1
  if (n >= 11 && n <= 18) return 100 + (n - 11)
  return -1
}

/**
 * Physical layout on the DevKitC-1. Two headers of 21 pins each
 * (matching the board's silkscreen), plus power/USB rails. Index 0 is
 * the USB end of the board.
 */
export interface Esp32PhysicalPinPosition {
  pin: Esp32Pin | 'VIN' | '3V3' | 'GND' | 'EN' | 'USB_DP' | 'USB_DM' | 'TX0' | 'RX0'
  side: 'left' | 'right'
  index: number
  label: string
}

/**
 * Approximate DevKitC-1 layout. We render 20 rows per side (matches the
 * Seed's grid) so the renderer stays simple — power/boot pins collapse
 * onto the same rail graphic as on the Seed view.
 */
export const ESP32_S3_PHYSICAL_LAYOUT: Esp32PhysicalPinPosition[] = [
  // LEFT header (silkscreen top-to-bottom, USB-end first)
  { pin: '3V3',    side: 'left', index: 0,  label: '3V3'   },
  { pin: 'EN',     side: 'left', index: 1,  label: 'EN'    },
  { pin: 'GPIO4',  side: 'left', index: 2,  label: 'GPIO4'  },
  { pin: 'GPIO5',  side: 'left', index: 3,  label: 'GPIO5'  },
  { pin: 'GPIO6',  side: 'left', index: 4,  label: 'GPIO6'  },
  { pin: 'GPIO7',  side: 'left', index: 5,  label: 'GPIO7'  },
  { pin: 'GPIO15', side: 'left', index: 6,  label: 'GPIO15' },
  { pin: 'GPIO16', side: 'left', index: 7,  label: 'GPIO16' },
  { pin: 'GPIO17', side: 'left', index: 8,  label: 'GPIO17' },
  { pin: 'GPIO18', side: 'left', index: 9,  label: 'GPIO18' },
  { pin: 'GPIO8',  side: 'left', index: 10, label: 'GPIO8'  },
  { pin: 'GPIO3',  side: 'left', index: 11, label: 'GPIO3'  },
  { pin: 'GPIO46', side: 'left', index: 12, label: 'GPIO46' },
  { pin: 'GPIO9',  side: 'left', index: 13, label: 'GPIO9'  },
  { pin: 'GPIO10', side: 'left', index: 14, label: 'GPIO10' },
  { pin: 'GPIO11', side: 'left', index: 15, label: 'GPIO11' },
  { pin: 'GPIO12', side: 'left', index: 16, label: 'GPIO12' },
  { pin: 'GPIO13', side: 'left', index: 17, label: 'GPIO13' },
  { pin: 'GPIO14', side: 'left', index: 18, label: 'GPIO14' },
  { pin: 'GND',    side: 'left', index: 19, label: 'GND'   },

  // RIGHT header
  { pin: 'GND',    side: 'right', index: 0,  label: 'GND'    },
  { pin: 'VIN',    side: 'right', index: 1,  label: 'VIN'    },
  { pin: 'GPIO43', side: 'right', index: 2,  label: 'TX0'    },
  { pin: 'GPIO44', side: 'right', index: 3,  label: 'RX0'    },
  { pin: 'GPIO1',  side: 'right', index: 4,  label: 'GPIO1'  },
  { pin: 'GPIO2',  side: 'right', index: 5,  label: 'GPIO2'  },
  { pin: 'GPIO42', side: 'right', index: 6,  label: 'GPIO42' },
  { pin: 'GPIO41', side: 'right', index: 7,  label: 'GPIO41' },
  { pin: 'GPIO40', side: 'right', index: 8,  label: 'GPIO40' },
  { pin: 'GPIO39', side: 'right', index: 9,  label: 'GPIO39' },
  { pin: 'GPIO38', side: 'right', index: 10, label: 'GPIO38' },
  { pin: 'GPIO37', side: 'right', index: 11, label: 'GPIO37' },
  { pin: 'GPIO36', side: 'right', index: 12, label: 'GPIO36' },
  { pin: 'GPIO35', side: 'right', index: 13, label: 'GPIO35' },
  { pin: 'GPIO0',  side: 'right', index: 14, label: 'GPIO0'  },
  { pin: 'GPIO45', side: 'right', index: 15, label: 'GPIO45' },
  { pin: 'GPIO48', side: 'right', index: 16, label: 'GPIO48' },
  { pin: 'GPIO47', side: 'right', index: 17, label: 'GPIO47' },
  { pin: 'GPIO21', side: 'right', index: 18, label: 'GPIO21' },
  { pin: 'GPIO20', side: 'right', index: 19, label: 'D+'     }
]

/** Pins addressable from the inspector's pin-dropdown, in physical order. */
export const ESP32_S3_PINS_IN_ORDER: string[] = ESP32_S3_PHYSICAL_LAYOUT
  .filter((p) => typeof p.pin === 'string' && p.pin.startsWith('GPIO'))
  .map((p) => p.pin as string)

/**
 * Which pins satisfy a component role on the ESP32-S3. Same semantics as
 * `pinsForRole` in `daisySeedPinout.ts` but against the ESP32 table.
 */
export function esp32PinsForRole(role: string, kind: string): string[] {
  const r = role.toLowerCase()
  return ESP32_S3_PINS.filter((cap) => {
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
        return cap.gpio
      case 'oled_ssd1306':
        if (r === 'sda') return cap.i2c === 'sda' || cap.gpio
        if (r === 'scl') return cap.i2c === 'scl' || cap.gpio
        return !!cap.i2c
      case 'i2s_codec':
        if (r === 'sck')   return cap.i2s === 'sck'  || cap.gpio
        if (r === 'ws')    return cap.i2s === 'ws'   || cap.gpio
        if (r === 'mclk')  return cap.i2s === 'mclk' || cap.gpio
        if (r === 'sd_in' || r === 'sd_out') return cap.i2s === 'sd' || cap.gpio
        return !!cap.i2s
      case 'midi_jack':
        return cap.uart === 'rx' || cap.uart === 'tx' || cap.gpio
      case 'audio_jack':
        return cap.gpio
      default:
        return cap.gpio
    }
  }).map((c) => c.pin)
}
