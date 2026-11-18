//! Provider credentials, usage, selection, and the five provider commands.
//!
//! This is the Rust port of `.devboard/server/providers/`: the durable
//! credential store under `<stateDir>/providers/`, the usage cache, the
//! headroom selection, the per-peer binding, and the masked dashboard view.
//! OMP's own login state is never consulted for either provider.

use std::collections::HashMap;
use std::future::Future;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{json, Map, Value};

use crate::app::Conn;
use crate::command::Command;

/// An environment handed to one ACP peer.
pub type Env = HashMap<String, Option<String>>;
/// The logger a service writes one line at a time to.
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;
/// The clock a service reads, in Unix milliseconds.
pub type Now = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Replaces the per-connection state push with the dashboard's broadcast.
pub type Broadcast = Arc<dyn Fn(Value) + Send + Sync>;
/// The pause a worker's bounded credential retry waits between reads.
pub type RetrySleep = Arc<dyn Fn(u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

// ---------------------------------------------------------------------------
// Catalog

/// The two providers this dashboard knows.
pub const PROVIDER_IDS: [ProviderId; 2] = [ProviderId::OpenCodeGo, ProviderId::OpenRouter];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProviderId {
    OpenCodeGo,
    OpenRouter,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenCodeGo => "opencode-go",
            Self::OpenRouter => "openrouter",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "opencode-go" => Some(Self::OpenCodeGo),
            "openrouter" => Some(Self::OpenRouter),
            _ => None,
        }
    }
}

impl serde::Serialize for ProviderId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// One quota window that gates eligibility.
#[derive(Clone, Copy, Debug)]
pub struct WindowDefinition {
    pub key: &'static str,
    pub label: &'static str,
}

/// One provider's catalog entry.
#[derive(Debug)]
pub struct ProviderDefinition {
    pub id: ProviderId,
    pub name: &'static str,
    /// Environment variable that carries the selected key to a peer.
    pub env_var: &'static str,
    /// Model selector a peer runs when this provider serves it.
    pub model: &'static str,
    /// Base URL of the usage endpoint; overridable for tests.
    pub default_usage_base_url: &'static str,
    /// Environment variable that overrides `default_usage_base_url`.
    pub usage_base_url_env: &'static str,
    /// Path appended to the base URL by the usage fetch.
    pub usage_path: &'static str,
    /// Quota windows that gate eligibility, in display order.
    pub windows: &'static [WindowDefinition],
}

const GO_WINDOWS: &[WindowDefinition] = &[
    WindowDefinition {
        key: "rolling",
        label: "Rolling 5h",
    },
    WindowDefinition {
        key: "weekly",
        label: "Weekly",
    },
    WindowDefinition {
        key: "monthly",
        label: "Monthly",
    },
];

const OPENROUTER_WINDOWS: &[WindowDefinition] = &[WindowDefinition {
    key: "limit",
    label: "Account limit",
}];

const OPENCODE_GO: ProviderDefinition = ProviderDefinition {
    id: ProviderId::OpenCodeGo,
    name: "OpenCode Go",
    env_var: "OPENCODE_API_KEY",
    model: OPENCODE_GO_MODEL,
    default_usage_base_url: "https://opencode.ai/zen/go",
    usage_base_url_env: "DEVBOARD_OPENCODE_GO_USAGE_BASE_URL",
    usage_path: "/v1/usage",
    windows: GO_WINDOWS,
};

const OPENROUTER: ProviderDefinition = ProviderDefinition {
    id: ProviderId::OpenRouter,
    name: "OpenRouter",
    env_var: "OPENROUTER_API_KEY",
    model: OPENROUTER_FALLBACK_MODEL,
    default_usage_base_url: "https://openrouter.ai/api",
    usage_base_url_env: "DEVBOARD_OPENROUTER_USAGE_BASE_URL",
    usage_path: "/v1/key",
    windows: OPENROUTER_WINDOWS,
};

pub const OPENCODE_GO_MODEL: &str = "opencode-go/deepseek-v4.1-flash";
pub const OPENROUTER_FALLBACK_MODEL: &str = "openrouter/deepseek/deepseek-v4.1-flash-1017";

/// The model roles a generated per-peer config pins.
pub const MODEL_ROLES: [&str; 5] = ["default", "plan", "smol", "slow", "task"];

/// A subscription at or below this remaining fraction is skipped.
pub const ELIGIBILITY_THRESHOLD: f64 = 0.01;

/// The fixed rule the Providers dialog states.
pub const ROTATION_RULE: &str = "rotates at 1% remaining";

/// Usage is fetched at most once per this interval unless forced.
pub const USAGE_TTL_MS: u64 = 60_000;

/// One usage fetch may take at most this long.
pub const USAGE_TIMEOUT_MS: u64 = 5_000;

pub fn provider_definition(id: ProviderId) -> &'static ProviderDefinition {
    match id {
        ProviderId::OpenCodeGo => &OPENCODE_GO,
        ProviderId::OpenRouter => &OPENROUTER,
    }
}

pub fn is_provider_id(value: Option<&Value>) -> Option<ProviderId> {
    value.and_then(Value::as_str).and_then(ProviderId::parse)
}

pub fn provider_name(id: ProviderId) -> &'static str {
    provider_definition(id).name
}

// ---------------------------------------------------------------------------
// Credential store

pub const CREDENTIALS_VERSION: u32 = 1;

/// One stored subscription. The key never leaves this module except as a
/// selection's environment.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSubscription {
    pub id: String,
    pub provider: ProviderId,
    pub label: String,
    pub key: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(serde::Serialize)]
struct CredentialsEnvelope<'a> {
    version: u32,
    subscriptions: &'a [StoredSubscription],
}

/// Where a load found the subscription list it answered with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialSource {
    Primary,
    Backup,
    /// The running service's in-memory list restored files that were gone.
    Memory,
    None,
}

/// The subscriptions a load accepted, where it read them, plus a preserved
/// copy when some bytes could not be used.
#[derive(Debug, Clone)]
pub struct LoadedCredentials {
    pub subscriptions: Vec<StoredSubscription>,
    pub preserved: Option<PathBuf>,
    pub source: CredentialSource,
}

/// One event the credential store reports to its host: a quiet repair belongs
/// in the activity log, while a loss is the one alarm an operator receives.
#[derive(Debug, Clone)]
pub enum ProviderAudit {
    Activity(String),
    Loss { message: String, primary: PathBuf },
}

pub type AuditSink = Arc<dyn Fn(ProviderAudit) + Send + Sync>;

/// One credential-store loss, recorded key-free in the presence marker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialLoss {
    pub id: String,
    pub primary: String,
    pub alarmed: bool,
    pub at: String,
}

/// The marker version under `<stateDir>/state/`.
pub const CREDENTIALS_MARKER_VERSION: u32 = 1;

/// The refusal an unrecoverable loss reports. It names the primary path and
/// the operator's Providers dialog, and never reads as a fresh store.
pub fn lost_credentials_message(primary: &Path) -> String {
    format!(
        "Provider credentials were lost: {} is missing or unreadable. Restore the file or open \
         the Providers dialog (settings.providers) to add the keys again.",
        primary.display()
    )
}

pub fn providers_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("providers")
}

pub fn credentials_path(state_dir: &Path) -> PathBuf {
    providers_directory(state_dir).join("credentials.json")
}

/// The same-directory copy every save and every repair maintains.
pub fn credentials_backup_path(state_dir: &Path) -> PathBuf {
    providers_directory(state_dir).join("credentials.backup.json")
}

