//! Retention for Rust build output.
//!
//! Cargo keeps one artifact per source hash and never garbage-collects the
//! old ones. One pass groups the canonical checkout's `target/debug/deps`
//! files by their `<stem>.<ext>` name, keeps the newest file per group, and
//! removes the rest. When `target/debug` still exceeds the cap afterwards, the
//! whole directory leaves. Neither step runs while a `cargo` or `rustc`
//! process builds inside that checkout.
//!
//! Every checked-out worktree under `.worktree/` loses its whole
//! `target/debug` in the same pass unless a live process works inside it. A
//! worktree is removed only once its branch is merged, so an abandoned
//! unmerged one would otherwise keep its build tree forever; that output
//! shares the filesystem the CI runner builds on, and an unbounded one fills
//! the host until a link step fails with `No space left on device`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The most bytes `target/debug` may keep after one pass.
pub const TARGET_DEBUG_MAX_BYTES: u64 = 21_474_836_480;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildCandidateKind {
    /// A superseded `deps` artifact.
    Duplicate,
    /// The whole canonical `target/debug` directory, removed by the cap
    /// backstop.
    TargetDebug,
    /// A worktree's whole `target/debug`, removed because no live process
    /// works in that checkout.
    WorktreeTargetDebug,
}

impl BuildCandidateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Duplicate => "duplicate",
            Self::TargetDebug => "target-debug",
            Self::WorktreeTargetDebug => "worktree-target-debug",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildCandidate {
    pub path: PathBuf,
    pub bytes: u64,
    pub kind: BuildCandidateKind,
}

#[derive(Clone, Debug, Default)]
pub struct BuildCleanupReport {
    /// Everything a dry run would remove.
    pub candidates: Vec<BuildCandidate>,
    /// What a real pass removed.
    pub removed: Vec<BuildCandidate>,
    /// The bytes every swept `target/debug` held before the pass.
    pub bytes_before: u64,
    /// The bytes the same directories hold after the pass, or would hold in a
    /// dry run.
    pub bytes_after: u64,
    pub cap_removed: bool,
    pub errors: Vec<String>,
    /// Set when the pass was skipped.
    pub skipped: Option<String>,
}

fn modified_ms(path: &Path) -> i64 {
    std::fs::symlink_metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Every entry's apparent size under one directory, as `du -sb` counts it.
fn apparent_size(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !metadata.is_dir() {
        return metadata.len();
    }
    let mut bytes = metadata.len();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            bytes += apparent_size(&entry.path());
        }
    }
    bytes
}

/// Splits `libname-0123456789abcdef.rlib` into `("libname", "rlib")`.
fn split_hashed_name(name: &str) -> Option<(&str, &str)> {
    let (base, extension) = name.rsplit_once('.')?;
    if extension.is_empty() {
        return None;
    }
    let (stem, hash) = base.rsplit_once('-')?;
    if stem.is_empty() || hash.len() != 16 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((stem, extension))
}

/// The pids of this process and its ancestors: a `cargo run` wrapper that
/// started the sweep is not a concurrent build.
fn own_process_tree() -> std::collections::HashSet<u32> {
    let mut pids = std::collections::HashSet::new();
    let mut pid = std::process::id();
    for _ in 0..64 {
        if !pids.insert(pid) {
            break;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            break;
        };
        let Some(rest) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
            break;
        };
        let Some(parent) = rest.split_whitespace().nth(1) else {
            break;
        };
        let Ok(parent) = parent.parse::<u32>() else {
            break;
        };
        if parent == 0 || parent == pid {
            break;
        }
        pid = parent;
    }
    pids
}

/// True when a `cargo` or `rustc` process outside this sweep's own process
/// tree builds inside `checkout`.
///
/// The gate is per checkout on purpose. The workspace builds many checkouts at
/// once, so one process table for the whole host stays busy almost always; the
/// canonical `target/debug` then grew to four times its cap while every pass
/// reported itself skipped. A build in one checkout never writes another
/// checkout's `target`, so it never holds that checkout's retention back.
pub fn build_running_in(checkout: &Path) -> bool {
    let own = own_process_tree();
    let checkout = canonical(checkout);
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        if own.contains(&pid) {
            continue;
        }
        let Ok(comm) = std::fs::read_to_string(entry.path().join("comm")) else {
            continue;
        };
        let comm = comm.trim();
        if comm != "cargo" && comm != "rustc" {
            continue;
        }
        let Ok(cwd) = std::fs::read_link(entry.path().join("cwd")) else {
            continue;
        };
        if canonical(&cwd).starts_with(&checkout) {
            return true;
        }
    }
    false
}

/// Groups one `deps` directory's hashed artifacts and returns the ones that
/// are not the newest in their group.
fn duplicate_candidates(deps: &Path, report: &mut BuildCleanupReport) -> Vec<BuildCandidate> {
    let entries = match std::fs::read_dir(deps) {
        Ok(entries) => entries,
        Err(error) => {
            report.errors.push(format!("{}: {error}", deps.display()));
            return Vec::new();
        }
    };
    let mut groups: HashMap<String, Vec<(PathBuf, i64)>> = HashMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((stem, extension)) = split_hashed_name(&name) else {
            continue;
        };
        let is_file = entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false);
        if !is_file {
            continue;
        }
        let path = entry.path();
        groups
            .entry(format!("{stem}.{extension}"))
            .or_default()
            .push((path.clone(), modified_ms(&path)));
    }
    let mut candidates = Vec::new();
    for (_, mut files) in groups {
        if files.len() < 2 {
            continue;
        }
        files.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        files.pop();
        for (path, _) in files {
            let bytes = std::fs::symlink_metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            candidates.push(BuildCandidate {
                path,
                bytes,
                kind: BuildCandidateKind::Duplicate,
            });
        }
    }
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    candidates
}

