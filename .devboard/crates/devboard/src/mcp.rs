//! The one MCP catalog. `tools/list` and the MCP optimizer `tool-gap` filter
//! both read this module: a tool name and its `covers` entries exist here and
//! nowhere else. The list is sorted by name so one unchanged state yields one
//! stable catalog byte for byte.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};

use crate::journal::repo_key;

fn string_schema() -> Value {
    json!({ "type": "string" })
}

fn integer_schema() -> Value {
    json!({ "type": "integer" })
}

fn limit_schema() -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": 200 })
}

fn no_arguments() -> Value {
    json!({ "type": "object", "additionalProperties": false, "properties": {} })
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = Map::new();
    schema.insert("type".to_string(), json!("object"));
    schema.insert("additionalProperties".to_string(), json!(false));
    schema.insert("properties".to_string(), properties);
    if !required.is_empty() {
        schema.insert("required".to_string(), json!(required));
    }
    Value::Object(schema)
}

fn tool(
    name: &str,
    title: &str,
    description: &str,
    input_schema: Value,
    covers: Option<&[&str]>,
) -> Value {
    let mut definition = Map::new();
    definition.insert("name".to_string(), json!(name));
    definition.insert("title".to_string(), json!(title));
    definition.insert("description".to_string(), json!(description));
    definition.insert("inputSchema".to_string(), input_schema);
    if let Some(covers) = covers {
        definition.insert("covers".to_string(), json!(covers));
    }
    Value::Object(definition)
}

