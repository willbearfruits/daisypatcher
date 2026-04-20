/**
 * ESP32-S3 target backend. Emits an Arduino/PlatformIO project that
 * compiles without libDaisy / DaisySP — DSP math is inlined in plain
 * C++ via the ESP32-specific emitter table (`nodeEmittersEsp32.ts`).
 *
 * Output layout:
 *   platformio.ini   — build config for the `esp32-s3-devkitc-1` env.
 *   src/main.cpp     — setup() + loop() + an I2S audio callback.
 *   project.json     — serialized AudioGraph (same as Daisy target).
 */
import type { AudioGraph, NodeInstance, NodeKind } from '@/types/graph'
import type { HardwareLayout, PlacedComponent } from '@/types/hardware'
import { emptyHardwareLayout } from '@/types/hardware'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { EmitContext, NodeEmitter } from '../nodeEmitters'
import { ESP32_NODE_EMITTERS } from '../nodeEmittersEsp32'
import {
  buildConnectionIndex,
  nodeVar,
  safeName,
  targetKey,
  topoSort,
  validateGraph
} from '../graphWalk'
import { esp32AdcChannelOf } from '@/hardware/esp32s3Pinout'
import type { GeneratedProject } from '../generateProject'
import type { TargetBackend } from './index'

/** Parse `"GPIO12"` -> 12, falling back to a guarded default. */
function gpioNum(pin: string | undefined, fallback: number): number {
  if (typeof pin !== 'string') return fallback
  if (!pin.startsWith('GPIO')) return fallback
  const n = Number(pin.slice(4))
  return Number.isFinite(n) ? n : fallback
}

interface HwState {
  // For each pot / cv_jack — its pin GPIO number + the variable name
  // that stores its float value between audio blocks.
  pots: { varName: string; gpio: number; label: string }[]
  buttons: { varName: string; gpio: number; label: string }[]
  gates: { varName: string; gpio: number; label: string }[]
  leds: { varName: string; gpio: number; label: string }[]
  switches: { varName: string; p1: number; p2: number; label: string }[]
  // I2S codec binding if any
  i2sCodec: {
    sck: number
    ws: number
    sdIn: number
    sdOut: number
    mclk: number
  } | null
  // OLED (i2c) if any
  oled: { sda: number; scl: number; address: string } | null
  /** Any graph node that wants its value sampled from hardware — keyed by bindingId. */
  bindings: Map<string, PlacedComponent>
}

function walkHardware(hardware: HardwareLayout): HwState {
  const st: HwState = {
    pots: [],
    buttons: [],
    gates: [],
    leds: [],
    switches: [],
    i2sCodec: null,
    oled: null,
    bindings: new Map()
  }
  for (const c of hardware.components) {
    st.bindings.set(c.id, c)
    const base = `hw_${c.kind}_${c.id.replace(/[^A-Za-z0-9_]/g, '_')}`
    switch (c.kind) {
      case 'pot': {
        const pin = c.pins['wiper']
        if (pin) st.pots.push({ varName: `${base}_val`, gpio: gpioNum(pin, 1), label: c.label })
        break
      }
      case 'cv_jack': {
        const pin = c.pins['signal']
        if (pin) st.pots.push({ varName: `${base}_val`, gpio: gpioNum(pin, 1), label: c.label })
        break
      }
      case 'button': {
        const pin = c.pins['io']
        if (pin) st.buttons.push({ varName: `${base}_val`, gpio: gpioNum(pin, 0), label: c.label })
        break
      }
      case 'gate_jack': {
        const pin = c.pins['io']
        if (pin) st.gates.push({ varName: `${base}_val`, gpio: gpioNum(pin, 0), label: c.label })
        break
      }
      case 'led': {
        const pin = c.pins['anode']
        if (pin) st.leds.push({ varName: `${base}_val`, gpio: gpioNum(pin, 21), label: c.label })
        break
      }
      case 'switch_3way': {
        const p1 = c.pins['pos1']
        const p2 = c.pins['pos2']
        if (p1 && p2) st.switches.push({
          varName: `${base}_val`, p1: gpioNum(p1, 0), p2: gpioNum(p2, 0), label: c.label
        })
        break
      }
      case 'i2s_codec': {
        st.i2sCodec = {
          sck:   gpioNum(c.pins['sck'], 36),
          ws:    gpioNum(c.pins['ws'], 37),
          sdIn:  gpioNum(c.pins['sd_in'], 35),
          sdOut: gpioNum(c.pins['sd_out'], 35),
          mclk:  gpioNum(c.pins['mclk'], 38)
        }
        break
      }
      case 'oled_ssd1306': {
        st.oled = {
          sda: gpioNum(c.pins['sda'], 8),
          scl: gpioNum(c.pins['scl'], 9),
          address: String(c.config['address'] ?? '0x3C')
        }
        break
      }
    }
  }
  return st
}

