//! Transcribe with an installed Bark model by driving its official loader.
//!
//! The loader is Python, so this writes a WAV, runs the runtime's interpreter,
//! and reads back one marked result line. Nothing is inferred from raw stdout.

use crate::voice_host::{blocking, run_with_deadline, tail};
use crate::voice_models::{installed_dirs, read_manifest};
use crate::voice_paths::{app_voice_root, runtime_dir};
use crate::voice_runtime::python_exe;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::AppHandle;

const RESULT_PREFIX: &str = "RESULT ";

/// Inference on CPU is slow but not unbounded; a wedged loader must not hang the app.
const TRANSCRIBE_DEADLINE: Duration = Duration::from_secs(900);

const DRIVER: &str = r#"
import importlib.util, json, sys
from pathlib import Path
import soundfile as sf

model_dir, weights, loader_name, audio, device, pad = sys.argv[1:7]
spec = importlib.util.spec_from_file_location("official_bark", str(Path(model_dir) / loader_name))
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)
model = loader.load_model(str(Path(model_dir) / weights), device=device)
wave, sr = sf.read(audio, dtype="float32", always_2d=True)
text = loader.transcribe(model, wave.mean(1), sr, pad_s=float(pad))
print("RESULT " + json.dumps({"text": text}))
"#;

/// 32-bit IEEE float mono WAV: exact samples, no requantization on the way out.
fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let channels: u16 = 1;
    let bits: u16 = 32;
    let block_align = channels * bits / 8;
    let byte_rate = sample_rate * u32::from(block_align);
    let data_len = (samples.len() * 4) as u32;

    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    std::fs::write(path, out).map_err(|e| format!("write {path:?}: {e}"))
}

fn find_model_dir(root: &Path, engine: &str, repo_id: &str) -> Result<PathBuf, String> {
    for dir in installed_dirs(root) {
        if let Some(manifest) = read_manifest(&dir) {
            if manifest.engine == engine && manifest.repo_id == repo_id {
                return Ok(dir);
            }
        }
    }
    Err(format!("{repo_id} is not installed yet"))
}

/// The transcript from the loader's marked line, or an error carrying its stderr.
fn parse_result(output: &std::process::Output) -> Result<String, String> {
    if !output.status.success() {
        return Err(format!(
            "Bark transcription failed ({}): {}",
            output.status,
            tail(&output.stderr, 600)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with(RESULT_PREFIX))
        .ok_or_else(|| {
            format!(
                "the Bark loader printed no result: {}",
                tail(&output.stderr, 400)
            )
        })?;
    let json: serde_json::Value = serde_json::from_str(&line[RESULT_PREFIX.len()..])
        .map_err(|e| format!("parse Bark result: {e}"))?;
    let text = json
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("No speech was recognized in the recording.".to_string());
    }
    Ok(text)
}

fn run_driver(
    python: &Path,
    work: &Path,
    model_dir: &Path,
    weights_file: &str,
    loader_file: &str,
    padding_seconds: f64,
    device: &str,
) -> Result<String, String> {
    let audio = work.join("input.wav");
    let driver = work.join("driver.py");
    std::fs::write(&driver, DRIVER).map_err(|e| format!("write {driver:?}: {e}"))?;

    let mut cmd = Command::new(python);
    cmd.arg(&driver)
        .arg(model_dir)
        .arg(weights_file)
        .arg(loader_file)
        .arg(&audio)
        .arg(device)
        .arg(padding_seconds.to_string());
    let output = run_with_deadline(&mut cmd, TRANSCRIBE_DEADLINE, "python")?;
    parse_result(&output)
}

fn transcribe_blocking(
    app: &AppHandle,
    runtime_dir_name: &str,
    engine: &str,
    repo_id: &str,
    weights_file: &str,
    loader_file: &str,
    padding_seconds: f64,
    samples: &[f32],
    sample_rate: u32,
    device: &str,
) -> Result<String, String> {
    if samples.is_empty() {
        return Err("the recording contained no samples".to_string());
    }
    let root = app_voice_root(app)?;
    let runtime = runtime_dir(&root, runtime_dir_name)?;
    let python = python_exe(&runtime);
    if !python.is_file() {
        return Err("the Bark runtime is not installed yet".to_string());
    }
    let model_dir = find_model_dir(&root, engine, repo_id)?;

    let work = root
        .join("tmp")
        .join(format!("bark-{}-{}", std::process::id(), monotonic_tag()));
    std::fs::create_dir_all(&work).map_err(|e| format!("create {work:?}: {e}"))?;

    let audio = work.join("input.wav");
    let outcome = write_wav(&audio, samples, sample_rate).and_then(|()| {
        run_driver(
            &python,
            &work,
            &model_dir,
            weights_file,
            loader_file,
            padding_seconds,
            device,
        )
    });
    let _ = std::fs::remove_dir_all(&work);
    outcome
}

fn monotonic_tag() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn voice_bark_transcribe(
    app: AppHandle,
    runtime_dir_name: String,
    engine: String,
    repo_id: String,
    weights_file: String,
    loader_file: String,
    padding_seconds: f64,
    samples: Vec<f32>,
    sample_rate: u32,
    device: String,
) -> Result<String, String> {
    blocking(move || {
        transcribe_blocking(
            &app,
            &runtime_dir_name,
            &engine,
            &repo_id,
            &weights_file,
            &loader_file,
            padding_seconds,
            &samples,
            sample_rate,
            &device,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_declares_float_mono_at_the_given_rate() {
        let dir = std::env::temp_dir().join(format!("reasonix-wav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("input.wav");
        write_wav(&path, &[0.0, 0.5, -0.5], 16_000).expect("write wav");
        let bytes = std::fs::read(&path).expect("read wav");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 3, "IEEE float");
        assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1, "mono");
        assert_eq!(
            u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]),
            16_000
        );
        assert_eq!(
            u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]),
            12
        );
        assert_eq!(bytes.len(), 44 + 12);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_model_is_reported_not_guessed() {
        let root = std::env::temp_dir().join(format!("reasonix-nomodel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        let err = find_model_dir(&root, "bark", "ConwayResearch/Underdog-Bark-3.0").unwrap_err();
        assert!(err.contains("not installed"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
