//! Version-independent locations for downloaded voice assets.
//!
//! Nothing here may contain the app version: an update must reuse whatever the
//! previous install already downloaded.

use std::path::{Path, PathBuf};
use tauri::Manager;

/// `<local data>/voice`: the only root voice assets are ever written under.
pub fn voice_root(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join("voice")
}

/// Root for downloaded model weights.
pub fn models_root(root: &Path) -> PathBuf {
    root.join("models")
}

/// Root for installed host runtimes.
pub fn runtimes_root(root: &Path) -> PathBuf {
    root.join("runtimes")
}

/// `tauri::AppHandle` form of [`voice_root`].
pub fn app_voice_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app local data dir: {e}"))?;
    Ok(voice_root(&dir))
}

/// Reject a value that would escape its parent directory if used as a segment.
pub fn safe_component(value: &str) -> Option<&str> {
    if value.is_empty() || value == "." || value == ".." {
        return None;
    }
    if value
        .chars()
        .any(|c| c.is_ascii_control() || matches!(c, '/' | '\\' | ':'))
    {
        return None;
    }
    Some(value)
}

/// `OpenAI/whisper-base` -> `openai--whisper-base`, a single safe segment.
pub fn repo_slug(repo_id: &str) -> String {
    if repo_id.is_empty() || repo_id == "." || repo_id == ".." {
        return "unknown".to_string();
    }
    let mut slug = String::with_capacity(repo_id.len());
    for ch in repo_id.chars() {
        match ch {
            '/' => slug.push_str("--"),
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' => {
                slug.push(c.to_ascii_lowercase())
            }
            _ => slug.push('_'),
        }
    }
    if slug.is_empty() {
        return "unknown".to_string();
    }
    slug
}

/// First twelve alphanumeric characters of a revision, for a readable dir name.
pub fn revision_tag(revision: &str) -> String {
    let kept: String = revision
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    if kept.is_empty() {
        "unknown".to_string()
    } else {
        kept.to_ascii_lowercase()
    }
}

/// Directory holding one model revision's files.
pub fn model_dir(root: &Path, engine: &str, repo_id: &str, revision: &str) -> PathBuf {
    let engine = safe_component(engine).unwrap_or("unknown");
    models_root(root)
        .join(engine)
        .join(format!("{}@{}", repo_slug(repo_id), revision_tag(revision)))
}

/// Directory holding one installed runtime, named by the caller's spec id.
pub fn runtime_dir(root: &Path, dir_name: &str) -> Result<PathBuf, String> {
    let name = safe_component(dir_name).ok_or_else(|| format!("invalid runtime dir: {dir_name}"))?;
    Ok(runtimes_root(root).join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_slug_collapses_the_namespace_separator() {
        assert_eq!(repo_slug("OpenAI/whisper-base"), "openai--whisper-base");
        assert_eq!(
            repo_slug("ConwayResearch/Underdog-Bark-3.0-Pro"),
            "conwayresearch--underdog-bark-3_0-pro"
        );
    }

    #[test]
    fn repo_slug_never_escapes_the_parent() {
        assert_eq!(repo_slug(".."), "unknown");
        assert_eq!(repo_slug(""), "unknown");
        assert!(!repo_slug("a/../../b").contains('/'));
    }

    #[test]
    fn revision_tag_is_bounded_and_readable() {
        assert_eq!(revision_tag("85db2ad18ab41e534a222ee253c29191d77ed919"), "85db2ad18ab4");
        assert_eq!(revision_tag(""), "unknown");
        assert_eq!(revision_tag("../etc"), "etc");
    }

    #[test]
    fn model_dir_carries_no_app_version() {
        let root = voice_root(Path::new("/data/dev.reasonix.desktop"));
        let dir = model_dir(&root, "bark", "ConwayResearch/Underdog-Bark-3.0", "85db2ad18ab4");
        assert_eq!(
            dir,
            root.join("models")
                .join("bark")
                .join("conwayresearch--underdog-bark-3_0@85db2ad18ab4")
        );
        let text = dir.to_string_lossy().to_lowercase();
        assert!(!text.contains("1.0."));
        assert!(!text.contains("v1"));
    }

    #[test]
    fn runtime_dir_rejects_a_path_segment() {
        let root = voice_root(Path::new("/data"));
        assert!(runtime_dir(&root, "bark-torch-abc").is_ok());
        assert!(runtime_dir(&root, "../escape").is_err());
        assert!(runtime_dir(&root, "").is_err());
    }
}