/// Every checked-out worktree's `target/debug`, paired with the worktree
/// directory it belongs to, in path order.
fn worktree_debug_directories(root: &Path) -> Vec<(PathBuf, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root.join(".worktree")) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let worktree = entry.path();
        if !worktree.join(".git").exists() {
            continue;
        }
        let debug = worktree.join(".devboard").join("target").join("debug");
        // A symlinked build directory is left alone: the sweep never follows
        // one out of the checkout it belongs to.
        let real_directory = std::fs::symlink_metadata(&debug)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false);
        if real_directory {
            found.push((worktree, debug));
        }
    }
    found.sort();
    found
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Applies the dedup rule and the cap to the canonical checkout's
/// `target/debug`, and returns the bytes it holds afterwards.
fn sweep_canonical_debug(
    debug: &Path,
    dry_run: bool,
    max_bytes: u64,
    report: &mut BuildCleanupReport,
) -> u64 {
    let before = apparent_size(debug);
    let deps = debug.join("deps");
    if !deps.is_dir() {
        report
            .errors
            .push(format!("{}: missing or unreadable", deps.display()));
        return before;
    }
    let duplicates = duplicate_candidates(&deps, report);
    let freed: u64 = duplicates.iter().map(|candidate| candidate.bytes).sum();
    let mut remaining = before.saturating_sub(freed);
    report.candidates.extend(duplicates.iter().cloned());
    if !dry_run {
        for candidate in &duplicates {
            match std::fs::remove_file(&candidate.path) {
                Ok(()) => report.removed.push(candidate.clone()),
                Err(error) => report
                    .errors
                    .push(format!("{}: {error}", candidate.path.display())),
            }
        }
        remaining = apparent_size(debug);
    }
    if remaining <= max_bytes {
        return remaining;
    }
    let candidate = BuildCandidate {
        path: debug.to_path_buf(),
        bytes: remaining,
        kind: BuildCandidateKind::TargetDebug,
    };
    report.candidates.push(candidate.clone());
    if !dry_run {
        match std::fs::remove_dir_all(debug) {
            Ok(()) => {
                report.removed.push(candidate);
                report.cap_removed = true;
            }
            Err(error) => report.errors.push(format!("{}: {error}", debug.display())),
        }
    }
    0
}

/// Applies the build retention rule to the canonical checkout's
/// `target/debug` and reclaims every worktree's build output that no live
/// process is working in.
///
/// `max_bytes` is the cap the canonical checkout's directory may keep.
/// `build_running_in` names the checkouts a live `cargo` or `rustc` process
/// builds in: the canonical pass waits for its own checkout only.
/// `busy_directories` names every directory a live process is working in or a
/// running dashboard serves: a worktree holding one keeps its build output. A
/// dry run reports the same candidates and removes nothing.
pub fn run_build_cleanup_with(
    root: &Path,
    dry_run: bool,
    max_bytes: u64,
    build_running_in: &dyn Fn(&Path) -> bool,
    busy_directories: &dyn Fn() -> Vec<PathBuf>,
) -> BuildCleanupReport {
    let mut report = BuildCleanupReport::default();
    let debug = root.join(".devboard").join("target").join("debug");
    let canonical_before = if debug.is_dir() {
        apparent_size(&debug)
    } else {
        0
    };
    // A build inside the canonical checkout may be writing this directory, so
    // the canonical pass waits for it. A worktree's own working directory is
    // what holds its build output back, so a build elsewhere never blocks
    // that reclaim.
    let mut canonical_after = canonical_before;
    if debug.is_dir() {
        if build_running_in(root) {
            report.skipped = Some("a cargo or rustc process builds in the checkout".to_string());
        } else {
            canonical_after = sweep_canonical_debug(&debug, dry_run, max_bytes, &mut report);
        }
    }
    let busy = busy_directories();
    let mut worktree_before = 0u64;
    let mut worktree_after = 0u64;
    for (worktree, worktree_debug) in worktree_debug_directories(root) {
        let bytes = apparent_size(&worktree_debug);
        worktree_before += bytes;
        let real = canonical(&worktree);
        if busy.iter().any(|directory| directory.starts_with(&real)) {
            worktree_after += bytes;
            continue;
        }
        let candidate = BuildCandidate {
            path: worktree_debug.clone(),
            bytes,
            kind: BuildCandidateKind::WorktreeTargetDebug,
        };
        report.candidates.push(candidate.clone());
        if dry_run {
            continue;
        }
        match std::fs::remove_dir_all(&worktree_debug) {
            Ok(()) => report.removed.push(candidate),
            Err(error) => {
                worktree_after += bytes;
                report
                    .errors
                    .push(format!("{}: {error}", worktree_debug.display()));
            }
        }
    }
    report.bytes_before = canonical_before + worktree_before;
    report.bytes_after = canonical_after + worktree_after;
    report
}
