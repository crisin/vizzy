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
  blend + beat-driven auto-switching) and nine 3D scenes (three.js):
  orb, terrain, tunnel, bars3d, gyro, procedural noise blob, nested
  cubes, blocky critters, and your own glTF/GLB/ZIP models with a
  thumbnail library (IndexedDB) and a bass/beat-driven explode effect.
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
and ten 3D scenes. The macOS capture backend (Core Audio process taps
via `objc2-core-audio`, `src-tauri/src/audio/mac.rs`) covers all three
source kinds. Next up: custom shader visualizations with a live code
editor.
