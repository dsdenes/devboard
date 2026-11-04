//! Process supervision: one spawn path, one durable record per child, one
//! reaper.
//!
//! A harness child is started in its own process group and recorded as
//! `{version,pid,argv,cwd,ownerPid,startedAt,startTicks,pgid}` before the
//! caller uses it, so a later tick can prove the child outlived its owner and
//! end it.
//!
//! Nothing here decides what a dashboard should keep; age-based file retention
//! belongs to cleanup, exactly as in `watchdog/supervision.ts`.
//!
//! This module also carries the process-table helpers the reaper needs:
//! `/proc/<pid>/stat` parsing, snapshots with their ancestor chains, and the
//! verification-scratch check. They are inlined from `watchdog/discovery.ts`
//! rather than pulled into a shared module, because supervision is their only
//! consumer here.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use time::macros::format_description;

/// How long an unrecorded orphan may exist before a kill is allowed.
pub const SUPERVISION_ORPHAN_GRACE_MS: u64 = 5_000;
/// How long a signalled process may take to exit before SIGKILL.
pub const SUPERVISION_KILL_GRACE_MS: u64 = 2_000;
/// The record directory inside a state directory.
pub const SUPERVISION_DIRECTORY: &str = "supervision";
/// The one interval the watchdog schedules the reaper on.
pub const SUPERVISION_INTERVAL_MS: u64 = 30_000;
/// Linux reports a process start in USER_HZ ticks per second.
const CLOCK_TICKS_PER_SECOND: f64 = 100.0;
/// The record schema version written by every spawn path.
const RECORD_VERSION: i64 = 1;

/// One supervised child. `argv` and `start_ticks` are read from `/proc` right
/// after the spawn, so they describe the process the kernel started rather
/// than the request the caller made; `start_ticks` is what separates a live
/// child from a recycled pid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionRecord {
    pub version: i64,
    pub pid: u32,
    pub argv: Vec<String>,
    pub cwd: String,
    pub owner_pid: u32,
    pub started_at: String,
    pub start_ticks: i64,
    pub pgid: i64,
}

/// A state directory whose `supervision` child carries records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SupervisionScope {
    pub state_dir: PathBuf,
    pub repo_dir: PathBuf,
}

/// Where the records of one caller's children live.
pub fn supervision_directory(state_dir: &Path) -> PathBuf {
    absolute(state_dir).join(SUPERVISION_DIRECTORY)
}

/// The record file of one child in one state directory.
pub fn supervision_record_path(state_dir: &Path, pid: u32) -> PathBuf {
    supervision_directory(state_dir).join(format!("{pid}.json"))
}

/// The state directory a child records into when its caller names none: the
/// dashboard's own `STATE_DIR`, then the root's canonical `.devboard/.tmp`,
/// then the serving harness's own `.tmp`, which is the same directory on a
/// source checkout and the dashboard's own state directory under an install
/// prefix.
pub fn default_supervision_state_directory() -> PathBuf {
    if let Some(state) = environment_value("STATE_DIR") {
        return absolute(Path::new(&state));
    }
    if let Some(repo) = environment_value("REPO_DIR") {
        return absolute(Path::new(&repo)).join(".devboard").join(".tmp");
    }
    harness_directory().join(".tmp")
}

/// The harness directory this build belongs to, resolved from the executable
/// so an installed binary never names its compile-time checkout.
fn harness_directory() -> PathBuf {
    if let Some(value) = environment_value("DEVBOARD_RUNNING_HARNESS_DIR") {
        return absolute(Path::new(&value));
    }
    crate::version::running_harness_dir()
}

