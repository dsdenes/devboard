//! Pull-request delivery and maintenance: branch/PR delivery that never
//! advances the integration branch, the event-driven maintenance loop, the
//! required-check fix path, review replies and thread resolution, conflict
//! integration, and the terminal states.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use devboard::delivery::{
    bounded_reply, check_state, closing_keyword, deliver_branch, deliver_issue_change,
    fresh_issue_branch, issue_branch, open_record_for_issue, plan_maintenance, read_maintenance,
    run_maintenance, CheckObservation, CommentDecision, CreatePull, DeliveryForge, DeliveryFuture,
    MaintenanceAction, MaintenanceInput, MaintenanceOutcome, MaintenanceRecord, MaintenanceResult,
    PullSnapshot, ReviewComment,
};
use devboard::issues_mode::Issue;
use serde_json::Value;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!(
            "background-pr-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("the scratch root");
    root
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-c")
        .arg("user.name=PR Fixture")
        .arg("-c")
        .arg("user.email=fixture@example.test")
        .arg("-c")
        .arg("commit.gpgsign=false")
        .arg("-c")
        .arg("init.defaultBranch=main")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    origin: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = scratch(label);
        let origin = root.join("origin.git");
        let repo = root.join("repo");
        let state = root.join("state");
        std::fs::create_dir_all(&state).expect("the state root");
        git(
            &root,
            &["init", "--bare", "-q", origin.to_str().expect("a path")],
        );
        std::fs::write(root.join("seed"), "").expect("a seed file");
        std::fs::create_dir_all(&repo).expect("the repository");
        git(&repo, &["init", "-q"]);
        std::fs::write(repo.join("tracked.txt"), "original\n").expect("a tracked file");
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-q", "-m", "chore: seed"]);
        git(
            &repo,
            &["remote", "add", "origin", origin.to_str().expect("a path")],
        );
        git(&repo, &["push", "-q", "-u", "origin", "main"]);
        Self {
            root,
            repo,
            origin,
            state,
        }
    }

    fn tip(&self) -> String {
        git(&self.origin, &["rev-parse", "main"])
    }

    fn remote_branch(&self, branch: &str) -> Option<String> {
        let output = Command::new("git")
            .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
            .current_dir(&self.origin)
            .output()
            .expect("git runs");
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn commit(&self, name: &str, text: &str, message: &str) -> String {
        std::fs::write(self.repo.join(name), text).expect("the change");
        git(&self.repo, &["add", name]);
        git(&self.repo, &["commit", "-q", "-m", message]);
        git(&self.repo, &["rev-parse", "HEAD"])
    }

    fn commit_on_main(&self, name: &str, text: &str, message: &str) -> String {
        let worktree = self.root.join("base-work");
        if !worktree.exists() {
            git(
                &self.root,
                &[
                    "clone",
                    "-q",
                    self.origin.to_str().expect("a path"),
                    worktree.to_str().expect("a path"),
                ],
            );
        }
        std::fs::write(worktree.join(name), text).expect("the base change");
        git(&worktree, &["add", name]);
        git(&worktree, &["commit", "-q", "-m", message]);
        git(&worktree, &["push", "-q", "origin", "main"]);
        git(&worktree, &["rev-parse", "HEAD"])
    }

    fn issue(&self, number: u64) -> Issue {
        Issue {
            number,
            title: "Bound the poll".to_string(),
            url: format!("https://forge.test/acme/fixture/issues/{number}"),
            created_at: "2026-01-10T10:00:00.000Z".to_string(),
            labels: vec!["goal".to_string()],
            body: Some("The context is too big.".to_string()),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(Default)]
struct FakeInner {
    creates: Vec<CreatePull>,
    snapshots: HashMap<u64, PullSnapshot>,
    checks: HashMap<u64, Vec<CheckObservation>>,
    comments: HashMap<u64, Vec<ReviewComment>>,
    replies: Vec<(u64, u64, String)>,
    resolved: Vec<(u64, u64)>,
    next_number: u64,
    issue_open: bool,
    closed_issues: Vec<u64>,
    fail_create: Option<String>,
    operations: Vec<&'static str>,
}

struct FakeForge {
    inner: Mutex<FakeInner>,
}

impl FakeForge {
    fn new(kind: &str) -> Arc<Self> {
        if !matches!(kind, "github" | "gitea") {
            panic!("unsupported fake forge {kind}");
        }
        Arc::new(Self {
            inner: Mutex::new(FakeInner {
                next_number: 7,
                issue_open: true,
                ..FakeInner::default()
            }),
        })
    }

    fn set_snapshot(&self, snapshot: PullSnapshot) {
        self.inner
            .lock()
            .expect("the fake")
            .snapshots
            .insert(snapshot.number, snapshot);
    }

    fn set_checks(&self, number: u64, checks: Vec<CheckObservation>) {
        self.inner
            .lock()
            .expect("the fake")
            .checks
            .insert(number, checks);
    }

    fn set_comments(&self, number: u64, comments: Vec<ReviewComment>) {
        self.inner
            .lock()
            .expect("the fake")
            .comments
            .insert(number, comments);
    }

    fn creates(&self) -> usize {
        self.inner.lock().expect("the fake").creates.len()
    }

    fn created(&self) -> CreatePull {
        self.inner.lock().expect("the fake").creates[0].clone()
    }

    fn replies(&self) -> Vec<(u64, u64, String)> {
        self.inner.lock().expect("the fake").replies.clone()
    }

    fn resolved(&self) -> Vec<(u64, u64)> {
        self.inner.lock().expect("the fake").resolved.clone()
    }

    fn operations(&self) -> Vec<&'static str> {
        self.inner.lock().expect("the fake").operations.clone()
    }

    fn closed_issues(&self) -> Vec<u64> {
        self.inner.lock().expect("the fake").closed_issues.clone()
    }
}

fn snapshot(number: u64, state: &str, head: &str, mergeable: &str) -> PullSnapshot {
    PullSnapshot {
        number,
        url: format!("https://forge.test/acme/fixture/pulls/{number}"),
        state: state.to_string(),
        draft: false,
        head: head.to_string(),
        mergeable: mergeable.to_string(),
    }
}

impl DeliveryForge for FakeForge {
    fn create_ready<'a>(
        &'a self,
        input: CreatePull,
    ) -> DeliveryFuture<'a, Result<PullSnapshot, String>> {
        Box::pin(async move {
            let mut inner = self.inner.lock().expect("the fake");
            inner.operations.push("create");
            if let Some(detail) = inner.fail_create.clone() {
                return Err(detail);
            }
            let number = inner.next_number;
            inner.next_number += 1;
            inner.creates.push(input.clone());
            let created = PullSnapshot {
                number,
                url: format!("https://forge.test/acme/fixture/pulls/{number}"),
                state: "open".to_string(),
                draft: false,
                head: input.head,
                mergeable: "mergeable".to_string(),
            };
            inner.snapshots.insert(number, created.clone());
            Ok(created)
        })
    }

    fn view<'a>(&'a self, number: u64) -> DeliveryFuture<'a, Result<PullSnapshot, String>> {
        Box::pin(async move {
            let inner = self.inner.lock().expect("the fake");
            inner
                .snapshots
                .get(&number)
                .cloned()
                .ok_or_else(|| format!("no pull request #{number}"))
        })
    }

    fn checks<'a>(
        &'a self,
        number: u64,
        _base: &'a str,
    ) -> DeliveryFuture<'a, Result<Vec<CheckObservation>, String>> {
        Box::pin(async move {
            Ok(self
                .inner
                .lock()
                .expect("the fake")
                .checks
                .get(&number)
                .cloned()
                .unwrap_or_default())
        })
    }

    fn review_comments<'a>(
        &'a self,
        number: u64,
    ) -> DeliveryFuture<'a, Result<Vec<ReviewComment>, String>> {
        Box::pin(async move {
            Ok(self
                .inner
                .lock()
                .expect("the fake")
                .comments
                .get(&number)
                .cloned()
                .unwrap_or_default())
        })
    }

    fn reply<'a>(
        &'a self,
        number: u64,
        comment: u64,
        body: &'a str,
    ) -> DeliveryFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut inner = self.inner.lock().expect("the fake");
            inner.replies.push((number, comment, body.to_string()));
            inner.operations.push("reply");
            Ok(())
        })
    }

    fn resolve_thread<'a>(
        &'a self,
        number: u64,
        comment: u64,
    ) -> DeliveryFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut inner = self.inner.lock().expect("the fake");
            inner.resolved.push((number, comment));
            inner.operations.push("resolve");
            Ok(())
        })
    }

    fn find_open_by_head<'a>(
        &'a self,
        head: &'a str,
    ) -> DeliveryFuture<'a, Result<Option<PullSnapshot>, String>> {
        Box::pin(async move {
            Ok(self
                .inner
                .lock()
                .expect("the fake")
                .snapshots
                .values()
                .find(|snapshot| snapshot.head == head && snapshot.state == "open")
                .cloned())
        })
    }

    fn issue_open<'a>(&'a self, _number: u64) -> DeliveryFuture<'a, Result<bool, String>> {
        Box::pin(async move { Ok(self.inner.lock().expect("the fake").issue_open) })
    }

    fn close_issue<'a>(&'a self, number: u64) -> DeliveryFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut inner = self.inner.lock().expect("the fake");
            inner.closed_issues.push(number);
            inner.issue_open = false;
            inner.operations.push("close");
            Ok(())
        })
    }
}

