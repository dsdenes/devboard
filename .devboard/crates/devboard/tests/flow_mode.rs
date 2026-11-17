//! Flow Mode's behavior, driven by the deterministic stub agent and the
//! injected stub forge: one goal interview, one implementation run, the
//! reviewable widgets, the steering feed, a read-only widget conversation, and
//! every refusal path's exact message.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::flow_mode::{CommandFlowForge, FlowForge, ForgePrInput, ForgeTarget};
use devboard::forge::{
    Exec, ExecOptions, ExecResult, HttpError, HttpFuture, HttpRequest, Transport,
    GITLAB_DRAFT_PREFIX,
};
use devboard::journal::Journal;
use serde_json::{json, Value};
use tokio::sync::mpsc;

fn devboard_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the devboard harness directory exists")
}

/// A test directory under `.devboard/.test-tmp`, removed when the test ends.
struct Scratch {
    path: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after the epoch")
            .as_nanos();
        let path = devboard_root()
            .join(".test-tmp")
            .join(format!("flow-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("a scratch root");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = StdCommand::new("git")
        .args([
            "-c",
            "user.name=Flow Fixture",
            "-c",
            "user.email=fixture@example.test",
            "-c",
            "commit.gpgsign=false",
        ])
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// One connected client: the frames the server sent it, in order.
struct Client {
    conn: Conn,
    frames: mpsc::UnboundedReceiver<String>,
    seen: Vec<Value>,
}

impl Client {
    async fn connect(app: &Arc<App>) -> Self {
        let (outbox, frames) = mpsc::unbounded_channel();
        let conn = Conn::new(outbox);
        app.register(conn.clone()).await;
        Self {
            conn,
            frames,
            seen: Vec::new(),
        }
    }

    fn drain(&mut self) {
        while let Ok(text) = self.frames.try_recv() {
            self.seen
                .push(serde_json::from_str(&text).expect("a JSON frame"));
        }
    }

    /// Waits for a frame matching `predicate`, scanning what already arrived.
    ///
    /// A frame follows an owner's turn, a stub answer, or a watcher tick, and a
    /// host running several suites at once starves every one of them; the
    /// budget bounds a stall above the slowest stage, never a deadline the
    /// product proves.
    async fn wait_for(&mut self, label: &str, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            self.drain();
            if let Some(found) = self.seen.iter().find(|frame| predicate(frame)) {
                return found.clone();
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let types: Vec<&str> = self
                    .seen
                    .iter()
                    .filter_map(|frame| frame.get("type").and_then(Value::as_str))
                    .collect();
                panic!("timed out waiting for {label}; saw {types:?}");
            }
            match tokio::time::timeout(remaining, self.frames.recv()).await {
                Ok(Some(text)) => self
                    .seen
                    .push(serde_json::from_str(&text).expect("a JSON frame")),
                Ok(None) => panic!("the client closed while waiting for {label}"),
                Err(_) => {
                    let types: Vec<&str> = self
                        .seen
                        .iter()
                        .filter_map(|frame| frame.get("type").and_then(Value::as_str))
                        .collect();
                    panic!("timed out waiting for {label}; saw {types:?}");
                }
            }
        }
    }
}

fn session_frames<'a>(frames: &'a [Value], kind: &str) -> Vec<&'a Value> {
    frames
        .iter()
        .filter(|frame| frame.get("type").and_then(Value::as_str) == Some(kind))
        .collect()
}

fn stub_agent_command(scratch: &Scratch) -> String {
    let log = scratch.path().join("agent.log");
    format!(
        "{} acp-stub --flow-goal --flow-implement --flow-change --flow-widget --log={}",
        env!("CARGO_BIN_EXE_devboard"),
        log.display()
    )
}

fn write_credentials(state_dir: &Path) {
    let directory = state_dir.join("providers");
    std::fs::create_dir_all(&directory).expect("a providers directory");
    let document = json!({
        "version": 1,
        "subscriptions": [{
            "id": "sub-fixture",
            "provider": "opencode-go",
            "label": "Fixture key",
            "key": "fixture-secret",
            "enabled": true,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        }],
    });
    std::fs::write(
        directory.join("credentials.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&document).expect("JSON")
        ),
    )
    .expect("credentials");
}

struct Fixture {
    app: Arc<App>,
    repo: PathBuf,
    state: PathBuf,
    forge_log: PathBuf,
    _scratch: Scratch,
}

fn fixture(label: &str) -> Fixture {
    fixture_with(label, |_, _| {})
}

/// Builds a fixture after `seed` writes the repository and state roots, so the
/// restore reads exactly what a stopped dashboard left behind.
fn fixture_with(label: &str, seed: impl FnOnce(&Path, &Path)) -> Fixture {
    let scratch = Scratch::new(label);
    let repo = scratch.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).expect("a repository");
    git(&repo, &["init", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "fixture\n").expect("a base file");
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-m", "fixture base"]);
    let origin = scratch.path().join("origin.git");
    let status = StdCommand::new("git")
        .args(["init", "--bare"])
        .arg(&origin)
        .output()
        .expect("git init --bare");
    assert!(status.status.success(), "the bare origin exists");
    git(
        &repo,
        &["remote", "add", "origin", origin.to_str().expect("a path")],
    );
    git(&repo, &["push", "-u", "origin", "main"]);

    let state = scratch.path().join("state");
    std::fs::create_dir_all(state.join("repo/adrs")).expect("a state root");
    write_credentials(&state);
    seed(&repo, &state);

    let forge_log = scratch.path().join("forge.log");
    // The recorded corpus enables the deterministic forge with the same
    // environment; the usage endpoints are pinned to a closed port so no peer
    // selection reaches the network.
    std::env::set_var("DEVBOARD_FLOW_FORGE", "stub");
    std::env::set_var("DEVBOARD_FLOW_FORGE_LOG", &forge_log);
    std::env::set_var("DEVBOARD_FLOW_WATCH_MS", "100");
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:9");
    std::env::set_var("DEVBOARD_OPENROUTER_USAGE_BASE_URL", "http://127.0.0.1:9");

    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: stub_agent_command(&scratch),
        state_dir: state.clone(),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);
    Fixture {
        app,
        repo,
        state,
        forge_log,
        _scratch: scratch,
    }
}

async fn send(app: &Arc<App>, conn: &Conn, command: Command) {
    app.command(conn, command).await;
}

