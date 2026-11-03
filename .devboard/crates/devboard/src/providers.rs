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

use serde_json::{json, Map, Value};

use crate::app::Conn;
use crate::protocol::Command;

/// An environment handed to one ACP peer.
pub type Env = HashMap<String, Option<String>>;
/// The logger a service writes one line at a time to.
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;
/// The clock a service reads, in Unix milliseconds.
pub type Now = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Replaces the per-connection state push with the dashboard's broadcast.
pub type Broadcast = Arc<dyn Fn(Value) + Send + Sync>;

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

/// The subscriptions a load accepted, plus a preserved copy when some bytes
/// could not be used.
#[derive(Debug, Clone)]
pub struct LoadedCredentials {
    pub subscriptions: Vec<StoredSubscription>,
    pub preserved: Option<PathBuf>,
}

pub fn providers_directory(state_dir: &Path) -> PathBuf {
    state_dir.join("providers")
}

pub fn credentials_path(state_dir: &Path) -> PathBuf {
    providers_directory(state_dir).join("credentials.json")
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

fn write_subscriptions(
    directory: &Path,
    path: &Path,
    subscriptions: &[StoredSubscription],
) -> io::Result<()> {
    let envelope = CredentialsEnvelope {
        version: CREDENTIALS_VERSION,
        subscriptions,
    };
    let mut text = serde_json::to_string_pretty(&envelope).map_err(io::Error::other)?;
    text.push('\n');
    let temporary = directory.join(format!(
        "credentials.json.{}.{}.tmp",
        std::process::id(),
        hex_bytes::<6>()
    ));
    let result = (|| -> io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
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

/// Reads the subscription list. A missing file is an empty list; unusable
/// bytes are preserved aside so a later save never overwrites them unnoticed.
pub fn load_subscriptions(state_dir: &Path) -> LoadedCredentials {
    let path = credentials_path(state_dir);
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return LoadedCredentials {
                subscriptions: Vec::new(),
                preserved: None,
            }
        }
        Err(_) => {
            return LoadedCredentials {
                subscriptions: Vec::new(),
                preserved: preserve(&path),
            }
        }
    };

    let parsed: Value = match serde_json::from_str(&source) {
        Ok(parsed) => parsed,
        Err(_) => {
            return LoadedCredentials {
                subscriptions: Vec::new(),
                preserved: preserve(&path),
            }
        }
    };
    let Some(envelope) = parsed.as_object() else {
        return LoadedCredentials {
            subscriptions: Vec::new(),
            preserved: preserve(&path),
        };
    };
    if envelope.get("version").and_then(Value::as_u64) != Some(CREDENTIALS_VERSION as u64) {
        return LoadedCredentials {
            subscriptions: Vec::new(),
            preserved: preserve(&path),
        };
    }
    let Some(entries) = envelope.get("subscriptions").and_then(Value::as_array) else {
        return LoadedCredentials {
            subscriptions: Vec::new(),
            preserved: preserve(&path),
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
    if !rejected {
        return LoadedCredentials {
            subscriptions,
            preserved: None,
        };
    }

    let Some(preserved) = preserve_copy(&path) else {
        return LoadedCredentials {
            subscriptions,
            preserved: None,
        };
    };
    let directory = providers_directory(state_dir);
    if ensure_directory(&directory).is_ok() {
        let _ = write_subscriptions(&directory, &path, &subscriptions);
    }
    LoadedCredentials {
        subscriptions,
        preserved: Some(preserved),
    }
}

/// Replaces the whole credentials file atomically.
pub fn save_subscriptions(
    state_dir: &Path,
    subscriptions: &[StoredSubscription],
) -> io::Result<()> {
    let directory = providers_directory(state_dir);
    ensure_directory(&directory)?;
    write_subscriptions(&directory, &credentials_path(state_dir), subscriptions)
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
    /// Position in the operator's list; the tie-breaker.
    pub index: usize,
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
            }
        })
        .collect()
}

