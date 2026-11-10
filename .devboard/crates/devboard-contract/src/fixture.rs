//! One in-process dashboard over the contract fixture.
//!
//! The corpus describes the answers this fixture dashboard gives: a copied
//! repository fixture, an empty state directory, and the fixture static root.
//! Every recording is produced and replayed here, so no replayed request ever
//! touches a real checkout, a real state directory, or a real forge.

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

/// The contract corpus directory.
pub fn contract_dir() -> PathBuf {
    harness_root().join("contract")
}

/// The nondeterminism allowlist the comparator reads.
pub fn allowlist_path() -> PathBuf {
    contract_dir().join("allowlist.json")
}

/// One fixture dashboard, alive until it is dropped.
pub struct Fixture {
    pub base: String,
    server: Arc<Server>,
}

impl Fixture {
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
        copy_tree(&contract_dir().join("fixtures/repo"), &repo)?;
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
        let listener = devboard::http::bind(&config.hostname, 0)
            .await
            .map_err(|error| format!("a listener: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("an address: {error}"))?
            .port();
        let mut config = config;
        config.port = port;
        let journal = Journal::open(&config.state_dir, &config.repo_dir, config.port);
        let server = Server::new(config, journal);
        let served = Arc::clone(&server);
        tokio::spawn(async move {
            let _ = devboard::http::serve_on(listener, served).await;
        });
        Ok(Self {
            base: format!("http://127.0.0.1:{port}"),
            server,
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.app.shared.shutdown.notify_waiters();
        if tokio::runtime::Handle::try_current().is_ok() {
            let app = Arc::clone(&self.server.app);
            tokio::spawn(async move {
                devboard::app::graceful_shutdown(&app).await;
            });
        }
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
