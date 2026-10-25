//! A warm Bark worker: one interpreter per runtime, model loaded once.
//!
//! The worker speaks newline-delimited JSON on stdin/stdout, so a dictation
//! costs inference instead of a fresh interpreter, torch import and model load.

use crate::voice_host::{no_window, tail};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const SCRIPT: &str = "bark_worker.py";
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const REAP_INTERVAL: Duration = Duration::from_secs(60);
const STDERR_CAP: usize = 8192;

/// Loading a 1.25 GB checkpoint is slow; answering a dictation is not.
const LOAD_DEADLINE: Duration = Duration::from_secs(300);
const TRANSCRIBE_DEADLINE: Duration = Duration::from_secs(120);

static REAPER: AtomicBool = AtomicBool::new(false);

/// Drives one transcription inside the long-lived worker process.
const WORKER: &str = r#"
import json
import sys

_model = None
_format = None
_processor = None


def _describe(error):
    return f"{type(error).__name__}: {error}"


def _load(request):
    global _model, _format, _processor
    import importlib.util
    from pathlib import Path

    model_dir = Path(request["modelDir"])
    image_format = request["format"]
    weights = request["weights"]
    device = request["device"]

    if image_format == "bark":
        loader_name = request.get("loader") or ""
        spec = importlib.util.spec_from_file_location(
            "official_bark", str(model_dir / loader_name)
        )
        loader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(loader)
        _model = loader.load_model(str(model_dir / weights), device=device)
        _processor = loader
    else:
        import torch
        from transformers import AutoProcessor, ParakeetForTDT

        _model = (
            ParakeetForTDT.from_pretrained(str(model_dir))
            .to(device=device, dtype=torch.float32)
            .eval()
        )
        _processor = AutoProcessor.from_pretrained(str(model_dir))

    _format = image_format


def _transcribe(request):
    import numpy as np
    import soundfile as sf

    wave, rate = sf.read(request["wav"], dtype="float32", always_2d=True)
    wave = wave.mean(1)
    pad = float(request.get("pad") or 0)

    if _format == "bark":
        return _processor.transcribe(_model, wave, rate, pad_s=pad)

    import torch

    if rate != 16000:
        import soxr

        wave = soxr.resample(wave, rate, 16000)
    padded = np.concatenate([np.zeros(int(pad * 16000), np.float32), wave.astype(np.float32)])
    inputs = _processor([padded], sampling_rate=16000, return_tensors="pt", padding=True)
    device = next(_model.parameters()).device
    dtype = next(_model.parameters()).dtype
    inputs = {
        key: value
        if not value.is_floating_point()
        else value.to(device=device, dtype=dtype)
        for key, value in inputs.items()
    }
    with torch.inference_mode():
        out = _model.generate(**inputs)
    return _processor.batch_decode(out.sequences, skip_special_tokens=True)[0].strip()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            print(json.dumps({"ok": False, "error": _describe(error)}), flush=True)
            continue

        kind = request.get("type")
        if kind == "exit":
            return
        if kind == "load":
            try:
                _load(request)
                print(json.dumps({"ok": True}), flush=True)
            except Exception as error:
                print(json.dumps({"ok": False, "error": _describe(error)}), flush=True)
            continue
        if kind == "transcribe":
            try:
                text = _transcribe(request)
                print(json.dumps({"id": request.get("id"), "text": text}), flush=True)
            except Exception as error:
                print(
                    json.dumps({"id": request.get("id"), "error": _describe(error)}),
                    flush=True,
                )
            continue
        print(json.dumps({"ok": False, "error": f"unknown request: {kind}"}), flush=True)


if __name__ == "__main__":
    main()
"#;

/// One live worker, tagged with the model and device it holds.
pub(crate) struct BarkWorker {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    stderr: Arc<Mutex<Vec<u8>>>,
    key: String,
    last_used: Instant,
}

