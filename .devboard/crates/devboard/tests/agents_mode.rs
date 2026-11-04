//! The background-agent registry, prompt pages, settings writes, and the
//! start/stop dispositions of the detached-worker dashboards.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
        addr_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: None,
        agent_command: "omp acp".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        token: "test-token".to_string(),
        bootstrap: "test-bootstrap".to_string(),
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
    let path = repo.join(".devboard/.tmp/dead-code/lock");
    write_json(
        &path,
        json!({
            "pid": pid,
            "startedAt": devboard::journal::now_iso8601(),
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

    let release = &agents[7];
    assert_eq!(release["cadence"]["minutes"], 10);
    assert_eq!(release["detail"]["scanId"], "idle:0");

    let prompts = find(&all, "agentPromptState");
    assert_eq!(prompts.len(), 8);
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
