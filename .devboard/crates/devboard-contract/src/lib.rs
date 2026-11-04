//! The normative contract corpus: loading, normalization, and replay.
//!
//! One recording per dispatcher command carries the frames the TypeScript
//! dashboard answered, the state tree it left, and the unauthorized answer.
//! Replay drives the same frames at the Rust dashboard on a private copy of the
//! same fixture and compares everything after the allowlisted nondeterministic
//! fields are normalized.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use serde_json::Value;

pub mod http_corpus;
pub mod http_table;

/// The settle window the recorder used: frames arriving this long after the
/// last one are not part of the answer.
pub const SETTLE_MS: u64 = 500;
pub const MAX_WAIT_MS: u64 = 6000;

/// One recorded scenario of one command.
#[derive(Debug, Clone)]
pub struct Scenario {
    pub name: String,
    pub send: String,
    pub frames: Vec<Value>,
    pub unauthorized: HttpAnswer,
    pub state: BTreeMap<String, String>,
    pub repository: BTreeMap<String, String>,
}

/// One recorded HTTP answer.
#[derive(Debug, Clone)]
pub struct HttpAnswer {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub status: u16,
    pub body: String,
}

/// One command's recording.
#[derive(Debug, Clone)]
pub struct CommandRecording {
    pub command: String,
    pub token: String,
    pub scenarios: Vec<Scenario>,
}

/// The whole corpus.
pub struct Corpus {
    pub root: PathBuf,
    pub commands: Vec<CommandRecording>,
    pub allowlist: Allowlist,
}

/// The explicit nondeterminism allowlist.
#[derive(Debug, Clone, Default)]
pub struct Allowlist {
    pub fields: Vec<AllowlistedField>,
    pub state_prefixes: Vec<AllowedPrefix>,
}

/// One state-tree prefix whose comparison waits for the subsystem port.
#[derive(Debug, Clone)]
pub struct AllowedPrefix {
    pub prefix: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct AllowlistedField {
    pub name: String,
    pub reason: String,
}

impl Corpus {
    /// Loads every command recording and the allowlist.
    pub fn load(root: &Path) -> anyhow::Result<Self> {
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let allowlist_value: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("allowlist.json"))
                .context("reading contract/allowlist.json")?,
        )
        .context("parsing the allowlist")?;
        let mut fields = Vec::new();
        for entry in allowlist_value
            .get("fields")
            .and_then(Value::as_array)
            .context("the allowlist names its fields")?
        {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .context("a field name")?;
            let reason = entry
                .get("reason")
                .and_then(Value::as_str)
                .context("a field reason")?;
            if reason.trim().len() < 8 {
                bail!("the allowlist entry {name} carries no real reason");
            }
            fields.push(AllowlistedField {
                name: name.to_string(),
                reason: reason.to_string(),
            });
        }
        let mut state_prefixes = Vec::new();
        for entry in allowlist_value
            .get("statePrefixes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let prefix = entry
                .get("prefix")
                .and_then(Value::as_str)
                .context("a state prefix")?;
            let reason = entry
                .get("reason")
                .and_then(Value::as_str)
                .context("a state prefix reason")?;
            if reason.trim().len() < 8 {
                bail!("the state prefix {prefix} carries no real reason");
            }
            state_prefixes.push(AllowedPrefix {
                prefix: prefix.to_string(),
                reason: reason.to_string(),
            });
        }
        let mut commands = Vec::new();
        let mut paths: Vec<PathBuf> = std::fs::read_dir(root.join("commands"))
            .context("reading contract/commands")?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect();
        paths.sort();
        for path in paths {
            let value: Value = serde_json::from_str(
                &std::fs::read_to_string(&path)
                    .with_context(|| format!("reading {}", path.display()))?,
            )?;
            let command = value
                .get("command")
                .and_then(Value::as_str)
                .context("a command name")?
                .to_string();
            let token = value
                .get("token")
                .and_then(Value::as_str)
                .context("a token")?
                .to_string();
            let mut scenarios = Vec::new();
            for scenario in value
                .get("scenarios")
                .and_then(Value::as_array)
                .context("scenarios")?
            {
                scenarios.push(parse_scenario(scenario)?);
            }
            commands.push(CommandRecording {
                command,
                token,
                scenarios,
            });
        }
        Ok(Self {
            root,
            commands,
            allowlist: Allowlist {
                fields,
                state_prefixes,
            },
        })
    }

    /// The command names the corpus records.
    pub fn command_names(&self) -> BTreeSet<String> {
        self.commands
            .iter()
            .map(|recording| recording.command.clone())
            .collect()
    }

    /// The event types the corpus names.
    pub fn event_types(&self) -> BTreeSet<String> {
        let mut types = BTreeSet::new();
        for recording in &self.commands {
            for scenario in &recording.scenarios {
                for frame in &scenario.frames {
                    if let Some(kind) = frame.get("type").and_then(Value::as_str) {
                        types.insert(kind.to_string());
                    }
                }
            }
        }
        types
    }
}

