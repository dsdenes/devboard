//! Automatic harness updates from the Gitea release manifest.
//!
//! The dashboard reads the newest manifest at startup and every interval,
//! installs a newer artifact while it keeps serving, and replaces itself
//! without an operator click. A failed check or install is journaled once per
//! attempt and retried with backoff; the running harness is never replaced by
//! a failed or partial install.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::task::JoinHandle;

use crate::app::App;
use crate::release::{self, ManifestSource};

/// The default check interval.
pub const DEFAULT_UPDATE_INTERVAL_MS: u64 = 60_000;
/// A repeated failure backs off to this ceiling.
pub const DEFAULT_MAX_BACKOFF_MS: u64 = 60 * 60_000;

/// One update decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateOutcome {
    Current,
    Installed,
    Failed,
    Stopped,
}

/// The check loop's shared state.
pub struct Updater {
    app: std::sync::Weak<App>,
    stopped: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl Updater {
    /// The newest release a check has seen, or `None` before the first check.
    pub fn latest(&self) -> Option<String> {
        self.app.upgrade().and_then(|app| app.latest_version())
    }

    /// Stops the next check; an in-flight check finishes.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Ok(mut handle) = self.handle.lock() {
            if let Some(handle) = handle.take() {
                handle.abort();
            }
        }
    }
}

/// The next check delay: the base interval until a failure backs it off.
pub fn update_retry_delay(failures: u32, interval_ms: u64, max_backoff_ms: u64) -> u64 {
    if failures == 0 {
        return interval_ms;
    }
    let factor = 2u64.saturating_pow(failures.min(16));
    interval_ms.saturating_mul(factor).min(max_backoff_ms)
}

