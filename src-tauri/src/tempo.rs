//! Tempo and beat-phase estimation from the onset envelope.
//!
//! The first version of this measured the gaps between detected onsets and
//! took their median. That throws away most of the signal — only hits loud
//! enough to cross the onset threshold count, each one is quantised to a whole
//! analysis hop (±1 hop is ±3 BPM at 137), and one syncopated stab between two
//! kicks produces two intervals that have nothing to do with the beat. The
//! estimate came out a few percent off, and a grid running a few percent off
//! slides all the way around the beat every dozen seconds.
//!
//! This works on the *whole* envelope instead:
//!
//! 1. **Tempo** — autocorrelate the last few seconds of spectral flux. Music
//!    that repeats every beat correlates with itself one beat later, and two,
//!    three and four beats later. Scoring a candidate period by all four of
//!    those lags at once pins it down four times finer than the first lag
//!    alone, and it needs no onset to have been "detected" at all.
//! 2. **Phase** — lay a comb with that period over the bass-weighted envelope
//!    and slide it until the teeth collect the most energy. Where the teeth
//!    sit is where the beats are.
//!
//! Both answers come from seconds of audio rather than from the last hit, so
//! they are steady enough for the grid in [`crate::phrasing`] to follow
//! directly.

/// Tempo range reported — exactly one octave. A pattern that repeats every
/// beat also repeats every two, so nothing in the signal separates 87 from
/// 174 BPM; a wider range only adds a coin flip between them, and a grid that
/// flips octaves is worse than one that reads slow hip-hop in double time.
/// Either reading is in time with the music.
const MIN_BPM: f32 = 90.0;
const MAX_BPM: f32 = 180.0;

/// Envelope history the tempo is read from. Long enough to hold four beats of
/// the slowest tempo several times over, short enough to follow a DJ blending
/// into the next track.
const WINDOW_S: f32 = 10.0;
/// Nothing is reported before this much envelope has been collected.
const WARMUP_S: f32 = 3.0;
const UPDATE_S: f32 = 0.25;
/// How far back the phase comb reaches.
const PHASE_WINDOW_S: f32 = 6.0;

/// Beat multiples a candidate period is scored on.
const HARMONICS: usize = 4;
/// Candidate period resolution, in analysis hops.
const LAG_STEP: f32 = 0.1;

/// A new tempo more than this far from the current one (as a ratio) counts as
/// a different tempo rather than a refinement, and has to …
const SAME_TEMPO: f32 = 0.04;
/// … beat the current one by this factor, this many updates in a row.
const SWITCH_MARGIN: f32 = 1.12;
const SWITCH_STRIKES: u32 = 8;

pub struct Estimate {
    /// Seconds per beat.
    pub period: f32,
    /// How long before the newest hop the most recent beat fell, in seconds.
    pub beat_age: f32,
    /// How periodic the envelope is at this tempo, 0…1.
    pub conf: f32,
}

pub struct Tempo {
    hop_s: f32,
    /// Ring buffers, `head` is the next write position.
    env: Vec<f32>,
    low: Vec<f32>,
    head: usize,
    filled: usize,
    since_update: usize,
    update_hops: usize,
    /// Current period in hops; 0 while there is none.
    period: f32,
    strikes: u32,
    // scratch, kept to avoid reallocating four times a second
    lin: Vec<f32>,
    lin_low: Vec<f32>,
    acf: Vec<f32>,
}

impl Tempo {
    pub fn new(hop_s: f32) -> Self {
        let n = (WINDOW_S / hop_s).round() as usize;
        Self {
            hop_s,
            env: vec![0.0; n],
            low: vec![0.0; n],
            head: 0,
            filled: 0,
            since_update: 0,
            update_hops: ((UPDATE_S / hop_s).round() as usize).max(1),
            period: 0.0,
            strikes: 0,
            lin: Vec::with_capacity(n),
            lin_low: Vec::with_capacity(n),
            acf: Vec::new(),
        }
    }

