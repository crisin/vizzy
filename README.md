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
- **Preset library** (`L`): every Milkdrop preset as a card with a
  generated preview — a still, or a 12-frame clip that tells the same
  story for each preset (quiet → loud → drop → later → two tweak
  variants), so they compare at a glance. The selected or hovered preset
  runs live in a large tile on the side, fed the real audio; a variant
  frame can be tried there and applied with its tweaks. Previews render
  in the background while the library is open (a few ms per frame, so the
  main picture keeps running) and are cached in IndexedDB per preset
  content, so an edited preset gets a fresh one. Search covers name,
  author and tags; filters for favourites, curated, own, quarantined.
- **Tags**: free labels on presets, set in the library (Ctrl/Shift-click
  for many at once), live with `T` (a chip bar over the picture, `1`–`9`
  toggle) or in code (`src/milkdrop/tagSeeds.ts`, `tags` on curated
  presets — defaults the user's own tags override). Stored in `tags.json`
  in the app data directory. "Tags ▾" in the toolbar restricts ←/→,
  random and auto to presets with given tags (any/all). Three groups mean
  something to the auto-switch: energy (`ruhig`/`mittel`/`hoch`), song
  section (`intro`/`build`/`drop`/`break`/`outro`) and `nie-auto`. With
  "Auswahl nach Tags" on (Settings → Milkdrop), the auto-switch weights its
  draw towards presets whose energy matches the smoothed level of the
  track (adaptive, so a quiet album still spans all three) and whose
  section tag matches what just happened — energy jumping up at a section
  boundary asks for `drop`, falling for `break`, the first half minute
  after silence for `intro`. Recently played presets are pushed down. The
  debug HUD shows the level and why the last preset was chosen. The
  preview generator measures motion and brightness and offers an energy
  tag per preset as a dashed suggestion.
- **Trap-proof presets**: Butterchurn compiles preset equations to WASM,
  where a float→int conversion of NaN traps. A build-time patch
  (`vite.config.ts`) switches it to the saturating instruction, the way
  original Milkdrop behaves. A preset that still fails three times is
  quarantined (⛔) and left out of the rotation until picked by hand.
- **Layer B** (`B` in the toolbar, `Shift+B`, drawer tab "Layer"): a second
  Milkdrop preset on its own canvas over the first, mixed by blend mode and
  opacity. Each layer can listen to all, only the bass or only the highs
  (split on the waveform Butterchurn analyses); B has its own level and
  render scale and can follow the auto-switch one bar after A. A/B swap,
  and good mixes can be kept as named "Kombis" (`combos.json`).
- **Preset studio** (`P`, toolbar, or from the library): own presets are
  made of *parts* — base values, init/frame/pixel equations, warp and comp
  shaders, four waves, four shapes — each taken from any other preset or
  written inline. *Bausteine* builds mashups by picking parts (or rolling
  them); *Code* edits the EEL and shader text with live reload and shows
  compile errors, shader errors with line numbers included; *Remix* mutates
  (base values, optionally the decimal constants in the code) or crosses
  with a partner and probe-renders every child, dropping the ones that
  trap, stay black or flat; *KI* lets a local model (Ollama, LM Studio,
  llama.cpp — any OpenAI-compatible server) edit the draft from an
  instruction. Presets are JSON files in `<app data>/presets/`, polled, so
  an edited file reloads in place; each remembers its lineage, shown as a
  family tree in the library.
- **Breeding** (Settings → Milkdrop → Zucht-Anteil): the auto-switch now and
  then plays a fresh mutation of the preset it picked. `+` keeps a child as
  an own preset, `-` drops it and moves on; both also rate presets (−3..3),
  and the auto-switch favours what you rated up.
- **Dev bridge** (Settings → System): a token-protected HTTP endpoint on
  127.0.0.1 through which Claude Code (or any script) can preview a preset
  JSON — image plus compile errors —, play it, save it and read the log.
  See [docs/bridge.md](docs/bridge.md).
- **Milkdrop in 3D**: the playing preset as background behind any 3D scene,
  and inside the parallax and morph pictures as light, distortion or
  reflection — weighted by depth in the parallax scene, so the foreground
  can dance while the distance stays calm.
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

  Both axes are crossfades between opposed prompts (`ConditioningAverage`),
  never a weight scaled inside one sentence: measured against a real
  ComfyUI, a weight on a sub-phrase at a denoise low enough to keep the
  composition baked nine near-identical pictures.

  Two variant templates, switchable in the panel:

  | | Needs | Holds the frame | Per cell (RTX 5070) |
  |---|---|---|---|
  | **Qwen-Image-Edit 2511** (default) | UNET + CLIP + VAE + the 4-step Lightning LoRA | by construction | ~26 s |
  | **SDXL img2img** | one SDXL checkpoint | via a low `denoise` | ~12 s |

  The default is the heavier one on purpose: a bake runs once and is then
  played forever. img2img destroys the picture and rebuilds it from a
  prompt, so "low enough to keep the frame" fights "high enough to change
  the mood"; an edit model takes the picture as a *condition* and performs
  an instruction on it, so individual rocks in a river stay put while the
  light changes completely. Its two axes are a bilinear blend of four
  corner *instructions* — X across each row, then Y between the rows, which
  is what the morph shader does with the finished frames, one stage
  earlier. A depth map takes about a second either way.

  Two things to expect from the Qwen template. Its first two or three cells
  are much slower than the rest (68 s, 97 s, 272 s, then a steady 26 s on a
  12 GB card): the models load, and the four corner conditionings are
  computed once and then served from ComfyUI's cache, since only the blend
  weights change from cell to cell. And the blend is not perceptually
  linear — at `x = 0.5` the picture already sits close to the warm pole, so
  the cold end lives in roughly the first third of the axis. Widening the
  grid helps more than widening the range.

  Both defaults use core nodes only (ComfyUI 0.44+): depth is Depth
  Anything 3 and wants
  [its weights](https://huggingface.co/Comfy-Org/Depth-Anything-3) in
  `models/geometry_estimation/`; variants load an SDXL photo checkpoint by
  name (`DEFAULT_CHECKPOINT` in `src/comfy.ts`), and a name is all it is —
  point vizzy at a ComfyUI that has a different one and the workflow field
  in the panel is where you say so. `/object_info` on the server lists what
  it has. The HTTP work runs in Rust because ComfyUI serves no CORS headers
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

The full list lives in `src/keys.ts`; the in-app help (`?`) and the
tooltips are generated from it.

`1`–`6` modes · `←`/`→` preset/scene · `F` fullscreen · `H` presentation
mode (toolbar and cursor stay away, keys keep working; persists) · `I` info
overlay (song, picture, tempo) · `E` settings · `C` cockpit · `G` Regie ·
`D` debug HUD · `?` help · `Esc` closes panels only, never fullscreen.
Milkdrop: `R` random · `A` auto-switch · `S` favourite · `L` library · `P`
studio · `T` tag bar · `B` layer B on/off · `Shift+B` layer B settings ·
`Q` / `Shift+Q` / `N` queue add / clear / next · `+`/`-` rate.
Keys that open a panel also leave presentation mode.

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

Every build identifies itself under *Einstellungen → System → Über*:
`vizzy 0.1.0 · Build 37 · 97c3d7a · 06.11.2026, 21:41`. The build number is
the commit count, the hash gets `+dirty` when uncommitted changes went in,
and the dev server adds `· dev`. Vite bakes this in at build time, so commit
before `npm run release` if the line should name a clean commit. The version
lives in `package.json` **and** `src-tauri/tauri.conf.json`; the build
refuses to run if the two disagree.

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
