//! macOS capture backend: Core Audio process taps.
//!
//! There is no loopback flag on a macOS output device the way WASAPI has one,
//! so system audio is captured by *tapping* processes: `CATapDescription`
//! describes which processes to mix, `AudioHardwareCreateProcessTap` turns
//! that into a tap object, and the tap is then read by putting it into a
//! private aggregate device that we drive with a normal IOProc.
//!
//! | source kind | mechanism                                          |
//! |-------------|----------------------------------------------------|
//! | `Loopback`  | global tap, our own process excluded                |
//! | `App`       | tap over the single process object behind that PID  |
//! | `Input`     | plain IOProc on the input device — no tap involved  |
//!
//! Taps need macOS 14.2+ and the audio-capture TCC grant; without the grant
//! `AudioHardwareCreateProcessTap` fails and the caller retries/falls back.
//! `Input` needs the microphone grant instead, and works on any macOS.

use std::cell::UnsafeCell;
use std::error::Error;
use std::ffi::{c_int, c_void, CStr};
use std::fmt;
use std::mem::{size_of, MaybeUninit};
use std::ptr::{null, NonNull};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AllocAnyThread, Message};
use objc2_core_audio::*;
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};

use super::*;

// ---------------------------------------------------------------- errors ---

/// `objc2-core-audio` keeps its own alias crate-private.
type OSStatus = i32;

#[derive(Debug)]
struct CaError {
    what: &'static str,
    status: OSStatus,
}

impl fmt::Display for CaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Core Audio statuses are mostly four-char codes; the raw i32 alone
        // is impossible to look up.
        let b = (self.status as u32).to_be_bytes();
        if b.iter().all(|c| c.is_ascii_graphic()) {
            write!(
                f,
                "{} failed: '{}' ({})",
                self.what,
                String::from_utf8_lossy(&b),
                self.status
            )
        } else {
            write!(f, "{} failed: OSStatus {}", self.what, self.status)
        }
    }
}

impl Error for CaError {}

fn ck(what: &'static str, status: OSStatus) -> Result<(), CaError> {
    if status == 0 {
        Ok(())
    } else {
        Err(CaError { what, status })
    }
}

// ------------------------------------------------------ property helpers ---

const SYSTEM: AudioObjectID = kAudioObjectSystemObject as AudioObjectID;

fn addr(
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain,
    }
}

fn global(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    addr(selector, kAudioObjectPropertyScopeGlobal)
}

/// Read a fixed-size property into `T`.
fn get_prop<T: Copy>(
    obj: AudioObjectID,
    mut a: AudioObjectPropertyAddress,
    what: &'static str,
) -> Result<T, CaError> {
    let mut out = MaybeUninit::<T>::uninit();
    let mut size = size_of::<T>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            obj,
            NonNull::from(&mut a),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::new(out.as_mut_ptr().cast()).unwrap(),
        )
    };
    ck(what, status)?;
    Ok(unsafe { out.assume_init() })
}

/// Read a variable-length array property.
fn get_prop_vec<T: Copy>(
    obj: AudioObjectID,
    mut a: AudioObjectPropertyAddress,
    what: &'static str,
) -> Result<Vec<T>, CaError> {
    let mut size = 0u32;
    ck(what, unsafe {
        AudioObjectGetPropertyDataSize(obj, NonNull::from(&mut a), 0, null(), NonNull::from(&mut size))
    })?;
    let count = size as usize / size_of::<T>();
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut out: Vec<T> = Vec::with_capacity(count);
    let status = unsafe {
        AudioObjectGetPropertyData(
            obj,
            NonNull::from(&mut a),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::new(out.as_mut_ptr().cast()).unwrap(),
        )
    };
    ck(what, status)?;
    unsafe { out.set_len(size as usize / size_of::<T>()) };
    Ok(out)
}

/// Read a CFString-valued property. Core Audio hands these out at +1, and
/// `Retained::from_raw` takes over that reference (CFString is toll-free
/// bridged to NSString, so the ObjC side can own it).
fn get_string(obj: AudioObjectID, a: AudioObjectPropertyAddress) -> Option<String> {
    let ptr: *mut NSString = get_prop(obj, a, "AudioObjectGetPropertyData(string)").ok()?;
    let s = unsafe { Retained::from_raw(ptr) }?;
    Some(s.to_string())
}

