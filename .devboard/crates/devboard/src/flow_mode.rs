//! Flow Mode: one implementation agent in an isolated worktree, reviewable as
//! color-coded change widgets, steered by an append-only feed and one read-only
//! decision board.
//!
//! The controller owns the session, its files under the harness state
//! directory, the worktree, the ACP peers, and the diff watcher. It never
//! writes `GOAL.md` or `adrs/`, never creates an issue or an epic, and never
//! applies an edit a read-only peer produced.
//!
//! `server/flow.ts` is the behavioral reference; every frame, refusal message,
//! durable file, child argv, and replay order matches it.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::acp::{
    AcpConnection, AcpConnectionOptions, AcpEvent, AcpId, AcpQuestion, AcpQuestionOption,
    PermissionPolicy,
};
use crate::app::{App, Conn};
use crate::command::Command;
use crate::detached_run::{DetachedPeer, DetachedPeerOptions, DetachedRunOutcome};
use crate::git::{run_git, GitResult};

// ---------------------------------------------------------------------------
// Constants

/// The seven change categories a widget may name.
pub const FLOW_CATEGORIES: &[&str] = &[
    "contract",
    "entity",
    "naming",
    "data",
    "dependency",
    "irreversible",
    "structure",
];

/// The marker an implementation peer streams to report a blocker.
const BLOCKER_MARKER: &str = "DEVBOARD-BLOCKED:";
/// Bound on the text the watcher keeps for one untracked file.
pub const UNTRACKED_BODY_MAX_BYTES: u64 = 1_048_576;
const DEFAULT_WATCH_MS: u64 = 400;
const DEFAULT_ANALYST_TIMEOUT_MS: u64 = 60_000;
const COMMAND_TIMEOUT_MS: u64 = 60_000;
const OUTPUT_TAIL_MAX: usize = 4000;
const STALE_VERIFICATION: &str = "not-run";

fn git_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("GIT_TERMINAL_PROMPT".to_string(), "0".to_string());
    env.insert("GIT_ASKPASS".to_string(), "true".to_string());
    env.insert("NO_COLOR".to_string(), "1".to_string());
    // The watcher only reads. Refreshing the index would take a lock an
    // agent's concurrent commit needs, making the agent's checkpoint fail.
    env.insert("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string());
    env
}

// ---------------------------------------------------------------------------
// Wire types

/// One changed file as the review list shows it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowFile {
    pub path: String,
    pub status: String,
    pub insertions: u64,
    pub deletions: u64,
    pub diff: String,
    /// Why an untracked file's body was omitted; absent when `diff` holds it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omitted: Option<String>,
}

/// One reviewable group of changed files.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowWidget {
    /// Stable signature over the category, its file set, and their diff.
    pub id: String,
    pub category: String,
    pub concept: String,
    pub summary: String,
    pub rationale: String,
    pub files: Vec<String>,
    pub accepted: bool,
}

/// One developer steering note, appended and never rewritten.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowSteeringNote {
    pub id: String,
    pub timestamp: String,
    pub source: String,
    pub text: String,
    pub status: String,
}

/// One commit the implementation recorded, projected onto the view.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowCheckpoint {
    pub id: String,
    pub timestamp: String,
    pub summary: String,
    pub files: u64,
    pub commit: String,
    pub verification: String,
}

/// The newest recorded verification result.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowVerification {
    pub command: String,
    pub status: String,
    pub timestamp: String,
    pub output: String,
}

/// One reason the implementation could not continue.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowBlocker {
    pub id: String,
    pub timestamp: String,
    pub text: String,
    pub dismissed: bool,
}

/// The session's pull request as the forge last reported it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowPr {
    pub forge: String,
    pub number: u64,
    pub url: String,
    pub state: String,
}

/// One question a peer is waiting on.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowQuestion {
    pub id: AcpId,
    pub message: String,
    pub options: Vec<AcpQuestionOption>,
}

/// One turn of a widget conversation.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationMessage {
    pub role: String,
    pub text: String,
}

/// One merged session, kept for the history list.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowHistoryEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub goal: String,
    pub pr: Option<FlowPr>,
}

/// The durable machine state of one Flow session.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    base_revision: Option<String>,
    worktree: String,
    branch: String,
    status: String,
    goal: String,
    decisions: String,
    steering: Vec<FlowSteeringNote>,
    accepted: Vec<String>,
    widgets: Vec<FlowWidget>,
    files: Vec<FlowFile>,
    checkpoints: Vec<FlowCheckpoint>,
    verification: Option<FlowVerification>,
    blockers: Vec<FlowBlocker>,
    pr: Option<FlowPr>,
    pr_error: Option<String>,
    leftover: Option<String>,
    /// True from the merge's terminal write until a cleanup attempt finishes
    /// with no leftovers.
    cleanup_pending: bool,
    question: Option<FlowQuestion>,
    pushed_tip: Option<String>,
    pr_failed_tip: Option<String>,
    last_diff_hash: Option<String>,
    created_at: String,
    updated_at: String,
}

/// `session.json`: a version envelope around one session.
#[derive(Serialize)]
struct SessionFile<'a> {
    version: u32,
    #[serde(flatten)]
    session: &'a Session,
}

/// A widget as an analyst names it, before validation and reconciliation.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct RawWidget {
    category: String,
    concept: String,
    summary: String,
    rationale: String,
    files: Vec<String>,
}

// ---------------------------------------------------------------------------
// Diff parsing

/// A diff without the volatile index line and trailing spaces.
pub fn normalize_diff(diff: &str) -> String {
    diff.replace("\r\n", "\n")
        .split('\n')
        .filter(|line| !line.starts_with("index "))
        .map(|line| line.trim_end_matches([' ', '\t']))
        .collect::<Vec<_>>()
        .join("\n")
}

fn count_diff_lines(chunk: &str) -> (u64, u64) {
    let mut insertions = 0;
    let mut deletions = 0;
    for line in chunk.split('\n') {
        if line.starts_with('+') && !line.starts_with("+++") {
            insertions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (insertions, deletions)
}

/// Decodes one path token of a `diff --git` header.
fn unquote_git_path(token: &str) -> String {
    if token.len() < 2 || !token.starts_with('"') || !token.ends_with('"') {
        return token.to_string();
    }
    let end = token.len() - 1;
    let mut bytes: Vec<u8> = Vec::new();
    let escapes: [(char, u8); 9] = [
        ('a', 7),
        ('b', 8),
        ('f', 12),
        ('n', 10),
        ('r', 13),
        ('t', 9),
        ('v', 11),
        ('"', 34),
        ('\\', 92),
    ];
    let chars: Vec<char> = token.chars().collect();
    let mut index = 1;
    while index < end {
        let character = chars[index];
        if character != '\\' {
            let mut buffer = [0u8; 4];
            bytes.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
            index += 1;
            continue;
        }
        let Some(next) = chars.get(index + 1).copied() else {
            bytes.push(92);
            break;
        };
        if let Some((_, byte)) = escapes.iter().find(|(name, _)| *name == next) {
            bytes.push(*byte);
            index += 2;
            continue;
        }
        if ('0'..='7').contains(&next) {
            let mut octal = String::new();
            let mut cursor = index + 1;
            while cursor < end && octal.len() < 3 {
                let candidate = chars[cursor];
                if !('0'..='7').contains(&candidate) {
                    break;
                }
                octal.push(candidate);
                cursor += 1;
            }
            let value = u32::from_str_radix(&octal, 8).unwrap_or(0);
            bytes.push(value as u8);
            index += 1 + octal.len();
            continue;
        }
        bytes.push(92);
        index += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The two paths of a `diff --git` header, without the `a/` and `b/` prefixes.
fn diff_header_paths(rest: &str) -> Option<(String, String)> {
    let chars: Vec<char> = rest.chars().collect();
    if rest.starts_with('"') {
        let mut index = 1;
        while index < chars.len() && chars[index] != '"' {
            index += if chars[index] == '\\' { 2 } else { 1 };
        }
        if chars.get(index) != Some(&'"') || chars.get(index + 1) != Some(&' ') {
            return None;
        }
        let first = unquote_git_path(&chars[..index + 1].iter().collect::<String>());
        let second = unquote_git_path(&chars[index + 2..].iter().collect::<String>());
        if !first.starts_with("a/") || !second.starts_with("b/") {
            return None;
        }
        return Some((first[2..].to_string(), second[2..].to_string()));
    }
    let prefix = "a/";
    if !rest.starts_with(prefix) {
        return None;
    }
    let separator = rest.rfind(" b/")?;
    let first = &rest[2..separator];
    let second = &rest[separator + 3..];
    if first.is_empty() || second.is_empty() {
        return None;
    }
    Some((first.to_string(), second.to_string()))
}

/// Splits one `git diff` result into per-path chunks.
pub fn split_diff_files(text: &str) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = Vec::new();
    let mut current: Option<String> = None;
    let mut lines: Vec<String> = Vec::new();
    let flush = |current: &mut Option<String>,
                 lines: &mut Vec<String>,
                 files: &mut Vec<(String, String)>| {
        if let Some(path) = current.take() {
            files.push((path, lines.join("\n").trim_end_matches('\n').to_string()));
        }
        lines.clear();
    };
    for line in text.split('\n') {
        if !line.starts_with("diff --git ") {
            if current.is_some() {
                lines.push(line.to_string());
            }
            continue;
        }
        // A file head always ends the previous chunk, so an unreadable header
        // can never fold its body into another file's diff.
        flush(&mut current, &mut lines, &mut files);
        let Some((_, second)) = diff_header_paths(&line["diff --git ".len()..]) else {
            continue;
        };
        current = Some(second);
        lines.push(line.to_string());
    }
    flush(&mut current, &mut lines, &mut files);
    files
}

fn file_status(chunk: &str) -> &'static str {
    if chunk.lines().any(|line| line.starts_with("new file mode ")) {
        return "added";
    }
    if chunk
        .lines()
        .any(|line| line.starts_with("deleted file mode "))
    {
        return "deleted";
    }
    if chunk.lines().any(|line| line.starts_with("rename from ")) {
        return "renamed";
    }
    "modified"
}

/// The tracked files one `git diff` result touches, with per-file counts.
pub fn diff_files(text: &str) -> Vec<FlowFile> {
    split_diff_files(text)
        .into_iter()
        .map(|(path, chunk)| {
            let (insertions, deletions) = count_diff_lines(&chunk);
            FlowFile {
                path,
                status: file_status(&chunk).to_string(),
                insertions,
                deletions,
                diff: chunk,
                omitted: None,
            }
        })
        .collect()
}

fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    hex::encode(digest)
}

/// The whole-diff hash the watcher compares to decide whether to analyze.
pub fn diff_hash(files: &[FlowFile]) -> String {
    let mut parts: Vec<String> = files
        .iter()
        .map(|file| {
            format!(
                "{}\0{}\0{}",
                file.path,
                file.omitted.as_deref().unwrap_or(""),
                normalize_diff(&file.diff)
            )
        })
        .collect();
    parts.sort();
    sha256_hex(&parts.join("\0"))
}

/// A widget's identity: its category, its sorted file set, and the normalized
/// diff of those files. Concept text is display metadata and never part of it.
pub fn widget_signature(
    category: &str,
    paths: &[String],
    diffs: &HashMap<String, String>,
) -> String {
    let mut sorted: Vec<String> = paths.to_vec();
    sorted.sort();
    let body = [
        category.to_string(),
        sorted.join("\0"),
        sorted
            .iter()
            .map(|path| normalize_diff(diffs.get(path).map(String::as_str).unwrap_or("")))
            .collect::<Vec<_>>()
            .join("\0"),
    ]
    .join("\0");
    sha256_hex(&body)[..16].to_string()
}

/// One new file's unified diff, built rather than shelled out to git.
fn untracked_diff(path: &str, content: &str, mode: &str) -> String {
    let header = [
        format!("diff --git a/{path} b/{path}"),
        format!("new file mode {mode}"),
        "--- /dev/null".to_string(),
        format!("+++ b/{path}"),
    ];
    if content.is_empty() {
        return header.join("\n");
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.len() > 1 && lines.last() == Some(&"") {
        lines.pop();
    }
    let mut body = vec![format!("@@ -0,0 +1,{} @@", lines.len())];
    body.extend(lines.into_iter().map(|line| format!("+{line}")));
    let mut all: Vec<String> = header.into();
    all.extend(body);
    all.join("\n")
}

fn omitted_file(path: &str, omitted: &str) -> FlowFile {
    FlowFile {
        path: path.to_string(),
        status: "added".to_string(),
        insertions: 0,
        deletions: 0,
        diff: String::new(),
        omitted: Some(omitted.to_string()),
    }
}

fn added_file(path: &str, diff: String) -> FlowFile {
    let (insertions, deletions) = count_diff_lines(&diff);
    FlowFile {
        path: path.to_string(),
        status: "added".to_string(),
        insertions,
        deletions,
        diff,
        omitted: None,
    }
}

/// One untracked file as a bounded [`FlowFile`].
fn untracked_file(worktree: &Path, path: &str) -> Option<FlowFile> {
    let absolute = worktree.join(path);
    let stats = std::fs::symlink_metadata(&absolute).ok()?;
    if stats.file_type().is_symlink() {
        let Ok(target) = std::fs::read_link(&absolute) else {
            return Some(omitted_file(path, "unreadable"));
        };
        let target = target.to_string_lossy().into_owned();
        if target.len() as u64 > UNTRACKED_BODY_MAX_BYTES {
            return Some(omitted_file(path, "large"));
        }
        return Some(added_file(path, untracked_diff(path, &target, "120000")));
    }
    if !stats.is_file() {
        return None;
    }
    if stats.len() > UNTRACKED_BODY_MAX_BYTES {
        return Some(omitted_file(path, "large"));
    }
    let bytes = std::fs::read(&absolute).ok()?;
    // The file may have grown between the stat and the read.
    if bytes.len() as u64 > UNTRACKED_BODY_MAX_BYTES {
        return Some(omitted_file(path, "large"));
    }
    if bytes.contains(&0) {
        return Some(omitted_file(path, "binary"));
    }
    let content = String::from_utf8_lossy(&bytes).into_owned();
    Some(added_file(path, untracked_diff(path, &content, "100644")))
}

/// Parses `git status --porcelain=v1 -z`.
pub fn parse_status_z(text: &str) -> Vec<(String, String)> {
    let parts: Vec<&str> = text.split('\0').collect();
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let part = parts[index];
        index += 1;
        if part.chars().count() < 4 {
            continue;
        }
        let code: String = part.chars().take(2).collect();
        let path: String = part.chars().skip(3).collect();
        if code == "??" {
            entries.push(("untracked".to_string(), path));
            continue;
        }
        if code.starts_with('R') || code.starts_with('C') {
            // The source path follows as its own NUL-terminated field.
            index += 1;
            entries.push(("renamed".to_string(), path));
            continue;
        }
        if code.contains('D') {
            entries.push(("deleted".to_string(), path));
            continue;
        }
        if code.contains('A') {
            entries.push(("added".to_string(), path));
            continue;
        }
        entries.push(("modified".to_string(), path));
    }
    entries
}

// ---------------------------------------------------------------------------
// Forge seam

/// One forge target, classified from the origin remote or configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForgeTarget {
    pub forge: String,
    pub host: String,
    pub project: String,
    pub base_url: Option<String>,
}

/// One PR/MR as the forge reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForgePrState {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub draft: bool,
}

/// One create or update request.
#[derive(Clone, Debug)]
pub struct ForgePrInput {
    pub cwd: PathBuf,
    pub target: ForgeTarget,
    pub head: String,
    pub base: String,
    pub title: String,
    pub body: String,
}

/// One async result on a trait object.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The pull-request lifecycle Flow drives.
///
/// The host forge is injected: the recorded corpus uses the deterministic
/// stub, and a production adapter implements the same six operations.
pub trait FlowForge: Send + Sync {
    fn create_draft(&self, input: ForgePrInput) -> BoxFuture<'_, Result<ForgePrState, String>>;
    fn update(&self, input: ForgePrInput, number: u64) -> BoxFuture<'_, Result<(), String>>;
    fn mark_ready<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<(), String>>;
    fn merge<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<(), String>>;
    fn view<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<ForgePrState, String>>;
    fn delete_remote_branch<'a>(
        &'a self,
        cwd: &'a Path,
        branch: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// How long one resolved credential is reused before it is resolved again.
const AUTH_CACHE_TTL_MS: i64 = 60_000;

/// The forge commands run with these fixed environment entries.
fn forge_git_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("GIT_TERMINAL_PROMPT".to_string(), "0".to_string());
    env.insert("GIT_ASKPASS".to_string(), "true".to_string());
    env.insert("NO_COLOR".to_string(), "1".to_string());
    env.insert("GH_PROMPT_DISABLED".to_string(), "1".to_string());
    env.insert("GH_NO_UPDATE_NOTIFIER".to_string(), "1".to_string());
    env
}

/// A credential the forge rejected after the command ran.
fn auth_diagnostic_pattern() -> &'static regex::Regex {
    static PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b401\b|\b403\b|unauthori[sz]ed|forbidden|bad credentials|invalid (?:token|credentials)|authentication (?:failed|required)",
        )
        .expect("a literal diagnostic pattern")
    });
    &PATTERN
}

fn is_auth_diagnostic(result: &crate::forge::ExecResult) -> bool {
    if result.code == 0 {
        return false;
    }
    auth_diagnostic_pattern().is_match(&format!("{}\n{}", result.stderr, result.stdout))
}

/// `forgeFailure(operation, result)`: the forge's own words, or its exit code.
fn forge_failure(operation: &str, result: &crate::forge::ExecResult) -> String {
    let detail = if !result.stderr.trim().is_empty() {
        result.stderr.trim()
    } else if !result.stdout.trim().is_empty() {
        result.stdout.trim()
    } else {
        return format!("Could not {operation}: exit code {}", result.code);
    };
    format!("Could not {operation}: {detail}")
}

/// The first `http(s)` word in a forge's output.
fn first_url(text: &str) -> Option<String> {
    static PATTERN: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"https?://\S+").expect("a literal URL pattern"));
    PATTERN.find(text).map(|found| found.as_str().to_string())
}

/// The request number a forge URL names.
fn number_from_url(url: &str) -> Option<u64> {
    static PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"/(?:pulls?|merge_requests)/(\d+)/?$").expect("a literal number pattern")
    });
    let trimmed = url.trim();
    let captures = PATTERN.captures(trimmed)?;
    captures.get(1)?.as_str().parse::<u64>().ok()
}

/// Normalizes one forge's state spelling to the three states the view knows.
fn normalized_forge_state(value: Option<&Value>) -> Option<&'static str> {
    match value?.as_str()?.trim().to_ascii_lowercase().as_str() {
        "open" | "opened" => Some("open"),
        "merged" => Some("merged"),
        "closed" => Some("closed"),
        _ => None,
    }
}

fn forge_kind(target: &ForgeTarget) -> Option<crate::forge::Forge> {
    match target.forge.as_str() {
        "github" => Some(crate::forge::Forge::GitHub),
        "gitlab" => Some(crate::forge::Forge::GitLab),
        "gitea" => Some(crate::forge::Forge::Gitea),
        _ => None,
    }
}

struct CachedAuth {
    auth: crate::forge::ResolvedAuth,
    /// Epoch milliseconds when the credential is resolved again.
    expires: i64,
}

/// The production adapter: the host's `gh`/`glab` CLI after resolving a
/// write-capable account for the exact repository, and the Gitea REST API.
/// Every credential stays in the child environment; no token is ever placed in
/// argv or in an error message.
pub struct CommandFlowForge {
    exec: crate::forge::Exec,
    /// Extra environment merged into credential resolution.
    env: HashMap<String, String>,
    timeout_ms: u64,
    transport: crate::forge::Transport,
    auth: Mutex<HashMap<String, CachedAuth>>,
}

impl CommandFlowForge {
    pub fn new() -> Self {
        Self {
            exec: crate::forge::default_exec(),
            env: HashMap::new(),
            timeout_ms: COMMAND_TIMEOUT_MS,
            transport: crate::forge::default_transport(COMMAND_TIMEOUT_MS),
            auth: Mutex::new(HashMap::new()),
        }
    }

    /// An adapter with a bounded command and an injected runner/transport.
    pub fn with_seams(
        exec: crate::forge::Exec,
        transport: crate::forge::Transport,
        env: HashMap<String, String>,
        timeout_ms: u64,
    ) -> Self {
        Self {
            exec,
            env,
            timeout_ms: timeout_ms.max(1),
            transport,
            auth: Mutex::new(HashMap::new()),
        }
    }

    fn cache(&self) -> MutexGuard<'_, HashMap<String, CachedAuth>> {
        self.auth.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn auth_key(target: &ForgeTarget) -> String {
        format!("{}:{}:{}", target.forge, target.host, target.project)
    }

    fn forget(&self, target: &ForgeTarget) {
        self.cache().remove(&Self::auth_key(target));
    }

