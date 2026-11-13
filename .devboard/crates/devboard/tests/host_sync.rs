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
        for entry in std::fs::read_dir(directory).expect("a shipped directory") {
            let entry = entry.expect("a shipped entry");
            let path = entry.path();
            let relative = path
                .strip_prefix(base)
                .expect("a path under the shipped root")
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
/// or update path refreshes it: every path the package ships under `omp/` must
/// match byte for byte, and a marked skill the package dropped must not linger
/// in the mirror. Entries the package does not ship belong to the host — its
/// own unmarked skills and `.omp/config.yml` — and stay out of scope.
#[test]
fn the_tracked_mirror_matches_every_shipped_path() {
    let canonical_root = package_dir().join("omp");
    let mirror_root = package_dir().join("../.omp");

    let shipped = tree_files(&canonical_root);
    assert!(!shipped.is_empty(), "the package ships no file under omp/");
    for (relative, bytes) in &shipped {
        let label = format!(".omp/{relative}");
        let mirrored = mirror_root.join(relative);
        let metadata = std::fs::symlink_metadata(&mirrored).unwrap_or_else(|error| {
            panic!("{label} is missing ({error}); run `.devboard/install.sh --force`")
        });
        assert!(
            !metadata.file_type().is_symlink(),
            "{label} is a symlink, not an installed copy"
        );
        assert!(metadata.is_file(), "{label} is not a real file");
        let installed = std::fs::read(&mirrored).expect("an installed copy");
        assert_eq!(
            bytes.len(),
            installed.len(),
            "{label} differs in length from .devboard/omp/{relative}"
        );
        if let Some(offset) = bytes
            .iter()
            .zip(&installed)
            .position(|(left, right)| left != right)
        {
            panic!("{label} differs from .devboard/omp/{relative} at byte {offset}");
        }
    }

    let canonical_skills = canonical_root.join("skills");
    let mirror_skills = mirror_root.join("skills");
    let shipped = marked_skills(&canonical_skills);
    assert!(!shipped.is_empty(), "the package ships no marked skill");
    assert_eq!(
        shipped,
        marked_skills(&mirror_skills),
        ".omp/skills does not mirror the marked skills the package ships"
    );

    // The bytes of every shipped file are already compared above; what remains
    // is an extra file inside a shipped skill, which an install prunes.
    for name in shipped {
        let label = format!(".omp/skills/{name}");
        let expected = tree_files(&canonical_skills.join(&name));
        let actual = tree_files(&mirror_skills.join(&name));
        let expected_paths: Vec<&String> = expected.keys().collect();
        let actual_paths: Vec<&String> = actual.keys().collect();
        assert_eq!(
            expected_paths, actual_paths,
            "{label} lists a different set of files than the canonical skill"
        );
    }
}