/// A trimmed, non-empty environment value.
fn environment_value(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The absolute form of one path, without resolving symlinks.
fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `/proc/<pid>/stat` fields this module needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessStat {
    pub pid: u32,
    pub ppid: i64,
    /// The process group id; equal to `pid` for a supervised child.
    pub pgrp: i64,
    /// Field 22, in USER_HZ ticks since boot.
    pub start_ticks: i64,
    /// Field 3, e.g. `R`, `S`, or `Z`.
    pub state: String,
}

/// Reads the `/proc/<pid>/stat` fields supervision relies on.
pub fn process_stat(pid: u32) -> Option<ProcessStat> {
    if !cfg!(target_os = "linux") || pid == 0 {
        return None;
    }
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat(pid, &text)
}

/// Parses one `/proc/<pid>/stat` line.
///
/// The command name may contain spaces and parentheses; fields resume after
/// the last `)`. That suffix starts at field 3 (state), so ppid is index 1,
/// pgrp index 2, and starttime index 19.
fn parse_stat(pid: u32, text: &str) -> Option<ProcessStat> {
    let close = text.rfind(')')?;
    let suffix = text.get(close + 2..)?;
    let fields: Vec<&str> = suffix.split(' ').collect();
    let state = fields.first().copied().unwrap_or_default().to_string();
    let ppid = fields.get(1)?.parse::<i64>().ok()?;
    let pgrp = fields.get(2)?.parse::<i64>().ok()?;
    let start_ticks = fields.get(19)?.parse::<i64>().ok()?;
    Some(ProcessStat {
        pid,
        ppid,
        pgrp,
        start_ticks,
        state,
    })
}

/// True when the pid names a running process that is not a zombie. A killed
/// child whose parent has not reaped it yet is dead for supervision's purpose.
pub fn live_process(pid: u32) -> bool {
    if let Some(stat) = process_stat(pid) {
        return stat.state != "Z";
    }
    !cfg!(target_os = "linux") && pid_alive(pid)
}

/// True when a signal of zero would be delivered, `EPERM` included.
fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        if pid == 0 {
            return false;
        }
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// The kernel's own argv for a process, which is what a record stores.
pub fn process_argv(pid: u32) -> Option<Vec<String>> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let text = String::from_utf8_lossy(&raw);
    Some(
        text.split('\0')
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// True when a process started less than `ms` ago.
pub fn process_age_ms(pid: u32) -> Option<f64> {
    let stat = process_stat(pid)?;
    let uptime_text = std::fs::read_to_string("/proc/uptime").ok()?;
    let uptime = uptime_text.split(' ').next()?.parse::<f64>().ok()?;
    if !uptime.is_finite() {
        return None;
    }
    Some((uptime * 1000.0 - stat.start_ticks as f64 * 1000.0 / CLOCK_TICKS_PER_SECOND).max(0.0))
}

/// Writes one JSON document atomically with a trailing newline.
fn write_json_atomic(path: &Path, value: &Value) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(
        ".{}.{:016x}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    let temporary = PathBuf::from(name);
    let mut text = crate::jsjson::stringify(value);
    text.push('\n');
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, path)
}

/// One JSON number that JavaScript's `Number.isInteger` would accept.
fn json_integer(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                return Some(integer);
            }
            if let Some(integer) = number.as_u64() {
                return i64::try_from(integer).ok();
            }
            let float = number.as_f64()?;
            if float.fract() == 0.0 && float >= i64::MIN as f64 && float <= i64::MAX as f64 {
                Some(float as i64)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Parses one record, rejecting values a later proof could not trust.
fn parse_record(value: &Value) -> Option<SupervisionRecord> {
    let object = value.as_object()?;
    let pid = json_integer(object.get("pid"))?;
    if pid <= 0 || pid > i64::from(u32::MAX) {
        return None;
    }
    let owner_pid = json_integer(object.get("ownerPid"))?;
    if owner_pid <= 0 || owner_pid > i64::from(u32::MAX) {
        return None;
    }
    let started_at = object.get("startedAt")?.as_str()?.to_string();
    let cwd = object.get("cwd")?.as_str()?.to_string();
    let start_ticks = json_integer(object.get("startTicks"))?;
    let pgid = json_integer(object.get("pgid"))?;
    let argv_json = object.get("argv")?.as_array()?;
    let mut argv = Vec::with_capacity(argv_json.len());
    for entry in argv_json {
        argv.push(entry.as_str()?.to_string());
    }
    Some(SupervisionRecord {
        version: json_integer(object.get("version")).unwrap_or(RECORD_VERSION),
        pid: pid as u32,
        argv,
        cwd,
        owner_pid: owner_pid as u32,
        started_at,
        start_ticks,
        pgid,
    })
}

/// The kernel argv of a just-spawned child. The exec can trail the spawn by a
/// few milliseconds, so an empty read is retried briefly; a child that is gone
/// or still nameless is never recorded, because a record must describe the
/// process a later proof would signal.
fn read_argv_soon(pid: u32) -> Option<Vec<String>> {
    for _attempt in 0..50 {
        if let Some(argv) = process_argv(pid) {
            if !argv.is_empty() {
                return Some(argv);
            }
        }
        process_stat(pid)?;
        std::thread::sleep(Duration::from_millis(2));
    }
    None
}

/// Records the pid now, before the caller uses the child.
fn record_child(state_dir: &Path, pid: u32, cwd: &Path) -> Option<PathBuf> {
    let stat = process_stat(pid)?;
    let argv = read_argv_soon(pid)?;
    let record = SupervisionRecord {
        version: RECORD_VERSION,
        pid,
        argv,
        cwd: absolute(cwd).to_string_lossy().into_owned(),
        owner_pid: std::process::id(),
        started_at: now_iso8601_millis(),
        start_ticks: stat.start_ticks,
        pgid: stat.pgrp,
    };
    let path = supervision_record_path(state_dir, pid);
    let value = serde_json::to_value(&record).ok()?;
    write_json_atomic(&path, &value).ok()?;
    Some(path)
}

/// The current instant as an ISO 8601 UTC timestamp with exactly three
/// fractional digits, the form `Date.prototype.toISOString` writes.
fn now_iso8601_millis() -> String {
    let format =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    time::OffsetDateTime::now_utc()
        .format(&format)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/// Removes one record, ignoring a record a concurrent reaper already removed.
pub fn remove_supervision_record(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Refreshes a record whose child is still owned, so a later sweep can tell a
/// live record from an abandoned one.
#[cfg(unix)]
fn touch_record(path: &Path) {
    use std::os::unix::ffi::OsStrExt;

    let Ok(target) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let stamp = libc::timeval {
        tv_sec: now.as_secs() as libc::time_t,
        tv_usec: now.subsec_micros() as libc::suseconds_t,
    };
    let times = [stamp, stamp];
    unsafe {
        libc::utimes(target.as_ptr(), times.as_ptr());
    }
}

#[cfg(not(unix))]
fn touch_record(_path: &Path) {}

/// Every readable record under one state directory.
pub fn read_supervision_records(state_dir: &Path) -> Vec<SupervisionRecord> {
    let directory = supervision_directory(state_dir);
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut names: Vec<std::ffi::OsString> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name())
        .collect();
    names.sort();
    let mut records = Vec::new();
    for name in names {
        if !name.to_string_lossy().ends_with(".json") {
            continue;
        }
        let Some(text) = std::fs::read_to_string(directory.join(&name)).ok() else {
            continue;
        };
        let Some(value) = serde_json::from_str::<Value>(&text).ok() else {
            continue;
        };
        if let Some(record) = parse_record(&value) {
            records.push(record);
        }
    }
    records
}

/// One child a caller starts and this module records.
pub struct SupervisedSpawnOptions {
    pub cwd: PathBuf,
    pub env: Option<HashMap<String, String>>,
    /// The state directory that carries the record; defaults as above.
    pub state_dir: Option<PathBuf>,
}

impl SupervisedSpawnOptions {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            env: None,
            state_dir: None,
        }
    }
}

/// A child with piped stdin, stdout, and stderr.
pub struct SupervisedChild {
    child: tokio::process::Child,
    record_path: Option<PathBuf>,
}

impl SupervisedChild {
    /// The pid the kernel assigned, when the child is still represented.
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// The underlying child, for stream and status access.
    pub fn child(&self) -> &tokio::process::Child {
        &self.child
    }

    /// The underlying child, mutably.
    pub fn child_mut(&mut self) -> &mut tokio::process::Child {
        &mut self.child
    }

    /// The durable record this child owns, when one was written.
    pub fn record_path(&self) -> Option<&Path> {
        self.record_path.as_deref()
    }

    /// Takes the piped stdin handle.
    pub fn take_stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.child.stdin.take()
    }

    /// Takes the piped stdout handle.
    pub fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child.stdout.take()
    }

    /// Takes the piped stderr handle.
    pub fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr.take()
    }

    /// Sends SIGKILL to the child without waiting for it.
    pub fn start_kill(&mut self) -> io::Result<()> {
        self.child.start_kill()
    }

    /// Sends SIGKILL and waits for the exit.
    pub async fn kill(&mut self) -> io::Result<()> {
        self.child.kill().await
    }

    /// Checks the child without blocking; a noticed exit removes its record.
    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            if let Some(path) = self.record_path.take() {
                remove_supervision_record(&path);
            }
        }
        Ok(status)
    }

    /// Waits for the child and removes its record, exactly as the TypeScript
    /// `child.exited` handler does.
    pub async fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        let result = self.child.wait().await;
        if let Some(path) = self.record_path.take() {
            remove_supervision_record(&path);
        }
        result
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        // A child that already exited leaves its record behind otherwise. A
        // still-running child keeps the record, so the reaper can still prove
        // and end it if this owner disappears.
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            if let Some(path) = self.record_path.take() {
                remove_supervision_record(&path);
            }
        }
    }
}