    /// One resolution per credential key, reused until its TTL expires. The
    /// selection the resolution returns wins over every ambient token.
    async fn resolve(
        &self,
        target: &ForgeTarget,
        cwd: &Path,
    ) -> Result<crate::forge::ResolvedAuth, String> {
        let key = Self::auth_key(target);
        let now = crate::providers::now_millis();
        {
            let cache = self.cache();
            if let Some(entry) = cache.get(&key) {
                if entry.expires > now {
                    return Ok(entry.auth.clone());
                }
            }
        }
        let forge = forge_kind(target)
            .ok_or_else(|| "The origin remote does not name a supported repository.".to_string())?;
        let mut environment: HashMap<String, String> = std::env::vars().collect();
        environment.extend(self.env.clone());
        let options = crate::forge::ResolveOptions {
            forge,
            host: target.host.clone(),
            project: target.project.clone(),
            cwd: cwd.to_path_buf(),
            required: crate::forge::RequiredAccess::Write,
            env: environment,
            deadline_ms: Some(now + self.timeout_ms as i64),
            base_url: target.base_url.clone(),
            gitea_transport: Some(self.transport.clone()),
        };
        match crate::forge::resolve_forge_auth(&self.exec, &options).await {
            crate::forge::AuthOutcome::Resolved(auth) => {
                self.cache().insert(
                    key,
                    CachedAuth {
                        auth: auth.clone(),
                        expires: now + AUTH_CACHE_TTL_MS,
                    },
                );
                Ok(auth)
            }
            crate::forge::AuthOutcome::Failure(failure) => Err(failure.error),
        }
    }

    /// Runs one forge CLI command with the resolved credential.
    async fn run(
        &self,
        cwd: &Path,
        target: &ForgeTarget,
        command: &str,
        args: Vec<String>,
    ) -> Result<crate::forge::ExecResult, String> {
        let auth = self.resolve(target, cwd).await?;
        let mut environment =
            crate::forge::auth_environment(&auth, &crate::forge::process_environment())
                .map_err(|error| error.message)?;
        environment.extend(forge_git_env());
        let result = (self.exec)(
            command.to_string(),
            args,
            crate::forge::ExecOptions {
                cwd: Some(cwd.to_path_buf()),
                env: environment,
                timeout_ms: Some(self.timeout_ms),
                stdin: None,
            },
        )
        .await;
        if is_auth_diagnostic(&result) {
            self.forget(target);
        }
        Ok(result)
    }

    /// The Gitea HTTP target one resolved credential names.
    async fn gitea(
        &self,
        target: &ForgeTarget,
        cwd: &Path,
    ) -> Result<crate::forge::GiteaTarget, String> {
        let auth = self.resolve(target, cwd).await?;
        let base_url = auth
            .base_url
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Creating a Gitea pull request needs DEVBOARD_GITEA_URL.".to_string())?;
        Ok(crate::forge::GiteaTarget {
            base_url,
            project: target.project.clone(),
            token: auth.token.clone(),
        })
    }

    fn call_options(&self) -> crate::forge::GiteaCallOptions {
        crate::forge::GiteaCallOptions {
            flow_id: None,
            timeout_ms: Some(self.timeout_ms),
        }
    }
}

impl Default for CommandFlowForge {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowForge for CommandFlowForge {
    fn create_draft(&self, input: ForgePrInput) -> BoxFuture<'_, Result<ForgePrState, String>> {
        Box::pin(async move {
            if input.target.forge == "gitea" {
                let target = self.gitea(&input.target, &input.cwd).await?;
                let pull = crate::forge::gitea_create_pull(
                    &target,
                    &crate::forge::CreatePullInput {
                        head: input.head,
                        base: input.base,
                        title: input.title,
                        body: input.body,
                    },
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                return Ok(ForgePrState {
                    number: pull.number.max(0) as u64,
                    url: pull.url,
                    state: "open".to_string(),
                    draft: true,
                });
            }
            let (command, args) = if input.target.forge == "github" {
                (
                    "gh",
                    vec![
                        "pr".to_string(),
                        "create".to_string(),
                        "--draft".to_string(),
                        "--base".to_string(),
                        input.base.clone(),
                        "--head".to_string(),
                        input.head.clone(),
                        "--title".to_string(),
                        input.title.clone(),
                        "--body".to_string(),
                        input.body.clone(),
                    ],
                )
            } else {
                (
                    "glab",
                    vec![
                        "mr".to_string(),
                        "create".to_string(),
                        "--draft".to_string(),
                        "--source-branch".to_string(),
                        input.head.clone(),
                        "--target-branch".to_string(),
                        input.base.clone(),
                        "--title".to_string(),
                        input.title.clone(),
                        "--description".to_string(),
                        input.body.clone(),
                        "--yes".to_string(),
                    ],
                )
            };
            let result = self.run(&input.cwd, &input.target, command, args).await?;
            if result.code != 0 {
                return Err(forge_failure("create the draft pull request", &result));
            }
            let url = first_url(&result.stdout).or_else(|| first_url(&result.stderr));
            let number = url.as_deref().and_then(number_from_url);
            let Some((url, number)) = url.zip(number) else {
                return Err(
                    "Could not create the draft pull request: the forge returned no URL."
                        .to_string(),
                );
            };
            Ok(ForgePrState {
                number,
                url,
                state: "open".to_string(),
                draft: true,
            })
        })
    }

    fn update(&self, input: ForgePrInput, number: u64) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if input.target.forge == "gitea" {
                let target = self.gitea(&input.target, &input.cwd).await?;
                // Gitea records draft state in the title. A checkpoint after
                // Ready must not send the WIP: prefix back and silently turn
                // the request into a draft again, so the current state decides
                // the title.
                let current = crate::forge::gitea_pull(
                    &target,
                    number as i64,
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                let title = if current.draft {
                    crate::forge::draft_title(&input.title)
                } else {
                    crate::forge::ready_title(&input.title)
                };
                crate::forge::gitea_edit_pull(
                    &target,
                    number as i64,
                    Some(&title),
                    Some(&input.body),
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                return Ok(());
            }
            let (command, args) = if input.target.forge == "github" {
                (
                    "gh",
                    vec![
                        "pr".to_string(),
                        "edit".to_string(),
                        number.to_string(),
                        "--title".to_string(),
                        input.title.clone(),
                        "--body".to_string(),
                        input.body.clone(),
                    ],
                )
            } else {
                (
                    "glab",
                    vec![
                        "mr".to_string(),
                        "update".to_string(),
                        number.to_string(),
                        "--title".to_string(),
                        input.title.clone(),
                        "--description".to_string(),
                        input.body.clone(),
                    ],
                )
            };
            let result = self.run(&input.cwd, &input.target, command, args).await?;
            if result.code != 0 {
                return Err(forge_failure("update the pull request", &result));
            }
            Ok(())
        })
    }

    fn mark_ready<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if target.forge == "gitea" {
                let gitea = self.gitea(target, cwd).await?;
                let current = crate::forge::gitea_pull(
                    &gitea,
                    number as i64,
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                let title = if current.title.starts_with(crate::forge::DRAFT_PREFIX) {
                    crate::forge::ready_title(&current.title)
                } else {
                    current.title.clone()
                };
                crate::forge::gitea_edit_pull(
                    &gitea,
                    number as i64,
                    Some(&title),
                    None,
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                return Ok(());
            }
            let (command, args) = if target.forge == "github" {
                (
                    "gh",
                    vec!["pr".to_string(), "ready".to_string(), number.to_string()],
                )
            } else {
                (
                    "glab",
                    vec![
                        "mr".to_string(),
                        "update".to_string(),
                        number.to_string(),
                        "--ready".to_string(),
                    ],
                )
            };
            let result = self.run(cwd, target, command, args).await?;
            if result.code != 0 {
                return Err(forge_failure("mark the pull request ready", &result));
            }
            Ok(())
        })
    }

    fn merge<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if target.forge == "gitea" {
                let gitea = self.gitea(target, cwd).await?;
                crate::forge::gitea_merge_pull(
                    &gitea,
                    number as i64,
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                return Ok(());
            }
            // A merge commit is the only accepted method: never squash, never
            // rebase. glab has no flag that forces a merge commit; it is the
            // default when neither --squash nor --rebase is passed.
            let (command, args) = if target.forge == "github" {
                (
                    "gh",
                    vec![
                        "pr".to_string(),
                        "merge".to_string(),
                        number.to_string(),
                        "--merge".to_string(),
                    ],
                )
            } else {
                (
                    "glab",
                    vec![
                        "mr".to_string(),
                        "merge".to_string(),
                        number.to_string(),
                        "--yes".to_string(),
                    ],
                )
            };
            let result = self.run(cwd, target, command, args).await?;
            if result.code != 0 {
                return Err(forge_failure("merge the pull request", &result));
            }
            Ok(())
        })
    }

    fn view<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<ForgePrState, String>> {
        Box::pin(async move {
            if target.forge == "gitea" {
                let gitea = self.gitea(target, cwd).await?;
                let pull = crate::forge::gitea_pull(
                    &gitea,
                    number as i64,
                    &self.transport,
                    &self.call_options(),
                )
                .await
                .map_err(|error| error.message)?;
                return Ok(ForgePrState {
                    number: pull.number.max(0) as u64,
                    url: pull.url,
                    state: pull.state.as_str().to_string(),
                    draft: pull.draft,
                });
            }
            let (command, args) = if target.forge == "github" {
                (
                    "gh",
                    vec![
                        "pr".to_string(),
                        "view".to_string(),
                        number.to_string(),
                        "--json".to_string(),
                        "number,url,state,isDraft".to_string(),
                    ],
                )
            } else {
                (
                    "glab",
                    vec![
                        "mr".to_string(),
                        "view".to_string(),
                        number.to_string(),
                        "--output".to_string(),
                        "json".to_string(),
                    ],
                )
            };
            let result = self.run(cwd, target, command, args).await?;
            if result.code != 0 {
                return Err(forge_failure("read the pull request", &result));
            }
            let parsed = serde_json::from_str::<Value>(&result.stdout)
                .ok()
                .filter(Value::is_object)
                .ok_or_else(|| {
                    "Could not read the pull request: unexpected forge output.".to_string()
                })?;
            let state = normalized_forge_state(parsed.get("state"));
            let url = parsed
                .get("url")
                .and_then(Value::as_str)
                .or_else(|| parsed.get("web_url").and_then(Value::as_str));
            let (Some(state), Some(url)) = (state, url) else {
                return Err("Could not read the pull request: unexpected forge output.".to_string());
            };
            let draft = parsed.get("isDraft").and_then(Value::as_bool) == Some(true)
                || parsed.get("draft").and_then(Value::as_bool) == Some(true);
            Ok(ForgePrState {
                number,
                url: url.to_string(),
                state: state.to_string(),
                draft,
            })
        })
    }

    fn delete_remote_branch<'a>(
        &'a self,
        cwd: &'a Path,
        branch: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut environment: HashMap<String, String> = std::env::vars().collect();
            environment.extend(forge_git_env());
            let result = (self.exec)(
                "git".to_string(),
                vec![
                    "push".to_string(),
                    "origin".to_string(),
                    "--delete".to_string(),
                    branch.to_string(),
                ],
                crate::forge::ExecOptions {
                    cwd: Some(cwd.to_path_buf()),
                    env: environment,
                    timeout_ms: Some(self.timeout_ms),
                    stdin: None,
                },
            )
            .await;
            if result.code != 0 {
                return Err(forge_failure(
                    &format!("delete the remote branch {branch}"),
                    &result,
                ));
            }
            Ok(())
        })
    }
}

/// A deterministic forge for Flow Mode's tests and browser verification.
///
/// It records every operation as one JSON line and answers as a forge would,
/// so a test proves the draft to live to merged transitions without a network.
pub struct StubForge {
    log_path: Option<PathBuf>,
    number: u64,
    base_url: String,
    inner: Mutex<StubForgeState>,
}

#[derive(Default)]
struct StubForgeState {
    pr: Option<ForgePrState>,
}

impl StubForge {
    pub fn new(log_path: Option<PathBuf>) -> Self {
        Self {
            log_path,
            number: 7,
            base_url: "https://forge.test/acme/fixture".to_string(),
            inner: Mutex::new(StubForgeState::default()),
        }
    }

    fn record(&self, value: Value) {
        let Some(path) = &self.log_path else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        use std::io::Write as _;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{}", crate::jsjson::stringify(&value));
        }
    }

    fn lock(&self) -> MutexGuard<'_, StubForgeState> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn target_json(target: &ForgeTarget) -> Value {
        let mut object = Map::new();
        object.insert("forge".into(), Value::String(target.forge.clone()));
        object.insert("host".into(), Value::String(target.host.clone()));
        object.insert("project".into(), Value::String(target.project.clone()));
        if let Some(base_url) = &target.base_url {
            object.insert("baseUrl".into(), Value::String(base_url.clone()));
        }
        Value::Object(object)
    }
}

impl FlowForge for StubForge {
    fn create_draft(&self, input: ForgePrInput) -> BoxFuture<'_, Result<ForgePrState, String>> {
        Box::pin(async move {
            self.record(json!({
                "op": "createDraft",
                "input": {
                    "head": input.head,
                    "base": input.base,
                    "title": input.title,
                    "body": input.body,
                },
            }));
            let url = if input.target.forge == "github" {
                format!("{}/pull/{}", self.base_url, self.number)
            } else {
                format!("{}/-/merge_requests/{}", self.base_url, self.number)
            };
            let state = ForgePrState {
                number: self.number,
                url,
                state: "open".to_string(),
                draft: true,
            };
            self.lock().pr = Some(state.clone());
            Ok(state)
        })
    }

    fn update(&self, input: ForgePrInput, number: u64) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.record(json!({
                "op": "update",
                "number": number,
                "input": { "title": input.title, "body": input.body },
            }));
            Ok(())
        })
    }

    fn mark_ready<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.record(json!({
                "op": "markReady",
                "number": number,
                "input": { "cwd": cwd.to_string_lossy(), "target": Self::target_json(target) },
            }));
            if let Some(pr) = self.lock().pr.as_mut() {
                pr.draft = false;
            }
            Ok(())
        })
    }

    fn merge<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.record(json!({
                "op": "merge",
                "number": number,
                "input": {
                    "cwd": cwd.to_string_lossy(),
                    "target": Self::target_json(target),
                    "method": "merge",
                },
            }));
            if let Some(pr) = self.lock().pr.as_mut() {
                pr.state = "merged".to_string();
                pr.draft = false;
            }
            Ok(())
        })
    }

    fn view<'a>(
        &'a self,
        cwd: &'a Path,
        target: &'a ForgeTarget,
        number: u64,
    ) -> BoxFuture<'a, Result<ForgePrState, String>> {
        Box::pin(async move {
            self.record(json!({
                "op": "view",
                "number": number,
                "input": { "cwd": cwd.to_string_lossy(), "target": Self::target_json(target) },
            }));
            match self.lock().pr.clone() {
                Some(pr) => Ok(pr),
                None => Err("No pull request exists.".to_string()),
            }
        })
    }

    fn delete_remote_branch<'a>(
        &'a self,
        cwd: &'a Path,
        branch: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.record(json!({
                "op": "deleteRemoteBranch",
                "branch": branch,
                "input": { "cwd": cwd.to_string_lossy() },
            }));
            Ok(())
        })
    }
}

/// The target the recorded corpus injects with `DEVBOARD_FLOW_FORGE=stub`.
fn stub_flow_target() -> Option<ForgeTarget> {
    if std::env::var("DEVBOARD_FLOW_FORGE").ok().as_deref() != Some("stub") {
        return None;
    }
    let forge = if std::env::var("DEVBOARD_FLOW_FORGE_KIND").ok().as_deref() == Some("gitlab") {
        "gitlab"
    } else {
        "github"
    };
    Some(ForgeTarget {
        forge: forge.to_string(),
        host: "forge.test".to_string(),
        project: "acme/fixture".to_string(),
        base_url: None,
    })
}

fn stub_flow_forge() -> Option<Arc<dyn FlowForge>> {
    if std::env::var("DEVBOARD_FLOW_FORGE").ok().as_deref() != Some("stub") {
        return None;
    }
    let log_path = std::env::var("DEVBOARD_FLOW_FORGE_LOG")
        .ok()
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    Some(Arc::new(StubForge::new(log_path)))
}

// ---------------------------------------------------------------------------
// Forge remote classification

/// The forge named by an origin URL, reusing the tracker's classification.
pub fn classify_origin(remote: &str, environment: &HashMap<String, String>) -> Option<ForgeTarget> {
    let parsed = crate::forge::parse_forge_remote(remote, environment)?;
    let base_url = if parsed.forge == crate::forge::Forge::Gitea {
        crate::forge::gitea_base_url(Some(&parsed), environment)
    } else {
        None
    };
    Some(ForgeTarget {
        forge: parsed.forge.as_str().to_string(),
        host: parsed.host,
        project: parsed.project,
        base_url,
    })
}

/// The pull-request title: the goal's first non-empty line, bounded.
pub fn pr_title(goal: &str) -> String {
    let line = first_line(goal);
    if line.chars().count() > 120 {
        format!("{}...", line.chars().take(117).collect::<String>())
    } else {
        line
    }
}

/// The pull-request body: the goal and the decision board.
pub fn pr_body(goal: &str, decisions: &str) -> String {
    let decisions = decisions.trim();
    [
        "## Goal",
        "",
        goal.trim(),
        "",
        "## Decisions",
        "",
        if decisions.is_empty() {
            "No decisions recorded."
        } else {
            decisions
        },
        "",
    ]
    .join("\n")
}

fn first_line(text: &str) -> String {
    text.replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.trim().trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .unwrap_or("Flow session")
        .to_string()
}

fn bounded_tail(text: &str) -> String {
    let count = text.chars().count();
    if count <= OUTPUT_TAIL_MAX {
        return text.to_string();
    }
    text.chars().skip(count - OUTPUT_TAIL_MAX).collect()
}

/// One stored checkpoint, with the defaults the reference applies to a record
/// that names only its commit.
fn checkpoint_from_value(entry: &Value) -> Option<FlowCheckpoint> {
    let commit = entry.get("commit").and_then(Value::as_str)?;
    let short: String = commit.chars().take(7).collect();
    Some(FlowCheckpoint {
        id: entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("checkpoint-{short}")),
        timestamp: entry
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        summary: entry
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        files: entry.get("files").and_then(Value::as_u64).unwrap_or(0),
        commit: commit.to_string(),
        verification: verification_status(entry.get("verification")),
    })
}

fn verification_status(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some("passed") => "passed".to_string(),
        Some("failed") => "failed".to_string(),
        _ => STALE_VERIFICATION.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Small file helpers

fn now_iso() -> String {
    crate::providers::iso_timestamp(crate::providers::now_millis())
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn write_text(path: &Path, text: &str) -> std::io::Result<()> {
    crate::state::write_state_file(path, text)
}

fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    write_text(path, &format!("{text}\n"))
}

fn read_json(path: &Path) -> Option<Value> {
    let text = read_text(path)?;
    serde_json::from_str(&text).ok()
}

/// Lines of a JSON-lines file; a malformed or absent file reads as none.
fn read_json_lines(path: &Path) -> Vec<Value> {
    let Some(source) = read_text(path) else {
        return Vec::new();
    };
    source
        .split('\n')
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                serde_json::from_str::<Value>(trimmed).ok()
            }
        })
        .collect()
}

fn append_line(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{}", crate::jsjson::stringify(value))
}

fn session_id() -> String {
    // `randomUUID().replace(/-/g, "").slice(0, 8)`.
    let digest = uuid::Uuid::new_v4().simple().to_string();
    digest[..8].to_string()
}