fn parse_scenario(value: &Value) -> anyhow::Result<Scenario> {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .context("a scenario name")?
        .to_string();
    let send = value
        .get("send")
        .and_then(Value::as_str)
        .context("a scenario frame")?
        .to_string();
    let frames = value
        .get("frames")
        .and_then(Value::as_array)
        .context("scenario frames")?
        .clone();
    let unauthorized = parse_http(
        value
            .get("unauthorized")
            .context("the unauthorized answer")?,
    )?;
    let state = manifest_field(value.get("state"));
    let repository = manifest_field(value.get("repository"));
    Ok(Scenario {
        name,
        send,
        frames,
        unauthorized,
        state,
        repository,
    })
}

fn manifest_field(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut manifest = BTreeMap::new();
    if let Some(entries) = value.and_then(Value::as_object) {
        for (path, content) in entries {
            if let Some(content) = content.as_str() {
                manifest.insert(path.clone(), content.to_string());
            }
        }
    }
    manifest
}

fn parse_http(value: &Value) -> anyhow::Result<HttpAnswer> {
    let mut headers = BTreeMap::new();
    if let Some(entries) = value.get("headers").and_then(Value::as_object) {
        for (name, header) in entries {
            if let Some(header) = header.as_str() {
                headers.insert(name.clone(), header.to_string());
            }
        }
    }
    Ok(HttpAnswer {
        method: value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("GET")
            .to_string(),
        path: value
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("/")
            .to_string(),
        headers,
        status: value.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
        body: value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

/// The work root one scenario uses; it mirrors the recorder's layout.
pub fn scenario_root(corpus: &Path, command: &str, scenario: &str) -> PathBuf {
    corpus
        .join(".work")
        .join(format!("run-{command}-{scenario}"))
}

/// A lexically normalized absolute path, as Node's `resolve` returns it.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::CurDir => {}
            other => parts.push(other.as_os_str().to_os_string()),
        }
    }
    let mut out = PathBuf::new();
    for part in parts {
        out.push(part);
    }
    out
}

