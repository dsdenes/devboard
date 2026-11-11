//! Discover Mode: the project sheet, glossary, skill, and contribution crawl.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::format_description::FormatItem;
use time::macros::format_description;
use time::OffsetDateTime;

use crate::acp::{AcpId, AcpQuestion};
use crate::app::{App, Conn, StateSection};
use crate::command::Command;
use crate::detached_run::{DetachedPeer, DetachedPeerOptions, DetachedRunOutcome};

/// One of the seven Discover agents, in sidebar order.
#[derive(Clone, Copy, Debug)]
pub struct AgentDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub command: &'static str,
    pub prompt_file: &'static str,
    pub skill: Option<&'static str>,
    pub glossary: bool,
}

pub const DISCOVER_AGENTS: &[AgentDescriptor] = &[
    AgentDescriptor {
        id: "sheet",
        label: "Data Sheet",
        command: "/discover-sheet",
        prompt_file: "discover-sheet.md",
        skill: None,
        glossary: false,
    },
    AgentDescriptor {
        id: "discover-contribution",
        label: "Contribution Agent",
        command: "/discover-contribution",
        prompt_file: "discover-contribution.md",
        skill: Some("discover-contribution"),
        glossary: false,
    },
    AgentDescriptor {
        id: "discover-testing-strategy",
        label: "Testing Strategy",
        command: "/discover-testing-strategy",
        prompt_file: "discover-testing-strategy.md",
        skill: Some("discover-testing-strategy"),
        glossary: false,
    },
    AgentDescriptor {
        id: "discover-naming-conventions",
        label: "Naming Conventions",
        command: "/discover-naming-conventions",
        prompt_file: "discover-naming-conventions.md",
        skill: Some("discover-naming-conventions"),
        glossary: false,
    },
    AgentDescriptor {
        id: "discover-coding-conventions",
        label: "Coding Conventions",
        command: "/discover-coding-conventions",
        prompt_file: "discover-coding-conventions.md",
        skill: Some("discover-coding-conventions"),
        glossary: false,
    },
    AgentDescriptor {
        id: "discover-architecture-boundaries",
        label: "Architecture & Boundaries",
        command: "/discover-architecture-boundaries",
        prompt_file: "discover-architecture-boundaries.md",
        skill: Some("discover-architecture-boundaries"),
        glossary: false,
    },
    AgentDescriptor {
        id: "discover-glossary",
        label: "Glossary Agent",
        command: "/discover-glossary",
        prompt_file: "discover-glossary.md",
        skill: Some("discover-glossary"),
        glossary: true,
    },
];

/// The fixed Run all order: the sheet and glossary ground the skills that follow.
pub const DISCOVER_RUN_ORDER: &[&str] = &[
    "sheet",
    "discover-glossary",
    "discover-testing-strategy",
    "discover-naming-conventions",
    "discover-coding-conventions",
    "discover-architecture-boundaries",
    "discover-contribution",
];

/// The longest skill description accepted, counted in characters.
pub const SKILL_DESCRIPTION_MAX_CHARS: usize = 1024;

/// The six project-local skills Discover publishes.
pub const DISCOVER_SKILLS: &[&str] = &[
    "discover-testing-strategy",
    "discover-naming-conventions",
    "discover-coding-conventions",
    "discover-architecture-boundaries",
    "discover-glossary",
    "discover-contribution",
];

fn discover_agent(id: &str) -> Option<&'static AgentDescriptor> {
    DISCOVER_AGENTS
        .iter()
        .find(|descriptor| descriptor.id == id)
}

fn is_discover_skill(name: &str) -> bool {
    DISCOVER_SKILLS.contains(&name)
}

// ------------------------------------------------------------------ paths

fn discover_root(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".omp").join("discover")
}

fn staging_root(repo_dir: &Path) -> PathBuf {
    discover_root(repo_dir).join("staging")
}

fn staging_directory(repo_dir: &Path, run_id: &str) -> PathBuf {
    staging_root(repo_dir).join(run_id)
}

fn live_skills_root(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".omp").join("skills")
}

fn baseline_path(repo_dir: &Path, name: &str) -> PathBuf {
    discover_root(repo_dir)
        .join("skills")
        .join(name)
        .join("SKILL.md")
}

fn live_skill_path(repo_dir: &Path, name: &str) -> PathBuf {
    live_skills_root(repo_dir).join(name).join("SKILL.md")
}

fn glossary_path(repo_dir: &Path, context: &str) -> PathBuf {
    discover_root(repo_dir)
        .join("glossary")
        .join(format!("{context}.glossary.yaml"))
}

fn significance_path(repo_dir: &Path) -> PathBuf {
    discover_root(repo_dir).join("significance.json")
}

fn remove_staging(repo_dir: &Path, run_id: &str) {
    let _ = fs::remove_dir_all(staging_directory(repo_dir, run_id));
    remove_staging_root_if_empty(repo_dir);
}

/// Removes the staging a restored run left behind. The run is always restarted
/// with a fresh staging directory, so the interrupted one never outlives the
/// restore.
fn remove_interrupted_staging(staging_dir: &Path) {
    if staging_dir.as_os_str().is_empty() {
        return;
    }
    let _ = fs::remove_dir_all(staging_dir);
    if let Some(parent) = staging_dir.parent() {
        if let Ok(mut entries) = fs::read_dir(parent) {
            if entries.next().is_none() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
}

fn remove_staging_root_if_empty(repo_dir: &Path) {
    let root = staging_root(repo_dir);
    if let Ok(mut entries) = fs::read_dir(&root) {
        if entries.next().is_none() {
            let _ = fs::remove_dir(&root);
        }
    }
}

// --------------------------------------------------------------- utility

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn iso_now() -> String {
    iso_time(OffsetDateTime::now_utc())
}

fn iso_time(time: OffsetDateTime) -> String {
    const FORMAT: &[FormatItem<'static>] =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    time.format(FORMAT)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

fn iso_from_millis(millis: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .map(iso_time)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/// Parses one ISO 8601 timestamp into UTC milliseconds.
fn parse_iso_millis(text: &str) -> Option<i64> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})$",
        )
        .expect("an ISO timestamp")
    });
    let captures = PATTERN.captures(text.trim())?;
    let number = |index: usize| -> i64 {
        captures
            .get(index)
            .and_then(|capture| capture.as_str().parse().ok())
            .unwrap_or(0)
    };
    let mut year = number(1);
    let month = number(2);
    let day = number(3);
    let hour = number(4);
    let minute = number(5);
    let second = number(6);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let fraction = captures
        .get(7)
        .map(|capture| {
            let digits = capture.as_str();
            let mut padded = digits.to_string();
            while padded.len() < 3 {
                padded.push('0');
            }
            padded[..3].parse::<i64>().unwrap_or(0)
        })
        .unwrap_or(0);
    let zone = captures.get(8)?.as_str();
    let offset_minutes = if zone.eq_ignore_ascii_case("z") {
        0
    } else {
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let hours: i64 = zone.get(1..3)?.parse().ok()?;
        let minutes: i64 = zone.get(4..6)?.parse().ok()?;
        sign * (hours * 60 + minutes)
    };
    if month <= 2 {
        year -= 1;
    }
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + fraction)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.iter().rev().map(|byte| *byte as char).collect()
}

/// The run id every Discover run names its staging directory with.
fn new_run_id() -> String {
    let random: u32 = rand::random();
    format!("run-{}-{:06x}", base36(now_millis()), random & 0x00ff_ffff)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn single_line(value: &str) -> bool {
    !value.contains('\n') && !value.contains('\r')
}

/// Sentence terminators, the way `[.!?](?=\s|$)` matches without lookahead.
fn sentence_terminators(text: &str) -> usize {
    let characters: Vec<char> = text.chars().collect();
    characters
        .iter()
        .enumerate()
        .filter(|(index, character)| {
            matches!(character, '.' | '!' | '?')
                && characters
                    .get(index + 1)
                    .map(|next| next.is_whitespace())
                    .unwrap_or(true)
        })
        .count()
}

fn secret_patterns() -> &'static Vec<Regex> {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
            r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b",
            r"\bsk-[A-Za-z0-9_-]{16,}\b",
            r"\bAKIA[0-9A-Z]{16}\b",
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
            r":\/\/[^\s/@:]+:[^\s/@:]+@",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("a secret pattern"))
        .collect()
    });
    &PATTERNS
}

fn has_secret(value: &str) -> bool {
    secret_patterns()
        .iter()
        .any(|pattern| pattern.is_match(value))
}

fn absolute_path_pattern() -> &'static Regex {
    static PATTERN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:/|[A-Za-z]:[\\/]|\\\\)").expect("an absolute path"));
    &PATTERN
}

fn is_absolute_path(value: &str) -> bool {
    absolute_path_pattern().is_match(value)
}

fn contains_absolute_host_path(text: &str) -> bool {
    if is_absolute_path(text) {
        return true;
    }
    static HOST_PATH: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?:^|[\s"'(=:])/(?:home|Users|etc|var|tmp|opt|usr|root|private)/[^\s]*"#)
            .expect("a host path")
    });
    static DRIVE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[A-Za-z]:[\\/]").expect("a drive path"));
    static UNC: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?:^|[\s"'(=:])\\\\[^\s]+"#).expect("a UNC path"));
    let host = &*HOST_PATH;
    let drive = &*DRIVE;
    let unc = &*UNC;
    host.is_match(text) || drive.is_match(text) || unc.is_match(text)
}

fn invalid(path: &str, rule: impl AsRef<str>) -> String {
    format!("{path}: {}", rule.as_ref())
}

/// One bounded single-line string, refusing the shapes an artifact may not carry.
fn text_value(value: &Value, path: &str, max: usize) -> Result<String, String> {
    let Some(text) = value.as_str() else {
        return Err(invalid(path, "must be a string"));
    };
    let text = text.trim();
    if text.is_empty() {
        return Err(invalid(path, "must not be empty"));
    }
    if !single_line(text) {
        return Err(invalid(path, "must be a single line"));
    }
    if text.chars().count() > max {
        return Err(invalid(path, format!("must be at most {max} characters")));
    }
    if is_absolute_path(text) {
        return Err(invalid(path, "must not be an absolute path"));
    }
    if text.starts_with("home/") || text.starts_with("Users/") {
        return Err(invalid(path, "must not carry an absolute host path"));
    }
    if text.contains(":\\") {
        return Err(invalid(path, "must not carry an absolute host path"));
    }
    if has_secret(text) {
        return Err(invalid(path, "must not carry a secret value"));
    }
    Ok(text.to_string())
}

fn evidence_list(value: &Value, path: &str) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list of strings"));
    };
    let mut entries = std::collections::BTreeSet::new();
    for (index, entry) in items.iter().enumerate() {
        let entry_path = format!("{path}[{index}]");
        let text = text_value(entry, &entry_path, 160)?;
        if text.contains("://") {
            return Err(invalid(&entry_path, "must not be a URL"));
        }
        if text.split('/').any(|segment| segment == "..") {
            return Err(invalid(&entry_path, "must stay inside the host"));
        }
        entries.insert(text);
    }
    Ok(entries.into_iter().collect())
}

fn record_texts(value: &Value, path: &str) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list of strings"));
    };
    if items.len() > 64 {
        return Err(invalid(path, "has too many entries"));
    }
    let mut entries = std::collections::BTreeSet::new();
    for (index, entry) in items.iter().enumerate() {
        entries.insert(text_value(entry, &format!("{path}[{index}]"), 160)?);
    }
    Ok(entries.into_iter().collect())
}

/// Fields one record may carry and the validators each requires.
type FieldValidator = fn(&Value, &str) -> Result<Value, String>;

/// Validates one record against its declared fields, refusing unknown keys.
fn record_fields(
    entry: &Value,
    path: &str,
    required: &[(&str, FieldValidator)],
    optional: &[(&str, FieldValidator)],
) -> Result<Map<String, Value>, String> {
    let Some(record) = entry.as_object() else {
        return Err(invalid(path, "must be an object"));
    };
    let known: HashSet<&str> = required
        .iter()
        .chain(optional.iter())
        .map(|(key, _)| *key)
        .collect();
    for key in record.keys() {
        if !known.contains(key.as_str()) {
            return Err(invalid(&format!("{path}.{key}"), "is not a declared field"));
        }
    }
    let mut result = Map::new();
    for (key, validate) in required {
        match record.get(*key) {
            Some(value) => {
                result.insert(key.to_string(), validate(value, &format!("{path}.{key}"))?);
            }
            None => return Err(invalid(&format!("{path}.{key}"), "is required")),
        }
    }
    for (key, validate) in optional {
        if let Some(value) = record.get(*key) {
            result.insert(key.to_string(), validate(value, &format!("{path}.{key}"))?);
        }
    }
    Ok(result)
}

fn plain_text(value: &Value, path: &str) -> Result<Value, String> {
    Ok(Value::String(text_value(value, path, 160)?))
}

fn plain_texts(value: &Value, path: &str) -> Result<Value, String> {
    Ok(Value::Array(
        record_texts(value, path)?
            .into_iter()
            .map(Value::String)
            .collect(),
    ))
}

// ------------------------------------------------------------------ leaves

#[derive(Clone, Copy)]
enum LeafKind {
    Text,
    Sentence,
    Texts,
    Routes,
    QualityGates,
    Enum(&'static [&'static str]),
}

const DEPLOYMENT_CLASSES: &[&str] = &[
    "package",
    "container",
    "static-site",
    "service",
    "cli",
    "library",
    "plugin",
    "none",
];
const BRANCH_MODELS: &[&str] = &["direct", "pull-request", "git-flow"];
const TEST_LEVELS: &[&str] = &["unit", "integration", "end-to-end", "contract", "other"];
const CONFIDENCES: &[&str] = &["observed", "declared", "inferred", "unknown"];

struct LeafBase {
    confidence: String,
    reason: Option<String>,
    evidence: Vec<Value>,
}

fn leaf_base(node: &Value, path: &str) -> Result<LeafBase, String> {
    let Some(record) = node.as_object() else {
        return Err(invalid(path, "must be a leaf object"));
    };
    let declared = record.get("confidence").and_then(Value::as_str);
    let Some(confidence) = declared else {
        return Err(invalid(
            &format!("{path}.confidence"),
            "must be observed, declared, inferred, or unknown",
        ));
    };
    if !CONFIDENCES.contains(&confidence) {
        return Err(invalid(
            &format!("{path}.confidence"),
            "must be observed, declared, inferred, or unknown",
        ));
    }
    if confidence == "unknown" {
        if !record.get("value").map(Value::is_null).unwrap_or(false) {
            return Err(invalid(
                &format!("{path}.value"),
                "must be null when confidence is unknown",
            ));
        }
        let evidence_empty = record
            .get("evidence")
            .and_then(Value::as_array)
            .map(|items| items.is_empty())
            .unwrap_or(false);
        if !evidence_empty {
            return Err(invalid(
                &format!("{path}.evidence"),
                "must be empty when confidence is unknown",
            ));
        }
        let Some(reason) = record.get("reason").and_then(Value::as_str) else {
            return Err(invalid(
                &format!("{path}.reason"),
                "must name why the value is unknown",
            ));
        };
        let reason = reason.trim();
        if reason.is_empty() {
            return Err(invalid(
                &format!("{path}.reason"),
                "must name why the value is unknown",
            ));
        }
        if !single_line(reason) || reason.chars().count() > 200 {
            return Err(invalid(
                &format!("{path}.reason"),
                "must be one line of at most 200 characters",
            ));
        }
        if has_secret(reason) {
            return Err(invalid(
                &format!("{path}.reason"),
                "must not carry a secret value",
            ));
        }
        return Ok(LeafBase {
            confidence: "unknown".to_string(),
            reason: Some(reason.to_string()),
            evidence: Vec::new(),
        });
    }
    if record.contains_key("reason") {
        return Err(invalid(
            &format!("{path}.reason"),
            "is only allowed when confidence is unknown",
        ));
    }
    let Some(evidence) = record.get("evidence") else {
        return Err(invalid(
            &format!("{path}.evidence"),
            "must ground a non-unknown value",
        ));
    };
    let evidence = evidence_list(evidence, &format!("{path}.evidence"))?;
    if evidence.is_empty() {
        return Err(invalid(
            &format!("{path}.evidence"),
            "must ground a non-unknown value",
        ));
    }
    if evidence.len() > 32 {
        return Err(invalid(&format!("{path}.evidence"), "has too many entries"));
    }
    Ok(LeafBase {
        confidence: confidence.to_string(),
        reason: None,
        evidence: evidence.into_iter().map(Value::String).collect(),
    })
}

fn leaf_value(kind: LeafKind, node: &Value, path: &str) -> Result<Value, String> {
    let base = leaf_base(node, path)?;
    let unknown = base.confidence == "unknown";
    let raw = || node.get("value").cloned().unwrap_or(Value::Null);
    let value = if unknown {
        Value::Null
    } else {
        match kind {
            LeafKind::Text => Value::String(text_value(
                node.get("value").unwrap_or(&Value::Null),
                &format!("{path}.value"),
                160,
            )?),
            LeafKind::Sentence => Value::String(one_sentence(
                node.get("value").unwrap_or(&Value::Null),
                &format!("{path}.value"),
            )?),
            LeafKind::Texts => Value::Array(
                record_texts(
                    node.get("value").unwrap_or(&Value::Null),
                    &format!("{path}.value"),
                )?
                .into_iter()
                .map(Value::String)
                .collect(),
            ),
            LeafKind::Routes => Value::Array(
                route_texts(
                    node.get("value").unwrap_or(&Value::Null),
                    &format!("{path}.value"),
                )?
                .into_iter()
                .map(Value::String)
                .collect(),
            ),
            LeafKind::QualityGates => Value::Array(
                quality_gates(
                    node.get("value").unwrap_or(&Value::Null),
                    &format!("{path}.value"),
                )?
                .into_iter()
                .collect(),
            ),
            LeafKind::Enum(values) => {
                let value = raw();
                let text = value.as_str().unwrap_or_default();
                if !values.contains(&text) {
                    return Err(invalid(
                        &format!("{path}.value"),
                        format!("must be one of {}", values.join(", ")),
                    ));
                }
                Value::String(text.to_string())
            }
        }
    };
    let mut out = Map::new();
    out.insert("value".to_string(), value);
    out.insert("confidence".to_string(), Value::String(base.confidence));
    if let Some(reason) = base.reason {
        out.insert("reason".to_string(), Value::String(reason));
    }
    out.insert("evidence".to_string(), Value::Array(base.evidence));
    Ok(Value::Object(out))
}

fn leaf_field(
    kind: LeafKind,
    node: Option<&Value>,
    section: &str,
    key: &str,
) -> Result<Value, String> {
    let path = format!("{section}.{key}");
    match node {
        Some(value) => leaf_value(kind, value, &path),
        None => Err(invalid(&path, "is required")),
    }
}

/// One HTTP route, optionally prefixed with its method.
fn route_text(value: &Value, path: &str) -> Result<String, String> {
    let Some(raw) = value.as_str() else {
        return Err(invalid(path, "must be a string"));
    };
    let text = raw.trim();
    if text.is_empty() {
        return Err(invalid(path, "must not be empty"));
    }
    if !single_line(text) {
        return Err(invalid(path, "must be a single line"));
    }
    if text.chars().count() > 160 {
        return Err(invalid(path, "must be at most 160 characters"));
    }
    if text.contains("://") {
        return Err(invalid(path, "must not be a URL"));
    }
    static METHOD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)\s+")
            .expect("a route method")
    });
    let method = &*METHOD;
    let route = method.replace(text, "");
    if route.starts_with('~') {
        return Err(invalid(path, "must not carry a home directory"));
    }
    if route.starts_with("//")
        || route.starts_with("\\\\")
        || Regex::new(r"^[A-Za-z]:[\\/]")
            .expect("a drive path")
            .is_match(&route)
    {
        return Err(invalid(path, "must not carry an absolute host path"));
    }
    static HOME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^/(?:home|Users)/[^/]+(?:/|$)").expect("a home path"));
    let home = &*HOME;
    if home.is_match(&route) {
        return Err(invalid(path, "must not carry an absolute host path"));
    }
    if route.split('/').any(|segment| segment == "..") {
        return Err(invalid(path, "must stay inside the host"));
    }
    if has_secret(text) {
        return Err(invalid(path, "must not carry a secret value"));
    }
    Ok(text.to_string())
}

fn route_texts(value: &Value, path: &str) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list of strings"));
    };
    if items.len() > 64 {
        return Err(invalid(path, "has too many entries"));
    }
    let mut entries = std::collections::BTreeSet::new();
    for (index, entry) in items.iter().enumerate() {
        entries.insert(route_text(entry, &format!("{path}[{index}]"))?);
    }
    Ok(entries.into_iter().collect())
}

fn one_sentence(value: &Value, path: &str) -> Result<String, String> {
    let text = text_value(value, path, 240)?;
    let count = sentence_terminators(&text);
    if count != 1
        || !text
            .chars()
            .last()
            .map(|last| matches!(last, '.' | '!' | '?'))
            .unwrap_or(false)
    {
        return Err(invalid(path, "must be exactly one sentence"));
    }
    Ok(text)
}

fn quality_gates(value: &Value, path: &str) -> Result<Vec<Value>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list"));
    };
    if items.len() > 64 {
        return Err(invalid(path, "has too many entries"));
    }
    let mut gates: Vec<(String, Value)> = Vec::new();
    let mut seen = HashSet::new();
    for (index, entry) in items.iter().enumerate() {
        let entry_path = format!("{path}[{index}]");
        let gate = if entry.is_string() {
            let name = text_value(entry, &entry_path, 160)?;
            json!({"name": name, "checks": ""})
        } else {
            let fields = record_fields(
                entry,
                &entry_path,
                &[("name", plain_text), ("checks", plain_text)],
                &[],
            )?;
            Value::Object(fields)
        };
        let name = gate
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !seen.insert(name.clone()) {
            return Err(invalid(&format!("{entry_path}.name"), "must be unique"));
        }
        gates.push((name, gate));
    }
    gates.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(gates.into_iter().map(|(_, gate)| gate).collect())
}

fn sorted_records(
    value: &Value,
    path: &str,
    validate: impl Fn(&Value, &str) -> Result<(String, Value), String>,
) -> Result<Value, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list"));
    };
    if items.len() > 64 {
        return Err(invalid(path, "has too many entries"));
    }
    let mut entries = Vec::new();
    for (index, entry) in items.iter().enumerate() {
        entries.push(validate(entry, &format!("{path}[{index}]"))?);
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(Value::Array(
        entries.into_iter().map(|(_, entry)| entry).collect(),
    ))
}

fn context_entry(entry: &Value, path: &str) -> Result<(String, Value), String> {
    let fields = record_fields(
        entry,
        path,
        &[
            ("name", plain_text),
            ("path", plain_text),
            ("responsibility", plain_text),
            ("entryPoints", plain_texts),
        ],
        &[],
    )?;
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok((name, Value::Object(fields)))
}

fn environment_entry(entry: &Value, path: &str) -> Result<(String, Value), String> {
    let fields = record_fields(
        entry,
        path,
        &[("name", plain_text), ("purpose", plain_text)],
        &[],
    )?;
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok((name, Value::Object(fields)))
}

fn dependency_entry(entry: &Value, path: &str) -> Result<(String, Value), String> {
    let fields = record_fields(
        entry,
        path,
        &[("from", plain_text), ("to", plain_text)],
        &[],
    )?;
    let from = fields
        .get("from")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let to = fields
        .get("to")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok((format!("{from}\u{0}{to}"), Value::Object(fields)))
}

fn level_entry(entry: &Value, path: &str) -> Result<(String, Value), String> {
    let fields = record_fields(
        entry,
        path,
        &[
            ("level", plain_text),
            ("tests", plain_text),
            ("paths", plain_texts),
            ("command", plain_text),
            ("fixtures", plain_texts),
        ],
        &[("happyPath", plain_text)],
    )?;
    let level = fields
        .get("level")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !TEST_LEVELS.contains(&level) {
        return Err(invalid(
            &format!("{path}.level"),
            format!("must be one of {}", TEST_LEVELS.join(", ")),
        ));
    }
    let tests = fields
        .get("tests")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<i64>().ok());
    let happy = fields
        .get("happyPath")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<i64>().ok());
    if let (Some(tests), Some(happy)) = (tests, happy) {
        if happy > tests {
            return Err(invalid(
                &format!("{path}.happyPath"),
                "must not exceed the level's test count",
            ));
        }
    }
    Ok((level.to_string(), Value::Object(fields)))
}

// ------------------------------------------------------------------- sheet

const DISCOVER_SHEET_SECTIONS: &[&str] = &[
    "definition",
    "stack",
    "deployment",
    "environments",
    "commands",
    "branching",
    "testing",
    "architecture",
    "ci",
    "runtime",
    "dependencyMap",
    "delivery",
];

const MANIFEST_COMMANDS: &[&str] = &[
    "install",
    "build",
    "test",
    "lint",
    "typecheck",
    "dev",
    "tryOut",
    "release",
];

fn section_record<'a>(raw: &'a Value, key: &str) -> Result<&'a Map<String, Value>, String> {
    match raw.get(key) {
        Some(Value::Object(section)) => Ok(section),
        _ => Err(invalid(key, "must be an object")),
    }
}

fn section_refuse_unknown(
    section: &Map<String, Value>,
    key: &str,
    known: &[&str],
) -> Result<(), String> {
    for field in section.keys() {
        if !known.contains(&field.as_str()) {
            return Err(invalid(
                &format!("{key}.{field}"),
                "is not a declared field",
            ));
        }
    }
    Ok(())
}

/// Validates one section of leaf fields, in the declared field order.
fn leaf_section(
    raw: &Value,
    key: &str,
    fields: &[(&str, LeafKind, bool)],
) -> Result<Map<String, Value>, String> {
    let section = section_record(raw, key)?;
    section_refuse_unknown(
        section,
        key,
        &fields.iter().map(|(name, _, _)| *name).collect::<Vec<_>>(),
    )?;
    let mut out = Map::new();
    for (name, kind, optional) in fields {
        match section.get(*name) {
            Some(value) => {
                out.insert(
                    name.to_string(),
                    leaf_value(*kind, value, &format!("{key}.{name}"))?,
                );
            }
            None => {
                if !optional {
                    return Err(invalid(&format!("{key}.{name}"), "is required"));
                }
            }
        }
    }
    Ok(out)
}

fn validate_dependency_edges(architecture: &Map<String, Value>) -> Result<(), String> {
    let Some(dependencies) = architecture.get("dependencies") else {
        return Ok(());
    };
    let unknown = dependencies
        .get("confidence")
        .and_then(Value::as_str)
        .map(|value| value == "unknown")
        .unwrap_or(false);
    if unknown {
        return Ok(());
    }
    let Some(contexts) = architecture.get("contexts") else {
        return Ok(());
    };
    let names: HashSet<String> = contexts
        .get("value")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| entry.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let edges = dependencies
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = HashSet::new();
    for (index, edge) in edges.iter().enumerate() {
        let (Some(from), Some(to)) = (
            edge.get("from").and_then(Value::as_str),
            edge.get("to").and_then(Value::as_str),
        ) else {
            return Err(invalid(
                &format!("architecture.dependencies.value[{index}]"),
                "must carry a from and a to context",
            ));
        };
        if from == to {
            return Err(invalid(
                &format!("architecture.dependencies.value[{index}].to"),
                "must differ from the source context",
            ));
        }
        for (field_name, name) in [("from", from), ("to", to)] {
            if !names.contains(name) {
                return Err(invalid(
                    &format!("architecture.dependencies.value[{index}].{field_name}"),
                    format!("must name a bounded context; \"{name}\" is not one"),
                ));
            }
        }
        if !seen.insert((from.to_string(), to.to_string())) {
            return Err(invalid(
                &format!("architecture.dependencies.value[{index}]"),
                format!("repeats the dependency {from} -> {to}"),
            ));
        }
    }
    Ok(())
}

/// Canonicalizes the staged sheet into the published shape.
pub fn normalize_sheet(raw: &Value, freshness: &Value) -> Result<Value, String> {
    if !is_record(raw) {
        return Err(invalid("sheet", "must be an object"));
    }
    let known: HashSet<&str> = std::iter::once("schemaVersion")
        .chain(DISCOVER_SHEET_SECTIONS.iter().copied())
        .collect();
    for key in raw
        .as_object()
        .map(|object| object.keys())
        .into_iter()
        .flatten()
    {
        if !known.contains(key.as_str()) {
            return Err(invalid(key, "is not a declared field"));
        }
    }
    if raw.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("schemaVersion", "must be 1"));
    }
    for section in DISCOVER_SHEET_SECTIONS {
        if raw.get(*section).is_none() {
            return Err(invalid(section, "is required"));
        }
    }

    let architecture = {
        let section = section_record(raw, "architecture")?;
        section_refuse_unknown(
            section,
            "architecture",
            &[
                "contexts",
                "dependencies",
                "dependencyDirection",
                "externalBoundaries",
                "sharedKernels",
            ],
        )?;
        let mut out = Map::new();
        for (name, kind, optional) in [
            ("contexts", LeafKind::Texts, false),
            ("dependencyDirection", LeafKind::Text, false),
            ("externalBoundaries", LeafKind::Texts, false),
            ("sharedKernels", LeafKind::Texts, false),
        ] {
            match section.get(name) {
                Some(node) if name == "contexts" => {
                    out.insert(
                        name.to_string(),
                        leaf_records_value(node, "architecture.contexts", context_entry)?,
                    );
                }
                Some(node) => {
                    out.insert(
                        name.to_string(),
                        leaf_value(kind, node, &format!("architecture.{name}"))?,
                    );
                }
                None if optional => {}
                None => return Err(invalid(&format!("architecture.{name}"), "is required")),
            }
        }
        if let Some(node) = section.get("dependencies") {
            out.insert(
                "dependencies".to_string(),
                leaf_records_value(node, "architecture.dependencies", dependency_entry)?,
            );
        }
        validate_dependency_edges(&out)?;
        out
    };

    let mut sheet = Map::new();
    sheet.insert("schemaVersion".to_string(), json!(1));
    sheet.insert("freshness".to_string(), freshness.clone());
    sheet.insert(
        "definition".to_string(),
        leaf_field(
            LeafKind::Sentence,
            raw.get("definition"),
            "definition",
            "definition",
        )
        .map_err(|error| error.replace("definition.definition", "definition"))?,
    );
    sheet.insert(
        "stack".to_string(),
        leaf_field(LeafKind::Texts, raw.get("stack"), "stack", "stack")
            .map_err(|error| error.replace("stack.stack", "stack"))?,
    );
    sheet.insert(
        "deployment".to_string(),
        Value::Object(leaf_section(
            raw,
            "deployment",
            &[
                ("class", LeafKind::Enum(DEPLOYMENT_CLASSES), false),
                ("artifact", LeafKind::Text, false),
                ("target", LeafKind::Text, false),
                ("pipelineSources", LeafKind::Texts, false),
            ],
        )?),
    );
    sheet.insert(
        "environments".to_string(),
        match raw.get("environments") {
            Some(node) => leaf_records_value(node, "environments", environment_entry)?,
            None => return Err(invalid("environments", "is required")),
        },
    );
    sheet.insert(
        "commands".to_string(),
        Value::Object({
            let mut out = Map::new();
            for name in MANIFEST_COMMANDS {
                out.insert(
                    name.to_string(),
                    leaf_field(
                        LeafKind::Text,
                        raw.get("commands").and_then(|section| section.get(*name)),
                        "commands",
                        name,
                    )?,
                );
            }
            let section = section_record(raw, "commands")?;
            section_refuse_unknown(section, "commands", MANIFEST_COMMANDS)?;
            out
        }),
    );
    sheet.insert(
        "branching".to_string(),
        Value::Object(leaf_section(
            raw,
            "branching",
            &[
                ("defaultBranch", LeafKind::Text, false),
                ("mergeMethod", LeafKind::Text, false),
                ("releaseBranches", LeafKind::Texts, false),
                ("model", LeafKind::Enum(BRANCH_MODELS), false),
            ],
        )?),
    );
    sheet.insert(
        "testing".to_string(),
        Value::Object({
            let section = section_record(raw, "testing")?;
            section_refuse_unknown(section, "testing", &["levels", "pyramid"])?;
            let mut out = Map::new();
            match section.get("levels") {
                Some(node) => out.insert(
                    "levels".to_string(),
                    leaf_records_value(node, "testing.levels", level_entry)?,
                ),
                None => return Err(invalid("testing.levels", "is required")),
            };
            match section.get("pyramid") {
                Some(node) => {
                    out.insert(
                        "pyramid".to_string(),
                        leaf_value(LeafKind::Text, node, "testing.pyramid")?,
                    );
                }
                None => return Err(invalid("testing.pyramid", "is required")),
            }
            out
        }),
    );
    sheet.insert("architecture".to_string(), Value::Object(architecture));
    sheet.insert(
        "ci".to_string(),
        Value::Object(leaf_section(
            raw,
            "ci",
            &[
                ("provider", LeafKind::Text, false),
                ("triggers", LeafKind::Texts, false),
                ("jobs", LeafKind::Texts, false),
                ("qualityGates", LeafKind::QualityGates, false),
                ("artifacts", LeafKind::Texts, false),
            ],
        )?),
    );
    sheet.insert(
        "runtime".to_string(),
        Value::Object(leaf_section(
            raw,
            "runtime",
            &[
                ("languages", LeafKind::Texts, false),
                ("runtimes", LeafKind::Texts, false),
                ("packageManagers", LeafKind::Texts, false),
                ("versions", LeafKind::Texts, false),
                ("manifests", LeafKind::Texts, false),
            ],
        )?),
    );
    sheet.insert(
        "dependencyMap".to_string(),
        Value::Object(leaf_section(
            raw,
            "dependencyMap",
            &[
                ("binaries", LeafKind::Texts, false),
                ("packages", LeafKind::Texts, false),
                ("routes", LeafKind::Routes, false),
                ("jobs", LeafKind::Texts, false),
                ("externalServices", LeafKind::Texts, false),
                ("dataStores", LeafKind::Texts, false),
                ("keyDependencies", LeafKind::Texts, false),
            ],
        )?),
    );
    sheet.insert(
        "delivery".to_string(),
        Value::Object(leaf_section(
            raw,
            "delivery",
            &[
                ("artifactTarget", LeafKind::Text, false),
                ("releaseChannels", LeafKind::Texts, false),
                ("versionScheme", LeafKind::Text, false),
                ("migrationPolicy", LeafKind::Text, false),
            ],
        )?),
    );
    Ok(Value::Object(sheet))
}

