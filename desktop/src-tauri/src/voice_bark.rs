//! Transcribe with an installed Bark model by driving its warm worker.
//!
//! Repos package weights two ways: an entropy-coded `.bark` archive that the
//! repo's own loader decodes, or a plain `transformers` checkpoint. The worker
//! loads the model once and answers every later dictation from memory.

use crate::voice_host::blocking;
use crate::voice_models::{installed_dirs, read_manifest};
use crate::voice_paths::{app_voice_root, runtime_dir};
use crate::voice_runtime::python_exe;
use crate::voice_worker::{BarkWorkers, Transcription, load_request, transcribe_request};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

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

fn monotonic_tag() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
fn transcribe_blocking(
    app: &AppHandle,
    workers: &BarkWorkers,
    runtime_dir_name: &str,
    engine: &str,
    repo_id: &str,
    format: &str,
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
        workers.run(Transcription {
            python: &python,
            runtime_dir: &runtime,
            key: format!("{format}|{}|{device}", model_dir.display()),
            load: load_request(format, &model_dir, weights_file, loader_file, device),
            request: transcribe_request(&audio, padding_seconds),
        })
    });
    let _ = std::fs::remove_dir_all(&work);
    outcome
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn voice_bark_transcribe(
    app: AppHandle,
    workers: tauri::State<'_, BarkWorkers>,
    runtime_dir_name: String,
    engine: String,
    repo_id: String,
    format: String,
    weights_file: String,
    loader_file: String,
    padding_seconds: f64,
    samples: Vec<f32>,
    sample_rate: u32,
    device: String,
) -> Result<String, String> {
    let registry = workers.inner().clone();
    blocking(move || {
        transcribe_blocking(
            &app,
            &registry,
            &runtime_dir_name,
            &engine,
            &repo_id,
            &format,
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
