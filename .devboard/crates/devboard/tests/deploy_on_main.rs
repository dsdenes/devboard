//! The push-triggered Deploy on main family: the advance trigger, coalescing,
//! the fast-forwarded deploy worktree, the prompt contract, run history, and
//! issue dedup.
//!
//! Every fixture is a real Git repository under `.test-tmp`. The deploy runner
//! is injected unless a test proves the real `omp acp` path, and every issue
//! write is injected, so no test contacts a network.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use devboard::app::{App, Conn};
use devboard::command::Command as WireCommand;
use devboard::config::Config;
use devboard::journal::Journal;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::watch;

use devboard::workers::deploy_on_main::{
    deploy_directory, deploy_worktree_path, DeployRunInput, DeployRunResult, DeployState,
    DeployWorker, DeployWorkerOptions, IssueRequest, RunDeployFn, RunFuture,
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!(
            "deploy-on-main-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a scratch root");
    std::fs::canonicalize(&root).unwrap_or(root)
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-c")
        .arg("user.name=Deploy Fixture")
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
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

struct Fixture {
    repo: PathBuf,
    state: PathBuf,
    counter: Mutex<u64>,
}

impl Fixture {
    /// A host project: a real git repository with `main`, a `.devboard`
    /// directory that is not a harness source manifest, and an `AGENTS.md`
    /// carrying a deploy section unless `deploy_section` says otherwise.
    fn new(label: &str, deploy_section: bool) -> Self {
        let root = scratch(label);
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join(".devboard/prompts")).expect("a harness directory");
        std::fs::create_dir_all(root.join("state")).expect("a state directory");
        git(&repo, &["init", "--quiet"]);
        let deploy = if deploy_section {
            "## Deploy\n\nRun `scripts/deploy.sh` in the deploy worktree.\n"
        } else {
            "## Development\n\nRun the tests.\n"
        };
        std::fs::write(
            repo.join("AGENTS.md"),
            format!("# Fixture host\n\n{deploy}\n## Map\n\n- `scripts/`\n"),
        )
        .expect("an AGENTS.md");
        std::fs::write(
            repo.join(".devboard/prompts/deploy-on-main.md"),
            "# fixture prompt\n",
        )
        .expect("a prompt file");
        std::fs::create_dir_all(repo.join("scripts")).expect("a scripts directory");
        std::fs::write(repo.join("scripts/deploy.sh"), "#!/bin/sh\nexit 0\n")
            .expect("a deploy script");
        git(&repo, &["add", "--all"]);
        git(&repo, &["commit", "--quiet", "--message", "fixture"]);
        Self {
            repo,
            state: root.join("state"),
            counter: Mutex::new(0),
        }
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.repo, args)
    }

    /// Advances `main` by one commit and returns its full sha.
    fn commit(&self, message: &str) -> String {
        let mut counter = self.counter.lock().expect("the counter");
        *counter += 1;
        std::fs::write(
            self.repo.join("advance.txt"),
            format!("{message} {}\n", *counter),
        )
        .expect("an advance file");
        self.git(&["add", "--all"]);
        self.git(&["commit", "--quiet", "--message", message]);
        self.head()
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }

    fn main_tip(&self) -> String {
        self.git(&["rev-parse", "refs/heads/main"])
    }

    fn worktree(&self) -> PathBuf {
        deploy_worktree_path(&self.repo)
    }

    fn directory(&self) -> PathBuf {
        deploy_directory(&self.state)
    }

    fn status(&self) -> String {
        self.git(&["status", "--porcelain"])
    }

    fn state(&self) -> DeployState {
        devboard::workers::deploy_on_main::read_state(&self.directory())
            .expect("the deploy state file")
    }
}

