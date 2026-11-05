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
        state_dir: root.join("state"),
        token: "replacement-token".to_string(),
        bootstrap: "replacement-bootstrap".to_string(),
    }
}

fn serve_pid(state: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(state.join("version.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value["pid"].as_u64().map(|pid| pid as u32)
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
async fn the_replacement_readiness_listener_answers_only_the_inherited_credential() {
    let (port, task) = start_readiness_listener("replacement-token".to_string())
        .await
        .expect("a readiness listener");
    let pid = std::process::id();
    assert!(probe_ready(port, "replacement-token", Some(pid)).await);
    assert!(!probe_ready(port, "wrong-token", Some(pid)).await);
    assert!(
        !probe_ready(port, "replacement-token", Some(pid.wrapping_add(1))).await,
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
