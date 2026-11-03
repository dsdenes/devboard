//! The Conventional Commit gate, release version derivation, pre-push range
//! selection, and hook installation.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use devboard::commit_gate::{
    self, commit_level, commit_violations, derive_release_version, is_merge_commit,
    next_release_version, parse_pre_push, parse_subject, previous_release_tag, pushed_commits,
    release_level, subject_rule, tag_binding, tag_commit, CommitRecord, ReleaseLevel, TagBinding,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn package_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let serial = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = package_dir()
            .join(".test-tmp")
            .join(format!("gate-{label}-{}-{serial}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self {
            root: fs::canonicalize(&root).unwrap(),
        }
    }

    fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["-c", "user.name=Gate Test"])
        .args(["-c", "user.email=gate@example.test"])
        .args(["-c", "commit.gpgsign=false"])
        .args(["-c", "init.defaultBranch=main"])
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("git {}: {error}", args.join(" ")));
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn repository(label: &str) -> (Scratch, PathBuf) {
    let scratch = Scratch::new(label);
    let directory = scratch.path().join("work");
    fs::create_dir_all(&directory).unwrap();
    git(&directory, &["init", "-q"]);
    (scratch, directory)
}

fn commit(directory: &Path, subject: &str) -> String {
    git(directory, &["commit", "--allow-empty", "-q", "-m", subject]);
    git(directory, &["rev-parse", "HEAD"])
}

fn commit_with_body(directory: &Path, subject: &str, body: &str) -> String {
    git(
        directory,
        &["commit", "--allow-empty", "-q", "-m", subject, "-m", body],
    );
    git(directory, &["rev-parse", "HEAD"])
}

fn record(sha: &str, subject: &str, parents: &[&str]) -> CommitRecord {
    CommitRecord {
        sha: sha.to_string(),
        subject: subject.to_string(),
        body: String::new(),
        parents: parents.iter().map(|parent| (*parent).to_string()).collect(),
    }
}

#[test]
fn every_conventional_type_scope_and_marker_is_accepted() {
    for kind in [
        "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore",
        "revert",
    ] {
        assert!(
            subject_rule(&format!("{kind}: describe the change")).is_none(),
            "{kind} without a scope was rejected"
        );
        assert!(
            subject_rule(&format!("{kind}(ui): describe the change")).is_none(),
            "{kind} with a scope was rejected"
        );
    }
    assert!(subject_rule("feat(ui)!: drop the old control").is_none());
    assert!(subject_rule("fix(a.b-c_1): scope characters").is_none());
    assert!(subject_rule("refactor(api)!: break the shape").is_none());

    let parsed = parse_subject("feat(ui)!: drop the old control").unwrap();
    assert_eq!(parsed.kind, "feat");
    assert_eq!(parsed.scope.as_deref(), Some("ui"));
    assert!(parsed.breaking);
    assert_eq!(parsed.description, "drop the old control");
    let plain = parse_subject("fix: keep it").unwrap();
    assert_eq!(plain.scope, None);
    assert!(!plain.breaking);
}

#[test]
fn every_malformed_shape_names_the_broken_rule() {
    assert!(subject_rule("Added export control")
        .unwrap()
        .contains("is not"));
    assert!(subject_rule("UI(discover): remove it")
        .unwrap()
        .contains("lowercase"));
    assert!(subject_rule("update(ui): remove it")
        .unwrap()
        .contains("is not one of"));
    assert!(subject_rule("feat(UI): scope")
        .unwrap()
        .contains("[a-z0-9._-]+"));
    assert!(subject_rule("feat(): empty scope")
        .unwrap()
        .contains("[a-z0-9._-]+"));
    assert!(subject_rule("feat(ui):no space")
        .unwrap()
        .contains("is not"));
    assert!(subject_rule("feat(ui): ").unwrap().contains("non-empty"));
    assert!(subject_rule("feat(ui): trailing ")
        .unwrap()
        .contains("leading or trailing"));
    assert!(subject_rule("feat(ui):  leading")
        .unwrap()
        .contains("leading or trailing"));
    assert!(subject_rule("").unwrap().contains("empty"));
    assert!(parse_subject("Added export control").is_none());
}