fn maintain_with(result: MaintenanceResult) -> devboard::delivery::MaintainFn {
    Arc::new(move |_input: MaintenanceInput| {
        let result = result.clone();
        Box::pin(async move { Ok(result) })
    })
}

#[tokio::test]
async fn pull_request_mode_opens_one_ready_pull_request_and_leaves_main_untouched() {
    let fixture = Fixture::new("opens");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    let head = fixture.commit("change.txt", "the change\n", "feat: make the change");
    let delivered = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the pull request");
    assert_eq!(
        fixture.tip(),
        base_tip,
        "the integration branch never advanced"
    );
    assert_eq!(
        fixture.remote_branch(&delivered.branch).as_deref(),
        Some(head.as_str())
    );
    assert_eq!(forge.creates(), 1);
    let created = forge.created();
    assert_eq!(created.head, delivered.branch);
    assert_eq!(created.base, "main");
    assert!(
        created.body.contains(&closing_keyword(12)),
        "{}",
        created.body
    );
    assert_eq!(delivered.state, "open");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the marker");
    assert_eq!(record.pull_request.number, delivered.number);
    assert_eq!(record.head_commit, head);
    assert_eq!(record.pull_request.branch, issue_branch(12, "run-abc"));
    assert!(forge.closed_issues().is_empty(), "the issue stays open");
}

