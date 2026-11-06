//! Audio capture + analysis.
//!
//! Windows: WASAPI via the `wasapi` crate. One code path covers both source
//! kinds — requesting `Direction::Capture` on a *render* device makes the
//! crate set `AUDCLNT_STREAMFLAGS_LOOPBACK` (system audio), on a *capture*
//! device it is a normal input (mic/line-in) stream.
//!
//! macOS: Core Audio process taps, see [`mac`]. Same three source kinds, but
//! system audio needs a tap plus an aggregate device rather than a flag on
//! the client.
//!
//! The analysis result is published as a flat f32 frame:
//! `[header[HEADER], bands[n_bands], wave[n_wave]]` — see [`HEADER`].
//!
//! On any other platform a silent stub keeps the pipeline alive.

use std::collections::VecDeque;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(target_os = "macos")]
mod mac;

pub const NUM_BANDS: usize = 64;
pub const WAVE_POINTS: usize = 1024; // matches Butterchurn's expected fftSize
const FFT_SIZE: usize = 2048;
const HOP: usize = 512; // ~94 analysis frames/s at 48 kHz
/// Rate the Windows client is configured for. macOS takes whatever rate the
/// tap or input device reports and hands it to [`Analyzer::new`] instead.
const SAMPLE_RATE: usize = 48000;
const F_MIN: f32 = 40.0;
const F_MAX: f32 = 16000.0;
const DB_FLOOR: f32 = 60.0;

pub type SharedAnalysis = Arc<Mutex<Vec<f32>>>;

/// Runtime-tunable analysis parameters (set from the frontend editor).
pub struct AnalysisParams {
    pub beat_sigma: f32,
}

impl Default for AnalysisParams {
    fn default() -> Self {
        Self { beat_sigma: 1.5 }
    }
}

pub type SharedParams = Arc<Mutex<AnalysisParams>>;

/// Which audio source to capture. `device_id: None` = default device.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceSpec {
    Loopback {
        device_id: Option<String>,
    },
    Input {
        device_id: Option<String>,
    },
    /// Per-app capture via the Windows process loopback API.
    App {
        pid: u32,
        #[serde(default)]
        name: String,
    },
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub kind: &'static str, // "loopback" | "input"
    pub is_default: bool,
}

/// A process that currently owns an audio session on some render device.
#[derive(Clone, Debug, serde::Serialize)]
pub struct AppInfo {
    pub pid: u32,
    pub name: String,
    pub active: bool, // at least one stream currently playing
}

/// Frame header layout:
/// `[rms, peak, n_bands, n_wave, beat, flux, bpm, bpm_conf,
///   beat_phase, beat_count, bar_phase, phrase_phase, section, grid_conf]`
///
/// Indices 0–7 are the raw per-hop analysis, 8–13 the musical position
/// tracked by [`crate::phrasing`]. Keep in sync with `HEADER` in `App.tsx`.
pub const HEADER: usize = 14;
const FLUX_HISTORY: usize = 188; // ~2 s of hops for the adaptive threshold
const BEAT_REFRACTORY_HOPS: usize = 11; // ~120 ms

pub fn empty_frame() -> Vec<f32> {
    let mut frame = vec![0.0f32; HEADER + NUM_BANDS + WAVE_POINTS];
    frame[2] = NUM_BANDS as f32;
    frame[3] = WAVE_POINTS as f32;
    frame
}

pub fn spawn_capture(shared: SharedAnalysis, rx: Receiver<SourceSpec>, params: SharedParams) {
    std::thread::Builder::new()
        .name("vizzy-audio".into())
        .spawn(move || {
            let mut spec = SourceSpec::Loopback { device_id: None };
            let mut failures = 0u32;
            loop {
                let started = std::time::Instant::now();
                match capture_loop(&shared, &spec, &rx, &params) {
                    Ok(Some(next)) => {
                        spec = next;
                        failures = 0;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        // A run that captured fine for a while before dying
                        // (device unplugged mid-play) is not a broken spec.
                        if started.elapsed() > Duration::from_secs(5) {
                            failures = 0;
                        }
                        failures += 1;
                        eprintln!("[vizzy-audio] capture error: {e}; waiting for retry/switch");

                        let is_default_loopback =
                            matches!(spec, SourceSpec::Loopback { device_id: None });
                        if failures >= 3 && !is_default_loopback {
                            eprintln!(
                                "[vizzy-audio] source keeps failing — falling back to default loopback"
                            );
                            spec = SourceSpec::Loopback { device_id: None };
                            failures = 0;
                            continue;
                        }

                        // Retry after a pause, unless a switch request
                        // arrives first.
                        if let Ok(next) = rx.recv_timeout(Duration::from_secs(2)) {
                            spec = next;
                            failures = 0;
                        }
                    }
                }
            }
        })
        .expect("failed to spawn audio thread");
}