/// The fixture writes process-wide environment variables, so its tests run one
/// at a time.
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn session_directory(fixture: &Fixture, session_id: &str) -> PathBuf {
    fixture
        .state
        .join("flow")
        .join(devboard::journal::repo_key(&fixture.repo))
        .join(session_id)
}

/// A record whose commit is longer than seven characters — the flow prompt asks
/// for at least seven — names the same checkpoint the live tick already wrote,
/// so a restart adds no second entry and the client's keyed list stays unique.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_recorded_commit_longer_than_seven_characters_restores_one_checkpoint() {
    let _env = ENV_LOCK.lock().await;
    const SESSION: &str = "seeded-checkpoints";
    let mut recorded = None;
    let fixture = fixture_with("long-commit-checkpoint", |repo, state| {
        let base = git(repo, &["rev-parse", "HEAD"]).trim().to_string();
        std::fs::write(repo.join("src/recorded.txt"), "one\n").expect("a change");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "feat: the recorded unit"]);
        let hash = git(repo, &["rev-parse", "HEAD"]).trim().to_string();
        let short: String = hash.chars().take(7).collect();
        let long: String = hash.chars().take(8).collect();
        let directory = state
            .join("flow")
            .join(devboard::journal::repo_key(repo))
            .join(SESSION);
        std::fs::create_dir_all(&directory).expect("a Flow session directory");
        let stamp = "2026-01-01T00:00:00.000Z";
        // The live tick wrote the seven-character entry the view keys by; the
        // agent's own record beside it names eight characters.
        let session = json!({
            "id": SESSION,
            "version": 1,
            "worktree": repo.to_string_lossy(),
            "branch": "main",
            "status": "stopped",
            "goal": "The stored goal",
            "baseRevision": base,
            "checkpoints": [{
                "id": format!("checkpoint-{short}"),
                "timestamp": stamp,
                "summary": "feat: the recorded unit",
                "files": 1,
                "commit": short,
                "verification": "passed",
            }],
        });
        std::fs::write(directory.join("session.json"), session.to_string()).expect("session.json");
        let record = json!({
            "id": format!("checkpoint-{short}"),
            "timestamp": stamp,
            "summary": "the agent's own record",
            "files": 1,
            "commit": long,
            "verification": "passed",
        });
        std::fs::write(directory.join("checkpoints.jsonl"), format!("{record}\n"))
            .expect("checkpoints.jsonl");
        recorded = Some(short);
    });
    let short = recorded.expect("the seeded commit");
    let app = fixture.app.clone();
    let mut client = Client::connect(&app).await;
    send(&app, &client.conn, Command::GetFlow).await;
    let restored = client
        .wait_for("the restored checkpoints", |frame| {
            frame["type"] == "flowCheckpoints"
                && frame["checkpoints"]
                    .as_array()
                    .is_some_and(|checkpoints| !checkpoints.is_empty())
        })
        .await;
    let checkpoints = restored["checkpoints"].as_array().expect("checkpoints");
    assert_eq!(checkpoints.len(), 1, "{checkpoints:?}");
    assert_eq!(checkpoints[0]["commit"], short.as_str());
    assert_eq!(checkpoints[0]["id"], format!("checkpoint-{short}").as_str());

    // Ticks run every 100 ms: the commit the restored entry already names adds
    // no second checkpoint and changes no id.
    tokio::time::sleep(Duration::from_millis(500)).await;
    client.seen.clear();
    send(&app, &client.conn, Command::GetFlow).await;
    let after = client
        .wait_for("the checkpoints after a tick", |frame| {
            frame["type"] == "flowCheckpoints"
        })
        .await;
    let checkpoints = after["checkpoints"].as_array().expect("checkpoints");
    assert_eq!(checkpoints.len(), 1, "{checkpoints:?}");
    let ids: Vec<&str> = checkpoints
        .iter()
        .filter_map(|checkpoint| checkpoint["id"].as_str())
        .collect();
    assert_eq!(ids.len(), checkpoints.len(), "every checkpoint names an id");
    let mut unique = ids.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), ids.len(), "checkpoint ids are unique");
}

/// The answer one widget acceptance request receives at the REST surface.
async fn patch_widget(app: &Arc<App>, id: &str, body: &str) -> (u16, Value) {
    let request = axum::http::Request::builder()
        .method("PATCH")
        .uri(format!("/flows/widgets/{id}"))
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .expect("a widget acceptance request");
    let response = devboard::rest::handle(app, request)
        .await
        .expect("the widget acceptance route");
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("the response body");
    let problem = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, problem)
}

/// The session's accepted widget signatures, in acceptance order.
fn accepted_signatures(directory: &Path) -> Vec<String> {
    let document: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("accepted.json")).expect("accepted.json"),
    )
    .expect("accepted JSON");
    document["signatures"]
        .as_array()
        .expect("signatures")
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

/// The forge operations the stub recorded, in call order.
fn forge_operations(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).expect("a forge call"))
        .filter_map(|call| call["op"].as_str().map(str::to_string))
        .collect()
}