fn steering_id() -> String {
    format!("steer-{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

fn blocker_id() -> String {
    format!(
        "blocker-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

// ---------------------------------------------------------------------------
// In-memory controller state

#[derive(Clone)]
struct GoalCreationRestore {
    session: Option<Session>,
    persisted_goal: Option<String>,
    /// The previous session's goal.md bytes, or `None` when the file was absent.
    goal_text: Option<String>,
    /// True when this Create opened the session directory itself.
    session_created: bool,
}

struct GoalCreation {
    token: u64,
    activity: Vec<String>,
    question: Option<FlowQuestion>,
    agent: Option<Arc<DetachedPeer>>,
    restore: GoalCreationRestore,
}

struct Implementation {
    token: u64,
    activity: Vec<String>,
    agent: Option<Arc<DetachedPeer>>,
    #[allow(dead_code)]
    finished: bool,
}

struct Conversation {
    token: u64,
    widget_id: String,
    agent: Option<Arc<AcpConnection>>,
    messages: Vec<ConversationMessage>,
    activity: Vec<String>,
    question: Option<FlowQuestion>,
    busy: bool,
    queue: Vec<String>,
}

impl Conversation {
    /// Appends the developer's message and decides who runs it: `true` means
    /// the caller starts the prompt turn, and `false` means the text waits for
    /// the live turn — or the opening prompt — to finish and drain it. The
    /// decision and the enqueue belong to this one call so a turn that
    /// finishes concurrently can never drain an empty queue and strand a
    /// message that was read as queued.
    fn enqueue_message(&mut self, text: &str) -> bool {
        self.messages.push(ConversationMessage {
            role: "developer".to_string(),
            text: text.to_string(),
        });
        if self.busy {
            self.queue.push(text.to_string());
            false
        } else {
            self.busy = true;
            true
        }
    }
}

struct Analyst {
    token: u64,
    agent: Option<Arc<AcpConnection>>,
}

/// Why the checkout is unavailable: the mode that owns it, the subject it is
/// working on, and the exact sentence tail each Flow command prints.
pub struct CheckoutBlocker {
    /// The refusal's first sentence without its period.
    pub label: String,
    /// What a Flow start prints.
    pub start: String,
    /// What a pull-request merge prints.
    pub merge: String,
}

struct Inner {
    session: Option<Session>,
    history: Vec<FlowHistoryEntry>,
    /// The goal text already on disk, or `None` when goal.md may not match it.
    persisted_goal: Option<String>,
    implementation: Option<Implementation>,
    goal_creation: Option<GoalCreation>,
    analyst: Option<Analyst>,
    analyst_pending: bool,
    conversation: Option<Conversation>,
    timer: Option<tokio::task::AbortHandle>,
    ticking: bool,
    tick_queued: bool,
    disposed: bool,
    begun: bool,
    restoring: bool,
    replay_waiters: Vec<Conn>,
    /// True until Start: a restored session never spawns an analyst by itself.
    quiet: bool,
    pr_busy: bool,
    /// The newest checkpoint tip a busy PR sync must pick up when it finishes.
    pr_pending_tip: Option<String>,
    restart_notice: Option<String>,
    started_at: String,
    forge: Arc<dyn FlowForge>,
    forge_target: Option<ForgeTarget>,
    checkout_blocker: Option<Arc<dyn Fn() -> Option<CheckoutBlocker> + Send + Sync>>,
    /// Publishes the restore's completion to waiting commands.
    restore_tx: tokio::sync::watch::Sender<bool>,
}

/// Flow Mode's controller for one dashboard.
pub struct FlowMode {
    app: Weak<App>,
    inner: Mutex<Inner>,
    decisions_lock: tokio::sync::Mutex<()>,
    /// Signals that the durable session restore has finished.
    restored: tokio::sync::watch::Receiver<bool>,
}

static FLOW_MODES: LazyLock<Mutex<HashMap<usize, Arc<FlowMode>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static Mutex<HashMap<usize, Arc<FlowMode>>> {
    &FLOW_MODES
}

fn register(app: &Arc<App>, mode: Arc<FlowMode>) {
    let key = Arc::as_ptr(app) as usize;
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(key, mode);
}

/// The controller serving one dashboard, if it has one.
pub fn controller(app: &Arc<App>) -> Option<Arc<FlowMode>> {
    let key = Arc::as_ptr(app) as usize;
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&key)
        .cloned()
}

fn next_token() -> u64 {
    NEXT_TOKEN.fetch_add(1, Ordering::SeqCst)
}

/// The ACP peers this controller still holds directly. A detached goal or
/// implementation run belongs to its owner, which the replacement adopts.
pub fn capture_children(app: Arc<App>) -> Vec<crate::detached_run::RecordedChild> {
    let Some(mode) = controller(&app) else {
        return Vec::new();
    };
    let inner = mode.lock();
    let mut children = Vec::new();
    let conversation = inner
        .conversation
        .as_ref()
        .and_then(|conversation| conversation.agent.as_ref());
    let analyst = inner
        .analyst
        .as_ref()
        .and_then(|analyst| analyst.agent.as_ref());
    for agent in [conversation, analyst].into_iter().flatten() {
        let Some(pid) = agent.pid() else {
            continue;
        };
        children.push(crate::detached_run::RecordedChild {
            pid,
            argv: agent.argv(),
            cwd: mode.repo_dir().display().to_string(),
        });
    }
    children
}

// ---------------------------------------------------------------------------
// Registration

/// Registers this mode's durable state with the dashboard.
pub fn init(app: &Arc<App>) {
    let mode = Arc::new(FlowMode::new(app));
    register(app, Arc::clone(&mode));
    app.shared.register_gate(
        "flow",
        Arc::new(FlowGate {
            mode: Arc::downgrade(&mode),
        }),
    );
    let weak = Arc::downgrade(app);
    install_checkout_blocker(
        app,
        Arc::new(move || {
            let app = weak.upgrade()?;
            default_checkout_blocker(&app)
        }),
    );
    mode.begin();
}

/// The checkout another mode holds, in the reference's sentences. Discover and
/// Goal Mode own the checkout while they work, so Flow refuses to start or
/// merge beside them.
fn default_checkout_blocker(app: &Arc<App>) -> Option<CheckoutBlocker> {
    if app.shared.gate_active("discover") {
        return Some(CheckoutBlocker {
            label: "Discover is active (a Discover run)".to_string(),
            start: "Stop it in Discover before starting Flow work.".to_string(),
            merge: "Stop it in Discover before starting Flow work.".to_string(),
        });
    }
    if app.shared.gate_active("goal-run") || app.shared.gate_active("goal-authoring") {
        return Some(CheckoutBlocker {
            label: "Goal Mode is active (a Goal Mode run)".to_string(),
            start: "Stop it before starting Flow work.".to_string(),
            merge: "Stop it before merging the Flow pull request.".to_string(),
        });
    }
    None
}

/// Flow's live-work gate: another mode's start refuses beside it, and the
/// replacement's preemption ends its peers exactly as `dispose` does.
struct FlowGate {
    mode: Weak<FlowMode>,
}

impl crate::app::ModeGate for FlowGate {
    fn has_active_work(&self) -> bool {
        self.mode
            .upgrade()
            .is_some_and(|mode| mode.has_active_work())
    }

    fn busy_reason(&self) -> Option<String> {
        self.has_active_work()
            .then(|| "Flow Mode is active.".to_string())
    }

    fn abort_active_work(&self) {
        if let Some(mode) = self.mode.upgrade() {
            mode.dispose();
        }
    }
}

/// Injects the forge adapter Flow drives.
pub fn install_forge(app: &Arc<App>, forge: Arc<dyn FlowForge>) {
    if let Some(mode) = controller(app) {
        mode.lock().forge = forge;
    }
}

/// Injects the host's checkout blocker, so Flow never guesses which mode holds
/// the checkout.
pub fn install_checkout_blocker(
    app: &Arc<App>,
    blocker: Arc<dyn Fn() -> Option<CheckoutBlocker> + Send + Sync>,
) {
    if let Some(mode) = controller(app) {
        mode.lock().checkout_blocker = Some(blocker);
    }
}

/// Replays the frames a connecting client owes before its own replies.
pub fn replay(app: &Arc<App>, conn: &Conn) {
    if let Some(mode) = controller(app) {
        mode.replay_to(Some(conn));
    }
}

/// Whether a Flow session exists whose worktree or pull request is not
/// merged. A reset refuses while this is true.
pub fn has_unmerged_session(app: &Arc<App>) -> bool {
    controller(app).is_some_and(|mode| {
        let inner = mode.lock();
        inner
            .session
            .as_ref()
            .is_some_and(|session| session.status != "merged")
    })
}

/// Every command this mode owns.
pub fn handles(command: &Command) -> bool {
    matches!(
        command,
        Command::GetFlow
            | Command::CreateFlowGoal
            | Command::CancelFlowGoal
            | Command::StartFlowImplementation
            | Command::StopFlowImplementation
            | Command::RetryFlowPr
            | Command::MarkFlowPrReady
            | Command::MergeFlowPr
            | Command::SendFlowSteering { .. }
            | Command::AcceptFlowWidget { .. }
            | Command::RefuseFlowWidget { .. }
            | Command::OpenFlowWidget { .. }
            | Command::CloseFlowWidget
            | Command::SendFlowConversation { .. }
            | Command::SendFlowConclusion { .. }
            | Command::DismissFlowBlocker { .. }
            | Command::FlowAnswer { .. }
    )
}

/// Applies one command; `false` when it belongs to another mode.
pub async fn handle(app: &Arc<App>, _conn: &Conn, command: &Command) -> bool {
    let Some(mode) = controller(app) else {
        return false;
    };
    if !handles(command) {
        return false;
    }
    mode.wait_restored().await;
    match command {
        Command::GetFlow => {
            replay(app, _conn);
            return true;
        }
        Command::CreateFlowGoal => mode.create_goal().await,
        Command::CancelFlowGoal => mode.cancel_goal(),
        Command::StartFlowImplementation => mode.start_implementation().await,
        Command::StopFlowImplementation => mode.stop_implementation(),
        Command::RetryFlowPr => mode.retry_pr().await,
        Command::MarkFlowPrReady => mode.mark_pr_ready().await,
        Command::MergeFlowPr => mode.merge_pr().await,
        Command::SendFlowSteering { text } => {
            mode.send_steering(text.clone().unwrap_or(Value::Null), "developer");
        }
        Command::AcceptFlowWidget { id, accepted } => {
            mode.accept_widget(id.clone(), accepted.clone());
        }
        Command::RefuseFlowWidget { id, reason } => mode.refuse_widget(id.clone(), reason.clone()),
        Command::OpenFlowWidget { id } => mode.open_conversation(id.clone()).await,
        Command::CloseFlowWidget => mode.close_conversation(false),
        Command::SendFlowConversation { text } => {
            mode.send_conversation_message(text.clone().unwrap_or(Value::Null));
        }
        Command::SendFlowConclusion { text } => {
            mode.send_conversation_conclusion(text.clone().unwrap_or(Value::Null))
                .await;
        }
        Command::DismissFlowBlocker { id } => mode.dismiss_blocker(id.clone()),
        Command::FlowAnswer { id, value, target } => {
            mode.answer(id.clone(), value.clone(), target.clone()).await;
        }
        _ => return false,
    }
    true
}

impl FlowMode {
    fn new(app: &Arc<App>) -> Self {
        let stub_target = stub_flow_target();
        let forge: Arc<dyn FlowForge> =
            stub_flow_forge().unwrap_or_else(|| Arc::new(CommandFlowForge::new()));
        let (restore_tx, restored) = tokio::sync::watch::channel(false);
        Self {
            app: Arc::downgrade(app),
            inner: Mutex::new(Inner {
                session: None,
                history: Vec::new(),
                persisted_goal: None,
                implementation: None,
                goal_creation: None,
                analyst: None,
                analyst_pending: false,
                conversation: None,
                timer: None,
                ticking: false,
                tick_queued: false,
                disposed: false,
                begun: false,
                restoring: false,
                replay_waiters: Vec::new(),
                quiet: false,
                pr_busy: false,
                pr_pending_tip: None,
                restart_notice: None,
                started_at: now_iso(),
                forge,
                forge_target: stub_target,
                checkout_blocker: None,
                restore_tx,
            }),
            decisions_lock: tokio::sync::Mutex::new(()),
            restored,
        }
    }

    /// Waits until the durable restore has finished, so a command never races
    /// the state it would act on. The bound is a last resort against a task
    /// that died before signalling; a restore's own git children are bounded
    /// well inside it.
    async fn wait_restored(&self) {
        let mut receiver = self.restored.clone();
        if *receiver.borrow() {
            return;
        }
        let _ =
            tokio::time::timeout(Duration::from_secs(120), receiver.wait_for(|value| *value)).await;
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn app(&self) -> Option<Arc<App>> {
        self.app.upgrade()
    }

    fn watch_ms(&self) -> u64 {
        std::env::var("DEVBOARD_FLOW_WATCH_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_WATCH_MS)
            .max(10)
    }

    fn analyst_timeout_ms(&self) -> u64 {
        std::env::var("DEVBOARD_FLOW_ANALYST_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_ANALYST_TIMEOUT_MS)
            .max(10)
    }

    // ---------------------------------------------------------- lifecycle

    fn begin(self: &Arc<Self>) {
        {
            let mut inner = self.lock();
            if inner.begun {
                return;
            }
            inner.begun = true;
        }
        // A dashboard that has never had a Flow session has nothing to
        // restore, so its commands must never wait on a scheduled task: the
        // signal is settled here, synchronously.
        let empty = std::fs::read_dir(self.flow_root())
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true);
        if empty {
            let mut inner = self.lock();
            inner.restoring = false;
            let _ = inner.restore_tx.send(true);
            return;
        }
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            mode.restore().await;
        });
    }

    /// Starts one detached agent turn.
    fn spawn_goal_creation(self: &Arc<Self>, token: u64) {
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            mode.run_goal_creation(token).await;
        });
    }

    fn has_active_work(&self) -> bool {
        let inner = self.lock();
        inner.goal_creation.is_some()
            || inner.implementation.is_some()
            || inner.analyst.is_some()
            || inner.conversation.is_some()
            || inner.pr_busy
    }

    /// Ends every live peer and the watcher. The durable session stays.
    fn dispose(&self) {
        let mut inner = self.lock();
        inner.disposed = true;
        if let Some(timer) = inner.timer.take() {
            timer.abort();
        }
        if let Some(implementation) = inner.implementation.take() {
            if let Some(agent) = &implementation.agent {
                agent.close();
            }
        }
        if let Some(creation) = inner.goal_creation.take() {
            if let Some(agent) = &creation.agent {
                agent.close();
            }
        }
        if let Some(conversation) = inner.conversation.take() {
            if let Some(agent) = &conversation.agent {
                agent.close();
            }
        }
        if let Some(analyst) = inner.analyst.take() {
            if let Some(agent) = &analyst.agent {
                agent.close();
            }
        }
    }

    fn refuse_checkout_blocked(&self, action: &str) -> bool {
        // The hook reads the other modes' gates; it runs without this mode's
        // lock held, so the two mutexes are never taken in both orders.
        let hook = {
            let inner = self.lock();
            inner.checkout_blocker.clone()
        };
        let blocker = hook.and_then(|hook| hook());
        let Some(blocker) = blocker else {
            return false;
        };
        let tail = if action == "start" {
            &blocker.start
        } else {
            &blocker.merge
        };
        self.error(&format!("{}. {}", blocker.label, tail));
        true
    }

    fn error(&self, message: &str) {
        self.broadcast(json!({"type": "flowError", "message": message}));
    }

    fn notice(&self, message: &str) {
        self.broadcast(json!({"type": "flowNotice", "message": message}));
    }

    fn broadcast(&self, event: Value) {
        if let Some(app) = self.app() {
            app.broadcast(event);
        }
    }

    // -------------------------------------------------------------- paths

    /// `<stateDir>/flow/<24-hex repository key>`.
    fn flow_root(&self) -> PathBuf {
        let Some(app) = self.app() else {
            return PathBuf::new();
        };
        app.config()
            .state_dir
            .join("flow")
            .join(crate::journal::repo_key(&app.config().repo_dir))
    }

    /// The flow root while the server that owns the state directory is still
    /// alive. A torn-down mode has no root to write under, and its empty
    /// [`Self::flow_root`] must never become the process working directory.
    fn live_flow_root(&self) -> Option<PathBuf> {
        self.app()?;
        Some(self.flow_root())
    }

    fn repo_dir(&self) -> PathBuf {
        self.app()
            .map(|app| app.config().repo_dir.clone())
            .unwrap_or_default()
    }

    fn state_dir(&self) -> PathBuf {
        self.app()
            .map(|app| app.config().state_dir.clone())
            .unwrap_or_default()
    }

    fn instance(&self) -> String {
        self.app()
            .map(|app| app.instance.clone())
            .unwrap_or_default()
    }

    fn harness_version(&self) -> Option<String> {
        self.app().and_then(|app| app.running_version.clone())
    }

    fn session_dir(&self) -> Option<PathBuf> {
        let id = self
            .lock()
            .session
            .as_ref()
            .map(|session| session.id.clone())?;
        Some(self.live_flow_root()?.join(id))
    }

    fn path(&self, name: &str) -> Result<PathBuf, String> {
        let directory = self
            .session_dir()
            .ok_or_else(|| "No Flow session exists.".to_string())?;
        Ok(directory.join(name))
    }

    fn worktree_path(&self, id: &str) -> PathBuf {
        self.repo_dir().join(".worktree").join(format!("flow-{id}"))
    }

    // ----------------------------------------------------------- snapshot

    fn snapshot(&self) -> Value {
        let inner = self.lock();
        let session = inner.session.as_ref();
        let conversation = inner.conversation.as_ref();
        let creation = inner.goal_creation.as_ref();
        let empty: Vec<Value> = Vec::new();
        let files = session
            .map(|session| serde_json::to_value(&session.files).unwrap_or_default())
            .unwrap_or_else(|| Value::Array(empty.clone()));
        let widgets = session
            .map(|session| serde_json::to_value(&session.widgets).unwrap_or_default())
            .unwrap_or_else(|| Value::Array(empty.clone()));
        let steering = session
            .map(|session| serde_json::to_value(&session.steering).unwrap_or_default())
            .unwrap_or_else(|| Value::Array(empty.clone()));
        let checkpoints = session
            .map(|session| serde_json::to_value(&session.checkpoints).unwrap_or_default())
            .unwrap_or_else(|| Value::Array(empty.clone()));
        let blockers = session
            .map(|session| serde_json::to_value(&session.blockers).unwrap_or_default())
            .unwrap_or_else(|| Value::Array(empty.clone()));
        let verification = session
            .and_then(|session| session.verification.as_ref())
            .map(|verification| serde_json::to_value(verification).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        let pr = session
            .and_then(|session| session.pr.as_ref())
            .map(|pr| serde_json::to_value(pr).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        let question = session
            .and_then(|session| session.question.as_ref())
            .map(|question| serde_json::to_value(question).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        let goal_creation = creation.map(|creation| {
            json!({
                "activity": creation.activity,
                "question": creation.question.as_ref()
                    .map(|question| serde_json::to_value(question).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null),
            })
        });
        let conversation_json = conversation.map(|conversation| {
            json!({
                "widgetId": conversation.widget_id,
                "messages": conversation.messages,
                "activity": conversation.activity,
                "question": conversation.question.as_ref()
                    .map(|question| serde_json::to_value(question).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null),
            })
        });
        let activity: Vec<String> = inner
            .implementation
            .as_ref()
            .map(|implementation| implementation.activity.clone())
            .unwrap_or_default();
        json!({
            "sessionId": session.map(|session| session.id.clone()),
            "status": session.map(|session| session.status.clone()).unwrap_or_else(|| "none".to_string()),
            "goal": session.map(|session| session.goal.clone()).unwrap_or_default(),
            "decisions": session.map(|session| session.decisions.clone()).unwrap_or_default(),
            "worktree": session.map(|session| session.worktree.clone()),
            "branch": session.map(|session| session.branch.clone()),
            "baseRevision": session.and_then(|session| session.base_revision.clone()),
            "files": files,
            "widgets": widgets,
            "steering": steering,
            "checkpoints": checkpoints,
            "verification": verification,
            "blockers": blockers,
            "pr": pr,
            "prError": session.and_then(|session| session.pr_error.clone()),
            "leftover": session.and_then(|session| session.leftover.clone()),
            "question": question,
            "goalCreation": goal_creation,
            "conversation": conversation_json,
            "activity": activity,
            "notice": inner.restart_notice,
            "history": inner.history,
        })
    }

    /// Sends the complete current Flow state, then the markers and streamed
    /// lines a connecting client needs.
    fn replay_to(&self, target: Option<&Conn>) {
        {
            let mut inner = self.lock();
            if inner.restoring {
                if let Some(target) = target {
                    inner.replay_waiters.push(target.clone());
                }
                return;
            }
            // A server with no Flow work sends nothing: the view already
            // starts empty.
            if inner.session.is_none()
                && inner.goal_creation.is_none()
                && inner.conversation.is_none()
                && inner.implementation.is_none()
            {
                return;
            }
        }

        let deliver = |event: Value| match target {
            Some(conn) => conn.send(event),
            None => self.broadcast(event),
        };

        let snapshot = self.snapshot();
        let frame = match snapshot {
            Value::Object(object) => object,
            _ => Map::new(),
        };
        // `flowSnapshot` names its type first, exactly like the broadcast.
        let ordered = ordered_frame("flowSnapshot", frame);

        let (session, creation, implementation, conversation) = {
            let inner = self.lock();
            (
                inner.session.clone(),
                inner
                    .goal_creation
                    .as_ref()
                    .map(|creation| (creation.activity.clone(), creation.question.clone())),
                inner.implementation.as_ref().map(|implementation| {
                    (
                        implementation.activity.clone(),
                        inner
                            .session
                            .as_ref()
                            .and_then(|session| session.question.clone()),
                    )
                }),
                inner.conversation.as_ref().map(|conversation| {
                    (
                        conversation.widget_id.clone(),
                        conversation.messages.clone(),
                        conversation.activity.clone(),
                        conversation.question.clone(),
                    )
                }),
            )
        };

        deliver(ordered);
        if let Some(session) = session {
            if session.status == "running" {
                deliver(json!({
                    "type": "flowImplementationStarted",
                    "sessionId": session.id,
                    "worktree": session.worktree,
                    "branch": session.branch,
                    "baseRevision": session.base_revision,
                }));
            }
            deliver(json!({"type": "flowFiles", "files": session.files}));
            deliver(json!({"type": "flowWidgets", "widgets": session.widgets}));
            deliver(json!({"type": "flowSteering", "notes": session.steering}));
            deliver(json!({"type": "flowDecisions", "text": session.decisions}));
            deliver(json!({"type": "flowCheckpoints", "checkpoints": session.checkpoints}));
            deliver(json!({"type": "flowVerification", "verification": session.verification}));
            deliver(json!({"type": "flowBlockers", "blockers": session.blockers}));
            deliver(json!({"type": "flowPr", "pr": session.pr}));
        }

        if let Some((activity, question)) = creation {
            deliver(json!({"type": "flowGoalStarted"}));
            for text in activity {
                deliver(json!({"type": "flowActivity", "text": text}));
            }
            if let Some(question) = question {
                deliver(json!({
                    "type": "flowQuestion",
                    "target": "goal",
                    "id": question.id,
                    "message": question.message,
                    "options": question.options,
                }));
            }
        }

        if let Some((activity, question)) = implementation {
            for text in activity {
                deliver(json!({"type": "flowActivity", "text": text}));
            }
            if let Some(question) = question {
                deliver(json!({
                    "type": "flowQuestion",
                    "target": "implementation",
                    "id": question.id,
                    "message": question.message,
                    "options": question.options,
                }));
            }
        }

        if let Some((widget_id, messages, activity, question)) = conversation {
            deliver(json!({"type": "flowConversationStarted", "widgetId": widget_id}));
            for message in messages {
                deliver(json!({
                    "type": "flowConversationMessage",
                    "role": message.role,
                    "text": message.text,
                }));
            }
            for text in activity {
                deliver(json!({"type": "flowConversationActivity", "text": text}));
            }
            if let Some(question) = question {
                deliver(json!({
                    "type": "flowConversationQuestion",
                    "id": question.id,
                    "message": question.message,
                    "options": question.options,
                }));
            }
        }
    }

    fn publish(&self) {
        let allowed = {
            let inner = self.lock();
            !(inner
                .session
                .as_ref()
                .is_some_and(|session| session.cleanup_pending && session.leftover.is_none()))
        };
        if !allowed {
            return;
        }
        let mut frame = match self.snapshot() {
            Value::Object(object) => object,
            _ => Map::new(),
        };
        frame.insert("type".into(), Value::String("flowSnapshot".into()));
        self.broadcast(ordered_frame("flowSnapshot", frame));
    }

    fn emit_sections(&self, files: bool, widgets: bool) {
        let session = self.lock().session.clone();
        let Some(session) = session else {
            return;
        };
        if files {
            self.broadcast(json!({"type": "flowFiles", "files": session.files}));
        }
        if widgets {
            self.broadcast(json!({"type": "flowWidgets", "widgets": session.widgets}));
        }
        self.broadcast(json!({"type": "flowSteering", "notes": session.steering}));
        self.broadcast(json!({"type": "flowDecisions", "text": session.decisions}));
        self.broadcast(json!({"type": "flowCheckpoints", "checkpoints": session.checkpoints}));
        self.broadcast(json!({"type": "flowVerification", "verification": session.verification}));
        self.broadcast(json!({"type": "flowBlockers", "blockers": session.blockers}));
        self.broadcast(json!({"type": "flowPr", "pr": session.pr}));
    }

    // -------------------------------------------------------- persistence

    fn persist(&self) {
        let Some(root) = self.live_flow_root() else {
            return;
        };
        let mut inner = self.lock();
        let Some(session) = inner.session.as_mut() else {
            return;
        };
        session.updated_at = now_iso();
        let file = SessionFile {
            version: 1,
            session,
        };
        let directory = root.join(session.id.clone());
        let path = directory.join("session.json");
        let value = match serde_json::to_value(&file) {
            Ok(value) => value,
            Err(_) => return,
        };
        drop(inner);
        if let Err(error) = write_json(&path, &value) {
            if let Some(app) = self.app() {
                app.shared.journal.write(
                    "server-error",
                    &format!("flow: could not write session state: {error}"),
                    None,
                );
            }
        }
    }

    /// Writes the reviewable artifacts beside the session's machine state.
    fn persist_artifacts(&self) {
        let Some(root) = self.live_flow_root() else {
            return;
        };
        let (directory, session, goal_creation_active, persisted_goal) = {
            let inner = self.lock();
            let Some(session) = inner.session.clone() else {
                return;
            };
            (
                root.join(session.id.clone()),
                session,
                inner.goal_creation.is_some(),
                inner.persisted_goal.clone(),
            )
        };
        let mut next_persisted_goal = persisted_goal.clone();
        if !goal_creation_active && persisted_goal.as_deref() != Some(session.goal.as_str()) {
            if let Err(error) = write_text(&directory.join("goal.md"), &session.goal) {
                self.journal_error(&format!("flow: could not write session files: {error}"));
            } else {
                next_persisted_goal = Some(session.goal.clone());
            }
        }
        if let Err(error) = write_text(&directory.join("decisions.md"), &session.decisions) {
            self.journal_error(&format!("flow: could not write session files: {error}"));
        }
        if let Err(error) = write_json(
            &directory.join("accepted.json"),
            &json!({"signatures": session.accepted}),
        ) {
            self.journal_error(&format!("flow: could not write session files: {error}"));
        }
        if let Err(error) = write_json(
            &directory.join("changes.json"),
            &serde_json::to_value(&session.files).unwrap_or(Value::Array(Vec::new())),
        ) {
            self.journal_error(&format!("flow: could not write session files: {error}"));
        }
        self.lock().persisted_goal = next_persisted_goal;
    }

    fn journal_error(&self, message: &str) {
        if let Some(app) = self.app() {
            app.shared.journal.write("server-error", message, None);
        }
    }

    fn append_steering(&self, note: &FlowSteeringNote) -> Result<(), String> {
        let path = self.path("steering.jsonl")?;
        append_line(&path, &serde_json::to_value(note).unwrap_or(Value::Null))
            .map_err(|error| error.to_string())?;
        if let Some(app) = self.app() {
            let text: String = note.text.chars().take(200).collect();
            app.shared.journal.write(
                "activity",
                &format!("flow steering [{}] {text}", note.source),
                None,
            );
        }
        Ok(())
    }

    fn register_history(&self) {
        let mut inner = self.lock();
        let Some(session) = inner.session.as_ref() else {
            return;
        };
        if session.status != "merged" {
            return;
        }
        let entry = FlowHistoryEntry {
            session_id: session.id.clone(),
            goal: session.goal.clone(),
            pr: session.pr.clone(),
        };
        let mut history = vec![entry];
        history.extend(
            inner
                .history
                .iter()
                .filter(|existing| existing.session_id != session.id)
                .cloned(),
        );
        inner.history = history;
    }

    // ------------------------------------------------------------ restore

    async fn restore(self: &Arc<Self>) {
        {
            let mut inner = self.lock();
            inner.restoring = true;
        }
        self.restore_sessions().await;
        let waiters = {
            let mut inner = self.lock();
            inner.restoring = false;
            let _ = inner.restore_tx.send(true);
            std::mem::take(&mut inner.replay_waiters)
        };
        for waiter in waiters {
            self.replay_to(Some(&waiter));
        }
    }

    async fn restore_sessions(self: &Arc<Self>) {
        let root = self.flow_root();
        let Ok(entries) = std::fs::read_dir(&root) else {
            return;
        };
        let started_at = self.lock().started_at.clone();
        let mut sessions: Vec<(Session, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            let directory = root.join(&id);
            let Some(stored) = read_json(&directory.join("session.json")) else {
                continue;
            };
            if stored.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }
            let Some(session) = parse_session(&stored, &id, &started_at) else {
                continue;
            };
            sessions.push((session, directory));
        }
        if sessions.is_empty() {
            return;
        }
        sessions.sort_by(|left, right| right.0.created_at.cmp(&left.0.created_at));
        // A merge's terminal write makes `pr.state` and `status` agree, so a
        // stored merged request beside any other status can only be an older
        // revision's torn state: finish that merge's cleanup and record it.
        for entry in sessions.iter_mut() {
            let merged_pr = entry.0.pr.as_ref().is_some_and(|pr| pr.state == "merged");
            if !merged_pr || entry.0.status == "merged" {
                continue;
            }
            entry.0.status = "merged".to_string();
            entry.0.question = None;
            entry.0.cleanup_pending = true;
        }
        {
            let mut inner = self.lock();
            inner.history = sessions
                .iter()
                .filter(|entry| entry.0.status == "merged")
                .map(|entry| FlowHistoryEntry {
                    session_id: entry.0.id.clone(),
                    goal: entry.0.goal.clone(),
                    pr: entry.0.pr.clone(),
                })
                .collect();
        }
        for entry in sessions.iter_mut() {
            if !entry.0.cleanup_pending {
                continue;
            }
            let leftover = self.cleanup_after_merge(&entry.0).await;
            entry.0.leftover = leftover.clone();
            entry.0.cleanup_pending = leftover.is_some();
            entry.0.updated_at = now_iso();
            let file = SessionFile {
                version: 1,
                session: &entry.0,
            };
            if let Ok(value) = serde_json::to_value(&file) {
                let _ = write_json(&entry.1.join("session.json"), &value);
            }
        }

        let Some(current) = sessions.iter_mut().find(|entry| entry.0.status != "merged") else {
            return;
        };
        let directory = current.1.clone();
        let session = &mut current.0;

        // The files beside the machine state are authoritative for the text a
        // developer or agent may have appended while the process was down.
        let stored_goal = read_text(&directory.join("goal.md"));
        if let Some(goal) = &stored_goal {
            session.goal = goal.clone();
        }
        session.decisions =
            read_text(&directory.join("decisions.md")).unwrap_or_else(|| session.decisions.clone());
        let acks: HashSet<String> = read_json_lines(&directory.join("steering-ack.jsonl"))
            .into_iter()
            .map(|entry| match entry {
                Value::String(id) => id,
                other => other.get("id").map(js_string_of).unwrap_or_default(),
            })
            .collect();
        for note in session.steering.iter_mut() {
            if acks.contains(&note.id) {
                note.status = "read".to_string();
            }
        }
        if let Some(verification) = read_json(&directory.join("verification.json")) {
            if verification.get("status").and_then(Value::as_str).is_some() {
                if let Ok(parsed) = serde_json::from_value::<FlowVerification>(verification) {
                    session.verification = Some(parsed);
                }
            }
        }
        for entry in read_json_lines(&directory.join("checkpoints.jsonl")) {
            // The agent's own record is authoritative for its commit; only the
            // commit itself is required, exactly as the reference decides.
            let Some(checkpoint) = checkpoint_from_value(&entry) else {
                continue;
            };
            if session
                .checkpoints
                .iter()
                .any(|candidate| candidate.commit == checkpoint.commit)
            {
                continue;
            }
            session.checkpoints.push(checkpoint);
        }

        let was_running = session.status == "running";
        // A detached implementation owner outlives the dashboard. Attaching to
        // it keeps the same run, worktree, and peer; only a run with no live
        // owner stopped.
        let adopted = was_running
            && crate::detached_run::detached_run_live(
                &self.state_dir(),
                &self.repo_dir(),
                "flow-implement",
                &session.id,
                &self.instance(),
            );
        if was_running && !adopted {
            session.status = "stopped".to_string();
        }
        session.question = None;
        let session_snapshot = session.clone();
        let missing_goal = stored_goal.clone();
        {
            let mut inner = self.lock();
            inner.session = Some(session_snapshot.clone());
            inner.persisted_goal = missing_goal;
        }
        self.persist();

        if adopted {
            let activity: Vec<String> = Vec::new();
            let token = next_token();
            {
                let mut inner = self.lock();
                inner.implementation = Some(Implementation {
                    token,
                    activity: activity.clone(),
                    agent: None,
                    finished: false,
                });
            }
            self.broadcast(json!({
                "type": "flowImplementationStarted",
                "sessionId": session_snapshot.id,
                "worktree": session_snapshot.worktree,
                "branch": session_snapshot.branch,
                "baseRevision": session_snapshot.base_revision,
            }));
            self.publish();
            let mode = Arc::clone(self);
            let adopted_session = session_snapshot.clone();
            let directory = directory.clone();
            tokio::spawn(async move {
                mode.run_implementation_peers(adopted_session, token, directory, true)
                    .await;
            });
        }

        if was_running && !adopted {
            let message = "The server restarted, so the Flow implementation stopped. Start it again to resume.";
            self.lock().restart_notice = Some(message.to_string());
            self.notice(message);
        }

        // Widgets are recomputed from the worktree without spawning a peer.
        let worktree = PathBuf::from(&session_snapshot.worktree);
        if worktree.exists() {
            if let Some(files) = self.compute_diff(&session_snapshot).await {
                let raw = read_json(&directory.join("widgets.json"))
                    .and_then(|value| value.get("widgets").cloned())
                    .filter(Value::is_array)
                    .and_then(|value| serde_json::from_value::<Vec<RawWidget>>(value).ok())
                    .unwrap_or_else(|| widgets_as_raw(&session_snapshot.widgets));
                let mut inner = self.lock();
                let Some(session) = inner
                    .session
                    .as_mut()
                    .filter(|s| s.id == session_snapshot.id)
                else {
                    return;
                };
                session.files = files.clone();
                session.widgets = reconcile(&raw, &files, session);
                session.last_diff_hash = Some(diff_hash(&files));
                drop(inner);
                self.persist();
                self.persist_artifacts();
            }
        }
        self.publish();
        self.emit_sections(true, true);
        self.lock().quiet = true;
        let merged = self
            .lock()
            .session
            .as_ref()
            .is_some_and(|session| session.status == "merged");
        if !merged {
            self.start_watchdog();
        }
    }

    // ----------------------------------------------------------- commands

    async fn create_goal(self: &Arc<Self>) {
        if self.refuse_checkout_blocked("start") {
            return;
        }
        {
            let inner = self.lock();
            if inner.implementation.is_some() {
                drop(inner);
                self.error(
                    "The Flow implementation is running. Stop it before creating a new goal.",
                );
                return;
            }
            if inner.goal_creation.is_some() {
                drop(inner);
                self.error("A Flow goal creation is already active.");
                return;
            }
        }

        let (previous, persisted_goal, goal_text, session_created) = {
            let inner = self.lock();
            let previous = inner.session.clone();
            let persisted = inner.persisted_goal.clone();
            let goal_text = previous
                .as_ref()
                .and_then(|session| read_text(&self.flow_root().join(&session.id).join("goal.md")));
            let created = previous
                .as_ref()
                .is_none_or(|session| session.status == "merged");
            (previous, persisted, goal_text, created)
        };
        let restore = GoalCreationRestore {
            session: previous,
            persisted_goal,
            goal_text,
            session_created,
        };

        if restore.session_created {
            self.new_session();
            if self.lock().session.is_none() {
                return;
            }
        }

        let token = next_token();
        {
            let mut inner = self.lock();
            inner.persisted_goal = None;
            inner.goal_creation = Some(GoalCreation {
                token,
                activity: Vec::new(),
                question: None,
                agent: None,
                restore,
            });
        }
        self.broadcast(json!({"type": "flowGoalStarted"}));
        self.publish();
        self.spawn_goal_creation(token);
    }

    fn new_session(&self) {
        let Some(root) = self.live_flow_root() else {
            return;
        };
        if std::fs::create_dir_all(&root).is_err() {
            return;
        }
        let mut id = session_id();
        while root.join(&id).exists() {
            id = session_id();
        }
        let directory = root.join(&id);
        if std::fs::create_dir_all(&directory).is_err() {
            return;
        }
        let now = now_iso();
        let session = Session {
            id: id.clone(),
            base_revision: None,
            worktree: self.worktree_path(&id).to_string_lossy().into_owned(),
            branch: format!("flow/{id}"),
            status: "idle".to_string(),
            goal: String::new(),
            decisions: String::new(),
            steering: Vec::new(),
            accepted: Vec::new(),
            widgets: Vec::new(),
            files: Vec::new(),
            checkpoints: Vec::new(),
            verification: None,
            blockers: Vec::new(),
            pr: None,
            pr_error: None,
            leftover: None,
            cleanup_pending: false,
            question: None,
            pushed_tip: None,
            pr_failed_tip: None,
            last_diff_hash: None,
            created_at: now.clone(),
            updated_at: now,
        };
        {
            let mut inner = self.lock();
            inner.session = Some(session);
            inner.persisted_goal = None;
        }
        self.persist();
        self.persist_artifacts();
    }

    fn cancel_goal(&self) {
        let (creation, current) = {
            let mut inner = self.lock();
            let Some(creation) = inner.goal_creation.take() else {
                drop(inner);
                self.error("No Flow goal interview is active.");
                return;
            };
            (creation, inner.session.clone())
        };
        let restore = creation.restore.clone();
        if let Some(agent) = &creation.agent {
            agent.close();
        }
        self.restore_canceled_goal(&restore, current.as_ref());
        self.broadcast(json!({"type": "flowGoalStopped", "completed": false}));
        self.publish();
    }

    fn restore_canceled_goal(&self, restore: &GoalCreationRestore, current: Option<&Session>) {
        if restore.session_created {
            if let Some(current) = current {
                let directory = self.flow_root().join(&current.id);
                // A canceled interview never reached implementation, so an
                // idle session with no worktree, pull request, or checkpoint is
                // the only directory this path may remove.
                let untouched = current.status == "idle"
                    && current.pr.is_none()
                    && current.checkpoints.is_empty()
                    && !Path::new(&current.worktree).exists();
                if !untouched {
                    self.journal_error(&format!(
                        "flow: canceled goal interview left {} because it holds work",
                        directory.display()
                    ));
                    return;
                }
                if let Err(error) = std::fs::remove_dir_all(&directory) {
                    self.journal_error(&format!(
                        "flow: could not remove {}: {error}",
                        directory.display()
                    ));
                    return;
                }
            }
        }
        {
            let mut inner = self.lock();
            inner.session = restore.session.clone();
            inner.persisted_goal = restore.persisted_goal.clone();
        }
        let Some(session) = &restore.session else {
            return;
        };
        if restore.session_created {
            return;
        }
        let goal_path = self.flow_root().join(&session.id).join("goal.md");
        let result = match &restore.goal_text {
            // The interview unlinked goal.md and may have written a draft into
            // it; the accepted goal file returns byte for byte.
            None => std::fs::remove_file(&goal_path),
            Some(text) => write_text(&goal_path, text),
        };
        if let Err(error) = result {
            self.journal_error(&format!(
                "flow: could not restore {}: {error}",
                goal_path.display()
            ));
        }
    }

    async fn run_goal_creation(self: &Arc<Self>, token: u64) {
        let Some(directory) = self.session_dir() else {
            return;
        };
        // Drop the previous interview's goal first: only a file this turn
        // writes may be accepted, never a draft an interrupted peer or an
        // earlier interview left behind.
        let goal_path = directory.join("goal.md");
        let _ = std::fs::remove_file(&goal_path);

        let environment = match self.peer_environment().await {
            Ok(environment) => environment,
            Err(message) => {
                if self.goal_creation_current(token) {
                    self.error(&message);
                    self.finish_goal_creation(false);
                }
                return;
            }
        };
        // A disposal during provider selection clears the interview; no peer
        // may be constructed for an owner that is gone.
        if !self.goal_creation_current(token) {
            return;
        }
        let repo_dir = self.repo_dir();
        let command = match self.agent_command() {
            Some(command) => command,
            None => return,
        };
        let mode = Arc::clone(self);
        let on_activity: crate::detached_run::ActivityCallback =
            Arc::new(move |activity: crate::acp::AcpActivity| {
                let append = {
                    let mut inner = mode.lock();
                    let Some(creation) = inner.goal_creation.as_mut() else {
                        return;
                    };
                    if creation.token != token {
                        return;
                    }
                    let append = activity.append && !creation.activity.is_empty();
                    if append {
                        if let Some(last) = creation.activity.last_mut() {
                            last.push_str(&activity.text);
                        }
                    } else {
                        creation.activity.push(activity.text.clone());
                    }
                    append
                };
                mode.broadcast(json!({
                    "type": "flowActivity",
                    "text": activity.text,
                    "append": append,
                }));
            });
        let question_mode = Arc::clone(self);
        let on_question: crate::detached_run::QuestionCallback =
            Arc::new(move |question: AcpQuestion| {
                let accepted = {
                    let mut inner = question_mode.lock();
                    let Some(creation) = inner.goal_creation.as_mut() else {
                        return;
                    };
                    if creation.token != token {
                        return;
                    }
                    creation.question = Some(flow_question(&question));
                    true
                };
                if accepted {
                    if let Some(app) = question_mode.app() {
                        app.shared
                            .journal
                            .write("question", &question.message, Some("flow:goal"));
                    }
                    question_mode.broadcast(json!({
                        "type": "flowQuestion",
                        "target": "goal",
                        "id": question.id,
                        "message": question.message,
                        "options": question.options,
                    }));
                }
            });
        let stderr_mode = Arc::clone(self);
        let on_stderr: crate::detached_run::StderrCallback = Arc::new(move |text: String| {
            if let Some(app) = stderr_mode.app() {
                app.shared.journal.write("acp-stderr", &text, None);
            }
        });
        let skip_activity = self
            .lock()
            .goal_creation
            .as_ref()
            .filter(|creation| creation.token == token)
            .map(|creation| creation.activity.len())
            .unwrap_or(0);
        let mut options = DetachedPeerOptions::new(
            repo_dir.clone(),
            self.state_dir(),
            "flow-goal",
            "goal",
            self.instance(),
            command,
            repo_dir.to_string_lossy().into_owned(),
        )
        .env(environment)
        .skip_activity(skip_activity)
        .activity(on_activity)
        .question(on_question)
        .stderr(on_stderr);
        options.harness_version = self.harness_version();
        let agent = DetachedPeer::new(options);
        {
            let mut inner = self.lock();
            match inner.goal_creation.as_mut() {
                Some(creation) if creation.token == token => {
                    creation.agent = Some(Arc::clone(&agent));
                }
                _ => {
                    drop(inner);
                    agent.close();
                    return;
                }
            }
        }

        // The interview runs until the agent finishes, fails, or the operator
        // cancels it; no wall-clock limit ends it.
        let prompt = format!("/flow-goal {}", directory.display());
        let outcome = agent.run(&prompt).await;
        if !self.goal_creation_current(token) {
            return;
        }
        match outcome {
            Ok(DetachedRunOutcome::Completed) => self.finish_goal_creation(true),
            Ok(DetachedRunOutcome::Preserved) => {}
            Ok(DetachedRunOutcome::Attached) | Ok(DetachedRunOutcome::Stopped) => {
                self.finish_goal_creation(false);
            }
            Err(error) => {
                self.error(&error);
                self.finish_goal_creation(false);
            }
        }
    }

    fn goal_creation_current(&self, token: u64) -> bool {
        self.lock()
            .goal_creation
            .as_ref()
            .is_some_and(|creation| creation.token == token)
    }

    fn finish_goal_creation(&self, read_file: bool) {
        let (creation, session) = {
            let mut inner = self.lock();
            let Some(creation) = inner.goal_creation.take() else {
                return;
            };
            let Some(session) = inner.session.clone() else {
                return;
            };
            (creation, session)
        };
        if let Some(agent) = &creation.agent {
            agent.close();
        }
        let goal_path = self.flow_root().join(&session.id).join("goal.md");
        let text = if read_file {
            read_text(&goal_path)
        } else {
            None
        };
        let accepted = text.filter(|text| !text.trim().is_empty());
        let Some(text) = accepted else {
            if read_file {
                self.error("The Flow goal interview wrote no goal.");
            }
            // A failed or interrupted interview must not leave its truncated
            // draft where the session's accepted goal belongs.
            self.persist_artifacts();
            self.broadcast(json!({"type": "flowGoalStopped", "completed": false}));
            self.publish();
            return;
        };
        {
            let mut inner = self.lock();
            let Some(session) = inner.session.as_mut() else {
                return;
            };
            session.goal = text.clone();
        }
        self.persist();
        self.persist_artifacts();
        self.broadcast(json!({"type": "flowGoalStopped", "completed": true, "text": text}));
        self.publish();
    }

    async fn start_implementation(self: &Arc<Self>) {
        if self.refuse_checkout_blocked("start") {
            return;
        }
        let (token, session) = {
            let mut inner = self.lock();
            let Some(session) = inner.session.clone() else {
                drop(inner);
                self.error("Create a Flow goal before starting the implementation.");
                return;
            };
            if session.status == "merged"
                || session.pr.as_ref().is_some_and(|pr| pr.state == "merged")
            {
                let merged_pr = session.pr.as_ref().filter(|pr| pr.state == "merged");
                let message = match merged_pr {
                    None => "This Flow session is merged. Create a new Flow goal to start again.".to_string(),
                    Some(pr) => format!(
                        "The pull request #{} ({}) is already merged, so this Flow session cannot start again. Create a new Flow goal.",
                        pr.number, pr.url
                    ),
                };
                drop(inner);
                self.error(&message);
                return;
            }
            if inner.goal_creation.is_some() {
                drop(inner);
                self.error("The Flow goal interview is active.");
                return;
            }
            if session.goal.trim().is_empty() {
                drop(inner);
                self.error("The Flow goal is empty.");
                return;
            }
            if inner.implementation.is_some() {
                drop(inner);
                self.error("The Flow implementation is already running.");
                return;
            }
            // Claim the slot before the first await. The base fetch and the
            // worktree check are asynchronous, and a second Start that lands
            // inside them would otherwise pass the guard and spawn a second
            // peer in the same worktree.
            let token = next_token();
            inner.implementation = Some(Implementation {
                token,
                activity: Vec::new(),
                agent: None,
                finished: false,
            });
            (token, session)
        };
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            mode.run_start_implementation(token, session).await;
        });
    }

    async fn run_start_implementation(self: Arc<Self>, token: u64, mut session: Session) {
        let base = self.resolve_base().await;
        let Some(base) = base else {
            {
                let mut inner = self.lock();
                if inner
                    .implementation
                    .as_ref()
                    .is_some_and(|implementation| implementation.token == token)
                {
                    inner.implementation = None;
                }
            }
            self.error(
                "Could not start the Flow implementation: neither origin/main nor main exists.",
            );
            return;
        };
        if session.base_revision.is_none() {
            session.base_revision = Some(base.clone());
        }
        let created = self.ensure_worktree(&session, &base).await;
        if !created {
            let mut inner = self.lock();
            if inner
                .implementation
                .as_ref()
                .is_some_and(|implementation| implementation.token == token)
            {
                inner.implementation = None;
            }
            drop(inner);
            return;
        }
        // Stop or dispose released the claim while the worktree was being
        // prepared; no peer may start without holding the slot.
        let still_claimed = {
            let mut inner = self.lock();
            if inner
                .implementation
                .as_ref()
                .is_none_or(|implementation| implementation.token != token)
            {
                false
            } else {
                let Some(current) = inner
                    .session
                    .as_mut()
                    .filter(|current| current.id == session.id)
                else {
                    return;
                };
                current.base_revision = session.base_revision.clone();
                current.status = "running".to_string();
                session.status = "running".to_string();
                inner.quiet = false;
                inner.restart_notice = None;
                true
            }
        };
        if !still_claimed {
            return;
        }
        self.persist();
        self.broadcast(json!({
            "type": "flowImplementationStarted",
            "sessionId": session.id,
            "worktree": session.worktree,
            "branch": session.branch,
            "baseRevision": session.base_revision,
        }));
        self.publish();
        self.start_watchdog();
        {
            let mode = Arc::clone(&self);
            tokio::spawn(async move {
                mode.tick().await;
            });
        }
        let Some(directory) = self.session_dir() else {
            return;
        };
        let mode = Arc::clone(&self);
        tokio::spawn(async move {
            mode.run_implementation_peers(session, token, directory, false)
                .await;
        });
    }

    async fn run_implementation_peers(
        self: &Arc<Self>,
        session: Session,
        token: u64,
        directory: PathBuf,
        attach: bool,
    ) {
        let environment = match self.peer_environment().await {
            Ok(environment) => environment,
            Err(message) => {
                if self.implementation_current(token) {
                    self.error(&message);
                    self.finish_implementation();
                }
                return;
            }
        };
        if !self.implementation_current(token) {
            return;
        }
        let Some(command) = self.agent_command() else {
            return;
        };
        let mode = Arc::clone(self);
        let on_activity: crate::detached_run::ActivityCallback =
            Arc::new(move |activity: crate::acp::AcpActivity| {
                let (append, markers) = {
                    let mut inner = mode.lock();
                    let Some(implementation) = inner.implementation.as_mut() else {
                        return;
                    };
                    if implementation.token != token {
                        return;
                    }
                    let append = activity.append && !implementation.activity.is_empty();
                    if append {
                        if let Some(last) = implementation.activity.last_mut() {
                            last.push_str(&activity.text);
                        }
                    } else {
                        implementation.activity.push(activity.text.clone());
                    }
                    let mut markers: Vec<String> = Vec::new();
                    if activity.text.contains(BLOCKER_MARKER) {
                        for line in implementation.activity.iter() {
                            if let Some(index) = line.find(BLOCKER_MARKER) {
                                markers
                                    .push(line[index + BLOCKER_MARKER.len()..].trim().to_string());
                            }
                        }
                    }
                    (append, markers)
                };
                mode.broadcast(json!({
                    "type": "flowActivity",
                    "text": activity.text,
                    "append": append,
                }));
                for marker in markers {
                    mode.add_blocker(&marker);
                }
            });
        let question_mode = Arc::clone(self);
        let on_question: crate::detached_run::QuestionCallback =
            Arc::new(move |question: AcpQuestion| {
                let accepted = {
                    let mut inner = question_mode.lock();
                    let Some(implementation) = inner.implementation.as_ref() else {
                        return;
                    };
                    if implementation.token != token {
                        return;
                    }
                    let Some(session) = inner.session.as_mut() else {
                        return;
                    };
                    session.question = Some(flow_question(&question));
                    true
                };
                if accepted {
                    question_mode.persist();
                    question_mode.broadcast(json!({
                        "type": "flowQuestion",
                        "target": "implementation",
                        "id": question.id,
                        "message": question.message,
                        "options": question.options,
                    }));
                }
            });
        let stderr_mode = Arc::clone(self);
        let on_stderr: crate::detached_run::StderrCallback = Arc::new(move |text: String| {
            if let Some(app) = stderr_mode.app() {
                app.shared.journal.write("acp-stderr", &text, None);
            }
        });
        let skip_activity = self
            .lock()
            .implementation
            .as_ref()
            .filter(|implementation| implementation.token == token)
            .map(|implementation| implementation.activity.len())
            .unwrap_or(0);
        let mut options = DetachedPeerOptions::new(
            self.repo_dir(),
            self.state_dir(),
            "flow-implement",
            session.id.clone(),
            self.instance(),
            command,
            session.worktree.clone(),
        )
        .env(environment)
        .skip_activity(skip_activity)
        .attach_only(attach)
        .activity(on_activity)
        .question(on_question)
        .stderr(on_stderr);
        options.harness_version = self.harness_version();
        let agent = DetachedPeer::new(options);
        let attached_question = if attach {
            agent.state().and_then(|state| state.question)
        } else {
            None
        };
        {
            let mut inner = self.lock();
            if let Some(question) = attached_question {
                if let Some(session) = inner.session.as_mut() {
                    session.question = Some(flow_question(&question));
                }
            }
            match inner.implementation.as_mut() {
                Some(implementation) if implementation.token == token => {
                    implementation.agent = Some(Arc::clone(&agent));
                }
                _ => {
                    drop(inner);
                    agent.close();
                    return;
                }
            }
        }
        if attach {
            self.persist();
        }

        let prompt = if attach {
            String::new()
        } else {
            format!("/flow-implement {}", directory.display())
        };
        let outcome = agent.run(&prompt).await;
        if !self.implementation_current(token) {
            agent.close();
            return;
        }
        match outcome {
            Ok(DetachedRunOutcome::Completed) => {
                if let Some(implementation) = self.lock().implementation.as_mut() {
                    implementation.finished = true;
                }
                self.finish_implementation();
            }
            Ok(DetachedRunOutcome::Preserved) => {}
            Ok(DetachedRunOutcome::Attached) | Ok(DetachedRunOutcome::Stopped) => {
                self.finish_implementation();
            }
            Err(error) => {
                self.error(&error);
                self.finish_implementation();
            }
        }
    }

    fn implementation_current(&self, token: u64) -> bool {
        self.lock()
            .implementation
            .as_ref()
            .is_some_and(|implementation| implementation.token == token)
    }

    fn finish_implementation(self: &Arc<Self>) {
        let mut inner = self.lock();
        let Some(implementation) = inner.implementation.take() else {
            return;
        };
        if let Some(agent) = &implementation.agent {
            agent.close();
        }
        let changed = if let Some(session) = inner.session.as_mut() {
            if session.status == "running" {
                session.status = "stopped".to_string();
                session.question = None;
                session.updated_at = now_iso();
                true
            } else {
                false
            }
        } else {
            false
        };
        drop(inner);
        if changed {
            self.persist();
        }
        self.broadcast(json!({"type": "flowStopped"}));
        self.publish();
        // The change set is complete, so its review list is classified now,
        // before a page can accept a widget the next analysis would rename.
        self.schedule_analysis();
        self.spawn_tick();
    }

    fn spawn_tick(self: &Arc<Self>) {
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            mode.tick().await;
        });
    }

    fn stop_implementation(self: &Arc<Self>) {
        if self.lock().implementation.is_none() {
            self.error("The Flow implementation is not running.");
            return;
        }
        self.finish_implementation();
    }

    // ------------------------------------------------------------ worktree

    async fn git(&self, cwd: &Path, args: &[&str]) -> GitResult {
        run_git(cwd, args, &git_env(), COMMAND_TIMEOUT_MS).await
    }

    async fn resolve_base(&self) -> Option<String> {
        let repo = self.repo_dir();
        let _ = self.git(&repo, &["fetch", "origin", "main"]).await;
        for reference in ["origin/main", "main"] {
            let verify = format!("{reference}^{{commit}}");
            let result = self.git(&repo, &["rev-parse", "--verify", &verify]).await;
            let revision = result.stdout.trim().to_string();
            if result.code == 0 && !revision.is_empty() {
                return Some(revision);
            }
        }
        None
    }

    async fn ensure_worktree(&self, session: &Session, base: &str) -> bool {
        let repo = self.repo_dir();
        if Path::new(&session.worktree).exists() {
            let inside = self
                .git(
                    Path::new(&session.worktree),
                    &["rev-parse", "--show-toplevel"],
                )
                .await;
            if inside.code == 0 {
                return true;
            }
        }
        let _ = std::fs::create_dir_all(repo.join(".worktree"));
        let branch_ref = format!("refs/heads/{}", session.branch);
        let branch = self
            .git(&repo, &["rev-parse", "--verify", &branch_ref])
            .await;
        let added = if branch.code == 0 {
            self.git(
                &repo,
                &["worktree", "add", &session.worktree, &session.branch],
            )
            .await
        } else {
            self.git(
                &repo,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &session.branch,
                    &session.worktree,
                    base,
                ],
            )
            .await
        };
        if added.code != 0 {
            let detail = added.stderr.trim();
            let detail = if detail.is_empty() {
                format!("exit code {}", added.code)
            } else {
                detail.to_string()
            };
            self.error(&format!("Could not create the Flow worktree: {detail}"));
            return false;
        }
        true
    }

    async fn is_clean(&self, worktree: &str) -> bool {
        let result = self
            .git(Path::new(worktree), &["status", "--porcelain"])
            .await;
        if result.code != 0 {
            return false;
        }
        result.stdout.trim().is_empty()
    }

    // ------------------------------------------------------------- watcher

    fn start_watchdog(self: &Arc<Self>) {
        let watch_ms = self.watch_ms();
        let mut inner = self.lock();
        if inner.timer.is_some() || inner.disposed {
            return;
        }
        let mode = Arc::clone(self);
        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(watch_ms));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // `setInterval` waits one period before its first tick.
            interval.tick().await;
            loop {
                interval.tick().await;
                if mode.lock().disposed || mode.lock().timer.is_none() {
                    break;
                }
                mode.tick().await;
            }
        });
        inner.timer = Some(handle.abort_handle());
    }

    fn stop_watchdog(&self) {
        let mut inner = self.lock();
        if let Some(timer) = inner.timer.take() {
            timer.abort();
        }
    }

    async fn tick(self: &Arc<Self>) {
        {
            let mut inner = self.lock();
            if inner.disposed {
                return;
            }
            if inner.ticking {
                inner.tick_queued = true;
                return;
            }
            inner.ticking = true;
        }
        loop {
            self.tick_once().await;
            let queued = {
                let mut inner = self.lock();
                if inner.tick_queued {
                    inner.tick_queued = false;
                    true
                } else {
                    inner.ticking = false;
                    false
                }
            };
            if !queued {
                break;
            }
        }
    }

    async fn tick_once(self: &Arc<Self>) {
        let session = {
            let inner = self.lock();
            if inner.disposed {
                return;
            }
            match inner.session.clone() {
                Some(session) => session,
                None => {
                    drop(inner);
                    self.stop_watchdog();
                    return;
                }
            }
        };
        if session.status == "merged" {
            self.stop_watchdog();
            return;
        }
        if !Path::new(&session.worktree).exists() {
            return;
        }

        self.sync_checkpoints(&session).await;
        let Some(files) = self.compute_diff(&session).await else {
            return;
        };
        let hash = diff_hash(&files);
        let changed = session.last_diff_hash.as_deref() != Some(hash.as_str());
        let (files_changed, widgets_cleared) = {
            let mut inner = self.lock();
            let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == session.id)
            else {
                return;
            };
            current.files = files.clone();
            let mut widgets_cleared = false;
            if changed && files.is_empty() {
                current.widgets = Vec::new();
                current.accepted = Vec::new();
                widgets_cleared = true;
            }
            if changed {
                current.last_diff_hash = Some(hash.clone());
            }
            (changed, widgets_cleared)
        };
        if widgets_cleared {
            self.broadcast(json!({"type": "flowWidgets", "widgets": []}));
        }
        if files_changed {
            self.persist();
            self.broadcast(json!({"type": "flowFiles", "files": files}));
        }
        self.persist_artifacts();
        if files_changed && !files.is_empty() {
            let quiet = self.lock().quiet;
            if quiet {
                // A restored session recomputes its review list without
                // spawning a peer; the analyst runs again only after the
                // implementation starts. A review list the analyst already
                // produced stays: a tick that lands just after the final
                // checkpoint replays the same change set, and replacing the
                // widgets the page is reviewing would rename the ids under an
                // accepted widget, an open conversation, or a conclusion.
                let widgets = {
                    let mut inner = self.lock();
                    let Some(current) = inner
                        .session
                        .as_mut()
                        .filter(|current| current.id == session.id)
                    else {
                        return;
                    };
                    if current.widgets.is_empty() {
                        current.widgets = reconcile(&[], &files, current);
                    }
                    let widgets = current.widgets.clone();
                    current
                        .accepted
                        .retain(|signature| widgets.iter().any(|widget| &widget.id == signature));
                    widgets
                };
                self.persist();
                self.persist_artifacts();
                self.broadcast(json!({"type": "flowWidgets", "widgets": widgets}));
            } else if self
                .lock()
                .session
                .as_ref()
                .is_some_and(|current| current.status != "running")
            {
                // While the implementation keeps writing the change set, each
                // analysis would name a different diff and its ids would churn
                // under a page already reviewing them. The review list is
                // classified once the peer stops, over the completed diff.
                self.schedule_analysis();
            }
        }
        self.sync_steering_acks();
        self.sync_verification();
        self.sync_blockers();
        if files_changed {
            self.publish();
        }
    }

    async fn compute_diff(&self, session: &Session) -> Option<Vec<FlowFile>> {
        let base = session.base_revision.clone()?;
        let worktree = Path::new(&session.worktree);
        let tracked = self
            .git(
                worktree,
                &["diff", "--no-color", "--no-ext-diff", &base, "--"],
            )
            .await;
        if tracked.code != 0 {
            return None;
        }
        let status = self
            .git(
                worktree,
                &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            )
            .await;
        if status.code != 0 {
            return None;
        }

        let mut files: Vec<FlowFile> = diff_files(&tracked.stdout);
        let mut by_path: HashMap<String, usize> = HashMap::new();
        for (index, file) in files.iter().enumerate() {
            by_path.insert(file.path.clone(), index);
        }
        for (status, path) in parse_status_z(&status.stdout) {
            if status == "untracked" {
                if by_path.contains_key(&path) {
                    continue;
                }
                let Some(file) = untracked_file(worktree, &path) else {
                    continue;
                };
                by_path.insert(path.clone(), files.len());
                files.push(file);
                continue;
            }
            let Some(index) = by_path.get(&path).copied() else {
                continue;
            };
            if matches!(status.as_str(), "added" | "deleted" | "renamed") {
                files[index].status = status;
            }
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Some(files)
    }

    fn schedule_analysis(self: &Arc<Self>) {
        let mut inner = self.lock();
        if inner.analyst_pending {
            return;
        }
        if inner.analyst.is_some() {
            inner.analyst_pending = true;
            return;
        }
        drop(inner);
        self.start_analyst();
    }

    fn start_analyst(self: &Arc<Self>) {
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(message) = mode.run_analyst().await {
                mode.journal_error(&format!("flow analyst failed: {message}"));
            }
        });
    }

    async fn run_analyst(self: &Arc<Self>) -> Result<(), String> {
        let (session, directory) = {
            let inner = self.lock();
            let Some(session) = inner.session.clone() else {
                return Ok(());
            };
            let directory = self.flow_root().join(&session.id);
            (session, directory)
        };
        let files = session.files.clone();
        if files.is_empty() {
            return Ok(());
        }

        let request = json!({
            "goal": session.goal,
            "decisions": session.decisions,
            "files": files.iter().map(|file| json!({
                "path": file.path,
                "status": file.status,
                "insertions": file.insertions,
                "deletions": file.deletions,
                "diff": file.diff,
            })).collect::<Vec<_>>(),
            "previous": session.widgets,
        });
        // Every file this turn reads and writes belongs to the session captured
        // at entry. A merge followed by createGoal replaces the session while
        // the turn is live; `path()` would then address the replacement.
        let request_path = directory.join("request.json");
        let widgets_path = directory.join("widgets.json");
        let _ = write_json(&request_path, &request);
        // A stale result must never be mistaken for this run's answer.
        let _ = std::fs::write(&widgets_path, "");

        let mut context_parts: Vec<String> = vec![
            "Session goal:".to_string(),
            session.goal.clone(),
            String::new(),
            "Decision board:".to_string(),
            session.decisions.clone(),
            String::new(),
            "Previous widget list:".to_string(),
            crate::jsjson::stringify(
                &serde_json::to_value(&session.widgets).unwrap_or(Value::Null),
            ),
            String::new(),
            "Current diff:".to_string(),
        ];
        for file in files.iter() {
            context_parts.push(
                [
                    format!(
                        "--- {} ({}, +{} -{}) ---",
                        file.path, file.status, file.insertions, file.deletions
                    ),
                    file.diff.clone(),
                ]
                .join("\n"),
            );
        }
        context_parts.push(String::new());
        context_parts
            .push("The same data is in request.json in the session directory.".to_string());
        context_parts.push(
            "Register the complete widget list with the flow_widgets_register MCP tool, using this session directory and the complete widgets array."
                .to_string(),
        );
        let context = context_parts.join("\n");

        let started = std::time::Instant::now();
        let mut binding_failure: Option<String> = None;
        let environment = self.peer_environment().await;
        let token = next_token();
        let mut agent: Option<Arc<AcpConnection>> = None;
        match environment {
            Err(message) => binding_failure = Some(message),
            Ok(environment) => {
                if !self.lock().disposed {
                    if let Some(command) = self.agent_command() {
                        let options = AcpConnectionOptions::new(
                            command,
                            self.repo_dir().to_string_lossy().into_owned(),
                        )
                        .with_starter("Flow")
                        .with_env(environment);
                        match AcpConnection::connect(options).await {
                            Ok((connection, events)) => {
                                let connection = Arc::new(connection);
                                agent = Some(Arc::clone(&connection));
                                self.lock().analyst = Some(Analyst {
                                    token,
                                    agent: Some(Arc::clone(&connection)),
                                });
                                self.spawn_analyst_events(Arc::clone(&connection), events);
                            }
                            Err(error) => binding_failure = Some(error.to_string()),
                        }
                    }
                }
            }
        }
        if let Some(agent) = &agent {
            let prompt = format!("/flow-change {}\n\n{}", directory.display(), context);
            let timeout = Duration::from_millis(self.analyst_timeout_ms());
            match tokio::time::timeout(timeout, agent.run(&prompt)).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    if !self.lock().disposed {
                        self.journal_error(&format!("flow analyst failed: {error}"));
                    }
                }
                Err(_) => {}
            }
            agent.close();
        }
        {
            let mut inner = self.lock();
            if inner
                .analyst
                .as_ref()
                .is_some_and(|analyst| analyst.token == token)
            {
                inner.analyst = None;
            }
        }

        let elapsed = started.elapsed().as_millis() as u64;
        let timed_out = elapsed >= self.analyst_timeout_ms().saturating_sub(5);
        let answer = read_json(&widgets_path);
        let raw = answer
            .as_ref()
            .and_then(|value| value.get("widgets"))
            .filter(|value| value.is_array())
            .and_then(|value| serde_json::from_value::<Vec<RawWidget>>(value.clone()).ok());
        let same_session = {
            let inner = self.lock();
            inner
                .session
                .as_ref()
                .is_some_and(|current| current.id == session.id)
        };
        if !same_session {
            // The turn outlived its session. Its answer belongs to the session
            // it analyzed, so persisting or broadcasting it would attach stale
            // widgets to the replacement. The pending tick, if any, now belongs
            // to the new session and gets its own turn.
            if self.lock().analyst_pending {
                self.lock().analyst_pending = false;
                self.start_analyst();
            }
            return Ok(());
        }
        // The implementation kept committing while the analyst ran, so this
        // answer may describe a diff the session no longer carries. Applying
        // it would rename the widgets the page is reviewing under an accepted
        // widget, an open conversation, or a conclusion; analyze the current
        // diff instead. The worktree itself is read, not the last recorded
        // hash: a commit the watchdog has not seen yet is still a stale answer.
        let analyzed_hash = diff_hash(&files);
        let fresh = self.compute_diff(&session).await;
        let stale_diff = fresh
            .as_ref()
            .is_some_and(|fresh| diff_hash(fresh) != analyzed_hash);
        if stale_diff {
            // Record the newer diff so the retry analyzes it instead of
            // spinning on the snapshot this turn captured.
            let fresh = fresh.unwrap_or_default();
            let fresh_hash = diff_hash(&fresh);
            let retry = {
                let mut inner = self.lock();
                if let Some(current) = inner
                    .session
                    .as_mut()
                    .filter(|current| current.id == session.id)
                {
                    current.files = fresh;
                    current.last_diff_hash = Some(fresh_hash);
                }
                let pending = inner.analyst_pending;
                inner.analyst_pending = false;
                !pending
            };
            if retry {
                self.start_analyst();
            }
            return Ok(());
        }
        let validated = match raw.as_ref() {
            None => None,
            Some(raw) => validate_widgets(raw, &files),
        };
        if validated.is_none() {
            let message = match (&binding_failure, timed_out) {
                (Some(binding), _) => format!(
                    "The Flow analyst could not start: {binding}. Every changed file is shown as a structure change."
                ),
                (None, true) => "The Flow analyst timed out; every changed file is shown as a structure change.".to_string(),
                (None, false) => "The Flow analyst returned no valid widget list; every changed file is shown as a structure change.".to_string(),
            };
            self.error(&message);
        }
        let raw_widgets = match &validated {
            Some(validated) => validated.clone(),
            None => Vec::new(),
        };
        let widgets = {
            let mut inner = self.lock();
            let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == session.id)
            else {
                return Ok(());
            };
            current.widgets = reconcile(&raw_widgets, &files, current);
            let widgets = current.widgets.clone();
            current
                .accepted
                .retain(|signature| widgets.iter().any(|widget| &widget.id == signature));
            widgets
        };
        let _ = write_json(&widgets_path, &json!({"widgets": widgets_as_raw(&widgets)}));
        self.persist();
        self.persist_artifacts();
        self.broadcast(json!({"type": "flowWidgets", "widgets": widgets}));
        self.publish();

        let pending = {
            let mut inner = self.lock();
            let pending = inner.analyst_pending;
            if pending {
                inner.analyst_pending = false;
            }
            pending
        };
        if pending {
            self.start_analyst();
        }
        Ok(())
    }

    fn spawn_analyst_events(
        self: &Arc<Self>,
        agent: Arc<AcpConnection>,
        mut events: mpsc::UnboundedReceiver<AcpEvent>,
    ) {
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    AcpEvent::Question(question) => {
                        let label = question
                            .options
                            .first()
                            .map(|option| option.label.clone())
                            .unwrap_or_else(|| "Continue".to_string());
                        let _ = agent.answer(&question.id, &label).await;
                    }
                    AcpEvent::Stderr(text) => {
                        if let Some(app) = mode.app() {
                            app.shared.journal.write("acp-stderr", &text, None);
                        }
                    }
                    _ => {}
                }
            }
        });
    }

    // --------------------------------------------------------- checkpoints

    async fn sync_checkpoints(&self, session: &Session) {
        let Some(base) = session.base_revision.clone() else {
            return;
        };
        let worktree = Path::new(&session.worktree);
        let range = format!("{base}..HEAD");
        let log = self
            .git(
                worktree,
                &["log", "--reverse", "--format=%H%x1f%s%x1f%cI", &range],
            )
            .await;
        if log.code != 0 {
            return;
        }
        let commits: Vec<(String, String, String)> = log
            .stdout
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| {
                let mut parts = line.split('\u{1f}');
                (
                    parts.next().unwrap_or("").to_string(),
                    parts.next().unwrap_or("").to_string(),
                    parts.next().unwrap_or("").to_string(),
                )
            })
            .filter(|(hash, _, _)| !hash.is_empty())
            .collect();
        if commits.is_empty() {
            return;
        }
        let directory = self.flow_root().join(&session.id);
        let recorded = read_json_lines(&directory.join("checkpoints.jsonl"));

        // File counts for commits no record names are read before the session
        // lock, because each one is a child process.
        let mut file_counts: HashMap<String, u64> = HashMap::new();
        for (hash, _, _) in commits.iter() {
            let short: String = hash.chars().take(7).collect();
            let has_record = recorded.iter().any(|entry| {
                entry
                    .get("commit")
                    .and_then(Value::as_str)
                    .is_some_and(|commit| hash.starts_with(commit))
            });
            let already = session
                .checkpoints
                .iter()
                .any(|entry| entry.commit == short);
            if has_record || already {
                continue;
            }
            let shown = self
                .git(
                    worktree,
                    &["show", "--name-only", "--format=", hash.as_str()],
                )
                .await;
            let count = shown
                .stdout
                .split('\n')
                .filter(|line| !line.trim().is_empty())
                .count() as u64;
            file_counts.insert(hash.clone(), count);
        }

        let (changed, checkpoints, push_tip) = {
            let mut inner = self.lock();
            let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == session.id)
            else {
                return;
            };
            let mut changed = false;
            for (hash, subject, timestamp) in commits.iter() {
                let short: String = hash.chars().take(7).collect();
                let index = current
                    .checkpoints
                    .iter()
                    .position(|entry| entry.commit == short);
                let record = recorded.iter().find(|entry| {
                    entry
                        .get("commit")
                        .and_then(Value::as_str)
                        .is_some_and(|commit| hash.starts_with(commit))
                });
                match record {
                    Some(record) => {
                        let entry = FlowCheckpoint {
                            id: record
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("checkpoint-{short}")),
                            timestamp: record
                                .get("timestamp")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| timestamp.clone()),
                            summary: record
                                .get("summary")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| subject.clone()),
                            files: record.get("files").and_then(Value::as_u64).unwrap_or(0),
                            commit: short.clone(),
                            verification: verification_status(record.get("verification")),
                        };
                        match index {
                            None => current.checkpoints.push(entry),
                            Some(index) => {
                                let existing = &current.checkpoints[index];
                                if existing.id == entry.id
                                    && existing.timestamp == entry.timestamp
                                    && existing.summary == entry.summary
                                    && existing.files == entry.files
                                    && existing.commit == entry.commit
                                    && existing.verification == entry.verification
                                {
                                    continue;
                                }
                                current.checkpoints[index] = entry;
                            }
                        }
                    }
                    None => {
                        if index.is_some() {
                            continue;
                        }
                        let verification = current
                            .verification
                            .as_ref()
                            .map(|verification| verification.status.clone())
                            .unwrap_or_else(|| STALE_VERIFICATION.to_string());
                        current.checkpoints.push(FlowCheckpoint {
                            id: format!("checkpoint-{short}"),
                            timestamp: timestamp.clone(),
                            summary: subject.clone(),
                            files: file_counts.get(hash).copied().unwrap_or(0),
                            commit: short.clone(),
                            verification,
                        });
                    }
                }
                changed = true;
            }
            let tip = commits
                .last()
                .map(|(hash, _, _)| hash.clone())
                .unwrap_or_default();
            let push = !tip.is_empty()
                && current.pushed_tip.as_deref() != Some(tip.as_str())
                && current.pr_failed_tip.as_deref() != Some(tip.as_str());
            let checkpoints = current.checkpoints.clone();
            (changed, checkpoints, push.then_some(tip))
        };
        if changed {
            self.persist();
            self.broadcast(json!({"type": "flowCheckpoints", "checkpoints": checkpoints}));
        }
        if let Some(tip) = push_tip {
            self.sync_pull_request(&session.id, &tip).await;
        }
    }

    // --------------------------------------------------------------- forge

    async fn sync_pull_request(&self, session_id: &str, tip: &str) {
        {
            let mut inner = self.lock();
            if inner.pr_busy {
                // A checkpoint that lands during a push is not dropped: the
                // running sync picks up the newest tip when it finishes.
                inner.pr_pending_tip = Some(tip.to_string());
                return;
            }
            inner.pr_busy = true;
        }
        let mut tip = tip.to_string();
        loop {
            let Some(session) = self.session_by_id(session_id) else {
                break;
            };
            self.sync_pull_request_once(session_id, &session, &tip)
                .await;
            // A newer tip that landed during this sync is pushed before the
            // claim is released, exactly as the reference's finally retries.
            let pending = {
                let mut inner = self.lock();
                inner.pr_pending_tip.take()
            };
            let Some(pending) = pending else {
                break;
            };
            let pushed = self
                .session_by_id(session_id)
                .and_then(|session| session.pushed_tip);
            if pushed.as_deref() == Some(pending.as_str()) {
                break;
            }
            tip = pending;
        }
        self.lock().pr_busy = false;
    }

    async fn sync_pull_request_once(&self, session_id: &str, session: &Session, tip: &str) {
        let worktree = Path::new(&session.worktree);
        let pushed = self
            .git(worktree, &["push", "origin", &session.branch])
            .await;
        if pushed.code != 0 {
            let detail = pushed.stderr.trim();
            let detail = if detail.is_empty() {
                format!("exit code {}", pushed.code)
            } else {
                detail.to_string()
            };
            self.apply_pr_failure(
                session_id,
                tip,
                &detail,
                &format!("Could not push {}: {detail}", session.branch),
            );
            return;
        }
        let Some(target) = self.target().await else {
            let message = "The origin remote does not name a supported repository.";
            self.apply_pr_failure(session_id, tip, message, message);
            return;
        };
        let title = pr_title(&session.goal);
        let body = pr_body(&session.goal, &session.decisions);
        let input = ForgePrInput {
            cwd: self.repo_dir(),
            target: target.clone(),
            head: session.branch.clone(),
            base: "main".to_string(),
            title,
            body,
        };
        let forge = Arc::clone(&self.lock().forge);
        if session.pr.as_ref().is_none_or(|pr| pr.state == "error") {
            match forge.create_draft(input).await {
                Ok(created) => {
                    let pr = FlowPr {
                        forge: target.forge.clone(),
                        number: created.number,
                        url: created.url,
                        state: "draft".to_string(),
                    };
                    self.set_pr(session_id, pr.clone());
                    self.broadcast(json!({"type": "flowPr", "pr": pr}));
                }
                Err(message) => {
                    self.apply_pr_failure(session_id, tip, &message, &message);
                    return;
                }
            }
        } else if let Err(message) = forge
            .update(input, session.pr.as_ref().map(|pr| pr.number).unwrap_or(0))
            .await
        {
            self.apply_pr_failure(session_id, tip, &message, &message);
            return;
        }
        let pr = {
            let mut inner = self.lock();
            let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == session_id)
            else {
                return;
            };
            current.pr_error = None;
            current.pr_failed_tip = None;
            current.pushed_tip = Some(tip.to_string());
            current.updated_at = now_iso();
            current.pr.clone()
        };
        self.persist();
        self.broadcast(json!({"type": "flowPr", "pr": pr}));
        self.publish();
    }

    fn apply_pr_failure(&self, session_id: &str, tip: &str, error: &str, message: &str) {
        {
            let mut inner = self.lock();
            let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == session_id)
            else {
                return;
            };
            current.pr_failed_tip = Some(tip.to_string());
            current.pr_error = Some(error.to_string());
            current.updated_at = now_iso();
        }
        self.persist();
        self.error(message);
        self.publish();
    }

    fn set_pr(&self, session_id: &str, pr: FlowPr) {
        let mut inner = self.lock();
        if let Some(current) = inner
            .session
            .as_mut()
            .filter(|current| current.id == session_id)
        {
            current.pr = Some(pr);
        }
    }

    fn session_by_id(&self, session_id: &str) -> Option<Session> {
        self.lock()
            .session
            .clone()
            .filter(|session| session.id == session_id)
    }

    async fn target(&self) -> Option<ForgeTarget> {
        if let Some(target) = self.lock().forge_target.clone() {
            return Some(target);
        }
        let repo = self.repo_dir();
        let remote = self.git(&repo, &["remote", "get-url", "origin"]).await;
        if remote.code != 0 {
            return None;
        }
        let environment: HashMap<String, String> = std::env::vars().collect();
        classify_origin(&remote.stdout, &environment)
    }

    async fn retry_pr(&self) {
        let session = self.lock().session.clone();
        let Some(session) = session else {
            self.error("No Flow session exists.");
            return;
        };
        let Some(tip) = session.pr_failed_tip.clone() else {
            self.error("There is no failed pull request to retry.");
            return;
        };
        {
            let mut inner = self.lock();
            if let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == session.id)
            {
                current.pr_failed_tip = None;
            }
        }
        self.sync_pull_request(&session.id, &tip).await;
    }

    async fn mark_pr_ready(&self) {
        let session = self.lock().session.clone();
        let Some(session) = session else {
            self.error("No Flow pull request exists.");
            return;
        };
        let Some(pr) = session.pr.clone() else {
            self.error("No Flow pull request exists.");
            return;
        };
        if self.lock().implementation.is_some() {
            self.error("Stop the Flow implementation before marking the pull request ready.");
            return;
        }
        if pr.state != "draft" {
            self.error("Only a draft pull request can be marked ready.");
            return;
        }
        if !self.is_clean(&session.worktree).await {
            self.error("Commit or discard the Flow worktree changes before marking the pull request ready.");
            return;
        }
        let Some(target) = self.target().await else {
            self.error("The origin remote does not name a supported repository.");
            return;
        };
        let forge = Arc::clone(&self.lock().forge);
        let repo = self.repo_dir();
        match forge.mark_ready(&repo, &target, pr.number).await {
            Ok(()) => {}
            Err(message) => {
                self.error(&message);
                return;
            }
        }
        let state = match forge.view(&repo, &target, pr.number).await {
            Ok(state) => state,
            Err(message) => {
                self.error(&message);
                return;
            }
        };
        let next = FlowPr {
            forge: pr.forge.clone(),
            number: pr.number,
            url: state.url,
            state: if state.state == "merged" {
                "merged".to_string()
            } else if state.draft {
                "draft".to_string()
            } else {
                "live".to_string()
            },
        };
        {
            let mut inner = self.lock();
            let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == session.id)
            else {
                return;
            };
            current.pr = Some(next.clone());
            current.updated_at = now_iso();
        }
        self.persist();
        self.broadcast(json!({"type": "flowPr", "pr": next}));
        self.publish();
    }

    async fn merge_pr(&self) {
        let session = self.lock().session.clone();
        let Some(session) = session else {
            self.error("No Flow pull request exists.");
            return;
        };
        let Some(pr) = session.pr.clone() else {
            self.error("No Flow pull request exists.");
            return;
        };
        if self.lock().implementation.is_some() {
            self.error("Stop the Flow implementation before merging the pull request.");
            return;
        }
        if self.refuse_checkout_blocked("merge") {
            return;
        }
        if pr.state != "live" {
            self.error("Only a live pull request can be merged.");
            return;
        }
        if !self.is_clean(&session.worktree).await {
            self.error("Commit or discard the Flow worktree changes before merging.");
            return;
        }
        let Some(target) = self.target().await else {
            self.error("The origin remote does not name a supported repository.");
            return;
        };
        let forge = Arc::clone(&self.lock().forge);
        let repo = self.repo_dir();

        // The forge is the authority on the request's current state: a request
        // closed or reopened elsewhere is never merged on stale local state.
        let current = match forge.view(&repo, &target, pr.number).await {
            Ok(current) => current,
            Err(message) => {
                self.error(&message);
                return;
            }
        };
        if current.state == "merged" {
            // A previous merge reached the forge but not this session's state:
            // adopt it instead of refusing the only local recovery path.
            self.adopt_merge(&session.id, &pr, &current.url);
        } else if current.state != "open" || current.draft {
            self.error("The pull request is not an open, live pull request.");
            return;
        } else {
            if let Err(message) = forge.merge(&repo, &target, pr.number).await {
                self.error(&message);
                return;
            }
            // The successful merge call is the authority. The confirming read
            // only refreshes the URL: a failed or lagging read must not leave
            // the forge merged while this session stays live and unmergeable.
            let mut url = pr.url.clone();
            if let Ok(state) = forge.view(&repo, &target, pr.number).await {
                url = state.url;
            }
            self.adopt_merge(&session.id, &pr, &url);
        }

        let merged = self.session_by_id(&session.id).unwrap_or(session);
        let leftover = self.cleanup_after_merge(&merged).await;
        {
            let mut inner = self.lock();
            if let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == merged.id)
            {
                current.leftover = leftover.clone();
                // A cleanup that left something keeps the retry armed; only a
                // cleanup with nothing left releases it.
                current.cleanup_pending = leftover.is_some();
                current.updated_at = now_iso();
            }
        }
        self.persist();
        if let Some(leftover) = &leftover {
            self.error(&format!(
                "The merge completed, but cleanup left {leftover}. It will be retried at the next Flow start."
            ));
        }
        self.publish();
    }

    /// Records a merge the forge has confirmed and arms the cleanup.
    fn adopt_merge(&self, session_id: &str, pr: &FlowPr, url: &str) {
        {
            let mut inner = self.lock();
            let Some(current) = inner
                .session
                .as_mut()
                .filter(|current| current.id == session_id)
            else {
                return;
            };
            current.pr = Some(FlowPr {
                forge: pr.forge.clone(),
                number: pr.number,
                url: url.to_string(),
                state: "merged".to_string(),
            });
            current.status = "merged".to_string();
            current.leftover = None;
            current.cleanup_pending = true;
            current.updated_at = now_iso();
        }
        self.persist();
        let merged = self.session_by_id(session_id);
        if let Some(session) = &merged {
            self.broadcast(json!({"type": "flowPr", "pr": session.pr}));
        }
        self.register_history();
        self.stop_watchdog();
    }

    /// Removes the merged work, reporting what it could not clean up.
    async fn cleanup_after_merge(&self, session: &Session) -> Option<String> {
        let mut leftovers: Vec<String> = Vec::new();
        let repo = self.repo_dir();
        let fetched = self.git(&repo, &["fetch", "origin"]).await;
        if fetched.code != 0 {
            // Without a refreshed origin/main the ancestry check would blame
            // the branch for a stale remote view.
            let detail = fetched.stderr.trim();
            leftovers.push(if detail.is_empty() {
                "git fetch origin failed".to_string()
            } else {
                format!("git fetch origin failed ({detail})")
            });
            return Some(leftovers.join("; "));
        }
        let head = self.git(&repo, &["symbolic-ref", "--short", "HEAD"]).await;
        if head.code == 0 && head.stdout.trim() == "main" {
            let status = self.git(&repo, &["status", "--porcelain"]).await;
            if status.code == 0 && status.stdout.trim().is_empty() {
                let fast_forward = self
                    .git(&repo, &["merge", "--ff-only", "origin/main"])
                    .await;
                if fast_forward.code != 0 {
                    leftovers.push(
                        "the host checkout could not fast-forward to origin/main".to_string(),
                    );
                }
            }
        }

        let tip = if Path::new(&session.worktree).exists() {
            Some(
                self.git(Path::new(&session.worktree), &["rev-parse", "HEAD"])
                    .await,
            )
        } else {
            None
        };
        let tip_revision = tip
            .as_ref()
            .filter(|tip| tip.code == 0)
            .map(|tip| tip.stdout.trim().to_string())
            .unwrap_or_default();
        if tip.is_some() {
            let removed = self
                .git(&repo, &["worktree", "remove", &session.worktree])
                .await;
            if removed.code != 0 {
                leftovers.push(format!(
                    "the worktree at {} ({})",
                    session.worktree, session.branch
                ));
                return Some(leftovers.join("; "));
            }
        }
        // A resumed cleanup finds the worktree already removed; the branch's
        // own tip then stands in for the revision that had to reach origin/main.
        let branch_ref = format!("refs/heads/{}", session.branch);
        let branch = self
            .git(&repo, &["rev-parse", "--verify", &branch_ref])
            .await;
        let mut branch_gone = branch.code != 0;
        if !branch_gone {
            let revision = if tip_revision.is_empty() {
                branch.stdout.trim().to_string()
            } else {
                tip_revision
            };
            let ancestor = if revision.is_empty() {
                GitResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: String::new(),
                }
            } else {
                self.git(
                    &repo,
                    &["merge-base", "--is-ancestor", &revision, "origin/main"],
                )
                .await
            };
            if ancestor.code != 0 {
                leftovers.push(format!(
                    "the branch {} (its tip is not an ancestor of origin/main)",
                    session.branch
                ));
            } else {
                let local = self.git(&repo, &["branch", "-d", &session.branch]).await;
                if local.code != 0 {
                    leftovers.push(format!("the local branch {}", session.branch));
                } else {
                    branch_gone = true;
                }
            }
        }
        if branch_gone {
            // Only a remote branch that still exists is a deletion candidate,
            // so finishing a cleanup that already deleted it stays silent.
            let remote = self
                .git(
                    &repo,
                    &[
                        "ls-remote",
                        "--exit-code",
                        "--heads",
                        "origin",
                        &session.branch,
                    ],
                )
                .await;
            if remote.code == 0 {
                let forge = Arc::clone(&self.lock().forge);
                if forge
                    .delete_remote_branch(&repo, &session.branch)
                    .await
                    .is_err()
                {
                    leftovers.push(format!("the remote branch {}", session.branch));
                }
            } else if remote.code != 2 {
                leftovers.push(format!(
                    "the remote branch {} (could not check it)",
                    session.branch
                ));
            }
        }
        if leftovers.is_empty() {
            None
        } else {
            Some(leftovers.join("; "))
        }
    }

    // --------------------------------------------------- steering/decisions

    fn send_steering(&self, text: Value, source: &str) -> bool {
        let session_id = {
            let inner = self.lock();
            match inner.session.as_ref() {
                Some(session) => session.id.clone(),
                None => {
                    drop(inner);
                    self.error("No Flow session exists.");
                    return false;
                }
            }
        };
        let Some(text) = text
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
        else {
            self.error("A steering note needs non-empty text.");
            return false;
        };
        let note = FlowSteeringNote {
            id: steering_id(),
            timestamp: now_iso(),
            source: source.to_string(),
            text,
            status: "new".to_string(),
        };
        {
            let mut inner = self.lock();
            let Some(session) = inner
                .session
                .as_mut()
                .filter(|session| session.id == session_id)
            else {
                return false;
            };
            session.steering.push(note.clone());
        }
        if let Err(error) = self.append_steering(&note) {
            self.error(&format!("Could not record the steering note: {error}"));
        }
        self.persist();
        let notes = self
            .session_by_id(&session_id)
            .map(|session| session.steering)
            .unwrap_or_default();
        self.broadcast(json!({"type": "flowSteering", "notes": notes}));
        self.publish();
        true
    }

    fn sync_steering_acks(&self) {
        let Some(directory) = self.session_dir() else {
            return;
        };
        let acks: HashSet<String> = read_json_lines(&directory.join("steering-ack.jsonl"))
            .into_iter()
            .map(|entry| match entry {
                Value::String(id) => id,
                other => other.get("id").map(js_string_of).unwrap_or_default(),
            })
            .collect();
        let (changed, notes) = {
            let mut inner = self.lock();
            let Some(session) = inner.session.as_mut() else {
                return;
            };
            let mut changed = false;
            for note in session.steering.iter_mut() {
                if note.status == "new" && acks.contains(&note.id) {
                    note.status = "read".to_string();
                    changed = true;
                }
            }
            (changed, session.steering.clone())
        };
        if changed {
            self.persist();
            self.broadcast(json!({"type": "flowSteering", "notes": notes}));
        }
    }

    /// Appends a timestamped, source-named section without touching developer
    /// text.
    async fn append_decisions(&self, source: &str, text: &str) {
        let _guard = self.decisions_lock.lock().await;
        let Some(session_id) = self
            .lock()
            .session
            .as_ref()
            .map(|session| session.id.clone())
        else {
            return;
        };
        let section = format!(
            "\n\n## {} \u{2014} {source}\n\n{}\n",
            now_iso(),
            text.trim_end()
        );
        let (decisions, path) = {
            let mut inner = self.lock();
            let Some(session) = inner
                .session
                .as_mut()
                .filter(|session| session.id == session_id)
            else {
                return;
            };
            let previous = session.decisions.trim_end();
            session.decisions = format!("{previous}{section}");
            (
                session.decisions.clone(),
                self.flow_root().join(&session.id).join("decisions.md"),
            )
        };
        if let Err(error) = write_text(&path, &decisions) {
            self.error(&format!("Could not write the decision board: {error}"));
        }
        self.persist();
        self.broadcast(json!({"type": "flowDecisions", "text": decisions}));
        self.publish();
    }

    // ------------------------------------------------------- diff / widgets

    fn accept_widget(&self, id: Option<Value>, accepted: Option<Value>) {
        let Some(session_id) = self
            .lock()
            .session
            .as_ref()
            .map(|session| session.id.clone())
        else {
            self.error("No Flow session exists.");
            return;
        };
        let Some(id) = id.and_then(|value| value.as_str().map(str::to_string)) else {
            self.error("A widget acceptance needs the widget id.");
            return;
        };
        let should_accept = match accepted {
            Some(Value::Bool(accepted)) => accepted,
            _ => {
                self.error("A widget acceptance needs a boolean decision.");
                return;
            }
        };
        let (widgets, signatures, path) = {
            let mut inner = self.lock();
            let Some(session) = inner
                .session
                .as_mut()
                .filter(|session| session.id == session_id)
            else {
                return;
            };
            if !session.widgets.iter().any(|widget| widget.id == id) {
                drop(inner);
                self.error("That Flow widget is no longer current.");
                return;
            }
            if should_accept {
                if !session.accepted.iter().any(|signature| signature == &id) {
                    session.accepted.push(id.clone());
                }
            } else {
                session.accepted.retain(|signature| signature != &id);
            }
            for widget in session.widgets.iter_mut() {
                if widget.id == id {
                    widget.accepted = should_accept;
                }
            }
            (
                session.widgets.clone(),
                session.accepted.clone(),
                self.flow_root().join(&session.id).join("accepted.json"),
            )
        };
        self.persist();
        let _ = write_json(&path, &json!({"signatures": signatures}));
        self.broadcast(json!({"type": "flowWidgets", "widgets": widgets}));
        self.publish();
    }

    fn refuse_widget(&self, id: Option<Value>, reason: Option<Value>) {
        let Some(session_id) = self
            .lock()
            .session
            .as_ref()
            .map(|session| session.id.clone())
        else {
            self.error("No Flow session exists.");
            return;
        };
        let id = id.and_then(|value| value.as_str().map(str::to_string));
        let known = match &id {
            Some(id) => self
                .session_by_id(&session_id)
                .is_some_and(|session| session.widgets.iter().any(|widget| &widget.id == id)),
            None => false,
        };
        if !known {
            self.error("That Flow widget is no longer current.");
            return;
        }
        let id = id.unwrap_or_default();
        let detail = reason
            .and_then(|value| value.as_str().map(|text| text.trim().to_string()))
            .unwrap_or_default();
        let text = if detail.is_empty() {
            format!("Refuse widget {id}: abandon this change and implement another solution.")
        } else {
            format!(
                "Refuse widget {id}: {detail} Abandon this change and implement another solution."
            )
        };
        self.send_steering(Value::String(text), &format!("widget:{id}"));
    }

    // -------------------------------------------------------- conversation

    async fn open_conversation(self: &Arc<Self>, widget_id: Option<Value>) {
        let Some(session) = self.lock().session.clone() else {
            self.error("No Flow session exists.");
            return;
        };
        let Some(widget_id) = widget_id.and_then(|value| value.as_str().map(str::to_string)) else {
            self.error("A widget conversation needs the widget id.");
            return;
        };
        let Some(widget) = session
            .widgets
            .iter()
            .find(|widget| widget.id == widget_id)
            .cloned()
        else {
            self.error("That Flow widget is no longer current.");
            return;
        };
        self.close_conversation(true);

        let token = next_token();
        {
            let mut inner = self.lock();
            inner.conversation = Some(Conversation {
                token,
                widget_id: widget_id.clone(),
                agent: None,
                messages: Vec::new(),
                activity: Vec::new(),
                question: None,
                // The opening prompt owns the turn from the moment the
                // conversation opens, so a message sent before the peer is
                // attached queues behind it instead of starting a second turn.
                busy: true,
                queue: Vec::new(),
            });
        }
        self.broadcast(json!({"type": "flowConversationStarted", "widgetId": widget_id}));
        self.publish();

        let Some(directory) = self.session_dir() else {
            return;
        };
        let files: Vec<FlowFile> = widget
            .files
            .iter()
            .filter_map(|path| {
                session
                    .files
                    .iter()
                    .find(|file| &file.path == path)
                    .cloned()
            })
            .collect();
        let mut context_parts = vec![
            format!("Widget category: {}", widget.category),
            format!("Widget concept: {}", widget.concept),
            format!("Widget summary: {}", widget.summary),
            format!("Widget rationale: {}", widget.rationale),
            String::new(),
            "Session goal:".to_string(),
            session.goal.clone(),
            String::new(),
            "Decision board:".to_string(),
            session.decisions.clone(),
            String::new(),
            "Files and diffs:".to_string(),
        ];
        for file in files {
            context_parts.push(
                [
                    format!("--- {} ({}) ---", file.path, file.status),
                    file.diff,
                ]
                .join("\n"),
            );
        }
        context_parts.push(String::new());
        context_parts
            .push("This conversation is read-only. Never edit code or the worktree.".to_string());
        let context = context_parts.join("\n");

        let mode = Arc::clone(self);
        tokio::spawn(async move {
            mode.run_conversation_open(token, widget_id, directory, context)
                .await;
        });
    }

    async fn run_conversation_open(
        self: Arc<Self>,
        token: u64,
        widget_id: String,
        directory: PathBuf,
        context: String,
    ) {
        let environment = match self.peer_environment().await {
            Ok(environment) => environment,
            Err(message) => {
                if self.conversation_current(token) {
                    self.error(&message);
                    self.close_conversation(false);
                }
                return;
            }
        };
        // A close, a replacement, or a disposal during provider selection
        // clears the owner.
        if !self.conversation_current(token) {
            return;
        }
        let Some(command) = self.agent_command() else {
            return;
        };
        let options =
            AcpConnectionOptions::new(command, self.repo_dir().to_string_lossy().into_owned())
                .with_starter("Flow")
                .with_env(environment)
                .with_permission_policy(PermissionPolicy::ReadOnly);
        let connected = AcpConnection::connect(options).await;
        let (connection, events) = match connected {
            Ok(connected) => connected,
            Err(error) => {
                if !self.conversation_current(token) {
                    return;
                }
                self.error(&error.to_string());
                self.close_conversation(false);
                return;
            }
        };
        if !self.conversation_current(token) {
            connection.close();
            return;
        }
        let agent = Arc::new(connection);
        {
            let mut inner = self.lock();
            match inner.conversation.as_mut() {
                Some(conversation) if conversation.token == token => {
                    conversation.agent = Some(Arc::clone(&agent));
                }
                _ => {
                    drop(inner);
                    agent.close();
                    return;
                }
            }
        }
        self.spawn_conversation_events(token, events);
        let prompt = format!(
            "/flow-widget {} {}\n\n{}",
            directory.display(),
            widget_id,
            context
        );
        self.pump_conversation(token, prompt).await;
    }

    fn conversation_current(&self, token: u64) -> bool {
        self.lock()
            .conversation
            .as_ref()
            .is_some_and(|conversation| conversation.token == token)
    }

    fn spawn_conversation_events(
        self: &Arc<Self>,
        token: u64,
        mut events: mpsc::UnboundedReceiver<AcpEvent>,
    ) {
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    AcpEvent::Activity(activity) => {
                        let append = {
                            let mut inner = mode.lock();
                            let Some(conversation) = inner.conversation.as_mut() else {
                                drop(inner);
                                break;
                            };
                            if conversation.token != token {
                                drop(inner);
                                break;
                            }
                            let append = activity.append && !conversation.activity.is_empty();
                            if append {
                                if let Some(last) = conversation.activity.last_mut() {
                                    last.push_str(&activity.text);
                                }
                            } else {
                                conversation.activity.push(activity.text.clone());
                            }
                            append
                        };
                        mode.broadcast(json!({
                            "type": "flowConversationActivity",
                            "text": activity.text,
                            "append": append,
                        }));
                    }
                    AcpEvent::Question(question) => {
                        let accepted = {
                            let mut inner = mode.lock();
                            let Some(conversation) = inner.conversation.as_mut() else {
                                drop(inner);
                                break;
                            };
                            if conversation.token != token {
                                drop(inner);
                                break;
                            }
                            conversation.question = Some(flow_question(&question));
                            true
                        };
                        if accepted {
                            mode.broadcast(json!({
                                "type": "flowConversationQuestion",
                                "id": question.id,
                                "message": question.message,
                                "options": question.options,
                            }));
                            mode.publish();
                        }
                    }
                    AcpEvent::Stderr(text) => {
                        if let Some(app) = mode.app() {
                            app.shared.journal.write("acp-stderr", &text, None);
                        }
                    }
                    AcpEvent::Text(_) | AcpEvent::SessionUpdate => {}
                }
            }
        });
    }

    /// One prompt at a time; a message sent while the peer answers waits its
    /// turn. The opening `run` creates the session, and every later turn
    /// prompts it so the queued text keeps the conversation's context.
    async fn pump_conversation(self: &Arc<Self>, token: u64, prompt: String) {
        let Some(agent) = self.conversation_agent(token) else {
            return;
        };
        self.set_conversation_busy(token, true);
        if let Err(error) = agent.run(&prompt).await {
            if self.conversation_current(token) {
                self.error(&error.to_string());
            }
        }
        self.finish_conversation_turn(token);
    }

    fn conversation_agent(&self, token: u64) -> Option<Arc<AcpConnection>> {
        self.lock()
            .conversation
            .as_ref()
            .filter(|conversation| conversation.token == token)
            .and_then(|conversation| conversation.agent.clone())
    }

    fn set_conversation_busy(&self, token: u64, busy: bool) {
        let mut inner = self.lock();
        if let Some(conversation) = inner.conversation.as_mut().filter(|c| c.token == token) {
            conversation.busy = busy;
        }
    }

    fn send_conversation_message(self: &Arc<Self>, text: Value) {
        let (token, exists) = {
            let inner = self.lock();
            match inner.conversation.as_ref() {
                Some(conversation) => (conversation.token, true),
                None => (0, false),
            }
        };
        if !exists {
            self.error("No widget conversation is open.");
            return;
        }
        let Some(text) = text
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
        else {
            self.error("A conversation message needs non-empty text.");
            return;
        };
        // The message and the turn decision are one step under one lock: a
        // turn that finishes between a separate check and the enqueue would
        // drain an empty queue and leave the text waiting forever.
        let start_turn = {
            let mut inner = self.lock();
            let Some(conversation) = inner.conversation.as_mut().filter(|c| c.token == token)
            else {
                return;
            };
            conversation.enqueue_message(&text)
        };
        self.broadcast(json!({
            "type": "flowConversationMessage",
            "role": "developer",
            "text": text,
        }));
        self.publish();
        if !start_turn {
            return;
        }
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            mode.prompt_conversation_turn(token, text).await;
        });
    }

    async fn prompt_conversation_turn(self: &Arc<Self>, token: u64, text: String) {
        let Some(agent) = self.conversation_agent(token) else {
            return;
        };
        self.set_conversation_busy(token, true);
        if let Err(error) = agent.prompt(&text).await {
            if self.conversation_current(token) {
                self.error(&error.to_string());
            }
        }
        self.finish_conversation_turn(token);
    }

    /// Clears the busy flag, then drains one queued message at a time. The
    /// queue is drained by a loop rather than a recursive spawn, so the whole
    /// conversation lives in one bounded future.
    fn finish_conversation_turn(self: &Arc<Self>, token: u64) {
        self.set_conversation_busy(token, false);
        let mode = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let next = {
                    let mut inner = mode.lock();
                    match inner.conversation.as_mut().filter(|c| c.token == token) {
                        Some(conversation) if !conversation.queue.is_empty() => {
                            Some(conversation.queue.remove(0))
                        }
                        _ => None,
                    }
                };
                let Some(text) = next else {
                    break;
                };
                let Some(agent) = mode.conversation_agent(token) else {
                    break;
                };
                mode.set_conversation_busy(token, true);
                if let Err(error) = agent.prompt(&text).await {
                    if mode.conversation_current(token) {
                        mode.error(&error.to_string());
                    }
                }
                mode.set_conversation_busy(token, false);
                if !mode.conversation_current(token) {
                    break;
                }
            }
        });
    }

    fn close_conversation(&self, silent: bool) {
        let conversation = {
            let mut inner = self.lock();
            inner.conversation.take()
        };
        let Some(conversation) = conversation else {
            if !silent {
                self.error("No widget conversation is open.");
            }
            return;
        };
        if let Some(agent) = &conversation.agent {
            agent.close();
        }
        self.broadcast(json!({
            "type": "flowConversationStopped",
            "widgetId": conversation.widget_id,
        }));
        if !silent {
            self.publish();
        }
    }

    async fn send_conversation_conclusion(&self, text: Value) {
        let (conversation_widget, session) = {
            let inner = self.lock();
            (
                inner
                    .conversation
                    .as_ref()
                    .map(|conversation| conversation.widget_id.clone()),
                inner.session.clone(),
            )
        };
        let (Some(widget_id), Some(session)) = (conversation_widget, session) else {
            self.error("No widget conversation is open.");
            return;
        };
        let Some(text) = text
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
        else {
            self.error("A conclusion needs non-empty text.");
            return;
        };
        let widget = session.widgets.iter().find(|widget| widget.id == widget_id);
        self.append_decisions(&format!("Widget conversation {widget_id}"), &text)
            .await;
        let concept = widget
            .map(|widget| format!(" ({})", widget.concept))
            .unwrap_or_default();
        self.send_steering(
            Value::String(format!(
                "Conclusion for widget {widget_id}{concept}: {text}"
            )),
            &format!("widget-chat:{widget_id}"),
        );
    }

    // ------------------------------------------------------- verification

    fn sync_verification(&self) {
        let Ok(path) = self.path("verification.json") else {
            return;
        };
        let Some(stored) = read_json(&path) else {
            return;
        };
        if !stored.is_object() {
            return;
        }
        let status = match stored.get("status").and_then(Value::as_str) {
            Some("passed") => "passed",
            Some("failed") => "failed",
            Some("not-run") => "not-run",
            _ => return,
        };
        let verification = FlowVerification {
            command: stored
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            status: status.to_string(),
            timestamp: stored
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(now_iso),
            output: stored
                .get("output")
                .and_then(Value::as_str)
                .map(bounded_tail)
                .unwrap_or_default(),
        };
        let unchanged = {
            let inner = self.lock();
            inner.session.as_ref().is_some_and(|session| {
                session.verification.as_ref().is_some_and(|existing| {
                    existing.command == verification.command
                        && existing.status == verification.status
                        && existing.timestamp == verification.timestamp
                })
            })
        };
        if unchanged {
            return;
        }
        {
            let mut inner = self.lock();
            let Some(session) = inner.session.as_mut() else {
                return;
            };
            session.verification = Some(verification.clone());
        }
        self.persist();
        self.broadcast(json!({"type": "flowVerification", "verification": verification}));
    }

    // ------------------------------------------------------------ blockers

    fn add_blocker(&self, text: &str) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        let (session_id, duplicate) = {
            let inner = self.lock();
            match inner.session.as_ref() {
                None => return,
                Some(session) => (
                    session.id.clone(),
                    session
                        .blockers
                        .iter()
                        .any(|blocker| blocker.text == trimmed),
                ),
            }
        };
        if duplicate {
            return;
        }
        let blocker = FlowBlocker {
            id: blocker_id(),
            timestamp: now_iso(),
            text: trimmed.to_string(),
            dismissed: false,
        };
        {
            let mut inner = self.lock();
            let Some(session) = inner
                .session
                .as_mut()
                .filter(|session| session.id == session_id)
            else {
                return;
            };
            session.blockers.push(blocker.clone());
        }
        if let Ok(path) = self.path("blockers.jsonl") {
            let _ = append_line(
                &path,
                &json!({
                    "id": blocker.id,
                    "timestamp": blocker.timestamp,
                    "text": blocker.text,
                }),
            );
        }
        self.persist();
        let blockers = self
            .session_by_id(&session_id)
            .map(|session| session.blockers)
            .unwrap_or_default();
        self.broadcast(json!({"type": "flowBlockers", "blockers": blockers}));
        self.publish();
    }

    fn sync_blockers(&self) {
        let Some(directory) = self.session_dir() else {
            return;
        };
        let recorded = read_json_lines(&directory.join("blockers.jsonl"));
        let (changed, blockers) = {
            let mut inner = self.lock();
            let Some(session) = inner.session.as_mut() else {
                return;
            };
            let mut changed = false;
            for entry in recorded {
                let Some(text) = entry.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if text.trim().is_empty()
                    || session.blockers.iter().any(|blocker| blocker.text == text)
                {
                    continue;
                }
                session.blockers.push(FlowBlocker {
                    id: entry
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            format!(
                                "blocker-{}",
                                &uuid::Uuid::new_v4().simple().to_string()[..8]
                            )
                        }),
                    timestamp: entry
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(now_iso),
                    text: text.to_string(),
                    dismissed: false,
                });
                changed = true;
            }
            (changed, session.blockers.clone())
        };
        if changed {
            self.persist();
            self.broadcast(json!({"type": "flowBlockers", "blockers": blockers}));
        }
    }

    fn dismiss_blocker(&self, id: Option<Value>) {
        let Some(session_id) = self
            .lock()
            .session
            .as_ref()
            .map(|session| session.id.clone())
        else {
            self.error("No Flow session exists.");
            return;
        };
        let Some(id) = id.and_then(|value| value.as_str().map(str::to_string)) else {
            self.error("A blocker dismissal needs the blocker id.");
            return;
        };
        let (blockers, exists) = {
            let mut inner = self.lock();
            let Some(session) = inner
                .session
                .as_mut()
                .filter(|session| session.id == session_id)
            else {
                return;
            };
            let exists = session.blockers.iter().any(|blocker| blocker.id == id);
            for blocker in session.blockers.iter_mut() {
                if blocker.id == id {
                    blocker.dismissed = true;
                }
            }
            (session.blockers.clone(), exists)
        };
        if !exists {
            self.error("That Flow blocker does not exist.");
            return;
        }
        self.persist();
        self.broadcast(json!({"type": "flowBlockers", "blockers": blockers}));
        self.publish();
    }

    // -------------------------------------------------------------- answer

    async fn answer(&self, id: Option<Value>, value: Option<Value>, target: Option<Value>) {
        let id = match &id {
            Some(Value::String(text)) => Some(Value::String(text.clone())),
            Some(Value::Number(number)) => Some(Value::String(number.to_string())),
            _ => None,
        };
        let Some(id) = id else {
            self.error("An answer needs the question id and a non-empty value.");
            return;
        };
        let Some(value) = value
            .as_ref()
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        else {
            self.error("An answer needs the question id and a non-empty value.");
            return;
        };
        let value = value.to_string();
        let wanted = id.as_str().unwrap_or_default().to_string();

        if target.as_ref().and_then(Value::as_str) == Some("conversation") {
            let (question, agent, token) = {
                let inner = self.lock();
                match inner.conversation.as_ref() {
                    Some(conversation) => (
                        conversation.question.clone(),
                        conversation.agent.clone(),
                        conversation.token,
                    ),
                    None => (None, None, 0),
                }
            };
            let Some(question) = question else {
                self.error("No pending conversation question with that id.");
                return;
            };
            if question.id.as_key() != wanted {
                self.error("No pending conversation question with that id.");
                return;
            }
            let Some(agent) = agent else {
                self.error("No pending conversation question with that id.");
                return;
            };
            if !agent.answer(&question.id, &value).await {
                self.error("No pending conversation question with that id.");
                return;
            }
            let mut inner = self.lock();
            if let Some(conversation) = inner.conversation.as_mut().filter(|c| c.token == token) {
                conversation.question = None;
            }
            drop(inner);
            self.publish();
            return;
        }

        if target.as_ref().and_then(Value::as_str) == Some("goal") {
            let (question, agent, token) = {
                let inner = self.lock();
                match inner.goal_creation.as_ref() {
                    Some(creation) => (
                        creation.question.clone(),
                        creation.agent.clone(),
                        creation.token,
                    ),
                    None => (None, None, 0),
                }
            };
            let Some(question) = question else {
                self.error("No pending Flow goal question with that id.");
                return;
            };
            if question.id.as_key() != wanted {
                self.error("No pending Flow goal question with that id.");
                return;
            }
            let Some(agent) = agent else {
                self.error("No pending Flow goal question with that id.");
                return;
            };
            if !agent.answer(&question.id, &value) {
                self.error("No pending Flow goal question with that id.");
                return;
            }
            let mut inner = self.lock();
            if let Some(creation) = inner.goal_creation.as_mut().filter(|c| c.token == token) {
                creation.question = None;
            }
            return;
        }

        let (session_question, agent, session_id, token) = {
            let inner = self.lock();
            (
                inner
                    .session
                    .as_ref()
                    .and_then(|session| session.question.clone()),
                inner
                    .implementation
                    .as_ref()
                    .and_then(|implementation| implementation.agent.clone()),
                inner.session.as_ref().map(|session| session.id.clone()),
                inner
                    .implementation
                    .as_ref()
                    .map(|implementation| implementation.token),
            )
        };
        let (Some(question), Some(agent), Some(session_id), Some(token)) =
            (session_question, agent, session_id, token)
        else {
            self.error("No pending Flow question with that id.");
            return;
        };
        if question.id.as_key() != wanted || !agent.answer(&question.id, &value) {
            self.error("No pending Flow question with that id.");
            return;
        }
        {
            let mut inner = self.lock();
            if inner
                .implementation
                .as_ref()
                .is_some_and(|implementation| implementation.token == token)
            {
                if let Some(session) = inner
                    .session
                    .as_mut()
                    .filter(|session| session.id == session_id)
                {
                    session.question = None;
                }
            }
        }
        self.persist();
        self.publish();
    }

    // ---------------------------------------------------------- peer setup

    async fn peer_environment(&self) -> Result<HashMap<String, String>, String> {
        let Some(app) = self.app() else {
            return Err("The dashboard is no longer running.".to_string());
        };
        match app.providers.select_environment().await {
            Ok(environment) => Ok(environment
                .into_iter()
                .filter_map(|(key, value)| value.map(|value| (key, value)))
                .collect()),
            Err(error) => Err(error.message),
        }
    }

    fn agent_command(&self) -> Option<String> {
        let app = self.app()?;
        Some(app.config().agent_command.clone())
    }
}

