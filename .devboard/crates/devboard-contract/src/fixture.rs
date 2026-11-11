//! One in-process dashboard over the contract fixture.
//!
//! The corpus describes the answers this fixture dashboard gives: a copied
//! repository fixture that is its own git repository with a fixed origin, an
//! empty state directory, and the fixture static root. Every recording is
//! produced and replayed here, so no replayed request ever touches a real
//! checkout, a real state directory, or a real forge.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use devboard::config::Config;
use devboard::http::Server;
use devboard::journal::Journal;
use serde_json::Value;

use crate::http_table::{self, Allowlist, Case, Corpus, Observed};

/// The harness root that owns the corpus: the crate sits two levels below it.
pub fn harness_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The checkout that owns the harness root: the repository a dashboard started
/// from this source serves, with its default goal document and records.
pub fn repository_root() -> PathBuf {
    let root = harness_root().join("..");
    root.canonicalize().unwrap_or(root)
}

/// The contract corpus directory.
pub fn contract_dir() -> PathBuf {
    harness_root().join("contract")
}

/// The nondeterminism allowlist the comparator reads.
pub fn allowlist_path() -> PathBuf {
    contract_dir().join("allowlist.json")
}

/// The origin every copied repository fixture carries: a fixture fact, never
/// the origin of the checkout that holds the harness.
const FIXTURE_ORIGIN: &str = "https://example.test/fixture/repo.git";

/// Copies the repository fixture to `target` and makes it a git repository of
/// its own: one commit and a fixed origin. Every git fact the fixture
/// dashboard reads therefore comes from the fixture, so no `git -C` call can
/// walk up into the enclosing checkout and record that checkout's answer.
pub fn prepare_repository(target: &Path) -> Result<(), String> {
    copy_tree(&contract_dir().join("fixtures/repo"), target)?;
    git(target, &["init", "--quiet"])?;
    git(target, &["add", "--all"])?;
    git(
        target,
        &[
            "-c",
            "user.name=Contract Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--quiet",
            "--message",
            "fixture",
        ],
    )?;
    git(target, &["remote", "add", "origin", FIXTURE_ORIGIN])
}

