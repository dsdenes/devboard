//! Behavior proofs for the ACP client, driven by the deterministic stub agent.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// Writes one shell peer under the test directory and returns the command that
/// runs it, so the command splitter sees a bare program with one argument.
#[cfg(unix)]
fn script_peer(scratch: &Scratch, name: &str, body: &str) -> String {
    let path = scratch.path().join(name);
    std::fs::write(&path, format!("{body}\n")).expect("the peer script is written");
    format!("/bin/sh {}", path.display())
}

#[cfg(unix)]
fn peer_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Waits until the peer script reports that its signal handling is installed,
/// so a close never races the shell's own startup.
#[cfg(unix)]
async fn wait_for_ready(scratch: &Scratch, name: &str) {
    let path = scratch.path().join(name);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(Instant::now() < deadline, "the peer never became ready");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(unix)]
async fn wait_for_peer_exit(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while peer_alive(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

/// A peer that ignores SIGTERM and drains its session until stdin reaches end
/// of file is ended by the close: the connection drops the pipe's write end.
#[cfg(unix)]
#[tokio::test]
async fn close_sends_stdin_eof_to_a_peer_that_ignores_sigterm() {
    let scratch = Scratch::new("close-stdin");
    let command = script_peer(
        &scratch,
        "drain.sh",
        "trap '' TERM\necho ready > ready.txt\nexec cat",
    );
    let options = AcpConnectionOptions::new(command, scratch.path().to_string_lossy());
    let (connection, _events) = AcpConnection::connect(options)
        .await
        .expect("the peer starts");
    let pid = connection.pid().expect("the peer has a pid");
    wait_for_ready(&scratch, "ready.txt").await;
    connection.close();
    assert!(
        wait_for_peer_exit(pid, Duration::from_millis(1_000)).await,
        "the peer waited for a stdin EOF the close never sent"
    );
}

/// A peer that exits on SIGTERM ends on that signal, without waiting for the
/// escalation deadline.
#[cfg(unix)]
#[tokio::test]
async fn close_ends_a_peer_that_exits_on_sigterm_before_the_deadline() {
    let scratch = Scratch::new("close-sigterm");
    let command = script_peer(&scratch, "term.sh", "echo ready > ready.txt\nexec sleep 60");
    let options = AcpConnectionOptions::new(command, scratch.path().to_string_lossy());
    let (connection, _events) = AcpConnection::connect(options)
        .await
        .expect("the peer starts");
    let pid = connection.pid().expect("the peer has a pid");
    wait_for_ready(&scratch, "ready.txt").await;
    connection.close();
    assert!(
        wait_for_peer_exit(pid, Duration::from_millis(1_000)).await,
        "the peer outlived SIGTERM and waited for the escalation deadline"
    );
}

/// A peer that ignores SIGTERM and never reads stdin has no exit of its own,
/// so the close's deadline has to SIGKILL its process group.
#[cfg(unix)]
#[tokio::test]
async fn close_sigkills_a_peer_that_ignores_signals_and_stdin_eof() {
    let scratch = Scratch::new("close-kill");
    let command = script_peer(
        &scratch,
        "stubborn.sh",
        "trap '' TERM\necho ready > ready.txt\nexec sleep 60",
    );
    let options = AcpConnectionOptions::new(command, scratch.path().to_string_lossy());
    let (connection, _events) = AcpConnection::connect(options)
        .await
        .expect("the peer starts");
    let pid = connection.pid().expect("the peer has a pid");
    wait_for_ready(&scratch, "ready.txt").await;
    connection.close();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        peer_alive(pid),
        "the peer should still be alive inside the grace period"
    );
    assert!(
        wait_for_peer_exit(pid, Duration::from_secs(5)).await,
        "the peer survived the SIGKILL deadline"
    );
}

/// A peer whose stdout already reached end of file is not yet ended: the
/// close still has to send its stdin EOF and reach the escalation deadline.
#[cfg(unix)]
#[tokio::test]
async fn close_ends_a_peer_whose_stdout_already_closed() {
    let scratch = Scratch::new("close-stdout-eof");
    let command = script_peer(
        &scratch,
        "silent.sh",
        "trap '' TERM\nexec 1>&-\necho ready > ready.txt\n\
         while IFS= read -r line; do :; done",
    );
    let options = AcpConnectionOptions::new(command, scratch.path().to_string_lossy());
    let (connection, _events) = AcpConnection::connect(options)
        .await
        .expect("the peer starts");
    let pid = connection.pid().expect("the peer has a pid");
    wait_for_ready(&scratch, "ready.txt").await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !connection.closed() {
        assert!(Instant::now() < deadline, "stdout EOF never settled");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    connection.close();
    assert!(
        wait_for_peer_exit(pid, Duration::from_millis(1_000)).await,
        "a close after stdout EOF left the peer running"
    );
}

/// A peer must never outlive the process that started it. The stub exits on
/// stdin EOF, which would pass even without a guarantee, so this peer ignores
/// signals and never reads its stdin: only the kernel's parent-death signal can
/// end it when its owner is SIGKILLed.
#[cfg(target_os = "linux")]
#[test]
fn a_peer_dies_with_its_owner_process() {
    if let Ok(ready) = std::env::var("DEVBOARD_ACP_OWNER_READY") {
        owner_with_its_peer(&ready);
        return;
    }
    let scratch = Scratch::new("owner-death");
    let script = scratch.path().join("stubborn.sh");
    std::fs::write(
        &script,
        "trap '' TERM\necho ready > ready.txt\nwhile :; do sleep 1; done\n",
    )
    .expect("the peer script is written");
    let ready = scratch.path().join("owner.txt");
    let mut owner = std::process::Command::new(std::env::current_exe().expect("the test binary"))
        .args([
            "--exact",
            "a_peer_dies_with_its_owner_process",
            "--nocapture",
        ])
        .env("DEVBOARD_ACP_OWNER_READY", &ready)
        .env(
            "DEVBOARD_ACP_OWNER_COMMAND",
            format!("/bin/sh {}", script.display()),
        )
        .env("STATE_DIR", scratch.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("the owner starts");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() {
        assert!(
            Instant::now() < deadline,
            "the owner never reported its peer"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let peer: u32 = std::fs::read_to_string(&ready)
        .expect("the ready file")
        .trim()
        .parse()
        .expect("the peer pid");
    unsafe {
        libc::kill(owner.id() as i32, libc::SIGKILL);
    }
    let _ = owner.wait();
    let deadline = Instant::now() + Duration::from_secs(5);
    while peer_alive(peer) {
        if Instant::now() >= deadline {
            unsafe {
                libc::kill(peer as i32, libc::SIGKILL);
            }
            panic!("the peer outlived the owner that started it");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The owner process of [`a_peer_dies_with_its_owner_process`]: it opens one
/// connection, publishes the peer pid, and parks until the parent kills it.
#[cfg(target_os = "linux")]
fn owner_with_its_peer(ready: &str) {
    let command = std::env::var("DEVBOARD_ACP_OWNER_COMMAND").expect("the peer command");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the owner runtime");
    runtime.block_on(async move {
        let cwd = std::env::var("STATE_DIR")
            .unwrap_or_else(|_| devboard_root().to_string_lossy().into_owned());
        let options = AcpConnectionOptions::new(command, cwd);
        let (connection, _events) = AcpConnection::connect(options)
            .await
            .expect("the peer starts");
        let pid = connection.pid().expect("the peer has a pid");
        std::fs::write(ready, format!("{pid}\n")).expect("the ready file");
        loop {
            tokio::time::sleep(Duration::from_secs(3_600)).await;
        }
    });
}
