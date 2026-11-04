//! The Consistent Naming worker: one full cycle over a fixture checkout, its
//! seven-category provenance, the repository-wide occurrence list, the
//! glossary authority and conflict rule, the seeded entry point, the idle
//! deadline that a progress beat restarts, and the preflight refusals.
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
use devboard::workers::consistent_naming as cn;
use devboard::workers::dead_code as dead;

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
                "consistent-naming-{label}-{}-{index}",
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

    fn naming_inputs(&self) -> String {
        let skill = naming_skill();
        self.write(".omp/skills/devboard-consistent-naming/SKILL.md", &skill);
        self.write(
            "src/price.ts",
            "export function unitPrice() {\n  return 1;\n}\nexport const price = unitPrice;\n",
        );
        self.write(
            "client/PriceCard.svelte",
            "<script>\n  export let price = 0;\n</script>\n<p>{price}</p>\n",
        );
        self.write("src/price.test.ts", "export const priceProbe = 1;\n");
        skill
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn naming_skill() -> String {
    [
        "# Consistent Naming",
        "",
        "## Architectural Violations",
        "",
        "- **Synonymous naming:** The same concept appears under two or more names, so a reader must learn that the names denote one thing.",
        "- **Semantic ambiguity:** One name denotes more than one concept, or its meaning depends on where it is read.",
        "- **Inconsistent vocabulary:** The same concept is named differently across layers, modules, tests, or documentation.",
        "- **Misleading naming:** A name suggests a meaning the concept does not have, such as behavior, ownership, or a scope it lacks.",
        "- **Unnecessary terminology:** A new term is introduced for a concept that already has a name, adding vocabulary without adding meaning.",
        "- **Conceptual collision:** Two distinct concepts share one name within a context, so the name no longer identifies either of them.",
        "- **Implementation-driven naming:** A concept is named after its current implementation detail (a table, a transport, a framework type, or an algorithm) instead of after the domain concept.",
        "",
    ]
    .join("\n")
}

fn naming_body(category: &str, options: BodyOptions<'_>) -> String {
    let title = match category {
        "synonymous naming" => "Synonymous naming",
        "semantic ambiguity" => "Semantic ambiguity",
        "inconsistent vocabulary" => "Inconsistent vocabulary",
        "misleading naming" => "Misleading naming",
        "unnecessary terminology" => "Unnecessary terminology",
        "conceptual collision" => "Conceptual collision",
        _ => "Implementation-driven naming",
    };
    let skill = naming_skill();
    let directive = skill
        .split('\n')
        .find(|line| line.starts_with(&format!("- **{title}:**")))
        .expect("a directive");
    let mut body = vec![
        "## Category".to_string(),
        String::new(),
        category.to_string(),
        String::new(),
        "## Skill".to_string(),
        String::new(),
        cn::consistent_naming_config().skill_document,
        String::new(),
        "## Directive".to_string(),
        String::new(),
        format!("> {directive}"),
        String::new(),
        "## Concept".to_string(),
        String::new(),
        options.concept.to_string(),
        String::new(),
        "## Name in use".to_string(),
        String::new(),
        options.name_in_use.to_string(),
        String::new(),
        "## Proposed name".to_string(),
        String::new(),
        options.proposed.to_string(),
        String::new(),
        "## Why the name is inconsistent".to_string(),
        String::new(),
        "One concept is named twice.".to_string(),
        String::new(),
        "## Rename".to_string(),
        String::new(),
        format!("Rename every occurrence to {}.", options.proposed),
        String::new(),
        "## Evidence".to_string(),
        String::new(),
        format!("- `{}:{}`", options.evidence_path, options.evidence_lines),
        format!("  > {}", options.quote),
        String::new(),
        "## Occurrences".to_string(),
        String::new(),
    ];
    for (path, span) in options.occurrences {
        body.push(format!("- `{path}:{span}`"));
    }
    body.extend([
        String::new(),
        "## Acceptance criteria".to_string(),
        String::new(),
        format!("- No occurrence of {} remains.", options.name_in_use),
        String::new(),
    ]);
    if let Some(glossary) = options.glossary {
        body.push(glossary.to_string());
    }
    body.join("\n")
}

#[derive(Clone, Copy)]
struct BodyOptions<'a> {
    concept: &'a str,
    name_in_use: &'a str,
    proposed: &'a str,
    evidence_path: &'a str,
    evidence_lines: &'a str,
    quote: &'a str,
    occurrences: &'a [(&'a str, &'a str)],
    glossary: Option<&'a str>,
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

/// A peer that beats the cycle heartbeat on its own interval and finishes at
/// `lifetime`, so a long turn with progress stays alive.
fn beating_connect(interval: Duration, lifetime: Duration) -> api::ConnectFn {
    Arc::new(move |options| {
        Box::pin(async move {
            let callbacks = options.callbacks.clone();
            let action: PeerAction = Arc::new(move |_prompt: String| {
                let callbacks = callbacks.clone();
                Box::pin(async move {
                    let start = std::time::Instant::now();
                    while start.elapsed() < lifetime {
                        tokio::time::sleep(interval).await;
                        if let Some(beat) = &callbacks.on_session_update {
                            beat();
                        }
                    }
                    Ok(())
                })
            });
            Ok(Arc::new(FakePeer { action }) as Arc<dyn api::Peer>)
        }) as api::PeerConnectFuture
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

#[derive(Default)]
struct NamingForge {
    issues: Mutex<Vec<cn::ForgeIssue>>,
}

impl cn::ForgeClient for NamingForge {
    fn list_issues(&self) -> cn::ForgeFuture<'_, Vec<cn::ForgeIssue>> {
        Box::pin(async move { Ok(self.issues.lock().expect("the fake").clone()) })
    }

    fn list_open_issue_titles(&self) -> cn::ForgeFuture<'_, Vec<String>> {
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

fn naming_worker(
    fixture: &Fixture,
    forge: Arc<NamingForge>,
    connect: api::ConnectFn,
) -> Arc<cn::Worker> {
    let mut options = cn::WorkerOptions::new(&fixture.repo, &fixture.state_dir);
    options.harness_version = Some(VERSION.to_string());
    options.sync_ms = Some(60_000);
    options.cadence_ms = Some(60 * 60_000);
    options.manual_cycles = true;
    options.connect = Some(connect);
    options.forge = Some(forge as Arc<dyn cn::ForgeClient>);
    cn::Worker::new(options)
}

/* ------------------------------------------------------------------------ */
/* One full cycle                                                            */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn consistent_naming_files_one_proven_vocabulary_issue() {
    let fixture = Fixture::new("cycle");
    fixture.naming_inputs();
    fixture.write(
        ".omp/discover/glossary/orders.glossary.yaml",
        "boundedContext: orders\nconcepts:\n  - id: item_price\n    prefLabels:\n      - text: Amount\n    altLabels:\n      - text: Charge\n",
    );
    let forge = Arc::new(NamingForge::default());
    let forge_for_peer = Arc::clone(&forge);
    let connect = fake_connect(move |prompt| {
        let forge = Arc::clone(&forge_for_peer);
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/consistent-naming ");
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(directory.join("request.json")).expect("a request"),
            )
            .expect("request JSON");
            assert_eq!(request["surface"], "consistent-naming");
            assert_eq!(request["issueRoom"], 5);
            assert_eq!(
                request["skillPath"],
                ".omp/skills/devboard-consistent-naming/SKILL.md"
            );
            let categories = request["categories"].as_array().expect("categories");
            assert_eq!(categories.len(), 7);
            assert_eq!(categories[0], "synonymous naming");
            assert_eq!(
                request["glossaries"][0],
                ".omp/discover/glossary/orders.glossary.yaml"
            );
            let entry = request["entryPoint"].as_object().expect("an entry point");
            assert!(entry["path"].as_str().is_some_and(|path| !path.is_empty()));
            assert!(entry["line"].as_u64().is_some_and(|line| line >= 1));
            let body = naming_body(
                "synonymous naming",
                BodyOptions {
                    concept: "item price",
                    name_in_use: "price",
                    proposed: "Amount",
                    evidence_path: "src/price.ts",
                    evidence_lines: "4",
                    quote: "export const price = unitPrice;",
                    occurrences: &[
                        ("src/price.ts", "1-4"),
                        ("client/PriceCard.svelte", "2-4"),
                    ],
                    glossary: Some(
                        "## Glossary\n\n.omp/discover/glossary/orders.glossary.yaml — Amount (item_price)",
                    ),
                },
            );
            forge.issues.lock().expect("the fake").push(cn::ForgeIssue {
                number: 1,
                title: "Rename price to Amount".to_string(),
                url: "https://forge.test/acme/fixture/issues/1".to_string(),
                state: "open".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                body,
                labels: vec!["consistent-naming".to_string()],
            });
            write_tool_record(&directory, 1, "Rename price to Amount");
            Ok(())
        })
    });
    let worker = naming_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.lifecycle, cn::Lifecycle::Idle);
    assert_eq!(state.issues.len(), 1);
    assert_eq!(state.issues[0].number, 1);
    assert_eq!(
        state.issues[0].category.as_deref(),
        Some("synonymous naming")
    );
    let directory = cn::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    let activity = api::read_activity(&directory).join("\n");
    assert!(activity.contains("entry point"));
    assert!(activity.contains("filed #1"));
    let persisted = cn::read_state(&cn::versioned_state_path(
        &fixture.state_dir,
        &fixture.repo,
        Some(VERSION),
    ))
    .expect("the versioned state");
    assert_eq!(persisted.issues.len(), 1);
    worker.stop().await;
    assert_eq!(worker.current_state().issues.len(), 1);
    assert!(!versioned(cn::lock_path(&fixture.repo)).exists());
}

