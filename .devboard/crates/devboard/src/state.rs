//! Durable dashboard state for one host repository.
//!
//! The server writes the whole state before it broadcasts any event, so a
//! replacement restores exactly what a client has already seen. One file per
//! repository keys the state like the journal, so two repositories that share
//! a harness never read each other's state.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

/// Envelope version. A file with another version is preserved, never read.
pub const STATE_VERSION: u32 = 1;

/// Restored activity is bounded to the first of these limits.
pub const ACTIVITY_MAX_ENTRIES: usize = 1000;
pub const ACTIVITY_MAX_BYTES: usize = 1024 * 1024;
pub const ACTIVITY_TRIMMED_MARKER: &str = "Earlier activity was trimmed.";

/// Total serialized state one repository may keep.
pub const STATE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// The 24-hex repository key that names this repository's state file.
pub fn state_key(repo_dir: &Path) -> String {
    let digest = Sha256::digest(repo_dir.to_string_lossy().as_bytes());
    hex::encode(digest)[..24].to_string()
}

/// The state file under one state directory.
pub fn state_file(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    state_dir
        .join("state")
        .join(format!("{}.json", state_key(repo_dir)))
}

/// The outcome of reading one state file.
pub enum StateLoad {
    Missing,
    Loaded(serde_json::Value),
    Damaged {
        reason: String,
        preserved: Option<PathBuf>,
    },
}

/// Moves unusable bytes aside so they are never overwritten or deleted.
pub fn preserve_state_file(path: &Path) -> Option<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let aside = PathBuf::from(format!("{}.damaged-{stamp}", path.display()));
    std::fs::rename(path, &aside).ok().map(|_| aside)
}

/// Reads and validates one state file.
pub fn read_state_file(path: &Path) -> StateLoad {
    let source = match std::fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return StateLoad::Missing,
        Err(error) => {
            return StateLoad::Damaged {
                reason: format!("could not read {}: {error}", path.display()),
                preserved: preserve_state_file(path),
            }
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&source) {
        Ok(value) => value,
        Err(error) => {
            return StateLoad::Damaged {
                reason: format!("the state file is not valid JSON: {error}"),
                preserved: preserve_state_file(path),
            }
        }
    };
    let Some(envelope) = parsed.as_object() else {
        return StateLoad::Damaged {
            reason: "the state file is not a state envelope".to_string(),
            preserved: preserve_state_file(path),
        };
    };
    let version = envelope.get("version");
    if version.and_then(serde_json::Value::as_u64) != Some(STATE_VERSION as u64) {
        let reason = match version {
            Some(serde_json::Value::Number(number)) => {
                format!("the state file has unsupported version {number}")
            }
            _ => "the state file has no version".to_string(),
        };
        return StateLoad::Damaged {
            reason,
            preserved: preserve_state_file(path),
        };
    }
    let Some(value) = envelope.get("state").filter(|value| value.is_object()) else {
        return StateLoad::Damaged {
            reason: "the state envelope holds no state".to_string(),
            preserved: preserve_state_file(path),
        };
    };
    StateLoad::Loaded(value.clone())
}

/// The state a dashboard writes before any flow has a section: every key the
/// TypeScript `captureState` always carries, in its key order.
pub fn default_state() -> serde_json::Value {
    serde_json::json!({
        "lifecycle": {"stage": "goal", "pass": 1, "work": null, "paused": false},
        "lastLifecycle": null,
        "lifecycleRunning": false,
        "lifecyclePausedForManualRun": false,
        "laneSequence": 0,
        "lanes": [],
        "epicStates": [],
        "parkedEpics": [],
        "knownEpics": [],
        "generationQueued": false,
        "generationAttempted": false,
        "manualSequencing": false,
        "manualRun": null,
        "goalCreation": null,
        "goalRevision": null,
        "skillsPreparation": null,
        "skillsPreparationPending": null,
        "resetActive": false,
        "restartWhenIdle": false,
        "discover": null,
        "discoverInterrupted": false,
        "discoverTarget": null,
        "children": [],
    })
}

/// The state envelope text for one state value.
pub fn state_envelope(state: &serde_json::Value) -> String {
    let mut envelope = serde_json::Map::new();
    envelope.insert("version".into(), STATE_VERSION.into());
    envelope.insert("state".into(), state.clone());
    crate::jsjson::stringify(&serde_json::Value::Object(envelope))
}

/// The synchronous atomic write: staged beside the destination, then renamed.
pub fn write_file_atomically_sync(path: &Path, text: &str) -> std::io::Result<()> {
    write_state_file(path, text)
}

/// Orders staged writes so no two share a staging path.
static STAGED_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Replaces the state file atomically.
pub fn write_state_file(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let sequence = STAGED_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        sequence
    ));
    let result = (|| {
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// The asynchronous counterpart of [`write_state_file`], with a staging path
/// unique to this write.
pub async fn write_file_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let sequence = STAGED_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        sequence
    ));
    let result = async {
        tokio::fs::write(&temporary, text).await?;
        tokio::fs::rename(&temporary, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_envelope_round_trips() {
        let value = serde_json::json!({"goal": "text"});
        let text = state_envelope(&value);
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
        assert_eq!(parsed["version"], STATE_VERSION);
        assert_eq!(parsed["state"], value);
    }
}
