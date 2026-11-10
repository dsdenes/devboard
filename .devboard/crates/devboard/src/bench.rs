//! Benchmarks: REST read latency, and the idle CPU and state-file I/O one
//! dashboard and its family workers spend.
//!
//! `bench cpu` builds a scratch host under `<harness>/.test-tmp`, starts a
//! scratch `devboard serve --port 0`, drives one scenario, and prints the
//! dashboard's and the workers' CPU and read bytes per second. Nothing it
//! touches is the operator's state directory, and every process it starts is
//! ended before the command returns.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// The families whose worker takes a `--sync` cadence. The others own their
/// cadence in their settings file and refuse an unknown flag.
const SYNCED_FAMILIES: [&str; 6] = [
    "scout",
    "design",
    "dead-code",
    "api-standards",
    "single-responsibility",
    "consistent-naming",
];

/// How long a scenario warms up before its measurement window opens. The
/// warmup lets every worker finish its start and its first due pass, so the
/// window measures the idle steady state the criterion names.
const WARMUP: Duration = Duration::from_secs(45);
/// The default measurement window. Warmup and window together stay under the
/// watchdog's 30 s supervision sweep and a minute boundary, and the warmup
/// outlasts a family's transient forge-read backoff, so the window measures
/// idle work rather than a start, a retry, or one machine-wide `/proc` scan.
const DEFAULT_SECONDS: u64 = 10;

/// Measures round-trip latency for one named read operation and returns the
/// summary, naming the HTTP method and path it measured.
pub async fn measure(port: u16, iterations: u64, command: &str) -> anyhow::Result<Value> {
    let (method, path, _body) =
        crate::rest::request_for_command(&json!({"type": command})).map_err(anyhow::Error::msg)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .build()?;
    let url = format!("http://127.0.0.1:{port}{path}");
    let mut samples: Vec<f64> = Vec::with_capacity(iterations as usize);
    for _ in 0..iterations {
        let started = Instant::now();
        let response = client
            .request(method.clone(), &url)
            .header("accept", "application/json")
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!(
                "{} {} answered HTTP {}",
                method.as_str(),
                path,
                response.status().as_u16()
            );
        }
        let _ = response.bytes().await?;
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    Ok(json!({
        "command": command,
        "method": method.as_str(),
        "path": path,
        "iterations": iterations,
        "p50Ms": percentile(&samples, 50.0),
        "p95Ms": percentile(&samples, 95.0),
    }))
}

fn percentile(samples: &[f64], percentile: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let index = ((percentile / 100.0) * (samples.len() as f64 - 1.0)).round() as usize;
    samples[index.min(samples.len() - 1)]
}

/// One `bench cpu` invocation.
pub struct CpuOptions {
    pub scenario: String,
    /// The measurement window. Zero asks for [`DEFAULT_SECONDS`].
    pub seconds: u64,
}

