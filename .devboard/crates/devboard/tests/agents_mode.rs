//! The background-agent registry, prompt pages, settings writes, and the
//! start/stop dispositions of the detached-worker dashboards.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use devboard::agents_mode::{ForgeFact, ForgeProjection, ForgeReader};
use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::journal::Journal;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

#[cfg(target_os = "linux")]
mod common;

#[cfg(target_os = "linux")]
use common::AccessCounter;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

type RecordedSpawns = Arc<Mutex<Vec<(Vec<String>, HashMap<String, String>)>>>;

fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!(
            "agents-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/.devboard/prompts")).expect("a prompt root");
    std::fs::create_dir_all(root.join("repo/adrs")).expect("an adr root");
    std::fs::create_dir_all(root.join("state")).expect("a state root");
    for prompt in [
        "scout-recommendations.md",
        "design-system.md",
        "dead-code-removal.md",
        "api-standards.md",
        "single-responsibility.md",
        "consistent-naming.md",
        "release-train.md",
    ] {
        std::fs::write(
            root.join("repo/.devboard/prompts").join(prompt),
            format!("# {prompt}\n\nBytes.\n"),
        )
        .expect("a prompt file");
    }
    root
}

fn app_at(root: &Path) -> Arc<App> {
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: None,
        agent_command: "omp acp".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    App::new(config, journal)
}

fn connection() -> (Conn, UnboundedReceiver<String>) {
    let (outbox, inbox) = tokio::sync::mpsc::unbounded_channel();
    (Conn::new(outbox), inbox)
}

async fn connection_for(app: &Arc<App>) -> (Conn, UnboundedReceiver<String>) {
    let (conn, inbox) = connection();
    app.register(conn.clone()).await;
    (conn, inbox)
}

fn frames(inbox: &mut UnboundedReceiver<String>) -> Vec<Value> {
    let mut result = Vec::new();
    while let Ok(text) = inbox.try_recv() {
        result.push(serde_json::from_str(&text).expect("a JSON frame"));
    }
    result
}

fn find<'a>(frames: &'a [Value], kind: &str) -> Vec<&'a Value> {
    frames
        .iter()
        .filter(|frame| frame.get("type").and_then(Value::as_str) == Some(kind))
        .collect()
}

fn agent<'a>(frames: &'a [Value], id: &str) -> Option<&'a Value> {
    frames
        .iter()
        .filter(|frame| frame.get("type").and_then(Value::as_str) == Some("agentState"))
        .filter_map(|frame| frame.get("agent"))
        .filter(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
        .next_back()
}

fn repo_key(repo: &Path) -> String {
    devboard::journal::repo_key(repo)
}

fn write_json(path: &Path, value: Value) {
    std::fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
    std::fs::write(path, format!("{value}\n")).expect("a state file");
}

fn dead_code_state(_root: &Path, repo: &Path, state_dir: &Path, pid: u32) -> Value {
    let started = devboard::journal::now_iso8601();
    json!({
        "version": 1,
        "repo": repo.to_string_lossy(),
        "root": repo.to_string_lossy(),
        "lifecycle": "idle",
        "enabled": true,
        "worker": {
            "pid": pid,
            "startedAt": started,
            "stateDir": state_dir.to_string_lossy(),
            "harnessVersion": null,
            "argv": ["devboard", "worker", "dead-code"],
        },
        "limits": {"maxPerHour": 10, "maxPending": 5},
        "intervalMinutes": 60,
        "lastCycleStartedAt": null,
        "issues": [],
        "releaseSignature": null,
        "sync": {"state": "stale", "at": null, "error": null},
        "newestCycleId": null,
        "nextAttemptAt": null,
        "lastError": null,
        "notice": null,
        "draining": false,
        "updatedAt": devboard::journal::now_iso8601(),
    })
}

fn write_lock(repo: &Path, state_dir: &Path, pid: u32) {
    write_lock_started_at(repo, state_dir, pid, &devboard::journal::now_iso8601());
}

/// A lock whose `startedAt` matches when the stand-in worker actually started:
/// the publish may land late, but the process it names did not.
fn write_lock_started_at(repo: &Path, state_dir: &Path, pid: u32, started_at: &str) {
    let path = repo.join(".devboard/.tmp/dead-code/lock");
    write_json(
        &path,
        json!({
            "pid": pid,
            "startedAt": started_at,
            "repo": repo.to_string_lossy(),
            "stateDir": state_dir.to_string_lossy(),
            "harnessVersion": null,
            "argv": ["devboard", "worker", "dead-code"],
        }),
    );
}

/// The machine-scoped Watchdog holds its lock under the repository's own
/// `.devboard/.tmp/watchdog`, not under a per-repository key.
fn write_watchdog_lock(repo: &Path, state_dir: &Path, pid: u32) {
    write_json(
        &repo.join(".devboard/.tmp/watchdog/lock"),
        json!({
            "pid": pid,
            "startedAt": devboard::journal::now_iso8601(),
            "repo": repo.to_string_lossy(),
            "stateDir": state_dir.to_string_lossy(),
            "harnessVersion": null,
            "argv": ["devboard", "worker", "watchdog"],
        }),
    );
}

/// A start preflight that never settles, so the only way its Start ends is the
/// command itself being dropped.
fn hanging_preflight() -> devboard::agents_mode::PreflightCallback {
    Arc::new(|_request| Box::pin(std::future::pending()))
}

/// A live stand-in worker that outlives the call without being reaped.
fn stand_in_watchdog() -> u32 {
    let child = std::process::Command::new("sleep")
        .arg("60")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("a stand-in worker");
    let pid = child.id();
    std::mem::forget(child);
    pid
}

#[tokio::test]
async fn family_snapshots_and_prompts_replay_in_registry_order() {
    let root = scratch("snapshots");
    let app = app_at(&root);
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::replay(&app, &conn);

    let all = frames(&mut inbox);
    let state = all
        .iter()
        .find(|frame| frame.get("type").and_then(Value::as_str) == Some("agentsState"))
        .expect("an agentsState frame");
    let agents = state
        .get("agents")
        .and_then(Value::as_array)
        .expect("an agents list");
    let ids: Vec<&str> = agents
        .iter()
        .filter_map(|agent| agent.get("id").and_then(Value::as_str))
        .collect();
    assert_eq!(
        ids,
        vec![
            "scout",
            "watchdog",
            "design",
            "dead-code",
            "mcp-optimizer",
            "api-standards",
            "single-responsibility",
            "consistent-naming",
            "release-train",
        ]
    );
    let scout = &agents[0];
    assert_eq!(scout["label"], "Auto Scout");
    assert_eq!(
        scout["description"],
        "Scans the repository and files significant findings as issues."
    );
    assert_eq!(scout["scope"], "repository");
    assert_eq!(scout["source"], "live");
    assert_eq!(
        scout["asOf"],
        Value::Null,
        "a live answer is current by construction"
    );
    assert_eq!(scout["lifecycle"], "stopped");
    assert_eq!(scout["paused"], false);
    assert_eq!(scout["cadence"]["minutes"], 1);
    assert_eq!(scout["cadence"]["defaultMinutes"], 1);
    assert_eq!(scout["limits"]["maxPerHour"], 10);
    assert_eq!(scout["limits"]["maxPending"], 5);
    assert_eq!(scout["detail"]["panel"], "activity");
    assert!(scout["issues"].as_array().expect("issues").is_empty());
    assert_eq!(scout["notices"], json!([]));
    assert_eq!(scout["lastScan"], Value::Null);
    assert!(scout["workers"].as_array().expect("workers").is_empty());

    let watchdog = &agents[1];
    assert_eq!(watchdog["scope"], "machine");
    assert_eq!(watchdog["cadence"]["minutes"], 10);
    assert_eq!(watchdog["limits"]["maxPerHour"], Value::Null);
    assert_eq!(watchdog["detail"]["panel"], "cycles");

    let design = &agents[2];
    assert_eq!(design["cadence"]["minutes"], 60);
    assert!(design["documentation"]
        .as_array()
        .expect("documentation")
        .is_empty());

    let mcp = &agents[4];
    assert_eq!(mcp["cadence"]["defaultMinutes"], 60);
    assert_eq!(mcp["limits"]["maxPending"], 20);
    assert_eq!(mcp["detail"]["panel"], "cycles");

    let naming = &agents[7];
    assert_eq!(naming["label"], "Consistent Naming");
    assert_eq!(
        naming["description"],
        "Audits the repository's vocabulary against the project naming skill and files one capped vocabulary issue per concept and violation."
    );
    assert_eq!(naming["scope"], "repository");
    assert_eq!(naming["cadence"]["defaultMinutes"], 60);
    assert_eq!(naming["limits"]["maxPerHour"], 10);
    assert_eq!(naming["limits"]["maxPending"], 5);
    assert_eq!(naming["detail"]["panel"], "activity");

    let release = &agents[8];
    assert_eq!(release["cadence"]["minutes"], 10);
    assert_eq!(release["detail"]["scanId"], "idle:0");

    let prompts = find(&all, "agentPromptState");
    assert_eq!(prompts.len(), 9);
    assert_eq!(prompts[0]["id"], "scout");
    assert_eq!(prompts[0]["prompt"]["absent"], false);
    assert!(prompts[0]["prompt"]["text"]
        .as_str()
        .expect("scout prompt")
        .contains("# scout-recommendations.md"));
    assert_eq!(prompts[1]["id"], "watchdog");
    assert_eq!(prompts[1]["prompt"]["absent"], true);
    assert_eq!(prompts[1]["prompt"]["text"], Value::Null);
    let template = prompts[4]["prompt"]["template"]
        .as_str()
        .expect("the generated template");
    assert!(template.starts_with("## Manifesto"));
    assert!(template.contains("Family:\n<family>"));
    assert!(template
        .contains("Open MCP optimizer issues:\nOpen MCP optimizer issues could not be read."));
    assert!(template.contains("\"filingRoom\": \"<filingRoom>\""));
}

