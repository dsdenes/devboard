//! The API Standards, Dead Code, and Single Responsibility workers: one full
//! cycle each over a fixture checkout, their caps and settings, the drain
//! paths, the durable files, the lock release, preflight refusals, and the
//! CLI exit codes.
//!
//! Every forge and every agent is injected, so no test contacts a network.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use devboard::workers::api_standards as api;
use devboard::workers::dead_code as dead;
use devboard::workers::single_responsibility as srp;

const VERSION: &str = "test";

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    state_dir: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let index = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("the crate sits inside the harness")
            .join(".test-tmp")
            .join(format!(
                "audit-workers-{label}-{}-{index}",
                std::process::id()
            ));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let state_dir = repo.join(".devboard").join(".tmp").join("state");
        std::fs::create_dir_all(&state_dir).expect("a fixture state directory");
        Self {
            root,
            repo,
            state_dir,
        }
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.repo.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("a fixture directory");
        }
        std::fs::write(path, text).expect("a fixture file");
    }

    fn api_inputs(&self) {
        self.write(
            ".devboard/crates/devboard/src/http.rs",
            concat!(
                "use axum::http::{HeaderMap, Method};\n",
                "\n",
                "async fn handle(server: Arc<Server>, uri: Uri, method: Method) -> Response {\n",
                "    match uri.path() {\n",
                "        \"/api/ready\" => {\n",
                "            if *method != Method::GET && *method != Method::HEAD {\n",
                "                return reply(Replies::problem(&headers, 405, \"GET only.\", &[(\"Allow\", \"GET\")]));\n",
                "            }\n",
                "            return reply(ready(&headers, &method));\n",
                "        }\n",
                "        \"/feedback\" => {\n",
                "            return reply(server.app.feedback(&method, &headers).await);\n",
                "        }\n",
                "        \"/ws\" => {\n",
                "            if method != Method::GET {\n",
                "                return reply(Replies::problem(&headers, 405, \"GET only.\", &[(\"Allow\", \"GET\")]));\n",
                "            }\n",
                "            return reply(upgrade(server.clone()).await);\n",
                "        }\n",
                "        _ => {}\n",
                "    }\n",
                "    if let Some(name) = uri.path().strip_prefix(\"/api/ready/\") {\n",
                "        return reply(draft_answer(&server, name, &method, &headers));\n",
                "    }\n",
                "    static_file(&server, &relative, &method, &headers)\n",
                "}\n",
                "\n",
                "fn draft_answer(server: &Arc<Server>, name: &str, method: &Method, headers: &HeaderMap) -> Response {\n",
                "    if *method != Method::GET && *method != Method::HEAD {\n",
                "        return Replies::problem(headers, 405, \"GET only.\", &[(\"Allow\", \"GET\")]);\n",
                "    }\n",
                "    Replies::json(headers, Value::Null, 200, &[])\n",
                "}\n",
            ),
        );
        self.write(
            ".devboard/crates/devboard/src/app.rs",
            concat!(
                "use axum::http::{HeaderMap, Method};\n",
                "\n",
                "impl App {\n",
                "    /// `POST /feedback`.\n",
                "    pub async fn feedback(&self, method: &Method, headers: &HeaderMap) -> Response {\n",
                "        if *method != Method::POST {\n",
                "            return Replies::problem(headers, 405, \"POST only.\", &[(\"Allow\", \"POST\")]);\n",
                "        }\n",
                "        Replies::json(headers, Value::Null, 201, &[])\n",
                "    }\n",
                "}\n",
            ),
        );
        self.write(
            ".devboard/crates/devboard/src/journal.rs",
            "pub fn write(text: &str) {\n    let _ = text;\n}\n",
        );
        self.write(
            ".omp/skills/devboard-restful-api-implementation/SKILL.md",
            "# RESTful API Implementation\n\nAudit the HTTP API.\n",
        );
        self.write(
            ".omp/skills/devboard-restful-api-implementation/references/zalando-rest-rules.md",
            concat!(
                "## URLs\n\n",
                "| Rule | Level | Directive |\n| --- | --- | --- |\n",
                "| 129 | SHOULD | Write path segments in lower-case kebab-case. |\n\n",
                "## HTTP requests\n\n",
                "| Rule | Level | Directive |\n| --- | --- | --- |\n",
                "| 148 | MUST | Use HTTP methods according to RFC 9110. |\n",
                "| 100 | MAY | Offer an optional OpenAPI document. |\n",
            ),
        );
    }

    fn srp_inputs(&self) -> String {
        let skill = srp_skill();
        self.write(
            ".omp/skills/devboard-single-responsibility-principle/SKILL.md",
            &skill,
        );
        self.write(
            "src/handler.ts",
            "export const handle = 1;\nexport const parse = 2;\n",
        );
        self.write("src/renderer.ts", "export const renderRow = 1;\n");
        skill
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn srp_skill() -> String {
    [
        "# Single Responsibility Principle",
        "",
        "## Architectural Violations",
        "",
        "- **Mixed responsibilities:** A function, class, or module performs operations belonging to conceptually unrelated concerns.",
        "- **Divergent change:** A component requires modifications for multiple independent reasons.",
        "- **Accidental aggregation:** Unrelated functionality is grouped together for convenience rather than shared responsibility.",
        "- **Responsibility leakage:** A component implements behavior that belongs to another component's responsibility.",
        "- **Artificial fragmentation:** A cohesive responsibility is unnecessarily split into trivial components without establishing meaningful separation.",
        "",
    ]
    .join("\n")
}

fn srp_body(category: &str, path: &str, line: usize, quote: &str, skill: &str) -> String {
    let title = match category {
        "mixed-responsibilities" => "Mixed responsibilities",
        "divergent-change" => "Divergent change",
        "accidental-aggregation" => "Accidental aggregation",
        "responsibility-leakage" => "Responsibility leakage",
        _ => "Artificial fragmentation",
    };
    let directive = skill
        .split('\n')
        .find(|line| line.starts_with(&format!("- **{title}:**")))
        .expect("a directive");
    [
        "## Category".to_string(),
        String::new(),
        category.to_string(),
        String::new(),
        "## Component".to_string(),
        String::new(),
        format!("{path} — the fixture component"),
        String::new(),
        "## Skill".to_string(),
        String::new(),
        srp::single_responsibility_config().skill_document,
        String::new(),
        "## Directive".to_string(),
        String::new(),
        format!("> {directive}"),
        String::new(),
        "## Why the responsibilities are mixed".to_string(),
        String::new(),
        "The fixture component parses and renders.".to_string(),
        String::new(),
        "## Evidence".to_string(),
        String::new(),
        format!("- `{path}:{line}-{line}`"),
        format!("  > {quote}"),
        String::new(),
        "## Refactor".to_string(),
        String::new(),
        "Move the unrelated behavior into its own component.".to_string(),
        String::new(),
        "## Acceptance criteria".to_string(),
        String::new(),
        "- The component no longer contains the moved behavior.".to_string(),
        String::new(),
    ]
    .join("\n")
}

/* ------------------------------------------------------------------------ */
/* Fake peers                                                                */
/* ------------------------------------------------------------------------ */

type PeerAction =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

struct FakePeer {
    action: PeerAction,
}

impl api::Peer for FakePeer {
    fn run(&self, prompt: String) -> api::PeerRunFuture<'_> {
        (self.action)(prompt)
    }

    fn close(&self) {}
}

fn fake_connect(
    action: impl Fn(String) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync
        + 'static,
) -> api::ConnectFn {
    let action = Arc::new(action);
    Arc::new(move |_options| {
        let action = Arc::clone(&action);
        Box::pin(async move { Ok(Arc::new(FakePeer { action }) as Arc<dyn api::Peer>) })
            as api::PeerConnectFuture
    })
}

fn prompt_directory(prompt: &str, prefix: &str) -> PathBuf {
    PathBuf::from(prompt.trim_start_matches(prefix).trim())
}