/// The checkout that built this replay. A recorded error names the checkout it
/// ran in, so that absolute root is normalized like the work root instead of
/// pinning the corpus to one worktree.
pub fn checkout_root() -> PathBuf {
    lexical_normalize(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

/// Formats a path the way the corpus names it: everything up to the work root
/// becomes `{{WORK}}`, and the checkout above it becomes `{{CHECKOUT}}`.
pub fn sanitize_text(text: &str, root: &Path) -> String {
    let root_text = root.to_string_lossy();
    let replaced = text.replace(&*root_text, "{{WORK}}");
    // Node's `resolve` prints a lexically normalized path; replace that form
    // too when the caller's root still carries a `..` segment.
    let normalized = lexical_normalize(root);
    let replaced = if normalized != *root {
        replaced.replace(&*normalized.to_string_lossy(), "{{WORK}}")
    } else {
        replaced
    };
    // The checkout root is a prefix of the work root, so it is replaced only
    // after the work root: a path under the corpus keeps its `{{WORK}}` name,
    // and a path that names the checkout itself becomes `{{CHECKOUT}}`.
    let checkout = checkout_root();
    let replaced = replaced.replace(&*checkout.to_string_lossy(), "{{CHECKOUT}}");
    let checkout_canonical = checkout.canonicalize().unwrap_or_else(|_| checkout.clone());
    let replaced = if checkout_canonical != checkout {
        replaced.replace(&*checkout_canonical.to_string_lossy(), "{{CHECKOUT}}")
    } else {
        replaced
    };
    // A home-relative project path names the same work root without its
    // absolute prefix; normalize the prefix too.
    let replaced = match replaced.rfind("contract/.work/run-") {
        Some(index) => format!("{{{{ROOT}}}}/{}", &replaced[index..]),
        None => replaced,
    };
    let replaced = strip_run_ids(&replaced);
    let replaced = strip_uuids(&replaced);
    let replaced = strip_hex24(&replaced);
    strip_flow_session_ids(&replaced)
}

/// Replaces the generated 8-hex session directory under `flow/<key>/`.
fn strip_flow_session_ids(text: &str) -> String {
    let marker = "flow/{{KEY24}}/";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(marker) {
        out.push_str(&rest[..index + marker.len()]);
        let after = &rest[index + marker.len()..];
        let bytes = after.as_bytes();
        let mut end = 0;
        while end < bytes.len() && bytes[end].is_ascii_hexdigit() {
            end += 1;
        }
        if end == 8 {
            out.push_str("{{ID8}}");
            rest = &after[end..];
        } else {
            rest = after;
        }
    }
    out.push_str(rest);
    // A Flow worktree and branch name carry the session id as `flow-<id>` and
    // `flow/<id>` outside a state path.
    let out = out;
    let mut rest = out.as_str();
    let mut rebuilt = String::new();
    while let Some(index) = rest.find("flow-") {
        rebuilt.push_str(&rest[..index + 5]);
        let after = &rest[index + 5..];
        let bytes = after.as_bytes();
        let mut end = 0;
        while end < bytes.len() && bytes[end].is_ascii_hexdigit() {
            end += 1;
        }
        if end == 8 {
            rebuilt.push_str("{{ID8}}");
            rest = &after[end..];
        } else {
            rest = after;
        }
    }
    rebuilt.push_str(rest);
    rebuilt
}

/// Replaces run identifiers and generated session ids.
fn strip_run_ids(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("run-") {
        out.push_str(&rest[..index]);
        let candidate = &rest[index..];
        let mut end = 4;
        let bytes = candidate.as_bytes();
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
            end += 1;
        }
        let token = &candidate[..end];
        if token.len() >= 10 {
            out.push_str("run-{{ID}}");
        } else {
            out.push_str(token);
        }
        rest = &candidate[end..];
    }
    out.push_str(rest);
    out
}

fn strip_uuids(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(|character: char| character.is_ascii_hexdigit()) {
        // A UUID is 8-4-4-4-12 hex digits; match it greedily from `start`.
        let candidate = &rest[start..];
        let bytes = candidate.as_bytes();
        let pattern = [8usize, 4, 4, 4, 12];
        let mut cursor = 0;
        let mut matched = true;
        for (index, length) in pattern.iter().enumerate() {
            if index > 0 {
                if bytes.get(cursor) != Some(&b'-') {
                    matched = false;
                    break;
                }
                cursor += 1;
            }
            let mut count = 0;
            while count < *length && bytes.get(cursor).is_some_and(u8::is_ascii_hexdigit) {
                cursor += 1;
                count += 1;
            }
            if count != *length {
                matched = false;
                break;
            }
        }
        if matched {
            out.push_str(&rest[..start]);
            out.push_str("{{UUID}}");
            rest = &rest[start + cursor..];
        } else {
            let character = rest[start..].chars().next().expect("a character");
            out.push_str(&rest[..start + character.len_utf8()]);
            rest = &rest[start + character.len_utf8()..];
        }
    }
    out.push_str(rest);
    out
}

fn strip_hex24(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let Some(start) = rest.find(|character: char| character.is_ascii_hexdigit()) else {
            break;
        };
        let bytes = rest.as_bytes();
        let mut cursor = start;
        while cursor < bytes.len() && bytes[cursor].is_ascii_hexdigit() {
            cursor += 1;
        }
        out.push_str(&rest[..start]);
        if cursor - start == 24 {
            out.push_str("{{KEY24}}");
        } else if cursor - start == 32 {
            out.push_str("{{ID32}}");
        } else {
            out.push_str(&rest[start..cursor]);
        }
        rest = &rest[cursor..];
    }
    out.push_str(rest);
    out
}