#[tokio::test]
async fn prompt_errors_and_unknown_agents_refuse_by_name() {
    let root = scratch("prompt-errors");
    let app = app_at(&root);
    let (conn, mut inbox) = connection_for(&app).await;

    assert!(
        devboard::agents_mode::handle(&app, &conn, &Command::GetAgentPrompt { id: None }).await
    );
    assert!(
        devboard::agents_mode::handle(
            &app,
            &conn,
            &Command::GetAgentPrompt {
                id: Some(json!("not-an-agent")),
            }
        )
        .await
    );
    let all = frames(&mut inbox);
    assert_eq!(all[0]["message"], "An agent prompt needs its agent id.");
    assert_eq!(all[1]["type"], "agentPromptError");
    assert_eq!(all[1]["id"], "not-an-agent");
    assert_eq!(all[1]["message"], "Unknown background agent: not-an-agent.");

    let (conn, mut inbox) = connection_for(&app).await;
    assert!(devboard::agents_mode::handle(&app, &conn, &Command::StartAgent { id: None }).await);
    assert!(
        devboard::agents_mode::handle(
            &app,
            &conn,
            &Command::DisableAgentTimer {
                id: Some(json!("scout")),
            }
        )
        .await
    );
    let all = frames(&mut inbox);
    assert_eq!(all[0]["message"], "An agent command needs its agent id.");
    assert_eq!(
        all[1]["message"],
        "Auto Scout has no legacy timer to disable."
    );
}

#[tokio::test]
async fn settings_round_trip_and_refusals() {
    let root = scratch("settings");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let (conn, mut inbox) = connection_for(&app).await;

    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::SetAgentSettings {
            id: Some(json!("scout")),
            minutes: Some(json!(30)),
            max_per_hour: Some(json!(20)),
            max_pending: Some(Value::Null),
        },
    )
    .await;
    let all = frames(&mut inbox);
    assert!(find(&all, "error").is_empty());
    let settings_path = state
        .join("scout")
        .join(repo_key(&repo))
        .join("settings.json");
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).expect("settings"))
            .expect("JSON settings");
    assert_eq!(
        written,
        json!({"maxPerHour": 20, "maxPending": null, "intervalMinutes": 30})
    );
    let scout = agent(&all, "scout").expect("a scout snapshot");
    assert_eq!(scout["cadence"]["minutes"], 30, "{scout}");
    assert_eq!(scout["limits"]["maxPerHour"], 20);
    assert_eq!(scout["limits"]["maxPending"], Value::Null);

    for (minutes, hourly, pending, message) in [
        (
            0,
            json!(20),
            json!(null),
            "The cadence must be an integer from 1 through 1440 minutes.",
        ),
        (
            1441,
            json!(20),
            json!(null),
            "The cadence must be an integer from 1 through 1440 minutes.",
        ),
        (
            30,
            json!(101),
            json!(null),
            "Both limits must be empty or integers from 1 through 100.",
        ),
        (
            30,
            Value::Null,
            json!(0),
            "Both limits must be empty or integers from 1 through 100.",
        ),
    ] {
        let (conn, mut inbox) = connection_for(&app).await;
        devboard::agents_mode::handle(
            &app,
            &conn,
            &Command::SetAgentSettings {
                id: Some(json!("scout")),
                minutes: Some(json!(minutes)),
                max_per_hour: Some(hourly),
                max_pending: Some(pending),
            },
        )
        .await;
        let all = frames(&mut inbox);
        let errors = find(&all, "error");
        let error = errors.first().expect("a refusal");
        assert_eq!(error["message"], message);
    }

    // A missing limit is as invalid as an out-of-range one.
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::SetAgentSettings {
            id: Some(json!("scout")),
            minutes: Some(json!(30)),
            max_per_hour: None,
            max_pending: Some(json!(null)),
        },
    )
    .await;
    let all = frames(&mut inbox);
    assert_eq!(
        find(&all, "error")[0]["message"],
        "Both limits must be empty or integers from 1 through 100."
    );

    // The file survived every refusal.
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).expect("settings"))
            .expect("JSON settings");
    assert_eq!(written["intervalMinutes"], 30);
}