fn write_tool_record(directory: &Path, number: i64, title: &str) {
    let path = directory.join("tool-log.jsonl");
    let line = json!({
        "tool": "issue_create",
        "ok": true,
        "value": {"number": number, "title": title},
    });
    std::fs::write(path, format!("{line}\n")).expect("a tool record");
}

/* ------------------------------------------------------------------------ */
/* Forge fakes                                                               */
/* ------------------------------------------------------------------------ */

#[derive(Default)]
struct ApiForge {
    issues: Mutex<Vec<api::ForgeIssue>>,
    fail: Mutex<Option<String>>,
}

impl api::ForgeClient for ApiForge {
    fn list_issues(&self) -> api::ForgeFuture<'_, Vec<api::ForgeIssue>> {
        Box::pin(async move {
            if let Some(error) = self.fail.lock().expect("the fake").clone() {
                return Err(error);
            }
            Ok(self.issues.lock().expect("the fake").clone())
        })
    }

    fn list_open_issue_titles(&self) -> api::ForgeFuture<'_, Vec<String>> {
        Box::pin(async move {
            Ok(self
                .issues
                .lock()
                .expect("the fake")
                .iter()
                .filter(|issue| issue.state == "open")
                .map(|issue| issue.title.clone())
                .collect())
        })
    }
}

#[derive(Default)]
struct DeadForge {
    issues: Mutex<Vec<dead::ForgeIssue>>,
    releases: Mutex<Vec<dead::Release>>,
    closing: Mutex<Vec<String>>,
    closing_calls: AtomicU64,
    open_title_calls: AtomicU64,
}

impl dead::ForgeClient for DeadForge {
    fn list_issues(&self) -> dead::ForgeFuture<'_, Vec<dead::ForgeIssue>> {
        Box::pin(async move { Ok(self.issues.lock().expect("the fake").clone()) })
    }

    fn list_open_issue_titles(&self) -> dead::ForgeFuture<'_, Vec<String>> {
        self.open_title_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok(self
                .issues
                .lock()
                .expect("the fake")
                .iter()
                .filter(|issue| issue.state == "open")
                .map(|issue| issue.title.clone())
                .collect())
        })
    }

    fn list_releases(&self) -> dead::ForgeFuture<'_, Vec<dead::Release>> {
        Box::pin(async move { Ok(self.releases.lock().expect("the fake").clone()) })
    }

    fn closing_commits(&self, _issue_number: i64) -> dead::ForgeFuture<'_, Vec<String>> {
        self.closing_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(self.closing.lock().expect("the fake").clone()) })
    }

    fn landed_commits(&self, _issue_number: i64) -> Vec<String> {
        Vec::new()
    }

    fn resolve_commit(&self, short: String) -> dead::ForgeFuture<'_, Option<String>> {
        Box::pin(async move { Ok(Some(short)) })
    }

    fn containing_release_tags(
        &self,
        _commit: String,
        releases: Vec<dead::Release>,
    ) -> dead::ForgeFuture<'_, Vec<String>> {
        Box::pin(async move { Ok(releases.into_iter().map(|release| release.tag).collect()) })
    }
}

#[derive(Default)]
struct SrpForge {
    issues: Mutex<Vec<srp::ForgeIssue>>,
    open_title_calls: AtomicU64,
}

impl srp::ForgeClient for SrpForge {
    fn list_issues(&self) -> srp::ForgeFuture<'_, Vec<srp::ForgeIssue>> {
        Box::pin(async move { Ok(self.issues.lock().expect("the fake").clone()) })
    }

    fn list_open_issue_titles(&self) -> srp::ForgeFuture<'_, Vec<String>> {
        self.open_title_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok(self
                .issues
                .lock()
                .expect("the fake")
                .iter()
                .filter(|issue| issue.state == "open")
                .map(|issue| issue.title.clone())
                .collect())
        })
    }
}

/* ------------------------------------------------------------------------ */
/* Worker fixtures                                                           */
/* ------------------------------------------------------------------------ */

fn api_worker(
    fixture: &Fixture,
    forge: Arc<ApiForge>,
    connect: api::ConnectFn,
) -> Arc<api::Worker> {
    let mut options = api::WorkerOptions::new(&fixture.repo, &fixture.state_dir);
    options.harness_version = Some(VERSION.to_string());
    options.sync_ms = Some(60_000);
    options.cadence_ms = Some(60 * 60_000);
    options.manual_cycles = true;
    options.connect = Some(connect);
    options.forge = Some(forge as Arc<dyn api::ForgeClient>);
    api::Worker::new(options)
}

fn dead_worker(
    fixture: &Fixture,
    forge: Arc<DeadForge>,
    connect: api::ConnectFn,
) -> Arc<dead::Worker> {
    let mut options = dead::WorkerOptions::new(&fixture.repo, &fixture.state_dir);
    options.harness_version = Some(VERSION.to_string());
    options.sync_ms = Some(60_000);
    options.cadence_ms = Some(60 * 60_000);
    options.manual_cycles = true;
    options.connect = Some(connect);
    options.forge = Some(forge as Arc<dyn dead::ForgeClient>);
    dead::Worker::new(options)
}

fn srp_worker(
    fixture: &Fixture,
    forge: Arc<SrpForge>,
    connect: api::ConnectFn,
) -> Arc<srp::Worker> {
    let mut options = srp::WorkerOptions::new(&fixture.repo, &fixture.state_dir);
    options.harness_version = Some(VERSION.to_string());
    options.sync_ms = Some(60_000);
    options.cadence_ms = Some(60 * 60_000);
    options.manual_cycles = true;
    options.connect = Some(connect);
    options.forge = Some(forge as Arc<dyn srp::ForgeClient>);
    srp::Worker::new(options)
}

async fn eventually_stopped(worker: &dyn StoppedCheck) -> bool {
    for _ in 0..100 {
        if worker.stopped() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

trait StoppedCheck {
    fn stopped(&self) -> bool;
}

impl StoppedCheck for api::Worker {
    fn stopped(&self) -> bool {
        self.is_stopped()
    }
}

impl StoppedCheck for dead::Worker {
    fn stopped(&self) -> bool {
        self.is_stopped()
    }
}

impl StoppedCheck for srp::Worker {
    fn stopped(&self) -> bool {
        self.is_stopped()
    }
}

/* ------------------------------------------------------------------------ */
/* API Standards                                                             */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn api_standards_runs_one_cycle_and_files_a_must_finding() {
    let fixture = Fixture::new("api-cycle");
    fixture.api_inputs();
    let forge = Arc::new(ApiForge::default());
    let forge_for_peer = Arc::clone(&forge);
    let connect = fake_connect(move |prompt| {
        let forge = Arc::clone(&forge_for_peer);
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/api-standards-audit ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            assert_eq!(request["issueRoom"], 5);
            assert_eq!(request["sourceDir"], ".devboard/crates/devboard/src");
            assert!(request["knownTitles"].is_array());
            let finding = json!({
                "title": "POST /api/ready ignores the method",
                "ruleId": "148",
                "level": "MUST",
                "chapter": "HTTP requests",
                "directive": "Use HTTP methods according to RFC 9110.",
                "endpoints": [{"method": "POST", "path": "/api/ready"}],
                "evidence": [{
                    "path": ".devboard/crates/devboard/src/http.rs",
                    "lines": "5-9",
                    "quote": "if *method != Method::GET && *method != Method::HEAD {",
                }],
                "proposedChange": "Answer a non-GET request with 405.",
                "acceptanceCriteria": ["POST /api/ready answers 405."],
                "decision": "filed",
                "issueNumber": 7,
                "issueUrl": "https://forge.test/acme/fixture/issues/7",
            });
            std::fs::write(
                directory.join("findings.json"),
                format!("{}\n", json!({"version": 1, "findings": [finding]})),
            )
            .expect("findings");
            write_tool_record(&directory, 7, "POST /api/ready ignores the method");
            forge
                .issues
                .lock()
                .expect("the fake")
                .push(api::ForgeIssue {
                    number: 7,
                    title: "POST /api/ready ignores the method".to_string(),
                    url: "https://forge.test/acme/fixture/issues/7".to_string(),
                    state: "open".to_string(),
                    created_at: "2026-01-01T00:00:00.000Z".to_string(),
                    body: "## Chapter\n\nHTTP requests\n".to_string(),
                    labels: vec!["api-standards".to_string()],
                });
            Ok(())
        })
    });
    let worker = api_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.lifecycle, api::Lifecycle::Idle);
    assert_eq!(state.issues.len(), 1);
    assert_eq!(state.issues[0].category.as_deref(), Some("HTTP requests"));
    let cycle_id = state.newest_cycle_id.clone().expect("a cycle id");
    let directory = api::cycle_directory(&fixture.repo, &cycle_id);
    assert!(api::request_path(&directory).is_file());
    assert!(directory.join("findings.json").is_file());
    assert!(api::input_path(&directory).is_file());
    assert!(directory.join("tool-log.jsonl").is_file());
    let activity = api::read_activity(&directory).join("\n");
    assert!(activity.contains("route(s)"));
    assert!(activity.contains("admissible rule 148 MUST"));
    assert!(activity.contains("filed #7"));
    let persisted = api::read_state(&api::versioned_state_path(
        &fixture.state_dir,
        &fixture.repo,
        Some(VERSION),
    ))
    .expect("the versioned state");
    assert_eq!(persisted.issues.len(), 1);
    assert!(persisted.sync.state == api::SyncState::Ok);
    worker.stop().await;
    assert!(worker.current_state().lifecycle == api::Lifecycle::Stopped);
    assert!(!versioned(api::lock_path(&fixture.repo)).exists());
}