#[test]
fn merge_commits_are_exempt_from_grammar_and_mapping() {
    let real_merge = record("m", "Merge origin/main into issue-1", &["a", "b"]);
    let synthetic = record("s", "Merge origin/main into issue-1", &["a"]);
    assert!(is_merge_commit(&real_merge));
    assert!(is_merge_commit(&synthetic));
    assert_eq!(commit_level(&real_merge), None);
    assert_eq!(commit_level(&synthetic), None);
    assert!(commit_violations(&[real_merge, synthetic]).is_empty());
}

#[test]
fn major_on_a_bang_or_breaking_footer_minor_on_feat_patch_otherwise() {
    assert_eq!(
        commit_level(&record("1", "feat(api)!: move the prefix", &["p"])),
        Some(ReleaseLevel::Major)
    );
    let mut change = record("2", "fix: keep it", &["p"]);
    change.body = "BREAKING CHANGE: moved".to_string();
    assert_eq!(commit_level(&change), Some(ReleaseLevel::Major));
    change.body = "BREAKING-CHANGE: moved".to_string();
    assert_eq!(commit_level(&change), Some(ReleaseLevel::Major));
    assert_eq!(
        commit_level(&record("3", "feat: add it", &["p"])),
        Some(ReleaseLevel::Minor)
    );
    assert_eq!(
        commit_level(&record("4", "fix: correct it", &["p"])),
        Some(ReleaseLevel::Patch)
    );
    assert_eq!(
        commit_level(&record("5", "Added it", &["p"])),
        Some(ReleaseLevel::Patch)
    );
    assert_eq!(
        release_level(&[
            record("6", "fix: one", &["p"]),
            record("7", "feat: two", &["p"]),
        ]),
        Some(ReleaseLevel::Minor)
    );
    assert_eq!(
        release_level(&[
            record("8", "feat: one", &["p"]),
            record("9", "feat!: two", &["p"]),
            record("10", "fix: three", &["p"]),
        ]),
        Some(ReleaseLevel::Major)
    );
    assert_eq!(
        release_level(&[record("11", "fix: only", &["p"])]),
        Some(ReleaseLevel::Patch)
    );
}

#[test]
fn the_version_advances_the_previous_release_by_the_highest_level() {
    assert_eq!(
        next_release_version(Some("1.2.3"), Some(ReleaseLevel::Major)).unwrap(),
        "2.0.0"
    );
    assert_eq!(
        next_release_version(Some("1.2.3"), Some(ReleaseLevel::Minor)).unwrap(),
        "1.3.0"
    );
    assert_eq!(
        next_release_version(Some("1.2.3"), Some(ReleaseLevel::Patch)).unwrap(),
        "1.2.4"
    );
    assert_eq!(next_release_version(Some("1.2.3"), None).unwrap(), "1.2.3");
    assert_eq!(
        next_release_version(None, Some(ReleaseLevel::Major)).unwrap(),
        "1.0.0"
    );
    assert_eq!(
        next_release_version(Some("0.1.1176"), Some(ReleaseLevel::Minor)).unwrap(),
        "1.0.0"
    );
    assert_eq!(
        next_release_version(Some("0.1.1176"), None).unwrap(),
        "1.0.0"
    );
    assert!(next_release_version(Some("1.0"), Some(ReleaseLevel::Patch)).is_err());
}