fn compare_ranked(left: &RankedSubscription, right: &RankedSubscription) -> std::cmp::Ordering {
    match (left.headroom, right.headroom) {
        (None, None) => left.index.cmp(&right.index),
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(left_value), Some(right_value)) => {
            if right_value != left_value {
                right_value
                    .partial_cmp(&left_value)
                    .unwrap_or(std::cmp::Ordering::Equal)
            } else {
                left.index.cmp(&right.index)
            }
        }
    }
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

    let go_candidates: Vec<RankedSubscription> = ranked
        .iter()
        .filter(|candidate| candidate.subscription.provider == ProviderId::OpenCodeGo)
        .cloned()
        .collect();
    let open_router_candidates: Vec<RankedSubscription> = ranked
        .iter()
        .filter(|candidate| candidate.subscription.provider == ProviderId::OpenRouter)
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

/// A path-safe, stable directory name for one selection.
pub fn selection_id(provider: ProviderId, subscription_id: &str) -> String {
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
    format!("{}-{}", provider.as_str(), String::from_utf16_lossy(&units))
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

/// The generated peer's MCP registration; the wrapper resolves the harness.
pub fn devboard_mcp_entry() -> Value {
    json!({
        "type": "stdio",
        "command": "sh",
        "args": [
            "-c",
            r##"exec bun "$(if [ -n "$DEVBOARD_HARNESS_DIR" ]; then printf '%s/mcp/index.ts' "$DEVBOARD_HARNESS_DIR"; elif [ -n "$PI_CODING_AGENT_DIR" ] && [ -f "$PI_CODING_AGENT_DIR/devboard-mcp.ts" ]; then printf '%s/devboard-mcp.ts' "$PI_CODING_AGENT_DIR"; elif [ -f .devboard/mcp/index.ts ]; then printf '%s' .devboard/mcp/index.ts; else printf '%s' .devboard/node_modules/@dsdenes/devboard/mcp/index.ts; fi)""##
        ]
    })
}

/// One peer role's MCP registration.
#[derive(Clone, Debug)]
pub struct AgentMcp {
    /// The `mcpServers` map written to `mcp.json`.
    pub servers: Value,
    /// The wrapper file the entry starts, written next to `mcp.json`.
    pub wrapper_name: String,
    pub wrapper: String,
}

pub fn devboard_harness_directory(repo_dir: &Path) -> PathBuf {
    let checkout = repo_dir.join(".devboard");
    if checkout.is_dir() {
        return checkout;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo_dir.to_path_buf())
}

pub fn default_agent_mcp(harness_dir: &Path) -> AgentMcp {
    AgentMcp {
        servers: json!({ DEVBOARD_MCP_SERVER: devboard_mcp_entry() }),
        wrapper_name: "devboard-mcp.ts".to_string(),
        wrapper: generated_mcp_wrapper(harness_dir),
    }
}

pub fn generated_mcp_config(mcp: &AgentMcp) -> String {
    let value = json!({ "mcpServers": mcp.servers.clone() });
    let mut text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text
}

/// The generated wrapper: it starts the harness's stdio server from any cwd.
pub fn generated_mcp_wrapper(harness_dir: &Path) -> String {
    let module = harness_dir.join("mcp").join("index.ts");
    let quoted = serde_json::to_string(&module.to_string_lossy()).unwrap_or_default();
    format!(
        "// Generated by devboard for one ACP peer. Do not edit.\nimport {{ startStdio }} from {quoted};\n\nawait startStdio();\n"
    )
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
pub fn write_agent_directory(directory: &Path, config: &str, mcp: &AgentMcp) -> io::Result<()> {
    std::fs::create_dir_all(directory)?;
    set_mode(directory, 0o700)?;
    write_file_atomic(&directory.join("config.yml"), config)?;
    write_file_atomic(&directory.join("mcp.json"), &generated_mcp_config(mcp))?;
    write_file_atomic(&directory.join(&mcp.wrapper_name), &mcp.wrapper)
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

/// The provider definition for a selection, for its model and env variable.
pub fn selected_provider(binding: &PeerBinding) -> &'static ProviderDefinition {
    provider_definition(binding.provider)
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
    let temporary = PathBuf::from(format!("{}.{}.tmp", target.display(), std::process::id()));
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
    let result = (|| -> io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        drop(file);
        set_mode(&temporary, 0o600)?;
        std::fs::rename(&temporary, &target)?;
        set_mode(&target, 0o600)
    })();
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

pub type SaveProviderResult = Result<(), String>;

struct ValidatedInput {
    provider: ProviderId,
    label: String,
    key: Option<String>,
}

struct Inner {
    subscriptions: Vec<StoredSubscription>,
    usage: HashMap<String, UsageReport>,
}

pub struct ProviderService {
    state_dir: PathBuf,
    repo_dir: PathBuf,
    harness_dir: PathBuf,
    base_env: Env,
    transport: Transport,
    now_ms: Now,
    usage_base_urls: HashMap<ProviderId, String>,
    log: Log,
    broadcast: Mutex<Option<Broadcast>>,
    inner: Mutex<Inner>,
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
        let harness_dir = devboard_harness_directory(&repo_dir);
        let base_env = options.env.unwrap_or_else(process_env);
        let timeout_ms = options.timeout_ms.unwrap_or(USAGE_TIMEOUT_MS);
        let transport = options
            .transport
            .unwrap_or_else(|| default_transport(timeout_ms));
        let now_ms = options.now_ms.unwrap_or_else(|| Arc::new(now_millis));
        let log = options.log.unwrap_or_else(|| Arc::new(|_: &str| {}));
        let loaded = load_subscriptions(&state_dir);
        if let Some(preserved) = &loaded.preserved {
            log(&format!(
                "providers: unusable credentials were preserved at {}",
                preserved.display()
            ));
        }
        Self {
            state_dir,
            repo_dir,
            harness_dir,
            base_env,
            transport,
            now_ms,
            usage_base_urls: options.usage_base_urls,
            log,
            broadcast: Mutex::new(options.broadcast),
            inner: Mutex::new(Inner {
                subscriptions: loaded.subscriptions,
                usage: HashMap::new(),
            }),
        }
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
        credentials_path(&self.state_dir)
    }

    /// The internal list, including keys; never serialize this.
    pub fn list(&self) -> Vec<StoredSubscription> {
        lock(&self.inner).subscriptions.clone()
    }

    /// Re-reads the credential file for a long-lived worker, keeping cached
    /// usage for an unchanged key and dropping it for a removed or replaced
    /// one.
    pub fn reload(&self) {
        let loaded = load_subscriptions(&self.state_dir);
        let next = loaded.subscriptions;
        let next_ids: std::collections::HashSet<&str> = next
            .iter()
            .map(|subscription| subscription.id.as_str())
            .collect();
        let mut inner = lock(&self.inner);
        inner.usage.retain(|id, _| next_ids.contains(id.as_str()));
        for subscription in &next {
            if let Some(previous) = inner
                .subscriptions
                .iter()
                .find(|entry| entry.id == subscription.id)
            {
                if previous.key != subscription.key || previous.provider != subscription.provider {
                    inner.usage.remove(&subscription.id);
                }
            }
        }
        inner.subscriptions = next;
        drop(inner);
        if let Some(preserved) = &loaded.preserved {
            (self.log)(&format!(
                "providers: unusable credentials were preserved at {}",
                preserved.display()
            ));
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

    async fn fetch_usage_for(&self, provider: ProviderId, key: &str) -> UsageReport {
        let base_url = self.base_url(provider);
        let now = (self.now_ms)();
        fetch_usage(provider, key, &base_url, &self.transport, now).await
    }

    /// Reads every subscription whose cached usage is older than the TTL, or
    /// all of them when the operator forces a refresh.
    pub async fn refresh(&self, force: bool) {
        let now = (self.now_ms)();
        let pending: Vec<StoredSubscription> = {
            let inner = lock(&self.inner);
            inner
                .subscriptions
                .iter()
                .filter(|subscription| {
                    if force {
                        return true;
                    }
                    match inner.usage.get(&subscription.id) {
                        None => true,
                        Some(cached) => now - cached.checked_at_ms >= USAGE_TTL_MS as i64,
                    }
                })
                .cloned()
                .collect()
        };
        let mut futures = Vec::new();
        for subscription in pending {
            let provider = subscription.provider;
            let key = subscription.key.clone();
            let id = subscription.id.clone();
            futures.push(async move {
                let report = self.fetch_usage_for(provider, &key).await;
                (id, key, report)
            });
        }
        let results = futures_util::future::join_all(futures).await;
        {
            let mut inner = lock(&self.inner);
            for (id, key, report) in results {
                let current = inner
                    .subscriptions
                    .iter()
                    .find(|subscription| subscription.id == id);
                if current.map(|subscription| subscription.key.as_str()) == Some(key.as_str()) {
                    inner.usage.insert(id, report);
                }
            }
        }
        self.publish_selection();
    }

    fn ranked(&self) -> Vec<RankedSubscription> {
        let inner = lock(&self.inner);
        rank_subscriptions(&inner.subscriptions, &inner.usage)
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
                &self.state_dir,
                subscription.provider,
                &subscription.id,
                &subscription.label,
                provider_definition(subscription.provider).model,
                usage.and_then(|usage| usage.remaining_fraction),
                &checked_at,
            ),
            ProviderDecision::Refused { .. } => {
                remove_selection_snapshot(&self.state_dir);
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
                refusal: Some(reason),
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
    /// first; an edit without a key only changes the label and enablement.
    pub async fn save(&self, input: SaveProviderInput) -> SaveProviderResult {
        let validated = self.validated(&input)?;
        let existing = match &input.id {
            Some(id) => lock(&self.inner)
                .subscriptions
                .iter()
                .find(|subscription| &subscription.id == id)
                .cloned(),
            None => None,
        };
        if input.id.is_some() && existing.is_none() {
            return Err("That subscription no longer exists.".to_string());
        }

        let key = validated
            .key
            .clone()
            .or_else(|| existing.as_ref().map(|entry| entry.key.clone()));
        let Some(key) = key else {
            return Err("An API key is required.".to_string());
        };

        let mut checked = None;
        if validated.key.is_some() {
            let report = self.fetch_usage_for(validated.provider, &key).await;
            if report.status == UsageStatus::Invalid {
                return Err(report
                    .error
                    .clone()
                    .unwrap_or_else(|| "The provider rejected this key.".to_string()));
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

        let mut inner = lock(&self.inner);
        let next = match &existing {
            None => {
                let mut next = inner.subscriptions.clone();
                next.push(subscription.clone());
                next
            }
            Some(_) => inner
                .subscriptions
                .iter()
                .map(|entry| {
                    if entry.id == id {
                        subscription.clone()
                    } else {
                        entry.clone()
                    }
                })
                .collect(),
        };
        if let Err(error) = save_subscriptions(&self.state_dir, &next) {
            return Err(format!(
                "The credentials file could not be written: {error}"
            ));
        }
        inner.subscriptions = next;
        if let Some(existing) = &existing {
            if existing.key != subscription.key {
                inner.usage.remove(&id);
            }
        }
        if let Some(report) = checked {
            inner.usage.insert(id, report);
        }
        drop(inner);

        self.publish_selection();
        Ok(())
    }

    pub fn remove(&self, id: &str) -> SaveProviderResult {
        let mut inner = lock(&self.inner);
        let next: Vec<StoredSubscription> = inner
            .subscriptions
            .iter()
            .filter(|subscription| subscription.id != id)
            .cloned()
            .collect();
        if next.len() == inner.subscriptions.len() {
            return Err("That subscription no longer exists.".to_string());
        }
        if let Err(error) = save_subscriptions(&self.state_dir, &next) {
            return Err(format!(
                "The credentials file could not be written: {error}"
            ));
        }
        inner.subscriptions = next;
        inner.usage.remove(id);
        drop(inner);
        self.publish_selection();
        Ok(())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> SaveProviderResult {
        let mut inner = lock(&self.inner);
        let Some(existing) = inner
            .subscriptions
            .iter()
            .find(|subscription| subscription.id == id)
            .cloned()
        else {
            return Err("That subscription no longer exists.".to_string());
        };
        let updated_at = iso_timestamp((self.now_ms)());
        let next: Vec<StoredSubscription> = inner
            .subscriptions
            .iter()
            .map(|subscription| {
                if subscription.id == existing.id {
                    StoredSubscription {
                        enabled,
                        updated_at: updated_at.clone(),
                        ..subscription.clone()
                    }
                } else {
                    subscription.clone()
                }
            })
            .collect();
        if let Err(error) = save_subscriptions(&self.state_dir, &next) {
            return Err(format!(
                "The credentials file could not be written: {error}"
            ));
        }
        inner.subscriptions = next;
        drop(inner);
        self.publish_selection();
        Ok(())
    }

    /// Resolves the peer binding. Refuses before any process exists when no
    /// subscription can serve a peer.
    pub async fn select(&self) -> Result<PeerBinding, ProviderUnavailable> {
        self.refresh(false).await;
        let ranked = self.ranked();
        let decision = decide_provider(&ranked, !ranked.is_empty());
        let (subscription, usage, fallback) = match decision {
            ProviderDecision::Refused { reason } => return Err(ProviderUnavailable::new(reason)),
            ProviderDecision::Selected {
                subscription,
                usage,
                fallback,
                ..
            } => (subscription, usage, fallback),
        };

        let provider = subscription.provider;
        let model = provider_definition(provider).model;
        let directory = agent_directory(&self.state_dir, provider, &subscription.id);
        write_agent_directory(
            &directory,
            &generated_config(provider, model),
            &default_agent_mcp(&self.harness_dir),
        )
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
        binding.env = peer_environment(
            &self.base_env,
            &binding,
            &subscription.key,
            fallback.as_ref().map(|entry| entry.key.as_str()),
        );
        Ok(binding)
    }

    /// The environment one ACP peer receives for the current selection.
    pub async fn select_environment(&self) -> Result<Env, ProviderUnavailable> {
        self.select().await.map(|binding| binding.env)
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
                // A query answers its own client; only a change or an explicit
                // refresh publishes to every client.
                self.refresh(false).await;
                conn.send(self.state_frame());
                true
            }
            Command::RefreshProviders => {
                self.refresh(true).await;
                self.push_state(conn);
                true
            }
            Command::SaveProvider {
                request_id,
                id,
                provider,
                label,
                key,
            } => {
                if !request_id
                    .as_ref()
                    .map(is_provider_request_id)
                    .unwrap_or(false)
                {
                    conn.send(provider_error_frame(None, PROVIDER_CHANGE_NEEDS_ID));
                    return true;
                }
                let input = SaveProviderInput {
                    id: id.as_ref().and_then(Value::as_str).map(str::to_string),
                    provider: provider.clone(),
                    label: label.clone(),
                    key: key.clone(),
                };
                let result = self.save(input).await;
                self.settle(conn, request_id.as_ref(), result).await;
                true
            }
            Command::DeleteProvider { request_id, id } => {
                let Some(id) = id.as_ref().and_then(Value::as_str) else {
                    conn.send(provider_error_frame(
                        request_id.as_ref(),
                        "A delete needs the subscription id.",
                    ));
                    return true;
                };
                if !request_id
                    .as_ref()
                    .map(is_provider_request_id)
                    .unwrap_or(false)
                {
                    conn.send(provider_error_frame(None, PROVIDER_CHANGE_NEEDS_ID));
                    return true;
                }
                let result = self.remove(id);
                self.settle(conn, request_id.as_ref(), result).await;
                true
            }
            Command::SetProviderEnabled {
                request_id,
                id,
                enabled,
            } => {
                let id = id.as_ref().and_then(Value::as_str);
                let enabled = enabled.as_ref().and_then(Value::as_bool);
                let (Some(id), Some(enabled)) = (id, enabled) else {
                    conn.send(provider_error_frame(
                        request_id.as_ref(),
                        "Enabling a subscription needs its id and a boolean.",
                    ));
                    return true;
                };
                if !request_id
                    .as_ref()
                    .map(is_provider_request_id)
                    .unwrap_or(false)
                {
                    conn.send(provider_error_frame(None, PROVIDER_CHANGE_NEEDS_ID));
                    return true;
                }
                let result = self.set_enabled(id, enabled);
                self.settle(conn, request_id.as_ref(), result).await;
                true
            }
            _ => false,
        }
    }

    async fn settle(&self, conn: &Conn, request_id: Option<&Value>, result: SaveProviderResult) {
        match result {
            Ok(()) => {
                let request_id = request_id.cloned().unwrap_or(Value::Null);
                conn.send(json!({"type": "providerChanged", "requestId": request_id}));
                self.refresh(false).await;
                self.push_state(conn);
            }
            Err(message) => conn.send(provider_error_frame(request_id, &message)),
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

pub fn provider_error_frame(request_id: Option<&Value>, message: &str) -> Value {
    let mut object = Map::new();
    object.insert(
        "type".to_string(),
        Value::String("providerError".to_string()),
    );
    if let Some(request_id) = request_id {
        object.insert("requestId".to_string(), request_id.clone());
    }
    object.insert("message".to_string(), Value::String(message.to_string()));
    Value::Object(object)
}

// ---------------------------------------------------------------------------
// Worker environment

/// A worker-scoped resolver: one service keeps usage cached for its TTL,
/// while every call re-reads the credential file.
pub struct WorkerProviderEnvironment {
    state_dir: PathBuf,
    repo_dir: PathBuf,
    environment: Env,
    options: ProviderOptions,
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
        Self {
            state_dir: state_dir.as_ref().to_path_buf(),
            repo_dir: repo_dir.as_ref().to_path_buf(),
            environment,
            options,
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
        if service.list().is_empty() {
            let state = lock(&self.state);
            if state.configured {
                return Err(ProviderUnavailable::new(NO_PROVIDER_CONFIGURED));
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
    if load_subscriptions(state_dir).subscriptions.is_empty() {
        return Ok(environment);
    }
    options.env = Some(environment);
    let service = ProviderService::with_options(state_dir, repo_dir, options);
    Ok(service.select().await?.env)
}

// ---------------------------------------------------------------------------
// Peers

#[derive(Clone, Default)]
pub struct OpenCodePeerOptions {
    /// Names the requester in a refusal, e.g. "the finalizer".
    pub subject: String,
    /// Distinguishes this role's generated agent directory from other roles'.
    pub agent_suffix: Option<String>,
    /// The MCP registration the generated directory carries.
    pub mcp: Option<AgentMcp>,
    /// Transport and clock seams; usage is not consulted here.
    pub options: ProviderOptions,
}

/// One binding per enabled OpenCode Go subscription, in the operator's list
/// order, each pinned to the Go model. An enabled OpenRouter subscription
/// supplies the fallback chain's key when one exists.
pub fn open_code_peer_bindings(
    state_dir: &Path,
    repo_dir: &Path,
    environment: &Env,
    options: &OpenCodePeerOptions,
) -> Result<Vec<PeerBinding>, String> {
    let mut settings = options.options.clone();
    settings.env = Some(environment.clone());
    let service = ProviderService::with_options(state_dir, repo_dir, settings);
    let subscriptions = service.list();
    let mut candidates: Vec<StoredSubscription> = subscriptions
        .iter()
        .filter(|entry| entry.provider == ProviderId::OpenCodeGo && entry.enabled)
        .cloned()
        .collect();
    if candidates.is_empty() {
        return Err(format!(
            "{} needs an enabled OpenCode Go subscription; add one in the Providers dialog (settings.providers)",
            options.subject
        ));
    }

    if let Some(snapshot) = read_selection_snapshot(state_dir) {
        if snapshot.provider == ProviderId::OpenCodeGo {
            if let Some(preferred) = candidates
                .iter()
                .position(|entry| entry.id == snapshot.subscription_id)
            {
                if preferred > 0 {
                    let entry = candidates.remove(preferred);
                    candidates.insert(0, entry);
                }
            }
        }
    }

    let fallback = subscriptions
        .iter()
        .find(|entry| entry.provider == ProviderId::OpenRouter && entry.enabled)
        .cloned();
    let harness_dir = devboard_harness_directory(repo_dir);
    let mcp = options
        .mcp
        .clone()
        .unwrap_or_else(|| default_agent_mcp(&harness_dir));

    let mut bindings = Vec::new();
    for subscription in candidates {
        let subscription_id = match &options.agent_suffix {
            None => subscription.id.clone(),
            Some(suffix) => format!("{}-{suffix}", subscription.id),
        };
        let directory = agent_directory(state_dir, ProviderId::OpenCodeGo, &subscription_id);
        write_agent_directory(
            &directory,
            &generated_config(ProviderId::OpenCodeGo, OPENCODE_GO_MODEL),
            &mcp,
        )
        .map_err(|error| {
            format!(
                "{} agent directory could not be written: {error}",
                options.subject
            )
        })?;
        let mut binding = PeerBinding {
            provider: ProviderId::OpenCodeGo,
            provider_name: OPENCODE_GO.name,
            subscription_id: subscription.id.clone(),
            subscription_label: subscription.label.clone(),
            model: OPENCODE_GO_MODEL.to_string(),
            remaining_fraction: None,
            agent_dir: directory,
            env: Env::new(),
        };
        binding.env = peer_environment(
            environment,
            &binding,
            &subscription.key,
            fallback.as_ref().map(|entry| entry.key.as_str()),
        );
        bindings.push(binding);
    }
    Ok(bindings)
}