#[tokio::test]
async fn api_standards_may_level_and_missing_room_are_recorded() {
    let fixture = Fixture::new("api-cap");
    fixture.api_inputs();
    let forge = Arc::new(ApiForge::default());
    for index in 1..=5 {
        forge
            .issues
            .lock()
            .expect("the fake")
            .push(api::ForgeIssue {
                number: index,
                title: format!("Existing finding {index}"),
                url: format!("https://forge.test/acme/fixture/issues/{index}"),
                state: "open".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                body: String::new(),
                labels: vec!["api-standards".to_string()],
            });
    }
    let connect = fake_connect(|prompt| {
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/api-standards-audit ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            assert_eq!(request["issueRoom"], 0);
            let may = json!({
                "title": "Optional OpenAPI document",
                "ruleId": "100",
                "level": "MAY",
                "chapter": "HTTP requests",
                "directive": "Offer an optional OpenAPI document.",
                "decision": "skipped",
                "reason": "may-level",
            });
            std::fs::write(
                directory.join("findings.json"),
                format!("{}\n", json!({"version": 1, "findings": [may]})),
            )
            .expect("findings");
            Ok(())
        })
    });
    let worker = api_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    assert_eq!(worker.current_state().issues.len(), 5);
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    let directory = api::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    let activity = api::read_activity(&directory).join("\n");
    assert!(activity.contains("room 0"));
    assert!(activity.contains("skipped (may-level)"));
    assert_eq!(worker.current_state().issues.len(), 5);
    worker.stop().await;
}

#[tokio::test]
async fn api_standards_settings_command_resumes_filing() {
    let fixture = Fixture::new("api-settings");
    fixture.api_inputs();
    let forge = Arc::new(ApiForge::default());
    for index in 1..=5 {
        forge
            .issues
            .lock()
            .expect("the fake")
            .push(api::ForgeIssue {
                number: index,
                title: format!("Existing finding {index}"),
                url: format!("https://forge.test/acme/fixture/issues/{index}"),
                state: "open".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                body: String::new(),
                labels: vec!["api-standards".to_string()],
            });
    }
    let rooms = Arc::new(Mutex::new(Vec::new()));
    let rooms_for_peer = Arc::clone(&rooms);
    let connect = fake_connect(move |prompt| {
        let rooms = Arc::clone(&rooms_for_peer);
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/api-standards-audit ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            let room = request["issueRoom"].as_i64().unwrap_or_default();
            rooms.lock().expect("the rooms").push(room);
            let entries = if room > 0 {
                write_tool_record(&directory, 9, "A new finding");
                vec![json!({
                    "title": "A new finding",
                    "ruleId": "148",
                    "level": "MUST",
                    "chapter": "HTTP requests",
                    "directive": "Use HTTP methods according to RFC 9110.",
                    "endpoints": [{"method": "GET", "path": "/api/ready"}],
                    "evidence": [{"path": ".devboard/crates/devboard/src/http.rs", "lines": "6", "quote": "if *method != Method::GET && *method != Method::HEAD {"}],
                    "proposedChange": "Keep GET.",
                    "acceptanceCriteria": ["GET /api/ready answers 200."],
                    "decision": "filed",
                    "issueNumber": 9,
                })]
            } else {
                vec![json!({
                    "title": "A new finding",
                    "ruleId": "148",
                    "level": "MUST",
                    "chapter": "HTTP requests",
                    "directive": "Use HTTP methods according to RFC 9110.",
                    "decision": "skipped",
                    "reason": "no-room",
                })]
            };
            std::fs::write(
                directory.join("findings.json"),
                format!("{}\n", json!({"version": 1, "findings": entries})),
            )
            .expect("findings");
            Ok(())
        })
    });
    let worker = api_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    api::write_command(
        &api::versioned_control_directory(&fixture.state_dir, &fixture.repo, Some(VERSION)),
        &api::Command::Settings {
            interval_minutes: 60,
            max_per_hour: Some(10),
            max_pending: None,
        },
    )
    .expect("a settings command");
    worker.tick_now().await;
    let settings = api::read_settings(&api::settings_path(&fixture.state_dir, &fixture.repo))
        .expect("the settings file");
    assert_eq!(settings.max_pending, None);
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    assert_eq!(*rooms.lock().expect("the rooms"), vec![0, 10]);
    let state = worker.current_state();
    let directory = api::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    assert!(api::read_activity(&directory)
        .join("\n")
        .contains("filed #9"));
    worker.stop().await;
}

#[tokio::test]
async fn api_standards_drain_exits_after_the_in_flight_cycle() {
    let fixture = Fixture::new("api-drain");
    fixture.api_inputs();
    let forge = Arc::new(ApiForge::default());
    let release = Arc::new(tokio::sync::Notify::new());
    let release_for_peer = Arc::clone(&release);
    let connect = fake_connect(move |_prompt| {
        let release = Arc::clone(&release_for_peer);
        Box::pin(async move {
            release.notified().await;
            Ok(())
        })
    });
    let worker = api_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    assert!(worker.cycling_now());
    api::write_command(
        &api::versioned_control_directory(&fixture.state_dir, &fixture.repo, Some(VERSION)),
        &api::Command::Drain,
    )
    .expect("a drain command");
    worker.tick_now().await;
    assert!(worker.current_state().draining);
    assert!(worker.cycling_now());
    release.notify_one();
    worker.wait_for_cycle().await;
    assert!(eventually_stopped(worker.as_ref()).await);
    assert!(worker.current_state().lifecycle == api::Lifecycle::Stopped);
    assert_eq!(
        std::fs::read_dir(api::cycles_directory(&fixture.repo))
            .expect("the cycles")
            .count(),
        1
    );
}

#[tokio::test]
async fn api_standards_preflight_refusals_name_the_missing_fact() {
    let fixture = Fixture::new("api-preflight");
    fixture.api_inputs();
    let mut options = api::PreflightOptions {
        repo_dir: fixture.repo.clone(),
        state_dir: fixture.state_dir.clone(),
        ..api::PreflightOptions::default()
    };
    std::fs::remove_dir_all(fixture.repo.join(".devboard").join("crates")).expect("remove");
    let message = api::preflight_api_standards(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains(".devboard/crates/devboard/src"));
    assert!(message.contains("installed npm prefix"));

    fixture.api_inputs();
    std::fs::remove_file(
        fixture
            .repo
            .join(".omp/skills/devboard-restful-api-implementation/SKILL.md"),
    )
    .expect("remove");
    let message = api::preflight_api_standards(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("SKILL.md is not readable"));

    fixture.api_inputs();
    fixture.write(
        ".omp/skills/devboard-restful-api-implementation/references/zalando-rest-rules.md",
        "## URLs\n\n| Rule | Level | Directive |\n| --- | --- | --- |\n",
    );
    let message = api::preflight_api_standards(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("no rule table"));

    fixture.api_inputs();
    options.origin = Some(origin("gitlab", "gitlab.test", "acme/fixture"));
    let message = api::preflight_api_standards(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("GitLab"));

    options.origin = None;
    options.state_dir = fixture.root.clone();
    let message = api::preflight_api_standards(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("not inside REPO_DIR"));
}

