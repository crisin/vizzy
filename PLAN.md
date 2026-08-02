# vizzy — Projektplan

Cross-platform Audio-Visualizer für Windows und macOS.
Quellenauswahl (System-Audio, einzelne Apps, Mikrofon/Line-In), Visuals von Waveform/EQ-Bars
über Milkdrop-Presets bis zu 3D-Szenen — langfristig mit eingebautem Editor für eigene Visualizations.

## Entscheidungen (Stand: 2026-08-02)

| Thema | Entscheidung |
|---|---|
| Stack | **Tauri 2**: Rust-Core (Audio-Capture + DSP) + Web-Frontend (TypeScript, Three.js/WebGL2) |
| Milkdrop-Presets | **Ja, früh** — via Butterchurn (MIT, vom Original-Autor wieder aktiv gepflegt) |
| Audio-Quellen | System-Loopback, per-App-Capture, Mikrofon/Line-In |
| Plattform-Floor | Windows 10 2004+ (per-App offiziell ab Build 20348), macOS 14.4+ |
| Mac-Entwicklung | Mac regelmäßig verfügbar → beide OS von Anfang an mitentwickeln |

## Architektur

```
┌─────────────────────────────────────────────────────┐
│ Frontend (TypeScript + Vite + React)                │
│  • Source-Picker, Settings, Preset-Browser          │
│  • Visualization-Host mit Plugin-Interface          │
│     - Builtins: Waveform, EQ-Bars, Radial, 3D       │
│     - Butterchurn-Wrapper (Milkdrop-Presets)        │
│     - später: Editor-Visuals (Shader/Nodes)         │
└──────────────▲──────────────────────────────────────┘
               │ Tauri IPC-Channel (binäre AnalysisFrames, ~60 Hz)
┌──────────────┴──────────────────────────────────────┐
│ Rust-Core (src-tauri + crate vizzy-core)            │
│  • AudioSource-Trait: SystemLoopback | AppCapture   │
│    | InputDevice                                    │
│     - Windows: `wasapi`-Crate (Device- +            │
│       Process-Loopback)                             │
│     - macOS: `cidre` (Core Audio Taps, System +     │
│       per-App)                                      │
│     - Mic/Line-In: `cpal`                           │
│  • DSP: FFT (realfft), Band-Aggregation, RMS/Peak,  │
│    Beat-/Onset-Detection (Spectral Flux)            │
│  • AnalysisFrame: Waveform-Ausschnitt + FFT-Bins +  │
│    Features → kompakt (~4–8 KB) ans Frontend        │
└─────────────────────────────────────────────────────┘
```

Grundsatz: **FFT/Analyse in Rust**, Frontend bekommt fertige, kompakte Frames.
Visualization-Manifest-Format (Name, Typ, Parameter) ab Tag 1 — das ist später das Fundament des Editors.

## Phasen

### Phase 0 — Pipeline-Spike (~1 Woche)
Ziel: beweisen, dass die Kette steht. Kein Feinschliff.
- Rust-Toolchain installieren, Tauri-2-Skeleton aufsetzen
- Windows: WASAPI-Loopback → FFT → EQ-Bars auf Canvas
- macOS: Core-Audio-Tap-Capture via `cidre` verifizieren (inkl. TCC-Prompt "System Audio Recording Only" — braucht stabile Code-Signing-Identität!)
- Latenz + IPC-Durchsatz messen (Ziel: 60 fps stabil, gefühlte Latenz < 50 ms)

### Phase 1 — MVP
- Source-Picker: System-Audio + Eingabegeräte (Mic/Line-In), Gerätewechsel zur Laufzeit
- Visuals: Waveform, EQ-Bars, Radial-Spectrum — mit Farbschemata
- Fullscreen-Modus, FPS-Overlay, Settings-Persistenz
- Umgang mit Stille (WASAPI liefert bei Stille keine Pakete → Decay/Keepalive)

### Phase 2 — Milkdrop / Butterchurn
- Butterchurn (3.x) als Visualization-Typ einbetten, Preset-Browser
- Beat-gesteuertes Auto-Switching + Crossfade zwischen Presets
- Kuratierte Preset-Auswahl (Achtung: Lizenzlage der Community-Presets vor Redistribution prüfen)
- WKWebView-WebGL2-Performance auf dem Mac verifizieren

### Phase 3 — Per-App-Capture
- Windows: Process-Loopback (`wasapi`-Crate: `new_application_loopback_client`), Include-/Exclude-Tree
- macOS: per-App-Taps via `cidre` (`CATapDescription` mit PID-Mixdown)
- UI: laufende Apps mit Icons listen, Quelle per Klick

### Phase 4 — 3D-Visuals
- Three.js-Szenen als Visualization-Typ (WebGL2, später optional WebGPU)
- Audio-Mapping-System: Bänder/Features → Szenen-Parameter (Uniforms), deklarativ im Manifest
- 2–3 Hero-Szenen: Partikelfeld, audio-reaktives Terrain, Geometrie-Morphing

### Phase 5 — Editor
- Shader-Editor (GLSL-Fragment, an ISF angelehnt — MIT-Spec, fertige Renderer existieren) mit Monaco + Live-Preview
- Parameter-Binding-UI (Feature → Uniform), Speichern/Teilen im Manifest-Format
- Später evaluieren: Node-basierter Editor (Referenz: cables.gl, MIT)

### Laufend
- CI: GitHub Actions Builds für Windows + macOS
- Packaging/Signing (macOS notarization; ohne stabile Signatur kein Audio-TCC-Prompt!)

## Risiken & offene Punkte
- **macOS-Permission**: kein öffentliches API zum Abfragen/Anfordern der Audio-Capture-Berechtigung; Prompt kommt implizit beim ersten Tap. Früh auf echtem Mac testen.
- **Tauri-IPC-Durchsatz**: mit Analysis-Frames unkritisch; falls doch eng → WebSocket/Custom-Protocol als Fallback.
- **Butterchurn 3.x ist Beta** (stabil ist 2.6.7 von 2019) — beide Versionen im Spike testen.
- **cpal kann macOS-Loopback erst ab macOS >14.6** und nur System-Mix → deshalb `cidre` als primärer macOS-Pfad.
- Preset-/Shader-Lizenzen: Shadertoy-Default ist CC BY-NC-SA (nicht bundlebar); Butterchurn-Presets ungeklärt → nur geprüfte Sets ausliefern.

## Recherche-Referenzen
- projectM (LGPL, C-API, sehr aktiv): https://github.com/projectM-visualizer/projectm — Alternative/Ergänzung zu Butterchurn, falls wir nativ rendern wollen
- Butterchurn (MIT): https://github.com/jberg/butterchurn — Integration-Referenz: Webamp
- Windows Process-Loopback: https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/
- macOS Core Audio Taps: https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps — Beispiel: https://github.com/insidegui/AudioCap
- Rust-Crates: `wasapi` (HEnquist), `cidre`, `cpal`, `realfft`
- Editor-Studienobjekte: cables.gl (MIT, node-based), Astrofox (MIT, Layer-Editor), ISF-Spec (MIT)
