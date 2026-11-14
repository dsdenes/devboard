//! `devboard land <branch>`: one fast-forward landing, its push, and its proof.
//!
//! The integration checkout is resolved from the harness's own repository, so a
//! run working in `<REPO_DIR>/.worktree/<name>` names only its branch: no
//! `cd <checkout> &&` prefix, no hand-appended status read, and no `ls-remote`
//! probe. The command fetches the integration branch's upstream, integrates a
//! moved tip, rebases a branch whose base advanced, fast-forwards the checkout
//! without a merge commit, pushes, and proves the remote tip names the merged
//! commit. A concurrent landing that cannot lock `HEAD` is retried with bounded
//! backoff instead of exiting 128.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::git::{run_git, GitResult};

/// How many times one concurrent `cannot lock ref` failure is retried.
pub const MAX_LOCK_ATTEMPTS: u32 = 6;
/// The first pause between lock attempts; each retry doubles it.
pub const LOCK_BACKOFF_START_MS: u64 = 50;
/// The ceiling on one lock pause.
pub const LOCK_BACKOFF_MAX_MS: u64 = 800;
/// How many times a landing attempt retries after its base moved.
pub const MAX_LAND_ATTEMPTS: usize = 3;
/// How many times a rejected push is retried after integrating the new tip.
pub const MAX_PUSH_ATTEMPTS: usize = 3;
/// A local git invocation's bound.
const LOCAL_TIMEOUT_MS: u64 = 120_000;
/// A network git invocation's bound: fetch, push, and the tip proof.
const NETWORK_TIMEOUT_MS: u64 = 600_000;

/// One proven landing: what landed, where it landed, and the remote's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Landing {
    /// The integration checkout that received the merge.
    pub checkout: PathBuf,
    /// The checkout's branch, the line every landing publishes to.
    pub integration: String,
    /// The branch the caller named.
    pub branch: String,
    /// `<remote>/<branch>` as the integration branch's upstream configures it.
    pub upstream: String,
    /// The integration checkout's commit after the merge.
    pub merged: String,
    /// The tip the remote reports for the integration branch.
    pub remote_tip: String,
    /// Commits the integration branch holds beyond its upstream.
    pub ahead: u64,
    /// Commits the upstream holds beyond the integration branch.
    pub behind: u64,
    /// True when the branch was rebased onto the integration tip.
    pub rebased: bool,
    /// True when the integration branch was rebased onto a moved upstream.
    pub recovered: bool,
    /// How many refused `HEAD` locks were retried.
    pub lock_retries: u32,
}

impl Landing {
    /// The lines the command prints: the merged commit, the verified remote
    /// tip, and the checkout's ahead/behind.
    pub fn lines(&self) -> Vec<String> {
        let mut lines = vec![format!("landed {} into {}", self.branch, self.integration)];
        if self.rebased {
            lines.push(format!("rebased {} onto {}", self.branch, self.integration));
        }
        if self.recovered {
            lines.push(format!(
                "rebased {} onto {}",
                self.integration, self.upstream
            ));
        }
        lines.push(format!("merged {}", self.merged));
        lines.push(format!(
            "remote {} {} verified",
            self.upstream, self.remote_tip
        ));
        lines.push(format!("ahead {} behind {}", self.ahead, self.behind));
        if self.lock_retries > 0 {
            lines.push(format!("retried {} HEAD lock(s)", self.lock_retries));
        }
        lines
    }

    /// The same record for a caller that parses JSON.
    pub fn to_json(&self) -> Value {
        json!({
            "checkout": self.checkout.display().to_string(),
            "integration": self.integration,
            "branch": self.branch,
            "upstream": self.upstream,
            "merged": self.merged,
            "remoteTip": self.remote_tip,
            "ahead": self.ahead,
            "behind": self.behind,
            "rebased": self.rebased,
            "recovered": self.recovered,
            "lockRetries": self.lock_retries,
        })
    }
}

/// The integration checkout: its root, its git directory, and its branch.
struct Checkout {
    root: PathBuf,
    git_dir: PathBuf,
    branch: String,
    remote: String,
    remote_branch: String,
}

impl Checkout {
    fn upstream(&self) -> String {
        format!("{}/{}", self.remote, self.remote_branch)
    }
}

/// Runs one local git command in `directory` and returns its raw result.
async fn local(directory: &Path, args: &[&str]) -> GitResult {
    run_git(directory, args, &HashMap::new(), LOCAL_TIMEOUT_MS).await
}