#[tokio::test]
async fn a_replayed_implementation_reuses_the_open_pull_request() {
    let fixture = Fixture::new("replay");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    let head = fixture.commit("change.txt", "the change\n", "feat: make the change");
    let first = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the first delivery");
    assert_eq!(first.number, 7);
    let second = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the replay");
    assert_eq!(second, first);
    assert_eq!(forge.creates(), 1, "a replay opens no second pull request");
    assert_eq!(
        fixture.remote_branch(&first.branch).as_deref(),
        Some(head.as_str())
    );
}

/// A regular file where the state directory belongs makes every record write
/// fail, after the forge already holds the pull request.
fn blocked_state(fixture: &Fixture) -> PathBuf {
    let blocked = fixture.root.join("blocked-state");
    std::fs::write(&blocked, "").expect("a regular file where the state directory belongs");
    blocked
}

#[tokio::test]
async fn a_delivered_pull_request_whose_record_cannot_be_written_is_an_error() {
    let fixture = Fixture::new("record-unwritable");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let error = deliver_issue_change(
        &fixture.repo,
        &blocked_state(&fixture),
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect_err("the unwritten record is reported");
    assert_eq!(forge.creates(), 1, "the pull request was still opened");
    assert!(
        error.contains("pull request #7 (https://forge.test/acme/fixture/pulls/7)"),
        "{error}"
    );
    assert!(
        error.contains("maintenance record could not be written"),
        "{error}"
    );
}

#[tokio::test]
async fn an_adopted_pull_request_whose_record_cannot_be_written_is_an_error() {
    let fixture = Fixture::new("record-unwritable-adopted");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let branch = issue_branch(12, "run-abc");
    forge.set_snapshot(snapshot(9, "open", &branch, "mergeable"));
    let error = deliver_issue_change(
        &fixture.repo,
        &blocked_state(&fixture),
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect_err("the unwritten record is reported");
    assert_eq!(forge.creates(), 0, "the existing pull request is adopted");
    assert!(
        error.contains("pull request #9 (https://forge.test/acme/fixture/pulls/9)"),
        "{error}"
    );
}

#[tokio::test]
async fn a_documentation_pull_request_whose_record_cannot_be_written_is_an_error() {
    let fixture = Fixture::new("record-unwritable-branch");
    let forge = FakeForge::new("github");
    let head = fixture.commit("doc.md", "the document\n", "docs: write the document");
    let error = deliver_branch(
        &fixture.repo,
        &fixture.repo,
        &blocked_state(&fixture),
        forge.as_ref(),
        "devboard/design-cycle-1",
        "main",
        "docs(design): the summary".to_string(),
        "The summary.\n".to_string(),
        &head,
        None,
        Some("The summary.".to_string()),
    )
    .await
    .expect_err("the unwritten record is reported");
    assert_eq!(forge.creates(), 1, "the pull request was still opened");
    assert_eq!(
        fixture.remote_branch("devboard/design-cycle-1").as_deref(),
        Some(head.as_str()),
        "the branch stays pushed"
    );
    assert!(
        error.contains("pull request #7 (https://forge.test/acme/fixture/pulls/7)"),
        "{error}"
    );
}

#[tokio::test]
async fn maintenance_runs_only_for_an_actionable_change() {
    let fixture = Fixture::new("maintenance");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    let head = fixture.commit("change.txt", "the change\n", "feat: make the change");
    let delivered = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the delivery");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the marker");
    forge.set_snapshot(snapshot(delivered.number, "open", &head, "mergeable"));
    forge.set_checks(
        delivered.number,
        vec![CheckObservation {
            name: "unit".into(),
            state: "success".into(),
            detail: None,
        }],
    );

    let none = run_maintenance(
        &fixture.repo,
        &fixture.state,
        record.clone(),
        forge.as_ref(),
        None,
    )
    .await
    .expect("a due check with nothing changed");
    assert_eq!(none, MaintenanceOutcome::NoChange);

    forge.set_comments(
        delivered.number,
        vec![ReviewComment {
            id: 41,
            body: "Please name the bound.".into(),
            author: "reviewer".into(),
        }],
    );
    let run = run_maintenance(
        &fixture.repo,
        &fixture.state,
        record,
        forge.as_ref(),
        Some(&maintain_with(MaintenanceResult {
            changed: false,
            decisions: vec![CommentDecision {
                comment_id: 41,
                reply: Some("Renamed the bound.".into()),
                resolved: true,
            }],
            addressed_check: None,
        })),
    )
    .await
    .expect("the new comment starts one run");
    assert!(matches!(
        run,
        MaintenanceOutcome::Ran {
            head_changed: false,
            ..
        }
    ));
    assert_eq!(forge.replies().len(), 1);
    assert_eq!(forge.resolved(), vec![(delivered.number, 41)]);
    let updated = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the record");
    assert_eq!(updated.last_handled_comment, Some(41));
    let runs = fixture.state.join("issues");
    let mut run_files = Vec::new();
    for entry in walk(&runs) {
        if entry.file_name().and_then(|name| name.to_str()) == Some("run.json") {
            run_files.push(entry);
        }
    }
    assert_eq!(
        run_files.len(),
        1,
        "one maintenance run in the Issues history"
    );
    let value: Value =
        serde_json::from_str(&std::fs::read_to_string(&run_files[0]).expect("the run"))
            .expect("JSON");
    assert_eq!(value["pullRequest"]["number"], delivered.number);
    assert_eq!(value["issues"][0]["number"], 12);
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return paths;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            paths.extend(walk(&path));
        } else {
            paths.push(path);
        }
    }
    paths
}