#[tokio::test]
async fn ranges_check_only_non_merge_commits_and_derive_reachable_versions() {
    let (_scratch, directory) = repository("range");
    let base = commit(&directory, "feat: first");
    git(&directory, &["tag", "v0.1.7", &base]);
    let second = commit(&directory, "fix: second");

    assert!(
        commit_gate::check_commit_range(&directory, &format!("{base}..{second}"))
            .await
            .unwrap()
            .is_empty()
    );

    let baseline = derive_release_version(&directory, "HEAD").await.unwrap();
    assert_eq!(
        baseline.previous,
        Some(commit_gate::ReleaseTag {
            tag: "v0.1.7".to_string(),
            version: "0.1.7".to_string(),
        })
    );
    assert_eq!(baseline.range, "v0.1.7..HEAD");
    assert_eq!(baseline.level, Some(ReleaseLevel::Patch));
    assert_eq!(baseline.version, "1.0.0");

    git(&directory, &["tag", "v1.0.0", &second]);
    assert_eq!(
        derive_release_version(&directory, "HEAD")
            .await
            .unwrap()
            .version,
        "1.0.0"
    );
    assert_eq!(
        previous_release_tag(&directory, "HEAD").await,
        Some(commit_gate::ReleaseTag {
            tag: "v1.0.0".to_string(),
            version: "1.0.0".to_string(),
        })
    );

    let third = commit(&directory, "feat(ui): third");
    let minor = derive_release_version(&directory, "HEAD").await.unwrap();
    assert_eq!(minor.range, "v1.0.0..HEAD");
    assert_eq!(minor.version, "1.1.0");
    git(&directory, &["tag", "v1.1.0", &third]);

    let breaking = commit_with_body(
        &directory,
        "feat(api): move the prefix",
        "BREAKING CHANGE: installed prefixes move",
    );
    assert_eq!(
        derive_release_version(&directory, "HEAD")
            .await
            .unwrap()
            .version,
        "2.0.0"
    );

    let merge = git(
        &directory,
        &[
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            "HEAD",
            "-p",
            "HEAD",
            "-m",
            "Merge origin/main into issue-1",
        ],
    );
    assert!(
        commit_gate::check_commit_range(&directory, &format!("{breaking}..{merge}"))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        release_level(
            &commit_gate::read_commits(&directory, &format!("{breaking}..{merge}"))
                .await
                .unwrap()
        ),
        None
    );
}

#[tokio::test]
async fn each_offending_commit_is_named_with_the_rule_it_broke() {
    let (_scratch, directory) = repository("bad");
    commit(&directory, "chore: base");
    let bad = git(
        &directory,
        &[
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            "HEAD",
            "-m",
            "Added export control",
        ],
    );
    let violations = commit_gate::check_commit_range(&directory, &format!("HEAD..{bad}"))
        .await
        .unwrap();
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0].sha, bad);
    assert_eq!(violations[0].subject, "Added export control");
    assert_eq!(
        violations[0].rule,
        "the subject is not `<type>[(<scope>)][!]: <description>`"
    );

    let formatted = commit_gate::format_violations(&violations);
    assert_eq!(
        formatted,
        format!(
            "commit-gate: {bad} Added export control\n  \
             the subject is not `<type>[(<scope>)][!]: <description>`"
        )
    );
    assert!(!formatted.contains("\n\n"));
    assert_eq!(commit_gate::report_violations(&[]), 0);
}

#[tokio::test]
async fn release_tag_binding_separates_names_contains_behind_and_unrelated() {
    let (_scratch, directory) = repository("binding");
    let head = commit(&directory, "fix: one");
    assert_eq!(
        tag_binding(&directory, "v1.0.0", "HEAD").await,
        TagBinding::Absent
    );
    assert_eq!(tag_commit(&directory, "v1.0.0").await, None);

    git(&directory, &["tag", "v1.0.0", &head]);
    assert_eq!(
        tag_binding(&directory, "v1.0.0", "HEAD").await,
        TagBinding::Names
    );
    assert_eq!(tag_commit(&directory, "v1.0.0").await, Some(head.clone()));

    let later = commit(&directory, "feat: two");
    git(&directory, &["tag", "v1.1.0", &later]);
    assert_eq!(
        tag_binding(&directory, "v1.1.0", &head).await,
        TagBinding::Contains
    );
    assert_eq!(
        tag_binding(&directory, "v1.0.0", "HEAD").await,
        TagBinding::Behind
    );

    git(&directory, &["checkout", "-q", "--orphan", "elsewhere"]);
    let orphan = commit(&directory, "fix: elsewhere");
    git(&directory, &["checkout", "-q", "main"]);
    git(&directory, &["tag", "v1.0.1", &orphan]);
    assert_eq!(tag_commit(&directory, "v1.0.1").await, Some(orphan));
    assert_eq!(
        tag_binding(&directory, "v1.0.1", "HEAD").await,
        TagBinding::Unrelated
    );
    assert_eq!(
        tag_binding(&directory, "v1.0.1", &head).await,
        TagBinding::Unrelated
    );
}