fn positive_number(value: Option<String>, fallback: u64) -> u64 {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

/// Resolves the manifest source from the environment, or `None` when neither a
/// Gitea instance nor a local release directory is configured.
///
/// `DEVBOARD_RELEASE_URL` names a local directory that carries
/// `devboard-manifest.json` and its artifacts; it wins, and makes every read a
/// local file read for offline verification.
pub fn manifest_source_from_env(_state_dir: &std::path::Path) -> Option<ManifestSource> {
    manifest_source(&std::env::vars().collect())
}

/// The release source one explicit environment names.
pub fn manifest_source(
    environment: &std::collections::HashMap<String, String>,
) -> Option<ManifestSource> {
    if let Some(local) = environment
        .get("DEVBOARD_RELEASE_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let path = std::path::PathBuf::from(local.strip_prefix("file://").unwrap_or(&local));
        return Some(ManifestSource {
            base_url: String::new(),
            repository: release::RELEASE_REPOSITORY.to_string(),
            token: None,
            timeout_ms: 30_000,
            local_dir: Some(path),
            forge: release::ReleaseForge::Gitea,
            download_base: String::new(),
            gitea_fallback: None,
        });
    }
    let repository =
        release::release_project(environment.get("DEVBOARD_RELEASE_REPO").map(String::as_str));
    // The Gitea origin this environment names. A configured origin takes the
    // read below, so a public GitHub source carries this only as the fallback a
    // failed artifact read consults: the source resolves it once, beside its
    // other fields, instead of the download reading the process environment.
    let gitea_fallback = gitea_base(environment);
    if let Some(base_url) = &gitea_fallback {
        // The release repository is public. A check that presented the
        // operator's credential made Gitea update the token row every
        // interval, so the read is anonymous and never touches that store.
        return Some(ManifestSource {
            base_url: base_url.trim_end_matches('/').to_string(),
            repository,
            token: None,
            timeout_ms: 30_000,
            local_dir: None,
            forge: release::ReleaseForge::Gitea,
            download_base: String::new(),
            gitea_fallback: None,
        });
    }
    // A host that cannot reach Gitea installs, updates, and passes doctor
    // from the public GitHub release. The read is unauthenticated unless the
    // environment already carries a public token; no token command runs here.
    let base_url = environment
        .get("DEVBOARD_GITHUB_API_URL")
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://api.github.com".to_string());
    let download_base = environment
        .get("DEVBOARD_GITHUB_DOWNLOAD_URL")
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if base_url == "https://api.github.com" {
                format!("https://github.com/{repository}")
            } else {
                format!("{base_url}/{repository}")
            }
        });
    let token = environment
        .get("GH_TOKEN")
        .or_else(|| environment.get("GITHUB_TOKEN"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Some(ManifestSource {
        base_url,
        repository,
        token,
        timeout_ms: 30_000,
        local_dir: None,
        forge: release::ReleaseForge::GitHub,
        download_base,
        gitea_fallback,
    })
}

/// The Gitea HTTP origin for a release read: `DEVBOARD_GITEA_URL`, then the
/// host's own `GITEA_URL`.
pub fn gitea_base_from_env() -> Option<String> {
    gitea_base(&std::env::vars().collect())
}

fn gitea_base(environment: &std::collections::HashMap<String, String>) -> Option<String> {
    for key in ["DEVBOARD_GITEA_URL", "GITEA_URL"] {
        let Some(raw) = environment.get(key) else {
            continue;
        };
        let value = raw.trim().trim_end_matches('/').to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// Starts the updater for one dashboard process.
pub fn start(app: Arc<App>) -> Updater {
    let interval_ms = positive_number(
        std::env::var("DEVBOARD_UPDATE_INTERVAL_MS").ok(),
        DEFAULT_UPDATE_INTERVAL_MS,
    );
    let max_backoff_ms = positive_number(
        std::env::var("DEVBOARD_UPDATE_BACKOFF_MAX_MS").ok(),
        DEFAULT_MAX_BACKOFF_MS,
    );
    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_for_task = Arc::clone(&stopped);
    let weak = Arc::downgrade(&app);
    let weak_for_task = weak.clone();
    let handle = tokio::spawn(async move {
        let mut failures: u32 = 0;
        loop {
            if stopped_for_task.load(Ordering::SeqCst) {
                return;
            }
            let Some(app) = weak_for_task.upgrade() else {
                return;
            };
            let outcome = check(&app).await;
            drop(app);
            match outcome {
                UpdateOutcome::Failed => {
                    failures = failures.saturating_add(1);
                }
                _ => failures = 0,
            }
            if stopped_for_task.load(Ordering::SeqCst) {
                return;
            }
            let delay = update_retry_delay(failures, interval_ms, max_backoff_ms);
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
    });
    Updater {
        app: weak,
        stopped,
        handle: Mutex::new(Some(handle)),
    }
}

/// Runs one check now, reading the release source this process's environment
/// names.
pub async fn check(app: &Arc<App>) -> UpdateOutcome {
    let Some(source) = manifest_source_from_env(&app.config().state_dir) else {
        return check_installed_host(app);
    };
    check_with_source(app, &source).await
}

/// Runs one check now against one release source.
pub async fn check_with_source(app: &Arc<App>, source: &ManifestSource) -> UpdateOutcome {
    let prefix = app.config().repo_dir.join(".devboard");
    let repo_dir = app.config().repo_dir.clone();
    // A launcher published-worktree dashboard runs a published release, not the
    // checkout's working tree: it installs the newest release artifact under
    // `.devboard/published` and replaces itself with it. `<repo>/.devboard/bin`
    // is never populated, so the checkout stays a source deployment.
    let published = app.published_release();
    // A source checkout never installs or replaces itself on an update check;
    // only a publish-written source-refresh request may replace it. An
    // installed host and a published-worktree dashboard may replace themselves.
    let source_checkout = crate::version::is_harness_source_checkout(&repo_dir);
    if !source_checkout {
        if let UpdateOutcome::Installed = check_installed_host(app) {
            return UpdateOutcome::Installed;
        }
    }
    let running = app.running_version.clone();
    let release = match release::latest_manifest_for(source, running.as_deref()).await {
        Ok(Some(release)) => release,
        Ok(None) => {
            // The newest release already names this process's version: there
            // is nothing newer to read, and no manifest was downloaded.
            if let Some(version) = running {
                app.note_latest_version(&version);
                if published.is_some() {
                    app.note_installed_version(&version);
                    app.note_published_release(&version);
                }
            }
            return UpdateOutcome::Current;
        }
        Err(error) => {
            // An offline, rate-limited, or overloaded forge is a transient
            // condition, not a failed update: `activity` names it,
            // `update-error` does not.
            if is_transient_update_failure(&error) {
                app.shared.journal.write(
                    "activity",
                    &format!("update check delayed: {error}"),
                    None,
                );
            } else {
                app.journal_error("update-error", &format!("update check failed: {error}"));
            }
            return UpdateOutcome::Failed;
        }
    };
    app.note_latest_version(&release.version);
    if published.is_some() {
        // `installed` and `latest` name the newest fully published release: the
        // launcher selects it on the next start even before this process has
        // installed or replaced itself with it.
        let not_older = running
            .as_deref()
            .is_none_or(|current| !release::is_newer_version(current, Some(&release.version)));
        if not_older {
            app.note_installed_version(&release.version);
            app.note_published_release(&release.version);
        }
    }
    if source_checkout && published.is_none() {
        return UpdateOutcome::Current;
    }
    if !release::is_newer_version(&release.version, app.running_version.as_deref()) {
        return UpdateOutcome::Current;
    }
    if published.is_some() {
        return match release::install_published_release(
            source,
            &release,
            &repo_dir,
            &app.config().state_dir,
        )
        .await
        {
            Ok(program) => {
                let version = release.version.clone();
                app.replace_with_installed_at(&version, Some(program));
                UpdateOutcome::Installed
            }
            Err(error) => {
                journal_install_failure(app, &error);
                UpdateOutcome::Failed
            }
        };
    }
    match release::install_release(source, &release, &prefix, &app.config().state_dir).await {
        Ok(version) => {
            let _ = app.sync_host_copies();
            app.replace_with_installed(&version);
            UpdateOutcome::Installed
        }
        Err(error) => {
            journal_install_failure(app, &error);
            UpdateOutcome::Failed
        }
    }
}

/// Journals one failed install.
///
/// A release the publisher has not finished writing — its manifest names an
/// artifact the release does not serve yet, or the forge could not answer — is
/// retried on the next interval and recorded as activity. Any other cause is
/// the update error the watchdog files an issue for.
fn journal_install_failure(app: &App, error: &str) {
    if is_transient_update_failure(error) {
        app.shared.journal.write(
            "activity",
            &format!("update install delayed: {error}"),
            None,
        );
    } else {
        app.journal_error("update-error", &format!("update install failed: {error}"));
    }
}

/// The installed-host half of one check: the host sync and a binary that
/// already sits beside this process.
fn check_installed_host(app: &Arc<App>) -> UpdateOutcome {
    if crate::version::is_installed_host(&app.config().repo_dir) {
        // Every check retries the host sync, so a failed write is journaled
        // once per attempt and repaired on the next check.
        if let Err(error) = app.sync_host_copies() {
            app.journal_error("update-error", &format!("host sync failed: {error}"));
        }
    }
    let prefix = app.config().repo_dir.join(".devboard");
    if let Some(installed) = release::installed_version(&prefix) {
        if release::is_newer_version(&installed, app.running_version.as_deref()) {
            app.replace_with_installed(&installed);
            return UpdateOutcome::Installed;
        }
    }
    UpdateOutcome::Current
}

/// True for a check failure the next interval resolves on its own: an
/// unreachable, rate-limited, or overloaded forge, a release body that arrived
/// empty, unreadable, unparsable, or cut off mid-transfer, or a release whose
/// manifest asset the publisher has not uploaded yet. The next interval retries
/// it and the journal records only activity.
pub fn is_transient_update_failure(error: &str) -> bool {
    let text = error.to_ascii_lowercase();
    if names_server_error_status(&text) {
        return true;
    }
    [
        "http 429",
        "http 403",
        "rate limit",
        "too many requests",
        "error sending request",
        "connection refused",
        "connection reset",
        "timed out",
        "timeout",
        "dns",
        "enotfound",
        "econnrefused",
        "network",
        "unreachable",
        "cannot reach",
        "empty body",
        "not json",
        "cannot read the body",
        // A body the connection cut off mid-transfer: `reqwest` reports it as a
        // decode failure on the artifact download, and the next interval reads
        // the same address whole. The live dashboard journaled this for a
        // platform archive that installed on the following check.
        "error decoding response body",
        release::RELEASE_STILL_BEING_WRITTEN,
    ]
    .iter()
    .any(|token| text.contains(token))
}

/// True when the error names an HTTP status the forge could not serve, 500
/// through 599.
///
/// Every release read formats a refusal as `... failed (HTTP <code>)`. A busy,
/// restarting, or overloaded Gitea answers 500 with an empty message and
/// answers the same request once it clears, so the next interval retries it
/// like the transport failures above and the journal records only activity. A
/// 4xx is the forge's verdict about the request and stays a real error.
fn names_server_error_status(text: &str) -> bool {
    let start = match text.find("(http ") {
        Some(index) => index + "(http ".len(),
        None => return false,
    };
    let digits: String = text[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits
        .parse::<u16>()
        .is_ok_and(|status| (500..600).contains(&status))
}

/// The installed version a restart would load, read from the running binary's
/// prefix manifest.
pub fn installed_version(prefix: &std::path::Path) -> Option<String> {
    release::installed_version(prefix)
}