/// Builds a frame whose first key is `type`, matching `{ type, ...snapshot }`.
fn ordered_frame(kind: &str, object: Map<String, Value>) -> Value {
    let mut ordered = Map::new();
    ordered.insert("type".into(), Value::String(kind.to_string()));
    for (key, value) in object.into_iter() {
        if key == "type" {
            continue;
        }
        ordered.insert(key, value);
    }
    Value::Object(ordered)
}

fn js_string_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_string(),
        other => crate::jsjson::stringify(other),
    }
}

fn flow_question(question: &AcpQuestion) -> FlowQuestion {
    FlowQuestion {
        id: question.id.clone(),
        message: question.message.clone(),
        options: question.options.clone(),
    }
}

fn widgets_as_raw(widgets: &[FlowWidget]) -> Vec<RawWidget> {
    widgets
        .iter()
        .map(|widget| RawWidget {
            category: widget.category.clone(),
            concept: widget.concept.clone(),
            summary: widget.summary.clone(),
            rationale: widget.rationale.clone(),
            files: widget.files.clone(),
        })
        .collect()
}

fn validate_widgets(raw: &[RawWidget], files: &[FlowFile]) -> Option<Vec<RawWidget>> {
    let paths: HashSet<&str> = files.iter().map(|file| file.path.as_str()).collect();
    let mut widgets: Vec<RawWidget> = Vec::new();
    for entry in raw {
        if !FLOW_CATEGORIES.contains(&entry.category.as_str()) {
            return None;
        }
        if entry.concept.trim().is_empty()
            || entry.summary.trim().is_empty()
            || entry.rationale.trim().is_empty()
        {
            return None;
        }
        if entry.files.is_empty() {
            return None;
        }
        if !entry.files.iter().all(|path| paths.contains(path.as_str())) {
            return None;
        }
        let mut seen: Vec<String> = Vec::new();
        for path in entry.files.iter() {
            if !seen.iter().any(|existing| existing == path) {
                seen.push(path.clone());
            }
        }
        widgets.push(RawWidget {
            category: entry.category.clone(),
            concept: entry.concept.clone(),
            summary: entry.summary.clone(),
            rationale: entry.rationale.clone(),
            files: seen,
        });
    }
    Some(widgets)
}