    /// Feed one hop. `flux` is the full onset strength, `low` the same thing
    /// weighted toward the kick — the first decides the tempo, the second
    /// where the beat sits. Returns a fresh estimate a few times a second.
    pub fn push(&mut self, flux: f32, low: f32) -> Option<Estimate> {
        let n = self.env.len();
        self.env[self.head] = flux;
        self.low[self.head] = low;
        self.head = (self.head + 1) % n;
        self.filled = (self.filled + 1).min(n);

        self.since_update += 1;
        if self.since_update < self.update_hops {
            return None;
        }
        self.since_update = 0;
        if (self.filled as f32) * self.hop_s < WARMUP_S {
            return None;
        }
        self.analyze()
    }

    fn analyze(&mut self) -> Option<Estimate> {
        // Unroll the rings, oldest first.
        let n = self.env.len();
        let start = (self.head + n - self.filled) % n;
        self.lin.clear();
        self.lin_low.clear();
        for i in 0..self.filled {
            self.lin.push(self.env[(start + i) % n]);
            self.lin_low.push(self.low[(start + i) % n]);
        }
        let len = self.lin.len();
        let mean = self.lin.iter().sum::<f32>() / len as f32;
        for v in self.lin.iter_mut() {
            *v -= mean;
        }

        let min_lag = 60.0 / MAX_BPM / self.hop_s;
        let max_lag = 60.0 / MIN_BPM / self.hop_s;
        // Lags past ~60 % of the window are averaged over too few samples to
        // mean anything; harmonics that land out there are left out.
        let usable = (len as f32 * 0.6).floor();
        let top = ((max_lag * HARMONICS as f32).min(usable) as usize + 2).min(len - 1);

        let r0 = self.lin.iter().map(|v| v * v).sum::<f32>() / len as f32;
        if r0 < 1e-9 {
            return None; // silence, or a perfectly flat envelope
        }
        self.acf.clear();
        self.acf.push(1.0);
        for lag in 1..=top {
            let mut acc = 0.0f32;
            for i in lag..len {
                acc += self.lin[i] * self.lin[i - lag];
            }
            self.acf.push(acc / (len - lag) as f32 / r0);
        }

        // Score every candidate period, remembering the best overall and the
        // best close to the tempo we already hold.
        let mut best = (0.0f32, f32::MIN); // (lag, score)
        let mut near = best;
        let mut lag = min_lag;
        while lag < max_lag {
            if let Some(score) = self.score(lag, usable) {
                if score > best.1 {
                    best = (lag, score);
                }
                if self.period > 0.0
                    && (lag / self.period).ln().abs() < SAME_TEMPO
                    && score > near.1
                {
                    near = (lag, score);
                }
            }
            lag += LAG_STEP;
        }
        if best.1 <= 0.0 {
            return None;
        }

        // Hold the current tempo unless something else is clearly and
        // persistently better — one odd bar must not send the grid off to
        // two thirds of the tempo.
        let chosen = if self.period == 0.0 || near.1 == f32::MIN {
            best
        } else if (best.0 / self.period).ln().abs() < SAME_TEMPO {
            self.strikes = 0;
            best
        } else if best.1 > near.1 * SWITCH_MARGIN {
            self.strikes += 1;
            if self.strikes >= SWITCH_STRIKES || near.1 <= 0.0 {
                self.strikes = 0;
                best
            } else {
                near
            }
        } else {
            self.strikes = 0;
            near
        };
        if chosen.1 <= 0.0 {
            return None;
        }
        self.period = chosen.0;

        Some(Estimate {
            period: self.period * self.hop_s,
            beat_age: self.phase(self.period) * self.hop_s,
            conf: chosen.1.clamp(0.0, 1.0),
        })
    }

    /// Mean autocorrelation at the first few multiples of `lag`.
    fn score(&self, lag: f32, usable: f32) -> Option<f32> {
        let mut sum = 0.0f32;
        let mut used = 0;
        for k in 1..=HARMONICS {
            let at = lag * k as f32;
            if at > usable {
                break;
            }
            sum += lerp(&self.acf, at);
            used += 1;
        }
        // one lag alone cannot separate a tempo from its neighbours
        (used >= 2).then(|| sum / used as f32)
    }

