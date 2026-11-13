//! The Issues dashboard's frames, worker controls, answers, and closes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::issues_mode::{
    CloseIssueRequest, Issue, IssuesBridge, IssuesCommand, IssuesHooks, IssuesOptions, PollResult,
    PreflightRequest, PreflightResult, StartOutcome, TrackerRead, TrackerReadRequest,
};
use devboard::journal::Journal;
use serde_json::{json, Value};

type Sink = Arc<Mutex<Vec<Value>>>;
type SpawnHook = Arc<dyn Fn(&[String], &HashMap<String, String>) -> Option<u32> + Send + Sync>;
type RecordedSpawns = Arc<Mutex<Vec<(Vec<String>, HashMap<String, String>)>>>;

fn scratch(label: &str) -> (PathBuf, PathBuf) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("issues-mode-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    std::fs::create_dir_all(repo.join(".devboard").join(".tmp")).expect("a fixture repo");
    std::fs::create_dir_all(&state).expect("a fixture state directory");
    // Its own checkout with no origin: the enclosing harness checkout's
    // remote must not leak into a fixture's repository answer.
    let _ = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .arg("init")
        .arg("--quiet")
        .output();
    // The bridge resolves its paths the way Node's `resolve` does, so the
    // fixture paths the tests key state by must be resolved the same way.
    let repo = std::fs::canonicalize(&repo).expect("a canonical repo");
    let state = std::fs::canonicalize(&state).expect("a canonical state directory");
    (repo, state)
}

fn repo_key(repo: &Path) -> String {
    devboard::journal::repo_key(repo)
}

fn state_path(repo: &Path, state: &Path) -> PathBuf {
    state.join("issues").join(repo_key(repo)).join("state.json")
}

fn control_directory(repo: &Path, state: &Path) -> PathBuf {
    state.join("issues").join(repo_key(repo)).join("control")
}

fn versioned_worker_directory(repo: &Path, state: &Path, version: &str) -> PathBuf {
    state
        .join("issues")
        .join(repo_key(repo))
        .join("workers")
        .join(version)
}

fn lock_path(repo: &Path) -> PathBuf {
    repo.join(".devboard")
        .join(".tmp")
        .join("issues")
        .join("lock")
}

fn empty_poll() -> Value {
    json!({
        "intervalMs": 10000,
        "lastPollAt": null,
        "nextPollAt": null,
        "etag": null,
        "notModified": false,
        "rateLimitedUntil": null,
        "error": null,
    })
}

fn state_document(repo: &Path, lifecycle: &str, agents: Value) -> Value {
    json!({
        "version": 2,
        "repo": "acme/app",
        "root": repo.display().to_string(),
        "lifecycle": lifecycle,
        "enabled": true,
        "paused": false,
        "pauseSource": null,
        "worker": null,
        "poll": empty_poll(),
        "queue": [],
        "runs": [],
        "agents": agents,
        "cooldowns": {},
        "lastError": null,
        "lastExitCode": null,
        "finishedAt": null,
        "notice": null,
        "updatedAt": devboard::journal::now_iso8601(),
    })
}

/// A `running` run record whose identity is this test process, so a claim
/// naming it proves its owner.
fn running_run(repo: &Path, state: &Path, run_id: &str) {
    let directory = state
        .join("issues")
        .join(repo_key(repo))
        .join("runs")
        .join(run_id);
    std::fs::create_dir_all(&directory).expect("a run directory");
    std::fs::write(
        directory.join("run.json"),
        json!({
            "version": 1,
            "runId": run_id,
            "repo": "acme/app",
            "status": "running",
            "argv": [],
            "cwd": repo.display().to_string(),
            "startedAt": devboard::journal::now_iso8601(),
            "finishedAt": null,
            "exitCode": null,
            "issues": [],
            "firstStderrLine": null,
            "workerPid": std::process::id(),
            "startTicks": devboard::supervision::start_ticks(std::process::id()),
            "harnessVersion": "1.2.3",
        })
        .to_string(),
    )
    .expect("a run record");
}

fn write_state(repo: &Path, state: &Path, document: &Value) {
    let path = state_path(repo, state);
    std::fs::create_dir_all(path.parent().expect("a parent")).expect("a state directory");
    std::fs::write(&path, serde_json::to_string(document).expect("state JSON"))
        .expect("a state file");
}

/// A live owner: a real child process whose cwd is the fixture checkout.
struct Owner {
    child: Child,
    pid: u32,
    lock: PathBuf,
}

impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.lock);
    }
}

fn spawn_owner(repo: &Path, state: &Path) -> Owner {
    spawn_owner_at(repo, state, None, lock_path(repo))
}

/// A live owner of one harness version, holding that version's lock.
fn spawn_versioned_owner(repo: &Path, state: &Path, version: &str) -> Owner {
    let path = repo
        .join(".devboard")
        .join(".tmp")
        .join("issues")
        .join(format!("lock.{version}"));
    spawn_owner_at(repo, state, Some(version), path)
}

fn spawn_owner_at(repo: &Path, state: &Path, version: Option<&str>, path: PathBuf) -> Owner {
    let child = std::process::Command::new("sleep")
        .arg("60")
        .current_dir(repo)
        .spawn()
        .expect("a child");
    let pid = child.id();
    std::fs::create_dir_all(path.parent().expect("a lock directory")).expect("a lock directory");
    let lock = json!({
        "pid": pid,
        "startedAt": devboard::journal::now_iso8601(),
        "repo": repo.display().to_string(),
        "stateDir": state.display().to_string(),
        "harnessVersion": version,
        "argv": ["sleep", "60"],
    });
    std::fs::write(&path, serde_json::to_string(&lock).expect("lock JSON")).expect("a lock");
    Owner {
        child,
        pid,
        lock: path,
    }
}

fn empty_tracker() -> TrackerRead {
    Arc::new(|_request: TrackerReadRequest| {
        Box::pin(async move { PollResult::NotModified { etag: None } })
    })
}

fn options(repo: &Path, state: &Path, hooks: IssuesHooks, sink: Sink) -> IssuesOptions {
    IssuesOptions {
        repo_dir: repo.to_path_buf(),
        state_dir: state.to_path_buf(),
        agent_command: "omp acp".to_string(),
        running_version: Some("1.2.3".to_string()),
        environment: HashMap::new(),
        hooks,
        send: Arc::new(move |event, _except| {
            sink.lock().expect("sink").push(event);
        }),
        has_clients: Arc::new(|| true),
        poll_ms: 50,
        sync_ms: 30_000,
        preflight_timeout_ms: 2_000,
        on_open_issues: Arc::new(|_issues| {}),
    }
}

fn hooks(
    preflight: Arc<dyn Fn() -> PreflightResult + Send + Sync>,
    spawn: SpawnHook,
    close: Arc<dyn Fn(CloseIssueRequest) -> Result<(), String> + Send + Sync>,
) -> IssuesHooks {
    IssuesHooks {
        preflight: Arc::new(move |request: PreflightRequest| {
            let _ = request;
            let result = preflight();
            Box::pin(async move { result })
        }),
        spawn_worker: spawn,
        close_issue: Arc::new(move |request: CloseIssueRequest| {
            let result = close(request);
            Box::pin(async move { result })
        }),
        tracker_read: empty_tracker(),
        agent_environment: Arc::new(|| Box::pin(async { Ok(HashMap::new()) })),
        processing_write: Arc::new(|_number, _active| Box::pin(async { Ok(()) })),
    }
}

