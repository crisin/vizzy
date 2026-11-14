//! Is someone singing right now, how loud, and how high? A cheap per-hop
//! estimate, no model: a few tens of milliseconds behind the music, where
//! Whisper is seconds behind (`PLAN-stimme.md`, S1).
//!
//! The idea is a vocal remover in reverse. Lead vocals sit dead centre in
//! the stereo image; most instruments around them are panned at least a
//! little. Per FFT bin in the vocal band (250 Hz – 4 kHz) we keep only what
//! is centred (side far below mid). What is left is a rough "vocals only"
//! spectrum:
//! - its **level**, normalized to the song's own range, is the voice signal
//!   (it follows the singing, line by line and often syllable by syllable);
//! - transformed back, it is what YIN reads the **pitch** from.
//!
//! Calibrated on four songs against vocals separated with Demucs
//! (`docs/learnings.md`): per hop the centre level tells singing from not
//! singing with an AUC of 0.74–0.95; plain periodicity of the mix scored
//! ~0.5 (synths and guitars are just as tonal as a voice).
//!
//! Without stereo (macOS mixes down in the IOProc, a mono microphone) the
//! mask has nothing to go on; the plain band level stands in, which is
//! weaker but still moves with the vocals.

use std::collections::VecDeque;
use std::sync::Arc;

use realfft::num_complex::Complex;

/// stereo spectrum: ~43 ms at 48 kHz
const FFT_N: usize = 2048;
/// the vocal band the mask looks at
const BAND_LO: f32 = 250.0;
const BAND_HI: f32 = 4000.0;
/// a bin counts as "dead centre" when its side is this much below its mid
const CENTRE_SIDE_RATIO: f32 = 0.1;
/// pitch search range (a low male voice … a high soprano)
const F0_MIN: f32 = 70.0;
const F0_MAX: f32 = 1000.0;
/// below this (dBFS of the vocal band) nothing counts
const FLOOR_DB: f32 = -60.0;
/// the normalization window never gets narrower than this
const MIN_RANGE_DB: f32 = 12.0;
/// centre share of the band: no voice below, full voice above
const SHARE_FROM: f32 = 0.2;
const SHARE_FULL: f32 = 0.6;
/// gate thresholds on the normalized level, and the shortest on-time
const GATE_ON: f32 = 0.55;
const GATE_OFF: f32 = 0.35;
const GATE_HOLD_S: f32 = 0.15;

/// What one analysis hop measured, before normalization and smoothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct Features {
    /// vocal band level, dBFS
    pub db: f32,
    /// share of the band energy that sits dead centre (0 without stereo)
    pub cmask: f32,
    /// level of the centred part, dBFS — the band level without stereo
    pub cdb: f32,
    /// 1 − YIN's best normalized difference on the centred part
    pub periodicity: f32,
    /// Hz, 0 when nothing periodic in range
    pub pitch: f32,
}

pub struct Voice {
    rate: f32,
    hop_s: f32,
    ring_l: VecDeque<f32>,
    ring_r: VecDeque<f32>,
    fwd: Arc<dyn realfft::RealToComplex<f32>>,
    inv: Arc<dyn realfft::ComplexToReal<f32>>,
    hann: Vec<f32>,
    in_l: Vec<f32>,
    in_r: Vec<f32>,
    sp_l: Vec<Complex<f32>>,
    sp_r: Vec<Complex<f32>>,
    sp_c: Vec<Complex<f32>>,
    centred: Vec<f32>,
    bins: (usize, usize),
    stereo_seen: bool,
    /// YIN works on the centred signal, decimated to ~16 kHz
    dec: usize,
    yin_x: Vec<f32>,
    d: Vec<f32>,
    tau_min: usize,
    tau_max: usize,
    /// slow followers of the song's quiet and loud centre level
    lo: f32,
    hi: f32,
    started: bool,
    pub feat: Features,
    /// 0..1: how loud the voice is, relative to this song
    pub level: f32,
    /// true while someone sings (hysteresis on `level`)
    pub gate: bool,
    gate_hold: f32,
    /// smoothed pitch in Hz; holds the last one through unvoiced hops
    pub pitch: f32,
    /// 0..1, how much to trust `pitch` right now
    pub pitch_conf: f32,
}

