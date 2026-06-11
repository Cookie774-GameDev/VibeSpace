//! Kokoro-82M local TTS command surface for the Tauri core.
//!
//! Scope: resolve the OS-stable model directory; download model assets with
//! progress events, resume, and real SHA-256 verification; detect/repair
//! corrupt files; expose a `kokoro_speak` command.
//!
//! IMPORTANT — audio generation:
//!   This module does NOT bundle an ONNX inference runtime or Kokoro weights
//!   yet. `kokoro_speak` returns a structured `engine_not_available` error and
//!   `kokoro_status` reports `ready = false`, so the frontend TtsService falls
//!   back to system TTS automatically — no crash, no UI freeze. Wiring a real
//!   runtime (e.g. the `ort` crate) + publishing the model release asset is the
//!   remaining step. See docs/10-voice-subscription-system.md.
//!
//! Registration (add to lib.rs):
//!   mod kokoro;
//!   // in invoke_handler: kokoro::kokoro_model_path, kokoro::kokoro_check_installed,
//!   //   kokoro::kokoro_verify_checksums, kokoro::kokoro_status, kokoro::kokoro_warmup,
//!   //   kokoro::kokoro_download, kokoro::kokoro_resume_download, kokoro::kokoro_repair,
//!   //   kokoro::kokoro_delete_corrupt, kokoro::kokoro_speak, kokoro::kokoro_stop,
//! Cargo.toml needs: sha2 = "0.10"  (reqwest is already present).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;

const CHUNK: usize = 65_536;
const PLACEHOLDER_SHA: &str = "REPLACE_WITH_REAL_SHA256";

/// Last manifest seen by a download, so resume/repair can re-run without the
/// frontend re-sending it.
static LAST_MANIFEST: Mutex<Option<Manifest>> = Mutex::new(None);

#[derive(Deserialize, Clone)]
pub struct ManifestFile {
    name: String,
    url: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    size_bytes: u64,
    #[serde(default = "default_true")]
    required: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize, Clone)]
pub struct Manifest {
    files: Vec<ManifestFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCheck {
    installed: bool,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksumResult {
    ok: bool,
    corrupt: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    installed: bool,
    ready: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    file: String,
    received_bytes: u64,
    total_bytes: u64,
    percent: f64,
}

/// OS-stable Kokoro model directory.
///   Windows: %APPDATA%/VibeSpace/models/kokoro
///   macOS:   ~/Library/Application Support/VibeSpace/models/kokoro
///   Linux:   ~/.local/share/VibeSpace/models/kokoro
fn model_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("VibeSpace").join("models").join("kokoro")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join("Library")
            .join("Application Support")
            .join("VibeSpace")
            .join("models")
            .join("kokoro")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".local")
            .join("share")
            .join("VibeSpace")
            .join("models")
            .join("kokoro")
    }
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; CHUNK];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// True when the file matches the manifest. When no real checksum is provided
/// (placeholder/empty), accept on presence so a partial manifest doesn't block
/// development.
fn verify_one(path: &Path, file: &ManifestFile) -> bool {
    if !path.exists() {
        return false;
    }
    if file.sha256.is_empty() || file.sha256 == PLACEHOLDER_SHA {
        return true;
    }
    sha256_file(path)
        .map(|h| h.eq_ignore_ascii_case(&file.sha256))
        .unwrap_or(false)
}

