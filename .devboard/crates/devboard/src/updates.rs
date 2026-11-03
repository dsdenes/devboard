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
use crate::release::{self, ManifestSource, ReleaseInfo};

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
    latest: Arc<Mutex<Option<String>>>,
    stopped: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl Updater {
    /// The newest release a check has seen, or `None` before the first check.
    pub fn latest(&self) -> Option<String> {
        self.latest.lock().ok().and_then(|latest| latest.clone())
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

/// Resolves the manifest source from the environment, or `None` when no Gitea
/// instance is configured.
pub fn manifest_source_from_env(state_dir: &std::path::Path) -> Option<ManifestSource> {
    let base_url = std::env::var("DEVBOARD_GITEA_URL").ok()?.trim().to_string();
    if base_url.is_empty() {
        return None;
    }
    let _ = state_dir;
    let token = std::env::var("GITEA_TOKEN")
        .ok()
        .or_else(|| std::env::var("DEVBOARD_GITEA_TOKEN").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Some(ManifestSource {
        base_url: base_url.trim_end_matches('/').to_string(),
        repository: std::env::var("DEVBOARD_RELEASE_REPO")
            .unwrap_or_else(|_| release::RELEASE_REPOSITORY.to_string()),
        token,
        timeout_ms: 30_000,
    })
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
    let latest = Arc::new(Mutex::new(None));
    let stopped = Arc::new(AtomicBool::new(false));
    let latest_for_task = Arc::clone(&latest);
    let stopped_for_task = Arc::clone(&stopped);
    let handle = tokio::spawn(async move {
        let mut failures: u32 = 0;
        loop {
            if stopped_for_task.load(Ordering::SeqCst) {
                return;
            }
            let outcome = check_once(&app, &latest_for_task).await;
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
        latest,
        stopped,
        handle: Mutex::new(Some(handle)),
    }
}

/// Runs one check now.
async fn check_once(app: &Arc<App>, latest: &Arc<Mutex<Option<String>>>) -> UpdateOutcome {
    let prefix = app.config().repo_dir.join(".devboard");
    // A source checkout never installs or replaces itself on an update check;
    // only a publish-written source-refresh request may replace it.
    let source_checkout = crate::version::is_harness_source_checkout(&app.config().repo_dir);
    if !source_checkout {
        if let Some(installed) = release::installed_version(&prefix) {
            if release::is_newer_version(&installed, app.running_version.as_deref()) {
                app.replace_with_installed(&installed);
                return UpdateOutcome::Installed;
            }
        }
    }
    let Some(source) = manifest_source_from_env(&app.config().state_dir) else {
        return UpdateOutcome::Current;
    };
    let release = match release::latest_manifest(&source).await {
        Ok(release) => release,
        Err(error) => {
            app.journal_error("update-error", &format!("update check failed: {error}"));
            return UpdateOutcome::Failed;
        }
    };
    if let Ok(mut value) = latest.lock() {
        *value = Some(release.version.clone());
    }
    app.note_latest_version(&release.version);
    if source_checkout {
        return UpdateOutcome::Current;
    }
    if !release::is_newer_version(&release.version, app.running_version.as_deref()) {
        return UpdateOutcome::Current;
    }
    match release::install_release(&source, &release, &prefix, &app.config().state_dir).await {
        Ok(version) => {
            let _ = app.sync_host_copies();
            app.replace_with_installed(&version);
            UpdateOutcome::Installed
        }
        Err(error) => {
            app.journal_error("update-error", &format!("update install failed: {error}"));
            UpdateOutcome::Failed
        }
    }
}

/// The installed version a restart would load, read from the running binary's
/// prefix manifest.
pub fn installed_version(prefix: &std::path::Path) -> Option<String> {
    release::installed_version(prefix)
}

#[allow(dead_code)]
fn _release_info_is_shared(_info: &ReleaseInfo) {}
