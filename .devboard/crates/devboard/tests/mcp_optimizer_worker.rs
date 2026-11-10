//! The MCP optimizer worker: the cycle over a fixture repository, the
//! projection bytes, settings and caps, failure recording, and drain.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use devboard::workers::mcp_optimizer as mcp;
use mcp::{
    build_families, cycle_lock_path, family_tag, load_ledger, mcp_optimizer_directory,
    normalize_command_signature, read_status, read_worker_state, run_cycle, run_worker,
    select_sessions, settings_path, versioned_control_directory, versioned_lock_path,
    versioned_worker_directory, write_command, write_settings, Activity, ActivityOptions, Command,
    CycleOptions, CycleResult, CycleRunner, Delivery, DeliveryFuture, DeliveryResult, Family,
    FamilyAction, FamilyEntry, FamilyKind, IssueReader, IssueReaderFuture, Ledger, OpenIssue,
    ProjectedIssue, Report, ReportWindow, Settings, SynthesisFuture, SynthesisPaths,
    SynthesisResult, WorkerOptions, CYCLE_BUSY_NOTICE,
};
use serde_json::{json, Value};

const NOW_TEXT: &str = "2026-01-10T12:00:00.000Z";
fn fixed_ms() -> i64 {
    mcp::parse_instant_millis(NOW_TEXT).expect("the fixed clock in milliseconds")
}
const START_TEXT: &str = "2026-01-09T12:00:00.000Z";

fn harness_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .expect("the crate sits inside the harness")
}

struct Fixture {
    root: PathBuf,
    repo_dir: PathBuf,
    state_dir: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let index = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = harness_root().join(".test-tmp").join(format!(
            "mcp-optimizer-{name}-{}-{index}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let repo_dir = root.join("checkout");
        let state_dir = root.join("state");
        std::fs::create_dir_all(repo_dir.join(".devboard")).expect("the fixture checkout");
        std::fs::create_dir_all(mcp_optimizer_directory(&state_dir)).expect("the coach directory");
        Self {
            root,
            repo_dir,
            state_dir,
        }
    }

    fn directory(&self) -> PathBuf {
        mcp_optimizer_directory(&self.state_dir)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn now() -> time::OffsetDateTime {
    mcp::parse_instant(NOW_TEXT).expect("the fixed clock")
}

fn minutes_ago(minutes: i64) -> String {
    mcp::iso(mcp::from_millis(fixed_ms() - minutes * 60_000))
}

fn memory_delivery(open: Vec<OpenIssue>) -> Arc<MemoryDelivery> {
    Arc::new(MemoryDelivery {
        issues: Mutex::new(open),
        created: Mutex::new(Vec::new()),
    })
}

struct MemoryDelivery {
    issues: Mutex<Vec<OpenIssue>>,
    created: Mutex<Vec<(String, String)>>,
}

impl Delivery for MemoryDelivery {
    fn repository(&self) -> String {
        "acme/fixture".to_string()
    }

    fn list(&self) -> DeliveryFuture<'_, anyhow::Result<Vec<OpenIssue>>> {
        Box::pin(async move { Ok(self.issues.lock().expect("the fixture issues").clone()) })
    }

    fn create<'a>(&'a self, title: String, body: String) -> DeliveryFuture<'a, DeliveryResult> {
        Box::pin(async move {
            let mut created = self.created.lock().expect("the fixture calls");
            created.push((title.clone(), body.clone()));
            let mut issues = self.issues.lock().expect("the fixture issues");
            let number = issues.len() as u64 + 1;
            let url = format!("https://forge.test/acme/fixture/issues/{number}");
            issues.push(OpenIssue {
                number,
                title,
                body,
                url: url.clone(),
            });
            DeliveryResult::Created { url }
        })
    }
}

/// A delivery whose open-issue read fails with one diagnostic line, so a cycle
/// can be run against a forge that is unavailable or refused the read.
struct FailingListDelivery {
    detail: String,
    unavailable: bool,
}

impl Delivery for FailingListDelivery {
    fn repository(&self) -> String {
        "acme/fixture".to_string()
    }

    fn list(&self) -> DeliveryFuture<'_, anyhow::Result<Vec<OpenIssue>>> {
        let detail = self.detail.clone();
        let error = if self.unavailable {
            anyhow::Error::new(mcp::ForgeReadUnavailable::new(detail))
        } else {
            anyhow::anyhow!(detail)
        };
        Box::pin(async move { Err(error) })
    }

    fn create<'a>(&'a self, _title: String, _body: String) -> DeliveryFuture<'a, DeliveryResult> {
        Box::pin(async move {
            DeliveryResult::Failed {
                reason: "the open issue read failed, so nothing was filed".to_string(),
            }
        })
    }
}

/// A synthesis replacement that performs the same MCP writes a real turn
/// would: one `issue_create` record, or one skip record.
fn stub_synthesis(calls: Arc<Mutex<Vec<(String, String)>>>) -> mcp::Synthesize {
    Arc::new(
        move |family: Family, prompt: String, paths: SynthesisPaths| -> SynthesisFuture {
            calls
                .lock()
                .expect("the synthesis calls")
                .push((family.key.clone(), prompt.clone()));
            let hold = prompt.contains("\"filingRoom\": 0");
            let key = family.key.clone();
            Box::pin(async move {
                if hold {
                    let record = json!({
                        "tool": "mcp_optimizer_proposal_skip",
                        "at": NOW_TEXT,
                        "ok": true,
                        "value": {
                            "family": key,
                            "status": "skipped",
                            "reason": "the cycle's filing room is zero",
                        },
                    });
                    std::fs::write(
                        &paths.skip_log_path,
                        format!("{}\n", devboard::jsjson::stringify(&record)),
                    )
                    .expect("the skip log");
                    return SynthesisResult {
                        ok: true,
                        model: "stub".to_string(),
                        duration_ms: 1,
                        text: Some(String::new()),
                        reason: None,
                        timed_out: false,
                    };
                }
                let record = json!({
                    "tool": "issue_create",
                    "at": NOW_TEXT,
                    "ok": true,
                    "value": {
                        "number": 1,
                        "url": "https://forge.test/acme/fixture/issues/1",
                        "title": format!("[mcp-optimizer] {key}"),
                        "labels": [],
                    },
                });
                std::fs::write(
                    &paths.tool_log_path,
                    format!("{}\n", devboard::jsjson::stringify(&record)),
                )
                .expect("the tool log");
                SynthesisResult {
                    ok: true,
                    model: "stub".to_string(),
                    duration_ms: 1,
                    text: Some(String::new()),
                    reason: None,
                    timed_out: false,
                }
            })
        },
    )
}

