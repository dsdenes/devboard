//! The background-agent registry, prompt pages, settings writes, and the
//! start/stop dispositions of the detached-worker dashboards.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use devboard::agents_mode::{ForgeFact, ForgeProjection, ForgeReader};
use devboard::app::{App, Conn};
use devboard::config::Config;
use devboard::journal::Journal;
use devboard::protocol::Command;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

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
    devboard::journal::journal_key(repo)
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
    assert_eq!(scout["lifecycle"], "stopped");
    assert_eq!(scout["paused"], false);
    assert_eq!(scout["cadence"]["minutes"], 1);
    assert_eq!(scout["cadence"]["defaultMinutes"], 1);
    assert_eq!(scout["limits"]["maxPerHour"], 10);
    assert_eq!(scout["limits"]["maxPending"], 5);
    assert_eq!(scout["detail"]["panel"], "activity");
    assert!(scout["issues"].as_array().expect("issues").is_empty());
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
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let all = frames(&mut inbox);
    let errors = find(&all, "error");
    let error = errors.first().expect("a refusal");
    assert_eq!(
        error["message"],
        "the start preflight did not finish within 20 ms; press Start to retry."
    );
    let scout = agent(&all, "scout").expect("a scout snapshot");
    assert_ne!(scout["lifecycle"], "starting");
}

#[tokio::test]
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
