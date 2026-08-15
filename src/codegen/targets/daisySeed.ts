/**
 * Daisy Seed target backend. This is the original `generateProject`
 * implementation moved inside the TargetBackend shape. Output shape and
 * emitted C++ are unchanged — existing patches compile exactly as
 * before.
 */
import type { AudioGraph, NodeInstance, NodeKind } from '@/types/graph'
import type { HardwareLayout } from '@/types/hardware'
import { emptyHardwareLayout } from '@/types/hardware'
import { NODE_DEFINITIONS } from '@/nodes/definitions'
import {
  NODE_EMITTERS,
  setParamOverrides,
  setSampleInfo,
  type EmitContext,
  type NodeEmitter
} from '../nodeEmitters'
import { emitHardwareInit, emitHardwarePoll } from '../hardwareBindings'
import {
  dedupeMenuBlocks,
  emitMenuParamGlobals,
  makeOverrideAudit,
  menuOrderingEdges,
  menuParamOverrides,
  overrideExprMap
} from '../menuCodegen'
import { analogRoleFor } from '@/types/hardware'
import {
  buildConnectionIndex,
  nodeVar,
  safeName,
  targetKey,
  auditOutputDecls,
  topoSort,
  validateGraph
} from '../graphWalk'
import type { GenerateOptions, GeneratedProject } from '../generateProject'
import { emitSamples } from '../sampleCodegen'
import {
  buildPresetTable,
  emitPresetRuntime,
  hasPresetDriver,
  presetParamOverrides
} from '../presetCodegen'
import { buildProvenance, type EmitBlock, type EmitSection } from '../provenance'
import type { DaisyFlashMode } from '@/types/store'
import type { TargetBackend } from './index'

/**
 * Flash-mode → `APP_TYPE` mapping. Names match libDaisy's
 * `core/Makefile` which branches on `$(APP_TYPE)` to pick
 * between `STM32H750IB_flash.lds`, `STM32H750IB_qspi.lds`, and
 * `STM32H750IB_sram.lds`.
 */
const APP_TYPE_BY_MODE: Record<DaisyFlashMode, string> = {
  internal: 'BOOT_NONE',
  qspi: 'BOOT_QSPI',
  sram: 'BOOT_SRAM'
}

function knobChannel(node: NodeInstance, warn: (msg: string) => void): number {
  const raw = node.params.channel
  const asNum = typeof raw === 'string' ? parseInt(raw, 10) - 1 : typeof raw === 'number' ? raw : 0
  if (asNum > 5) {
    warn(`knob_in ${node.id} channel ${asNum} exceeds Seed ADC (0-5); clamped to 5`)
    return 5
  }
  if (asNum < 0) return 0
  return asNum | 0
}

