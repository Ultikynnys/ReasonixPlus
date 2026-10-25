//! Provision a voice engine's host runtime on demand.
//!
//! The interpreter, its wheels and the Hugging Face home all live under the
//! version-independent voice root, so an app update reuses them untouched.

use crate::voice_host::{blocking, run as run_command, tail};
use crate::voice_paths::{app_voice_root, runtime_dir, runtimes_root, safe_component};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

const MARKER: &str = ".installed";
const PROGRESS_EVENT: &str = "voice-runtime-progress";

/// Installs in flight, so a double click cannot provision the same dir twice.
#[derive(Default)]
pub struct RuntimeInstalls(pub parking_lot::Mutex<HashSet<String>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub dir: String,
    pub bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeProgress {
    dir_name: String,
    phase: &'static str,
    detail: String,
}

/// Interpreter of an installed runtime.
pub fn python_exe(dir: &Path) -> PathBuf {
    dir.join("Scripts").join("python.exe")
}

pub fn is_installed(dir: &Path) -> bool {
    dir.join(MARKER).is_file() && python_exe(dir).is_file()
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(meta) if meta.is_dir() => dir_size(&entry.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

fn status_for(dir: &Path) -> RuntimeStatus {
    RuntimeStatus {
        installed: is_installed(dir),
        dir: dir.to_string_lossy().into_owned(),
        bytes: dir_size(dir),
    }
}

fn emit_phase(app: &AppHandle, dir_name: &str, phase: &'static str, detail: impl Into<String>) {
    let _ = app.emit(
        PROGRESS_EVENT,
        RuntimeProgress {
            dir_name: dir_name.to_string(),
            phase,
            detail: detail.into(),
        },
    );
}

fn apply_env(cmd: &mut Command, root: &Path) {
    cmd.env("UV_CACHE_DIR", root.join("cache").join("uv"))
        .env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("HF_HOME", root.join("hf-home"))
        .env("UV_NO_PROGRESS", "1")
        .env("UV_LINK_MODE", "copy");
}

fn run(cmd: &mut Command, label: &str) -> Result<(), String> {
    let output = run_command(cmd, label)?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "{label} failed ({}): {}",
        output.status,
        tail(&output.stderr, 600)
    ))
}

fn extract_uv(archive: &Path, exe: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("open {archive:?}: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read uv archive: {e}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("read uv archive entry: {e}"))?;
        if !entry.name().ends_with("uv.exe") {
            continue;
        }
        let mut out = std::fs::File::create(exe).map_err(|e| format!("create {exe:?}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract uv.exe: {e}"))?;
        return Ok(());
    }
    Err("uv.exe was not present in its archive".to_string())
}

/// The installer binary, fetched once per pinned version and shared by every runtime.
fn ensure_uv(root: &Path, version: &str) -> Result<PathBuf, String> {
    let version =
        safe_component(version).ok_or_else(|| format!("invalid installer version: {version}"))?;
    let dir = runtimes_root(root).join("uv").join(version);
    let exe = dir.join("uv.exe");
    if exe.is_file() {
        return Ok(exe);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        _ => "x86_64",
    };
    let url = format!(
        "https://github.com/astral-sh/uv/releases/download/{version}/uv-{arch}-pc-windows-msvc.zip"
    );
    let archive = dir.join("uv.zip");
    crate::voice_models::download_file(&url, &archive)?;
    extract_uv(&archive, &exe)?;
    let _ = std::fs::remove_file(&archive);
    Ok(exe)
}

fn install_blocking(
    app: &AppHandle,
    dir_name: &str,
    python: &str,
    requirements: &[String],
    installer_version: &str,
) -> Result<RuntimeStatus, String> {
    let root = app_voice_root(app)?;
    let dir = runtime_dir(&root, dir_name)?;
    if is_installed(&dir) {
        return Ok(status_for(&dir));
    }
    if dir.is_dir() {
        // An attempt that died mid-provision leaves a directory no install can reuse.
        std::fs::remove_dir_all(&dir).map_err(|e| format!("clear {dir:?}: {e}"))?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;

    emit_phase(app, dir_name, "installer", "Fetching the runtime installer");
    let uv = ensure_uv(&root, installer_version)?;

    emit_phase(
        app,
        dir_name,
        "environment",
        format!("Provisioning Python {python}"),
    );
    let mut venv = Command::new(&uv);
    venv.args(["venv", "--python", python]).arg(&dir);
    apply_env(&mut venv, &root);
    run(&mut venv, "uv venv")?;

    let spec = dir.join("requirements.txt");
    let body = format!("{}\n", requirements.join("\n"));
    std::fs::write(&spec, body).map_err(|e| format!("write {spec:?}: {e}"))?;

    emit_phase(
        app,
        dir_name,
        "packages",
        "Installing the inference packages",
    );
    let mut pip = Command::new(&uv);
    pip.arg("pip")
        .arg("install")
        .arg("--python")
        .arg(python_exe(&dir))
        .arg("-r")
        .arg(&spec);
    apply_env(&mut pip, &root);
    run(&mut pip, "uv pip install")?;

    std::fs::write(dir.join(MARKER), requirements.join("\n"))
        .map_err(|e| format!("write runtime marker: {e}"))?;
    emit_phase(app, dir_name, "ready", "Runtime ready");
    Ok(status_for(&dir))
}

#[tauri::command]
pub async fn voice_runtime_status(
    app: AppHandle,
    dir_name: String,
) -> Result<RuntimeStatus, String> {
    blocking(move || {
        let root = app_voice_root(&app)?;
        let dir = runtime_dir(&root, &dir_name)?;
        Ok(status_for(&dir))
    })
    .await
}

#[tauri::command]
pub async fn voice_runtime_install(
    app: AppHandle,
    installs: tauri::State<'_, RuntimeInstalls>,
    dir_name: String,
    python: String,
    requirements: Vec<String>,
    installer_version: String,
) -> Result<RuntimeStatus, String> {
    if requirements.is_empty() {
        return Err("a runtime needs at least one requirement".to_string());
    }
    {
        let mut inflight = installs.0.lock();
        if !inflight.insert(dir_name.clone()) {
            return Err(format!("{dir_name} is already installing"));
        }
    }

    let handle = app.clone();
    let key = dir_name.clone();
    let result = blocking(move || {
        install_blocking(
            &handle,
            &dir_name,
            &python,
            &requirements,
            &installer_version,
        )
    })
    .await;
    installs.0.lock().remove(&key);
    result
}

#[tauri::command]
pub async fn voice_runtime_remove(app: AppHandle, dir_name: String) -> Result<(), String> {
    blocking(move || {
        let root = app_voice_root(&app)?;
        let dir = runtime_dir(&root, &dir_name)?;
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {dir:?}: {e}"))?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_lives_in_the_venv_scripts_dir() {
        let dir = Path::new("/runtimes/bark-torch-abc");
        assert_eq!(python_exe(dir), dir.join("Scripts").join("python.exe"));
    }

    #[test]
    fn a_directory_without_a_marker_is_not_installed() {
        let dir = std::env::temp_dir().join(format!("reasonix-runtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        assert!(!is_installed(&dir));
        std::fs::write(dir.join(MARKER), b"").expect("marker");
        assert!(!is_installed(&dir), "the marker alone is not an install");
        std::fs::create_dir_all(dir.join("Scripts")).expect("scripts");
        std::fs::write(python_exe(&dir), b"stub").expect("python");
        assert!(is_installed(&dir));
        assert!(dir_size(&dir) >= 4);
        assert!(!status_for(&dir).dir.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_traversing_installer_version_is_refused() {
        let root = std::env::temp_dir().join(format!("reasonix-uv-{}", std::process::id()));
        assert!(ensure_uv(&root, "../escape").is_err());
        assert!(!root.exists());
    }
}