#[tokio::test]
async fn start_spawns_the_rust_worker_argv_and_stop_writes_control() {
    let root = scratch("start-stop");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");

    let recorded: RecordedSpawns = Arc::new(Mutex::new(Vec::new()));
    let child_pid = Arc::new(Mutex::new(None::<u32>));
    let recorded_spawn = Arc::clone(&recorded);
    let child_for_spawn = Arc::clone(&child_pid);
    let repo_for_spawn = repo.clone();
    let state_for_spawn = state.clone();
    devboard::agents_mode::set_spawn(&app, move |argv, environment| {
        recorded_spawn
            .lock()
            .expect("recorded spawns")
            .push((argv.to_vec(), environment.clone()));
        let child = std::process::Command::new("sleep")
            .arg("60")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("a stand-in worker");
        let pid = child.id();
        // The stand-in must outlive this call; nothing reaps it.
        std::mem::forget(child);
        *child_for_spawn.lock().expect("a pid") = Some(pid);
        write_lock(&repo_for_spawn, &state_for_spawn, pid);
        let path = state_for_spawn
            .join("dead-code")
            .join(repo_key(&repo_for_spawn))
            .join("state.json");
        write_json(
            &path,
            dead_code_state(&root, &repo_for_spawn, &state_for_spawn, pid),
        );
        Some(pid)
    });
    let preflight: devboard::agents_mode::PreflightCallback =
        Arc::new(|_request| Box::pin(async { Ok("owner/repository".to_string()) }));
    devboard::agents_mode::set_preflight(&app, "dead-code", preflight);
    devboard::agents_mode::set_agent_environment(&app, || Box::pin(async { Ok(HashMap::new()) }));

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StartAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    assert!(find(&all, "error").is_empty(), "start refused: {all:?}");
    {
        let spawned = recorded.lock().expect("recorded spawns");
        assert_eq!(spawned.len(), 1);
        let (argv, environment) = &spawned[0];
        let executable = std::env::current_exe()
            .expect("the test binary")
            .to_string_lossy()
            .into_owned();
        assert_eq!(argv[0], executable);
        assert_eq!(
            &argv[1..6],
            &[
                "worker".to_string(),
                "dead-code".to_string(),
                "--repo".to_string(),
                repo.to_string_lossy().into_owned(),
                "--state-dir".to_string(),
            ]
        );
        assert_eq!(argv[6], state.to_string_lossy());
        assert_eq!(argv.len(), 7);
        assert_eq!(
            environment.get("REPO_DIR"),
            Some(&repo.to_string_lossy().into_owned())
        );
        assert_eq!(
            environment.get("STATE_DIR"),
            Some(&state.to_string_lossy().into_owned())
        );
        assert_eq!(
            environment.get("AGENT_COMMAND"),
            Some(&"omp acp".to_string())
        );
    }

    let attached = agent(&all, "dead-code").expect("a dead-code snapshot");
    assert_eq!(attached["lifecycle"], "running", "{all:?}");
    assert_eq!(attached["attached"], true);
    assert_eq!(attached["owned"], true);
    assert_eq!(attached["enabled"], true);
    assert_eq!(
        attached["workers"][0]["pid"],
        child_pid.lock().expect("a pid").expect("a pid")
    );

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StopAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    assert!(find(&all, "error").is_empty(), "stop refused: {all:?}");
    let control = state
        .join("dead-code")
        .join(repo_key(&repo))
        .join("control");
    let mut names: Vec<String> = std::fs::read_dir(&control)
        .expect("a control directory")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names.len(), 1);
    let command: Value =
        serde_json::from_str(&std::fs::read_to_string(control.join(&names[0])).expect("a command"))
            .expect("JSON command");
    assert_eq!(command, json!({"type": "stop"}));

    let stand_in = *child_pid.lock().expect("a pid");
    if let Some(pid) = stand_in {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

#[tokio::test]
async fn a_stop_answer_reads_each_cycle_summary_once() {
    let root = scratch("stop-cycle-reads");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");

    let pid = stand_in_watchdog();
    write_watchdog_lock(&repo, &state, pid);

    // A long-lived watchdog keeps one run per cycle. The family holds more runs
    // than its projection lists, so the bound is part of this test too.
    let runs = repo.join(".devboard/.tmp/watchdog/runs");
    for index in 0..120 {
        let hour = 10 + index / 60;
        let minute = index % 60;
        let at = format!("2026-11-09T{hour:02}:{minute:02}:00.000Z");
        write_json(
            &runs
                .join(format!("2026-11-09T{hour:02}-{minute:02}-00-000Z"))
                .join("cycle.json"),
            json!({
                "cycle": at,
                "window": {"start": at, "end": at},
                "action": "none",
                "findings": [{"fingerprint": format!("finding-{index}")}],
                "issues": [],
            }),
        );
    }
    devboard::sampling::reset_reads_under(&runs);

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StopAgent {
            id: Some(json!("watchdog")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    assert!(find(&all, "error").is_empty(), "stop refused: {all:?}");
    let listed = devboard::sampling::reads_under(&runs);
    assert_eq!(
        listed, 100,
        "the Stop answer reads each listed cycle summary once, not per row"
    );

    // The same projection over an unchanged history reads no summary again, so
    // the answer is bounded by the state that changed, not by the history it
    // accumulated.
    let started = std::time::Instant::now();
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StopAgent {
            id: Some(json!("watchdog")),
        },
    )
    .await;
    let elapsed = started.elapsed();
    let all = frames(&mut inbox);
    assert!(find(&all, "error").is_empty(), "stop refused: {all:?}");
    assert_eq!(
        devboard::sampling::reads_under(&runs),
        listed,
        "an unchanged cycle history is never read again"
    );
    assert!(
        elapsed < std::time::Duration::from_millis(250),
        "a Stop answer over an unchanged history took {elapsed:?}"
    );

    kill_stand_in(pid);
}

#[tokio::test]
async fn a_slow_preflight_never_trips_the_state_publication_proof() {
    let root = scratch("slow-preflight");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let child_pid = Arc::new(Mutex::new(None::<u32>));
    let child_for_spawn = Arc::clone(&child_pid);
    let started_at = Arc::new(Mutex::new(String::new()));
    let started_at_for_spawn = Arc::clone(&started_at);
    // The spawn answers at once and publishes no lock: a real worker's first
    // tick writes it, and the proof must measure that publish, not the click.
    devboard::agents_mode::set_spawn(&app, move |_argv, _environment| {
        let child = std::process::Command::new("sleep")
            .arg("60")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("a stand-in worker");
        let pid = child.id();
        std::mem::forget(child);
        *child_for_spawn.lock().expect("a pid") = Some(pid);
        *started_at_for_spawn.lock().expect("a start time") = devboard::journal::now_iso8601();
        Some(pid)
    });
    // A forge preflight reads the repository and ensures its labels; on its own
    // it outlasts the five second window the proof allows.
    let preflight: devboard::agents_mode::PreflightCallback = Arc::new(|_request| {
        Box::pin(async {
            tokio::time::sleep(std::time::Duration::from_millis(5_400)).await;
            Ok("owner/repository".to_string())
        })
    });
    devboard::agents_mode::set_preflight(&app, "dead-code", preflight);
    devboard::agents_mode::set_agent_environment(&app, || Box::pin(async { Ok(HashMap::new()) }));

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StartAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    assert!(
        find(&all, "error").is_empty(),
        "a slow preflight is not a start failure: {all:?}"
    );
    let pending = agent(&all, "dead-code").expect("a dead-code snapshot");
    assert_eq!(pending["lifecycle"], "starting", "{all:?}");
    assert_eq!(pending["error"], Value::Null, "{all:?}");

    // A live worker that has not published yet is not a failure, however long
    // the publish takes: the process is the proof, the lock only proves
    // attachment.
    let pid = child_pid.lock().expect("a pid").expect("a pid");
    tokio::time::sleep(std::time::Duration::from_millis(5_400)).await;
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::GetAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    let quiet = agent(&all, "dead-code").expect("a dead-code snapshot");
    assert_eq!(quiet["lifecycle"], "starting", "{all:?}");
    assert_eq!(quiet["error"], Value::Null, "{all:?}");

    // The worker's own first publish then proves the start.
    let started = started_at.lock().expect("a start time").clone();
    write_lock_started_at(&repo, &state, pid, &started);
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::GetAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    let running = agent(&all, "dead-code").expect("a dead-code snapshot");
    assert_eq!(running["lifecycle"], "running", "{all:?}");
    assert_eq!(running["error"], Value::Null, "{all:?}");

    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[tokio::test]
async fn a_worker_that_dies_without_publishing_reports_the_proof_failure() {
    let root = scratch("dead-worker");
    let app = app_at(&root);
    let dead_pid = Arc::new(Mutex::new(None::<u32>));
    let dead_for_spawn = Arc::clone(&dead_pid);
    // The spawn answers with a pid that has already exited and never writes a
    // lock: the honest failure the proof exists for.
    devboard::agents_mode::set_spawn(&app, move |_argv, _environment| {
        let mut child = std::process::Command::new("true")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("a stand-in worker");
        let pid = child.id();
        let _ = child.wait();
        *dead_for_spawn.lock().expect("a pid") = Some(pid);
        Some(pid)
    });
    let preflight: devboard::agents_mode::PreflightCallback =
        Arc::new(|_request| Box::pin(async { Ok("owner/repository".to_string()) }));
    devboard::agents_mode::set_preflight(&app, "dead-code", preflight);
    devboard::agents_mode::set_agent_environment(&app, || Box::pin(async { Ok(HashMap::new()) }));

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StartAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    assert!(find(&all, "error").is_empty(), "start refused: {all:?}");

    tokio::time::sleep(std::time::Duration::from_millis(5_400)).await;
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::GetAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    let failed = agent(&all, "dead-code").expect("a dead-code snapshot");
    assert_eq!(
        failed["error"],
        json!("the Dead Code worker did not publish its state within 5 seconds"),
        "{all:?}"
    );
    assert_eq!(failed["lifecycle"], "stopped", "{all:?}");
}

#[tokio::test]
async fn an_attached_worker_clears_a_preview_its_own_start_still_shows() {
    let root = scratch("stale-preview");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    // A bound far past the test keeps the abandonment reset out of the way: the
    // attachment is the only thing that can retire the preview.
    devboard::agents_mode::set_preflight(&app, "watchdog", hanging_preflight());
    devboard::agents_mode::set_preflight_timeout(&app, "watchdog", 600_000);
    let spawned: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&spawned);
    devboard::agents_mode::set_spawn(&app, move |_argv, _environment| {
        let pid = stand_in_reapable();
        recorded.lock().expect("pids").push(pid);
        Some(pid)
    });

    // A Start that is still in flight — its preflight has not answered — while a
    // worker of this root exists, which is exactly what a second dashboard's
    // start leaves behind for this one to read.
    let starting_app = Arc::clone(&app);
    let (start_conn, _start_inbox) = connection_for(&app).await;
    let start = tokio::spawn(async move {
        devboard::agents_mode::handle(
            &starting_app,
            &start_conn,
            &Command::StartAgent {
                id: Some(json!("watchdog")),
            },
        )
        .await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let pid = stand_in_watchdog();
    write_watchdog_lock(&repo, &state, pid);
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::GetAgent {
            id: Some(json!("watchdog")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    let attached = agent(&all, "watchdog").expect("a watchdog snapshot");
    assert_eq!(attached["lifecycle"], "running", "{all:?}");
    assert_eq!(attached["attached"], true, "{all:?}");

    start.abort();
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    kill_recorded(&spawned);
}

#[tokio::test]
async fn reconnect_replays_the_newest_scout_activity_and_sorted_issues() {
    let root = scratch("replay");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let scan = repo.join(".devboard/.tmp/scout/scans/scan-1");
    std::fs::create_dir_all(&scan).expect("a scan directory");
    write_json(
        &scan.join("activity.json"),
        json!(["first line", "second line"]),
    );
    write_json(
        &state.join("scout").join(repo_key(&repo)).join("state.json"),
        json!({
            "version": 2,
            "repo": repo.to_string_lossy(),
            "root": repo.to_string_lossy(),
            "lifecycle": "idle",
            "enabled": false,
            "worker": null,
            "limits": {"maxPerHour": 10, "maxPending": 5},
            "intervalMinutes": 1,
            "lastScanStartedAt": "2026-01-02T00:00:00.000Z",
            "issues": [
                {
                    "number": 1,
                    "title": "older",
                    "url": "https://example.test/owner/repo/issues/1",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "state": "pending",
                    "category": "clarity",
                    "version": null,
                    "versionAttemptAt": null,
                    "versionError": null
                },
                {
                    "number": 2,
                    "title": "newer",
                    "url": "https://example.test/owner/repo/issues/2",
                    "createdAt": "2026-01-03T00:00:00.000Z",
                    "state": "implemented",
                    "category": "tests",
                    "version": "1.2.3",
                    "versionAttemptAt": null,
                    "versionError": null
                }
            ],
            "openTitles": [],
            "releaseSignature": null,
            "sync": {"state": "stale", "at": null, "error": null},
            "scan": {
                "scanId": "scan-1",
                "startedAt": "2026-01-02T00:00:00.000Z",
                "requested": 2
            },
            "newestScanId": "scan-1",
            "nextAttemptAt": null,
            "lastError": null,
            "notice": null,
            "updatedAt": "2026-01-03T00:00:00.000Z",
        }),
    );

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::replay(&app, &conn);
    let all = frames(&mut inbox);
    let state_frame = all
        .iter()
        .find(|frame| frame.get("type").and_then(Value::as_str) == Some("agentsState"))
        .expect("an agentsState frame");
    let scout = &state_frame["agents"][0];
    assert_eq!(scout["detail"]["scanId"], "scan-1");
    let issues = scout["issues"].as_array().expect("issues");
    assert_eq!(issues.len(), 2);
    assert_eq!(issues[0]["title"], "newer");
    assert_eq!(issues[0]["version"], "1.2.3");
    assert_eq!(issues[1]["title"], "older");
    assert_eq!(issues[1]["state"], "pending");
    assert_eq!(scout["pending"], 1);

    let activity = find(&all, "agentActivity")
        .into_iter()
        .find(|frame| frame.get("id").and_then(Value::as_str) == Some("scout"))
        .expect("scout activity");
    assert_eq!(activity["scanId"], "scan-1");
    assert_eq!(activity["replay"], true);
    assert_eq!(
        activity["entries"],
        json!([
            {"text": "first line", "append": false},
            {"text": "second line", "append": false}
        ])
    );
}

#[tokio::test]
async fn a_hanging_start_preflight_refuses_within_the_bound() {
    let root = scratch("start-timeout");
    let app = app_at(&root);
    devboard::agents_mode::set_preflight_timeout(&app, "scout", 20);
    let preflight: devboard::agents_mode::PreflightCallback = Arc::new(|_request| {
        Box::pin(async { std::future::pending::<Result<String, String>>().await })
    });
    devboard::agents_mode::set_preflight(&app, "scout", preflight);
    devboard::agents_mode::set_agent_environment(&app, || Box::pin(async { Ok(HashMap::new()) }));
    let pids: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&pids);
    devboard::agents_mode::set_spawn(&app, move |_argv, _environment| {
        let pid = stand_in_reapable();
        recorded.lock().expect("pids").push(pid);
        Some(pid)
    });
    let (conn, mut inbox) = connection_for(&app).await;

    let started = std::time::Instant::now();
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StartAgent {
            id: Some(json!("scout")),
        },
    )
    .await;
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "Start waited for its preflight"
    );
    // The preflight runs beside the spawned worker; its refusal lands on the
    // card. A budget refusal is latency: the notice states it and no error
    // frame reaches the page.
    let (scout, all) = wait_for_snapshot(&app, &conn, &mut inbox, "scout", |snapshot| {
        snapshot["notice"].as_str().is_some()
    })
    .await;
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert!(find(&all, "error").is_empty(), "{all:?}");
    assert_eq!(
        scout["notice"],
        "the start preflight did not finish within 20 ms; press Start to retry."
    );
    assert_eq!(scout["error"], Value::Null);
    assert_ne!(scout["lifecycle"], "starting");
    let pid = *pids.lock().expect("pids").first().expect("a pid");
    assert!(pid_dead(pid), "the refused start left its worker alive");
    kill_recorded(&pids);
}

#[tokio::test]
async fn a_slow_forge_start_refusal_stays_on_the_card_instead_of_raising_the_alarm() {
    let root = scratch("start-forge-latency");
    let app = app_at(&root);
    devboard::agents_mode::set_agent_environment(&app, || Box::pin(async { Ok(HashMap::new()) }));
    let pids: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&pids);
    devboard::agents_mode::set_spawn(&app, move |_argv, _environment| {
        let pid = stand_in_reapable();
        recorded.lock().expect("pids").push(pid);
        Some(pid)
    });
    let reason = "the Gitea repository acme/fixture could not be read before Start's deadline: \
                  GET /repos/acme/fixture failed: the request timed out after 19745 ms; \
                  press Start to retry.";
    // Every family whose Start preflight reads the forge: the shared repo
    // families — Design System among them, the family whose stalled repository
    // read raised the report — then Watchdog and MCP optimizer.
    for family in [
        "scout",
        "design",
        "dead-code",
        "api-standards",
        "single-responsibility",
        "consistent-naming",
        "watchdog",
        "mcp-optimizer",
    ] {
        let latency = reason.to_string();
        let preflight: devboard::agents_mode::PreflightCallback = Arc::new(move |_request| {
            let latency = latency.clone();
            Box::pin(async move { Err(latency) })
        });
        devboard::agents_mode::set_preflight(&app, family, preflight);
        let (conn, mut inbox) = connection_for(&app).await;
        devboard::agents_mode::handle(
            &app,
            &conn,
            &Command::StartAgent {
                id: Some(json!(family)),
            },
        )
        .await;
        let (snapshot, all) = wait_for_snapshot(&app, &conn, &mut inbox, family, |snapshot| {
            snapshot["notice"].as_str().is_some()
        })
        .await;
        // A read that ran out of time against a forge that is slow, not broken:
        // the card states why the start refused, and no error frame reaches the
        // page, so nothing raises an error notification or files a board issue
        // against the same forge.
        assert_eq!(snapshot["notice"], json!(reason), "{family}");
        assert_eq!(snapshot["error"], Value::Null, "{family}");
        assert_ne!(snapshot["lifecycle"], json!("starting"), "{family}");
        assert!(find(&all, "error").is_empty(), "{family}: {all:?}");

        // A refusal that names a fault the operator must fix keeps startError,
        // so the page still raises its alert.
        let fault = "missing prerequisite: the Gitea token cannot write to acme/fixture on \
                     http://forge.test";
        let refusal = fault.to_string();
        let preflight: devboard::agents_mode::PreflightCallback = Arc::new(move |_request| {
            let refusal = refusal.clone();
            Box::pin(async move { Err(refusal) })
        });
        devboard::agents_mode::set_preflight(&app, family, preflight);
        let (conn, mut inbox) = connection_for(&app).await;
        devboard::agents_mode::handle(
            &app,
            &conn,
            &Command::StartAgent {
                id: Some(json!(family)),
            },
        )
        .await;
        let (snapshot, all) = wait_for_snapshot(&app, &conn, &mut inbox, family, |snapshot| {
            snapshot["error"].as_str().is_some()
        })
        .await;
        assert_eq!(snapshot["error"], json!(fault), "{family}");
        assert_eq!(snapshot["notice"], Value::Null, "{family}");
        let refusals = find(&all, "error");
        assert_eq!(refusals.len(), 1, "{family}: {all:?}");
        assert_eq!(refusals[0]["message"], json!(fault), "{family}");
    }
    kill_recorded(&pids);
}

#[tokio::test]
async fn api_standards_start_refuses_an_unusable_rule_table_instead_of_panicking() {
    let root = scratch("api-standards-rule-table");
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join(".devboard/crates/devboard/src")).expect("a source root");
    let skill_dir = repo.join(".omp/skills/devboard-restful-api-implementation");
    std::fs::create_dir_all(skill_dir.join("references")).expect("a skill root");
    std::fs::write(skill_dir.join("SKILL.md"), "# REST\n\nBytes.\n").expect("a skill file");
    let app = app_at(&root);
    devboard::agents_mode::set_agent_environment(&app, || Box::pin(async { Ok(HashMap::new()) }));
    let pids: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&pids);
    devboard::agents_mode::set_spawn(&app, move |_argv, _environment| {
        let pid = stand_in_reapable();
        recorded.lock().expect("pids").push(pid);
        Some(pid)
    });

    let documents = [
        // A line that trims to one `|`: the shared scan refuses it, while a
        // hand-rolled first-and-last-byte check would slice `[1..0]`.
        ("## URLs\n\n|\n", "a lone pipe"),
        // A heading with no name opens no chapter, so its row table is no
        // rule table for the preflight or for the worker's parser.
        ("## \n\n| 1 | MUST | Use a URL |\n", "a blank heading"),
    ];
    for (rules, label) in documents {
        std::fs::write(skill_dir.join("references/zalando-rest-rules.md"), rules)
            .expect("a rules file");
        let (conn, mut inbox) = connection_for(&app).await;
        devboard::agents_mode::handle(
            &app,
            &conn,
            &Command::StartAgent {
                id: Some(json!("api-standards")),
            },
        )
        .await;
        let (snapshot, all) =
            wait_for_snapshot(&app, &conn, &mut inbox, "api-standards", |snapshot| {
                snapshot["error"].as_str().is_some()
            })
            .await;
        let error = snapshot["error"]
            .as_str()
            .unwrap_or_else(|| panic!("{label}: no refusal in {all:?}"));
        assert!(error.contains("no rule table"), "{label}: {error}");
        assert!(
            error.contains("zalando-rest-rules.md has no rule table"),
            "{label}: {error}"
        );
        assert_ne!(snapshot["lifecycle"], json!("starting"), "{label}");
        assert_eq!(find(&all, "error").len(), 1, "{label}: {all:?}");
    }
    kill_recorded(&pids);
}