/// `&T` -> `&AnyObject` for stuffing typed objects into an untyped container.
fn erase<T: Message>(x: &T) -> &AnyObject {
    unsafe { &*(x as *const T as *const AnyObject) }
}

fn nsstr(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

fn nskey(c: &CStr) -> Retained<NSString> {
    NSString::from_str(c.to_str().expect("Core Audio keys are ASCII"))
}

// ------------------------------------------------------------ ring buffer ---

const RING_CAP: usize = 1 << 15; // ~0.68 s at 48 kHz — plenty of slack

/// Single-producer/single-consumer ring. The producer is the Core Audio
/// IOProc, which runs on a realtime thread and must never block, so nothing
/// here locks: the consumer publishes its read index with a release store and
/// the producer only ever reads it to check for overrun.
struct Ring {
    buf: UnsafeCell<Box<[f32]>>,
    write: AtomicUsize,
    read: AtomicUsize,
    dropped: AtomicUsize,
}

// SAFETY: exactly one producer (the IOProc) touches `write`, exactly one
// consumer touches `read`, and the slot a given index maps to is only
// accessed by one side at a time thanks to the index comparison below.
unsafe impl Send for Ring {}
unsafe impl Sync for Ring {}

impl Ring {
    fn new() -> Self {
        Self {
            buf: UnsafeCell::new(vec![0.0; RING_CAP].into_boxed_slice()),
            write: AtomicUsize::new(0),
            read: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
        }
    }

    /// Producer side — IOProc only.
    fn push(&self, sample: f32) {
        let w = self.write.load(Ordering::Relaxed);
        if w.wrapping_sub(self.read.load(Ordering::Acquire)) >= RING_CAP {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        unsafe { (*self.buf.get())[w & (RING_CAP - 1)] = sample };
        self.write.store(w.wrapping_add(1), Ordering::Release);
    }

    /// Consumer side — capture thread only.
    fn drain(&self, out: &mut Vec<f32>) -> usize {
        let w = self.write.load(Ordering::Acquire);
        let mut r = self.read.load(Ordering::Relaxed);
        let n = w.wrapping_sub(r);
        for _ in 0..n {
            out.push(unsafe { (*self.buf.get())[r & (RING_CAP - 1)] });
            r = r.wrapping_add(1);
        }
        self.read.store(r, Ordering::Release);
        n
    }
}

/// IOProc: mix every input channel down to mono and hand it to the ring.
/// Handles both interleaved (one buffer, N channels) and non-interleaved
/// (N buffers, one channel each) layouts, which is what taps and input
/// devices respectively tend to deliver.
unsafe extern "C-unwind" fn io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client: *mut c_void,
) -> OSStatus {
    if client.is_null() {
        return 0;
    }
    let ring = unsafe { &*(client as *const Ring) };
    let list = unsafe { input.as_ref() };
    let n_buffers = list.mNumberBuffers as usize;
    if n_buffers == 0 {
        return 0;
    }
    let buffers = unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), n_buffers) };

    // One-shot wiring report. Not realtime-safe, but it fires exactly once.
    static REPORTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !REPORTED.swap(true, Ordering::Relaxed) {
        for (i, b) in buffers.iter().enumerate() {
            eprintln!(
                "[vizzy-audio] ioproc buffer {i}: {} ch, {} bytes",
                b.mNumberChannels, b.mDataByteSize
            );
        }
    }

    let mut frames = usize::MAX;
    let mut channels = 0usize;
    for b in buffers {
        if b.mData.is_null() || b.mNumberChannels == 0 {
            continue;
        }
        let ch = b.mNumberChannels as usize;
        frames = frames.min(b.mDataByteSize as usize / (4 * ch));
        channels += ch;
    }
    if channels == 0 || frames == 0 || frames == usize::MAX {
        return 0;
    }

    for i in 0..frames {
        let mut sum = 0.0f32;
        for b in buffers {
            if b.mData.is_null() || b.mNumberChannels == 0 {
                continue;
            }
            let ch = b.mNumberChannels as usize;
            let data = b.mData as *const f32;
            for c in 0..ch {
                sum += unsafe { *data.add(i * ch + c) };
            }
        }
        ring.push(sum / channels as f32);
    }
    0
}

// ---------------------------------------------------------------- session ---