export function generateEsp32S3Project(
  graph: AudioGraph,
  hardware: HardwareLayout = emptyHardwareLayout('esp32_s3_devkitc'),
  projectName?: string
): GeneratedProject {
  const name = safeName(projectName ?? graph.meta.name ?? 'DaisypatcherPatch')
  const warnings: string[] = []
  const warn = (msg: string) => warnings.push(msg)

  for (const msg of validateGraph(graph)) warn(msg)

  const connIdx = buildConnectionIndex(graph.connections)
  const { order } = topoSort(graph.nodes, graph.connections, warn)

  const nodeById = new Map<string, NodeInstance>()
  for (const n of graph.nodes) nodeById.set(n.id, n)

  const hw = walkHardware(hardware)

  const ctx = (node: NodeInstance): EmitContext => ({
    node,
    graph,
    hardware,
    varName: (id) => {
      const n = nodeById.get(id)
      return nodeVar(id, (n?.kind ?? 'oscillator') as NodeKind)
    },
    inputExpr: (nid, sid, def = '0.f') => {
      const src = connIdx.byTarget.get(targetKey(nid, sid))
      if (!src) return def
      const sn = nodeById.get(src.nodeId)
      if (!sn) return def
      return `${nodeVar(src.nodeId, sn.kind)}_${src.socketId}`
    },
    outputVar: (nid, sid) => {
      const n = nodeById.get(nid)
      return `${nodeVar(nid, (n?.kind ?? 'oscillator') as NodeKind)}_${sid}`
    },
    warn
  })

  const declLines: string[] = []
  const initLines: string[] = []
  const processLines: string[] = []

  // Every LED emitter writes to `<var>_val`; we declare the state here
  // so the emitter can assume it exists without double-declaring.
  for (const n of graph.nodes) {
    if (n.kind === 'led') declLines.push(`float ${nodeVar(n.id, 'led')}_val = 0.f;`)
  }

  const outputNode = graph.nodes.find((n) => n.kind === 'audio_output')

  for (const id of order) {
    const node = nodeById.get(id)
    if (!node) continue
    let emitter: NodeEmitter | undefined = ESP32_NODE_EMITTERS[node.kind]
    if (!emitter) {
      warn(`no ESP32 emitter for ${node.kind}; passthrough stub`)
      emitter = {
        declare: () => '',
        init: () => '',
        process: (c) => {
          c.warn(`node kind ${c.node.kind} has no codegen implementation for this target`)
          const def = NODE_DEFINITIONS[c.node.kind]
          if (!def) return ''
          const inSock = def.inputs[0]?.id
          const src = inSock ? c.inputExpr(c.node.id, inSock, '0.f') : '0.f'
          const lines: string[] = [`    // TODO: implement ${c.node.kind} emission`]
          for (const out of def.outputs) {
            lines.push(`    float ${c.outputVar(c.node.id, out.id)} = ${src};`)
          }
          return lines.join('\n') + '\n'
        }
      }
    }

    const c = ctx(node)
    const d = emitter.declare(c)
    if (d) declLines.push(`// ${node.kind} ${node.id}\n${d}`)
    const initSrc = emitter.init(c)
    if (initSrc) initLines.push(initSrc)
    const p = emitter.process(c)
    if (p) processLines.push(p)
  }

  let leftExpr = '0.f'
  let rightExpr = '0.f'
  if (outputNode) {
    const c = ctx(outputNode)
    leftExpr = c.inputExpr(outputNode.id, 'left', '0.f')
    const rawRight = c.inputExpr(outputNode.id, 'right', '__NO_RIGHT__')
    rightExpr = rawRight === '__NO_RIGHT__' ? leftExpr : rawRight
  }

  // Hardware ADC / GPIO / I2S state tables
  const hwDecls: string[] = []
  for (const p of hw.pots) hwDecls.push(`float ${p.varName} = 0.f; // ${p.label}`)
  for (const b of hw.buttons) hwDecls.push(`float ${b.varName} = 0.f; // ${b.label}`)
  for (const g of hw.gates)   hwDecls.push(`float ${g.varName} = 0.f; // ${g.label}`)
  for (const s of hw.switches) hwDecls.push(`float ${s.varName} = 0.f; // ${s.label}`)

  // Per-knob/button nodes use `<kind>_<nodeid>_val`. When they have a
  // hardware binding, we patch the loop() to copy from the hw_* var.
  const pollLines: string[] = []
  for (const n of graph.nodes) {
    const bid = typeof n.params.bindingId === 'string' ? n.params.bindingId : ''
    if (!bid) continue
    const comp = hw.bindings.get(bid)
    if (!comp) continue
    const compBase = `hw_${comp.kind}_${comp.id.replace(/[^A-Za-z0-9_]/g, '_')}_val`
    const varBase = `${nodeVar(n.id, n.kind)}_val`
    if (n.kind === 'knob_in' || n.kind === 'gate_in' || n.kind === 'button' || n.kind === 'switch_3way') {
      pollLines.push(`    ${varBase} = ${compBase};`)
    }
  }

  // LED writes
  for (const n of graph.nodes) {
    if (n.kind !== 'led') continue
    const bid = typeof n.params.bindingId === 'string' ? n.params.bindingId : ''
    if (!bid) continue
    const comp = hw.bindings.get(bid)
    if (!comp || comp.kind !== 'led') continue
    const pin = comp.pins['anode']
    const g = gpioNum(pin, 21)
    const varBase = `${nodeVar(n.id, 'led')}_val`
    pollLines.push(`    digitalWrite(${g}, (${varBase} > 0.5f) ? HIGH : LOW);`)
  }

  const main = buildMainCpp({
    name,
    projectDisplayName: graph.meta.name,
    blockSize: graph.meta.blockSize,
    sampleRate: graph.meta.sampleRate,
    declLines,
    hwDecls,
    initLines,
    processLines,
    leftExpr,
    rightExpr,
    hw,
    pollLines,
    warnings
  })

  const platformioIni = buildPlatformioIni(hw)
  const projectJson = JSON.stringify(graph, null, 2)

  return {
    projectName: name,
    files: {
      'platformio.ini': platformioIni,
      'src/main.cpp': main,
      'project.json': projectJson
    },
    warnings
  }
}