#[tokio::test]
async fn consistent_naming_drops_a_filing_outside_the_seven_categories() {
    let fixture = Fixture::new("drop");
    fixture.naming_inputs();
    let forge = Arc::new(NamingForge::default());
    forge.issues.lock().expect("the fake").push(cn::ForgeIssue {
        number: 1,
        title: "Report an unlisted concern".to_string(),
        url: "https://forge.test/acme/fixture/issues/1".to_string(),
        state: "open".to_string(),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        body: "## Category\n\nunlisted-category\n\n## Evidence\n\n- `src/price.ts:4`\n  > export const price = unitPrice;".to_string(),
        labels: vec!["consistent-naming".to_string()],
    });
    let connect = fake_connect(|_prompt| Box::pin(async move { Ok(()) }));
    let worker = naming_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    assert!(worker.current_state().issues.is_empty());
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert!(state.issues.is_empty());
    let directory = cn::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    assert!(api::read_activity(&directory)
        .join("\n")
        .contains("verification failure"));
    worker.stop().await;
}

#[tokio::test]
async fn consistent_naming_requires_the_complete_occurrence_list() {
    let fixture = Fixture::new("occurrences");
    fixture.naming_inputs();
    let forge = Arc::new(NamingForge::default());
    let forge_for_peer = Arc::clone(&forge);
    let connect = fake_connect(move |prompt| {
        let forge = Arc::clone(&forge_for_peer);
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/consistent-naming ");
            let body = naming_body(
                "synonymous naming",
                BodyOptions {
                    concept: "item price",
                    name_in_use: "price",
                    proposed: "amount",
                    evidence_path: "src/price.ts",
                    evidence_lines: "4",
                    quote: "export const price = unitPrice;",
                    occurrences: &[("src/price.ts", "4")],
                    glossary: None,
                },
            );
            forge.issues.lock().expect("the fake").push(cn::ForgeIssue {
                number: 2,
                title: "Rename price to amount".to_string(),
                url: "https://forge.test/acme/fixture/issues/2".to_string(),
                state: "open".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                body,
                labels: vec!["consistent-naming".to_string()],
            });
            write_tool_record(&directory, 2, "Rename price to amount");
            Ok(())
        })
    });
    let worker = naming_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert!(state.issues.is_empty());
    let directory = cn::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    let activity = api::read_activity(&directory).join("\n");
    assert!(activity.contains("the occurrence list omits client/PriceCard.svelte"));
    worker.stop().await;
}

