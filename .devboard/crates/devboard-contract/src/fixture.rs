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
use std::time::{Duration, Instant};

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
/// stderr when it fails. The call is hermetic against the host's git
/// configuration: signing stays off and the initial branch is `main` whatever
/// the user's config says, no system config applies, and an inherited
/// `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_INDEX_FILE` cannot redirect the command
/// away from the copied fixture, which `git -C` alone does not neutralize.
fn git(repo: &Path, args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
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

/// Seeds a fixture dashboard's Flow root with one stored session and the
/// restore hold: the dashboard restores the session and then waits on the hold
/// file, so a read answers while the restore is still running. The file stays
/// for the fixture's whole life, exactly as the recorded row needs it.
fn seed_held_restore(state: &Path, repo: &Path) -> Result<(), String> {
    let root = state.join("flow").join(devboard::journal::repo_key(repo));
    let id = "seeded-session";
    let directory = root.join(id);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("{}: {error}", directory.display()))?;
    let session = serde_json::json!({
        "id": id,
        "version": 1,
        "worktree": repo.join(format!(".worktree/flow-{id}")).to_string_lossy(),
        "branch": format!("flow/{id}"),
        "status": "idle",
        "goal": "The stored session the fixture holds.",
    });
    let path = directory.join("session.json");
    let text = serde_json::to_vec_pretty(&session).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| format!("{}: {error}", path.display()))?;
    let hold = root.join(devboard::flow_mode::RESTORE_HOLD_FILE);
    std::fs::write(&hold, "").map_err(|error| format!("{}: {error}", hold.display()))
}

/// How long a dropped fixture waits for its dashboard to stop. A fixture that
/// never stops is reported instead of joined, because a test suite with no
/// per-test bound must never hang on a dashboard.
const FIXTURE_STOP_BOUND: Duration = Duration::from_secs(120);

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
    /// `hold_flow_restore` seeds a stored Flow session and the restore hold
    /// first, so the dashboard's restore cannot finish before a row reads it.
    pub async fn start(label: &str, hold_flow_restore: bool) -> Result<Self, String> {
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
        if hold_flow_restore {
            if let Err(error) = seed_held_restore(&state, &repo) {
                let _ = std::fs::remove_dir_all(&root);
                return Err(error);
            }
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
                // The dashboard's own tasks wait on the same signal, so every
                // waiter wakes — whichever of them registered first, and even
                // one this runtime has not polled yet — and the server ends
                // before the root this fixture created goes away.
                let _ = stop.await;
                shared.shutdown.signal();
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
        let Some(served) = self.served.take() else {
            let _ = std::fs::remove_dir_all(&self.root);
            return;
        };
        let deadline = Instant::now() + FIXTURE_STOP_BOUND;
        while !served.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if served.is_finished() {
            let _ = served.join();
            let _ = std::fs::remove_dir_all(&self.root);
            return;
        }
        // The root and the dashboard stay: a test that asserts they are gone
        // fails on this line's message instead of hanging forever.
        eprintln!(
            "the fixture dashboard at {} did not stop within {} s",
            self.base,
            FIXTURE_STOP_BOUND.as_secs()
        );
    }
}