fn remote_repository(label: &str) -> (Scratch, PathBuf, PathBuf) {
    let scratch = Scratch::new(label);
    let remote = scratch.path().join("remote.git");
    let holder = scratch.path().join("holder");
    fs::create_dir_all(&holder).unwrap();
    git(
        &holder,
        &["init", "--bare", "-q", &remote.to_string_lossy()],
    );
    let directory = scratch.path().join("work");
    fs::create_dir_all(&directory).unwrap();
    git(&directory, &["init", "-q"]);
    (scratch, remote, directory)
}

#[tokio::test]
async fn the_push_checks_only_commits_no_remote_already_has() {
    let (_scratch, remote, directory) = remote_repository("push");
    let base = commit(&directory, "chore: base");
    git(
        &directory,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );
    git(
        &directory,
        &["push", "-q", "origin", "HEAD:refs/heads/main"],
    );
    git(&directory, &["fetch", "-q", "origin"]);

    let zero = "0".repeat(40);
    let bad = commit(&directory, "Bad message");
    let refs = parse_pre_push(&format!(
        "refs/heads/main {bad} refs/heads/main {base}\n{zero} {zero} refs/heads/gone {zero}\n"
    ))
    .unwrap();
    assert_eq!(refs.len(), 2);
    let candidates = pushed_commits(&directory, &refs).await.unwrap();
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.sha.clone())
            .collect::<Vec<String>>(),
        vec![bad.clone()]
    );
    assert_eq!(commit_violations(&candidates).len(), 1);

    let good = git(
        &directory,
        &[
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            &base,
            "-m",
            "fix(gate): accept the subject",
        ],
    );
    let rewritten =
        parse_pre_push(&format!("refs/heads/main {good} refs/heads/main {base}\n")).unwrap();
    assert!(commit_violations(&pushed_commits(&directory, &rewritten).await.unwrap()).is_empty());

    let input = format!("refs/heads/main {bad} refs/heads/main {base}\n");
    assert_eq!(
        commit_gate::check_pre_push(&directory, &input)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        commit_gate::check_pre_push(&directory, "only three fields\n")
            .await
            .unwrap_err()
            .to_string()
            .contains("unreadable pre-push line")
    );
}

#[tokio::test]
async fn a_new_destination_ref_still_excludes_published_commits() {
    let (_scratch, remote, directory) = remote_repository("new-ref");
    commit(&directory, "chore: already published");
    git(
        &directory,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );
    git(
        &directory,
        &["push", "-q", "origin", "HEAD:refs/heads/main"],
    );
    git(&directory, &["fetch", "-q", "origin"]);
    let added = commit(&directory, "feat: new work");

    let refs = parse_pre_push(&format!(
        "refs/heads/topic {added} refs/heads/main {}\n",
        "0".repeat(40)
    ))
    .unwrap();
    assert_eq!(
        pushed_commits(&directory, &refs)
            .await
            .unwrap()
            .iter()
            .map(|candidate| candidate.sha.clone())
            .collect::<Vec<String>>(),
        vec![added]
    );
}

fn harness_fixture(scratch: &Scratch, manifest: bool) -> PathBuf {
    let checkout = scratch.path().join("checkout");
    let harness = checkout.join(".devboard");
    fs::create_dir_all(harness.join("hooks")).unwrap();
    if manifest {
        fs::write(
            harness.join("package.json"),
            br#"{"name":"@dsdenes/devboard"}"#,
        )
        .unwrap();
    }
    git(&checkout, &["init", "-q"]);
    harness
}

