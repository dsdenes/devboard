//! Durable paths and the lease every detached run watches.

use std::path::{Path, PathBuf};

use crate::journal::journal_key;

/// The root of every detached run for one repository.
pub fn detached_runs_root(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    absolute(state_dir)
        .join("runs")
        .join(journal_key(&absolute(repo_dir)))
}

/// The lease that tells a detached run whether its owner is still alive.
pub fn detached_run_lease_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    detached_runs_root(state_dir, repo_dir).join("lease.json")
}

/// The handoff record a replacement leaves for the runs it inherited.
pub fn detached_run_handoff_path(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    detached_runs_root(state_dir, repo_dir).join("handoff.json")
}

/// Writes one JSON document atomically with a trailing newline.
pub fn write_json(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        rand_suffix()
    ));
    let mut text = crate::jsjson::stringify(value);
    text.push('\n');
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, path)
}

fn rand_suffix() -> u32 {
    rand::random()
}

/// The current instance's lease, refreshed while the process lives.
pub fn write_detached_lease(
    state_dir: &Path,
    repo_dir: &Path,
    instance: &str,
) -> std::io::Result<()> {
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    write_json(
        &detached_run_lease_path(state_dir, repo_dir),
        &serde_json::json!({
            "pid": std::process::id(),
            "instance": instance,
            "updatedAt": updated_at,
        }),
    )
}

/// The absolute form of one path, without resolving symlinks.
pub fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}