/// The key-free presence marker that tells a lost store from a fresh one.
pub fn credentials_marker_path(state_dir: &Path) -> PathBuf {
    state_dir.join("state").join("provider-credentials.json")
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

fn ensure_directory(directory: &Path) -> io::Result<()> {
    std::fs::create_dir_all(directory)?;
    // A pre-existing directory may have wider permissions; the store fixes it.
    set_mode(directory, 0o700)
}

fn stored_subscription(value: &Value) -> Option<StoredSubscription> {
    let record = value.as_object()?;
    let id = record.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    let provider = ProviderId::parse(record.get("provider")?.as_str()?)?;
    let label = record.get("label")?.as_str()?;
    let key = record.get("key")?.as_str()?;
    if key.is_empty() {
        return None;
    }
    let enabled = record.get("enabled")?.as_bool()?;
    let created_at = record.get("createdAt")?.as_str()?;
    let updated_at = record.get("updatedAt")?.as_str()?;
    Some(StoredSubscription {
        id: id.to_string(),
        provider,
        label: label.to_string(),
        key: key.to_string(),
        enabled,
        created_at: created_at.to_string(),
        updated_at: updated_at.to_string(),
    })
}

fn preserve(path: &Path) -> Option<PathBuf> {
    let aside = PathBuf::from(format!("{}.damaged-{}", path.display(), now_millis()));
    match std::fs::rename(path, &aside) {
        Ok(()) => Some(aside),
        Err(_) => None,
    }
}

/// Copies a file aside before its unusable entries are rewritten away, so the
/// rejected bytes stay recoverable.
fn preserve_copy(path: &Path) -> Option<PathBuf> {
    let aside = PathBuf::from(format!(
        "{}.damaged-{}-{}",
        path.display(),
        now_millis(),
        hex_bytes::<4>()
    ));
    match std::fs::copy(path, &aside) {
        Ok(_) => match set_mode(&aside, 0o600) {
            Ok(()) => Some(aside),
            Err(_) => {
                let _ = std::fs::remove_file(&aside);
                preserve(path)
            }
        },
        Err(_) => {
            let _ = std::fs::remove_file(&aside);
            preserve(path)
        }
    }
}

fn subscriptions_text(subscriptions: &[StoredSubscription]) -> io::Result<String> {
    let envelope = CredentialsEnvelope {
        version: CREDENTIALS_VERSION,
        subscriptions,
    };
    let mut text = serde_json::to_string_pretty(&envelope).map_err(io::Error::other)?;
    text.push('\n');
    Ok(text)
}

/// Stages private bytes beside `path`; the caller renames it into place.
fn stage_bytes(directory: &Path, bytes: &[u8], label: &str) -> io::Result<PathBuf> {
    let temporary = directory.join(format!(
        ".{label}.{}.{}.tmp",
        std::process::id(),
        hex_bytes::<6>()
    ));
    let result = (|| -> io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        drop(file);
        set_mode(&temporary, 0o600)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return result.map(|()| temporary);
    }
    Ok(temporary)
}

fn replace_staged(temporary: &Path, path: &Path) -> io::Result<()> {
    std::fs::rename(temporary, path)?;
    set_mode(path, 0o600)
}

fn restore_bytes(directory: &Path, path: &Path, previous: Option<&[u8]>) -> io::Result<()> {
    match previous {
        Some(bytes) => {
            let temporary = stage_bytes(directory, bytes, "credentials-restore")?;
            replace_staged(&temporary, path)
        }
        None => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    }
}

fn write_credentials_file(
    state_dir: &Path,
    path: &Path,
    subscriptions: &[StoredSubscription],
) -> io::Result<()> {
    let directory = providers_directory(state_dir);
    ensure_directory(&directory)?;
    let text = subscriptions_text(subscriptions)?;
    let temporary = stage_bytes(&directory, text.as_bytes(), "credentials")?;
    let result = replace_staged(&temporary, path);
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Writes the primary and its backup from one text, and adopts neither when
/// either rename fails. The backup lands first, so a failed primary rename is
/// rolled back instead of leaving the pair split.
fn write_credentials_pair(
    state_dir: &Path,
    subscriptions: &[StoredSubscription],
) -> io::Result<()> {
    let directory = providers_directory(state_dir);
    ensure_directory(&directory)?;
    let primary = credentials_path(state_dir);
    let backup = credentials_backup_path(state_dir);
    let text = subscriptions_text(subscriptions)?;
    let primary_before = std::fs::read(&primary).ok();
    let backup_before = std::fs::read(&backup).ok();
    let primary_temporary = stage_bytes(&directory, text.as_bytes(), "credentials")?;
    let backup_temporary = match stage_bytes(&directory, text.as_bytes(), "credentials-backup") {
        Ok(temporary) => temporary,
        Err(error) => {
            let _ = std::fs::remove_file(&primary_temporary);
            return Err(error);
        }
    };
    if let Err(error) = std::fs::rename(&backup_temporary, &backup) {
        let _ = std::fs::remove_file(&primary_temporary);
        let _ = std::fs::remove_file(&backup_temporary);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&primary_temporary, &primary) {
        let _ = std::fs::remove_file(&primary_temporary);
        let _ = restore_bytes(&directory, &backup, backup_before.as_deref());
        return Err(error);
    }
    if let Err(error) = set_mode(&primary, 0o600).and_then(|()| set_mode(&backup, 0o600)) {
        let _ = restore_bytes(&directory, &primary, primary_before.as_deref());
        let _ = restore_bytes(&directory, &backup, backup_before.as_deref());
        return Err(error);
    }
    Ok(())
}

enum CredentialFile {
    Missing,
    Valid {
        subscriptions: Vec<StoredSubscription>,
        rejected: bool,
        preserved: Option<PathBuf>,
    },
    Unusable {
        preserved: Option<PathBuf>,
    },
}

/// Reads one credential file. A missing file is distinct from an unusable one:
/// unusable bytes are preserved aside so a later save never overwrites them
/// unnoticed.
fn read_credentials_file(path: &Path) -> CredentialFile {
    let source = match std::fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return CredentialFile::Missing,
        Err(_) => {
            return CredentialFile::Unusable {
                preserved: preserve(path),
            }
        }
    };

    let parsed: Value = match serde_json::from_str(&source) {
        Ok(parsed) => parsed,
        Err(_) => {
            return CredentialFile::Unusable {
                preserved: preserve(path),
            }
        }
    };
    let Some(envelope) = parsed.as_object() else {
        return CredentialFile::Unusable {
            preserved: preserve(path),
        };
    };
    if envelope.get("version").and_then(Value::as_u64) != Some(CREDENTIALS_VERSION as u64) {
        return CredentialFile::Unusable {
            preserved: preserve(path),
        };
    }
    let Some(entries) = envelope.get("subscriptions").and_then(Value::as_array) else {
        return CredentialFile::Unusable {
            preserved: preserve(path),
        };
    };

    let mut subscriptions = Vec::new();
    let mut rejected = false;
    for entry in entries {
        match stored_subscription(entry) {
            Some(stored) => subscriptions.push(stored),
            None => rejected = true,
        }
    }
    let preserved = if rejected { preserve_copy(path) } else { None };
    CredentialFile::Valid {
        subscriptions,
        rejected,
        preserved,
    }
}

/// The list an intact copy holds: it parsed completely, preserved every
/// entry, and names at least one subscription. Only such a copy outranks a
/// primary that lost entries to validation.
fn intact_subscriptions(file: &CredentialFile) -> Option<&[StoredSubscription]> {
    match file {
        CredentialFile::Valid {
            subscriptions,
            rejected: false,
            ..
        } if !subscriptions.is_empty() => Some(subscriptions),
        _ => None,
    }
}

/// Reads the subscription list, preferring the primary and falling back to
/// the same-directory backup. A missing file is an empty list; unusable bytes
/// are preserved aside. A primary that lost entries to validation is damaged,
/// so an intact backup is the copy to trust and repairs it.
pub fn load_subscriptions(state_dir: &Path) -> LoadedCredentials {
    let primary_path = credentials_path(state_dir);
    let backup_path = credentials_backup_path(state_dir);
    let primary = read_credentials_file(&primary_path);
    let backup = read_credentials_file(&backup_path);
    if let CredentialFile::Valid {
        rejected: true,
        preserved,
        ..
    } = &primary
    {
        if let Some(restored) = intact_subscriptions(&backup) {
            let subscriptions = restored.to_vec();
            let _ = write_credentials_file(state_dir, &primary_path, &subscriptions);
            return LoadedCredentials {
                subscriptions,
                preserved: preserved.clone(),
                source: CredentialSource::Primary,
            };
        }
    }
    match primary {
        CredentialFile::Valid {
            subscriptions,
            rejected,
            preserved,
        } => {
            if rejected {
                let _ = write_credentials_file(state_dir, &primary_path, &subscriptions);
            }
            LoadedCredentials {
                subscriptions,
                preserved,
                source: CredentialSource::Primary,
            }
        }
        primary => {
            let primary_preserved = match primary {
                CredentialFile::Unusable { preserved } => preserved,
                _ => None,
            };
            match backup {
                CredentialFile::Valid {
                    subscriptions,
                    rejected,
                    preserved,
                } => {
                    if rejected {
                        let _ = write_credentials_file(state_dir, &backup_path, &subscriptions);
                    }
                    LoadedCredentials {
                        subscriptions,
                        preserved: primary_preserved.or(preserved),
                        source: CredentialSource::Backup,
                    }
                }
                backup => {
                    let backup_preserved = match backup {
                        CredentialFile::Unusable { preserved } => preserved,
                        _ => None,
                    };
                    LoadedCredentials {
                        subscriptions: Vec::new(),
                        preserved: primary_preserved.or(backup_preserved),
                        source: CredentialSource::None,
                    }
                }
            }
        }
    }
}

/// Replaces both credential files atomically and records the store's presence.
pub fn save_subscriptions(
    state_dir: &Path,
    subscriptions: &[StoredSubscription],
) -> io::Result<()> {
    write_credentials_pair(state_dir, subscriptions)?;
    let _ = write_marker(state_dir, None);
    Ok(())
}

#[derive(Clone, Debug)]
enum MarkerState {
    Absent,
    Healthy,
    Loss(CredentialLoss),
}

/// Reads the presence marker. A marker that exists but cannot be read still
/// proves the store existed, so it is treated as healthy presence rather than
/// as a fresh directory.
fn marker_state(state_dir: &Path) -> MarkerState {
    let path = credentials_marker_path(state_dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return MarkerState::Absent;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return MarkerState::Healthy;
    };
    if value.get("version").and_then(Value::as_u64) != Some(CREDENTIALS_MARKER_VERSION as u64) {
        return MarkerState::Healthy;
    }
    let Some(loss) = value.get("loss").filter(|loss| !loss.is_null()) else {
        return MarkerState::Healthy;
    };
    let Some(loss) = loss.as_object() else {
        return MarkerState::Healthy;
    };
    let Some(id) = loss.get("id").and_then(Value::as_str) else {
        return MarkerState::Healthy;
    };
    let Some(primary) = loss.get("primary").and_then(Value::as_str) else {
        return MarkerState::Healthy;
    };
    let Some(alarmed) = loss.get("alarmed").and_then(Value::as_bool) else {
        return MarkerState::Healthy;
    };
    let at = loss.get("at").and_then(Value::as_str).unwrap_or("");
    MarkerState::Loss(CredentialLoss {
        id: id.to_string(),
        primary: primary.to_string(),
        alarmed,
        at: at.to_string(),
    })
}

/// Writes the presence marker. It carries the loss identity, its primary path,
/// and whether the alarm was already emitted; it never carries key material.
fn write_marker(state_dir: &Path, loss: Option<&CredentialLoss>) -> io::Result<()> {
    let path = credentials_marker_path(state_dir);
    let value = match loss {
        Some(loss) => json!({
            "version": CREDENTIALS_MARKER_VERSION,
            "loss": {
                "id": loss.id,
                "primary": loss.primary,
                "alarmed": loss.alarmed,
                "at": loss.at,
            },
        }),
        None => json!({"version": CREDENTIALS_MARKER_VERSION, "loss": Value::Null}),
    };
    let mut text = serde_json::to_string_pretty(&value).map_err(io::Error::other)?;
    text.push('\n');
    let directory = path.parent().unwrap_or(state_dir);
    std::fs::create_dir_all(directory)?;
    let temporary = stage_bytes(directory, text.as_bytes(), "provider-credentials")?;
    let result = replace_staged(&temporary, &path);
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Whether the presence marker records an unrecoverable loss.
pub fn credentials_lost(state_dir: &Path) -> bool {
    matches!(marker_state(state_dir), MarkerState::Loss(_))
}

/// A display mask that reveals at most the last four characters.
pub fn mask_key(key: &str) -> String {
    let units: Vec<u16> = key.encode_utf16().collect();
    if units.is_empty() {
        return String::new();
    }
    if units.len() <= 8 {
        return "••••".to_string();
    }
    let tail = &units[units.len() - 4..];
    format!("••••{}", String::from_utf16_lossy(tail))
}

// ---------------------------------------------------------------------------
// Usage

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageStatus {
    Ok,
    NearLimit,
    Exhausted,
    Invalid,
    Unknown,
}

impl UsageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NearLimit => "near-limit",
            Self::Exhausted => "exhausted",
            Self::Invalid => "invalid",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug)]
pub struct UsageWindowState {
    pub key: String,
    pub label: String,
    /// Percent of the window used, when the provider reports one.
    pub percent_used: Option<f64>,
    /// Fraction of the window left, 0 through 1.
    pub remaining_fraction: f64,
    pub resets_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct UsageReport {
    pub status: UsageStatus,
    pub checked_at: String,
    pub windows: Vec<UsageWindowState>,
    /// The smallest remaining fraction, or null when the headroom is unknown.
    pub remaining_fraction: Option<f64>,
    pub error: Option<String>,
    checked_at_ms: i64,
}

impl UsageReport {
    pub fn checked_at_ms(&self) -> i64 {
        self.checked_at_ms
    }
}

/// One usage request, so a test transport sees exactly the URL and key.
#[derive(Clone, Debug)]
pub struct UsageRequest {
    pub url: String,
    pub key: String,
}

#[derive(Clone, Debug)]
pub struct UsageResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportError {
    Timeout,
    Unreachable,
}

pub type TransportFuture =
    Pin<Box<dyn Future<Output = Result<UsageResponse, TransportError>> + Send>>;
/// The injected-transport seam: no provider call is made directly.
pub type Transport = Arc<dyn Fn(UsageRequest) -> TransportFuture + Send + Sync>;

/// The real transport, bounded by the configured timeout.
pub fn default_transport(timeout_ms: u64) -> Transport {
    let timeout = std::time::Duration::from_millis(timeout_ms.max(1));
    Arc::new(move |request: UsageRequest| -> TransportFuture {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .map_err(|_| TransportError::Unreachable)?;
            let response = client
                .get(&request.url)
                .header("accept", "application/json")
                .header("authorization", format!("Bearer {}", request.key))
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        TransportError::Timeout
                    } else {
                        TransportError::Unreachable
                    }
                })?;
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            Ok(UsageResponse { status, body })
        })
    })
}

fn finite_percent(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    if value.is_finite() && (0.0..=100.0).contains(&value) {
        Some(value)
    } else {
        None
    }
}