/// Runs one network git command in `directory` and returns its raw result.
async fn network(directory: &Path, args: &[&str]) -> GitResult {
    run_git(directory, args, &HashMap::new(), NETWORK_TIMEOUT_MS).await
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn failure_line(result: &GitResult, fallback: &str) -> String {
    first_line(&result.stderr)
        .or_else(|| first_line(&result.stdout))
        .unwrap_or(fallback)
        .to_string()
}

/// Runs a local git command that must succeed and returns its trimmed stdout.
async fn must(directory: &Path, args: &[&str], what: &str) -> Result<String> {
    let result = local(directory, args).await;
    if result.code != 0 {
        bail!("{what}: {}", failure_line(&result, "git failed"));
    }
    Ok(result.stdout.trim().to_string())
}

/// True when a local command's answer is `yes`.
async fn is(directory: &Path, args: &[&str]) -> bool {
    local(directory, args).await.code == 0
}

/// True when git refused the ref update because another process held it.
pub fn refused_head_lock(result: &GitResult) -> bool {
    if result.code == 0 {
        return false;
    }
    let text = format!("{}\n{}", result.stdout, result.stderr);
    text.contains("cannot lock ref") || text.contains("unable to lock")
}

/// Retries one ref-updating command refused by a concurrent `HEAD` lock.
///
/// The retry is bounded by [`MAX_LOCK_ATTEMPTS`] and by a doubling,
/// [`LOCK_BACKOFF_MAX_MS`]-capped pause, and every attempt is a fresh invocation
/// of `attempt`. A refusal the retry budget cannot absorb, and every failure
/// that is not a lock refusal, is returned unchanged with the count of retries
/// that preceded it.
pub async fn retry_head_lock<F, Fut>(mut attempt: F) -> (GitResult, u32)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = GitResult>,
{
    let mut backoff = LOCK_BACKOFF_START_MS;
    let mut retried = 0;
    loop {
        let result = attempt().await;
        if !refused_head_lock(&result) || retried >= MAX_LOCK_ATTEMPTS {
            return (result, retried);
        }
        retried += 1;
        tokio::time::sleep(Duration::from_millis(backoff)).await;
        backoff = (backoff * 2).min(LOCK_BACKOFF_MAX_MS);
    }
}

/// Resolves the integration checkout from any directory inside the repository.
///
/// `--git-common-dir` names the canonical checkout's `.git` from a linked
/// worktree too, so a run working in `.worktree/<name>` still reaches the line
/// it lands into without naming a host path.
async fn resolve_checkout(start: &Path) -> Result<PathBuf> {
    if !start.exists() {
        bail!("{} does not exist", start.display());
    }
    let common = local(
        start,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await;
    if common.code != 0 {
        bail!(
            "{} is not inside a git checkout: {}",
            start.display(),
            failure_line(&common, "git rev-parse failed")
        );
    }
    let git_dir = PathBuf::from(common.stdout.trim());
    let Some(root) = git_dir.parent().map(Path::to_path_buf) else {
        bail!("the git directory {} names no checkout", git_dir.display());
    };
    if !git_dir.join("HEAD").exists() {
        bail!(
            "the common git directory {} does not sit beside its checkout",
            git_dir.display()
        );
    }
    if !is(&root, &["rev-parse", "--is-inside-work-tree"]).await {
        bail!("{} is not a working checkout", root.display());
    }
    Ok(root)
}

/// The path a `git status --porcelain` line names.
fn porcelain_path(line: &str) -> Option<String> {
    let path = line.get(3..)?.trim();
    let path = path.rsplit(" -> ").next().unwrap_or(path);
    Some(path.trim_matches('"').to_string())
}

/// Refuses a checkout with an unfinished operation, or local work the landing
/// would overwrite.
///
/// Untracked paths are left alone: the harness writes its own scratch files
/// under `.devboard/`, and a landing never eats another worker's work. An
/// uncommitted path the branch does not touch is preserved by the
/// fast-forward, so only an overlapping path is a refusal.
async fn guard_clean(checkout: &Checkout, branch_ref: &str) -> Result<()> {
    for (name, label) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
    ] {
        if checkout.git_dir.join(name).exists() {
            bail!(
                "refusing to land: {} has a {label} in progress",
                checkout.root.display()
            );
        }
    }
    let status = local(
        &checkout.root,
        &["status", "--porcelain", "--untracked-files=no"],
    )
    .await;
    if status.code != 0 {
        bail!(
            "could not read the status of {}: {}",
            checkout.root.display(),
            failure_line(&status, "git status failed")
        );
    }
    let changed: Vec<String> = status.stdout.lines().filter_map(porcelain_path).collect();
    if changed.is_empty() {
        return Ok(());
    }
    let landing = must(
        &checkout.root,
        &["diff", "--name-only", "HEAD", branch_ref],
        "could not read the paths the landing touches",
    )
    .await?;
    let touched: Vec<String> = landing
        .lines()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();
    let overlap: Vec<&String> = changed
        .iter()
        .filter(|path| touched.iter().any(|landed| landed == *path))
        .collect();
    if let Some(first) = overlap.first() {
        bail!(
            "refusing to land: {} carries uncommitted work in {} that the landing would overwrite, \
             starting with {first}; commit or remove it first",
            checkout.root.display(),
            overlap.len()
        );
    }
    Ok(())
}

/// Reads the integration checkout's branch and its configured upstream.
async fn describe_checkout(root: PathBuf, git_dir: PathBuf) -> Result<Checkout> {
    let branch = local(&root, &["symbolic-ref", "--short", "HEAD"]).await;
    if branch.code != 0 {
        bail!(
            "the integration checkout {} is not on a branch: {}",
            root.display(),
            failure_line(&branch, "git symbolic-ref failed")
        );
    }
    let branch = branch.stdout.trim().to_string();
    let upstream = local(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .await;
    if upstream.code != 0 {
        bail!(
            "the integration branch {branch} has no upstream: {}",
            failure_line(&upstream, "git rev-parse failed")
        );
    }
    let upstream = upstream.stdout.trim().to_string();
    let Some((remote, remote_branch)) = upstream.split_once('/') else {
        bail!("the integration branch {branch} names an unusable upstream {upstream}");
    };
    if remote.is_empty() || remote_branch.is_empty() {
        bail!("the integration branch {branch} names an unusable upstream {upstream}");
    }
    Ok(Checkout {
        root,
        git_dir,
        branch,
        remote: remote.to_string(),
        remote_branch: remote_branch.to_string(),
    })
}

/// Why a fast-forward did not run.
enum MergeFailure {
    /// The target does not contain the checkout's tip, so a rebase comes first.
    NotFastForward,
    /// Any other git failure, already reduced to one line.
    Other(String),
}

/// Fast-forwards `directory` to `rev`, retrying a concurrent `HEAD` lock with
/// bounded backoff so another worker's landing never costs a second call.
async fn fast_forward(directory: &Path, rev: &str) -> Result<u32, MergeFailure> {
    let args = ["merge", "--ff-only", rev];
    let (result, retries) = retry_head_lock(|| local(directory, &args)).await;
    if result.code == 0 {
        return Ok(retries);
    }
    let text = format!("{}\n{}", result.stdout, result.stderr);
    if text.contains("Not possible to fast-forward") || text.contains("can't be fast-forwarded") {
        return Err(MergeFailure::NotFastForward);
    }
    Err(MergeFailure::Other(failure_line(
        &result,
        "git merge failed",
    )))
}

/// Rebases `directory` onto `base`, never leaving a half-applied rebase behind.
///
/// A refused rebase names the conflicting paths it stopped on, so the caller can
/// finish that rebase by hand in the same worktree.
async fn rebase_onto(directory: &Path, base: &str, what: &str) -> Result<()> {
    let result = local(directory, &["rebase", base]).await;
    if result.code == 0 {
        return Ok(());
    }
    let text = format!("{}\n{}", result.stdout, result.stderr);
    let conflicts: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("CONFLICT"))
        .collect();
    let detail = if conflicts.is_empty() {
        failure_line(&result, "git rebase failed")
    } else {
        conflicts.join("; ")
    };
    let _ = local(directory, &["rebase", "--abort"]).await;
    bail!("{what} does not rebase cleanly onto {base}: {detail}");
}

/// The worktree that has `branch` checked out, if one exists.
async fn branch_worktree(checkout: &Path, branch: &str) -> Result<Option<PathBuf>> {
    let listing = local(checkout, &["worktree", "list", "--porcelain"]).await;
    if listing.code != 0 {
        bail!(
            "could not list the checkout's worktrees: {}",
            failure_line(&listing, "git worktree list failed")
        );
    }
    let wanted = format!("refs/heads/{branch}");
    let mut current: Option<PathBuf> = None;
    for line in listing.stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current = Some(PathBuf::from(path.trim()));
        } else if line
            .strip_prefix("branch ")
            .map(|name| name.trim() == wanted)
            .unwrap_or(false)
        {
            return Ok(current.take());
        }
    }
    Ok(None)
}

