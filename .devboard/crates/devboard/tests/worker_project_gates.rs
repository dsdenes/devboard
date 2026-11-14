//! The `worker` command refuses a family on the project kind that does not
//! permit it, before any lock, state file, or peer exists.

use std::path::{Path, PathBuf};
use std::process::Command;

fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("worker-gates-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/.devboard/prompts")).expect("a repository");
    root
}

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn host_repository(label: &str) -> PathBuf {
    let root = scratch(label);
    let repo = root.join("repo");
    git(&repo, &["init", "--quiet"]);
    git(&repo, &["config", "user.email", "fixture@example.test"]);
    git(&repo, &["config", "user.name", "Fixture"]);
    std::fs::write(repo.join("AGENTS.md"), "# Host\n").expect("an AGENTS.md");
    git(&repo, &["add", "--all"]);
    git(&repo, &["commit", "--quiet", "--message", "fixture"]);
    root
}

fn worker(root: &Path, family: &str) -> (bool, String) {
    let repo = root.join("repo");
    let output = Command::new(env!("CARGO_BIN_EXE_devboard"))
        .args(["worker", family, "--repo"])
        .arg(&repo)
        .arg("--state-dir")
        .arg(repo.join(".devboard/.tmp"))
        .arg("--once")
        .output()
        .expect("the worker command runs");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn the_release_train_refuses_a_host_project_before_writing_anything() {
    let root = host_repository("release-host");
    let (ok, stderr) = worker(&root, "release-train");
    assert!(!ok, "the release train exits nonzero on a host: {stderr}");
    let first = stderr.lines().next().unwrap_or_default();
    assert!(first.contains("host project"), "{first}");
    assert!(
        !root.join("repo/.devboard/.tmp/release-train").exists(),
        "a refused family writes no state"
    );
}

#[test]
fn deploy_on_main_refuses_the_harness_source_checkout_before_writing_anything() {
    let root = host_repository("deploy-source");
    std::fs::write(
        root.join("repo/.devboard/package.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"0.1.0\"}\n",
    )
    .expect("a source manifest");
    let (ok, stderr) = worker(&root, "deploy-on-main");
    assert!(!ok, "deploy exits nonzero in the source: {stderr}");
    let first = stderr.lines().next().unwrap_or_default();
    assert!(first.contains("harness source checkout"), "{first}");
    assert!(
        !root.join("repo/.devboard/.tmp/deploy-on-main").exists(),
        "a refused family writes no state"
    );
}
