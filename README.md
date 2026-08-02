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

Phase 0: WASAPI loopback capture (default render device) → FFT →
EQ bars + waveform. macOS backend (Core Audio taps) not wired up yet.
