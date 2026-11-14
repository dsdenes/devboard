//! Retention for the two surfaces a build leaves behind: the transient
//! `run-p*` scopes inside `devboard.slice`, and the `.test-tmp` trees the
//! workspace's tests write.
//!
//! A scope is stopped only when nothing live owns it. The proofs are the
//! scope's own record (a worker's published state names a live pid), the
//! directory it serves (a registered worktree or the checkout itself), the
//! process table (a live child's working directory), and an allowlist of
//! tools whose presence means work in flight. One scratch entry leaves only
//! after it is older than the retention window and no live process holds a
//! working directory inside it; an old file inside a fresh tree still goes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde_json::Value;

use super::watchdog::{Instance, CLEANUP_RETENTION_MS};

/// The window for a `.test-tmp` entry. A test tree is disposable by
/// definition, so one day is enough to prove no run still owns it.
pub const TEST_SCRATCH_RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

/// A scope younger than this may belong to a test run this cleanup cannot
/// see entirely; it is never a candidate. The stale scopes a build leaves
/// behind are days old, never hours.
pub const SCOPE_MIN_AGE_MS: i64 = 6 * 60 * 60 * 1000;

/// Executables that mean a build or an agent is running in the scope. A
/// scope holding one of these is never a candidate.
pub const KEEP_EXECUTABLES: [&str; 7] = [
    "cargo",
    "rustc",
    "rustdoc",
    "ld",
    "ld.lld",
    "clippy-driver",
    "omp",
];

/// Top-level entries of a worktree's `.devboard/.tmp` that hold durable
/// state. No age makes them a scratch candidate.
const DURABLE_TMP_NAMES: [&str; 26] = [
    "api-standards",
    "bundles",
    "coach",
    "complexity",
    "consistent-naming",
    "control",
    "dead-code",
    "design",
    "flow",
    "goal-drafts",
    "issues",
    "journal",
    "mcp-optimizer",
    "orchestrator",
    "providers",
    "release-train",
    "resources",
    "runs",
    "scout",
    "serving",
    "single-responsibility",
    "state",
    "supervision",
    "tasks",
    "watchdog",
    "worktree-cleanup",
];

// ---------------------------------------------------------------------------
// Test scratch
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScratchKind {
    TestTmp,
    Tmp,
}

impl ScratchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TestTmp => "test-tmp",
            Self::Tmp => "tmp",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScratchCandidate {
    pub path: PathBuf,
    pub kind: ScratchKind,
}

#[derive(Clone, Debug, Default)]
pub struct ScratchCleanupReport {
    /// Everything a dry run would remove.
    pub candidates: Vec<ScratchCandidate>,
    /// What a real pass removed.
    pub removed: Vec<ScratchCandidate>,
    pub errors: Vec<String>,
    pub skipped: Option<String>,
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn modified_ms(path: &Path) -> Option<i64> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// One scratch root and the window its entries must exceed.
struct ScratchRoot {
    directory: PathBuf,
    window_ms: i64,
    kind: ScratchKind,
}

fn scratch_roots(root: &Path) -> Vec<ScratchRoot> {
    let mut roots = vec![ScratchRoot {
        directory: root.join(".devboard").join(".test-tmp"),
        window_ms: TEST_SCRATCH_RETENTION_MS,
        kind: ScratchKind::TestTmp,
    }];
    let worktrees = root.join(".worktree");
    let mut names: Vec<std::ffi::OsString> = match std::fs::read_dir(&worktrees) {
        Ok(entries) => entries.flatten().map(|entry| entry.file_name()).collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    for name in names {
        if name == ".test-tmp" {
            continue;
        }
        let directory = worktrees.join(&name);
        if !std::fs::symlink_metadata(&directory)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        roots.push(ScratchRoot {
            directory: directory.join(".devboard").join(".test-tmp"),
            window_ms: TEST_SCRATCH_RETENTION_MS,
            kind: ScratchKind::TestTmp,
        });
        roots.push(ScratchRoot {
            directory: directory.join(".devboard").join(".tmp"),
            window_ms: CLEANUP_RETENTION_MS,
            kind: ScratchKind::Tmp,
        });
    }
    roots
}

fn durable_tmp_entry(name: &str) -> bool {
    DURABLE_TMP_NAMES.contains(&name) || name.starts_with("lock.")
}

fn remove_entry(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) => Err(error),
    }
}

