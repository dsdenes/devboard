//! The paths a serve start resolves: the derived repository and goal document
//! follow the values the environment and the serve flags leave in force, a
//! repository directory that does not exist still refuses the start, and forge
//! discovery reads the served repository rather than the working directory.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
        Self::spawn(scratch, args, |_| {})
    }

    /// Starts a dashboard whose only path input is `ADRS_DIR`, from a working
    /// directory of `cwd` and an environment that names no Gitea target, so its
    /// forge discovery runs against the checkout this start resolves.
    fn start_discovering(scratch: Scratch, adrs_dir: &Path, cwd: &Path) -> Self {
        Self::spawn(scratch, &[], |command| {
            command
                .env_remove("DEVBOARD_GITEA_URL")
                .env("ADRS_DIR", adrs_dir)
                .current_dir(cwd);
        })
    }

    fn spawn(
        scratch: Scratch,
        args: &[&OsStr],
        configure: impl FnOnce(&mut ProcessCommand),
    ) -> Self {
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
        configure(&mut command);
        let child = command.spawn().expect("the dashboard starts");
        Self {
            scratch,
            state,
            child,
        }
    }

    async fn port(&self) -> u16 {
        // One start forks, reaps over the whole process table, reads the slice
        // with systemctl, and resolves the harness version through bounded git
        // reads before it binds; a loaded host starves every stage by seconds,
        // so the budget bounds a stall above the slowest stage.
        let deadline = Instant::now() + Duration::from_secs(120);
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

/// Whether the dashboard's `versionState` reports harness reporting enabled,
/// which only a Gitea target its startup resolved sets.
async fn feedback_enabled(port: u16) -> bool {
    frames(port, "/version")
        .await
        .iter()
        .find(|frame| frame["type"] == "versionState")
        .and_then(|frame| frame["feedbackEnabled"].as_bool())
        .expect("the version frame")
}

/// Runs one fixture git command and fails the test unless it succeeds.
fn run_git(repo: &Path, args: &[&str]) {
    let status = ProcessCommand::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .status()
        .expect("git runs");
    assert!(
        status.success(),
        "git {args:?} succeeds in {}",
        repo.display()
    );
}

/// A git checkout below the scratch path, carrying `origin` and, when `source`
/// is set, the source manifest a forge discovery probe reads before its origin.
fn checkout(scratch: &Scratch, name: &str, origin: &str, source: bool) -> PathBuf {
    let repo = scratch.repository(name);
    if source {
        std::fs::write(
            repo.join(".devboard/package.json"),
            "{\"name\":\"@dsdenes/devboard\",\"version\":\"1.57.7\"}\n",
        )
        .expect("a source manifest");
    }
    run_git(&repo, &["init", "--quiet"]);
    run_git(&repo, &["remote", "add", "origin", origin]);
    repo
}

/// A loopback HTTP server answering the one document a Gitea discovery probe
/// reads, so a start whose discovery probes this fixture's checkout resolves a
/// reporting target instead of finding none.
struct GiteaStub {
    port: u16,
    stop: Arc<AtomicBool>,
}

impl GiteaStub {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback listener");
        let port = listener.local_addr().expect("a bound address").port();
        listener
            .set_nonblocking(true)
            .expect("a non-blocking listener");
        let stop = Arc::new(AtomicBool::new(false));
        let running = Arc::clone(&stop);
        let _ = std::thread::spawn(move || {
            while !running.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => answer_version(stream),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Self { port, stop }
    }

    fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for GiteaStub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Answers one probe with the documented `GET /api/v1/version` document.
fn answer_version(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut request = [0u8; 1024];
    let _ = stream.read(&mut request);
    let body = "{\"version\":\"1.21.0\"}";
    let headers = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\
         connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

/// A start that names only the ADR directory serves the repository that
/// directory implies, and forge discovery reads that served checkout, never the
/// working directory. The working directory here belongs to another checkout,
/// so discovery of the served loopback source repository is the only way the
/// dashboard reports harness reporting enabled.
#[tokio::test]
async fn discovery_reads_the_served_repository_not_the_working_directory() {
    let scratch = Scratch::new("discovery-repo");
    let served = checkout(&scratch, "served", "git@localhost:owner/served.git", true);
    let elsewhere = checkout(
        &scratch,
        "elsewhere",
        "git@localhost:owner/elsewhere.git",
        false,
    );
    let adrs_dir = served.join("adrs");
    let gitea = GiteaStub::start();
    assert_ne!(gitea.port(), 0, "the stub listens");

    let dashboard = Dashboard::start_discovering(scratch, &adrs_dir, &elsewhere);
    let port = dashboard.port().await;

    assert!(
        feedback_enabled(port).await,
        "discovery resolved the loopback Gitea origin of the served checkout"
    );
}

#[tokio::test]
async fn an_unreadable_record_is_reported_instead_of_dropped_from_the_listing() {
    let scratch = Scratch::new("unreadable-record");
    let repo = scratch.repository("served");
    std::fs::write(repo.join("GOAL.md"), "# The served goal\n").expect("a goal");
    let adrs_dir = repo.join("adrs");
    std::fs::write(adrs_dir.join("0001-unreadable.md"), [0x66, 0x80])
        .expect("an unreadable record");
    write_adr(&adrs_dir, "0002-readable.md", "Readable record");

    let dashboard = Dashboard::start(scratch, &[OsStr::new("--adrs-dir"), adrs_dir.as_os_str()]);
    let port = dashboard.port().await;

    let answered = frames(port, "/records").await;
    assert!(
        answered
            .iter()
            .all(|frame| frame["type"].as_str() != Some("records")),
        "an unreadable record never yields a listing: {answered:?}"
    );
    let message = answered
        .iter()
        .find(|frame| frame["type"].as_str() == Some("error"))
        .and_then(|frame| frame["message"].as_str())
        .expect("the report");
    assert!(message.contains("0001-unreadable.md"), "{message}");
}
