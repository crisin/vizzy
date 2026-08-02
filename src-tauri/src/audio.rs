//! Audio capture + analysis.
//!
//! Phase 0: Windows WASAPI device loopback (default render device) → mono
//! mixdown → FFT → log-spaced bands + waveform excerpt. The analysis result
//! is published as a flat f32 frame:
//!
//! `[rms, peak, n_bands, n_wave, bands[n_bands], wave[n_wave]]`
//!
//! On non-Windows platforms a silent stub keeps the pipeline alive until the
//! macOS Core Audio tap backend lands (Phase 0 Mac spike).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const NUM_BANDS: usize = 64;
pub const WAVE_POINTS: usize = 512;
const FFT_SIZE: usize = 2048;
const HOP: usize = 512; // ~94 analysis frames/s at 48 kHz
const SAMPLE_RATE: usize = 48000;
const F_MIN: f32 = 40.0;
const F_MAX: f32 = 16000.0;
const DB_FLOOR: f32 = 60.0;

pub type SharedAnalysis = Arc<Mutex<Vec<f32>>>;

pub fn empty_frame() -> Vec<f32> {
    let mut frame = vec![0.0f32; 4 + NUM_BANDS + WAVE_POINTS];
    frame[2] = NUM_BANDS as f32;
    frame[3] = WAVE_POINTS as f32;
    frame
}

pub fn spawn_capture(shared: SharedAnalysis) {
    std::thread::Builder::new()
        .name("vizzy-audio".into())
        .spawn(move || loop {
            if let Err(e) = capture_loop(&shared) {
                eprintln!("[vizzy-audio] capture error: {e}; retrying in 2s");
            }
            std::thread::sleep(Duration::from_secs(2));
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
    bands: Vec<f32>,
    published: u64,
}

impl Analyzer {
    fn new() -> Self {
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
                let bin = (f * FFT_SIZE as f32 / SAMPLE_RATE as f32).round() as usize;
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
            bands: vec![0.0; NUM_BANDS],
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

        self.published += 1;
        if self.published % 188 == 0 {
            // ~every 2 s at 94 frames/s
            eprintln!("[vizzy-audio] frames={} rms={rms:.4} peak={peak:.4}", self.published);
        }

        let mut frame = shared.lock().unwrap();
        frame[0] = rms;
        frame[1] = peak;
        for (i, b) in self.bands.iter().enumerate() {
            frame[4 + i] = *b;
        }
        for (i, s) in self.ring.iter().skip(FFT_SIZE - WAVE_POINTS).enumerate() {
            frame[4 + NUM_BANDS + i] = *s;
        }
    }

    /// Called when no audio arrives (loopback delivers nothing during
    /// silence): let the published bands fall toward zero.
    fn decay_publish(&mut self, shared: &SharedAnalysis) {
        for b in self.bands.iter_mut() {
            *b *= 0.82;
        }
        let mut frame = shared.lock().unwrap();
        frame[0] *= 0.82;
        frame[1] *= 0.82;
        for (i, b) in self.bands.iter().enumerate() {
            frame[4 + i] = *b;
        }
        for w in frame[4 + NUM_BANDS..].iter_mut() {
            *w *= 0.7;
        }
    }
}

#[cfg(target_os = "windows")]
fn capture_loop(shared: &SharedAnalysis) -> Result<(), Box<dyn std::error::Error>> {
    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    wasapi::initialize_mta().ok()?;

    let enumerator = DeviceEnumerator::new()?;
    let device = enumerator.get_default_device(&Direction::Render)?;
    eprintln!(
        "[vizzy-audio] loopback capture on render device: {}",
        device.get_friendlyname().unwrap_or_else(|_| "<unknown>".into())
    );

    let mut client = device.get_iaudioclient()?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, 2, None);
    let (_default_period, min_period) = client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    // Direction::Capture on a render device → the crate sets
    // AUDCLNT_STREAMFLAGS_LOOPBACK for us (shared mode only).
    client.initialize_client(&format, &Direction::Capture, &mode)?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    let block_align = format.get_blockalign() as usize;

    let mut bytes: VecDeque<u8> = VecDeque::with_capacity(64 * 1024);
    let mut analyzer = Analyzer::new();

    client.start_stream()?;
    loop {
        capture.read_from_device_to_deque(&mut bytes)?;

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

        // Timeout ⇒ silence (WASAPI loopback stops delivering packets when
        // nothing plays). Decay instead of freezing the picture.
        if event.wait_for_event(250).is_err() {
            analyzer.decay_publish(shared);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_loop(shared: &SharedAnalysis) -> Result<(), Box<dyn std::error::Error>> {
    // macOS backend (Core Audio taps via `cidre`) lands in the Mac spike.
    eprintln!("[vizzy-audio] no capture backend for this OS yet — publishing silence");
    let mut analyzer = Analyzer::new();
    loop {
        analyzer.decay_publish(shared);
        std::thread::sleep(Duration::from_millis(100));
    }
}
