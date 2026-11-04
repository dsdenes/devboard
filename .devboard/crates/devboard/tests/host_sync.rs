//! Install/update host sync: changed package files are written, stale shipped
//! files are removed, and a tracked host file is preserved as drift.

use std::path::{Path, PathBuf};

fn package_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn host(label: &str) -> PathBuf {
    let root = package_dir()
        .join(".test-tmp")
        .join(format!("host-sync-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".devboard")).unwrap();
    root
}

fn shipped_command() -> PathBuf {
    package_dir().join("omp/commands/implement-issue.md")
}

#[test]
fn changed_wrappers_are_written_and_stale_untracked_files_are_removed() {
    let root = host("sync");
    let report = devboard::cli_install::install(Some(&root), false).unwrap();
    assert!(report.removed == 0);

    let command = root.join(".omp/commands/implement-issue.md");
    std::fs::write(&command, b"host changed\n").unwrap();
    let stale = root.join(".omp/commands/renamed-away.md");
    std::fs::write(&stale, b"stale command\n").unwrap();

    let report = devboard::cli_install::install(Some(&root), false).unwrap();
    assert_eq!(
        std::fs::read(&command).unwrap(),
        std::fs::read(shipped_command()).unwrap()
    );
    assert!(!stale.exists(), "a stale untracked command is removed");
    assert!(report.removed >= 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_tracked_payload_file_is_preserved_and_reported_as_drift() {
    let root = host("tracked");
    devboard::cli_install::install(Some(&root), false).unwrap();
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["init", "--quiet"])
        .status()
        .unwrap()
        .success());
    let prompt = root.join(".devboard/prompts/forge-auth.md");
    let original = std::fs::read(&prompt).unwrap();
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["add", "-f", ".devboard/prompts/forge-auth.md"])
        .status()
        .unwrap()
        .success());

    // Change the package copy by changing the host copy: the next install
    // sees a differing tracked file and leaves the bytes alone.
    std::fs::write(&prompt, b"host tracked content\n").unwrap();
    let report = devboard::cli_install::install(Some(&root), false).unwrap();
    assert_eq!(std::fs::read(&prompt).unwrap(), b"host tracked content\n");
    assert!(report
        .drift
        .iter()
        .any(|entry| entry.contains(".devboard/prompts/forge-auth.md")));
    assert_ne!(std::fs::read(&prompt).unwrap(), original);
    let _ = std::fs::remove_dir_all(&root);
}