fn reconcile(raw: &[RawWidget], files: &[FlowFile], session: &Session) -> Vec<FlowWidget> {
    let diffs: HashMap<String, String> = files
        .iter()
        .map(|file| (file.path.clone(), file.diff.clone()))
        .collect();
    let by_path: HashSet<&str> = files.iter().map(|file| file.path.as_str()).collect();
    let accepted: HashSet<&str> = session.accepted.iter().map(String::as_str).collect();
    let mut widgets: Vec<FlowWidget> = Vec::new();
    let mut covered: HashSet<String> = HashSet::new();

    for entry in raw {
        if !FLOW_CATEGORIES.contains(&entry.category.as_str()) {
            continue;
        }
        let paths: Vec<String> = entry
            .files
            .iter()
            .filter(|path| by_path.contains(path.as_str()))
            .cloned()
            .collect();
        if paths.is_empty() {
            continue;
        }
        let signature = widget_signature(&entry.category, &paths, &diffs);
        for path in paths.iter() {
            covered.insert(path.clone());
        }
        if widgets.iter().any(|widget| widget.id == signature) {
            continue;
        }
        let mut sorted = paths.clone();
        sorted.sort();
        sorted.dedup();
        widgets.push(FlowWidget {
            id: signature.clone(),
            category: entry.category.clone(),
            concept: entry.concept.clone(),
            summary: entry.summary.clone(),
            rationale: entry.rationale.clone(),
            files: sorted,
            accepted: accepted.contains(signature.as_str()),
        });
    }

    for file in files {
        if covered.contains(&file.path) {
            continue;
        }
        let paths = vec![file.path.clone()];
        let signature = widget_signature("structure", &paths, &diffs);
        if widgets.iter().any(|widget| widget.id == signature) {
            continue;
        }
        widgets.push(FlowWidget {
            id: signature.clone(),
            category: "structure".to_string(),
            concept: file.path.clone(),
            summary: format!("Changed file {}", file.path),
            rationale: "No change widget named this file, so it is shown as a structure change."
                .to_string(),
            files: paths,
            accepted: accepted.contains(signature.as_str()),
        });
    }

    widgets
}

