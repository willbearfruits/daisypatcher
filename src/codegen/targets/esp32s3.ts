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
import { emptyHardwareLayout, analogRoleFor } from '@/types/hardware'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import type { EmitContext, NodeEmitter } from '../nodeEmitters'
import { ESP32_NODE_EMITTERS, setParamOverridesEsp32, setSampleInfoEsp32 } from '../nodeEmittersEsp32'
import {
  dedupeMenuBlocks,
  emitMenuParamGlobals,
  makeOverrideAudit,
  menuOrderingEdges,
  menuParamOverrides,
  overrideExprMap
} from '../menuCodegen'
import {
  buildConnectionIndex,
  nodeVar,
  safeName,
  targetKey,
  auditOutputDecls,
  silenceUnusedOutputs,
  topoSort,
  validateGraph
} from '../graphWalk'
import { esp32AdcChannelOf } from '@/hardware/esp32s3Pinout'
import type { GenerateOptions, GeneratedProject } from '../generateProject'
import { emitSamples } from '../sampleCodegen'
import {
  buildPresetTable,
  emitPresetRuntime,
  hasPresetDriver,
  presetParamOverrides
} from '../presetCodegen'
import { buildProvenance, type EmitBlock, type EmitSection } from '../provenance'
import type { TargetBackend } from './index'
import type { Esp32Profile } from './esp32Profiles'
import { ESP32_PROFILES } from './esp32Profiles'
import { supportLevel } from '@/nodes/targetSupport'

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
  /**
   * I2S peripheral binding, if any. `sdIn` and `mclk` are optional because
   * not every bound device has them: a PCM5102A or MAX98357A is an
   * output-only sink with no data-return line, and the MAX98357A has no
   * MCLK pin at all (it recovers its clock from BCLK).
   */
  i2sCodec: {
    sck: number
    ws: number
    sdIn?: number
    sdOut: number
    mclk?: number
    /** False for output-only sinks — used to warn on an impossible audio_in. */
    canInput: boolean
  } | null
  // OLED (i2c) if any
  oled: { sda: number; scl: number; address: string } | null
  /** Any graph node that wants its value sampled from hardware — keyed by bindingId. */
  bindings: Map<string, PlacedComponent>
}

function walkHardware(hardware: HardwareLayout, profile: Esp32Profile): HwState {
  const dflt = profile.defaults
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

    /*
     * Analog inputs first, as a family. `st.pots` is really "things read
     * with analogRead()" — pots, sliders, ribbons, LDRs, mics, piezos and
     * CV jacks all qualify. Handling them by table rather than by two
     * hardcoded cases is what stops a placed Ribbon from vanishing
     * between the hardware view and the firmware.
     */
    const analogRole = analogRoleFor(c.kind)
    if (analogRole) {
      const isBuzzer =
        c.kind === 'piezo' && String(c.config['direction'] ?? 'input') !== 'input'
      const pin = c.pins[analogRole]
      if (pin && !isBuzzer) {
        st.pots.push({ varName: `${base}_val`, gpio: gpioNum(pin, 1), label: c.label })
      }
      continue
    }

    switch (c.kind) {
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
        if (pin) st.leds.push({ varName: `${base}_val`, gpio: gpioNum(pin, dflt.led), label: c.label })
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
        if (!dflt.i2s) break
        st.i2sCodec = {
          sck:   gpioNum(c.pins['sck'], dflt.i2s.sck),
          ws:    gpioNum(c.pins['ws'], dflt.i2s.ws),
          sdIn:  gpioNum(c.pins['sd_in'], dflt.i2s.sdIn),
          sdOut: gpioNum(c.pins['sd_out'], dflt.i2s.sdOut),
          mclk:  gpioNum(c.pins['mclk'], dflt.i2s.mclk),
          canInput: true
        }
        break
      }
      /*
       * PCM5102A (line out) and MAX98357A (class-D amp) are both TX-only
       * I2S sinks: three wires in, audio out, no data return. They share
       * the codec slot because from the ESP32's side they are the same
       * peripheral setup — the difference is what's on the other end.
       *
       * `sdIn` is left undefined so a graph with an `audio_in` node can be
       * warned about instead of silently reading a pin nothing drives, and
       * the MAX98357A has no MCLK pin at all (it recovers clock from BCLK).
       */
      case 'pcm5102a':
      case 'max98357a': {
        if (!dflt.i2s) break
        st.i2sCodec = {
          sck:   gpioNum(c.pins['sck'], dflt.i2s.sck),
          ws:    gpioNum(c.pins['ws'], dflt.i2s.ws),
          sdOut: gpioNum(c.pins['sd_out'], dflt.i2s.sdOut),
          mclk:  c.kind === 'pcm5102a' && c.pins['mclk']
            ? gpioNum(c.pins['mclk'], dflt.i2s.mclk)
            : undefined,
          canInput: false
        }
        break
      }
      case 'oled_ssd1306': {
        st.oled = {
          sda: gpioNum(c.pins['sda'], dflt.oled.sda),
          scl: gpioNum(c.pins['scl'], dflt.oled.scl),
          address: String(c.config['address'] ?? '0x3C')
        }
        break
      }
    }
  }
  return st
}

