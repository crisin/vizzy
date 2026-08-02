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
- Next: beat detection (spectral flux) + preset auto-switching.
- macOS backend (Core Audio taps) not wired up yet.