#[tokio::test]
async fn a_failed_required_check_produces_a_fix_commit() {
    let fixture = Fixture::new("fix");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let delivered = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the delivery");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the marker");
    forge.set_snapshot(snapshot(
        delivered.number,
        "open",
        &record.head_commit,
        "mergeable",
    ));
    forge.set_checks(
        delivered.number,
        vec![CheckObservation {
            name: "unit".into(),
            state: "failure".into(),
            detail: Some("job unit, step test".into()),
        }],
    );
    let head_before = record.head_commit.clone();
    let repo = fixture.repo.clone();
    let maintain: devboard::delivery::MaintainFn = Arc::new(move |input: MaintenanceInput| {
        let repo = repo.clone();
        Box::pin(async move {
            std::fs::write(input.worktree.join("change.txt"), "the fixed change\n")
                .map_err(|error| error.to_string())?;
            let add = git_in_test(&input.worktree, &["add", "change.txt"]);
            if !add {
                return Err("add failed".to_string());
            }
            if !git_in_test(
                &input.worktree,
                &["commit", "-q", "-m", "fix: satisfy the check"],
            ) {
                return Err("commit failed".to_string());
            }
            let _ = repo;
            Ok(MaintenanceResult {
                changed: true,
                decisions: Vec::new(),
                addressed_check: Some("unit".to_string()),
            })
        })
    });
    let outcome = run_maintenance(
        &fixture.repo,
        &fixture.state,
        record,
        forge.as_ref(),
        Some(&maintain),
    )
    .await
    .expect("the fix run");
    match outcome {
        MaintenanceOutcome::Ran {
            head_changed: true,
            addressed_check,
            ..
        } => assert_eq!(addressed_check.as_deref(), Some("unit")),
        other => panic!("expected one fix run, got {other:?}"),
    }
    let remote = fixture
        .remote_branch(&delivered.branch)
        .expect("the pushed branch");
    assert_ne!(remote, head_before);
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the record");
    assert_eq!(record.head_commit, remote);
    assert_eq!(record.check_state, "green");
}