#[test]
fn installing_the_hook_is_idempotent_and_force_replaces_a_different_hook() {
    let scratch = Scratch::new("install");
    let harness = harness_fixture(&scratch, true);
    let contents: &[u8] = b"#!/bin/sh\nexec devboard gate-prepush\n";
    fs::write(harness.join("hooks").join("pre-push"), contents).unwrap();

    let first = commit_gate::hooks_install_at(&harness, false).unwrap();
    assert!(!first.current);
    assert_eq!(fs::read(&first.target).unwrap(), contents);
    assert!(first.target.ends_with("hooks/pre-push"));
    assert!(first.hooks_directory.ends_with("hooks"));
    assert!(first.message().starts_with("hooks: installed "));

    let second = commit_gate::hooks_install_at(&harness, false).unwrap();
    assert!(second.current);
    assert_eq!(second.target, first.target);
    assert_eq!(fs::read(&second.target).unwrap(), contents);
    assert!(second.message().ends_with(" is current"));

    fs::write(&second.target, b"#!/bin/sh\nexit 0\n").unwrap();
    let refused = commit_gate::hooks_install_at(&harness, false).unwrap_err();
    assert!(refused
        .to_string()
        .contains("differs from the checked-in hook"));
    assert_eq!(
        fs::read(&second.target).unwrap(),
        b"#!/bin/sh\nexit 0\n".to_vec()
    );

    let forced = commit_gate::hooks_install_at(&harness, true).unwrap();
    assert!(!forced.current);
    assert_eq!(fs::read(&forced.target).unwrap(), contents);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&forced.target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }
}

#[test]
fn the_installer_refuses_anything_that_is_not_the_source_harness() {
    let scratch = Scratch::new("install-refusals");

    let not_named = scratch.path().join("lib");
    fs::create_dir_all(&not_named).unwrap();
    let error = commit_gate::hooks_install_at(&not_named, false).unwrap_err();
    assert!(error.to_string().contains("is not named .devboard"));

    let missing_manifest = harness_fixture(&scratch, false);
    let error = commit_gate::hooks_install_at(&missing_manifest, false).unwrap_err();
    assert!(error
        .to_string()
        .contains("is not the source harness checkout"));

    let installed = scratch.path().join("installed-checkout");
    let installed_harness = installed.join(".devboard");
    fs::create_dir_all(installed_harness.join("node_modules/@dsdenes/devboard")).unwrap();
    fs::write(
        installed_harness.join("package.json"),
        br#"{"name":"@dsdenes/devboard"}"#,
    )
    .unwrap();
    git(&installed, &["init", "-q"]);
    let error = commit_gate::hooks_install_at(&installed_harness, false).unwrap_err();
    assert!(error.to_string().contains("holds an installed harness"));

    let nested_checkout = scratch.path().join("nested");
    let nested = nested_checkout.join("sub").join(".devboard");
    fs::create_dir_all(&nested).unwrap();
    fs::write(
        nested.join("package.json"),
        br#"{"name":"@dsdenes/devboard"}"#,
    )
    .unwrap();
    git(&nested_checkout, &["init", "-q"]);
    let error = commit_gate::hooks_install_at(&nested, false).unwrap_err();
    assert!(error.to_string().contains("is not <checkout>/.devboard"));

    let no_source = harness_fixture(&scratch, true);
    let error = commit_gate::hooks_install_at(&no_source, false).unwrap_err();
    assert!(error.to_string().contains("the hook source is missing"));

    let source = harness_fixture(&scratch, true);
    fs::write(
        source.join("hooks").join("pre-push"),
        b"#!/bin/sh\nexit 0\n",
    )
    .unwrap();
    fs::create_dir_all(source.join("../.git/hooks/pre-push")).unwrap();
    let error = commit_gate::hooks_install_at(&source, true).unwrap_err();
    assert!(error.to_string().contains("is a directory, not a hook"));
}