struct Analyzer {
    fft: Arc<dyn realfft::RealToComplex<f32>>,
    window: Vec<f32>,
    win_sum: f32,
    ring: VecDeque<f32>,
    since_hop: usize,
    in_buf: Vec<f32>,
    spectrum: Vec<realfft::num_complex::Complex<f32>>,
    band_edges: Vec<usize>,
    sample_rate: usize,
    params: SharedParams,
    bands: Vec<f32>,
    prev_bands: Vec<f32>,
    prev_low_amp: f32,
    prev_full_amp: f32,
    flux_hist: VecDeque<f32>,
    beat_env: f32,
    hops_since_beat: usize,
    beats: u64,
    tempo: crate::tempo::Tempo,
    bpm: f32,
    bpm_conf: f32,
    phrasing: crate::phrasing::Phrasing,
    published: u64,
}

impl Analyzer {
    fn new(params: SharedParams, sample_rate: usize) -> Self {
        let sample_rate = if sample_rate == 0 { SAMPLE_RATE } else { sample_rate };
        let mut planner = realfft::RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let in_buf = fft.make_input_vec();
        let spectrum = fft.make_output_vec();

        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                let x = std::f32::consts::TAU * i as f32 / FFT_SIZE as f32;
                0.5 * (1.0 - x.cos())
            })
            .collect();
        let win_sum: f32 = window.iter().sum();

        // Log-spaced band edges as FFT bin indices, clamped to [1, N/2].
        let band_edges: Vec<usize> = (0..=NUM_BANDS)
            .map(|k| {
                let f = F_MIN * (F_MAX / F_MIN).powf(k as f32 / NUM_BANDS as f32);
                let bin = (f * FFT_SIZE as f32 / sample_rate as f32).round() as usize;
                bin.clamp(1, FFT_SIZE / 2)
            })
            .collect();

        Self {
            fft,
            window,
            win_sum,
            ring: VecDeque::with_capacity(FFT_SIZE),
            since_hop: 0,
            in_buf,
            spectrum,
            band_edges,
            sample_rate,
            params,
            bands: vec![0.0; NUM_BANDS],
            prev_bands: vec![0.0; NUM_BANDS],
            prev_low_amp: 0.0,
            prev_full_amp: 0.0,
            flux_hist: VecDeque::with_capacity(FLUX_HISTORY),
            beat_env: 0.0,
            hops_since_beat: 0,
            beats: 0,
            tempo: crate::tempo::Tempo::new(HOP as f32 / sample_rate as f32),
            bpm: 0.0,
            bpm_conf: 0.0,
            phrasing: crate::phrasing::Phrasing::new(NUM_BANDS),
            published: 0,
        }
    }

    fn push(&mut self, sample: f32) {
        if self.ring.len() == FFT_SIZE {
            self.ring.pop_front();
        }
        self.ring.push_back(sample);
        self.since_hop += 1;
    }

    fn maybe_publish(&mut self, shared: &SharedAnalysis) {
        if self.since_hop < HOP || self.ring.len() < FFT_SIZE {
            return;
        }
        self.since_hop = 0;

        for (dst, (s, w)) in self
            .in_buf
            .iter_mut()
            .zip(self.ring.iter().zip(self.window.iter()))
        {
            *dst = s * w;
        }
        if self.fft.process(&mut self.in_buf, &mut self.spectrum).is_err() {
            return;
        }

        let scale = 2.0 / self.win_sum;
        for b in 0..NUM_BANDS {
            let start = self.band_edges[b];
            let end = (self.band_edges[b + 1]).max(start + 1).min(FFT_SIZE / 2 + 1);
            let mut acc = 0.0f32;
            for c in &self.spectrum[start..end] {
                acc += c.norm();
            }
            let mag = (acc / (end - start) as f32) * scale;
            let db = 20.0 * (mag + 1e-7).log10();
            self.bands[b] = ((db + DB_FLOOR) / DB_FLOOR).clamp(0.0, 1.0);
        }

        let mut sq = 0.0f32;
        let mut peak = 0.0f32;
        for s in self.ring.iter() {
            sq += s * s;
            peak = peak.max(s.abs());
        }
        let rms = (sq / FFT_SIZE as f32).sqrt();

        // Spectral flux: bass-weighted positive band changes, thresholded
        // adaptively against the recent history (mean + 1.5σ).
        let mut flux = 0.0f32;
        for b in 0..NUM_BANDS {
            let d = self.bands[b] - self.prev_bands[b];
            if d > 0.0 {
                let weight = if b < 16 { 2.0 } else { 1.0 };
                flux += d * weight;
            }
            self.prev_bands[b] = self.bands[b];
        }

        // A second envelope for *where* the beat sits: the rise in low-end
        // amplitude (below ~180 Hz), plus a little of the full range so there
        // is still something to align to when the bass drops out. Unlike the
        // bands above this is linear, not dB — on a dB scale a quiet off-beat
        // bass note rises as far as the kick does and the two are a toss-up;
        // in amplitude the kick is plainly the bigger event.
        let low_end = self.band_edges[16].min(FFT_SIZE / 2);
        let amp = |bins: &[realfft::num_complex::Complex<f32>]| {
            bins.iter().map(|c| c.norm()).sum::<f32>() * scale
        };
        let low_amp = amp(&self.spectrum[1..low_end]);
        let full_amp = low_amp + amp(&self.spectrum[low_end..]);
        let kick_flux = (low_amp - self.prev_low_amp).max(0.0)
            + 0.1 * (full_amp - self.prev_full_amp).max(0.0);
        self.prev_low_amp = low_amp;
        self.prev_full_amp = full_amp;
        if self.flux_hist.len() == FLUX_HISTORY {
            self.flux_hist.pop_front();
        }
        self.flux_hist.push_back(flux);
        let n = self.flux_hist.len() as f32;
        let mean = self.flux_hist.iter().sum::<f32>() / n;
        let var = self.flux_hist.iter().map(|f| (f - mean).powi(2)).sum::<f32>() / n;
        let std = var.sqrt();

        let sigma = self.params.lock().map(|p| p.beat_sigma).unwrap_or(1.5);
        self.hops_since_beat += 1;
        let now_s = self.published as f32 * HOP as f32 / self.sample_rate as f32;
        let hop_s = HOP as f32 / self.sample_rate as f32;
        // Tempo and beat position come from the envelope as a whole, a few
        // times a second; the grid follows them.
        if let Some(e) = self.tempo.push(flux, kick_flux) {
            let instant = 60.0 / e.period;
            // smoothing is for the readout only — the grid gets the raw value
            self.bpm = if self.bpm > 0.0 && (self.bpm / instant).ln().abs() < 0.04 {
                self.bpm * 0.7 + instant * 0.3
            } else {
                instant
            };
            self.bpm_conf = e.conf;
            self.phrasing.on_tempo(now_s, e.period, e.beat_age, e.conf);
        }
        let is_beat = self.flux_hist.len() > 20
            && flux > mean + sigma * std
            && flux > 0.05
            && self.hops_since_beat > BEAT_REFRACTORY_HOPS;
        if is_beat {
            self.beat_env = 1.0;
            self.hops_since_beat = 0;
            self.beats += 1;
            self.phrasing.on_onset(now_s, flux);
        } else {
            self.beat_env *= 0.88;
        }
        self.phrasing.advance(now_s, hop_s, &self.bands);
        let flux_norm = if std > 1e-6 {
            ((flux - mean) / (3.0 * std)).clamp(0.0, 1.0)
        } else {
            0.0
        };

        self.published += 1;
        if cfg!(not(test)) && self.published % 470 == 0 {
            // ~every 5 s at 94 frames/s
            eprintln!(
                "[vizzy-audio] frames={} rms={rms:.4} peak={peak:.4} beats={} bpm={:.1} conf={:.2} grid={:.2}",
                self.published,
                self.beats,
                self.bpm,
                self.bpm_conf,
                self.phrasing.grid_conf()
            );
        }

        let mut frame = shared.lock().unwrap();
        frame[0] = rms;
        frame[1] = peak;
        frame[4] = self.beat_env;
        frame[5] = flux_norm;
        frame[6] = self.bpm;
        frame[7] = self.bpm_conf;
        frame[8] = self.phrasing.beat_phase();
        frame[9] = self.phrasing.beat_count();
        frame[10] = self.phrasing.bar_phase();
        frame[11] = self.phrasing.phrase_phase();
        frame[12] = self.phrasing.section();
        frame[13] = self.phrasing.grid_conf();
        for (i, b) in self.bands.iter().enumerate() {
            frame[HEADER + i] = *b;
        }
        for (i, s) in self.ring.iter().skip(FFT_SIZE - WAVE_POINTS).enumerate() {
            frame[HEADER + NUM_BANDS + i] = *s;
        }
    }

    /// Called when no audio arrives (loopback delivers nothing during
    /// silence): let the published bands fall toward zero.
    fn decay_publish(&mut self, shared: &SharedAnalysis) {
        for b in self.bands.iter_mut() {
            *b *= 0.82;
        }
        self.beat_env *= 0.8;
        self.phrasing.decay();
        let mut frame = shared.lock().unwrap();
        frame[0] *= 0.82;
        frame[1] *= 0.82;
        frame[4] = self.beat_env;
        frame[5] *= 0.8;
        frame[12] = self.phrasing.section();
        frame[13] = self.phrasing.grid_conf();
        for (i, b) in self.bands.iter().enumerate() {
            frame[HEADER + i] = *b;
        }
        for w in frame[HEADER + NUM_BANDS..].iter_mut() {
            *w *= 0.7;
        }
    }
}