/// Owns every Core Audio object a capture run creates, so that an error path
/// or a source switch tears them down in the right order.
struct Session {
    ring: Arc<Ring>,
    device: AudioObjectID,
    proc_id: AudioDeviceIOProcID,
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    /// Raw `Arc<Ring>` handed to the IOProc as its client pointer.
    client: *mut Arc<Ring>,
    running: bool,
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            if self.running {
                AudioDeviceStop(self.device, self.proc_id);
            }
            if self.proc_id.is_some() {
                AudioDeviceDestroyIOProcID(self.device, self.proc_id);
            }
            if self.aggregate != 0 {
                AudioHardwareDestroyAggregateDevice(self.aggregate);
            }
            if self.tap != 0 {
                AudioHardwareDestroyProcessTap(self.tap);
            }
            if !self.client.is_null() {
                drop(Box::from_raw(self.client));
            }
        }
        let dropped = self.ring.dropped.load(Ordering::Relaxed);
        if dropped > 0 {
            eprintln!("[vizzy-audio] ring overrun: {dropped} samples dropped");
        }
    }
}

impl Session {
    /// Attach an IOProc to `device` and start it.
    fn start(mut self, device: AudioObjectID) -> Result<Self, Box<dyn Error>> {
        self.device = device;
        let client = Box::into_raw(Box::new(self.ring.clone()));
        self.client = client;

        let mut proc_id: AudioDeviceIOProcID = None;
        ck("AudioDeviceCreateIOProcID", unsafe {
            AudioDeviceCreateIOProcID(
                device,
                Some(io_proc),
                // The IOProc dereferences this as `*const Ring`, so hand it
                // the Arc's target rather than the Arc itself.
                Arc::as_ptr(&*client) as *mut c_void,
                NonNull::from(&mut proc_id),
            )
        })?;
        self.proc_id = proc_id;

        ck("AudioDeviceStart", unsafe {
            AudioDeviceStart(device, proc_id)
        })?;
        self.running = true;
        Ok(self)
    }
}

// ------------------------------------------------------- device discovery ---

fn all_devices() -> Result<Vec<AudioObjectID>, CaError> {
    get_prop_vec(
        SYSTEM,
        global(kAudioHardwarePropertyDevices),
        "kAudioHardwarePropertyDevices",
    )
}

fn device_uid(device: AudioObjectID) -> Option<String> {
    get_string(device, global(kAudioDevicePropertyDeviceUID))
}

fn device_name(device: AudioObjectID) -> String {
    get_string(device, global(kAudioObjectPropertyName)).unwrap_or_else(|| format!("Device {device}"))
}

/// Number of streams in a scope — 0 means the device cannot do that direction.
fn stream_count(device: AudioObjectID, scope: AudioObjectPropertyScope) -> usize {
    get_prop_vec::<AudioObjectID>(
        device,
        addr(kAudioDevicePropertyStreams, scope),
        "kAudioDevicePropertyStreams",
    )
    .map(|v| v.len())
    .unwrap_or(0)
}

fn default_device(selector: AudioObjectPropertySelector) -> Result<AudioObjectID, CaError> {
    get_prop(SYSTEM, global(selector), "default device")
}

fn device_by_uid(uid: &str) -> Option<AudioObjectID> {
    all_devices()
        .ok()?
        .into_iter()
        .find(|d| device_uid(*d).as_deref() == Some(uid))
}

/// Resolve a frontend-supplied device id, falling back to the default when it
/// is empty or no longer present (devices come and go).
fn resolve_device(
    device_id: Option<&str>,
    default_selector: AudioObjectPropertySelector,
) -> Result<AudioObjectID, Box<dyn Error>> {
    if let Some(uid) = device_id.filter(|s| !s.is_empty()) {
        if let Some(dev) = device_by_uid(uid) {
            return Ok(dev);
        }
        eprintln!("[vizzy-audio] device '{uid}' is gone — using the default instead");
    }
    Ok(default_device(default_selector)?)
}