/// Waits until `count` spawns are recorded. An accepted Start runs its
/// preflight and spawn after it answers, so a test never reads the spawn list
/// on the answer's own turn.
async fn wait_for_spawns(spawns: &RecordedSpawns, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while spawns.lock().expect("spawns").len() < count && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn commands(directory: &Path) -> Vec<Value> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .filter(|name| name.ends_with(".json"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let text = std::fs::read_to_string(directory.join(name)).expect("a command");
            serde_json::from_str(&text).expect("command JSON")
        })
        .collect()
}

#[tokio::test]
async fn an_unstarted_checkout_publishes_the_stopped_state_frame() {
    let (repo, state) = scratch("empty");
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));

    let snapshot = bridge.snapshot();
    let expected = json!({
        "present": false,
        "repo": null,
        "root": repo.display().to_string(),
        "lifecycle": "stopped",
        "enabled": false,
        "paused": false,
        "attached": false,
        "worker": null,
        "poll": null,
        "queue": [],
        "runs": [],
        "agents": [],
        "cooldowns": {},
        "lastError": null,
        "lastExitCode": null,
        "finishedAt": null,
        "notice": null,
        "deferral": null,
        "starting": false,
        "startError": null,
        "updatedAt": null,
        "workers": [],
        "sync": {"intervalMs": 30000, "lastSyncAt": null, "error": null},
    });
    assert_eq!(
        devboard::jsjson::stringify(&snapshot),
        devboard::jsjson::stringify(&expected)
    );

    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    bridge.replay(&Conn::new(outbox));
    let frame = next_frame(&mut inbox).await;
    assert_eq!(frame["type"], "issuesState");
    assert_eq!(frame["present"], false);
}

#[tokio::test]
async fn a_fresh_tracker_read_publishes_the_open_queue() {
    let (repo, state) = scratch("queue");
    write_state(&repo, &state, &state_document(&repo, "idle", json!([])));
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let tracker: TrackerRead = Arc::new(|_request: TrackerReadRequest| {
        Box::pin(async {
            PollResult::Issues {
                issues: vec![
                    Issue {
                        number: 9,
                        title: "Second".into(),
                        url: "https://example.test/9".into(),
                        created_at: "2026-01-02T00:00:00.000Z".into(),
                        labels: vec!["bug".into()],
                        body: Some("nine".into()),
                    },
                    Issue {
                        number: 3,
                        title: "First".into(),
                        url: "https://example.test/3".into(),
                        created_at: "2026-01-01T00:00:00.000Z".into(),
                        labels: Vec::new(),
                        body: Some("three".into()),
                    },
                ],
                etag: Some("etag-1".into()),
            }
        })
    });
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    );
    settings.hooks.tracker_read = tracker;
    let bridge = IssuesBridge::new(settings);

    bridge.sync_now().await;

    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["repo"], "acme/app");
    assert_eq!(snapshot["queue"][0]["number"], json!(3));
    assert_eq!(snapshot["queue"][0]["handled"], false);
    assert_eq!(snapshot["queue"][0]["runId"], Value::Null);
    assert_eq!(snapshot["queue"][0]["agentRunId"], Value::Null);
    assert_eq!(snapshot["queue"][1]["number"], json!(9));
    assert_eq!(snapshot["queue"][1]["labels"][0], "bug");
    assert_eq!(snapshot["sync"]["error"], Value::Null);
    assert!(snapshot["sync"]["lastSyncAt"].is_string());
    let last = sink.lock().expect("sink").last().cloned().expect("a frame");
    assert_eq!(last["type"], "issuesState");
}

/// A `processing` label no live claim owns marks no run: the fresh read
/// clears it on the tracker, and the row is served pending. The label a live
/// claim owns stays, so a running issue never loses its marker.
#[tokio::test]
async fn a_fresh_read_clears_a_processing_label_no_live_claim_owns() {
    fn claimed_issue(number: u64) -> Issue {
        Issue {
            number,
            title: format!("Issue {number}"),
            url: format!("https://example.test/{number}"),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            labels: vec!["processing".into()],
            body: None,
        }
    }

    let (repo, state) = scratch("stale-processing");
    write_state(&repo, &state, &state_document(&repo, "idle", json!([])));
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let writes: Arc<Mutex<Vec<(u64, bool)>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&writes);
    let tracker: TrackerRead = Arc::new(|_request: TrackerReadRequest| {
        Box::pin(async {
            PollResult::Issues {
                issues: vec![claimed_issue(4), claimed_issue(5)],
                etag: Some("etag-1".into()),
            }
        })
    });
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    );
    settings.hooks.tracker_read = tracker;
    settings.hooks.processing_write = Arc::new(move |number, active| {
        let recorded = Arc::clone(&recorded);
        Box::pin(async move {
            recorded.lock().expect("writes").push((number, active));
            Ok(())
        })
    });
    // Issue #5 is owned by a claim this live process holds through its
    // running run; #4 is not.
    running_run(&repo, &state, "run-5");
    let claims = repo.join(".devboard/.tmp/issues/claims");
    std::fs::create_dir_all(&claims).expect("a claims directory");
    std::fs::write(
        claims.join("5.json"),
        json!({
            "number": 5,
            "pid": std::process::id(),
            "startTicks": devboard::supervision::start_ticks(std::process::id()),
            "runId": "run-5",
            "harnessVersion": "1.2.3",
        })
        .to_string(),
    )
    .expect("a claim");
    let bridge = IssuesBridge::new(settings);

    bridge.sync_now().await;

    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["queue"][0]["number"], json!(4));
    assert_eq!(snapshot["queue"][0]["labels"], json!([]));
    assert_eq!(snapshot["queue"][1]["number"], json!(5));
    assert_eq!(snapshot["queue"][1]["labels"], json!(["processing"]));
    assert_eq!(
        *writes.lock().expect("writes"),
        vec![(4, false)],
        "only the unclaimed label is cleared"
    );
}

/// A tracker read that answers one open issue and counts its calls.
fn counted_tracker() -> (TrackerRead, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);
    let tracker: TrackerRead = Arc::new(move |_request: TrackerReadRequest| {
        seen.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            PollResult::Issues {
                issues: vec![Issue {
                    number: 7,
                    title: "Seventh".into(),
                    url: "https://example.test/7".into(),
                    created_at: "2026-01-03T00:00:00.000Z".into(),
                    labels: vec!["processing".into()],
                    body: None,
                }],
                etag: Some("etag-7".into()),
            }
        })
    });
    (tracker, calls)
}

#[tokio::test]
async fn no_page_and_no_socket_makes_no_tracker_call() {
    let (repo, state) = scratch("no-demand");
    let (tracker, calls) = counted_tracker();
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::new(Mutex::new(Vec::new())),
    );
    settings.has_clients = Arc::new(|| false);
    settings.hooks.tracker_read = tracker;
    let bridge = IssuesBridge::new(settings);

    bridge.sync_now().await;

    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["queue"], json!([]));
    assert_eq!(snapshot["sync"]["lastSyncAt"], Value::Null);
}

#[tokio::test]
async fn a_page_read_without_a_socket_reads_the_tracker_and_fills_the_queue() {
    let (repo, state) = scratch("page-demand");
    write_state(&repo, &state, &state_document(&repo, "idle", json!([])));
    let (tracker, calls) = counted_tracker();
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::new(Mutex::new(Vec::new())),
    );
    settings.has_clients = Arc::new(|| false);
    settings.hooks.tracker_read = tracker;
    let bridge = IssuesBridge::new(settings);

    let (outbox, _inbox) = tokio::sync::mpsc::unbounded_channel();
    bridge.replay(&Conn::new(outbox));
    bridge.sync_now().await;

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["queue"][0]["number"], json!(7));
    assert_eq!(snapshot["queue"][0]["title"], "Seventh");
    assert_eq!(snapshot["sync"]["error"], Value::Null);
    assert!(snapshot["sync"]["lastSyncAt"].is_string());
}

