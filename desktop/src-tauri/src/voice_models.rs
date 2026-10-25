//! Download and track voice model weights on disk.
//!
//! Weights live under the version-independent voice root and are keyed by the
//! resolved Hugging Face revision, so an app update never refetches them.

use crate::voice_host::blocking;
use crate::voice_paths::{app_voice_root, model_dir, models_root, repo_slug};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MANIFEST: &str = "manifest.json";
const PROGRESS_EVENT: &str = "voice-model-progress";
const CHUNK: usize = 64 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Shared HTTP agent: a stalled socket must fail instead of hanging forever.
static AGENT: OnceLock<ureq::Agent> = OnceLock::new();

fn agent() -> &'static ureq::Agent {
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60))
            .build()
    })
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelFile {
    pub name: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelManifest {
    pub engine: String,
    pub repo_id: String,
    pub revision: String,
    pub files: Vec<VoiceModelFile>,
    pub bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelProgress {
    repo_id: String,
    file: String,
    loaded: u64,
    total: u64,
}

/// Flatten a declared file reference to a single segment inside the model dir.
fn file_name_of(reference: &str) -> Result<&str, String> {
    let name = reference.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name == "." || name == ".." {
        return Err(format!("invalid model file reference: {reference}"));
    }
    Ok(name)
}

fn files_present(dir: &Path, manifest: &VoiceModelManifest) -> bool {
    manifest.files.iter().all(|file| {
        std::fs::metadata(dir.join(&file.name))
            .map(|meta| meta.is_file() && meta.len() == file.bytes)
            .unwrap_or(false)
    })
}

pub(crate) fn read_manifest(dir: &Path) -> Option<VoiceModelManifest> {
    let raw = std::fs::read(dir.join(MANIFEST)).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn write_manifest(dir: &Path, manifest: &VoiceModelManifest) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    let path = dir.join(MANIFEST);
    let tmp = dir.join(format!("{MANIFEST}.part"));
    std::fs::write(&tmp, raw).map_err(|e| format!("write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {path:?}: {e}"))
}

pub(crate) fn installed_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(engines) = std::fs::read_dir(models_root(root)) else {
        return out;
    };
    for engine in engines.flatten() {
        let Ok(entries) = std::fs::read_dir(engine.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                out.push(entry.path());
            }
        }
    }
    out
}

fn resolve_revision(repo_id: &str) -> Result<String, String> {
    let url = format!("https://huggingface.co/api/models/{repo_id}");
    let body = agent()
        .get(&url)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?
        .into_string()
        .map_err(|e| format!("read {url}: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse {url}: {e}"))?;
    json.get("sha")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("{url} reported no revision"))
}

fn download(
    url: &str,
    dest: &Path,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<u64, String> {
    let response = agent()
        .get(url)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?;
    let total = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = response.into_reader();
    let mut suffix = dest.as_os_str().to_owned();
    suffix.push(".part");
    let tmp = PathBuf::from(suffix);
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("create {tmp:?}: {e}"))?;

    let mut buffer = vec![0u8; CHUNK];
    let mut loaded = 0u64;
    let mut last = Instant::now();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("read {url}: {e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("write {tmp:?}: {e}"))?;
        loaded += read as u64;
        if last.elapsed() >= PROGRESS_INTERVAL {
            last = Instant::now();
            on_progress(loaded, total);
        }
    }
    file.flush().map_err(|e| format!("flush {tmp:?}: {e}"))?;
    drop(file);

    if loaded == 0 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{url} returned no bytes"));
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("rename {dest:?}: {e}"))?;
    on_progress(loaded, total.max(loaded));
    Ok(loaded)
}

/// Fetch a URL to a file with no per-chunk reporting.
pub(crate) fn download_file(url: &str, dest: &Path) -> Result<u64, String> {
    download(url, dest, |_, _| {})
}