// The budget is wall clock, so a loaded host can spend it before the first
// step starts. A paused clock makes the two steps and the deadline advance
// together and the assertion independent of how busy the machine is.
#[tokio::test(start_paused = true)]
async fn a_shared_preflight_budget_bounds_every_step_and_names_the_slow_one() {
    use devboard::agents_mode::PreflightBudget;
    use std::time::{Duration, Instant};

    let budget = PreflightBudget::new(150);
    let first = budget
        .run("the first forge step", async {
            tokio::time::sleep(Duration::from_millis(80)).await;
            Ok(1_u32)
        })
        .await
        .expect("the first step fits the budget");
    assert_eq!(first, 1);

    // The second step overruns; it is cut by the remainder of the same budget
    // and names itself, so a chained slow read can no longer outlive the
    // twenty second preflight behind a generic refusal.
    let started = Instant::now();
    let error = budget
        .run::<()>("the second forge step", async {
            tokio::time::sleep(Duration::from_millis(5_000)).await;
            Ok(())
        })
        .await
        .expect_err("a step past the shared deadline fails");
    let elapsed = started.elapsed();
    assert!(
        error.starts_with("the second forge step did not finish within "),
        "{error}"
    );
    assert!(error.ends_with(" ms; press Start to retry."), "{error}");
    assert!(elapsed < Duration::from_millis(300), "{elapsed:?}");
    assert_eq!(budget.remaining_ms(), 1);
}

#[tokio::test]
async fn a_single_responsibility_page_open_pushes_the_worker_refresh() {
    let root = scratch("single-responsibility-refresh");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let child = std::process::Command::new("sleep")
        .arg("60")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("a stand-in worker");
    let pid = child.id();
    std::mem::forget(child);
    let lock = devboard::workers::single_responsibility::lock_path(&repo);
    write_json(
        &lock,
        json!({
            "pid": pid,
            "startedAt": devboard::journal::now_iso8601(),
            "repo": repo.to_string_lossy(),
            "stateDir": state.to_string_lossy(),
            "harnessVersion": null,
            "argv": ["devboard", "worker", "single-responsibility"],
        }),
    );
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::RefreshAgent {
            id: Some(json!("single-responsibility")),
        },
    )
    .await;
    let control = devboard::workers::single_responsibility::control_directory(&state, &repo);
    let command = std::fs::read_dir(&control)
        .expect("a control directory")
        .filter_map(Result::ok)
        .map(|entry| std::fs::read_to_string(entry.path()).expect("a command"))
        .map(|text| serde_json::from_str::<Value>(&text).expect("JSON"))
        .next()
        .expect("a refresh command");
    assert_eq!(command, json!({"type": "refresh"}));
    let all = frames(&mut inbox);
    assert!(agent(&all, "single-responsibility").is_some());
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

/// The page open that asks for one fresh read answers the projection the poll
/// maintains. Reading the family's state tree on that request is what pushed
/// the action past the 1000 ms budget under load, so the read must not read it
/// at all: the projection survives the state directory disappearing, and only
/// the poll replaces it.
#[tokio::test]
async fn a_refresh_answers_the_polled_projection_without_walking_the_state_tree() {
    let root = scratch("refresh-projection");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let pid = stand_in_watchdog();
    write_lock(&repo, &state, pid);
    let directory = state.join("dead-code").join(repo_key(&repo));
    let mut seeded = dead_code_state(&root, &repo, &state, pid);
    seeded["issues"] = json!([{
        "number": 1,
        "title": "delete the unused helper",
        "url": "https://example.test/owner/repo/issues/1",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "state": "pending",
        "category": "unreferenced-symbol",
        "version": null,
        "versionAttemptAt": null,
        "versionError": null
    }]);
    write_json(&directory.join("state.json"), seeded);

    // The poll is the one projection owner; it fills the cache this read answers.
    devboard::agents_mode::poll_once(&app);
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::RefreshAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let warmed = agent(&frames(&mut inbox), "dead-code")
        .expect("a dead-code snapshot")
        .clone();
    assert_eq!(warmed["issues"][0]["title"], "delete the unused helper");

    // With the worker state gone, a fresh walk would answer no row at all; the
    // projection the poll already published answers them unchanged.
    std::fs::remove_dir_all(&directory).expect("the state directory");
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::RefreshAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let answered_frames = frames(&mut inbox);
    let answered = agent(&answered_frames, "dead-code").expect("the answering snapshot");
    assert_eq!(
        answered["issues"], warmed["issues"],
        "the refresh walked the family's state tree instead of answering its projection"
    );
    kill_stand_in(pid);
}

#[tokio::test]
async fn a_changed_open_issue_read_republishes_the_prompt_template() {
    let root = scratch("prompt-refresh");
    let app = app_at(&root);
    let (_conn, mut inbox) = connection_for(&app).await;
    let first = vec![json!({
        "number": 11,
        "title": "[mcp-optimizer] aaamarker7",
        "url": "https://example.test/11",
        "body": "family: aaamarker7",
    })];
    devboard::agents_mode::publish_prompt_templates(&app, first);
    let all = frames(&mut inbox);
    let template = find(&all, "agentPromptState")
        .into_iter()
        .find(|frame| frame["id"] == "mcp-optimizer")
        .and_then(|frame| frame["prompt"]["template"].as_str())
        .expect("the republished template");
    assert!(template.contains("aaamarker7"), "{template}");

    let second = vec![json!({
        "number": 12,
        "title": "[mcp-optimizer] bbbmarker8",
        "url": "https://example.test/12",
        "body": "family: bbbmarker8",
    })];
    devboard::agents_mode::publish_prompt_templates(&app, second);
    let all = frames(&mut inbox);
    let template = find(&all, "agentPromptState")
        .into_iter()
        .find(|frame| frame["id"] == "mcp-optimizer")
        .and_then(|frame| frame["prompt"]["template"].as_str())
        .expect("the republished template");
    assert!(template.contains("bbbmarker8"), "{template}");
    assert!(!template.contains("aaamarker7"), "{template}");
}