impl BarkWorker {
    fn send(&mut self, payload: &Value) -> Result<(), String> {
        let line =
            serde_json::to_string(payload).map_err(|e| format!("encode worker request: {e}"))?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|()| self.stdin.write_all(b"\n"))
            .and_then(|()| self.stdin.flush())
            .map_err(|e| format!("write to the Bark worker: {e}"))
    }

    fn read_json(&mut self, deadline: Duration) -> Result<Value, String> {
        let started = Instant::now();
        loop {
            let remaining = deadline.saturating_sub(started.elapsed());
            let timeout = || {
                format!(
                    "the Bark worker did not answer within {}s",
                    deadline.as_secs()
                )
            };
            if remaining.is_zero() {
                return Err(timeout());
            }
            match self.lines.recv_timeout(remaining) {
                Ok(line) => {
                    if let Some(reply) = accept_line(&line) {
                        return Ok(reply);
                    }
                }
                Err(RecvTimeoutError::Timeout) => return Err(timeout()),
                Err(RecvTimeoutError::Disconnected) => return Err(self.crash()),
            }
        }
    }

    fn crash(&self) -> String {
        let captured = self
            .stderr
            .lock()
            .map(|buffer| String::from_utf8_lossy(&buffer).into_owned())
            .unwrap_or_default();
        let detail = tail(captured.as_bytes(), 600);
        let detail = detail.trim();
        if detail.is_empty() {
            "the Bark worker exited without a message".to_string()
        } else {
            format!("the Bark worker exited: {detail}")
        }
    }

    fn kill(&mut self) {
        let _ = self.stdin.write_all(b"{\"type\":\"exit\"}\n");
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for BarkWorker {
    fn drop(&mut self) {
        self.kill();
    }
}

fn spawn(python: &Path, runtime_dir: &Path, key: String) -> Result<BarkWorker, String> {
    let script: PathBuf = runtime_dir.join(SCRIPT);
    let differs = std::fs::read_to_string(&script)
        .map(|installed| installed != WORKER)
        .unwrap_or(true);
    if differs {
        std::fs::write(&script, WORKER).map_err(|e| format!("write {script:?}: {e}"))?;
    }

    let mut cmd = Command::new(python);
    cmd.arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("spawn python: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "the Bark worker has no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "the Bark worker has no stdout".to_string())?;
    let stderr_stream = child.stderr.take();

    let (tx, lines) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });

    let stderr = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&stderr);
    std::thread::spawn(move || {
        let Some(mut source) = stderr_stream else {
            return;
        };
        let mut chunk = [0u8; 1024];
        loop {
            match source.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    if let Ok(mut buffer) = sink.lock() {
                        let room = STDERR_CAP.saturating_sub(buffer.len());
                        buffer.extend_from_slice(&chunk[..read.min(room)]);
                    }
                }
            }
        }
    });

    Ok(BarkWorker {
        child,
        stdin,
        lines,
        stderr,
        key,
        last_used: Instant::now(),
    })
}

/// A reply is a JSON object on its own line; anything else is stray output.
fn accept_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Value>(trimmed).ok().filter(Value::is_object)
}

/// A worker reported failure: the process is healthy, the request was not.
fn interpret(reply: &Value) -> Result<String, String> {
    if let Some(error) = reply.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    let text = reply
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("No speech was recognized in the recording.".to_string());
    }
    Ok(text)
}

/// Everything one transcription needs, with the model identity that keys the worker.
pub(crate) struct Transcription<'a> {
    pub python: &'a Path,
    pub runtime_dir: &'a Path,
    pub key: String,
    pub load: Value,
    pub request: Value,
}

/// The single warm worker the app keeps alive for Bark.
#[derive(Clone, Default)]
pub struct BarkWorkers(pub Arc<Mutex<Option<BarkWorker>>>);

impl BarkWorkers {
    /// Run one transcription, replacing the worker when the model or device changes.
    pub fn run(&self, job: Transcription<'_>) -> Result<String, String> {
        let mut guard = self.registry();

        let stale = match guard.as_ref() {
            Some(worker) => worker.key != job.key,
            None => true,
        };
        if stale {
            if let Some(mut previous) = guard.take() {
                previous.kill();
            }
            let mut fresh = spawn(job.python, job.runtime_dir, job.key.clone())?;
            fresh.send(&job.load)?;
            let reply = fresh.read_json(LOAD_DEADLINE)?;
            if reply.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(reply
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("the Bark worker refused the model")
                    .to_string());
            }
            *guard = Some(fresh);
            start_reaper(&self.0);
        }

