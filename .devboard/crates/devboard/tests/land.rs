//! `devboard land`: one fast-forward landing, its lock retry, and its proof.
//!
//! Every fixture is a real bare origin with a real integration clone beside it,
//! under `.devboard/.test-tmp`, so the command is proven against git itself.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use devboard::git::GitResult;
use devboard::land::{land, retry_head_lock, MAX_LOCK_ATTEMPTS};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let serial = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("land-{label}-{}-{serial}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a fixture root");
        Self {
            root: std::fs::canonicalize(&root).expect("a canonical fixture root"),
        }
    }

    fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn git(directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["-c", "user.name=Land Test"])
        .args(["-c", "user.email=land@example.test"])
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

/// A bare origin and the integration clone that lands into it.
struct Fixture {
    scratch: Scratch,
    origin: PathBuf,
    checkout: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let scratch = Scratch::new(label);
        let origin = scratch.path().join("origin.git");
        let origin_text = origin.to_str().expect("a fixture path").to_string();
        git(
            scratch.path(),
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch=main",
                &origin_text,
            ],
        );
        let checkout = scratch.path().join("checkout");
        git(
            scratch.path(),
            &["clone", "--quiet", &origin_text, "checkout"],
        );
        std::fs::write(checkout.join("README.md"), "seed\n").expect("a seed file");
        git(&checkout, &["add", "README.md"]);
        std::fs::write(checkout.join("notes.md"), "notes\n").expect("a notes file");
        git(&checkout, &["add", "notes.md"]);
        git(&checkout, &["commit", "--quiet", "-m", "chore: seed"]);
        git(&checkout, &["push", "--quiet", "-u", "origin", "main"]);
        Self {
            scratch,
            origin,
            checkout,
        }
    }

    fn head(&self) -> String {
        git(&self.checkout, &["rev-parse", "HEAD"])
    }

    fn remote_main(&self) -> String {
        git(&self.checkout, &["ls-remote", "origin", "refs/heads/main"])
            .split_whitespace()
            .next()
            .expect("a remote tip")
            .to_string()
    }

    /// A worktree branch cut from `main`, carrying one commit of its own.
    fn task_branch(&self, name: &str) -> PathBuf {
        let worktree = self.scratch.path().join(format!("{name}-wt"));
        git(
            &self.checkout,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                name,
                worktree.to_str().expect("a fixture path"),
                "main",
            ],
        );
        std::fs::write(worktree.join(format!("{name}.md")), format!("{name}\n"))
            .expect("a branch file");
        let file = format!("{name}.md");
        git(&worktree, &["add", &file]);
        let subject = format!("feat: {name}");
        git(&worktree, &["commit", "--quiet", "-m", &subject]);
        worktree
    }

    /// Publishes one commit on `main` from another clone.
    fn publish_elsewhere(&self, label: &str) -> String {
        let other = self.scratch.path().join("other");
        let origin_text = self.origin.to_str().expect("a fixture path").to_string();
        git(
            self.scratch.path(),
            &["clone", "--quiet", &origin_text, "other"],
        );
        std::fs::write(other.join(format!("{label}.md")), format!("{label}\n"))
            .expect("an upstream file");
        let file = format!("{label}.md");
        git(&other, &["add", &file]);
        let subject = format!("feat: {label}");
        git(&other, &["commit", "--quiet", "-m", &subject]);
        let sha = git(&other, &["rev-parse", "HEAD"]);
        git(&other, &["push", "--quiet", "origin", "main"]);
        sha
    }
}