/**
 * One generator for every Espressif board — the profile carries whatever
 * differs (pio board name, PSRAM, USB stack, safe GPIO fallbacks).
 */
export function generateEsp32Project(
  profile: Esp32Profile,
  graph: AudioGraph,
  hardware: HardwareLayout = emptyHardwareLayout(profile.boardId),
  projectName?: string,
  options: GenerateOptions = {}
): GeneratedProject {
  const name = safeName(projectName ?? graph.meta.name ?? 'DaisypatcherPatch')
  const warnings: string[] = []
  const warn = (msg: string) => warnings.push(msg)

  for (const msg of validateGraph(graph)) warn(msg)

  /*
   * Menu leaves drive node params with no cable, so the scheduler needs an
   * edge it can see. `menuOrderingEdges` synthesizes one per menu -> target
   * pair on a socket id no emitter reads; it must come AFTER validateGraph,
   * whose socket check would otherwise flag it.
   */
  const connections = [...graph.connections, ...menuOrderingEdges(graph)]
  const paramOverrides = menuParamOverrides(graph, warn)
  /*
   * Presets write the SAME globals menu leaves do, so they merge into one
   * map before anything reads it. Menu entries win a collision because
   * they carry `menuVar`/`entryIndex` that the menu emitter needs; the
   * preset table only needs the variable name, which is identical either
   * way.
   */
  const presetOverrides = presetParamOverrides(graph, options.presets ?? [], warn)
  for (const [k, o] of presetOverrides) if (!paramOverrides.has(k)) paramOverrides.set(k, o)
  const presetTable = buildPresetTable(graph, options.presets ?? [], paramOverrides)

  /*
   * Samples become const arrays at file scope. Emitted BEFORE the node
   * loop because the player's `process` needs the variable name, and the
   * arrays have to precede any use in the file anyway.
   */
  const sampleEmission = emitSamples(graph, options.samples ?? {}, profile.boardId, warn)
  setSampleInfoEsp32(sampleEmission.byNode)
  if (presetTable.rows.length > 0 && !hasPresetDriver(graph)) {
    warn(
      `${presetTable.rows.length} preset(s) will be compiled in but nothing can fire them — ` +
        `add a Preset node and patch a trigger to it`
    )
  }
  const overrideExprs = overrideExprMap(paramOverrides)
  const reachedOverrides = makeOverrideAudit(paramOverrides, warn)

  const connIdx = buildConnectionIndex(connections)
  const { order } = topoSort(graph.nodes, connections, warn)

  const nodeById = new Map<string, NodeInstance>()
  for (const n of graph.nodes) nodeById.set(n.id, n)

  const hw = walkHardware(hardware, profile)

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

  const blocks: EmitBlock[] = []
  const declLines: string[] = [
    ...emitMenuParamGlobals(paramOverrides),
    // Must follow the globals — the slot table takes their addresses.
    ...emitPresetRuntime(presetTable),
    ...sampleEmission.declLines
  ]
  /*
   * Emitted at the top of Arduino's loop(), before render_block(). That is
   * this target's equivalent of the Daisy's while(1): a place for blocking
   * peripheral traffic that must never run inside the audio path. An I2C
   * sensor read is ~400 us and an audio block is 1 ms.
   */
  const nodeLoopLines: string[] = []
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
    /*
     * Board-capability gate.
     *
     * `supportLevel` drives the palette's dots and filter, but the palette
     * only governs what a user can DROP — it does nothing for a patch that
     * was saved on one board and opened on another, or re-targeted. Without
     * this check a granulator on a C3 still emits its EXT_RAM_ATTR buffer
     * (no PSRAM to put it in) and the MIDI kinds still emit <USBMIDI.h>
     * (no TinyUSB device stack on RISC-V). Both compile fine and then fail
     * at link time — as a raw PlatformIO error, which is the worst possible
     * place for the user to meet it.
     *
     * Substituting a passthrough keeps the rest of the patch working and
     * puts the explanation in the build log where it belongs.
     */
    if (supportLevel(node.kind, profile.boardId) === 'unsupported') {
      const why = `not available on ${profile.label}`
      warn(`${node.kind}: ${why} — emitted as passthrough`)
      const def = NODE_DEFINITIONS[node.kind]
      emitter = {
        declare: () => '',
        init: () => '',
        process: (c) => {
          if (!def) return ''
          const inSock = def.inputs[0]?.id
          const src = inSock ? c.inputExpr(c.node.id, inSock, '0.f') : '0.f'
          const lines = [`    // ${c.node.kind}: ${why}`]
          for (const out of def.outputs) {
            lines.push(`    float ${c.outputVar(c.node.id, out.id)} = ${src};`)
          }
          return lines.join('\n') + '\n'
        }
      }
    }
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
    // Record what this node contributed, so the code view can point at it.
    const note = (section: EmitSection, text: string | undefined): void => {
      if (text) blocks.push({ nodeId: node.id, kind: node.kind, section, text })
    }
    /*
     * `declare` runs with overrides OFF: a param used at file scope sizes a
     * buffer or seeds a constant and has to stay a compile-time literal.
     * Everything after it runs inside a function, where a global is fine.
     */
    setParamOverridesEsp32(null)
    const d = emitter.declare(c)
    if (d) declLines.push(`// ${node.kind} ${node.id}\n${d}`)
    note('declare', d)
    setParamOverridesEsp32(overrideExprs)
    const initSrc = emitter.init(c)
    if (initSrc) initLines.push(initSrc)
    note('init', initSrc)
    const p = emitter.process(c)
    if (p) processLines.push(p)
    // Outputs no cable reads: `(void)` them so -Wall stays quiet. Audio
    // outputs feeding the codec are consumed by the output stage, not by a
    // cable, so `audio_output` is exempt.
    if (p && node.kind !== 'audio_output') {
      const v = silenceUnusedOutputs(node, p, c.outputVar, (nid, sid) =>
        connIdx.consumedOutputs.has(`${nid}|${sid}`)
      )
      if (v) processLines.push(v)
    }
    note('process', p)
    const lp = emitter.loop?.(c)
    if (lp) nodeLoopLines.push(lp)
    note('loop', lp)
    setParamOverridesEsp32(null)

    reachedOverrides(node.id, `${initSrc}\n${p}`)
    auditOutputDecls(node, p, c.outputVar, warn)
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
    const g = gpioNum(pin, profile.defaults.led)
    const varBase = `${nodeVar(n.id, 'led')}_val`
    pollLines.push(`    digitalWrite(${g}, (${varBase} > 0.5f) ? HIGH : LOW);`)
  }

  // Real I2S input: only pulled in when the graph actually reads it.
  // The legacy I2S driver (driver/i2s.h, the one this target emits) does
  // full-duplex master on a single port on the S3 — TX and RX share
  // BCLK/WS, so a codec wired to one bus gets both directions for free.
  const hasAudioIn = graph.nodes.some((n) => n.kind === 'audio_in')
  if (hasAudioIn) {
    if (!hw.i2sCodec) {
      warn('audio_in: no I2S codec component bound; RX uses default data-in pin GPIO39 (BCLK/WS shared with the output bus)')
    } else if (!hw.i2sCodec.canInput) {
      // A PCM5102A / MAX98357A physically cannot return audio. Without this
      // the generated project would configure RX on a fallback pin that
      // nothing drives, and the patch would run on silence with no clue why.
      warn('audio_in: the bound I2S device is output-only (PCM5102A / MAX98357A have no data-out line) — add a codec with an input, or remove the audio_in node')
    } else if (hw.i2sCodec.sdIn === hw.i2sCodec.sdOut) {
      warn(`audio_in: I2S codec sd_in and sd_out are both bound to GPIO${hw.i2sCodec.sdIn} — bind sd_in to its own pin`)
    }
  }

  const main = buildMainCpp({
    name,
    profile,
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
    nodeLoopLines,
    hasAudioIn,
    warnings
  })

  // Feature flags derived from the graph — drive platformio.ini lib_deps and
  // memory flags (PSRAM for granulator, Adafruit SSD1306 for OLED).
  const graphFeatures = {
    hasOled: graph.nodes.some((n) => n.kind === 'oled') || !!hw.oled,
    hasGranulator: graph.nodes.some((n) => n.kind === 'granulator'),
    hasTof: graph.nodes.some((n) => n.kind === 'distance_in'),
    hasMidi: graph.nodes.some((n) =>
      n.kind === 'midi_in_note' || n.kind === 'midi_in_cc' || n.kind === 'midi_out_note'
    )
  }
  const platformioIni = buildPlatformioIni(hw, graphFeatures, profile)
  const projectJson = JSON.stringify(graph, null, 2)

  return {
    projectName: name,
    files: {
      'platformio.ini': platformioIni,
      'src/main.cpp': main,
      'project.json': projectJson
    },
    warnings,
    provenance: buildProvenance('src/main.cpp', main, blocks)
  }
}