#[tokio::test]
async fn consistent_naming_reports_a_glossary_conflict_and_rejects_a_synonym() {
    let fixture = Fixture::new("glossary");
    fixture.naming_inputs();
    fixture.write(
        "src/charge.ts",
        "export const Charge = 1;\nexport const fee = Charge;\n",
    );
    fixture.write(
        ".omp/discover/glossary/orders.glossary.yaml",
        "boundedContext: orders\nconcepts:\n  - id: order\n    prefLabels:\n      - text: Order\n    altLabels:\n      - text: Purchase\n  - id: item_price\n    prefLabels:\n      - text: Amount\n    altLabels:\n      - text: Charge\n",
    );
    let forge = Arc::new(NamingForge::default());
    let forge_for_peer = Arc::clone(&forge);
    let connect = fake_connect(move |prompt| {
        let forge = Arc::clone(&forge_for_peer);
        Box::pin(async move {
            let directory = prompt_directory(&prompt, "/consistent-naming ");
            let conflict = naming_body(
                "synonymous naming",
                BodyOptions {
                    concept: "order",
                    name_in_use: "Charge",
                    proposed: "Amount",
                    evidence_path: "src/charge.ts",
                    evidence_lines: "1",
                    quote: "export const Charge = 1;",
                    occurrences: &[("src/charge.ts", "1-2")],
                    glossary: Some(
                        "## Glossary conflict\n\n.omp/discover/glossary/orders.glossary.yaml assigns Charge to item_price; the preferred label is Amount.",
                    ),
                },
            );
            let rejected = naming_body(
                "synonymous naming",
                BodyOptions {
                    concept: "order",
                    name_in_use: "Charge",
                    proposed: "Fee",
                    evidence_path: "src/charge.ts",
                    evidence_lines: "1",
                    quote: "export const Charge = 1;",
                    occurrences: &[("src/charge.ts", "1-2")],
                    glossary: Some(
                        "## Glossary conflict\n\n.omp/discover/glossary/orders.glossary.yaml assigns Charge to item_price; the preferred label is Amount.",
                    ),
                },
            );
            forge.issues.lock().expect("the fake").push(cn::ForgeIssue {
                number: 3,
                title: "Charge names the item price concept".to_string(),
                url: "https://forge.test/acme/fixture/issues/3".to_string(),
                state: "open".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                body: conflict,
                labels: vec!["consistent-naming".to_string()],
            });
            forge.issues.lock().expect("the fake").push(cn::ForgeIssue {
                number: 4,
                title: "A synonym the glossary forbids".to_string(),
                url: "https://forge.test/acme/fixture/issues/4".to_string(),
                state: "open".to_string(),
                created_at: "2026-01-01T00:00:01.000Z".to_string(),
                body: rejected,
                labels: vec!["consistent-naming".to_string()],
            });
            write_tool_record(&directory, 3, "Charge names the item price concept");
            Ok(())
        })
    });
    let worker = naming_worker(&fixture, Arc::clone(&forge), connect);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.issues.len(), 1);
    assert_eq!(state.issues[0].number, 3);
    let directory = cn::cycle_directory(&fixture.repo, &state.newest_cycle_id.expect("a cycle"));
    assert!(api::read_activity(&directory)
        .join("\n")
        .contains("verification failure"));
    worker.stop().await;
}

