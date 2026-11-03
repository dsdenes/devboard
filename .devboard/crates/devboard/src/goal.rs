//! The goal document: one Markdown file the operator and a peer revise.

use std::path::{Path, PathBuf};

/// The goal document's name at the repository root.
const GOAL_FILE_NAME: &str = "GOAL.md";

/// The repository's own goal document.
pub fn default_goal_path(repo_dir: &Path) -> PathBuf {
    repo_dir.join(GOAL_FILE_NAME)
}

/// Reads the goal document.
pub async fn read_goal(path: &Path) -> std::io::Result<String> {
    tokio::fs::read_to_string(path).await
}

/// Replaces the goal document wholesale, staging beside it and renaming into
/// place so a reader never observes a partial document.
pub async fn write_goal(path: &Path, text: &str) -> std::io::Result<()> {
    crate::state::write_file_atomically(path, text).await
}