function buildPlatformioIni(
  hw: HwState,
  features: { hasOled: boolean; hasGranulator: boolean; hasMidi: boolean; hasTof: boolean },
  profile: Esp32Profile
): string {
  const libs: string[] = []
  if (hw.oled || features.hasOled) {
    libs.push('adafruit/Adafruit SSD1306 @ ^2.5.13')
    libs.push('adafruit/Adafruit GFX Library @ ^1.11.9')
  }
  // The VL53L0X init is a vendor tuning sequence, not a handful of register
  // writes — see the distance_in emitter. This is the one sensor that pulls
  // in a dependency instead of being written out.
  if (features.hasTof) libs.push('pololu/VL53L0X @ ^1.3.1')
  const libDeps = libs.length
    ? `lib_deps =\n    ${libs.join('\n    ')}\n`
    : ''
  // Granulator's 4-second capture buffer (~770 KB at 48 kHz fp32) doesn't fit
  // in DRAM; we place it in external PSRAM via EXT_RAM_ATTR. Enable the octal
  // PSRAM mapping so malloc/BSS in PSRAM is available. Gated on the profile:
  // emitting this for a board without PSRAM produces a config that looks
  // right and then fails to link.
  const psramBlock = features.hasGranulator && profile.hasPsram
    ? `board_build.arduino.memory_type = qio_opi\nboard_build.flash_mode = qio\nboard_upload.flash_size = 8MB\nboard_build.partitions = default_8MB.csv\n`
    : ''
  // USB MIDI needs the USB CDC / MODE flags already present; no extra libs
  // since USBMIDI ships in the Arduino-ESP32 core.
  const midiNote = features.hasMidi && profile.hasTinyUsbMidi
    ? '; USB MIDI: uses <USBMIDI.h> from arduino-esp32 core\n'
    : ''
  const buildFlags = profile.usbCdcOnBoot
    ? 'build_flags = -DARDUINO_USB_CDC_ON_BOOT=1 -DARDUINO_USB_MODE=1\n'
    : ''
  return `[env:${profile.pioBoard}]
platform = espressif32
board = ${profile.pioBoard}
framework = arduino
monitor_speed = 115200
${buildFlags}${psramBlock}${midiNote}${libDeps}`
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
  profile: Esp32Profile
  pollLines: string[]
  /** Node `loop` hooks — run once per block, outside the audio render. */
  nodeLoopLines: string[]
  /** Graph contains an `audio_in` node — emit the full-duplex RX path. */
  hasAudioIn: boolean
  warnings: string[]
}): string {
  const block = Math.max(1, args.blockSize | 0) || 64
  const sr = args.sampleRate > 0 ? args.sampleRate : 48000

  const warningsBlock = args.warnings.length
    ? `// Codegen warnings:\n${args.warnings.map((w) => `//   - ${w}`).join('\n')}\n`
    : ''

  // I2S pin config — either the bound codec's pins or sensible defaults.
  const codec = args.hw.i2sCodec
  // Fallbacks come from the board profile, not literals: GPIO 35-39 are
  // flash pins or absent on a C3, so guessing them there would emit a
  // project that compiles and then drives nothing.
  const i2sDflt = args.profile.defaults.i2s
  const pinBclk = codec?.sck ?? i2sDflt?.sck ?? 0
  const pinLrck = codec?.ws ?? i2sDflt?.ws ?? 0
  const pinDout = codec?.sdOut ?? i2sDflt?.sdOut ?? 0
  const pinMclk = codec?.mclk

  // Full-duplex RX (real line-in) — only emitted when the graph reads it.
  // The legacy driver runs TX+RX on one port in master mode with shared
  // BCLK/WS; RX only needs its own data-in GPIO. Default GPIO39 sits next
  // to the I2S cluster on the right header and is otherwise unclaimed.
  const duplex = args.hasAudioIn
  const pinDin = codec?.sdIn ?? i2sDflt?.sdIn ?? 0
  const inBufDecl = duplex ? `\nint16_t audio_in_buffer[${block} * 2];` : ''
  // Mirror of the output path's float→int conversion (out * 32767 clamped):
  // int16 → float via * (1/32767) so a full-scale loopback round-trips to
  // exactly ±1.0.
  const inputReadLines = duplex
    ? `        float in_l = (float)audio_in_buffer[i*2]     * (1.f / 32767.f);\n` +
      `        float in_r = (float)audio_in_buffer[i*2 + 1] * (1.f / 32767.f);`
    : `        float in_l = 0.f, in_r = 0.f;`
  const i2sSectionComment = duplex
    ? '// --- I2S audio (full-duplex master: TX out + RX in on one bus) ---'
    : '// --- I2S audio out ---'
  const i2sMode = duplex
    ? 'I2S_MODE_MASTER | I2S_MODE_TX | I2S_MODE_RX'
    : 'I2S_MODE_MASTER | I2S_MODE_TX'
  const dataInPin = duplex ? String(pinDin) : 'I2S_PIN_NO_CHANGE'
  const i2sReadBlock = duplex
    ? `    // --- Pull one block of stereo line-in (blocks until DMA delivers) ---\n` +
      `    size_t read_bytes = 0;\n` +
      `    i2s_read(I2S_PORT, audio_in_buffer, sizeof(audio_in_buffer), &read_bytes, portMAX_DELAY);\n\n`
    : ''

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

  return `// Auto-generated by Daisypatcher (${args.profile.label} target)
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

/*
 * DaisySP's SoftLimit/SoftClip, transliterated.
 *
 * ESP32 builds do not link DaisySP, so any emitter that needs to match a
 * DaisySP-shaped curve has to carry its own copy. Kept here rather than
 * inside one emitter's output because more than one node saturates, and
 * three private copies of the same polynomial is how the two targets
 * drifted apart in the first place.
 */
static inline float dp_soft_clip(float x) {
    if (x < -3.f) return -1.f;
    if (x > 3.f) return 1.f;
    return x * (27.f + x * x) / (27.f + 9.f * x * x);
}
int16_t audio_out_buffer[${block} * 2];${inBufDecl}

// --- Node declarations ---
${dedupeMenuBlocks(args.declLines.join('\n')) || '// (no nodes emitted members)'}

// --- Hardware state ---
${args.hwDecls.join('\n') || '// (no hardware components placed)'}

static inline void render_block() {
    for (int i = 0; i < BLOCK; i++) {
${inputReadLines}
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

    ${i2sSectionComment}
    i2s_config_t i2s_cfg = {
        .mode = (i2s_mode_t)(${i2sMode}),
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
        .data_in_num = ${dataInPin}
    };
${mclkBlock}    i2s_driver_install(I2S_PORT, &i2s_cfg, 0, nullptr);
    i2s_set_pin(I2S_PORT, &pin_cfg);
    i2s_set_clk(I2S_PORT, SAMPLE_RATE, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
}

void loop() {
    // --- Poll hardware (ADC + GPIO) ---
${hwPollLines.join('\n') || '    // (no hardware inputs)'}

    // --- Slow peripherals (I2C sensors etc). NEVER inside render_block(). ---
${args.nodeLoopLines.join('\n') || '    // (none)'}

    // --- Copy bound hardware values into per-node state ---
${args.pollLines.join('\n') || '    // (no bindings)'}

${i2sReadBlock}    // --- Render one audio block + push to I2S ---
    render_block();
    size_t written = 0;
    i2s_write(I2S_PORT, audio_out_buffer, sizeof(audio_out_buffer), &written, portMAX_DELAY);
}
`
}