fn write_transcript(state_dir: &Path, repo_dir: &Path, id: &str, commands: &[(&str, bool)]) {
    let directory = state_dir
        .join("providers")
        .join("agents")
        .join("fixture")
        .join("sessions")
        .join("bucket");
    std::fs::create_dir_all(&directory).expect("the transcript directory");
    let mut lines = vec![
        json!({
            "type": "session",
            "id": id,
            "cwd": repo_dir.to_string_lossy(),
            "timestamp": minutes_ago(60),
        }),
        json!({
            "type": "title",
            "title": format!("session {id}"),
        }),
    ];
    for (index, (command, is_error)) in commands.iter().enumerate() {
        lines.push(json!({
            "type": "message",
            "timestamp": minutes_ago(30),
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "toolCall",
                    "id": format!("call-{index}"),
                    "name": "bash",
                    "arguments": { "command": command },
                }],
            },
        }));
        lines.push(json!({
            "type": "message",
            "timestamp": minutes_ago(30),
            "message": {
                "role": "toolResult",
                "toolCallId": format!("call-{index}"),
                "toolName": "bash",
                "content": [{ "type": "text", "text": if *is_error { "ERROR: failed" } else { "ok" } }],
                "isError": is_error,
            },
        }));
    }
    let text: Vec<String> = lines.iter().map(devboard::jsjson::stringify).collect();
    std::fs::write(
        directory.join(format!("{id}.jsonl")),
        format!("{}\n", text.join("\n")),
    )
    .expect("the transcript");
}

fn write_journal(state_dir: &Path, repo_dir: &Path, scopes: &[(&str, &str)]) {
    let path = devboard::journal::journal_file(state_dir, repo_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("the journal directory");
    }
    let lines: Vec<String> = scopes
        .iter()
        .map(|(scope, text)| {
            devboard::jsjson::stringify(&json!({
                "ts": minutes_ago(20),
                "repo": repo_dir.to_string_lossy(),
                "port": 0,
                "pid": 1,
                "kind": "question",
                "text": text,
                "scope": scope,
            }))
        })
        .collect();
    std::fs::write(path, format!("{}\n", lines.join("\n"))).expect("the journal");
}

/// The fixture's evidence: one repeated command family and one journal
/// family, which is two families for one cycle.
fn seed_evidence(fixture: &Fixture) {
    write_transcript(
        &fixture.state_dir,
        &fixture.repo_dir,
        "a1",
        &[("bun run publish 2>&1 | tail -40", false)],
    );
    write_transcript(
        &fixture.state_dir,
        &fixture.repo_dir,
        "a2",
        &[("bun run publish | tail -60", false)],
    );
    write_journal(
        &fixture.state_dir,
        &fixture.repo_dir,
        &[
            ("session-a", "how do I publish?"),
            ("session-b", "how do I publish?"),
        ],
    );
}

fn empty_report() -> Report {
    Report {
        cycle: NOW_TEXT.to_string(),
        window: ReportWindow {
            start: START_TEXT.to_string(),
            end: NOW_TEXT.to_string(),
            minutes: 1440,
        },
        sessions: 0,
        session_files: 0,
        truncated: false,
        skipped: 0,
        malformed: 0,
        journal_records: 0,
        families: 0,
        findings: Vec::new(),
        selected: Vec::new(),
        omitted: 0,
        ledger_reset: false,
        synthesis: Vec::new(),
        validations: Vec::new(),
        action: "none".to_string(),
        reason: Some("test cycle".to_string()),
        issues: Vec::new(),
        duplicates: Vec::new(),
        dropped: 0,
        pending: 0,
        report_path: String::new(),
    }
}

fn empty_cycle_result() -> CycleResult {
    CycleResult {
        report: empty_report(),
        exit_code: 0,
        run_dir: None,
    }
}

fn seed_filed_family(directory: &Path, url: &str, filed_at: &str) {
    let mut ledger = Ledger::empty();
    ledger.families.push((
        "bun run publish".to_string(),
        FamilyEntry {
            first_seen: START_TEXT.to_string(),
            last_seen: filed_at.to_string(),
            calls: json!(1),
            sessions: json!(1),
            kind: FamilyKind::Command,
            last_action: FamilyAction::Filed,
            last_issue_url: Some(url.to_string()),
            last_title: Some("[mcp-optimizer] bun run publish".to_string()),
            last_filed_at: Some(filed_at.to_string()),
        },
    ));
    mcp::save_ledger(directory, &ledger).expect("the seeded ledger");
}

struct StubReader {
    calls: AtomicUsize,
    state: String,
}

impl IssueReader for StubReader {
    fn project<'a>(&'a self, urls: &[String]) -> IssueReaderFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let urls = urls.to_vec();
        let state = self.state.clone();
        Box::pin(async move {
            Ok(urls
                .into_iter()
                .map(|url| ProjectedIssue {
                    url,
                    state: state.clone(),
                    version: None,
                })
                .collect())
        })
    }
}

