//! A real `devboard serve` dashboard: discovery, the published credential,
//! the MCP status answer, the watchdog's own discovery, and cleanup coverage.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let index = COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("discovery-{label}-{}-{index}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    root
}

struct Dashboard {
    root: PathBuf,
    repo: PathBuf,
    state: PathBuf,
    child: Child,
    pid: u32,
    port: u16,
}

impl Dashboard {
    fn start(label: &str) -> Self {
        Self::start_with(label, None, None)
    }

    #[allow(clippy::type_complexity)]
    fn start_with(
        label: &str,
        agent: Option<String>,
        prepare: Option<&dyn Fn(&Path, &Path)>,
    ) -> Self {
        let root = scratch(label);
        let repo = root.join("repo");
        let state = root.join("state");
        std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");
        std::fs::create_dir_all(&state).expect("a state directory");
        let status = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["init", "--quiet"])
            .status()
            .expect("git runs");
        assert!(status.success());
        if let Some(prepare) = prepare {
            prepare(&repo, &state);
        }
        std::fs::write(repo.join("README.md"), "# Fixture\n").unwrap();
        for args in [
            vec!["add", "README.md"],
            vec![
                "-c",
                "user.name=Discovery Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-q",
                "-m",
                "fixture",
            ],
        ] {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(&args)
                .status()
                .expect("git runs");
            assert!(status.success());
        }
        let mut command = Command::new(env!("CARGO_BIN_EXE_devboard"));
        if let Some(agent) = &agent {
            command.env("AGENT_COMMAND", agent);
        }
        let child = command
            .args(["serve", "--repo-dir"])
            .arg(&repo)
            .arg("--port")
            .arg("0")
            .env("REPO_DIR", &repo)
            .env("STATE_DIR", &state)
            .env("HOST", "127.0.0.1")
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("DEVBOARD_UPDATE_INTERVAL_MS", "3600000")
            .env("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1")
            .env("DEVBOARD_OPENROUTER_USAGE_BASE_URL", "http://127.0.0.1:1")
            .env_remove("DEVBOARD_GITEA_URL")
            .env_remove("GITEA_URL")
            .env_remove("GITEA_TOKEN")
            .env_remove("DEVBOARD_RELEASE_URL")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(
                std::fs::File::create(root.join("dashboard.log"))
                    .map(Stdio::from)
                    .unwrap_or_else(|_| Stdio::null()),
            )
            .spawn()
            .expect("the dashboard starts");
        let marker = state.join("version.json");
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut pid = 0;
        let mut port = 0;
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&marker) {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    pid = value.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
                    port = value.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
                    if pid != 0 && port != 0 {
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(pid != 0 && port != 0, "the dashboard published its marker");
        Self {
            root,
            repo,
            state,
            child,
            pid,
            port,
        }
    }

    fn environ(&self) -> String {
        std::fs::read(format!("/proc/{}/environ", self.pid))
            .map(|raw| String::from_utf8_lossy(&raw).replace('\0', "\n"))
            .unwrap_or_default()
    }
}

impl Drop for Dashboard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if std::env::var_os("DEVBOARD_KEEP_TEST_SCRATCH").is_none() {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

fn mcp_status(repo: &Path, state: &Path) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_devboard"))
        .arg("mcp")
        .current_dir(repo)
        .env("REPO_DIR", repo)
        .env("STATE_DIR", state)
        .env("HOST", "127.0.0.1")
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the MCP server starts");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        for request in [
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-01-01"}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "devboard_status", "arguments": {}}}),
        ] {
            writeln!(stdin, "{}", serde_json::to_string(&request).unwrap()).expect("a request");
        }
    }
    drop(child.stdin.take());
    let stdout = child.stdout.take().expect("stdout");
    let mut frames = Vec::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Ok(frame) = serde_json::from_str::<Value>(&line) {
            frames.push(frame);
        }
    }
    let _ = child.wait();
    let reply = frames
        .iter()
        .find(|frame| frame["id"] == 2)
        .expect("a status reply");
    let text = reply["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    serde_json::from_str(text).expect("status JSON")
}