    /// Slide a comb of the given period over the kick envelope; returns how
    /// many hops before the newest sample the best-fitting tooth sits.
    fn phase(&self, period: f32) -> f32 {
        let len = self.lin_low.len();
        let newest = (len - 1) as f32;
        let reach = (PHASE_WINDOW_S / self.hop_s).min(newest);
        let comb = |offset: f32| -> f32 {
            let mut sum = 0.0f32;
            let mut back = offset;
            while back <= reach {
                // recent beats count for more, so the phase follows the music
                // rather than averaging over a transition
                sum += lerp(&self.lin_low, newest - back) * (1.0 - 0.5 * back / reach);
                back += period;
            }
            sum
        };

        const STEP: f32 = 0.5;
        let steps = (period / STEP).ceil() as usize;
        let (mut best_i, mut best) = (0usize, f32::MIN);
        for i in 0..steps {
            let s = comb(i as f32 * STEP);
            if s > best {
                best = s;
                best_i = i;
            }
        }
        // Parabolic refinement between the neighbouring steps — the envelope
        // is sampled once per hop, the beat is not obliged to fall on one.
        let at = |i: i64| comb((i as f32 * STEP).rem_euclid(period));
        let (l, r) = (at(best_i as i64 - 1), at(best_i as i64 + 1));
        let denom = l - 2.0 * best + r;
        let shift = if denom < -1e-9 {
            (0.5 * (l - r) / denom).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        ((best_i as f32 + shift) * STEP).rem_euclid(period)
    }
}

/// Linear interpolation into `v` at a fractional index.
fn lerp(v: &[f32], at: f32) -> f32 {
    let i = at.floor() as usize;
    if i + 1 >= v.len() {
        return *v.last().unwrap_or(&0.0);
    }
    let f = at - i as f32;
    v[i] * (1.0 - f) + v[i + 1] * f
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOP_S: f32 = 512.0 / 48000.0;

    /// An envelope with a spike on every beat and a smaller one on the
    /// off-beat — the shape a kick and a hat leave behind.
    fn run(bpm: f32, secs: f32) -> Estimate {
        run_at(bpm, secs).0
    }

    /// Also returns the index of the hop the estimate was made on.
    fn run_at(bpm: f32, secs: f32) -> (Estimate, usize) {
        let mut t = Tempo::new(HOP_S);
        let period = 60.0 / bpm / HOP_S;
        let mut last = None;
        for i in 0..(secs / HOP_S) as usize {
            let pos = (i as f32 / period).fract();
            let kick = if pos < 1.0 / period { 1.0 } else { 0.0 };
            let off = (pos - 0.5).abs() < 0.5 / period;
            let flux = kick + if off { 0.5 } else { 0.0 };
            if let Some(e) = t.push(flux, kick) {
                last = Some((e, i));
            }
        }
        last.expect("no estimate")
    }

    #[test]
    fn reads_tempo_far_finer_than_one_hop() {
        for bpm in [92.0f32, 120.0, 128.0, 137.0, 150.0, 174.0] {
            let e = run(bpm, 20.0);
            let got = 60.0 / e.period;
            assert!((got - bpm).abs() < 0.5, "{bpm} BPM read as {got:.2}");
            assert!(e.conf > 0.5, "{bpm} BPM: conf {}", e.conf);
        }
    }

    /// Outside the octave the answer is the same pulse, doubled or halved —
    /// never something that is out of time with it.
    #[test]
    fn tempos_outside_the_range_fold_by_octaves() {
        for (bpm, want) in [(70.0f32, 140.0f32), (85.0, 170.0), (200.0, 100.0)] {
            let got = 60.0 / run(bpm, 20.0).period;
            assert!((got - want).abs() < 0.7, "{bpm} BPM read as {got:.2}");
        }
    }

    #[test]
    fn beat_position_lands_on_the_kick() {
        let bpm = 137.0;
        let (e, newest) = run_at(bpm, 20.0);
        // kicks sit at whole multiples of the period
        let period = 60.0 / bpm / HOP_S;
        let want = (newest as f32 % period) * HOP_S;
        let diff = (e.beat_age - want).abs();
        let diff = diff.min(e.period - diff);
        assert!(diff < 0.012, "beat placed {diff:.4} s off the kick");
    }

    #[test]
    fn silence_reports_nothing() {
        let mut t = Tempo::new(HOP_S);
        for _ in 0..2000 {
            assert!(t.push(0.0, 0.0).is_none());
        }
    }
}
