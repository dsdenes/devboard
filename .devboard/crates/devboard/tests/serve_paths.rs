//! The paths a serve start resolves: the derived repository and goal document
//! follow the values the environment and the serve flags leave in force, and a
//! repository directory that does not exist still refuses the start.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_devboard")
}

fn harness_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the devboard harness directory exists")
}

struct Scratch {
    path: PathBuf,
    releases: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after the epoch")
            .as_nanos();
        let root = harness_root().join(".test-tmp");
        std::fs::create_dir_all(&root).expect("the scratch root");
        let path = root.join(format!(
            "serve-paths-{label}-{}-{nanos}",
            std::process::id()
        ));
        let releases = path.join("releases");
        std::fs::create_dir_all(&releases).expect("an empty release source");
        Self { path, releases }
    }

    fn repository(&self, name: &str) -> PathBuf {
        let repo = self.path.join(name);
        std::fs::create_dir_all(repo.join("adrs")).expect("an ADR directory");
        std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");
        repo
    }

    fn state(&self) -> PathBuf {
        let state = self.path.join("state");
        std::fs::create_dir_all(&state).expect("a state directory");
        state
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if std::env::var_os("DEVBOARD_KEEP_TEST_SCRATCH").is_none() {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn write_adr(directory: &Path, file: &str, title: &str) {
    std::fs::create_dir_all(directory).expect("an ADR directory");
    std::fs::write(
        directory.join(file),
        format!(
            "---\ntitle: {title}\nstatus: accepted\n---\n\n## Decision\n\nThe record stands.\n"
        ),
    )
    .expect("an ADR");
}

/// The environment a serve start receives with no path variable supplied: the
/// fixture is its own release source and its own reporting target, so no
/// published release installs a newer binary mid-assert and no source-checkout
/// forge discovery runs.
fn base_env(scratch: &Scratch, repo: &Path, state: &Path) -> ProcessCommand {
    let mut command = ProcessCommand::new(binary());
    command
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", repo)
        .env("HOST", "127.0.0.1")
        .env("STATE_DIR", state)
        .env("AGENT_COMMAND", format!("{} acp-stub", binary()))
        .env("DEVBOARD_OWNER_EXECUTABLE", binary())
        .env("DEVBOARD_UPDATE_INTERVAL_MS", "3600000")
        .env("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1")
        .env("DEVBOARD_RELEASE_URL", &scratch.releases)
        .env("DEVBOARD_GITEA_URL", "http://127.0.0.1:1")
        .env("DEVBOARD_DASHBOARD_SINGLETON_FIXTURE", "1")
        .env("DEVBOARD_WATCHDOG_FIXTURE", "1");
    command
}

struct Dashboard {
    scratch: Scratch,
    state: PathBuf,
    child: Child,
}

impl Dashboard {
    /// Starts a dashboard whose only path input is `args`, from an environment
    /// that names no ADR directory, repository, or goal file.
    fn start(scratch: Scratch, args: &[&OsStr]) -> Self {
        let state = scratch.state();
        let log = std::fs::File::create(scratch.path.join("dashboard.log")).expect("a log");
        let mut command = base_env(&scratch, &scratch.path, &state);
        command
            .arg("serve")
            .arg("--port")
            .arg("0")
            .arg("--state-dir")
            .arg(&state)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().expect("a log handle")))
            .stderr(Stdio::from(log));
        let child = command.spawn().expect("the dashboard starts");
        Self {
            scratch,
            state,
            child,
        }
    }

    async fn port(&self) -> u16 {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let port = std::fs::read_to_string(self.state.join("version.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| value["port"].as_u64())
                .and_then(|port| u16::try_from(port).ok())
                .unwrap_or(0);
            if port > 0 && ready(port).await {
                return port;
            }
            assert!(
                Instant::now() < deadline,
                "the dashboard became ready; log:\n{}",
                std::fs::read_to_string(self.scratch.path.join("dashboard.log"))
                    .unwrap_or_default()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Dashboard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn ready(port: u16) -> bool {
    client()
        .get(format!("http://127.0.0.1:{port}/ready"))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .expect("a client")
}

async fn frames(port: u16, path: &str) -> Vec<Value> {
    let response = client()
        .get(format!("http://127.0.0.1:{port}{path}"))
        .send()
        .await
        .expect("an answer");
    assert_eq!(response.status(), 200, "{path}");
    let body: Value = response.json().await.expect("a JSON body");
    body["frames"].as_array().cloned().unwrap_or_default()
}

/// The goal document the served repository resolves: `<repo_dir>/GOAL.md`.
async fn goal_text(port: u16) -> String {
    frames(port, "/goal")
        .await
        .iter()
        .find(|frame| frame["type"] == "goal")
        .and_then(|frame| frame["text"].as_str())
        .expect("the goal frame")
        .to_string()
}

/// The ADR files the served ADR directory resolves.
async fn record_files(port: u16) -> Vec<String> {
    frames(port, "/records")
        .await
        .iter()
        .find(|frame| frame["type"] == "records")
        .and_then(|frame| frame["records"].as_array())
        .map(|records| {
            records
                .iter()
                .filter_map(|record| record["file"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_flags_only_start_serves_the_adrs_directory_parent() {
    let scratch = Scratch::new("flags-only");
    let repo = scratch.repository("served");
    std::fs::write(repo.join("GOAL.md"), "# The flag-only goal\n").expect("a goal");
    write_adr(&repo.join("adrs"), "0001-flag-only.md", "Flag only");
    let adrs_dir = repo.join("adrs");

    let dashboard = Dashboard::start(scratch, &[OsStr::new("--adrs-dir"), adrs_dir.as_os_str()]);
    let port = dashboard.port().await;

    assert_eq!(goal_text(port).await, "# The flag-only goal\n");
    assert_eq!(
        record_files(port).await,
        vec!["0001-flag-only.md".to_string()]
    );
}

#[tokio::test]
async fn a_repository_flag_stays_authoritative_beside_an_adrs_flag() {
    let scratch = Scratch::new("both-flags");
    let served = scratch.repository("served");
    let adr_source = scratch.repository("adr-source");
    std::fs::write(served.join("GOAL.md"), "# The served repository's goal\n").expect("a goal");
    write_adr(&served.join("adrs"), "0002-decoy.md", "Decoy");
    write_adr(&adr_source.join("adrs"), "0001-flagged.md", "Flagged");
    let adrs_dir = adr_source.join("adrs");

    let dashboard = Dashboard::start(
        scratch,
        &[
            OsStr::new("--repo-dir"),
            served.as_os_str(),
            OsStr::new("--adrs-dir"),
            adrs_dir.as_os_str(),
        ],
    );
    let port = dashboard.port().await;

    assert_eq!(goal_text(port).await, "# The served repository's goal\n");
    assert_eq!(
        record_files(port).await,
        vec!["0001-flagged.md".to_string()]
    );
}

#[test]
fn a_derived_repository_that_does_not_exist_refuses_the_start() {
    let scratch = Scratch::new("missing");
    let absent = scratch.path.join("absent");
    let state = scratch.state();
    let mut command = base_env(&scratch, &scratch.path, &state);
    command
        .arg("serve")
        .arg("--adrs-dir")
        .arg(absent.join("adrs"))
        .arg("--port")
        .arg("0")
        .arg("--state-dir")
        .arg(&state);
    let output = command.output().expect("serve runs");

    assert!(!output.status.success(), "the start is refused");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("the repository directory"), "{stderr}");
    assert!(stderr.contains(&absent.display().to_string()), "{stderr}");
}