        let outcome = {
            let Some(worker) = guard.as_mut() else {
                return Err("the Bark worker vanished".to_string());
            };
            worker.last_used = Instant::now();
            match worker.send(&job.request) {
                Ok(()) => worker.read_json(TRANSCRIBE_DEADLINE).map(|reply| interpret(&reply)),
                Err(error) => Err(error),
            }
        };

        match outcome {
            Ok(reply) => reply,
            Err(transport) => {
                guard.take();
                Err(transport)
            }
        }
    }

    /// Stop the worker, e.g. when the app is closing. Never waits for a
    /// transcription in flight: the worker also exits when our pipes close.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.0.try_lock() {
            guard.take();
        }
    }

    fn registry(&self) -> MutexGuard<'_, Option<BarkWorker>> {
        // A panic elsewhere must not leave Bark unusable for the rest of the session.
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn start_reaper(registry: &Arc<Mutex<Option<BarkWorker>>>) {
    if REAPER.swap(true, Ordering::SeqCst) {
        return;
    }
    let shared = Arc::clone(registry);
    std::thread::spawn(move || loop {
        std::thread::sleep(REAP_INTERVAL);
        let Ok(mut guard) = shared.lock() else {
            return;
        };
        let idle = match guard.as_ref() {
            Some(worker) => worker.last_used.elapsed() >= IDLE_TIMEOUT,
            None => false,
        };
        if idle {
            guard.take();
        }
    });
}

/// Request that loads a model into the worker.
pub(crate) fn load_request(
    format: &str,
    model_dir: &Path,
    weights: &str,
    loader: &str,
    device: &str,
) -> Value {
    json!({
        "type": "load",
        "format": format,
        "modelDir": model_dir.to_string_lossy(),
        "weights": weights,
        "loader": loader,
        "device": device,
    })
}

/// Request that transcribes one WAV file.
pub(crate) fn transcribe_request(audio: &Path, padding_seconds: f64) -> Value {
    json!({
        "type": "transcribe",
        "id": 1,
        "wav": audio.to_string_lossy(),
        "pad": padding_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_healthy_worker_error_keeps_its_text_out_of_the_way() {
        assert_eq!(interpret(&json!({ "text": " hello " })).unwrap(), "hello");
        assert!(interpret(&json!({ "text": "   " })).is_err());
        assert_eq!(
            interpret(&json!({ "error": "RuntimeError: boom" })).unwrap_err(),
            "RuntimeError: boom"
        );
    }

    #[test]
    fn the_worker_script_covers_both_packagings() {
        assert!(WORKER.contains("loader.load_model"), "archive path");
        assert!(
            WORKER.contains("ParakeetForTDT.from_pretrained"),
            "checkpoint path"
        );
        assert!(!WORKER.contains("import librosa"));
    }

    #[test]
    fn stray_output_never_counts_as_a_reply() {
        assert!(accept_line("Loading weights...").is_none());
        assert!(accept_line("[1, 2]").is_none());
        assert!(accept_line("42").is_none());
        assert!(accept_line("{ not json }").is_none());
        assert_eq!(accept_line(r#"{"ok": true}"#).unwrap()["ok"], true);
    }

    #[test]
    fn load_requests_carry_the_model_identity() {
        let request = load_request(
            "safetensors",
            Path::new("/voice/models/bark/acme@abc"),
            "model.safetensors",
            "",
            "cpu",
        );
        assert_eq!(request["type"], "load");
        assert_eq!(request["format"], "safetensors");
        assert_eq!(request["modelDir"], "/voice/models/bark/acme@abc");
        assert_eq!(request["device"], "cpu");
    }

    #[test]
    fn transcribe_requests_carry_the_audio_and_padding() {
        let request = transcribe_request(Path::new("/tmp/input.wav"), 0.25);
        assert_eq!(request["type"], "transcribe");
        assert_eq!(request["wav"], "/tmp/input.wav");
        assert_eq!(request["pad"], 0.25);
    }
}