fn report_status(windows: &[UsageWindowState]) -> UsageStatus {
    if windows
        .iter()
        .any(|window| window.remaining_fraction <= 0.0)
    {
        return UsageStatus::Exhausted;
    }
    let lowest = windows
        .iter()
        .map(|window| window.remaining_fraction)
        .fold(f64::INFINITY, f64::min);
    if lowest <= ELIGIBILITY_THRESHOLD * 10.0 {
        UsageStatus::NearLimit
    } else {
        UsageStatus::Ok
    }
}

const WINDOW_LABELS: &[(&str, &str)] = &[
    ("rolling", "Rolling 5h"),
    ("weekly", "Weekly"),
    ("monthly", "Monthly"),
    ("limit", "Account limit"),
];

fn window_label(key: &str) -> String {
    WINDOW_LABELS
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, label)| (*label).to_string())
        .unwrap_or_else(|| key.to_string())
}

fn parse_open_code_go(payload: &Value) -> Option<Vec<UsageWindowState>> {
    let usage = payload.as_object()?.get("usage")?.as_object()?;
    let mut windows = Vec::new();
    for definition in GO_WINDOWS {
        let window = usage.get(definition.key)?.as_object()?;
        let percent = finite_percent(window.get("percent"))?;
        let resets_at = window
            .get("resetsAt")
            .and_then(Value::as_str)
            .map(str::to_string);
        windows.push(UsageWindowState {
            key: definition.key.to_string(),
            label: window_label(definition.key),
            percent_used: Some(percent),
            remaining_fraction: (1.0 - percent / 100.0).max(0.0),
            resets_at,
        });
    }
    Some(windows)
}

fn parse_open_router(payload: &Value) -> Option<Vec<UsageWindowState>> {
    let outer = payload.as_object()?;
    let data = outer
        .get("data")
        .and_then(Value::as_object)
        .unwrap_or(outer);
    let remaining = data.get("limit_remaining")?.as_f64()?;
    if !remaining.is_finite() || remaining < 0.0 {
        return None;
    }
    let key = "limit".to_string();
    let label = window_label("limit");
    match data.get("limit") {
        None | Some(Value::Null) => Some(vec![UsageWindowState {
            key,
            label,
            percent_used: None,
            remaining_fraction: 1.0,
            resets_at: None,
        }]),
        Some(limit) => {
            let limit = limit.as_f64()?;
            if !limit.is_finite() || limit <= 0.0 {
                return None;
            }
            let fraction = (remaining / limit).clamp(0.0, 1.0);
            Some(vec![UsageWindowState {
                key,
                label,
                percent_used: Some((1.0 - fraction) * 100.0),
                remaining_fraction: fraction,
                resets_at: None,
            }])
        }
    }
}

fn unknown_report(checked_at: String, now_ms: i64, error: &str) -> UsageReport {
    UsageReport {
        status: UsageStatus::Unknown,
        checked_at,
        windows: Vec::new(),
        remaining_fraction: None,
        error: Some(error.to_string()),
        checked_at_ms: now_ms,
    }
}

/// Fetches one subscription's usage through the injected transport.
pub async fn fetch_usage(
    provider: ProviderId,
    key: &str,
    base_url: &str,
    transport: &Transport,
    now_ms: i64,
) -> UsageReport {
    let definition = provider_definition(provider);
    let checked_at = iso_timestamp(now_ms);
    let url = format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        definition.usage_path
    );
    let response = match transport(UsageRequest {
        url,
        key: key.to_string(),
    })
    .await
    {
        Ok(response) => response,
        Err(TransportError::Timeout) => {
            return unknown_report(checked_at, now_ms, "The usage check timed out.")
        }
        Err(TransportError::Unreachable) => {
            return unknown_report(
                checked_at,
                now_ms,
                "The usage check could not reach the provider.",
            )
        }
    };

    if response.status == 401 || response.status == 403 {
        return UsageReport {
            status: UsageStatus::Invalid,
            checked_at,
            windows: Vec::new(),
            remaining_fraction: None,
            error: Some(format!(
                "The provider rejected this key (HTTP {}).",
                response.status
            )),
            checked_at_ms: now_ms,
        };
    }
    if !(200..300).contains(&response.status) {
        return unknown_report(
            checked_at,
            now_ms,
            &format!("The usage check failed (HTTP {}).", response.status),
        );
    }

    let payload: Value = match serde_json::from_str(&response.body) {
        Ok(payload) => payload,
        Err(_) => return unknown_report(checked_at, now_ms, "The usage response was not JSON."),
    };
    let windows = match provider {
        ProviderId::OpenCodeGo => parse_open_code_go(&payload),
        ProviderId::OpenRouter => parse_open_router(&payload),
    };
    let Some(windows) = windows.filter(|windows| !windows.is_empty()) else {
        return unknown_report(
            checked_at,
            now_ms,
            "The usage response did not report every quota window.",
        );
    };

    let remaining = windows
        .iter()
        .map(|window| window.remaining_fraction)
        .fold(f64::INFINITY, f64::min);
    UsageReport {
        status: report_status(&windows),
        checked_at,
        windows,
        remaining_fraction: Some(remaining),
        error: None,
        checked_at_ms: now_ms,
    }
}

// ---------------------------------------------------------------------------
// Selection

#[derive(Clone, Debug)]
pub struct RankedSubscription {
    pub subscription: StoredSubscription,
    pub usage: Option<UsageReport>,
    /// The lowest remaining fraction, or null when the headroom is unknown.
    pub headroom: Option<f64>,
    pub eligible: bool,
    /// Position in the operator's list; the last tie-breaker.
    pub index: usize,
    /// Whether the dashboard's published selection names this subscription.
    /// A fresh worker has no cached usage, so every headroom is unknown; the
    /// published decision is the only evidence that distinguishes the keys.
    pub preferred: bool,
}

// Selected carries the full subscription and usage records the caller
// serializes; boxing them would add an allocation to every decision.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug)]
pub enum ProviderDecision {
    Selected {
        subscription: StoredSubscription,
        usage: Option<UsageReport>,
        /// The best enabled OpenRouter key, attached for a Go fallback chain.
        fallback: Option<StoredSubscription>,
        fallback_usage: Option<UsageReport>,
    },
    Refused {
        reason: String,
    },
}

fn is_eligible(usage: Option<&UsageReport>) -> bool {
    let Some(usage) = usage else { return true };
    if usage.status == UsageStatus::Invalid {
        return false;
    }
    if usage.status == UsageStatus::Unknown || usage.remaining_fraction.is_none() {
        return true;
    }
    // 1 - 99/100 is 0.010000000000000009, so compare with a small tolerance:
    // exactly 1% remaining is not above the threshold.
    usage.remaining_fraction.unwrap_or(0.0) > ELIGIBILITY_THRESHOLD + 1e-9
}

/// Ranks every subscription; disabled ones are reported but never eligible.
pub fn rank_subscriptions(
    subscriptions: &[StoredSubscription],
    usage: &HashMap<String, UsageReport>,
) -> Vec<RankedSubscription> {
    subscriptions
        .iter()
        .enumerate()
        .map(|(index, subscription)| {
            let report = usage.get(&subscription.id);
            RankedSubscription {
                subscription: subscription.clone(),
                usage: report.cloned(),
                headroom: report.and_then(|report| report.remaining_fraction),
                eligible: subscription.enabled && is_eligible(report),
                index,
                preferred: false,
            }
        })
        .collect()
}

fn compare_ranked(left: &RankedSubscription, right: &RankedSubscription) -> std::cmp::Ordering {
    match (left.headroom, right.headroom) {
        (None, None) => tie_break(left, right),
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(left_value), Some(right_value)) => {
            if right_value != left_value {
                return right_value
                    .partial_cmp(&left_value)
                    .unwrap_or(std::cmp::Ordering::Equal);
            }
            tie_break(left, right)
        }
    }
}

/// The published selection wins a tie, then the operator's list order. A
/// worker that has just loaded its credentials knows no headroom, so without
/// this every Go key ties and the first stored key is always chosen.
fn tie_break(left: &RankedSubscription, right: &RankedSubscription) -> std::cmp::Ordering {
    right
        .preferred
        .cmp(&left.preferred)
        .then_with(|| left.index.cmp(&right.index))
}

fn best(candidates: &[RankedSubscription]) -> Option<RankedSubscription> {
    let mut eligible: Vec<&RankedSubscription> = candidates
        .iter()
        .filter(|candidate| candidate.eligible)
        .collect();
    eligible.sort_by(|left, right| compare_ranked(left, right));
    eligible.first().map(|candidate| (*candidate).clone())
}

/// Best enabled subscription of one provider, eligible or not.
fn best_enabled(candidates: &[RankedSubscription]) -> Option<RankedSubscription> {
    let mut enabled: Vec<&RankedSubscription> = candidates
        .iter()
        .filter(|candidate| candidate.subscription.enabled)
        .collect();
    enabled.sort_by(|left, right| compare_ranked(left, right));
    enabled.first().map(|candidate| (*candidate).clone())
}

fn provider_reason(name: &str, candidates: &[RankedSubscription]) -> String {
    if candidates.is_empty() {
        return format!("{name} has no subscription");
    }
    let enabled: Vec<&RankedSubscription> = candidates
        .iter()
        .filter(|candidate| candidate.subscription.enabled)
        .collect();
    if enabled.is_empty() {
        return format!("{name} has no enabled subscription");
    }
    if enabled.iter().all(|candidate| {
        candidate.usage.as_ref().map(|usage| usage.status) == Some(UsageStatus::Invalid)
    }) {
        return format!("{name} rejected every key");
    }
    format!("{name} has no subscription above 1% remaining")
}

/// Chooses the provider for one peer.
pub fn decide_provider(ranked: &[RankedSubscription], configured: bool) -> ProviderDecision {
    if !configured {
        return ProviderDecision::Refused {
            reason: NO_PROVIDER_CONFIGURED.to_string(),
        };
    }

    let open_router_candidates: Vec<RankedSubscription> = ranked
        .iter()
        .filter(|candidate| candidate.subscription.provider == ProviderId::OpenRouter)
        .cloned()
        .collect();

    // A process that has not read usage (a detached worker resolving its own
    // environment) knows no headroom at all, so the published selection is the
    // only evidence. Follow it across providers as well as within one, or an
    // exhausted Go key would win the list order over the OpenRouter key the
    // dashboard had already rotated to.
    if !ranked.iter().any(|candidate| candidate.headroom.is_some()) {
        if let Some(preferred) = ranked
            .iter()
            .find(|candidate| candidate.preferred && candidate.eligible)
        {
            let fallback = if preferred.subscription.provider == ProviderId::OpenCodeGo {
                best_enabled(&open_router_candidates)
            } else {
                None
            };
            return ProviderDecision::Selected {
                subscription: preferred.subscription.clone(),
                usage: preferred.usage.clone(),
                fallback: fallback
                    .as_ref()
                    .map(|candidate| candidate.subscription.clone()),
                fallback_usage: fallback.and_then(|candidate| candidate.usage),
            };
        }
    }

    let go_candidates: Vec<RankedSubscription> = ranked
        .iter()
        .filter(|candidate| candidate.subscription.provider == ProviderId::OpenCodeGo)
        .cloned()
        .collect();
    let open_router = best(&open_router_candidates);
    let go = best(&go_candidates);

    if let Some(go) = go {
        let fallback = best_enabled(&open_router_candidates);
        return ProviderDecision::Selected {
            subscription: go.subscription,
            usage: go.usage,
            fallback: fallback
                .as_ref()
                .map(|candidate| candidate.subscription.clone()),
            fallback_usage: fallback.and_then(|candidate| candidate.usage),
        };
    }
    if let Some(open_router) = open_router {
        return ProviderDecision::Selected {
            subscription: open_router.subscription,
            usage: open_router.usage,
            fallback: None,
            fallback_usage: None,
        };
    }

    ProviderDecision::Refused {
        reason: format!(
            "No provider subscription is eligible: {}; {}. Open the Providers dialog (settings.providers) to add or refresh a key.",
            provider_reason("OpenCode Go", &go_candidates),
            provider_reason("OpenRouter", &open_router_candidates)
        ),
    }
}