/// A deploy runner whose runs block until the test releases them, so two
/// advances can land inside one live run.
#[derive(Clone)]
struct Gate {
    calls: Arc<Mutex<Vec<Value>>>,
    started: watch::Sender<usize>,
    release: watch::Sender<bool>,
    active: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

impl Gate {
    fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            started: watch::channel(0).0,
            release: watch::channel(false).0,
            active: Arc::new(AtomicUsize::new(0)),
            peak: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn runner(&self) -> RunDeployFn {
        let gate = self.clone();
        Arc::new(move |input: DeployRunInput| -> RunFuture {
            let gate = gate.clone();
            Box::pin(async move {
                let now = gate.active.fetch_add(1, Ordering::SeqCst) + 1;
                gate.peak.fetch_max(now, Ordering::SeqCst);
                let count = {
                    let mut calls = gate.calls.lock().expect("calls");
                    calls.push(json!({
                        "commit": input.run.commit,
                        "worktree": input.worktree.to_string_lossy(),
                        "runDir": input.run_dir.to_string_lossy(),
                    }));
                    calls.len()
                };
                let _ = gate.started.send(count);
                let mut release = gate.release.subscribe();
                let _ = release.wait_for(|released| *released).await;
                gate.active.fetch_sub(1, Ordering::SeqCst);
                DeployRunResult::Succeeded {
                    detail: Some("the fixture deployed".to_string()),
                }
            })
        })
    }

    async fn wait_started(&self, count: usize) {
        let mut started = self.started.subscribe();
        let waited = tokio::time::timeout(
            Duration::from_secs(5),
            started.wait_for(|value| *value >= count),
        )
        .await;
        assert!(waited.is_ok(), "run {count} did not start within 5 seconds");
    }

    fn release_all(&self) {
        let _ = self.release.send(true);
    }

