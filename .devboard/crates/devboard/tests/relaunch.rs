//! A confirmed replacement proves readiness while the caller still holds the
//! dashboard port, so it answers through its own loopback readiness listener.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use devboard::relaunch::{
    probe_ready, relaunch_confirmed, start_readiness_listener, RelaunchSettings,
};

struct Scratch {
    root: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn scratch(label: &str) -> Scratch {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("relaunch-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/adrs")).expect("a fixture root");
    std::fs::create_dir_all(root.join("repo/.devboard/bin")).expect("an install directory");
    std::fs::create_dir_all(root.join("state")).expect("a fixture state");
    std::fs::write(root.join("repo/GOAL.md"), "# Goal\n").expect("a goal document");
    std::os::unix::fs::symlink(
        env!("CARGO_BIN_EXE_devboard"),
        root.join("repo/.devboard/bin/devboard"),
    )
    .expect("the replacement program");
    Scratch { root }
}

fn settings(root: &Path, port: u16) -> RelaunchSettings {
    let repo = root.join("repo");
    RelaunchSettings {
        hostname: "127.0.0.1".to_string(),
        port,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        state_dir: root.join("state"),
    }
}

fn serve_pid(state: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(state.join("version.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value["pid"].as_u64().map(|pid| pid as u32)
}

/// The startup passes the replacement journaled under its own state directory.
fn startup_passes(state: &Path) -> usize {
    std::fs::read_to_string(state.join("supervision/reaped.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|line| line["pass"] == "startup")
        .count()
}

/// The spawned replacement is this test's child, so SIGTERM plus `waitpid`
/// reaps it instead of leaving a zombie that `kill(pid, 0)` still reports.
fn stop(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut status = 0;
        let reaped = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
        if reaped == pid as i32 || Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The marker's listener names this process and answers only with the
/// credential the replacement inherited.
#[tokio::test]
async fn the_replacement_readiness_listener_answers_the_pid_without_a_credential() {
    let (port, task) = start_readiness_listener()
        .await
        .expect("a readiness listener");
    let pid = std::process::id();
    assert!(probe_ready(port, Some(pid)).await);
    assert!(
        !probe_ready(port, Some(pid.wrapping_add(1))).await,
        "another pid never becomes the replacement"
    );
    task.abort();
}

/// The caller holds the dashboard port until the handoff succeeds, exactly as
/// a serving dashboard does, so the readiness marker alone proves nothing about
/// an answer on that port.
#[tokio::test]
async fn a_confirmed_replacement_becomes_ready_before_the_caller_releases_the_port() {
    let scratch = scratch("confirmed");
    let state = scratch.root.join("state");
    let held = TcpListener::bind(("127.0.0.1", 0)).expect("a held dashboard port");
    let port = held.local_addr().expect("an address").port();
    let ready_file = state.join("replacement").join("ready.json");
    let result = relaunch_confirmed(
        &settings(&scratch.root, port),
        &ready_file,
        15_000,
        Some("9.9.9"),
    )
    .await;
    assert!(result.is_ok(), "{}", result.unwrap_err());

    drop(held);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut pid = serve_pid(&state);
    while pid.is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        pid = serve_pid(&state);
    }
    let pid = pid.expect("the replacement binds the dashboard port");
    assert_ne!(pid, std::process::id(), "the replacement serves");
    stop(pid);
}

/// The replacement's startup reaping pass scans the process table and runs
/// once its listener is bound, never before the marker: on a busy host that
/// scan outlasts a caller's readiness deadline, and waiting for it turned every
/// source refresh into an `update-error`.
#[tokio::test]
async fn a_confirmed_replacement_is_ready_before_its_startup_reaping_pass() {
    let scratch = scratch("reaping");
    let state = scratch.root.join("state");
    let held = TcpListener::bind(("127.0.0.1", 0)).expect("a held dashboard port");
    let port = held.local_addr().expect("an address").port();
    let ready_file = state.join("replacement").join("ready.json");
    let result = relaunch_confirmed(
        &settings(&scratch.root, port),
        &ready_file,
        10_000,
        Some("9.9.9"),
    )
    .await;
    assert!(result.is_ok(), "{}", result.unwrap_err());
    assert_eq!(
        startup_passes(&state),
        0,
        "the marker is written before the startup reaping pass"
    );

    drop(held);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut pid = serve_pid(&state);
    while pid.is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        pid = serve_pid(&state);
    }
    let pid = pid.expect("the replacement binds the dashboard port");
    let deadline = Instant::now() + Duration::from_secs(30);
    while startup_passes(&state) == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        startup_passes(&state),
        1,
        "the startup reaping pass still runs once the port is bound"
    );
    stop(pid);
}

/// The environment block one process was started with.
fn process_environment(pid: u32) -> std::collections::HashMap<String, String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).expect("the child's environment");
    raw.split(|byte| *byte == 0)
        .filter_map(|entry| {
            let text = std::str::from_utf8(entry).ok()?;
            let (name, value) = text.split_once('=')?;
            Some((name.to_string(), value.to_string()))
        })
        .collect()
}