fn catalog() -> Vec<Value> {
    let mut tools = vec![
        tool(
            "agent_session_read",
            "Read one agent session",
            "Reads one ACP peer transcript in message order, bounded by rows and bytes. Each message carries index, timestamp, role, bounded text, tool name, the error flag, usage, and a failure fingerprint.",
            object_schema(
                json!({
                    "id": string_schema(),
                    "offset": json!({"type": "integer", "minimum": 0}),
                    "limit": limit_schema(),
                }),
                &["id"],
            ),
            None,
        ),
        tool(
            "agent_session_search",
            "Search agent sessions",
            "Case-insensitive substring search across this repository's ACP peer transcripts, newest session first. At most 100 matches with a 200-character snippet.",
            object_schema(json!({"query": string_schema(), "limit": limit_schema()}), &["query"]),
            None,
        ),
        tool(
            "agent_sessions_list",
            "List agent sessions",
            "Lists this repository's ACP peer transcripts newest first with id, relative path, start time, title, relative cwd, message count, tool-error count, tokens, and cost.",
            object_schema(
                json!({
                    "since": string_schema(),
                    "until": string_schema(),
                    "cwd": string_schema(),
                    "limit": limit_schema(),
                    "offset": json!({"type": "integer", "minimum": 0}),
                }),
                &[],
            ),
            Some(&["rg --files", "find .devboard/.tmp/providers"]),
        ),
        tool(
            "background_agent_control",
            "Control a background agent",
            "Delegates start, stop, set_settings, or disable_timer to the single live dashboard for this repository and returns its resulting agent snapshot.",
            object_schema(
                json!({
                    "action": json!({
                        "type": "string",
                        "enum": json!(["start", "stop", "set_settings", "disable_timer"]),
                    }),
                    "id": string_schema(),
                    "minutes": integer_schema(),
                    "maxPerHour": json!({"type": json!(["integer", "null"]), "minimum": 1, "maximum": 100}),
                    "maxPending": json!({"type": json!(["integer", "null"]), "minimum": 1, "maximum": 100}),
                }),
                &["action", "id"],
            ),
            None,
        ),
        tool(
            "background_agent_get",
            "Read one background agent",
            "Returns one background agent's snapshot from the live dashboard, or its persisted state when no dashboard is live.",
            object_schema(json!({"id": string_schema()}), &["id"]),
            None,
        ),
        tool(
            "background_agents_list",
            "List background agents",
            "Returns every background agent's snapshot from the live dashboard, or the persisted state when no dashboard is live.",
            no_arguments(),
            None,
        ),
        tool(
            "design_release_request",
            "Request a Design System release",
            "Records the documentation release summary and rationale beside the cycle's edited draft documents. The worker commits, pushes, waits for the release workflow, and publishes; the request path is returned.",
            object_schema(
                json!({"cycleDir": string_schema(), "summary": string_schema(), "rationale": string_schema()}),
                &["cycleDir", "summary", "rationale"],
            ),
            None,
        ),
        tool(
            "devboard_status",
            "Read Devboard status",
            "Returns the resolved repository root, harness directory, state directory, the checkout's branch, upstream, and ahead/behind counts, live dashboard port and pid when one exists, and the harness version state.",
            no_arguments(),
            Some(&["git rev-parse --show-toplevel"]),
        ),
        tool(
            "discover_contribution_stage",
            "Stage a Discover contribution sheet",
            "Writes the contribution agent's complete staged contribution.json and returns its path and schema version. Publication validates and publishes it.",
            object_schema(
                json!({"stagingDir": string_schema(), "contribution": json!({"type": "object"})}),
                &["stagingDir", "contribution"],
            ),
            None,
        ),
        tool(
            "discover_glossary_stage",
            "Stage a Discover glossary",
            "Writes one bounded context's UbiLang glossary YAML as the run's staged glossary document and returns its path and context id.",
            object_schema(
                json!({"stagingDir": string_schema(), "context": string_schema(), "yaml": string_schema()}),
                &["stagingDir", "context", "yaml"],
            ),
            None,
        ),
        tool(
            "discover_sheet_stage",
            "Stage a Discover project sheet",
            "Writes the complete project sheet as the run's staged sheet.json and returns its path and schema version. Publication validates and publishes it.",
            object_schema(
                json!({"stagingDir": string_schema(), "sheet": json!({"type": "object"})}),
                &["stagingDir", "sheet"],
            ),
            None,
        ),
        tool(
            "discover_significance_stage",
            "Stage Discover significance scores",
            "Writes the glossary significance sidecar beside the staged glossaries and returns its path and schema version.",
            object_schema(
                json!({"stagingDir": string_schema(), "significance": json!({"type": "object"})}),
                &["stagingDir", "significance"],
            ),
            None,
        ),
        tool(
            "discover_skill_stage",
            "Stage a Discover skill",
            "Writes one managed Discover skill with its name, one-line description, and heading-plus-bullets body, and returns its path and name.",
            object_schema(
                json!({
                    "stagingDir": string_schema(),
                    "name": string_schema(),
                    "description": string_schema(),
                    "body": string_schema(),
                }),
                &["stagingDir", "name", "description", "body"],
            ),
            None,
        ),
        tool(
            "entry_point",
            "Pick a crawl entry point",
            "Returns the repository-relative path, a line inside it, the surface, and the seed for one background-agent crawl. The same surface and seed over an unchanged eligible set return the identical path and line; an omitted seed produces a fresh one that replays the same pick. Read-only.",
            object_schema(
                json!({
                    "surface": json!({
                        "type": "string",
                        "enum": json!(["scout", "design", "dead-code", "single-responsibility", "consistent-naming"]),
                    }),
                    "seed": string_schema(),
                }),
                &["surface"],
            ),
            None,
        ),
        tool(
            "flow_checkpoint_record",
            "Record a Flow checkpoint",
            "Appends one checkpoint for a committed coherent unit to the session's checkpoint log and returns its id, commit, and summary.",
            object_schema(
                json!({
                    "sessionDir": string_schema(),
                    "id": string_schema(),
                    "timestamp": string_schema(),
                    "summary": string_schema(),
                    "files": integer_schema(),
                    "commit": string_schema(),
                    "verification": json!({"type": "string", "enum": json!(["passed", "failed", "not-run"])}),
                }),
                &["sessionDir", "commit", "summary"],
            ),
            None,
        ),
        tool(
            "flow_control",
            "Control Flow mode",
            "Delegates create_goal, start_implementation, or stop_implementation to the live dashboard and returns the resulting Flow snapshot.",
            object_schema(
                json!({
                    "action": json!({
                        "type": "string",
                        "enum": json!(["create_goal", "start_implementation", "stop_implementation"]),
                    }),
                }),
                &["action"],
            ),
            None,
        ),
        tool(
            "flow_steering_ack",
            "Acknowledge Flow steering",
            "Records the steering-note ids this implementation turn consumed, once each, in the session's acknowledgement log and returns the ids it wrote and the ids already recorded.",
            object_schema(
                json!({
                    "sessionDir": string_schema(),
                    "ids": json!({"type": "array", "items": string_schema(), "maxItems": 200}),
                }),
                &["sessionDir", "ids"],
            ),
            None,
        ),
        tool(
            "flow_verification_record",
            "Record Flow verification",
            "Replaces the session's latest verification result with the command run, its status, the timestamp, and a bounded output tail, and returns the recorded status.",
            object_schema(
                json!({
                    "sessionDir": string_schema(),
                    "command": string_schema(),
                    "status": json!({"type": "string", "enum": json!(["passed", "failed", "not-run"])}),
                    "timestamp": string_schema(),
                    "output": string_schema(),
                }),
                &["sessionDir", "status"],
            ),
            None,
        ),
        tool(
            "flow_widgets_register",
            "Register Flow change widgets",
            "Replaces one Flow session's widget list with the supplied widgets. Each widget carries a category, concept, summary, rationale, and its changed files. The flow server reconciles identity, acceptance, and missing files.",
            object_schema(
                json!({
                    "sessionDir": string_schema(),
                    "widgets": json!({
                        "type": "array",
                        "maxItems": 200,
                        "items": object_schema(
                            json!({
                                "category": json!({
                                    "type": "string",
                                    "enum": json!([
                                        "contract",
                                        "entity",
                                        "naming",
                                        "data",
                                        "dependency",
                                        "irreversible",
                                        "structure",
                                    ]),
                                }),
                                "concept": string_schema(),
                                "summary": string_schema(),
                                "rationale": string_schema(),
                                "files": json!({
                                    "type": "array",
                                    "items": string_schema(),
                                    "minItems": 1,
                                    "maxItems": 200,
                                }),
                            }),
                            &["category", "concept", "summary", "rationale", "files"],
                        ),
                    }),
                }),
                &["sessionDir", "widgets"],
            ),
            None,
        ),
        tool(
            "goal_control",
            "Control Goal mode",
            "Delegates create, revise, prepare_skills, or reset_implementation to the live dashboard and returns the resulting Goal-mode state.",
            object_schema(
                json!({
                    "action": json!({
                        "type": "string",
                        "enum": json!(["create", "revise", "prepare_skills", "reset_implementation"]),
                    }),
                    "request": string_schema(),
                }),
                &["action"],
            ),
            None,
        ),
        tool(
            "goal_draft_file",
            "File a goal draft as an issue",
            "Ensures the exact `goal` label, creates one issue from a goal spec's bytes, reads it back, verifies the label and byte equality, and only then removes an optional named draft.",
            object_schema(
                json!({"specPath": string_schema(), "title": string_schema(), "draftPath": string_schema()}),
                &["specPath", "title"],
            ),
            None,
        ),
        tool(
            "goal_draft_read",
            "Read a goal draft",
            "Returns one proposed-goal draft under `.devboard/goal-proposals/` verbatim.",
            object_schema(json!({"path": string_schema()}), &["path"]),
            None,
        ),
        tool(
            "goal_drafts_list",
            "List goal drafts",
            "Lists the proposed-goal drafts directly under `.devboard/goal-proposals/`.",
            no_arguments(),
            Some(&["ls .devboard/goal-proposals", "find .devboard/goal-proposals"]),
        ),
        tool(
            "goal_get",
            "Read the goal document",
            "Returns the goal document's text.",
            no_arguments(),
            Some(&["cat GOAL.md"]),
        ),
        tool(
            "goal_spec_write",
            "Write a goal spec",
            "Writes `.devboard/goals/<slug>.md` with the five required sections once each, a derived kebab-case slug, and the first free numeric suffix.",
            object_schema(
                json!({
                    "objective": string_schema(),
                    "successCriteria": string_schema(),
                    "verification": string_schema(),
                    "boundaries": string_schema(),
                    "stopConditions": string_schema(),
                    "slug": string_schema(),
                }),
                &["objective", "successCriteria", "verification", "boundaries", "stopConditions"],
            ),
            None,
        ),
        tool(
            "issue_close",
            "Close an issue",
            "Closes one issue through the repository's own forge as completed or not planned and returns the resulting state.",
            object_schema(
                json!({
                    "number": integer_schema(),
                    "reason": json!({"type": "string", "enum": json!(["completed", "not planned"])}),
                }),
                &["number"],
            ),
            None,
        ),
        tool(
            "issue_comment",
            "Comment on an issue",
            "Appends one Markdown comment to an existing issue and confirms the issue number that received it.",
            object_schema(json!({"number": integer_schema(), "body": string_schema()}), &["number", "body"]),
            Some(&["gh issue comment"]),
        ),
        tool(
            "issue_create",
            "Create an issue",
            "Creates one issue with a one-line title, a full Markdown body, and an optional list of label names. Each label is ensured before the issue is created; the created issue's number, URL, title, and labels are returned. A watchdog deduplication run passes the candidate `fingerprint`, which the tool records for the cycle.",
            object_schema(
                json!({
                    "title": string_schema(),
                    "body": string_schema(),
                    "labels": json!({"type": "array", "items": string_schema(), "maxItems": 20}),
                    "fingerprint": string_schema(),
                }),
                &["title", "body"],
            ),
            Some(&["gh issue create"]),
        ),
        tool(
            "issue_get",
            "Read one issue",
            "Returns one issue's title, body, labels, state, and URL.",
            object_schema(json!({"number": integer_schema()}), &["number"]),
            Some(&["gh issue view", "gh issue list"]),
        ),
        tool(
            "issues_control",
            "Control the Issues worker",
            "Delegates start, pause, resume, stop, or check_now to the live dashboard and returns the Issues snapshot.",
            object_schema(
                json!({
                    "action": json!({
                        "type": "string",
                        "enum": json!(["start", "pause", "resume", "stop", "check_now"]),
                    }),
                }),
                &["action"],
            ),
            None,
        ),
        tool(
            "issues_list",
            "List issues",
            "Lists the repository's open and closed issues with number, title, state, labels, URL, and creation time.",
            object_schema(
                json!({
                    "state": json!({"type": "string", "enum": json!(["open", "closed", "all"])}),
                    "limit": limit_schema(),
                }),
                &[],
            ),
            Some(&["gh issue list"]),
        ),
        tool(
            "journal_search",
            "Search the dashboard journal",
            "Filters this repository's dashboard journal records by kind, scope, window, and substring, newest first. At most 200 records and 64 KiB.",
            object_schema(
                json!({
                    "kind": string_schema(),
                    "scope": string_schema(),
                    "since": string_schema(),
                    "until": string_schema(),
                    "query": string_schema(),
                    "limit": limit_schema(),
                }),
                &[],
            ),
            None,
        ),
        tool(
            "lifecycle_control",
            "Control Goal-mode lifecycle",
            "Delegates start, pause, resume, stop, or start_run to the live dashboard and returns the Goal-mode state.",
            object_schema(
                json!({
                    "action": json!({
                        "type": "string",
                        "enum": json!(["start", "pause", "resume", "stop", "start_run"]),
                    }),
                    "file": string_schema(),
                }),
                &["action"],
            ),
            None,
        ),
        tool(
            "mcp_optimizer_proposal_skip",
            "Record an MCP optimizer family with no proposal",
            "Records why an MCP optimizer family's synthesis turn filed no issue. The coordinator records the family as skipped with this reason; nothing is queued and no answer document is read.",
            object_schema(
                json!({"family": string_schema(), "reason": string_schema()}),
                &["family", "reason"],
            ),
            None,
        ),
        tool(
            "verification_run",
            "Run a verification check",
            "Runs one allowlisted check from `.devboard/package.json` with a 900-second timeout and at most 16 KiB of captured output. The Rust checks `rust:fmt`, `rust:clippy`, and `rust:test` run their exact cargo argv from the harness directory. The check's complete output is written to a log unique to that invocation and that path is returned as `log`; when the run settles the same output is published to `<stateDir>/<check>.log`.",
            object_schema(
                json!({
                    "check": string_schema(),
                    "paths": json!({"type": "array", "items": string_schema(), "maxItems": 50}),
                }),
                &["check"],
            ),
            Some(&[
                "bun test",
                "bun run check",
                "bun run build",
                "bunx tsc --noEmit",
                "cargo fmt --check --all",
                "cargo clippy --workspace --all-targets -- -D warnings",
                "cargo test --workspace",
                "rust:fmt",
                "rust:clippy",
                "rust:test",
            ]),
        ),
        tool(
            "watchdog_duplicate_record",
            "Record a watchdog duplicate",
            "Records that one watchdog candidate duplicates an open issue or another candidate in the same cycle. A duplicate creates and comments on nothing; the recorded disposition is returned.",
            object_schema(
                json!({
                    "fingerprint": string_schema(),
                    "issue": string_schema(),
                    "representative": string_schema(),
                }),
                &["fingerprint"],
            ),
            None,
        ),
    ];
    tools.sort_by(|left, right| {
        let left = left.get("name").and_then(Value::as_str).unwrap_or_default();
        let right = right
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        left.cmp(right)
    });
    tools
}