    fn commits(&self) -> Vec<String> {
        self.calls
            .lock()
            .expect("calls")
            .iter()
            .filter_map(|call| call.get("commit").and_then(Value::as_str))
            .map(str::to_string)
            .collect()
    }
}

fn worker(
    fixture: &Fixture,
    run_deploy: RunDeployFn,
    file_issue: devboard::workers::deploy_on_main::IssueFn,
) -> Arc<DeployWorker> {
    let mut options = DeployWorkerOptions::new(&fixture.repo, &fixture.state);
    options.run_deploy = Some(run_deploy);
    options.file_issue = Some(file_issue);
    options.control_poll_ms = Some(20);
    Arc::new(DeployWorker::new(options))
}

fn no_issues() -> (
    devboard::workers::deploy_on_main::IssueFn,
    Arc<Mutex<Vec<IssueRequest>>>,
) {
    let requests: Arc<Mutex<Vec<IssueRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    let file: devboard::workers::deploy_on_main::IssueFn =
        Arc::new(move |request: IssueRequest| {
            recorded.lock().expect("issues").push(request);
            Box::pin(async { Ok("https://example.test/issues/1".to_string()) }) as _
        });
    (file, requests)
}

async fn wait_for_runs(worker: &DeployWorker, count: usize) {
    let started = Instant::now();
    loop {
        if worker.current_state().runs.len() >= count {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the worker published {} run(s), expected {count}",
            worker.current_state().runs.len()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_settled(worker: &DeployWorker, count: usize) {
    let started = Instant::now();
    loop {
        let state = worker.current_state();
        if state.runs.len() >= count
            && state
                .runs
                .iter()
                .take(count)
                .all(|run| run.state.as_str() != "running")
        {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the run did not settle: {state:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_worker_started(worker: &DeployWorker) {
    let started = Instant::now();
    while worker.current_worker().is_none() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the worker did not begin"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // The ref watcher is registered inside `run` just after `begin`; one short
    // turn lets it arm before the triggering commit lands.
    tokio::time::sleep(Duration::from_millis(50)).await;
}

fn spawn_worker(worker: &Arc<DeployWorker>) -> tokio::task::JoinHandle<i32> {
    let worker = Arc::clone(worker);
    tokio::spawn(async move { worker.run().await })
}

#[tokio::test]
async fn starting_never_deploys_the_baseline_and_one_advance_starts_one_run() {
    let fixture = Fixture::new("trigger", true);
    let gate = Gate::new();
    let (issue, _issues) = no_issues();
    let worker = worker(&fixture, gate.runner(), issue);
    let task = spawn_worker(&worker);
    wait_worker_started(&worker).await;
    assert!(
        worker.current_state().runs.is_empty(),
        "the tip at start is the baseline"
    );

    let commit = fixture.commit("advance one");
    gate.wait_started(1).await;
    wait_for_runs(&worker, 1).await;
    let run = worker.current_state().runs[0].clone();
    assert_eq!(run.commit, commit);
    assert_eq!(run.worktree, fixture.worktree().to_string_lossy());
    assert_eq!(run.state.as_str(), "running");
    assert_eq!(
        fixture.main_tip(),
        commit,
        "the served main names the triggering commit"
    );

    gate.release_all();
    wait_settled(&worker, 1).await;
    let state = worker.current_state();
    assert_eq!(state.runs.len(), 1, "one advance appends one run");
    assert_eq!(state.runs[0].state.as_str(), "succeeded");
    assert_eq!(state.runs[0].commit, commit);

    worker.stop().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
}

#[tokio::test]
async fn two_advances_during_one_live_run_coalesce_to_one_run_at_the_newest_tip() {
    let fixture = Fixture::new("coalesce", true);
    let gate = Gate::new();
    let (issue, _issues) = no_issues();
    let worker = worker(&fixture, gate.runner(), issue);
    let task = spawn_worker(&worker);
    wait_worker_started(&worker).await;

    let first = fixture.commit("first advance");
    gate.wait_started(1).await;
    wait_for_runs(&worker, 1).await;
    assert_eq!(worker.current_state().runs[0].commit, first);

    let second = fixture.commit("second advance");
    let third = fixture.commit("third advance");
    assert_ne!(second, third);
    // Both advances landed while the first run is blocked in its peer.
    assert_eq!(gate.commits().len(), 1);
    gate.release_all();

    gate.wait_started(2).await;
    wait_settled(&worker, 2).await;
    let state = worker.current_state();
    assert_eq!(state.runs.len(), 2, "{state:?}");
    assert_eq!(state.runs[0].commit, third, "the newest tip wins");
    assert_eq!(state.runs[1].commit, first);
    assert_eq!(gate.commits(), vec![first, third]);
    assert_eq!(
        gate.peak.load(Ordering::SeqCst),
        1,
        "two deploy peers never run at once"
    );

    worker.stop().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
}

#[tokio::test]
async fn a_run_creates_and_reuses_the_deploy_worktree_and_leaves_the_served_tree_unchanged() {
    let fixture = Fixture::new("worktree", true);
    let status_before = fixture.status();
    let worktree = fixture.worktree();
    let observed: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&observed);
    let worktree_for_runner = worktree.clone();
    let runner: RunDeployFn = Arc::new(move |input: DeployRunInput| {
        let recorded = Arc::clone(&recorded);
        let worktree = worktree_for_runner.clone();
        Box::pin(async move {
            assert_eq!(
                input.worktree, worktree,
                "the peer runs in the deploy worktree"
            );
            let head = Command::new("git")
                .args(["-C", worktree.to_str().expect("a path")])
                .args(["rev-parse", "HEAD"])
                .output()
                .expect("git runs");
            let cwd = Command::new("sh")
                .arg("-c")
                .arg("pwd")
                .current_dir(&worktree)
                .output()
                .expect("pwd runs");
            recorded.lock().expect("observed").push(json!({
                "commit": input.run.commit,
                "worktree": input.worktree.to_string_lossy(),
                "head": String::from_utf8_lossy(&head.stdout).trim(),
                "cwd": String::from_utf8_lossy(&cwd.stdout).trim(),
            }));
            DeployRunResult::Succeeded { detail: None }
        })
    });
    let (issue, _issues) = no_issues();
    let worker = worker(&fixture, runner, issue);
    let task = spawn_worker(&worker);
    wait_worker_started(&worker).await;

    let first = fixture.commit("first deploy");
    wait_settled(&worker, 1).await;
    {
        let seen = observed.lock().expect("observed");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["commit"], json!(first));
        assert_eq!(seen[0]["worktree"], json!(worktree.to_string_lossy()));
        assert_eq!(seen[0]["head"], json!(first));
        assert_eq!(seen[0]["cwd"], json!(worktree.to_string_lossy()));
    }
    assert!(worktree.join(".git").exists(), "the worktree was created");
    assert_eq!(
        fixture.git(&[
            "-C",
            worktree.to_str().expect("a path"),
            "rev-parse",
            "HEAD"
        ]),
        first
    );
    assert_eq!(
        fixture.status(),
        status_before,
        "the served checkout's tracked tree is unchanged"
    );

    // The next advance reuses the same worktree and moves it forward.
    let second = fixture.commit("second deploy");
    wait_settled(&worker, 2).await;
    {
        let seen = observed.lock().expect("observed");
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[1]["worktree"], json!(worktree.to_string_lossy()));
        assert_eq!(seen[1]["head"], json!(second));
    }
    assert_eq!(
        fixture.git(&[
            "-C",
            worktree.to_str().expect("a path"),
            "rev-parse",
            "HEAD"
        ]),
        second
    );
    assert_eq!(fixture.status(), status_before);

    worker.stop().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
}

#[tokio::test]
async fn a_non_descendant_tip_fails_without_moving_the_worktree_or_starting_a_peer() {
    let fixture = Fixture::new("non-descendant", true);
    let gate = Gate::new();
    let (issue, _issues) = no_issues();
    let worker = worker(&fixture, gate.runner(), issue);
    let task = spawn_worker(&worker);
    wait_worker_started(&worker).await;

    let first = fixture.commit("the deploy baseline");
    gate.wait_started(1).await;
    gate.release_all();
    wait_settled(&worker, 1).await;
    assert_eq!(
        fixture.git(&[
            "-C",
            fixture.worktree().to_str().expect("a path"),
            "rev-parse",
            "HEAD"
        ]),
        first
    );

    // An unrelated root commit: `main` moves to history the deploy worktree
    // does not descend from.
    fixture.git(&["checkout", "--quiet", "--orphan", "unrelated"]);
    fixture.git(&["rm", "-r", "--quiet", "--cached", "."]);
    for entry in std::fs::read_dir(&fixture.repo).expect("the fixture") {
        let path = entry.expect("an entry").path();
        if matches!(
            path.file_name().and_then(|name| name.to_str()),
            Some(".git") | Some(".worktree")
        ) {
            continue;
        }
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    std::fs::write(fixture.repo.join("unrelated.txt"), "unrelated\n").expect("a file");
    fixture.git(&["add", "--all"]);
    fixture.git(&["commit", "--quiet", "--message", "unrelated root"]);
    let unrelated = fixture.head();
    fixture.git(&["update-ref", "refs/heads/main", &unrelated]);

    wait_settled(&worker, 2).await;
    let state = worker.current_state();
    assert_eq!(state.runs.len(), 2, "{state:?}");
    assert_eq!(state.runs[0].commit, unrelated);
    assert_eq!(state.runs[0].state.as_str(), "failed");
    let detail = state.runs[0].detail.clone().unwrap_or_default();
    assert!(detail.contains(&unrelated), "{detail}");
    assert!(detail.contains(&first), "{detail}");
    assert!(
        state.runs[0].peer.is_none(),
        "a refused tip starts no peer: {state:?}"
    );
    assert_eq!(gate.commits().len(), 1, "no second peer ran");
    assert_eq!(
        fixture.git(&[
            "-C",
            fixture.worktree().to_str().expect("a path"),
            "rev-parse",
            "HEAD"
        ]),
        first,
        "the worktree never moved"
    );

    worker.stop().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
}

#[tokio::test]
async fn an_agents_md_without_deploy_instructions_skips_without_an_issue() {
    let fixture = Fixture::new("no-instructions", false);
    let gate = Gate::new();
    let (issue, issues) = no_issues();
    let worker = worker(&fixture, gate.runner(), issue);
    let task = spawn_worker(&worker);
    wait_worker_started(&worker).await;

    fixture.commit("an advance with nothing to run");
    wait_settled(&worker, 1).await;
    let state = worker.current_state();
    assert_eq!(state.runs[0].state.as_str(), "skipped", "{state:?}");
    let detail = state.runs[0].detail.clone().unwrap_or_default();
    assert!(detail.contains("no deploy instructions"), "{detail}");
    assert!(state.issues.is_empty(), "a skipped run files no issue");
    assert!(issues.lock().expect("issues").is_empty());
    assert!(gate.commits().is_empty(), "no peer started");

    worker.stop().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
}

#[tokio::test]
async fn a_failed_run_files_one_issue_per_commit_and_a_repeat_files_none() {
    let fixture = Fixture::new("issue-dedup", true);
    let (issue, issues) = no_issues();
    let runner: RunDeployFn = Arc::new(|_input: DeployRunInput| {
        Box::pin(async { DeployRunResult::failed("the fixture deploy failed") })
    });
    let worker = worker(&fixture, runner, issue);
    let task = spawn_worker(&worker);
    wait_worker_started(&worker).await;

    let commit = fixture.commit("a failing advance");
    wait_settled(&worker, 1).await;
    let state = worker.current_state();
    assert_eq!(state.runs[0].state.as_str(), "failed");
    assert_eq!(state.issues.len(), 1, "{state:?}");
    assert_eq!(state.issued_commits, vec![commit.clone()]);
    assert_eq!(issues.lock().expect("issues").len(), 1);

    // Check now retries the same commit; its failure files nothing new.
    worker.tick_now().await;
    wait_settled(&worker, 2).await;
    let state = worker.current_state();
    assert_eq!(state.runs.len(), 2, "a retry is its own run record");
    assert_eq!(state.runs[0].commit, commit);
    assert_eq!(state.runs[0].state.as_str(), "failed");
    assert_eq!(state.issues.len(), 1, "one issue per commit");
    assert_eq!(issues.lock().expect("issues").len(), 1);

    worker.stop().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    let _ = fixture.state();
}

#[tokio::test]
async fn the_default_peer_starts_in_the_deploy_worktree_at_the_triggering_commit() {
    let fixture = Fixture::new("real-peer", true);
    let provider_log = fixture.repo.parent().expect("a root").join("peer.jsonl");
    let stub = format!(
        "{} acp-stub --provider-env={}",
        env!("CARGO_BIN_EXE_devboard"),
        provider_log.display()
    );
    let mut options = DeployWorkerOptions::new(&fixture.repo, &fixture.state);
    options.agent_command = Some(stub);
    options.control_poll_ms = Some(20);
    let worker = Arc::new(DeployWorker::new(options));
    let task = spawn_worker(&worker);
    wait_worker_started(&worker).await;

    let commit = fixture.commit("deploy through a real peer");
    wait_settled(&worker, 1).await;
    let state = worker.current_state();
    let run = &state.runs[0];
    assert!(run.peer.is_some(), "the peer is recorded: {state:?}");
    let log = std::fs::read_to_string(&provider_log).expect("the provider log");
    let first: Value =
        serde_json::from_str(log.lines().next().expect("one line")).expect("a JSON line");
    assert_eq!(
        first["cwd"],
        json!(fixture.worktree().to_string_lossy()),
        "the peer's working directory is the deploy worktree"
    );
    assert_eq!(run.commit, commit);

    worker.stop().await;
    let _ = tokio::time::timeout(Duration::from_secs(10), task).await;
}

#[test]
fn the_deploy_instructions_are_one_heading_section() {
    use devboard::workers::deploy_on_main::deploy_instructions;
    let document = "# Host\n\n## Deploy\n\nRun `a`.\nStill deploying.\n\n## Map\n\n- x\n";
    let section = deploy_instructions(document).expect("a deploy section");
    assert_eq!(section, "Run `a`.\nStill deploying.");
    assert_eq!(deploy_instructions("# Host\n\n## Map\n\n- x\n"), None);
    assert_eq!(
        deploy_instructions("## Deploy\n\n### Steps\n\nRun `b`.\n"),
        Some("### Steps\n\nRun `b`.".to_string())
    );
}

#[test]
fn a_host_project_is_not_a_harness_source_checkout() {
    let fixture = Fixture::new("kind", true);
    assert!(!devboard::version::is_harness_source_checkout(
        &fixture.repo
    ));
    assert_eq!(
        devboard::project_kind::reason(devboard::project_kind::Gate::HostProject, &fixture.repo),
        None
    );
    assert!(devboard::project_kind::reason(
        devboard::project_kind::Gate::HarnessSource,
        &fixture.repo
    )
    .is_some());
}

#[test]
fn the_registry_command_maps_the_deploy_family_to_its_worker() {
    let families = devboard::workers::FAMILIES;
    assert!(families.contains(&"deploy-on-main"));
    assert_eq!(
        devboard::project_kind::gate_for_family("deploy-on-main"),
        devboard::project_kind::Gate::HostProject
    );
    let refusal = devboard::project_kind::refusal(
        "deploy-on-main",
        devboard::project_kind::Gate::HostProject,
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .as_path(),
    )
    .expect("the harness source checkout refuses deploy");
    assert!(refusal.contains("host projects"), "{refusal}");
}

fn seeded_run(id: &str, state: &str, commit: &str, at: &str, commits: Option<i64>) -> Value {
    let mut run = json!({
        "version": 1,
        "id": id,
        "startedAt": at,
        "endedAt": at,
        "state": state,
        "commit": commit,
        "worktree": "/fixture/.worktree/deploy-main",
        "detail": "seeded",
        "peer": null,
    });
    if let Some(commits) = commits {
        run["commits"] = json!(commits);
    }
    run
}

fn seed_history(fixture: &Fixture, runs: Vec<Value>) {
    let directory = fixture.directory();
    std::fs::create_dir_all(&directory).expect("the deploy directory");
    let state = json!({
        "version": 1,
        "repo": fixture.repo.to_string_lossy(),
        "root": fixture.repo.to_string_lossy(),
        "updatedAt": "2026-11-01T00:00:00.000Z",
        "activity": [],
        "runs": runs,
        "issues": [],
        "issuedCommits": [],
        "lastCommit": null,
    });
    std::fs::write(directory.join("state.json"), format!("{state}\n"))
        .expect("a seeded deploy state");
}

fn fixture_app(fixture: &Fixture) -> Arc<App> {
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: fixture.repo.join("adrs"),
        repo_dir: fixture.repo.clone(),
        goal_file: fixture.repo.join("GOAL.md"),
        static_dir: None,
        agent_command: "omp acp".to_string(),
        state_dir: fixture.state.clone(),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 1);
    App::new(config, journal)
}

async fn fixture_connection(app: &Arc<App>) -> (Conn, UnboundedReceiver<String>) {
    let (outbox, inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = Conn::new(outbox);
    app.register(conn.clone()).await;
    (conn, inbox)
}

fn drain(inbox: &mut UnboundedReceiver<String>) -> Vec<Value> {
    let mut result = Vec::new();
    while let Ok(text) = inbox.try_recv() {
        result.push(serde_json::from_str(&text).expect("a JSON frame"));
    }
    result
}

#[tokio::test]
async fn old_records_are_backfilled_and_the_deploy_snapshot_lists_the_history() {
    let fixture = Fixture::new("history-backfill", true);
    let base = fixture.head();
    let _first = fixture.commit("first");
    let failing = fixture.commit("failing");
    let skipped = fixture.commit("skipped");
    let stopped = fixture.commit("stopped");
    let success = fixture.commit("success");
    assert_eq!(fixture.head(), success);

    // Newest first, exactly as the worker records them. Only the last success
    // carries a count already; every other record predates the field.
    seed_history(
        &fixture,
        vec![
            seeded_run(
                "run-5",
                "succeeded",
                &success,
                "2026-11-05T05:00:00.000Z",
                None,
            ),
            seeded_run(
                "run-4",
                "stopped",
                &stopped,
                "2026-11-04T04:00:00.000Z",
                None,
            ),
            seeded_run(
                "run-3",
                "skipped",
                &skipped,
                "2026-11-03T03:00:00.000Z",
                None,
            ),
            seeded_run(
                "run-2",
                "failed",
                &failing,
                "2026-11-02T02:00:00.000Z",
                None,
            ),
            seeded_run(
                "run-1",
                "succeeded",
                &base,
                "2026-11-01T01:00:00.000Z",
                Some(9),
            ),
        ],
    );

    let first_start = worker(&fixture, Gate::new().runner(), no_issues().0);
    assert!(first_start.begin(), "the first worker starts");
    let after_first = first_start.current_state();
    let counts: Vec<(String, Option<i64>)> = after_first
        .runs
        .iter()
        .map(|run| (run.id.clone(), run.commits))
        .collect();
    assert_eq!(
        counts,
        vec![
            ("run-5".to_string(), Some(5)),
            ("run-4".to_string(), Some(4)),
            ("run-3".to_string(), Some(3)),
            ("run-2".to_string(), Some(2)),
            // A present count is never recomputed.
            ("run-1".to_string(), Some(9)),
        ],
        "every missing count is filled from the last success; a present one stands"
    );
    drop(first_start);

    let second_start = worker(&fixture, Gate::new().runner(), no_issues().0);
    assert!(second_start.begin(), "the second worker starts");
    let after_second = second_start.current_state();
    assert_eq!(
        after_second.runs, after_first.runs,
        "a later start changes no count and reorders no run"
    );
    drop(second_start);

    let app = fixture_app(&fixture);
    let (conn, mut inbox) = fixture_connection(&app).await;
    devboard::agents_mode::replay(&app, &conn);
    let all = drain(&mut inbox);
    let deploy = all
        .iter()
        .filter(|frame| frame.get("type").and_then(Value::as_str) == Some("agentsState"))
        .flat_map(|frame| {
            frame
                .get("agents")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some("deploy-on-main"))
        .expect("a deploy-on-main snapshot");
    let deploys = deploy["deploys"].as_array().expect("a deploys array");
    assert_eq!(deploys.len(), 4, "the skipped run is hidden: {deploy}");
    assert_eq!(deploys[0]["state"], "succeeded");
    assert_eq!(deploys[0]["commit"], json!(success));
    assert_eq!(deploys[0]["commits"], json!(5));
    assert_eq!(deploys[1]["state"], "stopped");
    assert_eq!(deploys[1]["commits"], json!(4));
    assert_eq!(deploys[2]["state"], "failed");
    assert_eq!(deploys[2]["commits"], json!(2));
    assert_eq!(deploys[3]["state"], "succeeded");
    assert_eq!(deploys[3]["commits"], json!(9));
    assert!(
        deploys
            .iter()
            .all(|row| row.get("commit") != Some(&json!(skipped))),
        "a skipped run is never a row: {deploy}"
    );

    devboard::agents_mode::handle(
        &app,
        &conn,
        &WireCommand::SetAgentSettings {
            id: Some(json!("deploy-on-main")),
            minutes: Some(json!(5)),
            max_per_hour: Some(json!(10)),
            max_pending: Some(json!(5)),
        },
    )
    .await;
    let all = drain(&mut inbox);
    let errors: Vec<&str> = all
        .iter()
        .filter(|frame| frame.get("type").and_then(Value::as_str) == Some("error"))
        .filter_map(|frame| frame.get("message").and_then(Value::as_str))
        .collect();
    assert_eq!(errors.len(), 1, "{all:?}");
    assert!(
        errors[0].contains("Deploy on main has no settings"),
        "{errors:?}"
    );
    assert!(
        !fixture.directory().join("settings.json").exists(),
        "no deploy settings file is created"
    );
}