#[tokio::test]
async fn one_call_lands_the_branch_and_proves_the_remote_tip() {
    let fixture = Fixture::new("happy");
    fixture.task_branch("issue-1");
    // The harness writes its own scratch files; untracked paths never block a
    // landing.
    std::fs::write(fixture.checkout.join("scratch.txt"), "noise\n").expect("a scratch file");

    let landing = land(Some(&fixture.checkout), "issue-1")
        .await
        .expect("the landing");

    let landed = git(&fixture.checkout, &["rev-parse", "issue-1"]);
    assert_eq!(landing.merged, landed);
    assert_eq!(fixture.head(), landing.merged);
    assert_eq!(fixture.remote_main(), landing.merged);
    assert_eq!(landing.remote_tip, landing.merged);
    assert_eq!(landing.upstream, "origin/main");
    assert_eq!(landing.integration, "main");
    assert!(!landing.rebased);
    assert!(!landing.recovered);
    assert_eq!(landing.lock_retries, 0);
    assert_eq!((landing.ahead, landing.behind), (0, 0));

    let lines = landing.lines();
    assert!(lines.contains(&format!("merged {}", landing.merged)));
    assert!(lines.contains(&format!("remote origin/main {} verified", landing.merged)));
    assert!(lines.contains(&"ahead 0 behind 0".to_string()));
}

#[tokio::test]
async fn a_branch_whose_base_advanced_is_rebased_before_it_lands() {
    let fixture = Fixture::new("rebased");
    fixture.task_branch("issue-2");
    std::fs::write(fixture.checkout.join("later.md"), "later\n").expect("a later file");
    git(&fixture.checkout, &["add", "later.md"]);
    git(
        &fixture.checkout,
        &["commit", "--quiet", "-m", "feat: later"],
    );
    git(&fixture.checkout, &["push", "--quiet", "origin", "main"]);
    let integration_tip = fixture.head();

    let landing = land(Some(&fixture.checkout), "issue-2")
        .await
        .expect("the landing");

    assert!(landing.rebased);
    assert_ne!(landing.merged, integration_tip);
    assert_eq!(fixture.head(), landing.merged);
    assert_eq!(fixture.remote_main(), landing.merged);
    assert_eq!(
        git(&fixture.checkout, &["rev-parse", "HEAD^"]),
        integration_tip
    );
    assert!(landing
        .lines()
        .contains(&"rebased issue-2 onto main".to_string()));
}

#[tokio::test]
async fn an_integration_branch_behind_its_upstream_catches_up_first() {
    let fixture = Fixture::new("behind");
    fixture.task_branch("issue-3");
    let published = fixture.publish_elsewhere("elsewhere");

    let landing = land(Some(&fixture.checkout), "issue-3")
        .await
        .expect("the landing");

    assert!(!landing.recovered);
    assert_eq!(fixture.head(), landing.merged);
    assert_eq!(fixture.remote_main(), landing.merged);
    let landed = Command::new("git")
        .arg("-C")
        .arg(&fixture.checkout)
        .args(["merge-base", "--is-ancestor", &published, "HEAD"])
        .status()
        .expect("git merge-base");
    assert!(landed.success(), "the published commit is contained");
}

#[tokio::test]
async fn uncommitted_work_the_landing_would_overwrite_is_refused_untouched() {
    let fixture = Fixture::new("dirty");
    let worktree = fixture.task_branch("issue-4");
    std::fs::write(worktree.join("README.md"), "branch edit\n").expect("a branch edit");
    git(&worktree, &["add", "README.md"]);
    let subject = String::from("feat: branch edit");
    git(&worktree, &["commit", "--quiet", "-m", &subject]);
    let before = fixture.head();
    let remote_before = fixture.remote_main();
    std::fs::write(fixture.checkout.join("README.md"), "edited\n").expect("a tracked edit");

    let error = land(Some(&fixture.checkout), "issue-4")
        .await
        .expect_err("an overlapping checkout edit is refused");
    let text = format!("{error:#}");

    assert!(text.contains("refusing to land"), "{text}");
    assert!(text.contains("would overwrite"), "{text}");
    assert!(text.contains("README.md"), "{text}");
    assert_eq!(fixture.head(), before);
    assert_eq!(fixture.remote_main(), remote_before);
}

#[tokio::test]
async fn uncommitted_work_the_landing_does_not_touch_is_preserved() {
    let fixture = Fixture::new("unrelated");
    fixture.task_branch("issue-6");
    std::fs::write(fixture.checkout.join("notes.md"), "another worker's edit\n")
        .expect("an unrelated edit");

    let landing = land(Some(&fixture.checkout), "issue-6")
        .await
        .expect("an unrelated edit never blocks a landing");

    assert_eq!(fixture.head(), landing.merged);
    assert_eq!(fixture.remote_main(), landing.merged);
    assert_eq!(
        std::fs::read_to_string(fixture.checkout.join("notes.md")).expect("the unrelated edit"),
        "another worker's edit\n"
    );
}

