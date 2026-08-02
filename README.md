# vizzy

Cross-platform audio visualizer (Windows + macOS): Tauri 2, Rust core for
audio capture + DSP, web frontend for rendering.

See [PLAN.md](PLAN.md) for the roadmap.

## Dev

```
npm install
npm run tauri dev
```

`npm run dev` alone starts the frontend in a plain browser with animated
demo data (no audio capture).

## Status

- Phase 0/1 done: WASAPI capture (loopback + inputs, runtime source
  switching), FFT analysis, viz modes bars / radial / scope, fullscreen.
- Phase 2 done: Milkdrop presets via Butterchurn (107 base presets,
  browser + blend transitions), fed directly from the Rust analysis
  frames (no Web Audio).
- Beat detection (bass-weighted spectral flux, adaptive threshold) in the
  Rust analyzer; visuals pulse on beats, Milkdrop can auto-switch presets
  on beats ("auto" toggle / key A, 30s cooldown).
- 3D mode (three.js, key 5): "orb" particle sphere and "terrain"
  spectrogram mountains, scene switch with arrow keys.
- Per-app capture (Windows process loopback): pick a single app (e.g.
  Spotify) from the source dropdown; list refreshes on open.
- Settings persist across restarts (localStorage): mode, 3D scene,
  Milkdrop preset, auto-switch, and source (apps re-matched by process
  name since PIDs change).
- Parameter editor (key E / gear icon): every visualization declares its
  tunable parameters as a schema, the panel renders them generically —
  audio sensitivity/attack/release, beat threshold (live into the Rust
  analyzer), plus per-viz controls. Values persist. This schema system
  is the foundation for the future custom-visualization editor.
- Seven 3D scenes: orb, terrain, tunnel, bars3d, gyro, blob (procedural
  noise displacement) and model (load your own glTF/GLB — persisted in
  IndexedDB and restored on startup).
- Global reset in the editor panel (two-step confirm) wipes settings,
  parameters and the stored model.
- macOS backend (Core Audio taps) not wired up yet.
