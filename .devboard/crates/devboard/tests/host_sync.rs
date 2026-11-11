//! Install/update host sync: changed package files are written, stale shipped
//! files are removed, and a tracked host file is preserved as drift.

use std::collections::BTreeMap;
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

    let report = devboard::cli_install::install(Some(&root), true).unwrap();
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
    // A tracked wrapper belongs to the host: the install leaves it and reports
    // the drift instead of refusing or replacing it.
    let command = root.join(".omp/commands/implement-issue.md");
    let original = std::fs::read(&command).unwrap();
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["add", "-f", ".omp/commands/implement-issue.md"])
        .status()
        .unwrap()
        .success());

    std::fs::write(&command, b"host tracked content\n").unwrap();
    let report = devboard::cli_install::install(Some(&root), false).unwrap();
    assert_eq!(std::fs::read(&command).unwrap(), b"host tracked content\n");
    assert!(report
        .drift
        .iter()
        .any(|entry| entry.contains(".omp/commands/implement-issue.md")));
    assert_ne!(std::fs::read(&command).unwrap(), original);
    let _ = std::fs::remove_dir_all(&root);
}

/// Names of the package-owned marked skill directories directly under `root`,
/// sorted, so a host's own unmarked skill never enters the comparison.
fn marked_skills(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .expect("a skills directory")
        .map(|entry| entry.expect("a skill entry"))
        .filter(|entry| entry.file_type().expect("an entry type").is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("devboard-"))
        .collect();
    names.sort();
    names
}

/// Every regular file under `root`, keyed by its `/`-separated relative path.
/// A symlink or any other non-file entry fails: an installed tree holds real
/// files only.
fn tree_files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, directory: &Path, files: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(directory).expect("a skill directory") {
            let entry = entry.expect("a skill entry");
            let path = entry.path();
            let relative = path
                .strip_prefix(base)
                .expect("a path under the skill root")
                .to_string_lossy()
                .into_owned();
            let meta = std::fs::symlink_metadata(&path).expect("a skill entry");
            if meta.is_dir() {
                walk(base, &path, files);
            } else {
                assert!(meta.is_file(), "{} is not a real file", path.display());
                files.insert(relative, std::fs::read(&path).expect("a skill file"));
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

/// The tracked `.omp/` tree is the copy omp loads at this root, and no install
/// or update path refreshes it: every shipped marked skill must match byte for
/// byte, and a skill the package dropped must not linger in the mirror.
#[test]
fn the_tracked_mirror_matches_every_shipped_skill() {
    let canonical_root = package_dir().join("omp/skills");
    let mirror_root = package_dir().join("../.omp/skills");
    let shipped = marked_skills(&canonical_root);
    assert!(!shipped.is_empty(), "the package ships no marked skill");
    assert_eq!(
        shipped,
        marked_skills(&mirror_root),
        ".omp/skills does not mirror the marked skills the package ships"
    );

    for name in shipped {
        let label = format!(".omp/skills/{name}");
        let expected = tree_files(&canonical_root.join(&name));
        let actual = tree_files(&mirror_root.join(&name));
        let expected_paths: Vec<&String> = expected.keys().collect();
        let actual_paths: Vec<&String> = actual.keys().collect();
        assert_eq!(
            expected_paths, actual_paths,
            "{label} lists a different set of files than the canonical skill"
        );
        for (relative, bytes) in &expected {
            let mirrored = &actual[relative];
            assert_eq!(
                bytes.len(),
                mirrored.len(),
                "{label}/{relative} differs in length from the canonical skill"
            );
            if let Some(offset) = bytes
                .iter()
                .zip(mirrored)
                .position(|(left, right)| left != right)
            {
                panic!("{label}/{relative} differs from the canonical skill at byte {offset}");
            }
        }
    }
}
