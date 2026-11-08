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
    devboard::journal::journal_key(repo)
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

#[tokio::test]
async fn a_start_refusal_reports_the_preflight_message() {
    let (repo, state) = scratch("refuse");
    let sink: Sink = Arc::new(Mutex::new(Vec::new()));
    let bridge = IssuesBridge::new(options(
        &repo,
        &state,
        hooks(
            Arc::new(|| PreflightResult::Refused {
                message: "missing prerequisite: gh is not on PATH".into(),
            }),
            Arc::new(|_argv, _env| Some(42)),
            Arc::new(|_request| Ok(())),
        ),
        sink,
    ));
    assert_eq!(
        bridge.start().await,
        StartOutcome::Refused {
            message: "missing prerequisite: gh is not on PATH".into()
        }
    );
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
        json!({"type": "error", "message": "No such issues run."})
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