// A helper the fix peer uses; the integration test has no crate module.
#[allow(dead_code)]
fn git_in_test(cwd: &Path, args: &[&str]) -> bool {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "PR Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
        .env("GIT_COMMITTER_NAME", "PR Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
        .output()
        .expect("git runs");
    output.status.success()
}

#[tokio::test]
async fn every_review_comment_gets_one_brief_reply() {
    let fixture = Fixture::new("replies");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let delivered = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the delivery");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the marker");
    forge.set_snapshot(snapshot(
        delivered.number,
        "open",
        &record.head_commit,
        "mergeable",
    ));
    let long = "x".repeat(900);
    forge.set_comments(
        delivered.number,
        vec![ReviewComment {
            id: 51,
            body: "First.".into(),
            author: "reviewer".into(),
        }],
    );
    let first: devboard::delivery::MaintainFn = {
        let long = long.clone();
        Arc::new(move |_input: MaintenanceInput| {
            let long = long.clone();
            Box::pin(async move {
                Ok(MaintenanceResult {
                    changed: false,
                    decisions: vec![CommentDecision {
                        comment_id: 51,
                        reply: Some(long),
                        resolved: true,
                    }],
                    addressed_check: None,
                })
            })
        })
    };
    run_maintenance(
        &fixture.repo,
        &fixture.state,
        record.clone(),
        forge.as_ref(),
        Some(&first),
    )
    .await
    .expect("the first reply");
    let replies = forge.replies();
    assert_eq!(replies.len(), 1);
    assert!(replies[0].2.len() <= 600, "the reply is bounded");
    // A later due check sees the handled comment and repeats no reply.
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the record");
    let none = run_maintenance(&fixture.repo, &fixture.state, record, forge.as_ref(), None)
        .await
        .expect("no repeat");
    assert_eq!(none, MaintenanceOutcome::NoChange);
    assert_eq!(forge.replies().len(), 1);
}