/// Installs a pre-receive hook in the bare origin that refuses every push
/// with `detail`, so the next checkpoint stays local.
fn refuse_pushes(origin: &Path, detail: &str) {
    use std::os::unix::fs::PermissionsExt as _;
    let hook = origin.join("hooks/pre-receive");
    std::fs::write(&hook, format!("#!/bin/sh\necho {detail} >&2\nexit 1\n"))
        .expect("a pre-receive hook");
    let mut permissions = std::fs::metadata(&hook)
        .expect("the hook's metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&hook, permissions).expect("an executable hook");
}

/// The commit the remote branch names, or `None` when it does not exist.
fn remote_tip(origin: &Path, branch: &str) -> Option<String> {
    let output = StdCommand::new("git")
        .arg("-C")
        .arg(origin)
        .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
        .output()
        .expect("git runs");
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn flow_goal_widgets_steering_and_conversation_round_trip() {
    let _env = ENV_LOCK.lock().await;
    let fixture = fixture("round-trip");
    let app = fixture.app.clone();
    let mut client = Client::connect(&app).await;

    // --- the goal interview
    send(&app, &client.conn, Command::CreateFlowGoal).await;
    let started = client
        .wait_for("flowGoalStarted", |frame| {
            frame["type"] == "flowGoalStarted"
        })
        .await;
    assert_eq!(started["type"], "flowGoalStarted");
    let snapshot = client
        .wait_for("a new session's snapshot", |frame| {
            frame["type"] == "flowSnapshot" && frame["sessionId"].is_string()
        })
        .await;
    let session_id = snapshot["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string();
    assert_eq!(snapshot["status"], "idle");
    assert_eq!(snapshot["branch"], format!("flow/{session_id}"));
    assert!(snapshot["goalCreation"].is_object());

    // The interview asks the developer before it writes the goal.
    let goal_question = client
        .wait_for("the goal question", |frame| {
            frame["type"] == "flowQuestion" && frame["target"] == "goal"
        })
        .await;
    assert_eq!(goal_question["message"], "Choose an answer");
    send(
        &app,
        &client.conn,
        Command::FlowAnswer {
            id: Some(goal_question["id"].clone()),
            value: Some(json!("Alpha")),
            target: Some(json!("goal")),
        },
    )
    .await;

    let goal_stopped = client
        .wait_for("flowGoalStopped", |frame| {
            frame["type"] == "flowGoalStopped"
        })
        .await;
    assert_eq!(goal_stopped["completed"], true);
    assert!(goal_stopped["text"]
        .as_str()
        .expect("goal text")
        .starts_with("# Flow goal"));
    let directory = session_directory(&fixture, &session_id);
    assert_eq!(
        std::fs::read_to_string(directory.join("goal.md")).expect("goal.md"),
        goal_stopped["text"].as_str().expect("goal text")
    );

    // --- the implementation turn
    send(&app, &client.conn, Command::StartFlowImplementation).await;
    let implementation = client
        .wait_for("flowImplementationStarted", |frame| {
            frame["type"] == "flowImplementationStarted"
        })
        .await;
    assert_eq!(implementation["sessionId"], session_id);
    assert_eq!(implementation["branch"], format!("flow/{session_id}"));

    let stopped = client
        .wait_for("flowStopped", |frame| frame["type"] == "flowStopped")
        .await;
    assert_eq!(stopped["type"], "flowStopped");

    let widgets_frame = client
        .wait_for("two classified widgets", |frame| {
            // Every diff tick publishes a widget list before the analyst has
            // classified the files, and those transient lists name the files
            // as structure changes. Wait for the reconciled pair instead of
            // counting whatever the first frame carried.
            frame["type"] == "flowWidgets"
                && frame["widgets"].as_array().is_some_and(|widgets| {
                    widgets.len() >= 2
                        && widgets[0]["category"] == "contract"
                        && widgets[1]["category"] == "data"
                })
        })
        .await;
    let widgets = widgets_frame["widgets"]
        .as_array()
        .expect("widgets")
        .clone();
    let first = widgets[0].clone();
    let second = widgets[1].clone();
    let first_id = first["id"].as_str().expect("a widget id").to_string();
    let second_id = second["id"].as_str().expect("a widget id").to_string();
    assert_eq!(first["category"], "contract");
    assert_eq!(second["category"], "data");
    assert_eq!(first["accepted"], false);

    // The checkpoint and verification the stub recorded reach the view.
    client
        .wait_for("a checkpoint", |frame| {
            frame["type"] == "flowCheckpoints"
                && frame["checkpoints"]
                    .as_array()
                    .is_some_and(|checkpoints| !checkpoints.is_empty())
        })
        .await;
    client
        .wait_for("a verification", |frame| {
            frame["type"] == "flowVerification" && frame["verification"]["status"] == "passed"
        })
        .await;
    // The pushed tip becomes a draft pull request through the injected forge.
    let draft = client
        .wait_for("a draft pull request", |frame| {
            frame["type"] == "flowPr" && frame["pr"]["state"] == "draft"
        })
        .await;
    assert_eq!(draft["pr"]["number"], json!(7));

    // --- widget acceptance is a required boolean at the REST surface
    assert_eq!(
        accepted_signatures(&directory),
        Vec::<String>::new(),
        "a widget list starts with nothing accepted"
    );
    for body in [
        "{}",
        r#"{"accepted": "false"}"#,
        r#"{"accepted": 0}"#,
        r#"{"accepted": null}"#,
    ] {
        let (status, problem) = patch_widget(&app, &first_id, body).await;
        assert_eq!(status, 400, "PATCH {body} is refused");
        assert!(
            problem["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("accepted")),
            "the refusal names the field: {problem}"
        );
        assert_eq!(
            accepted_signatures(&directory),
            Vec::<String>::new(),
            "PATCH {body} accepts nothing"
        );
    }
    let (status, _) = patch_widget(&app, &first_id, r#"{"accepted": true}"#).await;
    assert_eq!(status, 200);
    let accepted = client
        .wait_for("an accepted widget", |frame| {
            frame["type"] == "flowWidgets"
                && frame["widgets"].as_array().is_some_and(|widgets| {
                    widgets.iter().any(|widget| {
                        widget["id"] == first_id.as_str() && widget["accepted"] == true
                    })
                })
        })
        .await;
    assert_eq!(accepted["type"], "flowWidgets");
    assert_eq!(
        accepted_signatures(&directory),
        vec![first_id.clone()],
        "an accepted decision adds the widget signature"
    );
    let (status, _) = patch_widget(&app, &first_id, r#"{"accepted": false}"#).await;
    assert_eq!(status, 200);
    assert_eq!(
        accepted_signatures(&directory),
        Vec::<String>::new(),
        "a refused decision removes the widget signature"
    );
    let (status, _) = patch_widget(&app, &first_id, r#"{"accepted": true}"#).await;
    assert_eq!(status, 200);
    assert_eq!(
        accepted_signatures(&directory),
        vec![first_id.clone()],
        "the accepted widget stays accepted for the rest of the session"
    );

    // --- widget refusal becomes a steering note with the exact sentence
    send(
        &app,
        &client.conn,
        Command::RefuseFlowWidget {
            id: Some(json!(second_id)),
            reason: Some(json!("the stored shape is wrong")),
        },
    )
    .await;
    let refused = client
        .wait_for("the refusal steering note", |frame| {
            frame["type"] == "flowSteering"
                && frame["notes"].as_array().is_some_and(|notes| {
                    notes
                        .iter()
                        .any(|note| note["source"] == format!("widget:{second_id}").as_str())
                })
        })
        .await;
    let note = refused["notes"]
        .as_array()
        .expect("notes")
        .iter()
        .find(|note| note["source"] == format!("widget:{second_id}").as_str())
        .expect("the refusal note");
    assert_eq!(
        note["text"],
        format!(
            "Refuse widget {second_id}: the stored shape is wrong Abandon this change and implement another solution."
        )
    );
    assert_eq!(note["status"], "new");

    // --- developer steering
    send(
        &app,
        &client.conn,
        Command::SendFlowSteering {
            text: Some(json!("Prefer the smaller shape")),
        },
    )
    .await;
    client
        .wait_for("the developer steering note", |frame| {
            frame["type"] == "flowSteering"
                && frame["notes"].as_array().is_some_and(|notes| {
                    notes.iter().any(|note| {
                        note["source"] == "developer" && note["text"] == "Prefer the smaller shape"
                    })
                })
        })
        .await;

    // --- the read-only widget conversation
    send(
        &app,
        &client.conn,
        Command::OpenFlowWidget {
            id: Some(json!(first_id)),
        },
    )
    .await;
    let conversation = client
        .wait_for("flowConversationStarted", |frame| {
            frame["type"] == "flowConversationStarted"
        })
        .await;
    assert_eq!(conversation["widgetId"], first_id.as_str());
    let question = client
        .wait_for("a conversation question", |frame| {
            frame["type"] == "flowConversationQuestion"
        })
        .await;
    assert_eq!(question["message"], "Choose an answer");
    let question_id = question["id"].clone();
    send(
        &app,
        &client.conn,
        Command::FlowAnswer {
            id: Some(question_id),
            value: Some(json!("Alpha")),
            target: Some(json!("conversation")),
        },
    )
    .await;
    client
        .wait_for("the answered conversation turn", |frame| {
            frame["type"] == "flowConversationActivity" && frame["text"] == "Answer received: Alpha"
        })
        .await;

    send(
        &app,
        &client.conn,
        Command::SendFlowConversation {
            text: Some(json!("Which caller observes this?")),
        },
    )
    .await;
    client
        .wait_for("the developer message frame", |frame| {
            frame["type"] == "flowConversationMessage"
                && frame["role"] == "developer"
                && frame["text"] == "Which caller observes this?"
        })
        .await;
    client
        .wait_for("the conversation's answer", |frame| {
            frame["type"] == "flowConversationActivity"
                && frame["text"] == "Developer: Which caller observes this?"
        })
        .await;

    send(
        &app,
        &client.conn,
        Command::SendFlowConclusion {
            text: Some(json!("The caller contract is the observable one.")),
        },
    )
    .await;
    let decisions = client
        .wait_for("the decision board section", |frame| {
            frame["type"] == "flowDecisions"
                && frame["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Widget conversation"))
        })
        .await;
    assert!(decisions["text"]
        .as_str()
        .expect("decisions text")
        .contains("The caller contract is the observable one."));
    let conclusion = client
        .wait_for("the conclusion steering note", |frame| {
            frame["type"] == "flowSteering"
                && frame["notes"].as_array().is_some_and(|notes| {
                    notes
                        .iter()
                        .any(|note| note["source"] == format!("widget-chat:{first_id}").as_str())
                })
        })
        .await;
    let note = conclusion["notes"]
        .as_array()
        .expect("notes")
        .iter()
        .find(|note| note["source"] == format!("widget-chat:{first_id}").as_str())
        .expect("the conclusion note");
    assert_eq!(
        note["text"],
        format!(
            "Conclusion for widget {first_id} ({}): The caller contract is the observable one.",
            first["concept"].as_str().expect("a concept")
        )
    );

    send(&app, &client.conn, Command::CloseFlowWidget).await;
    let closed = client
        .wait_for("flowConversationStopped", |frame| {
            frame["type"] == "flowConversationStopped"
        })
        .await;
    assert_eq!(closed["widgetId"], first_id.as_str());

    // --- marking the draft ready drives the injected forge
    send(&app, &client.conn, Command::MarkFlowPrReady).await;
    let live = client
        .wait_for("a live pull request", |frame| {
            frame["type"] == "flowPr" && frame["pr"]["state"] == "live"
        })
        .await;
    assert_eq!(live["pr"]["url"], "https://forge.test/acme/fixture/pull/7");

    // --- durable files
    let session_file =
        std::fs::read_to_string(directory.join("session.json")).expect("session.json");
    let session: Value = serde_json::from_str(&session_file).expect("session JSON");
    assert_eq!(session["version"], 1);
    assert_eq!(session["id"], session_id.as_str());
    assert_eq!(session["status"], "stopped");
    assert_eq!(session["pr"]["state"], "live");
    assert_eq!(session["pr"]["number"], json!(7));
    assert!(session["accepted"]
        .as_array()
        .expect("accepted")
        .iter()
        .any(|value| value == first_id.as_str()));
    let steering_sources: Vec<String> = session["steering"]
        .as_array()
        .expect("steering")
        .iter()
        .filter_map(|note| note["source"].as_str().map(str::to_string))
        .collect();
    assert!(steering_sources.contains(&"developer".to_string()));
    assert!(steering_sources.contains(&format!("widget:{second_id}")));
    assert!(steering_sources.contains(&format!("widget-chat:{first_id}")));

    let accepted_file: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("accepted.json")).expect("accepted.json"),
    )
    .expect("accepted JSON");
    assert!(accepted_file["signatures"]
        .as_array()
        .expect("signatures")
        .iter()
        .any(|value| value == first_id.as_str()));

    let changes: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("changes.json")).expect("changes.json"),
    )
    .expect("changes JSON");
    let changed_paths: Vec<&str> = changes
        .as_array()
        .expect("changes")
        .iter()
        .filter_map(|file| file["path"].as_str())
        .collect();
    assert!(changed_paths.contains(&"src/app.txt"));
    assert!(changed_paths.contains(&"src/config.json"));

    // The widget registration and the frame that announces it are two writes
    // from two processes: a loaded host lands the durable document after the
    // frame, and a reader that opened it mid-write sees an empty file. Wait for
    // the document the round trip asserted instead of sampling it once.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let widgets_file: Value = loop {
        let raw = std::fs::read_to_string(directory.join("widgets.json")).unwrap_or_default();
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if value["widgets"]
                .as_array()
                .is_some_and(|widgets| widgets.len() == 2)
            {
                break value;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "widgets.json holds the two registered widgets"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert_eq!(
        widgets_file["widgets"].as_array().expect("widgets").len(),
        2
    );

    let decisions_file =
        std::fs::read_to_string(directory.join("decisions.md")).expect("decisions.md");
    assert!(decisions_file.contains("The caller contract is the observable one."));

    let steering_lines: Vec<Value> = std::fs::read_to_string(directory.join("steering.jsonl"))
        .expect("steering.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("a steering line"))
        .collect();
    assert_eq!(steering_lines.len(), 3);
    assert_eq!(
        steering_lines.last().expect("the conclusion")["source"],
        format!("widget-chat:{first_id}").as_str()
    );

    let verification: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("verification.json")).expect("verification.json"),
    )
    .expect("verification JSON");
    assert_eq!(verification["status"], "passed");
    assert_eq!(verification["command"], "bun test");

    let checkpoints: Vec<Value> = std::fs::read_to_string(directory.join("checkpoints.jsonl"))
        .expect("checkpoints.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("a checkpoint line"))
        .collect();
    assert_eq!(checkpoints.len(), 1);

    let forge_calls: Vec<Value> = std::fs::read_to_string(&fixture.forge_log)
        .expect("the forge log")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("a forge call"))
        .collect();
    let operations: Vec<&str> = forge_calls
        .iter()
        .filter_map(|call| call["op"].as_str())
        .collect();
    assert!(operations.contains(&"createDraft"));
    assert!(operations.contains(&"markReady"));
    let created = forge_calls
        .iter()
        .find(|call| call["op"] == "createDraft")
        .expect("a createDraft call");
    assert_eq!(
        created["input"]["head"],
        format!("flow/{session_id}").as_str()
    );
    assert_eq!(created["input"]["base"], "main");
    assert_eq!(created["input"]["title"], "Flow goal");

    // --- refusal paths, each with its exact sentence
    send(
        &app,
        &client.conn,
        Command::AcceptFlowWidget {
            id: Some(json!("missing")),
            accepted: Some(json!(true)),
        },
    )
    .await;
    client
        .wait_for("the stale widget refusal", |frame| {
            frame["type"] == "flowError"
                && frame["message"] == "That Flow widget is no longer current."
        })
        .await;

    send(
        &app,
        &client.conn,
        Command::RefuseFlowWidget {
            id: None,
            reason: Some(json!("no id")),
        },
    )
    .await;
    client
        .wait_for("the missing widget id refusal", |frame| {
            frame["type"] == "flowError"
                && frame["message"] == "That Flow widget is no longer current."
        })
        .await;

    send(
        &app,
        &client.conn,
        Command::SendFlowSteering {
            text: Some(json!("  ")),
        },
    )
    .await;
    client
        .wait_for("the empty steering refusal", |frame| {
            frame["type"] == "flowError"
                && frame["message"] == "A steering note needs non-empty text."
        })
        .await;

    send(&app, &client.conn, Command::CloseFlowWidget).await;
    client
        .wait_for("the closed conversation refusal", |frame| {
            frame["type"] == "flowError" && frame["message"] == "No widget conversation is open."
        })
        .await;

    send(
        &app,
        &client.conn,
        Command::SendFlowConversation {
            text: Some(json!("still there?")),
        },
    )
    .await;
    client
        .wait_for("the missing conversation refusal", |frame| {
            frame["type"] == "flowError" && frame["message"] == "No widget conversation is open."
        })
        .await;

    send(
        &app,
        &client.conn,
        Command::FlowAnswer {
            id: Some(json!(1)),
            value: Some(json!("yes")),
            target: Some(json!("conversation")),
        },
    )
    .await;
    client
        .wait_for("the missing conversation question refusal", |frame| {
            frame["type"] == "flowError"
                && frame["message"] == "No pending conversation question with that id."
        })
        .await;

    send(
        &app,
        &client.conn,
        Command::DismissFlowBlocker {
            id: Some(json!("blocker-missing")),
        },
    )
    .await;
    client
        .wait_for("the missing blocker refusal", |frame| {
            frame["type"] == "flowError" && frame["message"] == "That Flow blocker does not exist."
        })
        .await;

    send(&app, &client.conn, Command::RetryFlowPr).await;
    client
        .wait_for("the retry refusal", |frame| {
            frame["type"] == "flowError"
                && frame["message"] == "There is no failed pull request to retry."
        })
        .await;

    send(&app, &client.conn, Command::StopFlowImplementation).await;
    client
        .wait_for("the stopped implementation refusal", |frame| {
            frame["type"] == "flowError"
                && frame["message"] == "The Flow implementation is not running."
        })
        .await;

    // --- a reconnect replays the session before its own replies
    let mut reconnect = Client::connect(&app).await;
    devboard::flow_mode::replay(&app, &reconnect.conn);
    reconnect.drain();
    assert_eq!(reconnect.seen[0]["type"], "flowSnapshot");
    assert_eq!(reconnect.seen[0]["sessionId"], session_id.as_str());
    assert_eq!(reconnect.seen[0]["status"], "stopped");
    let replay_types: Vec<&str> = reconnect
        .seen
        .iter()
        .filter_map(|frame| frame.get("type").and_then(Value::as_str))
        .collect();
    assert_eq!(replay_types[0], "flowSnapshot");
    assert!(replay_types.contains(&"flowFiles"));
    assert!(replay_types.contains(&"flowWidgets"));
    assert!(replay_types.contains(&"flowSteering"));
    assert!(replay_types.contains(&"flowDecisions"));
    assert!(replay_types.contains(&"flowCheckpoints"));
    assert!(replay_types.contains(&"flowVerification"));
    assert!(replay_types.contains(&"flowBlockers"));
    assert!(replay_types.contains(&"flowPr"));
    assert_eq!(session_frames(&reconnect.seen, "flowSnapshot").len(), 1);
}

/// A push the remote refused leaves the remote branch behind the worktree
/// tip, and the forge merges the branch as the remote holds it. Mark-ready and
/// merge therefore refuse an unpushed checkpoint, and the retry publishes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forge_transition_refuses_a_tip_the_push_never_reached() {
    let _env = ENV_LOCK.lock().await;
    let fixture = fixture("unpushed-tip");
    let app = fixture.app.clone();
    let mut client = Client::connect(&app).await;

    send(&app, &client.conn, Command::CreateFlowGoal).await;
    client
        .wait_for("flowGoalStarted", |frame| {
            frame["type"] == "flowGoalStarted"
        })
        .await;
    let snapshot = client
        .wait_for("a new session's snapshot", |frame| {
            frame["type"] == "flowSnapshot" && frame["sessionId"].is_string()
        })
        .await;
    let session_id = snapshot["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string();
    let goal_question = client
        .wait_for("the goal question", |frame| {
            frame["type"] == "flowQuestion" && frame["target"] == "goal"
        })
        .await;
    send(
        &app,
        &client.conn,
        Command::FlowAnswer {
            id: Some(goal_question["id"].clone()),
            value: Some(json!("Alpha")),
            target: Some(json!("goal")),
        },
    )
    .await;
    client
        .wait_for("flowGoalStopped", |frame| {
            frame["type"] == "flowGoalStopped"
        })
        .await;

    send(&app, &client.conn, Command::StartFlowImplementation).await;
    client
        .wait_for("flowImplementationStarted", |frame| {
            frame["type"] == "flowImplementationStarted"
        })
        .await;
    client
        .wait_for("flowStopped", |frame| frame["type"] == "flowStopped")
        .await;
    client
        .wait_for("a draft pull request", |frame| {
            frame["type"] == "flowPr" && frame["pr"]["state"] == "draft"
        })
        .await;

    let directory = session_directory(&fixture, &session_id);
    let session: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("session.json")).expect("session.json"),
    )
    .expect("session JSON");
    let worktree = PathBuf::from(session["worktree"].as_str().expect("a worktree"));
    let origin = fixture._scratch.path().join("origin.git");
    let hook = origin.join("hooks/pre-receive");
    let branch = format!("flow/{session_id}");

    // --- the remote refuses the next checkpoint's push
    refuse_pushes(&origin, "ready-refused");
    std::fs::write(worktree.join("src/unpushed.txt"), "one\n").expect("a checkpoint file");
    git(&worktree, &["add", "-A"]);
    git(
        &worktree,
        &["commit", "-m", "feat: the unpushed checkpoint"],
    );
    let unpushed = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
    client
        .wait_for("the refused ready push", |frame| {
            frame["type"] == "flowError"
                && frame["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("ready-refused"))
        })
        .await;
    assert_ne!(
        remote_tip(&origin, &branch).as_deref(),
        Some(unpushed.as_str())
    );

    send(&app, &client.conn, Command::MarkFlowPrReady).await;
    let refused = client
        .wait_for("the unpushed mark-ready refusal", |frame| {
            frame["type"] == "flowError"
                && frame["message"].as_str().is_some_and(|message| {
                    message.contains(&unpushed) && message.contains("retryFlowPr")
                })
        })
        .await;
    assert!(refused["message"]
        .as_str()
        .expect("a refusal")
        .contains("marking the pull request ready"));
    assert!(!forge_operations(&fixture.forge_log).contains(&"markReady".to_string()));

    // --- the retry publishes the tip, and the same command then proceeds
    std::fs::remove_file(&hook).expect("the hook is removed");
    send(&app, &client.conn, Command::RetryFlowPr).await;
    assert_eq!(
        remote_tip(&origin, &branch),
        Some(unpushed.clone()),
        "the retry pushed the worktree tip"
    );
    send(&app, &client.conn, Command::MarkFlowPrReady).await;
    client
        .wait_for("a live pull request", |frame| {
            frame["type"] == "flowPr" && frame["pr"]["state"] == "live"
        })
        .await;
    assert!(forge_operations(&fixture.forge_log).contains(&"markReady".to_string()));

    // --- the same guard refuses a merge of the next unpushed checkpoint
    refuse_pushes(&origin, "merge-refused");
    std::fs::write(worktree.join("src/unpushed.txt"), "two\n").expect("a checkpoint file");
    git(&worktree, &["add", "-A"]);
    git(
        &worktree,
        &["commit", "-m", "feat: the second unpushed checkpoint"],
    );
    let second = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
    client
        .wait_for("the refused merge push", |frame| {
            frame["type"] == "flowError"
                && frame["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("merge-refused"))
        })
        .await;
    assert_eq!(
        remote_tip(&origin, &branch),
        Some(unpushed),
        "the refused push left the remote branch behind"
    );

    send(&app, &client.conn, Command::MergeFlowPr).await;
    let refused = client
        .wait_for("the unpushed merge refusal", |frame| {
            frame["type"] == "flowError"
                && frame["message"].as_str().is_some_and(|message| {
                    message.contains(&second) && message.contains("retryFlowPr")
                })
        })
        .await;
    assert!(refused["message"]
        .as_str()
        .expect("a refusal")
        .contains("merging the pull request"));
    assert!(
        !forge_operations(&fixture.forge_log).contains(&"merge".to_string()),
        "an unpushed tip never reaches the forge merge"
    );

    std::fs::remove_file(&hook).expect("the hook is removed");
    send(&app, &client.conn, Command::RetryFlowPr).await;
    assert_eq!(
        remote_tip(&origin, &branch),
        Some(second.clone()),
        "the retry pushed the worktree tip"
    );
    send(&app, &client.conn, Command::MergeFlowPr).await;
    client
        .wait_for("a merged pull request", |frame| {
            frame["type"] == "flowPr" && frame["pr"]["state"] == "merged"
        })
        .await;
    assert!(forge_operations(&fixture.forge_log).contains(&"merge".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_flow_refusal_frames_reach_a_fresh_page() {
    let _env = ENV_LOCK.lock().await;

    let scratch = Scratch::new("socket");
    let repo = scratch.path().join("repo");
    std::fs::create_dir_all(repo.join("adrs")).expect("a repository");
    let state = scratch.path().join("state");
    std::fs::create_dir_all(&state).expect("a state directory");
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: state.clone(),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let listener = devboard::http::bind(&config.hostname, 0)
        .await
        .expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    let mut config = config;
    config.port = port;
    let journal = Journal::open(&config.state_dir, &config.repo_dir, port);
    let server = devboard::http::Server::new(config, journal);
    let running = Arc::clone(&server);
    let task = tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, running).await;
    });

    let client = reqwest::Client::new();
    let invalid = client
        .get(format!("http://127.0.0.1:{port}/not-a-contract-command"))
        .header("accept", "application/json")
        .send()
        .await
        .expect("a response");
    assert_eq!(invalid.status().as_u16(), 404);
    assert_eq!(
        invalid
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/problem+json")
    );

    let stopped = client
        .delete(format!("http://127.0.0.1:{port}/flows/implementations"))
        .header("accept", "application/json")
        .send()
        .await
        .expect("a response");
    let stopped: Value = stopped.json().await.expect("JSON");
    assert_eq!(
        stopped["frames"],
        json!([{
            "type": "flowError",
            "message": "The Flow implementation is not running.",
            "command": "stopFlowImplementation",
        }])
    );

    let opened = client
        .post(format!("http://127.0.0.1:{port}/flows/widget-opens"))
        .header("accept", "application/json")
        .json(&json!({"id": "missing"}))
        .send()
        .await
        .expect("a response");
    let opened: Value = opened.json().await.expect("JSON");
    assert_eq!(
        opened["frames"],
        json!([{
            "type": "flowError",
            "message": "No Flow session exists.",
            "command": "openFlowWidget",
        }])
    );

    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_steering_write_surfaces_a_flow_error() {
    let _env = ENV_LOCK.lock().await;
    let fixture = fixture("steering-write");
    let app = fixture.app.clone();
    let mut client = Client::connect(&app).await;

    send(&app, &client.conn, Command::CreateFlowGoal).await;
    let snapshot = client
        .wait_for("a session snapshot", |frame| {
            frame["type"] == "flowSnapshot" && frame["sessionId"].is_string()
        })
        .await;
    let session_id = snapshot["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string();
    let directory = session_directory(&fixture, &session_id);
    // A directory where the steering log belongs makes the append fail.
    std::fs::create_dir(directory.join("steering.jsonl")).expect("an unwritable steering path");

    send(
        &app,
        &client.conn,
        Command::SendFlowSteering {
            text: Some(json!("prefer a smaller configuration")),
        },
    )
    .await;
    let error = client
        .wait_for("the failed steering write", |frame| {
            frame["type"] == "flowError"
                && frame["message"].as_str().is_some_and(|message| {
                    message.starts_with("Could not record the steering note: ")
                })
        })
        .await;
    assert!(
        error["message"]
            .as_str()
            .expect("a message")
            .starts_with("Could not record the steering note: "),
        "{error}"
    );
}

/// A merged session stays on screen with its steering list, but its tick
/// returns before acknowledgements, so a note written there is never read.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_merged_session_refuses_a_steering_note() {
    let _env = ENV_LOCK.lock().await;
    let fixture = fixture("merged-steering");
    let app = fixture.app.clone();
    let mut client = Client::connect(&app).await;

    send(&app, &client.conn, Command::CreateFlowGoal).await;
    let snapshot = client
        .wait_for("a session snapshot", |frame| {
            frame["type"] == "flowSnapshot" && frame["sessionId"].is_string()
        })
        .await;
    let session_id = snapshot["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string();
    let directory = session_directory(&fixture, &session_id);
    let goal_question = client
        .wait_for("the goal question", |frame| {
            frame["type"] == "flowQuestion" && frame["target"] == "goal"
        })
        .await;
    send(
        &app,
        &client.conn,
        Command::FlowAnswer {
            id: Some(goal_question["id"].clone()),
            value: Some(json!("Alpha")),
            target: Some(json!("goal")),
        },
    )
    .await;
    client
        .wait_for("flowGoalStopped", |frame| {
            frame["type"] == "flowGoalStopped"
        })
        .await;

    send(&app, &client.conn, Command::StartFlowImplementation).await;
    client
        .wait_for("flowStopped", |frame| frame["type"] == "flowStopped")
        .await;
    client
        .wait_for("a draft pull request", |frame| {
            frame["type"] == "flowPr" && frame["pr"]["state"] == "draft"
        })
        .await;
    send(&app, &client.conn, Command::MarkFlowPrReady).await;
    client
        .wait_for("a live pull request", |frame| {
            frame["type"] == "flowPr" && frame["pr"]["state"] == "live"
        })
        .await;

    // A stopped implementation is still accepted: a restart reads the note at
    // its next checkpoint.
    send(
        &app,
        &client.conn,
        Command::SendFlowSteering {
            text: Some(json!("Prefer the smaller shape")),
        },
    )
    .await;
    client
        .wait_for("the stopped session's steering note", |frame| {
            frame["type"] == "flowSteering"
                && frame["notes"].as_array().is_some_and(|notes| {
                    notes.iter().any(|note| {
                        note["source"] == "developer" && note["text"] == "Prefer the smaller shape"
                    })
                })
        })
        .await;
    let before = std::fs::read_to_string(directory.join("steering.jsonl"))
        .expect("steering.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    assert_eq!(before, 1);

    send(&app, &client.conn, Command::MergeFlowPr).await;
    client
        .wait_for("the merged snapshot", |frame| {
            frame["type"] == "flowSnapshot" && frame["status"] == "merged"
        })
        .await;

    let expected =
        format!("Flow session {session_id} is merged, so it no longer reads steering notes.");
    send(
        &app,
        &client.conn,
        Command::SendFlowSteering {
            text: Some(json!("One last note")),
        },
    )
    .await;
    let refused = client
        .wait_for("the merged steering refusal", |frame| {
            frame["type"] == "flowError" && frame["message"] == expected.as_str()
        })
        .await;
    assert_eq!(refused["message"], expected.as_str());
    let after = std::fs::read_to_string(directory.join("steering.jsonl"))
        .expect("steering.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    assert_eq!(after, before, "a refused note appends no line");
}

// ---------------------------------------------------------------------------
// The command adapter's GitLab draft state

/// One recorded `glab` call set and the merge request the stub keeps.
#[derive(Default)]
struct RecordedGitlab {
    calls: Vec<Vec<String>>,
    title: String,
}

/// The merge request URL the recorded `glab mr create` answers with.
const GITLAB_MR_URL: &str = "https://gitlab.test/acme/fixture/-/merge_requests/7";

/// The value one recorded call passed after `flag`.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let index = args.iter().position(|argument| argument == flag)?;
    args.get(index + 1).cloned()
}

/// A recorded `glab` runner: it answers credential resolution, and it keeps one
/// merge request whose title carries GitLab's draft marker, so the calls a
/// checkpoint makes can be read back.
fn recorded_gitlab() -> (Exec, Arc<Mutex<RecordedGitlab>>) {
    let state: Arc<Mutex<RecordedGitlab>> = Arc::new(Mutex::new(RecordedGitlab::default()));
    let inner = state.clone();
    let exec: Exec = Arc::new(
        move |command: String, args: Vec<String>, _options: ExecOptions| {
            let inner = inner.clone();
            Box::pin(async move {
                if command != "glab" {
                    return ExecResult {
                        stderr: format!("{command}: not found"),
                        code: 127,
                        ..ExecResult::default()
                    };
                }
                let mut state = inner.lock().expect("the recorded glab state");
                state.calls.push(args.clone());
                let first = args.first().map(String::as_str).unwrap_or("");
                let second = args.get(1).map(String::as_str).unwrap_or("");
                match (first, second) {
                    ("auth", "status") => ExecResult {
                        code: 0,
                        ..ExecResult::default()
                    },
                    ("api", _) if args.last().map(String::as_str) == Some("user") => ExecResult {
                        stdout: json!({"username": "alice"}).to_string(),
                        code: 0,
                        ..ExecResult::default()
                    },
                    ("api", _) => ExecResult {
                        stdout: json!({"permissions": {"project_access": {"access_level": 40}}})
                            .to_string(),
                        code: 0,
                        ..ExecResult::default()
                    },
                    ("mr", "create") => {
                        // GitLab itself prefixes the title of a draft MR.
                        let title = flag_value(&args, "--title").unwrap_or_default();
                        state.title = format!("{GITLAB_DRAFT_PREFIX}{title}");
                        ExecResult {
                            stdout: format!("{GITLAB_MR_URL}\n"),
                            code: 0,
                            ..ExecResult::default()
                        }
                    }
                    ("mr", "view") => ExecResult {
                        stdout: json!({
                            "title": state.title,
                            "state": "opened",
                            "web_url": GITLAB_MR_URL,
                        })
                        .to_string(),
                        code: 0,
                        ..ExecResult::default()
                    },
                    ("mr", "update") => {
                        if args.iter().any(|argument| argument == "--ready") {
                            // `--ready` is the call that clears the marker.
                            state.title = state.title.trim_start_matches("Draft: ").to_string();
                        } else if let Some(title) = flag_value(&args, "--title") {
                            state.title = title;
                        }
                        ExecResult {
                            code: 0,
                            ..ExecResult::default()
                        }
                    }
                    _ => ExecResult {
                        stderr: format!("glab {first} {second}: unexpected"),
                        code: 2,
                        ..ExecResult::default()
                    },
                }
            })
        },
    );
    (exec, state)
}

/// A transport that never runs: the command adapter's GitLab path is CLI only.
fn unreachable_transport() -> Transport {
    Arc::new(|request: HttpRequest| -> HttpFuture {
        Box::pin(async move {
            Err(HttpError::Unreachable(format!(
                "no transport for {}",
                request.url
            )))
        })
    })
}

/// Every recorded `glab mr update` call.
fn recorded_updates(state: &Arc<Mutex<RecordedGitlab>>) -> Vec<Vec<String>> {
    state
        .lock()
        .expect("the recorded glab state")
        .calls
        .iter()
        .filter(|args| {
            args.first().map(String::as_str) == Some("mr")
                && args.get(1).map(String::as_str) == Some("update")
        })
        .cloned()
        .collect()
}

#[tokio::test]
async fn a_gitlab_checkpoint_keeps_the_draft_prefix_until_the_ready_call() {
    let scratch = Scratch::new("gitlab-draft");
    let (exec, state) = recorded_gitlab();
    let forge = CommandFlowForge::with_seams(exec, unreachable_transport(), HashMap::new(), 5_000);
    let target = ForgeTarget {
        forge: "gitlab".to_string(),
        host: "gitlab.test".to_string(),
        project: "acme/fixture".to_string(),
        base_url: None,
    };
    let input = ForgePrInput {
        cwd: scratch.path().to_path_buf(),
        target: target.clone(),
        head: "flow/goal".to_string(),
        base: "main".to_string(),
        title: "Flow goal".to_string(),
        body: "The goal body.".to_string(),
    };

    let created = forge
        .create_draft(input.clone())
        .await
        .expect("the draft merge request");
    assert!(created.draft, "the local PR state is draft");
    assert_eq!(created.number, 7);
    let created_calls = state.lock().expect("the recorded glab state").calls.clone();
    let create = created_calls
        .iter()
        .find(|args| args.get(1).map(String::as_str) == Some("create"))
        .expect("the recorded create call");
    assert!(create.iter().any(|argument| argument == "--draft"));

    // The second checkpoint runs while the local PR state is still draft.
    forge
        .update(input.clone(), created.number)
        .await
        .expect("the checkpoint update");
    let updates = recorded_updates(&state);
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert_eq!(
        flag_value(&updates[0], "--title").as_deref(),
        Some("Draft: Flow goal"),
        "{:?}",
        updates[0]
    );

    forge
        .mark_ready(scratch.path(), &target, created.number)
        .await
        .expect("the ready call");
    let updates = recorded_updates(&state);
    let ready: Vec<&Vec<String>> = updates
        .iter()
        .filter(|args| args.iter().any(|argument| argument == "--ready"))
        .collect();
    assert_eq!(ready.len(), 1, "one ready call: {updates:?}");
    assert!(
        !ready[0].iter().any(|argument| argument == "--title"),
        "the ready call sends no title: {:?}",
        ready[0]
    );
    for update in &updates {
        if update.iter().any(|argument| argument == "--ready") {
            continue;
        }
        let title = flag_value(update, "--title").expect("an update carries a title");
        assert!(
            title.starts_with(GITLAB_DRAFT_PREFIX),
            "{update:?} drops the draft prefix"
        );
    }

    // A checkpoint after the ready call sends the plain title again.
    forge
        .update(input, created.number)
        .await
        .expect("the checkpoint after ready");
    let updates = recorded_updates(&state);
    let last = updates.last().expect("the last update");
    assert_eq!(
        flag_value(last, "--title").as_deref(),
        Some("Flow goal"),
        "{last:?}"
    );
}