#[tokio::test]
async fn the_startup_write_formats_the_projection_byte_for_byte() {
    let fixture = Fixture::new("projection");
    let directory = fixture.directory();
    seed_filed_family(
        &directory,
        "https://forge.test/acme/fixture/issues/7",
        NOW_TEXT,
    );
    let reader = Arc::new(StubReader {
        calls: AtomicUsize::new(0),
        state: "pending".to_string(),
    });
    let mut activity = Activity::new(ActivityOptions {
        repo_dir: fixture.repo_dir.clone(),
        state_dir: fixture.state_dir.clone(),
        harness_dir: harness_root(),
        running_version: None,
        environment: HashMap::new(),
        directory: Some(directory.clone()),
        reader: Some(reader.clone()),
        has_clients: None,
        now: Some(Arc::new(fixed_ms)),
        interval_ms: None,
        stale_after_ms: None,
        log: None,
        preflight: None,
        spawn_worker: Some(Arc::new(|_: &[String], _: &HashMap<String, String>| None)),
    });
    activity.begin().await;
    assert_eq!(reader.calls.load(Ordering::SeqCst), 1);
    let text = std::fs::read_to_string(directory.join("projection.json")).expect("the projection");
    assert_eq!(
        text,
        concat!(
            "{\n",
            "  \"version\": 1,\n",
            "  \"state\": \"ok\",\n",
            "  \"at\": \"2026-01-10T12:00:00.000Z\",\n",
            "  \"error\": null,\n",
            "  \"issues\": [\n",
            "    {\n",
            "      \"url\": \"https://forge.test/acme/fixture/issues/7\",\n",
            "      \"state\": \"pending\",\n",
            "      \"version\": null\n",
            "    }\n",
            "  ]\n",
            "}\n",
        )
    );
    let seeded = mcp::read_projection(&directory).expect("the parsed projection");
    assert_eq!(seeded.state, "ok");
    assert_eq!(seeded.issues.len(), 1);
    activity.dispose();
}

#[tokio::test]
async fn one_cycle_collects_a_fixture_and_files_each_selected_family() {
    let fixture = Fixture::new("cycle");
    seed_evidence(&fixture);
    let delivery = memory_delivery(Vec::new());
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(delivery.clone());
    options.synthesize = Some(stub_synthesis(prompts.clone()));
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(10),
        max_pending: Some(20),
        max_issues_per_cycle: 20,
        allowlist: vec!["bun ".to_string()],
    });
    let result = run_cycle(options).await.expect("the cycle");
    assert_eq!(result.report.action, "filed", "{:?}", result.report.reason);
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.report.families, 2);
    assert_eq!(result.report.selected.len(), 2);
    assert_eq!(result.report.issues.len(), 2);
    assert!(delivery.created.lock().expect("the calls").is_empty());
    let calls = prompts.lock().expect("the prompts");
    assert_eq!(calls.len(), 2);
    for (key, prompt) in calls.iter() {
        assert!(prompt.starts_with("## Manifesto"));
        assert!(prompt.contains(&format!("family:{}", family_tag(key))));
        assert!(prompt.contains("\"filingRoom\": 1"));
    }
    let ledger = load_ledger(&fixture.directory()).ledger;
    for issue in &result.report.issues {
        let entry = ledger.entry(&issue.family).expect("the ledger entry");
        assert_eq!(entry.last_action, FamilyAction::Filed);
        assert_eq!(entry.last_issue_url.as_deref(), Some(issue.url.as_str()));
        assert_eq!(entry.last_title.as_deref(), Some(issue.title.as_str()));
    }
    let report_path = PathBuf::from(&result.report.report_path);
    assert!(report_path.is_file());
    assert!(fixture.directory().join("latest.json").is_file());
    let status = read_status(&fixture.directory());
    assert_eq!(status.filed, 2);
    assert_eq!(status.pending, 0);
    assert_eq!(status.issues.len(), 2);
}

/// A family key is a command signature and runs to thousands of bytes, so the
/// directory one family owns cannot be the key itself: a 255-byte component
/// limit turned the whole cycle into "File name too long".
#[tokio::test]
async fn a_family_key_longer_than_a_path_component_still_runs_its_cycle() {
    let fixture = Fixture::new("long-family");
    let pad = "x".repeat(320);
    let first = format!("bun run {pad} one");
    let second = format!("bun run {pad} two");
    write_transcript(
        &fixture.state_dir,
        &fixture.repo_dir,
        "a1",
        &[(first.as_str(), false)],
    );
    write_transcript(
        &fixture.state_dir,
        &fixture.repo_dir,
        "a2",
        &[(second.as_str(), false)],
    );
    let delivery = memory_delivery(Vec::new());
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(delivery);
    options.synthesize = Some(stub_synthesis(prompts.clone()));
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(10),
        max_pending: Some(20),
        max_issues_per_cycle: 20,
        allowlist: vec!["bun ".to_string()],
    });
    let result = run_cycle(options).await.expect("the long family's cycle");
    assert_eq!(result.report.action, "filed", "{:?}", result.report.reason);
    assert_eq!(result.report.selected.len(), 2);
    let families = result.run_dir.expect("the run directory").join("families");
    let mut directories: Vec<PathBuf> = std::fs::read_dir(&families)
        .expect("the family directories")
        .map(|entry| entry.expect("the family entry").path())
        .collect();
    directories.sort();
    assert_eq!(directories.len(), 2);
    for directory in &directories {
        let name = directory
            .file_name()
            .expect("the family directory name")
            .to_string_lossy()
            .into_owned();
        assert!(name.len() <= 255, "{name}");
        assert!(
            directory.join("tool-log.jsonl").is_file(),
            "{}",
            directory.display()
        );
    }
    assert_ne!(directories[0], directories[1]);
}

