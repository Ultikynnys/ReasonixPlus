//! Host-side helpers shared by the voice modules.

use std::process::{Command, Output, Stdio};

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

/// Run to completion, capturing both streams.
pub(crate) fn run(cmd: &mut Command, label: &str) -> Result<Output, String> {
    cmd.stdin(Stdio::null());
    no_window(cmd);
    cmd.output().map_err(|error| format!("spawn {label}: {error}"))
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
    #[test]
    fn a_command_reports_its_output_and_status() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "echo hello"]);
        let output = run(&mut cmd, "echo").expect("run");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("hello"));
    }
}
