//! The publish-only source refresh.
//!
//! A dashboard serving a harness source checkout never installs a package and
//! never replaces itself on an update check. One successful `devboard publish`
//! writes a request into the dashboard's own state directory; a valid,
//! unapplied request whose bundle digest matches replaces the process through
//! the ordinary replacement handoff.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::app::App;

pub const SOURCE_REFRESH_SCHEMA: u64 = 1;
pub const SOURCE_REFRESH_DIRECTORY: &str = "source-refresh";
pub const SOURCE_REFRESH_REQUEST_FILE: &str = "request.json";
pub const SOURCE_REFRESH_APPLIED_FILE: &str = "applied.json";
pub const DEFAULT_SOURCE_REFRESH_INTERVAL_MS: u64 = 60_000;
pub const MIN_SOURCE_REFRESH_INTERVAL_MS: u64 = 1_000;

/// One publish-written request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRefreshRequest {
    pub schema: u64,
    pub commit: String,
    pub version: String,
    pub dist_digest: String,
    pub requested_at: String,
}

/// The request a dashboard actually applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedSourceRefresh {
    pub commit: String,
    pub version: String,
    pub dist_digest: String,
    pub applied_at: String,
}

/// Where the source-refresh files live.
pub fn source_refresh_directory(state_dir: &Path) -> PathBuf {
    state_dir.join(SOURCE_REFRESH_DIRECTORY)
}

pub fn source_refresh_request_path(state_dir: &Path) -> PathBuf {
    source_refresh_directory(state_dir).join(SOURCE_REFRESH_REQUEST_FILE)
}

pub fn source_refresh_applied_path(state_dir: &Path) -> PathBuf {
    source_refresh_directory(state_dir).join(SOURCE_REFRESH_APPLIED_FILE)
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn is_hex_lower_or_upper(value: &str, minimum: usize) -> bool {
    (minimum..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Parses one request document; anything malformed is not a request.
pub fn parse_source_refresh_request(value: &Value) -> Option<SourceRefreshRequest> {
    let object = value.as_object()?;
    if object.get("schema").and_then(Value::as_u64) != Some(SOURCE_REFRESH_SCHEMA) {
        return None;
    }
    let commit = non_empty_string(object.get("commit"))?;
    let version = non_empty_string(object.get("version"))?;
    let dist_digest = non_empty_string(object.get("distDigest"))?;
    let requested_at = non_empty_string(object.get("requestedAt"))?;
    if !is_hex_lower_or_upper(&commit, 7) || !is_digest(&dist_digest) {
        return None;
    }
    Some(SourceRefreshRequest {
        schema: SOURCE_REFRESH_SCHEMA,
        commit,
        version,
        dist_digest,
        requested_at,
    })
}

/// The outcome of reading the request file.
pub enum RequestRead {
    Missing,
    Invalid {
        error: String,
        key: String,
    },
    Valid {
        request: SourceRefreshRequest,
        key: String,
    },
}

/// Reads the request a publish wrote.
pub fn read_source_refresh_request(state_dir: &Path) -> RequestRead {
    let path = source_refresh_request_path(state_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return RequestRead::Missing,
        Err(error) => {
            return RequestRead::Invalid {
                error: format!("could not read {}: {error}", path.display()),
                key: format!("unreadable:{}", path.display()),
            }
        }
    };
    let key = hex::encode(Sha256::digest(text.as_bytes()));
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            return RequestRead::Invalid {
                error: format!("could not parse {}: {error}", path.display()),
                key,
            }
        }
    };
    match parse_source_refresh_request(&parsed) {
        Some(request) => RequestRead::Valid { request, key },
        None => RequestRead::Invalid {
            error: format!("{} is not a source refresh request", path.display()),
            key,
        },
    }
}

/// Reads the applied marker.
pub fn read_applied_source_refresh(state_dir: &Path) -> Option<AppliedSourceRefresh> {
    let source = std::fs::read_to_string(source_refresh_applied_path(state_dir)).ok()?;
    let parsed: Value = serde_json::from_str(&source).ok()?;
    let object = parsed.as_object()?;
    Some(AppliedSourceRefresh {
        commit: non_empty_string(object.get("commit"))?,
        version: non_empty_string(object.get("version"))?,
        dist_digest: non_empty_string(object.get("distDigest"))?,
        applied_at: non_empty_string(object.get("appliedAt"))?,
    })
}

/// Writes the applied marker atomically.
pub fn write_applied_source_refresh(
    state_dir: &Path,
    request: &SourceRefreshRequest,
) -> std::io::Result<()> {
    let path = source_refresh_applied_path(state_dir);
    let mut text = crate::jsjson::stringify(&json!({
        "commit": request.commit,
        "version": request.version,
        "distDigest": request.dist_digest,
        "appliedAt": crate::journal::now_iso8601(),
    }));
    text.push('\n');
    crate::state::write_file_atomically_sync(&path, &text)
}

/// True when this dashboard already applied this request's commit.
pub fn already_applied(
    applied: Option<&AppliedSourceRefresh>,
    request: &SourceRefreshRequest,
) -> bool {
    applied
        .map(|applied| applied.commit == request.commit)
        .unwrap_or(false)
}

/// A deterministic SHA-256 of a built bundle tree.
pub fn dist_digest(directory: &Path) -> std::io::Result<String> {
    if !directory.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("the bundle directory is missing at {}", directory.display()),
        ));
    }
    let mut files = Vec::new();
    collect_files(directory, "", &mut files)?;
    files.sort();
    let mut hash = Sha256::new();
    for relative in files {
        hash.update(relative.as_bytes());
        hash.update([0u8]);
        let bytes = std::fs::read(directory.join(&relative))?;
        hash.update(&bytes);
        hash.update([0u8]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn collect_files(directory: &Path, prefix: &str, files: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_files(&entry.path(), &relative, files)?;
        } else if kind.is_file() {
            files.push(relative);
        }
    }
    Ok(())
}

