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
        "commands/implement-goal-issue.md",
        "commands/implement-next-epic.md",
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

    // Every prompt and extension asset lands byte-identically under the host
    // `.devboard` payload.
    let mut prompt_files = 0usize;
    for entry in fs::read_dir(package_dir().join("prompts")).unwrap() {
        let entry = entry.unwrap();
        let relative = entry.file_name();
        let expected = fs::read(entry.path()).unwrap();
        let installed = host.join(".devboard/prompts").join(&relative);
        assert_real_file(&installed);
        assert_eq!(fs::read(&installed).unwrap(), expected, "{relative:?}");
        prompt_files += 1;
    }
    assert!(prompt_files > 0);
    let mut command_files = 0usize;
    for entry in fs::read_dir(package_dir().join("omp/commands")).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        assert_eq!(
            fs::read(host.join(".omp/commands").join(&name)).unwrap(),
            fs::read(entry.path()).unwrap(),
            "{name:?}"
        );
        command_files += 1;
    }
    assert!(command_files > 0);
    assert!(
        !host.join(".devboard/extensions").exists()
            || fs::read_dir(host.join(".devboard/extensions"))
                .unwrap()
                .next()
                .is_none()
    );

    let template = fs::read(package_dir().join("templates/host-AGENTS.md")).unwrap();
    assert_eq!(fs::read(host.join("AGENTS.md")).unwrap(), template);

    let mut expected = vec![
        "/.devboard".to_string(),
        "/.omp/commands".to_string(),
        "/.omp/extensions".to_string(),
        "/.omp/mcp.json".to_string(),
    ];
    expected.extend(
        report
            .skills
            .iter()
            .map(|name| format!("/.omp/skills/{name}")),
    );
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
fn a_changed_untracked_package_file_is_overwritten_and_a_tracked_one_is_preserved() {
    let scratch = Scratch::new("conflict");
    let host = scratch.host();
    let target = host.join(".omp/mcp.json");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"host: config\n").unwrap();

    let report = cli_install::install(Some(host), false).unwrap();
    assert!(report.installed_files > 0);
    let shipped = fs::read(package_dir().join("omp/mcp.json")).unwrap();
    assert_eq!(fs::read(&target).unwrap(), shipped);
    assert!(cli_install::doctor(Some(host)).unwrap().ok());

    // A host that tracks the file keeps its bytes and sees the drift.
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(host)
        .args(["init", "--quiet"])
        .status()
        .unwrap();
    assert!(status.success());
    fs::write(&target, b"host: tracked\n").unwrap();
    std::process::Command::new("git")
        .arg("-C")
        .arg(host)
        .args(["add", "-f", ".omp/mcp.json"])
        .status()
        .unwrap();
    let report = cli_install::install(Some(host), false).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"host: tracked\n");
    assert!(report
        .drift
        .iter()
        .any(|entry| entry.contains(".omp/mcp.json")));
}

#[test]
fn a_host_without_devboard_receives_a_clean_install() {
    let scratch = Scratch::new("no-harness");
    let host = scratch.host();
    fs::remove_dir_all(host.join(".devboard")).unwrap();

    let report = cli_install::install(Some(host), false).expect("a clean host installs");
    assert!(report.installed_files > 0);
    assert!(host.join(".omp/skills").is_dir());
    assert!(host.join("AGENTS.md").is_file());
    assert!(cli_install::doctor(Some(host)).unwrap().ok());
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

#[test]
fn doctor_names_a_missing_or_changed_prompt_and_extension() {
    let scratch = Scratch::new("doctor-payload");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    assert!(cli_install::doctor(Some(host)).unwrap().ok());

    let prompt = host.join(".devboard/prompts/forge-auth.md");
    fs::remove_file(&prompt).unwrap();
    let report = cli_install::doctor(Some(host)).unwrap();
    assert!(!report.ok());
    assert!(
        report
            .failures
            .iter()
            .any(|failure| failure.contains(".devboard/prompts/forge-auth.md")),
        "{:?}",
        report.failures
    );

    // Reinstall restores it, and a stale runtime extension is removed.
    cli_install::install(Some(host), false).unwrap();
    assert!(cli_install::doctor(Some(host)).unwrap().ok());
    let extension = host.join(".devboard/extensions/implement-next-epic.ts");
    fs::create_dir_all(extension.parent().unwrap()).unwrap();
    fs::write(&extension, b"stale runtime\n").unwrap();
    let report = cli_install::install(Some(host), false).unwrap();
    assert!(!extension.exists());
    assert_eq!(report.removed, 1);
    assert!(cli_install::doctor(Some(host)).unwrap().ok());
}

#[test]
fn install_sh_produces_the_same_host_tree_as_the_binary() {
    let binary = Scratch::new("parity-binary");
    cli_install::install(Some(binary.host()), false).unwrap();

    let scripted = Scratch::new("parity-script");
    let output = std::process::Command::new("bash")
        .arg(package_dir().join("install.sh"))
        .arg(scripted.host())
        .output()
        .expect("the installer runs");
    assert!(
        output.status.success(),
        "install.sh failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let mut left = snapshot(binary.host());
    let mut right = snapshot(scripted.host());
    // The two hosts are different roots; every relative path and byte must
    // still agree.
    assert_eq!(left, right);
    left.clear();
    right.clear();
}

#[test]
fn every_installed_reference_resolves() {
    let scratch = Scratch::new("references");
    let host = scratch.host();
    fs::remove_dir_all(host.join(".devboard")).unwrap();
    cli_install::install(Some(host), false).unwrap();

    let mut prompt_references = 0usize;
    for entry in fs::read_dir(host.join(".omp/commands")).unwrap() {
        let entry = entry.unwrap();
        let text = fs::read_to_string(entry.path()).unwrap();
        for token in text.split('`') {
            if let Some(rest) = token.strip_prefix(".devboard/prompts/") {
                assert!(
                    host.join(".devboard/prompts").join(rest).is_file(),
                    "{} names a missing prompt {token}",
                    entry.path().display()
                );
                prompt_references += 1;
            }
        }
    }
    assert!(prompt_references > 0, "the commands name prompt files");

    for directory in [
        host.join(".omp/extensions"),
        host.join(".devboard/extensions"),
    ] {
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries {
                let entry = entry.unwrap();
                assert_ne!(
                    entry.path().extension().and_then(|value| value.to_str()),
                    Some("ts"),
                    "{} is a runtime TypeScript file",
                    entry.path().display()
                );
            }
        }
    }
    assert!(
        !fs::read_to_string(host.join(".omp/commands/implement-next-epic.md"))
            .unwrap()
            .contains(".ts"),
        "the command carries no TypeScript import"
    );
}
