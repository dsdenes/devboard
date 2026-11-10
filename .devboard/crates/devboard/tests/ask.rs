//! Behavior proofs for Ask conversations: frames, refusals, reuse, close, and
//! the durable transcript, driven by the deterministic stub agent.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::journal::Journal;
use devboard::providers::{save_subscriptions, ProviderId, StoredSubscription};
use serde_json::{json, Value};
use tokio::sync::mpsc::{self, UnboundedReceiver};

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
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after the epoch")
            .as_nanos();
        let root = devboard_root().join(".test-tmp");
        std::fs::create_dir_all(&root).expect("scratch root exists");
        let path = root.join(format!(
            "ask-{label}-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(path.join("state")).expect("a state directory");
        std::fs::create_dir_all(path.join("repo")).expect("a repository");
        Self { path }
    }

    fn state(&self) -> PathBuf {
        self.path.join("state")
    }

    fn repo(&self) -> PathBuf {
        self.path.join("repo")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn stub_command(log: &Path) -> String {
    format!(
        "{} acp-stub --ask --ask-delay-ms=1 --log={}",
        env!("CARGO_BIN_EXE_devboard"),
        log.display()
    )
}

fn config(scratch: &Scratch, command: String) -> Config {
    let repo = scratch.repo();
    Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: command,
        state_dir: scratch.state(),
        allowed_hosts: Vec::new(),
        feedback: None,
    }
}

fn app_for(scratch: &Scratch, command: String) -> std::sync::Arc<App> {
    App::new(
        config(scratch, command),
        Journal::open(&scratch.state(), &scratch.repo(), 0),
    )
}

/// Serializes the tests, which share one process environment.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

fn connection() -> (Conn, UnboundedReceiver<String>) {
    let (outbox, inbox) = mpsc::unbounded_channel();
    (Conn::new(outbox), inbox)
}

/// The ephemeral handle one REST request answers through.
fn request_connection() -> (Conn, UnboundedReceiver<String>) {
    let (outbox, inbox) = mpsc::unbounded_channel();
    (Conn::new_request(outbox), inbox)
}

fn drain(inbox: &mut UnboundedReceiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(text) = inbox.try_recv() {
        frames.push(serde_json::from_str(&text).expect("a JSON frame"));
    }
    frames
}

/// Reads one conversation until its turn settles, returning the last frames.
async fn settled(
    app: &App,
    conn: &Conn,
    inbox: &mut UnboundedReceiver<String>,
    id: &str,
) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        app.command(
            conn,
            Command::GetInquiry {
                conversation_id: Some(json!(id)),
            },
        )
        .await;
        let frames = drain(inbox);
        if frames
            .iter()
            .any(|frame| frame["type"] == "inquiry" && frame["busy"] == json!(false))
        {
            return frames;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the turn settled: {frames:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The stub streams its answer in two chunks, trimming each; the client joins
/// them verbatim, which loses the space the split consumed.
fn streamed(answer: &str) -> String {
    let split = answer
        .find(". ")
        .map(|index| index + 2)
        .expect("the fixture answer has two sentences");
    format!("{}{}", answer[..split].trim(), answer[split..].trim())
}

const READ_ONLY_SENTENCE: &str = "This conversation is read-only. Never edit files, run mutating commands, file issues, commit, or push.";
const BREVITY_SENTENCE: &str = "Answer in at most three short sentences and about 400 characters. No preamble and no restating the question.";
const PLAIN_SENTENCE: &str = "Reply in plain text without Markdown.";

const ANSWER_ONE: &str = "The issues indicator shows the lifecycle the detached worker published for this repository. It turns amber while a run is working and shows failed when the last run failed. It sits in the status bar and opens the Issues mode.";
const ANSWER_TWO: &str = "The status bar renders that label in StatusBar.svelte from the issues snapshot the server sends. The count is the open issues the tracker returned for the host repository. No other status item opens a mode.";

fn context() -> Value {
    json!({
        "route": "/issues",
        "url": "http://127.0.0.1:8080/issues",
        "selector": "#issues-indicator",
        "viewport": "1280x800",
        "captured_at": "2026-11-03T12:00:00.000Z",
        "visible_text": "Issues",
        "dom_excerpt": "<button id=\"issues-indicator\">Issues</button>",
    })
}

/// The first prompt of a conversation, exactly as `server/ask.ts` composes it.
fn first_prompt(question: &str) -> String {
    let captured = context();
    let mut lines = vec![
        "You are answering a question about a UI element in the running Devboard interface."
            .to_string(),
        "Answer from the captured context and this conversation; change nothing.".to_string(),
        String::new(),
        READ_ONLY_SENTENCE.to_string(),
        BREVITY_SENTENCE.to_string(),
        PLAIN_SENTENCE.to_string(),
        String::new(),
        format!("Question: {question}"),
        String::new(),
        "Captured element context:".to_string(),
    ];
    for name in [
        "route",
        "url",
        "selector",
        "viewport",
        "captured_at",
        "visible_text",
        "dom_excerpt",
    ] {
        lines.push(format!("{name}: {}", captured[name].as_str().unwrap()));
    }
    lines.join("\n")
}

fn follow_up_prompt(question: &str) -> String {
    [
        READ_ONLY_SENTENCE,
        BREVITY_SENTENCE,
        PLAIN_SENTENCE,
        "",
        &format!("Question: {question}"),
    ]
    .join("\n")
}

/// The durable transcript of one conversation.
fn transcript_path(scratch: &Scratch, id: &str) -> PathBuf {
    let repo = std::path::absolute(scratch.repo()).expect("an absolute repository");
    let directory = scratch
        .state()
        .join("ask")
        .join(devboard::journal::repo_key(&repo));
    let names: Vec<PathBuf> = std::fs::read_dir(&directory)
        .unwrap_or_else(|error| panic!("the ask directory {}: {error}", directory.display()))
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    assert_eq!(names.len(), 1, "one conversation file for {id}: {names:?}");
    let name = names[0]
        .file_name()
        .and_then(|name| name.to_str())
        .expect("a file name");
    assert_eq!(name.len(), 37, "a 32-hex key plus .json");
    assert!(
        name[..32]
            .chars()
            .all(|character| character.is_ascii_hexdigit()),
        "the key is hex: {name}"
    );
    names[0].clone()
}

fn log_lines(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

// The environment guard serializes process-wide env across concurrently
// running tests, so it is deliberately held for the whole test.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn ask_streams_turns_and_keeps_one_transcript() {
    let _env = env_guard();
    let scratch = Scratch::new("conversation");
    let log = scratch.path.join("agent.log");
    // A configured key makes the provider selection resolve without a call the
    // test waits on: the usage endpoint refuses immediately.
    save_subscriptions(
        &scratch.state(),
        &[StoredSubscription {
            id: "subscription-1".to_string(),
            provider: ProviderId::OpenCodeGo,
            label: "Test".to_string(),
            key: "test-key".to_string(),
            enabled: true,
            created_at: "2026-11-03T00:00:00.000Z".to_string(),
            updated_at: "2026-11-03T00:00:00.000Z".to_string(),
        }],
    )
    .expect("the credentials file is written");
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    let app = app_for(&scratch, stub_command(&log));
    let (conn, mut inbox) = connection();

    // A refused request never touches the agent.
    app.command(
        &conn,
        Command::Ask {
            conversation_id: Some(json!("missing")),
            question: Some(json!("contract?")),
            context: None,
        },
    )
    .await;
    assert_eq!(
        drain(&mut inbox),
        vec![json!({
            "type": "askError",
            "conversationId": "missing",
            "message": "The ask has no element context.",
        })]
    );

    app.command(
        &conn,
        Command::Ask {
            conversation_id: Some(json!("  ")),
            question: Some(json!("What?")),
            context: Some(context()),
        },
    )
    .await;
    assert_eq!(
        drain(&mut inbox),
        vec![json!({
            "type": "askError",
            "conversationId": "  ",
            "message": "The conversation id must be 1-200 characters.",
        })]
    );

    app.command(
        &conn,
        Command::Ask {
            conversation_id: Some(json!("conversation-1")),
            question: Some(json!("   ")),
            context: Some(context()),
        },
    )
    .await;
    assert_eq!(
        drain(&mut inbox),
        vec![json!({
            "type": "askError",
            "conversationId": "conversation-1",
            "message": "The question is empty.",
        })]
    );

    let question_one = "What does the issues indicator show?";
    app.command(
        &conn,
        Command::Ask {
            conversation_id: Some(json!("conversation-1")),
            question: Some(json!(question_one)),
            context: Some(context()),
        },
    )
    .await;
    let frames = drain(&mut inbox);
    assert_eq!(
        frames.len(),
        1,
        "the creation answers one frame: {frames:?}"
    );
    let inquiry = frames[0].as_object().expect("an inquiry object");
    assert_eq!(
        inquiry.keys().map(String::as_str).collect::<Vec<&str>>(),
        vec![
            "type",
            "conversationId",
            "busy",
            "answer",
            "error",
            "transcript"
        ],
        "an inquiry carries exactly the six fields"
    );
    assert_eq!(frames[0]["type"], "inquiry");
    assert_eq!(frames[0]["conversationId"], "conversation-1");
    assert_eq!(frames[0]["busy"], json!(true));
    assert_eq!(frames[0]["answer"], "");
    assert_eq!(frames[0]["error"], Value::Null);
    assert_eq!(
        frames[0]["transcript"],
        json!([{"role": "developer", "text": question_one}])
    );

    let frames = settled(&app, &conn, &mut inbox, "conversation-1").await;
    let inquiry = frames
        .iter()
        .rev()
        .find(|frame| frame["type"] == "inquiry")
        .expect("a settled inquiry");
    assert_eq!(inquiry["busy"], json!(false));
    assert_eq!(inquiry["answer"], "");
    assert_eq!(inquiry["error"], Value::Null);
    assert_eq!(
        inquiry["transcript"],
        json!([
            {"role": "developer", "text": question_one},
            {"role": "agent", "text": streamed(ANSWER_ONE)},
        ])
    );

    let path = transcript_path(&scratch, "conversation-1");
    let persisted = std::fs::read_to_string(&path).expect("the transcript exists");
    let expected = format!(
        "{{\"id\":\"conversation-1\",\"transcript\":[{{\"role\":\"developer\",\"text\":{}}},{{\"role\":\"agent\",\"text\":{}}}],\"turn\":1,\"busy\":false,\"lastPrompt\":{},\"textStart\":0,\"error\":null}}\n",
        serde_json::to_string(question_one).expect("a JSON question"),
        serde_json::to_string(&streamed(ANSWER_ONE)).expect("a JSON answer"),
        serde_json::to_string(&first_prompt(question_one)).expect("a JSON prompt"),
    );
    assert_eq!(persisted, expected, "the transcript bytes match ask.ts");

    // The fixture proves the framed prompt the peer actually received.
    let texts: Vec<String> = log_lines(&log)
        .into_iter()
        .filter_map(|line| line.strip_prefix("ask-text 1 ").map(str::to_string))
        .collect();
    assert_eq!(texts.len(), 1, "one first prompt");
    let sent: Value = serde_json::from_str(&texts[0]).expect("the logged prompt is JSON");
    assert_eq!(sent, json!(first_prompt(question_one)));

    // A follow-up keeps the live peer and repeats only the instructions.
    let question_two = "Which component renders it?";
    app.command(
        &conn,
        Command::Ask {
            conversation_id: Some(json!("conversation-1")),
            question: Some(json!(question_two)),
            context: Some(context()),
        },
    )
    .await;
    let frames = drain(&mut inbox);
    assert_eq!(
        frames.len(),
        1,
        "the follow-up answers one frame: {frames:?}"
    );
    assert_eq!(frames[0]["type"], "inquiry");
    assert_eq!(frames[0]["busy"], json!(true));
    assert_eq!(
        frames[0]["transcript"],
        json!([
            {"role": "developer", "text": question_one},
            {"role": "agent", "text": streamed(ANSWER_ONE)},
            {"role": "developer", "text": question_two},
        ])
    );

    let frames = settled(&app, &conn, &mut inbox, "conversation-1").await;
    let inquiry = frames
        .iter()
        .rev()
        .find(|frame| frame["type"] == "inquiry")
        .expect("a settled inquiry");
    assert_eq!(
        inquiry["transcript"],
        json!([
            {"role": "developer", "text": question_one},
            {"role": "agent", "text": streamed(ANSWER_ONE)},
            {"role": "developer", "text": question_two},
            {"role": "agent", "text": streamed(ANSWER_TWO)},
        ])
    );

    let persisted = std::fs::read_to_string(&path).expect("the transcript exists");
    let expected = format!(
        "{{\"id\":\"conversation-1\",\"transcript\":[{{\"role\":\"developer\",\"text\":{}}},{{\"role\":\"agent\",\"text\":{}}},{{\"role\":\"developer\",\"text\":{}}},{{\"role\":\"agent\",\"text\":{}}}],\"turn\":2,\"busy\":false,\"lastPrompt\":{},\"textStart\":2,\"error\":null}}\n",
        serde_json::to_string(question_one).expect("a JSON question"),
        serde_json::to_string(&streamed(ANSWER_ONE)).expect("a JSON answer"),
        serde_json::to_string(question_two).expect("a JSON question"),
        serde_json::to_string(&streamed(ANSWER_TWO)).expect("a JSON answer"),
        serde_json::to_string(&follow_up_prompt(question_two)).expect("a JSON prompt"),
    );
    assert_eq!(persisted, expected, "both turns are retained in order");

    let follow_ups: Vec<String> = log_lines(&log)
        .into_iter()
        .filter_map(|line| line.strip_prefix("ask-text 2 ").map(str::to_string))
        .collect();
    assert_eq!(follow_ups.len(), 1, "one follow-up prompt");
    let sent: Value = serde_json::from_str(&follow_ups[0]).expect("the logged prompt is JSON");
    assert_eq!(sent, json!(follow_up_prompt(question_two)));
    assert_eq!(
        log_lines(&log)
            .iter()
            .filter(|line| line.starts_with("ask-start "))
            .count(),
        1,
        "the follow-up reuses the peer process"
    );

    // Closing stops the peer and drops the transcript.
    app.command(
        &conn,
        Command::CloseAsk {
            conversation_id: Some(json!("conversation-1")),
        },
    )
    .await;
    assert!(drain(&mut inbox).is_empty(), "closeAsk answers no frame");
    assert!(!path.exists(), "closeAsk removes the transcript file");
    let spawned = log_lines(&log)
        .iter()
        .find_map(|line| {
            line.strip_prefix("spawn ")
                .and_then(|pid| pid.parse::<u32>().ok())
        })
        .expect("the log names the spawned peer");
    wait_for_process_exit(spawned).await;

    assert!(
        ask_directory_empty(&scratch),
        "the ask directory holds no conversation file"
    );
}

/// True when the ask directory exists and holds no `.json` file.
fn ask_directory_empty(scratch: &Scratch) -> bool {
    let repo = std::path::absolute(scratch.repo()).expect("an absolute repository");
    let directory = scratch
        .state()
        .join("ask")
        .join(devboard::journal::repo_key(&repo));
    std::fs::read_dir(&directory)
        .map(|entries| {
            !entries.flatten().any(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
        })
        .unwrap_or(true)
}

/// Every turn is its own REST request. A follow-up asked by a new handle after
/// the first turn settled continues the conversation and answers its
/// conversation, and the handle that asked the first turn sees none of it.
// The environment guard serializes process-wide env across concurrently
// running tests, so it is deliberately held for the whole test.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn ask_answers_a_follow_up_requested_by_a_new_handle() {
    let _env = env_guard();
    let scratch = Scratch::new("follow-up-request");
    let log = scratch.path.join("agent.log");
    save_subscriptions(
        &scratch.state(),
        &[StoredSubscription {
            id: "subscription-1".to_string(),
            provider: ProviderId::OpenCodeGo,
            label: "Test".to_string(),
            key: "test-key".to_string(),
            enabled: true,
            created_at: "2026-11-03T00:00:00.000Z".to_string(),
            updated_at: "2026-11-03T00:00:00.000Z".to_string(),
        }],
    )
    .expect("the credentials file is written");
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    let app = app_for(&scratch, stub_command(&log));

    let (first, mut first_inbox) = request_connection();
    app.command(
        &first,
        Command::Ask {
            conversation_id: Some(json!("conversation-1")),
            question: Some(json!("What does the issues indicator show?")),
            context: Some(context()),
        },
    )
    .await;
    let frames = drain(&mut first_inbox);
    assert!(
        frames.iter().all(|frame| frame["type"] != "askError"),
        "the first request answers: {frames:?}"
    );
    settled(&app, &first, &mut first_inbox, "conversation-1").await;

    let (follow_up, mut follow_up_inbox) = request_connection();
    app.command(
        &follow_up,
        Command::Ask {
            conversation_id: Some(json!("conversation-1")),
            question: Some(json!("Which component renders it?")),
            context: Some(context()),
        },
    )
    .await;
    let frames = drain(&mut follow_up_inbox);
    assert!(
        frames.iter().all(|frame| frame["type"] != "askError"),
        "a new request handle continues the conversation: {frames:?}"
    );
    assert!(
        frames
            .iter()
            .any(|frame| frame["type"] == "inquiry" && frame["busy"] == json!(true)),
        "the follow-up answers its accepted conversation: {frames:?}"
    );
    let frames = settled(&app, &follow_up, &mut follow_up_inbox, "conversation-1").await;
    let inquiry = frames
        .iter()
        .rev()
        .find(|frame| frame["type"] == "inquiry")
        .expect("a settled inquiry");
    assert_eq!(
        inquiry["transcript"],
        json!([
            {"role": "developer", "text": "What does the issues indicator show?"},
            {"role": "agent", "text": streamed(ANSWER_ONE)},
            {"role": "developer", "text": "Which component renders it?"},
            {"role": "agent", "text": streamed(ANSWER_TWO)},
        ])
    );
    assert!(
        drain(&mut first_inbox).is_empty(),
        "the request that asked the first turn receives nothing of the follow-up"
    );

    app.command(
        &follow_up,
        Command::CloseAsk {
            conversation_id: Some(json!("conversation-1")),
        },
    )
    .await;
}

/// A conversation answers one turn at a time: a second ask while the first is
/// still running is refused, whichever client asks it.
// The environment guard serializes process-wide env across concurrently
// running tests, so it is deliberately held for the whole test.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn ask_refuses_a_second_turn_while_one_runs() {
    let _env = env_guard();
    let scratch = Scratch::new("live-owner");
    let log = scratch.path.join("agent.log");
    save_subscriptions(
        &scratch.state(),
        &[StoredSubscription {
            id: "subscription-1".to_string(),
            provider: ProviderId::OpenCodeGo,
            label: "Test".to_string(),
            key: "test-key".to_string(),
            enabled: true,
            created_at: "2026-11-03T00:00:00.000Z".to_string(),
            updated_at: "2026-11-03T00:00:00.000Z".to_string(),
        }],
    )
    .expect("the credentials file is written");
    std::env::set_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
    let app = app_for(&scratch, stub_command(&log));

    let (owner, mut owner_inbox) = connection();
    app.command(
        &owner,
        Command::Ask {
            conversation_id: Some(json!("conversation-1")),
            question: Some(json!("What does the issues indicator show?")),
            context: Some(context()),
        },
    )
    .await;
    let frames = drain(&mut owner_inbox);
    assert!(
        frames
            .iter()
            .any(|frame| frame["type"] == "inquiry" && frame["busy"] == json!(true)),
        "the first ask is admitted while its turn runs: {frames:?}"
    );

    let (other, mut other_inbox) = connection();
    app.command(
        &other,
        Command::Ask {
            conversation_id: Some(json!("conversation-1")),
            question: Some(json!("Which component renders it?")),
            context: Some(context()),
        },
    )
    .await;
    assert_eq!(
        drain(&mut other_inbox),
        vec![json!({
            "type": "askError",
            "conversationId": "conversation-1",
            "message": "The agent is still answering the previous question.",
        })],
        "one turn in flight refuses a second question"
    );

    settled(&app, &owner, &mut owner_inbox, "conversation-1").await;
    app.command(
        &owner,
        Command::CloseAsk {
            conversation_id: Some(json!("conversation-1")),
        },
    )
    .await;
}

// The environment guard serializes process-wide env across concurrently
// running tests, so it is deliberately held for the whole test.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn ask_refuses_before_a_process_without_a_provider() {
    let _env = env_guard();
    let scratch = Scratch::new("no-provider");
    let log = scratch.path.join("agent.log");
    std::env::remove_var("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL");
    let app = app_for(&scratch, stub_command(&log));
    let (conn, mut inbox) = connection();

    app.command(
        &conn,
        Command::Ask {
            conversation_id: Some(json!("conversation-2")),
            question: Some(json!("What does this button do?")),
            context: Some(context()),
        },
    )
    .await;
    let frames = drain(&mut inbox);
    assert_eq!(frames.len(), 1, "one refusal: {frames:?}");
    assert_eq!(frames[0]["type"], "askError");
    assert_eq!(frames[0]["conversationId"], "conversation-2");
    assert_eq!(
        frames[0]["message"],
        "No provider is configured. Open the Providers dialog (settings.providers) and add an \
         OpenCode Go or OpenRouter API key."
    );
    assert!(
        !log.exists(),
        "no agent process started for a refused selection"
    );
}

/// Waits until the peer process is gone, so a close is proven by the process
/// table rather than by a runtime-specific exit log line. The wait yields so
/// the runtime can reap the child it spawned.
async fn wait_for_process_exit(pid: u32) {
    for _ in 0..200 {
        if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the peer {pid} is still running after closeAsk");
}