/// A leaf whose value is a list of records, sorted by identity.
fn leaf_records_value(
    node: &Value,
    path: &str,
    validate: impl Fn(&Value, &str) -> Result<(String, Value), String>,
) -> Result<Value, String> {
    let base = leaf_base(node, path)?;
    let unknown = base.confidence == "unknown";
    let value = if unknown {
        Value::Null
    } else {
        sorted_records(
            node.get("value").unwrap_or(&Value::Null),
            &format!("{path}.value"),
            validate,
        )?
    };
    let mut out = Map::new();
    out.insert("value".to_string(), value);
    out.insert("confidence".to_string(), Value::String(base.confidence));
    if let Some(reason) = base.reason {
        out.insert("reason".to_string(), Value::String(reason));
    }
    out.insert("evidence".to_string(), Value::Array(base.evidence));
    Ok(Value::Object(out))
}
// ---------------------------------------------------------------- glossary

#[derive(Clone, Debug)]
pub struct Label {
    pub language: String,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct HiddenLabel {
    pub language: String,
    pub text: String,
    pub reason: String,
    pub rejected_on: String,
}

#[derive(Clone, Debug)]
pub struct Concept {
    pub id: String,
    pub pref_labels: Vec<Label>,
    pub alt_labels: Vec<Label>,
    pub hidden_labels: Vec<HiddenLabel>,
    pub definitions: Vec<Label>,
    pub scope_note: Option<String>,
    pub example: Option<String>,
    pub history_note: Option<String>,
    pub status: String,
    pub origin: String,
    pub standard_ref: Option<String>,
    pub kind: String,
    pub grounding: Vec<String>,
    pub broader: Option<String>,
    pub related: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Glossary {
    pub bounded_context: String,
    pub titles: Vec<Label>,
    pub concepts: Vec<Concept>,
}

const CONCEPT_STATUSES: &[&str] = &[
    "confirmed",
    "unconfirmed",
    "proposed",
    "deprecated",
    "invalidated",
];
const CONCEPT_ORIGINS: &[&str] = &["owner", "standard", "llm"];
const CONCEPT_KINDS: &[&str] = &["entity", "event", "field", "role", "actor", "value", "rule"];

fn kebab_pattern() -> &'static Regex {
    static PATTERN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").expect("kebab"));
    &PATTERN
}

fn date_pattern() -> &'static Regex {
    static PATTERN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").expect("a date"));
    &PATTERN
}

fn label_value(value: &Value, path: &str) -> Result<Label, String> {
    let fields = record_fields(
        value,
        path,
        &[("language", plain_text), ("text", plain_text)],
        &[],
    )?;
    let language = fields
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if language != "en" && language != "de" {
        return Err(invalid(&format!("{path}.language"), "must be en or de"));
    }
    Ok(Label {
        language: language.to_string(),
        text: fields
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

fn label_list(value: &Value, path: &str) -> Result<Vec<Label>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list of labels"));
    };
    let mut labels = Vec::new();
    for (index, entry) in items.iter().enumerate() {
        labels.push(label_value(entry, &format!("{path}[{index}]"))?);
    }
    labels.sort_by(|left, right| {
        left.language
            .cmp(&right.language)
            .then_with(|| left.text.cmp(&right.text))
    });
    let mut seen = HashSet::new();
    for label in &labels {
        if !seen.insert(label.language.clone()) {
            return Err(invalid(path, "carries two labels in one language"));
        }
    }
    Ok(labels)
}

fn hidden_label_list(value: &Value, path: &str) -> Result<Vec<HiddenLabel>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list of hidden labels"));
    };
    let mut labels = Vec::new();
    for (index, entry) in items.iter().enumerate() {
        let entry_path = format!("{path}[{index}]");
        let fields = record_fields(
            entry,
            &entry_path,
            &[
                ("language", plain_text),
                ("text", plain_text),
                ("reason", plain_text),
                ("rejectedOn", plain_text),
            ],
            &[],
        )?;
        let language = fields
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if language != "en" && language != "de" {
            return Err(invalid(
                &format!("{entry_path}.language"),
                "must be en or de",
            ));
        }
        let rejected_on = fields
            .get("rejectedOn")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !date_pattern().is_match(rejected_on) {
            return Err(invalid(
                &format!("{entry_path}.rejectedOn"),
                "must be a YYYY-MM-DD date",
            ));
        }
        labels.push(HiddenLabel {
            language: language.to_string(),
            text: fields
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            reason: fields
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            rejected_on: rejected_on.to_string(),
        });
    }
    labels.sort_by(|left, right| {
        format!("{}:{}", left.language, left.text)
            .cmp(&format!("{}:{}", right.language, right.text))
    });
    Ok(labels)
}

fn model_name_exists(files: &[String], repo_dir: &Path, name: &str) -> bool {
    let escaped = regex::escape(name);
    let pattern =
        Regex::new(&format!(r"(^|[^A-Za-z0-9_]){escaped}([^A-Za-z0-9_]|$)")).expect("a model name");
    let mut budget = 4096;
    for path in files {
        if budget == 0 {
            break;
        }
        budget -= 1;
        let Ok(bytes) = fs::read(repo_dir.join(path)) else {
            continue;
        };
        if bytes.len() > 512 * 1024 || bytes.contains(&0) {
            continue;
        }
        if pattern.is_match(&String::from_utf8_lossy(&bytes)) {
            return true;
        }
    }
    false
}

fn grounding_list(
    value: &Value,
    path: &str,
    repo_dir: &Path,
    files: &[String],
    trust_grounding: bool,
) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list of grounding entries"));
    };
    static MODEL_TOKEN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_.-]*$").expect("a model token"));
    let mut entries = std::collections::BTreeSet::new();
    for (index, entry) in items.iter().enumerate() {
        let entry_path = format!("{path}[{index}]");
        let text = text_value(entry, &entry_path, 300)?;
        if let Some(target) = text.strip_prefix("code:") {
            if is_absolute_path(target) || target.split('/').any(|segment| segment == "..") {
                return Err(invalid(&entry_path, "must name a repository-relative path"));
            }
            if !trust_grounding && !files.iter().any(|file| file == target) {
                return Err(invalid(
                    &entry_path,
                    format!("names {target}, which the host does not carry"),
                ));
            }
        } else if let Some(name) = text.strip_prefix("model:") {
            if !MODEL_TOKEN.is_match(name) {
                return Err(invalid(&entry_path, "must name a model element"));
            }
            if !trust_grounding && !model_name_exists(files, repo_dir, name) {
                return Err(invalid(
                    &entry_path,
                    format!("names {name}, which the host does not carry"),
                ));
            }
        } else {
            return Err(invalid(&entry_path, "must start with code: or model:"));
        }
        entries.insert(text);
    }
    Ok(entries.into_iter().collect())
}

fn optional_concept_text(
    raw: &Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<Option<String>, String> {
    match raw.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(text_value(value, &format!("{path}.{key}"), 500)?)),
    }
}

const CONCEPT_FIELDS: &[&str] = &[
    "id",
    "prefLabels",
    "altLabels",
    "hiddenLabels",
    "definitions",
    "scopeNote",
    "example",
    "historyNote",
    "status",
    "origin",
    "standardRef",
    "kind",
    "grounding",
    "broader",
    "related",
];

const REQUIRED_CONCEPT_FIELDS: &[&str] = &[
    "id",
    "prefLabels",
    "altLabels",
    "hiddenLabels",
    "definitions",
    "status",
    "origin",
    "kind",
    "grounding",
    "related",
];

fn concept_value(
    raw: &Value,
    path: &str,
    repo_dir: &Path,
    files: &[String],
    trust_grounding: bool,
) -> Result<Concept, String> {
    let Some(record) = raw.as_object() else {
        return Err(invalid(path, "must be an object"));
    };
    for key in record.keys() {
        if !CONCEPT_FIELDS.contains(&key.as_str()) {
            return Err(invalid(
                &format!("{path}.{key}"),
                "is not a UbiLang concept field",
            ));
        }
    }
    for required in REQUIRED_CONCEPT_FIELDS {
        if !record.contains_key(*required) {
            return Err(invalid(&format!("{path}.{required}"), "is required"));
        }
    }
    let id = text_value(
        record.get("id").unwrap_or(&Value::Null),
        &format!("{path}.id"),
        120,
    )?;
    if !kebab_pattern().is_match(&id) {
        return Err(invalid(&format!("{path}.id"), "must be kebab-case"));
    }
    let pref_labels = label_list(
        record.get("prefLabels").unwrap_or(&Value::Null),
        &format!("{path}.prefLabels"),
    )?;
    if pref_labels.is_empty() {
        return Err(invalid(
            &format!("{path}.prefLabels"),
            "must carry a preferred label",
        ));
    }
    if !pref_labels.iter().any(|label| label.language == "en") {
        return Err(invalid(
            &format!("{path}.prefLabels"),
            "must carry an English preferred label",
        ));
    }
    let alt_labels = label_list(
        record.get("altLabels").unwrap_or(&Value::Null),
        &format!("{path}.altLabels"),
    )?;
    let hidden_labels = hidden_label_list(
        record.get("hiddenLabels").unwrap_or(&Value::Null),
        &format!("{path}.hiddenLabels"),
    )?;
    let Some(definitions_raw) = record.get("definitions").and_then(Value::as_array) else {
        return Err(invalid(
            &format!("{path}.definitions"),
            "must be a list of labels",
        ));
    };
    let mut definitions = Vec::new();
    for (index, entry) in definitions_raw.iter().enumerate() {
        definitions.push(label_value(entry, &format!("{path}.definitions[{index}]"))?);
    }
    if definitions.is_empty() {
        return Err(invalid(
            &format!("{path}.definitions"),
            "must carry a definition",
        ));
    }
    if !definitions.iter().any(|label| label.language == "en") {
        return Err(invalid(
            &format!("{path}.definitions"),
            "must carry an English definition",
        ));
    }
    definitions.sort_by(|left, right| left.language.cmp(&right.language));
    let status = record
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !CONCEPT_STATUSES.contains(&status) {
        return Err(invalid(
            &format!("{path}.status"),
            format!("must be one of {}", CONCEPT_STATUSES.join(", ")),
        ));
    }
    let origin = record
        .get("origin")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !CONCEPT_ORIGINS.contains(&origin) {
        return Err(invalid(
            &format!("{path}.origin"),
            format!("must be one of {}", CONCEPT_ORIGINS.join(", ")),
        ));
    }
    let kind = record
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !CONCEPT_KINDS.contains(&kind) {
        return Err(invalid(
            &format!("{path}.kind"),
            format!("must be one of {}", CONCEPT_KINDS.join(", ")),
        ));
    }
    let standard_ref = optional_concept_text(record, "standardRef", path)?;
    if origin == "standard" && standard_ref.is_none() {
        return Err(invalid(
            &format!("{path}.standardRef"),
            "is required when origin is standard",
        ));
    }
    let grounding = grounding_list(
        record.get("grounding").unwrap_or(&Value::Null),
        &format!("{path}.grounding"),
        repo_dir,
        files,
        trust_grounding,
    )?;
    if grounding.is_empty() {
        return Err(invalid(
            &format!("{path}.grounding"),
            "must ground the concept",
        ));
    }
    let broader = match record.get("broader") {
        None | Some(Value::Null) => None,
        Some(value) => Some(text_value(value, &format!("{path}.broader"), 120)?),
    };
    let Some(related_raw) = record.get("related").and_then(Value::as_array) else {
        return Err(invalid(
            &format!("{path}.related"),
            "must be a list of concept ids",
        ));
    };
    let mut related = std::collections::BTreeSet::new();
    for (index, entry) in related_raw.iter().enumerate() {
        related.insert(text_value(entry, &format!("{path}.related[{index}]"), 120)?);
    }
    Ok(Concept {
        id,
        pref_labels,
        alt_labels,
        hidden_labels,
        definitions,
        scope_note: optional_concept_text(record, "scopeNote", path)?,
        example: optional_concept_text(record, "example", path)?,
        history_note: optional_concept_text(record, "historyNote", path)?,
        status: status.to_string(),
        origin: origin.to_string(),
        standard_ref,
        kind: kind.to_string(),
        grounding,
        broader,
        related: related.into_iter().collect(),
    })
}

// A YAML subset reader for the one document shape Discover writes.
struct YamlLine {
    indent: usize,
    content: String,
}

fn yaml_lines(text: &str) -> Vec<YamlLine> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        let trimmed_end = raw.trim_end();
        if trimmed_end.trim().is_empty() || trimmed_end.trim_start().starts_with('#') {
            continue;
        }
        let indent = trimmed_end.len() - trimmed_end.trim_start().len();
        lines.push(YamlLine {
            indent,
            content: trimmed_end.trim_start().to_string(),
        });
    }
    lines
}

fn split_key(content: &str) -> Option<(String, String)> {
    let index = content.find(':')?;
    let key = content[..index].trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    Some((key.to_string(), content[index + 1..].trim().to_string()))
}

fn yaml_scalar(text: &str) -> Value {
    let text = text.trim();
    if text == "null" || text == "~" {
        return Value::Null;
    }
    if text == "[]" {
        return Value::Array(Vec::new());
    }
    if text == "{}" {
        return Value::Object(Map::new());
    }
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        if let Ok(value) = serde_json::from_str::<String>(text) {
            return Value::String(value);
        }
        return Value::String(text[1..text.len() - 1].to_string());
    }
    if text.len() >= 2 && text.starts_with('\'') && text.ends_with('\'') {
        return Value::String(text[1..text.len() - 1].replace("''", "'"));
    }
    Value::String(text.to_string())
}

fn parse_yaml_value(lines: &[YamlLine], index: &mut usize, indent: usize) -> Value {
    if *index < lines.len() && lines[*index].content.starts_with("- ") {
        return parse_yaml_sequence(lines, index, indent);
    }
    parse_yaml_mapping(lines, index, indent)
}

fn parse_yaml_mapping(lines: &[YamlLine], index: &mut usize, indent: usize) -> Value {
    let mut out = Map::new();
    while *index < lines.len() {
        let line = &lines[*index];
        if line.indent != indent || line.content.starts_with("- ") {
            break;
        }
        let Some((key, raw_value)) = split_key(&line.content) else {
            break;
        };
        *index += 1;
        if raw_value.is_empty() {
            let next_indent = lines.get(*index).map(|next| next.indent).unwrap_or(0);
            if *index < lines.len() && next_indent > indent {
                out.insert(key, parse_yaml_value(lines, index, next_indent));
            } else {
                out.insert(key, Value::Null);
            }
        } else {
            out.insert(key, yaml_scalar(&raw_value));
        }
    }
    Value::Object(out)
}

fn parse_yaml_sequence(lines: &[YamlLine], index: &mut usize, indent: usize) -> Value {
    let mut out = Vec::new();
    while *index < lines.len() {
        let line = &lines[*index];
        if line.indent != indent || !line.content.starts_with("- ") {
            break;
        }
        let rest = line.content[2..].trim().to_string();
        *index += 1;
        if rest.is_empty() {
            let next_indent = lines.get(*index).map(|next| next.indent).unwrap_or(0);
            if *index < lines.len() && next_indent > indent {
                out.push(parse_yaml_value(lines, index, next_indent));
            } else {
                out.push(Value::Null);
            }
            continue;
        }
        let quoted_scalar = rest.starts_with('"') || rest.starts_with('\'');
        if !quoted_scalar {
            if let Some((key, raw_value)) = split_key(&rest) {
                let mut object = Map::new();
                if raw_value.is_empty() {
                    let next_indent = lines.get(*index).map(|next| next.indent).unwrap_or(0);
                    if *index < lines.len() && next_indent > indent {
                        object.insert(key, parse_yaml_value(lines, index, next_indent));
                    } else {
                        object.insert(key, Value::Null);
                    }
                } else {
                    object.insert(key, yaml_scalar(&raw_value));
                }
                // The item's remaining fields share one indentation level.
                let field_indent = lines
                    .get(*index)
                    .filter(|next| next.indent > indent && !next.content.starts_with("- "))
                    .map(|next| next.indent);
                if let Some(field_indent) = field_indent {
                    if let Value::Object(rest_fields) =
                        parse_yaml_mapping(lines, index, field_indent)
                    {
                        for (field_key, field_value) in rest_fields {
                            object.insert(field_key, field_value);
                        }
                    }
                }
                out.push(Value::Object(object));
            }
        } else {
            out.push(yaml_scalar(&rest));
        }
    }
    Value::Array(out)
}

/// Parses one YAML document with the subset reader Discover's glossary uses.
/// A damaged document yields `Value::Null` rather than an error, so a caller
/// that only needs the record decides what an unusable document means.
pub fn parse_yaml_document(text: &str) -> Value {
    let lines = yaml_lines(text);
    let mut index = 0;
    if lines.is_empty() {
        Value::Null
    } else {
        parse_yaml_value(&lines, &mut index, lines[0].indent)
    }
}

pub fn parse_glossary(
    text: &str,
    source: &str,
    repo_dir: &Path,
    files: &[String],
    trust_grounding: bool,
    staged: bool,
) -> Result<Glossary, String> {
    let lines = yaml_lines(text);
    let mut index = 0;
    let parsed = if lines.is_empty() {
        Value::Null
    } else {
        parse_yaml_value(&lines, &mut index, lines[0].indent)
    };
    if !is_record(&parsed) {
        return Err(invalid(source, "must be one YAML document object"));
    }
    let record = parsed.as_object().expect("a record");
    let known = ["boundedContext", "titles", "concepts"];
    for key in record.keys() {
        if !known.contains(&key.as_str()) {
            return Err(invalid(
                &format!("{source}:{key}"),
                "is not a UbiLang glossary field",
            ));
        }
    }
    let Some(bounded_context) = record.get("boundedContext") else {
        return Err(invalid(&format!("{source}:boundedContext"), "is required"));
    };
    let bounded_context = text_value(bounded_context, &format!("{source}:boundedContext"), 120)?;
    if !kebab_pattern().is_match(&bounded_context) {
        return Err(invalid(
            &format!("{source}:boundedContext"),
            "must be kebab-case",
        ));
    }
    let file_name = Path::new(source)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if file_name != format!("{bounded_context}.glossary.yaml") {
        return Err(invalid(
            &format!("{source}:boundedContext"),
            format!("must match the file name {bounded_context}.glossary.yaml"),
        ));
    }
    let Some(titles_raw) = record.get("titles").and_then(Value::as_array) else {
        return Err(invalid(
            &format!("{source}:titles"),
            "must be a list of labels",
        ));
    };
    let mut titles = Vec::new();
    for (index, entry) in titles_raw.iter().enumerate() {
        titles.push(label_value(entry, &format!("{source}:titles[{index}]"))?);
    }
    let Some(concepts_raw) = record.get("concepts").and_then(Value::as_array) else {
        return Err(invalid(&format!("{source}:concepts"), "must be a list"));
    };
    if concepts_raw.is_empty() {
        return Err(invalid(
            &format!("{source}:concepts"),
            "must carry at least one concept",
        ));
    }
    let mut concepts = Vec::new();
    for (index, entry) in concepts_raw.iter().enumerate() {
        concepts.push(concept_value(
            entry,
            &format!("{source}:concepts[{index}]"),
            repo_dir,
            files,
            trust_grounding,
        )?);
    }
    let mut ids = HashSet::new();
    for concept in &concepts {
        if !ids.insert(concept.id.clone()) {
            return Err(invalid(
                &format!("{source}:concepts"),
                format!("carries duplicate id {}", concept.id),
            ));
        }
        if staged {
            if ["confirmed", "deprecated", "invalidated"].contains(&concept.status.as_str()) {
                return Err(invalid(
                    &format!("{source}:concepts"),
                    format!("writes human status {} for {}", concept.status, concept.id),
                ));
            }
            if concept.status == "unconfirmed" && concept.origin == "llm" {
                return Err(invalid(
                    &format!("{source}:concepts"),
                    format!("cannot mark the llm coinage {} unconfirmed", concept.id),
                ));
            }
            if concept.status == "proposed" && concept.origin != "llm" {
                return Err(invalid(
                    &format!("{source}:concepts"),
                    format!(
                        "cannot propose {} with origin {}",
                        concept.id, concept.origin
                    ),
                ));
            }
        }
    }
    for concept in &concepts {
        if let Some(broader) = &concept.broader {
            if !ids.contains(broader) {
                return Err(invalid(
                    &format!("{source}:concepts.{}.broader", concept.id),
                    format!("names unknown concept {broader}"),
                ));
            }
        }
        for related in &concept.related {
            if !ids.contains(related) {
                return Err(invalid(
                    &format!("{source}:concepts.{}.related", concept.id),
                    format!("names unknown concept {related}"),
                ));
            }
        }
    }
    concepts.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(Glossary {
        bounded_context,
        titles,
        concepts,
    })
}

fn yaml_scalar_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn push_labels(lines: &mut Vec<String>, key: &str, values: &[Label]) {
    if values.is_empty() {
        lines.push(format!("    {key}: []"));
        return;
    }
    lines.push(format!("    {key}:"));
    for label in values {
        lines.push(format!(
            "      - language: {}",
            yaml_scalar_quoted(&label.language)
        ));
        lines.push(format!("        text: {}", yaml_scalar_quoted(&label.text)));
    }
}

/// Deterministic YAML rendering of one canonical glossary document.
pub fn render_glossary(glossary: &Glossary) -> String {
    fn scalar(value: &str) -> String {
        yaml_scalar_quoted(value)
    }
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "boundedContext: {}",
        scalar(&glossary.bounded_context)
    ));
    if glossary.titles.is_empty() {
        lines.push("titles: []".to_string());
    } else {
        lines.push("titles:".to_string());
        for title in &glossary.titles {
            lines.push(format!("  - language: {}", scalar(&title.language)));
            lines.push(format!("    text: {}", scalar(&title.text)));
        }
    }
    lines.push("concepts:".to_string());
    for concept in &glossary.concepts {
        lines.push(format!("  - id: {}", scalar(&concept.id)));
        push_labels(&mut lines, "prefLabels", &concept.pref_labels);
        push_labels(&mut lines, "altLabels", &concept.alt_labels);
        if concept.hidden_labels.is_empty() {
            lines.push("    hiddenLabels: []".to_string());
        } else {
            lines.push("    hiddenLabels:".to_string());
            for hidden in &concept.hidden_labels {
                lines.push(format!("      - language: {}", scalar(&hidden.language)));
                lines.push(format!("        text: {}", scalar(&hidden.text)));
                lines.push(format!("        reason: {}", scalar(&hidden.reason)));
                lines.push(format!(
                    "        rejectedOn: {}",
                    scalar(&hidden.rejected_on)
                ));
            }
        }
        push_labels(&mut lines, "definitions", &concept.definitions);
        let optional = |value: &Option<String>| match value {
            None => "null".to_string(),
            Some(text) => scalar(text),
        };
        lines.push(format!("    scopeNote: {}", optional(&concept.scope_note)));
        lines.push(format!("    example: {}", optional(&concept.example)));
        lines.push(format!(
            "    historyNote: {}",
            optional(&concept.history_note)
        ));
        lines.push(format!("    status: {}", scalar(&concept.status)));
        lines.push(format!("    origin: {}", scalar(&concept.origin)));
        lines.push(format!(
            "    standardRef: {}",
            optional(&concept.standard_ref)
        ));
        lines.push(format!("    kind: {}", scalar(&concept.kind)));
        if concept.grounding.is_empty() {
            lines.push("    grounding: []".to_string());
        } else {
            lines.push("    grounding:".to_string());
            for entry in &concept.grounding {
                lines.push(format!("      - {}", scalar(entry)));
            }
        }
        lines.push(format!("    broader: {}", optional(&concept.broader)));
        if concept.related.is_empty() {
            lines.push("    related: []".to_string());
        } else {
            lines.push("    related:".to_string());
            for entry in &concept.related {
                lines.push(format!("      - {}", scalar(entry)));
            }
        }
    }
    format!("{}\n", lines.join("\n"))
}