/// The `tools/list` payload: from the catalog, already sorted by name.
pub fn tool_list_payload() -> Value {
    json!({ "tools": catalog() })
}

/// `<stateDir>/mcp/tool-invocations/<24-hex repository key>.db`
pub fn tool_invocation_file(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    resolve(state_dir)
        .join("mcp")
        .join("tool-invocations")
        .join(format!("{}.db", repo_key(repo_dir)))
}

/// The counts a dashboard renders. A missing file is an empty table; an
/// unreadable or damaged file is reported as empty rather than breaking the
/// tool panel, because counts are never live state a control depends on.
pub fn tool_invocation_counts(state_dir: &Path, repo_dir: &Path) -> Value {
    let path = tool_invocation_file(state_dir, repo_dir);
    if !path.exists() {
        return Value::Object(Map::new());
    }
    read_counts(&path).unwrap_or_else(|| Value::Object(Map::new()))
}

/// Resolves one path the way `path.resolve` does: against the working
/// directory, lexically, without touching the filesystem.
fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    normalize(&absolute)
}

fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let remove = matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                );
                if remove {
                    normalized.pop();
                    continue;
                }
                let keep = matches!(
                    normalized.components().next_back(),
                    Some(Component::RootDir) | Some(Component::Prefix(_))
                );
                if !keep {
                    normalized.push("..");
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn read_counts(path: &Path) -> Option<Value> {
    let database = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    database.busy_timeout(BUSY_TIMEOUT).ok()?;
    let mut statement = database
        .prepare("SELECT name, count FROM tool_invocations")
        .ok()?;
    let mut rows = statement.query([]).ok()?;
    let mut counts = Map::new();
    while let Some(row) = rows.next().ok()? {
        let name = match row.get_ref(0).ok()? {
            rusqlite::types::ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
                Ok(name) => name,
                Err(_) => continue,
            },
            _ => continue,
        };
        if name.is_empty() {
            continue;
        }
        let count = match row.get_ref(1).ok()? {
            rusqlite::types::ValueRef::Integer(value)
                if (0..=MAX_SAFE_INTEGER).contains(&value) =>
            {
                value
            }
            rusqlite::types::ValueRef::Real(value)
                if value.is_finite()
                    && value.fract() == 0.0
                    && value >= 0.0
                    && value <= MAX_SAFE_INTEGER as f64 =>
            {
                value as i64
            }
            _ => continue,
        };
        counts.insert(name.to_string(), Value::from(count));
    }
    Some(Value::Object(counts))
}
