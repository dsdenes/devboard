//! One bounded git invocation shared by every flow.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

/// The outcome of one git child.
#[derive(Debug, Clone)]
pub struct GitResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `git -C <repo> <args>` with the given environment overrides, bounded.
pub async fn run_git(
    repo_dir: &Path,
    args: &[&str],
    env: &HashMap<String, String>,
    timeout_ms: u64,
) -> GitResult {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(repo_dir)
        .args(args)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return GitResult {
                code: -1,
                stdout: String::new(),
                stderr: error.to_string(),
            }
        }
    };
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms.max(1)),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => GitResult {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Ok(Err(error)) => GitResult {
            code: -1,
            stdout: String::new(),
            stderr: error.to_string(),
        },
        Err(_) => GitResult {
            code: -1,
            stdout: String::new(),
            stderr: format!(
                "git {} timed out after {timeout_ms}ms",
                args.first().copied().unwrap_or("")
            ),
        },
    }
}