/// Every live working directory and each of its ancestors, so one lookup
/// keeps a subtree a live process holds.
fn protected_directories(live: &[PathBuf]) -> HashSet<PathBuf> {
    let mut protected = HashSet::new();
    for cwd in live {
        let mut path = cwd.clone();
        loop {
            if !protected.insert(path.clone()) {
                break;
            }
            match path.parent() {
                Some(parent) => path = parent.to_path_buf(),
                None => break,
            }
        }
    }
    protected
}

fn scratch_visit(
    root: &Path,
    path: &Path,
    cutoff: i64,
    protected: &HashSet<PathBuf>,
    kind: ScratchKind,
    dry_run: bool,
    report: &mut ScratchCleanupReport,
) -> (bool, u64) {
    if protected.contains(path) {
        return (false, 0);
    }
    if kind == ScratchKind::Tmp && path.parent() == Some(root) {
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            if durable_tmp_entry(name) {
                return (false, 0);
            }
        }
    }
    let Ok(entry) = std::fs::symlink_metadata(path) else {
        report
            .errors
            .push(format!("{}: could not read", path.display()));
        return (false, 0);
    };
    let Some(modified) = modified_ms(path) else {
        return (false, 0);
    };
    if entry.file_type().is_symlink() || entry.is_file() {
        if modified >= cutoff {
            return (false, 0);
        }
        let candidate = ScratchCandidate {
            path: path.to_path_buf(),
            kind,
        };
        if dry_run {
            report.candidates.push(candidate);
            return (true, 0);
        }
        return match remove_entry(path) {
            Ok(()) => {
                report.removed.push(candidate);
                (true, 0)
            }
            Err(error) => {
                report.errors.push(format!("{}: {error}", path.display()));
                (false, 0)
            }
        };
    }
    if !entry.is_dir() {
        return (false, 0);
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        report
            .errors
            .push(format!("{}: could not read", path.display()));
        return (false, 0);
    };
    let mut names: Vec<std::ffi::OsString> =
        entries.flatten().map(|entry| entry.file_name()).collect();
    names.sort();
    let mut survivors = 0;
    let mut bytes = 0;
    for name in names {
        let (removable, child_bytes) = scratch_visit(
            root,
            &path.join(name),
            cutoff,
            protected,
            kind,
            dry_run,
            report,
        );
        bytes += child_bytes;
        if !removable {
            survivors += 1;
        }
    }
    if survivors == 0 && modified < cutoff {
        let candidate = ScratchCandidate {
            path: path.to_path_buf(),
            kind,
        };
        if dry_run {
            report.candidates.push(candidate);
            return (true, bytes);
        }
        return match std::fs::remove_dir(path) {
            Ok(()) => {
                report.removed.push(candidate);
                (true, bytes)
            }
            Err(error) => {
                report.errors.push(format!("{}: {error}", path.display()));
                (false, bytes)
            }
        };
    }
    (false, bytes)
}

/// True while a test binary runs from a build tree. A test's fixtures may
/// carry deliberately ancient mtimes, so a sweep never reaches inside a fresh
/// tree while one runs; it only removes whole trees that already aged out.
pub fn test_process_running() -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(exe) = std::fs::read_link(entry.path().join("exe")) else {
            continue;
        };
        let text = exe.to_string_lossy();
        if text.contains("/target/debug/deps/") || text.contains("/target/release/deps/") {
            return true;
        }
    }
    false
}

fn scratch_top_level(
    root: &Path,
    path: &Path,
    cutoff: i64,
    protected: &HashSet<PathBuf>,
    kind: ScratchKind,
    dry_run: bool,
    report: &mut ScratchCleanupReport,
) {
    if protected.contains(path) {
        return;
    }
    if kind == ScratchKind::Tmp && path.parent() == Some(root) {
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            if durable_tmp_entry(name) {
                return;
            }
        }
    }
    let Some(modified) = modified_ms(path) else {
        return;
    };
    if modified >= cutoff {
        return;
    }
    let candidate = ScratchCandidate {
        path: path.to_path_buf(),
        kind,
    };
    if dry_run {
        report.candidates.push(candidate);
        return;
    }
    match remove_entry(path) {
        Ok(()) => report.removed.push(candidate),
        Err(error) => report.errors.push(format!("{}: {error}", path.display())),
    }
}