/// Rebases the branch onto the integration tip inside its own worktree.
async fn rebase_branch(checkout: &Checkout, branch: &str) -> Result<()> {
    let Some(worktree) = branch_worktree(&checkout.root, branch).await? else {
        bail!(
            "the branch {branch} does not contain {} and has no worktree to rebase; check it out \
             in one and commit there first",
            checkout.branch
        );
    };
    let status = local(
        &worktree,
        &["status", "--porcelain", "--untracked-files=no"],
    )
    .await;
    if status.code != 0 {
        bail!(
            "could not read the status of {}: {}",
            worktree.display(),
            failure_line(&status, "git status failed")
        );
    }
    if !status.stdout.trim().is_empty() {
        bail!(
            "the branch {branch} has uncommitted changes in {}; commit them before landing",
            worktree.display()
        );
    }
    let base = format!("refs/heads/{}", checkout.branch);
    rebase_onto(&worktree, &base, &format!("the branch {branch}")).await
}

/// Fetches the integration branch's upstream, dropping merged remote refs.
async fn fetch_remote(checkout: &Checkout) -> Result<()> {
    let result = network(&checkout.root, &["fetch", &checkout.remote, "--prune"]).await;
    if result.code != 0 {
        bail!(
            "could not fetch {}: {}",
            checkout.remote,
            failure_line(&result, "git fetch failed")
        );
    }
    Ok(())
}