#[cfg(target_os = "windows")]
pub fn list_sources() -> Result<Vec<SourceInfo>, String> {
    // Runs in its own thread: COM apartment state of Tauri's threads is
    // none of our business, a fresh thread can always join the MTA.
    std::thread::spawn(|| -> Result<Vec<SourceInfo>, String> {
        use wasapi::{DeviceEnumerator, Direction};
        (|| -> Result<Vec<SourceInfo>, Box<dyn std::error::Error>> {
            wasapi::initialize_mta().ok()?;
            let enumerator = DeviceEnumerator::new()?;
            let mut sources = Vec::new();
            for (direction, kind) in [
                (Direction::Render, "loopback"),
                (Direction::Capture, "input"),
            ] {
                let default_id = enumerator
                    .get_default_device(&direction)
                    .and_then(|d| d.get_id())
                    .unwrap_or_default();
                let collection = enumerator.get_device_collection(&direction)?;
                for i in 0..collection.get_nbr_devices()? {
                    let device = collection.get_device_at_index(i)?;
                    let id = device.get_id()?;
                    let name = device
                        .get_friendlyname()
                        .unwrap_or_else(|_| "<unbekannt>".into());
                    sources.push(SourceInfo {
                        is_default: id == default_id,
                        id,
                        name,
                        kind,
                    });
                }
            }
            eprintln!("[vizzy-audio] list_sources -> {} devices", sources.len());
            Ok(sources)
        })()
        .map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "source enumeration thread panicked".to_string())?
}

#[cfg(target_os = "macos")]
pub fn list_sources() -> Result<Vec<SourceInfo>, String> {
    mac::list_sources()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn list_sources() -> Result<Vec<SourceInfo>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
pub fn list_apps() -> Result<Vec<AppInfo>, String> {
    std::thread::spawn(|| -> Result<Vec<AppInfo>, String> {
        use std::collections::HashMap;
        use sysinfo::{ProcessRefreshKind, RefreshKind, System};
        use wasapi::{DeviceEnumerator, Direction, SessionState};
        (|| -> Result<Vec<AppInfo>, Box<dyn std::error::Error>> {
            wasapi::initialize_mta().ok()?;
            let system = System::new_with_specifics(
                RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
            );
            let own_pid = std::process::id();
            let mut apps: HashMap<u32, AppInfo> = HashMap::new();

            let enumerator = DeviceEnumerator::new()?;
            let collection = enumerator.get_device_collection(&Direction::Render)?;
            for i in 0..collection.get_nbr_devices()? {
                let Ok(device) = collection.get_device_at_index(i) else {
                    continue;
                };
                let Ok(manager) = device.get_iaudiosessionmanager() else {
                    continue;
                };
                let Ok(sessions) = manager.get_audiosessionenumerator() else {
                    continue;
                };
                for s in 0..sessions.get_count().unwrap_or(0) {
                    let Ok(control) = sessions.get_session(s) else {
                        continue;
                    };
                    let Ok(pid) = control.get_process_id() else {
                        continue;
                    };
                    if pid == 0 || pid == own_pid {
                        continue; // system sounds session / vizzy itself
                    }
                    let state = control.get_state().unwrap_or(SessionState::Inactive);
                    if matches!(state, SessionState::Expired) {
                        continue;
                    }
                    let active = matches!(state, SessionState::Active);
                    let name = system
                        .process(sysinfo::Pid::from_u32(pid))
                        .map(|p| p.name().to_string_lossy().into_owned())
                        .unwrap_or_else(|| format!("PID {pid}"));
                    apps.entry(pid)
                        .and_modify(|a| a.active |= active)
                        .or_insert(AppInfo { pid, name, active });
                }
            }

            let mut list: Vec<AppInfo> = apps.into_values().collect();
            list.sort_by(|a, b| {
                b.active
                    .cmp(&a.active)
                    .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            eprintln!("[vizzy-audio] list_apps -> {} apps", list.len());
            Ok(list)
        })()
        .map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "app enumeration thread panicked".to_string())?
}

#[cfg(target_os = "macos")]
pub fn list_apps() -> Result<Vec<AppInfo>, String> {
    mac::list_apps()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn list_apps() -> Result<Vec<AppInfo>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
fn capture_loop(
    shared: &SharedAnalysis,
    spec: &SourceSpec,
    rx: &Receiver<SourceSpec>,
    params: &SharedParams,
) -> Result<Option<SourceSpec>, Box<dyn std::error::Error>> {
    use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

    wasapi::initialize_mta().ok()?;

    let (mut client, buffer_duration_hns) = match spec {
        SourceSpec::App { pid, name } => {
            eprintln!("[vizzy-audio] capturing app '{name}' (pid {pid})");
            // include_tree: also catch audio from child processes
            (AudioClient::new_application_loopback_client(*pid, true)?, 0)
        }
        SourceSpec::Loopback { device_id } => {
            open_device_client(&Direction::Render, device_id.as_deref())?
        }
        SourceSpec::Input { device_id } => {
            open_device_client(&Direction::Capture, device_id.as_deref())?
        }
    };

    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, 2, None);
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns,
    };
    client.initialize_client(&format, &Direction::Capture, &mode)?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    let block_align = format.get_blockalign() as usize;

    let mut bytes: VecDeque<u8> = VecDeque::with_capacity(64 * 1024);
    let mut analyzer = Analyzer::new(params.clone(), SAMPLE_RATE);

    client.start_stream()?;
    loop {
        if capture.get_next_packet_size()?.unwrap_or(0) > 0 {
            capture.read_from_device_to_deque(&mut bytes)?;
        }

        while bytes.len() >= block_align {
            let mut b = [0u8; 4];
            for byte in b.iter_mut() {
                *byte = bytes.pop_front().unwrap();
            }
            let left = f32::from_le_bytes(b);
            for byte in b.iter_mut() {
                *byte = bytes.pop_front().unwrap();
            }
            let right = f32::from_le_bytes(b);
            analyzer.push(0.5 * (left + right));
        }
        analyzer.maybe_publish(shared);

        // Source switch requested from the frontend?
        if let Ok(next) = rx.try_recv() {
            let _ = client.stop_stream();
            return Ok(Some(next));
        }

        // Timeout ⇒ silence (WASAPI loopback stops delivering packets when
        // nothing plays). Decay instead of freezing the picture.
        if event.wait_for_event(250).is_err() {
            analyzer.decay_publish(shared);
        }
    }
}

/// Open an IAudioClient on a specific or default endpoint of the given
/// direction. Returns the client plus the minimum device period to use as
/// event-driven buffer duration.
#[cfg(target_os = "windows")]
fn open_device_client(
    direction: &wasapi::Direction,
    device_id: Option<&str>,
) -> Result<(wasapi::AudioClient, i64), Box<dyn std::error::Error>> {
    use wasapi::DeviceEnumerator;

    let enumerator = DeviceEnumerator::new()?;
    let device = match device_id {
        Some(id) => enumerator.get_device(id)?,
        None => enumerator.get_default_device(direction)?,
    };
    eprintln!(
        "[vizzy-audio] capturing {:?} endpoint: {}",
        direction,
        device.get_friendlyname().unwrap_or_else(|_| "<unknown>".into())
    );
    let mut client = device.get_iaudioclient()?;
    let (_default_period, min_period) = client.get_device_period()?;
    Ok((client, min_period))
}

#[cfg(target_os = "macos")]
fn capture_loop(
    shared: &SharedAnalysis,
    spec: &SourceSpec,
    rx: &Receiver<SourceSpec>,
    params: &SharedParams,
) -> Result<Option<SourceSpec>, Box<dyn std::error::Error>> {
    mac::capture_loop(shared, spec, rx, params)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn capture_loop(
    shared: &SharedAnalysis,
    _spec: &SourceSpec,
    rx: &Receiver<SourceSpec>,
    params: &SharedParams,
) -> Result<Option<SourceSpec>, Box<dyn std::error::Error>> {
    eprintln!("[vizzy-audio] no capture backend for this OS yet — publishing silence");
    let mut analyzer = Analyzer::new(params.clone(), SAMPLE_RATE);
    loop {
        analyzer.decay_publish(shared);
        if let Ok(next) = rx.recv_timeout(Duration::from_millis(100)) {
            return Ok(Some(next));
        }
    }
}

#[cfg(test)]
mod pipeline_tests {
    use super::*;

    const SR: usize = 48000;

    /// Deterministic white noise in -1…1.
    fn noise(i: usize) -> f32 {
        let mut x = (i as u32).wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
        x ^= x >> 15;
        x = x.wrapping_mul(0x2C1B_3C6D);
        x ^= x >> 12;
        x = x.wrapping_mul(0x297A_2D39);
        x ^= x >> 15;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    pub enum Groove {
        /// kick on every beat, clap on 2+4, off-beat hat, 16th ticks, off-beat bass
        FourFloor,
        /// two-step breakbeat: kick on 1 and the "and" of 3, snare on 2 and 4
        Break,
        /// four-on-the-floor with loud syncopated stabs on dotted eighths
        Syncopated,
    }

    /// Render `secs` of a drum loop at `bpm`. Beat 0 starts at t = 0.
    pub fn synth(bpm: f32, secs: f32, groove: Groove) -> Vec<f32> {
        let n = (secs * SR as f32) as usize;
        let beat = 60.0 / bpm;
        let mut out = vec![0.0f32; n];
        let mut add = |at: f32, len: f32, f: &dyn Fn(f32, usize) -> f32| {
            let s0 = (at * SR as f32) as usize;
            let l = (len * SR as f32) as usize;
            for i in 0..l {
                if s0 + i >= n {
                    break;
                }
                out[s0 + i] += f(i as f32 / SR as f32, s0 + i);
            }
        };
        let kick = |t: f32, _: usize| {
            let f = 45.0 + 110.0 * (-t * 28.0).exp();
            (std::f32::consts::TAU * f * t).sin() * (-t * 9.0).exp() * 0.8
        };
        let snare = |t: f32, i: usize| {
            (noise(i) * 0.5 + (std::f32::consts::TAU * 190.0 * t).sin() * 0.3) * (-t * 22.0).exp()
        };
        let hat = |t: f32, i: usize| (noise(i) - noise(i + 1)) * 0.18 * (-t * 70.0).exp();
        let tick = |t: f32, i: usize| (noise(i) - noise(i + 1)) * 0.07 * (-t * 110.0).exp();
        let bass = |t: f32, _: usize| {
            let p = (t * 55.0).fract();
            (p * 2.0 - 1.0) * 0.3 * (1.0 - (-t * 200.0).exp()) * (-t * 6.0).exp()
        };
        let stab = |t: f32, _: usize| {
            let s = (std::f32::consts::TAU * 440.0 * t).sin()
                + (std::f32::consts::TAU * 554.0 * t).sin()
                + (std::f32::consts::TAU * 659.0 * t).sin();
            s * 0.2 * (-t * 14.0).exp()
        };

        let beats = (secs / beat) as usize + 1;
        for b in 0..beats {
            let t = b as f32 * beat;
            let in_bar = b % 4;
            match groove {
                Groove::FourFloor | Groove::Syncopated => {
                    add(t, 0.35, &kick);
                    if in_bar % 2 == 1 {
                        add(t, 0.2, &snare);
                    }
                    add(t + beat * 0.5, 0.08, &hat);
                    add(t + beat * 0.5, 0.3, &bass);
                    add(t + beat * 0.25, 0.04, &tick);
                    add(t + beat * 0.75, 0.04, &tick);
                    if groove == Groove::Syncopated {
                        // 3-3-2 pattern in eighths across each half bar
                        if in_bar % 2 == 0 {
                            add(t, 0.25, &stab);
                            add(t + beat * 0.75, 0.25, &stab);
                        } else {
                            add(t + beat * 0.5, 0.25, &stab);
                        }
                    }
                }
                Groove::Break => {
                    if in_bar == 0 {
                        add(t, 0.35, &kick);
                    }
                    if in_bar == 2 {
                        add(t + beat * 0.5, 0.35, &kick);
                    }
                    if in_bar % 2 == 1 {
                        add(t, 0.2, &snare);
                    }
                    add(t, 0.08, &hat);
                    add(t + beat * 0.5, 0.08, &hat);
                    add(t + beat * 0.25, 0.04, &tick);
                    add(t + beat * 0.75, 0.04, &tick);
                }
            }
        }
        out
    }

    pub struct Report {
        pub bpm: f32,
        pub bpm_conf: f32,
        pub grid_conf: f32,
        /// length of the mean phase-error vector: 1 = the grid holds a fixed
        /// offset to the true beat, 0 = it slides all the way around
        pub steadiness: f32,
        /// mean offset of the grid from the true beat, in milliseconds
        pub offset_ms: f32,
        /// beats the grid gained or lost against the true count
        pub slipped: f32,
    }

    /// Push audio through the real analyzer and compare the published grid
    /// against the known beat positions, ignoring the first `warmup` seconds.
    pub fn measure(audio: &[f32], true_bpm: f32, warmup: f32) -> Report {
        measure_from(audio, true_bpm, warmup, 0.0)
    }

    /// As [`measure`], with the true beats counted from `origin` seconds in.
    pub fn measure_from(audio: &[f32], true_bpm: f32, warmup: f32, origin: f32) -> Report {
        // the estimator reports within one octave; judge against the same
        // pulse folded into it
        let mut true_bpm = true_bpm;
        while true_bpm < 90.0 {
            true_bpm *= 2.0;
        }
        while true_bpm >= 180.0 {
            true_bpm /= 2.0;
        }
        let shared: SharedAnalysis = Arc::new(Mutex::new(empty_frame()));
        let params: SharedParams = Arc::new(Mutex::new(AnalysisParams::default()));
        let mut a = Analyzer::new(params, SR);
        let beat = 60.0 / true_bpm;
        let (mut sc, mut ss, mut n) = (0.0f32, 0.0f32, 0u32);
        let mut conf_sum = 0.0f32;
        let mut first: Option<(f32, f32)> = None;
        let mut last = (0.0f32, 0.0f32);
        for (i, &s) in audio.iter().enumerate() {
            a.push(s);
            let before = a.published;
            a.maybe_publish(&shared);
            if a.published == before {
                continue;
            }
            let t = i as f32 / SR as f32;
            if t < warmup {
                continue;
            }
            let f = shared.lock().unwrap();
            let truth = (t - origin) / beat;
            let grid = f[9] + f[8];
            let err = (f[8] - truth.fract()).rem_euclid(1.0);
            let (s_, c_) = (std::f32::consts::TAU * err).sin_cos();
            sc += c_;
            ss += s_;
            n += 1;
            conf_sum += f[13];
            if first.is_none() {
                first = Some((grid, truth));
            }
            last = (grid, truth);
        }
        let f = shared.lock().unwrap();
        let (g0, t0) = first.unwrap();
        let nf = n as f32;
        Report {
            bpm: f[6],
            bpm_conf: f[7],
            grid_conf: conf_sum / nf,
            steadiness: ((sc / nf).powi(2) + (ss / nf).powi(2)).sqrt(),
            offset_ms: (ss / nf).atan2(sc / nf) / std::f32::consts::TAU * beat * 1000.0,
            slipped: (last.0 - g0) - (last.1 - t0),
        }
    }

    /// The regression test for the drift seen on real music: tempo read a few
    /// percent off, the grid sliding around the beat every dozen seconds, and
    /// the confidence stuck near 0.1 as a result. Every earlier test fed the
    /// grid the *true* tempo and so never saw it. This one goes through the
    /// whole analyzer, audio in, grid out.
    #[test]
    fn grid_holds_the_beat_end_to_end() {
        for groove in [Groove::FourFloor, Groove::Syncopated, Groove::Break] {
            for bpm in [92.0f32, 128.0, 137.0, 174.0] {
                let r = measure(&synth(bpm, 45.0, groove), bpm, 12.0);
                let what = format!("{groove:?} at {bpm} BPM");
                assert!((r.bpm - bpm).abs() < 1.0, "{what}: read as {:.1}", r.bpm);
                assert!(r.steadiness > 0.95, "{what}: steadiness {:.2}", r.steadiness);
                assert!(r.slipped.abs() < 0.5, "{what}: slipped {:+.1} beats", r.slipped);
                assert!(r.offset_ms.abs() < 15.0, "{what}: {:+.0} ms off", r.offset_ms);
                assert!(r.grid_conf > 0.8, "{what}: grid_conf {:.2}", r.grid_conf);
            }
        }
    }

    /// A DJ blending into a faster track: the grid has to let go of the old
    /// tempo and settle on the new one.
    #[test]
    fn follows_a_change_of_tempo() {
        let mut audio = synth(126.0, 30.0, Groove::FourFloor);
        audio.extend(synth(140.0, 40.0, Groove::FourFloor));
        // judged over the last 20 s, against beats counted from the switch
        let r = measure_from(&audio, 140.0, 50.0, 30.0);
        assert!((r.bpm - 140.0).abs() < 1.0, "read as {:.1}", r.bpm);
        assert!(r.grid_conf > 0.8, "grid_conf {:.2}", r.grid_conf);
        assert!(r.steadiness > 0.95, "steadiness {:.2}", r.steadiness);
        assert!(r.offset_ms.abs() < 15.0, "{:+.0} ms off", r.offset_ms);
    }

    /// Sound with no pulse must not be reported as a locked grid.
    #[test]
    fn noise_does_not_lock() {
        // hiss with bursts at irregular, unrelated intervals
        let n = 40 * SR;
        let mut audio = vec![0.0f32; n];
        let (mut next, mut k) = (0usize, 0usize);
        let mut env = 0.0f32;
        for (i, s) in audio.iter_mut().enumerate() {
            if i >= next {
                env = 1.0;
                k += 1;
                let r = (noise(k * 7919) * 0.5 + 0.5).abs();
                next = i + ((0.13 + r * 0.6) * SR as f32) as usize;
            }
            env *= 0.9995;
            *s = noise(i) * (0.05 + 0.5 * env);
        }
        let r = measure(&audio, 120.0, 12.0);
        assert!(r.grid_conf < 0.5, "noise locked: grid_conf {:.2}", r.grid_conf);
    }

    /// Not an assertion — the end-to-end scoreboard. Run with
    /// `cargo test --lib -- --nocapture scoreboard`.
    #[test]
    fn scoreboard() {
        println!("groove      bpm    -> est    bconf gconf steady  ms   slipped");
        for groove in [Groove::FourFloor, Groove::Syncopated, Groove::Break] {
            for bpm in [85.0f32, 92.0, 100.0, 110.0, 120.0, 128.0, 137.0, 150.0, 160.0, 174.0] {
                let audio = synth(bpm, 60.0, groove);
                let r = measure(&audio, bpm, 15.0);
                println!(
                    "{:<11} {:>5.1} -> {:>6.1}  {:.2}  {:.2}  {:.2}  {:+4.0}  {:+.1}",
                    format!("{groove:?}"),
                    bpm,
                    r.bpm,
                    r.bpm_conf,
                    r.grid_conf,
                    r.steadiness,
                    r.offset_ms,
                    r.slipped
                );
            }
        }
    }
}