/// Normalizes one value for comparison.
pub fn normalize(value: &Value, allowlist: &Allowlist, root: &Path) -> Value {
    match value {
        Value::Object(object) => {
            let mut normalized = serde_json::Map::new();
            for (key, item) in object {
                if allowlist.fields.iter().any(|field| field.name == *key) {
                    normalized.insert(key.clone(), Value::String(format!("<ignored:{key}>")));
                } else {
                    normalized.insert(key.clone(), normalize(item, allowlist, root));
                }
            }
            Value::Object(normalized)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| normalize(item, allowlist, root))
                .collect(),
        ),
        Value::String(text) => Value::String(sanitize_text(text, root)),
        other => other.clone(),
    }
}

/// The report of one replay run.
#[derive(Debug, Default)]
pub struct Report {
    pub compared: usize,
    pub matched: usize,
    pub mismatches: Vec<Mismatch>,
    pub unimplemented: BTreeSet<String>,
}

#[derive(Debug)]
pub struct Mismatch {
    pub command: String,
    pub scenario: String,
    pub detail: String,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.mismatches.is_empty()
    }
}

/// Replays one command's scenarios that the dashboard implements.
pub async fn replay_command(
    corpus: &Corpus,
    recording: &CommandRecording,
    implemented: &(dyn Fn(&str) -> bool + Sync),
    report: &mut Report,
) -> anyhow::Result<()> {
    if !implemented(&recording.command) {
        report.unimplemented.insert(recording.command.clone());
        return Ok(());
    }
    for scenario in &recording.scenarios {
        let root = scenario_root(&corpus.root, &recording.command, &scenario.name);
        let outcome = replays(corpus, recording, scenario, &root).await?;
        report.compared += 1;
        match outcome {
            Ok(()) => report.matched += 1,
            Err(detail) => report.mismatches.push(Mismatch {
                command: recording.command.clone(),
                scenario: scenario.name.clone(),
                detail,
            }),
        }
    }
    Ok(())
}