#[tokio::test]
async fn a_page_read_cannot_outpace_the_sync_interval() {
    let (repo, state) = scratch("page-throttle");
    write_state(&repo, &state, &state_document(&repo, "idle", json!([])));
    let (tracker, calls) = counted_tracker();
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::new(Mutex::new(Vec::new())),
    );
    settings.has_clients = Arc::new(|| false);
    settings.hooks.tracker_read = tracker;
    let bridge = IssuesBridge::new(settings);

    for _ in 0..2 {
        let (outbox, _inbox) = tokio::sync::mpsc::unbounded_channel();
        bridge.replay(&Conn::new(outbox));
        bridge.sync_now().await;
    }

    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(bridge.snapshot()["queue"][0]["number"], json!(7));
}

#[tokio::test]
async fn start_spawns_once_then_attaches_and_writes_every_control() {
    let (repo, state) = scratch("start");
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let spawns: RecordedSpawns = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&spawns);
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(move |argv, env| {
                recorded
                    .lock()
                    .expect("spawns")
                    .push((argv.to_vec(), env.clone()));
                Some(4242)
            }),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));

    assert_eq!(
        bridge.start().await,
        StartOutcome::Started { attached: false }
    );
    wait_for_spawns(&spawns, 1).await;
    {
        let recorded_spawns = spawns.lock().expect("spawns");
        assert_eq!(recorded_spawns.len(), 1);
        let (argv, environment) = &recorded_spawns[0];
        let executable = std::env::current_exe().expect("exe").display().to_string();
        assert_eq!(argv[0], executable);
        assert_eq!(argv[1], "worker");
        assert_eq!(argv[2], "issues");
        assert_eq!(argv[3], "--repo");
        assert_eq!(argv[4], repo.display().to_string());
        assert_eq!(argv[5], "--state-dir");
        assert_eq!(argv[6], state.display().to_string());
        let repo_text = repo.display().to_string();
        let state_text = state.display().to_string();
        assert_eq!(
            environment.get("REPO_DIR").map(String::as_str),
            Some(repo_text.as_str())
        );
        assert_eq!(
            environment.get("STATE_DIR").map(String::as_str),
            Some(state_text.as_str())
        );
        assert_eq!(
            environment.get("AGENT_COMMAND").map(String::as_str),
            Some("omp acp")
        );
    }

    let owner = spawn_owner(&repo, &state);
    write_state(&repo, &state, &state_document(&repo, "idle", json!([])));
    assert_eq!(
        bridge.start().await,
        StartOutcome::Started { attached: true }
    );
    assert_eq!(spawns.lock().expect("spawns").len(), 1);

    bridge.command(&IssuesCommand::Pause).expect("pause");
    bridge.command(&IssuesCommand::Resume).expect("resume");
    bridge.command(&IssuesCommand::Check).expect("check");
    bridge.command(&IssuesCommand::Stop).expect("stop");
    let written = commands(&control_directory(&repo, &state));
    let kinds: Vec<&str> = written
        .iter()
        .filter_map(|command| command["type"].as_str())
        .collect();
    assert_eq!(kinds, ["pause", "resume", "check", "stop"]);

    drop(owner);
    let _ = std::fs::remove_file(lock_path(&repo));
    let error = bridge
        .command(&IssuesCommand::Stop)
        .expect_err("a stopped worker refuses commands");
    assert_eq!(error, "No issues worker is running for this checkout.");
}

#[tokio::test]
async fn auto_resume_replaces_a_crashed_worker_and_respects_stop_and_pause() {
    let (repo, state) = scratch("auto-resume");
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let spawns: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&spawns);
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(move |_argv, _env| {
                let mut spawns = recorded.lock().expect("spawns");
                let pid = 9_000 + spawns.len() as u32;
                spawns.push(pid);
                Some(pid)
            }),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));
    write_state(&repo, &state, &state_document(&repo, "running", json!([])));

    // A live worker is never duplicated.
    let mut owner = spawn_owner(&repo, &state);
    assert!(!bridge.supervise_once().await);
    assert!(spawns.lock().expect("spawns").is_empty());

    // A worker that vanishes while enabled is replaced on the next tick.
    owner.child.kill().expect("the worker dies");
    owner.child.wait().expect("the worker is reaped");
    std::fs::remove_file(lock_path(&repo)).expect("the stale lock leaves");
    assert!(
        bridge.supervise_once().await,
        "the vanished worker restarts"
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while spawns.lock().expect("spawns").is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(spawns.lock().expect("spawns").len(), 1);

    // An operator Stop stays respected even when the worker dies before it
    // can publish the stopped state itself.
    let mut owner = spawn_owner(&repo, &state);
    bridge.command(&IssuesCommand::Stop).expect("stop");
    owner.child.kill().ok();
    owner.child.wait().ok();
    std::fs::remove_file(lock_path(&repo)).ok();
    assert!(
        !bridge.supervise_once().await,
        "an operator Stop suspends auto-resume"
    );
    assert_eq!(spawns.lock().expect("spawns").len(), 1);

    // A Pause is equally an operator decision.
    let (repo, state) = scratch("auto-resume-paused");
    let paused_spawns: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&paused_spawns);
    let paused = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(move |_argv, _env| {
                let mut spawns = recorded.lock().expect("spawns");
                let pid = 9_100 + spawns.len() as u32;
                spawns.push(pid);
                Some(pid)
            }),
            Arc::new(|_request| Ok(())),
        ),
        sink,
    ));
    let mut document = state_document(&repo, "paused", json!([]));
    document["paused"] = json!(true);
    write_state(&repo, &state, &document);
    let mut owner = spawn_owner(&repo, &state);
    assert!(!paused.supervise_once().await);
    owner.child.kill().ok();
    owner.child.wait().ok();
    std::fs::remove_file(lock_path(&repo)).ok();
    assert!(
        !paused.supervise_once().await,
        "a paused worker is not restarted"
    );
    assert!(paused_spawns.lock().expect("spawns").is_empty());

    // A stopped worker stays stopped.
    let mut document = state_document(&repo, "stopped", json!([]));
    document["enabled"] = json!(false);
    write_state(&repo, &state, &document);
    assert!(!paused.supervise_once().await);
}

#[tokio::test]
async fn a_live_worker_s_published_state_drives_the_lifecycle_frames() {
    let (repo, state) = scratch("lifecycle");
    let owner = spawn_owner(&repo, &state);
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));

    let mut document = state_document(&repo, "idle", json!([]));
    write_state(&repo, &state, &document);
    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["present"], true);
    assert_eq!(snapshot["attached"], true);
    assert_eq!(snapshot["enabled"], true);
    assert_eq!(snapshot["lifecycle"], "idle");
    assert_eq!(snapshot["workers"].as_array().expect("workers").len(), 1);
    assert_eq!(snapshot["workers"][0]["pid"], json!(owner.pid));

    document["paused"] = json!(true);
    document["pauseSource"] = json!("operator");
    document["lifecycle"] = json!("paused");
    write_state(&repo, &state, &document);
    assert_eq!(bridge.snapshot()["lifecycle"], "paused");
    assert_eq!(bridge.snapshot()["paused"], true);

    document["paused"] = json!(false);
    document["pauseSource"] = Value::Null;
    document["lifecycle"] = json!("running");
    document["agents"] = json!([{
        "runId": "run-7",
        "issueNumber": 7,
        "startedAt": devboard::journal::now_iso8601(),
        "question": null,
        "acp": null,
    }]);
    write_state(&repo, &state, &document);
    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["lifecycle"], "running");
    assert_eq!(snapshot["agents"][0]["runId"], "run-7");
    assert_eq!(snapshot["agents"][0]["harnessVersion"], Value::Null);

    document["lifecycle"] = json!("stopped");
    document["enabled"] = json!(false);
    document["agents"] = json!([]);
    write_state(&repo, &state, &document);
    assert_eq!(bridge.snapshot()["lifecycle"], "stopped");
    drop(owner);
}