/// Sweeps every `.devboard/.test-tmp` tree under the checkout and its
/// worktrees, plus every worktree's `.devboard/.tmp`, removing an entry only
/// when it is older than its window and no live process holds a working
/// directory inside it.
pub fn run_scratch_cleanup(
    root: &Path,
    now_ms: i64,
    dry_run: bool,
    live_directories: &dyn Fn() -> Vec<PathBuf>,
) -> ScratchCleanupReport {
    run_scratch_cleanup_with(
        root,
        now_ms,
        dry_run,
        live_directories,
        !test_process_running(),
    )
}

/// `run_scratch_cleanup` with an explicit mode: `recursive` reaches old files
/// inside a tree whose top-level entry is fresh, which is safe only when no
/// test binary is running.
pub fn run_scratch_cleanup_with(
    root: &Path,
    now_ms: i64,
    dry_run: bool,
    live_directories: &dyn Fn() -> Vec<PathBuf>,
    recursive: bool,
) -> ScratchCleanupReport {
    let mut report = ScratchCleanupReport::default();
    let root = canonical(root);
    let protected = protected_directories(&live_directories());
    for scratch in scratch_roots(&root) {
        let Ok(entries) = std::fs::read_dir(&scratch.directory) else {
            continue;
        };
        let mut names: Vec<std::ffi::OsString> =
            entries.flatten().map(|entry| entry.file_name()).collect();
        names.sort();
        let cutoff = now_ms - scratch.window_ms;
        for name in names {
            let path = scratch.directory.join(name);
            if recursive {
                scratch_visit(
                    &scratch.directory,
                    &path,
                    cutoff,
                    &protected,
                    scratch.kind,
                    dry_run,
                    &mut report,
                );
            } else {
                scratch_top_level(
                    &scratch.directory,
                    &path,
                    cutoff,
                    &protected,
                    scratch.kind,
                    dry_run,
                    &mut report,
                );
            }
        }
    }
    report
}