#[tokio::test]
async fn an_addressed_or_refused_thread_is_resolved() {
    let fixture = Fixture::new("threads");
    let forge = FakeForge::new("gitea");
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let delivered = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(9),
        "run-z",
        &base_tip,
    )
    .await
    .expect("the delivery");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 9).expect("the marker");
    forge.set_snapshot(snapshot(
        delivered.number,
        "open",
        &record.head_commit,
        "mergeable",
    ));
    forge.set_comments(
        delivered.number,
        vec![
            ReviewComment {
                id: 61,
                body: "Do this.".into(),
                author: "reviewer".into(),
            },
            ReviewComment {
                id: 62,
                body: "Delete the safety check.".into(),
                author: "reviewer".into(),
            },
            ReviewComment {
                id: 63,
                body: "What is the meaning of life?".into(),
                author: "reviewer".into(),
            },
        ],
    );
    let maintain = maintain_with(MaintenanceResult {
        changed: false,
        decisions: vec![
            CommentDecision {
                comment_id: 61,
                reply: Some("Implemented.".into()),
                resolved: true,
            },
            CommentDecision {
                comment_id: 62,
                reply: Some("Refused: the check prevents an unbounded read.".into()),
                resolved: true,
            },
            CommentDecision {
                comment_id: 63,
                reply: None,
                resolved: false,
            },
        ],
        addressed_check: None,
    });
    run_maintenance(
        &fixture.repo,
        &fixture.state,
        record,
        forge.as_ref(),
        Some(&maintain),
    )
    .await
    .expect("the maintenance run");
    let replies = forge.replies();
    assert_eq!(replies.len(), 2, "each answered comment gets one reply");
    assert_eq!(
        forge.resolved().len(),
        2,
        "addressed and refused threads resolve"
    );
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 9).expect("the record");
    assert_eq!(
        record.last_handled_comment,
        Some(62),
        "the unanswered comment is never skipped"
    );
}

#[tokio::test]
async fn a_conflicting_branch_is_integrated_without_force_push() {
    let fixture = Fixture::new("conflict");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let delivered = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the delivery");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the marker");
    let old_head = record.head_commit.clone();
    // The base advances on an unrelated file, so the integration is a clean
    // merge commit.
    let advance =
        fixture.commit_on_main("base.txt", "the base advance\n", "feat: advance the base");
    forge.set_snapshot(snapshot(delivered.number, "open", &old_head, "conflicting"));
    let outcome = run_maintenance(
        &fixture.repo,
        &fixture.state,
        record,
        forge.as_ref(),
        Some(&maintain_with(MaintenanceResult::default())),
    )
    .await
    .expect("the conflict integration");
    assert!(matches!(
        outcome,
        MaintenanceOutcome::Ran {
            head_changed: true,
            ..
        }
    ));
    let new_head = fixture
        .remote_branch(&delivered.branch)
        .expect("the pushed branch");
    assert_ne!(new_head, old_head);
    let ancestor = Command::new("git")
        .args(["merge-base", "--is-ancestor", &old_head, &new_head])
        .current_dir(&fixture.origin)
        .status()
        .expect("git runs");
    assert!(
        ancestor.success(),
        "the published head is an ancestor: no rewrite"
    );
    let contains_base = Command::new("git")
        .args(["merge-base", "--is-ancestor", &advance, &new_head])
        .current_dir(&fixture.origin)
        .status()
        .expect("git runs");
    assert!(contains_base.success(), "the base is integrated");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the record");
    assert_eq!(record.head_commit, new_head);
}