/// Integrates the upstream tip into the integration branch.
///
/// A pure catch-up fast-forwards; an integration branch that carries
/// unpublished commits is rebased onto the fetched tip, which is also why the
/// caller reports it.
async fn sync_integration(checkout: &Checkout, lock_retries: &mut u32) -> Result<bool> {
    let upstream = checkout.upstream();
    if is(
        &checkout.root,
        &["merge-base", "--is-ancestor", &upstream, "HEAD"],
    )
    .await
    {
        return Ok(false);
    }
    if is(
        &checkout.root,
        &["merge-base", "--is-ancestor", "HEAD", &upstream],
    )
    .await
    {
        match fast_forward(&checkout.root, &upstream).await {
            Ok(retries) => {
                *lock_retries += retries;
                return Ok(false);
            }
            Err(MergeFailure::NotFastForward) | Err(MergeFailure::Other(_)) => {
                // A concurrent landing moved `HEAD` between the probe and the
                // merge; the rebase below integrates the fetched tip instead.
            }
        }
    }
    rebase_onto(
        &checkout.root,
        &upstream,
        &format!("the integration branch {}", checkout.branch),
    )
    .await?;
    Ok(true)
}

/// Lands `branch` into the integration checkout and proves the remote tip.
pub async fn land(start: Option<&Path>, branch: &str) -> Result<Landing> {
    let branch = branch.trim();
    if branch.is_empty() {
        bail!("land needs a branch name");
    }
    let start = match start {
        Some(directory) => directory.to_path_buf(),
        None => {
            std::env::current_dir().map_err(|error| anyhow!("no working directory: {error}"))?
        }
    };
    let root = resolve_checkout(&start).await?;
    let git_dir = PathBuf::from(
        must(
            &root,
            &["rev-parse", "--absolute-git-dir"],
            "could not read the git dir",
        )
        .await?,
    );
    let checkout = describe_checkout(root, git_dir).await?;
    if branch == checkout.branch {
        bail!(
            "the branch {branch} is the integration branch {}; name the branch to land",
            checkout.branch
        );
    }
    let branch_ref = format!("refs/heads/{branch}");
    let exists = local(
        &checkout.root,
        &["rev-parse", "--verify", "--quiet", &branch_ref],
    )
    .await;
    if exists.code != 0 || exists.stdout.trim().is_empty() {
        bail!(
            "the branch {branch} does not exist in {}",
            checkout.root.display()
        );
    }
    guard_clean(&checkout, &branch_ref).await?;
    fetch_remote(&checkout).await?;

    let mut lock_retries = 0;
    let mut recovered = sync_integration(&checkout, &mut lock_retries).await?;

    let mut rebased = false;
    let mut landed = false;
    for attempt in 0..MAX_LAND_ATTEMPTS {
        if !is(
            &checkout.root,
            &["merge-base", "--is-ancestor", "HEAD", &branch_ref],
        )
        .await
        {
            rebase_branch(&checkout, branch).await?;
            rebased = true;
        }
        match fast_forward(&checkout.root, &branch_ref).await {
            Ok(retries) => {
                lock_retries += retries;
                landed = true;
                break;
            }
            Err(MergeFailure::NotFastForward) if attempt + 1 < MAX_LAND_ATTEMPTS => continue,
            Err(MergeFailure::NotFastForward) => break,
            Err(MergeFailure::Other(line)) => bail!("could not land {branch}: {line}"),
        }
    }
    if !landed {
        bail!("could not land {branch}: the integration tip moved through every attempt");
    }

    let mut pushed = false;
    for attempt in 0..MAX_PUSH_ATTEMPTS {
        let result = network(
            &checkout.root,
            &[
                "push",
                &checkout.remote,
                &format!("HEAD:refs/heads/{}", checkout.remote_branch),
            ],
        )
        .await;
        if result.code == 0 {
            pushed = true;
            break;
        }
        let text = format!("{}\n{}", result.stdout, result.stderr);
        let rejected = text.contains("[rejected]")
            || text.contains("non-fast-forward")
            || text.contains("fetch first");
        if rejected && attempt + 1 < MAX_PUSH_ATTEMPTS {
            fetch_remote(&checkout).await?;
            recovered = sync_integration(&checkout, &mut lock_retries).await? || recovered;
            continue;
        }
        bail!(
            "the push to {} was refused: {}",
            checkout.upstream(),
            failure_line(&result, "git push failed")
        );
    }
    if !pushed {
        bail!(
            "the push to {} was refused through every attempt",
            checkout.upstream()
        );
    }

    let merged = must(
        &checkout.root,
        &["rev-parse", "HEAD"],
        "could not read the merged commit",
    )
    .await?;
    let remote_tip = network(
        &checkout.root,
        &[
            "ls-remote",
            &checkout.remote,
            &format!("refs/heads/{}", checkout.remote_branch),
        ],
    )
    .await;
    if remote_tip.code != 0 {
        bail!(
            "could not read the remote tip of {}: {}",
            checkout.upstream(),
            failure_line(&remote_tip, "git ls-remote failed")
        );
    }
    let Some(remote_tip) = remote_tip
        .stdout
        .split_whitespace()
        .next()
        .map(str::to_string)
    else {
        bail!(
            "the remote {} answered no tip for refs/heads/{}",
            checkout.remote,
            checkout.remote_branch
        );
    };
    if remote_tip != merged {
        bail!(
            "the remote {} names {remote_tip}, not the merged commit {merged}",
            checkout.upstream()
        );
    }

    let upstream = checkout.upstream();
    let counts = must(
        &checkout.root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{upstream}...HEAD"),
        ],
        "could not read the checkout's divergence",
    )
    .await?;
    let mut parts = counts.split_whitespace();
    let behind = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let ahead = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    Ok(Landing {
        checkout: checkout.root,
        integration: checkout.branch,
        branch: branch.to_string(),
        upstream,
        merged,
        remote_tip,
        ahead,
        behind,
        rebased,
        recovered,
        lock_retries,
    })
}

/// Parses `devboard land <branch> [--repo-dir <dir>] [--json]`.
pub async fn command(args: &[String]) -> Result<()> {
    let mut branch: Option<String> = None;
    let mut repo_dir: Option<PathBuf> = None;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--repo-dir" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| anyhow!("--repo-dir needs a directory"))?;
                repo_dir = Some(PathBuf::from(value));
                index += 2;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            "--help" | "-h" => {
                println!("usage: devboard land <branch> [--repo-dir <dir>] [--json]");
                return Ok(());
            }
            other if other.starts_with('-') => bail!("unknown land option {other}"),
            other => {
                if branch.is_some() {
                    bail!("land takes exactly one branch, not {other}");
                }
                branch = Some(other.to_string());
                index += 1;
            }
        }
    }
    let branch = branch.ok_or_else(|| anyhow!("land needs a branch name"))?;
    let start = repo_dir.or_else(|| std::env::current_dir().ok());
    let landing = land(start.as_deref(), &branch).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&landing.to_json())?);
    } else {
        for line in landing.lines() {
            println!("{line}");
        }
    }
    Ok(())
}