/// A restart passes no version, so the replacement must resolve the one it
/// loaded instead of inheriting the one its caller ran. The inherited value kept
/// a source dashboard reporting the release a publish had last refreshed to,
/// even while it served a newer build.
#[tokio::test]
async fn a_replacement_does_not_inherit_the_version_its_caller_ran() {
    std::env::set_var("DEVBOARD_RUNNING_VERSION", "9.9.9");
    let scratch = scratch("inherited-version");
    let state = scratch.root.join("state");
    let held = TcpListener::bind(("127.0.0.1", 0)).expect("a held dashboard port");
    let port = held.local_addr().expect("an address").port();
    let ready_file = state.join("replacement").join("ready.json");
    let result =
        relaunch_confirmed(&settings(&scratch.root, port), &ready_file, 15_000, None).await;
    std::env::remove_var("DEVBOARD_RUNNING_VERSION");
    assert!(result.is_ok(), "{}", result.unwrap_err());

    drop(held);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut pid = serve_pid(&state);
    while pid.is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        pid = serve_pid(&state);
    }
    let pid = pid.expect("the replacement binds the dashboard port");
    let environment = process_environment(pid);
    stop(pid);
    assert_ne!(
        environment
            .get("DEVBOARD_RUNNING_VERSION")
            .map(String::as_str),
        Some("9.9.9"),
        "a restart never hands its own version to the replacement"
    );
}

/// A replacement inherits the static root the operator configured, never the
/// caller's pid-named snapshot, so a dashboard started with `STATIC_DIR` keeps
/// serving that bundle after an update or restart instead of the embedded
/// client.
#[tokio::test]
async fn a_replacement_serves_the_static_root_its_caller_configured() {
    let scratch = scratch("static-root");
    let state = scratch.root.join("state");
    let static_root = scratch.root.join("client");
    std::fs::create_dir_all(&static_root).expect("a static root");
    std::fs::write(
        static_root.join("issue-1671-marker.txt"),
        "served from the configured static root\n",
    )
    .expect("a marker file");
    let held = TcpListener::bind(("127.0.0.1", 0)).expect("a held dashboard port");
    let port = held.local_addr().expect("an address").port();
    let ready_file = state.join("replacement").join("ready.json");
    let mut settings = settings(&scratch.root, port);
    settings.static_dir = Some(static_root.clone());
    let result = relaunch_confirmed(&settings, &ready_file, 15_000, None).await;
    assert!(result.is_ok(), "{}", result.unwrap_err());

    drop(held);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut pid = serve_pid(&state);
    while pid.is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        pid = serve_pid(&state);
    }
    let pid = pid.expect("the replacement binds the dashboard port");
    let environment = process_environment(pid);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .build()
        .expect("a client");
    let url = format!("http://127.0.0.1:{port}/issue-1671-marker.txt");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut answer = None;
    while answer.is_none() && Instant::now() < deadline {
        if let Ok(response) = client.get(&url).send().await {
            if response.status().is_success() {
                answer = response.text().await.ok();
            }
        }
        if answer.is_none() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    stop(pid);

    assert_eq!(
        environment.get("STATIC_DIR").map(String::as_str),
        static_root.to_str(),
        "the replacement names the configured static root"
    );
    assert_eq!(
        answer.as_deref(),
        Some("served from the configured static root\n"),
        "the replacement serves the configured static root, not the embedded client"
    );
}