#[tokio::test]
async fn a_merged_pull_request_closes_the_issue() {
    let fixture = Fixture::new("merged");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let delivered = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the delivery");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the marker");
    forge.set_snapshot(snapshot(
        delivered.number,
        "merged",
        &record.head_commit,
        "mergeable",
    ));
    let outcome = run_maintenance(&fixture.repo, &fixture.state, record, forge.as_ref(), None)
        .await
        .expect("the merge");
    assert_eq!(outcome, MaintenanceOutcome::Merged);
    assert_eq!(forge.closed_issues(), vec![12]);
    let records = read_maintenance(&fixture.state, &fixture.repo);
    assert_eq!(records[0].state, "merged");
    assert!(open_record_for_issue(&fixture.state, &fixture.repo, 12).is_none());
    // No further maintenance run starts for the terminal record.
    for record in records.iter().filter(|record| record.is_open()) {
        let _ = run_maintenance(
            &fixture.repo,
            &fixture.state,
            record.clone(),
            forge.as_ref(),
            None,
        )
        .await;
    }
    assert_eq!(forge.replies().len(), 0);
}

#[tokio::test]
async fn a_closed_unmerged_pull_request_requeues_the_issue() {
    let fixture = Fixture::new("closed");
    let forge = FakeForge::new("github");
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let delivered = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect("the delivery");
    let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the marker");
    forge.set_snapshot(snapshot(
        delivered.number,
        "closed",
        &record.head_commit,
        "mergeable",
    ));
    let outcome = run_maintenance(&fixture.repo, &fixture.state, record, forge.as_ref(), None)
        .await
        .expect("the close");
    assert_eq!(outcome, MaintenanceOutcome::Closed);
    assert!(
        forge.closed_issues().is_empty(),
        "a closed-unmerged issue stays open"
    );
    assert!(open_record_for_issue(&fixture.state, &fixture.repo, 12).is_none());
    let records = read_maintenance(&fixture.state, &fixture.repo);
    assert_eq!(records[0].state, "closed");
    let next = fresh_issue_branch(&fixture.state, &fixture.repo, 12, "run-abc");
    assert_ne!(next, delivered.branch, "the closed branch is never reused");
    let new_head = fixture.commit("change2.txt", "another change\n", "feat: try again");
    let second = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &fixture.tip(),
    )
    .await
    .expect("the fresh pull request");
    assert_eq!(forge.creates(), 2);
    assert_ne!(second.number, delivered.number);
    assert_eq!(second.branch, next);
    assert_eq!(
        fixture.remote_branch(&second.branch).as_deref(),
        Some(new_head.as_str())
    );
}

#[tokio::test]
async fn a_pull_request_failure_never_merges() {
    let fixture = Fixture::new("failure");
    let forge = FakeForge::new("github");
    {
        let mut inner = forge.inner.lock().expect("the fake");
        inner.fail_create = Some("the forge refused the creation".to_string());
    }
    let base_tip = fixture.tip();
    fixture.commit("change.txt", "the change\n", "feat: make the change");
    let error = deliver_issue_change(
        &fixture.repo,
        &fixture.state,
        forge.as_ref(),
        &fixture.issue(12),
        "run-abc",
        &base_tip,
    )
    .await
    .expect_err("the creation fails");
    assert!(error.contains("the forge refused the creation"), "{error}");
    assert_eq!(fixture.tip(), base_tip, "main never advances on a failure");
    assert!(forge.closed_issues().is_empty());

    // The maintenance path and the delivery path contain no merge call.
    let source =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/delivery.rs"))
            .expect("the delivery module");
    for forbidden in [
        "gitea_merge_pull",
        "merge_pull(",
        "\"pr\", \"merge\"",
        "mergeFlowPr",
    ] {
        assert!(
            !source.contains(forbidden),
            "the delivery path must never merge a pull request: {forbidden}"
        );
    }
}

