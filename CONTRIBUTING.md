# Contributing

Thanks for looking. Daisypatcher is in beta and small, which means a good bug report moves the project more than almost anything else.

## Reporting a bug

Open an issue with:

- **The `.dpatch` file** if the bug involves a patch. It is JSON, small, and contains no personal data beyond node names — attach it or paste it in a `<details>` block.
- Which **board** was selected, and whether the problem is in the app, in the build log, or on the device.
- OS and app version (**Help → About**).
- If the app crashed to the red screen, the **Error details** block from it — the **Report this** button pre-fills an issue with them.

"The device sounds different from the app" is a bug in its own class: attach the patch and say which node you suspect. Every kind is compared emulator-vs-firmware before release, so a difference means either a node drifted or a case the test does not drive.

## Working on the code

```bash
git clone https://github.com/willbearfruits/daisypatcher.git
cd daisypatcher
npm install
npm run dev
```

Node 22+. `npm run dev` builds the worklets, opens the app with HMR on the renderer, and pops DevTools. Main-process changes need a restart; renderer changes hot-reload; anything that touches Rete's imperative setup (`src/editor/ReteEditor.tsx`) needs a manual reload before you trust it.

**Read [`CLAUDE.md`](./CLAUDE.md) first.** It is written as instructions for an AI pair-programmer, and it is also the most honest map of the codebase there is: the three-process layout, the two data models, the checklist for adding a node, and every gotcha that has bitten before.

### The gate

```bash
npm run test
```

runs typecheck (main + renderer), the codegen snapshots (every fixture × every board), the cross-target emitter contract, and the behavioural feature tests. CI runs the same on every push. A PR that goes red there will not be merged; a PR that changes generated code on purpose re-runs `npm run test:codegen -- --update` and includes the snapshot diff.

Two more layers exist and are worth running for anything that touches an emitter or a worklet:

```bash
npm run test:compile -- --only <kind>   # real make / pio run for the four boards
npm run test:audio -- --only <kind>     # emulator vs compiled firmware, waveform compared
```

Both need the toolchains (`arm-none-eabi-gcc`, `pio`) and the libDaisy/DaisySP clones the app installs on first run.

### Adding a node kind

The classic first contribution. Six or seven files, all listed under **Node catalog assembled from partials** in `CLAUDE.md`: the `NodeKind` union, a definition, a worklet, a registry line, an emitter per target, and (only if it is not fully supported somewhere) a line in `targetSupport.ts`. Then `npm run test` and `npm run test:audio -- --only <kind>`. If the two sides do not agree the PR is not done — that agreement is the product.

### Style

- Tokens only: colours, spacing, radii and motion come from `var(--dp-*)`. A hard-coded hex in a component is a bug.
- No UI libraries, no emoji in the UI (inline SVG icons, 1.5px stroke, `currentColor`).
- Comments explain *why*, not what. The codebase leans on them heavily; keep the density of the file you are in.
- Commit messages describe the change and, when it is not obvious, the reason. Small commits over one big one.

### Scope

Before starting on a feature, open an issue or read [`ROADMAP.md`](./ROADMAP.md) — it says what is planned, in what order, and why. Note in particular that **runtime-loadable custom nodes (`.dpnode`) are the intended way for the catalogue to grow**: a custom node is a Code-node source plus metadata, needs no rebuild and no TypeScript, and cannot drift between emulator and firmware because both come from one parse. If you are about to hand-write a node kind in seven files, check whether it should be a `.dpnode` instead. Also look at [`V2_PLAN.md`](./V2_PLAN.md) — some things are deliberately not done yet, and a few (having the assistant write C++, per-instance sockets on the Code node, eval in the renderer) are deliberately not done at all. The reasoning is in `CLAUDE.md`.

## License

By contributing you agree that your contribution is licensed under the project's [AGPL-3.0-or-later](./LICENSE).
