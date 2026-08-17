/**
 * Order a role's candidate pins so auto-assignment picks the sensible one.
 *
 * `pinsForRole` on the ESP32 boards answers "which pins CAN carry this
 * role" — and on an ESP32 nearly every GPIO can carry every role, because
 * the GPIO matrix routes I2C/I2S/UART anywhere. So the filtered list came
 * back in table order and the first free pin won: an OLED landed on
 * GPIO2/GPIO4 with the board's silkscreened SDA/SCL (GPIO8/9) sitting
 * unused two rows down. Correct, and exactly what nobody wiring the board
 * from its pin card would do.
 *
 * Stable partition, not a re-sort: within each tier the table order is
 * kept, so the "first free" rule is unchanged for pins of equal standing.
 *   1. the pin whose dedicated function IS this role (I2C_SDA for `sda`,
 *      UART_RX for `rx`, I2S_WS for `ws` …)
 *   2. everything else
 *   3. strapping pins last (unless tier 1 claimed them) — they work, but
 *      pulling one the wrong way at boot is the classic "it stopped
 *      booting after I added a button".
 */
import type { PinCapabilities } from '@/types/hardware'

function dedicated(cap: PinCapabilities, role: string): boolean {
  switch (role) {
    case 'sda':
    case 'scl':
      return cap.i2c === role
    case 'rx':
    case 'tx':
      return cap.uart === role
    case 'sck':
      return cap.i2s === 'sck' || cap.spi === 'sck'
    case 'ws':
      return cap.i2s === 'ws'
    case 'sd_in':
    case 'sd_out':
    case 'sd':
      return cap.i2s === 'sd'
    case 'mclk':
      return cap.i2s === 'mclk'
    case 'miso':
    case 'mosi':
    case 'cs':
      return cap.spi === role
    default:
      return false
  }
}

export function preferDedicated(candidates: PinCapabilities[], role: string): PinCapabilities[] {
  const r = role.toLowerCase()
  const first: PinCapabilities[] = []
  const middle: PinCapabilities[] = []
  const last: PinCapabilities[] = []
  for (const cap of candidates) {
    // USB D-/D+ (GPIO19/20 on the S3). Every ESP32 profile here boots with
    // USB CDC on — that is how the serial monitor and native-USB flashing
    // work — so binding a knob to the data lines takes the port down with
    // it. Not offered at all.
    if (cap.usbReserved) continue
    // Dedicated wins even over the strapping rule: the C3 SuperMini's
    // documented I2C pair IS its two strapping pins (GPIO8/9), and the
    // bus pull-ups are what make that safe. A strapping pin with no
    // dedicated claim on the role goes last.
    if (dedicated(cap, r)) first.push(cap)
    else if (cap.strapping) last.push(cap)
    else middle.push(cap)
  }
  return [...first, ...middle, ...last]
}