#[tokio::test]
async fn a_conflicting_rebase_names_the_path_and_leaves_nothing_half_applied() {
    let fixture = Fixture::new("conflict");
    let worktree = fixture.task_branch("issue-5");
    std::fs::write(fixture.checkout.join("README.md"), "integration edit\n").expect("an edit");
    git(&fixture.checkout, &["add", "README.md"]);
    git(
        &fixture.checkout,
        &["commit", "--quiet", "-m", "feat: integration edit"],
    );
    git(&fixture.checkout, &["push", "--quiet", "origin", "main"]);
    let before = fixture.head();
    let remote_before = fixture.remote_main();
    std::fs::write(worktree.join("README.md"), "branch edit\n").expect("a branch edit");
    git(&worktree, &["add", "README.md"]);
    let subject = String::from("feat: branch edit");
    git(&worktree, &["commit", "--quiet", "-m", &subject]);
    let branch_before = git(&fixture.checkout, &["rev-parse", "issue-5"]);

    let error = land(Some(&fixture.checkout), "issue-5")
        .await
        .expect_err("a conflicting rebase is refused");
    let text = format!("{error:#}");

    assert!(text.contains("does not rebase cleanly"), "{text}");
    assert!(text.contains("README.md"), "{text}");
    assert_eq!(fixture.head(), before);
    assert_eq!(fixture.remote_main(), remote_before);
    assert_eq!(
        git(&fixture.checkout, &["rev-parse", "issue-5"]),
        branch_before
    );
    let status = git(&worktree, &["status", "--porcelain"]);
    assert!(
        status.is_empty(),
        "the worktree is not mid-rebase: {status}"
    );
}

#[tokio::test]
async fn landing_the_integration_branch_itself_is_refused() {
    let fixture = Fixture::new("self");

    let error = land(Some(&fixture.checkout), "main")
        .await
        .expect_err("landing main into main is refused");
    assert!(
        format!("{error:#}").contains("is the integration branch"),
        "{error:#}"
    );
}

#[tokio::test]
async fn a_refused_head_lock_is_retried_until_the_merge_wins() {
    let mut attempts = 0;
    let (result, retries) = retry_head_lock(|| {
        attempts += 1;
        let refused = attempts <= 2;
        std::future::ready(if refused {
            GitResult {
                code: 128,
                stdout: String::from("Updating d5d360cb..085052b0\nFast-forward\n"),
                stderr: String::from(
                    "fatal: update_ref failed for ref 'HEAD': cannot lock ref 'HEAD': is at \
                     e022446b72ae but expected d5d360cb7a70",
                ),
            }
        } else {
            GitResult {
                code: 0,
                stdout: String::from("Fast-forward"),
                stderr: String::new(),
            }
        })
    })
    .await;

    assert_eq!(result.code, 0);
    assert_eq!(retries, 2);
    assert_eq!(attempts, 3);
}

#[tokio::test]
async fn a_lock_that_never_clears_stops_at_the_bound() {
    let mut attempts = 0;
    let (result, retries) = retry_head_lock(|| {
        attempts += 1;
        std::future::ready(GitResult {
            code: 128,
            stdout: String::new(),
            stderr: String::from("fatal: cannot lock ref 'HEAD': is at abc but expected def"),
        })
    })
    .await;

    assert_eq!(result.code, 128);
    assert_eq!(retries, MAX_LOCK_ATTEMPTS);
    assert_eq!(attempts, MAX_LOCK_ATTEMPTS + 1);
}

#[tokio::test]
async fn a_failure_that_is_not_a_lock_is_never_retried() {
    let mut attempts = 0;
    let (result, retries) = retry_head_lock(|| {
        attempts += 1;
        std::future::ready(GitResult {
            code: 1,
            stdout: String::new(),
            stderr: String::from("fatal: Not possible to fast-forward, aborting."),
        })
    })
    .await;

    assert_eq!(result.code, 1);
    assert_eq!(retries, 0);
    assert_eq!(attempts, 1);
}
