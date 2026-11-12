//! One dashboard per host directory, and the sweep the panel icon runs.
//!
//! The guard is one `flock`ed file under `<host>/.devboard/.tmp`. The kernel
//! releases it when the serving process exits, so a killed dashboard never
//! leaves a refusal behind. Its identity is the canonical real path of the
//! repository directory: a relative path, a symlinked path, another port, and
//! another state directory all resolve to the same host directory, and a
//! dashboard for a different host stays legal.
//!
//! `devboard instances status` lists the live dashboards of one host directory
//! and `devboard instances sweep` keeps the newest one that answers `/ready`,
//! stops every other one of the same host directory, and then runs the orphan
//! reaper for that host's scopes. Nothing outside the host directory is
//! signalled.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::mcp_server::{discover_dashboards, LiveDashboard};
use crate::supervision::{live_process, supervision_directory};
use crate::workers::watchdog::process_started_at;

/// Where the guard lives under the host directory.
pub const GUARD_DIRECTORY: &str = ".devboard/.tmp";
/// The one lock file the guard holds for the process lifetime.
pub const GUARD_LOCK_FILE: &str = "dashboard-guard.lock";
/// The owner record beside the lock; it never outvotes the lock.
pub const GUARD_OWNER_FILE: &str = "dashboard-guard.json";
/// How long a start waits for an owner record to name its port.
pub const REFUSAL_WAIT_MS: u64 = 8_000;
/// How long a confirmed replacement waits for the old guard to be released.
pub const REPLACEMENT_WAIT_MS: u64 = 30_000;
/// How long an alive but silent dashboard gets to answer `/ready`.
pub const SWEEP_PROBE_GRACE_MS: u64 = 5_000;
/// The fixture escape hatch's environment name. Only a repository under a
/// harness test root honours it, so a host can never disable the guard.
pub const FIXTURE_ENV: &str = "DEVBOARD_DASHBOARD_SINGLETON_FIXTURE";

/// The canonical real path that identifies a host directory.
pub fn canonical_host_dir(repo_dir: &Path) -> PathBuf {
    match std::fs::canonicalize(repo_dir) {
        Ok(path) => path,
        Err(_) if repo_dir.is_absolute() => repo_dir.to_path_buf(),
        Err(_) => std::env::current_dir()
            .map(|cwd| cwd.join(repo_dir))
            .unwrap_or_else(|_| repo_dir.to_path_buf()),
    }
}

/// Everything the owner record carries, so a refused start can name the live
/// dashboard instead of guessing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GuardOwner {
    pub pid: u32,
    pub port: u16,
    pub repo_dir: String,
    pub state_dir: String,
    pub started_at: String,
}

impl GuardOwner {
    fn to_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "port": self.port,
            "repoDir": self.repo_dir,
            "stateDir": self.state_dir,
            "startedAt": self.started_at,
        })
    }

    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            pid: u32::try_from(value.get("pid")?.as_u64()?).ok()?,
            port: u16::try_from(value.get("port").and_then(Value::as_u64).unwrap_or(0)).ok()?,
            repo_dir: value
                .get("repoDir")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            state_dir: value
                .get("stateDir")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            started_at: value
                .get("startedAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }
}

/// The guard as one held OS lock. Dropping it closes the file and the kernel
/// releases the lock; a `SIGKILL` does the same.
#[derive(Debug)]
pub struct HostGuard {
    _file: std::fs::File,
    owner_path: PathBuf,
}

impl HostGuard {
    /// Publishes this process as the host's dashboard. The first call records
    /// the requested port, the second the bound one.
    pub fn record(&self, owner: &GuardOwner) -> std::io::Result<()> {
        let mut text = crate::jsjson::stringify(&owner.to_json());
        text.push('\n');
        crate::state::write_file_atomically_sync(&self.owner_path, &text)
    }
}

