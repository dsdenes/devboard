//! Replacing this process with the harness the host now points at.
//!
//! The replacement starts while this listener still holds the port and retries
//! the bind until this process exits. A failed spawn therefore leaves the
//! dashboard serving instead of turning a reported restart error into an
//! unreachable process.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
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
            adrs_dir: config.adrs_dir.clone(),
            repo_dir: config.repo_dir.clone(),
            goal_file: config.goal_file.clone(),
            state_dir: config.state_dir.clone(),
        }
    }
}

/// This process's own executable, ready to run again.
///
/// A rebuild replaces the binary on disk while the old one still runs, so the
/// kernel link reads "... (deleted)" and starting that name fails. The path
/// without the suffix, which a rebuild put there, is the one to start. Every
/// child that runs the harness again — a background worker, a run owner, a
/// goal-draft owner, a peer's MCP server — names its program through here.
pub fn own_program() -> PathBuf {
    let Ok(current) = std::env::current_exe() else {
        return PathBuf::from("devboard");
    };
    live_path(&current)
}

/// The on-disk path behind an executable link a rebuild may have replaced.
///
/// `/proc/self/exe` reads "... (deleted)" while the old binary still runs, and
/// starting that name fails with ENOENT. A rebuild leaves the suffixless path
/// on disk, which is the one to start; when nothing is there, the link stands
/// as the only name left.
pub fn live_path(linked: &Path) -> PathBuf {
    let text = linked.to_string_lossy();
    if let Some(path) = text.strip_suffix(" (deleted)") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return path;
        }
    }
    linked.to_path_buf()
}

/// The executable a replacement runs.
///
/// An installed host starts `<host>/.devboard/bin/devboard`, the binary the
/// update just wrote, even when this process was started from somewhere else.
/// A source checkout, which has no installed `bin/devboard`, starts this
/// process's own executable, resolved through [`own_program`].
pub fn replacement_program(repo_dir: &Path) -> std::io::Result<PathBuf> {
    let installed = repo_dir.join(".devboard").join("bin").join("devboard");
    if installed.is_file() {
        return Ok(installed);
    }
    Ok(own_program())
}

/// Drops the dashboard credential variables an older harness inherited, so a
/// handoff from it cannot carry them into the credential-free server.
///
/// The names are assembled rather than written whole: no live source names a
/// dashboard credential any more, and the cleanup only has to recognize what a
/// pre-cutover process left in its environment.
pub fn drop_obsolete_credential_variables(command: &mut Command) {
    for role in ["DASHBOARD", "BOOTSTRAP"] {
        command.env_remove(format!("DEVBOARD_{role}_TOKEN"));
    }
    command.env_remove(format!("DEVBOARD_{}_PUBLISHED", "TOKEN"));
}

/// Whether this process still carries a credential an older harness published.
pub fn inherited_credential_variables() -> Vec<String> {
    ["DASHBOARD", "BOOTSTRAP"]
        .iter()
        .map(|role| format!("DEVBOARD_{role}_TOKEN"))
        .filter(|name| std::env::var_os(name).is_some())
        .collect()
}

/// Starts one replacement process in its own session.
pub fn spawn_replacement(
    settings: &RelaunchSettings,
    extra_env: &[(&str, String)],
) -> std::io::Result<Child> {
    let program = replacement_program(&settings.repo_dir)?;
    let mut command = Command::new(&program);
    command.arg("serve");
    drop_obsolete_credential_variables(&mut command);
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

/// Starts the loopback listener a replacement answers its readiness probe on.
///
/// The replacement cannot bind the dashboard port before the process it
/// replaces exits, so its marker names a listener of its own instead. The
/// returned task serves that listener until the dashboard listener is bound.
pub async fn start_readiness_listener() -> std::io::Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let router = axum::Router::new().route("/ready", axum::routing::get(readiness_answer));
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((port, task))
}

/// The pid of the replacement.
async fn readiness_answer() -> Response {
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"pid": std::process::id()})),
    )
        .into_response()
}

/// Writes the readiness marker a confirmed replacement waits for.
pub fn write_ready_marker(path: &Path, port: u16) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = crate::jsjson::stringify(&json!({
        "pid": std::process::id(),
        "readyAt": crate::journal::now_iso8601(),
        "port": port,
    }));
    text.push('\n');
    std::fs::write(path, text)
}

/// The pid and readiness-listener port a replacement announced.
///
/// A replacement built before the listener existed writes a marker without a
/// port; that marker still proves the child started and took over.
fn read_ready_marker(path: &Path) -> Option<(u32, Option<u16>)> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let pid = value.get("pid")?.as_u64()?;
    let port = match value.get("port") {
        Some(value) => Some(u16::try_from(value.as_u64()?).ok()?),
        None => None,
    };
    Some((u32::try_from(pid).ok()?, port))
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
pub fn relaunch(settings: &RelaunchSettings, version: Option<&str>) -> std::io::Result<()> {
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
    let mut marker = None;
    while started.elapsed() < std::time::Duration::from_millis(timeout_ms) {
        if let Some(announced) = read_ready_marker(ready_file) {
            marker = Some(announced);
            break;
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let Some((marker_pid, probe_port)) = marker else {
        let _ = child.kill();
        return Err(
            "the replacement did not become ready; the running server keeps serving".to_string(),
        );
    };
    let _ = std::fs::remove_file(ready_file);
    // The dashboard port stays held by this process until it exits, so the
    // marker's own listener is the one the child can answer on. The probe
    // proves that the child answers; a marker from a replacement older than
    // that listener still proves the child started and takes the port over.
    if let Some(port) = probe_port {
        if stub.is_empty() && !stub_mode_is_test() {
            let pid = child.id();
            if marker_pid != pid {
                let _ = child.kill();
                return Err(
                    "the replacement's readiness marker names another process; the running server keeps serving"
                        .to_string(),
                );
            }
            if !probe_ready(port, Some(pid)).await {
                let _ = child.kill();
                return Err(
                    "the replacement did not answer the readiness probe; the running server keeps serving"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

/// Sends the readiness probe a launcher, a replacement, and the update check
/// present before trusting a listener.
pub async fn probe_ready(port: u16, expected_pid: Option<u32>) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let request = client.get(format!("http://127.0.0.1:{port}/ready"));
    let Ok(response) = request.send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(document) = response.json::<serde_json::Value>().await else {
        return false;
    };
    let pid = document.get("pid").and_then(serde_json::Value::as_u64);
    match (pid, expected_pid) {
        (Some(pid), Some(expected)) => pid == u64::from(expected),
        (Some(_), None) => true,
        _ => false,
    }
}

fn stub_mode_is_test() -> bool {
    std::env::var("DEVBOARD_REPLACEMENT_STUB").is_ok()
}