fn concept_json(concept: &Concept) -> Value {
    let labels = |values: &[Label]| {
        Value::Array(
            values
                .iter()
                .map(|label| json!({"language": label.language, "text": label.text}))
                .collect(),
        )
    };
    let mut out = Map::new();
    out.insert("id".to_string(), Value::String(concept.id.clone()));
    out.insert("prefLabels".to_string(), labels(&concept.pref_labels));
    out.insert("altLabels".to_string(), labels(&concept.alt_labels));
    out.insert(
        "hiddenLabels".to_string(),
        Value::Array(
            concept
                .hidden_labels
                .iter()
                .map(|hidden| {
                    json!({
                        "language": hidden.language,
                        "text": hidden.text,
                        "reason": hidden.reason,
                        "rejectedOn": hidden.rejected_on,
                    })
                })
                .collect(),
        ),
    );
    out.insert("definitions".to_string(), labels(&concept.definitions));
    out.insert(
        "scopeNote".to_string(),
        concept
            .scope_note
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    out.insert(
        "example".to_string(),
        concept
            .example
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    out.insert(
        "historyNote".to_string(),
        concept
            .history_note
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    out.insert("status".to_string(), Value::String(concept.status.clone()));
    out.insert("origin".to_string(), Value::String(concept.origin.clone()));
    out.insert(
        "standardRef".to_string(),
        concept
            .standard_ref
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    out.insert("kind".to_string(), Value::String(concept.kind.clone()));
    out.insert(
        "grounding".to_string(),
        Value::Array(
            concept
                .grounding
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    out.insert(
        "broader".to_string(),
        concept
            .broader
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    out.insert(
        "related".to_string(),
        Value::Array(concept.related.iter().cloned().map(Value::String).collect()),
    );
    Value::Object(out)
}

pub fn glossary_json(glossary: &Glossary) -> Value {
    json!({
        "boundedContext": glossary.bounded_context,
        "titles": glossary.titles.iter().map(|label| json!({
            "language": label.language,
            "text": label.text,
        })).collect::<Vec<_>>(),
        "concepts": glossary.concepts.iter().map(concept_json).collect::<Vec<_>>(),
    })
}

fn glossary_skeleton(glossary: &Glossary) -> Value {
    json!({
        "boundedContext": glossary.bounded_context,
        "titles": glossary.titles.iter().map(|title| json!({
            "language": title.language,
            "text": "",
        })).collect::<Vec<_>>(),
        "concepts": glossary.concepts.iter().map(|concept| {
            let mut value = concept_json(concept);
            if let Some(object) = value.as_object_mut() {
                if let Some(definitions) = object.get_mut("definitions").and_then(Value::as_array_mut) {
                    for definition in definitions {
                        if let Some(entry) = definition.as_object_mut() {
                            entry.insert("text".to_string(), Value::String(String::new()));
                        }
                    }
                }
                object.insert("scopeNote".to_string(), Value::Null);
                object.insert("historyNote".to_string(), Value::Null);
            }
            value
        }).collect::<Vec<_>>(),
    })
}

pub fn glossary_digest(glossary: &Glossary) -> String {
    sha256_hex(crate::jsjson::stringify(&glossary_skeleton(glossary)).as_bytes())
}

// ------------------------------------------------------------ significance

pub fn parse_significance(
    raw: &Value,
    path: &str,
    glossaries: &[Glossary],
) -> Result<Value, String> {
    if !is_record(raw) {
        return Err(invalid(path, "must be an object"));
    }
    let record = raw.as_object().expect("a record");
    for key in record.keys() {
        if key != "schemaVersion" && key != "contexts" {
            return Err(invalid(path, format!("carries an undeclared key {key}")));
        }
    }
    if record.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(invalid(path, "schemaVersion must be 1"));
    }
    let Some(contexts) = record.get("contexts").and_then(Value::as_object) else {
        return Err(invalid(&format!("{path}.contexts"), "must be an object"));
    };
    let staged: HashMap<&str, &Glossary> = glossaries
        .iter()
        .map(|glossary| (glossary.bounded_context.as_str(), glossary))
        .collect();
    for context in contexts.keys() {
        if !staged.contains_key(context.as_str()) {
            return Err(invalid(
                &format!("{path}.contexts"),
                format!("names the unknown context {context}"),
            ));
        }
    }
    let mut parsed = Map::new();
    for glossary in glossaries {
        let context = glossary.bounded_context.as_str();
        let Some(entries) = contexts.get(context).and_then(Value::as_object) else {
            return Err(invalid(
                &format!("{path}.contexts"),
                format!("has no entry for {context}"),
            ));
        };
        let ids: HashSet<&str> = glossary
            .concepts
            .iter()
            .map(|concept| concept.id.as_str())
            .collect();
        for id in entries.keys() {
            if !ids.contains(id.as_str()) {
                return Err(invalid(
                    &format!("{path}.contexts.{context}"),
                    format!("names the unknown concept {id}"),
                ));
            }
        }
        let mut scored = Map::new();
        let mut sorted_ids: Vec<&str> = ids.into_iter().collect();
        sorted_ids.sort_unstable();
        for id in sorted_ids {
            let trail = format!("{path}.contexts.{context}.{id}");
            let Some(entry) = entries.get(id) else {
                return Err(invalid(&trail, "must be an object"));
            };
            let Some(entry) = entry.as_object() else {
                return Err(invalid(&trail, "must be an object"));
            };
            for key in entry.keys() {
                if key != "score" && key != "reason" {
                    return Err(invalid(&trail, format!("carries an undeclared key {key}")));
                }
            }
            let score = entry.get("score").and_then(Value::as_i64);
            let Some(score) = score.filter(|score| (0..=100).contains(score)) else {
                return Err(invalid(
                    &format!("{trail}.score"),
                    "must be an integer from 0 to 100",
                ));
            };
            let Some(reason) = entry.get("reason").and_then(Value::as_str) else {
                return Err(invalid(&format!("{trail}.reason"), "must be a string"));
            };
            let text = reason.trim();
            if text.is_empty() {
                return Err(invalid(&format!("{trail}.reason"), "must not be empty"));
            }
            if !single_line(text) {
                return Err(invalid(&format!("{trail}.reason"), "must be one line"));
            }
            if text.chars().count() > 160 {
                return Err(invalid(
                    &format!("{trail}.reason"),
                    "must be at most 160 characters",
                ));
            }
            if is_absolute_path(text) {
                return Err(invalid(
                    &format!("{trail}.reason"),
                    "must not be an absolute path",
                ));
            }
            if has_secret(text) {
                return Err(invalid(
                    &format!("{trail}.reason"),
                    "must not carry a secret",
                ));
            }
            scored.insert(id.to_string(), json!({"score": score, "reason": text}));
        }
        parsed.insert(context.to_string(), Value::Object(scored));
    }
    Ok(Value::Object(parsed))
}
// ------------------------------------------------------------------ skills

pub struct SkillFrontmatter {
    pub fields: HashMap<String, String>,
    pub body: String,
}

fn unquote(value: &str) -> String {
    if value.len() >= 2 {
        let first = value.chars().next().unwrap_or(' ');
        let last = value.chars().last().unwrap_or(' ');
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

pub fn parse_skill(source: &str, path: &str) -> Result<SkillFrontmatter, String> {
    if !source.starts_with("---\n") {
        return Err(invalid(path, "must start with YAML frontmatter"));
    }
    let Some(end) = source[4..].find("\n---").map(|offset| offset + 4) else {
        return Err(invalid(path, "must close its frontmatter"));
    };
    let frontmatter = &source[4..end];
    let mut body = &source[end + 4..];
    body = body
        .strip_prefix("\r\n")
        .or_else(|| body.strip_prefix('\n'))
        .unwrap_or(body);
    let mut fields = HashMap::new();
    let mut section = String::new();
    static FIELD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\s*([A-Za-z0-9_.-]+):\s*(.*)$").expect("a frontmatter line")
    });
    for raw_line in frontmatter.split('\n') {
        if raw_line.trim().is_empty() || raw_line.trim_start().starts_with('#') {
            continue;
        }
        let indented = raw_line.starts_with(' ') || raw_line.starts_with('\t');
        let Some(captures) = FIELD.captures(raw_line) else {
            return Err(invalid(
                path,
                format!("cannot read frontmatter line {}", raw_line.trim()),
            ));
        };
        let key = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or("");
        let value = captures
            .get(2)
            .map(|capture| capture.as_str())
            .unwrap_or("")
            .trim();
        if !indented && value.is_empty() {
            section = key.to_string();
            continue;
        }
        let name = if indented && !section.is_empty() {
            format!("{section}.{key}")
        } else {
            key.to_string()
        };
        fields.insert(name, unquote(value));
    }
    Ok(SkillFrontmatter {
        fields,
        body: body.to_string(),
    })
}

#[derive(Clone)]
pub struct StagedSkill {
    pub name: String,
    pub text: String,
    pub body: String,
}

fn validate_skill_text(name: &str, text: &str, path: &str) -> Result<StagedSkill, String> {
    let parsed = parse_skill(text, path)?;
    let declared = parsed.fields.get("name").cloned().unwrap_or_default();
    if declared != name {
        return Err(invalid(
            &format!("{path}:name"),
            format!("must equal the directory name {name}"),
        ));
    }
    if !kebab_pattern().is_match(&declared) {
        return Err(invalid(&format!("{path}:name"), "must be kebab-case"));
    }
    if declared.chars().count() > 64 {
        return Err(invalid(
            &format!("{path}:name"),
            "must be at most 64 characters",
        ));
    }
    let description = parsed
        .fields
        .get("description")
        .cloned()
        .unwrap_or_default();
    if description.trim().is_empty() {
        return Err(invalid(&format!("{path}:description"), "must not be empty"));
    }
    if description.chars().count() > SKILL_DESCRIPTION_MAX_CHARS {
        return Err(invalid(
            &format!("{path}:description"),
            format!("must be at most {SKILL_DESCRIPTION_MAX_CHARS} characters"),
        ));
    }
    if parsed
        .fields
        .get("metadata.devboard-managed")
        .map(String::as_str)
        != Some("true")
    {
        return Err(invalid(
            &format!("{path}:metadata.devboard-managed"),
            "must be \"true\"",
        ));
    }
    if parsed
        .fields
        .get("metadata.devboard-family")
        .map(String::as_str)
        != Some("discover")
    {
        return Err(invalid(
            &format!("{path}:metadata.devboard-family"),
            "must be \"discover\"",
        ));
    }
    let role = parsed
        .fields
        .get("metadata.devboard-skill")
        .cloned()
        .unwrap_or_default();
    if role.trim().is_empty() {
        return Err(invalid(
            &format!("{path}:metadata.devboard-skill"),
            "must name the skill's role",
        ));
    }
    let contribution = name == "discover-contribution";
    if contribution {
        if role != "contribution" {
            return Err(invalid(
                &format!("{path}:metadata.devboard-skill"),
                "must equal \"contribution\"",
            ));
        }
        let sentences = sentence_terminators(&description);
        if !description
            .chars()
            .last()
            .map(|last| matches!(last, '.' | '!' | '?'))
            .unwrap_or(false)
            || sentences != 1
        {
            return Err(invalid(
                &format!("{path}:description"),
                "must be one sentence",
            ));
        }
    }
    if has_secret(&description) || has_secret(&role) || has_secret(&parsed.body) {
        return Err(invalid(path, "must not carry a secret value"));
    }
    if contains_absolute_host_path(&parsed.body) {
        return Err(invalid(path, "must not carry an absolute host path"));
    }
    if parsed.body.trim().is_empty() {
        return Err(invalid(path, "must carry a body"));
    }
    let lines: Vec<&str> = parsed.body.split('\n').collect();
    if contribution {
        let first = lines
            .iter()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim())
            .unwrap_or("");
        if !Regex::new(r"^# \S").expect("a heading").is_match(first) {
            return Err(invalid(path, "body must open with one # heading"));
        }
    }
    let mut bullets = 0;
    static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-*+]\s+").expect("a bullet"));
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if contribution && (line.starts_with("> ") || *line == ">") {
            continue;
        }
        if !BULLET.is_match(line.trim_start()) {
            return Err(invalid(
                path,
                "body prose must be imperative bullets, not paragraphs",
            ));
        }
        bullets += 1;
    }
    if bullets == 0 {
        return Err(invalid(path, "must carry at least one imperative bullet"));
    }
    if contribution
        && parsed.body.contains('>')
        && !Regex::new(r"(?m)^## Exemplars\s*$")
            .expect("a heading")
            .is_match(&parsed.body)
    {
        return Err(invalid(
            path,
            "quoted exemplars must follow a ## Exemplars heading",
        ));
    }
    Ok(StagedSkill {
        name: name.to_string(),
        text: text.to_string(),
        body: parsed.body,
    })
}

#[derive(Clone, Copy)]
enum Polarity {
    Positive,
    Negative,
}

fn directive_text(line: &str) -> String {
    static BULLET: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*[-*+]\s+").expect("a bullet"));
    BULLET.replace(line, "").trim().to_string()
}

fn directives_of(body: &str) -> Vec<(Polarity, String)> {
    static DIRECTIVE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(always|never|must not|must|should not|should|do not|don't|avoid|prefer|use)\s+(.+)$")
            .expect("a directive")
    });
    static MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[`*_]").expect("markup"));
    static TRAILING_PUNCTUATION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[.:;]+$").expect("punctuation"));
    let mut directives = Vec::new();
    for line in body.split('\n') {
        let text = directive_text(line);
        let Some(captures) = DIRECTIVE.captures(&text) else {
            continue;
        };
        let keyword = captures
            .get(1)
            .map(|capture| capture.as_str().to_lowercase())
            .unwrap_or_default();
        let subject = captures
            .get(2)
            .map(|capture| capture.as_str())
            .unwrap_or("");
        let subject = MARKUP.replace_all(&subject.to_lowercase(), "").to_string();
        let subject = TRAILING_PUNCTUATION.replace(&subject, "").to_string();
        let subject = subject.split_whitespace().collect::<Vec<_>>().join(" ");
        if subject.is_empty() {
            continue;
        }
        let negative = [
            "never",
            "must not",
            "should not",
            "do not",
            "don't",
            "avoid",
        ]
        .contains(&keyword.as_str());
        directives.push((
            if negative {
                Polarity::Negative
            } else {
                Polarity::Positive
            },
            subject,
        ));
    }
    directives
}

/// Opposite policies about the same subject, across two skill bodies.
pub fn skill_contradictions(skills: &[(String, String)]) -> Vec<(String, String, String)> {
    let mut contradictions = Vec::new();
    let mut seen = HashSet::new();
    for left in 0..skills.len() {
        for right in left + 1..skills.len() {
            let (left_name, left_body) = &skills[left];
            let (right_name, right_body) = &skills[right];
            for (left_polarity, left_subject) in directives_of(left_body) {
                for (right_polarity, right_subject) in directives_of(right_body) {
                    if matches!(
                        (left_polarity, right_polarity),
                        (Polarity::Positive, Polarity::Positive)
                            | (Polarity::Negative, Polarity::Negative)
                    ) {
                        continue;
                    }
                    if left_subject != right_subject {
                        continue;
                    }
                    let key = format!("{left_name}\u{0}{right_name}\u{0}{left_subject}");
                    if !seen.insert(key) {
                        continue;
                    }
                    contradictions.push((
                        left_name.clone(),
                        right_name.clone(),
                        left_subject.clone(),
                    ));
                }
            }
        }
    }
    contradictions
}

// ----------------------------------------------------------- contribution

const CONTRIBUTION_SECTION_IDS: &[&str] = &[
    "workflow",
    "testing",
    "pull-request-style",
    "pull-request-size",
    "conventions",
    "review",
    "documentation",
    "hotspots",
    "evidence",
];

const WORKFLOW_FACT_KEYS: &[&str] = &[
    "entryPoints",
    "steps",
    "prerequisites",
    "install",
    "build",
    "lint",
    "typecheck",
    "run",
];
const TESTING_FACT_KEYS: &[&str] = &["suite", "levels"];

fn section_label(section: &str) -> &'static str {
    match section {
        "workflow" => "Workflow",
        "testing" => "Testing",
        "pull-request-style" => "Pull request style",
        "pull-request-size" => "Pull request size",
        "conventions" => "Conventions",
        "review" => "Review",
        "documentation" => "Documentation",
        "hotspots" => "Hotspots",
        "evidence" => "Evidence",
        _ => "",
    }
}

fn fact_label(section: &str, key: &str) -> String {
    let label = match (section, key) {
        ("workflow", "entryPoints") => "Contribution entry points",
        ("workflow", "steps") => "Contribution steps",
        ("workflow", "prerequisites") => "Prerequisites",
        ("workflow", "install") => "Install",
        ("workflow", "build") => "Build",
        ("workflow", "lint") => "Lint",
        ("workflow", "typecheck") => "Typecheck",
        ("workflow", "run") => "Run",
        ("testing", "suite") => "Whole suite",
        ("testing", "levels") => "Test levels",
        ("pull-request-style", "titlePatterns") => "Title patterns",
        ("pull-request-style", "titleWords") => "Title words",
        ("pull-request-style", "bodyHeadings") => "Body section headings",
        ("pull-request-style", "bodyWords") => "Body words",
        ("pull-request-style", "bodyLines") => "Body lines",
        ("pull-request-style", "bulletRatio") => "Bullet lines",
        ("pull-request-style", "voice") => "Voice and tense",
        ("pull-request-style", "vocabulary") => "Vocabulary",
        ("pull-request-style", "issueLinking") => "Issue linking",
        ("pull-request-style", "templates") => "Templates",
        ("pull-request-style", "granularity") => "Change granularity",
        ("pull-request-size", "additions") => "Additions",
        ("pull-request-size", "deletions") => "Deletions",
        ("pull-request-size", "filesChanged") => "Files changed",
        ("pull-request-size", "testFileShare") => "Test-file share",
        ("pull-request-size", "largest") => "Largest accepted pull request",
        ("pull-request-size", "testsShare") => "Pull requests that change tests",
        ("pull-request-size", "documentationShare") => "Pull requests that change documentation",
        ("pull-request-size", "testsAndDocumentationShare") => {
            "Pull requests that change tests and documentation"
        }
        ("conventions", "commitSubject") => "Commit subjects",
        ("conventions", "commitBody") => "Commit bodies",
        ("conventions", "branchNaming") => "Branch naming",
        ("conventions", "mergeMethod") => "Merge method",
        ("conventions", "issueReferences") => "Issue references",
        ("review", "requiredApprovals") => "Required approvals",
        ("review", "requiredChecks") => "Required checks",
        ("review", "labels") => "Labels",
        ("review", "draftUsage") => "Draft usage",
        ("review", "mergeMethod") => "Merge method",
        ("documentation", "documentationShare") => "Documentation changes",
        ("documentation", "changelogShare") => "Changelog changes",
        ("documentation", "convention") => "Documentation convention",
        ("hotspots", "directories") => "Directories",
        ("hotspots", "files") => "Files",
        ("hotspots", "typicalFiles") => "Typical file set",
        ("evidence", "forge") => "Forge",
        ("evidence", "host") => "Host",
        ("evidence", "sampleSize") => "Merged sample size",
        ("evidence", "window") => "Merge window",
        ("evidence", "closedUnmerged") => "Closed, unmerged pull requests",
        ("evidence", "unknownFacts") => "Unknown facts",
        _ => key,
    };
    label.to_string()
}

#[derive(Clone)]
pub struct MergedPullRequest {
    pub number: i64,
    pub title: String,
    pub body: String,
    pub merged_at: String,
    pub additions: i64,
    pub deletions: i64,
    pub files_changed: i64,
    pub files: Vec<String>,
    pub test_files: i64,
    pub documentation_files: i64,
    pub labels: Vec<String>,
    pub draft: bool,
    pub approvals: i64,
    pub checks: Vec<String>,
    pub commits: Vec<(String, String)>,
    pub branch: String,
    pub merge_method: String,
    pub references: Vec<i64>,
}

#[derive(Clone)]
pub struct ParsedFact {
    pub key: String,
    pub value: Option<Value>,
    pub evidence: Vec<String>,
    pub confidence: String,
    pub reason: Option<String>,
}

#[derive(Clone)]
pub struct StagedContribution {
    pub forge: Option<String>,
    pub host: Option<String>,
    pub unavailable: Option<String>,
    pub window: Option<(String, String)>,
    pub merged: Vec<MergedPullRequest>,
    pub closed_unmerged: Vec<i64>,
    pub workflow: Vec<ParsedFact>,
    pub testing: Vec<ParsedFact>,
}

fn contribution_string(value: &Value, path: &str, max: usize) -> Result<String, String> {
    let Some(text) = value.as_str() else {
        return Err(invalid(path, "must be a string"));
    };
    if text.chars().count() > max {
        return Err(invalid(path, format!("must be at most {max} characters")));
    }
    if has_secret(text) {
        return Err(invalid(path, "must not carry a secret value"));
    }
    if contains_absolute_host_path(text) {
        return Err(invalid(path, "must not carry an absolute host path"));
    }
    Ok(text.to_string())
}

fn contribution_line(value: &Value, path: &str, max: usize) -> Result<String, String> {
    let text = contribution_string(value, path, max)?;
    if !single_line(&text) {
        return Err(invalid(path, "must be a single line"));
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(invalid(path, "must not be empty"));
    }
    Ok(trimmed.to_string())
}

fn contribution_int(value: &Value, path: &str, min: i64, max: i64) -> Result<i64, String> {
    let number = value.as_i64();
    match number.filter(|number| (min..=max).contains(number)) {
        Some(number) => Ok(number),
        None => Err(invalid(
            path,
            format!("must be an integer between {min} and {max}"),
        )),
    }
}

fn contribution_evidence(value: &Value, path: &str) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list of evidence entries"));
    };
    if items.len() > 32 {
        return Err(invalid(path, "must carry at most 32 entries"));
    }
    static COMMIT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^commit [0-9a-f]{7,40}$").expect("a commit"));
    static PR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^PR #[1-9][0-9]*$").expect("a pull request"));
    let mut entries = std::collections::BTreeSet::new();
    for (index, entry) in items.iter().enumerate() {
        let text = contribution_line(entry, &format!("{path}[{index}]"), 160)?;
        let fixed = matches!(
            text.as_str(),
            "git log" | "git status" | "git branch" | "git ls-files" | "forge records"
        ) || PR.is_match(&text)
            || COMMIT.is_match(&text);
        if !fixed {
            if text.contains("://") {
                return Err(invalid(&format!("{path}[{index}]"), "must not be a URL"));
            }
            if text.split('/').any(|segment| segment == "..") {
                return Err(invalid(
                    &format!("{path}[{index}]"),
                    "must stay inside the host",
                ));
            }
            let excluded = ["omp", "git", "devboard", "worktree"]
                .iter()
                .any(|root| text == format!(".{root}") || text.starts_with(&format!(".{root}/")));
            if excluded {
                return Err(invalid(
                    &format!("{path}[{index}]"),
                    "must not cite an excluded crawl path",
                ));
            }
        }
        entries.insert(text);
    }
    Ok(entries.into_iter().collect())
}

fn contribution_string_list(value: &Value, path: &str, max: usize) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list"));
    };
    if items.len() > max {
        return Err(invalid(path, format!("must carry at most {max} entries")));
    }
    let mut entries = std::collections::BTreeSet::new();
    for (index, entry) in items.iter().enumerate() {
        entries.insert(contribution_line(entry, &format!("{path}[{index}]"), 160)?);
    }
    Ok(entries.into_iter().collect())
}

fn contribution_number_list(value: &Value, path: &str) -> Result<Vec<i64>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "must be a list of numbers"));
    };
    let mut numbers = std::collections::BTreeSet::new();
    for (index, entry) in items.iter().enumerate() {
        numbers.insert(contribution_int(
            entry,
            &format!("{path}[{index}]"),
            1,
            1_000_000_000,
        )?);
    }
    Ok(numbers.into_iter().collect())
}

fn contribution_timestamp(value: &Value, path: &str) -> Result<String, String> {
    let Some(text) = value.as_str().filter(|text| !text.is_empty()) else {
        return Err(invalid(path, "must be an ISO timestamp"));
    };
    match parse_iso_millis(text) {
        Some(millis) => Ok(iso_from_millis(millis)),
        None => Err(invalid(path, "must be an ISO timestamp")),
    }
}

fn contribution_body(value: &Value, path: &str) -> Result<String, String> {
    let Some(text) = value.as_str() else {
        return Err(invalid(path, "must be a string"));
    };
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim().to_string();
    if text.chars().count() > 20_000 {
        return Err(invalid(path, "must be at most 20000 characters"));
    }
    if has_secret(&text) {
        return Err(invalid(path, "must not carry a secret value"));
    }
    if contains_absolute_host_path(&text) {
        return Err(invalid(path, "must not carry an absolute host path"));
    }
    Ok(text)
}

fn contribution_file_path(value: &Value, path: &str) -> Result<String, String> {
    let text = contribution_line(value, path, 512)?;
    let excluded = ["omp", "git", "devboard", "worktree"]
        .iter()
        .any(|root| text == format!(".{root}") || text.starts_with(&format!(".{root}/")));
    if excluded {
        return Err(invalid(path, "must not cite an excluded crawl path"));
    }
    if text.split('/').any(|segment| segment == "..") {
        return Err(invalid(path, "must stay inside the host"));
    }
    Ok(text)
}

fn contribution_record<'a>(
    value: &'a Value,
    path: &str,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let Some(record) = value.as_object() else {
        return Err(invalid(path, "must be an object"));
    };
    for key in record.keys() {
        if !keys.contains(&key.as_str()) {
            return Err(invalid(
                &format!("{path}.{key}"),
                "is not part of this record",
            ));
        }
    }
    Ok(record)
}

fn parse_merged_pull_request(value: &Value, index: usize) -> Result<MergedPullRequest, String> {
    let path = format!("source.mergedPullRequests[{index}]");
    let keys = [
        "number",
        "title",
        "body",
        "mergedAt",
        "additions",
        "deletions",
        "filesChanged",
        "files",
        "testFiles",
        "documentationFiles",
        "labels",
        "draft",
        "approvals",
        "checks",
        "commits",
        "branch",
        "mergeMethod",
        "references",
    ];
    let raw = contribution_record(value, &path, &keys)?;
    let field = |key: &str| raw.get(key).unwrap_or(&Value::Null);
    let files_changed = contribution_int(
        field("filesChanged"),
        &format!("{path}.filesChanged"),
        0,
        100_000,
    )?;
    let Some(file_items) = field("files").as_array() else {
        return Err(invalid(&format!("{path}.files"), "must be a list of paths"));
    };
    if file_items.len() as i64 != files_changed {
        return Err(invalid(
            &format!("{path}.files"),
            "must list exactly filesChanged paths",
        ));
    }
    let mut files = std::collections::BTreeSet::new();
    for (file_index, entry) in file_items.iter().enumerate() {
        files.insert(contribution_file_path(
            entry,
            &format!("{path}.files[{file_index}]"),
        )?);
    }
    if files.len() as i64 != files_changed {
        return Err(invalid(&format!("{path}.files"), "must not repeat a path"));
    }
    let test_files = contribution_int(
        field("testFiles"),
        &format!("{path}.testFiles"),
        0,
        files_changed,
    )?;
    let documentation_files = contribution_int(
        field("documentationFiles"),
        &format!("{path}.documentationFiles"),
        0,
        files_changed,
    )?;
    let Some(commit_items) = field("commits").as_array() else {
        return Err(invalid(&format!("{path}.commits"), "must be a list"));
    };
    if commit_items.len() > 64 {
        return Err(invalid(
            &format!("{path}.commits"),
            "must carry at most 64 commits",
        ));
    }
    let mut commits = Vec::new();
    for (commit_index, entry) in commit_items.iter().enumerate() {
        let commit_path = format!("{path}.commits[{commit_index}]");
        let record = contribution_record(entry, &commit_path, &["subject", "body"])?;
        commits.push((
            contribution_line(
                record.get("subject").unwrap_or(&Value::Null),
                &format!("{commit_path}.subject"),
                300,
            )?,
            contribution_body(
                record.get("body").unwrap_or(&Value::Null),
                &format!("{commit_path}.body"),
            )?,
        ));
    }
    let merge_method = contribution_line(field("mergeMethod"), &format!("{path}.mergeMethod"), 16)?;
    if !["merge", "squash", "rebase"].contains(&merge_method.as_str()) {
        return Err(invalid(
            &format!("{path}.mergeMethod"),
            "must be merge, squash, or rebase",
        ));
    }
    let Some(draft) = field("draft").as_bool() else {
        return Err(invalid(&format!("{path}.draft"), "must be a boolean"));
    };
    Ok(MergedPullRequest {
        number: contribution_int(field("number"), &format!("{path}.number"), 1, 1_000_000_000)?,
        title: contribution_line(field("title"), &format!("{path}.title"), 300)?,
        body: contribution_body(field("body"), &format!("{path}.body"))?,
        merged_at: contribution_timestamp(field("mergedAt"), &format!("{path}.mergedAt"))?,
        additions: contribution_int(
            field("additions"),
            &format!("{path}.additions"),
            0,
            100_000_000,
        )?,
        deletions: contribution_int(
            field("deletions"),
            &format!("{path}.deletions"),
            0,
            100_000_000,
        )?,
        files_changed,
        files: files.into_iter().collect(),
        test_files,
        documentation_files,
        labels: contribution_string_list(field("labels"), &format!("{path}.labels"), 64)?,
        draft,
        approvals: contribution_int(field("approvals"), &format!("{path}.approvals"), 0, 1_000)?,
        checks: contribution_string_list(field("checks"), &format!("{path}.checks"), 64)?,
        commits,
        branch: contribution_line(field("branch"), &format!("{path}.branch"), 200)?,
        merge_method,
        references: contribution_number_list(field("references"), &format!("{path}.references"))?,
    })
}

fn parse_contribution_source(
    value: &Value,
) -> Result<
    (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<(String, String)>,
        Vec<MergedPullRequest>,
        Vec<i64>,
    ),
    String,
> {
    let keys = [
        "forge",
        "host",
        "unavailable",
        "window",
        "mergedPullRequests",
        "closedUnmergedPullRequests",
    ];
    let raw = contribution_record(value, "source", &keys)?;
    let forge = raw.get("forge").unwrap_or(&Value::Null);
    let forge = if forge.is_null() {
        None
    } else {
        let text = forge.as_str().unwrap_or_default();
        if !["github", "gitlab", "gitea"].contains(&text) {
            return Err(invalid(
                "source.forge",
                "must be github, gitlab, gitea, or null",
            ));
        }
        Some(text.to_string())
    };
    let host = match raw.get("host").unwrap_or(&Value::Null) {
        Value::Null => None,
        value => Some(contribution_line(value, "source.host", 200)?),
    };
    let unavailable = match raw.get("unavailable").unwrap_or(&Value::Null) {
        Value::Null => None,
        value => Some(contribution_line(value, "source.unavailable", 200)?),
    };
    let Some(merged_items) = raw.get("mergedPullRequests").and_then(Value::as_array) else {
        return Err(invalid("source.mergedPullRequests", "must be a list"));
    };
    if merged_items.len() > 50 {
        return Err(invalid(
            "source.mergedPullRequests",
            "must carry at most 50 pull requests",
        ));
    }
    let mut merged = Vec::new();
    for (index, entry) in merged_items.iter().enumerate() {
        merged.push(parse_merged_pull_request(entry, index)?);
    }
    let mut numbers = HashSet::new();
    for (index, pull_request) in merged.iter().enumerate() {
        if !numbers.insert(pull_request.number) {
            return Err(invalid(
                &format!("source.mergedPullRequests[{index}].number"),
                "must be unique",
            ));
        }
    }
    let closed_unmerged = contribution_number_list(
        raw.get("closedUnmergedPullRequests")
            .unwrap_or(&Value::Null),
        "source.closedUnmergedPullRequests",
    )?;
    if closed_unmerged
        .iter()
        .any(|number| numbers.contains(number))
    {
        return Err(invalid(
            "source.closedUnmergedPullRequests",
            "must not repeat a merged pull request",
        ));
    }
    let window = match raw.get("window").unwrap_or(&Value::Null) {
        Value::Null => None,
        value => {
            let record = contribution_record(value, "source.window", &["from", "to"])?;
            Some((
                contribution_timestamp(
                    record.get("from").unwrap_or(&Value::Null),
                    "source.window.from",
                )?,
                contribution_timestamp(
                    record.get("to").unwrap_or(&Value::Null),
                    "source.window.to",
                )?,
            ))
        }
    };
    if unavailable.is_some() {
        if !merged.is_empty() || !closed_unmerged.is_empty() {
            return Err(invalid(
                "source.unavailable",
                "must accompany empty pull-request lists",
            ));
        }
        if window.is_some() {
            return Err(invalid(
                "source.window",
                "must be null when the forge was unavailable",
            ));
        }
        if host.is_some() {
            return Err(invalid(
                "source.host",
                "must be null when the forge was unavailable",
            ));
        }
        if forge.is_some() {
            return Err(invalid(
                "source.forge",
                "must be null when the forge was unavailable",
            ));
        }
    }
    if !merged.is_empty() {
        if forge.is_none() {
            return Err(invalid(
                "source.forge",
                "must name the forge that supplied the sample",
            ));
        }
        if host.is_none() {
            return Err(invalid(
                "source.host",
                "must name the host that supplied the sample",
            ));
        }
        let mut times: Vec<i64> = merged
            .iter()
            .filter_map(|pull_request| parse_iso_millis(&pull_request.merged_at))
            .collect();
        times.sort_unstable();
        let computed = (
            times.first().copied().unwrap_or(0),
            times.last().copied().unwrap_or(0),
        );
        let expected = window.as_ref().and_then(|(from, to)| {
            let parse = |text: &str| parse_iso_millis(text);
            Some((parse(from)?, parse(to)?))
        });
        if expected != Some(computed) {
            return Err(invalid(
                "source.window",
                "must span the merged sample's merge times",
            ));
        }
    }
    Ok((forge, host, unavailable, window, merged, closed_unmerged))
}

fn validate_contribution_value(value: &Value, path: &str) -> Result<(), String> {
    static CAMEL_CASE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").expect("camel case"));
    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        Value::Number(number) => {
            if number.as_f64().is_none() {
                Err(invalid(path, "must be a finite number"))
            } else {
                Ok(())
            }
        }
        Value::String(text) => {
            contribution_string(value, path, 20_000)?;
            let _ = text;
            Ok(())
        }
        Value::Array(items) => {
            if items.len() > 64 {
                return Err(invalid(path, "must carry at most 64 entries"));
            }
            for (index, entry) in items.iter().enumerate() {
                validate_contribution_value(entry, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        Value::Object(object) => {
            if object.len() > 16 {
                return Err(invalid(path, "must carry at most 16 keys"));
            }
            for (key, entry) in object {
                let kebab = CAMEL_CASE.replace_all(key, "$1-$2").to_lowercase();
                if !kebab_pattern().is_match(&kebab) {
                    return Err(invalid(
                        &format!("{path}.{key}"),
                        "must be a camelCase field name",
                    ));
                }
                validate_contribution_value(entry, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
    }
}

fn parse_contribution_fact(value: &Value, path: &str, key: &str) -> Result<ParsedFact, String> {
    let raw = contribution_record(
        value,
        path,
        &["key", "value", "evidence", "confidence", "reason"],
    )?;
    if raw.get("key").and_then(Value::as_str) != Some(key) {
        return Err(invalid(&format!("{path}.key"), format!("must be {key}")));
    }
    let Some(confidence) = raw.get("confidence").and_then(Value::as_str) else {
        return Err(invalid(
            &format!("{path}.confidence"),
            "must be observed, declared, inferred, or unknown",
        ));
    };
    if !CONFIDENCES.contains(&confidence) {
        return Err(invalid(
            &format!("{path}.confidence"),
            "must be observed, declared, inferred, or unknown",
        ));
    }
    let evidence = contribution_evidence(
        raw.get("evidence").unwrap_or(&Value::Null),
        &format!("{path}.evidence"),
    )?;
    if confidence == "unknown" {
        if raw.contains_key("value") {
            return Err(invalid(
                &format!("{path}.value"),
                "must be absent on an unknown fact",
            ));
        }
        if !evidence.is_empty() {
            return Err(invalid(
                &format!("{path}.evidence"),
                "must be empty on an unknown fact",
            ));
        }
        let reason = contribution_line(
            raw.get("reason").unwrap_or(&Value::Null),
            &format!("{path}.reason"),
            200,
        )?;
        return Ok(ParsedFact {
            key: key.to_string(),
            value: None,
            evidence,
            confidence: confidence.to_string(),
            reason: Some(reason),
        });
    }
    if !raw.contains_key("value") {
        return Err(invalid(
            &format!("{path}.value"),
            "must be present on a known fact",
        ));
    }
    if evidence.is_empty() {
        return Err(invalid(
            &format!("{path}.evidence"),
            "must ground a known fact",
        ));
    }
    if raw.contains_key("reason") {
        return Err(invalid(
            &format!("{path}.reason"),
            "belongs only to an unknown fact",
        ));
    }
    validate_contribution_value(
        raw.get("value").unwrap_or(&Value::Null),
        &format!("{path}.value"),
    )?;
    Ok(ParsedFact {
        key: key.to_string(),
        value: raw.get("value").cloned(),
        evidence,
        confidence: confidence.to_string(),
        reason: None,
    })
}

fn parse_contribution_facts(
    value: &Value,
    section: &str,
    keys: &[&str],
) -> Result<Vec<ParsedFact>, String> {
    let Some(items) = value.as_array() else {
        return Err(invalid(section, "must be a list of facts"));
    };
    let mut by_key: HashMap<String, &Value> = HashMap::new();
    for (index, entry) in items.iter().enumerate() {
        if !is_record(entry) {
            return Err(invalid(
                &format!("{section}[{index}]"),
                "must be a fact object",
            ));
        }
        let key = entry.get("key").and_then(Value::as_str);
        let Some(key) = key.filter(|key| keys.contains(key)) else {
            return Err(invalid(
                &format!("{section}[{index}].key"),
                format!("must be one of {}", keys.join(", ")),
            ));
        };
        if by_key.insert(key.to_string(), entry).is_some() {
            return Err(invalid(
                &format!("{section}[{index}].key"),
                format!("must appear once for {key}"),
            ));
        }
    }
    let mut facts = Vec::new();
    for key in keys {
        let Some(entry) = by_key.get(*key) else {
            return Err(invalid(&format!("{section}.{key}"), "must carry this fact"));
        };
        facts.push(parse_contribution_fact(
            entry,
            &format!("{section}.{key}"),
            key,
        )?);
    }
    Ok(facts)
}

fn parse_staged_contribution(raw: &Value) -> Result<StagedContribution, String> {
    let record = contribution_record(
        raw,
        "contribution.json",
        &["schemaVersion", "source", "workflow", "testing"],
    )?;
    if record.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("contribution.json.schemaVersion", "must equal 1"));
    }
    let (forge, host, unavailable, window, merged, closed_unmerged) =
        parse_contribution_source(record.get("source").unwrap_or(&Value::Null))?;
    Ok(StagedContribution {
        forge,
        host,
        unavailable,
        window,
        merged,
        closed_unmerged,
        workflow: parse_contribution_facts(
            record.get("workflow").unwrap_or(&Value::Null),
            "workflow",
            WORKFLOW_FACT_KEYS,
        )?,
        testing: parse_contribution_facts(
            record.get("testing").unwrap_or(&Value::Null),
            "testing",
            TESTING_FACT_KEYS,
        )?,
    })
}
// ------------------------------------------------ contribution derivation

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        return sorted[middle];
    }
    let average = (sorted[middle - 1] + sorted[middle]) / 2.0;
    (average * 10.0).round() / 10.0
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn integer(value: i64) -> Value {
    Value::Number(serde_json::Number::from(value))
}

fn spread(values: &[f64]) -> Value {
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    json!({
        "median": number(median(&sorted)),
        "min": number(sorted.first().copied().unwrap_or(0.0)),
        "max": number(sorted.last().copied().unwrap_or(0.0)),
    })
}

fn spread_int(values: &[i64]) -> Value {
    spread(&values.iter().map(|value| *value as f64).collect::<Vec<_>>())
}

fn percent(part: usize, total: usize) -> Value {
    if total == 0 {
        return integer(0);
    }
    integer(((part as f64 / total as f64) * 100.0).round() as i64)
}

fn words_of(text: &str) -> Vec<&str> {
    text.split_whitespace()
        .filter(|word| !word.is_empty())
        .collect()
}

fn stop_words() -> &'static HashSet<&'static str> {
    static WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
        [
            "the", "and", "for", "this", "that", "with", "from", "into", "when", "then", "than",
            "have", "has", "had", "was", "were", "are", "but", "not", "its", "our", "their",
            "they", "them", "you", "your", "will", "would", "can", "could", "should", "must",
            "may", "also", "only", "just", "now", "pull", "request", "requests", "branch",
            "commit", "commits", "code", "file", "files", "test", "tests", "change", "changes",
            "changed", "add", "adds", "added", "update", "updates", "updated", "fix", "fixes",
            "fixed", "use", "uses", "used", "make", "makes", "made", "more", "less", "one", "two",
            "new", "all", "any", "out", "over", "under", "after", "before", "about", "which",
            "where", "there", "here", "been", "being", "does", "did", "doing", "what", "why",
            "how", "who", "each",
        ]
        .into_iter()
        .collect()
    });
    &WORDS
}

fn evidence_of(merged: &[MergedPullRequest]) -> Vec<String> {
    let mut numbers: Vec<i64> = merged
        .iter()
        .map(|pull_request| pull_request.number)
        .collect();
    numbers.sort_unstable();
    numbers
        .into_iter()
        .take(32)
        .map(|number| format!("PR #{number}"))
        .collect()
}

fn sorted_evidence(evidence: &[String]) -> Value {
    let mut unique: Vec<String> = evidence.to_vec();
    unique.sort();
    unique.dedup();
    Value::Array(unique.into_iter().map(Value::String).collect())
}

fn fact(section: &str, key: &str, value: Value, evidence: &[String], confidence: &str) -> Value {
    json!({
        "key": key,
        "label": fact_label(section, key),
        "evidence": sorted_evidence(evidence),
        "confidence": confidence,
        "value": value,
    })
}

fn unknown_fact(section: &str, key: &str, reason: &str) -> Value {
    let reason: String = reason.chars().take(200).collect();
    json!({
        "key": key,
        "label": fact_label(section, key),
        "evidence": [],
        "confidence": "unknown",
        "reason": reason,
    })
}

fn parsed_fact(section: &str, parsed: &ParsedFact) -> Value {
    let base = json!({
        "key": parsed.key,
        "label": fact_label(section, &parsed.key),
        "evidence": sorted_evidence(&parsed.evidence),
        "confidence": parsed.confidence,
    });
    let mut out = base.as_object().cloned().unwrap_or_default();
    if parsed.confidence == "unknown" {
        out.insert(
            "reason".to_string(),
            Value::String(
                parsed
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Unknown.".to_string()),
            ),
        );
    } else {
        out.insert(
            "value".to_string(),
            parsed.value.clone().unwrap_or(Value::Null),
        );
    }
    Value::Object(out)
}

/// Counts each value in a map, returning the entries sorted by count desc then key.
fn ranked(counts: &HashMap<String, i64>) -> Vec<(String, i64)> {
    let mut entries: Vec<(String, i64)> = counts
        .iter()
        .map(|(key, count)| (key.clone(), *count))
        .collect();
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    entries
}

fn collision_patterns() -> (&'static Regex, &'static Regex) {
    static TITLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^([a-z]+)(?:\(([a-z0-9._/-]+)\))?(!?):\s+").expect("a title pattern")
    });
    static HEADING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^#{1,6}\s+(.+?)\s*$").expect("a heading"));
    (&TITLE, &HEADING)
}

fn pattern_summary(captures: Option<&regex::Captures<'_>>, fallback: &str) -> String {
    match captures {
        None => fallback.to_string(),
        Some(captures) => {
            let kind = captures
                .get(1)
                .map(|capture| capture.as_str())
                .unwrap_or("");
            let scope = captures.get(2).map(|capture| capture.as_str());
            let bang = captures
                .get(3)
                .map(|capture| capture.as_str())
                .unwrap_or("");
            match scope {
                Some(scope) => format!("{kind}({scope}){bang}: summary"),
                None => format!("{kind}{bang}: summary"),
            }
        }
    }
}

fn style_facts(merged: &[MergedPullRequest]) -> Vec<Value> {
    let section = "pull-request-style";
    let evidence = evidence_of(merged);
    let titles: Vec<&str> = merged
        .iter()
        .map(|pull_request| pull_request.title.as_str())
        .collect();
    let bodies: Vec<&str> = merged
        .iter()
        .map(|pull_request| pull_request.body.as_str())
        .collect();
    let (title_pattern, heading_pattern) = collision_patterns();
    let mut counts: HashMap<String, i64> = HashMap::new();
    for title in &titles {
        let pattern = pattern_summary(title_pattern.captures(title).as_ref(), "free-form summary");
        *counts.entry(pattern).or_insert(0) += 1;
    }
    let title_patterns: Vec<Value> = ranked(&counts)
        .into_iter()
        .take(8)
        .map(|(pattern, count)| Value::String(format!("{pattern} ({count})")))
        .collect();
    let mut heading_counts: HashMap<String, i64> = HashMap::new();
    let mut heading_first: HashMap<String, f64> = HashMap::new();
    for (body_index, body) in bodies.iter().enumerate() {
        for line in body.split('\n') {
            let Some(captures) = heading_pattern.captures(line) else {
                continue;
            };
            let heading = captures
                .get(1)
                .map(|capture| capture.as_str())
                .unwrap_or("");
            *heading_counts.entry(heading.to_string()).or_insert(0) += 1;
            if !heading_first.contains_key(heading) {
                heading_first.insert(
                    heading.to_string(),
                    heading_first.len() as f64 + body_index as f64 * 0.001,
                );
            }
        }
    }
    let mut headings: Vec<(String, i64)> = heading_counts.into_iter().collect();
    headings.sort_by(|left, right| {
        right.1.cmp(&left.1).then_with(|| {
            heading_first
                .get(&left.0)
                .partial_cmp(&heading_first.get(&right.0))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.0.cmp(&right.0))
        })
    });
    let body_headings: Vec<Value> = headings
        .into_iter()
        .take(10)
        .map(|(heading, _)| Value::String(heading))
        .collect();
    let bullet_pattern = Regex::new(r"^\s*[-*+]\s+").expect("a bullet");
    let mut total_lines = 0;
    let mut bullet_lines = 0;
    for body in &bodies {
        let lines: Vec<&str> = body
            .split('\n')
            .filter(|line| !line.trim().is_empty())
            .collect();
        total_lines += lines.len();
        bullet_lines += lines
            .iter()
            .filter(|line| bullet_pattern.is_match(line))
            .count();
    }
    let imperative = Regex::new(
        r"^(Add|Allow|Avoid|Build|Bump|Change|Clean|Convert|Create|Document|Drop|Enable|Ensure|Expose|Fix|Handle|Improve|Introduce|Keep|Make|Move|Prefer|Rename|Remove|Replace|Restore|Return|Show|Support|Test|Update|Use|Validate)\b",
    )
    .expect("imperative");
    let past = Regex::new(
        r"^(Added|Allowed|Built|Bumped|Changed|Converted|Created|Documented|Dropped|Enabled|Ensured|Exposed|Fixed|Handled|Improved|Introduced|Kept|Made|Moved|Renamed|Removed|Replaced|Restored|Returned|Showed|Supported|Tested|Updated|Used|Validated)\b",
    )
    .expect("past");
    let imperative_titles = titles
        .iter()
        .filter(|title| imperative.is_match(title))
        .count();
    let past_titles = titles.iter().filter(|title| past.is_match(title)).count();
    let first_person = Regex::new(r"\b(?:I|we)\b").expect("first person");
    let first_person_bodies = bodies
        .iter()
        .filter(|body| first_person.is_match(body))
        .count();
    let mut voice = Vec::new();
    if imperative_titles > 0 && imperative_titles >= past_titles {
        voice.push("imperative");
    }
    if past_titles > imperative_titles {
        voice.push("past tense");
    }
    if first_person_bodies > 0 && first_person_bodies * 2 >= merged.len() {
        voice.push("first person");
    }
    voice.sort();
    let mut word_counts: HashMap<String, i64> = HashMap::new();
    let strip = Regex::new(r"[^a-z0-9-]").expect("word punctuation");
    for body in &bodies {
        for word in words_of(&body.to_lowercase()) {
            let word = strip.replace_all(word, "").to_string();
            if word.len() < 4 || stop_words().contains(word.as_str()) {
                continue;
            }
            *word_counts.entry(word).or_insert(0) += 1;
        }
    }
    let vocabulary: Vec<Value> = ranked(&word_counts)
        .into_iter()
        .filter(|(_, count)| *count >= 2)
        .take(8)
        .map(|(word, _)| Value::String(word))
        .collect();
    let closing = Regex::new(r"(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#[0-9]+")
        .expect("a closing keyword");
    let reference = Regex::new(r"#[0-9]+").expect("a reference");
    let checklist = Regex::new(r"- \[[ xX]\]").expect("a checklist");
    let screenshot = Regex::new(r"!\[|screenshot").expect("a screenshot");
    let test_plan = Regex::new(r"(?im)^#{1,6}\s+test plan\b").expect("a test plan");
    let checklist_count = merged
        .iter()
        .filter(|pull_request| checklist.is_match(&pull_request.body))
        .count();
    let screenshot_count = merged
        .iter()
        .filter(|pull_request| screenshot.is_match(&pull_request.body))
        .count();
    let test_plan_count = merged
        .iter()
        .filter(|pull_request| test_plan.is_match(&pull_request.body))
        .count();
    let reference_count = merged
        .iter()
        .filter(|pull_request| reference.is_match(&pull_request.body))
        .count();
    let closing_count = merged
        .iter()
        .filter(|pull_request| closing.is_match(&pull_request.body))
        .count();
    let sizes: Vec<i64> = merged
        .iter()
        .map(|pull_request| pull_request.files_changed)
        .collect();
    let size = spread_int(&sizes);
    vec![
        fact(
            section,
            "titlePatterns",
            Value::Array(title_patterns),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "titleWords",
            spread_int(
                &titles
                    .iter()
                    .map(|title| words_of(title).len() as i64)
                    .collect::<Vec<_>>(),
            ),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "bodyHeadings",
            Value::Array(body_headings),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "bodyWords",
            spread_int(
                &bodies
                    .iter()
                    .map(|body| words_of(body).len() as i64)
                    .collect::<Vec<_>>(),
            ),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "bodyLines",
            spread_int(
                &bodies
                    .iter()
                    .map(|body| body.split('\n').count() as i64)
                    .collect::<Vec<_>>(),
            ),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "bulletRatio",
            percent(bullet_lines, total_lines),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "voice",
            Value::Array(
                voice
                    .into_iter()
                    .map(|entry| Value::String(entry.to_string()))
                    .collect(),
            ),
            &evidence,
            "inferred",
        ),
        fact(
            section,
            "vocabulary",
            Value::Array(vocabulary),
            &evidence,
            "inferred",
        ),
        fact(
            section,
            "issueLinking",
            json!({
                "referenceShare": percent(reference_count, merged.len()),
                "closingShare": percent(closing_count, merged.len()),
            }),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "templates",
            json!({
                "checklistShare": percent(checklist_count, merged.len()),
                "screenshotShare": percent(screenshot_count, merged.len()),
                "testPlanShare": percent(test_plan_count, merged.len()),
            }),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "granularity",
            Value::String(format!(
                "One accepted change touches a median of {} files (range {}-{}).",
                size_json_number(&size, "median"),
                size_json_number(&size, "min"),
                size_json_number(&size, "max"),
            )),
            &evidence,
            "inferred",
        ),
    ]
}

fn size_json_number(size: &Value, key: &str) -> String {
    size.get(key)
        .map(crate::jsjson::stringify)
        .unwrap_or_else(|| "0".to_string())
}

fn merge_method_of(merged: &[MergedPullRequest]) -> String {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for pull_request in merged {
        *counts.entry(pull_request.merge_method.clone()).or_insert(0) += 1;
    }
    ranked(&counts)
        .into_iter()
        .next()
        .map(|(method, _)| method)
        .unwrap_or_else(|| "merge".to_string())
}

fn size_facts(merged: &[MergedPullRequest]) -> Vec<Value> {
    let section = "pull-request-size";
    let evidence = evidence_of(merged);
    let test_shares: Vec<i64> = merged
        .iter()
        .map(|pull_request| {
            ((pull_request.test_files as f64 / pull_request.files_changed as f64) * 100.0).round()
                as i64
        })
        .collect();
    let mut largest = merged.to_vec();
    largest.sort_by(|left, right| {
        let left_total = left.additions + left.deletions;
        let right_total = right.additions + right.deletions;
        right_total
            .cmp(&left_total)
            .then_with(|| right.files_changed.cmp(&left.files_changed))
            .then_with(|| right.number.cmp(&left.number))
    });
    let largest = largest.first().expect("a merged sample");
    let with_tests = merged
        .iter()
        .filter(|pull_request| pull_request.test_files > 0)
        .count();
    let with_docs = merged
        .iter()
        .filter(|pull_request| pull_request.documentation_files > 0)
        .count();
    let with_both = merged
        .iter()
        .filter(|pull_request| pull_request.test_files > 0 && pull_request.documentation_files > 0)
        .count();
    vec![
        fact(
            section,
            "additions",
            spread_int(
                &merged
                    .iter()
                    .map(|pull_request| pull_request.additions)
                    .collect::<Vec<_>>(),
            ),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "deletions",
            spread_int(
                &merged
                    .iter()
                    .map(|pull_request| pull_request.deletions)
                    .collect::<Vec<_>>(),
            ),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "filesChanged",
            spread_int(
                &merged
                    .iter()
                    .map(|pull_request| pull_request.files_changed)
                    .collect::<Vec<_>>(),
            ),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "testFileShare",
            spread_int(&test_shares),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "largest",
            json!({
                "number": largest.number,
                "additions": largest.additions,
                "deletions": largest.deletions,
                "filesChanged": largest.files_changed,
            }),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "testsShare",
            percent(with_tests, merged.len()),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "documentationShare",
            percent(with_docs, merged.len()),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "testsAndDocumentationShare",
            percent(with_both, merged.len()),
            &evidence,
            "observed",
        ),
    ]
}

fn convention_facts(merged: &[MergedPullRequest]) -> Vec<Value> {
    let section = "conventions";
    let evidence = evidence_of(merged);
    let commits: Vec<&(String, String)> = merged
        .iter()
        .flat_map(|pull_request| &pull_request.commits)
        .collect();
    let (subject_pattern_regex, _) = collision_patterns();
    let mut subject_counts: HashMap<String, i64> = HashMap::new();
    for (subject, _) in &commits {
        let pattern = pattern_summary(
            subject_pattern_regex.captures(subject).as_ref(),
            "free-form subject",
        );
        *subject_counts.entry(pattern).or_insert(0) += 1;
    }
    let subject_pattern = ranked(&subject_counts).into_iter().next();
    let with_body = commits.iter().filter(|(_, body)| !body.is_empty()).count();
    let mut branch_prefixes: HashMap<String, i64> = HashMap::new();
    for pull_request in merged {
        let prefix = if pull_request.branch.contains('/') {
            format!("{}/", pull_request.branch.split('/').next().unwrap_or(""))
        } else {
            "no-prefix".to_string()
        };
        *branch_prefixes.entry(prefix).or_insert(0) += 1;
    }
    let branch_naming: Vec<Value> = ranked(&branch_prefixes)
        .into_iter()
        .take(8)
        .map(|(prefix, count)| Value::String(format!("{prefix} ({count})")))
        .collect();
    let merge_method = merge_method_of(merged);
    let reference = Regex::new(r"#[0-9]+").expect("a reference");
    let referenced = merged
        .iter()
        .filter(|pull_request| {
            !pull_request.references.is_empty()
                || pull_request
                    .commits
                    .iter()
                    .any(|(subject, body)| reference.is_match(&format!("{subject} {body}")))
        })
        .count();
    vec![
        fact(
            section,
            "commitSubject",
            json!({
                "pattern": subject_pattern.as_ref().map(|(pattern, _)| pattern.clone()).unwrap_or_else(|| "free-form subject".to_string()),
                "share": percent(subject_pattern.as_ref().map(|(_, count)| *count as usize).unwrap_or(0), commits.len()),
            }),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "commitBody",
            json!({
                "share": percent(with_body, commits.len()),
                "medianLines": number(median(
                    &commits
                        .iter()
                        .filter(|(_, body)| !body.is_empty())
                        .map(|(_, body)| body.split('\n').count() as f64)
                        .collect::<Vec<_>>()
                )),
            }),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "branchNaming",
            Value::Array(branch_naming),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "mergeMethod",
            Value::String(merge_method),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "issueReferences",
            json!({"referenceShare": percent(referenced, merged.len())}),
            &evidence,
            "observed",
        ),
    ]
}

fn review_facts(merged: &[MergedPullRequest]) -> Vec<Value> {
    let section = "review";
    let evidence = evidence_of(merged);
    let mut checks: Vec<String> = merged
        .iter()
        .flat_map(|pull_request| pull_request.checks.clone())
        .collect();
    checks.sort();
    checks.dedup();
    let mut labels: Vec<String> = merged
        .iter()
        .flat_map(|pull_request| pull_request.labels.clone())
        .collect();
    labels.sort();
    labels.dedup();
    let approvals = merged
        .iter()
        .map(|pull_request| pull_request.approvals)
        .min()
        .unwrap_or(0);
    let drafts = merged
        .iter()
        .filter(|pull_request| pull_request.draft)
        .count();
    vec![
        fact(
            section,
            "requiredApprovals",
            json!(approvals),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "requiredChecks",
            Value::Array(checks.into_iter().map(Value::String).collect()),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "labels",
            Value::Array(labels.into_iter().map(Value::String).collect()),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "draftUsage",
            percent(drafts, merged.len()),
            &evidence,
            "observed",
        ),
        fact(
            section,
            "mergeMethod",
            Value::String(merge_method_of(merged)),
            &evidence,
            "observed",
        ),
    ]
}

fn documentation_facts(merged: &[MergedPullRequest]) -> Vec<Value> {
    let section = "documentation";
    let evidence = evidence_of(merged);
    let docs = merged
        .iter()
        .filter(|pull_request| pull_request.documentation_files > 0)
        .count();
    let changelog_pattern =
        Regex::new(r"(?i)(?:^|/)(?:changelog|changes|release[-_]?notes)(?:\.[A-Za-z0-9]+)?$")
            .expect("a changelog");
    let changelog = merged
        .iter()
        .filter(|pull_request| {
            pull_request
                .files
                .iter()
                .any(|file| changelog_pattern.is_match(file))
        })
        .count();
    let docs_share = percent(docs, merged.len());
    let changelog_share = percent(changelog, merged.len());
    let convention = if docs_share == integer(0) {
        "Merged pull requests do not change documentation."
    } else if changelog_share == integer(0) {
        "Merged pull requests change documentation in the same pull request, with no changelog file."
    } else {
        "Merged pull requests change documentation and the changelog in the same pull request."
    };
    vec![
        fact(
            section,
            "documentationShare",
            docs_share,
            &evidence,
            "observed",
        ),
        fact(
            section,
            "changelogShare",
            changelog_share,
            &evidence,
            "observed",
        ),
        fact(
            section,
            "convention",
            Value::String(convention.to_string()),
            &evidence,
            "inferred",
        ),
    ]
}

fn hotspot_facts(merged: &[MergedPullRequest]) -> Vec<Value> {
    let section = "hotspots";
    let evidence = evidence_of(merged);
    let mut directory_counts: HashMap<String, i64> = HashMap::new();
    let mut file_counts: HashMap<String, i64> = HashMap::new();
    for pull_request in merged {
        for file in &pull_request.files {
            *file_counts.entry(file.clone()).or_insert(0) += 1;
            let parts: Vec<&str> = file.split('/').collect();
            let directory = if parts.len() > 1 {
                parts[..parts.len() - 1].join("/")
            } else {
                ".".to_string()
            };
            *directory_counts.entry(directory).or_insert(0) += 1;
        }
    }
    let top = |counts: &HashMap<String, i64>| -> Value {
        Value::Array(
            ranked(counts)
                .into_iter()
                .take(8)
                .map(|(path, count)| json!({"path": path, "count": count}))
                .collect(),
        )
    };
    vec![
        fact(
            section,
            "directories",
            top(&directory_counts),
            &evidence,
            "observed",
        ),
        fact(section, "files", top(&file_counts), &evidence, "observed"),
        fact(
            section,
            "typicalFiles",
            spread_int(
                &merged
                    .iter()
                    .map(|pull_request| pull_request.files_changed)
                    .collect::<Vec<_>>(),
            ),
            &evidence,
            "observed",
        ),
    ]
}

fn section_json(id: &str, facts: Vec<Value>) -> Value {
    json!({
        "id": id,
        "label": section_label(id),
        "facts": facts,
    })
}

fn unknown_ledger(sections: &[Value]) -> Vec<String> {
    let mut ledger = Vec::new();
    for section in sections {
        let id = section
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(facts) = section.get("facts").and_then(Value::as_array) {
            for entry in facts {
                if entry.get("confidence").and_then(Value::as_str) == Some("unknown") {
                    ledger.push(format!(
                        "{id}.{}: {}",
                        entry.get("key").and_then(Value::as_str).unwrap_or_default(),
                        entry
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                    ));
                }
            }
        }
    }
    ledger
}

pub fn derive_contribution(staged: &StagedContribution, freshness: &Value) -> Value {
    let merged = &staged.merged;
    let unavailable = staged.unavailable.clone();
    let empty_reason = unavailable.clone().unwrap_or_else(|| {
        if merged.is_empty() {
            "No merged pull requests were found for the target.".to_string()
        } else {
            String::new()
        }
    });
    let evidence = evidence_of(merged);
    let mut sections: Vec<Value> = Vec::new();
    sections.push(section_json(
        "workflow",
        staged
            .workflow
            .iter()
            .map(|entry| parsed_fact("workflow", entry))
            .collect(),
    ));
    sections.push(section_json(
        "testing",
        staged
            .testing
            .iter()
            .map(|entry| parsed_fact("testing", entry))
            .collect(),
    ));
    let profiles: [(&str, &[&str], fn(&[MergedPullRequest]) -> Vec<Value>); 6] = [
        (
            "pull-request-style",
            &[
                "titlePatterns",
                "titleWords",
                "bodyHeadings",
                "bodyWords",
                "bodyLines",
                "bulletRatio",
                "voice",
                "vocabulary",
                "issueLinking",
                "templates",
                "granularity",
            ],
            style_facts,
        ),
        (
            "pull-request-size",
            &[
                "additions",
                "deletions",
                "filesChanged",
                "testFileShare",
                "largest",
                "testsShare",
                "documentationShare",
                "testsAndDocumentationShare",
            ],
            size_facts,
        ),
        (
            "conventions",
            &[
                "commitSubject",
                "commitBody",
                "branchNaming",
                "mergeMethod",
                "issueReferences",
            ],
            convention_facts,
        ),
        (
            "review",
            &[
                "requiredApprovals",
                "requiredChecks",
                "labels",
                "draftUsage",
                "mergeMethod",
            ],
            review_facts,
        ),
        (
            "documentation",
            &["documentationShare", "changelogShare", "convention"],
            documentation_facts,
        ),
        (
            "hotspots",
            &["directories", "files", "typicalFiles"],
            hotspot_facts,
        ),
    ];
    for (id, keys, derive) in profiles {
        let facts = if merged.is_empty() {
            keys.iter()
                .map(|key| {
                    unknown_fact(
                        id,
                        key,
                        if empty_reason.is_empty() {
                            "No evidence."
                        } else {
                            &empty_reason
                        },
                    )
                })
                .collect()
        } else {
            derive(merged)
        };
        sections.push(section_json(id, facts));
    }
    let forge_fact = if unavailable.is_some() || staged.forge.is_none() {
        unknown_fact(
            "evidence",
            "forge",
            unavailable
                .as_deref()
                .unwrap_or("The forge could not be determined."),
        )
    } else {
        fact(
            "evidence",
            "forge",
            Value::String(staged.forge.clone().unwrap_or_default()),
            &["forge records".to_string()],
            "observed",
        )
    };
    let host_fact = if unavailable.is_some() || staged.host.is_none() {
        unknown_fact(
            "evidence",
            "host",
            unavailable
                .as_deref()
                .unwrap_or("The forge host could not be determined."),
        )
    } else {
        fact(
            "evidence",
            "host",
            Value::String(staged.host.clone().unwrap_or_default()),
            &["forge records".to_string()],
            "observed",
        )
    };
    let sample_fact = match &unavailable {
        Some(reason) => unknown_fact("evidence", "sampleSize", reason),
        None => fact(
            "evidence",
            "sampleSize",
            json!(merged.len()),
            &evidence,
            "observed",
        ),
    };
    let window_fact = if unavailable.is_some() || staged.window.is_none() {
        unknown_fact(
            "evidence",
            "window",
            unavailable
                .as_deref()
                .unwrap_or("No merged pull requests were found."),
        )
    } else {
        let (from, to) = staged.window.clone().unwrap_or_default();
        fact(
            "evidence",
            "window",
            json!({"from": from, "to": to}),
            &evidence,
            "observed",
        )
    };
    let closed_fact = match &unavailable {
        Some(reason) => unknown_fact("evidence", "closedUnmerged", reason),
        None => fact(
            "evidence",
            "closedUnmerged",
            json!(staged.closed_unmerged.len()),
            &["forge records".to_string()],
            "observed",
        ),
    };
    let mut evidence_facts = vec![forge_fact, host_fact, sample_fact, window_fact, closed_fact];
    let mut with_evidence = sections.clone();
    with_evidence.push(section_json("evidence", evidence_facts.clone()));
    let ledger = unknown_ledger(&with_evidence);
    evidence_facts.push(fact(
        "evidence",
        "unknownFacts",
        Value::Array(ledger.into_iter().map(Value::String).collect()),
        &if unavailable.is_none() {
            vec!["forge records".to_string()]
        } else {
            vec!["git log".to_string()]
        },
        "observed",
    ));
    sections.push(section_json("evidence", evidence_facts));
    let mut out = Map::new();
    out.insert("schemaVersion".to_string(), json!(1));
    out.insert("freshness".to_string(), freshness.clone());
    out.insert("sections".to_string(), Value::Array(sections));
    out.insert("sample".to_string(), contribution_sample(merged));
    Value::Object(out)
}

pub fn contribution_sample(merged: &[MergedPullRequest]) -> Value {
    let mut sorted = merged.to_vec();
    sorted.sort_by(|left, right| {
        let left_time = parse_iso_millis(&left.merged_at).unwrap_or(0);
        let right_time = parse_iso_millis(&right.merged_at).unwrap_or(0);
        right_time
            .cmp(&left_time)
            .then_with(|| right.number.cmp(&left.number))
    });
    Value::Array(
        sorted
            .into_iter()
            .take(3)
            .map(|pull_request| {
                json!({
                    "number": pull_request.number,
                    "title": pull_request.title,
                    "body": pull_request.body,
                })
            })
            .collect(),
    )
}

fn contribution_exemplars(body: &str) -> Vec<(i64, String, String)> {
    static MARKER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^> PR #([1-9][0-9]*) — (.+)$").expect("an exemplar marker"));
    let mut exemplars: Vec<(i64, String, String)> = Vec::new();
    let mut current: Option<(i64, String, String)> = None;
    for line in body.split('\n') {
        if let Some(captures) = MARKER.captures(line) {
            if let Some(finished) = current.take() {
                exemplars.push(finished);
            }
            current = Some((
                captures
                    .get(1)
                    .and_then(|capture| capture.as_str().parse().ok())
                    .unwrap_or(0),
                captures
                    .get(2)
                    .map(|capture| capture.as_str().trim())
                    .unwrap_or("")
                    .to_string(),
                String::new(),
            ));
            continue;
        }
        let Some((number, title, text)) = current.as_mut() else {
            continue;
        };
        if line == ">" {
            text.push('\n');
            continue;
        }
        if let Some(rest) = line.strip_prefix("> ") {
            text.push_str(rest);
            text.push('\n');
            continue;
        }
        exemplars.push((*number, title.clone(), text.clone()));
        current = None;
    }
    if let Some(finished) = current {
        exemplars.push(finished);
    }
    exemplars
        .into_iter()
        .map(|(number, title, body)| {
            (
                number,
                title,
                body.strip_suffix('\n').unwrap_or(&body).to_string(),
            )
        })
        .collect()
}

fn validate_contribution_skill(
    body: &str,
    path: &str,
    sample: &Value,
    unavailable: Option<&str>,
) -> Result<(), String> {
    let exemplars = contribution_exemplars(body);
    let samples = sample.as_array().cloned().unwrap_or_default();
    if samples.is_empty() {
        if !exemplars.is_empty() {
            return Err(invalid(
                path,
                "must quote no exemplar when the merged sample is empty",
            ));
        }
        if !body.to_lowercase().contains("unknown") {
            return Err(invalid(
                path,
                "must state that its pull-request-derived rules are unknown",
            ));
        }
        if let Some(unavailable) = unavailable {
            if !body.contains(unavailable) {
                return Err(invalid(
                    path,
                    "must state why the merged sample is unavailable",
                ));
            }
        }
        return Ok(());
    }
    if exemplars.len() != samples.len() {
        return Err(invalid(
            path,
            format!("must quote exactly {} merged exemplars", samples.len()),
        ));
    }
    for (index, (number, title, body_text)) in exemplars.iter().enumerate() {
        let expected = &samples[index];
        let expected_number = expected.get("number").and_then(Value::as_i64).unwrap_or(0);
        let expected_title = expected.get("title").and_then(Value::as_str).unwrap_or("");
        let expected_body = expected.get("body").and_then(Value::as_str).unwrap_or("");
        if *number != expected_number || title != expected_title || body_text != expected_body {
            return Err(invalid(
                path,
                format!(
                    "exemplar {} must quote PR #{expected_number} verbatim",
                    index + 1
                ),
            ));
        }
    }
    Ok(())
}
// ----------------------------------------------------------------- remote

pub const REMOTE_SCRATCH_NAME: &str = "discover-remote";
pub const REMOTE_URL_MAX_BYTES: usize = 2048;
pub const REMOTE_CLONE_TIMEOUT_MS: u64 = 300_000;
pub const REMOTE_RECORD_NAME: &str = "project.json";
pub const REMOTE_TRANSIENT_PREFIX: &str = ".staging-";
const RUN_CLAIM_DIRECTORY: &str = ".runs";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteRepository {
    pub url: String,
    pub owner: String,
    pub repo: String,
}

#[derive(Clone, Debug)]
pub struct RetainedRemoteProject {
    pub url: String,
    pub owner: String,
    pub repo: String,
    pub completed_at: String,
}

#[derive(Clone, Debug)]
pub struct CloneRequest {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug)]
pub struct CloneResult {
    pub code: i32,
    pub stderr: String,
    pub timed_out: bool,
}

pub type CloneFuture = std::pin::Pin<Box<dyn Future<Output = CloneResult> + Send + 'static>>;
pub type CloneRunner = Arc<dyn Fn(CloneRequest) -> CloneFuture + Send + Sync>;

static CLONE_RUNNER: Mutex<Option<CloneRunner>> = Mutex::new(None);

/// Replaces the clone runner process-wide; tests inject one here.
pub fn set_clone_runner(runner: Option<CloneRunner>) {
    *lock(&CLONE_RUNNER) = runner;
}

fn clone_runner() -> CloneRunner {
    static DEFAULT: LazyLock<CloneRunner> = LazyLock::new(|| Arc::new(spawn_clone));
    if let Some(runner) = lock(&CLONE_RUNNER).clone() {
        return runner;
    }
    Arc::clone(&DEFAULT)
}

fn spawn_clone(request: CloneRequest) -> CloneFuture {
    Box::pin(async move {
        let mut command = tokio::process::Command::new(&request.argv[0]);
        command
            .args(&request.argv[1..])
            .current_dir(&request.cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &request.env {
            command.env(key, value);
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return CloneResult {
                    code: -1,
                    stderr: error.to_string(),
                    timed_out: false,
                }
            }
        };
        match tokio::time::timeout(
            Duration::from_millis(request.timeout_ms.max(1)),
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(output)) => CloneResult {
                code: output.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                timed_out: false,
            },
            Ok(Err(error)) => CloneResult {
                code: -1,
                stderr: error.to_string(),
                timed_out: false,
            },
            Err(_) => CloneResult {
                code: -1,
                stderr: String::new(),
                timed_out: true,
            },
        }
    })
}

fn remote_segment() -> &'static Regex {
    static PATTERN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$").expect("a segment"));
    &PATTERN
}

/// Accepts exactly `https://github.com/<owner>/<repo>`, with an optional
/// trailing slash and an optional `.git` suffix.
pub fn parse_remote_url(raw: &str) -> Result<RemoteRepository, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("the URL is empty".to_string());
    }
    if url.len() > REMOTE_URL_MAX_BYTES {
        return Err(format!(
            "the URL is longer than {REMOTE_URL_MAX_BYTES} bytes"
        ));
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return Err("the URL must start with https://".to_string());
    };
    if rest.contains('?') || rest.contains('#') {
        return Err("the URL must not carry a query or fragment".to_string());
    }
    let mut parts: Vec<&str> = rest.split('/').collect();
    if parts.len() == 4 && parts[3].is_empty() {
        parts.pop();
    }
    if parts.len() != 3 {
        return Err("the URL must name exactly one owner and one repository".to_string());
    }
    let host = parts[0];
    let owner = parts[1];
    let raw_repo = parts[2];
    if host.contains('@') {
        return Err("the URL must not carry user information".to_string());
    }
    if host.contains(':') {
        return Err("the URL must not carry a port".to_string());
    }
    if host.to_lowercase() != "github.com" {
        return Err("the URL must name github.com".to_string());
    }
    let repo = raw_repo.strip_suffix(".git").unwrap_or(raw_repo);
    if !remote_segment().is_match(owner) || !remote_segment().is_match(repo) {
        return Err(
            "the owner and repository must be 1-100 letters, digits, dots, underscores, or hyphens"
                .to_string(),
        );
    }
    Ok(RemoteRepository {
        url: url.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

pub fn remote_scratch_root(state_dir: &Path) -> PathBuf {
    state_dir.join(REMOTE_SCRATCH_NAME)
}

/// The one clone directory name a repository gets; always lowercase.
pub fn remote_clone_name(owner: &str, repo: &str) -> String {
    format!("{owner}~{repo}").to_lowercase()
}

pub fn remote_project_directory(scratch_root: &Path, owner: &str, repo: &str) -> PathBuf {
    scratch_root.join(remote_clone_name(owner, repo))
}

fn claim_path(scratch_root: &Path, name: &str) -> PathBuf {
    scratch_root
        .join(RUN_CLAIM_DIRECTORY)
        .join(format!("{name}.json"))
}

fn claim_alive(scratch_root: &Path, name: &str) -> bool {
    let Ok(source) = fs::read_to_string(claim_path(scratch_root, name)) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&source) else {
        return false;
    };
    let Some(pid) = value.get("pid").and_then(Value::as_i64) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    if pid as u32 == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        if result == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn claim_scratch_entry(scratch_root: &Path, name: &str) -> bool {
    let claim = json!({"pid": std::process::id(), "claimedAt": iso_now()});
    let directory = scratch_root.join(RUN_CLAIM_DIRECTORY);
    (|| -> std::io::Result<()> {
        fs::create_dir_all(&directory)?;
        fs::write(claim_path(scratch_root, name), format!("{claim}\n"))
    })()
    .is_ok()
}

fn release_scratch_entry(scratch_root: &Path, name: &str) {
    let _ = fs::remove_file(claim_path(scratch_root, name));
    let _ = fs::remove_dir(scratch_root.join(RUN_CLAIM_DIRECTORY));
}

fn prune_scratch_claims(scratch_root: &Path) {
    let directory = scratch_root.join(RUN_CLAIM_DIRECTORY);
    let Ok(entries) = fs::read_dir(&directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().is_file() || !name.ends_with(".json") {
            continue;
        }
        let stem = name.trim_end_matches(".json").to_string();
        if claim_alive(scratch_root, &stem) {
            continue;
        }
        let _ = fs::remove_file(entry.path());
    }
    let _ = fs::remove_dir(&directory);
}

fn parse_retained_project(raw: &Value) -> Option<RetainedRemoteProject> {
    let url = raw.get("url")?.as_str()?;
    let owner = raw.get("owner")?.as_str()?;
    let repo = raw.get("repo")?.as_str()?;
    let completed_at = raw.get("completedAt")?.as_str()?;
    let parsed = parse_remote_url(url).ok()?;
    if parsed.owner != owner || parsed.repo != repo {
        return None;
    }
    parse_iso_millis(completed_at)?;
    Some(RetainedRemoteProject {
        url: url.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        completed_at: completed_at.to_string(),
    })
}

pub fn read_retained_project(directory: &Path) -> Option<RetainedRemoteProject> {
    let source = fs::read_to_string(directory.join(REMOTE_RECORD_NAME)).ok()?;
    let value: Value = serde_json::from_str(&source).ok()?;
    parse_retained_project(&value)
}

pub fn retained_project_ready(directory: &Path, record: &RetainedRemoteProject) -> bool {
    let name = directory
        .canonicalize()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| {
            directory
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    name == remote_clone_name(&record.owner, &record.repo)
        && directory.join(".omp").join("discover").exists()
}

pub fn list_retained_projects(scratch_root: &Path) -> Vec<RetainedRemoteProject> {
    let Ok(entries) = fs::read_dir(scratch_root) else {
        return Vec::new();
    };
    let mut projects = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().is_dir() || name.starts_with('.') {
            continue;
        }
        let directory = scratch_root.join(&name);
        let Some(record) = read_retained_project(&directory) else {
            continue;
        };
        if remote_clone_name(&record.owner, &record.repo) != name {
            continue;
        }
        if !retained_project_ready(&directory, &record) {
            continue;
        }
        projects.push(record);
    }
    projects.sort_by(|left, right| {
        let left_time = parse_iso_millis(&left.completed_at).unwrap_or(0);
        let right_time = parse_iso_millis(&right.completed_at).unwrap_or(0);
        right_time
            .cmp(&left_time)
            .then_with(|| left.url.cmp(&right.url))
    });
    projects
}

/// Copies a finished run's published trees out of its checkout and records the
/// completion time; the previous snapshot survives a failed rename.
pub fn retain_remote_project(
    scratch_root: &Path,
    checkout_dir: &Path,
    record: &RetainedRemoteProject,
    run_id: &str,
) -> Result<(), String> {
    let published = checkout_dir.join(".omp");
    let discover_source = published.join("discover");
    let skills_source = published.join("skills");
    if !discover_source.exists() {
        return Err("the agent published no Discover artifacts to retain".to_string());
    }
    let staging = scratch_root.join(format!("{REMOTE_TRANSIENT_PREFIX}retain-{run_id}"));
    let previous = scratch_root.join(format!("{REMOTE_TRANSIENT_PREFIX}previous-{run_id}"));
    let staging_name = staging
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let previous_name = previous
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let destination = remote_project_directory(scratch_root, &record.owner, &record.repo);
    claim_scratch_entry(scratch_root, &staging_name);
    claim_scratch_entry(scratch_root, &previous_name);
    let outcome = (|| -> Result<(), String> {
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(staging.join(".omp")).map_err(|error| error.to_string())?;
        copy_directory(&discover_source, &staging.join(".omp").join("discover"))
            .map_err(|error| error.to_string())?;
        if skills_source.exists() {
            copy_directory(&skills_source, &staging.join(".omp").join("skills"))
                .map_err(|error| error.to_string())?;
        }
        fs::write(
            staging.join(REMOTE_RECORD_NAME),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&json!({
                    "url": record.url,
                    "owner": record.owner,
                    "repo": record.repo,
                    "completedAt": record.completed_at,
                }))
                .unwrap_or_else(|_| "{}".to_string())
            ),
        )
        .map_err(|error| error.to_string())?;
        let _ = fs::remove_dir_all(&previous);
        let had_previous = destination.exists();
        if had_previous {
            fs::rename(&destination, &previous).map_err(|error| error.to_string())?;
        }
        if let Err(error) = fs::rename(&staging, &destination) {
            if had_previous {
                let _ = fs::rename(&previous, &destination);
            }
            return Err(error.to_string());
        }
        let _ = fs::remove_dir_all(&previous);
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    release_scratch_entry(scratch_root, &staging_name);
    release_scratch_entry(scratch_root, &previous_name);
    outcome
}

pub fn remove_retained_project(
    scratch_root: &Path,
    record: &RetainedRemoteProject,
) -> Option<String> {
    match fs::remove_dir_all(remote_project_directory(
        scratch_root,
        &record.owner,
        &record.repo,
    )) {
        Ok(()) => None,
        Err(error) => Some(error.to_string()),
    }
}

fn copy_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

pub fn is_inside_repository(repo_dir: &Path, path: &Path) -> bool {
    let base = repo_dir
        .canonicalize()
        .unwrap_or_else(|_| repo_dir.to_path_buf());
    let target = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    target != base && target.starts_with(&base)
}

fn clone_environment() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("GIT_TERMINAL_PROMPT".to_string(), "0".to_string());
    env.insert("GIT_ASKPASS".to_string(), "true".to_string());
    env.insert("NO_COLOR".to_string(), "1".to_string());
    env
}

pub fn remote_clone_request(url: &str, scratch_root: &Path, run_id: &str) -> CloneRequest {
    CloneRequest {
        argv: vec![
            "git".to_string(),
            "clone".to_string(),
            "--depth".to_string(),
            "1".to_string(),
            "--single-branch".to_string(),
            "--no-tags".to_string(),
            "--".to_string(),
            url.to_string(),
            format!(".staging-{run_id}"),
        ],
        cwd: scratch_root.to_path_buf(),
        env: clone_environment(),
        timeout_ms: REMOTE_CLONE_TIMEOUT_MS,
    }
}

/// Startup hygiene: a run's checkout and staging never survive a restart.
pub fn cleanup_remote_scratch(scratch_root: &Path) {
    let Ok(entries) = fs::read_dir(scratch_root) else {
        prune_scratch_claims(scratch_root);
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().is_dir() || name == RUN_CLAIM_DIRECTORY {
            continue;
        }
        let directory = scratch_root.join(&name);
        let transient = name.starts_with(REMOTE_TRANSIENT_PREFIX);
        let checkout = directory.join(".git").exists();
        if !transient && !checkout {
            continue;
        }
        if transient && claim_alive(scratch_root, &name) {
            continue;
        }
        let _ = fs::remove_dir_all(&directory);
        release_scratch_entry(scratch_root, &name);
    }
    prune_scratch_claims(scratch_root);
}

// ------------------------------------------------------------- host facts

#[derive(Clone, Debug)]
pub struct HostFacts {
    pub fingerprint: String,
    pub commit: String,
    pub dirty: bool,
}

const EXCLUDED_ROOTS: &[&str] = &[
    ".devboard",
    ".worktree",
    ".omp/discover",
    ".omp/skills",
    ".git",
];

fn excluded(relative_path: &str) -> bool {
    EXCLUDED_ROOTS
        .iter()
        .any(|root| relative_path == *root || relative_path.starts_with(&format!("{root}/")))
}

fn git_output(repo_dir: &Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Every file the fingerprint covers: tracked and untracked, never ignored.
pub fn host_files(repo_dir: &Path) -> Vec<String> {
    if let Some(listed) = git_output(
        repo_dir,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    ) {
        let mut files: Vec<String> = listed
            .split('\0')
            .filter(|entry| !entry.is_empty() && !excluded(entry) && !is_absolute_path(entry))
            .map(str::to_string)
            .collect();
        files.sort();
        return files;
    }
    let mut files = Vec::new();
    fn walk(repo_dir: &Path, directory: &Path, files: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let absolute = entry.path();
            let relative = absolute
                .strip_prefix(repo_dir)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if excluded(&relative) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "node_modules" || name == ".git" {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                walk(repo_dir, &absolute, files);
            } else if metadata.is_file() {
                files.push(relative);
            }
        }
    }
    walk(repo_dir, repo_dir, &mut files);
    files.sort();
    files
}

#[cfg(unix)]
fn entry_signature(metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "{}:{}:{}:{}:{}",
        metadata.mode(),
        metadata.size(),
        metadata.mtime_nsec(),
        metadata.ctime_nsec(),
        metadata.ino()
    )
}

#[cfg(not(unix))]
fn entry_signature(metadata: &fs::Metadata) -> String {
    format!(
        "{}:{}",
        metadata.len(),
        metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    )
}

fn entry_digest(path: &Path) -> String {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return "unreadable".to_string();
    };
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(path)
            .map(|target| target.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "unreadable".to_string());
        return sha256_hex(format!("symlink\u{0}{target}").as_bytes());
    }
    if metadata.is_file() {
        return fs::read(path)
            .map(|bytes| sha256_hex(&bytes))
            .unwrap_or_else(|_| "unreadable".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        sha256_hex(format!("special\u{0}{}", metadata.mode()).as_bytes())
    }
    #[cfg(not(unix))]
    {
        sha256_hex(b"special")
    }
}

/// The host fingerprint: `HEAD`, plus every tracked and untracked non-ignored
/// file outside the excluded directories.
pub fn host_facts(repo_dir: &Path) -> HostFacts {
    let entries = host_files(repo_dir);
    let mut listing = String::new();
    let mut digests = String::new();
    for path in &entries {
        let absolute = repo_dir.join(path);
        let signature = fs::symlink_metadata(&absolute)
            .map(|metadata| entry_signature(&metadata))
            .unwrap_or_else(|_| "missing".to_string());
        listing.push_str(path);
        listing.push('\u{0}');
        listing.push_str(&signature);
        listing.push('\u{0}');
        digests.push_str(path);
        digests.push('\u{0}');
        digests.push_str(&entry_digest(&absolute));
        digests.push('\u{0}');
    }
    let fingerprint = sha256_hex(digests.as_bytes());
    let commit = git_output(repo_dir, &["rev-parse", "--short=7", "HEAD"])
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    let dirty = git_output(
        repo_dir,
        &["status", "--porcelain", "--untracked-files=all"],
    )
    .map(|status| {
        status
            .split('\n')
            .filter(|line| !line.trim().is_empty())
            .filter(|line| {
                let mut path = line.chars().skip(3).collect::<String>();
                if let Some(index) = path.find(" -> ") {
                    path = path[index + 4..].to_string();
                }
                if path.starts_with('"') && path.ends_with('"') && path.len() >= 2 {
                    path = path[1..path.len() - 1].to_string();
                }
                !excluded(&path)
            })
            .count()
            > 0
    })
    .unwrap_or(false);
    HostFacts {
        fingerprint,
        commit,
        dirty,
    }
}
// ---------------------------------------------------------- staged slices

#[derive(Clone)]
pub struct Ownership {
    pub id: String,
    pub skills: Vec<String>,
    pub sheet: bool,
    pub glossary: bool,
    pub contribution: bool,
}

fn agent_ownership(id: &str) -> Option<Ownership> {
    let descriptor = discover_agent(id)?;
    let mut skills = Vec::new();
    if let Some(skill) = descriptor.skill {
        if is_discover_skill(skill) {
            skills.push(skill.to_string());
        }
    }
    Some(Ownership {
        id: descriptor.id.to_string(),
        skills,
        sheet: descriptor.skill.is_none(),
        glossary: descriptor.glossary,
        contribution: descriptor.id == "discover-contribution",
    })
}

fn walk_files(root: &Path, prefix: &str, files: &mut Vec<String>) -> std::io::Result<()> {
    for entry in fs::read_dir(root.join(prefix))? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let next = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if entry.path().is_dir() {
            walk_files(root, &next, files)?;
        } else {
            files.push(next);
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct AgentStaged {
    pub sheet: Option<Value>,
    pub glossaries: Vec<Glossary>,
    pub significance: Option<Value>,
    pub contribution: Option<StagedContribution>,
    pub skills: Vec<StagedSkill>,
}

/// Validates exactly the slice one agent owns.
pub fn validate_agent_staged(
    repo_dir: &Path,
    staging_dir: &Path,
    freshness: &Value,
    agent_id: &str,
) -> Result<AgentStaged, String> {
    let ownership =
        agent_ownership(agent_id).ok_or_else(|| format!("unknown Discover agent: {agent_id}"))?;
    if !staging_dir.exists() {
        return Err("the agent left no staging directory".to_string());
    }
    let mut files = Vec::new();
    walk_files(staging_dir, "", &mut files).map_err(|error| error.to_string())?;
    files.sort();
    let owned_skills: HashSet<&str> = ownership.skills.iter().map(String::as_str).collect();
    for file in &files {
        let parts: Vec<&str> = file.split('/').collect();
        let allowed = (ownership.sheet && file == "sheet.json")
            || (ownership.contribution && file == "contribution.json")
            || (ownership.glossary
                && (file == "glossary/significance.json"
                    || (parts.first() == Some(&"glossary")
                        && parts.len() == 2
                        && parts[1].ends_with(".glossary.yaml"))))
            || (parts.first() == Some(&"skills")
                && parts.len() == 3
                && parts[2] == "SKILL.md"
                && owned_skills.contains(parts[1]));
        if !allowed {
            return Err(format!(
                "the agent wrote {file}, which is not part of the {} staged set",
                ownership.id
            ));
        }
    }
    let files_set: HashSet<&str> = files.iter().map(String::as_str).collect();
    let host = host_files(repo_dir);
    let mut staged = AgentStaged {
        sheet: None,
        glossaries: Vec::new(),
        significance: None,
        contribution: None,
        skills: Vec::new(),
    };
    if ownership.sheet {
        if !files_set.contains("sheet.json") {
            return Err("the agent left no sheet.json".to_string());
        }
        let source = fs::read_to_string(staging_dir.join("sheet.json"))
            .map_err(|error| format!("sheet.json is not valid JSON: {error}"))?;
        let raw: Value = serde_json::from_str(&source)
            .map_err(|error| format!("sheet.json is not valid JSON: {error}"))?;
        staged.sheet = Some(normalize_sheet(&raw, freshness)?);
    }
    if ownership.glossary {
        let glossary_files: Vec<&String> = files
            .iter()
            .filter(|file| file.starts_with("glossary/") && file.ends_with(".glossary.yaml"))
            .collect();
        if glossary_files.is_empty() {
            return Err("the agent left no glossary document".to_string());
        }
        let mut glossaries = Vec::new();
        let mut contexts = HashSet::new();
        for file in glossary_files {
            let text = fs::read_to_string(staging_dir.join(file))
                .map_err(|error| format!("could not read {file}: {error}"))?;
            let glossary = parse_glossary(&text, file, repo_dir, &host, false, true)?;
            if !contexts.insert(glossary.bounded_context.clone()) {
                return Err(format!("two glossaries name {}", glossary.bounded_context));
            }
            glossaries.push(glossary);
        }
        if !files_set.contains("glossary/significance.json") {
            return Err("the agent left no glossary/significance.json".to_string());
        }
        let source = fs::read_to_string(staging_dir.join("glossary/significance.json"))
            .map_err(|error| format!("glossary/significance.json is not valid JSON: {error}"))?;
        let raw: Value = serde_json::from_str(&source)
            .map_err(|error| format!("glossary/significance.json is not valid JSON: {error}"))?;
        staged.significance = Some(parse_significance(
            &raw,
            "glossary/significance.json",
            &glossaries,
        )?);
        staged.glossaries = glossaries;
    }
    if ownership.contribution {
        if !files_set.contains("contribution.json") {
            return Err("the agent left no contribution.json".to_string());
        }
        let text = fs::read_to_string(staging_dir.join("contribution.json"))
            .map_err(|error| format!("could not read contribution.json: {error}"))?;
        let raw: Value = serde_json::from_str(&text)
            .map_err(|error| format!("contribution.json is not valid JSON: {error}"))?;
        staged.contribution = Some(parse_staged_contribution(&raw)?);
    }
    for name in &ownership.skills {
        let file = format!("skills/{name}/SKILL.md");
        if !files_set.contains(file.as_str()) {
            return Err(format!("the agent left no {name} skill"));
        }
        let text = fs::read_to_string(staging_dir.join(&file))
            .map_err(|error| format!("could not read {file}: {error}"))?;
        staged.skills.push(validate_skill_text(name, &text, &file)?);
    }
    let glossary_skill = staged
        .skills
        .iter()
        .find(|skill| skill.name == "discover-glossary");
    for glossary in &staged.glossaries {
        let path = format!(
            ".omp/discover/glossary/{}.glossary.yaml",
            glossary.bounded_context
        );
        let names = glossary_skill
            .map(|skill| skill.body.contains(&path))
            .unwrap_or(false);
        if !names {
            return Err(format!("discover-glossary does not name {path}"));
        }
    }
    if ownership.contribution {
        let skill = staged
            .skills
            .iter()
            .find(|skill| skill.name == "discover-contribution");
        let Some(contribution) = &staged.contribution else {
            return Err("the agent left no discover-contribution skill".to_string());
        };
        let Some(skill) = skill else {
            return Err("the agent left no discover-contribution skill".to_string());
        };
        let sample = contribution_sample(&contribution.merged);
        validate_contribution_skill(
            &skill.body,
            "skills/discover-contribution/SKILL.md",
            &sample,
            contribution.unavailable.as_deref(),
        )?;
    }
    Ok(staged)
}

// ------------------------------------------------------------- publishing

#[derive(Clone)]
struct FileWrite {
    path: PathBuf,
    content: String,
}

/// Writes every file or restores every affected byte on a failure.
fn write_transaction(writes: &[FileWrite], deletions: &[PathBuf]) -> Result<(), String> {
    let mut snapshots: Vec<(PathBuf, Option<Vec<u8>>)> = Vec::new();
    let mut seen = HashSet::new();
    for path in writes
        .iter()
        .map(|write| write.path.clone())
        .chain(deletions.iter().cloned())
    {
        if !seen.insert(path.clone()) {
            continue;
        }
        snapshots.push((path.clone(), fs::read(&path).ok()));
    }
    let outcome = (|| -> Result<(), String> {
        for write in writes {
            if let Some(parent) = write.path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let temporary = PathBuf::from(format!(
                "{}.{}.tmp",
                write.path.display(),
                std::process::id()
            ));
            fs::write(&temporary, &write.content).map_err(|error| error.to_string())?;
            fs::rename(&temporary, &write.path).map_err(|error| error.to_string())?;
        }
        for path in deletions {
            let _ = fs::remove_file(path);
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        for (path, bytes) in snapshots {
            match bytes {
                Some(bytes) => {
                    let _ = fs::write(&path, bytes);
                }
                None => {
                    let _ = fs::remove_file(&path);
                }
            }
        }
        return Err(error);
    }
    Ok(())
}

fn render_json(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

fn validated_manifest_path(repo_dir: &Path, value: &Value, field: &str) -> Result<String, String> {
    let Some(text) = value.as_str() else {
        return Err(invalid(field, "must be a string"));
    };
    if text.is_empty() {
        return Err(invalid(field, "must not be empty"));
    }
    if is_absolute_path(text) {
        return Err(invalid(field, "must be a repository-relative path"));
    }
    let segments: Vec<&str> = text.split(['/', '\\']).collect();
    if segments.contains(&"..") {
        return Err(invalid(field, "must not carry a .. segment"));
    }
    if segments.first() != Some(&".omp") || segments.len() < 2 {
        return Err(invalid(field, "must stay under .omp/"));
    }
    let _ = repo_dir;
    Ok(text.to_string())
}

fn validated_manifest_path_record(
    repo_dir: &Path,
    value: Option<&Value>,
    field: &str,
) -> Result<Map<String, Value>, String> {
    let Some(value) = value else {
        return Ok(Map::new());
    };
    let Some(record) = value.as_object() else {
        return Err(invalid(field, "must be an object of repository paths"));
    };
    let mut out = Map::new();
    for (name, entry) in record {
        out.insert(
            name.clone(),
            Value::String(validated_manifest_path(
                repo_dir,
                entry,
                &format!("{field}.{name}"),
            )?),
        );
    }
    Ok(out)
}

fn validated_manifest_paths(
    repo_dir: &Path,
    value: &Value,
    field: &str,
) -> Result<Map<String, Value>, String> {
    let Some(record) = value.as_object() else {
        return Err(invalid(field, "must be an object"));
    };
    let mut out = Map::new();
    out.insert(
        "manifest".to_string(),
        Value::String(validated_manifest_path(
            repo_dir,
            record.get("manifest").unwrap_or(&Value::Null),
            &format!("{field}.manifest"),
        )?),
    );
    out.insert(
        "sheet".to_string(),
        Value::String(validated_manifest_path(
            repo_dir,
            record.get("sheet").unwrap_or(&Value::Null),
            &format!("{field}.sheet"),
        )?),
    );
    out.insert(
        "decisions".to_string(),
        Value::String(validated_manifest_path(
            repo_dir,
            record.get("decisions").unwrap_or(&Value::Null),
            &format!("{field}.decisions"),
        )?),
    );
    let Some(glossaries) = record.get("glossaries").and_then(Value::as_array) else {
        return Err(invalid(
            &format!("{field}.glossaries"),
            "must be a list of repository paths",
        ));
    };
    let mut list = Vec::new();
    for (index, entry) in glossaries.iter().enumerate() {
        list.push(Value::String(validated_manifest_path(
            repo_dir,
            entry,
            &format!("{field}.glossaries[{index}]"),
        )?));
    }
    out.insert("glossaries".to_string(), Value::Array(list));
    out.insert(
        "baselines".to_string(),
        Value::Object(validated_manifest_path_record(
            repo_dir,
            record.get("baselines"),
            &format!("{field}.baselines"),
        )?),
    );
    out.insert(
        "live".to_string(),
        Value::Object(validated_manifest_path_record(
            repo_dir,
            record.get("live"),
            &format!("{field}.live"),
        )?),
    );
    if let Some(significance) = record.get("significance") {
        out.insert(
            "significance".to_string(),
            Value::String(validated_manifest_path(
                repo_dir,
                significance,
                &format!("{field}.significance"),
            )?),
        );
    }
    if let Some(contribution) = record.get("contribution") {
        out.insert(
            "contribution".to_string(),
            Value::String(validated_manifest_path(
                repo_dir,
                contribution,
                &format!("{field}.contribution"),
            )?),
        );
    }
    Ok(out)
}

fn read_manifest(repo_dir: &Path) -> Result<Option<Value>, String> {
    let path = discover_root(repo_dir).join("manifest.json");
    if !path.exists() {
        return Ok(None);
    }
    let source = fs::read_to_string(&path)
        .map_err(|error| format!("manifest.json is not valid JSON: {error}"))?;
    let parsed: Value = serde_json::from_str(&source)
        .map_err(|error| format!("manifest.json is not valid JSON: {error}"))?;
    if !is_record(&parsed) || parsed.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("manifest.json has an unsupported version".to_string());
    }
    let mut manifest = parsed.as_object().cloned().unwrap_or_default();
    manifest.insert(
        "paths".to_string(),
        Value::Object(validated_manifest_paths(
            repo_dir,
            parsed.get("paths").unwrap_or(&Value::Null),
            "manifest.json.paths",
        )?),
    );
    Ok(Some(Value::Object(manifest)))
}

fn read_decisions(repo_dir: &Path) -> Result<Vec<Value>, String> {
    let path = discover_root(repo_dir).join("decisions.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let source = fs::read_to_string(&path)
        .map_err(|error| format!("decisions.json is not valid JSON: {error}"))?;
    let parsed: Value = serde_json::from_str(&source)
        .map_err(|error| format!("decisions.json is not valid JSON: {error}"))?;
    let Some(items) = parsed.as_array() else {
        return Err("decisions.json is not a list".to_string());
    };
    let mut decisions = Vec::new();
    for (index, entry) in items.iter().enumerate() {
        let Some(record) = entry.as_object() else {
            return Err(invalid(&format!("decisions[{index}]"), "must be an object"));
        };
        let action = record
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if action != "confirm" && action != "reject" {
            return Err(invalid(
                &format!("decisions[{index}].action"),
                "must be confirm or reject",
            ));
        }
        let reason = match record.get("reason") {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(text)) => Value::String(text.clone()),
            Some(_) => {
                return Err(invalid(
                    &format!("decisions[{index}].reason"),
                    "must be a string or null",
                ))
            }
        };
        let date = record
            .get("date")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !date_pattern().is_match(date) {
            return Err(invalid(
                &format!("decisions[{index}].date"),
                "must be a YYYY-MM-DD date",
            ));
        }
        decisions.push(json!({
            "context": text_value(record.get("context").unwrap_or(&Value::Null), &format!("decisions[{index}].context"), 120)?,
            "id": text_value(record.get("id").unwrap_or(&Value::Null), &format!("decisions[{index}].id"), 120)?,
            "action": action,
            "reason": reason,
            "date": date,
        }));
    }
    Ok(decisions)
}

fn collision_at(repo_dir: &Path, name: &str) -> Option<String> {
    let path = live_skill_path(repo_dir, name);
    if !path.exists() {
        return None;
    }
    let Ok(text) = fs::read_to_string(&path) else {
        return Some(format!(
            "{name} is unreadable, so Discover will not replace it"
        ));
    };
    let Ok(parsed) = parse_skill(&text, name) else {
        return Some(format!(
            "{name} is an unmanaged skill, so Discover will not replace it"
        ));
    };
    if parsed
        .fields
        .get("metadata.devboard-managed")
        .map(String::as_str)
        != Some("true")
    {
        return Some(format!(
            "{name} is an unmanaged skill, so Discover will not replace it"
        ));
    }
    let family = parsed
        .fields
        .get("metadata.devboard-family")
        .cloned()
        .unwrap_or_else(|| "prepare".to_string());
    if family != "discover" {
        return Some(format!(
            "{name} belongs to the {family} family, so Discover will not replace it"
        ));
    }
    None
}

fn merge_glossary(existing: Option<&Glossary>, staged: &Glossary) -> Glossary {
    let Some(existing) = existing else {
        return staged.clone();
    };
    let mut preserved: Vec<Concept> = Vec::new();
    for concept in &staged.concepts {
        let previous = existing
            .concepts
            .iter()
            .find(|entry| entry.id == concept.id);
        match previous {
            Some(previous)
                if previous.status == "confirmed" || previous.status == "invalidated" =>
            {
                let mut merged = previous.clone();
                merged.grounding = concept.grounding.clone();
                preserved.push(merged);
            }
            _ => preserved.push(concept.clone()),
        }
    }
    let seen: HashSet<String> = preserved.iter().map(|concept| concept.id.clone()).collect();
    for previous in &existing.concepts {
        if previous.status != "confirmed" && previous.status != "invalidated" {
            continue;
        }
        if seen.contains(&previous.id) {
            continue;
        }
        preserved.push(previous.clone());
    }
    preserved.sort_by(|left, right| left.id.cmp(&right.id));
    Glossary {
        bounded_context: staged.bounded_context.clone(),
        titles: staged.titles.clone(),
        concepts: preserved,
    }
}

fn read_published_glossaries(
    repo_dir: &Path,
    manifest: Option<&Value>,
) -> Result<Vec<Glossary>, String> {
    let Some(manifest) = manifest else {
        return Ok(Vec::new());
    };
    let host = host_files(repo_dir);
    let mut glossaries = Vec::new();
    if let Some(paths) = manifest
        .get("paths")
        .and_then(|paths| paths.get("glossaries"))
        .and_then(Value::as_array)
    {
        for entry in paths {
            let Some(relative) = entry.as_str() else {
                continue;
            };
            let text = fs::read_to_string(repo_dir.join(relative))
                .map_err(|error| format!("{relative} is unreadable: {error}"))?;
            glossaries.push(parse_glossary(
                &text, relative, repo_dir, &host, true, false,
            )?);
        }
    }
    Ok(glossaries)
}

struct SkillPublication {
    entry: Value,
    writes: Vec<FileWrite>,
}

fn publish_skill(
    repo_dir: &Path,
    staged: &StagedSkill,
    previous: Option<&Value>,
) -> SkillPublication {
    let name = staged.name.as_str();
    let baseline = staged.text.clone();
    let baseline_hash = sha256_hex(baseline.as_bytes());
    let live_path = live_skill_path(repo_dir, name);
    let mut writes = vec![FileWrite {
        path: baseline_path(repo_dir, name),
        content: baseline.clone(),
    }];
    let state;
    let mut current_hash: Value;
    if !live_path.exists() {
        if previous.is_none() {
            state = "generated";
            current_hash = Value::String(baseline_hash.clone());
            writes.push(FileWrite {
                path: live_path,
                content: baseline,
            });
        } else {
            state = "missing";
            current_hash = Value::Null;
        }
    } else {
        let live_text = fs::read_to_string(&live_path).unwrap_or_default();
        let live_hash = sha256_hex(live_text.as_bytes());
        current_hash = Value::String(live_hash.clone());
        let previous_baseline = previous
            .and_then(|entry| entry.get("baselineHash"))
            .and_then(Value::as_str);
        let decided = if previous.is_some() {
            live_hash != previous_baseline.unwrap_or_default()
        } else {
            live_hash != baseline_hash
        };
        if decided {
            state = "edited";
        } else {
            state = "generated";
            current_hash = Value::String(baseline_hash.clone());
            writes.push(FileWrite {
                path: live_path,
                content: baseline,
            });
        }
    }
    SkillPublication {
        entry: json!({
            "name": name,
            "baselineHash": baseline_hash,
            "currentHash": current_hash,
            "state": state,
        }),
        writes,
    }
}

pub struct PublishOutcome {
    pub manifest: Value,
    pub warnings: Vec<String>,
}

/// Validates and publishes exactly one agent's slice.
pub fn publish_agent_staged(
    repo_dir: &Path,
    run_id: &str,
    facts: &HostFacts,
    staging_dir: &Path,
    project: &str,
    agent: &str,
) -> Result<PublishOutcome, String> {
    let ownership =
        agent_ownership(agent).ok_or_else(|| format!("unknown Discover agent: {agent}"))?;
    let discovered_at = iso_now();
    let freshness = json!({
        "project": project,
        "commit": facts.commit,
        "dirty": facts.dirty,
        "discoveredAt": discovered_at,
        "fingerprint": facts.fingerprint,
    });
    let staged = validate_agent_staged(repo_dir, staging_dir, &freshness, agent)?;
    for name in &ownership.skills {
        if let Some(collision) = collision_at(repo_dir, name) {
            return Err(collision);
        }
    }
    let previous_manifest = read_manifest(repo_dir)?;
    let previous_paths = match &previous_manifest {
        Some(manifest) => Some(validated_manifest_paths(
            repo_dir,
            manifest.get("paths").unwrap_or(&Value::Null),
            "manifest.json.paths",
        )?),
        None => None,
    };
    let mut skill_entries: Map<String, Value> = Map::new();
    if let Some(manifest) = &previous_manifest {
        if let Some(skills) = manifest.get("skills").and_then(Value::as_array) {
            for entry in skills {
                if let Some(name) = entry.get("name").and_then(Value::as_str) {
                    skill_entries.insert(name.to_string(), entry.clone());
                }
            }
        }
    }
    let previous_skills = skill_entries.clone();
    let mut writes: Vec<FileWrite> = Vec::new();
    let mut deletions: Vec<PathBuf> = Vec::new();
    let mut merged_glossaries: Option<Vec<Glossary>> = None;
    if ownership.glossary {
        let previous_glossaries = read_published_glossaries(repo_dir, previous_manifest.as_ref())?;
        let mut merged: Vec<Glossary> = staged
            .glossaries
            .iter()
            .map(|glossary| {
                let previous = previous_glossaries
                    .iter()
                    .find(|candidate| candidate.bounded_context == glossary.bounded_context);
                merge_glossary(previous, glossary)
            })
            .collect();
        for previous in &previous_glossaries {
            if staged
                .glossaries
                .iter()
                .any(|glossary| glossary.bounded_context == previous.bounded_context)
            {
                continue;
            }
            if previous
                .concepts
                .iter()
                .any(|concept| concept.status == "confirmed" || concept.status == "invalidated")
            {
                merged.push(previous.clone());
            }
        }
        merged.sort_by(|left, right| left.bounded_context.cmp(&right.bounded_context));
        for glossary in &mut merged {
            for concept in &mut glossary.concepts {
                if concept.status == "proposed" || concept.status == "unconfirmed" {
                    concept.status = "confirmed".to_string();
                }
            }
        }
        let staged_significance = staged
            .significance
            .clone()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let previous_significance = previous_paths
            .as_ref()
            .and_then(|paths| paths.get("significance"))
            .and_then(Value::as_str)
            .map(|path| read_significance(repo_dir, path, &merged))
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut contexts = Map::new();
        for glossary in &merged {
            let context = &glossary.bounded_context;
            let entries = staged_significance
                .get(context)
                .or_else(|| previous_significance.get(context));
            if let Some(entries) = entries {
                contexts.insert(context.clone(), entries.clone());
            }
        }
        writes.push(FileWrite {
            path: significance_path(repo_dir),
            content: render_json(&json!({
                "schemaVersion": 1,
                "contexts": Value::Object(contexts),
            })),
        });
        for glossary in &merged {
            writes.push(FileWrite {
                path: glossary_path(repo_dir, &glossary.bounded_context),
                content: render_glossary(glossary),
            });
        }
        let desired: HashSet<PathBuf> = merged
            .iter()
            .map(|glossary| glossary_path(repo_dir, &glossary.bounded_context))
            .collect();
        let glossary_root = discover_root(repo_dir).join("glossary");
        if let Ok(entries) = fs::read_dir(&glossary_root) {
            for entry in entries.flatten() {
                let absolute = entry.path();
                if !desired.contains(&absolute) && absolute.is_file() {
                    deletions.push(absolute);
                }
            }
        }
        merged_glossaries = Some(merged);
    }
    for staged_skill in &staged.skills {
        let publication = publish_skill(
            repo_dir,
            staged_skill,
            previous_skills.get(&staged_skill.name),
        );
        skill_entries.insert(staged_skill.name.clone(), publication.entry);
        writes.extend(publication.writes);
    }
    let mut sheet_digest = match &previous_manifest {
        Some(manifest) => manifest.get("sheetDigest").cloned().unwrap_or(Value::Null),
        None => Value::Null,
    };
    if ownership.sheet {
        let Some(sheet) = &staged.sheet else {
            return Err("the agent left no sheet.json".to_string());
        };
        sheet_digest = Value::String(sheet_digest_of(sheet));
        writes.push(FileWrite {
            path: repo_dir.join(".omp/discover/sheet.json"),
            content: render_json(sheet),
        });
    }
    if ownership.contribution {
        let Some(contribution) = &staged.contribution else {
            return Err("the agent left no contribution.json".to_string());
        };
        let document = derive_contribution(contribution, &freshness);
        writes.push(FileWrite {
            path: repo_dir.join(".omp/discover/contribution.json"),
            content: render_json(&document),
        });
    }
    let ordered_skills: Vec<Value> = DISCOVER_SKILLS
        .iter()
        .filter_map(|name| skill_entries.get(*name).cloned())
        .collect();
    let glossary_digests = match &merged_glossaries {
        Some(glossaries) => {
            let mut digests = Map::new();
            for glossary in glossaries {
                digests.insert(
                    glossary.bounded_context.clone(),
                    Value::String(glossary_digest(glossary)),
                );
            }
            Value::Object(digests)
        }
        None => previous_manifest
            .as_ref()
            .and_then(|manifest| manifest.get("glossaryDigests").cloned())
            .unwrap_or_else(|| Value::Object(Map::new())),
    };
    let mut paths = Map::new();
    paths.insert(
        "manifest".to_string(),
        Value::String(".omp/discover/manifest.json".to_string()),
    );
    paths.insert(
        "sheet".to_string(),
        Value::String(".omp/discover/sheet.json".to_string()),
    );
    paths.insert(
        "decisions".to_string(),
        Value::String(".omp/discover/decisions.json".to_string()),
    );
    if let Some(glossaries) = &merged_glossaries {
        paths.insert(
            "glossaries".to_string(),
            Value::Array(
                glossaries
                    .iter()
                    .map(|glossary| {
                        Value::String(format!(
                            ".omp/discover/glossary/{}.glossary.yaml",
                            glossary.bounded_context
                        ))
                    })
                    .collect(),
            ),
        );
    } else {
        paths.insert(
            "glossaries".to_string(),
            previous_paths
                .as_ref()
                .and_then(|paths| paths.get("glossaries").cloned())
                .unwrap_or_else(|| Value::Array(Vec::new())),
        );
    }
    let mut baselines = Map::new();
    let mut live = Map::new();
    for entry in &ordered_skills {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
        baselines.insert(
            name.to_string(),
            Value::String(format!(".omp/discover/skills/{name}/SKILL.md")),
        );
        live.insert(
            name.to_string(),
            Value::String(format!(".omp/skills/{name}/SKILL.md")),
        );
    }
    paths.insert("baselines".to_string(), Value::Object(baselines));
    paths.insert("live".to_string(), Value::Object(live));
    let significance = if ownership.glossary || previous_paths.is_none() {
        Value::String(".omp/discover/significance.json".to_string())
    } else {
        previous_paths
            .as_ref()
            .and_then(|paths| paths.get("significance").cloned())
            .unwrap_or(Value::Null)
    };
    if previous_paths.is_none() && !ownership.glossary {
        // A skill-only first publication carries no sidecar path at all.
    } else if significance.is_null() {
        // A host published before the sidecar existed keeps its manifest free
        // of the path until a glossary agent republishes.
    } else {
        paths.insert("significance".to_string(), significance);
    }
    let contribution_path = if ownership.contribution {
        Some(Value::String(".omp/discover/contribution.json".to_string()))
    } else {
        previous_paths
            .as_ref()
            .and_then(|paths| paths.get("contribution").cloned())
    };
    if let Some(contribution_path) = contribution_path {
        paths.insert("contribution".to_string(), contribution_path);
    }
    let manifest = json!({
        "schemaVersion": 1,
        "fingerprint": facts.fingerprint,
        "publishedAt": iso_now(),
        "runId": run_id,
        "sheetDigest": sheet_digest,
        "glossaryDigests": glossary_digests,
        "skills": ordered_skills,
        "paths": Value::Object(paths),
    });
    let decisions = read_decisions(repo_dir)?;
    writes.push(FileWrite {
        path: repo_dir.join(".omp/discover/manifest.json"),
        content: render_json(&manifest),
    });
    writes.push(FileWrite {
        path: repo_dir.join(".omp/discover/decisions.json"),
        content: render_json(&Value::Array(decisions)),
    });
    write_transaction(&writes, &deletions)?;
    let warnings = live_skill_warnings(repo_dir, &manifest);
    Ok(PublishOutcome { manifest, warnings })
}

fn live_skill_warnings(repo_dir: &Path, manifest: &Value) -> Vec<String> {
    let Some(skills) = manifest.get("skills").and_then(Value::as_array) else {
        return Vec::new();
    };
    // Every skill with a live body is compared, edited or freshly generated:
    // a regeneration can contradict an edit that was made against the old
    // baseline, and an edited-versus-generated pair is exactly that case.
    let mut bodies = Vec::new();
    for entry in skills {
        let Some(name) = entry.get("name").and_then(Value::as_str) else {
            continue;
        };
        if let Ok(text) = fs::read_to_string(live_skill_path(repo_dir, name)) {
            bodies.push((name.to_string(), text));
        }
    }
    skill_contradictions(&bodies)
        .into_iter()
        .map(|(left, right, subject)| format!("{left} and {right} disagree about {subject}"))
        .collect()
}

/// The sheet with volatile fields, bounded prose, and unknown reasons removed.
fn sheet_structural_skeleton(sheet: &Value) -> Value {
    fn canonical_leaf(leaf: &Value, prose: bool) -> Value {
        let confidence = leaf.get("confidence").and_then(Value::as_str).unwrap_or("");
        let mut out = Map::new();
        let value = leaf.get("value").cloned().unwrap_or(Value::Null);
        out.insert(
            "value".to_string(),
            if prose && !value.is_null() {
                Value::String(String::new())
            } else {
                value
            },
        );
        out.insert(
            "evidence".to_string(),
            leaf.get("evidence")
                .cloned()
                .unwrap_or(Value::Array(Vec::new())),
        );
        out.insert(
            "confidence".to_string(),
            Value::String(confidence.to_string()),
        );
        if confidence == "unknown" {
            out.insert("reason".to_string(), Value::String(String::new()));
        }
        Value::Object(out)
    }
    let mut skeleton = Map::new();
    skeleton.insert(
        "schemaVersion".to_string(),
        sheet.get("schemaVersion").cloned().unwrap_or(Value::Null),
    );
    let freshness = sheet.get("freshness").cloned().unwrap_or(Value::Null);
    skeleton.insert(
        "freshness".to_string(),
        json!({
            "project": freshness.get("project").cloned().unwrap_or(Value::Null),
            "commit": freshness.get("commit").cloned().unwrap_or(Value::Null),
            "dirty": freshness.get("dirty").cloned().unwrap_or(Value::Null),
        }),
    );
    for section in DISCOVER_SHEET_SECTIONS {
        let Some(value) = sheet.get(*section) else {
            continue;
        };
        let prose = *section == "definition";
        if is_record(value) && value.get("confidence").is_some() {
            skeleton.insert(section.to_string(), canonical_leaf(value, prose));
            continue;
        }
        let Some(fields) = value.as_object() else {
            skeleton.insert(section.to_string(), value.clone());
            continue;
        };
        let mut out = Map::new();
        for (key, field) in fields {
            if is_record(field) && field.get("confidence").is_some() {
                out.insert(key.clone(), canonical_leaf(field, false));
            } else {
                out.insert(key.clone(), field.clone());
            }
        }
        skeleton.insert(section.to_string(), Value::Object(out));
    }
    Value::Object(skeleton)
}

fn sheet_digest_of(sheet: &Value) -> String {
    sha256_hex(crate::jsjson::stringify(&sheet_structural_skeleton(sheet)).as_bytes())
}

// ---------------------------------------------------------- published view

#[derive(Clone)]
pub struct SkillView {
    pub name: String,
    pub description: String,
    pub state: String,
    pub baseline: Option<String>,
    pub live: Option<String>,
    pub baseline_hash: Option<String>,
    pub current_hash: Option<String>,
}

impl SkillView {
    fn to_json(&self) -> Value {
        let optional =
            |value: &Option<String>| value.clone().map(Value::String).unwrap_or(Value::Null);
        json!({
            "name": self.name,
            "description": self.description,
            "state": self.state,
            "baseline": optional(&self.baseline),
            "live": optional(&self.live),
            "baselineHash": optional(&self.baseline_hash),
            "currentHash": optional(&self.current_hash),
        })
    }
}

#[derive(Clone)]
pub struct Artifacts {
    pub manifest: Value,
    pub sheet: Option<Value>,
    pub glossaries: Vec<Glossary>,
    pub usage: Value,
    pub significance: Value,
    pub decisions: Vec<Value>,
    pub skills: Vec<SkillView>,
    pub contribution: Option<Value>,
}

pub struct ArtifactsRead {
    pub artifacts: Option<Artifacts>,
    pub error: Option<String>,
}

struct PublishedRead {
    manifest: Value,
    sheet: Option<Value>,
    glossaries: Vec<Glossary>,
    significance: Value,
    decisions: Vec<Value>,
    contribution: Option<Value>,
}

fn read_significance(repo_dir: &Path, relative_path: &str, glossaries: &[Glossary]) -> Value {
    let Ok(source) = fs::read_to_string(repo_dir.join(relative_path)) else {
        return Value::Object(Map::new());
    };
    let Ok(raw) = serde_json::from_str::<Value>(&source) else {
        return Value::Object(Map::new());
    };
    if !is_record(&raw) || raw.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Value::Object(Map::new());
    }
    let contexts = raw.get("contexts").and_then(Value::as_object);
    let mut published = Map::new();
    for glossary in glossaries {
        let Some(entries) = contexts
            .and_then(|contexts| contexts.get(&glossary.bounded_context))
            .and_then(Value::as_object)
        else {
            continue;
        };
        let mut scored = Map::new();
        for concept in &glossary.concepts {
            let Some(entry) = entries.get(&concept.id).and_then(Value::as_object) else {
                continue;
            };
            let Some(score) = entry
                .get("score")
                .and_then(Value::as_i64)
                .filter(|score| (0..=100).contains(score))
            else {
                continue;
            };
            let Some(reason) = entry
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
            else {
                continue;
            };
            scored.insert(
                concept.id.clone(),
                json!({"score": score, "reason": reason}),
            );
        }
        if !scored.is_empty() {
            published.insert(glossary.bounded_context.clone(), Value::Object(scored));
        }
    }
    Value::Object(published)
}

fn read_contribution_artifact(repo_dir: &Path, relative_path: &str) -> Option<Value> {
    let source = fs::read_to_string(repo_dir.join(relative_path)).ok()?;
    let raw: Value = serde_json::from_str(&source).ok()?;
    if raw.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    if !is_record(raw.get("freshness")?) || !raw.get("sections")?.is_array() {
        return None;
    }
    if raw.get("sections")?.as_array()?.len() != CONTRIBUTION_SECTION_IDS.len() {
        return None;
    }
    if !raw.get("sample")?.is_array() {
        return None;
    }
    Some(raw)
}

fn read_published(repo_dir: &Path) -> Result<Option<PublishedRead>, String> {
    let Some(manifest) = read_manifest(repo_dir)? else {
        return Ok(None);
    };
    let host = host_files(repo_dir);
    let mut sheet = None;
    if manifest
        .get("sheetDigest")
        .map(|digest| !digest.is_null())
        .unwrap_or(false)
    {
        let path = manifest
            .get("paths")
            .and_then(|paths| paths.get("sheet"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let source = fs::read_to_string(repo_dir.join(path))
            .map_err(|error| format!("sheet.json is unreadable: {error}"))?;
        let raw: Value = serde_json::from_str(&source)
            .map_err(|error| format!("sheet.json is unreadable: {error}"))?;
        if !is_record(&raw) {
            return Err("sheet.json is not an object".to_string());
        }
        let Some(freshness) = raw.get("freshness") else {
            return Err("sheet.json has no freshness header".to_string());
        };
        if !is_record(freshness) {
            return Err("sheet.json has no freshness header".to_string());
        }
        let mut content = raw.as_object().cloned().unwrap_or_default();
        content.remove("freshness");
        let header = json!({
            "project": text_value(freshness.get("project").unwrap_or(&Value::Null), "freshness.project", 200)?,
            "commit": text_value(freshness.get("commit").unwrap_or(&Value::Null), "freshness.commit", 64)?,
            "dirty": freshness.get("dirty").and_then(Value::as_bool).unwrap_or(false),
            "discoveredAt": text_value(freshness.get("discoveredAt").unwrap_or(&Value::Null), "freshness.discoveredAt", 64)?,
            "fingerprint": text_value(freshness.get("fingerprint").unwrap_or(&Value::Null), "freshness.fingerprint", 128)?,
        });
        sheet = Some(normalize_sheet(&Value::Object(content), &header)?);
    }
    let mut glossaries = Vec::new();
    if let Some(paths) = manifest
        .get("paths")
        .and_then(|paths| paths.get("glossaries"))
        .and_then(Value::as_array)
    {
        for entry in paths {
            let Some(relative) = entry.as_str() else {
                continue;
            };
            let text = fs::read_to_string(repo_dir.join(relative))
                .map_err(|error| format!("{relative} is unreadable: {error}"))?;
            glossaries.push(parse_glossary(
                &text, relative, repo_dir, &host, true, false,
            )?);
        }
    }
    let significance = match manifest
        .get("paths")
        .and_then(|paths| paths.get("significance"))
        .and_then(Value::as_str)
    {
        Some(path) => read_significance(repo_dir, path, &glossaries),
        None => Value::Object(Map::new()),
    };
    let decisions = read_decisions(repo_dir)?;
    let contribution = manifest
        .get("paths")
        .and_then(|paths| paths.get("contribution"))
        .and_then(Value::as_str)
        .and_then(|path| read_contribution_artifact(repo_dir, path));
    Ok(Some(PublishedRead {
        manifest,
        sheet,
        glossaries,
        significance,
        decisions,
        contribution,
    }))
}

fn read_skill_view(repo_dir: &Path, manifest: &Value, name: &str) -> SkillView {
    let entry = manifest
        .get("skills")
        .and_then(Value::as_array)
        .and_then(|skills| {
            skills
                .iter()
                .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
        });
    let baseline_file = baseline_path(repo_dir, name);
    let live_file = live_skill_path(repo_dir, name);
    let baseline = fs::read_to_string(&baseline_file).ok();
    let live = fs::read_to_string(&live_file).ok();
    let baseline_hash = baseline.as_ref().map(|text| sha256_hex(text.as_bytes()));
    let current_hash = live.as_ref().map(|text| sha256_hex(text.as_bytes()));
    let description = parse_skill(live.as_deref().or(baseline.as_deref()).unwrap_or(""), name)
        .ok()
        .and_then(|parsed| parsed.fields.get("description").cloned())
        .unwrap_or_default();
    let state = if live.is_none() {
        "missing"
    } else if (baseline_hash.is_some() && current_hash == baseline_hash)
        || entry
            .and_then(|entry| entry.get("baselineHash"))
            .and_then(Value::as_str)
            .map(|hash| Some(hash.to_string()) == current_hash)
            .unwrap_or(false)
    {
        "generated"
    } else {
        "edited"
    };
    SkillView {
        name: name.to_string(),
        description,
        state: state.to_string(),
        baseline,
        live,
        baseline_hash,
        current_hash,
    }
}

/// Reads the published artifacts from disk; never writes or repairs them.
pub fn read_artifacts(repo_dir: &Path) -> ArtifactsRead {
    match read_published(repo_dir) {
        Err(error) => ArtifactsRead {
            artifacts: None,
            error: Some(error),
        },
        Ok(None) => ArtifactsRead {
            artifacts: None,
            error: None,
        },
        Ok(Some(published)) => {
            let fingerprint = published
                .manifest
                .get("fingerprint")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let skills = DISCOVER_SKILLS
                .iter()
                .filter(|name| {
                    published
                        .manifest
                        .get("skills")
                        .and_then(Value::as_array)
                        .map(|entries| {
                            entries.iter().any(|entry| {
                                entry.get("name").and_then(Value::as_str) == Some(**name)
                            })
                        })
                        .unwrap_or(false)
                })
                .map(|name| read_skill_view(repo_dir, &published.manifest, name))
                .collect();
            let usage = glossary_usage(repo_dir, &published.glossaries, &fingerprint);
            ArtifactsRead {
                artifacts: Some(Artifacts {
                    manifest: published.manifest,
                    sheet: published.sheet,
                    glossaries: published.glossaries,
                    usage,
                    significance: published.significance,
                    decisions: published.decisions,
                    skills,
                    contribution: published.contribution,
                }),
                error: None,
            }
        }
    }
}

pub fn live_warnings(repo_dir: &Path, artifacts: &Artifacts) -> Vec<String> {
    // Compare every skill whose live body exists, so an edited skill is still
    // compared with one a publication just regenerated.
    let bodies: Vec<(String, String)> = artifacts
        .skills
        .iter()
        .filter_map(|skill| skill.live.clone().map(|live| (skill.name.clone(), live)))
        .collect();
    if bodies.is_empty() {
        return Vec::new();
    }
    let _ = repo_dir;
    skill_contradictions(&bodies)
        .into_iter()
        .map(|(left, right, subject)| format!("{left} and {right} disagree about {subject}"))
        .collect()
}

pub fn artifacts_stale(repo_dir: &Path, artifacts: Option<&Artifacts>) -> bool {
    let Some(artifacts) = artifacts else {
        return false;
    };
    let fingerprint = artifacts
        .manifest
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or("");
    host_facts(repo_dir).fingerprint != fingerprint
}

// ------------------------------------------------------- derived payloads

/// A recorded command paired with the installed invocation that runs it.
pub fn declared_command_aliases(root: &Path) -> Value {
    let Ok(source) = fs::read_to_string(root.join("package.json")) else {
        return Value::Array(Vec::new());
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&source) else {
        return Value::Array(Vec::new());
    };
    let Some(scripts) = manifest.get("scripts").and_then(Value::as_object) else {
        return Value::Array(Vec::new());
    };
    let mut names: Vec<&String> = scripts.keys().collect();
    names.sort_by(|left, right| {
        if left.as_str() == "test" {
            std::cmp::Ordering::Less
        } else if right.as_str() == "test" {
            std::cmp::Ordering::Greater
        } else {
            left.cmp(right)
        }
    });
    let mut aliases: Vec<(String, String)> = Vec::new();
    for name in names {
        let Some(body) = scripts.get(name).and_then(Value::as_str) else {
            continue;
        };
        let command = body.split_whitespace().collect::<Vec<_>>().join(" ");
        if command.is_empty() || aliases.iter().any(|(existing, _)| existing == &command) {
            continue;
        }
        let alias = if name == "test" {
            "npm test".to_string()
        } else {
            format!("npm run {name}")
        };
        aliases.push((command, alias));
    }
    aliases.sort_by(|left, right| left.0.cmp(&right.0));
    Value::Array(
        aliases
            .into_iter()
            .map(|(command, alias)| json!({"command": command, "alias": alias}))
            .collect(),
    )
}

fn dependency_name(line: &str) -> String {
    let token = line.split_whitespace().next().unwrap_or("");
    match token.rfind('@') {
        Some(index) if index > 0 => token[..index].to_string(),
        _ => token.to_string(),
    }
}

fn dependency_candidates(node: &Value, names: &mut std::collections::BTreeSet<String>) {
    match node {
        Value::String(text) => {
            let name = dependency_name(text);
            if !name.is_empty() {
                names.insert(name);
            }
        }
        Value::Array(items) => {
            for entry in items {
                dependency_candidates(entry, names);
            }
        }
        Value::Object(record) => {
            if record.contains_key("confidence") && record.contains_key("evidence") {
                if let Some(value) = record.get("value") {
                    dependency_candidates(value, names);
                }
                return;
            }
            for value in record.values() {
                dependency_candidates(value, names);
            }
        }
        _ => {}
    }
}

fn normalize_repository_url(raw: &str, directory: Option<&str>) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    static SHORTHAND: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^github:([\w.-]+)/([\w.-]+?)(?:\.git)?$").expect("a shorthand")
    });
    if let Some(captures) = SHORTHAND.captures(trimmed) {
        return Some(format!(
            "https://github.com/{}/{}",
            captures.get(1)?.as_str(),
            captures.get(2)?.as_str()
        ));
    }
    let mut candidate = trimmed.strip_prefix("git+").unwrap_or(trimmed).to_string();
    static SCP: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^git@([^:\s]+):(.+)$").expect("an scp URL"));
    if let Some(captures) = SCP.captures(&candidate) {
        candidate = format!(
            "https://{}/{}",
            captures.get(1)?.as_str(),
            captures.get(2)?.as_str()
        );
    }
    candidate = candidate
        .strip_prefix("ssh://git@")
        .map(|rest| format!("https://{rest}"))
        .unwrap_or(candidate);
    candidate = candidate
        .strip_prefix("git://")
        .map(|rest| format!("https://{rest}"))
        .unwrap_or(candidate);
    let url = url::Url::parse(&candidate).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    let path = url
        .path()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_start_matches('/')
        .to_string();
    if path.is_empty() {
        return None;
    }
    let base = format!(
        "{}://{}{}/{path}",
        url.scheme(),
        url.host_str().unwrap_or(""),
        url.port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    );
    let Some(directory) = directory.filter(|directory| !directory.is_empty()) else {
        return Some(base);
    };
    if url.host_str() != Some("github.com") {
        return Some(base);
    }
    let web = directory
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            url::form_urlencoded::byte_serialize(segment.as_bytes())
                .collect::<String>()
                .replace('+', "%20")
        })
        .collect::<Vec<_>>()
        .join("/");
    Some(format!("{base}/tree/HEAD/{web}"))
}

/// Directories whose `node_modules` may hold an installed package: the
/// repository root first, then the directory of every manifest the sheet
/// records. A manifest path that is absolute or escapes the repository
/// contributes nothing.
fn install_roots(repo_dir: &Path, sheet: &Value) -> Vec<PathBuf> {
    let mut roots = vec![repo_dir.to_path_buf()];
    let manifests = sheet
        .get("runtime")
        .and_then(|runtime| runtime.get("manifests"))
        .and_then(|leaf| leaf.get("value"))
        .and_then(Value::as_array);
    for manifest in manifests.into_iter().flatten() {
        let Some(text) = manifest.as_str().map(str::trim) else {
            continue;
        };
        if text.is_empty() || is_absolute_path(text) {
            continue;
        }
        if text.split(['/', '\\']).any(|segment| segment == "..") {
            continue;
        }
        let Some(parent) = Path::new(text).parent() else {
            continue;
        };
        if parent.as_os_str().is_empty() {
            continue;
        }
        let root = repo_dir.join(parent);
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn package_repository(roots: &[PathBuf], name: &str) -> Option<String> {
    static PACKAGE_NAME: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
            .expect("a package name")
    });
    if !PACKAGE_NAME.is_match(name) || name.contains("..") {
        return None;
    }
    roots.iter().find_map(|root| {
        let mut path = root.join("node_modules");
        for segment in name.split('/') {
            path = path.join(segment);
        }
        let source = fs::read_to_string(path.join("package.json")).ok()?;
        let manifest: Value = serde_json::from_str(&source).ok()?;
        let repository = manifest.get("repository")?;
        let (raw, directory) = if let Some(text) = repository.as_str() {
            (text.to_string(), None)
        } else {
            let record = repository.as_object()?;
            (
                record.get("url").and_then(Value::as_str)?.to_string(),
                record.get("directory").and_then(Value::as_str),
            )
        };
        normalize_repository_url(&raw, directory)
    })
}

pub fn dependency_repositories(repo_dir: &Path, sheet: Option<&Value>) -> Value {
    let Some(sheet) = sheet else {
        return Value::Object(Map::new());
    };
    let mut names = std::collections::BTreeSet::new();
    if let Some(stack) = sheet.get("stack") {
        dependency_candidates(stack, &mut names);
    }
    let mut links = Map::new();
    let roots = install_roots(repo_dir, sheet);
    for name in names {
        let url = package_repository(&roots, &name)
            .or_else(|| package_repository(&roots, &name.to_lowercase()));
        if let Some(url) = url {
            links.insert(name, Value::String(url));
        }
    }
    Value::Object(links)
}

fn overview_path_link(root: &Path, reference: &Value, host: bool) -> Option<String> {
    if !host {
        return None;
    }
    let value = reference.as_str().map(str::trim).unwrap_or("");
    if value.is_empty() || is_absolute_path(value) {
        return None;
    }
    if value.split(['/', '\\']).any(|segment| segment == "..") {
        return None;
    }
    let checkout = root.canonicalize().ok()?;
    let absolute = checkout.join(value);
    let real = absolute.canonicalize().ok()?;
    if real != checkout && !real.starts_with(&checkout) {
        return None;
    }
    let encoded = absolute
        .to_string_lossy()
        .split('/')
        .map(|segment| {
            url::form_urlencoded::byte_serialize(segment.as_bytes())
                .collect::<String>()
                .replace('+', "%20")
        })
        .collect::<Vec<_>>()
        .join("/");
    Some(format!("vscode://file/{encoded}"))
}

pub fn overview_path_links(root: &Path, sheet: Option<&Value>, host: bool) -> Value {
    let Some(sheet) = sheet else {
        return Value::Object(Map::new());
    };
    if !host {
        return Value::Object(Map::new());
    }
    let mut references: Vec<String> = Vec::new();
    let leaf_value = |section: &str, field: &str| -> Option<&Vec<Value>> {
        sheet.get(section)?.get(field)?.get("value")?.as_array()
    };
    if let Some(contexts) = leaf_value("architecture", "contexts") {
        for context in contexts {
            if let Some(entry_points) = context.get("entryPoints").and_then(Value::as_array) {
                for entry in entry_points {
                    if let Some(text) = entry.as_str() {
                        references.push(text.trim().to_string());
                    }
                }
            }
        }
    }
    for (section, field) in [("architecture", "sharedKernels"), ("runtime", "manifests")] {
        if let Some(values) = leaf_value(section, field) {
            for value in values {
                if let Some(text) = value.as_str() {
                    references.push(text.trim().to_string());
                }
            }
        }
    }
    references.retain(|reference| !reference.is_empty());
    references.sort();
    references.dedup();
    let mut links = Map::new();
    for reference in references {
        if let Some(href) = overview_path_link(root, &Value::String(reference.clone()), host) {
            links.insert(reference, Value::String(href));
        }
    }
    Value::Object(links)
}

// --------------------------------------------------------- glossary usage

fn usage_words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

fn usage_variants(labels: &[String]) -> Vec<String> {
    let mut variants = std::collections::BTreeSet::new();
    for label in labels {
        let words = usage_words(label);
        if words.is_empty() {
            continue;
        }
        let phrase = words.join(" ");
        if phrase.len() >= 2 {
            variants.insert(phrase);
        }
        if words.len() > 1 {
            variants.insert(words.join(""));
            variants.insert(words.join("_"));
            variants.insert(words.join("-"));
        }
    }
    let mut variants: Vec<String> = variants.into_iter().collect();
    variants.sort_by(|left, right| {
        if left.len() == right.len() {
            left.cmp(right)
        } else {
            right.len().cmp(&left.len())
        }
    });
    variants
}

fn count_occurrences(text: &str, term: &str) -> i64 {
    let mut count = 0;
    let mut index = 0;
    while let Some(found) = text[index..].find(term) {
        count += 1;
        index += found + term.len();
    }
    count
}

fn usage_files(repo_dir: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    for path in host_files(repo_dir) {
        let absolute = repo_dir.join(&path);
        // `metadata` follows a symlink: a tracked link to a readable file is
        // host documentation and counts, exactly as the crawl reads it.
        let Ok(metadata) = fs::metadata(&absolute) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > 512 * 1024 {
            continue;
        }
        let Ok(bytes) = fs::read(&absolute) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        files.push((path, String::from_utf8_lossy(&bytes).into_owned()));
    }
    files
}

/// How many usage analyses stay cached, keyed by host revision and glossary
/// shape.
const USAGE_CACHE_MAX: usize = 8;

static USAGE_CACHE: LazyLock<Mutex<VecDeque<(String, Value)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

/// The cache key: the repository, the fingerprint, and every concept's id,
/// labels, and grounding. A second publish of an unchanged host with the same
/// glossary reuses the analysis instead of walking the tree again.
fn usage_key(repo_dir: &Path, fingerprint: &str, glossaries: &[Glossary]) -> String {
    let shape: Vec<Value> = glossaries
        .iter()
        .map(|glossary| {
            json!({
                "context": glossary.bounded_context,
                "concepts": glossary.concepts.iter().map(|concept| {
                    json!({
                        "id": concept.id,
                        "labels": concept
                            .pref_labels
                            .iter()
                            .chain(concept.alt_labels.iter())
                            .map(|label| label.text.clone())
                            .collect::<Vec<_>>(),
                        "grounding": concept.grounding,
                    })
                }).collect::<Vec<_>>(),
            })
        })
        .collect();
    let digest = format!(
        "{}\u{0}{fingerprint}\u{0}{}",
        repo_dir.to_string_lossy(),
        crate::jsjson::stringify(&Value::Array(shape))
    );
    sha256_hex(digest.as_bytes())
}

fn identifier_pattern() -> &'static Regex {
    static PATTERN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[A-Za-z_$][A-Za-z0-9_$]*").expect("an identifier"));
    &PATTERN
}

pub fn glossary_usage(repo_dir: &Path, glossaries: &[Glossary], fingerprint: &str) -> Value {
    let key = usage_key(repo_dir, fingerprint, glossaries);
    let cached = {
        let cache = lock(&USAGE_CACHE);
        cache
            .iter()
            .find(|(existing, _)| existing == &key)
            .map(|(_, value)| value.clone())
    };
    if let Some(cached) = cached {
        return cached;
    }
    let files = usage_files(repo_dir);
    let mut usage = Map::new();
    for glossary in glossaries {
        let mut contexts = Map::new();
        for concept in &glossary.concepts {
            let labels: Vec<String> = concept
                .pref_labels
                .iter()
                .chain(concept.alt_labels.iter())
                .map(|label| label.text.clone())
                .collect();
            let variants = usage_variants(&labels);
            let word_sets: Vec<(Vec<String>, String)> = labels
                .iter()
                .map(|label| usage_words(label))
                .filter(|words| !words.is_empty())
                .map(|words| (words.clone(), words.join("")))
                .collect();
            let grounding: HashSet<&str> = concept
                .grounding
                .iter()
                .filter_map(|entry| entry.strip_prefix("code:"))
                .collect();
            let mut count = 0;
            let mut files_with = 0;
            let mut examples: HashMap<String, (i64, bool)> = HashMap::new();
            for (path, text) in &files {
                let haystack = text.to_lowercase();
                let mut in_file = 0;
                for variant in &variants {
                    in_file += count_occurrences(&haystack, variant);
                }
                if in_file > 0 {
                    count += in_file;
                    files_with += 1;
                }
                if word_sets.is_empty() {
                    continue;
                }
                let grounded = grounding.contains(path.as_str());
                for name in identifier_pattern().find_iter(text) {
                    let name = name.as_str();
                    if name.len() < 3 || name.len() > 80 {
                        continue;
                    }
                    let lower = name.to_lowercase();
                    let matches = word_sets.iter().any(|(words, compact)| {
                        if words.len() == 1 {
                            lower.contains(&words[0])
                        } else {
                            words.iter().all(|word| lower.contains(word)) || lower.contains(compact)
                        }
                    });
                    if !matches {
                        continue;
                    }
                    let entry = examples.entry(name.to_string()).or_insert((0, false));
                    entry.0 += 1;
                    entry.1 = entry.1 || grounded;
                }
            }
            for entry in &concept.grounding {
                if let Some(name) = entry.strip_prefix("model:") {
                    let value = examples.entry(name.to_string()).or_insert((0, false));
                    value.1 = true;
                }
            }
            let mut ranked: Vec<(String, i64, bool)> = examples
                .into_iter()
                .map(|(name, (count, grounded))| (name, count, grounded))
                .collect();
            ranked.sort_by(|left, right| {
                right
                    .2
                    .cmp(&left.2)
                    .then_with(|| right.1.cmp(&left.1))
                    .then_with(|| {
                        left.0
                            .to_lowercase()
                            .cmp(&right.0.to_lowercase())
                            .then_with(|| left.0.cmp(&right.0))
                    })
            });
            let examples: Vec<Value> = ranked
                .into_iter()
                .take(8)
                .map(|(name, _, _)| Value::String(name))
                .collect();
            contexts.insert(
                concept.id.clone(),
                json!({"count": count, "files": files_with, "examples": examples}),
            );
        }
        usage.insert(glossary.bounded_context.clone(), Value::Object(contexts));
    }
    let usage = Value::Object(usage);
    {
        let mut cache = lock(&USAGE_CACHE);
        if !cache.iter().any(|(existing, _)| existing == &key) {
            cache.push_back((key, usage.clone()));
        }
        while cache.len() > USAGE_CACHE_MAX {
            cache.pop_front();
        }
    }
    usage
}
// ------------------------------------------------------------- mode state

#[derive(Clone)]
struct AgentStatus {
    state: &'static str,
    started_at: Option<String>,
    ended_at: Option<String>,
    error: Option<String>,
}

impl AgentStatus {
    fn idle() -> Self {
        Self {
            state: "idle",
            started_at: None,
            ended_at: None,
            error: None,
        }
    }
}

#[derive(Clone)]
struct Checkout {
    run_id: String,
    dir: PathBuf,
    target: RemoteRepository,
}

#[derive(Clone)]
struct Cloning {
    url: String,
    target: RemoteRepository,
    staging: PathBuf,
}

#[derive(Clone)]
struct Run {
    run_id: String,
    staging_dir: PathBuf,
    cwd: PathBuf,
    started_at: String,
    agent: String,
    mode: &'static str,
    activity: Vec<String>,
    question: Option<AcpQuestion>,
    remote: Option<RemoteRepository>,
    resumed: bool,
    peer: Option<Arc<DetachedPeer>>,
}

struct ModeState {
    run: Option<Run>,
    interrupted: bool,
    artifacts: Option<Artifacts>,
    read_error: Option<String>,
    warnings: Vec<String>,
    stale: bool,
    statuses: Vec<AgentStatus>,
    all_active: bool,
    all_failed: Option<String>,
    target: Option<RemoteRepository>,
    checkout: Option<Checkout>,
    cloning: Option<Cloning>,
    starting: bool,
    request: u64,
    restored: Option<StoredDiscover>,
    notice: Option<String>,
    host_repository: Option<String>,
    remote_available: bool,
    remote_root: PathBuf,
    /// The busy reason the last pushed state carried; `None` inside means idle.
    last_busy: Option<Option<String>>,
}

#[derive(Clone)]
struct StoredDiscover {
    run_id: String,
    staging_dir: String,
    started_at: String,
    agent: String,
    activity: Vec<String>,
    remote: Option<RemoteRepository>,
}

impl ModeState {
    fn status(&self, id: &str) -> AgentStatus {
        self.statuses
            .get(
                DISCOVER_AGENTS
                    .iter()
                    .position(|descriptor| descriptor.id == id)
                    .unwrap_or(0),
            )
            .cloned()
            .unwrap_or_else(AgentStatus::idle)
    }

    fn set_status(&mut self, id: &str, status: AgentStatus) {
        if let Some(index) = DISCOVER_AGENTS
            .iter()
            .position(|descriptor| descriptor.id == id)
        {
            self.statuses[index] = status;
        }
    }

    fn reset_statuses(&mut self) {
        self.all_failed = None;
        self.statuses = DISCOVER_AGENTS
            .iter()
            .map(|_| AgentStatus::idle())
            .collect();
    }
}

pub struct Mode {
    app: Weak<App>,
    state: Mutex<ModeState>,
}

static MODES: Mutex<Vec<(Weak<App>, Arc<Mode>)>> = Mutex::new(Vec::new());

fn mode_for(app: &Arc<App>) -> Arc<Mode> {
    {
        let mut modes = lock(&MODES);
        modes.retain(|(weak, _)| weak.strong_count() > 0);
        for (weak, mode) in modes.iter() {
            if weak.ptr_eq(&Arc::downgrade(app)) {
                return Arc::clone(mode);
            }
        }
    }
    let mode = Arc::new(Mode {
        app: Arc::downgrade(app),
        state: Mutex::new(ModeState {
            run: None,
            interrupted: false,
            artifacts: None,
            read_error: None,
            warnings: Vec::new(),
            stale: false,
            statuses: DISCOVER_AGENTS
                .iter()
                .map(|_| AgentStatus::idle())
                .collect(),
            all_active: false,
            all_failed: None,
            target: None,
            checkout: None,
            cloning: None,
            starting: false,
            request: 0,
            restored: None,
            notice: None,
            host_repository: origin_repository(&app.config().repo_dir),
            remote_available: crate::version::is_harness_source_checkout(&app.config().repo_dir),
            remote_root: remote_scratch_root(&app.config().state_dir),
            last_busy: Some(None),
        }),
    });
    lock(&MODES).push((Arc::downgrade(app), Arc::clone(&mode)));
    mode
}

fn origin_repository(repo_dir: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["remote", "get-url", "origin"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        return None;
    }
    static SCP: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[^@/\s]+@([^:/\s]+):(.+)$").expect("an scp remote"));
    let (host, path) = if let Some(captures) = SCP.captures(&url) {
        (
            captures.get(1)?.as_str().to_lowercase(),
            captures.get(2)?.as_str().to_string(),
        )
    } else {
        let parsed = url::Url::parse(&url).ok()?;
        (
            parsed.host_str()?.to_lowercase(),
            parsed.path().trim_start_matches('/').to_string(),
        )
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() < 2 {
        return None;
    }
    if host.contains("gitlab") {
        return Some(segments.join("/"));
    }
    Some(format!(
        "{}/{}",
        segments[segments.len() - 2],
        segments[segments.len() - 1]
    ))
}

// ---------------------------------------------------------------- gate

struct DiscoverGate {
    mode: Arc<Mode>,
}

impl crate::app::ModeGate for DiscoverGate {
    fn has_active_work(&self) -> bool {
        let state = lock(&self.mode.state);
        state.run.is_some() || state.all_active || state.cloning.is_some() || state.starting
    }

    fn busy_reason(&self) -> Option<String> {
        let state = lock(&self.mode.state);
        if state.cloning.is_some() {
            return Some(GATE_CLONE_REASON.to_string());
        }
        if state.run.is_some() || state.all_active || state.starting {
            return Some(GATE_RUN_REASON.to_string());
        }
        None
    }

    fn abort_active_work(&self) {
        let app = mode_app(&self.mode);
        let run = {
            let mut state = lock(&self.mode.state);
            state.request += 1;
            let run = state.run.take();
            state.all_active = false;
            state.all_failed = None;
            if let Some(run) = &run {
                if let Some(peer) = &run.peer {
                    peer.close();
                }
                remove_staging(&run.cwd, &run.run_id);
                let started = state
                    .status(&run.agent)
                    .started_at
                    .unwrap_or_else(|| run.started_at.clone());
                state.set_status(
                    &run.agent,
                    AgentStatus {
                        state: "failed",
                        started_at: Some(started),
                        ended_at: Some(iso_now()),
                        error: Some("Stopped by the implementation reset.".to_string()),
                    },
                );
            }
            run
        };
        if run.is_some() {
            clear_remote_checkout(&app, &self.mode);
            if let Some(run) = run {
                app.shared.broadcast(json!({
                    "type": "discoverStopped",
                    "completed": false,
                    "agent": run.agent,
                    "mode": run.mode,
                }));
            }
        }
    }
}

const GATE_CLONE_REASON: &str =
    "A repository clone is active. Wait for it before starting other work.";
const GATE_RUN_REASON: &str =
    "A Discover run is active. Finish or stop it before starting other work.";

fn busy_reason(app: &Arc<App>) -> Option<String> {
    app.shared
        .busy_reason()
        .filter(|reason| reason.as_str() != GATE_CLONE_REASON && reason.as_str() != GATE_RUN_REASON)
}

// ------------------------------------------------------------- snapshots

/// The app this mode belongs to.
fn mode_app(mode: &Arc<Mode>) -> Arc<App> {
    mode.app
        .upgrade()
        .unwrap_or_else(|| unreachable!("the application outlives its modes"))
}

fn target_root(state: &ModeState, repo_dir: &Path) -> PathBuf {
    match &state.target {
        None => repo_dir.to_path_buf(),
        Some(target) => remote_project_directory(&state.remote_root, &target.owner, &target.repo),
    }
}

fn same_remote_target(left: Option<&RemoteRepository>, right: Option<&RemoteRepository>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            remote_clone_name(&left.owner, &left.repo)
                == remote_clone_name(&right.owner, &right.repo)
        }
        _ => false,
    }
}