/// The path-safe, stable form of one subscription id: every character outside
/// `[A-Za-z0-9._-]` becomes `_`, at most 96 UTF-16 units survive, and the
/// result names the selection directory after the provider prefix.
pub fn subscription_key(subscription_id: &str) -> String {
    let units: Vec<u16> = subscription_id
        .encode_utf16()
        .map(|unit| {
            let character = char::from_u32(u32::from(unit)).unwrap_or('_');
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                unit
            } else {
                b'_' as u16
            }
        })
        .take(96)
        .collect();
    String::from_utf16_lossy(&units)
}

/// A path-safe, stable directory name for one selection.
pub fn selection_id(provider: ProviderId, subscription_id: &str) -> String {
    format!(
        "{}-{}",
        provider.as_str(),
        subscription_key(subscription_id)
    )
}

pub fn agent_directory(state_dir: &Path, provider: ProviderId, subscription_id: &str) -> PathBuf {
    state_dir
        .join("providers")
        .join("agents")
        .join(selection_id(provider, subscription_id))
}

/// Implicit local model servers no peer can run.
pub const DISABLED_PEER_PROVIDERS: [&str; 4] = ["ollama", "lm-studio", "llama.cpp", "apple"];

/// The generated config pins every model role and, for a Go selection, walks
/// to the OpenRouter fallback model on any provider error.
pub fn generated_config(provider: ProviderId, model: &str) -> String {
    let mut lines: Vec<String> =
        vec!["# Generated by devboard for one ACP peer. Do not edit.".to_string()];
    lines.push("modelRoles:".to_string());
    for role in MODEL_ROLES {
        lines.push(format!("  {role}: {model}"));
    }
    lines.push("disabledProviders:".to_string());
    for disabled in DISABLED_PEER_PROVIDERS {
        lines.push(format!("  - {disabled}"));
    }
    if provider == ProviderId::OpenCodeGo {
        lines.push("retry:".to_string());
        lines.push("  modelFallback: true".to_string());
        lines.push("  fallbackOn: any".to_string());
        lines.push("  fallbackChains:".to_string());
        lines.push("    \"opencode-go/*\":".to_string());
        lines.push(format!("      - {OPENROUTER_FALLBACK_MODEL}"));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// The MCP server name every peer's generated agent directory registers.
pub const DEVBOARD_MCP_SERVER: &str = "devboard";

/// The harness executable that answers this protocol's `mcp` subcommand,
/// resolved through the same rule as every other harness child.
fn harness_executable(repo_dir: &Path) -> Result<PathBuf, String> {
    crate::relaunch::harness_program(repo_dir)
}

/// The generated peer's MCP registration: this harness's own stdio server.
///
/// The executable is absolute, so a peer whose cwd is a worktree, a temporary
/// clone, or a host directory starts the same server with no project `.omp`
/// directory and no bun module to resolve.
fn devboard_mcp_entry(program: &Path) -> Value {
    json!({
        "type": "stdio",
        "command": program.display().to_string(),
        "args": ["mcp"],
    })
}

/// One peer role's MCP registration.
#[derive(Clone, Debug)]
pub struct AgentMcp {
    /// The `mcpServers` map written to `mcp.json`.
    pub servers: Value,
}

/// The peer registration resolved against a known repository root.
pub fn default_agent_mcp_for(repo_dir: &Path) -> Result<AgentMcp, String> {
    let program = harness_executable(repo_dir)?;
    Ok(AgentMcp {
        servers: json!({ DEVBOARD_MCP_SERVER: devboard_mcp_entry(&program) }),
    })
}

/// The peer registration for callers that carry no repository root. The
/// environment or the working directory names it; a refusal is not
/// representable here, so the running image is the last resort.
pub fn default_agent_mcp() -> AgentMcp {
    let repo_dir = std::env::var_os("REPO_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    let program = crate::relaunch::harness_program(&repo_dir).unwrap_or_else(|_| {
        let current = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("devboard"));
        crate::relaunch::live_path(&current)
    });
    AgentMcp {
        servers: json!({ DEVBOARD_MCP_SERVER: devboard_mcp_entry(&program) }),
    }
}

pub fn generated_mcp_config(mcp: &AgentMcp) -> String {
    let value = json!({ "mcpServers": mcp.servers.clone() });
    let mut text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text
}