// ---------------------------------------------------------------------------
// Transient scopes
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeProcess {
    pub pid: u32,
    /// The basename of `/proc/<pid>/exe`, or of `argv[0]` when the executable
    /// link is gone.
    pub executable: String,
    /// The process's working directory; `None` when the kernel refuses to read
    /// it or the directory was already removed.
    pub cwd: Option<PathBuf>,
    pub argv: Vec<String>,
    /// The process's age; `None` when the kernel refuses to report it, which
    /// keeps the scope.
    pub age_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeFacts {
    pub unit: String,
    /// Active or activating.
    pub active: bool,
    /// Failed and left loaded.
    pub failed: bool,
    pub processes: Vec<ScopeProcess>,
}

#[derive(Clone, Debug)]
pub struct ScopeContext {
    pub root: PathBuf,
    /// Every path `git worktree list --porcelain` names, canonicalized.
    pub registered_worktrees: HashSet<PathBuf>,
    /// The dashboards this host is serving; their scopes are never stopped.
    pub dashboard_pids: HashSet<u32>,
    pub now_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeCandidate {
    pub unit: String,
    pub reason: String,
    pub pids: Vec<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct ScopeCleanupReport {
    /// Every provably dead scope a dry run would stop.
    pub candidates: Vec<ScopeCandidate>,
    /// What a real pass stopped.
    pub stopped: Vec<ScopeCandidate>,
    pub errors: Vec<String>,
    pub skipped: Option<String>,
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// One option's value from an argument vector, written `--name value` or
/// `--name=value`.
fn option_value(argv: &[String], name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let prefix = format!("--{name}=");
    for (index, argument) in argv.iter().enumerate() {
        if let Some(value) = argument.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
        if argument == &flag {
            return argv.get(index + 1).cloned();
        }
    }
    None
}

/// Every directory a scope's arguments name as its own: the state directory
/// it writes and the worktree it serves.
fn scope_directories(process: &ScopeProcess) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut state_dirs = Vec::new();
    let mut worktrees = Vec::new();
    if let Some(value) = option_value(&process.argv, "state-dir") {
        state_dirs.push(canonical(Path::new(&value)));
    }
    for name in ["repo", "repo-dir"] {
        if let Some(value) = option_value(&process.argv, name) {
            worktrees.push(canonical(Path::new(&value)));
        }
    }
    if let Some(cwd) = &process.cwd {
        // A process started inside a checkout names it by its cwd even when
        // its argv carries no `--repo`: `<checkout>/.devboard/...` and
        // `<checkout>/.devboard` both point at `<checkout>`. A cwd inside a
        // test scratch tree names no checkout; its `--repo` (when it has one)
        // is the scratch repository itself.
        if scratch_entry(cwd).is_none() {
            let mut prefix = cwd.clone();
            let mut found = false;
            while let Some(parent) = prefix.parent() {
                if prefix.file_name().and_then(|name| name.to_str()) == Some(".devboard") {
                    worktrees.push(parent.to_path_buf());
                    found = true;
                    break;
                }
                prefix = parent.to_path_buf();
            }
            if !found {
                if let Some(parent) = cwd.parent() {
                    if parent.file_name().and_then(|name| name.to_str()) == Some(".devboard") {
                        worktrees.push(parent.parent().unwrap_or(parent).to_path_buf());
                    }
                }
            }
        }
    }
    (state_dirs, worktrees)
}

fn within_registered(process: &ScopeProcess, context: &ScopeContext) -> bool {
    let Some(cwd) = &process.cwd else {
        return false;
    };
    let cwd = canonical(cwd);
    // A process that lives inside a test scratch tree is not serving the
    // worktree that happens to contain that tree.
    if scratch_entry(&cwd).is_some() {
        return false;
    }
    if cwd == context.root || cwd == context.root.join(".devboard") {
        return true;
    }
    context.registered_worktrees.iter().any(|worktree| {
        let under_root = worktree == &context.root;
        &cwd == worktree || (!under_root && cwd.starts_with(worktree))
    })
}

/// The scratch entry a cwd names, when it sits under a `.test-tmp` tree.
fn scratch_entry(cwd: &Path) -> Option<PathBuf> {
    let parts: Vec<std::ffi::OsString> = cwd
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect();
    for index in 0..parts.len() {
        if parts[index] == ".devboard"
            && parts.get(index + 1).map(|part| part.as_os_str())
                == Some(std::ffi::OsStr::new(".test-tmp"))
        {
            let entry: PathBuf = parts.iter().take(index + 3).collect();
            return Some(entry);
        }
    }
    None
}

fn fresh_scratch(process: &ScopeProcess, now_ms: i64) -> bool {
    let Some(cwd) = &process.cwd else {
        return false;
    };
    let Some(entry) = scratch_entry(cwd) else {
        return false;
    };
    let Some(modified) = modified_ms(&entry) else {
        return false;
    };
    modified >= now_ms - TEST_SCRATCH_RETENTION_MS
}

fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn terminal_lifecycle(lifecycle: &str) -> bool {
    matches!(lifecycle, "stopped" | "failed" | "succeeded" | "done")
}

/// True when a worker record under one state directory names a live loop for
/// a process in the scope. The record is the run's own published state; a
/// `running` or `idle` family is still serving.
fn state_dir_has_live_record(state_dir: &Path, pids: &HashSet<u32>) -> bool {
    let mut records: Vec<PathBuf> = Vec::new();
    let legacy = state_dir.join("worker.json");
    if legacy.is_file() {
        records.push(legacy);
    }
    if let Ok(families) = std::fs::read_dir(state_dir) {
        for family in families.flatten() {
            let family = family.path();
            let legacy = family.join("worker.json");
            if legacy.is_file() {
                records.push(legacy);
            }
            let workers = family.join("workers");
            if let Ok(versions) = std::fs::read_dir(&workers) {
                for version in versions.flatten() {
                    let record = version.path().join("worker.json");
                    if record.is_file() {
                        records.push(record);
                    }
                }
            }
        }
    }
    records.iter().any(|record| {
        let Ok(text) = std::fs::read_to_string(record) else {
            return false;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return false;
        };
        let Some(pid) = value.get("pid").and_then(Value::as_u64) else {
            return false;
        };
        let pid = pid as u32;
        if !pids.contains(&pid) || !pid_alive(pid) {
            return false;
        }
        let lifecycle = value
            .get("lifecycle")
            .and_then(Value::as_str)
            .unwrap_or_default();
        !terminal_lifecycle(lifecycle)
    })
}

/// Decides one scope. `Some` names a scope whose work is provably over;
/// `None` keeps everything live, fresh, or owned by a registered checkout.
pub fn evaluate_scope(facts: &ScopeFacts, context: &ScopeContext) -> Option<ScopeCandidate> {
    let pids: Vec<u32> = facts.processes.iter().map(|process| process.pid).collect();
    let candidate = |reason: &str| {
        Some(ScopeCandidate {
            unit: facts.unit.clone(),
            reason: reason.to_string(),
            pids: pids.clone(),
        })
    };
    if facts.failed {
        return candidate("failed");
    }
    if !facts.active {
        // An inactive unit is already stopped; the next cleanup pass never
        // reports it again.
        return None;
    }
    if facts.processes.is_empty() {
        return candidate("no process");
    }
    if facts.processes.iter().any(|process| {
        process
            .age_ms
            .map(|age| age < SCOPE_MIN_AGE_MS)
            .unwrap_or(true)
    }) {
        return None;
    }
    let pid_set: HashSet<u32> = pids.iter().copied().collect();
    if facts
        .processes
        .iter()
        .any(|process| context.dashboard_pids.contains(&process.pid))
    {
        return None;
    }
    if facts.processes.iter().any(|process| {
        KEEP_EXECUTABLES.contains(&process.executable.as_str())
            || process
                .argv
                .first()
                .map(|argument| basename(Path::new(argument)))
                .map(|argument| KEEP_EXECUTABLES.contains(&argument.as_str()))
                .unwrap_or(false)
    }) {
        return None;
    }
    if facts
        .processes
        .iter()
        .any(|process| within_registered(process, context))
    {
        return None;
    }
    if facts
        .processes
        .iter()
        .any(|process| fresh_scratch(process, context.now_ms))
    {
        return None;
    }
    let (state_dirs, worktrees) = facts.processes.iter().map(scope_directories).fold(
        (Vec::new(), Vec::new()),
        |mut all, (states, repos)| {
            all.0.extend(states);
            all.1.extend(repos);
            (all.0, all.1)
        },
    );
    if state_dirs
        .iter()
        .any(|directory| state_dir_has_live_record(directory, &pid_set))
    {
        return None;
    }
    // The record is terminal or absent, the state directory is absent or the
    // served worktree is no longer registered, and no live process holds a
    // working directory inside either.
    let state_absent = state_dirs.iter().all(|directory| !directory.exists());
    let worktree_unregistered = worktrees.iter().all(|worktree| {
        !context.registered_worktrees.contains(worktree) && worktree != &context.root
    });
    if !state_absent && !worktree_unregistered {
        return None;
    }
    for process in &facts.processes {
        let Some(cwd) = &process.cwd else {
            continue;
        };
        let cwd = canonical(cwd);
        if state_dirs
            .iter()
            .any(|directory| directory.exists() && cwd.starts_with(directory))
        {
            return None;
        }
    }
    candidate("no live record, state, or registered worktree")
}

fn cgroup_processes(directory: &Path, depth: usize) -> Vec<u32> {
    if depth > 4 {
        return Vec::new();
    }
    let mut pids = Vec::new();
    if let Ok(text) = std::fs::read_to_string(directory.join("cgroup.procs")) {
        for line in text.lines() {
            if let Ok(pid) = line.trim().parse::<u32>() {
                pids.push(pid);
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                pids.extend(cgroup_processes(&entry.path(), depth + 1));
            }
        }
    }
    pids
}

fn process_age_ms(pid: u32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    let start_ticks: i64 = stat[close + 1..].split_whitespace().nth(19)?.parse().ok()?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return None;
    }
    let uptime = std::fs::read_to_string("/proc/uptime").ok()?;
    let uptime_ms = (uptime.split_whitespace().next()?.parse::<f64>().ok()? * 1000.0) as i64;
    Some((uptime_ms - start_ticks * 1000 / hz).max(0))
}

fn read_argv(pid: u32) -> Vec<String> {
    let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&raw)
        .split('\0')
        .filter(|argument| !argument.is_empty())
        .map(str::to_string)
        .collect()
}

fn process_facts(pid: u32) -> Option<ScopeProcess> {
    let argv = read_argv(pid);
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
    let executable = exe
        .as_deref()
        .map(basename)
        .filter(|name| !name.is_empty())
        .or_else(|| argv.first().map(|argument| basename(Path::new(argument))))
        .unwrap_or_default();
    if executable.is_empty() && argv.is_empty() {
        return None;
    }
    let cwd = std::fs::canonicalize(format!("/proc/{pid}/cwd")).ok();
    Some(ScopeProcess {
        pid,
        executable,
        cwd,
        argv,
        age_ms: process_age_ms(pid),
    })
}

fn systemctl(args: &[&str]) -> std::result::Result<String, String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn property<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines()
        .find_map(|line| line.strip_prefix(&format!("{name}=")))
}

