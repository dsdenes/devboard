//! Behavior proofs for the Rust ACP stub, driven through the ACP client the
//! server uses. Every turn speaks the same newline-delimited JSON-RPC frames
//! the TypeScript fixture speaks.

#[allow(dead_code)]
#[path = "../src/acp_stub.rs"]
mod acp_stub;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::acp::{
    AcpConnection, AcpConnectionOptions, AcpEvent, AcpId, AcpQuestion, PermissionPolicy,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;

fn devboard_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the devboard harness directory exists")
}

/// Runs the wired `acp-stub` subcommand of the built binary.
fn stub_command(arguments: &[String]) -> String {
    let mut command = env!("CARGO_BIN_EXE_devboard").to_string();
    command.push_str(" acp-stub");
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
            "acp-stub-{label}-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("scratch directory exists");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn write(&self, relative: &str, text: &str) -> PathBuf {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("fixture parent exists");
        }
        std::fs::write(&path, text).expect("fixture file is written");
        path
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

/// Runs one complete turn, then closes the peer and collects everything the
/// callback channel carried.
async fn run_turn(
    scratch: &Scratch,
    arguments: &[String],
    permission_policy: PermissionPolicy,
    prompt: &str,
) -> TurnOutcome {
    let log = scratch.path().join("agent.log");
    let mut arguments = arguments.to_vec();
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

async fn connect(
    scratch: &Scratch,
    arguments: &[String],
    permission_policy: PermissionPolicy,
) -> (
    Arc<AcpConnection>,
    mpsc::UnboundedReceiver<AcpEvent>,
    PathBuf,
) {
    let log = scratch.path().join("agent.log");
    let mut arguments = arguments.to_vec();
    arguments.push(format!("--log={}", log.display()));
    let options =
        AcpConnectionOptions::new(stub_command(&arguments), scratch.path().to_string_lossy())
            .with_permission_policy(permission_policy);
    let (connection, events) = AcpConnection::connect(options)
        .await
        .expect("the stub agent starts");
    (Arc::new(connection), events, log)
}

#[tokio::test]
async fn handshake_opens_the_session_and_streams_one_activity_line() {
    let scratch = Scratch::new("handshake");
    let outcome = run_turn(
        &scratch,
        &[],
        PermissionPolicy::Allow,
        "Hello from the Rust ACP test",
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    assert_eq!(outcome.result.unwrap()["stopReason"], "end_turn");
    assert_eq!(
        activity_texts(&outcome.events),
        vec!["Working on Hello from the Rust ACP test".to_string()]
    );
    assert!(outcome
        .events
        .iter()
        .any(|event| matches!(event, AcpEvent::SessionUpdate)));

    let lines: Vec<&str> = outcome.log.lines().collect();
    assert_eq!(lines.first().copied(), Some("session-new"));
    assert!(lines.iter().any(|line| line.starts_with("spawn ")));
    assert!(lines
        .iter()
        .any(|line| line.starts_with("argv ") && line.contains("--log=")));
    assert!(lines.contains(&"prompt Hello from the Rust ACP test"));
}

#[tokio::test]
async fn session_new_is_opened_with_the_given_mcp_servers() {
    let scratch = Scratch::new("mcp");
    let log = scratch.path().join("agent.log");
    let options = AcpConnectionOptions::new(
        stub_command(&[format!("--log={}", log.display())]),
        scratch.path().to_string_lossy(),
    )
    .with_mcp_servers(vec![devboard::acp::SessionMcpServer {
        name: "devboard".to_string(),
        command: "node".to_string(),
        args: vec!["server.js".to_string()],
        env: vec![devboard::acp::McpEnvVar {
            name: "TOKEN".to_string(),
            value: "secret".to_string(),
        }],
    }]);
    let (connection, mut events) = AcpConnection::connect(options)
        .await
        .expect("the stub agent starts");
    let result = tokio::time::timeout(Duration::from_secs(30), connection.run("Hello"))
        .await
        .expect("the turn settles")
        .expect("the prompt succeeds");
    assert_eq!(result["stopReason"], "end_turn");
    assert!(connection.has_session());
    assert_eq!(connection.session_id().as_deref(), Some("stub-session"));
    let argv: Vec<String> = connection.argv();
    assert!(argv.iter().any(|value| value == "acp-stub"));
    connection.close();
    drop(connection);
    let _ = drain_events(&mut events).await;
    let log = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(log.lines().any(|line| line == "session-new"));
}

#[tokio::test]
async fn questions_carry_the_fixture_schema_and_recommendation() {
    let scratch = Scratch::new("question");
    let (connection, mut events, log) = connect(
        &scratch,
        &["--questions=1".to_string()],
        PermissionPolicy::ReadOnly,
    )
    .await;
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
    let log = std::fs::read_to_string(log).unwrap_or_default();
    assert!(log.lines().any(|line| line == "answer Beta"));
}

#[tokio::test]
async fn questions_can_omit_the_recommended_default() {
    let scratch = Scratch::new("question-unrecommended");
    let (connection, mut events, _log) = connect(
        &scratch,
        &[
            "--questions=1".to_string(),
            "--questions-unrecommended".to_string(),
        ],
        PermissionPolicy::ReadOnly,
    )
    .await;
    let runner = tokio::spawn({
        let connection = Arc::clone(&connection);
        async move { connection.run("Hello").await }
    });
    let mut seen = Vec::new();
    let question = wait_for_question(&mut events, &mut seen).await;
    // The client marks the first option when the peer omits a default.
    assert!(question.options[0].recommended);
    assert!(!question.properties["value"]
        .as_object()
        .expect("the value property is an object")
        .contains_key("default"));
    assert!(connection.answer(&question.id, "Alpha").await);
    let _ = tokio::time::timeout(Duration::from_secs(30), runner)
        .await
        .expect("the turn settles")
        .expect("the runner joins")
        .expect("the prompt succeeds");
    connection.close();
}

#[tokio::test]
async fn create_and_revise_goal_write_the_fixture_bytes() {
    let scratch = Scratch::new("goal");
    let goal = scratch.write("goal.md", "# Original\n");

    let create = run_turn(
        &scratch,
        &[
            "--create-goal".to_string(),
            format!("--goal={}", goal.display()),
        ],
        PermissionPolicy::Deny,
        "/goal-outcome",
    )
    .await;
    assert!(create.result.is_ok(), "create failed: {:?}", create.result);
    assert_eq!(
        std::fs::read_to_string(&goal).unwrap_or_default(),
        "# Created goal\n\nThe agent wrote this."
    );
    assert!(create
        .log
        .lines()
        .any(|line| line == format!("created {}", goal.display())));
    assert!(activity_texts(&create.events).contains(&"Created the goal".to_string()));

    let revise = run_turn(
        &scratch,
        &[
            "--revise-goal".to_string(),
            format!("--goal={}", goal.display()),
        ],
        PermissionPolicy::Deny,
        "Revise the goal\n\nMake it shorter.",
    )
    .await;
    assert!(revise.result.is_ok(), "revise failed: {:?}", revise.result);
    assert_eq!(
        std::fs::read_to_string(&goal).unwrap_or_default(),
        "# Revised goal\n\nThe agent rewrote this."
    );
    assert!(revise
        .log
        .lines()
        .any(|line| line == format!("revised {}", goal.display())));
    assert!(revise
        .log
        .contains("request Revise the goal\n\nMake it shorter."));
}

#[tokio::test]
async fn prepare_skills_writes_the_managed_snapshot() {
    let scratch = Scratch::new("prepare-skills");
    let outcome = run_turn(
        &scratch,
        &["--prepare-skills".to_string()],
        PermissionPolicy::Allow,
        "/prepare-skills",
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);

    let expected = "---\nname: dependency-direction\ndescription: Choose dependency direction \
                    and boundary ownership for any layered design.\nmetadata:\n  devboard-managed: \
                    \"true\"\n---\n\n# Dependency direction\n\n- Always declare dependencies in \
                    one direction.\n- Keep policy separate from delivery and storage \
                    concerns.\n\n";
    assert_eq!(
        std::fs::read_to_string(
            scratch
                .path()
                .join(".omp/skills/dependency-direction/SKILL.md")
        )
        .unwrap_or_default(),
        expected
    );
    for name in [
        "cohesive-units",
        "behavior-first-testing",
        "dependency-direction",
    ] {
        assert!(
            scratch
                .path()
                .join(format!(".omp/skills/{name}/SKILL.md"))
                .is_file(),
            "{name} was not written"
        );
    }
    assert!(outcome.log.lines().any(|line| line == "prepared"));
    assert!(activity_texts(&outcome.events)
        .contains(&"Reviewed every installed skill; no contradictions".to_string()));
}

#[tokio::test]
async fn prepare_skills_empty_still_answers_the_turn() {
    let scratch = Scratch::new("prepare-skills-empty");
    let skill = scratch.write(".omp/skills/hand-written/SKILL.md", "# Hand written\n");
    let outcome = run_turn(
        &scratch,
        &[
            "--prepare-skills".to_string(),
            "--prepare-skills-empty".to_string(),
        ],
        PermissionPolicy::Allow,
        "/prepare-skills",
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    assert_eq!(
        std::fs::read_to_string(&skill).unwrap_or_default(),
        "# Hand written\n"
    );
    assert!(!scratch
        .path()
        .join(".omp/skills/dependency-direction")
        .exists());
    assert!(outcome.log.lines().any(|line| line == "prepared"));
}

#[tokio::test]
async fn prepare_skills_reports_unmanaged_writes() {
    let scratch = Scratch::new("prepare-skills-unmanaged");
    let outcome = run_turn(
        &scratch,
        &[
            "--prepare-skills".to_string(),
            "--prepare-skills-unmanaged-write".to_string(),
            "--prepare-skills-unmanaged-skill".to_string(),
        ],
        PermissionPolicy::Allow,
        "/prepare-skills",
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".omp/skills/house-style/extra.md"))
            .unwrap_or_default(),
        "# Extra\n\n- Added by the preparation peer.\n"
    );
    assert!(scratch
        .path()
        .join(".omp/skills/stray-style/SKILL.md")
        .is_file());
    assert!(outcome
        .log
        .lines()
        .any(|line| line == "unmanaged house-style/extra.md"));
    assert!(outcome
        .log
        .lines()
        .any(|line| line == "unmanaged stray-style/SKILL.md"));
}

#[tokio::test]
async fn permission_policies_cancel_or_grant_the_probe() {
    let deny_scratch = Scratch::new("permission-deny");
    let deny_probe = deny_scratch.path().join("probe.txt");
    let deny = run_turn(
        &deny_scratch,
        &[format!("--permission-probe={}", deny_probe.display())],
        PermissionPolicy::Deny,
        "Please write the probe.",
    )
    .await;
    assert!(deny.result.is_ok(), "deny turn failed: {:?}", deny.result);
    assert!(!deny_probe.exists());
    assert!(deny.log.contains("permission cancelled"));

    let read_only_scratch = Scratch::new("permission-read-only");
    let read_only_probe = read_only_scratch.path().join("probe.txt");
    let read_only = run_turn(
        &read_only_scratch,
        &[format!("--permission-probe={}", read_only_probe.display())],
        PermissionPolicy::ReadOnly,
        "Please write the probe.",
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
        &[format!("--permission-probe={}", allow_probe.display())],
        PermissionPolicy::Allow,
        "Please write the probe.",
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
async fn discover_stages_the_sheet_glossary_contribution_and_skills() {
    let scratch = Scratch::new("discover");
    scratch.write("README.md", "# A\n");
    scratch.write("package.json", "{\"name\":\"x\"}\n");
    std::fs::create_dir_all(scratch.path().join("src")).expect("source directory exists");
    std::fs::create_dir_all(scratch.path().join("test")).expect("test directory exists");
    std::fs::create_dir_all(scratch.path().join(".github/workflows"))
        .expect("workflow directory exists");

    let (connection, mut events, log) = connect(
        &scratch,
        &["--discover".to_string()],
        PermissionPolicy::Allow,
    )
    .await;
    let sheet_dir = scratch.path().join(".omp/discover/staging/sheet-run");
    let sheet = tokio::time::timeout(
        Duration::from_secs(30),
        connection.run(&format!("/discover-sheet {}", sheet_dir.display())),
    )
    .await
    .expect("the sheet turn settles")
    .expect("the sheet turn succeeds");
    assert_eq!(sheet["stopReason"], "end_turn");

    let staged_sheet: Value = serde_json::from_str(
        &std::fs::read_to_string(sheet_dir.join("sheet.json")).expect("sheet.json exists"),
    )
    .expect("the sheet is JSON");
    assert_eq!(staged_sheet["schemaVersion"], json!(1));
    assert_eq!(
        staged_sheet["definition"]["value"],
        json!("A fixture host with a small order domain used to verify the Discover crawl.")
    );
    assert_eq!(staged_sheet["stack"]["value"], json!(["Bun", "TypeScript"]));
    assert_eq!(staged_sheet["stack"]["evidence"], json!(["package.json"]));
    assert_eq!(staged_sheet["stack"]["confidence"], json!("declared"));
    assert_eq!(
        staged_sheet["architecture"]["contexts"]["value"][0]["name"],
        json!("Checkout")
    );
    assert_eq!(
        staged_sheet["testing"]["levels"]["value"][0]["command"],
        json!("npm run test:unit")
    );

    let glossary_dir = scratch
        .path()
        .join(".omp/discover/staging/discover-glossary-run");
    tokio::time::timeout(
        Duration::from_secs(30),
        connection.prompt(&format!("/discover-glossary {}", glossary_dir.display())),
    )
    .await
    .expect("the glossary turn settles")
    .expect("the glossary turn succeeds");
    let glossary = std::fs::read_to_string(glossary_dir.join("glossary/orders.glossary.yaml"))
        .expect("the glossary exists");
    let expected_definition =
        "A fixture host with a small order domain used to verify the Discover crawl names one customer order request.";
    assert!(glossary.starts_with(
        "boundedContext: orders\ntitles:\n  - language: en\n    text: \
                                   \"Orders\"\nconcepts:\n  - id: order\n"
    ));
    assert!(glossary.contains(&format!(
        "    definitions:\n      - language: en\n        text: {}\n",
        json!(expected_definition)
    )));
    assert!(glossary.contains(
        "        text: \"A fixture host with a small order domain used \
                                to verify the Discover crawl sums the lines of one order.\"\n"
    ));
    assert!(glossary.contains("    status: proposed\n    origin: llm\n"));
    assert!(glossary.contains("      - \"code:README.md\"\n"));
    assert!(glossary.contains("      - \"code:package.json\"\n"));
    assert!(glossary.ends_with("    broader: null\n    related: []\n"));

    let significance: Value = serde_json::from_str(
        &std::fs::read_to_string(glossary_dir.join("glossary/significance.json"))
            .expect("the significance sidecar exists"),
    )
    .expect("the sidecar is JSON");
    assert_eq!(
        significance,
        json!({
            "schemaVersion": 1,
            "contexts": {
                "orders": {
                    "order": {
                        "score": 80,
                        "reason": "Every fixture checkout creates one order record.",
                    },
                    "option": {
                        "score": 10,
                        "reason": "A framework option token, not a domain term.",
                    },
                    "order-total": {
                        "score": 90,
                        "reason": "The order total is the domain's central summed value.",
                    },
                },
            },
        })
    );

    let contribution_dir = scratch
        .path()
        .join(".omp/discover/staging/discover-contribution-run");
    tokio::time::timeout(
        Duration::from_secs(30),
        connection.prompt(&format!(
            "/discover-contribution {}",
            contribution_dir.display()
        )),
    )
    .await
    .expect("the contribution turn settles")
    .expect("the contribution turn succeeds");
    let contribution: Value = serde_json::from_str(
        &std::fs::read_to_string(contribution_dir.join("contribution.json"))
            .expect("contribution.json exists"),
    )
    .expect("the contribution is JSON");
    assert_eq!(contribution["schemaVersion"], json!(1));
    assert_eq!(contribution["source"]["forge"], json!("gitea"));
    assert_eq!(contribution["source"]["host"], json!("localhost"));
    assert_eq!(
        contribution["source"]["window"],
        json!({ "from": "2026-02-01T08:00:00.000Z", "to": "2026-05-04T10:00:00.000Z" })
    );
    assert_eq!(
        contribution["source"]["closedUnmergedPullRequests"],
        json!([10])
    );
    assert_eq!(
        contribution["source"]["mergedPullRequests"]
            .as_array()
            .expect("merged pull requests are a list")
            .len(),
        4
    );
    assert_eq!(
        contribution["source"]["mergedPullRequests"][0]["files"],
        json!(["src/order.ts", "test/order.test.ts"])
    );

    for agent in [
        "discover-testing-strategy",
        "discover-naming-conventions",
        "discover-coding-conventions",
        "discover-architecture-boundaries",
    ] {
        let directory = scratch
            .path()
            .join(format!(".omp/discover/staging/{agent}-run"));
        tokio::time::timeout(
            Duration::from_secs(30),
            connection.prompt(&format!("/{agent} {}", directory.display())),
        )
        .await
        .unwrap_or_else(|_| panic!("the {agent} turn settles"))
        .unwrap_or_else(|error| panic!("the {agent} turn succeeds: {error}"));
    }
    for agent in [
        "discover-testing-strategy",
        "discover-naming-conventions",
        "discover-coding-conventions",
        "discover-architecture-boundaries",
        "discover-glossary",
        "discover-contribution",
    ] {
        let path = scratch.path().join(format!(
            ".omp/discover/staging/{agent}-run/skills/{agent}/SKILL.md"
        ));
        let skill = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{agent} was not staged: {error}"));
        assert!(skill.starts_with(&format!("---\nname: {agent}\ndescription: ")));
        assert!(skill.contains(
            "metadata:\n  devboard-managed: \"true\"\n  devboard-family: \
                                \"discover\"\n"
        ));
        assert!(skill.contains("# "));
    }
    let glossary_skill = std::fs::read_to_string(
        scratch
            .path()
            .join(".omp/discover/staging/discover-glossary-run/skills/discover-glossary/SKILL.md"),
    )
    .expect("the glossary skill exists");
    assert!(glossary_skill.contains(
        "devboard-skill: glossary\n---\n\n# Glossary\n\n- Treat \
                                     .omp/discover/glossary/orders.glossary.yaml"
    ));

    connection.close();
    drop(connection);
    let _ = drain_events(&mut events).await;
    let log = std::fs::read_to_string(log).unwrap_or_default();
    assert!(log
        .lines()
        .any(|line| line.starts_with("prompt /discover-sheet ")));
}

#[tokio::test]
async fn discover_variants_stage_the_recorded_defects() {
    let scratch = Scratch::new("discover-defects");
    scratch.write("README.md", "# A\n");
    scratch.write("package.json", "{\"name\":\"x\"}\n");
    let (connection, mut events, _log) = connect(
        &scratch,
        &[
            "--discover".to_string(),
            "--discover-invalid-sheet".to_string(),
            "--discover-sheet-secret".to_string(),
            "--discover-significance=extra-concept".to_string(),
            "--discover-contribution-no-forge".to_string(),
        ],
        PermissionPolicy::Allow,
    )
    .await;
    let sheet_dir = scratch.path().join(".omp/discover/staging/defect-sheet");
    tokio::time::timeout(
        Duration::from_secs(30),
        connection.run(&format!("/discover-sheet {}", sheet_dir.display())),
    )
    .await
    .expect("the sheet turn settles")
    .expect("the sheet turn succeeds");
    let sheet: Value = serde_json::from_str(
        &std::fs::read_to_string(sheet_dir.join("sheet.json")).expect("sheet exists"),
    )
    .expect("sheet is JSON");
    assert_eq!(sheet["stack"]["value"], json!(["x".repeat(200)]));
    assert_eq!(
        sheet["deployment"]["artifact"]["value"],
        json!("ghp_0123456789abcdefghijklmnopqrstuvwxyz")
    );

    let glossary_dir = scratch.path().join(".omp/discover/staging/defect-glossary");
    tokio::time::timeout(
        Duration::from_secs(30),
        connection.prompt(&format!("/discover-glossary {}", glossary_dir.display())),
    )
    .await
    .expect("the glossary turn settles")
    .expect("the glossary turn succeeds");
    let significance: Value = serde_json::from_str(
        &std::fs::read_to_string(glossary_dir.join("glossary/significance.json"))
            .expect("sidecar exists"),
    )
    .expect("sidecar is JSON");
    assert_eq!(
        significance["contexts"]["orders"]["ghost-term"]["score"],
        json!(50)
    );

    let contribution_dir = scratch
        .path()
        .join(".omp/discover/staging/defect-contribution");
    tokio::time::timeout(
        Duration::from_secs(30),
        connection.prompt(&format!(
            "/discover-contribution {}",
            contribution_dir.display()
        )),
    )
    .await
    .expect("the contribution turn settles")
    .expect("the contribution turn succeeds");
    let contribution: Value = serde_json::from_str(
        &std::fs::read_to_string(contribution_dir.join("contribution.json"))
            .expect("contribution exists"),
    )
    .expect("contribution is JSON");
    assert_eq!(contribution["source"]["forge"], Value::Null);
    assert_eq!(contribution["source"]["mergedPullRequests"], json!([]));
    let skill =
        std::fs::read_to_string(contribution_dir.join("skills/discover-contribution/SKILL.md"))
            .expect("contribution skill exists");
    assert!(skill.contains("No forge credential or network was available for the target."));
    connection.close();
    drop(connection);
    let _ = drain_events(&mut events).await;
}

#[tokio::test]
async fn implementation_lane_activity_question_blocker_and_close() {
    let scratch = Scratch::new("lane");
    let tracker = scratch.write(
        "tracker.json",
        "[{\"number\":5,\"title\":\"Five\",\"url\":\"https://fixture.test/issues/5\"},\
         {\"number\":6,\"title\":\"Six\",\"url\":\"https://fixture.test/issues/6\"}]\n",
    );
    let (connection, mut events, log) = connect(
        &scratch,
        &[
            format!("--fixture-tracker={}", tracker.display()),
            "--lane-activity=5:Custom-lane".to_string(),
        ],
        PermissionPolicy::Allow,
    )
    .await;
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        connection.run("/implement-next-epic 5"),
    )
    .await
    .expect("the lane turn settles")
    .expect("the lane turn succeeds");
    assert_eq!(result["stopReason"], "end_turn");
    let tracked: Value =
        serde_json::from_str(&std::fs::read_to_string(&tracker).expect("tracker exists"))
            .expect("tracker is JSON");
    assert_eq!(tracked.as_array().expect("tracker is a list").len(), 1);
    assert_eq!(tracked[0]["number"], json!(6));
    connection.close();
    drop(connection);
    let seen = drain_events(&mut events).await;
    assert_eq!(activity_texts(&seen), vec!["Custom-lane".to_string()]);
    let log = std::fs::read_to_string(log).unwrap_or_default();
    assert!(log.lines().any(|line| line == "closed 5"));

    let scratch = Scratch::new("lane-blocked");
    let tracker = scratch.write(
        "tracker.json",
        "[{\"number\":5,\"title\":\"Five\",\"url\":\"https://fixture.test/issues/5\"}]\n",
    );
    let (connection, mut events, log) = connect(
        &scratch,
        &[
            format!("--fixture-tracker={}", tracker.display()),
            "--blocker-epic=5".to_string(),
            "--question-epic=5".to_string(),
        ],
        PermissionPolicy::ReadOnly,
    )
    .await;
    let runner = tokio::spawn({
        let connection = Arc::clone(&connection);
        async move { connection.run("/implement-next-epic").await }
    });
    let mut seen = Vec::new();
    let question = wait_for_question(&mut events, &mut seen).await;
    assert!(connection.answer(&question.id, "Alpha").await);
    let result = tokio::time::timeout(Duration::from_secs(30), runner)
        .await
        .expect("the lane turn settles")
        .expect("the runner joins")
        .expect("the lane turn succeeds");
    assert_eq!(result["stopReason"], "end_turn");
    connection.close();
    drop(connection);
    seen.extend(drain_events(&mut events).await);
    assert_eq!(
        activity_texts(&seen),
        vec![
            "Working on epic 5".to_string(),
            "Answer received: Alpha".to_string(),
            "DEVBOARD-BLOCKED: fixture blocker for epic 5".to_string(),
        ]
    );
    let tracked: Value =
        serde_json::from_str(&std::fs::read_to_string(&tracker).expect("tracker exists"))
            .expect("tracker is JSON");
    assert_eq!(tracked.as_array().expect("tracker is a list").len(), 1);
    let log = std::fs::read_to_string(log).unwrap_or_default();
    assert!(log.lines().any(|line| line == "blocked 5"));
}

#[tokio::test]
async fn generation_lane_files_the_configured_epics() {
    let scratch = Scratch::new("generation");
    let tracker = scratch.write("tracker.json", "[]\n");
    let (connection, mut events, log) = connect(
        &scratch,
        &[
            format!("--fixture-tracker={}", tracker.display()),
            "--generate-epic=7:Seven".to_string(),
            "--generate-epic=8:Eight".to_string(),
        ],
        PermissionPolicy::Allow,
    )
    .await;
    tokio::time::timeout(Duration::from_secs(30), connection.run("/epic-next"))
        .await
        .expect("the generation turn settles")
        .expect("the generation turn succeeds");
    connection.close();
    drop(connection);
    let seen = drain_events(&mut events).await;
    assert_eq!(
        activity_texts(&seen),
        vec![
            "Choosing the next epics".to_string(),
            "Filed epic 7".to_string(),
            "Filed epic 8".to_string(),
        ]
    );
    let tracked: Value =
        serde_json::from_str(&std::fs::read_to_string(&tracker).expect("tracker exists"))
            .expect("tracker is JSON");
    assert_eq!(tracked[0]["url"], json!("https://fixture.test/issues/7"));
    assert_eq!(tracked[1]["title"], json!("Eight"));
    let log = std::fs::read_to_string(log).unwrap_or_default();
    assert!(log.lines().any(|line| line == "filed 7"));
    assert_eq!(
        std::fs::read_to_string(format!("{}.generation-count", tracker.display()))
            .unwrap_or_default(),
        "2\n"
    );
}

fn git_run(directory: &Path, arguments: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {arguments:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn seed_git_repository(directory: &Path) {
    let init = std::process::Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .current_dir(directory)
        .output()
        .expect("git init runs");
    assert!(init.status.success(), "git init failed");
    std::fs::write(directory.join("README.md"), "# Fixture\n").expect("README exists");
    git_run(directory, &["config", "user.name", "Test"]);
    git_run(directory, &["config", "user.email", "test@example.test"]);
    git_run(directory, &["config", "commit.gpgsign", "false"]);
    git_run(directory, &["add", "-A"]);
    git_run(directory, &["commit", "-qm", "init"]);
}

fn text_events(events: &[AcpEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            AcpEvent::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn flow_goal_interviews_then_writes_the_goal() {
    let scratch = Scratch::new("flow-goal");
    let directory = scratch.path().join("flow-goal-run");
    let (connection, mut events, log) = connect(
        &scratch,
        &["--flow-goal".to_string()],
        PermissionPolicy::ReadOnly,
    )
    .await;
    let runner = tokio::spawn({
        let connection = Arc::clone(&connection);
        let prompt = format!("/flow-goal {}", directory.display());
        async move { connection.run(&prompt).await }
    });
    let mut seen = Vec::new();
    let question = wait_for_question(&mut events, &mut seen).await;
    assert_eq!(question.message, "Choose an answer");
    assert!(connection.answer(&question.id, "Beta").await);
    let result = tokio::time::timeout(Duration::from_secs(30), runner)
        .await
        .expect("the flow goal turn settles")
        .expect("the runner joins")
        .expect("the flow goal turn succeeds");
    assert_eq!(result["stopReason"], "end_turn");
    connection.close();
    drop(connection);
    seen.extend(drain_events(&mut events).await);
    assert_eq!(
        std::fs::read_to_string(directory.join("goal.md")).unwrap_or_default(),
        "# Flow goal\n\nMake the fixture behavior observable."
    );
    assert_eq!(
        activity_texts(&seen),
        vec![
            "Interviewing the developer about the Flow goal".to_string(),
            "Answer received: Beta".to_string(),
            "Wrote the Flow goal".to_string(),
        ]
    );
    let log = std::fs::read_to_string(log).unwrap_or_default();
    assert!(log
        .lines()
        .any(|line| line == format!("flow-goal {}", directory.display())));
    assert!(log
        .lines()
        .any(|line| line == format!("flow-goal-written {}", directory.display())));
}

#[tokio::test]
async fn flow_goal_empty_and_text_file_variants_are_honored() {
    let scratch = Scratch::new("flow-goal-empty");
    let directory = scratch.path().join("flow-empty");
    let outcome = run_turn(
        &scratch,
        &["--flow-goal".to_string(), "--flow-goal-empty".to_string()],
        PermissionPolicy::Deny,
        &format!("/flow-goal {}", directory.display()),
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    assert_eq!(
        std::fs::read_to_string(directory.join("goal.md")).unwrap_or_default(),
        ""
    );

    let scratch = Scratch::new("flow-goal-text");
    let directory = scratch.path().join("flow-text");
    let source = scratch.write("goal-source.md", "# From file\n");
    let outcome = run_turn(
        &scratch,
        &[
            "--flow-goal".to_string(),
            format!("--flow-goal-text-file={}", source.display()),
        ],
        PermissionPolicy::Deny,
        &format!("/flow-goal {}", directory.display()),
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    assert_eq!(
        std::fs::read_to_string(directory.join("goal.md")).unwrap_or_default(),
        "# From file\n"
    );
}

#[tokio::test]
async fn flow_implementation_commits_checkpoints() {
    let scratch = Scratch::new("flow-implement");
    seed_git_repository(scratch.path());
    let directory = scratch.path().join("flow-run");
    std::fs::create_dir_all(&directory).expect("flow directory exists");
    std::fs::write(directory.join("decisions.md"), "decision one\n").expect("decisions exist");
    std::fs::write(
        directory.join("steering.jsonl"),
        "{\"id\":\"s1\",\"text\":\"prefer smaller units\"}\n",
    )
    .expect("steering exists");

    let outcome = run_turn(
        &scratch,
        &[
            "--flow-implement".to_string(),
            "--flow-checkpoints=2".to_string(),
        ],
        PermissionPolicy::Deny,
        &format!("/flow-implement {}", directory.display()),
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    assert_eq!(
        activity_texts(&outcome.events),
        vec![
            "Reading the plan".to_string(),
            "Committed checkpoint 1".to_string(),
            "Committed checkpoint 2".to_string(),
        ]
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("src/app.txt")).unwrap_or_default(),
        "version 2\n"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("src/config.json")).unwrap_or_default(),
        "{\n  \"version\": 2\n}\n"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("src/extra-2.txt")).unwrap_or_default(),
        "extra 2\n"
    );
    let verification: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("verification.json")).expect("verification exists"),
    )
    .expect("verification is JSON");
    assert_eq!(verification["command"], json!("bun test"));
    assert_eq!(verification["status"], json!("passed"));
    assert_eq!(
        verification["output"],
        json!("0 failing tests: fixture verification passed\n")
    );
    let checkpoints: Vec<Value> = std::fs::read_to_string(directory.join("checkpoints.jsonl"))
        .expect("checkpoints exist")
        .lines()
        .map(|line| serde_json::from_str(line).expect("checkpoint is JSON"))
        .collect();
    assert_eq!(checkpoints.len(), 2);
    assert_eq!(checkpoints[0]["id"], json!("cp-1"));
    assert_eq!(checkpoints[0]["files"], json!(2));
    assert_eq!(checkpoints[1]["files"], json!(3));
    assert_eq!(checkpoints[1]["verification"], json!("passed"));
    let steering =
        std::fs::read_to_string(scratch.path().join("steering-applied.txt")).unwrap_or_default();
    assert_eq!(steering, "prefer smaller units\n");
    let acked = std::fs::read_to_string(directory.join("steering-ack.jsonl")).unwrap_or_default();
    assert_eq!(acked, "{\"id\":\"s1\"}\n");

    let count = std::process::Command::new("git")
        .arg("-C")
        .arg(scratch.path())
        .args(["rev-list", "--count", "HEAD"])
        .output()
        .expect("git rev-list runs");
    assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "3");

    let log = outcome.log;
    assert!(log.lines().any(|line| line == "flow-decisions-read 1 13"));
    assert!(log.lines().any(|line| line == "flow-decisions-read 2 13"));
    assert!(log.lines().any(|line| line == "flow-steering-read 1"));
    assert!(log.lines().any(|line| line == "flow-ack s1"));
    assert!(log
        .lines()
        .any(|line| line.starts_with("flow-checkpoint 1 ")));
    assert!(log
        .lines()
        .any(|line| line.starts_with("flow-checkpoint 2 ")));
}

#[tokio::test]
async fn flow_implementation_reports_blockers_and_blocker_lines() {
    let scratch = Scratch::new("flow-blocked");
    seed_git_repository(scratch.path());
    let directory = scratch.path().join("flow-run");
    let outcome = run_turn(
        &scratch,
        &[
            "--flow-implement".to_string(),
            "--flow-blocked".to_string(),
            "--flow-blocker-line=first-halt".to_string(),
            "--flow-blocker-line=second-halt".to_string(),
        ],
        PermissionPolicy::Deny,
        &format!("/flow-implement {}", directory.display()),
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    assert!(activity_texts(&outcome.events).contains(
        &"DEVBOARD-BLOCKED: the fixture cannot continue past this checkpoint".to_string()
    ));
    assert!(activity_texts(&outcome.events).contains(&"DEVBOARD-BLOCKED: first-halt".to_string()));
    assert!(activity_texts(&outcome.events).contains(&"DEVBOARD-BLOCKED: second-halt".to_string()));
    let blockers =
        std::fs::read_to_string(directory.join("blockers.jsonl")).expect("blockers exist");
    let blocker: Value = serde_json::from_str(blockers.lines().next().expect("one blocker"))
        .expect("blocker is JSON");
    assert_eq!(blocker["id"], json!("blocker-fixture"));
    assert_eq!(
        blocker["text"],
        json!("the fixture cannot continue past this checkpoint")
    );
    assert!(outcome
        .log
        .lines()
        .any(|line| line == "flow-blocker 1 first-halt"));
    assert!(outcome
        .log
        .lines()
        .any(|line| line == "flow-blocker 2 second-halt"));
}

#[tokio::test]
async fn flow_change_writes_the_widget_sections() {
    let scratch = Scratch::new("flow-change");
    let directory = scratch.path().join("change-run");
    std::fs::create_dir_all(&directory).expect("change directory exists");
    std::fs::write(
        directory.join("request.json"),
        "{\"files\":[{\"path\":\"src/a.ts\"},{\"path\":\"src/b.ts\"},{\"path\":\"src/c.ts\"}]}\n",
    )
    .expect("request exists");
    let outcome = run_turn(
        &scratch,
        &["--flow-change".to_string()],
        PermissionPolicy::Deny,
        &format!("/flow-change {}", directory.display()),
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    let widgets: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("widgets.json")).expect("widgets exist"),
    )
    .expect("widgets is JSON");
    assert_eq!(
        widgets,
        json!({
            "widgets": [
                {
                    "category": "contract",
                    "concept": "Application contract",
                    "summary": "The application's observable contract changed.",
                    "rationale": "Callers observe a different result.",
                    "files": ["src/a.ts"],
                },
                {
                    "category": "data",
                    "concept": "Stored configuration",
                    "summary": "The stored configuration changed.",
                    "rationale": "Persisted values have a new shape.",
                    "files": ["src/b.ts", "src/c.ts"],
                },
            ],
        })
    );
    assert_eq!(outcome.log.lines().last(), Some("flow-widgets 2"));
}

#[tokio::test]
async fn flow_widget_asks_and_the_conversation_stays_read_only() {
    let scratch = Scratch::new("flow-widget");
    let (connection, mut events, log) = connect(
        &scratch,
        &["--flow-widget".to_string()],
        PermissionPolicy::Deny,
    )
    .await;
    tokio::time::timeout(
        Duration::from_secs(30),
        connection.run("/flow-widget widget-1 revision-two"),
    )
    .await
    .expect("the widget turn settles")
    .expect("the widget turn succeeds");
    tokio::time::timeout(
        Duration::from_secs(30),
        connection.prompt("Why is this read-only?"),
    )
    .await
    .expect("the conversation turn settles")
    .expect("the conversation turn succeeds");
    connection.close();
    drop(connection);
    let seen = drain_events(&mut events).await;
    assert_eq!(
        activity_texts(&seen),
        vec![
            "Reviewing the widget and its diff".to_string(),
            "Answer received: ".to_string(),
            "The widget conversation is read-only".to_string(),
            "Developer: Why is this read-only?".to_string(),
        ]
    );
    let log = std::fs::read_to_string(log).unwrap_or_default();
    assert!(log
        .lines()
        .any(|line| line == "flow-widget widget-1 revision-two"));
}

#[tokio::test]
async fn goal_draft_writes_the_spec_and_removes_the_draft() {
    let scratch = Scratch::new("goal-draft");
    let draft = scratch.write("draft-goal.md", "# Draft\n\nReport body.\n");
    let outcome = run_turn(
        &scratch,
        &["--goal-draft".to_string()],
        PermissionPolicy::Deny,
        "/goal-draft draft-goal.md",
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    assert!(!draft.exists());
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(".devboard/goals/draft-goal.md"))
            .unwrap_or_default(),
        "## Objective\n\nFinalized draft-goal.\n\n## Success criteria\n\n- The stub wrote this \
         spec.\n\n## Verification\n\n- Read this file.\n\n## Boundaries\n\n- The fixture \
         only.\n\n## Stop conditions\n\n- Halt on a missing prerequisite.\n"
    );
    assert_eq!(
        activity_texts(&outcome.events),
        vec![
            "Reading the draft and researching the repository draft-goal.md".to_string(),
            "Filed the goal issue and verified the goal label".to_string(),
        ]
    );
    assert!(outcome
        .log
        .lines()
        .any(|line| line == "goal-draft draft-goal.md"));
    assert!(outcome
        .log
        .lines()
        .any(|line| line == "goal-draft-verified draft-goal.md"));
}

#[tokio::test]
async fn prompt_chat_proposes_a_replacement_without_writing() {
    let scratch = Scratch::new("prompt-chat");
    let prompt = "## Operator request\nRewrite the base prompt.\n<<<PROMPT\nBase prompt text.\n\
                  Second line.\nPROMPT>>>\n";
    let outcome = run_turn(
        &scratch,
        &["--chat-discover".to_string()],
        PermissionPolicy::Deny,
        prompt,
    )
    .await;
    assert!(outcome.result.is_ok(), "turn failed: {:?}", outcome.result);
    let activities = activity_texts(&outcome.events);
    assert_eq!(activities.len(), 2);
    assert_eq!(activities[0], "Here is the revision.");
    assert!(activities[1].contains("<prompt-file>"));
    let text = text_events(&outcome.events);
    assert!(text.contains("<prompt-file>"));
    assert!(text.contains("Base prompt text.\nSecond line."));
    assert!(text.contains("<!-- revised by the verification peer -->"));
    assert!(outcome.log.lines().any(|line| line == "prompt-chat"));
}

#[tokio::test]
async fn provider_environment_logs_fingerprints_without_keys() {
    let scratch = Scratch::new("provider-env");
    let provider_log = scratch.path().join("provider.jsonl");
    let mut environment: std::collections::HashMap<String, String> = std::env::vars().collect();
    environment.insert(
        "OPENCODE_API_KEY".to_string(),
        "opencode-secret".to_string(),
    );
    environment.insert("OPENROUTER_API_KEY".to_string(), String::new());
    environment.insert(
        "PI_CODING_AGENT_DIR".to_string(),
        "/tmp/agent-dir".to_string(),
    );
    let log = scratch.path().join("agent.log");
    let options = AcpConnectionOptions::new(
        stub_command(&[
            format!("--provider-env={}", provider_log.display()),
            format!("--log={}", log.display()),
        ]),
        scratch.path().to_string_lossy(),
    )
    .with_env(environment)
    .with_permission_policy(PermissionPolicy::Allow);
    let (connection, mut events) = AcpConnection::connect(options)
        .await
        .expect("the stub agent starts");
    tokio::time::timeout(Duration::from_secs(30), connection.run("Hello"))
        .await
        .expect("the turn settles")
        .expect("the prompt succeeds");
    connection.close();
    drop(connection);
    let _ = drain_events(&mut events).await;
    let line = std::fs::read_to_string(&provider_log).expect("the provider log exists");
    let record: Value = serde_json::from_str(line.trim()).expect("the provider log is JSON");
    assert!(record["pid"].as_u64().unwrap_or(0) > 0);
    assert_eq!(record["agentDir"], json!("/tmp/agent-dir"));
    assert_eq!(record["opencode"], json!("35fa42698e98e42f"));
    assert_eq!(record["openrouter"], json!("e3b0c44298fc1c14"));
    assert!(record["argv"]
        .as_array()
        .expect("argv is a list")
        .iter()
        .any(|value| value
            .as_str()
            .is_some_and(|text| text.starts_with("--provider-env="))));
    assert!(record["cwd"]
        .as_str()
        .is_some_and(|cwd| cwd.contains("acp-stub-provider-env")));
    assert!(!line.contains("opencode-secret"));
}