pub(super) fn list_sources() -> Result<Vec<SourceInfo>, String> {
    (|| -> Result<Vec<SourceInfo>, Box<dyn Error>> {
        let default_out = default_device(kAudioHardwarePropertyDefaultOutputDevice).unwrap_or(0);
        let default_in = default_device(kAudioHardwarePropertyDefaultInputDevice).unwrap_or(0);

        let mut sources = Vec::new();
        for device in all_devices()? {
            let Some(uid) = device_uid(device) else {
                continue;
            };
            let name = device_name(device);
            // An output device is a "loopback" source here: we tap whatever
            // the system routes to it.
            if stream_count(device, kAudioObjectPropertyScopeOutput) > 0 {
                sources.push(SourceInfo {
                    id: uid.clone(),
                    name: name.clone(),
                    kind: "loopback",
                    is_default: device == default_out,
                });
            }
            if stream_count(device, kAudioObjectPropertyScopeInput) > 0 {
                sources.push(SourceInfo {
                    id: uid,
                    name,
                    kind: "input",
                    is_default: device == default_in,
                });
            }
        }
        eprintln!("[vizzy-audio] list_sources -> {} devices", sources.len());
        Ok(sources)
    })()
    .map_err(|e| e.to_string())
}

// ------------------------------------------------------ process discovery ---

const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

extern "C" {
    fn proc_pidpath(pid: c_int, buffer: *mut c_void, buffersize: u32) -> c_int;
}

/// Human-readable name for a pid: prefer the `.app` bundle name over the
/// executable, so the picker shows "Spotify" and not "Spotify Helper".
fn process_name(pid: u32) -> Option<String> {
    let mut buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
    let len = unsafe { proc_pidpath(pid as c_int, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    buf.truncate(len as usize);
    let path = String::from_utf8_lossy(&buf).into_owned();
    if let Some(app) = path
        .split('/')
        .find(|c| c.ends_with(".app"))
        .and_then(|c| c.strip_suffix(".app"))
    {
        return Some(app.to_string());
    }
    path.rsplit('/').next().map(|s| s.to_string())
}

fn process_objects() -> Result<Vec<AudioObjectID>, CaError> {
    get_prop_vec(
        SYSTEM,
        global(kAudioHardwarePropertyProcessObjectList),
        "kAudioHardwarePropertyProcessObjectList",
    )
}

/// Core Audio's process object for a pid, if that process has ever had audio.
fn process_object_for_pid(pid: u32) -> Option<AudioObjectID> {
    let mut a = global(kAudioHardwarePropertyTranslatePIDToProcessObject);
    let pid = pid as c_int;
    let mut out: AudioObjectID = 0;
    let mut size = size_of::<AudioObjectID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            SYSTEM,
            NonNull::from(&mut a),
            size_of::<c_int>() as u32,
            (&pid as *const c_int).cast(),
            NonNull::from(&mut size),
            NonNull::from(&mut out).cast(),
        )
    };
    (status == 0 && out != 0).then_some(out)
}