/* ------------------------------------------------------------------------ */
/* The idle deadline                                                         */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn consistent_naming_cycle_survives_when_the_peer_keeps_beating() {
    let fixture = Fixture::new("idle-beat");
    fixture.naming_inputs();
    let forge = Arc::new(NamingForge::default());
    let connect = beating_connect(Duration::from_millis(50), Duration::from_millis(500));
    let mut options = cn::WorkerOptions::new(&fixture.repo, &fixture.state_dir);
    options.harness_version = Some(VERSION.to_string());
    options.sync_ms = Some(60_000);
    options.manual_cycles = true;
    options.timeout_ms = Some(250);
    options.connect = Some(connect);
    options.forge = Some(Arc::clone(&forge) as Arc<dyn cn::ForgeClient>);
    let worker = cn::Worker::new(options);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.lifecycle, cn::Lifecycle::Idle);
    assert_eq!(state.last_error, None);
    worker.stop().await;
}

#[tokio::test]
async fn consistent_naming_cycle_fails_when_the_peer_stays_silent() {
    let fixture = Fixture::new("idle-silent");
    fixture.naming_inputs();
    let forge = Arc::new(NamingForge::default());
    let connect = beating_connect(Duration::from_millis(60_000), Duration::from_millis(60_000));
    let mut options = cn::WorkerOptions::new(&fixture.repo, &fixture.state_dir);
    options.harness_version = Some(VERSION.to_string());
    options.sync_ms = Some(60_000);
    options.manual_cycles = true;
    options.timeout_ms = Some(150);
    options.connect = Some(connect);
    options.forge = Some(Arc::clone(&forge) as Arc<dyn cn::ForgeClient>);
    let worker = cn::Worker::new(options);
    assert!(worker.start("acme/fixture"));
    worker.refresh().await;
    worker.begin_cycle().await;
    worker.wait_for_cycle().await;
    let state = worker.current_state();
    assert_eq!(state.last_error.as_deref(), Some("the cycle timed out"));
    worker.stop().await;
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                               */
/* ------------------------------------------------------------------------ */

#[test]
fn the_entry_point_surface_covers_the_naming_pool_deterministically() {
    assert_eq!(dead::ENTRY_POINT_SURFACES.len(), 5);
    assert!(dead::ENTRY_POINT_SURFACES.contains(&"consistent-naming"));
    let fixture = Fixture::new("entry");
    fixture.naming_inputs();
    fixture.write("server/handler.ts", "export const handler = 1;\n");
    let pool = dead::consistent_naming_pool(&fixture.repo);
    assert!(pool.iter().any(|path| path == "src/price.ts"));
    assert!(pool.iter().any(|path| path == "server/handler.ts"));
    assert!(pool.iter().any(|path| path == "client/PriceCard.svelte"));
    assert!(!pool.iter().any(|path| path.contains(".test.")));
    assert!(!pool.iter().any(|path| path.starts_with("tests/")));
    let first = dead::pick_entry_point(&fixture.repo, "consistent-naming", Some("naming-proof"))
        .expect("a pick");
    let second = dead::pick_entry_point(&fixture.repo, "consistent-naming", Some("naming-proof"))
        .expect("a replay");
    assert_eq!(first.path, second.path);
    assert_eq!(first.line, second.line);
    assert_eq!(first.surface, "consistent-naming");
    assert!(!first.path.contains(".test."));
}

/* ------------------------------------------------------------------------ */
/* Preflight                                                                 */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn consistent_naming_preflight_refuses_a_missing_or_unusable_skill() {
    let fixture = Fixture::new("preflight");
    git_fixture(&fixture, "https://forge.test/acme/fixture.git");
    let mut options = cn::PreflightOptions {
        repo_dir: fixture.repo.clone(),
        state_dir: fixture.state_dir.clone(),
        ..cn::PreflightOptions::default()
    };
    let message = cn::preflight_consistent_naming(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("SKILL.md is not readable"));
    fixture.naming_inputs();
    fixture.write(
        ".omp/skills/devboard-consistent-naming/SKILL.md",
        "# Empty\n",
    );
    let message = cn::preflight_consistent_naming(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("unusable"));
    fixture.naming_inputs();
    options.state_dir = fixture.root.clone();
    let message = cn::preflight_consistent_naming(&options)
        .await
        .expect_err("a refusal");
    assert!(message.contains("not inside REPO_DIR"));
}

/* ------------------------------------------------------------------------ */
/* MCP surface                                                               */
/* ------------------------------------------------------------------------ */

async fn drive_mcp(context: &devboard::mcp_server::McpContext, requests: &[Value]) -> Vec<Value> {
    let mut input = String::new();
    for request in requests {
        input.push_str(&serde_json::to_string(request).expect("a request"));
        input.push('\n');
    }
    let mut output: Vec<u8> = Vec::new();
    let mut diagnostics: Vec<u8> = Vec::new();
    devboard::mcp_server::run_stdio(
        context.clone(),
        input.as_bytes(),
        &mut output,
        &mut diagnostics,
    )
    .await
    .expect("the stdio loop");
    String::from_utf8_lossy(&output)
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).expect("a JSON-RPC frame"))
        .collect()
}