/// Starts one long-lived child in its own process group with piped stdio and
/// records it before returning. The record leaves when the child exits.
///
/// The caller must run inside a Tokio runtime, which [`tokio::process`]
/// requires.
pub fn supervised_spawn(
    argv: &[String],
    options: SupervisedSpawnOptions,
) -> io::Result<SupervisedChild> {
    let program = argv.first().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "spawn argv must not be empty")
    })?;
    let state_dir = options
        .state_dir
        .clone()
        .unwrap_or_else(default_supervision_state_directory);
    let mut command = tokio::process::Command::new(program);
    command.args(&argv[1..]);
    command.current_dir(&options.cwd);
    if let Some(env) = &options.env {
        command.env_clear();
        command.envs(env);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn()?;
    let record_path = child
        .id()
        .and_then(|pid| record_child(&state_dir, pid, &options.cwd));
    Ok(SupervisedChild { child, record_path })
}

/// One detached child a caller starts and this module records.
/// The failure sink one detached spawn reports through.
pub type SpawnErrorSink = Box<dyn Fn(&io::Error) + Send + Sync>;

pub struct SupervisedDetachOptions {
    pub cwd: PathBuf,
    /// The whole environment, as the caller resolved it.
    pub env: HashMap<String, String>,
    /// The state directory that carries the record; defaults as above.
    pub state_dir: Option<PathBuf>,
    pub stdio: DetachStdio,
    /// Called with a spawn failure; the caller keeps its own wording.
    pub on_error: Option<SpawnErrorSink>,
}

impl Default for SupervisedDetachOptions {
    fn default() -> Self {
        Self {
            cwd: PathBuf::new(),
            env: HashMap::new(),
            state_dir: None,
            stdio: DetachStdio::default(),
            on_error: None,
        }
    }
}

/// The three standard streams of a detached child.
pub struct DetachStdio {
    pub stdin: Stdio,
    pub stdout: Stdio,
    pub stderr: Stdio,
}

impl DetachStdio {
    /// `/dev/null` on all three streams, the TypeScript default.
    pub fn ignore() -> Self {
        Self {
            stdin: Stdio::null(),
            stdout: Stdio::null(),
            stderr: Stdio::null(),
        }
    }

    /// The parent's own descriptors, as TypeScript's `"inherit"` does.
    pub fn inherit() -> Self {
        Self {
            stdin: Stdio::inherit(),
            stdout: Stdio::inherit(),
            stderr: Stdio::inherit(),
        }
    }
}

impl Default for DetachStdio {
    fn default() -> Self {
        Self::ignore()
    }
}

/// Starts one detached child in its own process group and records it before
/// returning its pid. The record leaves when the child exits; a child that
/// outlives this process is removed by the reaper.
///
/// The caller must run inside a Tokio runtime, which [`tokio::process`]
/// requires; the watcher that removes the record runs until the child exits.
pub fn supervised_detach(argv: &[String], options: SupervisedDetachOptions) -> Option<u32> {
    let program = argv.first()?;
    let state_dir = options
        .state_dir
        .clone()
        .unwrap_or_else(default_supervision_state_directory);
    let mut command = tokio::process::Command::new(program);
    command.args(&argv[1..]);
    command.current_dir(&options.cwd);
    command.env_clear();
    command.envs(&options.env);
    command
        .stdin(options.stdio.stdin)
        .stdout(options.stdio.stdout)
        .stderr(options.stdio.stderr);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(on_error) = &options.on_error {
                on_error(&error);
            }
            return None;
        }
    };
    let pid = child.id();
    let record_path = pid.and_then(|pid| record_child(&state_dir, pid, &options.cwd));
    tokio::spawn(async move {
        let _ = child.wait().await;
        if let Some(path) = record_path {
            remove_supervision_record(&path);
        }
    });
    pid
}