/**
 * Build a TargetBackend for any Espressif board.
 *
 * The build/flash/toolchain half is genuinely identical across all of
 * them — `pio run` and `pio run --target upload` are MCU-agnostic, and
 * PlatformIO resolves the Xtensa-vs-RISC-V toolchain from `board =`
 * alone. Only `generate` and the artifact path vary, and both derive from
 * the profile.
 */
export function makeEsp32Target(profile: Esp32Profile): TargetBackend {
  return {
    id: profile.boardId,
    label: profile.label,
    shortLabel: profile.shortLabel,
    description: profile.description,
    generate: (graph, hardware, projectName, options) =>
      generateEsp32Project(profile, graph, hardware, projectName, options),
    buildCommand: () => ({
      bin: 'pio',
      args: ['run'],
      env: {}
    }),
    toolchainCheck: () => [
      { name: 'PlatformIO', command: 'pio', required: true, installHint: 'pip install platformio' },
      { name: 'Python 3', command: 'python3', required: true, installHint: 'install python3 (platform package manager)' }
    ],
    binaryArtifact: () => `.pio/build/${profile.pioBoard}/firmware.bin`,
    flashCommand: () => ({
      // PlatformIO handles port auto-detect + DTR/RTS bootloader entry.
      bin: 'pio',
      args: ['run', '--target', 'upload']
    }),
    artifactExtension: 'bin'
  }
}

export const esp32S3Target = makeEsp32Target(ESP32_PROFILES.esp32_s3_devkitc)
export const esp32C3SuperMiniTarget = makeEsp32Target(ESP32_PROFILES.esp32_c3_supermini)
export const esp32S3SuperMiniTarget = makeEsp32Target(ESP32_PROFILES.esp32_s3_supermini)

/** @deprecated Kept for callers that predate the multi-board factory. */
export function generateEsp32S3Project(
  graph: AudioGraph,
  hardware?: HardwareLayout,
  projectName?: string,
  options: GenerateOptions = {}
): GeneratedProject {
  return generateEsp32Project(ESP32_PROFILES.esp32_s3_devkitc, graph, hardware, projectName, options)
}
