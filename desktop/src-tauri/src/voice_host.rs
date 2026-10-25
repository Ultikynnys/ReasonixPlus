//! Host-side helpers shared by the voice modules.

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(50);

/// Run blocking work off the UI thread, flattening a join failure into a string.
pub(crate) async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("join: {error}"))?
}

/// Never flash a console window on Windows.
pub(crate) fn no_window(cmd: &mut Command) {
    let _ = cmd;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn read_all<R: Read>(source: Option<R>) -> Vec<u8> {
    let Some(mut source) = source else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let _ = source.read_to_end(&mut out);
    out
}

/// Run to completion, capturing both streams.
pub(crate) fn run(cmd: &mut Command, label: &str) -> Result<Output, String> {
    cmd.stdin(Stdio::null());
    no_window(cmd);
    cmd.output().map_err(|error| format!("spawn {label}: {error}"))
}

/// Run capturing both streams, but stop the command once `deadline` passes.
pub(crate) fn run_with_deadline(
    cmd: &mut Command,
    deadline: Duration,
    label: &str,
) -> Result<Output, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(cmd);
    let mut child = cmd.spawn().map_err(|error| format!("spawn {label}: {error}"))?;

    let out_stream = child.stdout.take();
    let err_stream = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_all(out_stream));
    let err_reader = std::thread::spawn(move || read_all(err_stream));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => return Err(format!("wait {label}: {error}")),
        }
        if started.elapsed() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{label} was still running after {}s and was stopped",
                deadline.as_secs()
            ));
        }
        std::thread::sleep(POLL);
    };

    Ok(Output {
        status,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// Last `take` characters of captured output, for an actionable error message.
pub(crate) fn tail(output: &[u8], take: usize) -> String {
    String::from_utf8_lossy(output)
        .chars()
        .rev()
        .take(take)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_end_of_the_output() {
        assert_eq!(tail(b"abcdef", 3), "def");
        assert_eq!(tail(b"ab", 5), "ab");
        assert_eq!(tail(b"", 5), "");
    }

    #[cfg(windows)]
    fn sleeper(seconds: &str) -> Command {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", &format!("ping -n {seconds} 127.0.0.1 >NUL")]);
        cmd
    }

    #[cfg(windows)]
    #[test]
    fn a_command_inside_the_deadline_reports_its_output() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "echo hello"]);
        let output = run_with_deadline(&mut cmd, Duration::from_secs(30), "echo").expect("run");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("hello"));
    }

    #[cfg(windows)]
    #[test]
    fn a_command_past_the_deadline_is_stopped() {
        let started = Instant::now();
        let error = run_with_deadline(&mut sleeper("30"), Duration::from_millis(300), "ping")
            .expect_err("must not wait for the command");
        assert!(error.contains("was stopped"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