/// True when the live process still is the one the record describes.
fn matches_record(record: &SupervisionRecord) -> bool {
    let Some(stat) = process_stat(record.pid) else {
        return false;
    };
    if stat.start_ticks != record.start_ticks {
        return false;
    }
    match process_argv(record.pid) {
        None => true,
        Some(argv) => argv.join("\u{0}") == record.argv.join("\u{0}"),
    }
}

/// True for a process the harness starts and supervises as a child of another:
/// a fixture peer, a run owner, a goal-draft owner, or a background worker
/// entry point of any family and any harness version. Every such process runs
/// a file inside a `.devboard` tree, so a worker name alone never marks an
/// unrelated process.
///
/// A dashboard is deliberately not a surface here. It is reparented to PID 1
/// by design, so "reparented" proves nothing for one. Its own record, written
/// by the helper, is the proof that ends it once its owner is gone.
pub fn is_supervised_surface(cmdline: &str) -> bool {
    if rust_harness_command(cmdline, &["serve", "worker", "acp-stub"]) {
        return true;
    }
    if !cmdline.contains(".devboard") {
        return false;
    }
    cmdline.split_whitespace().any(|token| {
        contains_with_boundary(token, "server/run-owner.ts")
            || contains_with_boundary(token, "server/goal-draft-owner.ts")
            || fixture_surface(token)
            || ends_with_segment(token, "worker.ts")
    })
}

/// True when the command line runs the Rust harness binary with one of
/// `subcommands` as its first argument: `devboard serve`, `devboard worker
/// <family>`, `devboard worker run-owner`, `devboard acp-stub`.
fn rust_harness_command(cmdline: &str, subcommands: &[&str]) -> bool {
    let tokens: Vec<&str> = cmdline.split_whitespace().collect();
    for (index, token) in tokens.iter().enumerate() {
        if !ends_with_segment(token, "devboard") && !ends_with_segment(token, "devboard.exe") {
            continue;
        }
        if let Some(subcommand) = tokens.get(index + 1) {
            if subcommands.contains(subcommand) {
                return true;
            }
        }
    }
    false
}

/// True when `needle` occurs in `text` at the start or after a `/`, which is
/// the boundary the TypeScript patterns spell `(?:^|/)`.
fn contains_with_boundary(text: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(found) = text[from..].find(needle) {
        let index = from + found;
        if index == 0 || text.as_bytes().get(index - 1) == Some(&b'/') {
            return true;
        }
        from = index + 1;
    }
    false
}

/// True when a whitespace-free token ends with exactly `segment` as a whole
/// path segment, which is the TypeScript end anchor `(?:\s|$)`.
pub fn ends_with_segment(token: &str, segment: &str) -> bool {
    match token.strip_suffix(segment) {
        Some(prefix) => prefix.is_empty() || prefix.ends_with('/'),
        None => false,
    }
}

/// `(?:^|/)server/fixtures/[^\s]+\.ts` over one whitespace-free token.
fn fixture_surface(token: &str) -> bool {
    let marker = "server/fixtures/";
    let mut from = 0;
    while let Some(found) = token[from..].find(marker) {
        let index = from + found;
        if index == 0 || token.as_bytes().get(index - 1) == Some(&b'/') {
            let rest = &token[index + marker.len()..];
            if rest.find(".ts").is_some_and(|position| position >= 1) {
                return true;
            }
        }
        from = index + 1;
    }
    false
}

/// True for `scripts/verify-<lowercase-name>.ts` as one whole token.
fn verify_script_token(token: &str) -> bool {
    let marker = "scripts/verify-";
    let Some(position) = token.rfind(marker) else {
        return false;
    };
    if position > 0 && token.as_bytes().get(position - 1) != Some(&b'/') {
        return false;
    }
    let Some(body) = token[position + marker.len()..].strip_suffix(".ts") else {
        return false;
    };
    !body.is_empty()
        && body
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// A harness entry point that starts and owns other harness processes. A
/// scratch child with one of these in its ancestry still has an owner and is
/// never a candidate; the job runner's own subreaper is not one, so a job's
/// orphaned grandchildren stay candidates.
fn is_harness_supervisor(cmdline: &str) -> bool {
    if rust_harness_command(cmdline, &["serve", "worker"]) {
        return true;
    }
    let tokens: Vec<&str> = cmdline.split_whitespace().collect();
    for (index, token) in tokens.iter().enumerate() {
        if ends_with_segment(token, "server/index.ts")
            || ends_with_segment(token, "watchdog/worker.ts")
            || ends_with_segment(token, "watchdog/main.ts")
            || verify_script_token(token)
        {
            return true;
        }
        if (*token == "bun" || *token == "bun.exe") && tokens.get(index + 1) == Some(&"test") {
            return true;
        }
    }
    false
}

/// True when a live harness supervisor still owns the candidate through its
/// ancestor chain: a test runner, a verification script, a dashboard, or the
/// watchdog. A reparented process whose new parent is the job runner's
/// subreaper has no such ancestor and stays a candidate.
fn supervised_by_ancestor(
    candidate: &ProcessSnapshot,
    by_pid: &HashMap<u32, ProcessSnapshot>,
) -> bool {
    candidate.ancestors.iter().any(|pid| {
        by_pid
            .get(pid)
            .is_some_and(|ancestor| is_harness_supervisor(&ancestor.cmdline))
    })
}

/// One process on the machine, as the reaper sees it.
#[derive(Clone, Debug, Default)]
pub struct ProcessSnapshot {
    pub pid: u32,
    pub cmdline: String,
    pub env: HashMap<String, String>,
    pub cwd: Option<PathBuf>,
    /// Process ids from the parent upward, nearest first.
    pub ancestors: Vec<u32>,
}

/// The parent id from `/proc/<pid>/status`.
fn parent_pid(pid: u32) -> Option<u32> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("PPid:") {
            return rest.trim().parse::<u32>().ok();
        }
    }
    None
}

