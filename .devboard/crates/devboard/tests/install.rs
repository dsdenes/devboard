//! Install and doctor behavior against a scratch host.

use std::collections::{BTreeMap, HashMap};
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
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "--quiet"])
            .status()
            .unwrap();
        assert!(status.success(), "the fixture host is a git checkout");
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

/// A local release at the installed version, so doctor proves its checks
/// without a network or an inherited forge configuration.
fn local_release(host: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let release = host.join(".test-release");
    fs::create_dir_all(&release).unwrap();
    let target = devboard::release::current_target().unwrap();
    let bytes = b"the platform artifact";
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    fs::write(release.join(format!("devboard-{target}.tar.xz")), bytes).unwrap();
    fs::write(
        release.join("devboard-manifest.json"),
        serde_json::to_string(&serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "tag": format!("v{}", env!("CARGO_PKG_VERSION")),
            "assets": [{
                "target": target,
                "url": format!("https://github.test/devboard-{target}.tar.xz"),
                "sha256": digest,
            }],
        }))
        .unwrap(),
    )
    .unwrap();
    release
}

/// Doctor with the inherited forge configuration removed: a fixture proves
/// its own checks, never the developer's network or installed tools.
fn doctor(host: &Path) -> anyhow::Result<devboard::cli_install::DoctorReport> {
    use std::os::unix::fs::PermissionsExt;

    let mut environment: HashMap<String, String> = std::env::vars().collect();
    for key in [
        "DEVBOARD_GITEA_URL",
        "GITEA_URL",
        "DEVBOARD_RELEASE_URL",
        "GITEA_TOKEN",
        "DEVBOARD_GITEA_TOKEN",
    ] {
        environment.remove(key);
    }
    environment.insert(
        "DEVBOARD_RELEASE_URL".to_string(),
        local_release(host).display().to_string(),
    );
    let tools = host.join(".test-bin");
    fs::create_dir_all(&tools).unwrap();
    let omp = tools.join("omp");
    fs::write(&omp, b"#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = fs::metadata(&omp).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&omp, permissions).unwrap();
    let inherited = environment.get("PATH").cloned().unwrap_or_default();
    environment.insert(
        "PATH".to_string(),
        format!("{}:{inherited}", tools.display()),
    );
    devboard::cli_install::doctor_with_env(Some(host), &environment)
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
    let clean = doctor(host).unwrap();
    assert!(clean.ok(), "{:?}", clean.failures);
    assert!(clean.drift.is_empty(), "{:?}", clean.drift);

    let name = cli_install::managed_skill_names()[0].clone();
    let target = host.join(".omp/skills").join(&name).join("SKILL.md");
    let mut bytes = fs::read(&target).unwrap();
    bytes[0] ^= 0x01;
    fs::write(&target, &bytes).unwrap();

    let report = doctor(host).unwrap();
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
fn install_restores_a_tracked_package_owned_skill() {
    let scratch = Scratch::new("tracked-marked-skill");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    let name = cli_install::managed_skill_names()[0].clone();
    let target = host.join(".omp/skills").join(&name).join("SKILL.md");
    fs::write(&target, b"host owned edit\n").unwrap();
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(host)
        .args(["add", "-f", &format!(".omp/skills/{name}/SKILL.md")])
        .status()
        .unwrap();
    assert!(status.success(), "the fixture tracks the marked skill");

    let report = cli_install::install(Some(host), false).unwrap();
    assert_eq!(
        fs::read(&target).unwrap(),
        fs::read(
            package_dir()
                .join("omp/skills")
                .join(&name)
                .join("SKILL.md")
        )
        .unwrap(),
        "the package wins a marked name even when the host tracks it"
    );
    assert!(
        !report.drift.iter().any(|entry| entry.contains(&name)),
        "{:?}",
        report.drift
    );
}

#[test]
fn doctor_fails_a_tracked_marked_skill_but_only_drifts_a_host_skill() {
    let scratch = Scratch::new("tracked-marked-doctor");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();

    let name = cli_install::managed_skill_names()[0].clone();
    let target = host.join(".omp/skills").join(&name).join("SKILL.md");
    let mut bytes = fs::read(&target).unwrap();
    bytes[0] ^= 0x01;
    fs::write(&target, &bytes).unwrap();
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(host)
        .args(["add", "-f", &format!(".omp/skills/{name}/SKILL.md")])
        .status()
        .unwrap();
    assert!(status.success(), "the fixture tracks the marked skill");

    let report = doctor(host).unwrap();
    assert!(
        !report.ok(),
        "a tracked marked skill is package-owned: {:?}",
        report.drift
    );
    assert!(
        report
            .failures
            .iter()
            .any(|failure| failure.contains(&format!(".omp/skills/{name}/SKILL.md"))),
        "{:?}",
        report.failures
    );

    // An unmarked host skill belongs to the host: it never fails doctor.
    let host_skill = host.join(".omp/skills/host-notes/SKILL.md");
    fs::create_dir_all(host_skill.parent().unwrap()).unwrap();
    fs::write(&host_skill, b"host owned\n").unwrap();
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(host)
        .args(["add", "-f", ".omp/skills/host-notes/SKILL.md"])
        .status()
        .unwrap();
    assert!(status.success());
    let report = doctor(host).unwrap();
    assert!(
        !report
            .failures
            .iter()
            .any(|failure| failure.contains("host-notes")),
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
    assert!(doctor(host).unwrap().ok());
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
    assert!(doctor(host).unwrap().ok());

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
    assert!(doctor(host).unwrap().ok());
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

    let doctor = doctor(host).unwrap();
    assert!(doctor.ok(), "{:?}", doctor.failures);
    assert!(doctor.drift.iter().any(|entry| entry.contains("AGENTS.md")));
}

#[test]
fn a_tracked_deleted_agents_md_stays_absent_and_is_drift() {
    let scratch = Scratch::new("agents-deleted");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    let tracked = std::process::Command::new("git")
        .arg("-C")
        .arg(host)
        .args(["add", "--", "AGENTS.md"])
        .status()
        .unwrap();
    assert!(tracked.success(), "the fixture tracks AGENTS.md");
    fs::remove_file(host.join("AGENTS.md")).unwrap();

    let report = cli_install::install(Some(host), false).unwrap();
    assert_eq!(report.agents, AgentsOutcome::Drift);
    assert!(!host.join("AGENTS.md").exists(), "install restored it");
    assert!(report.drift.iter().any(|entry| entry.contains("AGENTS.md")));

    let doctor = doctor(host).unwrap();
    assert!(doctor.ok(), "{:?}", doctor.failures);
    assert!(doctor.drift.iter().any(|entry| entry.contains("AGENTS.md")));
    assert!(
        !doctor
            .failures
            .iter()
            .any(|failure| failure.contains("AGENTS.md")),
        "{:?}",
        doctor.failures
    );
}

#[test]
fn doctor_names_a_missing_or_changed_prompt_and_extension() {
    let scratch = Scratch::new("doctor-payload");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    assert!(doctor(host).unwrap().ok());

    let prompt = host.join(".devboard/prompts/forge-auth.md");
    fs::remove_file(&prompt).unwrap();
    let report = doctor(host).unwrap();
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
    assert!(doctor(host).unwrap().ok());
    let extension = host.join(".devboard/extensions/implement-next-epic.ts");
    fs::create_dir_all(extension.parent().unwrap()).unwrap();
    fs::write(&extension, b"stale runtime\n").unwrap();
    let report = cli_install::install(Some(host), false).unwrap();
    assert!(!extension.exists());
    assert_eq!(report.removed, 1);
    assert!(doctor(host).unwrap().ok());
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

fn git(host: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(host)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {}", args.join(" "));
}

#[test]
fn the_canonical_source_checkout_is_never_an_install_target() {
    let scratch = Scratch::new("canonical");
    let host = scratch.host();
    fs::write(
        host.join(".devboard/package.json"),
        r#"{"name":"@dsdenes/devboard","version":"0.1.0"}"#,
    )
    .unwrap();
    let before = snapshot(host);
    let error = cli_install::install(Some(host), false).expect_err("the checkout is refused");
    assert!(error.to_string().contains("canonical"), "{error}");
    assert_eq!(snapshot(host), before, "a refused install changes no byte");
}

#[test]
fn a_host_that_tracks_its_devboard_tree_is_refused() {
    let scratch = Scratch::new("tracked-tree");
    let host = scratch.host();
    fs::write(host.join(".devboard/keep"), b"tracked").unwrap();
    git(host, &["add", "-f", ".devboard/keep"]);
    let error = cli_install::install(Some(host), false).expect_err("a tracked tree is refused");
    assert!(
        error.to_string().contains("tracks its .devboard"),
        "{error}"
    );
    assert_eq!(fs::read(host.join(".devboard/keep")).unwrap(), b"tracked");
}

#[test]
fn a_symlinked_prefix_is_repaired_and_keeps_its_state() {
    let scratch = Scratch::new("prefix");
    let host = scratch.host();
    let target = host.join("prefix-target");
    let _ = fs::remove_dir_all(&target);
    fs::create_dir_all(target.join(".tmp/journal")).unwrap();
    fs::create_dir_all(target.join(".tmp/source-refresh")).unwrap();
    fs::create_dir_all(target.join(".tmp/locks")).unwrap();
    fs::write(target.join(".tmp/journal/abc.jsonl"), b"{}\n").unwrap();
    fs::write(
        target.join(".tmp/source-refresh/applied.json"),
        b"{\"commit\":\"x\"}",
    )
    .unwrap();
    fs::write(target.join(".tmp/locks/one.lock"), b"owner").unwrap();
    fs::remove_dir_all(host.join(".devboard")).unwrap();
    std::os::unix::fs::symlink(&target, host.join(".devboard")).unwrap();
    assert!(cli_install::refuse_symlinked_prefix(host).is_err());

    cli_install::install(Some(host), false).expect("the prefix is repaired");
    assert!(!fs::symlink_metadata(host.join(".devboard"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(host.join(".devboard/.tmp/journal/abc.jsonl").is_file());
    assert!(host
        .join(".devboard/.tmp/source-refresh/applied.json")
        .is_file());
    assert!(host.join(".devboard/.tmp/locks/one.lock").is_file());
    assert!(host.join(".omp/commands").is_dir());
    cli_install::refuse_symlinked_prefix(host).expect("the repaired prefix is a real directory");
    let _ = fs::remove_dir_all(&target);
}

#[test]
fn a_differing_wrapper_needs_force() {
    let scratch = Scratch::new("wrapper");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    let target = host.join(".omp/commands/setup-devboard.md");
    fs::write(&target, b"host edit\n").unwrap();
    let error = cli_install::install(Some(host), false).expect_err("the wrapper is refused");
    assert!(error.to_string().contains("--force"), "{error}");
    assert_eq!(fs::read(&target).unwrap(), b"host edit\n");
    cli_install::install(Some(host), true).expect("force replaces the wrapper");
    assert_ne!(fs::read(&target).unwrap(), b"host edit\n");
}

#[test]
fn a_git_ls_files_failure_refuses_the_install() {
    let scratch = Scratch::new("ls-files");
    let host = scratch.host();
    fs::write(host.join(".git/index"), b"not an index").unwrap();
    let error = cli_install::install(Some(host), false).expect_err("a failed read is refused");
    assert!(error.to_string().contains("git ls-files"), "{error}");
    assert!(!host.join(".omp").exists());
}

#[test]
fn a_tracked_agents_md_deleted_by_the_host_stays_absent() {
    let scratch = Scratch::new("agents-deleted-tracked");
    let host = scratch.host();
    cli_install::install(Some(host), false).unwrap();
    git(host, &["add", "-f", "AGENTS.md"]);
    fs::remove_file(host.join("AGENTS.md")).unwrap();
    let report = cli_install::install(Some(host), false).unwrap();
    assert!(!host.join("AGENTS.md").exists(), "the deletion stands");
    assert_eq!(report.agents, AgentsOutcome::Drift);
    assert!(report.drift.iter().any(|entry| entry.contains("AGENTS.md")));
}

#[test]
fn an_update_syncs_from_the_installed_binary_first() {
    let scratch = Scratch::new("installed-sync");
    let host = scratch.host();
    let marker = host.join("installed-binary-ran");
    let program = host.join(".devboard/bin/devboard");
    fs::create_dir_all(program.parent().unwrap()).unwrap();
    fs::write(
        &program,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let status = cli_install::sync_from_installed_binary(host).expect("the installed binary runs");
    assert!(status.success());
    assert!(marker.is_file(), "the installed binary synced the host");
    // The host still receives the wrappers from this binary afterward.
    let report = cli_install::install(Some(host), true).unwrap();
    assert!(report.installed_files > 0);
    assert!(host.join(".omp/commands/setup-devboard.md").is_file());
    let _ = fs::remove_file(&marker);
}