#[test]
fn a_dashboard_is_discovered_by_every_surface() {
    let first = Dashboard::start("one");
    let second = Dashboard::start("two");

    let instances = devboard::workers::watchdog::discover_instances_for(&first.repo);
    let matching: Vec<_> = instances
        .iter()
        .filter(|instance| instance.repo_dir == first.repo.to_string_lossy())
        .collect();
    assert_eq!(matching.len(), 1, "{instances:?}");
    assert_eq!(matching[0].pid, first.pid);
    assert_eq!(matching[0].port, first.port as u32);
    let second_instances = devboard::workers::watchdog::discover_instances_for(&second.repo);
    let second_matching: Vec<_> = second_instances
        .iter()
        .filter(|instance| instance.repo_dir == second.repo.to_string_lossy())
        .collect();
    assert_eq!(second_matching.len(), 1);
    assert_eq!(second_matching[0].pid, second.pid);

    let status = mcp_status(&first.repo, &first.state);
    assert_eq!(status["dashboard"]["pid"], json!(first.pid));
    assert_eq!(status["dashboard"]["port"], json!(first.port));
    let second_status = mcp_status(&second.repo, &second.state);
    assert_eq!(second_status["dashboard"]["pid"], json!(second.pid));

    let output = Command::new(env!("CARGO_BIN_EXE_devboard"))
        .args(["worker", "watchdog", "--collect", "--dry-run", "--repo"])
        .arg(&first.repo)
        .arg("--state-dir")
        .arg(first.state.join("watchdog"))
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .output()
        .expect("the watchdog runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).expect("a JSON report");
    let reported: Vec<&Value> = report["instances"]
        .as_array()
        .expect("instances")
        .iter()
        .filter(|instance| instance["repoDir"] == json!(first.repo.to_string_lossy()))
        .collect();
    assert_eq!(reported.len(), 1, "{report}");
    assert_eq!(reported[0]["pid"], json!(first.pid));
    assert_eq!(reported[0]["port"], json!(first.port));

    let cleanup = Command::new(env!("CARGO_BIN_EXE_devboard"))
        .args(["cleanup", "--dry-run", "--json", "--root"])
        .arg(&first.repo)
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .output()
        .expect("cleanup runs");
    assert!(cleanup.status.success());
    let report: Value = serde_json::from_slice(&cleanup.stdout).expect("a cleanup report");
    let covered: Vec<String> = report["roots"]
        .as_array()
        .expect("roots")
        .iter()
        .filter_map(|root| root["stateDir"].as_str().map(str::to_string))
        .collect();
    let state = first
        .state
        .canonicalize()
        .unwrap_or_else(|_| first.state.clone());
    assert!(
        covered.iter().any(|root| std::fs::canonicalize(root)
            .unwrap_or_else(|_| PathBuf::from(root))
            == state),
        "cleanup covers the dashboard STATE_DIR: {covered:?}"
    );
}

#[test]
fn a_started_dashboard_publishes_no_dashboard_credential() {
    let dashboard = Dashboard::start("credentials");
    let environ = dashboard.environ();
    for family in ["DASHBOARD", "BOOTSTRAP"] {
        let name = format!("DEVBOARD_{family}_TOKEN=");
        assert!(!environ.contains(&name), "{environ}");
    }
    let instances = devboard::workers::watchdog::discover_instances_for(&dashboard.repo);
    let instance = instances
        .iter()
        .find(|instance| instance.pid == dashboard.pid)
        .expect("the instance");
    assert_eq!(instance.repo_dir, dashboard.repo.to_string_lossy());

    // The REST control surface answers without a credential.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let frames: Vec<Value> = runtime.block_on(async {
        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{}/version", dashboard.port))
            .header("accept", "application/json")
            .send()
            .await
            .expect("the REST API answers without a credential");
        let body: Value = response.json().await.expect("JSON");
        body["frames"].as_array().cloned().unwrap_or_default()
    });
    assert!(
        frames.iter().any(|frame| frame["type"] == "versionState"),
        "the credential-free socket answers the expected state: {frames:?}"
    );
}

