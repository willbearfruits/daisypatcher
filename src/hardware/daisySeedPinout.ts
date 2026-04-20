/**
 * Daisy Seed pin-to-STM32 mapping + capability flags. Labels match the
 * silkscreen on the board. This drives the hardware view renderer AND
 * the codegen pin map (so we keep the two in sync).
 *
 * Sources (in order of trust):
 *   1. libDaisy source — `sdk/libDaisy/src/daisy_seed.h` (seed::D0..D30,
 *      plus seed::D31/D32 for the Daisy Seed 2 DFM). Ground truth because
 *      it's what compiles against the hardware.
 *   2. libDaisy `src/per/adc.cpp` — STM32 channel → STM32 pin map
 *      (dsy_adc_channel_map + PIN_CHN_*). We use libDaisy's 0..11 channel
 *      index (the order pins appear in an AdcChannelConfig[] array), NOT
 *      the raw STM32 ADC_CHANNEL_N number, because that's what hw.adc
 *      gives users.
 *   3. libDaisy `src/per/uart.cpp`, `src/per/spi.cpp`, `src/per/dac.cpp`,
 *      `src/per/i2c.cpp` — alt-function matrices for each peripheral.
 *   4. Electrosmith's Daisy Seed pinout diagram (square PNG on the product
 *      page) — used to confirm physical header order.
 *
 * Rev notes:
 *   - The onboard WM8731 codec is wired to SAI1 on PORTE pins (PE2..PE6)
 *     which are NOT broken out to the 40-pin header. There is no user-
 *     accessible I2S peripheral on the OG Seed unless you bit-bang on
 *     GPIOs or use SAI2 pins that happen to overlap SPI2 on PB14/PB15.
 *     The previous version of this file flagged D27..D30 as I2S pins —
 *     that was wrong. D29/D30 (PB14/PB15) are SAI2 *possible* via alt
 *     function but aren't labeled as such on the silkscreen and aren't
 *     plumbed by libDaisy; we surface them as SPI2 instead, which is the
 *     common use.
 *   - D31 (PC2) and D32 (PC3) exist only on the Daisy Seed 2 DFM. The
 *     OG Seed Rev 1–5 has D0..D30 only. Our SeedPin union includes D31
 *     so Seed 2 DFM projects round-trip, but we flag it in its label and
 *     the physical layout puts it in the Seed-2-specific slot.
 *   - D22/D23 are both DAC (PA5=DAC_OUT_2, PA4=DAC_OUT_1) AND ADC
 *     (ADC3_INP18, INP19). libDaisy happily treats them as ADC when you
 *     feed them into AdcChannelConfig; codegen defaults to DAC use.
 */
import type { PinCapabilities, SeedPin } from '@/types/hardware'

/**
 * Authoritative pin-capability table.
 *
 * Every Daisy Seed GPIO breakout (D0..D30, plus D31 for Seed 2 DFM) is
 * listed. `gpio` is true for all of them — every broken-out pin is usable
 * as a digital I/O when not multiplexed into a peripheral. ADC-capable
 * pins are those whose STM32 pin has an ADC1/ADC2/ADC3 channel listed in
 * libDaisy's `per/adc.cpp` PIN_CHN_* table AND is broken out to the
 * header: D15..D25 and D28 on the OG Seed (12 pins, matching the
 * advertised "x12 ADC inputs"), plus D31/D32 on Seed 2 DFM.
 *
 * PWM / TIM-capable is a best-effort hint marking pins where a common
 * STM32H750 TIM_CH is on an alt-function we can switch to. Not a
 * complete timer map — users wanting specific TIMs should check the
 * STM32H750 datasheet.
 */