fn project_name(repo_dir: &Path, remote: Option<&RemoteRepository>) -> String {
    match remote {
        Some(remote) => format!("{}/{}", remote.owner, remote.repo),
        None => crate::app::project_label(repo_dir),
    }
}

#[derive(Clone)]
struct DiscoverTarget {
    root: PathBuf,
    remote: Option<RemoteRepository>,
    project: String,
}

// ---------------------------------------------------------------- prompts

/// The target whose clone is live: its checkout while it runs, the cloning
/// target while it clones.
fn in_flight_target(state: &ModeState) -> Option<&RemoteRepository> {
    state
        .cloning
        .as_ref()
        .map(|cloning| &cloning.target)
        .or_else(|| state.checkout.as_ref().map(|checkout| &checkout.target))
}

/// The target the page shows: a live clone of another project wins over the
/// selected target.
fn shown_remote(state: &ModeState) -> Option<&RemoteRepository> {
    let in_flight = in_flight_target(state);
    if in_flight.is_some() && !same_remote_target(in_flight, state.target.as_ref()) {
        in_flight
    } else {
        state.target.as_ref()
    }
}

/// The root whose prompt files the shown target's agent reads: its live
/// checkout, the retained project when no checkout is live, and the host
/// checkout for the host target.
fn prompt_root(state: &ModeState, repo_dir: &Path) -> PathBuf {
    match shown_remote(state) {
        None => repo_dir.to_path_buf(),
        Some(remote) => state
            .checkout
            .as_ref()
            .filter(|checkout| same_remote_target(Some(&checkout.target), Some(remote)))
            .map(|checkout| checkout.dir.clone())
            .unwrap_or_else(|| {
                remote_project_directory(&state.remote_root, &remote.owner, &remote.repo)
            }),
    }
}