/// The parent chain of a pid, nearest first, stopping at pid 1 or a cycle.
pub fn ancestry(pid: u32, limit: usize) -> Vec<u32> {
    let mut chain = Vec::new();
    let mut seen = HashSet::from([pid]);
    let mut current = parent_pid(pid);
    while let Some(value) = current {
        if value <= 1 || seen.contains(&value) || chain.len() >= limit {
            break;
        }
        chain.push(value);
        seen.insert(value);
        current = parent_pid(value);
    }
    chain
}

/// One process, read from `/proc`.
pub fn process_snapshot(pid: u32) -> Option<ProcessSnapshot> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let cmdline = String::from_utf8_lossy(&raw).replace('\0', " ");
    let env = read_environ(pid).unwrap_or_default();
    let cwd = std::fs::canonicalize(format!("/proc/{pid}/cwd")).ok();
    Some(ProcessSnapshot {
        pid,
        cmdline,
        env,
        cwd,
        ancestors: ancestry(pid, 64),
    })
}

/// The environment `/proc/<pid>/environ` reports.
fn read_environ(pid: u32) -> Option<HashMap<String, String>> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    let mut env = HashMap::new();
    for entry in String::from_utf8_lossy(&raw).split('\0') {
        if let Some((key, value)) = entry.split_once('=') {
            if !key.is_empty() {
                env.insert(key.to_string(), value.to_string());
            }
        }
    }
    Some(env)
}

/// Every process on the machine, read from `/proc`.
pub fn process_table() -> Vec<ProcessSnapshot> {
    let mut processes = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return processes;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        if let Some(snapshot) = process_snapshot(pid) {
            processes.push(snapshot);
        }
    }
    processes
}

/// True when a repository root sits in harness verification scratch
/// (`<anything>/.devboard/.tmp`). Verification fixtures live there, and a
/// defect they expose is the check's assertion, not one an operator must see.
pub fn is_verification_scratch(repo_dir: &str) -> bool {
    let segments: Vec<&str> = repo_dir
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect();
    segments
        .iter()
        .enumerate()
        .any(|(index, segment)| *segment == ".devboard" && segments.get(index + 1) == Some(&".tmp"))
}

/// Which proof turned one process into a candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReapReason {
    Record,
    Scratch,
}

/// One reaping decision, journaled and reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReapDecision {
    pub action: ReapAction,
    pub pid: u32,
    pub reason: ReapReason,
    pub detail: String,
}

/// What the reaper did to one candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReapAction {
    Killed,
    WouldKill,
    Skipped,
    RemovedRecord,
}

/// One reaping pass's report.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReapReport {
    /// False on a platform without `/proc`; nothing was signalled.
    pub available: bool,
    pub decisions: Vec<ReapDecision>,
    pub killed: Vec<u32>,
    pub removed_records: Vec<u32>,
}

/// The inputs of one reaping pass.
#[derive(Default)]
pub struct ReapOptions {
    /// Every `(state_dir, repo_dir)` whose records and proofs apply.
    pub scopes: Vec<SupervisionScope>,
    /// Pids a live lease, handoff, or worker lock still protects.
    pub protected_pids: HashSet<u32>,
    /// Test seam; production reads `/proc`.
    pub processes: Option<Vec<ProcessSnapshot>>,
    /// Test seam; production uses `/proc`.
    pub alive: Option<Box<dyn Fn(u32) -> bool + Send + Sync>>,
    /// Report candidates without signalling or deleting anything.
    pub dry_run: bool,
    /// How long an unrecorded orphan must have lived; defaults to the constant.
    pub orphan_grace_ms: Option<u64>,
    /// How long a signalled process may take to exit; defaults to the constant.
    pub kill_grace_ms: Option<u64>,
}

