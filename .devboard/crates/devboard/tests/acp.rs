//! Behavior proofs for the ACP client, driven by the deterministic stub agent.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::acp::{
    next_activity, AcpConnection, AcpConnectionOptions, AcpEvent, AcpId, AcpQuestion,
    PermissionPolicy,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;

fn devboard_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the devboard harness directory exists")
}

fn stub_command(arguments: &[String]) -> String {
    let binary = env!("CARGO_BIN_EXE_devboard");
    let mut command = format!("{binary} acp-stub");
    for argument in arguments {
        command.push(' ');
        command.push_str(argument);
    }
    command
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
            "acp-{label}-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("scratch directory exists");
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

fn activity_texts(events: &[AcpEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            AcpEvent::Activity(activity) => Some(activity.text.clone()),
            _ => None,
        })
        .collect()
}

fn questions(events: &[AcpEvent]) -> Vec<&AcpQuestion> {
    events
        .iter()
        .filter_map(|event| match event {
            AcpEvent::Question(question) => Some(question),
            _ => None,
        })
        .collect()
}

async fn drain_events(events: &mut mpsc::UnboundedReceiver<AcpEvent>) -> Vec<AcpEvent> {
    let mut collected = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            Ok(Some(event)) => collected.push(event),
            Ok(None) => break,
            Err(_) => break,
        }
    }
    collected
}

async fn wait_for_question(
    events: &mut mpsc::UnboundedReceiver<AcpEvent>,
    seen: &mut Vec<AcpEvent>,
) -> AcpQuestion {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("timed out waiting for the stub question");
        }
        match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Some(AcpEvent::Question(question))) => {
                seen.push(AcpEvent::Question(question.clone()));
                return question;
            }
            Ok(Some(event)) => seen.push(event),
            Ok(None) => panic!("the stub closed before asking a question"),
            Err(_) => panic!("timed out waiting for the stub question"),
        }
    }
}

struct TurnOutcome {
    result: Result<Value, String>,
    events: Vec<AcpEvent>,
    log: String,
}

impl TurnOutcome {
    fn activity_texts(&self) -> Vec<String> {
        activity_texts(&self.events)
    }

    fn questions(&self) -> Vec<&AcpQuestion> {
        questions(&self.events)
    }
}

/// Runs one complete turn, then closes the peer and collects everything the
/// callback channel carried.
async fn run_turn(
    scratch: &Scratch,
    arguments: Vec<String>,
    permission_policy: PermissionPolicy,
    prompt: &str,
) -> TurnOutcome {
    let log = scratch.path().join("agent.log");
    let mut arguments = arguments;
    arguments.push(format!("--log={}", log.display()));
    let options =
        AcpConnectionOptions::new(stub_command(&arguments), scratch.path().to_string_lossy())
            .with_permission_policy(permission_policy);
    let (connection, mut events) = AcpConnection::connect(options)
        .await
        .expect("the stub agent starts");
    let result = tokio::time::timeout(Duration::from_secs(30), connection.run(prompt)).await;
    connection.close();
    drop(connection);
    let events = drain_events(&mut events).await;
    let log = std::fs::read_to_string(&log).unwrap_or_default();
    let result = match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error.message),
        Err(_) => Err("turn timed out".to_string()),
    };
    TurnOutcome {
        result,
        events,
        log,
    }
}

#[test]
fn activity_joins_one_message_and_starts_a_line_after_tool_calls() {
    let updates = vec![
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": "The browser" }, "messageId": "message-1" }),
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": " interface" }, "messageId": "message-1" }),
        json!({ "sessionUpdate": "tool_call", "title": "Reading 0001-example.md" }),
        json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": " more" }, "messageId": "message-1" }),
        json!({ "sessionUpdate": "plan", "entries": [{ "content": "First" }, { "content": "Second" }] }),
        json!({ "sessionUpdate": "agent_thought_chunk", "content": { "text": "" } }),
    ];
    let mut stream = None;
    let mut activities = Vec::new();
    for update in &updates {
        if let Some(next) = next_activity(update, stream.as_ref()) {
            stream = next.stream;
            activities.push(next.activity);
        }
    }
    assert_eq!(
        activities,
        vec![
            devboard::acp::AcpActivity {
                text: "The browser".to_string(),
                append: false,
            },
            devboard::acp::AcpActivity {
                text: " interface".to_string(),
                append: true,
            },
            devboard::acp::AcpActivity {
                text: "Reading 0001-example.md".to_string(),
                append: false,
            },
            devboard::acp::AcpActivity {
                text: " more".to_string(),
                append: false,
            },
            devboard::acp::AcpActivity {
                text: "First\nSecond".to_string(),
                append: false,
            },
        ]
    );
}