/// Runs one git command in the fixture repository, naming the command and its
/// stderr when it fails.
fn git(repo: &Path, args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("{}: git: {error}", repo.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{}: git {}: {}",
            repo.display(),
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// One fixture dashboard over a copied repository, removed when it is dropped.
///
/// The dashboard runs on a runtime of its own, so dropping the fixture ends
/// every task it started — its lease heartbeat included — before the copied
/// repository and state directory go away.
pub struct Fixture {
    pub base: String,
    root: PathBuf,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    served: Option<std::thread::JoinHandle<()>>,
}

impl Fixture {
    /// The root this fixture created: its copied repository and state
    /// directory, removed when the fixture is dropped.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Starts one dashboard over a fresh copy of the repository fixture.
    pub async fn start(label: &str) -> Result<Self, String> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = harness_root().join(".test-tmp").join(format!(
            "contract-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let repo = root.join("repo");
        let state = root.join("state");
        std::fs::create_dir_all(&state).map_err(|error| format!("a state directory: {error}"))?;
        if let Err(error) = prepare_repository(&repo) {
            let _ = std::fs::remove_dir_all(&root);
            return Err(error);
        }
        let config = Config {
            hostname: "127.0.0.1".to_string(),
            port: 0,
            adrs_dir: repo.join("adrs"),
            repo_dir: repo.clone(),
            goal_file: repo.join("GOAL.md"),
            static_dir: Some(contract_dir().join("fixtures/static")),
            agent_command: "true".to_string(),
            state_dir: state,
            allowed_hosts: Vec::new(),
            feedback: None,
        };
        Self::start_with(root, config).await
    }

    /// Starts one dashboard over a supplied configuration and scratch root:
    /// it runs on a runtime of its own, and dropping the fixture ends it
    /// before that root goes away.
    pub async fn start_with(root: PathBuf, config: Config) -> Result<Self, String> {
        std::fs::create_dir_all(&config.state_dir)
            .map_err(|error| format!("{}: {error}", config.state_dir.display()))?;
        let (started, bound) = std::sync::mpsc::channel::<Result<u16, String>>();
        let (shutdown, stop) = tokio::sync::oneshot::channel::<()>();
        let served = std::thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = started.send(Err(format!("a fixture runtime: {error}")));
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match devboard::http::bind(&config.hostname, 0).await {
                    Ok(listener) => listener,
                    Err(error) => {
                        let _ = started.send(Err(format!("a listener: {error}")));
                        return;
                    }
                };
                let port = match listener.local_addr() {
                    Ok(address) => address.port(),
                    Err(error) => {
                        let _ = started.send(Err(format!("an address: {error}")));
                        return;
                    }
                };
                let mut config = config;
                config.port = port;
                let journal = Journal::open(&config.state_dir, &config.repo_dir, config.port);
                let server = Server::new(config, journal);
                let app = Arc::clone(&server.app);
                let shared = server.app.shared.clone();
                let serving =
                    tokio::spawn(async move { devboard::http::serve_on(listener, server).await });
                let _ = started.send(Ok(port));
                // The dashboard's own tasks wait on the same notification, so
                // every waiter is woken and the server ends before the root
                // this fixture created goes away.
                let _ = stop.await;
                shared.shutdown.notify_waiters();
                let _ = serving.await;
                devboard::app::graceful_shutdown(&app).await;
            });
        });
        let port = match bound.recv() {
            Ok(Ok(port)) => port,
            Ok(Err(error)) => {
                let _ = std::fs::remove_dir_all(&root);
                let _ = served.join();
                return Err(error);
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&root);
                let _ = served.join();
                return Err(format!("a fixture thread: {error}"));
            }
        };
        Ok(Self {
            base: format!("http://127.0.0.1:{port}"),
            root,
            shutdown: Some(shutdown),
            served: Some(served),
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(served) = self.served.take() {
            let _ = served.join();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Records every row the table names into `contract/http`, one recording per
/// row. Each row runs against its own fixture dashboard, so no row's answer
/// depends on the work an earlier row started, and every allowlisted value is
/// written as a placeholder of its type, so a re-recording names only a real
/// answer change.
pub async fn record(contract: &Path) -> Result<usize, String> {
    let allowlist = Allowlist::load(&contract.join("allowlist.json"))?;
    let client = http_table::client();
    let mut corpus = Corpus::default();
    for case in http_table::all_cases() {
        let fixture = Fixture::start(case.name).await?;
        let observed = http_table::send(&client, &fixture.base, &case).await?;
        corpus.insert(recording(&case, &observed, &allowlist));
    }
    corpus.write(&contract.join("http"))?;
    Ok(corpus.len())
}

/// Replays every row against its own fixture dashboard.
pub async fn replay(
    corpus: &Corpus,
    allowlist: &Allowlist,
) -> Result<Vec<(String, Result<Observed, String>)>, String> {
    let client = http_table::client();
    let mut results = Vec::new();
    for case in http_table::all_cases() {
        let fixture = Fixture::start(case.name).await?;
        let recording = corpus
            .get(case.name)
            .ok_or_else(|| format!("{}: no recording", case.name))?;
        let observed = http_table::send(&client, &fixture.base, &case).await;
        let result = observed.and_then(|observed| {
            http_table::check(&case, recording, allowlist, &observed)?;
            Ok(observed)
        });
        results.push((case.name.to_string(), result));
    }
    Ok(results)
}

/// The corpus entry one observed answer becomes.
fn recording(case: &Case, observed: &Observed, allowlist: &Allowlist) -> http_table::Recording {
    let json = observed
        .headers
        .get("content-type")
        .map(|value| value.contains("json"))
        .unwrap_or(false);
    let body = if json {
        serde_json::from_str(&observed.body)
            .unwrap_or_else(|_| serde_json::Value::String(observed.body.clone()))
    } else {
        serde_json::Value::String(observed.body.clone())
    };
    http_table::Recording {
        name: case.name.to_string(),
        method: case.method.as_str().to_string(),
        path: case.path.to_string(),
        status: observed.status,
        body: placeholder(&body, allowlist),
    }
}

/// Replaces every allowlisted value with a placeholder of its own type. The
/// comparator ignores those values and asserts the type, so the corpus names
/// the answer's stable content and a re-recording stays byte-identical.
fn placeholder(value: &Value, allowlist: &Allowlist) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let value = if allowlist.contains(key) {
                        typed_placeholder(value)
                    } else {
                        placeholder(value, allowlist)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| placeholder(item, allowlist))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn typed_placeholder(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::Bool(_) => Value::Bool(false),
        Value::Number(_) => Value::from(0),
        Value::String(_) => Value::String(String::new()),
        Value::Array(_) => Value::Array(Vec::new()),
        Value::Object(_) => Value::Object(serde_json::Map::new()),
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|error| format!("{}: {error}", target.display()))?;
    let entries =
        std::fs::read_dir(source).map_err(|error| format!("{}: {error}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|error| format!("{}: {error}", from.display()))?;
        }
    }
    Ok(())
}