#[test]
fn api_standards_inventory_reads_the_rust_http_surface() {
    let fixture = Fixture::new("api-inventory");
    fixture.api_inputs();
    let input =
        api::read_audit_input(&fixture.repo, &api::Config::default()).expect("an audit input");
    assert_eq!(input.source_dir, api::DEFAULT_API_SOURCE_DIRECTORY);
    let routes: Vec<(&str, Vec<&str>, &str)> = input
        .routes
        .iter()
        .map(|route| {
            (
                route.path.as_str(),
                route.methods.iter().map(String::as_str).collect(),
                route.kind.as_str(),
            )
        })
        .collect();
    assert_eq!(
        routes,
        vec![
            ("*", vec!["GET", "HEAD"], "static-fallback"),
            ("/api/ready", vec!["GET", "HEAD"], "endpoint"),
            ("/api/ready/{name}", vec!["GET", "HEAD"], "endpoint"),
            ("/feedback", vec!["POST"], "endpoint"),
            ("/ws", vec!["GET"], "upgrade"),
        ]
    );
    let sources: Vec<&str> = input
        .sources
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(
        sources,
        vec![
            ".devboard/crates/devboard/src/app.rs",
            ".devboard/crates/devboard/src/http.rs",
        ]
    );
}

/* ------------------------------------------------------------------------ */
/* Dead Code                                                                 */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn dead_code_runs_one_cycle_from_a_seeded_entry_point() {
    let fixture = Fixture::new("dead-cycle");
    fixture.write(
        "src/a.ts",
        "export const dead = 1;\nexport const live = 2;\n",
    );
    let forge = Arc::new(DeadForge::default());
    let forge_for_peer = Arc::clone(&forge);
    let seen = Arc::new(Mutex::new(Value::Null));
    let seen_for_peer = Arc::clone(&seen);
    let connect = fake_connect(move |prompt| {
        let forge = Arc::clone(&forge_for_peer);
        let seen = Arc::clone(&seen_for_peer);
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/dead-code-removal ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            *seen.lock().expect("the request") = request.clone();
            assert_eq!(request["surface"], "dead-code");
            assert_eq!(request["issueRoom"], 5);
            assert_eq!(request["maxPerHour"], 10);
            assert_eq!(request["maxPending"], 5);
            write_tool_record(&directory, 1, "Remove dead fixture code");
            forge
                .issues
                .lock()
                .expect("the fake")
                .push(dead::ForgeIssue {
                    number: 1,
                    title: "Remove dead fixture code".to_string(),
                    url: "https://forge.test/acme/fixture/issues/1".to_string(),
                    state: "open".to_string(),
                    created_at: "2026-01-01T00:00:00.000Z".to_string(),
                    closed_at: None,
                    body: "## Category\n\nunreferenced-symbol\n".to_string(),
                });
            Ok(())
        })
    });
    let worker = dead_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.lifecycle, dead::Lifecycle::Idle);
    assert_eq!(state.issues.len(), 1);
    assert_eq!(
        state.issues[0].category.as_deref(),
        Some("unreferenced-symbol")
    );
    let request = seen.lock().expect("the request").clone();
    let entry_path = request["entryPoint"]["path"].as_str().expect("a path");
    assert!(fixture.repo.join(entry_path).is_file());
    let replay = dead::pick_entry_point(&fixture.repo, "dead-code", request["seed"].as_str())
        .expect("the replay");
    assert_eq!(replay.path, entry_path);
    assert_eq!(
        replay.line,
        request["entryPoint"]["line"].as_u64().expect("a line") as usize
    );
    let directory = dead::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    let activity = api::read_activity(&directory).join("\n");
    assert!(activity.contains(entry_path));
    assert!(activity.contains("filed #1"));
    assert!(api::read_settings(&dead::settings_path(&fixture.state_dir, &fixture.repo)).is_none());
    assert!(dead::read_state(&dead::state_path(&fixture.state_dir, &fixture.repo)).is_none());
    worker.stop().await;
    assert!(worker.current_state().lifecycle == dead::Lifecycle::Stopped);
    assert_eq!(worker.current_state().issues.len(), 1);
    assert!(!versioned(dead::lock_path(&fixture.repo)).exists());
}

#[tokio::test]
async fn dead_code_resolves_a_release_once_and_retries_after_a_new_one() {
    let fixture = Fixture::new("dead-version");
    fixture.write("src/a.ts", "export const dead = 1;\n");
    let forge = Arc::new(DeadForge::default());
    let commit = "0123456789abcdef0123456789abcdef01234567";
    forge
        .issues
        .lock()
        .expect("the fake")
        .push(dead::ForgeIssue {
            number: 1,
            title: "Remove dead fixture code".to_string(),
            url: "https://forge.test/acme/fixture/issues/1".to_string(),
            state: "closed".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            closed_at: Some("2026-01-01T00:00:00.000Z".to_string()),
            body: "## Category\n\nunreferenced-symbol\n".to_string(),
        });
    forge
        .closing
        .lock()
        .expect("the fake")
        .push(commit.to_string());
    let millis = Arc::new(Mutex::new(
        api::parse_iso_millis("2026-01-01T00:00:00.000Z").expect("the clock"),
    ));
    let clock_source = Arc::clone(&millis);
    let mut options = dead::WorkerOptions::new(&fixture.repo, &fixture.state_dir);
    options.harness_version = Some(VERSION.to_string());
    options.sync_ms = Some(60_000);
    options.cadence_ms = Some(60 * 60_000);
    options.manual_cycles = true;
    options.clock = Some(Arc::new(move || *clock_source.lock().expect("the clock")));
    options.connect = Some(fake_connect(|_prompt| Box::pin(async move { Ok(()) })));
    options.forge = Some(Arc::clone(&forge) as Arc<dyn dead::ForgeClient>);
    let worker = dead::Worker::new(options);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    let first = worker.current_state().issues[0].clone();
    assert!(first.version.is_none());
    assert_eq!(
        first.version_error,
        Some(format!("no published release contains {commit}"))
    );
    assert!(first.version_attempt_at.is_some());
    assert_eq!(forge.closing_calls.load(Ordering::SeqCst), 1);

    *millis.lock().expect("the clock") += dead::RESOLUTION_RETRY_MS - 1;
    worker.refresh().await;
    assert_eq!(forge.closing_calls.load(Ordering::SeqCst), 1);

    forge
        .releases
        .lock()
        .expect("the fake")
        .push(dead::Release {
            tag: "v0.1.0".to_string(),
            published_at: "2026-01-01T00:00:30Z".to_string(),
        });
    worker.refresh().await;
    let row = worker.current_state().issues[0].clone();
    assert_eq!(row.version.as_deref(), Some("v0.1.0"));
    assert!(row.version_error.is_none());
    assert_eq!(forge.closing_calls.load(Ordering::SeqCst), 2);
    worker.stop().await;
}

#[tokio::test]
async fn dead_code_room_zero_files_nothing_and_records_the_skip() {
    let fixture = Fixture::new("dead-room");
    fixture.write("src/a.ts", "export const dead = 1;\n");
    let forge = Arc::new(DeadForge::default());
    for index in 1..=5 {
        forge
            .issues
            .lock()
            .expect("the fake")
            .push(dead::ForgeIssue {
                number: index,
                title: format!("Open dead-code finding {index}"),
                url: format!("https://forge.test/acme/fixture/issues/{index}"),
                state: "open".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                closed_at: None,
                body: "## Category\n\nunreferenced-symbol\n".to_string(),
            });
    }
    let connect = fake_connect(|prompt| {
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/dead-code-removal ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            assert_eq!(request["issueRoom"], 0);
            Ok(())
        })
    });
    let worker = dead_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    assert_eq!(worker.current_state().issues.len(), 5);
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    assert_eq!(forge.issues.lock().expect("the fake").len(), 5);
    let state = worker.current_state();
    let directory = dead::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    assert!(api::read_activity(&directory)
        .join("\n")
        .contains("no filing room"));
    worker.stop().await;
}

