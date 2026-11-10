//! Retention for abandoned worktrees and their branches.
//!
//! One pass removes a worktree only when its branch is already an ancestor of
//! `main`, its working tree is clean, no live process holds its directory, and
//! it is neither the sweep's own directory nor the checkout a running
//! dashboard serves. It never uses `git worktree remove --force`, and it
//! writes an unmerged branch's patch before deleting that branch.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::watchdog::Instance;

/// How long an unmerged branch with no worktree checkout stays before its
/// patch is written and the branch is deleted.
pub const WORKTREE_IDLE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The directory that holds one written patch per removed unmerged branch,
/// under the canonical harness.
pub const BRANCH_PATCH_DIRECTORY: &str = "worktree-cleanup/branches";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorktreeCandidateKind {
    Worktree,
    Branch,
}

impl WorktreeCandidateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Worktree => "worktree",
            Self::Branch => "branch",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeCandidate {
    pub kind: WorktreeCandidateKind,
    /// The worktree directory for a worktree, the branch name for a branch.
    pub path: PathBuf,
    pub branch: Option<String>,
    pub bytes: u64,
}

#[derive(Clone, Debug, Default)]
pub struct WorktreeCleanupReport {
    /// Everything a dry run would remove.
    pub candidates: Vec<WorktreeCandidate>,
    /// What a real pass removed.
    pub removed: Vec<WorktreeCandidate>,
    pub errors: Vec<String>,
    /// True when a real pass ran `git worktree prune`.
    pub pruned: bool,
    /// Set when the whole pass was skipped.
    pub skipped: Option<String>,
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn git_output(directory: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_ok(directory: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn is_ancestor(root: &Path, branch: &str, of: &str) -> bool {
    git_ok(root, &["merge-base", "--is-ancestor", branch, of])
}

/// The directories registered with `git worktree list --porcelain`.
fn registered_worktrees(root: &Path) -> Option<HashSet<PathBuf>> {
    let text = git_output(root, &["worktree", "list", "--porcelain"])?;
    let mut paths = HashSet::new();
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            let path = PathBuf::from(path);
            paths.insert(canonical(&path));
            paths.insert(path);
        }
    }
    Some(paths)
}

/// Every branch a registered worktree currently checks out.
fn checked_out_branches(root: &Path) -> HashSet<String> {
    let mut branches = HashSet::new();
    let Some(text) = git_output(root, &["worktree", "list", "--porcelain"]) else {
        return branches;
    };
    for line in text.lines() {
        if let Some(reference) = line.strip_prefix("branch refs/heads/") {
            branches.insert(reference.to_string());
        }
    }
    branches
}

/// One local branch and its tip's committer instant in epoch milliseconds.
fn local_branches(root: &Path) -> Vec<(String, i64)> {
    let Some(text) = git_output(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(committerdate:unix)",
            "refs/heads",
        ],
    ) else {
        return Vec::new();
    };
    let mut branches = Vec::new();
    for line in text.lines() {
        let Some((name, seconds)) = line.split_once('\t') else {
            continue;
        };
        let Ok(seconds) = seconds.trim().parse::<i64>() else {
            continue;
        };
        branches.push((name.to_string(), seconds * 1000));
    }
    branches
}

/// The canonical directories a pass must never remove: the sweep's own
/// working directory, the canonical checkout, and every checkout a running
/// dashboard serves.
fn protected_directories(root: &Path, instances: &[Instance]) -> Vec<PathBuf> {
    let mut protected: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        protected.push(canonical(&cwd));
    }
    protected.push(canonical(root));
    for instance in instances {
        if !instance.repo_dir.is_empty() {
            protected.push(canonical(Path::new(&instance.repo_dir)));
        }
    }
    protected
}

/// Every live process's working directory, canonicalized.
pub(crate) fn live_working_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return directories;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        if let Ok(cwd) = std::fs::read_link(entry.path().join("cwd")) {
            directories.push(canonical(&cwd));
        }
    }
    directories
}

/// Every file's bytes under one directory, for a report.
fn tree_bytes(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| tree_bytes(&entry.path()))
        .sum()
}

fn patch_path(root: &Path, branch: &str) -> PathBuf {
    root.join(".devboard")
        .join(".tmp")
        .join(BRANCH_PATCH_DIRECTORY)
        .join(format!("{branch}.patch"))
}

/// Writes `main..<branch>` as a patch. The branch is never deleted unless a
/// non-empty patch reached the disk.
fn write_branch_patch(root: &Path, branch: &str) -> Result<PathBuf, String> {
    let text = git_output(
        root,
        &["format-patch", &format!("main..{branch}"), "--stdout"],
    )
    .ok_or_else(|| format!("git format-patch main..{branch} failed"))?;
    if text.trim().is_empty() {
        return Err(format!("git format-patch main..{branch} wrote no patch"));
    }
    let path = patch_path(root, branch);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    std::fs::write(&path, text).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path)
}

