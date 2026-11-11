//! The goal document: one Markdown file the operator and a peer revise.

use std::path::{Path, PathBuf};

/// The goal document's name at the repository root.
const GOAL_FILE_NAME: &str = "GOAL.md";

/// The repository's own goal document.
pub fn default_goal_path(repo_dir: &Path) -> PathBuf {
    repo_dir.join(GOAL_FILE_NAME)
}

/// Reads the goal document.
///
/// An absent document is `NotFound`: the state a dashboard reports as no goal
/// yet. Every other failure — a directory in its place, a document the process
/// may not read, bytes that are not UTF-8 — is returned as the read produced
/// it, so a broken document is never served as an empty goal.
pub async fn read_goal(path: &Path) -> std::io::Result<String> {
    tokio::fs::read_to_string(path).await
}

/// Replaces the goal document wholesale, staging beside it and renaming into
/// place so a reader never observes a partial document.
pub async fn write_goal(path: &Path, text: &str) -> std::io::Result<()> {
    crate::state::write_file_atomically(path, text).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("goal-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a scratch directory");
        root
    }

    #[tokio::test]
    async fn an_absent_document_is_not_found() {
        let root = scratch("absent");
        let error = read_goal(&root.join(GOAL_FILE_NAME))
            .await
            .expect_err("an absent goal document is an error");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_document_that_is_a_directory_is_never_reported_missing() {
        let root = scratch("directory");
        let path = root.join(GOAL_FILE_NAME);
        std::fs::create_dir(&path).expect("a goal path that is a directory");
        let error = read_goal(&path)
            .await
            .expect_err("a directory is not a goal document");
        assert_ne!(
            error.kind(),
            std::io::ErrorKind::NotFound,
            "a directory in the document's place is not an absent document: {error}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn bytes_that_are_not_utf8_are_never_reported_missing() {
        let root = scratch("bytes");
        let path = root.join(GOAL_FILE_NAME);
        std::fs::write(&path, [0xff, 0xfe, 0x80]).expect("a fixture");
        let error = read_goal(&path)
            .await
            .expect_err("bytes that are not UTF-8 are not a goal document");
        assert_ne!(
            error.kind(),
            std::io::ErrorKind::NotFound,
            "an undecodable document is not an absent document: {error}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_permission_denied_document_is_reported_as_denied() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch("denied");
        let path = root.join(GOAL_FILE_NAME);
        std::fs::write(&path, "# Goal\n").expect("a fixture");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000))
            .expect("a document the process may not read");
        let outcome = read_goal(&path).await;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        match outcome {
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied),
            // A process that may read every file (a root test runner) cannot
            // observe EACCES; the directory case covers that same arm.
            Ok(text) => assert_eq!(text, "# Goal\n"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
