# vizzy

Audio visualizer for Windows and macOS: Tauri 2, Rust core for
audio capture + DSP, web frontend for rendering.

See [PLAN.md](PLAN.md) for the roadmap.

## Features

- **Sources**: system loopback (any output device), single apps
  (e.g. only Spotify — Windows process loopback / macOS process taps),
  mic/line-in. Auto-fallback when a device disappears.
- **Analysis** in Rust: FFT (64 log bands), beat detection
  (bass-weighted spectral flux, adaptive threshold), BPM estimation.
- **Modes**: bars, radial, scope, Milkdrop (107 Butterchurn presets with
  blend + beat-driven auto-switching) and thirteen 3D scenes (three.js):
  orb, terrain, tunnel, bars3d, gyro, procedural noise blob, nested
  cubes, blocky critters, surf, flora, parallax, morph, and your own
  glTF/GLB/ZIP models with a thumbnail library (IndexedDB) and a
  bass/beat-driven explode effect.
- **Parallax**: a still image unfolded into 2.5D by a depth map and then
  moved by the audio — bass breathes the relief open, the beat kicks the
  camera, the spectrum ripples bottom (bass) to top (treble) through the
  picture. Without a depth map the scene falls back to a crude depth
  guessed from the picture itself — usable, but visibly flatter. Images
  and depth maps persist in the same IndexedDB library.
- **Morph grid**: N variants of the *same* picture, treated as coordinates
  rather than as a sequence. The horizontal axis is timbre (spectral
  centroid), the vertical one is energy; the music moves a cursor across
  that surface and the picture is the blend of the four variants around
  it. Nothing loops, because there is no sequence to loop. Load the
  variants as a multi-selection (ordered by filename, so a ComfyUI batch
  lands in order) — bake them with the same seed and a varying
  prompt mix, so they share composition and differ in mood.
  Three blend modes: weighted mean, per-pixel dissolve, and brightest
  channel wins; both axes have their own gain and can be switched off.