#[tokio::test]
async fn a_tracker_failure_is_published_without_losing_the_last_list() {
    let (repo, state) = scratch("sync-error");
    write_state(&repo, &state, &state_document(&repo, "idle", json!([])));
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let tracker: TrackerRead = Arc::new(|_request: TrackerReadRequest| {
        Box::pin(async move {
            PollResult::Error {
                detail: "the tracker did not answer".into(),
            }
        })
    });
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        sink,
    );
    settings.hooks.tracker_read = tracker;
    let bridge = IssuesBridge::new(settings);

    bridge.sync_now().await;
    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["sync"]["error"], "the tracker did not answer");
    assert_eq!(snapshot["sync"]["lastSyncAt"], Value::Null);
    assert_eq!(snapshot["queue"], json!([]));
}

/// A Start answers the state it changed before its preflight runs.
///
/// The preflight reads the forge and the spawn starts a process; neither may
/// hold an operator action's answer. The answer names the start in flight, and
/// the preflight's refusal is published once it lands, to every page.
#[tokio::test]
async fn a_start_answers_before_its_preflight_finishes() {
    let (repo, state) = scratch("start-answer-budget");
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let (released, pending) = tokio::sync::oneshot::channel::<()>();
    let pending = Arc::new(Mutex::new(Some(pending)));
    let waiting = Arc::clone(&pending);
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        IssuesHooks {
            preflight: Arc::new(move |_request| {
                let pending = Arc::clone(&waiting);
                Box::pin(async move {
                    let pending = { pending.lock().expect("preflight").take() };
                    if let Some(pending) = pending {
                        let _ = pending.await;
                    }
                    PreflightResult::Refused {
                        message: "missing prerequisite: gh is not on PATH".into(),
                    }
                })
            }),
            spawn_worker: Arc::new(|_argv, _env| Some(42)),
            close_issue: Arc::new(|_request| Box::pin(async { Ok(()) })),
            tracker_read: empty_tracker(),
            agent_environment: Arc::new(|| Box::pin(async { Ok(HashMap::new()) })),
            processing_write: Arc::new(|_number, _active| Box::pin(async { Ok(()) })),
        },
        Arc::clone(&sink),
    ));

    let started = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_millis(1000), bridge.start())
        .await
        .expect("a Start answers before its preflight finishes");
    assert_eq!(outcome, StartOutcome::Started { attached: false });
    assert!(
        started.elapsed() < Duration::from_millis(1000),
        "the Start answered in {:?}",
        started.elapsed()
    );
    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["starting"], json!(true));
    assert_eq!(snapshot["startError"], Value::Null);

    let _ = released.send(());
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let snapshot = bridge.snapshot();
        if snapshot["starting"] == json!(false) && snapshot["startError"] != Value::Null {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the refusal was never published: {snapshot}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let snapshot = bridge.snapshot();
    assert_eq!(
        snapshot["startError"],
        "missing prerequisite: gh is not on PATH"
    );
    assert!(
        sink.lock()
            .expect("sink")
            .iter()
            .any(|frame| frame["startError"] == "missing prerequisite: gh is not on PATH"),
        "every page learns the refusal"
    );
}

/// A Stop during an accepted Start supersedes it: the preflight's outcome is
/// never published, and the worker that Start spawned is ended.
#[tokio::test]
async fn a_stop_supersedes_an_accepted_start() {
    let (repo, state) = scratch("start-superseded");
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let (released, pending) = tokio::sync::oneshot::channel::<()>();
    let pending = Arc::new(Mutex::new(Some(pending)));
    let waiting = Arc::clone(&pending);
    let spawns: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&spawns);
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        IssuesHooks {
            preflight: Arc::new(move |_request| {
                let pending = Arc::clone(&waiting);
                Box::pin(async move {
                    let pending = { pending.lock().expect("preflight").take() };
                    if let Some(pending) = pending {
                        let _ = pending.await;
                    }
                    PreflightResult::Ok {
                        repository: "acme/app".into(),
                    }
                })
            }),
            spawn_worker: Arc::new(move |_argv, _env| {
                recorded.lock().expect("spawns").push(42);
                Some(42)
            }),
            close_issue: Arc::new(|_request| Box::pin(async { Ok(()) })),
            tracker_read: empty_tracker(),
            agent_environment: Arc::new(|| Box::pin(async { Ok(HashMap::new()) })),
            processing_write: Arc::new(|_number, _active| Box::pin(async { Ok(()) })),
        },
        Arc::clone(&sink),
    ));

    assert_eq!(
        bridge.start().await,
        StartOutcome::Started { attached: false }
    );
    assert_eq!(bridge.snapshot()["starting"], json!(true));
    // The worker exists before the preflight is asked; the answer names it.
    assert_eq!(bridge.snapshot()["worker"]["pid"], json!(42));
    bridge.command(&IssuesCommand::Stop).expect("the stop");
    assert_eq!(bridge.snapshot()["starting"], json!(false));

    let _ = released.send(());
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        spawns.lock().expect("spawns").len(),
        1,
        "the Stop supersedes the start; it starts no second worker"
    );
    assert_eq!(bridge.snapshot()["startError"], Value::Null);
}

#[tokio::test]
async fn an_answer_routes_to_the_owning_run_and_refuses_unknown_ones() {
    let (repo, state) = scratch("answer");
    let owner = spawn_owner(&repo, &state);
    let agents = json!([{
        "runId": "run-1",
        "issueNumber": 5,
        "startedAt": devboard::journal::now_iso8601(),
        "question": null,
        "acp": null,
    }]);
    write_state(&repo, &state, &state_document(&repo, "running", agents));
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        sink,
    ));

    bridge
        .command(&IssuesCommand::Answer {
            id: json!(1),
            value: "yes".into(),
            run_id: Some("run-1".into()),
        })
        .expect("an answer");
    let written = commands(&control_directory(&repo, &state));
    assert_eq!(
        written.last().expect("an answer command"),
        &json!({"type": "answer", "id": 1, "value": "yes", "runId": "run-1"})
    );

    let unknown = bridge
        .command(&IssuesCommand::Answer {
            id: json!(1),
            value: "yes".into(),
            run_id: Some("nope".into()),
        })
        .expect_err("an unknown run");
    assert_eq!(unknown, "No agent is running for run nope.");
    let missing = bridge
        .command(&IssuesCommand::Answer {
            id: json!(1),
            value: "yes".into(),
            run_id: None,
        })
        .expect_err("a missing run id");
    assert_eq!(missing, "An answer needs its run id.");
    drop(owner);
}