fn read_prompt(root: &Path, descriptor: &AgentDescriptor) -> Result<String, (PathBuf, io::Error)> {
    let path = root
        .join(".devboard")
        .join("prompts")
        .join(descriptor.prompt_file);
    fs::read_to_string(&path).map_err(|error| (path, error))
}

fn prompt_snapshot(root: &Path, host_root: &Path, descriptor: &AgentDescriptor) -> Value {
    let mut read = read_prompt(root, descriptor);
    // A retained remote project keeps only the published artifacts, so the
    // host's copy is the readable fallback when the target holds none.
    if matches!(&read, Err((_, error)) if error.kind() == io::ErrorKind::NotFound)
        && root != host_root
    {
        read = read_prompt(host_root, descriptor);
    }
    match read {
        Ok(text) => json!({
            "agent": descriptor.id,
            "text": text,
            "error": Value::Null,
        }),
        Err((path, error)) => {
            let reason = if error.kind() == io::ErrorKind::NotFound {
                format!(
                    "ENOENT: no such file or directory, open '{}'",
                    path.display()
                )
            } else if error.kind() == io::ErrorKind::PermissionDenied {
                format!("EACCES: permission denied, open '{}'", path.display())
            } else {
                error.to_string()
            };
            json!({
                "agent": descriptor.id,
                "text": Value::Null,
                "error": format!("Could not read the {} prompt: {reason}", descriptor.label),
            })
        }
    }
}