#[tokio::test]
async fn the_cycle_cap_grants_filing_room_to_only_that_many_families() {
    let fixture = Fixture::new("cap");
    seed_evidence(&fixture);
    let delivery = memory_delivery(Vec::new());
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(delivery.clone());
    options.synthesize = Some(stub_synthesis(prompts.clone()));
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(10),
        max_pending: Some(20),
        max_issues_per_cycle: 1,
        allowlist: vec!["bun ".to_string()],
    });
    let result = run_cycle(options).await.expect("the cycle");
    assert_eq!(result.report.issues.len(), 1);
    assert_eq!(
        result
            .report
            .validations
            .iter()
            .filter(|entry| entry.outcome == "filed")
            .count(),
        1
    );
    assert_eq!(
        result
            .report
            .validations
            .iter()
            .filter(|entry| entry.outcome == "skipped")
            .count(),
        1
    );
    let capped = result
        .report
        .validations
        .iter()
        .find(|entry| entry.outcome == "skipped")
        .expect("the suppressed family");
    assert_eq!(capped.rule.as_deref(), Some("tool"));
    let ledger = load_ledger(&fixture.directory()).ledger;
    assert!(ledger
        .families
        .iter()
        .any(|(_, entry)| entry.last_action == FamilyAction::Capped));
}

#[tokio::test]
async fn the_rolling_hour_cap_empties_every_family_and_reads_as_capped() {
    let fixture = Fixture::new("hourly");
    seed_evidence(&fixture);
    seed_filed_family(
        &fixture.directory(),
        "https://forge.test/acme/fixture/issues/9",
        &minutes_ago(5),
    );
    let delivery = memory_delivery(Vec::new());
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(delivery.clone());
    options.synthesize = Some(stub_synthesis(prompts.clone()));
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(1),
        max_pending: Some(20),
        max_issues_per_cycle: 20,
        allowlist: vec!["bun ".to_string()],
    });
    let result = run_cycle(options).await.expect("the cycle");
    assert_eq!(result.report.action, "capped");
    assert_eq!(result.report.issues.len(), 0);
    assert!(result
        .report
        .reason
        .as_deref()
        .unwrap_or_default()
        .contains("maxPerHour 1 reached"));
    for (_, prompt) in prompts.lock().expect("the prompts").iter() {
        assert!(prompt.contains("\"filingRoom\": 0"));
    }
}

#[tokio::test]
async fn a_failed_synthesis_cycle_records_every_family_and_exits_nonzero() {
    let fixture = Fixture::new("failure");
    seed_evidence(&fixture);
    let delivery = memory_delivery(Vec::new());
    let synthesize: mcp::Synthesize = Arc::new(
        |family: Family, _prompt: String, _paths: SynthesisPaths| -> SynthesisFuture {
            Box::pin(async move {
                SynthesisResult {
                    ok: false,
                    model: "stub".to_string(),
                    duration_ms: 3,
                    text: None,
                    reason: Some(format!("peer failed for {}", family.key)),
                    timed_out: false,
                }
            })
        },
    );
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(delivery);
    options.synthesize = Some(synthesize);
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(10),
        max_pending: Some(20),
        max_issues_per_cycle: 20,
        allowlist: Vec::new(),
    });
    let result = run_cycle(options).await.expect("the cycle");
    assert_eq!(result.report.action, "failed");
    assert_eq!(result.exit_code, 1);
    assert!(result
        .report
        .reason
        .as_deref()
        .unwrap_or_default()
        .starts_with("synthesis failed for"));
    let ledger = load_ledger(&fixture.directory()).ledger;
    for summary in &result.report.selected {
        assert_eq!(
            ledger.entry(&summary.key).expect("the entry").last_action,
            FamilyAction::Failed
        );
    }
    let latest: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.directory().join("latest.json")).expect("latest.json"),
    )
    .expect("the latest report");
    assert_eq!(latest.get("action").and_then(Value::as_str), Some("failed"));
}

#[tokio::test]
async fn a_timed_out_synthesis_cycle_defers_without_failing() {
    let fixture = Fixture::new("timeout");
    seed_evidence(&fixture);
    let delivery = memory_delivery(Vec::new());
    let synthesize: mcp::Synthesize = Arc::new(
        |_family: Family, _prompt: String, _paths: SynthesisPaths| -> SynthesisFuture {
            Box::pin(async move {
                SynthesisResult {
                    ok: false,
                    model: "stub".to_string(),
                    duration_ms: 240_000,
                    text: None,
                    reason: Some("the synthesizer peer timed out after 240000ms".to_string()),
                    timed_out: true,
                }
            })
        },
    );
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(delivery);
    options.synthesize = Some(synthesize);
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(10),
        max_pending: Some(20),
        max_issues_per_cycle: 20,
        allowlist: Vec::new(),
    });
    let result = run_cycle(options).await.expect("the cycle");
    assert_eq!(
        result.report.action, "deferred",
        "{:?}",
        result.report.reason
    );
    assert_eq!(result.exit_code, 0);
    assert!(result
        .report
        .reason
        .as_deref()
        .unwrap_or_default()
        .starts_with("synthesis deferred for"));
    assert!(result.report.issues.is_empty());
    let deferred: Vec<&mcp::Validation> = result
        .report
        .validations
        .iter()
        .filter(|entry| entry.outcome == "deferred")
        .collect();
    assert_eq!(deferred.len(), result.report.selected.len());
    assert!(deferred
        .iter()
        .all(|entry| entry.rule.as_deref() == Some("timeout")));
    let ledger = load_ledger(&fixture.directory()).ledger;
    for summary in &result.report.selected {
        assert_eq!(
            ledger.entry(&summary.key).expect("the entry").last_action,
            FamilyAction::None
        );
    }
    let latest: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.directory().join("latest.json")).expect("latest.json"),
    )
    .expect("the latest report");
    assert_eq!(
        latest.get("action").and_then(Value::as_str),
        Some("deferred")
    );
}