/// The poll interval: the default, a configured value, never below 1s.
pub fn source_refresh_interval_ms() -> u64 {
    std::env::var("DEVBOARD_SOURCE_REFRESH_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.max(MIN_SOURCE_REFRESH_INTERVAL_MS))
        .unwrap_or(DEFAULT_SOURCE_REFRESH_INTERVAL_MS)
}

/// Starts the watcher for one dashboard process.
pub fn start(app: Arc<App>) -> SourceRefresher {
    let stopped = Arc::new(AtomicBool::new(false));
    let in_flight = Arc::new(Mutex::new(()));
    let interval_ms = source_refresh_interval_ms();
    let harness = crate::version::running_harness_dir();
    let dist = harness.join("dist");
    app.shared.journal.write(
        "activity",
        &format!(
            "source refresh watching {} every {interval_ms} ms",
            dist.display()
        ),
        None,
    );
    let task = {
        let app = Arc::clone(&app);
        let stopped = Arc::clone(&stopped);
        tokio::spawn(async move {
            let first = if std::env::var("DEVBOARD_REPLACEMENT_READY_FILE")
                .map(|value| value.is_empty())
                .unwrap_or(true)
            {
                0
            } else {
                interval_ms
            };
            tokio::time::sleep(std::time::Duration::from_millis(first)).await;
            loop {
                if stopped.load(Ordering::SeqCst) {
                    return;
                }
                check_once(&app, &dist).await;
                tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
            }
        })
    };
    SourceRefresher {
        interval_ms,
        stopped,
        task: Mutex::new(Some(task)),
        _in_flight: in_flight,
    }
}

/// One watcher handle.
pub struct SourceRefresher {
    pub interval_ms: u64,
    stopped: Arc<AtomicBool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    _in_flight: Arc<Mutex<()>>,
}

impl SourceRefresher {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Ok(mut task) = self.task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

/// What one poll of the request file does.
#[derive(Debug, PartialEq, Eq)]
pub enum RefreshAction {
    /// Nothing to do: no request, or the request's commit already applied.
    Idle,
    /// Journal this one record and keep serving.
    Report {
        kind: &'static str,
        key: String,
        text: String,
    },
    /// Replace the process through the replacement handoff.
    Replace(SourceRefreshRequest),
}

/// Decides what one poll of the request file does, without side effects.
///
/// A request whose digest names a bundle other than the one this dashboard
/// serves was superseded by a later build: it can never apply, so it is
/// recorded once per request as `activity` — nothing failed — while the poll
/// keeps checking, so a `dist` rebuilt back to the requested tree still
/// applies it. An unreadable request or an unreadable bundle is a failure and
/// is recorded as `update-error`.
pub fn plan_refresh(state_dir: &Path, dist: &Path) -> RefreshAction {
    let (request, key) = match read_source_refresh_request(state_dir) {
        RequestRead::Missing => return RefreshAction::Idle,
        RequestRead::Invalid { error, key } => {
            return RefreshAction::Report {
                kind: "update-error",
                key,
                text: format!("source refresh ignored: {error}"),
            }
        }
        RequestRead::Valid { request, key } => (request, key),
    };
    if already_applied(read_applied_source_refresh(state_dir).as_ref(), &request) {
        return RefreshAction::Idle;
    }
    let current = match dist_digest(dist) {
        Ok(digest) => digest,
        Err(error) => {
            return RefreshAction::Report {
                kind: "update-error",
                key: format!("digest-unreadable:{key}"),
                text: format!(
                    "source refresh ignored: could not read {}: {error}",
                    dist.display()
                ),
            }
        }
    };
    if current != request.dist_digest {
        return RefreshAction::Report {
            kind: "activity",
            key: format!("superseded:{key}"),
            text: format!(
                "source refresh ignored: {} digests {current}, not the requested {}; \
                 a later build superseded this request",
                dist.display(),
                request.dist_digest
            ),
        };
    }
    RefreshAction::Replace(request)
}

async fn check_once(app: &Arc<App>, dist: &Path) {
    let state_dir = &app.config().state_dir;
    match plan_refresh(state_dir, dist) {
        RefreshAction::Idle => {}
        RefreshAction::Report { kind, key, text } => report_once(app, kind, &key, &text),
        RefreshAction::Replace(request) => replace(app, state_dir, &request).await,
    }
}

/// The replacement handoff for one matching request.
async fn replace(app: &Arc<App>, state_dir: &Path, request: &SourceRefreshRequest) {
    app.shared.journal.write(
        "update",
        &format!(
            "source refresh requested: replacing with {} ({})",
            request.version,
            &request.commit[..7.min(request.commit.len())]
        ),
        None,
    );
    let settings = crate::relaunch::RelaunchSettings::from_config(app.config());
    let ready_file = source_refresh_directory(state_dir).join(format!(
        "ready-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    ));
    match crate::relaunch::relaunch_confirmed(
        &settings,
        &ready_file,
        10_000,
        Some(request.version.as_str()),
    )
    .await
    {
        Ok(()) => {
            let _ = write_applied_source_refresh(state_dir, request);
            app.prepare_replacement();
            app.shared.shutdown.notify_waiters();
            std::process::exit(0);
        }
        Err(error) => {
            app.shared.journal.write(
                "update-error",
                &format!("source refresh failed: {error}"),
                None,
            );
        }
    }
}

fn report_once(app: &Arc<App>, kind: &str, key: &str, text: &str) {
    static REPORTED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);
    let first = {
        let mut reported = REPORTED.lock().expect("the source refresh report set");
        reported
            .get_or_insert_with(std::collections::HashSet::new)
            .insert(key.to_string())
    };
    if first {
        app.shared.journal.write(kind, text, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_round_trips_and_a_bad_digest_is_refused() {
        let request = SourceRefreshRequest {
            schema: SOURCE_REFRESH_SCHEMA,
            commit: "abcdef1234567".to_string(),
            version: "1.2.3".to_string(),
            dist_digest: "a".repeat(64),
            requested_at: "2026-11-03T00:00:00.000Z".to_string(),
        };
        let value = json!({
            "schema": request.schema,
            "commit": request.commit,
            "version": request.version,
            "distDigest": request.dist_digest,
            "requestedAt": request.requested_at,
        });
        assert_eq!(parse_source_refresh_request(&value), Some(request));
        let mut bad = value;
        bad["distDigest"] = json!("nope");
        assert_eq!(parse_source_refresh_request(&bad), None);
    }

    fn scratch(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("source-refresh-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a scratch root");
        root
    }

    fn write_request(state_dir: &Path, commit: &str, dist_digest: &str) {
        let directory = source_refresh_directory(state_dir);
        std::fs::create_dir_all(&directory).expect("the source refresh directory");
        let text = crate::jsjson::stringify(&json!({
            "schema": SOURCE_REFRESH_SCHEMA,
            "commit": commit,
            "version": "1.2.3",
            "distDigest": dist_digest,
            "requestedAt": "2026-11-03T00:00:00.000Z",
        }));
        std::fs::write(directory.join(SOURCE_REFRESH_REQUEST_FILE), text).expect("a request");
    }

    #[test]
    fn a_superseded_request_is_recorded_once_and_a_matching_one_replaces() {
        let root = scratch("superseded");
        let state_dir = root.join("state");
        let dist = root.join("dist");
        std::fs::create_dir_all(dist.join("assets")).expect("the bundle");
        std::fs::write(dist.join("index.html"), b"<html>published</html>").expect("an asset");
        let published = dist_digest(&dist).expect("the published digest");

        assert_eq!(plan_refresh(&state_dir, &dist), RefreshAction::Idle);

        write_request(&state_dir, "abcdef1234567", &"b".repeat(64));
        let (kind, key) = match plan_refresh(&state_dir, &dist) {
            RefreshAction::Report { kind, key, text } => {
                assert!(
                    text.contains(&published),
                    "the record names the served bundle: {text}"
                );
                (kind, key)
            }
            other => panic!("a superseded request reports, not {other:?}"),
        };
        assert_eq!(kind, "activity", "an ignored request is not a failure");

        std::fs::write(dist.join("index.html"), b"<html>rebuilt</html>").expect("a rebuilt asset");
        match plan_refresh(&state_dir, &dist) {
            RefreshAction::Report {
                kind, key: again, ..
            } => {
                assert_eq!(kind, "activity");
                assert_eq!(again, key, "a rebuilt bundle keeps one record per request");
            }
            other => panic!("a superseded request reports, not {other:?}"),
        }

        std::fs::write(dist.join("index.html"), b"<html>published</html>")
            .expect("the published asset");
        write_request(&state_dir, "abcdef1234567", &published);
        assert!(
            matches!(plan_refresh(&state_dir, &dist), RefreshAction::Replace(_)),
            "a request naming the served bundle replaces the process"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unreadable_bundle_and_a_malformed_request_are_failures() {
        let root = scratch("failure");
        let state_dir = root.join("state");
        write_request(&state_dir, "abcdef1234567", &"c".repeat(64));

        match plan_refresh(&state_dir, &root.join("missing-dist")) {
            RefreshAction::Report { kind, key, .. } => {
                assert_eq!(kind, "update-error");
                assert!(key.starts_with("digest-unreadable:"));
            }
            other => panic!("a missing bundle reports a failure, not {other:?}"),
        }

        std::fs::write(
            source_refresh_directory(&state_dir).join(SOURCE_REFRESH_REQUEST_FILE),
            "{}",
        )
        .expect("a malformed request");
        match plan_refresh(&state_dir, &root.join("missing-dist")) {
            RefreshAction::Report { kind, .. } => assert_eq!(kind, "update-error"),
            other => panic!("a malformed request reports a failure, not {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&root);
    }
}
