//! Install and doctor behavior against a scratch host.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use devboard::cli_install::{self, AgentsOutcome};

fn package_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let root = package_dir()
            .join(".test-tmp")
            .join(format!("install-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".devboard")).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        Self { root }
    }

    fn host(&self) -> &Path {
        &self.root
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    collect(root, Path::new(""), &mut out);
    out
}

fn collect(root: &Path, prefix: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
    let Ok(entries) = fs::read_dir(root.join(prefix)) else {
        return;
    };
    for entry in entries {
        let entry = entry.unwrap();
        let relative = prefix.join(entry.file_name());
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            collect(root, &relative, out);
            continue;
        }
        out.insert(relative, fs::read(entry.path()).unwrap());
    }
}

fn gitignore_lines(host: &Path) -> Vec<String> {
    fs::read_to_string(host.join(".gitignore"))
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

fn assert_real_file(path: &Path) {
    let meta = fs::symlink_metadata(path).unwrap_or_else(|error| {
        panic!("{} is missing: {error}", path.display());
    });
    assert!(
        meta.is_file() && !meta.file_type().is_symlink(),
        "{} is not a real file",
        path.display()
    );
}

#[test]
fn install_writes_real_files_and_one_gitignore_line_per_skill() {
    let scratch = Scratch::new("fresh");
    let host = scratch.host();
    let report = cli_install::install(Some(host), false).unwrap();
    assert_eq!(report.agents, AgentsOutcome::Installed);
    assert_eq!(report.skills, cli_install::managed_skill_names().to_vec());
    assert!(!report.skills.is_empty());
    assert!(report.installed_files > 0);

    let omp = host.join(".omp");
    for relative in [
        "commands/adr-resolve.md",
        "extensions/implement-goal-issue.ts",
        "config.yml",
        "mcp.json",
    ] {
        assert_real_file(&omp.join(relative));
    }
    for name in cli_install::managed_skill_names() {
        let dir = omp.join("skills").join(name);
        let meta = fs::symlink_metadata(&dir).unwrap();
        assert!(
            meta.is_dir() && !meta.file_type().is_symlink(),
            "{name} is a real directory"
        );
        assert_real_file(&dir.join("SKILL.md"));
    }
    assert_real_file(&omp.join("skills/devboard-ui-ux/references/validation.md"));

    let template = fs::read(package_dir().join("templates/host-AGENTS.md")).unwrap();
    assert_eq!(fs::read(host.join("AGENTS.md")).unwrap(), template);

    let expected: Vec<String> = report
        .skills
        .iter()
        .map(|name| format!("/.omp/skills/{name}"))
        .collect();
    assert_eq!(gitignore_lines(host), expected);
    assert_eq!(report.gitignore_added, expected);
}

#[test]
fn rerun_changes_no_bytes_and_adds_nothing_to_gitignore() {
    let scratch = Scratch::new("rerun");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    let before = snapshot(host);
    let ignore_before = gitignore_lines(host);

    let report = cli_install::install(Some(host), false).unwrap();
    assert_eq!(report.installed_files, 0);
    assert!(report.gitignore_added.is_empty());
    assert_eq!(report.agents, AgentsOutcome::Current);
    assert_eq!(snapshot(host), before);
    assert_eq!(gitignore_lines(host), ignore_before);
}

#[test]
fn doctor_passes_then_fails_on_a_one_byte_managed_skill_edit() {
    let scratch = Scratch::new("doctor");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    let clean = cli_install::doctor(Some(host)).unwrap();
    assert!(clean.ok(), "{:?}", clean.failures);
    assert!(clean.drift.is_empty(), "{:?}", clean.drift);

    let name = cli_install::managed_skill_names()[0].clone();
    let target = host.join(".omp/skills").join(&name).join("SKILL.md");
    let mut bytes = fs::read(&target).unwrap();
    bytes[0] ^= 0x01;
    fs::write(&target, &bytes).unwrap();

    let report = cli_install::doctor(Some(host)).unwrap();
    assert!(!report.ok());
    let expected = format!(".omp/skills/{name}/SKILL.md");
    assert!(
        report
            .failures
            .iter()
            .any(|failure| failure.contains(&expected)),
        "{:?}",
        report.failures
    );
}

#[test]
fn an_unmarked_host_skill_is_never_read_or_deleted() {
    let scratch = Scratch::new("unmarked");
    let host = scratch.host();
    let host_skill = host.join(".omp/skills/my-notes/SKILL.md");
    fs::create_dir_all(host_skill.parent().unwrap()).unwrap();
    fs::write(&host_skill, b"host owned\n").unwrap();

    let report = cli_install::install(Some(host), false).unwrap();
    assert_eq!(fs::read(&host_skill).unwrap(), b"host owned\n");
    assert!(!report
        .gitignore_added
        .iter()
        .any(|line| line.contains("my-notes")));
    assert!(!gitignore_lines(host)
        .iter()
        .any(|line| line.contains("my-notes")));
    assert!(cli_install::doctor(Some(host)).unwrap().ok());
}

#[test]
fn a_differing_unmarked_file_refuses_without_force() {
    let scratch = Scratch::new("conflict");
    let host = scratch.host();
    let target = host.join(".omp/config.yml");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"host: config\n").unwrap();

    let error = cli_install::install(Some(host), false)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("install: refusing to overwrite differing files"),
        "{error}"
    );
    assert!(error.contains("config.yml"), "{error}");
    assert!(
        error.contains("install: rerun with --force to replace them"),
        "{error}"
    );
    assert_eq!(fs::read(&target).unwrap(), b"host: config\n");
    assert!(!host.join(".omp/commands").exists());

    let report = cli_install::install(Some(host), true).unwrap();
    assert!(report.installed_files > 0);
    let shipped = fs::read(package_dir().join("omp/config.yml")).unwrap();
    assert_eq!(fs::read(&target).unwrap(), shipped);
    assert!(cli_install::doctor(Some(host)).unwrap().ok());
}

#[test]
fn a_host_without_devboard_is_refused() {
    let scratch = Scratch::new("no-harness");
    let host = scratch.host();
    fs::remove_dir_all(host.join(".devboard")).unwrap();

    let error = cli_install::install(Some(host), false)
        .unwrap_err()
        .to_string();
    assert!(error.contains("no .devboard directory"), "{error}");
    assert!(!host.join(".omp").exists());
    assert!(!host.join("AGENTS.md").exists());
}

#[test]
fn agents_md_drift_is_reported_without_failing() {
    let scratch = Scratch::new("drift");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    fs::write(host.join("AGENTS.md"), b"host content\n").unwrap();

    let report = cli_install::install(Some(host), false).unwrap();
    assert_eq!(report.agents, AgentsOutcome::Drift);
    assert_eq!(fs::read(host.join("AGENTS.md")).unwrap(), b"host content\n");

    let doctor = cli_install::doctor(Some(host)).unwrap();
    assert!(doctor.ok(), "{:?}", doctor.failures);
    assert!(doctor.drift.iter().any(|entry| entry.contains("AGENTS.md")));
}