/// Signals a supervised child's whole process group, or the child alone when
/// it does not lead one; a signal to a group that is already gone is not an
/// error.
pub fn signal_process_group(pid: u32, signal: i32) {
    #[cfg(unix)]
    {
        if pid == 0 {
            return;
        }
        let stat = process_stat(pid);
        let group = match stat {
            Some(stat) if stat.pgrp == i64::from(pid) && pid != std::process::id() => -(pid as i32),
            _ => pid as i32,
        };
        if unsafe { libc::kill(group, signal) } == 0 {
            return;
        }
        unsafe {
            libc::kill(pid as i32, signal);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
    }
}

/// Waits for a process to disappear, polling `/proc` at the TypeScript
/// module's twenty-millisecond cadence.
fn wait_for_exit(pid: u32, alive: &dyn Fn(u32) -> bool, timeout_ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        if !cfg!(target_os = "linux") {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !alive(pid)
}

/// Ends one child and its group: SIGTERM, then SIGKILL after the grace.
fn terminate(pid: u32, alive: &dyn Fn(u32) -> bool, kill_grace_ms: u64) {
    signal_process_group(pid, libc::SIGTERM);
    if wait_for_exit(pid, alive, kill_grace_ms) {
        return;
    }
    signal_process_group(pid, libc::SIGKILL);
    wait_for_exit(pid, alive, kill_grace_ms);
}

/// One reaping pass. Records are the first proof: a recorded child whose owner
/// is dead and whose argv and start ticks still match is killed and its record
/// removed; a recorded child whose owner lives is never signalled. The second
/// proof covers records that were never written: a supervised surface whose
/// cwd or `REPO_DIR` is verification scratch, whose ancestor chain reaches PID
/// 1 again, and which no live harness process in that chain still owns is
/// killed. Everything a live lease, handoff, or worker lock protects is left
/// alone, and a doubt journals the candidate instead of signalling it.
pub fn reap_orphans(options: ReapOptions) -> ReapReport {
    let mut options = options;
    let mut report = ReapReport {
        available: cfg!(target_os = "linux"),
        ..Default::default()
    };
    if !report.available {
        return report;
    }
    let alive_box: Box<dyn Fn(u32) -> bool + Send + Sync> = match options.alive.take() {
        Some(alive) => alive,
        None => Box::new(live_process),
    };
    let alive: &dyn Fn(u32) -> bool = alive_box.as_ref();
    let dry_run = options.dry_run;
    let protected = &options.protected_pids;
    let orphan_grace_ms = options
        .orphan_grace_ms
        .unwrap_or(SUPERVISION_ORPHAN_GRACE_MS);
    let kill_grace_ms = options.kill_grace_ms.unwrap_or(SUPERVISION_KILL_GRACE_MS);

    // Read every record once; a pid recorded in two state directories is one
    // child.
    let mut records: Vec<(SupervisionRecord, PathBuf)> = Vec::new();
    let mut known: HashSet<u32> = HashSet::new();
    for scope in &options.scopes {
        for record in read_supervision_records(&scope.state_dir) {
            if !known.insert(record.pid) {
                continue;
            }
            let path = supervision_record_path(&scope.state_dir, record.pid);
            records.push((record, path));
        }
    }

    // A killed owner frees its own children on the next round, so a tree falls
    // in one pass instead of one per interval.
    let mut handled: HashSet<u32> = HashSet::new();
    for _round in 0..4 {
        let mut acted = false;
        let snapshot: Vec<(SupervisionRecord, PathBuf)> = records
            .iter()
            .filter(|(record, _)| !handled.contains(&record.pid))
            .cloned()
            .collect();
        for (record, path) in snapshot {
            let pid = record.pid;
            if handled.contains(&pid) {
                continue;
            }
            if !alive(pid) {
                if !dry_run {
                    remove_supervision_record(&path);
                    report.removed_records.push(pid);
                }
                records.retain(|entry| entry.0.pid != pid);
                handled.insert(pid);
                acted = true;
                continue;
            }
            if !matches_record(&record) {
                // The pid was recycled; the record describes a process that is gone.
                if !dry_run {
                    remove_supervision_record(&path);
                }
                records.retain(|entry| entry.0.pid != pid);
                handled.insert(pid);
                continue;
            }
            if alive(record.owner_pid) {
                touch_record(&path);
                continue;
            }
            if protected.contains(&pid) {
                touch_record(&path);
                report.decisions.push(ReapDecision {
                    action: ReapAction::Skipped,
                    pid,
                    reason: ReapReason::Record,
                    detail: "a live lease, handoff, or worker lock protects this child".to_string(),
                });
                handled.insert(pid);
                continue;
            }
            let detail = format!(
                "owner {} is gone; argv and start time match",
                record.owner_pid
            );
            if dry_run {
                report.decisions.push(ReapDecision {
                    action: ReapAction::WouldKill,
                    pid,
                    reason: ReapReason::Record,
                    detail,
                });
                handled.insert(pid);
                continue;
            }
            terminate(pid, alive, kill_grace_ms);
            remove_supervision_record(&path);
            report.decisions.push(ReapDecision {
                action: ReapAction::Killed,
                pid,
                reason: ReapReason::Record,
                detail,
            });
            report.killed.push(pid);
            records.retain(|entry| entry.0.pid != pid);
            handled.insert(pid);
            acted = true;
        }
        if !acted {
            break;
        }
    }

    let processes = options.processes.take().unwrap_or_else(process_table);
    let by_pid: HashMap<u32, ProcessSnapshot> = processes
        .iter()
        .map(|process| (process.pid, process.clone()))
        .collect();
    let recorded: HashSet<u32> = records.iter().map(|(record, _)| record.pid).collect();
    let self_pid = std::process::id();
    for candidate in &processes {
        let pid = candidate.pid;
        // The reaper's own descendants are its caller's work, never candidates.
        if pid == self_pid || candidate.ancestors.contains(&self_pid) {
            continue;
        }
        if recorded.contains(&pid) || handled.contains(&pid) {
            continue;
        }
        if !is_supervised_surface(&candidate.cmdline) {
            continue;
        }
        let scratch_dir = candidate
            .cwd
            .as_ref()
            .map(|cwd| cwd.to_string_lossy().into_owned());
        let scratch = scratch_dir.as_deref().is_some_and(is_verification_scratch)
            || candidate
                .env
                .get("REPO_DIR")
                .is_some_and(|repo_dir| is_verification_scratch(repo_dir));
        if !scratch {
            continue;
        }
        // A live harness ancestor still owns the process; only an orphan is a
        // candidate.
        if supervised_by_ancestor(candidate, &by_pid) {
            continue;
        }
        if !alive(pid) {
            continue;
        }
        if let Some(age) = process_age_ms(pid) {
            if age < orphan_grace_ms as f64 {
                continue;
            }
        }
        if protected.contains(&pid) {
            report.decisions.push(ReapDecision {
                action: ReapAction::Skipped,
                pid,
                reason: ReapReason::Scratch,
                detail: "a live lease, handoff, or worker lock protects this process".to_string(),
            });
            continue;
        }
        let detail = "no record, verification scratch, and no live harness ancestor";
        if dry_run {
            report.decisions.push(ReapDecision {
                action: ReapAction::WouldKill,
                pid,
                reason: ReapReason::Scratch,
                detail: detail.to_string(),
            });
            continue;
        }
        terminate(pid, alive, kill_grace_ms);
        report.decisions.push(ReapDecision {
            action: ReapAction::Killed,
            pid,
            reason: ReapReason::Scratch,
            detail: detail.to_string(),
        });
        report.killed.push(pid);
    }

    report
}

/// The inputs of the orphan supervisor.
pub struct OrphanSupervisorOptions<F> {
    /// One reaping pass; the caller wires this to [`reap_orphans`].
    pub reap: F,
    pub interval_ms: Option<u64>,
}

impl<F> OrphanSupervisorOptions<F> {
    pub fn new(reap: F) -> Self {
        Self {
            reap,
            interval_ms: None,
        }
    }
}

/// A running orphan supervisor; dropping it stops the interval.
pub struct OrphanSupervisor {
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl OrphanSupervisor {
    /// Stops the interval; a pass already running finishes.
    pub fn stop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

impl Drop for OrphanSupervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Runs one pass now, then one every `interval_ms`. The interval has nothing
/// to do with a watchdog cycle cadence: a leaked child is reaped even while
/// the cycle is idle.
///
/// Each pass runs on a blocking worker because a pass sleeps through its kill
/// grace. The caller must run inside a Tokio runtime.
pub fn start_orphan_supervisor<F>(options: OrphanSupervisorOptions<F>) -> OrphanSupervisor
where
    F: Fn() + Send + Sync + 'static,
{
    let interval = options
        .interval_ms
        .unwrap_or(SUPERVISION_INTERVAL_MS)
        .max(1);
    let reap = std::sync::Arc::new(options.reap);
    (*reap)();
    let task_reap = std::sync::Arc::clone(&reap);
    let handle = tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_millis(interval));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        timer.tick().await;
        loop {
            timer.tick().await;
            let reap = std::sync::Arc::clone(&task_reap);
            let _ = tokio::task::spawn_blocking(move || (*reap)()).await;
        }
    });
    OrphanSupervisor {
        handle: Some(handle),
    }
}

/// Ends every live harness descendant of `owner`: a `devboard worker`, a
/// `devboard acp-stub`, or an `omp acp` peer. The pass sends `SIGTERM`, waits
/// up to `timeout_ms`, and kills whatever still runs.
pub async fn terminate_harness_descendants(owner: u32, timeout_ms: u64) -> Vec<u32> {
    #[cfg(unix)]
    {
        let targets: Vec<u32> = process_table()
            .into_iter()
            .filter(|process| {
                process.pid != owner
                    && process.ancestors.contains(&owner)
                    && is_harness_descendant_surface(&process.cmdline)
            })
            .map(|process| process.pid)
            .collect();
        for pid in &targets {
            unsafe {
                libc::kill(*pid as libc::pid_t, libc::SIGTERM);
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        while std::time::Instant::now() < deadline && targets.iter().any(|pid| live_process(*pid)) {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        for pid in targets.iter().filter(|pid| live_process(**pid)) {
            unsafe {
                libc::kill(*pid as libc::pid_t, libc::SIGKILL);
            }
        }
        targets
    }
    #[cfg(not(unix))]
    {
        let _ = (owner, timeout_ms);
        Vec::new()
    }
}

/// True for a process the harness spawns as a child surface.
fn is_harness_descendant_surface(cmdline: &str) -> bool {
    rust_harness_command(cmdline, &["worker", "acp-stub"])
        || cmdline.contains("omp acp")
        || cmdline.contains(".devboard/server/fixtures/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("supervision-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a scratch root");
        root
    }

    fn sleeper() -> Vec<String> {
        vec![
            "sh".to_string(),
            "-c".to_string(),
            "while :; do sleep 0.2; done".to_string(),
        ]
    }

    fn scope(state: &Path, repo: &Path) -> ReapOptions {
        ReapOptions {
            scopes: vec![SupervisionScope {
                state_dir: state.to_path_buf(),
                repo_dir: repo.to_path_buf(),
            }],
            ..Default::default()
        }
    }

    fn dead_pid() -> u32 {
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .expect("a helper process");
        let pid = child.id();
        let _ = child.wait();
        assert!(!live_process(pid), "the helper must be gone");
        pid
    }

    #[test]
    fn process_stat_resumes_after_the_last_parenthesis() {
        let text =
            "42 (a ) tricky name) R 7 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 0 20 0 1 987654 0 0";
        let stat = parse_stat(42, text).expect("a stat");
        assert_eq!(stat.pid, 42);
        assert_eq!(stat.ppid, 7);
        assert_eq!(stat.pgrp, 42);
        assert_eq!(stat.start_ticks, 987_654);
        assert_eq!(stat.state, "R");
        assert!(parse_stat(42, "42 without a close parenthesis").is_none());
    }

    #[test]
    fn scratch_and_supervised_surfaces_are_recognised() {
        assert!(is_verification_scratch("/w/.devboard/.tmp/repo"));
        assert!(is_verification_scratch("C:\\w\\.devboard\\.tmp\\repo"));
        assert!(!is_verification_scratch("/w/.devboard/.test-tmp/repo"));
        assert!(is_supervised_surface(
            "/usr/bin/bun /w/.devboard/server/run-owner.ts"
        ));
        assert!(is_supervised_surface(
            "/usr/bin/bun /w/.devboard/server/goal-draft-owner.ts"
        ));
        assert!(is_supervised_surface(
            "/usr/bin/bun /w/.devboard/server/fixtures/stub-agent.ts"
        ));
        assert!(is_supervised_surface("/usr/bin/bun /w/.devboard/worker.ts"));
        assert!(is_supervised_surface(
            "/home/ds/devboard/.devboard/bin/devboard worker watchdog --repo /w"
        ));
        assert!(is_supervised_surface(
            "/home/ds/devboard/.devboard/bin/devboard worker run-owner"
        ));
        assert!(is_supervised_surface(
            "/home/ds/devboard/.devboard/bin/devboard worker goal-draft"
        ));
        assert!(is_supervised_surface(
            "/home/ds/devboard/.devboard/bin/devboard acp-stub --repo /w"
        ));
        assert!(is_supervised_surface(
            "/home/ds/devboard/.devboard/bin/devboard serve --port 8080"
        ));
        assert!(!is_supervised_surface("/usr/bin/bun /w/server/index.ts"));
        assert!(!is_supervised_surface("/usr/bin/devboard version"));
        assert!(is_harness_supervisor(
            "/home/ds/devboard/.devboard/bin/devboard serve --port 8080"
        ));
        assert!(is_harness_supervisor(
            "/home/ds/devboard/.devboard/bin/devboard worker watchdog"
        ));
        assert!(!is_harness_supervisor(
            "/home/ds/devboard/.devboard/bin/devboard acp-stub"
        ));
        assert!(is_harness_supervisor(
            "/usr/bin/bun /w/.devboard/server/index.ts"
        ));
        assert!(is_harness_supervisor(
            "/usr/bin/bun /w/.devboard/scripts/verify-live-cycle.ts"
        ));
        assert!(is_harness_supervisor("bun test"));
        assert!(is_harness_supervisor("bun.exe test --filter"));
        assert!(!is_harness_supervisor("bun run test"));
    }

    #[tokio::test]
    async fn a_spawned_child_is_recorded_and_kept_while_its_owner_lives() {
        let root = scratch("spawn");
        let state = root.join("state");
        let mut child = supervised_spawn(
            &sleeper(),
            SupervisedSpawnOptions {
                cwd: root.clone(),
                env: None,
                state_dir: Some(state.clone()),
            },
        )
        .expect("a supervised child");
        let pid = child.pid().expect("a pid");
        let path = supervision_record_path(&state, pid);
        assert!(
            path.exists(),
            "the record is written before the child is used"
        );
        let text = std::fs::read_to_string(&path).expect("a record");
        let value: Value = serde_json::from_str(&text).expect("record JSON");
        assert_eq!(value["version"], json!(1));
        assert_eq!(value["pid"], json!(pid));
        assert_eq!(value["ownerPid"], json!(std::process::id()));
        let expected_cwd = absolute(&root);
        assert_eq!(value["cwd"].as_str(), expected_cwd.to_str());
        assert_eq!(value["pgid"], json!(pid));
        assert!(value["startTicks"].as_i64().expect("ticks") > 0);
        let argv = value["argv"].as_array().expect("argv");
        assert!(argv.iter().any(|entry| entry.as_str() == Some("-c")));
        assert!(argv
            .iter()
            .any(|entry| entry.as_str().is_some_and(|text| text.contains("sleep"))));
        let started = value["startedAt"].as_str().expect("startedAt");
        assert_eq!(started.len(), 24, "milliseconds and a Z suffix");
        assert!(started.ends_with('Z'));
        let keys = [
            "\"version\"",
            "\"pid\"",
            "\"argv\"",
            "\"cwd\"",
            "\"ownerPid\"",
            "\"startedAt\"",
            "\"startTicks\"",
            "\"pgid\"",
        ];
        let mut previous = 0;
        for key in keys {
            let index = text.find(key).expect("a record key");
            assert!(index >= previous, "keys keep the TypeScript order");
            previous = index;
        }

        let report = reap_orphans(scope(&state, &root));
        assert!(report.available);
        assert!(
            report.killed.is_empty(),
            "a live child is not reaped: {:?}",
            report.decisions
        );
        assert!(report.removed_records.is_empty());
        assert!(path.exists(), "the live child keeps its record");

        child.start_kill().expect("a signal");
        let _status = child.wait().await.expect("an exit");
        assert!(!path.exists(), "the record leaves when the child exits");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_reaper_ends_a_recorded_orphan_and_removes_its_record() {
        let root = scratch("orphan");
        let state = root.join("state");
        let mut child = supervised_spawn(
            &sleeper(),
            SupervisedSpawnOptions {
                cwd: root.clone(),
                env: None,
                state_dir: Some(state.clone()),
            },
        )
        .expect("a supervised child");
        let pid = child.pid().expect("a pid");
        let path = supervision_record_path(&state, pid);
        let dead_owner = dead_pid();
        let text = std::fs::read_to_string(&path).expect("a record");
        let mut value: Value = serde_json::from_str(&text).expect("record JSON");
        value["ownerPid"] = json!(dead_owner);
        std::fs::write(&path, format!("{}\n", crate::jsjson::stringify(&value)))
            .expect("an orphan record");

        let report = reap_orphans(ReapOptions {
            kill_grace_ms: Some(200),
            ..scope(&state, &root)
        });
        assert!(report.available);
        assert_eq!(report.killed, vec![pid]);
        assert!(report.removed_records.is_empty());
        assert_eq!(report.decisions.len(), 1);
        assert_eq!(report.decisions[0].action, ReapAction::Killed);
        assert_eq!(report.decisions[0].reason, ReapReason::Record);
        assert!(report.decisions[0]
            .detail
            .contains(&format!("owner {dead_owner} is gone")));
        assert!(!path.exists(), "the record leaves with the child");
        assert!(!live_process(pid), "the child is no longer running");

        let _status = child.wait().await.expect("a reaped child");
        let _ = std::fs::remove_dir_all(&root);
    }
}