#[tokio::test]
async fn a_forge_outage_on_the_open_issue_read_defers_the_cycle() {
    let fixture = Fixture::new("outage");
    seed_evidence(&fixture);
    let detail = concat!(
        "GET /repos/acme/fixture/issues?state=open&limit=100 failed (HTTP 500): ",
        "database is locked (5) (SQLITE_BUSY)"
    );
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(Arc::new(FailingListDelivery {
        detail: detail.to_string(),
        unavailable: true,
    }));
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(10),
        max_pending: Some(20),
        max_issues_per_cycle: 20,
        allowlist: Vec::new(),
    });
    let result = run_cycle(options).await.expect("the cycle");
    assert_eq!(
        result.report.action, "deferred",
        "{:?}",
        result.report.reason
    );
    assert_eq!(result.exit_code, 0);
    assert_eq!(
        result.report.reason,
        Some(format!("the open issues could not be read: {detail}"))
    );
    assert!(result.report.issues.is_empty());
    let latest: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.directory().join("latest.json")).expect("latest.json"),
    )
    .expect("the latest report");
    assert_eq!(
        latest.get("action").and_then(Value::as_str),
        Some("deferred")
    );
}

#[tokio::test]
async fn a_refused_open_issue_read_fails_the_cycle_with_one_reason() {
    let fixture = Fixture::new("refused");
    seed_evidence(&fixture);
    let detail = "GET /repos/acme/fixture/issues?state=open&limit=100 failed (HTTP 404): \
                  not found";
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(Arc::new(FailingListDelivery {
        detail: detail.to_string(),
        unavailable: false,
    }));
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(10),
        max_pending: Some(20),
        max_issues_per_cycle: 20,
        allowlist: Vec::new(),
    });
    let result = run_cycle(options).await.expect("the cycle");
    assert_eq!(result.report.action, "failed");
    assert_eq!(result.exit_code, 1);
    let reason = result.report.reason.clone().expect("the failure reason");
    // The delivery's own line names the request and its answer, so the cycle
    // prefix is added once: a doubled prefix names no fault.
    assert_eq!(
        reason,
        format!("the open issues could not be read: {detail}")
    );
    assert_eq!(
        reason.matches("the open issues could not be read").count(),
        1,
        "{reason}"
    );
}

#[tokio::test]
async fn a_duplicate_open_issue_is_recorded_and_files_nothing() {
    let fixture = Fixture::new("duplicate");
    seed_evidence(&fixture);
    let sessions = select_sessions(&fixture.state_dir, &fixture.repo_dir, None, None);
    let families = build_families(
        &sessions.sessions,
        &[],
        mcp::parse_instant_millis(START_TEXT).expect("the window start"),
        fixed_ms(),
        &fixture.repo_dir,
    );
    let first = families.selected.first().expect("a family").clone();
    let delivery = memory_delivery(vec![OpenIssue {
        number: 1,
        title: "[mcp-optimizer] something else".to_string(),
        body: format!("evidence family:{}", family_tag(&first.key)),
        url: "https://forge.test/acme/fixture/issues/1".to_string(),
    }]);
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.delivery = Some(delivery);
    options.synthesize = Some(stub_synthesis(prompts));
    options.settings = Some(Settings {
        interval_minutes: 60,
        max_per_hour: Some(10),
        max_pending: Some(20),
        max_issues_per_cycle: 20,
        allowlist: Vec::new(),
    });
    let result = run_cycle(options).await.expect("the cycle");
    assert!(result
        .report
        .duplicates
        .iter()
        .any(|entry| entry.family == first.key));
    assert!(result
        .report
        .issues
        .iter()
        .all(|issue| issue.family != first.key));
    assert_eq!(
        load_ledger(&fixture.directory())
            .ledger
            .entry(&first.key)
            .expect("the entry")
            .last_action,
        FamilyAction::Duplicate
    );
}

#[test]
fn settings_fall_back_per_key_and_keep_the_allowlist() {
    let parsed = mcp::parse_settings(
        r#"{"intervalMinutes":1441,"maxPerHour":0,"maxPending":null,"maxIssuesPerCycle":7,"allowlist":["bun ","git push"],"legacy":true}"#,
    )
    .expect("the parsed settings");
    assert_eq!(parsed.interval_minutes, 60);
    assert_eq!(parsed.max_per_hour, Some(10));
    assert_eq!(parsed.max_pending, None);
    assert_eq!(parsed.max_issues_per_cycle, 7);
    assert_eq!(parsed.allowlist, vec!["bun ", "git push"]);
    assert!(mcp::parse_settings("not json").is_none());

    let fixture = Fixture::new("settings");
    write_settings(
        &fixture.directory(),
        &Settings {
            interval_minutes: 15,
            max_per_hour: Some(4),
            max_pending: Some(2),
            max_issues_per_cycle: 7,
            allowlist: vec!["bun ".to_string()],
        },
    )
    .expect("the settings file");
    let text = std::fs::read_to_string(settings_path(&fixture.directory())).expect("the file");
    assert_eq!(
        text,
        concat!(
            "{\n",
            "  \"intervalMinutes\": 15,\n",
            "  \"maxPerHour\": 4,\n",
            "  \"maxPending\": 2,\n",
            "  \"maxIssuesPerCycle\": 7,\n",
            "  \"allowlist\": [\n",
            "    \"bun \"\n",
            "  ]\n",
            "}\n",
        )
    );
    assert_eq!(
        mcp::read_settings(&fixture.directory()),
        Settings {
            interval_minutes: 15,
            max_per_hour: Some(4),
            max_pending: Some(2),
            max_issues_per_cycle: 7,
            allowlist: vec!["bun ".to_string()],
        }
    );
}