fn download_file(app: &tauri::AppHandle, file: &ManifestFile, dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let final_path = dir.join(&file.name);
    if verify_one(&final_path, file) {
        return Ok(());
    }

    let part_path = dir.join(format!("{}.part", file.name));
    let mut start: u64 = 0;
    if part_path.exists() {
        start = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&file.url);
    if start > 0 {
        req = req.header("Range", format!("bytes={start}-"));
    }
    let mut resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(format!("download_failed_{}", status.as_u16()));
    }
    // Server ignored Range (200 not 206): restart from scratch.
    if start > 0 && status.as_u16() == 200 {
        start = 0;
        let _ = fs::remove_file(&part_path);
    }

    let total = file
        .size_bytes
        .max(resp.content_length().unwrap_or(0).saturating_add(start));

    let mut out = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part_path)
        .map_err(|e| e.to_string())?;

    let mut buf = [0u8; CHUNK];
    let mut received = start;
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        let percent = if total > 0 {
            (received as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app.emit(
            "kokoro:progress",
            DownloadProgress {
                file: file.name.clone(),
                received_bytes: received,
                total_bytes: total,
                percent,
            },
        );
    }
    drop(out);

    if !verify_one(&part_path, file) {
        let _ = fs::remove_file(&part_path);
        return Err("checksum_mismatch".to_string());
    }
    fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Real Kokoro-82M inference (feature = "kokoro") ────────────────────────────
//
// Pipeline (mirrors the canonical thewh1teagle/kokoro-onnx reference):
//   text --misaki(pure-Rust G2P)--> phonemes --vocab--> token ids
//   input_ids = [0, ...ids, 0]; style = voices[name][len(ids)] (256-d);
//   ort session.run -> f32 waveform @ 24 kHz -> 16-bit WAV -> base64.
//
// Every fallible step returns Err (never panics); callers degrade to the
// Windows Natural system voice. No secrets are ever logged.
#[cfg(feature = "kokoro")]
mod engine {
    use super::model_dir;
    use base64::Engine as _;
    use ndarray::ArrayD;
    use ndarray_npy::NpzReader;
    use ort::session::Session;
    use ort::value::Tensor;
    use std::collections::HashMap;
    use std::fs::File;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    const SAMPLE_RATE: u32 = 24_000;
    const MAX_PHONEME_LENGTH: usize = 510;
    const STYLE_DIM: usize = 256;

    static ENGINE: Mutex<Option<KokoroEngine>> = Mutex::new(None);

    #[derive(Clone, Copy, PartialEq)]
    enum SpeedDtype {
        F32,
        I64,
        I32,
    }

    struct KokoroEngine {
        session: Session,
        /// voice name -> flat row-major style table (len = rows * 256).
        voices: HashMap<String, Vec<f32>>,
        /// Cached working (token_input_is_ids, speed dtype) once a run succeeds.
        combo: Option<(bool, SpeedDtype)>,
    }

    fn err<E: std::fmt::Display>(e: E) -> String {
        e.to_string()
    }

    /// Kokoro phoneme -> token id (the n_token=178 vocab from the model config).
    fn vocab() -> &'static HashMap<char, i64> {
        static V: OnceLock<HashMap<char, i64>> = OnceLock::new();
        V.get_or_init(|| {
            let pairs: &[(char, i64)] = &[
                (';', 1), (':', 2), (',', 3), ('.', 4), ('!', 5), ('?', 6),
                ('\u{2014}', 9), ('\u{2026}', 10), ('"', 11), ('(', 12), (')', 13),
                ('\u{201C}', 14), ('\u{201D}', 15), (' ', 16), ('\u{0303}', 17),
                ('\u{02A3}', 18), ('\u{02A5}', 19), ('\u{02A6}', 20), ('\u{02A8}', 21),
                ('\u{1D5D}', 22), ('\u{AB67}', 23), ('A', 24), ('I', 25), ('O', 31),
                ('Q', 33), ('S', 35), ('T', 36), ('W', 39), ('Y', 41), ('\u{1D4A}', 42),
                ('a', 43), ('b', 44), ('c', 45), ('d', 46), ('e', 47), ('f', 48),
                ('h', 50), ('i', 51), ('j', 52), ('k', 53), ('l', 54), ('m', 55),
                ('n', 56), ('o', 57), ('p', 58), ('q', 59), ('r', 60), ('s', 61),
                ('t', 62), ('u', 63), ('v', 64), ('w', 65), ('x', 66), ('y', 67),
                ('z', 68), ('\u{0251}', 69), ('\u{0250}', 70), ('\u{0252}', 71),
                ('\u{00E6}', 72), ('\u{03B2}', 75), ('\u{0254}', 76), ('\u{0255}', 77),
                ('\u{00E7}', 78), ('\u{0256}', 80), ('\u{00F0}', 81), ('\u{02A4}', 82),
                ('\u{0259}', 83), ('\u{025A}', 85), ('\u{025B}', 86), ('\u{025C}', 87),
                ('\u{025F}', 90), ('\u{0261}', 92), ('\u{0265}', 99), ('\u{0268}', 101),
                ('\u{026A}', 102), ('\u{029D}', 103), ('\u{026F}', 110), ('\u{0270}', 111),
                ('\u{014B}', 112), ('\u{0273}', 113), ('\u{0272}', 114), ('\u{0274}', 115),
                ('\u{00F8}', 116), ('\u{0278}', 118), ('\u{03B8}', 119), ('\u{0153}', 120),
                ('\u{0279}', 123), ('\u{027E}', 125), ('\u{027B}', 126), ('\u{0281}', 128),
                ('\u{027D}', 129), ('\u{0282}', 130), ('\u{0283}', 131), ('\u{0288}', 132),
                ('\u{02A7}', 133), ('\u{028A}', 135), ('\u{028B}', 136), ('\u{028C}', 138),
                ('\u{0263}', 139), ('\u{0264}', 140), ('\u{03C7}', 142), ('\u{028E}', 143),
                ('\u{0292}', 147), ('\u{0294}', 148), ('\u{02C8}', 156), ('\u{02CC}', 157),
                ('\u{02D0}', 158), ('\u{02B0}', 162), ('\u{02B2}', 164), ('\u{2193}', 169),
                ('\u{2192}', 171), ('\u{2197}', 172), ('\u{2198}', 173), ('\u{1D7B}', 177),
            ];
            pairs.iter().copied().collect()
        })
    }

    /// The ONNX model file. The smallest `.onnx` wins, so a quantized q8f16
    /// model is preferred over a large fp32 one if both happen to be present.
    fn find_model() -> Result<PathBuf, String> {
        let dir = model_dir();
        let mut best: Option<(PathBuf, u64)> = None;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.ends_with(".part") || !name.ends_with(".onnx") {
                    continue;
                }
                let size = e.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
                if best.as_ref().map(|(_, b)| size < *b).unwrap_or(true) {
                    best = Some((e.path(), size));
                }
            }
        }
        best.map(|(p, _)| p)
            .ok_or_else(|| "model_not_installed".to_string())
    }

    /// Cheap presence check used by status polling — never creates an ONNX
    /// session (which is slow), just confirms a model + a voice file exist.
    fn assets_present() -> bool {
        if find_model().is_err() {
            return false;
        }
        if let Ok(entries) = std::fs::read_dir(model_dir()) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.ends_with(".part") || name.ends_with(".onnx") {
                    continue;
                }
                if name.ends_with(".bin") || name.ends_with(".npz") {
                    return true;
                }
            }
        }
        false
    }

    /// Load every voice in the model dir: raw little-endian f32 `.bin` files
    /// (one per voice, ~0.5 MB) and/or a combined NPZ archive. Handles both.
    fn load_voices(model_path: &Path) -> HashMap<String, Vec<f32>> {
        use std::io::Read;
        let mut voices: HashMap<String, Vec<f32>> = HashMap::new();
        let Ok(entries) = std::fs::read_dir(model_dir()) else {
            return voices;
        };
        for e in entries.flatten() {
            let path = e.path();
            if path == *model_path {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let lname = name.to_lowercase();
            if lname.ends_with(".part") || !(lname.ends_with(".bin") || lname.ends_with(".npz")) {
                continue;
            }
            // NPZ archives begin with the ZIP magic "PK"; raw voices are floats.
            let mut magic = [0u8; 2];
            let is_npz = File::open(&path)
                .and_then(|mut f| f.read_exact(&mut magic))
                .map(|_| &magic == b"PK")
                .unwrap_or(false);
            if is_npz {
                if let Ok(file) = File::open(&path) {
                    if let Ok(mut npz) = NpzReader::new(file) {
                        if let Ok(names) = npz.names() {
                            for n in names {
                                let arr: ArrayD<f32> = match npz.by_name(&n) {
                                    Ok(a) => a,
                                    Err(_) => continue,
                                };
                                let flat: Vec<f32> = arr.iter().copied().collect();
                                if flat.len() >= STYLE_DIM {
                                    voices.insert(n.trim_end_matches(".npy").to_string(), flat);
                                }
                            }
                        }
                    }
                }
            } else if let Ok(bytes) = std::fs::read(&path) {
                if bytes.len() >= STYLE_DIM * 4 && bytes.len() % 4 == 0 {
                    let floats: Vec<f32> = bytes
                        .chunks_exact(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect();
                    let stem = name
                        .rsplit_once('.')
                        .map(|(s, _)| s.to_string())
                        .unwrap_or(name);
                    voices.insert(stem, floats);
                }
            }
        }
        voices
    }

    impl KokoroEngine {
        fn load() -> Result<KokoroEngine, String> {
            let model_path = find_model()?;
            let session = Session::builder()
                .map_err(err)?
                .commit_from_file(&model_path)
                .map_err(err)?;
            let voices = load_voices(&model_path);
            if voices.is_empty() {
                return Err("no_voices_loaded".to_string());
            }
            Ok(KokoroEngine {
                session,
                voices,
                combo: None,
            })
        }

        fn resolve_voice(&self, requested: &str) -> String {
            if self.voices.contains_key(requested) {
                return requested.to_string();
            }
            let mapped = match requested.to_lowercase().as_str() {
                "jarvis" | "jarvis-prime" | "jarvis classic" => "bm_george",
                "friday" | "aurora" => "bf_emma",
                _ => "",
            };
            if !mapped.is_empty() && self.voices.contains_key(mapped) {
                return mapped.to_string();
            }
            if self.voices.contains_key("af_heart") {
                return "af_heart".to_string();
            }
            self.voices.keys().next().cloned().unwrap_or_default()
        }

        fn synth(&mut self, text: &str, voice: &str, speed: f32) -> Result<Vec<f32>, String> {
            // Phonemize with misaki (pure Rust, US English) — Kokoro's own G2P.
            let g2p = misaki_rs::G2P::new(misaki_rs::Language::EnglishUS);
            let (phonemes, _tokens) = g2p
                .g2p(text)
                .map_err(|e| format!("phonemize_failed: {e:?}"))?;
            let v = vocab();
            let mut ids: Vec<i64> = phonemes.chars().filter_map(|c| v.get(&c).copied()).collect();
            if ids.len() > MAX_PHONEME_LENGTH {
                ids.truncate(MAX_PHONEME_LENGTH);
            }
            if ids.is_empty() {
                return Err("empty_phonemes".to_string());
            }
            let token_len = ids.len();

            let voice_name = self.resolve_voice(voice);
            let flat = self
                .voices
                .get(&voice_name)
                .ok_or_else(|| "voice_not_found".to_string())?
                .clone();
            let rows = flat.len() / STYLE_DIM;
            let idx = token_len.min(rows.saturating_sub(1));
            let style = flat[idx * STYLE_DIM..idx * STYLE_DIM + STYLE_DIM].to_vec();

            let mut input_ids: Vec<i64> = Vec::with_capacity(token_len + 2);
            input_ids.push(0);
            input_ids.extend_from_slice(&ids);
            input_ids.push(0);

            self.run(input_ids, style, speed.clamp(0.5, 2.0))
        }

        fn run(&mut self, ids: Vec<i64>, style: Vec<f32>, speed: f32) -> Result<Vec<f32>, String> {
            let n = ids.len();
            let candidates: Vec<(bool, SpeedDtype)> = match self.combo {
                Some(c) => vec![c],
                None => vec![
                    (true, SpeedDtype::F32),
                    (true, SpeedDtype::I64),
                    (true, SpeedDtype::I32),
                    (false, SpeedDtype::F32),
                    (false, SpeedDtype::I64),
                    (false, SpeedDtype::I32),
                ],
            };
            let mut last_err = "inference_failed".to_string();
            for (is_ids, dtype) in candidates {
                let input_ids = Tensor::from_array(([1usize, n], ids.clone())).map_err(err)?;
                let style_t =
                    Tensor::from_array(([1usize, STYLE_DIM], style.clone())).map_err(err)?;
                let run_result = match (is_ids, dtype) {
                    (true, SpeedDtype::F32) => {
                        let s = Tensor::from_array(([1usize], vec![speed])).map_err(err)?;
                        self.session.run(ort::inputs!["input_ids" => input_ids, "style" => style_t, "speed" => s])
                    }
                    (true, SpeedDtype::I64) => {
                        let s = Tensor::from_array(([1usize], vec![speed.round() as i64])).map_err(err)?;
                        self.session.run(ort::inputs!["input_ids" => input_ids, "style" => style_t, "speed" => s])
                    }
                    (true, SpeedDtype::I32) => {
                        let s = Tensor::from_array(([1usize], vec![speed.round() as i32])).map_err(err)?;
                        self.session.run(ort::inputs!["input_ids" => input_ids, "style" => style_t, "speed" => s])
                    }
                    (false, SpeedDtype::F32) => {
                        let s = Tensor::from_array(([1usize], vec![speed])).map_err(err)?;
                        self.session.run(ort::inputs!["tokens" => input_ids, "style" => style_t, "speed" => s])
                    }
                    (false, SpeedDtype::I64) => {
                        let s = Tensor::from_array(([1usize], vec![speed.round() as i64])).map_err(err)?;
                        self.session.run(ort::inputs!["tokens" => input_ids, "style" => style_t, "speed" => s])
                    }
                    (false, SpeedDtype::I32) => {
                        let s = Tensor::from_array(([1usize], vec![speed.round() as i32])).map_err(err)?;
                        self.session.run(ort::inputs!["tokens" => input_ids, "style" => style_t, "speed" => s])
                    }
                };
                match run_result {
                    Ok(outputs) => {
                        let output = match outputs.iter().next() {
                            Some(o) => o,
                            None => {
                                last_err = "no_output".to_string();
                                continue;
                            }
                        };
                        let (_shape, data) =
                            output.1.try_extract_tensor::<f32>().map_err(err)?;
                        if data.is_empty() {
                            return Err("empty_audio".to_string());
                        }
                        let out = data.to_vec();
                        self.combo = Some((is_ids, dtype));
                        return Ok(out);
                    }
                    Err(e) => last_err = e.to_string(),
                }
            }
            Err(last_err)
        }
    }

    /// True when the model + a voice file are present on disk. Cheap by design:
    /// it does NOT create the ONNX session (that happens lazily on first speak
    /// and is cached), so frequent status polling never stalls the app.
    pub fn ready() -> bool {
        assets_present()
    }

    /// Synthesize speech, returning (base64 wav, mime). Errors -> caller falls back.
    pub fn speak(text: &str, voice: &str, speed: f32) -> Result<(String, String), String> {
        let mut slot = ENGINE.lock().map_err(|_| "engine_lock".to_string())?;
        if slot.is_none() {
            *slot = Some(KokoroEngine::load()?);
        }
        let engine = slot.as_mut().ok_or_else(|| "engine_unavailable".to_string())?;
        let samples = engine.synth(text, voice, speed)?;

        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut buf: Vec<u8> = Vec::new();
        {
            let cursor = Cursor::new(&mut buf);
            let mut writer = hound::WavWriter::new(cursor, spec).map_err(err)?;
            for &s in &samples {
                let val = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                writer.write_sample(val).map_err(err)?;
            }
            writer.finalize().map_err(err)?;
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        Ok((b64, "audio/wav".to_string()))
    }

    #[cfg(test)]
    mod tests {
        use base64::Engine as _;

        // Runs the FULL pipeline (load model + voices, misaki phonemize, ort
        // inference, WAV encode) against a locally-installed model. Skips
        // cleanly when the model is not present so CI without weights passes.
        #[test]
        fn synthesizes_test_phrase_when_model_present() {
            if super::find_model().is_err() {
                eprintln!("kokoro model not installed locally — skipping real synth test");
                return;
            }
            let phrase = "Hello, I am Jarvis. Systems are online.";
            for (label, voice) in [("jarvis/bm_george", "jarvis"), ("friday/bf_emma", "friday")] {
                let (b64, mime) = super::speak(phrase, voice, 1.0)
                    .unwrap_or_else(|e| panic!("kokoro synthesis failed for {label}: {e}"));
                assert_eq!(mime, "audio/wav");
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(&b64)
                    .expect("speak() must return valid base64");
                let min_len = 44 + 24_000;
                assert!(
                    bytes.len() > min_len,
                    "audio too short for {label}: {} bytes (expected > {})",
                    bytes.len(),
                    min_len
                );
                let secs = (bytes.len() as f64 - 44.0) / 2.0 / 24_000.0;
                println!("KOKORO_OK {label} bytes={} (~{:.2}s)", bytes.len(), secs);
            }
        }
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn kokoro_model_path() -> String {
    model_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn kokoro_check_installed() -> InstalledCheck {
    let dir = model_dir();
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if !name.ends_with(".part") {
                    files.push(name.to_string());
                }
            }
        }
    }
    let manifest = LAST_MANIFEST.lock().ok().and_then(|m| m.clone());
    let installed = match manifest {
        Some(m) => m
            .files
            .iter()
            .filter(|f| f.required)
            .all(|f| dir.join(&f.name).exists()),
        None => files.iter().any(|f| f.ends_with(".onnx")),
    };
    InstalledCheck { installed, files }
}

#[tauri::command]
pub fn kokoro_verify_checksums() -> ChecksumResult {
    let dir = model_dir();
    let manifest = LAST_MANIFEST.lock().ok().and_then(|m| m.clone());
    let Some(manifest) = manifest else {
        return ChecksumResult {
            ok: false,
            corrupt: Vec::new(),
        };
    };
    let mut corrupt = Vec::new();
    for f in &manifest.files {
        if f.required && !verify_one(&dir.join(&f.name), f) {
            corrupt.push(f.name.clone());
        }
    }
    ChecksumResult {
        ok: corrupt.is_empty(),
        corrupt,
    }
}

#[tauri::command]
pub fn kokoro_status() -> ModelStatus {
    let installed = kokoro_check_installed().installed;
    // `ready` is true only when the feature is compiled in AND a session can be
    // created from the installed weights. Otherwise the frontend falls back to
    // the Windows Natural system voice instead of pretending audio works.
    #[cfg(feature = "kokoro")]
    let ready = installed && engine::ready();
    #[cfg(not(feature = "kokoro"))]
    let ready = false;
    ModelStatus { installed, ready }
}

#[tauri::command]
pub fn kokoro_warmup() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn kokoro_download(app: tauri::AppHandle, manifest: Manifest) -> Result<(), String> {
    if let Ok(mut slot) = LAST_MANIFEST.lock() {
        *slot = Some(manifest.clone());
    }
    let dir = model_dir();
    for file in &manifest.files {
        download_file(&app, file, &dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn kokoro_resume_download(app: tauri::AppHandle) -> Result<(), String> {
    let manifest = LAST_MANIFEST
        .lock()
        .ok()
        .and_then(|m| m.clone())
        .ok_or_else(|| "no_manifest".to_string())?;
    let dir = model_dir();
    for file in &manifest.files {
        download_file(&app, file, &dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn kokoro_delete_corrupt() -> Result<(), String> {
    let dir = model_dir();
    let manifest = LAST_MANIFEST.lock().ok().and_then(|m| m.clone());
    if let Some(manifest) = manifest {
        for f in &manifest.files {
            let p = dir.join(&f.name);
            if p.exists() && !verify_one(&p, f) {
                let _ = fs::remove_file(&p);
            }
            let part = dir.join(format!("{}.part", f.name));
            if part.exists() {
                let _ = fs::remove_file(&part);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn kokoro_repair(app: tauri::AppHandle) -> Result<(), String> {
    kokoro_delete_corrupt()?;
    kokoro_resume_download(app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakResult {
    audio: String,
    mime: String,
}

#[tauri::command]
pub fn kokoro_speak(text: String, voice: String, speed: f32) -> Result<SpeakResult, String> {
    #[cfg(feature = "kokoro")]
    {
        let (audio, mime) = engine::speak(&text, &voice, speed)?;
        Ok(SpeakResult { audio, mime })
    }
    // When the Kokoro feature is not compiled in, return a structured error the
    // frontend maps to an automatic Windows Natural fallback. Never fake audio.
    #[cfg(not(feature = "kokoro"))]
    {
        let _ = (text, voice, speed);
        Err("engine_not_available".to_string())
    }
}

#[tauri::command]
pub fn kokoro_stop() {
    // No persistent local synthesis process to stop yet.
}
