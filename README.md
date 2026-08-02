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
- Next: per-app capture (process loopback), settings persistence.
- macOS backend (Core Audio taps) not wired up yet.