#[tokio::test]
async fn closing_posts_the_number_and_the_origin_and_surfaces_failures() {
    let (repo, state) = scratch("close");
    let requests: Arc<Mutex<Vec<CloseIssueRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let fail = Arc::new(AtomicBool::new(false));
    let recorded = Arc::clone(&requests);
    let failing = Arc::clone(&fail);
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(move |request| {
                recorded.lock().expect("requests").push(request);
                if failing.load(Ordering::SeqCst) {
                    Err("Could not close issue #7: forbidden".into())
                } else {
                    Ok(())
                }
            }),
        ),
        sink,
    ));
    write_state(&repo, &state, &state_document(&repo, "idle", json!([])));

    bridge.close_issue(&json!(7)).await.expect("a close");
    {
        let requests = requests.lock().expect("requests");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].number, 7);
        assert_eq!(requests[0].repository, "acme/app");
        assert_eq!(requests[0].repo_dir, repo);
    }

    fail.store(true, Ordering::SeqCst);
    assert_eq!(
        bridge.close_issue(&json!(7)).await.expect_err("a refusal"),
        "Could not close issue #7: forbidden"
    );
    assert_eq!(
        bridge
            .close_issue(&json!("seven"))
            .await
            .expect_err("not a number"),
        "Closing an issue needs a positive issue number."
    );
    assert_eq!(
        bridge
            .close_issue(&json!(0))
            .await
            .expect_err("not positive"),
        "Closing an issue needs a positive issue number."
    );
}

#[tokio::test]
async fn a_run_detail_keeps_the_summary_then_the_record_and_activity() {
    let (repo, state) = scratch("run");
    let directory = state
        .join("issues")
        .join(repo_key(&repo))
        .join("runs")
        .join("run-1");
    std::fs::create_dir_all(&directory).expect("a run directory");
    let run = json!({
        "version": 1,
        "runId": "run-1",
        "repo": "acme/app",
        "status": "succeeded",
        "argv": ["omp", "acp"],
        "cwd": repo.display().to_string(),
        "startedAt": "2026-01-01T00:00:00.000Z",
        "finishedAt": "2026-01-01T00:01:00.000Z",
        "exitCode": 0,
        "issues": [{
            "number": 3,
            "title": "First",
            "url": "https://example.test/3",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "labels": [],
        }],
        "firstStderrLine": null,
        "workerPid": 123,
        "harnessVersion": "1.2.3",
    });
    std::fs::write(
        directory.join("run.json"),
        serde_json::to_string(&run).expect("run JSON"),
    )
    .expect("a run file");
    std::fs::write(directory.join("activity.json"), "[\"one\",\"two\"]\n")
        .expect("an activity file");
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        sink,
    ));

    let detail = bridge.run(&json!("run-1")).expect("a detail");
    assert_eq!(detail["runId"], "run-1");
    assert_eq!(detail["status"], "succeeded");
    assert_eq!(detail["activity"], 2);
    assert_eq!(detail["issues"][0]["number"], json!(3));
    assert_eq!(detail["repo"], "acme/app");
    assert_eq!(detail["activityLines"], json!(["one", "two"]));
    assert_eq!(detail["workerPid"], json!(123));
    assert!(bridge.run(&json!("../escape")).is_none());
    assert!(bridge.run(&json!("missing")).is_none());
    assert!(bridge.run(&Value::Null).is_none());
}

async fn next_frame(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Value {
    let text = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
        .await
        .expect("a frame before the deadline")
        .expect("a frame");
    serde_json::from_str(&text).expect("frame JSON")
}

fn app_config(repo: &Path, state: &Path) -> Config {
    Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.to_path_buf(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: "omp acp".to_string(),
        state_dir: state.to_path_buf(),
        allowed_hosts: Vec::new(),
        feedback: None,
    }
}

#[tokio::test]
async fn the_dispatch_refuses_with_the_typescript_wording() {
    let (repo, state) = scratch("dispatch");
    let config = app_config(&repo, &state);
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);
    let (outbox, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);

    app.command(&conn, Command::PauseIssues).await;
    assert_eq!(
        next_frame(&mut receiver).await,
        json!({"type": "error", "message": "No issues worker is running for this checkout."})
    );

    app.command(
        &conn,
        Command::CloseIssue {
            number: Some(json!("x")),
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut receiver).await,
        json!({"type": "error", "message": "Closing an issue needs its number."})
    );

    app.command(
        &conn,
        Command::AnswerIssues {
            id: Some(Value::Null),
            value: Some(json!("yes")),
            run_id: Some(json!("run-1")),
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut receiver).await,
        json!({"type": "error", "message": "An answer needs its question id and value."})
    );

    app.command(
        &conn,
        Command::AnswerIssues {
            id: Some(json!(1)),
            value: Some(json!("yes")),
            run_id: None,
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut receiver).await,
        json!({"type": "error", "message": "An answer needs its run id."})
    );

    app.command(&conn, Command::GetIssuesRun { run_id: None })
        .await;
    assert_eq!(
        next_frame(&mut receiver).await,
        json!({
            "type": "issuesRunMissing",
            "runId": null,
            "message": "No such issues run.",
        })
    );

    // The answer echoes the id it names: a page correlates the refusal with
    // the read it issued, so a stale history entry never reads as a slow one.
    app.command(
        &conn,
        Command::GetIssuesRun {
            run_id: Some(json!("run-abc")),
        },
    )
    .await;
    assert_eq!(
        next_frame(&mut receiver).await,
        json!({
            "type": "issuesRunMissing",
            "runId": "run-abc",
            "message": "No such issues run.",
        })
    );

    app.command(&conn, Command::GetIssues).await;
    let frame = next_frame(&mut receiver).await;
    assert_eq!(frame["type"], "issuesState");
    assert_eq!(frame["present"], false);
    assert_eq!(frame["lifecycle"], "stopped");
    let _ = app;
}

#[tokio::test]
async fn a_fresh_open_issue_read_publishes_the_issue_hook() {
    let (repo, state) = scratch("open-issue-hook");
    write_state(&repo, &state, &state_document(&repo, "idle", json!([])));
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let seen: Arc<Mutex<Vec<Vec<u64>>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_for_hook = Arc::clone(&seen);
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    );
    settings.on_open_issues = Arc::new(move |issues| {
        seen_for_hook
            .lock()
            .expect("seen")
            .push(issues.iter().map(|issue| issue.number).collect());
    });
    settings.hooks.tracker_read = Arc::new(|_request: TrackerReadRequest| {
        Box::pin(async {
            PollResult::Issues {
                issues: vec![Issue {
                    number: 4,
                    title: "Changed".into(),
                    url: "https://example.test/4".into(),
                    created_at: "2026-01-01T00:00:00.000Z".into(),
                    labels: Vec::new(),
                    body: Some("body".into()),
                }],
                etag: Some("etag".into()),
            }
        })
    });
    let bridge = IssuesBridge::new(settings);
    bridge.sync_now().await;
    assert_eq!(*seen.lock().expect("seen"), vec![vec![4]]);
}

/// A newer harness starts its own worker while an older one is live and then
/// drains the older one. Attaching instead leaves the family paused with no
/// worker that can start a queued issue.
#[tokio::test]
async fn a_newer_harness_spawns_its_own_worker_then_drains_the_older_one() {
    let (repo, state) = scratch("takeover");
    std::fs::write(
        repo.join(".devboard").join("package.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"1.0.1\"}\n",
    )
    .expect("the harness manifest");
    let owner = spawn_versioned_owner(&repo, &state, "1.0.0");
    let older = versioned_worker_directory(&repo, &state, "1.0.0");
    std::fs::create_dir_all(&older).expect("the older worker's state directory");
    std::fs::write(
        older.join("state.json"),
        serde_json::to_string(&state_document(&repo, "pausing", json!([]))).expect("state JSON"),
    )
    .expect("the older worker's state");

    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let spawns = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&spawns);
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(move |_argv, _env| {
                counted.fetch_add(1, Ordering::SeqCst);
                Some(std::process::id())
            }),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    );
    settings.running_version = Some("1.0.1".to_string());
    let bridge = IssuesBridge::new(settings);
    bridge.begin();

    let deadline = Instant::now() + Duration::from_secs(2);
    while spawns.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "the newest version starts its own worker"
    );

    let written = commands(&older.join("control"));
    assert_eq!(written.len(), 1, "{written:?}");
    assert_eq!(written[0]["type"], "drain");
    let marker: Value = serde_json::from_str(
        &std::fs::read_to_string(older.join("drain.json")).expect("a drain marker"),
    )
    .expect("marker JSON");
    assert_eq!(marker["by"], "1.0.1");
    assert_eq!(marker["pid"], owner.pid);

    // An operator Start attaches to the live worker and never duplicates it.
    assert_eq!(
        bridge.start().await,
        StartOutcome::Started { attached: true }
    );
    assert_eq!(spawns.load(Ordering::SeqCst), 1);

    drop(owner);
}

