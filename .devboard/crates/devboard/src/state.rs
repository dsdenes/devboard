//! Durable dashboard state for one host repository.
//!
//! The server writes the whole state before it broadcasts any event, so a
//! replacement restores exactly what a client has already seen. One file per
//! repository keys the state like the journal, so two repositories that share
//! a harness never read each other's state.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Envelope version. A file with another version is preserved, never read.
pub const STATE_VERSION: u32 = 1;

/// Restored activity is bounded to the first of these limits.
pub const ACTIVITY_MAX_ENTRIES: usize = 1000;
pub const ACTIVITY_MAX_BYTES: usize = 1024 * 1024;
pub const ACTIVITY_TRIMMED_MARKER: &str = "Earlier activity was trimmed.";

/// Total serialized state one repository may keep.
pub const STATE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// The state file under one state directory, keyed like every other project
/// state directory.
pub fn state_file(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    state_dir
        .join("state")
        .join(format!("{}.json", crate::journal::repo_key(repo_dir)))
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

/// The mode a document the writer creates carries: private to its owner, never
/// the process umask default. The same writer stores the project OMP settings,
/// which can carry `mcpServers` environment values.
#[cfg(unix)]
const CREATED_FILE_MODE: u32 = 0o600;

/// The mode bits that survive a rename onto the destination, without the file
/// type bits `st_mode` also carries.
#[cfg(unix)]
fn permission_bits(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o7777
}

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
        write_staged_file(&temporary, text)?;
        carry_destination_mode(path, &temporary)?;
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
        write_staged_file_async(&temporary, text).await?;
        carry_destination_mode_async(path, &temporary).await?;
        tokio::fs::rename(&temporary, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

/// Creates the staging document with the private mode a fresh document gets.
fn write_staged_file(temporary: &Path, text: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(CREATED_FILE_MODE)
            .open(temporary)?;
        // A umask can only clear the requested bits, so restore the exact mode
        // the writer promises a document it creates.
        file.set_permissions(std::fs::Permissions::from_mode(CREATED_FILE_MODE))?;
        file.write_all(text.as_bytes())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(temporary, text)
    }
}

/// The asynchronous counterpart of [`write_staged_file`].
async fn write_staged_file_async(temporary: &Path, text: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(CREATED_FILE_MODE)
            .open(temporary)
            .await?;
        tokio::fs::set_permissions(
            temporary,
            std::fs::Permissions::from_mode(CREATED_FILE_MODE),
        )
        .await?;
        file.write_all(text.as_bytes()).await
    }
    #[cfg(not(unix))]
    {
        tokio::fs::write(temporary, text).await
    }
}

/// Carries the destination's own mode onto the staging file before the rename,
/// so a document the host made private is never widened by a rewrite. A
/// destination that does not exist keeps the private mode of a fresh document,
/// and an unreadable one is never widened either.
fn carry_destination_mode(destination: &Path, staged: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(destination) {
            std::fs::set_permissions(
                staged,
                std::fs::Permissions::from_mode(permission_bits(&metadata)),
            )?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (destination, staged);
    }
    Ok(())
}

/// The asynchronous counterpart of [`carry_destination_mode`].
async fn carry_destination_mode_async(destination: &Path, staged: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = tokio::fs::metadata(destination).await {
            tokio::fs::set_permissions(
                staged,
                std::fs::Permissions::from_mode(permission_bits(&metadata)),
            )
            .await?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (destination, staged);
    }
    Ok(())
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

    #[cfg(unix)]
    fn fixture(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("state-mode-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a fixture root");
        root
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .expect("the document")
            .permissions()
            .mode()
            & 0o777
    }

    #[cfg(unix)]
    fn make_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .expect("the document's mode");
    }

    #[cfg(unix)]
    #[test]
    fn a_sync_write_creates_private_and_carries_the_destination_mode() {
        let root = fixture("sync");
        let path = root.join("state.json");

        write_state_file(&path, "{\"a\":1}").expect("a fresh document");
        assert_eq!(mode_of(&path), 0o600);

        make_mode(&path, 0o640);
        write_state_file(&path, "{\"a\":2}").expect("a rewrite");
        assert_eq!(mode_of(&path), 0o640);
        assert_eq!(
            std::fs::read_to_string(&path).expect("the document"),
            "{\"a\":2}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_async_write_creates_private_and_carries_the_destination_mode() {
        let root = fixture("async");
        let path = root.join("state.json");

        write_file_atomically(&path, "{\"a\":1}")
            .await
            .expect("a fresh document");
        assert_eq!(mode_of(&path), 0o600);

        make_mode(&path, 0o600);
        write_file_atomically(&path, "{\"a\":2}")
            .await
            .expect("a rewrite");
        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(
            std::fs::read_to_string(&path).expect("the document"),
            "{\"a\":2}"
        );
    }
}