fn prompts_replay(repo_dir: &Path, state: &ModeState, conn: &Conn) {
    let root = prompt_root(state, repo_dir);
    for descriptor in DISCOVER_AGENTS {
        conn.send(json!({
            "type": "discoverPromptState",
            "agent": descriptor.id,
            "prompt": prompt_snapshot(&root, repo_dir, descriptor),
        }));
    }
}

// ---------------------------------------------------------------- payload

fn refresh_snapshot(app: &Arc<App>, state: &mut ModeState) {
    let repo_dir = app.config().repo_dir.clone();
    let root = target_root(state, &repo_dir);
    let read = read_artifacts(&root);
    state.artifacts = read.artifacts;
    state.read_error = read.error;
    let Some(artifacts) = &state.artifacts else {
        state.warnings.clear();
        state.stale = false;
        return;
    };
    state.warnings = live_warnings(&root, artifacts);
    state.stale = state.target.is_none() && artifacts_stale(&root, Some(artifacts));
}

fn discover_state_payload(app: &Arc<App>, state: &ModeState, busy: Option<String>) -> Value {
    let repo_dir = app.config().repo_dir.clone();
    let showing_in_flight = in_flight_target(state)
        .is_some_and(|target| !same_remote_target(Some(target), state.target.as_ref()));
    let shown_remote = shown_remote(state);
    let artifacts = if showing_in_flight {
        None
    } else {
        state.artifacts.as_ref()
    };
    let root = target_root(state, &repo_dir);
    let prompt_root = prompt_root(state, &repo_dir);

    let agents: Vec<Value> = DISCOVER_AGENTS
        .iter()
        .map(|descriptor| {
            let status = state.status(descriptor.id);
            json!({
                "id": descriptor.id,
                "label": descriptor.label,
                "command": descriptor.command,
                "state": status.state,
                "startedAt": status.started_at,
                "endedAt": status.ended_at,
                "error": status.error,
                "prompt": prompt_snapshot(&prompt_root, &repo_dir, descriptor),
            })
        })
        .collect();

    let retained: Vec<Value> = if state.remote_available {
        list_retained_projects(&state.remote_root)
            .into_iter()
            .map(|project| {
                json!({
                    "url": project.url,
                    "owner": project.owner,
                    "repo": project.repo,
                    "completedAt": project.completed_at,
                })
            })
            .collect()
    } else {
        Vec::new()
    };

    let target = match shown_remote {
        None => json!({"kind": "host"}),
        Some(remote) => json!({
            "kind": "remote",
            "url": remote.url,
            "owner": remote.owner,
            "repo": remote.repo,
            "checkout": state
                .checkout
                .as_ref()
                .map(|checkout| same_remote_target(Some(&checkout.target), Some(remote)))
                .unwrap_or(false),
        }),
    };
    let repository: Value = match shown_remote {
        None => state
            .host_repository
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
        Some(remote) => Value::String(format!("{}/{}", remote.owner, remote.repo)),
    };
    let manifest = artifacts
        .map(|artifacts| artifacts.manifest.clone())
        .unwrap_or(Value::Null);
    let sheet = artifacts.and_then(|artifacts| artifacts.sheet.clone());
    let freshness = sheet
        .as_ref()
        .and_then(|sheet| sheet.get("freshness").cloned())
        .unwrap_or(Value::Null);
    let glossaries: Vec<Value> = artifacts
        .map(|artifacts| artifacts.glossaries.iter().map(glossary_json).collect())
        .unwrap_or_default();
    let skills: Vec<Value> = artifacts
        .map(|artifacts| artifacts.skills.iter().map(SkillView::to_json).collect())
        .unwrap_or_default();
    let usage = artifacts
        .map(|artifacts| artifacts.usage.clone())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let significance = artifacts
        .map(|artifacts| artifacts.significance.clone())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let decisions = artifacts
        .map(|artifacts| Value::Array(artifacts.decisions.clone()))
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let contribution = artifacts
        .and_then(|artifacts| artifacts.contribution.clone())
        .unwrap_or(Value::Null);
    let command_aliases = if artifacts.is_some() {
        declared_command_aliases(&root)
    } else {
        Value::Array(Vec::new())
    };
    let dependency_repositories_value = if artifacts.is_none() || sheet.is_none() {
        Value::Object(Map::new())
    } else {
        dependency_repositories(&root, sheet.as_ref())
    };
    let overview_links = if artifacts.is_none() || sheet.is_none() || shown_remote.is_some() {
        Value::Object(Map::new())
    } else {
        overview_path_links(&root, sheet.as_ref(), true)
    };

    let mut payload = Map::new();
    payload.insert("active".to_string(), Value::Bool(state.run.is_some()));
    // `discover_active` also holds through the clone-to-first-run handoff, so
    // the page needs that phase to disable what the server would refuse.
    payload.insert("starting".to_string(), Value::Bool(state.starting));
    payload.insert(
        "runId".to_string(),
        state
            .run
            .as_ref()
            .map(|run| Value::String(run.run_id.clone()))
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "startedAt".to_string(),
        state
            .run
            .as_ref()
            .map(|run| Value::String(run.started_at.clone()))
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "activeAgent".to_string(),
        state
            .run
            .as_ref()
            .map(|run| Value::String(run.agent.clone()))
            .unwrap_or(Value::Null),
    );
    payload.insert("runningAll".to_string(), Value::Bool(state.all_active));
    payload.insert(
        "allFailed".to_string(),
        state
            .all_failed
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    payload.insert("agents".to_string(), Value::Array(agents));
    payload.insert("interrupted".to_string(), Value::Bool(state.interrupted));
    payload.insert(
        "stale".to_string(),
        Value::Bool(if showing_in_flight {
            false
        } else {
            state.stale
        }),
    );
    payload.insert(
        "warnings".to_string(),
        Value::Array(if showing_in_flight {
            Vec::new()
        } else {
            state
                .warnings
                .clone()
                .into_iter()
                .map(Value::String)
                .collect()
        }),
    );
    payload.insert(
        "busy".to_string(),
        busy.map(Value::String).unwrap_or(Value::Null),
    );
    payload.insert(
        "error".to_string(),
        if showing_in_flight {
            Value::Null
        } else {
            state
                .read_error
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null)
        },
    );
    payload.insert(
        "remoteAvailable".to_string(),
        Value::Bool(state.remote_available),
    );
    payload.insert("retained".to_string(), Value::Array(retained));
    payload.insert("repository".to_string(), repository);
    payload.insert("target".to_string(), target);
    payload.insert(
        "cloning".to_string(),
        state
            .cloning
            .as_ref()
            .map(|cloning| json!({"url": cloning.url}))
            .unwrap_or(Value::Null),
    );
    payload.insert("manifest".to_string(), manifest);
    payload.insert("freshness".to_string(), freshness);
    payload.insert("sheet".to_string(), sheet.unwrap_or(Value::Null));
    payload.insert("commandAliases".to_string(), command_aliases);
    payload.insert(
        "dependencyRepositories".to_string(),
        dependency_repositories_value,
    );
    payload.insert("overviewLinks".to_string(), overview_links);
    payload.insert("glossaries".to_string(), Value::Array(glossaries));
    payload.insert("contribution".to_string(), contribution);
    payload.insert("glossaryUsage".to_string(), usage);
    payload.insert("glossarySignificance".to_string(), significance);
    payload.insert("decisions".to_string(), decisions);
    payload.insert("skills".to_string(), Value::Array(skills));
    Value::Object(payload)
}