/// A drain whose replacement never started leaves the newest state stopped
/// with no live owner. The newest version adopts the family instead of
/// leaving the queue stopped with every slot free.
#[tokio::test]
async fn a_drain_stopped_family_is_adopted_by_the_newest_version() {
    let (repo, state) = scratch("drain-resume");
    let mut document = state_document(&repo, "stopped", json!([]));
    document["enabled"] = json!(false);
    document["paused"] = json!(false);
    document["pauseSource"] = json!("drain");
    write_state(&repo, &state, &document);

    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let spawns = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&spawns);
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(move |_argv, _env| {
                counted.fetch_add(1, Ordering::SeqCst);
                Some(std::process::id())
            }),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));

    assert!(
        bridge.supervise_once().await,
        "the drained family is resumed"
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while spawns.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(spawns.load(Ordering::SeqCst), 1);
}

fn running_agent(run_id: &str, issue: u64) -> Value {
    json!({
        "runId": run_id,
        "issueNumber": issue,
        "startedAt": devboard::journal::now_iso8601(),
        "question": null,
        "acp": null,
    })
}

fn attached_worker(pid: &u32, state: &Path) -> Value {
    json!({
        "pid": pid,
        "startedAt": devboard::journal::now_iso8601(),
        "stateDir": state.display().to_string(),
        "harnessVersion": null,
        "argv": [],
    })
}

fn write_run_activity(repo: &Path, state: &Path, run_id: &str, entries: &[&str]) {
    let directory = state
        .join("issues")
        .join(repo_key(repo))
        .join("runs")
        .join(run_id);
    std::fs::create_dir_all(&directory).expect("a run directory");
    std::fs::write(
        directory.join("activity.json"),
        serde_json::to_string(&entries).expect("activity JSON"),
    )
    .expect("an activity file");
}

/// A Start answers the state it changed and never the whole activity.
///
/// One run's activity reaches 1 MiB. Replaying every running agent's log in
/// the answer an operator Start waits for made one answer 32 MB on a dashboard
/// with sixteen running agents, and the page parses that whole body before it
/// reads the state frame the action was waiting for.
#[tokio::test]
async fn a_start_answers_the_state_and_never_the_activity() {
    let (repo, state) = scratch("start-answer");
    let owner = spawn_owner(&repo, &state);
    let mut document = state_document(
        &repo,
        "running",
        json!([running_agent("run-1", 7), running_agent("run-2", 8)]),
    );
    document["worker"] = attached_worker(&owner.pid, &state);
    write_state(&repo, &state, &document);
    write_run_activity(&repo, &state, "run-1", &["one", "two"]);
    write_run_activity(&repo, &state, "run-2", &["three"]);

    let config = app_config(&repo, &state);
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);
    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);

    app.command(&conn, Command::StartIssues).await;
    let frame = next_frame(&mut inbox).await;
    assert_eq!(frame["type"], "issuesState");
    assert_eq!(frame["lifecycle"], "running");
    assert_eq!(frame["agents"].as_array().map(Vec::len), Some(2));
    let extra = inbox.try_recv();
    assert!(
        extra.is_err(),
        "a Start answers the state alone, not the activity: {extra:?}"
    );
    drop(owner);
}

/// The REST answer one dispatched Start waits for arrives while its preflight
/// is still pending.
///
/// The preflight reads the forge, so it can take seconds. A request handler
/// that answered only after it finished held the operator's action past its
/// one-second budget with no frame written; the answer now names the start in
/// flight and the request returns on the quiet window.
#[tokio::test]
async fn a_dispatched_start_answers_inside_the_budget_while_its_preflight_is_pending() {
    let (repo, state) = scratch("start-dispatch-budget");
    let config = app_config(&repo, &state);
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);
    // A preflight that never settles and a spawn that starts no process: the
    // Start answers its state from the spawn seam, so nothing outlives the
    // test's own runtime.
    devboard::issues_mode::set_preflight(
        &app,
        Arc::new(|_request| {
            Box::pin(async move {
                std::future::pending::<()>().await;
                PreflightResult::Ok {
                    repository: "acme/app".into(),
                }
            })
        }),
    );
    devboard::issues_mode::set_spawn(&app, Arc::new(|_argv, _environment| Some(4_242_424)));
    devboard::issues_mode::set_agent_environment(&app, || Box::pin(async { Ok(HashMap::new()) }));

    let started = Instant::now();
    let frames = app.dispatch_captured(Command::StartIssues).await;
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(1000),
        "the dispatched Start answered in {elapsed:?} while its preflight was pending"
    );
    assert_eq!(frames[0]["type"], "issuesState");
    assert_eq!(frames[0]["starting"], json!(true));
    // The answer names the worker it spawned, not a start with nothing to show.
    assert_eq!(frames[0]["worker"]["pid"], json!(4_242_424));
}

/// A Start answers the projection the bridge already published, restated with
/// the Start's own facts.
///
/// The answer used to rebuild the projection, which read and parsed every
/// worker document this checkout ever wrote inside the operator's request. The
/// document below changes after the projection is published, so an answer that
/// rebuilt it would report the new file instead of the published state.
#[tokio::test]
async fn a_start_restates_the_published_projection_instead_of_rebuilding_it() {
    let (repo, state) = scratch("start-answer-published");
    let mut document = state_document(&repo, "running", json!([running_agent("run-1", 7)]));
    document["notice"] = json!("the operator stopped the previous worker");
    write_state(&repo, &state, &document);
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(4_242_424)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));

    let published = bridge.snapshot();
    assert_eq!(
        published["notice"],
        json!("the operator stopped the previous worker"),
        "{published}"
    );
    std::fs::remove_file(state_path(&repo, &state)).expect("the published document");

    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    bridge.start_answering(&conn).await;
    let frame = next_frame(&mut inbox).await;
    assert_eq!(frame["type"], "issuesState", "{frame}");
    assert_eq!(
        frame["notice"],
        json!("the operator stopped the previous worker"),
        "the answer restates the published projection: {frame}"
    );
    assert_eq!(frame["starting"], json!(true), "{frame}");
    assert_eq!(frame["worker"]["pid"], json!(4_242_424), "{frame}");
}