fn mcp_result(frames: &[Value], id: i64) -> Value {
    let frame = frames
        .iter()
        .find(|frame| frame.get("id").and_then(Value::as_i64) == Some(id))
        .expect("a reply");
    let text = frame["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    serde_json::from_str::<Value>(text).expect("tool JSON")
}

#[tokio::test]
async fn consistent_naming_appears_in_the_background_agents_tools() {
    let fixture = Fixture::new("mcp");
    fixture.write("src/app.ts", "export const app = 1;\n");
    std::fs::create_dir_all(fixture.repo.join(".devboard")).expect("the harness");
    let context = devboard::mcp_server::McpContext {
        repo_dir: fixture.repo.clone(),
        harness_dir: fixture.repo.join(".devboard"),
        state_dir: fixture.state_dir.clone(),
        environment: HashMap::new(),
        dashboards: Some(Vec::new()),
    };
    let frames = drive_mcp(
        &context,
        &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "background_agents_list", "arguments": {}}}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "background_agent_get", "arguments": {"id": "consistent-naming"}}}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "entry_point", "arguments": {"surface": "consistent-naming", "seed": "mcp-proof"}}}),
        ],
    )
    .await;
    let list = mcp_result(&frames, 1);
    let agents = list["agents"].as_array().expect("agents");
    assert_eq!(agents.len(), 9);
    let naming = agents
        .iter()
        .find(|agent| agent["id"] == "consistent-naming")
        .expect("the naming family");
    assert_eq!(naming["label"], "Consistent Naming");
    assert_eq!(naming["scope"], "repository");
    assert_eq!(naming["detail"]["panel"], "activity");
    let got = mcp_result(&frames, 2);
    assert_eq!(got["id"], "consistent-naming");
    let pick = mcp_result(&frames, 3);
    assert_eq!(pick["surface"], "consistent-naming");
    assert_eq!(pick["path"], "src/app.ts");
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

fn git_fixture(fixture: &Fixture, origin: &str) {
    std::fs::create_dir_all(&fixture.repo).expect("the checkout");
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
    git(&["init", "-q"]);
    git(&["config", "user.email", "fixture@example.test"]);
    git(&["config", "user.name", "Fixture"]);
    std::fs::write(fixture.repo.join("tracked.txt"), "original\n").expect("a file");
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "fixture"]);
    git(&["remote", "add", "origin", origin]);
}

fn versioned(lock: PathBuf) -> PathBuf {
    devboard::workers::watchdog::versioned_lock_path(&lock, Some(VERSION))
}