#[tokio::test]
async fn the_prompt_page_serves_the_workers_synthesis_template() {
    let root = scratch("prompt-shared-source");
    let state = root.join("state");
    let coach = state.join("coach");
    // Exactly 200 characters but more than 200 bytes: the worker's allowlist
    // rule counts characters, so the page must show the allowlist the
    // synthesis call sends and a settings save must keep it.
    let entry = "é".repeat(200);
    std::fs::create_dir_all(&coach).expect("a coach root");
    std::fs::write(
        coach.join("settings.json"),
        serde_json::to_string(&json!({
            "intervalMinutes": 30,
            "maxPerHour": 5,
            "maxPending": 9,
            "maxIssuesPerCycle": 3,
            "allowlist": [entry],
        }))
        .expect("settings JSON"),
    )
    .expect("the settings file");

    let rows = vec![
        json!({
            "number": 12,
            "title": "[mcp-optimizer] later",
            "url": "https://example.test/12",
            "body": "family:later",
        }),
        json!({
            "number": 11,
            "title": "[mcp-optimizer] earlier",
            "url": "https://example.test/11",
            "body": "family:earlier",
        }),
        json!({
            "number": 13,
            "title": "an unrelated issue",
            "url": "https://example.test/13",
            "body": "no tag here",
        }),
    ];
    let app = app_at(&root);
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::publish_prompt_templates(&app, rows.clone());
    assert!(
        devboard::agents_mode::handle(
            &app,
            &conn,
            &Command::GetAgentPrompt {
                id: Some(json!("mcp-optimizer")),
            }
        )
        .await
    );
    let all = frames(&mut inbox);
    let served = find(&all, "agentPromptState")
        .into_iter()
        .filter(|frame| frame["id"] == "mcp-optimizer")
        .next_back()
        .and_then(|frame| frame["prompt"]["template"].as_str())
        .expect("the served template");

    let settings = devboard::workers::mcp_optimizer::read_settings(&coach);
    assert_eq!(settings.allowlist, vec![entry.clone()]);
    let issues: Vec<devboard::workers::mcp_optimizer::OpenIssue> = rows
        .iter()
        .map(|row| devboard::workers::mcp_optimizer::OpenIssue {
            number: row["number"].as_u64().expect("a number"),
            title: row["title"].as_str().expect("a title").to_string(),
            body: row["body"].as_str().expect("a body").to_string(),
            url: row["url"].as_str().expect("a url").to_string(),
        })
        .collect();
    let expected = devboard::workers::mcp_optimizer::prompt_template(&settings, Some(&issues));
    assert_eq!(served, expected);
    assert!(
        served.contains("- Everything this call needs is above. Do not read, search, list, or run"),
        "{served}"
    );
    // The route rule spells the one tool whose catalog name already carries the
    // prefix, and the skip rule names the two argument fields a peer must send.
    assert!(
        served.contains("`devboard_status` mounts as `xd://mcp__devboard_status`,")
            && served.contains("never `xd://mcp__devboard_devboard_status`"),
        "{served}"
    );
    assert!(
        served.contains(
            "- Spell every argument exactly as the tool's schema names it: `mcp_optimizer_proposal_skip`\n  takes `family` and `reason`, never `familyKey` or `family_key`."
        ),
        "{served}"
    );

    // A save through the page keeps the allowlist the synthesis call reads.
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::SetAgentSettings {
            id: Some(json!("mcp-optimizer")),
            minutes: Some(json!(30)),
            max_per_hour: Some(json!(5)),
            max_pending: Some(json!(9)),
        },
    )
    .await;
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(coach.join("settings.json")).expect("saved"))
            .expect("saved JSON");
    assert_eq!(saved["allowlist"], json!([entry]));
}

/// A resolved fact stays cached; the next cycle asks only for pending and
/// unreadable URLs, and one cycle never makes more than one reader call.
#[tokio::test]
async fn forge_projection_reads_only_unresolved_urls() {
    let resolved = "https://example.test/issues/1";
    let pending = "https://example.test/issues/2";
    let unreadable = "https://example.test/issues/3";
    let all = vec![
        resolved.to_string(),
        pending.to_string(),
        unreadable.to_string(),
    ];
    let batches: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let batches_for_reader = Arc::clone(&batches);
    let calls = Arc::new(AtomicU64::new(0));
    let calls_for_reader = Arc::clone(&calls);
    let reader: ForgeReader = Arc::new(move |urls: Vec<String>| {
        let batches = Arc::clone(&batches_for_reader);
        let calls = Arc::clone(&calls_for_reader);
        batches.lock().expect("batches").push(urls.clone());
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let facts = urls
                .into_iter()
                .filter_map(|url| match url.as_str() {
                    "https://example.test/issues/1" => Some(ForgeFact {
                        url,
                        state: "implemented".to_string(),
                        version: Some("1.2.3".to_string()),
                    }),
                    "https://example.test/issues/2" => Some(ForgeFact {
                        url,
                        state: "pending".to_string(),
                        version: None,
                    }),
                    "https://example.test/issues/3" => Some(ForgeFact {
                        url,
                        state: "unreadable".to_string(),
                        version: None,
                    }),
                    _ => None,
                })
                .collect();
            Ok(facts)
        })
    });
    let reader_for_test = Arc::clone(&reader);
    let projection = ForgeProjection::new(Some(reader), Vec::new());

    let first = projection.pending_urls(all.clone());
    assert_eq!(first, all, "the first cycle reads every unresolved URL");
    let facts = reader_for_test(first.clone())
        .await
        .expect("the first read answers");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one reader call per cycle");
    projection.apply(first, facts, 1_000);

    let second = projection.pending_urls(all.clone());
    assert_eq!(
        second,
        vec![pending.to_string(), unreadable.to_string()],
        "a resolved URL is never requested again"
    );
    let facts = reader_for_test(second.clone())
        .await
        .expect("the second read answers");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "the release list is read at most once per cycle"
    );
    projection.apply(second, facts, 2_000);

    let answer = projection
        .fact(resolved)
        .expect("the resolved fact is cached");
    assert_eq!(answer.state, "implemented");
    assert_eq!(answer.version.as_deref(), Some("1.2.3"));
    assert_eq!(
        projection.fact(pending).map(|answer| answer.state),
        Some("pending".to_string())
    );
    assert!(batches.lock().expect("batches").len() == 2);
    assert_eq!(
        projection.pending_urls(all.clone()),
        vec![pending.to_string(), unreadable.to_string()]
    );

    // A restart seeds the cache from persisted state, so even its first cycle
    // asks only for the rows that were not resolved before.
    let seeded = ForgeProjection::new(
        None,
        vec![ForgeFact {
            url: resolved.to_string(),
            state: "implemented".to_string(),
            version: Some("1.2.3".to_string()),
        }],
    );
    assert_eq!(
        seeded.pending_urls(all),
        vec![pending.to_string(), unreadable.to_string()]
    );
    assert_eq!(
        seeded
            .fact(resolved)
            .and_then(|answer| answer.version)
            .as_deref(),
        Some("1.2.3")
    );
}

fn release_worker_state(pid: u32, state_dir: &Path) -> Value {
    json!({
        "version": 1,
        "pid": pid,
        "startedAt": devboard::journal::now_iso8601(),
        "root": "",
        "stateDir": state_dir.to_string_lossy(),
        "lifecycle": "running",
        "enabled": true,
        "paused": false,
        "argv": ["devboard", "worker", "release-train"],
        "lastRunAt": null,
        "nextRunAt": null,
        "lastError": null,
        "notice": null,
        "updatedAt": devboard::journal::now_iso8601(),
    })
}

/// Starts a stand-in worker process and returns its pid; the caller kills it.
fn stand_in_worker() -> u32 {
    let child = std::process::Command::new("sleep")
        .arg("60")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("a stand-in worker");
    let pid = child.id();
    // The stand-in must outlive this call; nothing reaps it.
    std::mem::forget(child);
    pid
}