#[test]
fn sigterm_ends_the_child_and_removes_the_staging() {
    use devboard::providers::{save_subscriptions, ProviderId, StoredSubscription};

    let seed = |repo: &Path, state: &Path| {
        save_subscriptions(
            state,
            &[StoredSubscription {
                id: "fixture-subscription".to_string(),
                provider: ProviderId::OpenCodeGo,
                label: "Fixture".to_string(),
                key: "sk-fixture-shutdown-key".to_string(),
                enabled: true,
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            }],
        )
        .expect("the fixture credentials");
        let prompts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../prompts");
        std::fs::create_dir_all(repo.join(".devboard/prompts")).unwrap();
        for entry in std::fs::read_dir(&prompts).expect("the prompts").flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("discover-") && name.ends_with(".md") {
                std::fs::copy(entry.path(), repo.join(".devboard/prompts").join(&name))
                    .expect("a prompt");
            }
        }
    };
    let dashboard = Dashboard::start_with(
        "shutdown",
        Some(format!(
            "{} acp-stub --discover --discover-delay-ms=30000",
            env!("CARGO_BIN_EXE_devboard")
        )),
        Some(&seed),
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("a runtime");
    let run_id = runtime.block_on(async {
        let client = reqwest::Client::new();
        client
            .post(format!(
                "http://127.0.0.1:{}/discoveries/agent-scans",
                dashboard.port
            ))
            .header("accept", "application/json")
            .json(&json!({"agent": "discover-testing-strategy"}))
            .send()
            .await
            .expect("the start request");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let response = client
                .get(format!(
                    "http://127.0.0.1:{}/discoveries/workspace",
                    dashboard.port
                ))
                .header("accept", "application/json")
                .send()
                .await
                .expect("a workspace read");
            let body: Value = response.json().await.expect("JSON");
            if let Some(run_id) = body["frames"].as_array().and_then(|frames| {
                frames.iter().find_map(|frame| {
                    if frame["type"] == "discoverState" {
                        frame["state"]["runId"].as_str().map(str::to_string)
                    } else {
                        None
                    }
                })
            }) {
                return run_id;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the discover run started"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    });
    let staging = dashboard.repo.join(".omp/discover/staging").join(&run_id);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !staging.exists() {
        if Instant::now() >= deadline {
            let log =
                std::fs::read_to_string(dashboard.root.join("dashboard.log")).unwrap_or_default();
            panic!("the run staged its inputs: {log}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let children: Vec<u32> = loop {
        let children: Vec<u32> = devboard::supervision::process_table()
            .into_iter()
            .filter(|process| process.ancestors.contains(&dashboard.pid))
            .map(|process| process.pid)
            .collect();
        if !children.is_empty() || Instant::now() >= deadline {
            break children;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(!children.is_empty(), "the stub peer is a child");

    let status = Command::new("kill")
        .args(["-TERM", &dashboard.pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(status.success());
    let deadline = Instant::now() + Duration::from_secs(5);
    while devboard::supervision::live_process(dashboard.pid) {
        assert!(
            Instant::now() < deadline,
            "the dashboard stops within five seconds"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !staging.exists(),
        "the stopping dashboard removed its staging directory"
    );
    for pid in &children {
        assert!(
            !devboard::supervision::live_process(*pid),
            "no child of the dashboard remains ({pid})"
        );
    }
    let marker = std::fs::read_to_string(dashboard.state.join("version.json")).expect("a marker");
    let value: Value = serde_json::from_str(&marker).expect("a valid marker");
    assert_eq!(value["pid"], json!(dashboard.pid));
    let state_file = devboard::state::state_file(&dashboard.state, &dashboard.repo);
    let text = std::fs::read_to_string(&state_file).expect("a persisted state file");
    serde_json::from_str::<Value>(&text).expect("the state file is valid");
}