function buildPlatformioIni(hw: HwState): string {
  const libs: string[] = []
  if (hw.oled) {
    libs.push('adafruit/Adafruit SSD1306 @ ^2.5.9')
    libs.push('adafruit/Adafruit GFX Library @ ^1.11.9')
  }
  const libDeps = libs.length
    ? `lib_deps =\n    ${libs.join('\n    ')}\n`
    : ''
  return `[env:esp32-s3-devkitc-1]
platform = espressif32
board = esp32-s3-devkitc-1
framework = arduino
monitor_speed = 115200
build_flags = -DARDUINO_USB_CDC_ON_BOOT=1 -DARDUINO_USB_MODE=1
${libDeps}`
}

function buildMainCpp(args: {
  name: string
  projectDisplayName: string
  blockSize: number
  sampleRate: number
  declLines: string[]
  hwDecls: string[]
  initLines: string[]
  processLines: string[]
  leftExpr: string
  rightExpr: string
  hw: HwState
  pollLines: string[]
  warnings: string[]
}): string {
  const block = Math.max(1, args.blockSize | 0) || 64
  const sr = args.sampleRate > 0 ? args.sampleRate : 48000

  const warningsBlock = args.warnings.length
    ? `// Codegen warnings:\n${args.warnings.map((w) => `//   - ${w}`).join('\n')}\n`
    : ''

  // I2S pin config — either the bound codec's pins or sensible defaults.
  const codec = args.hw.i2sCodec
  const pinBclk = codec?.sck ?? 36
  const pinLrck = codec?.ws ?? 37
  const pinDout = codec?.sdOut ?? 35
  const pinMclk = codec?.mclk

  const hwInitLines: string[] = []
  for (const p of args.hw.pots) {
    hwInitLines.push(`    analogRead(${p.gpio}); // prime ADC for ${p.label}`)
  }
  for (const b of args.hw.buttons) {
    hwInitLines.push(`    pinMode(${b.gpio}, INPUT_PULLUP); // ${b.label}`)
  }
  for (const g of args.hw.gates) {
    hwInitLines.push(`    pinMode(${g.gpio}, INPUT_PULLUP); // ${g.label}`)
  }
  for (const l of args.hw.leds) {
    hwInitLines.push(`    pinMode(${l.gpio}, OUTPUT); // ${l.label}`)
  }
  for (const s of args.hw.switches) {
    hwInitLines.push(`    pinMode(${s.p1}, INPUT_PULLUP); pinMode(${s.p2}, INPUT_PULLUP); // ${s.label}`)
  }
  if (args.hw.oled) {
    hwInitLines.push(`    Wire.begin(${args.hw.oled.sda}, ${args.hw.oled.scl});`)
  }

  const hwPollLines: string[] = []
  for (const p of args.hw.pots) {
    const chan = esp32AdcChannelOf(`GPIO${p.gpio}`)
    hwPollLines.push(
      `    ${p.varName} = (float)analogRead(${p.gpio}) / 4095.f; // ADC chan ${chan}`
    )
  }
  for (const b of args.hw.buttons) {
    hwPollLines.push(`    ${b.varName} = digitalRead(${b.gpio}) == LOW ? 1.f : 0.f;`)
  }
  for (const g of args.hw.gates) {
    hwPollLines.push(`    ${g.varName} = digitalRead(${g.gpio}) == LOW ? 1.f : 0.f;`)
  }
  for (const s of args.hw.switches) {
    hwPollLines.push(
      `    { bool p1 = digitalRead(${s.p1}) == LOW; bool p2 = digitalRead(${s.p2}) == LOW; ${s.varName} = p1 ? -1.f : (p2 ? 1.f : 0.f); }`
    )
  }

  const mclkBlock = pinMclk !== undefined
    ? `    // MCLK: GPIO${pinMclk} is routed by I2S driver when configured.\n`
    : ''

  return `// Auto-generated by Daisypatcher (ESP32-S3 target)
// Patch: ${args.projectDisplayName}
// Target: ${args.name}
// DO NOT EDIT — regenerate from the .dpatch file
${warningsBlock}
#include <Arduino.h>
#include <Wire.h>
#include <driver/i2s.h>
#include <math.h>

static const int SAMPLE_RATE = ${sr};
static const int BLOCK = ${block};
static const i2s_port_t I2S_PORT = I2S_NUM_0;
int16_t audio_out_buffer[${block} * 2];

// --- Node declarations ---
${args.declLines.join('\n') || '// (no nodes emitted members)'}

// --- Hardware state ---
${args.hwDecls.join('\n') || '// (no hardware components placed)'}

static inline void render_block() {
    for (int i = 0; i < BLOCK; i++) {
        float in_l = 0.f, in_r = 0.f;
        (void)in_l; (void)in_r;

${args.processLines.join('\n')}
        float out_l = ${args.leftExpr};
        float out_r = ${args.rightExpr};
        audio_out_buffer[i*2]     = (int16_t)(fmaxf(-1.f, fminf(1.f, out_l)) * 32767.f);
        audio_out_buffer[i*2 + 1] = (int16_t)(fmaxf(-1.f, fminf(1.f, out_r)) * 32767.f);
    }
}

void setup() {
    Serial.begin(115200);

    // --- Hardware pin setup ---
${hwInitLines.join('\n') || '    // (no hardware init)'}

    // --- Node init ---
${args.initLines.join('\n')}

    // --- I2S audio out ---
    i2s_config_t i2s_cfg = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 4,
        .dma_buf_len = ${block},
        .use_apll = false,
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0
    };
    i2s_pin_config_t pin_cfg = {
        .bck_io_num = ${pinBclk},
        .ws_io_num = ${pinLrck},
        .data_out_num = ${pinDout},
        .data_in_num = I2S_PIN_NO_CHANGE
    };
${mclkBlock}    i2s_driver_install(I2S_PORT, &i2s_cfg, 0, nullptr);
    i2s_set_pin(I2S_PORT, &pin_cfg);
    i2s_set_clk(I2S_PORT, SAMPLE_RATE, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
}

void loop() {
    // --- Poll hardware (ADC + GPIO) ---
${hwPollLines.join('\n') || '    // (no hardware inputs)'}

    // --- Copy bound hardware values into per-node state ---
${args.pollLines.join('\n') || '    // (no bindings)'}

    // --- Render one audio block + push to I2S ---
    render_block();
    size_t written = 0;
    i2s_write(I2S_PORT, audio_out_buffer, sizeof(audio_out_buffer), &written, portMAX_DELAY);
}
`
}

export const esp32S3Target: TargetBackend = {
  id: 'esp32_s3',
  label: 'ESP32-S3',
  description: 'Espressif ESP32-S3 DevKitC-1 (Arduino / PlatformIO)',
  generate: generateEsp32S3Project,
  buildCommand: () => ({
    bin: 'pio',
    args: ['run'],
    env: {}
  }),
  toolchainCheck: () => [
    { name: 'PlatformIO', command: 'pio', required: true, installHint: 'pip install platformio' },
    { name: 'Python 3', command: 'python3', required: true, installHint: 'install python3 (platform package manager)' }
  ],
  binaryArtifact: () => '.pio/build/esp32-s3-devkitc-1/firmware.bin',
  flashCommand: () => ({
    // PlatformIO handles port auto-detect + DTR/RTS bootloader entry.
    bin: 'pio',
    args: ['run', '--target', 'upload']
  }),
  artifactExtension: 'bin'
}