/// Reads every `run-p*` scope systemd knows about and the processes each one
/// holds. A host without a user systemd answers with an empty list.
pub fn collect_scope_facts() -> std::result::Result<Vec<ScopeFacts>, String> {
    let listing = match systemctl(&[
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "run-p*.scope",
    ]) {
        Ok(listing) => listing,
        Err(error) if error.is_empty() => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut units: Vec<String> = listing
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .filter(|unit| unit.starts_with("run-p") && unit.ends_with(".scope"))
        .map(str::to_string)
        .collect();
    units.sort();
    units.dedup();
    let mut facts = Vec::new();
    for unit in units {
        let shown = systemctl(&["show", &unit, "-p", "ActiveState", "-p", "ControlGroup"])?;
        let active_state = property(&shown, "ActiveState").unwrap_or_default();
        let control_group = property(&shown, "ControlGroup").unwrap_or_default();
        let active = matches!(active_state, "active" | "activating" | "reloading");
        let failed = active_state == "failed";
        let mut processes = Vec::new();
        if !control_group.is_empty() {
            let directory = Path::new("/sys/fs/cgroup").join(control_group.trim_start_matches('/'));
            let mut pids = cgroup_processes(&directory, 0);
            pids.sort();
            pids.dedup();
            processes = pids.iter().filter_map(|pid| process_facts(*pid)).collect();
        }
        facts.push(ScopeFacts {
            unit,
            active,
            failed,
            processes,
        });
    }
    Ok(facts)
}

fn stop_scope(unit: &str) -> std::result::Result<(), String> {
    systemctl(&["stop", unit])?;
    let _ = systemctl(&["reset-failed", unit]);
    Ok(())
}

fn scope_context(root: &Path, now_ms: i64, instances: &[Instance]) -> ScopeContext {
    let root = canonical(root);
    let mut registered = crate::workers::worktrees::registered_worktrees(&root).unwrap_or_default();
    registered.insert(root.clone());
    ScopeContext {
        root,
        registered_worktrees: registered,
        dashboard_pids: instances.iter().map(|instance| instance.pid).collect(),
        now_ms,
    }
}

/// Evaluates and (outside a dry run) stops every provably dead scope. The
/// stop is one `systemctl --user stop`; a failed unit is reset so the next
/// pass does not report it again.
pub fn run_scope_cleanup(
    root: &Path,
    now_ms: i64,
    dry_run: bool,
    instances: &[Instance],
    facts: &[ScopeFacts],
    stop: &dyn Fn(&str) -> std::result::Result<(), String>,
) -> ScopeCleanupReport {
    let context = scope_context(root, now_ms, instances);
    let mut report = ScopeCleanupReport::default();
    for scope in facts {
        let Some(candidate) = evaluate_scope(scope, &context) else {
            continue;
        };
        if dry_run {
            report.candidates.push(candidate);
            continue;
        }
        match stop(&candidate.unit) {
            Ok(()) => report.stopped.push(candidate),
            Err(error) => report.errors.push(format!("{}: {error}", candidate.unit)),
        }
    }
    report
}

/// Production entry point: collect the host's scopes and stop the dead ones.
pub fn run_scope_cleanup_on_host(
    root: &Path,
    now_ms: i64,
    dry_run: bool,
    instances: &[Instance],
) -> ScopeCleanupReport {
    match collect_scope_facts() {
        Ok(facts) => run_scope_cleanup(root, now_ms, dry_run, instances, &facts, &stop_scope),
        Err(error) => ScopeCleanupReport {
            skipped: Some(error),
            ..ScopeCleanupReport::default()
        },
    }
}