/// Replays one scenario and returns its mismatch, if any.
async fn replays(
    corpus: &Corpus,
    recording: &CommandRecording,
    scenario: &Scenario,
    root: &Path,
) -> anyhow::Result<Result<(), String>> {
    let fixture = corpus.root.join("fixtures");
    let repo_dir = root.join("repo");
    let state_dir = root.join("state");
    let _ = std::fs::remove_dir_all(root);
    std::fs::create_dir_all(&state_dir)?;
    copy_dir(&fixture.join("repo"), &repo_dir)?;

    let mut config = crate::dashboard_config(
        &repo_dir,
        &state_dir,
        &fixture.join("static"),
        &recording.token,
    );
    config.port = 0;
    let listener = devboard::http::bind("127.0.0.1", 0).await?;
    let port = listener.local_addr()?.port();
    config.port = port;
    let journal = devboard::journal::Journal::open(&state_dir, &repo_dir, port);
    let server = devboard::http::Server::new(config, journal);
    let app = server.app.clone();
    let handle = tokio::spawn(async move {
        let _ = devboard::http::serve_on(listener, server).await;
    });

    let unauthorized = probe_unauthorized(port).await?;
    let normalized_expected = normalize(
        &serde_json::json!(scenario.unauthorized.status),
        &corpus.allowlist,
        root,
    );
    let normalized_actual = normalize(
        &serde_json::json!(unauthorized.status),
        &corpus.allowlist,
        root,
    );
    if normalized_expected != normalized_actual {
        handle.abort();
        return Ok(Err(format!(
            "unauthorized probe answered {} not {}",
            unauthorized.status, scenario.unauthorized.status
        )));
    }

    let frames = drive_socket(port, &recording.token, &scenario.send).await?;
    let actual: Vec<Value> = frames
        .iter()
        .map(|frame| normalize(frame, &corpus.allowlist, root))
        .collect();
    let expected: Vec<Value> = scenario
        .frames
        .iter()
        .map(|frame| normalize(frame, &corpus.allowlist, root))
        .collect();
    if actual != expected {
        handle.abort();
        return Ok(Err(describe_frame_mismatch(&expected, &actual)));
    }

    let actual_state = crate::state_manifest(&state_dir, root);
    let expected_state: BTreeMap<String, String> = scenario
        .state
        .iter()
        .map(|(path, content)| {
            (
                normalize_text(path, &corpus.allowlist, root),
                normalize_text(content, &corpus.allowlist, root),
            )
        })
        .collect();
    let actual_state: BTreeMap<String, String> = actual_state
        .into_iter()
        .map(|(path, content)| {
            (
                normalize_text(&path, &corpus.allowlist, root),
                normalize_text(&content, &corpus.allowlist, root),
            )
        })
        .collect();
    let pending = |path: &String| {
        corpus
            .allowlist
            .state_prefixes
            .iter()
            .any(|entry| path.starts_with(&entry.prefix))
    };
    let missing: Vec<&String> = expected_state
        .keys()
        .filter(|path| !pending(path) && !actual_state.contains_key(*path))
        .collect();
    let extra: Vec<&String> = actual_state
        .keys()
        .filter(|path| !pending(path) && !expected_state.contains_key(*path))
        .collect();
    let changed: Vec<&String> = expected_state
        .iter()
        .filter(|(path, content)| {
            actual_state
                .get(*path)
                .is_some_and(|actual| actual != *content)
        })
        .map(|(path, _)| path)
        .collect();
    let _ = app;
    handle.abort();
    if !missing.is_empty() || !extra.is_empty() || !changed.is_empty() {
        return Ok(Err(format!(
            "state tree differs: missing {missing:?}, extra {extra:?}, changed {changed:?}"
        )));
    }

    // The repository tree is contract too: a mutating command writes the same
    // files at the same paths with the same bytes.
    let actual_repo = crate::state_manifest(&repo_dir, root);
    let expected_repo: BTreeMap<String, String> = scenario
        .repository
        .iter()
        .map(|(path, content)| {
            (
                normalize_text(path, &corpus.allowlist, root),
                normalize_text(content, &corpus.allowlist, root),
            )
        })
        .collect();
    let actual_repo: BTreeMap<String, String> = actual_repo
        .into_iter()
        .map(|(path, content)| {
            (
                normalize_text(&path, &corpus.allowlist, root),
                normalize_text(&content, &corpus.allowlist, root),
            )
        })
        .collect();
    if !expected_repo.is_empty() {
        let missing_repo: Vec<&String> = expected_repo
            .keys()
            .filter(|path| !actual_repo.contains_key(*path))
            .collect();
        let extra_repo: Vec<&String> = actual_repo
            .keys()
            .filter(|path| !expected_repo.contains_key(*path))
            .collect();
        let changed_repo: Vec<&String> = expected_repo
            .iter()
            .filter(|(path, content)| {
                actual_repo
                    .get(*path)
                    .is_some_and(|actual| actual != *content)
            })
            .map(|(path, _)| path)
            .collect();
        if !missing_repo.is_empty() || !extra_repo.is_empty() || !changed_repo.is_empty() {
            return Ok(Err(format!(
                "repository tree differs: missing {missing_repo:?}, extra {extra_repo:?}, \
                 changed {changed_repo:?}"
            )));
        }
    }
    Ok(Ok(()))
}

/// Normalizes one text file's content under the same allowlist.
fn normalize_text(content: &str, allowlist: &Allowlist, root: &Path) -> String {
    let parsed: Option<Value> = serde_json::from_str(content).ok();
    match parsed {
        Some(mut value) => {
            // A Flow session carries its generated session id under `id`; the
            // branch and worktree name it too, and the corpus allowlist keeps
            // generated identifiers out of the comparison.
            if let Some(object) = value.as_object_mut() {
                let is_flow_session = object
                    .get("branch")
                    .and_then(Value::as_str)
                    .is_some_and(|branch| branch.starts_with("flow/"));
                if is_flow_session {
                    if let Some(id) = object.get("id").and_then(Value::as_str) {
                        if id.len() == 8 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                            object.insert("id".to_string(), Value::String("<ignored:id>".into()));
                        }
                    }
                }
            }
            devboard::jsjson::stringify(&normalize(&value, allowlist, root))
        }
        None => sanitize_text(content, root),
    }
}

fn describe_frame_mismatch(expected: &[Value], actual: &[Value]) -> String {
    if expected.len() != actual.len() {
        return format!(
            "expected {} frames, got {}: expected {expected:?}, actual {actual:?}",
            expected.len(),
            actual.len()
        );
    }
    for (index, (want, got)) in expected.iter().zip(actual.iter()).enumerate() {
        if want != got {
            return format!("frame {index}: expected {want}, got {got}");
        }
    }
    "frames differ".to_string()
}

