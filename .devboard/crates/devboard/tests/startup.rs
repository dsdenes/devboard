//! Every dashboard start runs one reaping pass, journals it, and never
//! signals a live recorded child.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn root(label: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("startup-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn reaped_lines(state: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(state.join("supervision/reaped.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[test]
fn a_recorded_dead_child_is_reaped_and_the_pass_is_journaled() {
    let directory = root("dead");
    let state = directory.join("state");
    let repo = directory.join("repo");
    let supervision = state.join("supervision");
    std::fs::create_dir_all(&supervision).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(
        supervision.join("4294967000.json"),
        serde_json::json!({
            "version": 1,
            "pid": 4_294_967_000u64,
            "argv": ["devboard", "worker"],
            "cwd": repo.to_string_lossy(),
            "ownerPid": 4_294_967_001u64,
            "startedAt": "2026-01-01T00:00:00.000Z",
            "startTicks": 1,
            "pgid": 4_294_967_000u64,
        })
        .to_string(),
    )
    .unwrap();

    devboard::workers::watchdog::reap_on_startup(&state, &repo);

    let lines = reaped_lines(&state);
    // The pass also covers every live dashboard's state directory, so this
    // journal may carry a decision about a child recorded elsewhere; exactly
    // one record is this start's own pass.
    let passes = lines
        .iter()
        .filter(|line| line["pass"] == "startup")
        .count();
    assert_eq!(passes, 1, "one pass record: {lines:?}");
    assert!(!supervision.join("4294967000.json").exists());
    let _ = std::fs::remove_dir_all(&directory);
}

#[tokio::test]
async fn a_live_recorded_child_with_a_live_owner_is_never_signalled() {
    let directory = root("live");
    let state = directory.join("state");
    let repo = directory.join("repo");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    let argv = vec!["sleep".to_string(), "60".to_string()];
    let pid = devboard::supervision::supervised_detach(
        &argv,
        devboard::supervision::SupervisedDetachOptions {
            cwd: repo.clone(),
            env: HashMap::from([(
                "PATH".to_string(),
                std::env::var("PATH").unwrap_or_default(),
            )]),
            state_dir: Some(state.clone()),
            stdio: devboard::supervision::DetachStdio::ignore(),
            on_error: None,
        },
    )
    .expect("the child starts");
    assert!(devboard::supervision::live_process(pid));

    devboard::workers::watchdog::reap_on_startup(&state, &repo);

    assert!(
        devboard::supervision::live_process(pid),
        "a live recorded child with a live owner is protected"
    );
    let lines = reaped_lines(&state);
    // As above, a decision about a child recorded in another live state
    // directory can share this journal; the pass record is this start's own.
    let passes = lines
        .iter()
        .filter(|line| line["pass"] == "startup")
        .count();
    assert_eq!(passes, 1, "one pass record: {lines:?}");
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    let _ = std::fs::remove_dir_all(&directory);
}

/// A request that reaches the dashboard's port while the dashboard starts is
/// either refused or answered, never accepted and then left to wait: a read
/// that queues behind the startup fan-out breaches the 1000 ms slow-action
/// budget even when its own handler answers in milliseconds.
#[tokio::test]
async fn a_read_during_startup_is_refused_or_answered_within_the_budget() {
    use std::time::{Duration, Instant};

    let directory = root("window");
    let repo = directory.join("repo");
    let state = directory.join("state");
    let shim = directory.join("bin");
    std::fs::create_dir_all(repo.join("adrs")).unwrap();
    std::fs::create_dir_all(repo.join(".devboard")).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir_all(&shim).unwrap();
    std::fs::write(repo.join("GOAL.md"), "# Goal\n").unwrap();
    // A source harness manifest makes the running-version read spawn git. The
    // shim makes that read cost 1.2 s, which is what a listener bound before
    // the read would hold a request behind.
    std::fs::write(
        repo.join(".devboard/devboard.json"),
        serde_json::json!({"name": "@dsdenes/devboard", "version": "0.1.0"}).to_string(),
    )
    .unwrap();
    std::fs::write(
        shim.join("git"),
        format!("#!/bin/sh\nsleep 1.2\nexec '{}' \"$@\"\n", real_git()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(shim.join("git"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let binary = env!("CARGO_BIN_EXE_devboard");
    // The port is held for the first 300 ms, so a start's own bind attempt is
    // the one observed here and no other process can claim it.
    let held = std::net::TcpListener::bind("127.0.0.1:0").expect("a free port");
    let port = held.local_addr().unwrap().port();
    let log_path = directory.join("serve.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let mut command = std::process::Command::new(binary);
    command
        .arg("serve")
        .arg("--repo-dir")
        .arg(&repo)
        .arg("--port")
        .arg(port.to_string())
        .arg("--state-dir")
        .arg(&state)
        .env_clear()
        .env(
            "PATH",
            format!(
                "{}:{}",
                shim.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .env("HOME", &repo)
        .env("HOST", "127.0.0.1")
        .env("ADRS_DIR", repo.join("adrs"))
        .env("REPO_DIR", &repo)
        .env("GOAL_FILE", repo.join("GOAL.md"))
        .env("STATE_DIR", &state)
        .env("DEVBOARD_RUNNING_HARNESS_DIR", repo.join(".devboard"))
        .env("AGENT_COMMAND", format!("{binary} acp-stub"))
        .env("DEVBOARD_OWNER_EXECUTABLE", binary)
        .env("DEVBOARD_UPDATE_INTERVAL_MS", "3600000")
        .env("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1")
        .env("DEVBOARD_GITEA_URL", "http://127.0.0.1:1")
        .env("DEVBOARD_DASHBOARD_SINGLETON_FIXTURE", "1")
        .env("DEVBOARD_WATCHDOG_FIXTURE", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log.try_clone().unwrap()))
        .stderr(std::process::Stdio::from(log));
    let mut child = command.spawn().expect("the dashboard starts");
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(held);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1_500))
        .build()
        .unwrap();
    let budget = Duration::from_millis(1_000);
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut served = false;
    let mut failure: Option<String> = None;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            failure = Some(format!(
                "the dashboard exited before it served ({status}):\n{}",
                std::fs::read_to_string(&log_path).unwrap_or_default()
            ));
            break;
        }
        let started = Instant::now();
        let answer = client
            .get(format!("http://127.0.0.1:{port}/project"))
            .header("accept", "application/json")
            .send()
            .await;
        let elapsed = started.elapsed();
        match answer {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if !status.is_success() {
                    failure = Some(format!("the dashboard refused the read: {status} {body}"));
                } else if elapsed >= budget {
                    failure = Some(format!(
                        "a read accepted during startup waited {elapsed:?} for its answer"
                    ));
                } else {
                    served = true;
                }
                break;
            }
            Err(error) => {
                // A refused connection is the honest unready state: the page
                // retries. A read that the kernel accepted and then held is
                // the slow path this test exists for.
                if error.is_timeout() || elapsed >= budget {
                    failure = Some(format!(
                        "a read accepted during startup waited {elapsed:?} for its answer: {error}"
                    ));
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&directory);
    if let Some(message) = failure {
        panic!("{message}");
    }
    assert!(served, "the dashboard never answered /project within 30 s");
}

/// The git on this process's PATH, which the shim delegates to.
fn real_git() -> String {
    for directory in std::env::var("PATH").unwrap_or_default().split(':') {
        let candidate = Path::new(directory).join("git");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    panic!("git is on PATH");
}