#[tokio::test]
async fn dead_code_reads_open_titles_once_per_cycle_not_on_every_sync() {
    let fixture = Fixture::new("dead-titles");
    fixture.write("src/a.ts", "export const dead = 1;\n");
    let forge = Arc::new(DeadForge::default());
    let seen = Arc::new(Mutex::new(Value::Null));
    let seen_for_peer = Arc::clone(&seen);
    let connect = fake_connect(move |prompt| {
        let seen = Arc::clone(&seen_for_peer);
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/dead-code-removal ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            *seen.lock().expect("the request") = request;
            Ok(())
        })
    });
    let worker = dead_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    // The periodic read never walks the open issue history.
    assert_eq!(forge.open_title_calls.load(Ordering::SeqCst), 0);
    // A title created after the sync is still in the cycle's duplicate check.
    forge
        .issues
        .lock()
        .expect("the fake")
        .push(dead::ForgeIssue {
            number: 9,
            title: "Fresh open title".to_string(),
            url: "https://forge.test/acme/fixture/issues/9".to_string(),
            state: "open".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            closed_at: None,
            body: String::new(),
        });
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    assert_eq!(forge.open_title_calls.load(Ordering::SeqCst), 1);
    let request = seen.lock().expect("the request").clone();
    let titles = request["knownTitles"].as_array().expect("known titles");
    assert!(
        titles.iter().any(|title| title == "Fresh open title"),
        "{titles:?}"
    );
    worker.stop().await;
}

#[tokio::test]
async fn dead_code_drain_during_the_read_starts_no_cycle() {
    let fixture = Fixture::new("dead-drain-race");
    fixture.write("src/a.ts", "export const dead = 1;\n");
    let forge = Arc::new(DeadForge::default());
    let connect = fake_connect(|_prompt| Box::pin(async move { Ok(()) }));
    let worker = dead_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    dead::write_command(
        &dead::versioned_control_directory(&fixture.state_dir, &fixture.repo, Some(VERSION)),
        &dead::Command::Drain,
    )
    .expect("a drain command");
    worker.tick_now().await;
    assert!(worker.current_state().last_cycle_started_at.is_none());
    assert!(eventually_stopped(worker.as_ref()).await);
    let cycles = dead::cycles_directory(&fixture.repo);
    assert!(!cycles.exists() || std::fs::read_dir(cycles).expect("cycles").count() == 0);
}

/* ------------------------------------------------------------------------ */
/* Single Responsibility                                                     */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn single_responsibility_files_only_proven_filings() {
    let fixture = Fixture::new("srp-cycle");
    let skill = fixture.srp_inputs();
    let forge = Arc::new(SrpForge::default());
    let forge_for_peer = Arc::clone(&forge);
    let skill_for_peer = skill.clone();
    let connect = fake_connect(move |prompt| {
        let forge = Arc::clone(&forge_for_peer);
        let skill = skill_for_peer.clone();
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/single-responsibility ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            assert_eq!(request["surface"], "single-responsibility");
            assert_eq!(request["issueRoom"], 5);
            assert_eq!(
                request["skillPath"],
                ".omp/skills/devboard-single-responsibility-principle/SKILL.md"
            );
            let first_body = srp_body(
                "mixed-responsibilities",
                "src/handler.ts",
                1,
                "export const handle = 1;",
                &skill,
            );
            let second_body = srp_body(
                "responsibility-leakage",
                "src/renderer.ts",
                1,
                "export const renderRow = 1;",
                &skill,
            );
            forge
                .issues
                .lock()
                .expect("the fake")
                .push(srp::ForgeIssue {
                    number: 1,
                    title: "Split the fixture handler".to_string(),
                    url: "https://forge.test/acme/fixture/issues/1".to_string(),
                    state: "open".to_string(),
                    created_at: "2026-01-01T00:00:00.000Z".to_string(),
                    body: first_body,
                    labels: vec!["single-responsibility".to_string()],
                });
            forge
                .issues
                .lock()
                .expect("the fake")
                .push(srp::ForgeIssue {
                    number: 2,
                    title: "Move rendering out of the fixture handler".to_string(),
                    url: "https://forge.test/acme/fixture/issues/2".to_string(),
                    state: "open".to_string(),
                    created_at: "2026-01-01T00:00:01.000Z".to_string(),
                    body: second_body,
                    labels: vec!["single-responsibility".to_string()],
                });
            write_tool_record(&directory, 1, "Split the fixture handler");
            let second = json!({
                "tool": "issue_create",
                "ok": true,
                "value": {"number": 2, "title": "Move rendering out of the fixture handler"},
            });
            std::fs::write(
                directory.join("tool-log.jsonl"),
                format!(
                    "{}\n{second}\n",
                    json!({"tool": "issue_create", "ok": true, "value": {"number": 1, "title": "Split the fixture handler"}})
                ),
            )
            .expect("tool records");
            Ok(())
        })
    });
    let worker = srp_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.issues.len(), 2);
    let categories: Vec<&str> = state
        .issues
        .iter()
        .filter_map(|issue| issue.category.as_deref())
        .collect();
    assert!(categories.contains(&"mixed-responsibilities"));
    assert!(categories.contains(&"responsibility-leakage"));
    let directory = srp::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    let activity = api::read_activity(&directory).join("\n");
    assert!(activity.contains("filed #1"));
    assert!(activity.contains("filed #2"));
    worker.stop().await;
    assert_eq!(worker.current_state().issues.len(), 2);
    assert!(!versioned(srp::lock_path(&fixture.repo)).exists());
}

#[tokio::test]
async fn single_responsibility_reads_open_titles_once_per_cycle_not_on_every_sync() {
    let fixture = Fixture::new("srp-titles");
    fixture.srp_inputs();
    let forge = Arc::new(SrpForge::default());
    let seen = Arc::new(Mutex::new(Value::Null));
    let seen_for_peer = Arc::clone(&seen);
    let connect = fake_connect(move |prompt| {
        let seen = Arc::clone(&seen_for_peer);
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/single-responsibility ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            *seen.lock().expect("the request") = request;
            Ok(())
        })
    });
    let worker = srp_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    // The periodic read never walks the open issue history.
    assert_eq!(forge.open_title_calls.load(Ordering::SeqCst), 0);
    // A title created after the sync is still in the cycle's duplicate check.
    forge
        .issues
        .lock()
        .expect("the fake")
        .push(srp::ForgeIssue {
            number: 9,
            title: "Fresh open title".to_string(),
            url: "https://forge.test/acme/fixture/issues/9".to_string(),
            state: "open".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            body: String::new(),
            labels: Vec::new(),
        });
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    assert_eq!(forge.open_title_calls.load(Ordering::SeqCst), 1);
    let request = seen.lock().expect("the request").clone();
    let titles = request["knownTitles"].as_array().expect("known titles");
    assert!(
        titles.iter().any(|title| title == "Fresh open title"),
        "{titles:?}"
    );
    worker.stop().await;
}