pub(super) fn list_apps() -> Result<Vec<AppInfo>, String> {
    (|| -> Result<Vec<AppInfo>, Box<dyn Error>> {
        let own_pid = std::process::id();
        let mut apps: Vec<AppInfo> = Vec::new();

        for object in process_objects()? {
            let Ok(pid) = get_prop::<c_int>(object, global(kAudioProcessPropertyPID), "pid") else {
                continue;
            };
            if pid <= 0 || pid as u32 == own_pid {
                continue;
            }
            let pid = pid as u32;
            // Only processes that can play audio are useful as a tap target.
            let plays = get_prop::<u32>(
                object,
                global(kAudioProcessPropertyIsRunningOutput),
                "isRunningOutput",
            )
            .unwrap_or(0)
                != 0;
            let name = process_name(pid)
                .or_else(|| get_string(object, global(kAudioProcessPropertyBundleID)))
                .unwrap_or_else(|| format!("PID {pid}"));
            apps.push(AppInfo {
                pid,
                name,
                active: plays,
            });
        }

        apps.sort_by(|a, b| {
            b.active
                .cmp(&a.active)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        apps.dedup_by(|a, b| a.pid == b.pid);
        eprintln!("[vizzy-audio] list_apps -> {} apps", apps.len());
        Ok(apps)
    })()
    .map_err(|e| e.to_string())
}

// -------------------------------------------------------------- tap setup ---

fn check_float32(format: &AudioStreamBasicDescription, what: &str) -> Result<(), Box<dyn Error>> {
    if format.mFormatFlags & kAudioFormatFlagIsFloat == 0 || format.mBitsPerChannel != 32 {
        return Err(format!(
            "{what} is not 32-bit float (flags {:#x}, {} bits) — unsupported",
            format.mFormatFlags, format.mBitsPerChannel
        )
        .into());
    }
    Ok(())
}

enum TapTarget {
    /// Everything the system plays, minus vizzy itself.
    Global,
    /// A single process.
    Process(AudioObjectID),
}

/// Create the tap, wrap it in a private aggregate device and start reading.
/// Returns the running session plus the tap's sample rate.
fn open_tap(
    target: TapTarget,
    output_device: AudioObjectID,
) -> Result<(Session, f64), Box<dyn Error>> {
    let description = unsafe {
        let alloc = CATapDescription::alloc();
        match target {
            TapTarget::Global => {
                // Excluding our own process object keeps a future
                // sound-emitting scene from feeding back into the analyzer.
                let own = process_object_for_pid(std::process::id());
                let excluded: Vec<Retained<NSNumber>> = own
                    .into_iter()
                    .map(|o| NSNumber::numberWithInt(o as c_int))
                    .collect();
                CATapDescription::initStereoGlobalTapButExcludeProcesses(
                    alloc,
                    &NSArray::from_retained_slice(&excluded),
                )
            }
            TapTarget::Process(object) => {
                let included = [NSNumber::numberWithInt(object as c_int)];
                CATapDescription::initStereoMixdownOfProcesses(
                    alloc,
                    &NSArray::from_retained_slice(&included),
                )
            }
        }
    };
    unsafe {
        description.setName(&nsstr("vizzy capture"));
        // Private: the tap must not show up as a device for other apps.
        description.setPrivate(true);
        // Unmuted: tapping must not silence what the user is listening to.
        description.setMuteBehavior(CATapMuteBehavior::Unmuted);
    }

    let mut tap: AudioObjectID = 0;
    ck("AudioHardwareCreateProcessTap", unsafe {
        AudioHardwareCreateProcessTap(Some(&description), &mut tap)
    })
    .map_err(|e| -> Box<dyn Error> {
        Box::from(format!(
            "{e} — needs macOS 14.2+ and the audio recording permission \
             (System Settings > Privacy & Security)"
        ))
    })?;

    // From here on the tap must be destroyed on every exit path.
    let mut session = Session {
        ring: Arc::new(Ring::new()),
        device: 0,
        proc_id: None,
        tap,
        aggregate: 0,
        client: std::ptr::null_mut(),
        running: false,
    };

    let tap_uid = get_string(tap, global(kAudioTapPropertyUID))
        .ok_or("tap has no UID")?;
    let format: AudioStreamBasicDescription =
        get_prop(tap, global(kAudioTapPropertyFormat), "kAudioTapPropertyFormat")?;
    check_float32(&format, "tap format")?;

    let out_uid = device_uid(output_device).ok_or("output device has no UID")?;

    // A private aggregate device is the only way to actually read a tap: the
    // output device provides the clock (sub-device list + main sub-device)
    // and the tap sits in the tap list.
    let sub_tap = NSDictionary::from_slices(
        &[
            &*nskey(kAudioSubTapUIDKey),
            &*nskey(kAudioSubTapDriftCompensationKey),
        ],
        &[
            erase(&*nsstr(&tap_uid)),
            erase(&*NSNumber::numberWithBool(true)),
        ],
    );
    let tap_list = NSArray::from_slice(&[erase(&*sub_tap)]);
    let sub_device =
        NSDictionary::from_slices(&[&*nskey(kAudioSubDeviceUIDKey)], &[erase(&*nsstr(&out_uid))]);
    let sub_devices = NSArray::from_slice(&[erase(&*sub_device)]);

    let description = NSDictionary::from_slices(
        &[
            &*nskey(kAudioAggregateDeviceNameKey),
            &*nskey(kAudioAggregateDeviceUIDKey),
            &*nskey(kAudioAggregateDeviceMainSubDeviceKey),
            &*nskey(kAudioAggregateDeviceIsPrivateKey),
            &*nskey(kAudioAggregateDeviceIsStackedKey),
            &*nskey(kAudioAggregateDeviceTapAutoStartKey),
            &*nskey(kAudioAggregateDeviceSubDeviceListKey),
            &*nskey(kAudioAggregateDeviceTapListKey),
        ],
        &[
            erase(&*nsstr("vizzy Capture")),
            erase(&*nsstr(&format!("com.vizzy.desktop.aggregate.{tap_uid}"))),
            erase(&*nsstr(&out_uid)),
            erase(&*NSNumber::numberWithBool(true)),
            erase(&*NSNumber::numberWithBool(false)),
            erase(&*NSNumber::numberWithBool(true)),
            erase(&*sub_devices),
            erase(&*tap_list),
        ],
    );
    // NSDictionary is toll-free bridged to CFDictionary.
    let cf: &CFDictionary = unsafe { &*Retained::as_ptr(&description).cast::<CFDictionary>() };

    let mut aggregate: AudioObjectID = 0;
    ck("AudioHardwareCreateAggregateDevice", unsafe {
        AudioHardwareCreateAggregateDevice(cf, NonNull::from(&mut aggregate))
    })?;
    session.aggregate = aggregate;

    eprintln!(
        "[vizzy-audio] tap on '{}' — {:.0} Hz, {} ch",
        device_name(output_device),
        format.mSampleRate,
        format.mChannelsPerFrame
    );
    let session = session.start(aggregate)?;
    Ok((session, format.mSampleRate))
}

/// Plain input capture (microphone, line-in, or a virtual device such as
/// BlackHole) — no tap, the IOProc sits directly on the device.
fn open_input(device: AudioObjectID) -> Result<(Session, f64), Box<dyn Error>> {
    let streams = get_prop_vec::<AudioObjectID>(
        device,
        addr(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput),
        "kAudioDevicePropertyStreams",
    )?;
    let stream = *streams.first().ok_or("device has no input stream")?;
    let format: AudioStreamBasicDescription = get_prop(
        stream,
        global(kAudioStreamPropertyVirtualFormat),
        "kAudioStreamPropertyVirtualFormat",
    )?;
    check_float32(&format, "input format")?;

    let session = Session {
        ring: Arc::new(Ring::new()),
        device: 0,
        proc_id: None,
        tap: 0,
        aggregate: 0,
        client: std::ptr::null_mut(),
        running: false,
    };

    eprintln!(
        "[vizzy-audio] input '{}' — {:.0} Hz, {} ch",
        device_name(device),
        format.mSampleRate,
        format.mChannelsPerFrame
    );
    let session = session.start(device)?;
    Ok((session, format.mSampleRate))
}

// ----------------------------------------------------------- capture loop ---

pub(super) fn capture_loop(
    shared: &SharedAnalysis,
    spec: &SourceSpec,
    rx: &Receiver<SourceSpec>,
    params: &SharedParams,
) -> Result<Option<SourceSpec>, Box<dyn Error>> {
    let (session, sample_rate) = match spec {
        SourceSpec::Loopback { device_id } => {
            let device = resolve_device(
                device_id.as_deref(),
                kAudioHardwarePropertyDefaultOutputDevice,
            )?;
            open_tap(TapTarget::Global, device)?
        }
        SourceSpec::App { pid, name } => {
            eprintln!("[vizzy-audio] capturing app '{name}' (pid {pid})");
            let object = process_object_for_pid(*pid)
                .ok_or_else(|| format!("'{name}' (pid {pid}) has no Core Audio process object"))?;
            let device = default_device(kAudioHardwarePropertyDefaultOutputDevice)?;
            open_tap(TapTarget::Process(object), device)?
        }
        SourceSpec::Input { device_id } => {
            let device = resolve_device(
                device_id.as_deref(),
                kAudioHardwarePropertyDefaultInputDevice,
            )?;
            open_input(device)?
        }
    };

    let mut analyzer = Analyzer::new(params.clone(), sample_rate as usize);
    let mut pending: Vec<f32> = Vec::with_capacity(4096);
    let mut last_audio = Instant::now();

    loop {
        if session.ring.drain(&mut pending) > 0 {
            last_audio = Instant::now();
            for sample in pending.drain(..) {
                analyzer.push(sample);
                // Per sample rather than per batch: a batch can span more
                // than one hop, and skipping hops would thin out the frames.
                analyzer.maybe_publish(shared);
            }
        } else if last_audio.elapsed() > Duration::from_millis(250) {
            // The IOProc stopped firing (device switched away, tap died).
            analyzer.decay_publish(shared);
        }

        match rx.recv_timeout(Duration::from_millis(4)) {
            Ok(next) => return Ok(Some(next)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}