#[tokio::test]
async fn stub_agent_handshake_streams_activity() {
    let scratch = Scratch::new("activity");
    let log = scratch.path().join("agent.log");
    let options = AcpConnectionOptions::new(
        stub_command(&[format!("--log={}", log.display())]),
        scratch.path().to_string_lossy(),
    );
    let (connection, mut events) = AcpConnection::connect(options)
        .await
        .expect("the stub agent starts");
    assert!(!connection.has_session());
    assert_eq!(connection.argv()[0], env!("CARGO_BIN_EXE_devboard"));
    assert_eq!(connection.argv()[1], "acp-stub");

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        connection.run("Hello from the Rust ACP test"),
    )
    .await
    .expect("the turn settles")
    .expect("the prompt succeeds");
    assert_eq!(result["stopReason"], "end_turn");
    assert!(connection.has_session());
    assert_eq!(connection.session_id().as_deref(), Some("stub-session"));

    connection.close();
    assert!(connection.closed());
    assert_eq!(connection.pid(), None);
    drop(connection);

    let events = drain_events(&mut events).await;
    assert_eq!(
        activity_texts(&events),
        vec!["Working on Hello from the Rust ACP test".to_string()]
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, AcpEvent::SessionUpdate)));
    let log = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(log.contains("session-new"));
    assert!(log.contains("prompt Hello from the Rust ACP test"));
}

#[tokio::test]
async fn stub_agent_answers_a_question() {
    let scratch = Scratch::new("question");
    let log = scratch.path().join("agent.log");
    let options = AcpConnectionOptions::new(
        stub_command(&[
            "--questions=1".to_string(),
            format!("--log={}", log.display()),
        ]),
        scratch.path().to_string_lossy(),
    );
    let (connection, mut events) = AcpConnection::connect(options)
        .await
        .expect("the stub agent starts");
    let connection = Arc::new(connection);
    let runner = tokio::spawn({
        let connection = Arc::clone(&connection);
        async move { connection.run("Hello").await }
    });

    let mut seen = Vec::new();
    let question = wait_for_question(&mut events, &mut seen).await;
    assert_eq!(question.id, AcpId::Number(1));
    assert_eq!(question.message, "Choose an answer");
    let labels: Vec<&str> = question
        .options
        .iter()
        .map(|option| option.label.as_str())
        .collect();
    assert_eq!(labels, vec!["Alpha", "Beta"]);
    assert!(question.options[0].recommended);
    assert!(!question.options[1].recommended);
    assert_eq!(
        question.options[0].description.as_deref(),
        Some("Alpha leads to the first outcome.")
    );
    assert_eq!(question.required, Some(vec!["value".to_string()]));
    assert!(question.properties.contains_key("value"));

    assert!(connection.answer(&question.id, "Beta").await);
    let result = tokio::time::timeout(Duration::from_secs(30), runner)
        .await
        .expect("the turn settles")
        .expect("the runner joins")
        .expect("the prompt succeeds");
    assert_eq!(result["stopReason"], "end_turn");
    // The question was consumed by the first answer.
    assert!(!connection.answer(&question.id, "Beta").await);

    connection.close();
    drop(connection);
    seen.extend(drain_events(&mut events).await);
    assert_eq!(
        activity_texts(&seen),
        vec![
            "Working on Hello".to_string(),
            "Answer received: Beta".to_string(),
        ]
    );
    let log = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(log.lines().any(|line| line == "answer Beta"));
}