fn parse_session(stored: &Value, id: &str, started_at: &str) -> Option<Session> {
    let worktree = stored.get("worktree").and_then(Value::as_str)?;
    let branch = stored.get("branch").and_then(Value::as_str)?;
    let status = stored.get("status").and_then(Value::as_str)?;
    if !matches!(status, "idle" | "running" | "stopped" | "merged") {
        return None;
    }
    let array = |name: &str| stored.get(name).cloned().filter(Value::is_array);
    let strings = |name: &str| -> Vec<String> {
        array(name)
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    };
    let typed = |name: &str| -> Vec<Value> {
        array(name)
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    };
    let mut widgets = Vec::new();
    for value in typed("widgets") {
        if let Ok(widget) = serde_json::from_value::<FlowWidget>(value) {
            widgets.push(widget);
        }
    }
    let mut files = Vec::new();
    for value in typed("files") {
        if let Ok(file) = serde_json::from_value::<FlowFile>(value) {
            files.push(file);
        }
    }
    let mut steering = Vec::new();
    for value in typed("steering") {
        if let Ok(note) = serde_json::from_value::<FlowSteeringNote>(value) {
            steering.push(note);
        }
    }
    let mut checkpoints = Vec::new();
    for value in typed("checkpoints") {
        if let Ok(checkpoint) = serde_json::from_value::<FlowCheckpoint>(value) {
            checkpoints.push(checkpoint);
        }
    }
    let mut blockers = Vec::new();
    for value in typed("blockers") {
        if let Ok(blocker) = serde_json::from_value::<FlowBlocker>(value) {
            blockers.push(blocker);
        }
    }
    Some(Session {
        id: id.to_string(),
        base_revision: stored
            .get("baseRevision")
            .and_then(Value::as_str)
            .map(str::to_string),
        worktree: worktree.to_string(),
        branch: branch.to_string(),
        status: status.to_string(),
        goal: stored
            .get("goal")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        decisions: stored
            .get("decisions")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        steering,
        accepted: strings("accepted"),
        widgets,
        files,
        checkpoints,
        verification: stored
            .get("verification")
            .filter(|value| value.is_object())
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        blockers,
        pr: stored
            .get("pr")
            .filter(|value| value.is_object())
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
        pr_error: stored
            .get("prError")
            .and_then(Value::as_str)
            .map(str::to_string),
        leftover: stored
            .get("leftover")
            .and_then(Value::as_str)
            .map(str::to_string),
        cleanup_pending: stored.get("cleanupPending") == Some(&Value::Bool(true)),
        question: None,
        pushed_tip: stored
            .get("pushedTip")
            .and_then(Value::as_str)
            .map(str::to_string),
        pr_failed_tip: stored
            .get("prFailedTip")
            .and_then(Value::as_str)
            .map(str::to_string),
        last_diff_hash: stored
            .get("lastDiffHash")
            .and_then(Value::as_str)
            .map(str::to_string),
        created_at: stored
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or(started_at)
            .to_string(),
        updated_at: stored
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or(started_at)
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_splits_into_per_file_chunks() {
        let text = "diff --git a/src/a.txt b/src/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n";
        let files = diff_files(text);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/a.txt");
        assert_eq!(files[0].status, "added");
        assert_eq!(files[0].insertions, 2);
        assert_eq!(files[0].deletions, 0);
    }

    #[test]
    fn a_quoted_header_path_is_decoded() {
        let text = "diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"\n--- a/caf\\303\\251.txt\n+++ b/caf\\303\\251.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let files = diff_files(text);
        assert_eq!(files[0].path, "café.txt");
    }

    #[test]
    fn a_widget_signature_ignores_file_order_and_concept() {
        let diffs = HashMap::from([
            (
                "a".to_string(),
                "diff --git a/a b/a\nindex 1..2\n+x".to_string(),
            ),
            ("b".to_string(), "diff --git a/b b/b\n+y".to_string()),
        ]);
        let forward = widget_signature("data", &["a".to_string(), "b".to_string()], &diffs);
        let reverse = widget_signature("data", &["b".to_string(), "a".to_string()], &diffs);
        assert_eq!(forward, reverse);
        assert_eq!(forward.len(), 16);
    }

    #[test]
    fn every_flow_command_is_handled() {
        let names = [
            "createFlowGoal",
            "cancelFlowGoal",
            "startFlowImplementation",
            "stopFlowImplementation",
            "retryFlowPr",
            "markFlowPrReady",
            "mergeFlowPr",
            "sendFlowSteering",
            "acceptFlowWidget",
            "refuseFlowWidget",
            "openFlowWidget",
            "closeFlowWidget",
            "sendFlowConversation",
            "sendFlowConclusion",
            "dismissFlowBlocker",
            "flowAnswer",
        ];
        for name in names {
            let frame = format!("{{\"type\":\"{name}\"}}");
            let command = crate::command::command_from_json(&frame)
                .unwrap_or_else(|| panic!("{name} parses"));
            assert!(handles(&command), "{name} belongs to Flow");
        }
        let goal = crate::command::command_from_json("{\"type\":\"getGoal\"}").expect("getGoal");
        assert!(!handles(&goal));
    }

    #[test]
    fn a_status_line_parses_into_its_entries() {
        let entries = parse_status_z("?? one.txt\0R  new name\0old name\0 M two.txt\0");
        assert_eq!(
            entries,
            vec![
                ("untracked".to_string(), "one.txt".to_string()),
                ("renamed".to_string(), "new name".to_string()),
                ("modified".to_string(), "two.txt".to_string()),
            ]
        );
    }

    #[test]
    fn a_pr_title_is_the_goals_first_line() {
        assert_eq!(pr_title("# Flow goal\n\nMake it work."), "Flow goal");
        assert_eq!(pr_title(""), "Flow session");
        let long = "x".repeat(200);
        assert_eq!(pr_title(&long).chars().count(), 120);
    }

    #[test]
    fn a_conversation_message_starts_one_turn_and_queues_the_next() {
        let mut conversation = Conversation {
            token: 1,
            widget_id: "widget-1".to_string(),
            agent: None,
            messages: Vec::new(),
            activity: Vec::new(),
            question: None,
            busy: false,
            queue: Vec::new(),
        };
        assert!(conversation.enqueue_message("Which caller observes this?"));
        assert!(conversation.busy);
        assert!(conversation.queue.is_empty());
        assert_eq!(
            conversation.messages,
            vec![ConversationMessage {
                role: "developer".to_string(),
                text: "Which caller observes this?".to_string(),
            }]
        );

        // A message that arrives while the turn runs waits for that turn's
        // finish to drain it, and the same call never drops it.
        assert!(!conversation.enqueue_message("And the stored shape?"));
        assert_eq!(
            conversation.queue,
            vec!["And the stored shape?".to_string()]
        );
        assert_eq!(conversation.messages.len(), 2);
    }

    #[test]
    fn an_origin_remote_classifies() {
        let environment = HashMap::new();
        let github =
            classify_origin("git@github.com:acme/fixture.git", &environment).expect("github");
        assert_eq!(github.forge, "github");
        assert_eq!(github.project, "acme/fixture");
        let gitlab =
            classify_origin("https://gitlab.com/group/sub/repo.git", &environment).expect("gitlab");
        assert_eq!(gitlab.forge, "gitlab");
        assert_eq!(gitlab.project, "group/sub/repo");
        // This checkout's Gitea origin is a Gitea target, never a GitHub one.
        let gitea = classify_origin("ssh://git@localhost:2223/owner/name.git", &environment)
            .expect("gitea");
        assert_eq!(gitea.forge, "gitea");
        assert_eq!(gitea.host, "localhost");
        assert_eq!(gitea.project, "owner/name");
        assert!(classify_origin("/home/me/repo", &environment).is_none());
    }
}