#[tokio::test]
async fn single_responsibility_drops_a_filing_without_provenance() {
    let fixture = Fixture::new("srp-drop");
    let skill = fixture.srp_inputs();
    let forge = Arc::new(SrpForge::default());
    forge.issues.lock().expect("the fake").push(srp::ForgeIssue {
        number: 1,
        title: "Report a concern outside the five categories".to_string(),
        url: "https://forge.test/acme/fixture/issues/1".to_string(),
        state: "open".to_string(),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        body: "## Category\n\nunlisted-category\n\n## Evidence\n\n- `src/handler.ts:1-1`\n  > export const handle = 1;".to_string(),
        labels: vec!["single-responsibility".to_string()],
    });
    let forge_for_peer = Arc::clone(&forge);
    let skill_for_peer = skill.clone();
    let connect = fake_connect(move |prompt| {
        let forge = Arc::clone(&forge_for_peer);
        let skill = skill_for_peer.clone();
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/single-responsibility ");
            let body = srp_body(
                "mixed-responsibilities",
                "src/handler.ts",
                1,
                "export const handle = 1;",
                &skill,
            );
            forge
                .issues
                .lock()
                .expect("the fake")
                .push(srp::ForgeIssue {
                    number: 2,
                    title: "Split the fixture handler".to_string(),
                    url: "https://forge.test/acme/fixture/issues/2".to_string(),
                    state: "open".to_string(),
                    created_at: "2026-01-01T00:00:01.000Z".to_string(),
                    body,
                    labels: vec!["single-responsibility".to_string()],
                });
            write_tool_record(&directory, 2, "Split the fixture handler");
            Ok(())
        })
    });
    let worker = srp_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    assert!(worker.current_state().issues.is_empty());
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.issues.len(), 1);
    assert_eq!(state.issues[0].number, 2);
    let directory = srp::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    assert!(api::read_activity(&directory)
        .join("\n")
        .contains("verification failure"));
    worker.stop().await;
}

#[tokio::test]
async fn single_responsibility_preflight_refuses_a_missing_or_unusable_skill() {
    let fixture = Fixture::new("srp-preflight");
    git_fixture(&fixture, "https://forge.test/acme/fixture.git");
    let mut options = srp::PreflightOptions {
        repo_dir: fixture.repo.clone(),
        state_dir: fixture.state_dir.clone(),
        ..srp::PreflightOptions::default()
    };
    let message = srp::preflight_single_responsibility(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("SKILL.md is not readable"));
    fixture.srp_inputs();
    fixture.write(
        ".omp/skills/devboard-single-responsibility-principle/SKILL.md",
        "# Empty\n",
    );
    let message = srp::preflight_single_responsibility(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("unusable"));
    fixture.srp_inputs();
    options.state_dir = fixture.root.clone();
    let message = srp::preflight_single_responsibility(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("not inside REPO_DIR"));
}

#[tokio::test]
async fn dead_code_preflight_refuses_a_missing_tool_or_command() {
    let fixture = Fixture::new("dead-preflight");
    git_fixture(&fixture, "https://forge.test/acme/fixture.git");
    let bin = fixture.root.join("bin");
    std::fs::create_dir_all(&bin).expect("a bin directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["omp", "gh"] {
            let path = bin.join(name);
            std::fs::write(&path, "#!/bin/sh\nexit 0\n").expect("a tool");
            let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).expect("executable");
        }
    }
    let empty = fixture.root.join("empty-bin");
    std::fs::create_dir_all(&empty).expect("an empty bin");
    let mut environment = HashMap::new();
    environment.insert("PATH".to_string(), empty.to_string_lossy().into_owned());
    environment.insert(
        "HOME".to_string(),
        fixture.root.to_string_lossy().into_owned(),
    );
    let mut options = dead::PreflightOptions {
        repo_dir: fixture.repo.clone(),
        state_dir: fixture.state_dir.clone(),
        environment,
        ..dead::PreflightOptions::default()
    };
    options.origin = Some(origin("github", "github.com", "acme/fixture"));
    let message = dead::preflight_dead_code(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("omp is not on PATH"));

    options
        .environment
        .insert("PATH".to_string(), bin.to_string_lossy().into_owned());
    let message = dead::preflight_dead_code(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("/dead-code-removal command is not installed"));

    fixture.write(
        ".omp/commands/dead-code-removal.md",
        "# Dead code removal\n",
    );
    let run: Arc<dead::RunFn> = Arc::new(|argv: Vec<String>| {
        Box::pin(async move {
            let label = argv.iter().any(|argument| argument.contains("/labels/"));
            dead_exec(if label { ("dead-code", 0) } else { ("true", 0) })
        })
    });
    options.run = Some(run);
    assert_eq!(
        dead::preflight_dead_code(&options).await.expect("a pass"),
        "acme/fixture"
    );
}

fn dead_exec(output: (&str, i32)) -> devboard::forge::ExecResult {
    devboard::forge::ExecResult {
        stdout: format!("{}\n", output.0),
        stderr: String::new(),
        code: output.1,
        killed: false,
    }
}

/* ------------------------------------------------------------------------ */
/* CLI exit codes                                                            */
/* ------------------------------------------------------------------------ */

fn git_fixture(fixture: &Fixture, origin: &str) {
    git_init(fixture);
    git_command(fixture, &["remote", "add", "origin", origin]);
}

fn git_command(fixture: &Fixture, args: &[&str]) {
    let output = Command::new("git")
        .arg("-c")
        .arg("commit.gpgsign=false")
        .arg("-c")
        .arg("init.defaultBranch=main")
        .args(args)
        .current_dir(&fixture.repo)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_init(fixture: &Fixture) {
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .arg("-c")
            .arg("commit.gpgsign=false")
            .arg("-c")
            .arg("init.defaultBranch=main")
            .args(args)
            .current_dir(&fixture.repo)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    std::fs::create_dir_all(&fixture.repo).expect("the checkout");
    git(&["init", "-q"]);
    git(&["config", "user.email", "fixture@example.test"]);
    git(&["config", "user.name", "Fixture"]);
    std::fs::write(fixture.repo.join("tracked.txt"), "original\n").expect("a file");
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "fixture"]);
}

#[test]
fn a_tracked_entry_point_is_not_excluded_by_an_ignore_rule() {
    let fixture = Fixture::new("tracked-entry-point");
    git_init(&fixture);
    // A host pattern that keeps an installed copy untracked also matches the
    // tracked harness tree. The entry-point pool is built from tracked files,
    // so the file is repository content and must stay eligible.
    fixture.write(".gitignore", "/.devboard\n");
    fixture.write(
        ".devboard/src/module.rs",
        "pub fn run() {\n    let value = 1;\n    let _ = value;\n}\n",
    );
    git_command(
        &fixture,
        &["add", "-f", ".gitignore", ".devboard/src/module.rs"],
    );
    git_command(&fixture, &["commit", "-q", "-m", "tracked entry point"]);

    let status = Command::new("git")
        .arg("-C")
        .arg(&fixture.repo)
        .args(["check-ignore", "-q", "--", ".devboard/src/module.rs"])
        .status()
        .expect("git runs");
    assert!(!status.success(), "git itself never ignores a tracked path");

    let entry = dead::pick_entry_point(&fixture.repo, "dead-code", Some("seed"))
        .expect("the tracked entry point is eligible");
    assert_eq!(entry.path, ".devboard/src/module.rs");
    assert!(entry.line >= 1);
}

