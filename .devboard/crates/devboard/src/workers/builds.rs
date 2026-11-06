//! Retention for Rust build output.
//!
//! Cargo keeps one artifact per source hash and never garbage-collects the
//! old ones. One pass groups `target/debug/deps` files by their
//! `<stem>.<ext>` name, keeps the newest file per group, and removes the rest.
//! When `target/debug` still exceeds the cap afterwards, the whole directory
//! leaves. Neither step runs while a build is alive.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The most bytes `target/debug` may keep after one pass.
pub const TARGET_DEBUG_MAX_BYTES: u64 = 21_474_836_480;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildCandidateKind {
    /// A superseded `deps` artifact.
    Duplicate,
    /// The whole `target/debug` directory, removed by the cap backstop.
    TargetDebug,
}

impl BuildCandidateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Duplicate => "duplicate",
            Self::TargetDebug => "target-debug",
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
    pub bytes_before: u64,
    /// The size the tree has after the pass, or would have in a dry run.
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

/// True when a build is running outside this sweep's own process tree.
pub fn build_process_alive() -> bool {
    let own = own_process_tree();
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
        if comm == "cargo" || comm == "rustc" {
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

/// Applies the build retention rule to `<root>/.devboard/target/debug`.
///
/// `max_bytes` is the cap the whole directory may keep. A dry run reports the
/// same candidates and removes nothing.
pub fn run_build_cleanup(root: &Path, dry_run: bool, max_bytes: u64) -> BuildCleanupReport {
    run_build_cleanup_with(root, dry_run, max_bytes, &build_process_alive)
}

/// `run_build_cleanup` with an explicit live-build predicate, so a test never
/// depends on the machine's process table.
pub fn run_build_cleanup_with(
    root: &Path,
    dry_run: bool,
    max_bytes: u64,
    build_running: &dyn Fn() -> bool,
) -> BuildCleanupReport {
    let mut report = BuildCleanupReport::default();
    let debug = root.join(".devboard").join("target").join("debug");
    if !debug.is_dir() {
        return report;
    }
    if build_running() {
        report.skipped = Some("a cargo or rustc process is alive".to_string());
        return report;
    }
    let deps = debug.join("deps");
    if !deps.is_dir() {
        report
            .errors
            .push(format!("{}: missing or unreadable", deps.display()));
        return report;
    }
    report.bytes_before = apparent_size(&debug);
    let duplicates = duplicate_candidates(&deps, &mut report);
    let freed: u64 = duplicates.iter().map(|candidate| candidate.bytes).sum();
    let mut remaining = report.bytes_before.saturating_sub(freed);
    report.candidates = duplicates.clone();
    if !dry_run {
        for candidate in &duplicates {
            match std::fs::remove_file(&candidate.path) {
                Ok(()) => report.removed.push(candidate.clone()),
                Err(error) => report
                    .errors
                    .push(format!("{}: {error}", candidate.path.display())),
            }
        }
        remaining = apparent_size(&debug);
    }
    if remaining > max_bytes {
        let candidate = BuildCandidate {
            path: debug.clone(),
            bytes: remaining,
            kind: BuildCandidateKind::TargetDebug,
        };
        report.candidates.push(candidate.clone());
        if !dry_run {
            match std::fs::remove_dir_all(&debug) {
                Ok(()) => {
                    report.removed.push(candidate);
                    report.cap_removed = true;
                }
                Err(error) => report.errors.push(format!("{}: {error}", debug.display())),
            }
        }
        report.bytes_after = 0;
    } else {
        report.bytes_after = remaining;
    }
    report
}