export function generateDaisySeedProject(
  graph: AudioGraph,
  hardware: HardwareLayout = emptyHardwareLayout('daisy_seed'),
  projectName?: string,
  options: GenerateOptions = {}
): GeneratedProject {
  // Default to QSPI — safe for factory-default Seeds with the Daisy
  // Bootloader installed. A caller that cares picks via options.
  const flashMode: DaisyFlashMode = options.daisyFlashMode ?? 'qspi'
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
  const sampleEmission = emitSamples(graph, options.samples ?? {}, 'daisy_seed', warn)
  setSampleInfo(sampleEmission.byNode)
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
  const initLines: string[] = []
  const processLines: string[] = []
  // Emitted inside main()'s while(1) — slow-peripheral servicing (OLED
  // refresh etc.). See NodeEmitter.loop.
  const loopLines: string[] = []

  const outputNode = graph.nodes.find((n) => n.kind === 'audio_output')
  const knobs: { node: NodeInstance; channel: number }[] = []

  for (const id of order) {
    const node = nodeById.get(id)
    if (!node) continue
    let emitter: NodeEmitter | undefined = NODE_EMITTERS[node.kind]
    if (!emitter) {
      warn(`no emitter for ${node.kind}; passthrough stub`)
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
    setParamOverrides(null)
    const d = emitter.declare(c)
    if (d) declLines.push(`// ${node.kind} ${node.id}\n${d}`)
    note('declare', d)
    setParamOverrides(overrideExprs)
    const initSrc = emitter.init(c)
    if (initSrc) initLines.push(initSrc)
    note('init', initSrc)
    const p = emitter.process(c)
    if (p) processLines.push(p)
    note('process', p)
    const l = emitter.loop?.(c)
    if (l) loopLines.push(l)
    note('loop', l)
    setParamOverrides(null)

    reachedOverrides(node.id, `${initSrc}\n${p}`)
    auditOutputDecls(node, p, c.outputVar, warn)

    if (node.kind === 'knob_in') {
      knobs.push({ node, channel: knobChannel(node, warn) })
    }
  }

  // audio_output wiring
  let leftExpr = '0.f'
  let rightExpr = '0.f'
  if (outputNode) {
    const c = ctx(outputNode)
    leftExpr = c.inputExpr(outputNode.id, 'left', '0.f')
    const rawRight = c.inputExpr(outputNode.id, 'right', '__NO_RIGHT__')
    rightExpr = rawRight === '__NO_RIGHT__' ? leftExpr : rawRight
  }

  const hwOut = emitHardwareInit(hardware)
  const hwPoll = emitHardwarePoll(hardware)
  if (hwOut.decls) declLines.push(`// Hardware layout\n${hwOut.decls}`)

  /*
   * Does the layout drive the ADC itself? If so the legacy channel-based
   * bank below must NOT be emitted — a second `hw.adc.Init()` silently
   * overwrites the first, so the hardware-bound pin map would be replaced
   * by the sequential 15+N one and every knob would read the wrong pin.
   *
   * This used to test only pot + cv_jack, so a layout whose analog inputs
   * were sliders or ribbons emitted BOTH banks.
   */
  const anyHwBoundAdc = hardware.components.some((c) => {
    const role = analogRoleFor(c.kind)
    return role !== null && Boolean(c.pins[role])
  })

  let knobInit = ''
  let knobPoll = ''
  if (!anyHwBoundAdc && knobs.length > 0) {
    const maxCh = Math.max(...knobs.map((k) => k.channel))
    const nChannels = Math.min(6, maxCh + 1)
    const pinLines: string[] = []
    for (let i = 0; i < nChannels; i++) {
      pinLines.push(`    adc_cfg[${i}].InitSingle(hw.GetPin(15 + ${i}));`)
    }
    knobInit =
      `    AdcChannelConfig adc_cfg[${nChannels}];\n` +
      pinLines.join('\n') +
      `\n    hw.adc.Init(adc_cfg, ${nChannels});\n    hw.adc.Start();`
    const pollLines = knobs.map(
      (k) =>
        `        ${nodeVar(k.node.id, 'knob_in')}_val = hw.adc.GetFloat(${k.channel});`
    )
    knobPoll = pollLines.join('\n')
  }

  const combinedInit = [hwOut.initCode, knobInit].filter(Boolean).join('\n\n')
  const combinedPoll = [hwPoll, knobPoll, ...loopLines].filter(Boolean).join('\n')

  const mainCpp = buildMainCpp({
    name,
    projectDisplayName: graph.meta.name,
    blockSize: graph.meta.blockSize,
    declLines,
    initLines,
    processLines,
    leftExpr,
    rightExpr,
    knobInit: combinedInit,
    knobPoll: combinedPoll,
    warnings
  })

  const makefile = buildMakefile(name, flashMode)
  const projectJson = JSON.stringify(graph, null, 2)

  return {
    projectName: name,
    files: {
      'main.cpp': mainCpp,
      Makefile: makefile,
      'project.json': projectJson
    },
    warnings,
    provenance: buildProvenance('main.cpp', mainCpp, blocks)
  }
}

function buildMainCpp(args: {
  name: string
  projectDisplayName: string
  blockSize: number
  declLines: string[]
  initLines: string[]
  processLines: string[]
  leftExpr: string
  rightExpr: string
  knobInit: string
  knobPoll: string
  warnings: string[]
}): string {
  const warningsBlock = args.warnings.length
    ? `// Codegen warnings:\n${args.warnings.map((w) => `//   - ${w}`).join('\n')}\n`
    : ''

  return `// Auto-generated by Daisypatcher
// Patch: ${args.projectDisplayName}
// Target: ${args.name}
// DO NOT EDIT — regenerate from the .dpatch file
${warningsBlock}
#include "daisy_seed.h"
#include "daisysp.h"
#include <cmath>
#include <cstdlib>

using namespace daisy;
using namespace daisysp;

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Maximum delay-line length (samples). Enough for 2s at 48kHz.
static constexpr size_t CODEGEN_MAX_DELAY = static_cast<size_t>(48000 * 2);

DaisySeed hw;

// --- Node declarations ---
${dedupeMenuBlocks(args.declLines.join('\n')) || '// (no nodes emitted members)'}

void AudioCallback(AudioHandle::InputBuffer in,
                   AudioHandle::OutputBuffer out,
                   size_t size) {
    float sr = hw.AudioSampleRate();
    for (size_t i = 0; i < size; i++) {
        float in_l = in[0][i];
        float in_r = in[1][i];
        (void)in_l; (void)in_r; (void)sr;

${args.processLines.join('\n')}
        float out_l = ${args.leftExpr};
        float out_r = ${args.rightExpr};
        out[0][i] = out_l;
        out[1][i] = out_r;
    }
}

int main(void) {
    // boost=true moves the H7 to 480MHz so the SAI MCLK ratio lands cleanly
    // on the AK4556's expected bit-clock. Without it the codec DAC can end
    // up silent or VERY quiet even though the callback runs — validated
    // with an LED-in-callback test on 2026-04-21.
    hw.Init(true);
    hw.SetAudioBlockSize(${Math.max(1, args.blockSize | 0) || 48});
    float sr = hw.AudioSampleRate();
    (void)sr;

${args.initLines.join('\n')}

${args.knobInit}

    hw.StartAudio(AudioCallback);

    while (1) {
${args.knobPoll}
        System::Delay(1);
    }
}
`
}

function buildMakefile(name: string, flashMode: DaisyFlashMode): string {
  const appType = APP_TYPE_BY_MODE[flashMode]
  // APP_TYPE selects the linker script libDaisy's core Makefile will
  // emit. BOOT_NONE → internal flash @0x08000000, BOOT_QSPI → QSPI
  // flash @0x90040000 (Daisy Bootloader), BOOT_SRAM → SRAM @0x24000000.
  return `# Auto-generated by Daisypatcher — regenerate, do not edit.
TARGET = ${name}

# Flash mode: ${flashMode}
APP_TYPE = ${appType}

CPP_SOURCES = main.cpp

# ReverbSc, MoogLadder and friends require the LGPL portion of DaisySP.
USE_DAISYSP_LGPL = 1

OPT = -O2

# LIBDAISY_DIR and DAISYSP_DIR are supplied by the build service; do not set here.
SYSTEM_FILES_DIR = $(LIBDAISY_DIR)/core
include $(SYSTEM_FILES_DIR)/Makefile
`
}

export const daisySeedTarget: TargetBackend = {
  id: 'daisy_seed',
  label: 'Daisy Seed',
  shortLabel: 'SEED',
  description: 'Electro-Smith Daisy Seed (STM32H7, libDaisy + DaisySP)',
  generate: generateDaisySeedProject,
  buildCommand: () => ({
    bin: 'make',
    args: [],
    // LIBDAISY_DIR / DAISYSP_DIR are populated by the build service at
    // spawn time from the SDK paths; leaving this empty keeps the target
    // backend pure (no Electron-main imports).
    env: {}
  }),
  toolchainCheck: () => [
    { name: 'arm-none-eabi-gcc', command: 'arm-none-eabi-gcc', required: true, installHint: 'install gcc-arm-none-eabi (apt / brew)' },
    { name: 'make', command: 'make', required: true, installHint: 'install make (apt / brew)' },
    { name: 'dfu-util', command: 'dfu-util', required: true, installHint: 'install dfu-util (apt / brew)' }
  ],
  binaryArtifact: (name) => `build/${name}.bin`,
  flashCommand: (binaryPath) => ({
    bin: 'dfu-util',
    args: ['-a', '0', '-i', '0', '-s', '0x08000000:leave', '-D', binaryPath]
  }),
  artifactExtension: 'bin'
}