#[test]
fn worker_exits_two_without_an_origin_and_zero_when_already_running() {
    let fixture = Fixture::new("cli");
    git_init(&fixture);
    let binary = env!("CARGO_BIN_EXE_devboard");
    let missing_origin = Command::new(binary)
        .args([
            "worker",
            "api-standards",
            "--repo",
            fixture.repo.to_str().expect("a path"),
            "--state-dir",
            fixture.state_dir.to_str().expect("a path"),
        ])
        .output()
        .expect("the worker runs");
    assert_eq!(missing_origin.status.code(), Some(2));

    git_command(
        &fixture,
        &[
            "remote",
            "add",
            "origin",
            "https://forge.test/acme/fixture.git",
        ],
    );
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let worker = runtime.block_on(async {
        let mut options = api::WorkerOptions::new(&fixture.repo, &fixture.state_dir);
        options.harness_version = Some(VERSION.to_string());
        options.manual_cycles = true;
        let worker = api::Worker::new(options);
        assert!(worker.start("acme/fixture"));
        worker
    });
    let already_running = Command::new(binary)
        .args([
            "worker",
            "api-standards",
            "--repo",
            fixture.repo.to_str().expect("a path"),
            "--state-dir",
            fixture.state_dir.to_str().expect("a path"),
        ])
        .env("DEVBOARD_HARNESS_VERSION", VERSION)
        .output()
        .expect("the worker runs");
    assert_eq!(already_running.status.code(), Some(0));
    runtime.block_on(worker.stop());
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

mod crate_origin {
    pub fn origin(forge: &str, host: &str, project: &str) -> devboard::forge::ForgeRemote {
        devboard::forge::ForgeRemote {
            forge: if forge == "gitlab" {
                devboard::forge::Forge::GitLab
            } else if forge == "gitea" {
                devboard::forge::Forge::Gitea
            } else {
                devboard::forge::Forge::GitHub
            },
            host: host.to_string(),
            project: project.to_string(),
            origin_url: None,
        }
    }
}

fn origin(forge: &str, host: &str, project: &str) -> devboard::forge::ForgeRemote {
    crate_origin::origin(forge, host, project)
}

fn versioned(lock: PathBuf) -> PathBuf {
    devboard::workers::watchdog::versioned_lock_path(&lock, Some(VERSION))
}

#[test]
fn the_real_harness_surface_carries_every_route_and_only_rust_sources() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("the repository root")
        .to_path_buf();
    let config = api::api_standards_config();
    assert_eq!(config.source_dir, ".devboard/crates/devboard/src");
    let input = api::read_audit_input(&root, &config).expect("the real surface is readable");
    assert!(!input.sources.is_empty());
    for source in &input.sources {
        assert!(source.path.ends_with(".rs"), "{}", source.path);
        assert!(!source.path.contains("_test.rs"), "{}", source.path);
        assert!(!source.path.contains("/tests/"), "{}", source.path);
    }
    let route = |path: &str, method: &str| {
        input
            .routes
            .iter()
            .any(|entry| entry.path == path && entry.methods.iter().any(|item| item == method))
    };
    assert!(route("/reports", "POST"));
    assert!(route("/ready", "GET"));
    assert!(route("/ready", "HEAD"));
    assert!(route("/goal-proposals", "POST"));
    assert!(!input.routes.iter().any(|entry| entry.path == "/ws"));
    assert!(input
        .routes
        .iter()
        .any(|entry| entry.kind == "static-fallback"));
}

#[test]
fn the_operator_suite_fixture_carries_an_auditable_api_surface() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("the repository root")
        .to_path_buf();
    let fixture = root.join(".devboard/e2e/fixtures/repo");
    let input = api::read_audit_input(&fixture, &api::api_standards_config())
        .expect("the operator suite's fixture repository is auditable");
    let sources: Vec<&str> = input
        .sources
        .iter()
        .map(|source| source.path.as_str())
        .collect();
    assert_eq!(sources, [".devboard/crates/devboard/src/lib.rs"]);
    assert_eq!(input.routes.len(), 1, "{:?}", input.routes);
    assert_eq!(input.routes[0].path, "/health");
    assert_eq!(input.routes[0].methods, ["GET"]);
    assert_eq!(input.routes[0].kind, "endpoint");
    assert_eq!(input.skill.rules.len(), 2);
}

/* ------------------------------------------------------------------------ */
/* The inherited startup state, for every audited family                     */
/* ------------------------------------------------------------------------ */

type PublishedSnapshot = (
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<String>,
);

/// Writes one family's published state: state directory, repository, version (or
/// the legacy file), cadence anchor, newest run id, limits, and `updatedAt`.
type PublishedWrite = fn(&Path, &Path, Option<&str>, &str, &str, (Option<i64>, Option<i64>), &str);

struct PublishedFamily {
    versioned_state_path: fn(&Path, &Path, Option<&str>) -> PathBuf,
    write: PublishedWrite,
    read: fn(&Path) -> Option<PublishedSnapshot>,
    start: fn(&Path, &Path) -> bool,
}

fn write_dead_published(
    state_dir: &Path,
    repo: &Path,
    version: Option<&str>,
    anchor: &str,
    newest_cycle_id: &str,
    limits: (Option<i64>, Option<i64>),
    updated_at: &str,
) {
    let mut state = dead::empty_state(dead::EmptyStateOptions {
        repo: "acme/fixture".to_string(),
        root: repo.to_string_lossy().into_owned(),
        lifecycle: dead::Lifecycle::Idle,
        limit: dead::Limits {
            max_per_hour: limits.0,
            max_pending: limits.1,
        },
        interval_minutes: 1,
        now: updated_at.to_string(),
    });
    state.enabled = true;
    state.last_cycle_started_at = Some(anchor.to_string());
    state.sync = dead::SyncStatus {
        state: dead::SyncState::Ok,
        at: Some(anchor.to_string()),
        error: None,
    };
    state.newest_cycle_id = Some(newest_cycle_id.to_string());
    state.updated_at = updated_at.to_string();
    let path = match version {
        Some(version) => dead::versioned_state_path(state_dir, repo, Some(version)),
        None => dead::state_path(state_dir, repo),
    };
    std::fs::create_dir_all(path.parent().expect("a state directory")).expect("state directory");
    dead::write_state(&path, &state).expect("a published state");
}

fn read_dead_published(path: &Path) -> Option<PublishedSnapshot> {
    dead::read_state(path).map(|state| {
        (
            state.last_cycle_started_at,
            state.newest_cycle_id,
            state.limits.max_per_hour,
            state.limits.max_pending,
            state.sync.at,
        )
    })
}

fn start_dead(repo: &Path, state_dir: &Path) -> bool {
    let mut options = dead::WorkerOptions::new(repo, state_dir);
    options.harness_version = Some(VERSION.to_string());
    let worker = dead::Worker::new(options);
    worker.start("acme/fixture")
}

fn write_srp_published(
    state_dir: &Path,
    repo: &Path,
    version: Option<&str>,
    anchor: &str,
    newest_cycle_id: &str,
    limits: (Option<i64>, Option<i64>),
    updated_at: &str,
) {
    let mut state = srp::empty_state(srp::EmptyStateOptions {
        repo: "acme/fixture".to_string(),
        root: repo.to_string_lossy().into_owned(),
        lifecycle: srp::Lifecycle::Idle,
        limit: srp::Limits {
            max_per_hour: limits.0,
            max_pending: limits.1,
        },
        interval_minutes: 1,
        now: updated_at.to_string(),
    });
    state.enabled = true;
    state.last_cycle_started_at = Some(anchor.to_string());
    state.sync = srp::SyncStatus {
        state: srp::SyncState::Ok,
        at: Some(anchor.to_string()),
        error: None,
    };
    state.newest_cycle_id = Some(newest_cycle_id.to_string());
    state.updated_at = updated_at.to_string();
    let path = match version {
        Some(version) => srp::versioned_state_path(state_dir, repo, Some(version)),
        None => srp::state_path(state_dir, repo),
    };
    std::fs::create_dir_all(path.parent().expect("a state directory")).expect("state directory");
    srp::write_state(&path, &state).expect("a published state");
}

fn read_srp_published(path: &Path) -> Option<PublishedSnapshot> {
    srp::read_state(path).map(|state| {
        (
            state.last_cycle_started_at,
            state.newest_cycle_id,
            state.limits.max_per_hour,
            state.limits.max_pending,
            state.sync.at,
        )
    })
}

fn start_srp(repo: &Path, state_dir: &Path) -> bool {
    let mut options = srp::WorkerOptions::new(repo, state_dir);
    options.harness_version = Some(VERSION.to_string());
    let worker = srp::Worker::new(options);
    worker.start("acme/fixture")
}