impl Voice {
    pub fn new(sample_rate: usize, hop_s: f32) -> Self {
        let rate = sample_rate as f32;
        let mut planner = realfft::RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(FFT_N);
        let inv = planner.plan_fft_inverse(FFT_N);
        let bin = |f: f32| ((f / rate) * FFT_N as f32).round() as usize;
        let dec = ((rate / 16000.0).round() as usize).max(1);
        let yin_rate = rate / dec as f32;
        let tau_max = (yin_rate / F0_MIN) as usize;
        Self {
            rate,
            hop_s,
            ring_l: VecDeque::with_capacity(FFT_N),
            ring_r: VecDeque::with_capacity(FFT_N),
            hann: (0..FFT_N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_N as f32).cos()).collect(),
            in_l: fwd.make_input_vec(),
            in_r: fwd.make_input_vec(),
            sp_l: fwd.make_output_vec(),
            sp_r: fwd.make_output_vec(),
            sp_c: fwd.make_output_vec(),
            centred: inv.make_output_vec(),
            fwd,
            inv,
            bins: (bin(BAND_LO), bin(BAND_HI)),
            stereo_seen: false,
            dec,
            yin_x: Vec::with_capacity(FFT_N / dec + 1),
            d: vec![0.0; tau_max + 1],
            tau_min: (yin_rate / F0_MAX) as usize,
            tau_max,
            lo: 0.0,
            hi: 0.0,
            started: false,
            feat: Features::default(),
            level: 0.0,
            gate: false,
            gate_hold: 0.0,
            pitch: 0.0,
            pitch_conf: 0.0,
        }
    }

    pub fn push(&mut self, l: f32, r: f32) {
        if self.ring_l.len() == FFT_N {
            self.ring_l.pop_front();
            self.ring_r.pop_front();
        }
        self.ring_l.push_back(l);
        self.ring_r.push_back(r);
        if !self.stereo_seen && (l - r).abs() > 1e-4 * (l.abs() + r.abs()) + 1e-7 {
            self.stereo_seen = true;
        }
    }

    /// Once per analysis hop: measure, normalize, smooth.
    pub fn hop(&mut self) {
        self.feat = self.measure();
        let f = self.feat;
        let loud = f.db > FLOOR_DB;

        // the song's own range of the centre level: a fast edge, a slow
        // return (~15 s), so a quiet verse still moves the signal
        if loud {
            if !self.started {
                (self.lo, self.hi, self.started) = (f.cdb - MIN_RANGE_DB, f.cdb, true);
            }
            let slow = (self.hop_s / 15.0).min(1.0);
            self.hi += (f.cdb - self.hi) * if f.cdb > self.hi { 0.3 } else { slow };
            self.lo += (f.cdb - self.lo) * if f.cdb < self.lo { 0.3 } else { slow };
        }
        let range = (self.hi - self.lo).max(MIN_RANGE_DB);
        let loudness = ((f.cdb - (self.hi - range)) / range).clamp(0.0, 1.0);
        // relative loudness alone cannot tell "always nothing in the centre"
        // from "always singing": the centre must also hold a real share of
        // the band (measured: median 0.7–0.8 while singing, 0.25–0.4 not)
        let share = if self.stereo_seen { ((f.cmask - SHARE_FROM) / (SHARE_FULL - SHARE_FROM)).clamp(0.0, 1.0) } else { 1.0 };
        let target = if loud && self.started { loudness * share } else { 0.0 };
        // fast enough for syllables, slow enough not to flicker
        let tau = if target > self.level { 0.03 } else { 0.15 };
        self.level += (target - self.level) * (1.0 - (-self.hop_s / tau).exp());

        self.gate_hold = (self.gate_hold - self.hop_s).max(0.0);
        if !self.gate && self.level > GATE_ON {
            self.gate = true;
            self.gate_hold = GATE_HOLD_S;
        } else if self.gate && self.level < GATE_OFF && self.gate_hold == 0.0 {
            self.gate = false;
        }

        if self.gate && f.pitch > 0.0 && f.periodicity > 0.6 {
            // glide in log space; a jump of more than a fifth starts over
            let jump = if self.pitch > 0.0 { (f.pitch / self.pitch).log2().abs() * 12.0 } else { 99.0 };
            self.pitch = if jump > 7.0 { f.pitch } else { self.pitch * (f.pitch / self.pitch).powf(0.5) };
            self.pitch_conf += (f.periodicity - self.pitch_conf) * 0.3;
        } else {
            self.pitch_conf *= 0.85;
        }
    }

    fn measure(&mut self) -> Features {
        if self.ring_l.len() < FFT_N {
            return Features { db: -120.0, cdb: -120.0, ..Default::default() };
        }
        for (i, (l, r)) in self.ring_l.iter().zip(self.ring_r.iter()).enumerate() {
            self.in_l[i] = l * self.hann[i];
            self.in_r[i] = r * self.hann[i];
        }
        if self.fwd.process(&mut self.in_l, &mut self.sp_l).is_err() || self.fwd.process(&mut self.in_r, &mut self.sp_r).is_err() {
            return Features::default();
        }
        // energies normalized so a full-scale sine in the band reads ~0 dB
        let norm = 4.0 / (FFT_N as f32 * FFT_N as f32 * 0.25);
        let (mut centre, mut all) = (0.0f32, 0.0f32);
        for c in self.sp_c.iter_mut() {
            *c = Complex::new(0.0, 0.0);
        }
        for k in self.bins.0..self.bins.1 {
            let (l, r) = (self.sp_l[k], self.sp_r[k]);
            let m = (l + r) * 0.5;
            let s = (l - r) * 0.5;
            let (em, es) = (m.norm_sqr(), s.norm_sqr());
            all += em + es;
            // without stereo every bin is "centred": the mask is the band
            if !self.stereo_seen || es < CENTRE_SIDE_RATIO * em {
                centre += em;
                self.sp_c[k] = m;
            }
        }
        let db = 10.0 * (all * norm + 1e-12).log10();
        let cdb = 10.0 * (centre * norm + 1e-12).log10();
        let cmask = if self.stereo_seen && all > 0.0 { centre / all } else { 0.0 };
        let (periodicity, pitch) = if db > FLOOR_DB { self.yin_centred() } else { (0.0, 0.0) };
        Features { db, cmask, cdb, periodicity, pitch }
    }

    /// YIN on the centred band, back in the time domain and decimated.
    fn yin_centred(&mut self) -> (f32, f32) {
        if self.inv.process(&mut self.sp_c, &mut self.centred).is_err() {
            return (0.0, 0.0);
        }
        // the centre of the Hann-windowed frame carries the signal
        self.yin_x.clear();
        self.yin_x.extend(self.centred.iter().step_by(self.dec));
        let x = &self.yin_x;
        let w = x.len().saturating_sub(self.tau_max + 1);
        if w < 64 {
            return (0.0, 0.0);
        }
        for tau in 1..=self.tau_max {
            let mut acc = 0.0f32;
            for j in 0..w {
                let d = x[j] - x[j + tau];
                acc += d * d;
            }
            self.d[tau] = acc;
        }
        let mut run = 0.0f32;
        self.d[0] = 1.0;
        for tau in 1..=self.tau_max {
            run += self.d[tau];
            self.d[tau] = if run > 0.0 { self.d[tau] * tau as f32 / run } else { 1.0 };
        }
        // first dip below the threshold, else the global minimum
        let (lo, hi) = (self.tau_min.max(2), self.tau_max - 1);
        let mut best = lo;
        match (lo..hi).find(|&t| self.d[t] < 0.2) {
            Some(mut t) => {
                while t + 1 < hi && self.d[t + 1] < self.d[t] {
                    t += 1;
                }
                best = t;
            }
            None => {
                for t in lo..hi {
                    if self.d[t] < self.d[best] {
                        best = t;
                    }
                }
            }
        }
        let periodicity = (1.0 - self.d[best]).clamp(0.0, 1.0);
        let (a, b, c) = (self.d[best - 1], self.d[best], self.d[best + 1]);
        let den = a - 2.0 * b + c;
        let t = best as f32 + if den.abs() > 1e-9 { 0.5 * (a - c) / den } else { 0.0 };
        let yin_rate = self.rate / self.dec as f32;
        (periodicity, if periodicity > 0.3 { yin_rate / t } else { 0.0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = 48000;
    const HOP: usize = 512;
    const TAU: f32 = 2.0 * std::f32::consts::PI;

    fn run(v: &mut Voice, l: impl Fn(f32) -> f32, r: impl Fn(f32) -> f32, from: f32, secs: f32) {
        let n0 = (from * SR as f32) as usize;
        for i in n0..n0 + (secs * SR as f32) as usize {
            let t = i as f32 / SR as f32;
            v.push(l(t), r(t));
            if (i + 1) % HOP == 0 {
                v.hop();
            }
        }
    }

    /// a voice-like tone: 220 Hz with harmonics
    fn voice(t: f32) -> f32 {
        let w = TAU * 220.0 * t;
        0.2 * (w.sin() + 0.5 * (2.0 * w).sin() + 0.3 * (3.0 * w).sin())
    }

    /// a "guitar" panned hard left, under the lead vocal: 330 Hz
    fn guitar(t: f32) -> f32 {
        0.1 * (TAU * 330.0 * t).sin()
    }

    #[test]
    fn hears_the_centred_voice_through_a_panned_instrument() {
        let mut v = Voice::new(SR, HOP as f32 / SR as f32);
        // the guitar alone first, then the voice joins in the middle
        run(&mut v, guitar, |_| 0.0, 0.0, 3.0);
        let before = v.level;
        assert!(!v.gate, "guitar alone opened the gate");
        run(&mut v, |t| guitar(t) + voice(t), voice, 3.0, 1.0);
        // the guitar keeps part of the band off-centre, so the share is not full
        assert!(v.gate && v.level > 0.45, "level {before} → {}", v.level);
        assert!(v.feat.cmask > 0.5, "cmask {}", v.feat.cmask);
        // pitch of the voice, not the guitar
        assert!((v.pitch - 220.0).abs() < 4.0, "pitch {}", v.pitch);
        assert!(v.pitch_conf > 0.5);
        // the voice stops: the gate closes again
        run(&mut v, guitar, |_| 0.0, 4.0, 1.0);
        assert!(!v.gate && v.level < 0.3, "level {}", v.level);
    }

    #[test]
    fn silence_is_nothing() {
        let mut v = Voice::new(SR, HOP as f32 / SR as f32);
        run(&mut v, |_| 0.0, |_| 0.0, 0.0, 1.0);
        assert!(v.level == 0.0 && !v.gate && v.feat.pitch == 0.0);
    }

    #[test]
    fn mono_falls_back_to_the_band_level() {
        let mut v = Voice::new(SR, HOP as f32 / SR as f32);
        // macOS feeds the same sample to both sides: quiet, then loud
        let quiet = |t: f32| 0.01 * voice(t);
        run(&mut v, quiet, quiet, 0.0, 2.0);
        run(&mut v, voice, voice, 2.0, 0.5);
        assert!(!v.stereo_seen && v.feat.cmask == 0.0);
        assert!(v.gate, "level {}", v.level);
        assert!((v.pitch - 220.0).abs() < 4.0, "pitch {}", v.pitch);
    }

    /// Dumps the features per hop for calibration:
    ///   ffmpeg -i song.mp3 -ss 30 -t 60 -ac 2 -ar 48000 -f f32le song.s48
    ///   VIZZY_VOICE_FILE=song.s48 VIZZY_VOICE_CSV=song.csv cargo test --lib voice_features -- --ignored
    #[test]
    #[ignore]
    fn voice_features() {
        let pcm: Vec<f32> = std::fs::read(std::env::var("VIZZY_VOICE_FILE").unwrap())
            .unwrap()
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let mut v = Voice::new(SR, HOP as f32 / SR as f32);
        let mut out = String::from("t,db,cmask,cdb,periodicity,pitch,level,gate,vpitch,vconf\n");
        for (i, lr) in pcm.chunks_exact(2).enumerate() {
            v.push(lr[0], lr[1]);
            if (i + 1) % HOP == 0 {
                v.hop();
                let f = v.feat;
                out += &format!(
                    "{:.4},{:.2},{:.4},{:.2},{:.4},{:.1},{:.4},{},{:.1},{:.3}\n",
                    (i + 1) as f32 / SR as f32,
                    f.db,
                    f.cmask,
                    f.cdb,
                    f.periodicity,
                    f.pitch,
                    v.level,
                    v.gate as u8,
                    v.pitch,
                    v.pitch_conf
                );
            }
        }
        std::fs::write(std::env::var("VIZZY_VOICE_CSV").unwrap(), out).unwrap();
    }
}