/// The projection parses a state document once per content change, not once
/// per build.
///
/// Every build read all of this checkout's worker documents — sixty of them,
/// four megabytes — and the bridge builds on a 250 ms cadence and on every
/// action's answer. The parse is what made one build cost hundreds of
/// milliseconds.
#[tokio::test]
async fn a_projection_parses_an_unchanged_document_once() {
    let (repo, state) = scratch("projection-parse-once");
    let mut first = state_document(&repo, "idle", json!([]));
    first["notice"] = json!("first");
    write_state(&repo, &state, &first);
    let newer = versioned_worker_directory(&repo, &state, "1.0.0");
    std::fs::create_dir_all(&newer).expect("a worker directory");
    let mut second = state_document(&repo, "idle", json!([]));
    second["notice"] = json!("second");
    std::fs::write(
        newer.join("state.json"),
        serde_json::to_string(&second).expect("state JSON"),
    )
    .expect("a worker state");

    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(4_242_424)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));

    devboard::issues_mode::reset_state_parses();
    let first_build = bridge.snapshot();
    let parses = devboard::issues_mode::state_parses();
    assert_eq!(first_build["present"], json!(true), "{first_build}");
    assert!(
        parses <= 2,
        "one build parsed {parses} documents for two documents"
    );

    let _second_build = bridge.snapshot();
    assert_eq!(
        devboard::issues_mode::state_parses(),
        parses,
        "an unchanged tree is parsed again"
    );

    let mut changed = second.clone();
    changed["notice"] = json!("changed");
    std::fs::write(
        newer.join("state.json"),
        serde_json::to_string(&changed).expect("state JSON"),
    )
    .expect("a rewritten worker state");
    let third_build = bridge.snapshot();
    assert!(
        devboard::issues_mode::state_parses() > parses,
        "a changed document is parsed again"
    );
    assert_eq!(third_build["present"], json!(true), "{third_build}");
}

/// A read replays each running agent's activity to the page that asked, and
/// to no other page.
///
/// The replay is what heals a page whose delta a hidden or failed poll missed,
/// so it stays on the read. Pushing a second copy of every run's log at every
/// other page only spent the same megabytes again.
#[tokio::test]
async fn a_replay_reaches_its_own_page_alone() {
    let (repo, state) = scratch("replay-target");
    let owner = spawn_owner(&repo, &state);
    let mut document = state_document(&repo, "running", json!([running_agent("run-1", 7)]));
    document["worker"] = attached_worker(&owner.pid, &state);
    write_state(&repo, &state, &document);
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));
    write_run_activity(&repo, &state, "run-1", &["one", "two"]);

    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    bridge.replay(&conn);

    let state_frame = next_frame(&mut inbox).await;
    assert_eq!(state_frame["type"], "issuesState");
    let activity = next_frame(&mut inbox).await;
    assert_eq!(activity["type"], "issuesActivity");
    assert_eq!(activity["runId"], "run-1");
    assert_eq!(activity["replay"], true);
    assert_eq!(activity["entries"].as_array().map(Vec::len), Some(2));
    let extra = inbox.try_recv();
    assert!(extra.is_err(), "one replay answers one read: {extra:?}");
    let broadcast = sink.lock().expect("sink");
    assert!(
        broadcast.is_empty(),
        "a replay never spends another page's traffic: {broadcast:?}"
    );
    drop(owner);
}

/// One tracker read per interval serves both the worker and the bridge.
///
/// A live worker owns the repository and reads the tracker on its interval.
/// The bridge projects that published result instead of reading the same
/// issues again, so three intervals cost three reads; on the parent commit the
/// bridge's own read doubled that to six.
#[tokio::test]
async fn one_tracker_read_per_interval_serves_the_worker_and_the_bridge() {
    let (repo, state) = scratch("shared-read");
    let owner = spawn_owner(&repo, &state);
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);
    let tracker: TrackerRead = Arc::new(move |_request: TrackerReadRequest| {
        let number = seen.fetch_add(1, Ordering::SeqCst) + 1;
        Box::pin(async move {
            PollResult::Issues {
                issues: vec![Issue {
                    number: number as u64,
                    title: format!("Issue {number}"),
                    url: format!("https://example.test/{number}"),
                    created_at: "2026-01-01T00:00:00.000Z".into(),
                    labels: Vec::new(),
                    body: None,
                }],
                etag: Some(format!("etag-{number}")),
            }
        })
    });
    let mut settings = options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        Arc::new(Mutex::new(Vec::new())),
    );
    settings.has_clients = Arc::new(|| true);
    settings.hooks.tracker_read = Arc::clone(&tracker);
    let bridge = IssuesBridge::new(settings);

    for interval in 0..3u64 {
        // The worker's one read for this interval, and the state it publishes.
        let read = tracker(TrackerReadRequest {
            repository: "acme/app".into(),
            etag: None,
        })
        .await;
        let PollResult::Issues { issues, etag } = read else {
            panic!("the worker read answered");
        };
        let mut document = state_document(&repo, "idle", json!([]));
        document["worker"] = attached_worker(&owner.pid, &state);
        document["poll"] = json!({
            "intervalMs": 10000,
            "lastPollAt": format!("2026-01-01T00:00:{:02}.000Z", interval),
            "nextPollAt": null,
            "etag": etag,
            "notModified": false,
            "rateLimitedUntil": null,
            "error": null,
        });
        document["queue"] = json!(issues
            .into_iter()
            .map(|issue| json!({
                "number": issue.number,
                "title": issue.title,
                "url": issue.url,
                "createdAt": issue.created_at,
                "labels": issue.labels,
                "handled": false,
                "runId": null,
                "agentRunId": null,
            }))
            .collect::<Vec<_>>());
        write_state(&repo, &state, &document);

        bridge.sync_now().await;
        let snapshot = bridge.snapshot();
        assert_eq!(
            snapshot["queue"][0]["number"],
            json!(interval + 1),
            "the bridge carries the worker's read"
        );
        assert_eq!(
            snapshot["sync"]["lastSyncAt"],
            json!(format!("2026-01-01T00:00:{interval:02}.000Z")),
            "the bridge states when the one read happened"
        );
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "three intervals cost three reads"
    );

    // With no live worker the bridge reads for itself, once per interval.
    drop(owner);
    bridge.sync_now().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        4,
        "the bridge reads when no worker is live"
    );
    let snapshot = bridge.snapshot();
    assert_eq!(snapshot["queue"][0]["number"], json!(4));
    assert!(snapshot["sync"]["lastSyncAt"].is_string());
}

/* ------------------------------------------------------------------------ */
/* Start answers                                                             */
/* ------------------------------------------------------------------------ */