fn write_api_published(
    state_dir: &Path,
    repo: &Path,
    version: Option<&str>,
    anchor: &str,
    newest_cycle_id: &str,
    limits: (Option<i64>, Option<i64>),
    updated_at: &str,
) {
    let mut state = api::empty_state(api::EmptyStateOptions {
        repo: "acme/fixture".to_string(),
        root: repo.to_string_lossy().into_owned(),
        lifecycle: api::Lifecycle::Idle,
        limit: api::Limits {
            max_per_hour: limits.0,
            max_pending: limits.1,
        },
        interval_minutes: 1,
        now: updated_at.to_string(),
    });
    state.enabled = true;
    state.last_cycle_started_at = Some(anchor.to_string());
    state.sync = api::SyncStatus {
        state: api::SyncState::Ok,
        at: Some(anchor.to_string()),
        error: None,
    };
    state.newest_cycle_id = Some(newest_cycle_id.to_string());
    state.updated_at = updated_at.to_string();
    let path = match version {
        Some(version) => api::versioned_state_path(state_dir, repo, Some(version)),
        None => api::state_path(state_dir, repo),
    };
    std::fs::create_dir_all(path.parent().expect("a state directory")).expect("state directory");
    api::write_state(&path, &state).expect("a published state");
}

fn read_api_published(path: &Path) -> Option<PublishedSnapshot> {
    api::read_state(path).map(|state| {
        (
            state.last_cycle_started_at,
            state.newest_cycle_id,
            state.limits.max_per_hour,
            state.limits.max_pending,
            state.sync.at,
        )
    })
}

fn start_api(repo: &Path, state_dir: &Path) -> bool {
    let mut options = api::WorkerOptions::new(repo, state_dir);
    options.harness_version = Some(VERSION.to_string());
    let worker = api::Worker::new(options);
    worker.start("acme/fixture")
}

fn published_families() -> Vec<(&'static str, PublishedFamily)> {
    vec![
        (
            "dead code",
            PublishedFamily {
                versioned_state_path: dead::versioned_state_path,
                write: write_dead_published,
                read: read_dead_published,
                start: start_dead,
            },
        ),
        (
            "single responsibility",
            PublishedFamily {
                versioned_state_path: srp::versioned_state_path,
                write: write_srp_published,
                read: read_srp_published,
                start: start_srp,
            },
        ),
        (
            "api standards",
            PublishedFamily {
                versioned_state_path: api::versioned_state_path,
                write: write_api_published,
                read: read_api_published,
                start: start_api,
            },
        ),
    ]
}

fn assert_newest_is_inherited(label: &str, family: &PublishedFamily) {
    let fixture = Fixture::new(&format!("inherit-newest-{label}"));
    let write = family.write;
    write(
        &fixture.state_dir,
        &fixture.repo,
        None,
        "2026-01-01T00:00:00.000Z",
        "legacy-cycle",
        (Some(11), Some(2)),
        "2026-01-01T00:00:00.000Z",
    );
    write(
        &fixture.state_dir,
        &fixture.repo,
        Some("0.0.1"),
        "2026-01-02T00:00:00.000Z",
        "v1-cycle",
        (Some(22), Some(3)),
        "2026-01-02T00:00:00.000Z",
    );
    write(
        &fixture.state_dir,
        &fixture.repo,
        Some("0.0.2"),
        "2026-01-03T00:00:00.000Z",
        "v2-cycle",
        (Some(33), Some(4)),
        "2026-01-03T00:00:00.000Z",
    );
    assert!((family.start)(&fixture.repo, &fixture.state_dir));
    let published = (family.read)(&(family.versioned_state_path)(
        &fixture.state_dir,
        &fixture.repo,
        Some(VERSION),
    ))
    .expect("the published state");
    assert_eq!(
        published.0.as_deref(),
        Some("2026-01-03T00:00:00.000Z"),
        "{label}: the newest cadence anchor is inherited"
    );
    assert_eq!(published.1.as_deref(), Some("v2-cycle"), "{label}");
    assert_eq!(published.2, Some(33), "{label}");
    assert_eq!(published.3, Some(4), "{label}");
    assert_eq!(
        published.4.as_deref(),
        Some("2026-01-03T00:00:00.000Z"),
        "{label}: the newest sync instant is inherited"
    );
}

fn assert_versioned_outranks_legacy(label: &str, family: &PublishedFamily) {
    let fixture = Fixture::new(&format!("inherit-precedence-{label}"));
    let write = family.write;
    write(
        &fixture.state_dir,
        &fixture.repo,
        None,
        "2026-01-01T00:00:00.000Z",
        "legacy-cycle",
        (Some(11), Some(2)),
        "2026-01-01T00:00:00.000Z",
    );
    write(
        &fixture.state_dir,
        &fixture.repo,
        Some("0.0.1"),
        "2026-01-05T00:00:00.000Z",
        "v1-cycle",
        (Some(22), Some(3)),
        "2026-01-05T00:00:00.000Z",
    );
    assert!((family.start)(&fixture.repo, &fixture.state_dir));
    let published = (family.read)(&(family.versioned_state_path)(
        &fixture.state_dir,
        &fixture.repo,
        Some(VERSION),
    ))
    .expect("the published state");
    assert_eq!(
        published.0.as_deref(),
        Some("2026-01-05T00:00:00.000Z"),
        "{label}: the newer versioned anchor wins"
    );
    assert_eq!(published.1.as_deref(), Some("v1-cycle"), "{label}");
    assert_eq!(published.2, Some(22), "{label}");
    assert_eq!(published.3, Some(3), "{label}");

    let legacy_only = Fixture::new(&format!("inherit-legacy-only-{label}"));
    write(
        &legacy_only.state_dir,
        &legacy_only.repo,
        None,
        "2026-01-01T00:00:00.000Z",
        "legacy-cycle",
        (Some(11), Some(2)),
        "2026-01-01T00:00:00.000Z",
    );
    assert!((family.start)(&legacy_only.repo, &legacy_only.state_dir));
    let published = (family.read)(&(family.versioned_state_path)(
        &legacy_only.state_dir,
        &legacy_only.repo,
        Some(VERSION),
    ))
    .expect("the published state");
    assert_eq!(
        published.0.as_deref(),
        Some("2026-01-01T00:00:00.000Z"),
        "{label}: the legacy file is used when it is the only state"
    );
    assert_eq!(published.1.as_deref(), Some("legacy-cycle"), "{label}");
    assert_eq!(published.2, Some(11), "{label}");
}

fn assert_own_state_is_kept(label: &str, family: &PublishedFamily) {
    let fixture = Fixture::new(&format!("inherit-own-{label}"));
    let write = family.write;
    write(
        &fixture.state_dir,
        &fixture.repo,
        None,
        "2026-01-04T00:00:00.000Z",
        "legacy-cycle",
        (Some(11), Some(2)),
        "2026-01-04T00:00:00.000Z",
    );
    write(
        &fixture.state_dir,
        &fixture.repo,
        Some("0.0.1"),
        "2026-01-05T00:00:00.000Z",
        "v1-cycle",
        (Some(22), Some(3)),
        "2026-01-05T00:00:00.000Z",
    );
    write(
        &fixture.state_dir,
        &fixture.repo,
        Some(VERSION),
        "2026-01-02T00:00:00.000Z",
        "own-cycle",
        (Some(44), Some(5)),
        "2026-01-02T00:00:00.000Z",
    );
    assert!((family.start)(&fixture.repo, &fixture.state_dir));
    let published = (family.read)(&(family.versioned_state_path)(
        &fixture.state_dir,
        &fixture.repo,
        Some(VERSION),
    ))
    .expect("the published state");
    assert_eq!(
        published.0.as_deref(),
        Some("2026-01-02T00:00:00.000Z"),
        "{label}: the version's own anchor is kept whatever other timestamps say"
    );
    assert_eq!(published.1.as_deref(), Some("own-cycle"), "{label}");
    assert_eq!(published.2, Some(44), "{label}");
}

#[test]
fn every_audited_family_inherits_the_newest_published_state() {
    for (label, family) in published_families() {
        assert_newest_is_inherited(label, &family);
    }
}

#[test]
fn every_audited_family_prefers_a_newer_versioned_state_to_the_legacy_file() {
    for (label, family) in published_families() {
        assert_versioned_outranks_legacy(label, &family);
    }
}

#[test]
fn every_audited_family_keeps_its_own_published_state() {
    for (label, family) in published_families() {
        assert_own_state_is_kept(label, &family);
    }
}