/// Runs one CPU and I/O scenario and returns its measurements.
pub async fn cpu(options: &CpuOptions) -> anyhow::Result<Value> {
    let scenario = options.scenario.as_str();
    if scenario != "runs-view" && scenario != "all-workers" {
        anyhow::bail!("unknown bench scenario {scenario}; expected runs-view or all-workers");
    }
    let seconds = if options.seconds == 0 {
        DEFAULT_SECONDS
    } else {
        options.seconds
    };
    let root = scratch(scenario)?;
    let repo = root.join("repo");
    let state = root.join("state");
    fixture(&repo)?;
    std::fs::create_dir_all(&state)?;
    if scenario == "runs-view" {
        seed_runs(&repo, &state)?;
    }

    let dashboard = Scratch::start(&repo, &state, &root.join("dashboard.log"))?;
    let base = format!("http://127.0.0.1:{}", dashboard.port);
    wait_ready(&base, Duration::from_secs(30)).await?;
    if scenario == "runs-view" {
        runs_view::open(base.clone(), dashboard.port);
    }
    let workers = if scenario == "all-workers" {
        start_workers(&repo, &state, &root)?
    } else {
        Vec::new()
    };

    tokio::time::sleep(WARMUP).await;
    for worker in &workers {
        worker.require_live()?;
    }

    let mut baseline: Vec<ProcSample> = vec![dashboard.sample()?];
    for worker in &workers {
        baseline.push(worker.sample()?);
    }
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    let after: Vec<ProcSample> = {
        let mut samples = vec![dashboard.sample()?];
        for worker in &workers {
            samples.push(worker.sample()?);
        }
        samples
    };
    for worker in &workers {
        worker.require_live()?;
    }
    let elapsed = seconds as f64;
    let dashboard_sample = delta(&baseline[0], &after[0], elapsed);
    let mut worker_rows = Vec::new();
    let mut worker_cpu = 0.0;
    let mut worker_reads = 0.0;
    for (index, worker) in workers.iter().enumerate() {
        let sample = delta(&baseline[index + 1], &after[index + 1], elapsed);
        worker_cpu += sample.cpu_percent;
        worker_reads += sample.read_bytes_per_second;
        worker_rows.push(json!({
            "family": worker.family,
            "pid": worker.child.id(),
            "cpuPercent": sample.cpu_percent,
            "readBytesPerSecond": sample.read_bytes_per_second,
        }));
    }
    let is_runs_view = scenario == "runs-view";
    Ok(json!({
        "scenario": scenario,
        "seconds": seconds,
        "scratch": root.display().to_string(),
        "dashboard": {
            "pid": dashboard.child.id(),
            "cpuPercent": dashboard_sample.cpu_percent,
            "readBytesPerSecond": dashboard_sample.read_bytes_per_second,
        },
        "workers": worker_rows,
        "cpuPercent": if is_runs_view { dashboard_sample.cpu_percent } else { worker_cpu },
        "readBytesPerSecond": if is_runs_view {
            dashboard_sample.read_bytes_per_second
        } else {
            worker_reads
        },
    }))
}

/// The harness directory a working directory belongs to.
///
/// The harness is the nearest ancestor named `.devboard` — a working directory
/// that is itself a harness root resolves to itself — or the `.devboard`
/// directory of the nearest ancestor that holds one. The walk never descends,
/// so a stray `<harness>/.devboard` cannot become the harness, and
/// `<harness>/crates/devboard` resolves to the harness rather than to the crate
/// directory. A directory with no harness above it is an error, never a
/// scratch location where the working directory happens to be.
fn harness_root(cwd: &Path) -> anyhow::Result<PathBuf> {
    for ancestor in cwd.ancestors() {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some(".devboard") {
            return Ok(ancestor.to_path_buf());
        }
        let harness = ancestor.join(".devboard");
        if harness.is_dir() {
            return Ok(harness);
        }
    }
    anyhow::bail!(
        "no .devboard harness directory at or above {}",
        cwd.display()
    )
}

/// The harness directory's scratch root: always `<harness>/.test-tmp`, so a
/// benchmark run never writes scratch state inside the harness tree itself.
fn scratch_root(cwd: &Path) -> anyhow::Result<PathBuf> {
    Ok(harness_root(cwd)?.join(".test-tmp"))
}

