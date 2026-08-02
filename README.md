# vizzy

Audio visualizer for Windows (macOS planned): Tauri 2, Rust core for
audio capture + DSP, web frontend for rendering.

See [PLAN.md](PLAN.md) for the roadmap.

## Features

- **Sources**: system loopback (any output device), single apps
  (Windows process loopback — e.g. only Spotify), mic/line-in.
  Auto-fallback when a device disappears.
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

### Keys

`1`–`5` modes · `←`/`→` preset/scene · `R` random preset · `A` preset
auto-switch · `B` BPM badge · `E` parameter editor · `F` fullscreen ·
`Esc` close/leave

## Dev

Prerequisites (once): [Node.js](https://nodejs.org) 20+,
[Rust](https://rustup.rs) (stable-msvc) and an MSVC linker — any
Visual Studio 2017+ install with C++ tools works, otherwise grab the
[Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the "Desktop development with C++" workload.

```
npm install
npm run tauri dev
```

`npm run dev` alone starts the frontend in a plain browser with animated
demo data (no audio capture).

## Release build (share it!)

```
npm run tauri build
```

Produces two artifacts:

| Artifact | Path | Use |
|---|---|---|
| Portable exe | `src-tauri\target\release\vizzy.exe` | Runs directly; needs the WebView2 runtime (preinstalled on Win 10/11) |
| **Installer** | `src-tauri\target\release\bundle\nsis\vizzy_0.1.0_x64-setup.exe` | **The file to share** — installs WebView2 automatically if missing |

Notes:

- The build is unsigned, so Windows SmartScreen will warn on first run:
  "More info" → "Run anyway". Code signing can be added later.
- The frontend (incl. Milkdrop presets and the Draco decoder) is
  embedded into the binary — no extra files needed next to the exe.
- Version and product name live in `src-tauri/tauri.conf.json`.

## Status

Windows feature set is complete through the editor phase: parameter
editor, frequency listeners with a modulation matrix (route any Hz
range onto any effect parameter, ◎ button), Milkdrop preset tweaking
with saveable user presets (🎛 button), background layer compositing,
and ten 3D scenes. Next up: custom shader visualizations with a live
code editor, and the macOS capture backend (Core Audio taps via
`cidre`).