#[test]
fn commands_sort_in_submission_order_and_parse_strictly() {
    let fixture = Fixture::new("control");
    let directory = fixture.directory().join("control");
    write_command(&directory, &Command::Stop).expect("a stop");
    write_command(
        &directory,
        &Command::Settings {
            interval_minutes: 15,
            max_per_hour: Some(4),
            max_pending: None,
        },
    )
    .expect("a settings command");
    let commands = mcp::take_commands(&directory);
    assert_eq!(
        commands,
        vec![
            Command::Stop,
            Command::Settings {
                interval_minutes: 15,
                max_per_hour: Some(4),
                max_pending: None,
            },
        ]
    );
    assert!(mcp::take_commands(&directory).is_empty());
    assert_eq!(
        mcp::parse_command(r#"{"type":"drain"}"#),
        Some(Command::Drain)
    );
    assert!(mcp::parse_command(
        r#"{"type":"settings","intervalMinutes":0,"maxPerHour":1,"maxPending":1}"#
    )
    .is_none());
}

#[test]
fn normalization_keeps_output_handling_out_of_the_family() {
    let repo = Path::new("/checkout");
    assert_eq!(
        normalize_command_signature("bun run publish 2>&1 | tail -40", repo),
        "bun run publish"
    );
    assert_eq!(
        normalize_command_signature("( cd /checkout && bun run publish )", repo),
        "bun run publish"
    );
    assert_eq!(
        normalize_command_signature("FOO=1 /checkout/bun run publish --watch", repo),
        "<repo>/bun run publish"
    );
    assert_eq!(
        normalize_command_signature("git -C /checkout status", repo),
        "git status"
    );
    assert!(mcp::is_trivial_command("bunx tsc"));
    assert!(mcp::is_trivial_command("cargo fmt --check --all"));
    assert!(mcp::is_trivial_command(
        "cargo clippy --workspace --all-targets -- -D warnings"
    ));
    assert!(mcp::is_trivial_command("cargo test --workspace"));
    assert!(!mcp::is_trivial_command("bun run publish"));
}

#[test]
fn a_cargo_test_evidence_row_produces_no_family() {
    let fixture = Fixture::new("cargo-families");
    write_transcript(
        &fixture.state_dir,
        &fixture.repo_dir,
        "a1",
        &[
            ("cargo test --workspace", true),
            (
                "cargo clippy --workspace --all-targets -- -D warnings",
                false,
            ),
            ("cargo fmt --check --all", false),
        ],
    );
    let selection = select_sessions(&fixture.state_dir, &fixture.repo_dir, None, None);
    assert_eq!(selection.sessions.len(), 1);
    let families = build_families(
        &selection.sessions,
        &[],
        mcp::parse_instant_millis(START_TEXT).expect("the window start"),
        fixed_ms(),
        &fixture.repo_dir,
    );
    assert!(families.families.is_empty(), "{:?}", families.families);
}

#[test]
fn a_worktree_command_and_a_fixture_command_produce_no_family() {
    let fixture = Fixture::new("families");
    write_transcript(
        &fixture.state_dir,
        &fixture.repo_dir,
        "a1",
        &[
            ("bun run publish", false),
            ("ls -la", false),
            ("echo hi", false),
        ],
    );
    write_transcript(
        &fixture.state_dir,
        &fixture.repo_dir,
        "a2",
        &[("bun run publish", true)],
    );
    let selection = select_sessions(&fixture.state_dir, &fixture.repo_dir, None, None);
    assert_eq!(selection.sessions.len(), 2);
    let families = build_families(
        &selection.sessions,
        &[],
        mcp::parse_instant_millis(START_TEXT).expect("the window start"),
        fixed_ms(),
        &fixture.repo_dir,
    );
    assert_eq!(families.families.len(), 1);
    let family = &families.families[0];
    assert_eq!(family.key, "bun run publish");
    assert_eq!(family.kind, FamilyKind::Command);
    assert_eq!(family.calls, 2);
    assert_eq!(family.sessions.len(), 2);
    assert_eq!(family.days, 1);
    assert_eq!(family.score, 4);
    assert_eq!(family.excerpts.len(), 2);
    assert_eq!(family.excerpts[0].status, "error");
}

#[tokio::test]
async fn a_settings_command_keeps_a_dashboard_save_the_worker_has_not_read() {
    let fixture = Fixture::new("worker-settings");
    let directory = fixture.directory();
    write_settings(
        &directory,
        &Settings {
            interval_minutes: 60,
            max_per_hour: Some(10),
            max_pending: Some(20),
            max_issues_per_cycle: 7,
            allowlist: vec!["bun ".to_string()],
        },
    )
    .expect("the settings file");
    let version_directory = versioned_worker_directory(&directory, Some("1.0.0"));
    write_command(
        &versioned_control_directory(&directory, Some("1.0.0")),
        &Command::Settings {
            interval_minutes: 15,
            max_per_hour: Some(4),
            max_pending: Some(2),
        },
    )
    .expect("the settings command");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let cycle_seen = seen.clone();
    struct RecordCycle {
        seen: Arc<Mutex<Vec<Settings>>>,
    }
    impl CycleRunner for RecordCycle {
        fn run<'a>(
            &'a self,
            options: CycleOptions,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<CycleResult>> + Send + 'a>> {
            self.seen
                .lock()
                .expect("the seen settings")
                .push(options.settings.clone().expect("the settings"));
            Box::pin(async { Ok(empty_cycle_result()) })
        }
    }
    let mut options = WorkerOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.harness_version = Some(Some("1.0.0".to_string()));
    options.control_poll_ms = Some(10);
    options.cycle = Some(Arc::new(RecordCycle { seen: cycle_seen }));
    options.log = Some(Arc::new(|_: &str| {}));
    options.argv = vec!["devboard".to_string(), "worker".to_string()];
    let handle = tokio::spawn(async move { run_worker(options).await });
    wait_for(
        || {
            if seen.lock().expect("the seen settings").is_empty() {
                None
            } else {
                Some(())
            }
        },
        "the first cycle",
    )
    .await;
    let settings = mcp::read_settings(&directory);
    assert_eq!(settings.interval_minutes, 15);
    assert_eq!(settings.max_per_hour, Some(4));
    assert_eq!(settings.max_pending, Some(2));
    assert_eq!(settings.max_issues_per_cycle, 7);
    assert_eq!(settings.allowlist, vec!["bun ".to_string()]);
    assert_eq!(
        seen.lock().expect("the seen settings")[0].interval_minutes,
        15
    );
    write_command(
        &versioned_control_directory(&directory, Some("1.0.0")),
        &Command::Stop,
    )
    .expect("the stop command");
    let code = tokio::time::timeout(Duration::from_secs(10), handle)
        .await
        .expect("the worker stops")
        .expect("the worker task")
        .expect("the worker result");
    assert_eq!(code, 0);
    let state = read_worker_state(&version_directory).expect("the stopped state");
    assert_eq!(state.lifecycle, mcp::Lifecycle::Stopped);
    assert!(!state.enabled);
}