fn fetch_blocking(
    app: &AppHandle,
    engine: &str,
    repo_id: &str,
    weights_file: &str,
    loader_file: Option<&str>,
) -> Result<VoiceModelManifest, String> {
    let root = app_voice_root(app)?;
    let revision = resolve_revision(repo_id)?;
    let dir = model_dir(&root, engine, repo_id, &revision);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;

    if let Some(existing) = read_manifest(&dir) {
        if existing.engine == engine && existing.repo_id == repo_id && files_present(&dir, &existing) {
            return Ok(existing);
        }
    }

    let mut references = vec![weights_file.to_string()];
    if let Some(loader) = loader_file {
        references.push(loader.to_string());
    }

    let mut files = Vec::with_capacity(references.len());
    for reference in &references {
        let name = file_name_of(reference)?.to_string();
        let dest = dir.join(&name);
        let url = format!("https://huggingface.co/{repo_id}/resolve/{revision}/{reference}");
        let handle = app.clone();
        let report_repo = repo_id.to_string();
        let report_name = name.clone();
        let bytes = download(&url, &dest, move |loaded, total| {
            let _ = handle.emit(
                PROGRESS_EVENT,
                ModelProgress {
                    repo_id: report_repo.clone(),
                    file: report_name.clone(),
                    loaded,
                    total,
                },
            );
        })?;
        files.push(VoiceModelFile { name, bytes });
    }

    let manifest = VoiceModelManifest {
        engine: engine.to_string(),
        repo_id: repo_id.to_string(),
        revision,
        bytes: files.iter().map(|file| file.bytes).sum(),
        files,
    };
    write_manifest(&dir, &manifest)?;
    Ok(manifest)
}

#[tauri::command]
pub async fn voice_model_status(app: AppHandle) -> Result<Vec<VoiceModelManifest>, String> {
    blocking(move || {
        let root = app_voice_root(&app)?;
        let mut out: Vec<VoiceModelManifest> = installed_dirs(&root)
            .into_iter()
            .filter_map(|dir| read_manifest(&dir))
            .collect();
        out.sort_by(|a, b| a.repo_id.cmp(&b.repo_id));
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn voice_model_fetch(
    app: AppHandle,
    engine: String,
    repo_id: String,
    weights_file: String,
    loader_file: Option<String>,
) -> Result<VoiceModelManifest, String> {
    let handle = app.clone();
    blocking(move || {
        fetch_blocking(
            &handle,
            &engine,
            &repo_id,
            &weights_file,
            loader_file.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn voice_model_remove(
    app: AppHandle,
    engine: String,
    repo_id: String,
) -> Result<(), String> {
    blocking(move || {
        let root = app_voice_root(&app)?;
        let engine_dir = models_root(&root).join(&engine);
        let prefix = format!("{}@", repo_slug(&repo_id));
        let Ok(entries) = std::fs::read_dir(&engine_dir) else {
            return Ok(());
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) {
                std::fs::remove_dir_all(entry.path())
                    .map_err(|e| format!("remove {entry:?}: {e}"))?;
            }
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("reasonix-voice-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn file_reference_is_flattened_to_one_segment() {
        assert_eq!(file_name_of("model.bark").unwrap(), "model.bark");
        assert_eq!(file_name_of("mlx/config.json").unwrap(), "config.json");
        assert!(file_name_of("").is_err());
        assert!(file_name_of("mlx/").is_err());
    }

    #[test]
    fn manifest_round_trips_and_detects_a_truncated_file() {
        let dir = temp_dir("manifest");
        std::fs::write(dir.join("model.bark"), b"weights").expect("write");
        let manifest = VoiceModelManifest {
            engine: "bark".into(),
            repo_id: "ConwayResearch/Underdog-Bark-3.0".into(),
            revision: "85db2ad18ab4".into(),
            files: vec![VoiceModelFile {
                name: "model.bark".into(),
                bytes: 7,
            }],
            bytes: 7,
        };
        write_manifest(&dir, &manifest).expect("write manifest");
        let read = read_manifest(&dir).expect("read manifest");
        assert_eq!(read.repo_id, manifest.repo_id);
        assert!(files_present(&dir, &read));

        std::fs::write(dir.join("model.bark"), b"w").expect("truncate");
        assert!(!files_present(&dir, &read));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