fn kill_stand_in(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

fn write_release_worker(state: &Path, pid: u32, owner_state: &Path) {
    let directory = state.join("release-train");
    write_json(
        &directory.join("lock.1.41.5"),
        json!({
            "pid": pid,
            "startedAt": devboard::journal::now_iso8601(),
            "repo": "",
            "stateDir": owner_state.to_string_lossy(),
            "harnessVersion": "1.41.5",
            "argv": ["devboard", "worker", "release-train"],
        }),
    );
    write_json(
        &directory.join("workers/1.41.5/worker.json"),
        release_worker_state(pid, owner_state),
    );
}

#[tokio::test]
async fn a_release_worker_of_another_state_dir_reads_running_and_start_is_a_noop() {
    let root = scratch("release-foreign");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let foreign = root.join("foreign-state");
    std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");
    std::fs::create_dir_all(&foreign).expect("a foreign state directory");

    let recorded: RecordedSpawns = Arc::new(Mutex::new(Vec::new()));
    let recorded_spawn = Arc::clone(&recorded);
    devboard::agents_mode::set_spawn(&app, move |argv, environment| {
        recorded_spawn
            .lock()
            .expect("recorded spawns")
            .push((argv.to_vec(), environment.clone()));
        None
    });

    let pid = stand_in_worker();
    write_release_worker(&state, pid, &foreign);

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StartAgent {
            id: Some(json!("release-train")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    assert!(find(&all, "error").is_empty(), "start refused: {all:?}");
    assert!(
        recorded.lock().expect("recorded spawns").is_empty(),
        "a second release worker started: {all:?}"
    );
    let snapshot = agent(&all, "release-train").expect("a release-train snapshot");
    assert_eq!(snapshot["lifecycle"], "running", "{all:?}");
    assert_eq!(snapshot["attached"], true);
    assert_eq!(snapshot["owned"], false, "{all:?}");
    let notice = snapshot["notice"].as_str().unwrap_or_default();
    assert!(
        notice.contains("another dashboard")
            && notice.contains(&foreign.to_string_lossy().into_owned()),
        "the page does not say which dashboard owns the worker: {all:?}"
    );

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StopAgent {
            id: Some(json!("release-train")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    let errors = find(&all, "error");
    assert_eq!(errors.len(), 1, "stop did not name the owner: {all:?}");
    let message = errors[0]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("another dashboard") && message.contains("cannot stop it"),
        "stop did not name the owner: {all:?}"
    );

    kill_stand_in(pid);
}

#[tokio::test]
async fn a_release_worker_of_this_state_dir_is_owned() {
    let root = scratch("release-own");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");

    let pid = stand_in_worker();
    write_release_worker(&state, pid, &state);

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::replay(&app, &conn);
    let all = frames(&mut inbox);
    let state_frame = all
        .iter()
        .find(|frame| frame.get("type").and_then(Value::as_str) == Some("agentsState"))
        .expect("an agentsState frame");
    let snapshot = state_frame
        .get("agents")
        .and_then(Value::as_array)
        .expect("an agents list")
        .iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some("release-train"))
        .expect("a release-train snapshot");
    assert_eq!(snapshot["lifecycle"], "running", "{all:?}");
    assert_eq!(snapshot["attached"], true);
    assert_eq!(snapshot["owned"], true);
    assert_eq!(snapshot["notice"], Value::Null);

    kill_stand_in(pid);
}

#[tokio::test]
async fn the_release_list_names_the_newest_release_whose_run_is_not_settled() {
    let root = scratch("release-history");
    let app = app_at(&root);
    let state = root.join("state");
    let target = "a".repeat(40);
    write_json(
        &state.join("release-train/state.json"),
        json!({
            "version": 1,
            "repo": "",
            "root": "",
            "release": {
                "version": "1.42.1",
                "url": "https://forge.test/releases/tag/v1.42.1",
                "at": "2026-11-07T19:51:42.111Z",
                "sha": target,
                "range": format!("v1.42.0..{target}"),
            },
            "failure": null,
            "gate": null,
            "runs": [
                {
                    "id": "new",
                    "startedAt": "2026-11-07T19:18:10.515Z",
                    "endedAt": null,
                    "state": "running",
                    "range": format!("v1.42.0..{target}"),
                    "target": target,
                    "version": "1.42.1",
                    "url": null,
                    "detail": null,
                    "commits": 1,
                    "peer": null,
                },
                {
                    "id": "old",
                    "startedAt": "2026-11-07T01:01:40.570Z",
                    "endedAt": "2026-11-07T01:27:12.552Z",
                    "state": "released",
                    "range": format!("v1.41.4..{target}"),
                    "target": target,
                    "version": "1.41.5",
                    "url": "https://forge.test/releases/tag/v1.41.5",
                    "detail": null,
                    "commits": 4,
                    "peer": null,
                },
            ],
            "activity": [],
            "updatedAt": "2026-11-07T19:51:42.111Z",
        }),
    );

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::replay(&app, &conn);
    let all = frames(&mut inbox);
    let snapshot = all
        .iter()
        .find(|frame| frame.get("type").and_then(Value::as_str) == Some("agentsState"))
        .and_then(|frame| frame.get("agents"))
        .and_then(Value::as_array)
        .and_then(|agents| {
            agents
                .iter()
                .find(|agent| agent.get("id").and_then(Value::as_str) == Some("release-train"))
        })
        .unwrap_or_else(|| panic!("a release-train snapshot: {all:?}"));
    let releases = snapshot["releases"]
        .as_array()
        .unwrap_or_else(|| panic!("no releases: {all:?}"));
    assert_eq!(releases.len(), 2, "{all:?}");
    assert_eq!(releases[0]["version"], json!("1.42.1"), "{all:?}");
    assert_eq!(
        releases[0]["at"],
        json!("2026-11-07T19:51:42.111Z"),
        "the newest release keeps the shared record's time"
    );
    assert_eq!(
        releases[0]["url"],
        json!("https://forge.test/releases/tag/v1.42.1")
    );
    assert_eq!(releases[0]["commits"], json!(1));
    assert_eq!(releases[1]["version"], json!("1.41.5"));
}

/// The Release Train's snapshot as the `agentsState` frame carries it.
fn release_train_snapshot(frames: &[Value]) -> Value {
    frames
        .iter()
        .find(|frame| frame.get("type").and_then(Value::as_str) == Some("agentsState"))
        .and_then(|frame| frame.get("agents"))
        .and_then(Value::as_array)
        .and_then(|agents| {
            agents
                .iter()
                .find(|agent| agent.get("id").and_then(Value::as_str) == Some("release-train"))
        })
        .cloned()
        .unwrap_or_else(|| panic!("a release-train snapshot: {frames:?}"))
}

/// The release-train shared state one failure record produces, with the runs
/// the page reads beside it.
fn write_release_failure(state: &Path, failure: Value) {
    let target = "a".repeat(40);
    write_json(
        &state.join("release-train/state.json"),
        json!({
            "version": 1,
            "repo": "",
            "root": "",
            "release": null,
            "failure": failure,
            "gate": null,
            "runs": [
                {
                    "id": "only",
                    "startedAt": "2026-11-12T17:45:38.055Z",
                    "endedAt": "2026-11-12T18:08:03.869Z",
                    "state": "stopped",
                    "range": format!("v1.46.13..{target}"),
                    "target": target,
                    "version": "1.47.0",
                    "url": null,
                    "detail": "stopped during the release run",
                    "commits": 5,
                    "peer": null,
                },
            ],
            "activity": [],
            "updatedAt": "2026-11-12T18:08:03.869Z",
        }),
    );
}

/// A stopped run keeps its unverified record as the retry handle a tag the
/// stop left pushed still needs, and the operator's stop is not a release
/// error, so the page shows none.
#[tokio::test]
async fn a_stopped_release_record_raises_no_page_error() {
    let root = scratch("release-stopped");
    let app = app_at(&root);
    let state = root.join("state");
    let target = "a".repeat(40);
    write_release_failure(
        &state,
        json!({
            "at": "2026-11-12T18:08:03.869Z",
            "detail": "stopped during the release run; GitHub assets: the release v1.47.0 does not exist",
            "sha": target,
            "range": format!("v1.46.13..{target}"),
            "version": "1.47.0",
            "stopped": true,
        }),
    );

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::replay(&app, &conn);
    let all = frames(&mut inbox);
    let snapshot = release_train_snapshot(&all);
    assert_eq!(snapshot["error"], Value::Null, "{all:?}");
}

/// The other side of that rule: a record that a release failed still reads as
/// the error it is.
#[tokio::test]
async fn a_failed_release_record_still_raises_the_page_error() {
    let root = scratch("release-failed");
    let app = app_at(&root);
    let state = root.join("state");
    let target = "a".repeat(40);
    let detail = "GitHub assets: the release v1.47.0 does not exist";
    write_release_failure(
        &state,
        json!({
            "at": "2026-11-12T18:08:03.869Z",
            "detail": detail,
            "sha": target,
            "range": format!("v1.46.13..{target}"),
            "version": "1.47.0",
            "stopped": false,
        }),
    );

    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::replay(&app, &conn);
    let all = frames(&mut inbox);
    let snapshot = release_train_snapshot(&all);
    assert_eq!(snapshot["error"], json!(detail), "{all:?}");
}

#[tokio::test]
async fn a_start_that_spawns_nothing_still_answers() {
    let root = scratch("start-refusal");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let foreign = root.join("foreign-state");
    std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");
    std::fs::create_dir_all(&foreign).expect("a foreign state directory");

    let recorded: RecordedSpawns = Arc::new(Mutex::new(Vec::new()));
    let recorded_spawn = Arc::clone(&recorded);
    devboard::agents_mode::set_spawn(&app, move |argv, environment| {
        recorded_spawn
            .lock()
            .expect("recorded spawns")
            .push((argv.to_vec(), environment.clone()));
        None
    });

    let pid = stand_in_worker();
    // A live worker another STATE_DIR owns: this dashboard refuses to start a
    // second one, and the refusal is the answer to the Start.
    write_lock(&repo, &foreign, pid);
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::GetAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let before = agent(&frames(&mut inbox), "dead-code")
        .expect("a dead-code snapshot")
        .clone();
    assert!(
        before["notice"]
            .as_str()
            .unwrap_or_default()
            .contains("another dashboard")
            || before["notice"]
                .as_str()
                .unwrap_or_default()
                .contains("STATE_DIR"),
        "{before:?}"
    );

    let started = std::time::Instant::now();
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StartAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "a Start that spawns nothing waited for the ceiling"
    );
    let all = frames(&mut inbox);
    let after = agent(&all, "dead-code").expect("the answering snapshot");
    assert!(
        recorded.lock().expect("recorded spawns").is_empty(),
        "a foreign worker's dashboard spawned a second worker: {all:?}"
    );
    assert_ne!(
        after["notice"], before["notice"],
        "the Start that spawned nothing answered with the snapshot the client already had: {all:?}"
    );
    assert!(
        after["notice"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Start did nothing:"),
        "{all:?}"
    );

    // A worker this dashboard owns and that is already running: Start still
    // answers with the reason instead of leaving the control waiting.
    write_lock(&repo, &state, pid);
    let state_path = state
        .join("dead-code")
        .join(repo_key(&repo))
        .join("state.json");
    write_json(&state_path, dead_code_state(&root, &repo, &state, pid));
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::GetAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let before = agent(&frames(&mut inbox), "dead-code")
        .expect("a dead-code snapshot")
        .clone();
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StartAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    let all = frames(&mut inbox);
    let after = agent(&all, "dead-code").expect("the answering snapshot");
    assert_ne!(
        after["notice"], before["notice"],
        "a running family's Start answered with the unchanged snapshot: {all:?}"
    );
    assert!(
        after["notice"]
            .as_str()
            .unwrap_or_default()
            .contains("already running"),
        "{all:?}"
    );
    assert!(recorded.lock().expect("recorded spawns").is_empty());

    kill_stand_in(pid);
}

#[tokio::test]
async fn an_unchanged_snapshot_is_not_rebroadcast() {
    let root = scratch("quiet-poll");
    let app = app_at(&root);
    let (conn, mut inbox) = connection_for(&app).await;
    devboard::agents_mode::replay(&app, &conn);
    let _ = frames(&mut inbox);

    // The replay opens its settle window; every tick after it must find the
    // same state and publish nothing.
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    for _ in 0..4 {
        devboard::agents_mode::poll_once(&app);
    }

    let all = frames(&mut inbox);
    assert!(
        find(&all, "agentState").is_empty(),
        "an unchanged snapshot was rebroadcast: {all:?}"
    );
}

#[tokio::test]
async fn a_get_agents_read_never_starves_the_poll() {
    let root = scratch("read-poll");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let scan = repo.join(".devboard/.tmp/scout/scans/scan-1");
    std::fs::create_dir_all(&scan).expect("a scan directory");
    write_json(&scan.join("activity.json"), json!(["first line"]));
    write_json(
        &state.join("scout").join(repo_key(&repo)).join("state.json"),
        json!({
            "version": 2,
            "repo": "owner/repo",
            "root": repo.to_string_lossy(),
            "lifecycle": "scanning",
            "enabled": true,
            "worker": null,
            "limits": {"maxPerHour": 10, "maxPending": 5},
            "intervalMinutes": 1,
            "lastScanStartedAt": "2026-01-02T00:00:00.000Z",
            "issues": [],
            "openTitles": [],
            "releaseSignature": null,
            "sync": {"state": "ok", "at": "2026-01-02T00:00:00.000Z", "error": null},
            "scan": {
                "scanId": "scan-1",
                "startedAt": "2026-01-02T00:00:00.000Z",
                "requested": 1
            },
            "newestScanId": "scan-1",
            "nextAttemptAt": null,
            "lastError": null,
            "notice": null,
            "updatedAt": "2026-01-02T00:00:01.000Z",
        }),
    );
    let (conn, mut inbox) = connection_for(&app).await;

    // A running family's page reads `getAgents` every second; that read is
    // answered from the poll's projection and must leave the poll its tick.
    devboard::agents_mode::handle(&app, &conn, &Command::GetAgents).await;
    let _ = frames(&mut inbox);
    write_json(
        &scan.join("activity.json"),
        json!(["first line", "second line"]),
    );
    devboard::agents_mode::handle(&app, &conn, &Command::GetAgents).await;
    let _ = frames(&mut inbox);
    devboard::agents_mode::poll_once(&app);
    let _ = frames(&mut inbox);

    devboard::agents_mode::handle(&app, &conn, &Command::GetAgents).await;
    let all = frames(&mut inbox);
    let scout = all
        .iter()
        .rev()
        .find(|frame| frame.get("type").and_then(Value::as_str) == Some("agentsState"))
        .and_then(|frame| frame.get("agents"))
        .and_then(Value::as_array)
        .and_then(|agents| {
            agents
                .iter()
                .find(|agent| agent.get("id").and_then(Value::as_str) == Some("scout"))
        })
        .expect("a scout snapshot");
    assert_eq!(scout["detail"]["scanId"], "scan-1");
    assert_eq!(
        scout["detail"]["entries"],
        json!(["first line", "second line"]),
        "a read deferred the poll, so the activity log froze: {scout:?}"
    );
}

/// One versioned worker state in a family's tree.
fn versioned_worker_state(repo: &Path, state_dir: &Path, version: &str, worker_pid: u32) -> Value {
    let mut value = dead_code_state(&repo.join(".."), repo, state_dir, worker_pid);
    value["version"] = json!(1);
    value["harnessVersion"] = json!(version);
    value
}

fn versioned_state_path(state_dir: &Path, family: &str, repo: &Path, version: &str) -> PathBuf {
    state_dir
        .join(family)
        .join(repo_key(repo))
        .join("workers")
        .join(version)
        .join("state.json")
}

#[tokio::test]
async fn an_unchanged_family_is_not_read_and_history_does_not_matter() {
    let root = scratch("history");
    let repo = root.join("repo");
    let state = root.join("state");
    let five = state.join("dead-code").join(repo_key(&repo));
    let fifty = state.join("consistent-naming").join(repo_key(&repo));
    for index in 0..5 {
        let version = format!("1.0.{index}");
        write_json(
            &versioned_state_path(&state, "dead-code", &repo, &version),
            versioned_worker_state(&repo, &state, &version, 9_000 + index),
        );
    }
    let mut changed_path = PathBuf::new();
    for index in 0..50 {
        let version = format!("1.1.{index}");
        let path = versioned_state_path(&state, "consistent-naming", &repo, &version);
        write_json(
            &path,
            versioned_worker_state(&repo, &state, &version, 8_000 + index),
        );
        if index == 7 {
            changed_path = path;
        }
    }

    let app = app_at(&root);
    // One interval warms the projections; the next one is the measured
    // interval, and it reads nothing at all.
    devboard::agents_mode::poll_once(&app);
    let watcher = AccessCounter::watch(&state);
    devboard::agents_mode::poll_once(&app);
    let counts = watcher.take();
    let reads_under = |root: &Path| -> u64 {
        counts
            .iter()
            .filter(|(path, _)| path.starts_with(root))
            .map(|(_, count)| *count)
            .sum()
    };
    let five_reads = reads_under(&five);
    let fifty_reads = reads_under(&fifty);
    assert_eq!(
        five_reads, 0,
        "an unchanged five-worker family is not read: {counts:?}"
    );
    assert_eq!(
        fifty_reads, five_reads,
        "history does not change an unchanged interval's reads"
    );

    // A changed family reads exactly the changed file.
    let mut changed = versioned_worker_state(&repo, &state, "1.1.7", 8_007);
    changed["updatedAt"] = json!("2026-11-10T01:00:00.000Z");
    write_json(&changed_path, changed);
    devboard::agents_mode::poll_once(&app);
    let counts = watcher.take();
    assert_eq!(
        counts.get(&changed_path).copied().unwrap_or(0),
        1,
        "the changed record is read once"
    );
    assert_eq!(
        counts
            .iter()
            .filter(|(path, _)| path.starts_with(&five))
            .map(|(_, count)| *count)
            .sum::<u64>(),
        0,
        "the unchanged family stays unread"
    );
}

#[tokio::test]
async fn a_changed_family_reaches_a_client_within_one_second() {
    let root = scratch("freshness");
    let repo = root.join("repo");
    let state = root.join("state");
    let family = state.join("dead-code").join(repo_key(&repo));
    let path = family.join("workers").join("1.0.0").join("state.json");
    write_json(&path, versioned_worker_state(&repo, &state, "1.0.0", 9_001));
    let app = app_at(&root);
    let (_conn, mut inbox) = connection_for(&app).await;
    // The first poll builds the projection; the change is what the measured
    // tick has to notice.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let _ = frames(&mut inbox);

    let mut changed = versioned_worker_state(&repo, &state, "1.0.0", 9_001);
    changed["lifecycle"] = json!("failed");
    write_json(&path, changed);

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        let all = frames(&mut inbox);
        if let Some(agent) = agent(&all, "dead-code") {
            if agent["lifecycle"] == json!("failed") {
                return;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "a changed family reaches the client within one second"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

const NINE_FAMILIES: [&str; 9] = [
    "scout",
    "watchdog",
    "design",
    "dead-code",
    "mcp-optimizer",
    "api-standards",
    "single-responsibility",
    "consistent-naming",
    "release-train",
];

/// A live stand-in whose exit a waiter reaps, so killing it makes the pid
/// observably dead instead of leaving a zombie the kernel still reports.
fn stand_in_reapable() -> u32 {
    let mut child = std::process::Command::new("sleep")
        .arg("60")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("a stand-in worker");
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    pid
}

/// The lock each family's snapshot reads as an attached worker.
fn family_lock_path(root: &Path, family: &str) -> PathBuf {
    let repo = root.join("repo");
    let state = root.join("state");
    match family {
        "watchdog" => repo.join(".devboard/.tmp/watchdog/lock"),
        "mcp-optimizer" => state.join("coach/lock"),
        "release-train" => state.join("release-train/lock"),
        other => repo.join(".devboard/.tmp").join(other).join("lock"),
    }
}

fn write_family_lock(root: &Path, family: &str, pid: u32, version: Option<&str>) {
    let repo = root.join("repo");
    let state = root.join("state");
    let lock = json!({
        "pid": pid,
        "startedAt": devboard::journal::now_iso8601(),
        "repo": repo.to_string_lossy(),
        "stateDir": state.to_string_lossy(),
        "harnessVersion": version,
        "argv": ["devboard", "worker", family],
    });
    if family == "release-train" {
        // Release attachment is a published worker record, not only a lock.
        let directory = state.join("release-train");
        let key = version.unwrap_or("0");
        write_json(&directory.join(format!("lock.{key}")), lock);
        write_json(
            &directory.join("workers").join(key).join("worker.json"),
            release_worker_state(pid, &state),
        );
        return;
    }
    write_json(&family_lock_path(root, family), lock);
}

/// The release family refuses a root that is not a canonical git checkout.
fn git_checkout(repo: &Path) {
    let status = std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(repo)
        .status()
        .expect("git init");
    assert!(status.success());
}

fn kill_recorded(recorded: &Arc<Mutex<Vec<u32>>>) {
    for pid in recorded.lock().expect("stand-ins").iter() {
        kill_stand_in(*pid);
    }
}

struct FamilyHarness {
    app: Arc<App>,
    conn: Conn,
    inbox: UnboundedReceiver<String>,
    pids: Arc<Mutex<Vec<u32>>>,
    spawns: RecordedSpawns,
}

async fn family_harness(
    root: &Path,
    family: &str,
    preflight: devboard::agents_mode::PreflightCallback,
    publishes_lock: bool,
) -> FamilyHarness {
    let app = app_at(root);
    if family == "release-train" {
        git_checkout(&root.join("repo"));
    }
    devboard::agents_mode::set_preflight(&app, family, preflight);
    devboard::agents_mode::set_agent_environment(&app, || Box::pin(async { Ok(HashMap::new()) }));
    let pids: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let spawns: RecordedSpawns = Arc::new(Mutex::new(Vec::new()));
    let pids_for_spawn = Arc::clone(&pids);
    let spawns_for_spawn = Arc::clone(&spawns);
    let root_for_spawn = root.to_path_buf();
    let family_for_spawn = family.to_string();
    let version_for_spawn = app.running_version.clone();
    devboard::agents_mode::set_spawn(&app, move |argv, environment| {
        spawns_for_spawn
            .lock()
            .expect("spawns")
            .push((argv.to_vec(), environment.clone()));
        let pid = stand_in_reapable();
        pids_for_spawn.lock().expect("pids").push(pid);
        if publishes_lock {
            write_family_lock(
                &root_for_spawn,
                &family_for_spawn,
                pid,
                version_for_spawn.as_deref(),
            );
        }
        Some(pid)
    });
    let (conn, inbox) = connection_for(&app).await;
    FamilyHarness {
        app,
        conn,
        inbox,
        pids,
        spawns,
    }
}

async fn start_family(
    harness: &mut FamilyHarness,
    family: &str,
) -> (Vec<Value>, std::time::Duration) {
    let started = std::time::Instant::now();
    devboard::agents_mode::handle(
        &harness.app,
        &harness.conn,
        &Command::StartAgent {
            id: Some(json!(family)),
        },
    )
    .await;
    let elapsed = started.elapsed();
    (frames(&mut harness.inbox), elapsed)
}

/// The newest snapshot a targeted read answers, draining the connection first.
async fn read_agent(harness: &mut FamilyHarness, family: &str) -> Value {
    let _ = frames(&mut harness.inbox);
    devboard::agents_mode::handle(
        &harness.app,
        &harness.conn,
        &Command::GetAgent {
            id: Some(json!(family)),
        },
    )
    .await;
    agent(&frames(&mut harness.inbox), family)
        .cloned()
        .unwrap_or(Value::Null)
}

fn assert_spawned_program(harness: &FamilyHarness, family: &str) {
    let spawns = harness.spawns.lock().expect("spawns");
    assert_eq!(spawns.len(), 1, "{family}: one spawn");
    let argv = &spawns[0].0;
    assert!(
        !argv[0].contains(" (deleted)"),
        "{family}: a deleted executable reached argv: {argv:?}"
    );
    assert!(
        Path::new(&argv[0]).is_file(),
        "{family}: argv[0] is not an existing regular file: {argv:?}"
    );
}

#[tokio::test]
async fn a_slow_preflight_does_not_delay_the_spawn() {
    for family in NINE_FAMILIES {
        let root = scratch(&format!("slow-spawn-{family}"));
        let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let completed_for = Arc::clone(&completed);
        let preflight: devboard::agents_mode::PreflightCallback = Arc::new(move |_request| {
            let completed = Arc::clone(&completed_for);
            Box::pin(async move {
                std::future::pending::<()>().await;
                completed.store(true, Ordering::SeqCst);
                Ok("owner/repository".to_string())
            })
        });
        let mut harness = family_harness(&root, family, preflight, false).await;
        let (all, elapsed) = start_family(&mut harness, family).await;
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "{family}: Start waited for its pending preflight ({elapsed:?})"
        );
        assert_spawned_program(&harness, family);
        let snapshot = agent(&all, family).expect("a family snapshot");
        assert_eq!(snapshot["lifecycle"], "starting", "{family}: {all:?}");
        assert!(
            !completed.load(Ordering::SeqCst),
            "{family}: the preflight completed before Start answered"
        );
        kill_recorded(&harness.pids);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[tokio::test]
async fn every_family_reaches_running_inside_two_seconds() {
    for family in NINE_FAMILIES {
        let root = scratch(&format!("running-{family}"));
        let preflight: devboard::agents_mode::PreflightCallback =
            Arc::new(|_request| Box::pin(async { Ok("owner/repository".to_string()) }));
        let mut harness = family_harness(&root, family, preflight, true).await;
        let started = std::time::Instant::now();
        devboard::agents_mode::handle(
            &harness.app,
            &harness.conn,
            &Command::StartAgent {
                id: Some(json!(family)),
            },
        )
        .await;
        assert_spawned_program(&harness, family);
        let deadline = started + std::time::Duration::from_millis(2_000);
        let snapshot = loop {
            let snapshot = read_agent(&mut harness, family).await;
            let running = snapshot["lifecycle"] == json!("running");
            let workers = snapshot["workers"]
                .as_array()
                .map(|workers| !workers.is_empty())
                .unwrap_or(false);
            if running && workers {
                break snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{family}: never reached running with a worker: {snapshot:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };
        assert_eq!(snapshot["lifecycle"], json!("running"), "{family}");
        kill_recorded(&harness.pids);
        let _ = std::fs::remove_dir_all(&root);
    }
}

fn refused_after_release(
    release: tokio::sync::oneshot::Receiver<()>,
    message: String,
) -> devboard::agents_mode::PreflightCallback {
    let release = Arc::new(Mutex::new(Some(release)));
    Arc::new(move |_request| {
        let release = Arc::clone(&release);
        let message = message.clone();
        Box::pin(async move {
            let receiver = release.lock().expect("release").take();
            if let Some(receiver) = receiver {
                let _ = receiver.await;
            }
            Err(message)
        })
    })
}

async fn wait_for_refusal(harness: &mut FamilyHarness, family: &str, pid: u32) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2_000);
    loop {
        let snapshot = read_agent(harness, family).await;
        let refused = snapshot["error"].as_str().is_some() || snapshot["notice"].as_str().is_some();
        let workers = snapshot["workers"].as_array().cloned().unwrap_or_default();
        if refused && pid_dead(pid) && workers.is_empty() {
            return snapshot;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{family}: the refusal never landed with a dead worker: {snapshot:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

fn pid_dead(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) != 0 }
}

#[tokio::test]
async fn a_failed_preflight_stops_the_spawned_worker() {
    let fault = "missing prerequisite: the Gitea token cannot write to acme/fixture on \
                 http://forge.test";
    for family in NINE_FAMILIES {
        let root = scratch(&format!("refused-{family}"));
        let (release, held) = tokio::sync::oneshot::channel();
        let preflight = refused_after_release(held, fault.to_string());
        let mut harness = family_harness(&root, family, preflight, true).await;
        let (all, _) = start_family(&mut harness, family).await;
        assert!(find(&all, "error").is_empty(), "{family}: {all:?}");
        assert_spawned_program(&harness, family);
        let pid = *harness.pids.lock().expect("pids").first().expect("a pid");
        release.send(()).expect("release the preflight");
        let snapshot = wait_for_refusal(&mut harness, family, pid).await;
        assert_eq!(snapshot["error"], json!(fault), "{family}: {snapshot:?}");
        assert_eq!(snapshot["notice"], Value::Null, "{family}: {snapshot:?}");
        kill_recorded(&harness.pids);
        let _ = std::fs::remove_dir_all(&root);
    }

    // A latency refusal stays on the card and is never answered as a generic
    // error frame.
    let root = scratch("refused-latency");
    let latency = "the Gitea repository acme/fixture could not be read before Start's deadline: \
                   GET /repos/acme/fixture failed: the request timed out after 19745 ms; \
                   press Start to retry.";
    let (release, held) = tokio::sync::oneshot::channel();
    let preflight = refused_after_release(held, latency.to_string());
    let mut harness = family_harness(&root, "scout", preflight, true).await;
    let (all, _) = start_family(&mut harness, "scout").await;
    assert!(find(&all, "error").is_empty(), "{all:?}");
    let pid = *harness.pids.lock().expect("pids").first().expect("a pid");
    release.send(()).expect("release the preflight");
    let snapshot = wait_for_refusal(&mut harness, "scout", pid).await;
    assert_eq!(snapshot["notice"], json!(latency), "{snapshot:?}");
    assert_eq!(snapshot["error"], Value::Null, "{snapshot:?}");
    kill_recorded(&harness.pids);
    let _ = std::fs::remove_dir_all(&root);
}

/// Polls targeted reads until the family publishes a snapshot the caller
/// accepts, returning it with every frame observed while waiting.
async fn wait_for_snapshot(
    app: &Arc<App>,
    conn: &Conn,
    inbox: &mut UnboundedReceiver<String>,
    id: &str,
    mut ready: impl FnMut(&Value) -> bool,
) -> (Value, Vec<Value>) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2_000);
    let mut collected: Vec<Value> = Vec::new();
    loop {
        devboard::agents_mode::handle(
            app,
            conn,
            &Command::GetAgent {
                id: Some(json!(id)),
            },
        )
        .await;
        collected.extend(frames(inbox));
        if let Some(snapshot) = collected
            .iter()
            .filter_map(|frame| frame.get("agent"))
            .filter(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
            .next_back()
        {
            if ready(snapshot) {
                return (snapshot.clone(), collected);
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{id}: no matching snapshot within two seconds"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// A page can ask twice inside the coalescing interval: the second command must
/// answer the same projection without starting a second worker refresh, and a
/// request past the interval starts the next one.
#[tokio::test]
async fn a_repeated_page_open_refresh_is_coalesced_for_the_family() {
    use std::time::Duration;

    let root = scratch("refresh-coalescing");
    let app = app_at(&root);
    let repo = root.join("repo");
    let state = root.join("state");
    let child = std::process::Command::new("sleep")
        .arg("60")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("a stand-in worker");
    let pid = child.id();
    std::mem::forget(child);
    let lock = devboard::workers::single_responsibility::lock_path(&repo);
    write_json(
        &lock,
        json!({
            "pid": pid,
            "startedAt": devboard::journal::now_iso8601(),
            "repo": repo.to_string_lossy(),
            "stateDir": state.to_string_lossy(),
            "harnessVersion": null,
            "argv": ["devboard", "worker", "single-responsibility"],
        }),
    );
    let control = devboard::workers::single_responsibility::control_directory(&state, &repo);
    let control_commands = || -> Vec<Value> {
        std::fs::read_dir(&control)
            .expect("a control directory")
            .filter_map(Result::ok)
            .map(|entry| std::fs::read_to_string(entry.path()).expect("a command"))
            .map(|text| serde_json::from_str::<Value>(&text).expect("JSON"))
            .collect()
    };
    let (conn, mut inbox) = connection_for(&app).await;

    let first = Command::RefreshAgent {
        id: Some(json!("single-responsibility")),
    };
    devboard::agents_mode::handle(&app, &conn, &first).await;
    let answered = frames(&mut inbox);
    let opened = agent(&answered, "single-responsibility")
        .expect("the first refresh answers a snapshot")
        .clone();
    assert_eq!(control_commands(), vec![json!({"type": "refresh"})]);

    // One millisecond later, inside the interval: the answer repeats and no
    // worker refresh command is written.
    tokio::time::sleep(Duration::from_millis(1)).await;
    devboard::agents_mode::handle(&app, &conn, &first).await;
    let repeated = frames(&mut inbox);
    assert_eq!(
        agent(&repeated, "single-responsibility"),
        Some(&opened),
        "a coalesced refresh answers the same agentState frame"
    );
    assert!(find(&repeated, "error").is_empty(), "{repeated:?}");
    assert_eq!(control_commands(), vec![json!({"type": "refresh"})]);

    // Past the interval, the next page open starts the next refresh.
    tokio::time::sleep(Duration::from_millis(5_001)).await;
    devboard::agents_mode::handle(&app, &conn, &first).await;
    let next = frames(&mut inbox);
    assert!(agent(&next, "single-responsibility").is_some());
    assert_eq!(
        control_commands(),
        vec![json!({"type": "refresh"}), json!({"type": "refresh"})]
    );
    kill_stand_in(pid);
}