/// Records every row the table names into `contract/http`, one recording per
/// row, and removes every recording the table no longer names. Each row runs
/// against its own fixture dashboard, so no row's answer depends on the work
/// an earlier row started, and every allowlisted value is written as a
/// placeholder of its type, so a re-recording names only a real answer change.
pub async fn record(contract: &Path) -> Result<usize, String> {
    let allowlist = Allowlist::load(&contract.join("allowlist.json"))?;
    let client = http_table::client();
    let mut corpus = Corpus::default();
    for case in http_table::all_cases() {
        let fixture = Fixture::start(case.name, case.hold_flow_restore).await?;
        let observed = http_table::send(&client, &fixture.base, &case).await?;
        corpus.insert(recording(&case, &observed, &allowlist)?);
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
        let fixture = Fixture::start(case.name, case.hold_flow_restore).await?;
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

/// The corpus entry one observed answer becomes. A zero-byte answer records
/// the empty text whatever its content type names, because a HEAD answer
/// carries the headers of the GET it strips and no payload at all. A content
/// type that names JSON makes a non-empty body mandatory JSON: a body
/// `serde_json` rejects fails the recording of that row instead of silently
/// becoming text the comparison would then match against itself. An answer
/// that drops its content type still records a JSON document when its body
/// parses as an object or array, so a handler cannot downgrade a row to text
/// by omitting the header.
fn recording(
    case: &Case,
    observed: &Observed,
    allowlist: &Allowlist,
) -> Result<http_table::Recording, String> {
    let names_json = observed
        .headers
        .get("content-type")
        .map(|value| value.contains("json"));
    let body = if observed.body.is_empty() {
        serde_json::Value::String(String::new())
    } else {
        match names_json {
            Some(true) => serde_json::from_str(&observed.body).map_err(|error| {
                format!(
                    "{}: the answer names JSON and its body does not parse: {error}",
                    case.name
                )
            })?,
            Some(false) => serde_json::Value::String(observed.body.clone()),
            None => match serde_json::from_str(&observed.body) {
                Ok(document @ (Value::Object(_) | Value::Array(_))) => document,
                Ok(_) | Err(_) => serde_json::Value::String(observed.body.clone()),
            },
        }
    };
    Ok(http_table::Recording {
        name: case.name.to_string(),
        method: case.method.as_str().to_string(),
        path: case.path.to_string(),
        status: observed.status,
        body: placeholder(&body, None, allowlist),
    })
}

/// Replaces every allowlisted value with a placeholder of its own type. The
/// comparator ignores those values and asserts the type, so the corpus names
/// the answer's stable content and a re-recording stays byte-identical. An
/// entry scoped to a parent key replaces only the field under that key; a bare
/// entry replaces the field at every depth. An array is transparent, so an
/// object it holds keeps the key that names the array.
fn placeholder(value: &Value, parent: Option<&str>, allowlist: &Allowlist) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let value = if allowlist.contains(key, parent) {
                        typed_placeholder(value)
                    } else {
                        placeholder(value, Some(key), allowlist)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| placeholder(item, parent, allowlist))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn allowlist() -> Allowlist {
        Allowlist::load(&allowlist_path()).expect("the nondeterminism allowlist")
    }

    #[test]
    fn the_placeholder_replaces_a_scoped_field_only_at_its_scope() {
        let body = serde_json::json!({
            "state": {
                "error": "read_artifacts failed",
                "agents": [{
                    "error": "read failed",
                    "sync": {"error": "the forge read was refused"},
                    "prompt": {"agent": "discover-sheet", "text": null,
                        "error": "ENOENT: no such file: /abs/fixture"}
                }]
            }
        });
        let recorded = placeholder(&body, None, &allowlist());
        assert_eq!(
            recorded["state"]["error"],
            Value::String("read_artifacts failed".to_string()),
            "the state's own error is recorded as it answered"
        );
        assert_eq!(
            recorded["state"]["agents"][0]["error"],
            Value::String("read failed".to_string()),
            "an agent's error is recorded as it answered"
        );
        assert_eq!(
            recorded["state"]["agents"][0]["sync"]["error"],
            Value::String(String::new()),
            "the fixture's forge read outcome is replaced"
        );
        assert_eq!(
            recorded["state"]["agents"][0]["prompt"]["error"],
            Value::String(String::new()),
            "the prompt's diagnostic is replaced at its own scope"
        );
    }

    /// One row named for the probe, holding no route of the real table.
    fn probe_case(name: &'static str) -> Case {
        Case {
            name,
            method: reqwest::Method::GET,
            path: "/probe",
            request_path: "/probe".to_string(),
            headers: http_table::HeaderSpec::None,
            expect_status: 200,
            expect_allow: None,
            expect_gzip: false,
            answer: http_table::Answer::Exact,
            live: http_table::Live::Recorded,
            hold_flow_restore: false,
        }
    }

    /// One observed answer carrying the content type it was given.
    fn probe_answer(name: &'static str, content_type: Option<&str>, body: &str) -> Observed {
        let mut headers = BTreeMap::new();
        if let Some(value) = content_type {
            headers.insert("content-type".to_string(), value.to_string());
        }
        Observed {
            name,
            status: 200,
            headers,
            body: body.to_string(),
        }
    }

    #[test]
    fn a_json_answer_that_does_not_parse_fails_the_recording_of_its_row() {
        let error = recording(
            &probe_case("broken-json"),
            &probe_answer("broken-json", Some("application/json"), "{\"answer\": "),
            &allowlist(),
        )
        .expect_err("a body the content type names JSON must parse");
        assert!(
            error.starts_with("broken-json: the answer names JSON and its body does not parse: "),
            "the error names the row and the rejected body: {error}"
        );
    }

    #[test]
    fn a_zero_byte_json_answer_is_recorded_as_the_empty_text() {
        let recorded = recording(
            &probe_case("ready-head"),
            &probe_answer("ready-head", Some("application/json;charset=utf-8"), ""),
            &allowlist(),
        )
        .expect("a HEAD answer carries the GET's content type and no payload");

        assert_eq!(
            recorded.body,
            Value::String(String::new()),
            "a zero-byte answer records the empty text its corpus row holds"
        );
    }

    #[test]
    fn a_json_answer_without_a_content_type_is_recorded_as_its_document() {
        let object = recording(
            &probe_case("json-object-without-content-type"),
            &probe_answer(
                "json-object-without-content-type",
                None,
                "{\"answer\": true}",
            ),
            &allowlist(),
        )
        .expect("a JSON object parses without a content type");
        assert_eq!(object.body, serde_json::json!({"answer": true}));

        let array = recording(
            &probe_case("json-array-without-content-type"),
            &probe_answer("json-array-without-content-type", None, "[{\"answer\": 1}]"),
            &allowlist(),
        )
        .expect("a JSON array parses without a content type");
        assert_eq!(array.body, serde_json::json!([{"answer": 1}]));
    }

    #[test]
    fn a_textual_answer_is_recorded_as_text() {
        let declared = recording(
            &probe_case("text-declared"),
            &probe_answer(
                "text-declared",
                Some("text/plain; charset=utf-8"),
                "no such run",
            ),
            &allowlist(),
        )
        .expect("a non-JSON content type records text");
        assert_eq!(declared.body, Value::String("no such run".to_string()));

        let undeclared = recording(
            &probe_case("text-undeclared"),
            &probe_answer("text-undeclared", None, "no such run"),
            &allowlist(),
        )
        .expect("a body that is not a JSON document records text");
        assert_eq!(undeclared.body, Value::String("no such run".to_string()));
    }
}