fn branch_candidate(branch: &str) -> WorktreeCandidate {
    WorktreeCandidate {
        kind: WorktreeCandidateKind::Branch,
        path: PathBuf::from(branch),
        branch: Some(branch.to_string()),
        bytes: 0,
    }
}

/// Removes every eligible worktree under `<root>/.worktree/`, prunes stale
/// worktree metadata, deletes a removed worktree's merged branch, and writes
/// an idle unmerged branch's patch before deleting it.
///
/// A dry run reports the same candidates and changes nothing, not even the
/// worktree metadata.
pub fn run_worktree_cleanup(
    root: &Path,
    now_ms: i64,
    dry_run: bool,
    instances: &[Instance],
) -> WorktreeCleanupReport {
    let mut report = WorktreeCleanupReport::default();
    let root = canonical(root);
    if !git_ok(&root, &["status", "--porcelain"]) {
        report.skipped = Some("git status could not be read".to_string());
        return report;
    }
    let Some(registered) = registered_worktrees(&root) else {
        report.skipped = Some("git worktree list could not be read".to_string());
        return report;
    };
    if !dry_run && git_ok(&root, &["worktree", "prune"]) {
        report.pruned = true;
    }
    let protected = protected_directories(&root, instances);
    let busy = live_working_directories();

    let worktrees_directory = root.join(".worktree");
    let mut names: Vec<std::ffi::OsString> = match std::fs::read_dir(&worktrees_directory) {
        Ok(entries) => entries.flatten().map(|entry| entry.file_name()).collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    for name in names {
        if name == ".test-tmp" {
            continue;
        }
        let path = worktrees_directory.join(&name);
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || !path.join(".git").exists() {
            continue;
        }
        let real = canonical(&path);
        if protected
            .iter()
            .any(|candidate| real == *candidate || candidate.starts_with(&real))
        {
            continue;
        }
        if busy.iter().any(|cwd| cwd.starts_with(&real)) {
            continue;
        }
        let Some(branch) = git_output(&path, &["rev-parse", "--abbrev-ref", "HEAD"]) else {
            report
                .errors
                .push(format!("{}: could not read HEAD", path.display()));
            continue;
        };
        let branch = branch.trim().to_string();
        if branch.is_empty() || branch == "HEAD" {
            continue;
        }
        let Some(status) = git_output(&path, &["status", "--porcelain"]) else {
            report
                .errors
                .push(format!("{}: could not read status", path.display()));
            continue;
        };
        if !status.trim().is_empty() {
            continue;
        }
        if !is_ancestor(&root, &branch, "main") {
            continue;
        }
        let candidate = WorktreeCandidate {
            kind: WorktreeCandidateKind::Worktree,
            path: path.clone(),
            branch: Some(branch.clone()),
            bytes: tree_bytes(&path),
        };
        report.candidates.push(candidate.clone());
        let branch_removal = branch_candidate(&branch);
        report.candidates.push(branch_removal.clone());
        if dry_run {
            continue;
        }
        let registered_here = registered.contains(&real) || registered.contains(&path);
        let removed = if registered_here {
            git_ok(&root, &["worktree", "remove", &path.to_string_lossy()])
        } else {
            std::fs::remove_dir_all(&path).is_ok()
        };
        if !removed {
            report
                .errors
                .push(format!("{}: could not remove", path.display()));
            report.candidates.pop();
            report.candidates.pop();
            continue;
        }
        report.removed.push(candidate);
        if git_ok(&root, &["branch", "-d", &branch]) {
            report.removed.push(branch_removal);
        } else {
            report
                .errors
                .push(format!("{branch}: could not delete the merged branch"));
        }
    }

    let checked_out = checked_out_branches(&root);
    let current = git_output(&root, &["symbolic-ref", "--short", "HEAD"])
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    for (branch, committed_ms) in local_branches(&root) {
        if branch == "main" || branch == current || checked_out.contains(&branch) {
            continue;
        }
        if is_ancestor(&root, &branch, "main") {
            continue;
        }
        if now_ms - committed_ms < WORKTREE_IDLE_MS {
            continue;
        }
        let candidate = branch_candidate(&branch);
        report.candidates.push(candidate.clone());
        if dry_run {
            continue;
        }
        match write_branch_patch(&root, &branch) {
            Ok(_) => {
                if git_ok(&root, &["branch", "-D", &branch]) {
                    report.removed.push(candidate);
                } else {
                    report
                        .errors
                        .push(format!("{branch}: could not delete the patched branch"));
                }
            }
            Err(error) => report.errors.push(error),
        }
    }
    report
}