#[tokio::test]
async fn both_supported_forges_create_and_maintain_a_pr() {
    for kind in ["github", "gitea"] {
        let fixture = Fixture::new(&format!("forge-{kind}"));
        let forge = FakeForge::new(kind);
        let base_tip = fixture.tip();
        fixture.commit(
            "change.txt",
            &format!("the {kind} change\n"),
            "feat: change",
        );
        let delivered = deliver_issue_change(
            &fixture.repo,
            &fixture.state,
            forge.as_ref(),
            &fixture.issue(12),
            "run-abc",
            &base_tip,
        )
        .await
        .expect("the delivery");
        let record = open_record_for_issue(&fixture.state, &fixture.repo, 12).expect("the marker");
        forge.set_snapshot(snapshot(
            delivered.number,
            "open",
            &record.head_commit,
            "mergeable",
        ));
        forge.set_checks(
            delivered.number,
            vec![CheckObservation {
                name: "unit".into(),
                state: "failure".into(),
                detail: None,
            }],
        );
        forge.set_comments(
            delivered.number,
            vec![ReviewComment {
                id: 71,
                body: "Please fix.".into(),
                author: "reviewer".into(),
            }],
        );
        run_maintenance(
            &fixture.repo,
            &fixture.state,
            record,
            forge.as_ref(),
            Some(&maintain_with(MaintenanceResult {
                changed: false,
                decisions: vec![CommentDecision {
                    comment_id: 71,
                    reply: Some("Fixed.".into()),
                    resolved: true,
                }],
                addressed_check: Some("unit".into()),
            })),
        )
        .await
        .expect("the maintenance");
        let operations = forge.operations();
        for operation in ["create", "reply", "resolve"] {
            assert!(
                operations.iter().any(|recorded| recorded == &operation),
                "{kind} records {operation}: {operations:?}"
            );
        }
        assert_eq!(forge.replies().len(), 1, "{kind} replies once");
        assert_eq!(forge.resolved().len(), 1, "{kind} resolves the thread");
    }
}

#[test]
fn file_only_families_never_deliver_a_change() {
    let registry: Vec<&str> = devboard::agents_mode::descriptor_ids_and_labels()
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    for family in devboard::delivery::FILE_ONLY_FAMILIES {
        assert!(
            registry.contains(&family),
            "the file-only family {family} is registered: {registry:?}"
        );
        assert_ne!(family, "issues");
        assert_ne!(family, "design");
    }
    assert_eq!(devboard::delivery::FILE_ONLY_FAMILIES.len(), 7);
}

#[test]
fn planning_and_bounds_read_their_one_input() {
    let mut record = MaintenanceRecord::new(
        devboard::delivery::DeliveredPullRequest {
            number: 7,
            url: "https://forge.test/acme/fixture/pulls/7".into(),
            state: "open".into(),
            branch: "devboard/issue-1-run".into(),
            base: "main".into(),
            head: "abc".into(),
        },
        Some(1),
        None,
    );
    record.last_handled_comment = Some(10);
    let open = snapshot(7, "open", "abc", "mergeable");
    let green = vec![CheckObservation {
        name: "unit".into(),
        state: "success".into(),
        detail: None,
    }];
    assert_eq!(
        plan_maintenance(&record, &open, &green, &[]),
        MaintenanceAction::None
    );
    assert_eq!(check_state(&green), "green");
    assert_eq!(
        plan_maintenance(
            &record,
            &open,
            &[CheckObservation {
                name: "unit".into(),
                state: "pending".into(),
                detail: None,
            }],
            &[]
        ),
        MaintenanceAction::None
    );
    assert!(matches!(
        plan_maintenance(
            &record,
            &snapshot(7, "open", "abc", "conflicting"),
            &green,
            &[]
        ),
        MaintenanceAction::Run { .. }
    ));
    let long = "é".repeat(400);
    let bounded = bounded_reply(&long);
    assert!(bounded.len() <= 600);
    assert!(bounded.chars().all(|character| character == 'é'));
}