/// One live worker process a Start can answer with: a real child whose pid
/// stays alive until the fixture drops it, as the worker a spawn names.
struct WorkerProcess {
    child: Child,
    pid: u32,
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_worker_process(repo: &Path) -> WorkerProcess {
    let child = std::process::Command::new("sleep")
        .arg("60")
        .current_dir(repo)
        .spawn()
        .expect("a worker child");
    let pid = child.id();
    WorkerProcess { child, pid }
}

/// The lock one live worker holds in this checkout, in this state directory.
fn write_worker_lock(repo: &Path, state: &Path, pid: u32) {
    let path = lock_path(repo);
    std::fs::create_dir_all(path.parent().expect("a lock directory")).expect("a lock directory");
    let lock = json!({
        "pid": pid,
        "startedAt": devboard::journal::now_iso8601(),
        "repo": repo.display().to_string(),
        "stateDir": state.display().to_string(),
        "harnessVersion": "1.2.3",
        "argv": ["sleep", "60"],
    });
    std::fs::write(&path, serde_json::to_string(&lock).expect("lock JSON")).expect("a lock");
}

/// Every record text the dashboard journal holds.
fn journal_records(repo: &Path, state: &Path) -> Vec<String> {
    let path = devboard::journal::journal_file(state, repo);
    std::fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter_map(|record| record["text"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

async fn wait_for_journal(repo: &Path, state: &Path, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !journal_records(repo, state)
        .iter()
        .any(|text| text.contains(needle))
    {
        assert!(
            Instant::now() < deadline,
            "the refusal was never journaled: {needle}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A Start never publishes a frame that names neither its worker nor its
/// refusal.
///
/// The accepted answer names the start in flight. The spawn that follows is
/// not an outcome yet: until the worker's own state names its pid, the frame
/// stays `starting`, so a page never reads a finished start with no worker
/// and no reason. On the parent commit the spawn's own frame cleared
/// `starting` while the worker had published nothing yet.
#[tokio::test]
async fn a_start_publishes_its_worker_or_its_refusal_without_a_gap() {
    let (repo, state) = scratch("start-no-gap");
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let spawned: Arc<Mutex<Option<WorkerProcess>>> = Arc::new(Mutex::new(None));
    let held = Arc::clone(&spawned);
    let spawn_repo = repo.clone();
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Ok {
                repository: "acme/app".into(),
            }),
            Arc::new(move |_argv, _env| {
                let worker = spawn_worker_process(&spawn_repo);
                let pid = worker.pid;
                *held.lock().expect("worker") = Some(worker);
                Some(pid)
            }),
            Arc::new(|_request| Ok(())),
        ),
        Arc::clone(&sink),
    ));

    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    let mut frames: Vec<Value> = Vec::new();

    assert_eq!(
        bridge.start().await,
        StartOutcome::Started { attached: false }
    );
    // The answer the command handler writes to the page that pressed Start.
    bridge.reply(&conn);

    // The spawn runs after the answer. Its frame must not clear `starting`
    // before the worker publishes anything.
    let deadline = Instant::now() + Duration::from_secs(2);
    while spawned.lock().expect("worker").is_none() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The worker now publishes the lock and the state that name it.
    let pid = spawned
        .lock()
        .expect("worker")
        .as_ref()
        .expect("a spawned worker")
        .pid;
    write_worker_lock(&repo, &state, pid);
    let mut document = state_document(&repo, "idle", json!([]));
    document["worker"] = attached_worker(&pid, &state);
    write_state(&repo, &state, &document);
    bridge.refresh();

    while let Ok(text) = inbox.try_recv() {
        frames.push(serde_json::from_str(&text).expect("frame JSON"));
    }
    frames.extend(sink.lock().expect("sink").iter().cloned());
    assert!(!frames.is_empty(), "the Start published no frame");
    for frame in &frames {
        if frame["type"] != "issuesState" {
            continue;
        }
        let starting = frame["starting"] == json!(true);
        let named = frame["worker"]["pid"].is_u64();
        let refused = frame["startError"].is_string();
        assert!(
            starting || named || refused,
            "a Start frame names neither its worker nor its refusal: {frame}"
        );
    }
    let settled = frames
        .iter()
        .rev()
        .find(|frame| frame["type"] == "issuesState")
        .expect("a state frame");
    assert_eq!(settled["starting"], json!(false), "{settled}");
    assert_eq!(settled["worker"]["pid"], json!(pid), "{settled}");
    // The spawn names its worker before that worker publishes, so the page
    // shows a pid without waiting for a poll or the ceiling.
    assert!(
        frames.iter().any(|frame| {
            frame["type"] == "issuesState"
                && frame["starting"] == json!(true)
                && frame["worker"]["pid"] == json!(pid)
        }),
        "the spawned worker is never named before it publishes: {frames:?}"
    );
}

/// A synchronous refusal answers with state, not only an error frame.
///
/// The card renders `startError` persistently and offers Start again; an
/// `error` frame would raise a server notification and file a board issue
/// against an operator-owned fact instead.
#[tokio::test]
async fn a_refused_issues_start_publishes_its_reason_on_the_card() {
    let (repo, state) = scratch("start-refusal-card");
    let config = app_config(&repo, &state);
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);

    // Another dashboard's STATE_DIR owns this checkout's worker lock.
    let worker = spawn_worker_process(&repo);
    let foreign_state = repo.join(".devboard").join(".tmp").join("foreign-state");
    let lock = lock_path(&repo);
    std::fs::create_dir_all(lock.parent().expect("a lock directory")).expect("a lock directory");
    let record = json!({
        "pid": worker.pid,
        "startedAt": devboard::journal::now_iso8601(),
        "repo": repo.display().to_string(),
        "stateDir": foreign_state.display().to_string(),
        "harnessVersion": null,
        "argv": ["sleep", "60"],
    });
    std::fs::write(&lock, serde_json::to_string(&record).expect("lock JSON")).expect("a lock");

    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    app.command(&conn, Command::StartIssues).await;

    let refusal = format!(
        "this checkout already has an issues worker (pid {}) using {}; this dashboard's STATE_DIR is {}",
        worker.pid,
        foreign_state.display(),
        state.display()
    );
    let frame = next_frame(&mut inbox).await;
    assert_eq!(frame["type"], "issuesState", "{frame}");
    assert_eq!(frame["starting"], json!(false), "{frame}");
    assert!(frame["enabled"].is_boolean(), "{frame}");
    assert_eq!(frame["startError"], json!(refusal), "{frame}");
    assert!(
        inbox.try_recv().is_err(),
        "the refusal is the card's state, not an error frame"
    );

    drop(worker);
    let _ = std::fs::remove_file(&lock);

    // A dashboard that never registered an Issues bridge answers the same way.
    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    devboard::issues_mode::answer_start_without_bridge(&app, &conn);
    let frame = next_frame(&mut inbox).await;
    assert_eq!(frame["type"], "issuesState", "{frame}");
    assert_eq!(frame["starting"], json!(false), "{frame}");
    assert!(frame["enabled"].is_boolean(), "{frame}");
    assert_eq!(
        frame["startError"],
        json!(devboard::issues_mode::NO_ISSUES_BRIDGE_REFUSAL),
        "{frame}"
    );
    assert!(
        inbox.try_recv().is_err(),
        "no bridge is still the card's state, not an error frame"
    );
}

/// A failed Start leaves one journal record naming why it failed.
#[tokio::test]
async fn a_failed_issues_start_is_journaled_with_its_reason() {
    let (repo, state) = scratch("start-journal");
    let preflight_reason = "missing prerequisite: omp is not on PATH".to_string();
    let spawn_reason = "the issues worker could not be started";
    let attempt = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&attempt);
    let refusal = preflight_reason.clone();
    let spawned = Arc::new(AtomicUsize::new(0));
    let spawn_count = Arc::clone(&spawned);
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(move || {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    PreflightResult::Refused {
                        message: refusal.clone(),
                    }
                } else {
                    PreflightResult::Ok {
                        repository: "acme/app".into(),
                    }
                }
            }),
            // The first Start spawns a worker its preflight then refuses; the
            // second reaches a spawn that fails.
            Arc::new(move |_argv, _env| {
                if spawn_count.fetch_add(1, Ordering::SeqCst) == 0 {
                    Some(4_242_424)
                } else {
                    None
                }
            }),
            Arc::new(|_request| Ok(())),
        ),
        Arc::new(Mutex::new(Vec::new())),
    ));

    assert_eq!(
        bridge.start().await,
        StartOutcome::Started { attached: false }
    );
    wait_for_journal(&repo, &state, &preflight_reason).await;

    let failed = bridge.start().await;
    assert_eq!(failed.message(), Some(spawn_reason), "{failed:?}");
    wait_for_journal(&repo, &state, spawn_reason).await;

    let records = journal_records(&repo, &state);
    assert_eq!(
        records
            .iter()
            .filter(|text| text.contains(&preflight_reason))
            .count(),
        1,
        "one record per refused attempt: {records:?}"
    );
    assert_eq!(
        records
            .iter()
            .filter(|text| text.contains(spawn_reason))
            .count(),
        1,
        "one record per failed attempt: {records:?}"
    );
}