fn push_state(app: &Arc<App>, mode: &Arc<Mode>) {
    let busy = busy_reason(app);
    {
        let mut state = lock(&mode.state);
        refresh_snapshot(app, &mut state);
    }
    let state = lock(&mode.state);
    let payload = discover_state_payload(app, &state, busy);
    drop(state);
    app.shared
        .broadcast(json!({"type": "discoverState", "state": payload}));
}

fn notify_discover_failure(conn: Option<&Conn>, message: &str) {
    if let Some(conn) = conn {
        conn.send(json!({"type": "discoverError", "message": message}));
    }
}

/// Reports a failure the restore path raised before any page was attached.
/// The frame goes to every connected page and stays queued for the first page
/// that connects afterwards, so a resumed run's refusal is never silent.
fn report_discover_failure(app: &Arc<App>, mode: &Arc<Mode>, conn: Option<&Conn>, message: &str) {
    if let Some(conn) = conn {
        notify_discover_failure(Some(conn), message);
        return;
    }
    lock(&mode.state).notice = Some(message.to_string());
    app.shared
        .broadcast(json!({"type": "discoverError", "message": message}));
}

// ------------------------------------------------------------ state parts

enum SectionPart {
    Run,
    Interrupted,
    Target,
}

struct ModeSection {
    mode: Arc<Mode>,
    part: SectionPart,
}

impl StateSection for ModeSection {
    fn snapshot(&self) -> Option<Value> {
        let state = lock(&self.mode.state);
        match self.part {
            SectionPart::Run => Some(
                state
                    .run
                    .as_ref()
                    .map(stored_discover_json)
                    .unwrap_or(Value::Null),
            ),
            SectionPart::Interrupted => Some(Value::Bool(state.interrupted)),
            SectionPart::Target => Some(
                state
                    .target
                    .as_ref()
                    .map(remote_target_json)
                    .unwrap_or(Value::Null),
            ),
        }
    }

    fn restore(&self, value: &Value) {
        let app = match self.mode.app.upgrade() {
            Some(app) => app,
            None => return,
        };
        match self.part {
            SectionPart::Run => {
                let stored = parse_stored_discover(value);
                if let Some(stored) = &stored {
                    remove_interrupted_staging(Path::new(&stored.staging_dir));
                }
                let mut state = lock(&self.mode.state);
                if let Some(stored) = &stored {
                    // Build the run the reconnecting page owes before the
                    // asynchronous attach runs; its owner's journals then
                    // extend the same activity stream. The question is not
                    // carried over: only an attached peer can route an answer,
                    // and the attach reports the pending question it finds, so
                    // a page never offers a question this process cannot answer.
                    state.run = Some(Run {
                        run_id: stored.run_id.clone(),
                        staging_dir: PathBuf::from(&stored.staging_dir),
                        cwd: self
                            .mode
                            .app
                            .upgrade()
                            .map(|app| app.config().repo_dir.clone())
                            .unwrap_or_default(),
                        started_at: stored.started_at.clone(),
                        agent: stored.agent.clone(),
                        mode: "single",
                        activity: stored.activity.clone(),
                        question: None,
                        remote: stored.remote.clone(),
                        resumed: true,
                        peer: None,
                    });
                    state.interrupted = true;
                }
                state.restored = stored;
            }
            SectionPart::Interrupted => {
                lock(&self.mode.state).interrupted = value.as_bool().unwrap_or(false);
            }
            SectionPart::Target => {
                let remote_available = self
                    .mode
                    .state
                    .lock()
                    .map(|state| state.remote_available)
                    .unwrap_or(false);
                let remote_root = lock(&self.mode.state).remote_root.clone();
                if remote_available {
                    cleanup_remote_scratch(&remote_root);
                }
                let stored = if remote_available {
                    parse_stored_target(value)
                } else {
                    None
                };
                let mut state = lock(&self.mode.state);
                if let Some(target) = stored {
                    let directory =
                        remote_project_directory(&remote_root, &target.owner, &target.repo);
                    let record = read_retained_project(&directory);
                    let ready = record
                        .as_ref()
                        .map(|record| retained_project_ready(&directory, record))
                        .unwrap_or(false);
                    if ready {
                        state.target = Some(target);
                    } else {
                        state.notice = Some(format!(
                            "The retained Discover project for {} is missing, so the host target is active.",
                            target.url
                        ));
                    }
                }
                let restored = state.restored.clone();
                drop(state);
                if let Some(restored) = restored {
                    if let Ok(handle) = tokio::runtime::Handle::try_current() {
                        handle.spawn(resume_discover_run(app, self.mode.clone(), restored));
                    }
                }
            }
        }
    }
}

fn stored_discover_json(run: &Run) -> Value {
    json!({
        "runId": run.run_id,
        "stagingDir": run.staging_dir.to_string_lossy(),
        "stagingDir": run.staging_dir.to_string_lossy(),
        "startedAt": run.started_at,
        "agent": run.agent,
        "activity": run.activity,
        "question": run.question.as_ref().map(question_json).unwrap_or(Value::Null),
        "remote": run
            .remote
            .as_ref()
            .map(remote_target_json)
            .unwrap_or(Value::Null),
    })
}

fn question_json(question: &AcpQuestion) -> Value {
    json!({
        "id": acp_id_json(&question.id),
        "message": question.message,
        "options": serde_json::to_value(&question.options).unwrap_or(Value::Array(Vec::new())),
    })
}

fn acp_id_json(id: &AcpId) -> Value {
    match id {
        AcpId::Number(number) => Value::Number((*number).into()),
        AcpId::String(text) => Value::String(text.clone()),
    }
}

fn remote_target_json(target: &RemoteRepository) -> Value {
    json!({"url": target.url, "owner": target.owner, "repo": target.repo})
}

fn parse_stored_discover(value: &Value) -> Option<StoredDiscover> {
    let run_id = value.get("runId")?.as_str()?.to_string();
    let staging_dir = value.get("stagingDir")?.as_str()?.to_string();
    let started_at = value.get("startedAt")?.as_str()?.to_string();
    let activity: Vec<String> = value
        .get("activity")?
        .as_array()?
        .iter()
        .filter_map(|entry| entry.as_str().map(str::to_string))
        .collect();
    let agent = value.get("agent")?.as_str()?.to_string();
    discover_agent(&agent)?;
    let remote = match value.get("remote") {
        None | Some(Value::Null) => {
            if staging_dir.contains("/discover-remote/") {
                return None;
            }
            None
        }
        Some(remote) => Some(parse_stored_target(remote)?),
    };
    Some(StoredDiscover {
        run_id,
        staging_dir,
        started_at,
        agent,
        activity,
        remote,
    })
}

fn parse_stored_target(value: &Value) -> Option<RemoteRepository> {
    let url = value.get("url")?.as_str()?;
    let owner = value.get("owner")?.as_str()?;
    let repo = value.get("repo")?.as_str()?;
    let parsed = parse_remote_url(url).ok()?;
    if parsed.owner != owner || parsed.repo != repo {
        return None;
    }
    Some(parsed)
}

/// Pushes the start control's disabled reason once per change.
fn sync_discover_busy(app: &Arc<App>, mode: &Arc<Mode>) {
    let busy = busy_reason(app);
    {
        let mut state = lock(&mode.state);
        if state.last_busy.as_ref() == Some(&busy) {
            return;
        }
        state.last_busy = Some(busy.clone());
    }
    let state = lock(&mode.state);
    let payload = discover_state_payload(app, &state, busy);
    drop(state);
    app.shared
        .send_all(json!({"type": "discoverState", "state": payload}), None);
}

/// Registers this mode's durable state with the dashboard.
pub fn init(app: &Arc<App>) {
    let mode = mode_for(app);
    app.shared.register_gate(
        "discover",
        Arc::new(DiscoverGate {
            mode: Arc::clone(&mode),
        }),
    );
    {
        let weak = Arc::downgrade(app);
        let hook_mode = Arc::clone(&mode);
        app.shared.add_broadcast_hook(Arc::new(move || {
            if let Some(app) = weak.upgrade() {
                sync_discover_busy(&app, &hook_mode);
            }
        }));
    }
    app.shared.register_section(
        "discoverInterrupted",
        Arc::new(ModeSection {
            mode: Arc::clone(&mode),
            part: SectionPart::Interrupted,
        }),
    );
    app.shared.register_section(
        "discover",
        Arc::new(ModeSection {
            mode: Arc::clone(&mode),
            part: SectionPart::Run,
        }),
    );
    app.shared.register_section(
        "discoverTarget",
        Arc::new(ModeSection {
            mode,
            part: SectionPart::Target,
        }),
    );
    {
        // A graceful stop leaves no run's staging behind. The watcher owns only
        // the shared signal; a dropped app simply skips its cleanup.
        let weak = Arc::downgrade(app);
        let shared = Arc::clone(&app.shared);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                shared.shutdown.notified().await;
                drop(shared);
                if let Some(app) = weak.upgrade() {
                    shutdown(&app);
                }
            });
        }
    }
}

/// Replays the frames a connecting client owes before its own replies.
pub fn replay(app: &Arc<App>, conn: &Conn) {
    replay_resource(app, conn);
    let repo_dir = app.config().repo_dir.clone();
    let mode = mode_for(app);
    let state = lock(&mode.state);
    prompts_replay(&repo_dir, &state, conn);
}