export const DAISY_SEED_PINS: PinCapabilities[] = [
  // --- Left header (D0..D14), libDaisy seed:: constants ---
  // D0  = PB12. Usable as UART5_RX, SPI2_NSS, TIM1_CH3N, CAN2_RX.
  { pin: 'D0',  stm32Pin: 'PB12', gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx', label: 'D0 / PB12 / UART5_RX' },
  // D1  = PC11. USART3_RX / UART4_RX / SPI3_MISO.
  { pin: 'D1',  stm32Pin: 'PC11', gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', label: 'D1 / PC11 / USART3_RX' },
  // D2  = PC10. USART3_TX / UART4_TX / SPI3_SCK.
  { pin: 'D2',  stm32Pin: 'PC10', gpio: true, adc: false, dac: false, pwm: false, uart: 'tx', label: 'D2 / PC10 / USART3_TX' },
  // D3  = PC9. I2C3_SDA / TIM3_CH4 / TIM8_CH4 / SDMMC1_D1.
  { pin: 'D3',  stm32Pin: 'PC9',  gpio: true, adc: false, dac: false, pwm: true,  i2c: 'sda', label: 'D3 / PC9 / I2C3_SDA' },
  // D4  = PC8. TIM3_CH3 / TIM8_CH3 / SDMMC1_D0.
  { pin: 'D4',  stm32Pin: 'PC8',  gpio: true, adc: false, dac: false, pwm: true,  label: 'D4 / PC8' },
  // D5  = PD2. UART5_RX / TIM3_ETR / SDMMC1_CMD.
  { pin: 'D5',  stm32Pin: 'PD2',  gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', label: 'D5 / PD2 / UART5_RX' },
  // D6  = PC12. UART5_TX / USART3_CK / SPI3_MOSI / SDMMC1_CK.
  { pin: 'D6',  stm32Pin: 'PC12', gpio: true, adc: false, dac: false, pwm: false, uart: 'tx', label: 'D6 / PC12 / UART5_TX' },
  // D7  = PG10. SPI1_NSS (CS) / LCD R2 / SAI2_SD_B.
  { pin: 'D7',  stm32Pin: 'PG10', gpio: true, adc: false, dac: false, pwm: false, spi: 'cs',   label: 'D7 / PG10 / SPI1_NSS' },
  // D8  = PG11. SPI1_SCK.
  { pin: 'D8',  stm32Pin: 'PG11', gpio: true, adc: false, dac: false, pwm: false, spi: 'sck',  label: 'D8 / PG11 / SPI1_SCK' },
  // D9  = PB4. SPI1_MISO / SPI3_MISO / UART7_TX / TIM16_CH1N / I2C3 (with alt).
  { pin: 'D9',  stm32Pin: 'PB4',  gpio: true, adc: false, dac: false, pwm: true,  spi: 'miso', uart: 'tx', label: 'D9 / PB4 / SPI1_MISO' },
  // D10 = PB5. SPI1_MOSI / SPI3_MOSI / UART5_RX / I2C1_SMBA / TIM17_CH1N.
  { pin: 'D10', stm32Pin: 'PB5',  gpio: true, adc: false, dac: false, pwm: true,  spi: 'mosi', label: 'D10 / PB5 / SPI1_MOSI' },
  // D11 = PB8. I2C1_SCL / I2C4_SCL / UART4_RX / TIM16_CH1 / TIM4_CH3.
  { pin: 'D11', stm32Pin: 'PB8',  gpio: true, adc: false, dac: false, pwm: true,  i2c: 'scl',  label: 'D11 / PB8 / I2C1_SCL' },
  // D12 = PB9. I2C1_SDA / I2C4_SDA / UART4_TX / TIM17_CH1 / TIM4_CH4.
  { pin: 'D12', stm32Pin: 'PB9',  gpio: true, adc: false, dac: false, pwm: true,  i2c: 'sda',  label: 'D12 / PB9 / I2C1_SDA' },
  // D13 = PB6. USART1_TX / LPUART1_TX / UART5_TX / I2C1_SCL (alt) / I2C4_SCL.
  { pin: 'D13', stm32Pin: 'PB6',  gpio: true, adc: false, dac: false, pwm: true,  uart: 'tx',  label: 'D13 / PB6 / USART1_TX' },
  // D14 = PB7. USART1_RX / LPUART1_RX / I2C1_SDA (alt) / I2C4_SDA / TIM4_CH2.
  { pin: 'D14', stm32Pin: 'PB7',  gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx',  label: 'D14 / PB7 / USART1_RX' },

  // --- Right header (D15..D30), the analog-rich side ---
  // ADC channel indices below are the 0..11 indices libDaisy exposes via
  // AdcChannelConfig (NOT the raw STM32 ADC_CHANNEL_N). Derived from the
  // order of pins as they map into the STM32 ADC channel space; we record
  // the STM32 channel in the label for traceability.
  // D15 = PC0. ADC123_INP10 / no common UART.
  { pin: 'D15', stm32Pin: 'PC0',  gpio: true, adc: true,  dac: false, pwm: false, label: 'D15 / PC0 / ADC_0 (CH10)' },
  // D16 = PA3. ADC12_INP15 / USART2_RX / TIM2_CH4 / TIM5_CH4 / TIM9_CH2.
  { pin: 'D16', stm32Pin: 'PA3',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'rx', label: 'D16 / PA3 / ADC_1 (CH15)' },
  // D17 = PB1. ADC12_INP5 / TIM1_CH3N / TIM3_CH4 / TIM8_CH3N.
  { pin: 'D17', stm32Pin: 'PB1',  gpio: true, adc: true,  dac: false, pwm: true,  label: 'D17 / PB1 / ADC_2 (CH5)' },
  // D18 = PA7. ADC12_INP7 / SPI1_MOSI / SPI6_MOSI / TIM1_CH1N / TIM3_CH2 / TIM8_CH1N.
  { pin: 'D18', stm32Pin: 'PA7',  gpio: true, adc: true,  dac: false, pwm: true,  spi: 'mosi', label: 'D18 / PA7 / ADC_3 (CH7)' },
  // D19 = PA6. ADC12_INP3 / SPI1_MISO / SPI6_MISO / TIM3_CH1 / TIM8_BKIN / TIM13_CH1.
  { pin: 'D19', stm32Pin: 'PA6',  gpio: true, adc: true,  dac: false, pwm: true,  spi: 'miso', label: 'D19 / PA6 / ADC_4 (CH3)' },
  // D20 = PC1. ADC123_INP11 / SPI2_MOSI / TIM? (none common).
  { pin: 'D20', stm32Pin: 'PC1',  gpio: true, adc: true,  dac: false, pwm: false, spi: 'mosi', label: 'D20 / PC1 / ADC_5 (CH11)' },
  // D21 = PC4. ADC12_INP4 / SPI1_MOSI (alt) / I2S1_MCK.
  { pin: 'D21', stm32Pin: 'PC4',  gpio: true, adc: true,  dac: false, pwm: false, label: 'D21 / PC4 / ADC_6 (CH4)' },
  // D22 = PA5. DAC1_OUT2 / ADC12_INP19 / SPI1_SCK / SPI6_SCK / TIM2_CH1 / TIM8_CH1N.
  { pin: 'D22', stm32Pin: 'PA5',  gpio: true, adc: true,  dac: true,  pwm: true,  spi: 'sck', label: 'D22 / PA5 / DAC_OUT_2 / ADC_11 (CH19)' },
  // D23 = PA4. DAC1_OUT1 / ADC12_INP18 / SPI1_NSS / SPI3_NSS / SPI6_NSS.
  { pin: 'D23', stm32Pin: 'PA4',  gpio: true, adc: true,  dac: true,  pwm: false, spi: 'cs',  label: 'D23 / PA4 / DAC_OUT_1 / ADC_10 (CH18)' },
  // D24 = PA1. ADC12_INP17 / UART4_RX / USART2_RTS / TIM2_CH2 / TIM5_CH2 / TIM15_CH1N.
  { pin: 'D24', stm32Pin: 'PA1',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'rx', label: 'D24 / PA1 / ADC_9 (CH17)' },
  // D25 = PA0. ADC12_INP16 / UART4_TX / USART2_CTS / TIM2_CH1 / TIM5_CH1 / TIM8_ETR.
  { pin: 'D25', stm32Pin: 'PA0',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'tx', label: 'D25 / PA0 / ADC_8 (CH16)' },
  // D26 = PD11. No ADC on PD11. USART3_CTS / I2C4_SMBA / SAI2_SD_A. libDaisy
  // does NOT alias D26 as an analog pin (A-alias list stops at A11=D28).
  // The old table incorrectly marked this ADC-capable.
  { pin: 'D26', stm32Pin: 'PD11', gpio: true, adc: false, dac: false, pwm: false, label: 'D26 / PD11' },
  // D27 = PG9. USART6_RX / SPI1_MISO (alt) / SAI2_FS_B. Not ADC-capable on
  // STM32H750. Old table had it as ADC_10 / I2S_MCLK — both wrong.
  { pin: 'D27', stm32Pin: 'PG9',  gpio: true, adc: false, dac: false, pwm: false, uart: 'rx', label: 'D27 / PG9 / USART6_RX' },
  // D28 = PA2. ADC12_INP14 / USART2_TX / TIM2_CH3 / TIM5_CH3 / TIM15_CH1.
  // libDaisy aliases D28 as A11 — so this is the 12th and final ADC pin
  // on the OG Seed, corresponding to channel index 7 in dsy_adc_channel_map.
  { pin: 'D28', stm32Pin: 'PA2',  gpio: true, adc: true,  dac: false, pwm: true,  uart: 'tx', label: 'D28 / PA2 / ADC_7 (CH14) / USART2_TX' },
  // D29 = PB14. USART1_TX / SPI2_MISO / TIM1_CH2N / TIM12_CH1 / SAI2 (via alt).
  // Onboard codec does NOT use this — SAI1 is on PORTE. PB14 is free.
  { pin: 'D29', stm32Pin: 'PB14', gpio: true, adc: false, dac: false, pwm: true,  uart: 'tx', spi: 'miso', label: 'D29 / PB14 / USART1_TX / SPI2_MISO' },
  // D30 = PB15. USART1_RX / SPI2_MOSI / TIM1_CH3N / TIM12_CH2 / SAI2 (via alt).
  { pin: 'D30', stm32Pin: 'PB15', gpio: true, adc: false, dac: false, pwm: true,  uart: 'rx', spi: 'mosi', label: 'D30 / PB15 / USART1_RX / SPI2_MOSI' },

  // --- Daisy Seed 2 DFM only ---
  // D31 = PC2. ADC123_INP12 / SPI2_MISO. Present only on Seed 2 DFM (OG
  // Seed Rev 1..5 stops at D30). We keep it in the union so Seed 2 DFM
  // projects round-trip.
  { pin: 'D31', stm32Pin: 'PC2',  gpio: true, adc: true,  dac: false, pwm: false, spi: 'miso', label: 'D31 / PC2 / ADC (Seed 2 DFM only)' }
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
 *
 * The indices here are the *libDaisy* 0..11 indices (the order you'd pass
 * an AdcChannelConfig[] array to hw.adc.Init), not the raw STM32
 * ADC_CHANNEL_N numbers. Derived from dsy_adc_channel_map in
 * libDaisy/src/per/adc.cpp: channels are ordered
 * CH3, CH4, CH5, CH7, CH8, CH9, CH10, CH11, CH12, CH13, CH14, CH15,
 * CH16, CH17, CH18, CH19 — and we just pick the ones that correspond to
 * Seed-broken-out pins.
 *
 * ADC pin → libDaisy index assignments (12 pins on OG Seed):
 *   D15=PC0 (CH10) → 6    D22=PA5 (CH19) → 15
 *   D16=PA3 (CH15) → 11   D23=PA4 (CH18) → 14
 *   D17=PB1 (CH5)  → 2    D24=PA1 (CH17) → 13
 *   D18=PA7 (CH7)  → 3    D25=PA0 (CH16) → 12
 *   D19=PA6 (CH3)  → 0    D28=PA2 (CH14) → 10
 *   D20=PC1 (CH11) → 7    D31=PC2 (CH12) → 8  (Seed 2 DFM)
 *   D21=PC4 (CH4)  → 1
 */
export function adcChannelOf(pin: SeedPin): number {
  const map: Partial<Record<SeedPin, number>> = {
    D19: 0,
    D21: 1,
    D17: 2,
    D18: 3,
    D15: 6,
    D20: 7,
    D31: 8,
    D28: 10,
    D16: 11,
    D25: 12,
    D24: 13,
    D23: 14,
    D22: 15
  }
  return map[pin] ?? -1
}

/**
 * Physical 40-pin header layout as screen-printed on the Seed. Two pin
 * headers of 20 pins each. Index 0 is the USB-end of the board; index 19
 * is the opposite end. The physical pin order is taken from the official
 * pinout diagram on Electrosmith's product page.
 *
 * Orientation: looking at the TOP face of the Seed with the USB connector
 * at the TOP. The left header runs downward D0, D1, ..., D14 then power
 * rails; the right header runs upward D15..D30 when numbered but DOWNWARD
 * as D30, D29, ..., D15, D31 so the physical grid mirrors correctly.
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
 * header runs D0..D14 plus power/USB; right header runs D30..D15 plus
 * audio jacks and the second 3V3 + AGND rail.
 *
 * NOTE: the right side is intentionally MIRRORED relative to the left
 * (D30 at top, D15 near bottom). This is because the right header
 * physically runs bottom-up from the viewer's perspective when the USB
 * connector is at the top of the board. If the hardware view ever
 * renders pins in the wrong slot, suspect this flip.
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
  { pin: 'D31',         side: 'right', index: 16, label: 'D31 (Seed 2 DFM)' },
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
        // NOTE: The OG Seed's onboard WM8731 is hard-wired to SAI1 on
        // PORTE (PE2..PE6) which is NOT broken out. For an *external*
        // I2S DAC/ADC the user must bit-bang or use SAI2 via GPIO alt
        // functions — we don't gate strictly on the i2s flag (none of
        // our pins carry it) so fall back to GPIO. Codegen is
        // responsible for warning if SAI alt isn't actually available.
        if (r === 'sck')   return cap.i2s === 'sck'  || cap.gpio
        if (r === 'ws')    return cap.i2s === 'ws'   || cap.gpio
        if (r === 'mclk')  return cap.i2s === 'mclk' || cap.gpio
        if (r === 'sd_in' || r === 'sd_out') return cap.i2s === 'sd' || cap.gpio
        return cap.gpio
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