async fn probe_unauthorized(port: u16) -> anyhow::Result<HttpAnswer> {
    let response = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/ws"))
        .send()
        .await?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    for (name, value) in response.headers() {
        headers.insert(name.to_string(), value.to_str().unwrap_or("").to_string());
    }
    let body = response.text().await.unwrap_or_default();
    Ok(HttpAnswer {
        method: "GET".to_string(),
        path: "/ws".to_string(),
        headers,
        status,
        body,
    })
}

/// Drives one frame at a socket and collects every answer within the settle
/// window.
pub async fn drive_socket(port: u16, token: &str, send: &str) -> anyhow::Result<Vec<Value>> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let mut request = format!("ws://127.0.0.1:{port}/ws").into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        axum::http::HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    let (mut socket, _response) = tokio_tungstenite::connect_async(request).await?;
    // The open replay settles before the command runs.
    drain_quiet(&mut socket, None).await;
    socket.send(Message::Text(send.to_string().into())).await?;
    let mut frames = Vec::new();
    let mut last = Instant::now();
    let started = Instant::now();
    loop {
        let wait = Duration::from_millis(SETTLE_MS);
        match tokio::time::timeout(wait, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    frames.push(value);
                }
                last = Instant::now();
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => {
                if last.elapsed() >= Duration::from_millis(SETTLE_MS)
                    || started.elapsed() >= Duration::from_millis(MAX_WAIT_MS)
                {
                    break;
                }
            }
        }
        if started.elapsed() >= Duration::from_millis(MAX_WAIT_MS) {
            break;
        }
    }
    let _ = socket.close(None).await;
    Ok(frames)
}

async fn drain_quiet(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    _unused: Option<()>,
) {
    use futures_util::StreamExt;
    // A replay may span several async reads; a frame that arrives within the
    // settle window continues it. Only a full settle window of silence ends
    // the drain, exactly like the recorder's wait after connecting.
    let started = Instant::now();
    loop {
        if started.elapsed() >= Duration::from_millis(MAX_WAIT_MS) {
            break;
        }
        match tokio::time::timeout(Duration::from_millis(SETTLE_MS), socket.next()).await {
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => break,
        }
    }
}

/// Copies one directory tree.
pub fn copy_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&path, &destination)?;
        } else {
            std::fs::copy(&path, &destination)?;
        }
    }
    Ok(())
}

/// The state tree one scenario left: relative path → text content.
pub fn state_manifest(state_dir: &Path, root: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    visit(state_dir, state_dir, root, &mut files);
    files
}

fn visit(base: &Path, directory: &Path, root: &Path, files: &mut BTreeMap<String, String>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            visit(base, &path, root, files);
            continue;
        }
        let relative = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        files.insert(
            sanitize_text(&relative, root),
            sanitize_text(&content, root),
        );
    }
}

/// Builds the configuration one replay instance uses.
pub fn dashboard_config(
    repo_dir: &Path,
    state_dir: &Path,
    static_dir: &Path,
    token: &str,
) -> devboard::config::Config {
    devboard::config::Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        addr_dir: repo_dir.join("adrs"),
        repo_dir: repo_dir.to_path_buf(),
        goal_file: repo_dir.join("GOAL.md"),
        static_dir: Some(static_dir.to_path_buf()),
        agent_command: "true".to_string(),
        state_dir: state_dir.to_path_buf(),
        allowed_hosts: Vec::new(),
        token: token.to_string(),
        bootstrap: "contract-bootstrap".to_string(),
        feedback: None,
    }
}

/// The full replay over every recording.
pub async fn replay_all(
    root: &Path,
    implemented: &(dyn Fn(&str) -> bool + Sync),
) -> anyhow::Result<Report> {
    let corpus = Corpus::load(root)?;
    let mut report = Report::default();
    for recording in &corpus.commands {
        replay_command(&corpus, recording, implemented, &mut report).await?;
    }
    Ok(report)
}

/// Unused helper so the crate can expose the dashboard without a name clash.
pub fn dashboard() -> Arc<()> {
    Arc::new(())
}