struct GateCycle {
    order: Arc<Mutex<Vec<String>>>,
    gate: Arc<tokio::sync::Notify>,
    calls: Arc<AtomicUsize>,
    hold: bool,
    label: &'static str,
}

impl CycleRunner for GateCycle {
    fn run<'a>(
        &'a self,
        _options: CycleOptions,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<CycleResult>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.order
            .lock()
            .expect("the order")
            .push(format!("{}:start", self.label));
        let hold = self.hold;
        let gate = self.gate.clone();
        let order = self.order.clone();
        let label = self.label;
        Box::pin(async move {
            if hold {
                gate.notified().await;
            }
            order
                .lock()
                .expect("the order")
                .push(format!("{label}:end"));
            Ok(empty_cycle_result())
        })
    }
}

async fn wait_for<T, F>(read: F, description: &str) -> T
where
    F: Fn() -> Option<T>,
{
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = read() {
            return value;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {description}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_drained_worker_finishes_its_cycle_then_the_next_version_claims_the_next() {
    let fixture = Fixture::new("drain");
    let directory = fixture.directory();
    let order = Arc::new(Mutex::new(Vec::new()));
    let gate = Arc::new(tokio::sync::Notify::new());
    let old_calls = Arc::new(AtomicUsize::new(0));
    let new_calls = Arc::new(AtomicUsize::new(0));

    let mut old_options = WorkerOptions::new(&fixture.repo_dir, &fixture.state_dir);
    old_options.harness_version = Some(Some("1.0.0".to_string()));
    old_options.control_poll_ms = Some(10);
    old_options.log = Some(Arc::new(|_: &str| {}));
    old_options.argv = vec!["devboard".to_string()];
    old_options.cycle = Some(Arc::new(GateCycle {
        order: order.clone(),
        gate: gate.clone(),
        calls: old_calls.clone(),
        hold: true,
        label: "old",
    }));
    let old_run = tokio::spawn(async move { run_worker(old_options).await });

    wait_for(
        || (old_calls.load(Ordering::SeqCst) == 1).then_some(()),
        "the old worker's cycle",
    )
    .await;
    assert!(mcp::live_lock_owner(&cycle_lock_path(&directory)).is_some());

    let mut new_options = WorkerOptions::new(&fixture.repo_dir, &fixture.state_dir);
    new_options.harness_version = Some(Some("1.0.1".to_string()));
    new_options.control_poll_ms = Some(10);
    new_options.log = Some(Arc::new(|_: &str| {}));
    new_options.argv = vec!["devboard".to_string()];
    new_options.cycle = Some(Arc::new(GateCycle {
        order: order.clone(),
        gate: gate.clone(),
        calls: new_calls.clone(),
        hold: false,
        label: "new",
    }));
    let new_run = tokio::spawn(async move { run_worker(new_options).await });

    wait_for(
        || {
            let state = read_worker_state(&versioned_worker_directory(&directory, Some("1.0.1")))?;
            (state.notice.as_deref() == Some(CYCLE_BUSY_NOTICE)).then_some(())
        },
        "the new worker to find the cycle claimed",
    )
    .await;
    assert_eq!(new_calls.load(Ordering::SeqCst), 0);
    assert_eq!(order.lock().expect("the order").clone(), vec!["old:start"]);

    write_command(
        &versioned_control_directory(&directory, Some("1.0.0")),
        &Command::Drain,
    )
    .expect("the drain command");
    let draining = wait_for(
        || {
            let state = read_worker_state(&versioned_worker_directory(&directory, Some("1.0.0")))?;
            (state.draining && state.lifecycle == mcp::Lifecycle::Stopping).then_some(state)
        },
        "the old worker to publish draining",
    )
    .await;
    assert_eq!(draining.lifecycle, mcp::Lifecycle::Stopping);
    assert_eq!(new_calls.load(Ordering::SeqCst), 0);

    gate.notify_waiters();
    tokio::time::timeout(Duration::from_secs(10), old_run)
        .await
        .expect("the old worker exits")
        .expect("the old worker task")
        .expect("the old worker result");
    let stopped = read_worker_state(&versioned_worker_directory(&directory, Some("1.0.0")))
        .expect("the stopped state");
    assert_eq!(stopped.lifecycle, mcp::Lifecycle::Stopped);
    assert!(mcp::live_lock_owner(&versioned_lock_path(&directory, Some("1.0.0"))).is_none());
    {
        let order = order.lock().expect("the order");
        assert_eq!(order.first().map(String::as_str), Some("old:start"));
        assert_eq!(order.get(1).map(String::as_str), Some("old:end"));
    }

    wait_for(
        || (order.lock().expect("the order").len() == 4).then_some(()),
        "the new worker's cycle",
    )
    .await;
    assert_eq!(new_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        order.lock().expect("the order").clone(),
        vec!["old:start", "old:end", "new:start", "new:end"]
    );

    write_command(
        &versioned_control_directory(&directory, Some("1.0.1")),
        &Command::Drain,
    )
    .expect("the drain command");
    tokio::time::timeout(Duration::from_secs(10), new_run)
        .await
        .expect("the new worker exits")
        .expect("the new worker task")
        .expect("the new worker result");
    assert_eq!(
        read_worker_state(&versioned_worker_directory(&directory, Some("1.0.1")))
            .expect("the stopped state")
            .lifecycle,
        mcp::Lifecycle::Stopped
    );
    assert!(mcp::live_lock_owner(&versioned_lock_path(&directory, Some("1.0.1"))).is_none());
    assert_eq!(old_calls.load(Ordering::SeqCst), 1);
    assert_eq!(new_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_newer_harness_starts_once_and_drains_the_older_worker() {
    let fixture = Fixture::new("takeover");
    let directory = fixture.directory();
    std::fs::write(
        fixture.repo_dir.join(".devboard").join("package.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"1.0.1\"}\n",
    )
    .expect("the harness manifest");
    let guard = mcp::acquire_lock(
        &versioned_lock_path(&directory, Some("1.0.0")),
        &mcp::LockDetails {
            repo: fixture.repo_dir.to_string_lossy().into_owned(),
            state_dir: fixture.state_dir.to_string_lossy().into_owned(),
            harness_version: Some("1.0.0".to_string()),
            argv: Vec::new(),
        },
    )
    .expect("the old worker's lock");
    let old_state = mcp::WorkerState {
        pid: std::process::id(),
        started_at: NOW_TEXT.to_string(),
        root: fixture.repo_dir.to_string_lossy().into_owned(),
        state_dir: fixture.state_dir.to_string_lossy().into_owned(),
        lifecycle: mcp::Lifecycle::Running,
        enabled: true,
        draining: false,
        harness_version: Some("1.0.0".to_string()),
        argv: Vec::new(),
        last_run_at: None,
        next_run_at: None,
        last_error: None,
        notice: None,
        updated_at: NOW_TEXT.to_string(),
    };
    mcp::write_worker_state(
        &versioned_worker_directory(&directory, Some("1.0.0")),
        &old_state,
    )
    .expect("the old worker's state");
    let spawned = Arc::new(AtomicUsize::new(0));
    let spawned_count = spawned.clone();
    let mut activity = Activity::new(ActivityOptions {
        repo_dir: fixture.repo_dir.clone(),
        state_dir: fixture.state_dir.clone(),
        harness_dir: harness_root(),
        running_version: Some("1.0.1".to_string()),
        environment: HashMap::new(),
        directory: Some(directory.clone()),
        reader: Some(Arc::new(StubReader {
            calls: AtomicUsize::new(0),
            state: "pending".to_string(),
        })),
        has_clients: None,
        now: Some(Arc::new(fixed_ms)),
        interval_ms: None,
        stale_after_ms: None,
        log: None,
        preflight: Some(Arc::new(|_, _| Box::pin(async { mcp::Preflight::Ok }))),
        spawn_worker: Some(Arc::new(
            move |_: &[String], _: &HashMap<String, String>| {
                spawned_count.fetch_add(1, Ordering::SeqCst);
                Some(std::process::id())
            },
        )),
    });
    activity.begin().await;
    assert_eq!(spawned.load(Ordering::SeqCst), 1);
    let commands = mcp::take_commands(&versioned_control_directory(&directory, Some("1.0.0")));
    assert_eq!(commands, vec![Command::Drain]);
    let snapshot = activity.snapshot().await;
    assert_eq!(
        snapshot.get("attached").and_then(Value::as_bool),
        Some(true)
    );
    // Any live worker of this family already serves new cycles; Start never
    // duplicates one, and the takeover runs once per bridge lifetime.
    assert!(activity.start().await.ok);
    activity.begin().await;
    assert_eq!(spawned.load(Ordering::SeqCst), 1);
    activity.dispose();
    drop(guard);
}

#[tokio::test]
async fn a_version_two_ledger_is_discarded_and_the_report_says_so() {
    let fixture = Fixture::new("ledger-reset");
    let directory = fixture.directory();
    std::fs::write(
        directory.join("state.json"),
        "{\"version\":2,\"families\":{},\"pendingFiling\":[]}\n",
    )
    .expect("the old ledger");
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.collect = Some(Arc::new(|| mcp::Collection {
        window_start: START_TEXT.to_string(),
        window_end: NOW_TEXT.to_string(),
        ..Default::default()
    }));
    options.delivery = Some(memory_delivery(Vec::new()));
    let result = run_cycle(options).await.expect("the cycle");
    assert!(result.report.ledger_reset);
    assert_eq!(result.report.action, "none");
    assert_eq!(
        result.report.reason.as_deref(),
        Some("no family in the window")
    );
    assert!(!load_ledger(&directory).reset);
}

#[tokio::test]
async fn a_pending_queue_written_by_an_older_revision_is_dropped_and_recorded() {
    let fixture = Fixture::new("pending");
    let directory = fixture.directory();
    let mut ledger = Ledger::empty();
    ledger.pending_filing.push(mcp::PendingFiling {
        family: "bun run publish".to_string(),
        kind: FamilyKind::Command,
        title: "[mcp-optimizer] bun run publish".to_string(),
        body: "body".to_string(),
        score: json!(4),
        created_at: NOW_TEXT.to_string(),
    });
    mcp::save_ledger(&directory, &ledger).expect("the queued proposal");
    let mut options = CycleOptions::new(&fixture.repo_dir, &fixture.state_dir);
    options.now = Some(now());
    options.collect = Some(Arc::new(|| mcp::Collection {
        window_start: START_TEXT.to_string(),
        window_end: NOW_TEXT.to_string(),
        ..Default::default()
    }));
    options.delivery = Some(memory_delivery(Vec::new()));
    let result = run_cycle(options).await.expect("the cycle");
    assert!(!result.report.ledger_reset);
    assert_eq!(result.report.dropped, 1);
    assert!(result.report.validations.iter().any(|entry| {
        entry.outcome == "dropped" && entry.rule.as_deref() == Some("pending-queue-removed")
    }));
    assert!(load_ledger(&directory).ledger.pending_filing.is_empty());
}