fn scratch(label: &str) -> anyhow::Result<PathBuf> {
    let cwd = std::env::current_dir()?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let root =
        scratch_root(&cwd)?.join(format!("bench-cpu-{label}-{}-{nanos}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    Ok(root)
}

fn write(path: &Path, text: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, text)?;
    Ok(())
}

/// A scratch host every background family accepts: a checkout with an origin
/// and a harness directory, a goal file, and an ADR directory.
fn fixture(repo: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(repo.join(".devboard/prompts"))?;
    std::fs::create_dir_all(repo.join("adrs"))?;
    write(&repo.join("README.md"), "# Bench fixture\n")?;
    write(&repo.join("GOAL.md"), "# Bench goal\n")?;
    write(
        &repo.join("src/order.ts"),
        "export function orderTotal(): number {\n  return 0;\n}\n",
    )?;
    for name in [
        "discover-sheet.md",
        "discover-contribution.md",
        "discover-testing-strategy.md",
        "discover-naming-conventions.md",
        "discover-coding-conventions.md",
        "discover-architecture-boundaries.md",
        "discover-glossary.md",
    ] {
        write(
            &repo.join(".devboard/prompts").join(name),
            "Fixture prompt.\n",
        )?;
    }
    let mut git = Command::new("git");
    git.arg("init")
        .arg("--quiet")
        .arg("--initial-branch=main")
        .arg(repo);
    git.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = git.status();
    let mut remote = Command::new("git");
    remote
        .arg("-C")
        .arg(repo)
        .args(["remote", "add", "origin"])
        .arg("http://127.0.0.1:1/devboard-fixture/fixture.git");
    remote
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = remote.status();
    Ok(())
}

/// One run record's status and recorded worker pid.
fn seed_run(
    directory: &Path,
    id: &str,
    status: &str,
    worker_pid: u32,
    activity: usize,
) -> anyhow::Result<()> {
    let record = json!({
        "version": 1,
        "runId": id,
        "repo": "fixture",
        "status": status,
        "workerPid": worker_pid,
        "startedAt": "2026-11-10T00:00:00.000Z",
        "finishedAt": if status == "running" { Value::Null } else { json!("2026-11-10T00:05:00.000Z") },
        "harnessVersion": "1.0.0",
    });
    write(
        &directory.join("run.json"),
        &format!("{}\n", crate::jsjson::stringify(&record)),
    )?;
    let lines: Vec<String> = (0..activity)
        .map(|index| format!("worker line {index}"))
        .collect();
    write(
        &directory.join("activity.json"),
        &format!("{}\n", crate::jsjson::stringify(&json!(lines))),
    )?;
    Ok(())
}

/// The collection one Runs view reads: finished records, orphaned `running`
/// records whose worker died, and exactly one live run.
fn seed_runs(repo: &Path, state: &Path) -> anyhow::Result<()> {
    let runs = state
        .join("issues")
        .join(crate::journal::journal_key(repo))
        .join("runs");
    std::fs::create_dir_all(&runs)?;
    for index in 0..150 {
        let status = match index % 3 {
            0 => "succeeded",
            1 => "stopped",
            _ => "failed",
        };
        seed_run(
            &runs.join(format!("2026-11-0{}T00-00-{index:02}Z", 1 + index % 9)),
            &format!("finished-{index}"),
            status,
            999_999,
            8,
        )?;
    }
    for index in 0..50 {
        seed_run(
            &runs.join(format!("2026-11-0{}T01-00-{index:02}Z", 1 + index % 9)),
            &format!("orphan-{index}"),
            "running",
            999_998,
            8,
        )?;
    }
    seed_run(
        &runs.join("2026-11-10T02-00-00Z"),
        "live-run",
        "running",
        std::process::id(),
        8,
    )?;
    Ok(())
}

/// One scratch dashboard.
struct Scratch {
    child: Child,
    port: u16,
}

impl Scratch {
    fn start(repo: &Path, state: &Path, log: &Path) -> anyhow::Result<Self> {
        let binary = std::env::current_exe()?;
        let output = std::fs::File::create(log)?;
        let child = Command::new(&binary)
            .arg("serve")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("HOST", "127.0.0.1")
            .env("PORT", "0")
            .env("ADRS_DIR", repo.join("adrs"))
            .env("REPO_DIR", repo)
            .env("GOAL_FILE", repo.join("GOAL.md"))
            .env("STATE_DIR", state)
            .env("AGENT_COMMAND", "true")
            .env("DEVBOARD_UPDATE_INTERVAL_MS", "3600000")
            .env("DEVBOARD_SOURCE_REFRESH_INTERVAL_MS", "3600000")
            .env("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1")
            .stdin(Stdio::null())
            .stdout(Stdio::from(output.try_clone()?))
            .stderr(Stdio::from(output))
            .spawn()?;
        let port = read_port(log, Duration::from_secs(30))?;
        Ok(Self { child, port })
    }

    fn sample(&self) -> anyhow::Result<ProcSample> {
        sample_proc(self.child.id())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One directly started family worker.
struct WorkerProcess {
    family: &'static str,
    child: Child,
}

impl WorkerProcess {
    fn sample(&self) -> anyhow::Result<ProcSample> {
        sample_proc(self.child.id())
    }

    /// Fails the measurement when a family exited before its window.
    fn require_live(&self) -> anyhow::Result<()> {
        let state = proc_state(self.child.id())?;
        if matches!(state.as_deref(), None | Some("Z") | Some("X")) {
            anyhow::bail!(
                "the {} worker exited before its measurement window",
                self.family
            );
        }
        Ok(())
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_workers(repo: &Path, state: &Path, root: &Path) -> anyhow::Result<Vec<WorkerProcess>> {
    let binary = std::env::current_exe()?;
    let watchdog = repo.join(".devboard/.tmp/watchdog");
    seed_idle_watchdog(&watchdog)?;
    let mut workers = Vec::new();
    for family in crate::workers::FAMILIES {
        let log = std::fs::File::create(root.join(format!("worker-{family}.log")))?;
        let mut command = Command::new(&binary);
        command
            .args(["worker", family, "--repo"])
            .arg(repo)
            .arg("--state-dir")
            .arg(if family == "watchdog" {
                &watchdog
            } else {
                state
            });
        if family == "watchdog" {
            command.arg("--owner-state-dir").arg(state);
        }
        if SYNCED_FAMILIES.contains(&family) {
            // The measurement window is the idle steady state: the family's
            // next due sync is an hour out, so the window holds no due work.
            command.args(["--sync", "3600000"]);
        }
        let child = command
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("REPO_DIR", repo)
            .env("STATE_DIR", state)
            .env("ADRS_DIR", repo.join("adrs"))
            .env("GOAL_FILE", repo.join("GOAL.md"))
            .env("AGENT_COMMAND", "true")
            .env("DESIGN_CADENCE_MS", "3600000")
            .env("DEAD_CODE_CADENCE_MS", "3600000")
            .env("SINGLE_RESPONSIBILITY_CADENCE_MS", "3600000")
            .env("CONSISTENT_NAMING_CADENCE_MS", "3600000")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()?;
        workers.push(WorkerProcess { family, child });
    }
    Ok(workers)
}

/// A watchdog that is idle from its first tick: the previous run is now and
/// its next is an hour out, so the window holds no due cycle.
fn seed_idle_watchdog(directory: &Path) -> anyhow::Result<()> {
    write(
        &directory.join("settings.json"),
        &format!(
            "{}\n",
            crate::jsjson::stringify(&json!({
                "intervalMinutes": 60,
                "maxPerHour": 10,
                "maxPending": 5,
            }))
        ),
    )?;
    let now = time::OffsetDateTime::now_utc();
    let later = now + time::Duration::hours(1);
    let format = time::format_description::well_known::Rfc3339;
    let format_now = || now.format(&format).unwrap_or_default();
    let worker = json!({
        "version": 1,
        "pid": std::process::id(),
        "startedAt": format_now(),
        "root": directory.parent().map(|path| path.display().to_string()).unwrap_or_default(),
        "stateDir": directory.display().to_string(),
        "lifecycle": "idle",
        "enabled": true,
        "harnessVersion": "bench",
        "argv": [],
        "lastRunAt": format_now(),
        "nextRunAt": later.format(&format).unwrap_or_default(),
        "lastError": null,
        "notice": null,
        "updatedAt": format_now(),
    });
    write(
        &directory.join("workers").join("bench").join("worker.json"),
        &format!("{}\n", crate::jsjson::stringify(&worker)),
    )?;
    Ok(())
}

fn read_port(log: &Path, timeout: Duration) -> anyhow::Result<u16> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(text) = std::fs::read_to_string(log) {
            if let Some(index) = text.rfind("127.0.0.1:") {
                let rest = &text[index + "127.0.0.1:".len()..];
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                if let Ok(port) = digits.parse::<u16>() {
                    return Ok(port);
                }
            }
        }
        if Instant::now() >= deadline {
            anyhow::bail!("the scratch dashboard never reported its port");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

async fn wait_ready(base: &str, timeout: Duration) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + timeout;
    loop {
        let ready = client
            .get(format!("{base}/ready"))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);
        if ready {
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!("the scratch dashboard never became ready");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The one Runs view: the collection poll and one reconciled socket per live
/// run.
mod runs_view {
    use std::collections::{HashMap, HashSet};

    use futures_util::StreamExt;
    use tokio::task::JoinHandle;

    use super::*;

    /// Opens the page's two reads: a conditional `/agent-runs` poll every
    /// second, and the output socket each live run keeps.
    pub fn open(base: String, port: u16) {
        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let mut etag: Option<String> = None;
            let mut view = LiveSockets::default();
            loop {
                let mut request = client
                    .get(format!("{base}/agent-runs"))
                    .header("accept", "application/json");
                if let Some(etag) = etag.as_deref() {
                    request = request.header("if-none-match", etag);
                }
                if let Ok(response) = request.send().await {
                    if let Some(value) = response
                        .headers()
                        .get("etag")
                        .and_then(|value| value.to_str().ok())
                    {
                        etag = Some(value.to_string());
                    }
                    let status = response.status();
                    let body = response.bytes().await.ok();
                    if status.is_success() {
                        if let Some(body) = body {
                            view.reconcile(&body, |id, cursor| spawn_socket(port, id, cursor))
                                .await;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    /// The sockets this view holds, keyed by run id.
    ///
    /// One socket exists per live run the poll sees: the first poll that sees
    /// a run opens it, a run that leaves the live set has its socket aborted,
    /// and a socket whose own read ended is the only one reopened, at its last
    /// cursor. Spawning a socket on every poll instead left the scratch
    /// dashboard serving one socket per elapsed second for the same run.
    #[derive(Default)]
    struct LiveSockets {
        sockets: HashMap<String, JoinHandle<Option<u64>>>,
        cursors: HashMap<String, u64>,
    }

    impl LiveSockets {
        /// Reconciles this view with one `/agent-runs` body, the way the page
        /// does: open a socket only for a live run that has none, abort the
        /// socket of a run that left the live set, and reopen a run whose
        /// socket ended with `after=<cursor>`.
        async fn reconcile(
            &mut self,
            body: &[u8],
            mut spawn: impl FnMut(&str, Option<u64>) -> JoinHandle<Option<u64>>,
        ) {
            let live: HashSet<String> = live_ids(body).into_iter().collect();
            let absent: Vec<String> = self
                .sockets
                .keys()
                .filter(|id| !live.contains(*id))
                .cloned()
                .collect();
            for id in absent {
                if let Some(socket) = self.sockets.remove(&id) {
                    socket.abort();
                }
                self.cursors.remove(&id);
            }
            let ended: Vec<String> = self
                .sockets
                .iter()
                .filter(|(_id, socket)| socket.is_finished())
                .map(|(id, _socket)| id.clone())
                .collect();
            for id in ended {
                if let Some(socket) = self.sockets.remove(&id) {
                    if let Ok(Some(cursor)) = socket.await {
                        self.cursors.insert(id, cursor);
                    }
                }
            }
            for id in live {
                if self.sockets.contains_key(&id) {
                    continue;
                }
                let cursor = self.cursors.get(&id).copied();
                self.sockets.insert(id.clone(), spawn(&id, cursor));
            }
        }
    }

    /// The ids of the live runs one `/agent-runs` body names.
    fn live_ids(body: &[u8]) -> Vec<String> {
        let Ok(value) = serde_json::from_slice::<Value>(body) else {
            return Vec::new();
        };
        value
            .get("runs")
            .and_then(Value::as_array)
            .map(|runs| {
                runs.iter()
                    .filter(|run| run.get("live").and_then(Value::as_bool) == Some(true))
                    .filter_map(|run| run.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Opens one run's output socket at its last cursor and follows it,
    /// returning that cursor so a socket that ends reconnects with `after`.
    fn spawn_socket(port: u16, id: &str, cursor: Option<u64>) -> JoinHandle<Option<u64>> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let id = id.to_string();
        tokio::spawn(async move {
            let after = cursor
                .map(|cursor| format!("?after={cursor}"))
                .unwrap_or_default();
            let Ok(request) = format!("ws://127.0.0.1:{port}/agent-runs/{id}/output{after}")
                .into_client_request()
            else {
                return cursor;
            };
            let Ok((socket, _)) = tokio_tungstenite::connect_async(request).await else {
                return cursor;
            };
            let (_write, mut read) = socket.split();
            let mut cursor = cursor;
            while let Some(Ok(message)) = read.next().await {
                let Ok(text) = message.into_text() else {
                    continue;
                };
                if let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) {
                    if let Some(next) = frame.get("cursor").and_then(Value::as_u64) {
                        cursor = Some(next);
                    }
                }
            }
            cursor
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const ONE_LIVE: &[u8] = br#"{"runs":[{"id":"run-1","live":true}]}"#;
        const NONE_LIVE: &[u8] = br#"{"runs":[{"id":"run-1","live":false}]}"#;

        fn note(
            opens: &mut Vec<(String, Option<u64>)>,
            id: &str,
            cursor: Option<u64>,
        ) -> JoinHandle<Option<u64>> {
            opens.push((id.to_string(), cursor));
            tokio::spawn(std::future::pending::<Option<u64>>())
        }

        async fn settle(socket: &tokio::task::AbortHandle) {
            for _ in 0..10 {
                if socket.is_finished() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        }

        /// The same body twice keeps one socket, and a run that left the live
        /// set loses its socket.
        #[tokio::test]
        async fn reconcile_holds_one_socket_per_live_run() {
            let mut view = LiveSockets::default();
            let mut opens = Vec::new();
            view.reconcile(ONE_LIVE, |id, cursor| note(&mut opens, id, cursor))
                .await;
            view.reconcile(ONE_LIVE, |id, cursor| note(&mut opens, id, cursor))
                .await;
            assert_eq!(opens, vec![("run-1".to_string(), None)]);
            assert_eq!(view.sockets.len(), 1);
            let socket = view
                .sockets
                .get("run-1")
                .expect("the live run's socket")
                .abort_handle();
            assert!(!socket.is_finished());
            view.reconcile(NONE_LIVE, |id, cursor| note(&mut opens, id, cursor))
                .await;
            assert!(view.sockets.is_empty());
            settle(&socket).await;
            assert!(socket.is_finished());
        }

        /// A socket that ended reopens once at the cursor it reported.
        #[tokio::test]
        async fn a_closed_socket_reopens_at_its_cursor() {
            let mut view = LiveSockets::default();
            let mut opens = Vec::new();
            let socket = tokio::spawn(async { Some(7u64) });
            view.sockets.insert("run-1".to_string(), socket);
            settle(&view.sockets["run-1"].abort_handle()).await;
            view.reconcile(ONE_LIVE, |id, cursor| note(&mut opens, id, cursor))
                .await;
            assert_eq!(
                opens,
                vec![("run-1".to_string(), Some(7))],
                "a closed socket reconnects with after"
            );
            assert_eq!(view.sockets.len(), 1);
        }
    }
}

/// One process sample: rchar and the user plus system CPU ticks.
#[derive(Clone, Copy)]
struct ProcSample {
    pid: u32,
    rchar: u64,
    ticks: u64,
}

struct Delta {
    cpu_percent: f64,
    read_bytes_per_second: f64,
}

fn sample_proc(pid: u32) -> anyhow::Result<ProcSample> {
    let io = std::fs::read_to_string(format!("/proc/{pid}/io"))?;
    let rchar = field(&io, "rchar:").unwrap_or(0);
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let ticks = stat_ticks(&stat).unwrap_or(0);
    Ok(ProcSample { pid, rchar, ticks })
}

fn field(text: &str, name: &str) -> Option<u64> {
    text.lines()
        .find_map(|line| line.strip_prefix(name))
        .and_then(|value| value.trim().parse().ok())
}

/// The CPU ticks a `/proc/<pid>/stat` line reports, after the parenthesized
/// command name (which may itself contain spaces).
fn stat_ticks(stat: &str) -> Option<u64> {
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // utime and stime are fields 14 and 15 of the whole line: 11 and 12
    // after the command name.
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some(utime + stime)
}

fn proc_state(pid: u32) -> anyhow::Result<Option<String>> {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return Ok(None);
    };
    let close = stat
        .rfind(')')
        .ok_or_else(|| anyhow::anyhow!("a stat line"))?;
    Ok(stat[close + 1..]
        .split_whitespace()
        .next()
        .map(str::to_string))
}

fn delta(before: &ProcSample, after: &ProcSample, seconds: f64) -> Delta {
    let _ = (before.pid, after.pid);
    let ticks = after.ticks.saturating_sub(before.ticks) as f64;
    let bytes = after.rchar.saturating_sub(before.rchar) as f64;
    Delta {
        // One clock tick is ten milliseconds: a full core spends 100 ticks a
        // second, so ticks per second is the percentage of one core.
        cpu_percent: round2(ticks / seconds),
        read_bytes_per_second: round2(bytes / seconds),
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Writes the report to stdout: JSON when asked, one line per figure when not.
pub fn print(result: &Value, json: bool) {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(result).unwrap_or_default()
        );
        return;
    }
    let mut out = std::io::stdout();
    let _ = writeln!(
        out,
        "{}: cpu {:.2}%  reads {:.0} B/s",
        result["scenario"].as_str().unwrap_or("scenario"),
        result["cpuPercent"].as_f64().unwrap_or(0.0),
        result["readBytesPerSecond"].as_f64().unwrap_or(0.0),
    );
    if let Some(workers) = result["workers"].as_array() {
        for worker in workers {
            let _ = writeln!(
                out,
                "  {}: cpu {:.2}%  reads {:.0} B/s",
                worker["family"].as_str().unwrap_or("?"),
                worker["cpuPercent"].as_f64().unwrap_or(0.0),
                worker["readBytesPerSecond"].as_f64().unwrap_or(0.0),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// A fixture checkout under the ignored scratch root: a repository holding
    /// a harness directory, and the crate directory inside that harness.
    fn fixture(name: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.test-tmp")
            .join(format!("bench-scratch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("repo/.devboard/crates/devboard"))
            .expect("a fixture harness");
        root
    }

    #[test]
    fn a_working_directory_resolves_to_the_harness_scratch_root() {
        let root = fixture("resolve");
        let repo = root.join("repo");
        let harness = repo.join(".devboard");
        let crate_dir = harness.join("crates/devboard");
        // The leaked `<harness>/.devboard` tree this resolver must never
        // descend into.
        std::fs::create_dir_all(harness.join(".devboard/.test-tmp")).expect("a stray harness");
        let expected = harness.join(".test-tmp");

        assert_eq!(scratch_root(&harness).expect("the harness root"), expected);
        assert_eq!(scratch_root(&repo).expect("the repository root"), expected);
        assert_eq!(
            scratch_root(&crate_dir).expect("the crate directory"),
            expected
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_outside_any_harness_is_an_error() {
        let outside = Path::new("/bench-scratch-outside-any-harness");
        let error = scratch_root(outside).expect_err("no harness above the directory");
        assert!(
            error
                .to_string()
                .contains(outside.to_str().expect("a utf-8 path")),
            "{error}"
        );
    }
}