#[tokio::test]
async fn permission_policies_cancel_or_grant_the_probe() {
    let deny_scratch = Scratch::new("permission-deny");
    let deny_probe = deny_scratch.path().join("probe.txt");
    let deny = run_turn(
        &deny_scratch,
        vec![
            "--ask".to_string(),
            format!("--permission-probe={}", deny_probe.display()),
        ],
        PermissionPolicy::Deny,
        "Please answer this.\nQuestion: what is the status?",
    )
    .await;
    assert!(deny.result.is_ok(), "deny turn failed: {:?}", deny.result);
    assert!(!deny_probe.exists());
    assert!(deny.log.contains("permission cancelled"));

    let read_only_scratch = Scratch::new("permission-read-only");
    let read_only_probe = read_only_scratch.path().join("probe.txt");
    let read_only = run_turn(
        &read_only_scratch,
        vec![
            "--ask".to_string(),
            format!("--permission-probe={}", read_only_probe.display()),
        ],
        PermissionPolicy::ReadOnly,
        "Please answer this.\nQuestion: what is the status?",
    )
    .await;
    assert!(
        read_only.result.is_ok(),
        "read-only turn failed: {:?}",
        read_only.result
    );
    assert!(!read_only_probe.exists());
    assert!(read_only.log.contains("permission cancelled"));

    let allow_scratch = Scratch::new("permission-allow");
    let allow_probe = allow_scratch.path().join("probe.txt");
    let allow = run_turn(
        &allow_scratch,
        vec![
            "--ask".to_string(),
            format!("--permission-probe={}", allow_probe.display()),
        ],
        PermissionPolicy::Allow,
        "Please answer this.\nQuestion: what is the status?",
    )
    .await;
    assert!(
        allow.result.is_ok(),
        "allow turn failed: {:?}",
        allow.result
    );
    assert_eq!(
        std::fs::read_to_string(&allow_probe).unwrap_or_default(),
        "granted\n"
    );
    assert!(allow.log.contains("permission selected allow"));
}

#[tokio::test]
async fn deny_cancels_elicitations_and_read_only_surfaces_them() {
    let deny_scratch = Scratch::new("elicitation-deny");
    let deny = run_turn(
        &deny_scratch,
        vec!["--questions=1".to_string()],
        PermissionPolicy::Deny,
        "Hello",
    )
    .await;
    assert!(deny.result.is_ok(), "deny turn failed: {:?}", deny.result);
    assert!(deny.questions().is_empty());
    assert_eq!(
        deny.activity_texts(),
        vec![
            "Working on Hello".to_string(),
            "Answer received: ".to_string(),
        ]
    );
    assert!(deny.log.lines().any(|line| line == "answer "));

    let read_only_scratch = Scratch::new("elicitation-read-only");
    let log = read_only_scratch.path().join("agent.log");
    let options = AcpConnectionOptions::new(
        stub_command(&[
            "--questions=1".to_string(),
            format!("--log={}", log.display()),
        ]),
        read_only_scratch.path().to_string_lossy(),
    )
    .with_permission_policy(PermissionPolicy::ReadOnly);
    let (connection, mut events) = AcpConnection::connect(options)
        .await
        .expect("the stub agent starts");
    let connection = Arc::new(connection);
    let runner = tokio::spawn({
        let connection = Arc::clone(&connection);
        async move { connection.run("Hello").await }
    });

    let mut seen = Vec::new();
    let question = wait_for_question(&mut events, &mut seen).await;
    assert!(connection.answer(&question.id, "Beta").await);
    let result = tokio::time::timeout(Duration::from_secs(30), runner)
        .await
        .expect("the turn settles")
        .expect("the runner joins")
        .expect("the prompt succeeds");
    assert_eq!(result["stopReason"], "end_turn");

    connection.close();
    drop(connection);
    seen.extend(drain_events(&mut events).await);
    assert_eq!(
        activity_texts(&seen),
        vec![
            "Working on Hello".to_string(),
            "Answer received: Beta".to_string(),
        ]
    );
    let log = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(log.lines().any(|line| line == "answer Beta"));
}