- **ComfyUI bake** ("Backen ✨", in both scenes): vizzy hands the selected
  image to a locally running ComfyUI and keeps what comes back — one
  image becomes a parallax depth map, a batch becomes a morph set in
  output order. Address and workflows are editable in the panel; a
  workflow is ComfyUI's own API-format JSON with the placeholder
  `__VIZZY_INPUT_IMAGE__` where the input image goes, so whatever nodes
  you have can be swapped in. A variant bake runs the workflow once per
  grid cell with `__VIZZY_X__` and `__VIZZY_Y__` replaced by that cell's
  coordinates — as bare numbers, so they work inside a prompt
  (`(golden hour:__VIZZY_X__)`) or as a node input (`"denoise":
  "__VIZZY_Y__"`, quotes and all: they fall away with the token, so the
  node gets a number and the template still parses while you edit it).
  Grid size and the range of each axis are set in the panel. One run per
  cell rather than one batched run, because a batch shares its
  conditioning: its outputs differ only by noise, which gives a coherent
  but *unordered* set — and the grid's axes only mean something if the
  order does. Keep the seed in the workflow fixed so the variants share a
  composition.

  Each axis of the variant default crossfades between two opposed prompts
  (`ConditioningAverage`) instead of scaling a weight inside one sentence.
  Measured against a real ComfyUI: a weight on a sub-phrase, at a denoise
  low enough to keep the composition, baked nine near-identical pictures —
  interpolating whole conditionings moves the mood and still holds the
  frame. On an RTX 5070 a 3×3 grid of 1 MP SDXL cells takes about two
  minutes, a depth map about a second.

  Both defaults use core nodes only (ComfyUI 0.44+): depth is Depth
  Anything 3 and wants
  [its weights](https://huggingface.co/Comfy-Org/Depth-Anything-3) in
  `models/geometry_estimation/`; variants want a `ckpt_name` you actually
  have. The HTTP work runs in Rust because ComfyUI serves no CORS headers
  unless started with `--enable-cors-header`. The client has an opt-in test
  suite against a real server:
  `VIZZY_COMFY_URL=http://127.0.0.1:8188 cargo test --test comfy_live --
  --ignored` — it skips without the variable.
- **Mouse camera** in 3D (orbit/zoom/pan, double-click to reset),
  **parameter editor** for every visualization, toggleable BPM badge —
  everything persists across restarts, global reset included.
- **Rendering settings** (editor → "Rendering"): render resolution as %
  of native and an FPS limit — turn resolution down for smooth fullscreen
  Milkdrop on weak/integrated GPUs (retina fullscreen is 4× the pixels).

### Keys

`1`–`5` modes · `←`/`→` preset/scene · `R` random preset · `A` preset
auto-switch · `B` BPM badge · `D` debug HUD (fps, render sizes, IPC
latency, audio stats, recent errors) · `E` parameter editor ·
`F` fullscreen · `Esc` close/leave

## Dev

Prerequisites (once): [Node.js](https://nodejs.org) 20+ and
[Rust](https://rustup.rs) (stable).

- **Windows**: stable-msvc plus an MSVC linker — any Visual Studio
  2017+ install with C++ tools works, otherwise grab the
  [Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  with the "Desktop development with C++" workload.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).

```
npm install
npm run app
```

Handy scripts:

| Script | What it does |
|---|---|
| `npm run app` | desktop app in dev mode (hot reload + audio capture) |
| `npm run dev` | frontend only, plain browser with animated demo data |
| `npm run typecheck` | TypeScript check without building |
| `npm run release` | release build for the host platform |
| `npm run release:mac` | universal macOS build (Intel + Apple Silicon) |
| `npm run setup:mac` | one-time: install both Rust targets for universal builds |

## Release build (share it!)

```
npm run release
```

### Windows

Produces two artifacts:

| Artifact | Path | Use |
|---|---|---|
| Portable exe | `src-tauri\target\release\vizzy.exe` | Runs directly; needs the WebView2 runtime (preinstalled on Win 10/11) |
| **Installer** | `src-tauri\target\release\bundle\nsis\vizzy_0.1.0_x64-setup.exe` | **The file to share** — installs WebView2 automatically if missing |

### macOS

The plain build targets the host architecture; for **one DMG that runs
on Intel and Apple Silicon** build universal:

```
npm run setup:mac
npm run release:mac
```

(`setup:mac` is a one-time `rustup target add` for both architectures.)

| Artifact | Path |
|---|---|
| App bundle | `src-tauri/target/universal-apple-darwin/release/bundle/macos/vizzy.app` |
| **DMG** | `src-tauri/target/universal-apple-darwin/release/bundle/dmg/vizzy_0.1.0_universal.dmg` |

macOS specifics (config in `src-tauri/tauri.macos.conf.json`):

- Needs **macOS 14.2+** (Core Audio process taps). Mic/line-in capture
  would work on older versions, but the bundle sets 14.2 as minimum.
- On first system-audio capture macOS asks for permission
  (System Settings → Privacy & Security → Screen & System Audio
  Recording → System Audio Recording Only). Mic capture prompts
  separately.
- The build is ad-hoc signed with the hardened runtime and the
  `audio-input` entitlement (`src-tauri/Entitlements.plist`) — without
  that entitlement macOS silently delivers zeros instead of audio.
  Gatekeeper will still warn on other Macs until the app is signed
  with a Developer ID and notarized: right-click → Open on first run.

Notes:

- The Windows build is unsigned, so SmartScreen will warn on first
  run: "More info" → "Run anyway". Code signing can be added later.
- The frontend (incl. Milkdrop presets and the Draco decoder) is
  embedded into the binary — no extra files needed next to the exe.
- Version and product name live in `src-tauri/tauri.conf.json`.

## Status

Windows feature set is complete through the editor phase: parameter
editor, frequency listeners with a modulation matrix (route any Hz
range onto any effect parameter, ◎ button), Milkdrop preset tweaking
with saveable user presets (🎛 button), background layer compositing,
and thirteen 3D scenes. The macOS capture backend (Core Audio process taps
via `objc2-core-audio`, `src-tauri/src/audio/mac.rs`) covers all three
source kinds. Next up: custom shader visualizations with a live code
editor.