fn write_file_atomic(path: &Path, content: &str) -> io::Result<()> {
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        hex_bytes::<6>()
    ));
    let result = (|| -> io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(content.as_bytes())?;
        drop(file);
        set_mode(&temporary, 0o600)?;
        std::fs::rename(&temporary, path)?;
        set_mode(path, 0o600)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Writes the generated config and MCP registration; the directory is 0700.
///
/// A directory written by an older harness may still carry the retired
/// `devboard-mcp.ts` wrapper the registration used to start; it is removed so
/// no stale module shadows the executable entry.
pub fn write_agent_directory(directory: &Path, config: &str, mcp: &AgentMcp) -> io::Result<()> {
    std::fs::create_dir_all(directory)?;
    set_mode(directory, 0o700)?;
    write_file_atomic(&directory.join("config.yml"), config)?;
    write_file_atomic(&directory.join("mcp.json"), &generated_mcp_config(mcp))?;
    match std::fs::remove_file(directory.join("devboard-mcp.ts")) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct PeerBinding {
    pub provider: ProviderId,
    pub provider_name: &'static str,
    pub subscription_id: String,
    pub subscription_label: String,
    pub model: String,
    /// The selected key's lowest remaining fraction, or null when unknown.
    pub remaining_fraction: Option<f64>,
    pub agent_dir: PathBuf,
    pub env: Env,
}

/// Builds the peer environment. Both provider variables are removed before the
/// selected values are applied, so the operator's shell cannot leak in.
pub fn peer_environment(
    base: &Env,
    binding: &PeerBinding,
    selected_key: &str,
    fallback_key: Option<&str>,
) -> Env {
    let mut env = base.clone();
    env.remove("OPENCODE_API_KEY");
    env.remove("OPENROUTER_API_KEY");
    env.remove("PI_CODING_AGENT_DIR");
    if binding.provider == ProviderId::OpenCodeGo {
        env.insert(
            "OPENCODE_API_KEY".to_string(),
            Some(selected_key.to_string()),
        );
        if let Some(fallback_key) = fallback_key {
            env.insert(
                "OPENROUTER_API_KEY".to_string(),
                Some(fallback_key.to_string()),
            );
        }
    } else {
        env.insert(
            "OPENROUTER_API_KEY".to_string(),
            Some(selected_key.to_string()),
        );
    }
    env.insert(
        "PI_CODING_AGENT_DIR".to_string(),
        Some(binding.agent_dir.to_string_lossy().into_owned()),
    );
    env
}

// ---------------------------------------------------------------------------
// Selection snapshot

#[derive(Clone, Debug)]
pub struct SelectionSnapshot {
    pub version: u32,
    pub provider: ProviderId,
    pub subscription_id: String,
    pub label: String,
    pub model: String,
    pub remaining_fraction: Option<f64>,
    pub checked_at: String,
}

pub fn selection_snapshot_path(state_dir: &Path) -> PathBuf {
    providers_directory(state_dir).join("selection.json")
}

/// Writes the selection atomically; the file carries no key material.
pub fn write_selection_snapshot(
    state_dir: &Path,
    provider: ProviderId,
    subscription_id: &str,
    label: &str,
    model: &str,
    remaining_fraction: Option<f64>,
    checked_at: &str,
) -> io::Result<()> {
    let directory = providers_directory(state_dir);
    std::fs::create_dir_all(&directory)?;
    set_mode(&directory, 0o700)?;
    let target = selection_snapshot_path(state_dir);
    let value = json!({
        "version": 1,
        "provider": provider,
        "subscriptionId": subscription_id,
        "label": label,
        "model": model,
        "remainingFraction": remaining_fraction,
        "checkedAt": checked_at,
    });
    let mut text = crate::jsjson::stringify(&value);
    text.push('\n');
    let temporary = stage_bytes(&directory, text.as_bytes(), "provider-selection")?;
    let result = replace_staged(&temporary, &target);
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub fn read_selection_snapshot(state_dir: &Path) -> Option<SelectionSnapshot> {
    let text = std::fs::read_to_string(selection_snapshot_path(state_dir)).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let record = parsed.as_object()?;
    if record.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let provider = ProviderId::parse(record.get("provider")?.as_str()?)?;
    let subscription_id = record.get("subscriptionId")?.as_str()?;
    if subscription_id.is_empty() {
        return None;
    }
    let label = record.get("label")?.as_str()?;
    let model = record.get("model")?.as_str()?;
    let remaining_fraction = match record.get("remainingFraction")? {
        Value::Null => None,
        value => {
            let value = value.as_f64()?;
            if !value.is_finite() {
                return None;
            }
            Some(value)
        }
    };
    let checked_at = record.get("checkedAt")?.as_str()?;
    Some(SelectionSnapshot {
        version: 1,
        provider,
        subscription_id: subscription_id.to_string(),
        label: label.to_string(),
        model: model.to_string(),
        remaining_fraction,
        checked_at: checked_at.to_string(),
    })
}

/// Removes a selection that is no longer valid (no eligible provider).
pub fn remove_selection_snapshot(state_dir: &Path) {
    let _ = std::fs::remove_file(selection_snapshot_path(state_dir));
}

// ---------------------------------------------------------------------------
// Service

/// The refusal every empty store reports.
pub const NO_PROVIDER_CONFIGURED: &str = "No provider is configured. Open the Providers dialog (settings.providers) and add an OpenCode Go or OpenRouter API key.";

#[derive(Debug, Clone)]
pub struct ProviderUnavailable {
    pub message: String,
}

impl ProviderUnavailable {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProviderUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProviderUnavailable {}

/// The seams a service takes. Production uses the process environment, the
/// real clock, and the reqwest transport.
#[derive(Clone, Default)]
pub struct ProviderOptions {
    /// The environment a peer inherits.
    pub env: Option<Env>,
    /// Test seam: replaces the HTTP call.
    pub transport: Option<Transport>,
    /// Test seam: replaces the clock.
    pub now_ms: Option<Now>,
    pub timeout_ms: Option<u64>,
    /// Test seam: replaces the provider base URLs from the environment.
    pub usage_base_urls: HashMap<ProviderId, String>,
    pub log: Option<Log>,
    /// When set, a state push goes to every client through this sink rather
    /// than to the requesting connection alone.
    pub broadcast: Option<Broadcast>,
    /// The host's activity-log and one-alarm sink for credential repairs.
    pub audit: Option<AuditSink>,
    /// Test seam: replaces the worker retry pause.
    pub retry_sleep: Option<RetrySleep>,
}

#[derive(Debug, Clone)]
pub struct ProviderWindowView {
    pub key: String,
    pub label: String,
    pub percent_used: Option<f64>,
    pub remaining_fraction: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderSubscriptionView {
    pub id: String,
    pub provider: ProviderId,
    pub provider_name: &'static str,
    pub label: String,
    pub enabled: bool,
    pub masked_key: String,
    pub status: UsageStatus,
    pub windows: Vec<ProviderWindowView>,
    pub remaining_fraction: Option<f64>,
    pub last_checked_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderSelectionView {
    pub provider: ProviderId,
    pub provider_name: &'static str,
    pub label: String,
    pub model: String,
    pub remaining_fraction: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ProvidersView {
    pub subscriptions: Vec<ProviderSubscriptionView>,
    pub selection: Option<ProviderSelectionView>,
    /// The refusal reason when no provider can serve a peer.
    pub refusal: Option<String>,
    pub rule: String,
}

fn window_json(window: &ProviderWindowView) -> Value {
    json!({
        "key": window.key,
        "label": window.label,
        "percentUsed": window.percent_used,
        "remainingFraction": window.remaining_fraction,
        "resetsAt": window.resets_at,
    })
}

impl ProvidersView {
    pub fn to_json(&self) -> Value {
        let subscriptions: Vec<Value> = self
            .subscriptions
            .iter()
            .map(|subscription| {
                json!({
                    "id": subscription.id,
                    "provider": subscription.provider,
                    "providerName": subscription.provider_name,
                    "label": subscription.label,
                    "enabled": subscription.enabled,
                    "maskedKey": subscription.masked_key,
                    "status": subscription.status.as_str(),
                    "windows": subscription.windows.iter().map(window_json).collect::<Vec<Value>>(),
                    "remainingFraction": subscription.remaining_fraction,
                    "lastCheckedAt": subscription.last_checked_at,
                    "error": subscription.error,
                })
            })
            .collect();
        let selection = match &self.selection {
            Some(selection) => json!({
                "provider": selection.provider,
                "providerName": selection.provider_name,
                "label": selection.label,
                "model": selection.model,
                "remainingFraction": selection.remaining_fraction,
            }),
            None => Value::Null,
        };
        json!({
            "type": "providersState",
            "subscriptions": subscriptions,
            "selection": selection,
            "refusal": self.refusal,
            "rule": self.rule,
        })
    }
}

/// One `saveProvider` request, with unvalidated wire fields.
#[derive(Debug, Clone, Default)]
pub struct SaveProviderInput {
    pub id: Option<String>,
    pub provider: Option<Value>,
    pub label: Option<Value>,
    pub key: Option<Value>,
}

/// One provider change's refusal.
///
/// A key the provider itself refused is the operator's own input error: the
/// Providers dialog reports it inline, so it raises no app-wide error
/// notification and files no tracker issue. Every other refusal is a harness or
/// stored-state fault and keeps that notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderChangeError {
    pub message: String,
    pub key_refused: bool,
}

impl ProviderChangeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            key_refused: false,
        }
    }

    pub fn refused_key(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            key_refused: true,
        }
    }
}

impl From<String> for ProviderChangeError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

pub type SaveProviderResult = Result<(), ProviderChangeError>;

struct ValidatedInput {
    provider: ProviderId,
    label: String,
    key: Option<String>,
}

/// One in-flight usage read, shared by every caller that asks for the same
/// provider key while it runs.
type UsageFuture = Shared<BoxFuture<'static, UsageReport>>;

/// The durable provider credential file and the in-memory copy a service reads.
/// Every credential-file read and write happens here.
pub struct CredentialStore {
    state_dir: PathBuf,
    log: Log,
    audit: AuditSink,
    subscriptions: Mutex<Vec<StoredSubscription>>,
    marker: Mutex<MarkerState>,
    gate: Mutex<()>,
}

impl CredentialStore {
    pub fn new(state_dir: impl AsRef<Path>, log: Log) -> Self {
        Self::with_audit(state_dir, log, Arc::new(|_| {}))
    }

    pub fn with_audit(state_dir: impl AsRef<Path>, log: Log, audit: AuditSink) -> Self {
        let state_dir = state_dir.as_ref().to_path_buf();
        let marker = marker_state(&state_dir);
        let store = Self {
            state_dir,
            log,
            audit,
            subscriptions: Mutex::new(Vec::new()),
            marker: Mutex::new(marker),
            gate: Mutex::new(()),
        };
        store.reconcile();
        store
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn credentials_path(&self) -> PathBuf {
        credentials_path(&self.state_dir)
    }

    /// The internal list, including keys; never serialize this.
    pub fn list(&self) -> Vec<StoredSubscription> {
        lock(&self.subscriptions).clone()
    }

    pub fn get(&self, id: &str) -> Option<StoredSubscription> {
        lock(&self.subscriptions)
            .iter()
            .find(|subscription| subscription.id == id)
            .cloned()
    }

    /// Whether the presence marker records a loss the store cannot recover.
    pub fn lost(&self) -> bool {
        matches!(*lock(&self.marker), MarkerState::Loss(_))
    }

    pub fn loss_message(&self) -> String {
        lost_credentials_message(&self.credentials_path())
    }

    fn audit_activity(&self, detail: String) {
        (self.audit)(ProviderAudit::Activity(detail));
    }

    fn audit_loss(&self, primary: &Path) {
        (self.audit)(ProviderAudit::Loss {
            message: lost_credentials_message(primary),
            primary: primary.to_path_buf(),
        });
    }

    fn log_preserved(&self, preserved: &Path) {
        (self.log)(&format!(
            "providers: unusable credentials were preserved at {}",
            preserved.display()
        ));
    }

    /// Records one loss. Repeated detections of the same loss, including
    /// across a restart that reads the marker, answer `false`.
    fn note_loss(&self, primary: &Path) -> bool {
        let current = lock(&self.marker).clone();
        if let MarkerState::Loss(loss) = &current {
            if loss.alarmed {
                return false;
            }
        }
        let loss = CredentialLoss {
            id: uuid::Uuid::new_v4().to_string(),
            primary: primary.display().to_string(),
            alarmed: true,
            at: iso_timestamp(now_millis()),
        };
        if let Err(error) = write_marker(&self.state_dir, Some(&loss)) {
            (self.log)(&format!(
                "providers: the credentials-loss marker could not be written: {error}"
            ));
        }
        *lock(&self.marker) = MarkerState::Loss(loss);
        true
    }

    /// Ends the current loss: the primary is valid again and the marker says
    /// so. A marker that was absent becomes healthy presence.
    fn clear_loss(&self) {
        if matches!(*lock(&self.marker), MarkerState::Healthy) {
            return;
        }
        if let Err(error) = write_marker(&self.state_dir, None) {
            (self.log)(&format!(
                "providers: the credentials presence marker could not be written: {error}"
            ));
        }
        *lock(&self.marker) = MarkerState::Healthy;
    }

    /// Repairs the credential files from the backup or the in-memory list and
    /// raises the one alarm a loss earns. Every startup constructs through
    /// this, and every provider refresh calls it before publishing state.
    fn reconcile(&self) {
        let _gate = lock(&self.gate);
        let primary_path = credentials_path(&self.state_dir);
        let backup_path = credentials_backup_path(&self.state_dir);
        let primary = read_credentials_file(&primary_path);
        let backup = read_credentials_file(&backup_path);
        for preserved in [
            match &primary {
                CredentialFile::Unusable { preserved } => preserved.clone(),
                CredentialFile::Valid { preserved, .. } => preserved.clone(),
                CredentialFile::Missing => None,
            },
            match &backup {
                CredentialFile::Unusable { preserved } => preserved.clone(),
                CredentialFile::Valid { preserved, .. } => preserved.clone(),
                CredentialFile::Missing => None,
            },
        ]
        .into_iter()
        .flatten()
        {
            self.log_preserved(&preserved);
        }

        if let CredentialFile::Valid {
            subscriptions,
            rejected,
            ..
        } = &primary
        {
            let rescuing = if *rejected {
                intact_subscriptions(&backup)
            } else {
                None
            };
            if let Some(restored) = rescuing {
                let list = restored.to_vec();
                match write_credentials_file(&self.state_dir, &primary_path, &list) {
                    Ok(()) => self.audit_activity(format!(
                        "providers: rewrote the damaged primary from the backup at {}",
                        primary_path.display()
                    )),
                    Err(error) => (self.log)(&format!(
                        "providers: the repaired credentials could not be written: {error}"
                    )),
                }
                *lock(&self.subscriptions) = list;
                self.clear_loss();
                return;
            }
            let list = subscriptions.clone();
            if *rejected {
                if let Err(error) = write_credentials_file(&self.state_dir, &primary_path, &list) {
                    (self.log)(&format!(
                        "providers: the sanitized credentials could not be written: {error}"
                    ));
                }
            }
            let backup_differs = match &backup {
                CredentialFile::Valid {
                    subscriptions: backup_list,
                    rejected: backup_rejected,
                    ..
                } => *backup_rejected || backup_list != &list,
                _ => true,
            };
            if backup_differs {
                match write_credentials_file(&self.state_dir, &backup_path, &list) {
                    Ok(()) => self.audit_activity(format!(
                        "providers: rewrote the credential backup from the primary at {}",
                        primary_path.display()
                    )),
                    Err(error) => (self.log)(&format!(
                        "providers: the credential backup could not be written: {error}"
                    )),
                }
            }
            *lock(&self.subscriptions) = list;
            self.clear_loss();
            return;
        }

        let memory = self.list();
        if !memory.is_empty() {
            let alarm = self.note_loss(&primary_path);
            if alarm {
                self.audit_loss(&primary_path);
            }
            match write_credentials_pair(&self.state_dir, &memory) {
                Ok(()) => self.clear_loss(),
                Err(error) => (self.log)(&format!(
                    "providers: the in-memory credentials could not be restored: {error}"
                )),
            }
            return;
        }

        if let CredentialFile::Valid { subscriptions, .. } = backup {
            let alarm = self.note_loss(&primary_path);
            if alarm {
                self.audit_loss(&primary_path);
            }
            match write_credentials_pair(&self.state_dir, &subscriptions) {
                Ok(()) => {
                    *lock(&self.subscriptions) = subscriptions;
                    self.clear_loss();
                }
                Err(error) => (self.log)(&format!(
                    "providers: the credential backup could not be restored: {error}"
                )),
            }
            return;
        }

        let files_existed = !matches!(primary, CredentialFile::Missing)
            || !matches!(backup, CredentialFile::Missing);
        let marker = lock(&self.marker).clone();
        if files_existed || !matches!(marker, MarkerState::Absent) {
            let alarm = self.note_loss(&primary_path);
            if alarm {
                self.audit_loss(&primary_path);
            }
        }
    }

    /// Re-reads the credential files for a long-lived worker and answers the
    /// list it read. It never fabricates a list: an empty store stays empty so
    /// the worker can apply its bounded retry.
    pub fn reload(&self) -> Vec<StoredSubscription> {
        let _gate = lock(&self.gate);
        let loaded = load_subscriptions(&self.state_dir);
        *lock(&self.subscriptions) = loaded.subscriptions.clone();
        if let Some(preserved) = &loaded.preserved {
            self.log_preserved(preserved);
        }
        loaded.subscriptions
    }

    /// Adds a subscription, or replaces the record that carries its id.
    pub fn save(&self, subscription: StoredSubscription) -> SaveProviderResult {
        let _gate = lock(&self.gate);
        let mut current = lock(&self.subscriptions);
        let mut next = current.clone();
        match next.iter().position(|entry| entry.id == subscription.id) {
            Some(index) => next[index] = subscription,
            None => next.push(subscription),
        }
        self.persist(&mut current, next)
    }

    pub fn remove(&self, id: &str) -> SaveProviderResult {
        let _gate = lock(&self.gate);
        let mut current = lock(&self.subscriptions);
        let next: Vec<StoredSubscription> = current
            .iter()
            .filter(|subscription| subscription.id != id)
            .cloned()
            .collect();
        if next.len() == current.len() {
            return Err("That subscription no longer exists.".to_string().into());
        }
        self.persist(&mut current, next)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool, updated_at: &str) -> SaveProviderResult {
        let _gate = lock(&self.gate);
        let mut current = lock(&self.subscriptions);
        if !current.iter().any(|subscription| subscription.id == id) {
            return Err("That subscription no longer exists.".to_string().into());
        }
        let next: Vec<StoredSubscription> = current
            .iter()
            .map(|subscription| {
                if subscription.id == id {
                    StoredSubscription {
                        enabled,
                        updated_at: updated_at.to_string(),
                        ..subscription.clone()
                    }
                } else {
                    subscription.clone()
                }
            })
            .collect();
        self.persist(&mut current, next)
    }

    /// Writes both files and adopts the list only once the write landed. The
    /// marker clears here too, so one mutation ends a lost state.
    fn persist(
        &self,
        current: &mut MutexGuard<'_, Vec<StoredSubscription>>,
        next: Vec<StoredSubscription>,
    ) -> SaveProviderResult {
        if let Err(error) = write_credentials_pair(&self.state_dir, &next) {
            return Err(format!("The credentials file could not be written: {error}").into());
        }
        if let Err(error) = write_marker(&self.state_dir, None) {
            (self.log)(&format!(
                "providers: the credentials presence marker could not be written: {error}"
            ));
        }
        *lock(&self.marker) = MarkerState::Healthy;
        **current = next;
        Ok(())
    }
}

/// The usage reads and the reports a service ranks from: one fetch per
/// provider key is shared while it runs, and a read that finds a stale report
/// wakes the dashboard's background loop through `refresh_wake`.
pub struct UsageCache {
    base_env: Env,
    transport: Transport,
    now_ms: Now,
    usage_base_urls: HashMap<ProviderId, String>,
    cached: Mutex<HashMap<String, UsageReport>>,
    /// One in-flight fetch per provider key, whatever asks while it runs.
    inflight: Mutex<HashMap<String, UsageFuture>>,
    /// Wakes the dashboard's background refresh loop when a read finds cached
    /// usage it should replace, so the read itself never waits for the
    /// usage endpoint.
    refresh_wake: Arc<tokio::sync::Notify>,
}

impl UsageCache {
    pub fn new(
        base_env: Env,
        transport: Transport,
        now_ms: Now,
        usage_base_urls: HashMap<ProviderId, String>,
    ) -> Self {
        Self {
            base_env,
            transport,
            now_ms,
            usage_base_urls,
            cached: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            refresh_wake: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// The handle the background refresh loop waits on.
    pub fn refresh_wake(&self) -> Arc<tokio::sync::Notify> {
        Arc::clone(&self.refresh_wake)
    }

    /// Wakes the background refresh loop for a stale report a read served.
    pub fn wake(&self) {
        self.refresh_wake.notify_one();
    }

    /// The cached report for every subscription id.
    pub fn snapshot(&self) -> HashMap<String, UsageReport> {
        lock(&self.cached).clone()
    }

    pub fn store(&self, id: String, report: UsageReport) {
        lock(&self.cached).insert(id, report);
    }

    pub fn forget(&self, id: &str) {
        lock(&self.cached).remove(id);
    }

    /// Keeps cached usage for an unchanged key and drops it for a removed or
    /// replaced one.
    pub fn retain_unchanged(&self, previous: &[StoredSubscription], next: &[StoredSubscription]) {
        let ids: std::collections::HashSet<&str> =
            next.iter().map(|entry| entry.id.as_str()).collect();
        let replaced: std::collections::HashSet<&str> = next
            .iter()
            .filter(|entry| {
                previous
                    .iter()
                    .find(|candidate| candidate.id == entry.id)
                    .is_some_and(|candidate| {
                        candidate.key != entry.key || candidate.provider != entry.provider
                    })
            })
            .map(|entry| entry.id.as_str())
            .collect();
        lock(&self.cached)
            .retain(|id, _| ids.contains(id.as_str()) && !replaced.contains(id.as_str()));
    }

    /// Whether one cached report is missing or older than the TTL.
    fn is_stale(cached: Option<&UsageReport>, now: i64) -> bool {
        match cached {
            None => true,
            Some(cached) => now - cached.checked_at_ms >= USAGE_TTL_MS as i64,
        }
    }

    /// Whether a background refresh would replace any cached report now.
    pub fn has_stale_usage(&self, subscriptions: &[StoredSubscription]) -> bool {
        let now = (self.now_ms)();
        let cached = lock(&self.cached);
        subscriptions
            .iter()
            .any(|subscription| Self::is_stale(cached.get(&subscription.id), now))
    }

    /// Reads every subscription whose cached usage is older than the TTL, or
    /// all of them when the operator forces a refresh.
    pub async fn refresh(&self, subscriptions: &[StoredSubscription], force: bool) {
        let now = (self.now_ms)();
        let pending: Vec<StoredSubscription> = {
            let cached = lock(&self.cached);
            subscriptions
                .iter()
                .filter(|subscription| force || Self::is_stale(cached.get(&subscription.id), now))
                .cloned()
                .collect()
        };
        let mut futures = Vec::new();
        for subscription in pending {
            let provider = subscription.provider;
            let key = subscription.key.clone();
            let id = subscription.id.clone();
            futures.push(async move {
                let report = self.fetch(provider, &key).await;
                (id, key, report)
            });
        }
        let results = futures_util::future::join_all(futures).await;
        let mut cached = lock(&self.cached);
        for (id, key, report) in results {
            let current = subscriptions
                .iter()
                .find(|subscription| subscription.id == id);
            if current.map(|subscription| subscription.key.as_str()) == Some(key.as_str()) {
                cached.insert(id, report);
            }
        }
    }

    fn base_url(&self, provider: ProviderId) -> String {
        let definition = provider_definition(provider);
        if let Some(value) = self.usage_base_urls.get(&provider) {
            return value.clone();
        }
        if let Some(value) = self
            .base_env
            .get(definition.usage_base_url_env)
            .and_then(Option::as_ref)
        {
            return value.clone();
        }
        definition.default_usage_base_url.to_string()
    }

    /// Reads one provider key, joining the fetch already in flight for it.
    pub async fn fetch(&self, provider: ProviderId, key: &str) -> UsageReport {
        let shared = self.shared_usage(provider, key);
        let report = shared.clone().await;
        self.finish_usage(provider, key, &shared);
        report
    }

    /// The one fetch every concurrent caller for this provider key waits on.
    /// The future is created once and shared, so a second caller never opens a
    /// second upstream request while the first is still pending.
    fn shared_usage(&self, provider: ProviderId, key: &str) -> UsageFuture {
        let id = format!("{}\u{0}{key}", provider.as_str());
        let mut inflight = lock(&self.inflight);
        if let Some(existing) = inflight.get(&id) {
            return existing.clone();
        }
        let base_url = self.base_url(provider);
        let transport = Arc::clone(&self.transport);
        let now = (self.now_ms)();
        let owned_key = key.to_string();
        let request: BoxFuture<'static, UsageReport> =
            async move { fetch_usage(provider, &owned_key, &base_url, &transport, now).await }
                .boxed();
        let shared = request.shared();
        inflight.insert(id, shared.clone());
        shared
    }

    /// Drops the in-flight entry once its callers have the report. A newer
    /// fetch for the same key is never removed by an older one.
    fn finish_usage(&self, provider: ProviderId, key: &str, shared: &UsageFuture) {
        let id = format!("{}\u{0}{key}", provider.as_str());
        let mut inflight = lock(&self.inflight);
        if inflight
            .get(&id)
            .map(|existing| existing.ptr_eq(shared))
            .unwrap_or(false)
        {
            inflight.remove(&id);
        }
    }
}

/// Writes one peer's agent directory and builds the binding it runs with. The
/// dashboard passes the repository root its harness executable resolves
/// against; a worker that carries only a state directory uses `unscoped`.
pub struct PeerProvisioner {
    state_dir: PathBuf,
    repo_dir: Option<PathBuf>,
    base_env: Env,
}

impl PeerProvisioner {
    pub fn new(state_dir: impl AsRef<Path>, repo_dir: impl AsRef<Path>, base_env: Env) -> Self {
        Self {
            state_dir: state_dir.as_ref().to_path_buf(),
            repo_dir: Some(repo_dir.as_ref().to_path_buf()),
            base_env,
        }
    }

    /// A provisioner for a caller that carries no repository root.
    pub fn unscoped(state_dir: impl AsRef<Path>, base_env: Env) -> Self {
        Self {
            state_dir: state_dir.as_ref().to_path_buf(),
            repo_dir: None,
            base_env,
        }
    }

    /// Writes the selected subscription's agent directory and returns the
    /// binding that directory and its environment carry.
    pub fn bind(
        &self,
        subscription: &StoredSubscription,
        usage: Option<&UsageReport>,
        fallback_key: Option<&str>,
    ) -> Result<PeerBinding, ProviderUnavailable> {
        let provider = subscription.provider;
        let model = provider_definition(provider).model;
        let directory = agent_directory(&self.state_dir, provider, &subscription.id);
        let mcp = match &self.repo_dir {
            Some(repo_dir) => default_agent_mcp_for(repo_dir),
            None => Ok(default_agent_mcp()),
        }
        .map_err(ProviderUnavailable::new)?;
        write_agent_directory(&directory, &generated_config(provider, model), &mcp)
            .map_err(|error| ProviderUnavailable::new(error.to_string()))?;

        let mut binding = PeerBinding {
            provider,
            provider_name: provider_name(provider),
            subscription_id: subscription.id.clone(),
            subscription_label: subscription.label.clone(),
            model: model.to_string(),
            remaining_fraction: usage.and_then(|usage| usage.remaining_fraction),
            agent_dir: directory,
            env: Env::new(),
        };
        binding.env = peer_environment(&self.base_env, &binding, &subscription.key, fallback_key);
        Ok(binding)
    }
}

/// Composes the credential store, the usage cache, and the peer provisioner;
/// keeps the masked view, the state frame, and command dispatch.
pub struct ProviderService {
    credentials: CredentialStore,
    usage: UsageCache,
    provisioner: PeerProvisioner,
    repo_dir: PathBuf,
    now_ms: Now,
    log: Log,
    broadcast: Mutex<Option<Broadcast>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// `new Date(ms).toISOString()`.
pub fn iso_timestamp(ms: i64) -> String {
    let nanos = i128::from(ms).saturating_mul(1_000_000);
    let moment = time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        moment.year(),
        moment.month() as u8,
        moment.day(),
        moment.hour(),
        moment.minute(),
        moment.second(),
        moment.millisecond()
    )
}

fn hex_bytes<const N: usize>() -> String {
    let bytes: Vec<u8> = (0..N).map(|_| rand::random::<u8>()).collect();
    hex::encode(bytes)
}

fn process_env() -> Env {
    std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                Some(value.to_string_lossy().into_owned()),
            )
        })
        .collect()
}

impl ProviderService {
    pub fn new(
        state_dir: impl AsRef<Path>,
        repo_dir: impl AsRef<Path>,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        let options = ProviderOptions {
            log: Some(Arc::new(log)),
            ..ProviderOptions::default()
        };
        Self::with_options(state_dir, repo_dir, options)
    }

    pub fn with_options(
        state_dir: impl AsRef<Path>,
        repo_dir: impl AsRef<Path>,
        options: ProviderOptions,
    ) -> Self {
        let state_dir = state_dir.as_ref().to_path_buf();
        let repo_dir = repo_dir.as_ref().to_path_buf();
        let base_env = options.env.unwrap_or_else(process_env);
        let timeout_ms = options.timeout_ms.unwrap_or(USAGE_TIMEOUT_MS);
        let transport = options
            .transport
            .unwrap_or_else(|| default_transport(timeout_ms));
        let now_ms = options.now_ms.unwrap_or_else(|| Arc::new(now_millis));
        let log = options.log.unwrap_or_else(|| Arc::new(|_: &str| {}));
        let audit = options
            .audit
            .clone()
            .unwrap_or_else(|| Arc::new(|_: ProviderAudit| {}));
        let credentials = CredentialStore::with_audit(&state_dir, Arc::clone(&log), audit);
        let usage = UsageCache::new(
            base_env.clone(),
            transport,
            Arc::clone(&now_ms),
            options.usage_base_urls,
        );
        let provisioner = PeerProvisioner::new(&state_dir, &repo_dir, base_env);
        Self {
            credentials,
            usage,
            provisioner,
            repo_dir,
            now_ms,
            log,
            broadcast: Mutex::new(options.broadcast),
        }
    }

    /// The handle the background refresh loop waits on.
    pub fn refresh_wake(&self) -> Arc<tokio::sync::Notify> {
        self.usage.refresh_wake()
    }

    pub fn repo_dir(&self) -> &Path {
        &self.repo_dir
    }

    /// Routes every state push through the dashboard's broadcast; without a
    /// sink the requesting connection is the only recipient.
    pub fn set_broadcast(&self, broadcast: Broadcast) {
        *lock(&self.broadcast) = Some(broadcast);
    }

    fn push_state(&self, conn: &Conn) {
        let frame = self.state_frame();
        let sink = lock(&self.broadcast).clone();
        match sink {
            Some(sink) => sink(frame),
            None => conn.send(frame),
        }
    }

    pub fn credentials_path(&self) -> PathBuf {
        self.credentials.credentials_path()
    }

    /// The internal credential list, including keys; never serialize this.
    pub fn list(&self) -> Vec<StoredSubscription> {
        self.credentials.list()
    }

    /// Re-reads the credential file for a long-lived worker, keeping cached
    /// usage for an unchanged key and dropping it for a removed or replaced
    /// one.
    pub fn reload(&self) {
        let previous = self.credentials.list();
        let next = self.credentials.reload();
        self.usage.retain_unchanged(&previous, &next);
    }

    /// Reads every subscription whose cached usage is older than the TTL, or
    /// all of them when the operator forces a refresh.
    pub async fn refresh(&self, force: bool) {
        self.credentials.reconcile();
        let subscriptions = self.credentials.list();
        self.usage.refresh(&subscriptions, force).await;
        self.publish_selection();
    }

    /// Repairs a missing or unusable primary from the backup or the in-memory
    /// list before any provider state is published. The dashboard calls this
    /// on its existing 60-second tick, including with no client connected.
    pub fn reconcile_credentials(&self) {
        self.credentials.reconcile();
    }

    fn ranked(&self) -> Vec<RankedSubscription> {
        let snapshot = read_selection_snapshot(self.credentials.state_dir());
        let subscriptions = self.credentials.list();
        let usage = self.usage.snapshot();
        let mut ranked = rank_subscriptions(&subscriptions, &usage);
        if let Some(snapshot) = snapshot {
            for candidate in &mut ranked {
                candidate.preferred = candidate.subscription.provider == snapshot.provider
                    && candidate.subscription.id == snapshot.subscription_id;
            }
        }
        ranked
    }

    /// Publishes the dashboard's decision so detached workers can follow it
    /// without probing usage themselves.
    fn publish_selection(&self) {
        let ranked = self.ranked();
        let decision = decide_provider(&ranked, !ranked.is_empty());
        let checked_at = iso_timestamp((self.now_ms)());
        let result = match decision {
            ProviderDecision::Selected {
                subscription,
                usage,
                ..
            } => write_selection_snapshot(
                self.credentials.state_dir(),
                subscription.provider,
                &subscription.id,
                &subscription.label,
                provider_definition(subscription.provider).model,
                usage.and_then(|usage| usage.remaining_fraction),
                &checked_at,
            ),
            ProviderDecision::Refused { .. } => {
                // A lost store keeps its last selection as evidence until a
                // successful save replaces it.
                if self.credentials.lost() {
                    return;
                }
                remove_selection_snapshot(self.credentials.state_dir());
                Ok(())
            }
        };
        if let Err(error) = result {
            (self.log)(&format!(
                "providers: the selection snapshot could not be written: {error}"
            ));
        }
    }

    pub fn view(&self) -> ProvidersView {
        let ranked = self.ranked();
        let decision = decide_provider(&ranked, !ranked.is_empty());
        let subscriptions = ranked
            .iter()
            .map(|candidate| {
                let usage = candidate.usage.as_ref();
                ProviderSubscriptionView {
                    id: candidate.subscription.id.clone(),
                    provider: candidate.subscription.provider,
                    provider_name: provider_name(candidate.subscription.provider),
                    label: candidate.subscription.label.clone(),
                    enabled: candidate.subscription.enabled,
                    masked_key: mask_key(&candidate.subscription.key),
                    status: usage
                        .map(|usage| usage.status)
                        .unwrap_or(UsageStatus::Unknown),
                    windows: usage
                        .map(|usage| {
                            usage
                                .windows
                                .iter()
                                .map(|window| ProviderWindowView {
                                    key: window.key.clone(),
                                    label: window.label.clone(),
                                    percent_used: window.percent_used,
                                    remaining_fraction: window.remaining_fraction,
                                    resets_at: window.resets_at.clone(),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    remaining_fraction: usage.and_then(|usage| usage.remaining_fraction),
                    last_checked_at: usage.map(|usage| usage.checked_at.clone()),
                    error: usage.and_then(|usage| usage.error.clone()),
                }
            })
            .collect();

        match decision {
            ProviderDecision::Refused { reason } => ProvidersView {
                subscriptions,
                selection: None,
                refusal: Some(if self.credentials.lost() {
                    self.credentials.loss_message()
                } else {
                    reason
                }),
                rule: ROTATION_RULE.to_string(),
            },
            ProviderDecision::Selected {
                subscription,
                usage,
                ..
            } => {
                let definition = provider_definition(subscription.provider);
                ProvidersView {
                    subscriptions,
                    selection: Some(ProviderSelectionView {
                        provider: subscription.provider,
                        provider_name: definition.name,
                        label: subscription.label,
                        model: definition.model.to_string(),
                        remaining_fraction: usage.and_then(|usage| usage.remaining_fraction),
                    }),
                    refusal: None,
                    rule: ROTATION_RULE.to_string(),
                }
            }
        }
    }

    fn validated(&self, input: &SaveProviderInput) -> Result<ValidatedInput, String> {
        let provider = is_provider_id(input.provider.as_ref())
            .ok_or_else(|| "Choose OpenCode Go or OpenRouter.".to_string())?;
        let label = clamp_label(
            input.label.as_ref().and_then(Value::as_str).unwrap_or(""),
            provider_definition(provider).name,
        );
        let key = input
            .key
            .as_ref()
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string);
        Ok(ValidatedInput {
            provider,
            label,
            key,
        })
    }

    /// Adds or edits one subscription. A new or changed key is validated
    /// first; an edit without a key only changes the label and enablement. An
    /// existing subscription never changes provider: its stored key belongs to
    /// the provider that issued it, and its cached usage belongs to that key.
    pub async fn save(&self, input: SaveProviderInput) -> SaveProviderResult {
        let validated = self.validated(&input)?;
        let existing = match &input.id {
            Some(id) => self.credentials.get(id),
            None => None,
        };
        if input.id.is_some() && existing.is_none() {
            return Err("That subscription no longer exists.".to_string().into());
        }
        if existing
            .as_ref()
            .is_some_and(|entry| entry.provider != validated.provider)
        {
            return Err(ProviderChangeError::new(
                "A subscription's provider cannot be changed. Remove it and add it again.",
            ));
        }

        let key = validated
            .key
            .clone()
            .or_else(|| existing.as_ref().map(|entry| entry.key.clone()));
        let Some(key) = key else {
            return Err("An API key is required.".to_string().into());
        };

        let mut checked = None;
        if validated.key.is_some() {
            let report = self.usage.fetch(validated.provider, &key).await;
            if report.status == UsageStatus::Invalid {
                return Err(ProviderChangeError::refused_key(
                    report
                        .error
                        .clone()
                        .unwrap_or_else(|| "The provider rejected this key.".to_string()),
                ));
            }
            checked = Some(report);
        }

        let timestamp = iso_timestamp((self.now_ms)());
        let id = existing
            .as_ref()
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let subscription = StoredSubscription {
            id: id.clone(),
            provider: validated.provider,
            label: validated.label,
            key,
            enabled: existing.as_ref().map(|entry| entry.enabled).unwrap_or(true),
            created_at: existing
                .as_ref()
                .map(|entry| entry.created_at.clone())
                .unwrap_or_else(|| timestamp.clone()),
            updated_at: timestamp,
        };

        self.credentials.save(subscription.clone())?;
        if existing
            .as_ref()
            .is_some_and(|entry| entry.key != subscription.key)
        {
            self.usage.forget(&id);
        }
        if let Some(report) = checked {
            self.usage.store(id, report);
        }

        self.publish_selection();
        Ok(())
    }

    pub fn remove(&self, id: &str) -> SaveProviderResult {
        self.credentials.remove(id)?;
        self.usage.forget(id);
        self.publish_selection();
        Ok(())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> SaveProviderResult {
        let updated_at = iso_timestamp((self.now_ms)());
        self.credentials.set_enabled(id, enabled, &updated_at)?;
        self.publish_selection();
        Ok(())
    }

    /// Resolves the peer binding from the cached usage report. Refuses before
    /// any process exists when no subscription can serve a peer.
    ///
    /// Selection never waits for the usage endpoint: a Start must answer on
    /// the cached report, and a stale report is refreshed by
    /// [`ProviderService::background_refresh`] on its own tick. A key whose
    /// cached report is missing is treated as unknown headroom, exactly as a
    /// failed check is. The dashboard's published selection breaks that tie,
    /// so a worker resolving its own environment follows the same key the
    /// dashboard chose instead of the first key in the credential file.
    pub async fn select(&self) -> Result<PeerBinding, ProviderUnavailable> {
        let ranked = self.ranked();
        let decision = decide_provider(&ranked, !ranked.is_empty());
        let (subscription, usage, fallback) = match decision {
            ProviderDecision::Refused { reason } => {
                let message = if self.credentials.lost() {
                    self.credentials.loss_message()
                } else {
                    reason
                };
                return Err(ProviderUnavailable::new(message));
            }
            ProviderDecision::Selected {
                subscription,
                usage,
                fallback,
                ..
            } => (subscription, usage, fallback),
        };

        self.provisioner.bind(
            &subscription,
            usage.as_ref(),
            fallback.as_ref().map(|entry| entry.key.as_str()),
        )
    }

    /// The environment one ACP peer receives for the current selection.
    pub async fn select_environment(&self) -> Result<Env, ProviderUnavailable> {
        self.select().await.map(|binding| binding.env)
    }

    /// The dashboard's periodic usage check: fetches a subscription's usage
    /// only when its cached report is at least one TTL old. The caller owns
    /// the cadence and the resulting state push, so no Start or `getProviders`
    /// request has to wait for the endpoint.
    pub async fn background_refresh(&self) {
        self.refresh(false).await;
    }

    /// The masked frame `getProviders` and every change answer with.
    pub fn state_frame(&self) -> Value {
        self.view().to_json()
    }

    /// The initial masked state a connecting client receives.
    pub fn replay(&self, conn: &Conn) {
        conn.send(self.state_frame());
    }

    /// Applies one provider command; `false` when the command belongs to
    /// another flow.
    pub async fn handle(&self, conn: &Conn, command: &Command) -> bool {
        match command {
            Command::GetProviders => {
                self.get_providers(conn);
                true
            }
            Command::RefreshProviders => {
                self.refresh_providers(conn).await;
                true
            }
            Command::CreateProvider {
                request_id,
                provider,
                label,
                key,
            } => {
                let input = SaveProviderInput {
                    id: None,
                    provider: provider.clone(),
                    label: label.clone(),
                    key: key.clone(),
                };
                self.save_command(conn, request_id.as_ref(), input).await;
                true
            }
            Command::SaveProvider {
                request_id,
                id,
                provider,
                label,
                key,
            } => {
                let input = SaveProviderInput {
                    id: id.as_ref().and_then(Value::as_str).map(str::to_string),
                    provider: provider.clone(),
                    label: label.clone(),
                    key: key.clone(),
                };
                self.save_command(conn, request_id.as_ref(), input).await;
                true
            }
            Command::DeleteProvider { request_id, id } => {
                self.delete_provider(
                    conn,
                    request_id.as_ref(),
                    id.as_ref().and_then(Value::as_str),
                )
                .await;
                true
            }
            Command::SetProviderEnabled {
                request_id,
                id,
                enabled,
            } => {
                self.set_provider_enabled(
                    conn,
                    request_id.as_ref(),
                    id.as_ref().and_then(Value::as_str),
                    enabled.as_ref().and_then(Value::as_bool),
                )
                .await;
                true
            }
            _ => false,
        }
    }

    /// A read answers the cached view and never waits for a usage endpoint. A
    /// stale report wakes the dashboard's background loop, which refreshes it
    /// and pushes the state it answers with; only an explicit refresh
    /// publishes to every client.
    fn get_providers(&self, conn: &Conn) {
        conn.send(self.state_frame());
        if self.usage.has_stale_usage(&self.credentials.list()) {
            self.usage.wake();
        }
    }

    async fn refresh_providers(&self, conn: &Conn) {
        self.refresh(true).await;
        self.push_state(conn);
    }

    async fn delete_provider(&self, conn: &Conn, request_id: Option<&Value>, id: Option<&str>) {
        let Some(id) = id else {
            conn.send(provider_error_frame(
                request_id,
                &ProviderChangeError::new("A delete needs the subscription id."),
            ));
            return;
        };
        if !request_id.map(is_provider_request_id).unwrap_or(false) {
            conn.send(provider_error_frame(
                None,
                &ProviderChangeError::new(PROVIDER_CHANGE_NEEDS_ID),
            ));
            return;
        }
        let result = self.remove(id);
        self.settle(conn, request_id, result).await;
    }

    async fn set_provider_enabled(
        &self,
        conn: &Conn,
        request_id: Option<&Value>,
        id: Option<&str>,
        enabled: Option<bool>,
    ) {
        let (Some(id), Some(enabled)) = (id, enabled) else {
            conn.send(provider_error_frame(
                request_id,
                &ProviderChangeError::new("Enabling a subscription needs its id and a boolean."),
            ));
            return;
        };
        if !request_id.map(is_provider_request_id).unwrap_or(false) {
            conn.send(provider_error_frame(
                None,
                &ProviderChangeError::new(PROVIDER_CHANGE_NEEDS_ID),
            ));
            return;
        }
        let result = self.set_enabled(id, enabled);
        self.settle(conn, request_id, result).await;
    }

    /// Applies one save or create under the request id both commands carry.
    async fn save_command(
        &self,
        conn: &Conn,
        request_id: Option<&Value>,
        input: SaveProviderInput,
    ) {
        if !request_id.map(is_provider_request_id).unwrap_or(false) {
            conn.send(provider_error_frame(
                None,
                &ProviderChangeError::new(PROVIDER_CHANGE_NEEDS_ID),
            ));
            return;
        }
        let result = self.save(input).await;
        self.settle(conn, request_id, result).await;
    }

    async fn settle(&self, conn: &Conn, request_id: Option<&Value>, result: SaveProviderResult) {
        match result {
            Ok(()) => {
                let request_id = request_id.cloned().unwrap_or(Value::Null);
                conn.send(json!({"type": "providerChanged", "requestId": request_id}));
                self.refresh(false).await;
                self.push_state(conn);
            }
            Err(error) => conn.send(provider_error_frame(request_id, &error)),
        }
    }
}

fn clamp_label(label: &str, fallback: &str) -> String {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let mut units: Vec<u16> = trimmed.encode_utf16().take(80).collect();
    if let Some(last) = units.last() {
        if (0xd800..0xdc00).contains(last) {
            units.pop();
        }
    }
    String::from_utf16(&units).unwrap_or_else(|_| fallback.to_string())
}

// ---------------------------------------------------------------------------
// Wire replies

/// The client-generated change id the server echoes back.
pub const PROVIDER_CHANGE_NEEDS_ID: &str = "A provider change needs its request id.";

pub fn is_provider_request_id(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                return integer >= 0;
            }
            if number.as_u64().is_some() {
                return true;
            }
            match number.as_f64() {
                Some(value) => value.is_finite() && value >= 0.0 && value.fract() == 0.0,
                None => false,
            }
        }
        _ => false,
    }
}

/// One `providerError` frame. `keyRefused` marks the provider's own verdict on
/// a key the operator just entered: the dialog reports it inline, so the client
/// raises no app-wide error notification and files no tracker issue.
pub fn provider_error_frame(request_id: Option<&Value>, error: &ProviderChangeError) -> Value {
    let mut object = Map::new();
    object.insert(
        "type".to_string(),
        Value::String("providerError".to_string()),
    );
    if let Some(request_id) = request_id {
        object.insert("requestId".to_string(), request_id.clone());
    }
    object.insert("message".to_string(), Value::String(error.message.clone()));
    if error.key_refused {
        object.insert("keyRefused".to_string(), Value::Bool(true));
    }
    Value::Object(object)
}

// ---------------------------------------------------------------------------
// Worker environment

/// A worker that already resolved a provider re-reads an empty store on this
/// bounded schedule: five pauses totalling 3.35 s, well inside five seconds,
/// and at least two reads. A file that reappears during the window resolves.
pub const WORKER_PROVIDER_RETRY_DELAYS_MS: [u64; 5] = [100, 250, 500, 1_000, 1_500];

fn default_retry_sleep() -> RetrySleep {
    Arc::new(|milliseconds: u64| {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(
            milliseconds,
        )))
    })
}

/// A worker-scoped resolver: one service keeps usage cached for its TTL,
/// while every call re-reads the credential file.
pub struct WorkerProviderEnvironment {
    state_dir: PathBuf,
    repo_dir: PathBuf,
    environment: Env,
    options: ProviderOptions,
    sleep: RetrySleep,
    state: Mutex<WorkerState>,
}

struct WorkerState {
    service: Option<Arc<ProviderService>>,
    configured: bool,
}

impl WorkerProviderEnvironment {
    pub fn new(
        state_dir: impl AsRef<Path>,
        repo_dir: impl AsRef<Path>,
        environment: Env,
        mut options: ProviderOptions,
    ) -> Self {
        options.env = Some(environment.clone());
        let sleep = options
            .retry_sleep
            .clone()
            .unwrap_or_else(default_retry_sleep);
        Self {
            state_dir: state_dir.as_ref().to_path_buf(),
            repo_dir: repo_dir.as_ref().to_path_buf(),
            environment,
            options,
            sleep,
            state: Mutex::new(WorkerState {
                service: None,
                configured: false,
            }),
        }
    }

    pub async fn resolve(&self) -> Result<Env, ProviderUnavailable> {
        let service = {
            let mut state = lock(&self.state);
            let service = state.service.get_or_insert_with(|| {
                Arc::new(ProviderService::with_options(
                    &self.state_dir,
                    &self.repo_dir,
                    self.options.clone(),
                ))
            });
            Arc::clone(service)
        };
        service.reload();
        let mut loaded = service.list();
        let configured = lock(&self.state).configured;
        if loaded.is_empty() && configured {
            for delay in WORKER_PROVIDER_RETRY_DELAYS_MS {
                (self.sleep)(delay).await;
                service.reload();
                loaded = service.list();
                if !loaded.is_empty() {
                    break;
                }
            }
        }
        if loaded.is_empty() {
            if configured || credentials_lost(&self.state_dir) {
                return Err(ProviderUnavailable::new(lost_credentials_message(
                    &credentials_path(&self.state_dir),
                )));
            }
            return Ok(self.environment.clone());
        }
        lock(&self.state).configured = true;
        Ok(service.select().await?.env)
    }
}

pub fn create_worker_provider_environment(
    state_dir: impl AsRef<Path>,
    repo_dir: impl AsRef<Path>,
    environment: Env,
    options: ProviderOptions,
) -> WorkerProviderEnvironment {
    WorkerProviderEnvironment::new(state_dir, repo_dir, environment, options)
}

/// One-shot form for callers that resolve a single agent.
pub async fn worker_peer_environment(
    state_dir: impl AsRef<Path>,
    repo_dir: impl AsRef<Path>,
    environment: Env,
    mut options: ProviderOptions,
) -> Result<Env, ProviderUnavailable> {
    let state_dir = state_dir.as_ref();
    let credentials = CredentialStore::new(state_dir, Arc::new(|_: &str| {}));
    if credentials.list().is_empty() {
        if credentials.lost() {
            return Err(ProviderUnavailable::new(lost_credentials_message(
                &credentials_path(state_dir),
            )));
        }
        return Ok(environment);
    }
    options.env = Some(environment);
    let service = ProviderService::with_options(state_dir, repo_dir, options);
    Ok(service.select().await?.env)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The peer registration must start this harness's stdio server. A module
    /// path that no longer exists leaves every peer without Devboard tools.
    #[test]
    fn a_peer_registration_launches_this_harness_stdio_server() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mcp = default_agent_mcp_for(repo).expect("the harness executable");
        let entry = &mcp.servers[DEVBOARD_MCP_SERVER];
        assert_eq!(entry["type"], json!("stdio"));
        assert_eq!(
            entry["command"],
            json!(harness_executable(repo).unwrap().display().to_string())
        );
        assert_eq!(entry["args"], json!(["mcp"]));
    }

    /// A directory written by the retired wrapper registration loses that
    /// wrapper, so the executable entry is the only path a peer can take.
    #[test]
    fn writing_a_peer_directory_removes_the_retired_wrapper() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("agent-mcp-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("scratch directory");
        std::fs::write(directory.join("devboard-mcp.ts"), "stale").expect("stale wrapper");
        let mcp = default_agent_mcp_for(Path::new(env!("CARGO_MANIFEST_DIR")))
            .expect("the harness executable");
        write_agent_directory(&directory, "modelRoles: {}\n", &mcp).expect("agent directory");
        assert!(!directory.join("devboard-mcp.ts").exists());
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(directory.join("mcp.json")).unwrap())
                .expect("mcp.json");
        assert_eq!(
            parsed["mcpServers"][DEVBOARD_MCP_SERVER]["args"],
            json!(["mcp"])
        );
        let _ = std::fs::remove_dir_all(&directory);
    }
}