/// What taking the guard decided.
pub enum GuardAdmission {
    /// This process holds the host directory.
    Acquired(HostGuard),
    /// A live dashboard holds it; the text is the refusal message.
    Refused(String),
}

/// True when a fixture repository may run more than one dashboard. The env
/// var alone is not enough: the repository must live under a harness test
/// root, so a real host never reaches this path.
pub fn fixture_bypass(repo_dir: &Path) -> bool {
    if std::env::var(FIXTURE_ENV)
        .map(|value| value != "1")
        .unwrap_or(true)
    {
        return false;
    }
    let text = canonical_host_dir(repo_dir).to_string_lossy().into_owned();
    text.contains("/.devboard/.tmp/")
        || text.contains("/.devboard/.test-tmp/")
        || text.ends_with("/.devboard/.tmp")
        || text.ends_with("/.devboard/.test-tmp")
}

/// Takes the host guard, or reports the dashboard that already holds it.
///
/// A `replacement` start (one carrying `DEVBOARD_REPLACEMENT_READY_FILE`)
/// waits for the process it replaces to release the lock; any other start
/// refuses at once. A guard directory that cannot be created fails closed.
pub fn acquire_host_guard(
    repo_dir: &Path,
    replacement: bool,
    initial: &GuardOwner,
) -> Result<GuardAdmission> {
    let host = canonical_host_dir(repo_dir);
    let directory = host.join(GUARD_DIRECTORY);
    std::fs::create_dir_all(&directory).with_context(|| {
        format!(
            "the dashboard guard directory {} cannot be created",
            directory.display()
        )
    })?;
    let lock_path = directory.join(GUARD_LOCK_FILE);
    let owner_path = directory.join(GUARD_OWNER_FILE);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| {
            format!(
                "the dashboard guard {} cannot be opened",
                lock_path.display()
            )
        })?;
    let deadline =
        Instant::now() + Duration::from_millis(if replacement { REPLACEMENT_WAIT_MS } else { 0 });
    loop {
        match try_lock_exclusive(&file) {
            Ok(true) => {
                let guard = HostGuard {
                    _file: file,
                    owner_path,
                };
                guard.record(initial)?;
                return Ok(GuardAdmission::Acquired(guard));
            }
            Ok(false) => {
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "the dashboard guard {} cannot be locked",
                        lock_path.display()
                    )
                })
            }
        }
    }
    Ok(GuardAdmission::Refused(refusal_message(&host, &owner_path)))
}

/// One held OS lock on the guard file.
#[cfg(unix)]
fn try_lock_exclusive(file: &std::fs::File) -> std::io::Result<bool> {
    use std::os::unix::io::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN => Ok(false),
        _ => Err(error),
    }
}

/// A platform without advisory locks cannot hold the singleton here; discovery
/// still reports what is live without signalling it.
#[cfg(not(unix))]
fn try_lock_exclusive(_file: &std::fs::File) -> std::io::Result<bool> {
    Ok(true)
}

fn read_owner(path: &Path) -> Option<GuardOwner> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    GuardOwner::from_json(&value)
}

