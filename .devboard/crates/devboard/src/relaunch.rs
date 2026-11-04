//! Replacing this process with the harness the host now points at.
//!
//! The replacement starts while this listener still holds the port and retries
//! the bind until this process exits. A failed spawn therefore leaves the
//! dashboard serving instead of turning a reported restart error into an
//! unreachable process.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use serde_json::json;

/// The listener inputs a replacement inherits.
#[derive(Debug, Clone)]
pub struct RelaunchSettings {
    pub hostname: String,
    pub port: u16,
    pub adrs_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub goal_file: PathBuf,
    pub state_dir: PathBuf,
}

impl RelaunchSettings {
    pub fn from_config(config: &crate::config::Config) -> Self {
        Self {
            hostname: config.hostname.clone(),
            port: config.port,
            adrs_dir: config.addr_dir.clone(),
            repo_dir: config.repo_dir.clone(),
            goal_file: config.goal_file.clone(),
            state_dir: config.state_dir.clone(),
        }
    }
}

/// The executable a replacement runs: this binary, which carries the client.
pub fn replacement_program() -> std::io::Result<PathBuf> {
    std::env::current_exe()
}

/// Starts one replacement process in its own session.
pub fn spawn_replacement(
    settings: &RelaunchSettings,
    extra_env: &[(&str, String)],
) -> std::io::Result<Child> {
    let program = replacement_program()?;
    let mut command = Command::new(&program);
    // Never start from a replaceable install directory: an update can rename
    // and delete it, and a child cannot start from a missing cwd.
    command
        .current_dir(&settings.repo_dir)
        .env("HOST", &settings.hostname)
        .env("PORT", settings.port.to_string())
        .env("ADRS_DIR", &settings.adrs_dir)
        .env("REPO_DIR", &settings.repo_dir)
        .env("GOAL_FILE", &settings.goal_file)
        .env("STATE_DIR", &settings.state_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (name, value) in extra_env {
        command.env(name, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // A new session protects the replacement when the launcher itself was
        // started inside a process group that is being shut down.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command.spawn()
}

/// Writes the readiness marker a confirmed replacement waits for.
pub fn write_ready_marker(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = crate::jsjson::stringify(&json!({
        "pid": std::process::id(),
        "readyAt": crate::journal::now_iso8601(),
    }));
    text.push('\n');
    std::fs::write(path, text)
}

/// The fixture's replacement mode; absent means a real replacement.
pub fn replacement_stub_mode() -> String {
    let Ok(stub) = std::env::var("DEVBOARD_REPLACEMENT_STUB") else {
        return String::new();
    };
    if stub.is_empty() {
        return String::new();
    }
    std::fs::read_to_string(stub)
        .map(|text| text.trim().to_string())
        .unwrap_or_else(|_| "fail".to_string())
}

/// Starts a replacement and hands the listener over immediately.
pub fn relaunch(
    settings: &RelaunchSettings,
    version: Option<&str>,
) -> std::io::Result<()> {
    if replacement_stub_mode() == "fail" {
        return Err(std::io::Error::other("stubbed replacement failure"));
    }
    let extra: Vec<(&str, String)> = version
        .map(|version| ("DEVBOARD_RUNNING_VERSION", version.to_string()))
        .into_iter()
        .collect();
    let child = spawn_replacement(settings, &extra)?;
    std::mem::forget(child);
    Ok(())
}

/// Starts a replacement and waits for its readiness marker before this process
/// stops serving. A child that exits first, or never signals, is ended and the
/// caller keeps serving.
pub async fn relaunch_confirmed(
    settings: &RelaunchSettings,
    ready_file: &Path,
    timeout_ms: u64,
    version: Option<&str>,
) -> Result<(), String> {
    let stub = replacement_stub_mode();
    if stub == "fail" {
        return Err("stubbed replacement failure".to_string());
    }
    let _ = std::fs::remove_file(ready_file);
    let mut extra: Vec<(&str, String)> = if stub == "never-ready" {
        Vec::new()
    } else {
        vec![(
            "DEVBOARD_REPLACEMENT_READY_FILE",
            ready_file.to_string_lossy().into_owned(),
        )]
    };
    if let Some(version) = version {
        extra.push(("DEVBOARD_RUNNING_VERSION", version.to_string()));
    }
    let mut child = spawn_replacement(settings, &extra).map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();
    let mut ready = false;
    while started.elapsed() < std::time::Duration::from_millis(timeout_ms) {
        if ready_file.exists() {
            ready = true;
            break;
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if !ready {
        let _ = child.kill();
        return Err(
            "the replacement did not become ready; the running server keeps serving".to_string(),
        );
    }
    let _ = std::fs::remove_file(ready_file);
    Ok(())
}