/// The state and run frames a `GET /discoveries/workspace` answers, without
/// the prompt catalog a socket connect also carries.
pub fn replay_resource(app: &Arc<App>, conn: &Conn) {
    let mode = mode_for(app);
    let notice = {
        let mut state = lock(&mode.state);
        refresh_snapshot(app, &mut state);
        state.notice.take()
    };
    if let Some(notice) = notice {
        conn.send(json!({"type": "discoverError", "message": notice}));
    }
    let busy = busy_reason(app);
    let (payload, read_error, started, activity, question) = {
        let state = lock(&mode.state);
        let payload = discover_state_payload(app, &state, busy);
        let read_error = state.read_error.clone();
        let started = state.run.as_ref().map(|run| {
            json!({
                "type": "discoverStarted",
                "runId": run.run_id,
                "startedAt": run.started_at,
                "agent": run.agent,
                "mode": run.mode,
            })
        });
        let activity = state
            .run
            .as_ref()
            .map(|run| {
                run.activity
                    .iter()
                    .map(|text| json!({"type": "discoverActivity", "agent": run.agent, "text": text}))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let question = state.run.as_ref().and_then(|run| {
            run.question.as_ref().map(|question| {
                json!({
                    "type": "discoverQuestion",
                    "agent": run.agent,
                    "id": acp_id_json(&question.id),
                    "message": question.message,
                    "options": serde_json::to_value(&question.options).unwrap_or(Value::Array(Vec::new())),
                })
            })
        });
        (payload, read_error, started, activity, question)
    };
    conn.send(json!({"type": "discoverState", "state": payload}));
    if let Some(error) = read_error {
        conn.send(json!({"type": "discoverError", "message": error}));
    }
    if let Some(started) = started {
        conn.send(started);
    }
    for frame in activity {
        conn.send(frame);
    }
    if let Some(question) = question {
        conn.send(question);
    }
}
// ----------------------------------------------------------- orchestration

fn clear_remote_checkout(app: &Arc<App>, mode: &Arc<Mode>) {
    let checkout = {
        let mut state = lock(&mode.state);
        let checkout = state.checkout.take();
        state.starting = false;
        checkout
    };
    let Some(checkout) = checkout else {
        return;
    };
    let _ = fs::remove_dir_all(&checkout.dir);
    let remote_root = lock(&mode.state).remote_root.clone();
    let name = checkout
        .dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    release_scratch_entry(&remote_root, &name);
    let _ = app;
}

fn release_orphaned_checkout(app: &Arc<App>, mode: &Arc<Mode>) {
    {
        let state = lock(&mode.state);
        if state.checkout.is_none() {
            return;
        }
        if state.run.is_some() || state.all_active || state.cloning.is_some() || state.starting {
            return;
        }
    }
    clear_remote_checkout(app, mode);
    push_state(app, mode);
}

fn discover_active(state: &ModeState) -> bool {
    state.run.is_some() || state.all_active || state.starting
}

fn start_refusal(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn) -> bool {
    let state = lock(&mode.state);
    if state.cloning.is_some() {
        drop(state);
        notify_discover_failure(
            Some(conn),
            "A repository clone is active. Wait for it to finish.",
        );
        return true;
    }
    if state.all_active {
        drop(state);
        notify_discover_failure(
            Some(conn),
            "Run all is active. Wait for it to finish or stop it.",
        );
        return true;
    }
    // A restored interrupted run is the run this request resumes; its
    // placeholder must not refuse its own resume.
    let resuming = state.interrupted && state.run.is_some();
    if state.starting || (state.run.is_some() && !resuming) {
        drop(state);
        notify_discover_failure(Some(conn), "A Discover run is already active.");
        return true;
    }
    drop(state);
    if let Some(busy) = busy_reason(app) {
        notify_discover_failure(Some(conn), &format!("A Discover run cannot start: {busy}"));
        return true;
    }
    false
}

fn remote_unavailable(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn) -> bool {
    if lock(&mode.state).remote_available {
        return false;
    }
    let _ = app;
    notify_discover_failure(
        Some(conn),
        "Discover from a repository URL is available only when the dashboard serves a harness source checkout.",
    );
    true
}

fn fail_discover(app: &Arc<App>, mode: &Arc<Mode>, run: &Run, message: &str) {
    {
        let mut state = lock(&mode.state);
        let current = state
            .run
            .as_ref()
            .map(|current| current.run_id == run.run_id)
            .unwrap_or(false);
        if !current {
            return;
        }
        state.run = None;
        state.all_active = false;
        if run.mode == "all" {
            state.all_failed = Some(run.agent.clone());
        }
        if let Some(peer) = &run.peer {
            peer.close();
        }
        if run.resumed {
            state.notice = Some(message.to_string());
        }
        remove_staging(&run.cwd, &run.run_id);
        let started = state
            .status(&run.agent)
            .started_at
            .unwrap_or_else(|| run.started_at.clone());
        state.set_status(
            &run.agent,
            AgentStatus {
                state: "failed",
                started_at: Some(started),
                ended_at: Some(iso_now()),
                error: Some(message.to_string()),
            },
        );
    }
    clear_remote_checkout(app, mode);
    app.shared.broadcast(json!({
        "type": "discoverError",
        "message": message,
        "agent": run.agent,
    }));
    push_state(app, mode);
    app.shared.broadcast(json!({
        "type": "discoverStopped",
        "completed": false,
        "agent": run.agent,
        "mode": run.mode,
    }));
}

fn append_activity(run: &mut Run, text: &str, append: bool) {
    if append {
        if let Some(last) = run.activity.last_mut() {
            last.push_str(text);
            return;
        }
    }
    run.activity.push(text.to_string());
}

/// True while this run is still the one the mode owns.
fn still_current(mode: &Arc<Mode>, run_id: &str, request: u64) -> bool {
    let state = lock(&mode.state);
    state.request == request
        && state
            .run
            .as_ref()
            .map(|run| run.run_id == run_id)
            .unwrap_or(false)
}

/// Runs exactly one agent against one root: one detached owner, one staging
/// directory, one validated slice, one publication. Returns true only when the
/// slice was published; a failure or a stop reports itself and returns false.
async fn run_agent(
    app: &Arc<App>,
    mode: &Arc<Mode>,
    conn: Option<&Conn>,
    agent: &str,
    run_mode: &'static str,
    target: &DiscoverTarget,
    resumed: Option<&StoredDiscover>,
    attach: bool,
) -> bool {
    let Some(descriptor) = discover_agent(agent) else {
        report_discover_failure(
            app,
            mode,
            conn,
            &format!("Unknown Discover agent: {agent}."),
        );
        return false;
    };
    let repo_dir = app.config().repo_dir.clone();
    let facts_before = host_facts(&target.root);
    let run_id = if attach {
        resumed
            .map(|stored| stored.run_id.clone())
            .unwrap_or_else(new_run_id)
    } else {
        new_run_id()
    };
    let staging_dir = if attach {
        resumed
            .map(|stored| stored.staging_dir.clone())
            .map(PathBuf::from)
            .unwrap_or_else(|| staging_directory(&target.root, &run_id))
    } else {
        staging_directory(&target.root, &run_id)
    };
    if !attach {
        if let Err(error) = fs::create_dir_all(&staging_dir) {
            report_discover_failure(
                app,
                mode,
                conn,
                &format!(
                    "Could not prepare the {} staging directory: {error}",
                    descriptor.label
                ),
            );
            if target.remote.is_some() {
                let mut state = lock(&mode.state);
                state.starting = false;
                state.all_active = false;
                drop(state);
                clear_remote_checkout(app, mode);
                push_state(app, mode);
            }
            return false;
        }
    }
    let started_at = resumed
        .map(|stored| stored.started_at.clone())
        .unwrap_or_else(iso_now);
    let activity = resumed
        .map(|stored| stored.activity.clone())
        .unwrap_or_default();
    let request = {
        let mut state = lock(&mode.state);
        state.request += 1;
        let request = state.request;
        state.set_status(
            agent,
            AgentStatus {
                state: "running",
                started_at: Some(started_at.clone()),
                ended_at: None,
                error: None,
            },
        );
        state.run = Some(Run {
            run_id: run_id.clone(),
            staging_dir: staging_dir.clone(),
            cwd: target.root.clone(),
            started_at: started_at.clone(),
            agent: descriptor.id.to_string(),
            mode: run_mode,
            activity,
            question: None,
            remote: target.remote.clone(),
            resumed: resumed.is_some(),
            peer: None,
        });
        state.starting = false;
        state.interrupted = false;
        request
    };
    app.shared
        .journal
        .write("lifecycle", "discover-start", None);
    app.shared.broadcast(json!({
        "type": "discoverStarted",
        "runId": run_id,
        "startedAt": started_at,
        "agent": descriptor.id,
        "mode": run_mode,
    }));
    push_state(app, mode);

    let environment = match app.providers.select_environment().await {
        Ok(environment) => environment
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect::<HashMap<String, String>>(),
        Err(error) => {
            let run = lock(&mode.state).run.clone();
            if let Some(run) = run.filter(|run| still_current(mode, &run.run_id, request)) {
                fail_discover(
                    app,
                    mode,
                    &run,
                    &format!("Could not start the {} agent: {error}", descriptor.label),
                );
            }
            return false;
        }
    };
    if !still_current(mode, &run_id, request) {
        return false;
    }

    let activity_run = run_id.clone();
    let activity_app = Arc::clone(app);
    let activity_mode = Arc::clone(mode);
    let on_activity: crate::detached_run::ActivityCallback =
        Arc::new(move |activity: crate::acp::AcpActivity| {
            let frame = {
                let mut state = lock(&activity_mode.state);
                let Some(run) = state.run.as_mut().filter(|run| run.run_id == activity_run) else {
                    return;
                };
                activity_app
                    .shared
                    .journal
                    .write("activity", &activity.text, None);
                let append = activity.append && !run.activity.is_empty();
                append_activity(run, &activity.text, append);
                let mut frame = json!({
                    "type": "discoverActivity",
                    "agent": run.agent,
                    "text": activity.text,
                });
                if append {
                    frame["append"] = Value::Bool(true);
                }
                frame
            };
            activity_app.shared.send_all(frame, None);
        });
    let question_run = run_id.clone();
    let question_app = Arc::clone(app);
    let question_mode = Arc::clone(mode);
    let on_question: crate::detached_run::QuestionCallback =
        Arc::new(move |question: AcpQuestion| {
            let frame = {
                let mut state = lock(&question_mode.state);
                let Some(run) = state.run.as_mut().filter(|run| run.run_id == question_run) else {
                    return;
                };
                question_app
                    .shared
                    .journal
                    .write("question", &question.message, Some("discover"));
                run.question = Some(question.clone());
                json!({
                    "type": "discoverQuestion",
                    "agent": run.agent,
                    "id": acp_id_json(&question.id),
                    "message": question.message,
                    "options": serde_json::to_value(&question.options)
                        .unwrap_or(Value::Array(Vec::new())),
                })
            };
            question_app.shared.send_all(frame, None);
        });
    let stderr_app = Arc::clone(app);
    let on_stderr: crate::detached_run::StderrCallback = Arc::new(move |text: String| {
        stderr_app.shared.journal.write("acp-stderr", &text, None);
        eprint!("{text}");
    });

    let skip_activity = lock(&mode.state)
        .run
        .as_ref()
        .filter(|run| run.run_id == run_id)
        .map(|run| run.activity.len())
        .unwrap_or(0);
    let mut options = DetachedPeerOptions::new(
        repo_dir.clone(),
        app.config().state_dir.clone(),
        "discover",
        run_id.clone(),
        app.instance.clone(),
        format!("{} --no-skills", app.config().agent_command),
        target.root.to_string_lossy().into_owned(),
    )
    .env(environment)
    .skip_activity(skip_activity)
    .attach_only(attach)
    .activity(on_activity)
    .question(on_question)
    .stderr(on_stderr);
    options.harness_version = app.running_version.clone();
    let peer = DetachedPeer::new(options);
    {
        let mut state = lock(&mode.state);
        match state.run.as_mut().filter(|run| run.run_id == run_id) {
            Some(run) => {
                if attach {
                    if let Some(stored) = peer.state() {
                        if let Some(question) = stored.question {
                            run.question = Some(question);
                        }
                    }
                }
                run.peer = Some(Arc::clone(&peer));
            }
            None => {
                peer.close();
                return false;
            }
        }
    }
    if attach {
        push_state(app, mode);
    }

    let prompt = format!("{} {}", descriptor.command, staging_dir.display());
    let outcome = peer.run(&prompt).await;
    if !still_current(mode, &run_id, request) {
        return false;
    }
    match outcome {
        Ok(DetachedRunOutcome::Completed) | Ok(DetachedRunOutcome::Attached) => {}
        Ok(DetachedRunOutcome::Stopped) | Ok(DetachedRunOutcome::Preserved) => return false,
        Err(message) => {
            let run = lock(&mode.state).run.clone();
            if let Some(run) = run.filter(|run| still_current(mode, &run.run_id, request)) {
                fail_discover(
                    app,
                    mode,
                    &run,
                    &format!("The {} run failed: {message}", descriptor.label),
                );
            }
            return false;
        }
    }
    let published = (|| -> Result<(), String> {
        if !target.root.is_dir() {
            return Err(if target.remote.is_none() {
                "the host directory disappeared during the run".to_string()
            } else {
                "the run's checkout was removed during the run".to_string()
            });
        }
        let facts = host_facts(&target.root);
        if facts.fingerprint != facts_before.fingerprint {
            return Err("the agent changed host files outside its staging directory".to_string());
        }
        publish_agent_staged(
            &target.root,
            &run_id,
            &facts,
            &staging_dir,
            &target.project,
            descriptor.id,
        )
        .map(|_| ())
    })();
    if let Err(error) = published {
        let run = lock(&mode.state).run.clone();
        if let Some(run) = run.filter(|run| still_current(mode, &run.run_id, request)) {
            fail_discover(
                app,
                mode,
                &run,
                &format!("{} failed: {error}", descriptor.label),
            );
        }
        return false;
    }
    remove_staging(&target.root, &run_id);
    {
        let mut state = lock(&mode.state);
        if let Some(run) = state.run.take() {
            if let Some(peer) = &run.peer {
                peer.close();
            }
        }
        state.set_status(
            agent,
            AgentStatus {
                state: "succeeded",
                started_at: Some(started_at),
                ended_at: Some(iso_now()),
                error: None,
            },
        );
    }
    push_state(app, mode);
    let _ = repo_dir;
    true
}

fn finish_discover_command(
    app: &Arc<App>,
    mode: &Arc<Mode>,
    target: &DiscoverTarget,
    run_mode: &'static str,
    agent: &str,
) {
    if let Some(remote) = &target.remote {
        let run_id = lock(&mode.state)
            .checkout
            .as_ref()
            .map(|checkout| checkout.run_id.clone())
            .unwrap_or_else(|| now_millis().to_string());
        let record = RetainedRemoteProject {
            url: remote.url.clone(),
            owner: remote.owner.clone(),
            repo: remote.repo.clone(),
            completed_at: iso_now(),
        };
        let remote_root = lock(&mode.state).remote_root.clone();
        match retain_remote_project(&remote_root, &target.root, &record, &run_id) {
            Err(retained) => {
                let mut state = lock(&mode.state);
                state.all_active = false;
                let started = state.status(agent).started_at;
                state.set_status(
                    agent,
                    AgentStatus {
                        state: "failed",
                        started_at: started,
                        ended_at: Some(iso_now()),
                        error: Some(format!("Discover failed: {retained}")),
                    },
                );
                drop(state);
                clear_remote_checkout(app, mode);
                app.shared.broadcast(json!({
                    "type": "discoverError",
                    "message": format!("Discover failed: {retained}"),
                    "agent": agent,
                }));
                push_state(app, mode);
                app.shared.broadcast(json!({
                    "type": "discoverStopped",
                    "completed": false,
                    "agent": agent,
                    "mode": run_mode,
                }));
                return;
            }
            Ok(()) => {
                lock(&mode.state).target = Some(remote.clone());
            }
        }
    }
    clear_remote_checkout(app, mode);
    {
        let mut state = lock(&mode.state);
        state.interrupted = false;
        state.all_active = false;
    }
    push_state(app, mode);
    app.shared.broadcast(json!({
        "type": "discoverStopped",
        "completed": true,
        "agent": agent,
        "mode": run_mode,
    }));
}

async fn clone_remote_project(
    app: &Arc<App>,
    mode: &Arc<Mode>,
    conn: Option<&Conn>,
    target: &RemoteRepository,
) -> bool {
    let run_id = new_run_id();
    let remote_root = lock(&mode.state).remote_root.clone();
    let staging = remote_root.join(format!(".staging-{run_id}"));
    let staging_name = staging
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Err(error) = fs::create_dir_all(&remote_root) {
        report_discover_failure(
            app,
            mode,
            conn,
            &format!("Could not prepare the Discover scratch root: {error}"),
        );
        return false;
    }
    if !claim_scratch_entry(&remote_root, &staging_name) {
        report_discover_failure(
            app,
            mode,
            conn,
            &format!(
                "Could not prepare the Discover scratch root: the scratch root is not writable: {}",
                remote_root.display()
            ),
        );
        return false;
    }
    {
        let mut state = lock(&mode.state);
        state.cloning = Some(Cloning {
            url: target.url.clone(),
            target: target.clone(),
            staging: staging.clone(),
        });
    }
    app.shared
        .journal
        .write("lifecycle", "discover-remote-clone", None);
    push_state(app, mode);

    let request = remote_clone_request(&target.url, &remote_root, &run_id);
    let runner = clone_runner();
    let result = runner(request.clone()).await;

    let clone_failed = |message: String| -> bool {
        {
            let mut state = lock(&mode.state);
            state.cloning = None;
        }
        let _ = fs::remove_dir_all(&staging);
        release_scratch_entry(&remote_root, &staging_name);
        report_discover_failure(app, mode, conn, &message);
        push_state(app, mode);
        false
    };
    if result.timed_out {
        let seconds = request.timeout_ms.div_ceil(1000) as i64;
        return clone_failed(format!(
            "The repository clone timed out after {seconds} seconds."
        ));
    }
    if result.code != 0 {
        return clone_failed(format!(
            "The repository clone failed: git exited with status {}.",
            result.code
        ));
    }
    if !staging.is_dir() {
        return clone_failed("The repository clone produced no readable directory.".to_string());
    }
    let retained = remote_project_directory(&remote_root, &target.owner, &target.repo);
    for tree in ["discover", "skills"] {
        let from = retained.join(".omp").join(tree);
        if !from.exists() {
            continue;
        }
        let destination = staging.join(".omp").join(tree);
        if let Err(error) = copy_directory(&from, &destination) {
            return clone_failed(format!(
                "The retained Discover artifacts could not be copied into the checkout: {error}"
            ));
        }
    }
    // The clone carries no harness for an arbitrary project, so the peer's slash
    // command and the prompt it reads would not resolve. Ship both into the checkout.
    if let Err(error) = crate::cli_install::install_discover_support(&staging) {
        return clone_failed(format!(
            "The Discover command wrappers could not be written into the checkout: {error}"
        ));
    }
    {
        let mut state = lock(&mode.state);
        state.cloning = None;
        state.checkout = Some(Checkout {
            run_id,
            dir: staging,
            target: target.clone(),
        });
        state.starting = true;
    }
    push_state(app, mode);
    true
}

async fn resolve_discover_root(
    app: &Arc<App>,
    mode: &Arc<Mode>,
    conn: Option<&Conn>,
) -> Option<DiscoverTarget> {
    let repo_dir = app.config().repo_dir.clone();
    let target = lock(&mode.state).target.clone();
    let has_checkout = lock(&mode.state).checkout.is_some();
    if let (Some(target), false) = (target.as_ref(), has_checkout) {
        if !clone_remote_project(app, mode, conn, target).await {
            return None;
        }
    }
    let checkout = lock(&mode.state).checkout.clone();
    let remote = checkout.as_ref().map(|checkout| checkout.target.clone());
    let root = match &checkout {
        Some(checkout) => checkout.dir.clone(),
        None => repo_dir.clone(),
    };
    Some(DiscoverTarget {
        root,
        project: project_name(&repo_dir, remote.as_ref()),
        remote,
    })
}

async fn start_all(app: &Arc<App>, mode: &Arc<Mode>, conn: Option<&Conn>, claimed: bool) {
    if !claimed {
        if let Some(conn) = conn {
            if start_refusal(app, mode, conn) {
                return;
            }
        }
    }
    let Some(target) = resolve_discover_root(app, mode, conn).await else {
        return;
    };
    {
        let mut state = lock(&mode.state);
        state.reset_statuses();
        state.all_active = true;
    }
    push_state(app, mode);
    let mut last = DISCOVER_RUN_ORDER[0];
    for id in DISCOVER_RUN_ORDER {
        last = id;
        let published = run_agent(app, mode, conn, id, "all", &target, None, false).await;
        if !published {
            return;
        }
    }
    finish_discover_command(app, mode, &target, "all", last);
}

async fn start_agent(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn, agent: &Value) {
    let Some(id) = agent.as_str() else {
        notify_discover_failure(Some(conn), "A Discover start needs an agent id.");
        return;
    };
    if discover_agent(id).is_none() {
        notify_discover_failure(Some(conn), &format!("Unknown Discover agent: {id}."));
        return;
    }
    if start_refusal(app, mode, conn) {
        return;
    }
    let Some(target) = resolve_discover_root(app, mode, Some(conn)).await else {
        return;
    };
    let published = run_agent(app, mode, Some(conn), id, "single", &target, None, false).await;
    if !published {
        return;
    }
    finish_discover_command(app, mode, &target, "single", id);
}

fn retained_project_for(mode: &Arc<Mode>, url: &str) -> Option<RetainedRemoteProject> {
    let parsed = parse_remote_url(url).ok()?;
    let name = remote_clone_name(&parsed.owner, &parsed.repo);
    let remote_root = lock(&mode.state).remote_root.clone();
    list_retained_projects(&remote_root)
        .into_iter()
        .find(|project| remote_clone_name(&project.owner, &project.repo) == name)
}

fn remote_change_refusal(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn, action: &str) -> bool {
    let (cloning, active) = {
        let state = lock(&mode.state);
        (state.cloning.is_some(), discover_active(&state))
    };
    if cloning {
        notify_discover_failure(
            Some(conn),
            "A repository clone is active. Wait for it to finish.",
        );
        return true;
    }
    if active {
        notify_discover_failure(
            Some(conn),
            &format!("A Discover run is active. Stop it before {action}."),
        );
        return true;
    }
    if let Some(busy) = busy_reason(app) {
        notify_discover_failure(
            Some(conn),
            &format!("The remote target cannot be changed: {busy}"),
        );
        return true;
    }
    false
}

fn switch_discover_remote(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn, url: &str) {
    if remote_unavailable(app, mode, conn) {
        return;
    }
    release_orphaned_checkout(app, mode);
    if remote_change_refusal(app, mode, conn, "switching projects") {
        return;
    }
    let Some(retained) = retained_project_for(mode, url) else {
        notify_discover_failure(
            Some(conn),
            &format!("No retained Discover project matches {}.", url.trim()),
        );
        return;
    };
    {
        let mut state = lock(&mode.state);
        state.target = Some(RemoteRepository {
            url: retained.url,
            owner: retained.owner,
            repo: retained.repo,
        });
    }
    app.shared
        .journal
        .write("lifecycle", "discover-remote-switch", None);
    push_state(app, mode);
}

fn remove_discover_remote(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn, url: &str) {
    if remote_unavailable(app, mode, conn) {
        return;
    }
    release_orphaned_checkout(app, mode);
    if remote_change_refusal(app, mode, conn, "removing a project") {
        return;
    }
    let Some(retained) = retained_project_for(mode, url) else {
        notify_discover_failure(
            Some(conn),
            &format!("No retained Discover project matches {}.", url.trim()),
        );
        return;
    };
    let remote_root = lock(&mode.state).remote_root.clone();
    if let Some(error) = remove_retained_project(&remote_root, &retained) {
        notify_discover_failure(
            Some(conn),
            &format!("The retained Discover project could not be removed: {error}"),
        );
        return;
    }
    let mut state = lock(&mode.state);
    if let Some(target) = &state.target {
        if remote_clone_name(&target.owner, &target.repo)
            == remote_clone_name(&retained.owner, &retained.repo)
        {
            state.target = None;
        }
    }
    drop(state);
    app.shared
        .journal
        .write("lifecycle", "discover-remote-remove", None);
    push_state(app, mode);
}

fn clear_discover_remote(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn) {
    if remote_unavailable(app, mode, conn) {
        return;
    }
    release_orphaned_checkout(app, mode);
    {
        let state = lock(&mode.state);
        if state.cloning.is_some() {
            drop(state);
            notify_discover_failure(
                Some(conn),
                "A repository clone is active. Wait for it to finish.",
            );
            return;
        }
        if discover_active(&state) {
            drop(state);
            notify_discover_failure(
                Some(conn),
                "A Discover run is active. Stop it before clearing the remote target.",
            );
            return;
        }
    }
    if let Some(busy) = busy_reason(app) {
        notify_discover_failure(
            Some(conn),
            &format!("The remote target cannot be cleared: {busy}"),
        );
        return;
    }
    {
        let mut state = lock(&mode.state);
        if state.target.is_none() {
            drop(state);
            notify_discover_failure(Some(conn), "No remote Discover target is active.");
            return;
        }
        state.target = None;
    }
    app.shared
        .journal
        .write("lifecycle", "discover-remote-clear", None);
    push_state(app, mode);
}

async fn start_remote(
    app: &Arc<App>,
    mode: &Arc<Mode>,
    conn: Option<&Conn>,
    url: &str,
    resumed: Option<StoredDiscover>,
) {
    if let Some(conn) = conn {
        if remote_unavailable(app, mode, conn) {
            return;
        }
    } else if !lock(&mode.state).remote_available {
        return;
    }
    {
        let state = lock(&mode.state);
        if state.cloning.is_some() {
            drop(state);
            report_discover_failure(app, mode, conn, "A repository clone is already active.");
            return;
        }
        let resuming = resumed.is_some() && state.interrupted;
        if discover_active(&state) && !resuming {
            drop(state);
            report_discover_failure(app, mode, conn, "A Discover run is already active.");
            return;
        }
    }
    if let Some(busy) = busy_reason(app) {
        report_discover_failure(
            app,
            mode,
            conn,
            &format!("A repository clone cannot start: {busy}"),
        );
        return;
    }
    let repo_dir = app.config().repo_dir.clone();
    let remote_root = lock(&mode.state).remote_root.clone();
    if !is_inside_repository(&repo_dir, &remote_root) {
        report_discover_failure(
            app,
            mode,
            conn,
            "The Discover scratch root is outside the repository. STATE_DIR must name a directory inside the repository.",
        );
        return;
    }
    let parsed = match parse_remote_url(url) {
        Ok(parsed) => parsed,
        Err(reason) => {
            report_discover_failure(
                app,
                mode,
                conn,
                &format!("Could not clone the repository: {reason}."),
            );
            return;
        }
    };
    if !clone_remote_project(app, mode, conn, &parsed).await {
        return;
    }
    if let Some(resumed) = resumed {
        if discover_agent(&resumed.agent).is_none() {
            clear_remote_checkout(app, mode);
            push_state(app, mode);
            return;
        }
        let Some(target) = resolve_discover_root(app, mode, conn).await else {
            return;
        };
        let published = run_agent(
            app,
            mode,
            conn,
            &resumed.agent,
            "single",
            &target,
            Some(&resumed),
            false,
        )
        .await;
        if published {
            let agent = resumed.agent.clone();
            finish_discover_command(app, mode, &target, "single", &agent);
        }
        return;
    }
    start_all(app, mode, conn, true).await;
}

async fn resume_discover_run(app: Arc<App>, mode: Arc<Mode>, stored: StoredDiscover) {
    if discover_agent(&stored.agent).is_none() {
        return;
    }
    let config = app.config();
    let attach = crate::detached_run::detached_run_live(
        &config.state_dir,
        &config.repo_dir,
        "discover",
        &stored.run_id,
        &app.instance,
    );
    if !attach {
        let staging = PathBuf::from(&stored.staging_dir);
        let _ = fs::remove_dir_all(&staging);
        if let Some(parent) = staging.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
    if stored.remote.is_none() {
        {
            let state = lock(&mode.state);
            if state.cloning.is_some() || state.all_active || state.starting {
                return;
            }
        }
        if busy_reason(&app).is_some() {
            return;
        }
        let repo_dir = app.config().repo_dir.clone();
        let target = DiscoverTarget {
            root: repo_dir.clone(),
            remote: None,
            project: project_name(&repo_dir, None),
        };
        let published = run_agent(
            &app,
            &mode,
            None,
            &stored.agent,
            "single",
            &target,
            Some(&stored),
            attach,
        )
        .await;
        if published {
            let agent = stored.agent.clone();
            finish_discover_command(&app, &mode, &target, "single", &agent);
        }
        return;
    }
    if !lock(&mode.state).remote_available {
        report_discover_failure(
            &app,
            &mode,
            None,
            &format!(
                "The Discover run started at {} was interrupted when the server restarted, and a remote run cannot be resumed in this installation.",
                stored.started_at
            ),
        );
        push_state(&app, &mode);
        return;
    }
    let Some(remote) = stored.remote.clone() else {
        return;
    };
    start_remote(&app, &mode, None, &remote.url, Some(stored)).await;
}

/// Ends the work a graceful stop would abandon. The run's peer closes, its
/// staging goes, and a clone or checkout no successor owns is released. This
/// is a filesystem cleanup only: a stopping dashboard publishes nothing.
pub fn shutdown(app: &Arc<App>) {
    let mode = mode_for(app);
    let (run, checkout, cloning, remote_root) = {
        let mut state = lock(&mode.state);
        state.request += 1;
        let run = state.run.take();
        let checkout = state.checkout.take();
        let cloning = state.cloning.take();
        state.all_active = false;
        state.starting = false;
        let remote_root = state.remote_root.clone();
        (run, checkout, cloning, remote_root)
    };
    if let Some(run) = run {
        if let Some(peer) = &run.peer {
            peer.close();
        }
        remove_staging(&run.cwd, &run.run_id);
    }
    if let Some(cloning) = cloning {
        let _ = fs::remove_dir_all(&cloning.staging);
        let name = cloning
            .staging
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        release_scratch_entry(&remote_root, &name);
    }
    if let Some(checkout) = checkout {
        let _ = fs::remove_dir_all(&checkout.dir);
        let name = checkout
            .dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        release_scratch_entry(&remote_root, &name);
    }
}

fn stop_discover(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn) {
    let run = {
        let mut state = lock(&mode.state);
        if state.run.is_none() && !state.all_active {
            drop(state);
            notify_discover_failure(Some(conn), "No Discover run is active.");
            return;
        }
        state.request += 1;
        let run = state.run.take();
        state.all_active = false;
        if let Some(run) = &run {
            match &run.peer {
                Some(peer) => peer.close(),
                None => {
                    let directory = crate::detached_run::detached_run_directory(
                        &app.config().state_dir,
                        &app.config().repo_dir,
                        "discover",
                        &run.run_id,
                    );
                    crate::detached_run::write_detached_run_command(
                        &crate::detached_run::detached_run_control_directory(&directory),
                        &crate::detached_run::DetachedRunCommand::Stop,
                    );
                }
            }
            remove_staging(&run.cwd, &run.run_id);
            let started = state
                .status(&run.agent)
                .started_at
                .unwrap_or_else(|| run.started_at.clone());
            state.set_status(
                &run.agent,
                AgentStatus {
                    state: "failed",
                    started_at: Some(started),
                    ended_at: Some(iso_now()),
                    error: Some("Stopped by the operator.".to_string()),
                },
            );
        }
        run
    };
    clear_remote_checkout(app, mode);
    app.shared.broadcast(json!({
        "type": "discoverStopped",
        "completed": false,
        "agent": run.as_ref().map(|run| run.agent.clone()),
        "mode": run.as_ref().map(|run| run.mode).unwrap_or("all"),
    }));
    push_state(app, mode);
}

async fn answer_discover(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn, id: &Value, value: &Value) {
    let question = {
        let state = lock(&mode.state);
        let Some(run) = &state.run else {
            drop(state);
            notify_discover_failure(Some(conn), "No Discover run is active.");
            return;
        };
        run.question.clone()
    };
    let id_text = match id {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    };
    let value_text = value.as_str().map(str::trim).unwrap_or("");
    let Some(id_text) = id_text.filter(|text| !text.is_empty()) else {
        notify_discover_failure(
            Some(conn),
            "An answer needs the question id and a non-empty value.",
        );
        return;
    };
    if value_text.is_empty() {
        notify_discover_failure(
            Some(conn),
            "An answer needs the question id and a non-empty value.",
        );
        return;
    }
    let Some(question) = question else {
        notify_discover_failure(Some(conn), "No pending Discover question with that id.");
        return;
    };
    if question.id.as_key() != id_text {
        notify_discover_failure(Some(conn), "No pending Discover question with that id.");
        return;
    }
    let peer = lock(&mode.state)
        .run
        .as_ref()
        .and_then(|run| run.peer.clone());
    let Some(peer) = peer else {
        notify_discover_failure(Some(conn), "The Discover question is no longer pending.");
        return;
    };
    let answered = peer.answer(&question.id, value_text);
    if !answered {
        notify_discover_failure(Some(conn), "The Discover question is no longer pending.");
        return;
    }
    if let Some(run) = lock(&mode.state).run.as_mut() {
        run.question = None;
    }
    let _ = app;
}

fn discover_term_request(context: &Value, id: &Value) -> Option<(String, String)> {
    let context = context.as_str().filter(|text| !text.is_empty())?;
    let id = id.as_str().filter(|text| !text.is_empty())?;
    Some((context.to_string(), id.to_string()))
}

fn today() -> String {
    let now = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    )
}

fn update_term(
    repo_dir: &Path,
    context: &str,
    id: &str,
    update: impl Fn(&mut Concept) -> Option<String>,
    action: &str,
    reason: Option<String>,
) -> Result<(), String> {
    if read_manifest(repo_dir)?.is_none() {
        return Err("no Discover artifacts are published".to_string());
    }
    if !kebab_pattern().is_match(context) {
        return Err(invalid("context", "must be a bounded context name"));
    }
    let file = glossary_path(repo_dir, context);
    if !file.exists() {
        return Err(invalid(
            "context",
            format!("has no glossary at {context}.glossary.yaml"),
        ));
    }
    let host = host_files(repo_dir);
    let source = fs::read_to_string(&file).map_err(|error| error.to_string())?;
    let mut glossary = parse_glossary(
        &source,
        &format!("{context}.glossary.yaml"),
        repo_dir,
        &host,
        true,
        false,
    )?;
    let Some(concept) = glossary
        .concepts
        .iter_mut()
        .find(|concept| concept.id == id)
    else {
        return Err(format!("{id} is not a term of {context}"));
    };
    if let Some(refusal) = update(concept) {
        return Err(refusal);
    }
    let mut decisions = read_decisions(repo_dir)?;
    decisions.push(json!({
        "context": context,
        "id": id,
        "action": action,
        "reason": reason,
        "date": today(),
    }));
    let manifest = read_manifest(repo_dir)?
        .ok_or_else(|| "no Discover artifacts are published".to_string())?;
    let mut next_manifest = manifest.as_object().cloned().unwrap_or_default();
    let mut digests = next_manifest
        .get("glossaryDigests")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    digests.insert(
        context.to_string(),
        Value::String(glossary_digest(&glossary)),
    );
    next_manifest.insert("glossaryDigests".to_string(), Value::Object(digests));
    let decisions_path = manifest
        .get("paths")
        .and_then(|paths| paths.get("decisions"))
        .and_then(Value::as_str)
        .unwrap_or(".omp/discover/decisions.json")
        .to_string();
    write_transaction(
        &[
            FileWrite {
                path: glossary_path(repo_dir, context),
                content: render_glossary(&glossary),
            },
            FileWrite {
                path: repo_dir.join(decisions_path),
                content: render_json(&Value::Array(decisions)),
            },
            FileWrite {
                path: repo_dir.join(".omp/discover/manifest.json"),
                content: render_json(&Value::Object(next_manifest)),
            },
        ],
        &[],
    )
}

fn confirm_glossary(app: &Arc<App>, mode: &Arc<Mode>, conn: &Conn, context: &Value, id: &Value) {
    let Some((context, id)) = discover_term_request(context, id) else {
        notify_discover_failure(
            Some(conn),
            "Confirming a term needs its bounded context and id.",
        );
        return;
    };
    let repo_dir = app.config().repo_dir.clone();
    let root = target_root(&lock(&mode.state), &repo_dir);
    let outcome = update_term(
        &root,
        &context,
        &id,
        |concept| {
            if concept.status != "proposed" && concept.status != "unconfirmed" {
                return Some(format!("{id} is {}, not confirmable", concept.status));
            }
            concept.status = "confirmed".to_string();
            None
        },
        "confirm",
        None,
    );
    match outcome {
        Err(error) => notify_discover_failure(Some(conn), &error),
        Ok(()) => push_state(app, mode),
    }
}

fn reject_glossary(
    app: &Arc<App>,
    mode: &Arc<Mode>,
    conn: &Conn,
    context: &Value,
    id: &Value,
    reason: &Value,
) {
    let Some((context, id)) = discover_term_request(context, id) else {
        notify_discover_failure(
            Some(conn),
            "Rejecting a term needs its bounded context, id, and reason.",
        );
        return;
    };
    let Some(reason) = reason.as_str() else {
        notify_discover_failure(
            Some(conn),
            "Rejecting a term needs its bounded context, id, and reason.",
        );
        return;
    };
    let trimmed = reason.trim().to_string();
    if trimmed.is_empty() {
        notify_discover_failure(Some(conn), "a rejection requires a non-empty reason");
        return;
    }
    let repo_dir = app.config().repo_dir.clone();
    let root = target_root(&lock(&mode.state), &repo_dir);
    let rejection = trimmed.clone();
    let outcome = update_term(
        &root,
        &context,
        &id,
        |concept| {
            if concept.status != "proposed"
                && concept.status != "unconfirmed"
                && concept.status != "confirmed"
            {
                return Some(format!(
                    "{id} is {}, so it cannot be rejected",
                    concept.status
                ));
            }
            concept.status = "invalidated".to_string();
            None
        },
        "reject",
        Some(rejection),
    );
    match outcome {
        Err(error) => notify_discover_failure(Some(conn), &error),
        Ok(()) => push_state(app, mode),
    }
}

/// Applies one command; `false` when it belongs to another mode.
pub async fn handle(app: &Arc<App>, conn: &Conn, command: &Command) -> bool {
    let mode = mode_for(app);
    match command {
        Command::GetDiscover => {
            replay_resource(app, conn);
            true
        }
        Command::DiscoverProject => {
            let app = Arc::clone(app);
            let mode = Arc::clone(&mode);
            let conn = conn.clone();
            tokio::spawn(async move {
                start_all(&app, &mode, Some(&conn), false).await;
            });
            true
        }
        Command::DiscoverAgent { agent } => {
            let app = Arc::clone(app);
            let mode = Arc::clone(&mode);
            let conn = conn.clone();
            let agent = agent.clone().unwrap_or(Value::Null);
            tokio::spawn(async move {
                start_agent(&app, &mode, &conn, &agent).await;
            });
            true
        }
        Command::DiscoverRemote { url } => {
            let app = Arc::clone(app);
            let mode = Arc::clone(&mode);
            let conn = conn.clone();
            let url = url.clone();
            tokio::spawn(async move {
                start_remote(&app, &mode, Some(&conn), &url, None).await;
            });
            true
        }
        Command::SwitchDiscoverRemote { url } => {
            switch_discover_remote(app, &mode, conn, url);
            true
        }
        Command::RemoveDiscoverRemote { url } => {
            remove_discover_remote(app, &mode, conn, url);
            true
        }
        Command::ClearDiscoverRemote => {
            clear_discover_remote(app, &mode, conn);
            true
        }
        Command::StopDiscover => {
            stop_discover(app, &mode, conn);
            true
        }
        Command::AnswerDiscover { id, value } => {
            answer_discover(
                app,
                &mode,
                conn,
                id.as_ref().unwrap_or(&Value::Null),
                value.as_ref().unwrap_or(&Value::Null),
            )
            .await;
            true
        }
        Command::ConfirmGlossaryTerm { context, id } => {
            confirm_glossary(
                app,
                &mode,
                conn,
                context.as_ref().unwrap_or(&Value::Null),
                id.as_ref().unwrap_or(&Value::Null),
            );
            true
        }
        Command::RejectGlossaryTerm {
            context,
            id,
            reason,
        } => {
            reject_glossary(
                app,
                &mode,
                conn,
                context.as_ref().unwrap_or(&Value::Null),
                id.as_ref().unwrap_or(&Value::Null),
                reason.as_ref().unwrap_or(&Value::Null),
            );
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("discover-prompt-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a scratch root");
        root
    }

    fn write_prompt(root: &Path, text: &str) {
        let path = root.join(".devboard/prompts").join(sheet().prompt_file);
        std::fs::create_dir_all(path.parent().expect("a prompt directory"))
            .expect("the prompt directory");
        std::fs::write(path, text).expect("a prompt file");
    }

    fn sheet() -> &'static AgentDescriptor {
        DISCOVER_AGENTS
            .iter()
            .find(|descriptor| descriptor.prompt_file == "discover-sheet.md")
            .expect("the sheet descriptor")
    }

    #[test]
    fn a_target_prompt_wins_over_the_host_copy() {
        let target = scratch("target");
        let host = scratch("host");
        write_prompt(&target, "# The shipped copy\n");
        write_prompt(&host, "# The host's edit\n");
        let snapshot = prompt_snapshot(&target, &host, sheet());
        assert_eq!(snapshot["text"], json!("# The shipped copy\n"));
        assert_eq!(snapshot["error"], Value::Null);
    }

    #[test]
    fn a_target_without_a_prompt_reads_the_host_copy() {
        let target = scratch("absent");
        let host = scratch("fallback");
        write_prompt(&host, "# The host's edit\n");
        let snapshot = prompt_snapshot(&target, &host, sheet());
        assert_eq!(snapshot["text"], json!("# The host's edit\n"));
        assert_eq!(snapshot["error"], Value::Null);
    }

    #[test]
    fn a_host_target_without_a_prompt_reports_the_read_error() {
        let host = scratch("missing-host");
        let snapshot = prompt_snapshot(&host, &host, sheet());
        assert_eq!(snapshot["text"], Value::Null);
        let error = snapshot["error"].as_str().expect("a read error");
        assert!(
            error.starts_with("Could not read the Data Sheet prompt: ENOENT"),
            "{error}"
        );
        assert!(
            error.contains(
                &host
                    .join(".devboard/prompts/discover-sheet.md")
                    .display()
                    .to_string()
            ),
            "{error}"
        );
    }
}

#[cfg(test)]
mod warning_tests {
    use super::*;

    const GENERATED: &str = "discover-testing-strategy";
    const EDITED: &str = "discover-naming-conventions";

    fn scratch(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("discover-warning-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a scratch root");
        root
    }

    fn write_file(path: PathBuf, text: &str) {
        std::fs::create_dir_all(path.parent().expect("a parent directory"))
            .expect("the parent directory");
        std::fs::write(path, text).expect("a skill body");
    }

    /// One publication rewrote `GENERATED` to its new baseline while `EDITED`
    /// keeps a live body that says the opposite thing about the same subject.
    fn published_pair(label: &str) -> (PathBuf, Value) {
        let root = scratch(label);
        let baseline = "- Never write tests first.\n";
        write_file(baseline_path(&root, GENERATED), baseline);
        write_file(live_skill_path(&root, GENERATED), baseline);
        write_file(
            baseline_path(&root, EDITED),
            "- Prefer tables for examples.\n",
        );
        write_file(
            live_skill_path(&root, EDITED),
            "- Always write tests first.\n",
        );
        let manifest = json!({
            "schemaVersion": 1,
            "skills": [
                {"name": GENERATED, "state": "generated"},
                {"name": EDITED, "state": "edited"},
            ],
            "paths": {
                "manifest": ".omp/discover/manifest.json",
                "sheet": ".omp/discover/sheet.json",
                "decisions": ".omp/discover/decisions.json",
                "glossaries": [],
            },
        });
        write_file(
            discover_root(&root).join("manifest.json"),
            &render_json(&manifest),
        );
        (root, manifest)
    }

    fn warning(left: &str, right: &str) -> String {
        format!("{left} and {right} disagree about write tests first")
    }

    #[test]
    fn publication_warns_about_an_edited_skill_against_a_regenerated_one() {
        let (root, manifest) = published_pair("publish");
        assert_eq!(
            live_skill_warnings(&root, &manifest),
            vec![warning(GENERATED, EDITED)]
        );
    }

    #[test]
    fn the_live_state_warns_about_an_edited_skill_against_a_regenerated_one() {
        let (root, _) = published_pair("state");
        let artifacts = read_artifacts(&root)
            .artifacts
            .expect("published artifacts");
        assert_eq!(
            artifacts
                .skills
                .iter()
                .map(|skill| (skill.name.as_str(), skill.state.as_str()))
                .collect::<Vec<_>>(),
            vec![(GENERATED, "generated"), (EDITED, "edited")]
        );
        assert_eq!(
            live_warnings(&root, &artifacts),
            vec![warning(GENERATED, EDITED)]
        );
    }
}