/// The live dashboard a refused start must name, polled until its port is
/// known or the wait runs out.
fn refusal_message(host: &Path, owner_path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_millis(REFUSAL_WAIT_MS);
    loop {
        // A stale record from a dashboard that already exited never names a
        // live instance; only a live owner (or discovery) does.
        let owner = read_owner(owner_path).filter(|owner| live_process(owner.pid));
        let dashboards = discover_dashboards(host);
        let named = owner.as_ref().and_then(|owner| {
            dashboards
                .iter()
                .find(|dashboard| dashboard.pid == owner.pid)
        });
        let pid = owner
            .as_ref()
            .map(|owner| owner.pid)
            .or_else(|| named.map(|dashboard| dashboard.pid))
            .or_else(|| dashboards.first().map(|dashboard| dashboard.pid));
        let port = owner
            .as_ref()
            .map(|owner| owner.port)
            .filter(|port| *port > 0)
            .or_else(|| named.map(|dashboard| dashboard.port))
            .or_else(|| dashboards.first().map(|dashboard| dashboard.port))
            .filter(|port| *port > 0);
        if pid.is_some() && port.is_some() {
            return refusal_text(host, pid, port);
        }
        if Instant::now() >= deadline {
            return refusal_text(host, pid, port);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn refusal_text(host: &Path, pid: Option<u32>, port: Option<u16>) -> String {
    format!(
        "another dashboard already serves {}: pid {} on port {}",
        host.display(),
        pid.map(|pid| pid.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        port.map(|port| port.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    )
}

// ---------------------------------------------------------------------------
// Instance status
// ---------------------------------------------------------------------------

/// One live dashboard for the host directory, as the command reports it.
#[derive(Clone, Debug)]
pub struct InstanceStatus {
    pub pid: u32,
    pub port: u16,
    pub ready: bool,
    pub repo_dir: String,
}

impl InstanceStatus {
    fn to_json(&self) -> Value {
        json!({
            "pid": self.pid,
            "port": self.port,
            "ready": self.ready,
            "repoDir": self.repo_dir,
        })
    }
}

/// Every live dashboard serving exactly this host directory, ordered by pid.
pub async fn instance_status(repo_dir: &Path) -> Vec<InstanceStatus> {
    let host = canonical_host_dir(repo_dir);
    let mut dashboards = discover_dashboards(&host);
    dashboards.sort_by_key(|dashboard| dashboard.pid);
    let probes = dashboards.iter().map(|dashboard| {
        let dashboard = dashboard.clone();
        async move {
            let ready = dashboard.port > 0
                && crate::relaunch::probe_ready(dashboard.port, Some(dashboard.pid)).await;
            InstanceStatus {
                pid: dashboard.pid,
                port: dashboard.port,
                ready,
                repo_dir: dashboard.repo_dir,
            }
        }
    });
    futures_util::future::join_all(probes).await
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/// What one sweep kept and stopped.
#[derive(Clone, Debug, Default)]
pub struct SweepReport {
    pub available: bool,
    pub kept_pid: Option<u32>,
    pub kept_port: Option<u16>,
    pub stopped_pids: Vec<u32>,
    pub hung_pids: Vec<u32>,
    pub protected_pids: Vec<u32>,
    pub remaining_pids: Vec<u32>,
}

impl SweepReport {
    fn to_json(&self) -> Value {
        json!({
            "available": self.available,
            "keptPid": self.kept_pid,
            "keptPort": self.kept_port,
            "stoppedPids": self.stopped_pids,
            "hungPids": self.hung_pids,
            "protectedPids": self.protected_pids,
            "remainingPids": self.remaining_pids,
        })
    }
}

/// Keeps the newest dashboard that answers `/ready`, stops every other
/// dashboard of this host directory, and reaps this host's orphaned children.
pub async fn sweep_host_dir(repo_dir: &Path, state_dir: &Path) -> SweepReport {
    let host = canonical_host_dir(repo_dir);
    let started = Instant::now();
    let mut dashboards = discover_dashboards(&host);
    dashboards.sort_by_key(|dashboard| dashboard.pid);

    let mut protected_pids = Vec::new();
    dashboards.retain(|dashboard| {
        if dashboard.pid == std::process::id() {
            return false;
        }
        if protected_fixture(dashboard) {
            protected_pids.push(dashboard.pid);
            return false;
        }
        true
    });
    protected_pids.sort_unstable();

    let mut ready: HashSet<u32> = HashSet::new();
    let probes = dashboards.iter().map(|dashboard| {
        let dashboard = dashboard.clone();
        async move {
            let ok = dashboard.port > 0
                && crate::relaunch::probe_ready(dashboard.port, Some(dashboard.pid)).await;
            (dashboard.pid, ok)
        }
    });
    for (pid, ok) in futures_util::future::join_all(probes).await {
        if ok {
            ready.insert(pid);
        }
    }

    // An alive dashboard that has not answered yet gets the whole grace to
    // finish starting. Only after it is declared silent is it signalled.
    if dashboards
        .iter()
        .any(|dashboard| !ready.contains(&dashboard.pid))
    {
        let deadline = started + Duration::from_millis(SWEEP_PROBE_GRACE_MS);
        let now = Instant::now();
        if now < deadline {
            tokio::time::sleep(deadline - now).await;
        }
        let retries = dashboards
            .iter()
            .filter(|dashboard| !ready.contains(&dashboard.pid))
            .map(|dashboard| {
                let dashboard = dashboard.clone();
                async move {
                    let ok = dashboard.port > 0
                        && crate::relaunch::probe_ready(dashboard.port, Some(dashboard.pid)).await;
                    (dashboard.pid, ok)
                }
            });
        for (pid, ok) in futures_util::future::join_all(retries).await {
            if ok {
                ready.insert(pid);
            }
        }
    }

    let keeper = newest_ready(&dashboards, &ready);
    let hung_pids: Vec<u32> = dashboards
        .iter()
        .filter(|dashboard| !ready.contains(&dashboard.pid))
        .map(|dashboard| dashboard.pid)
        .collect();

    let mut stops: Vec<u32> = dashboards
        .iter()
        .filter(|dashboard| Some(dashboard.pid) != keeper)
        .filter(|dashboard| live_process(dashboard.pid))
        .map(|dashboard| dashboard.pid)
        .collect();
    stops.sort_unstable();
    stops.dedup();

    signal_and_wait(&stops);

    let remaining = discover_dashboards(&host)
        .into_iter()
        .filter(|dashboard| dashboard.pid != std::process::id())
        .filter(|dashboard| Some(dashboard.pid) != keeper)
        .filter(|dashboard| !protected_pids.contains(&dashboard.pid))
        .filter(|dashboard| live_process(dashboard.pid))
        .map(|dashboard| dashboard.pid)
        .collect::<Vec<u32>>();

    let mut options = crate::workers::watchdog::OrphanReaperRunOptions::new(&host);
    options.state_dir = Some(state_dir.to_path_buf());
    let reap = crate::workers::watchdog::run_orphan_reaper(options);

    let kept_port = keeper.and_then(|pid| {
        dashboards
            .iter()
            .find(|dashboard| dashboard.pid == pid)
            .map(|dashboard| dashboard.port)
    });
    let report = SweepReport {
        available: reap.available,
        kept_pid: keeper,
        kept_port,
        stopped_pids: stops,
        hung_pids,
        protected_pids,
        remaining_pids: remaining,
    };
    log_sweep_pass(state_dir, &report, reap.decisions.len(), reap.killed.len());
    report
}

/// The newest ready dashboard by kernel start time; a ready dashboard with no
/// readable start time counts as the oldest.
fn newest_ready(dashboards: &[LiveDashboard], ready: &HashSet<u32>) -> Option<u32> {
    dashboards
        .iter()
        .filter(|dashboard| ready.contains(&dashboard.pid))
        .max_by_key(|dashboard| {
            (
                process_started_at(dashboard.pid).unwrap_or(0),
                dashboard.pid,
            )
        })
        .map(|dashboard| dashboard.pid)
}

/// A dashboard that is a verification fixture is never signalled unless the
/// fixture itself asked to be discovered.
fn protected_fixture(dashboard: &LiveDashboard) -> bool {
    let Some(snapshot) = crate::supervision::process_snapshot(dashboard.pid) else {
        return true;
    };
    if snapshot
        .env
        .get(crate::workers::watchdog::WATCHDOG_FIXTURE_ENV)
        .map(String::as_str)
        == Some("1")
    {
        return false;
    }
    crate::workers::watchdog::is_verification_fixture(&dashboard.repo_dir, &snapshot.env)
}

/// `SIGTERM`, the existing kill grace, then `SIGKILL` for what is still alive.
fn signal_and_wait(pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    #[cfg(unix)]
    {
        for pid in pids {
            unsafe {
                libc::kill(*pid as libc::pid_t, libc::SIGTERM);
            }
        }
        let deadline =
            Instant::now() + Duration::from_millis(crate::supervision::SUPERVISION_KILL_GRACE_MS);
        while Instant::now() < deadline && pids.iter().any(|pid| live_process(*pid)) {
            std::thread::sleep(Duration::from_millis(50));
        }
        for pid in pids.iter().filter(|pid| live_process(**pid)) {
            unsafe {
                libc::kill(*pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pids;
    }
}

/// One durable pass line under the host's state directory: what was kept and
/// what was stopped.
fn log_sweep_pass(state_dir: &Path, report: &SweepReport, decisions: usize, killed: usize) {
    use std::io::Write as _;
    let directory = supervision_directory(state_dir);
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let text = crate::jsjson::stringify(&json!({
        "ts": crate::workers::watchdog::now_iso(),
        "pass": "sweep",
        "available": report.available,
        "keptPid": report.kept_pid,
        "keptPort": report.kept_port,
        "stoppedPids": report.stopped_pids,
        "hungPids": report.hung_pids,
        "protectedPids": report.protected_pids,
        "remainingPids": report.remaining_pids,
        "decisions": decisions,
        "killed": killed,
    }));
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("reaped.jsonl"))
    {
        let _ = file.write_all(format!("{text}\n").as_bytes());
    }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/// `devboard instances <status|sweep> --repo-dir <dir> [--state-dir <dir>]
/// [--json]`.
pub async fn command(args: &[String]) -> Result<()> {
    let subcommand = args
        .first()
        .map(String::as_str)
        .unwrap_or("status")
        .to_string();
    if subcommand != "status" && subcommand != "sweep" {
        anyhow::bail!("unknown instances command {subcommand}; expected status or sweep");
    }
    let json_output = args.iter().any(|argument| argument == "--json");
    let repo_dir = option_path(args, "repo-dir")
        .or_else(|| std::env::var("REPO_DIR").ok().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let host = canonical_host_dir(&repo_dir);
    let state_dir = option_path(args, "state-dir").unwrap_or_else(|| host.join(".devboard/.tmp"));

    if subcommand == "status" {
        let entries = instance_status(&host).await;
        if json_output {
            let values: Vec<Value> = entries.iter().map(InstanceStatus::to_json).collect();
            println!("{}", serde_json::to_string(&values)?);
        } else if entries.is_empty() {
            println!("no dashboard serves {}", host.display());
        } else {
            for entry in &entries {
                println!(
                    "{}\t{}\t{}\t{}",
                    entry.pid,
                    entry.port,
                    if entry.ready { "ready" } else { "silent" },
                    entry.repo_dir
                );
            }
        }
        return Ok(());
    }

    let report = sweep_host_dir(&host, &state_dir).await;
    println!("{}", serde_json::to_string(&report.to_json())?);
    if !report.remaining_pids.is_empty() {
        anyhow::bail!(
            "stray dashboards still serve {}: {}",
            host.display(),
            report
                .remaining_pids
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(())
}

/// One `--name value` or `--name=value` path option.
fn option_path(args: &[String], name: &str) -> Option<PathBuf> {
    let flag = format!("--{name}");
    let prefix = format!("--{name}=");
    let mut index = 0;
    while index < args.len() {
        if let Some(value) = args[index].strip_prefix(&prefix) {
            return Some(PathBuf::from(value));
        }
        if args[index] == flag {
            return args.get(index + 1).map(PathBuf::from);
        }
        index += 1;
    }
    None
}
