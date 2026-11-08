//! One dashboard per host directory, the refusal that keeps it that way, and
//! the sweep the panel icon runs before it starts or restarts one.

use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

fn harness_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the devboard harness directory exists")
}

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_devboard")
}

struct Scratch {
    path: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after the epoch")
            .as_nanos();
        let root = harness_root().join(".test-tmp");
        std::fs::create_dir_all(&root).expect("the scratch root");
        let path = root.join(format!("instances-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("a scratch directory");
        Self { path }
    }

    fn host(&self, name: &str) -> PathBuf {
        let repo = self.path.join(name);
        std::fs::create_dir_all(repo.join("adrs")).expect("a repository");
        std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");
        std::fs::write(repo.join("GOAL.md"), "# Goal\n").expect("a goal document");
        repo
    }

    fn state(&self, name: &str) -> PathBuf {
        let state = self.path.join(name);
        std::fs::create_dir_all(&state).expect("a state directory");
        state
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn base_env(repo: &Path, state: &Path, command: &mut ProcessCommand) {
    command
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", repo)
        .env("HOST", "127.0.0.1")
        .env("ADRS_DIR", repo.join("adrs"))
        .env("REPO_DIR", repo)
        .env("GOAL_FILE", repo.join("GOAL.md"))
        .env("STATE_DIR", state)
        .env("AGENT_COMMAND", format!("{} acp-stub", binary()))
        .env("DEVBOARD_OWNER_EXECUTABLE", binary())
        .env("DEVBOARD_UPDATE_INTERVAL_MS", "3600000")
        .env("DEVBOARD_OPENCODE_GO_USAGE_BASE_URL", "http://127.0.0.1:1");
}

/// A dashboard start, exactly as an operator runs it.
fn start_dashboard(repo: &Path, state: &Path, log: &Path, extra: &[(&str, &str)]) -> Child {
    std::fs::create_dir_all(state).expect("a state directory");
    let output = std::fs::File::create(log).expect("a dashboard log");
    let mut command = ProcessCommand::new(binary());
    command
        .arg("serve")
        .arg("--repo-dir")
        .arg(repo)
        .arg("--port")
        .arg("0")
        .arg("--state-dir")
        .arg(state)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone().expect("a log handle")))
        .stderr(Stdio::from(output));
    base_env(repo, state, &mut command);
    for (name, value) in extra {
        command.env(name, value);
    }
    command.spawn().expect("the dashboard starts")
}

fn fixture_env() -> [(&'static str, &'static str); 2] {
    [
        ("DEVBOARD_DASHBOARD_SINGLETON_FIXTURE", "1"),
        ("DEVBOARD_WATCHDOG_FIXTURE", "1"),
    ]
}

async fn ready(port: u16) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .expect("a client");
    client
        .get(format!("http://127.0.0.1:{port}/ready"))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn marker(state: &Path) -> Value {
    std::fs::read_to_string(state.join("version.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

fn marker_port(state: &Path) -> u16 {
    u16::try_from(marker(state)["port"].as_u64().unwrap_or(0)).unwrap_or(0)
}

async fn wait_ready(state: &Path) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let port = marker_port(state);
        if port > 0 && ready(port).await {
            return port;
        }
        assert!(Instant::now() < deadline, "the dashboard became ready");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn wait_exit(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn kill_pid(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

fn alive(pid: u32) -> bool {
    devboard::supervision::live_process(pid)
}

struct Cli {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

fn instances(subcommand: &str, repo: &Path, state: &Path, json: bool) -> Cli {
    let mut command = ProcessCommand::new(binary());
    command
        .arg("instances")
        .arg(subcommand)
        .arg("--repo-dir")
        .arg(repo)
        .arg("--state-dir")
        .arg(state)
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", repo);
    if json {
        command.arg("--json");
    }
    let output = command.output().expect("the instances command runs");
    Cli {
        status: output.status,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn status_entries(repo: &Path, state: &Path) -> Vec<Value> {
    let cli = instances("status", repo, state, true);
    assert!(cli.status.success(), "status failed: {}", cli.stderr);
    let value: Value = serde_json::from_str(cli.stdout.trim()).expect("a JSON status");
    value.as_array().cloned().expect("a JSON array")
}

fn sweep(repo: &Path, state: &Path) -> Value {
    let cli = instances("sweep", repo, state, false);
    let line = cli
        .stdout
        .lines()
        .last()
        .expect("a sweep report")
        .to_string();
    let value: Value = serde_json::from_str(&line).expect("a JSON sweep report");
    assert!(
        cli.status.success(),
        "sweep failed: {} {}",
        cli.stderr,
        value
    );
    value
}

/// One REST restart request; the old process may stop before it answers.
async fn send_restart(port: u16) {
    let _ = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/server-restarts"))
        .header("accept", "application/json")
        .send()
        .await;
}

fn journal_size(repo: &Path, state: &Path) -> u64 {
    let path = devboard::journal::journal_file(state, repo);
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn version_bytes(state: &Path) -> Vec<u8> {
    std::fs::read(state.join("version.json")).unwrap_or_default()
}

#[tokio::test]
async fn a_second_start_for_the_same_host_dir_is_refused() {
    let scratch = Scratch::new("refused");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let other = scratch.state("second-state");
    let mut first = start_dashboard(&repo, &state, &scratch.path.join("first.log"), &[]);
    let port = wait_ready(&state).await;
    let pid = first.id();
    let before_version = version_bytes(&state);
    let before_journal = journal_size(&repo, &state);

    let started = Instant::now();
    let mut second = ProcessCommand::new(binary());
    second
        .arg("serve")
        .arg("--repo-dir")
        .arg(&repo)
        .arg("--port")
        .arg("0")
        .arg("--state-dir")
        .arg(&other)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    base_env(&repo, &other, &mut second);
    let output = second.output().expect("the second start runs");
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "the refusal answered within the deadline"
    );
    assert!(!output.status.success(), "the second start is refused");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(&pid.to_string()),
        "the refusal names the live pid: {stderr}"
    );
    assert!(
        stderr.contains(&port.to_string()),
        "the refusal names the live port: {stderr}"
    );
    assert!(
        second_listener_absent(&other),
        "the refused start bound nothing"
    );
    assert_eq!(
        version_bytes(&state),
        before_version,
        "version.json is untouched"
    );
    assert_eq!(
        journal_size(&repo, &state),
        before_journal,
        "the live journal is untouched"
    );
    assert!(ready(port).await, "the live dashboard still serves");
    stop(&mut first);
}

fn second_listener_absent(state: &Path) -> bool {
    !state.join("version.json").exists()
}

#[tokio::test]
async fn refusal_names_the_live_pid_port_and_repo() {
    let scratch = Scratch::new("named");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut first = start_dashboard(&repo, &state, &scratch.path.join("first.log"), &[]);
    let port = wait_ready(&state).await;
    let pid = first.id();
    let canonical = repo.canonicalize().expect("a canonical repository");

    let mut second = ProcessCommand::new(binary());
    second
        .arg("serve")
        .arg("--repo-dir")
        .arg(&repo)
        .arg("--port")
        .arg("0")
        .arg("--state-dir")
        .arg(scratch.state("second-state"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    base_env(&repo, &scratch.state("second-state"), &mut second);
    let output = second.output().expect("the second start runs");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(&pid.to_string()), "{stderr}");
    assert!(stderr.contains(&port.to_string()), "{stderr}");
    assert!(
        stderr.contains(&canonical.to_string_lossy().into_owned()),
        "the refusal names the repository: {stderr}"
    );
    stop(&mut first);
}

#[tokio::test]
async fn a_different_port_and_state_dir_do_not_defeat_the_guard() {
    let scratch = Scratch::new("port-state");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut first = start_dashboard(&repo, &state, &scratch.path.join("first.log"), &[]);
    wait_ready(&state).await;

    let mut second = ProcessCommand::new(binary());
    second
        .arg("serve")
        .arg("--repo-dir")
        .arg(&repo)
        .arg("--port")
        .arg("0")
        .arg("--state-dir")
        .arg(scratch.state("other-state"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    base_env(&repo, &scratch.state("other-state"), &mut second);
    let output = second.output().expect("the second start runs");
    assert!(
        !output.status.success(),
        "another port and state dir never defeat the guard"
    );
    stop(&mut first);
}

#[tokio::test]
async fn different_host_dirs_each_serve() {
    let scratch = Scratch::new("two-hosts");
    let repo_a = scratch.host("repo-a");
    let repo_b = scratch.host("repo-b");
    let state_a = scratch.state("state-a");
    let state_b = scratch.state("state-b");
    let mut first = start_dashboard(
        &repo_a,
        &state_a,
        &scratch.path.join("a.log"),
        &fixture_env(),
    );
    let mut second = start_dashboard(
        &repo_b,
        &state_b,
        &scratch.path.join("b.log"),
        &fixture_env(),
    );
    let port_a = wait_ready(&state_a).await;
    let port_b = wait_ready(&state_b).await;
    assert!(ready(port_a).await && ready(port_b).await);
    assert_eq!(status_entries(&repo_a, &state_a).len(), 1);
    assert_eq!(status_entries(&repo_b, &state_b).len(), 1);
    stop(&mut first);
    stop(&mut second);
}

#[tokio::test]
async fn concurrent_starts_leave_exactly_one_dashboard() {
    let scratch = Scratch::new("concurrent");
    let repo = scratch.host("repo");
    let mut children = Vec::new();
    for index in 0..4 {
        let state = scratch.state(&format!("state-{index}"));
        let log = scratch.path.join(format!("s{index}.log"));
        let child = start_dashboard(&repo, &state, &log, &[]);
        children.push((state, child, log));
    }
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let mut exited = 0;
        for (_, child, _) in children.iter_mut() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                exited += 1;
            }
        }
        if exited >= 3 {
            break;
        }
        assert!(Instant::now() < deadline, "three starts were refused");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut refusals = 0;
    for (_, child, log) in children.iter_mut() {
        let Some(status) = child.try_wait().expect("a start status") else {
            continue;
        };
        assert!(!status.success(), "a refused start exits nonzero");
        let text = std::fs::read_to_string(&*log).unwrap_or_default();
        assert!(
            text.contains("another dashboard already serves"),
            "the refusal message is written: {text}"
        );
        refusals += 1;
    }
    assert_eq!(refusals, 3, "three starts were refused");
    let entries = status_entries(&repo, &scratch.state("state-0"));
    assert_eq!(
        entries.len(),
        1,
        "exactly one dashboard serves the host: {entries:?}"
    );
    let ready_count = entries
        .iter()
        .filter(|entry| entry["ready"] == json!(true))
        .count();
    assert_eq!(ready_count, 1);
    for (_, child, _) in children.iter_mut() {
        stop(child);
    }
}

#[tokio::test]
async fn a_killed_dashboard_never_blocks_the_next_start() {
    let scratch = Scratch::new("killed");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut first = start_dashboard(&repo, &state, &scratch.path.join("first.log"), &[]);
    wait_ready(&state).await;
    let pid = first.id();
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    first.wait().expect("the killed dashboard is reaped");

    let next_state = scratch.state("next-state");
    let mut next = start_dashboard(&repo, &next_state, &scratch.path.join("next.log"), &[]);
    wait_ready(&next_state).await;
    let entries = status_entries(&repo, &state);
    assert_eq!(entries.len(), 1, "the next start serves alone: {entries:?}");
    assert_ne!(entries[0]["pid"].as_u64(), Some(u64::from(pid)));
    stop(&mut next);
}

#[tokio::test]
async fn a_confirmed_replacement_transfers_the_guard() {
    let scratch = Scratch::new("replacement");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut first = start_dashboard(&repo, &state, &scratch.path.join("first.log"), &[]);
    let port = wait_ready(&state).await;
    let old_pid = first.id();

    send_restart(port).await;
    let status = wait_exit(&mut first, Duration::from_secs(30));
    assert!(
        status.is_some(),
        "the old dashboard exits after the handoff"
    );

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut new_pid = 0;
    while Instant::now() < deadline {
        let current = u32::try_from(marker(&state)["pid"].as_u64().unwrap_or(0)).unwrap_or(0);
        if current != 0 && current != old_pid && ready(port).await {
            new_pid = current;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_ne!(new_pid, 0, "the replacement binds and serves");
    let entries = status_entries(&repo, &state);
    assert_eq!(
        entries.len(),
        1,
        "exactly one dashboard remains: {entries:?}"
    );
    assert_eq!(entries[0]["pid"].as_u64(), Some(u64::from(new_pid)));
    kill_pid(new_pid);
}

#[tokio::test]
async fn sweep_keeps_the_newest_ready_dashboard() {
    let scratch = Scratch::new("sweep-newest");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut children = Vec::new();
    for index in 0..3 {
        let child_state = scratch.state(&format!("state-{index}"));
        let child = start_dashboard(
            &repo,
            &child_state,
            &scratch.path.join(format!("s{index}.log")),
            &fixture_env(),
        );
        let _ = wait_ready(&child_state).await;
        children.push((child_state, child));
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let newest = children
        .last()
        .map(|(_, child)| child.id())
        .expect("a dashboard");
    let older: Vec<u32> = children[..2].iter().map(|(_, child)| child.id()).collect();
    let report = sweep(&repo, &state);
    assert_eq!(report["keptPid"].as_u64(), Some(u64::from(newest)));
    let stopped: Vec<u64> = report["stoppedPids"]
        .as_array()
        .expect("stopped pids")
        .iter()
        .filter_map(Value::as_u64)
        .collect();
    for pid in &older {
        assert!(
            stopped.contains(&u64::from(*pid)),
            "the older pid is named: {report}"
        );
        assert!(!alive(*pid), "the older dashboard stopped");
    }
    assert!(alive(newest), "the newest dashboard is kept");
    assert_eq!(status_entries(&repo, &state).len(), 1);
    for (_, child) in children.iter_mut() {
        stop(child);
    }
}

#[tokio::test]
async fn sweep_records_the_kept_and_stopped_pids() {
    let scratch = Scratch::new("sweep-record");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut children = Vec::new();
    for index in 0..2 {
        let child_state = scratch.state(&format!("state-{index}"));
        let child = start_dashboard(
            &repo,
            &child_state,
            &scratch.path.join(format!("s{index}.log")),
            &fixture_env(),
        );
        let _ = wait_ready(&child_state).await;
        children.push((child_state, child));
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let newest = children[1].1.id();
    let older = children[0].1.id();
    let report = sweep(&repo, &state);
    assert_eq!(report["keptPid"].as_u64(), Some(u64::from(newest)));

    let lines = std::fs::read_to_string(state.join("supervision/reaped.jsonl"))
        .expect("the sweep pass line");
    let pass = lines
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|line| line["pass"] == "sweep")
        .expect("a sweep pass line");
    assert_eq!(pass["keptPid"].as_u64(), Some(u64::from(newest)));
    let stopped: Vec<u64> = pass["stoppedPids"]
        .as_array()
        .expect("stopped pids")
        .iter()
        .filter_map(Value::as_u64)
        .collect();
    assert!(stopped.contains(&u64::from(older)));
    for (_, child) in children.iter_mut() {
        stop(child);
    }
}

/// A shell process that looks like a dashboard but never listens.
fn hung_dashboard(scratch: &Scratch, repo: &Path, state: &Path, port: u16) -> Child {
    let tools = scratch.path.join("tools");
    let bin = tools.join(".devboard/bin");
    std::fs::create_dir_all(&bin).expect("a fixture harness");
    std::fs::write(
        bin.join("devboard"),
        "#!/bin/sh\nwhile :; do sleep 1; done\n",
    )
    .expect("a hung fixture");
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(bin.join("devboard"), std::fs::Permissions::from_mode(0o755))
        .expect("an executable fixture");
    let log = std::fs::File::create(scratch.path.join("hung.log")).expect("a log");
    let mut command = ProcessCommand::new(bin.join("devboard"));
    command
        .arg("serve")
        .arg("--repo-dir")
        .arg(repo)
        .arg("--port")
        .arg(port.to_string())
        .arg("--state-dir")
        .arg(state)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("REPO_DIR", repo)
        .env("STATE_DIR", state)
        .env("PORT", port.to_string())
        .env("STATIC_DIR", tools.join(".devboard/dist"))
        .env("DEVBOARD_WATCHDOG_FIXTURE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().expect("a log")))
        .stderr(Stdio::from(log));
    command.spawn().expect("the hung fixture starts")
}

fn wait_discovered(repo: &Path, state: &Path, pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if status_entries(repo, state)
            .iter()
            .any(|entry| entry["pid"].as_u64() == Some(u64::from(pid)))
        {
            return;
        }
        assert!(Instant::now() < deadline, "the fixture is discovered");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tokio::test]
async fn sweep_stops_an_unresponsive_dashboard_after_the_grace() {
    let scratch = Scratch::new("sweep-hung");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut ready_child = start_dashboard(
        &repo,
        &scratch.state("ready-state"),
        &scratch.path.join("ready.log"),
        &fixture_env(),
    );
    let _ = wait_ready(&scratch.state("ready-state")).await;
    let mut hung = hung_dashboard(&scratch, &repo, &scratch.state("hung-state"), 47811);
    let hung_pid = hung.id();
    wait_discovered(&repo, &state, hung_pid);

    let started = Instant::now();
    let report = sweep(&repo, &state);
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(4_900),
        "the probe grace ran before the signal: {elapsed:?}"
    );
    assert!(
        !alive(hung_pid),
        "the unresponsive dashboard was stopped: {report}"
    );
    assert_eq!(
        report["keptPid"].as_u64(),
        Some(u64::from(ready_child.id())),
        "the ready dashboard is kept"
    );
    assert!(alive(ready_child.id()));
    stop(&mut ready_child);
    let _ = hung.wait();
}

#[tokio::test]
async fn sweep_never_signals_a_ready_dashboard() {
    let scratch = Scratch::new("sweep-ready");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut child = start_dashboard(
        &repo,
        &state,
        &scratch.path.join("ready.log"),
        &fixture_env(),
    );
    let port = wait_ready(&state).await;
    let pid = child.id();
    let report = sweep(&repo, &state);
    assert_eq!(report["keptPid"].as_u64(), Some(u64::from(pid)));
    assert_eq!(report["stoppedPids"], json!([]));
    assert!(
        alive(pid) && ready(port).await,
        "the ready dashboard keeps serving"
    );
    stop(&mut child);
}

#[tokio::test]
async fn sweep_leaves_another_host_dirs_dashboard_alone() {
    let scratch = Scratch::new("sweep-other-host");
    let repo_a = scratch.host("repo-a");
    let repo_b = scratch.host("repo-b");
    let state_a = scratch.state("state-a");
    let state_b = scratch.state("state-b");
    let mut first = start_dashboard(
        &repo_a,
        &state_a,
        &scratch.path.join("a.log"),
        &fixture_env(),
    );
    let mut second = start_dashboard(
        &repo_b,
        &state_b,
        &scratch.path.join("b.log"),
        &fixture_env(),
    );
    let port_b = wait_ready(&state_b).await;
    wait_ready(&state_a).await;
    let report = sweep(&repo_a, &state_a);
    assert_eq!(report["keptPid"].as_u64(), Some(u64::from(first.id())));
    assert!(
        alive(second.id()),
        "the other host's dashboard is untouched"
    );
    assert!(ready(port_b).await);
    assert_eq!(status_entries(&repo_b, &state_b).len(), 1);
    stop(&mut first);
    stop(&mut second);
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn stat_fields(pid: u32) -> Option<(i64, i64)> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = text.rfind(')')?;
    let fields: Vec<&str> = text.get(close + 2..)?.split(' ').collect();
    let pgid = fields.get(2)?.parse().ok()?;
    let start_ticks = fields.get(19)?.parse().ok()?;
    Some((start_ticks, pgid))
}

fn record_child(state: &Path, pid: u32, repo: &Path) {
    // `/proc/<pid>/cmdline` can read empty in the instant between fork and the
    // child's own exec, so wait for the argv the reaper will compare.
    let started = Instant::now();
    let argv = loop {
        match devboard::supervision::process_argv(pid) {
            Some(argv) if !argv.is_empty() => break argv,
            _ if started.elapsed() > Duration::from_secs(5) => {
                panic!("the child's argv is readable")
            }
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    let (start_ticks, pgid) = stat_fields(pid).expect("the child's stat");
    let record = json!({
        "version": 1,
        "pid": pid,
        "argv": argv,
        "cwd": repo.to_string_lossy(),
        "ownerPid": 2_000_000_000u32,
        "startedAt": devboard::workers::watchdog::now_iso(),
        "startTicks": start_ticks,
        "pgid": pgid,
    });
    let path = devboard::supervision::supervision_record_path(state, pid);
    std::fs::create_dir_all(path.parent().expect("a supervision directory"))
        .expect("the supervision directory");
    std::fs::write(path, format!("{record}\n")).expect("a supervision record");
}

fn sleep_child() -> Child {
    ProcessCommand::new("/bin/sleep")
        .arg("300")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("a sleeping child")
}

#[tokio::test]
async fn sweep_reaps_a_dead_owners_children() {
    let scratch = Scratch::new("sweep-reap");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut child = sleep_child();
    record_child(&state, child.id(), &repo);
    let report = sweep(&repo, &state);
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(child.id()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if alive(child.id()) {
        let reaped =
            std::fs::read_to_string(state.join("supervision/reaped.jsonl")).unwrap_or_default();
        let record = std::fs::read_to_string(devboard::supervision::supervision_record_path(
            &state,
            child.id(),
        ))
        .unwrap_or_else(|_| "<missing>".to_string());
        panic!("the dead owner's child is ended: {report} log {reaped} record {record}");
    }
    let _ = child.wait();
    let lines = std::fs::read_to_string(state.join("supervision/reaped.jsonl"))
        .expect("the sweep pass line");
    assert!(
        lines.contains("\"keptPid\""),
        "the pass line is written: {lines}"
    );
}

#[tokio::test]
async fn sweep_spares_a_live_lease_and_an_older_version_worker() {
    let scratch = Scratch::new("sweep-protected");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut leased = sleep_child();
    let leased_pid = leased.id();
    record_child(&state, leased_pid, &repo);
    let lease = devboard::detached_run::detached_run_lease_path(&state, &repo);
    std::fs::create_dir_all(lease.parent().expect("a lease directory")).expect("a lease directory");
    std::fs::write(
        lease,
        serde_json::to_string(&json!({"pid": std::process::id(), "updatedAt": now_ms()}))
            .expect("a lease"),
    )
    .expect("a lease");
    let runs = devboard::detached_run::detached_runs_root(&state, &repo);
    std::fs::create_dir_all(runs.join("run-1")).expect("a run directory");
    std::fs::write(
        runs.join("run-1/state.json"),
        serde_json::to_string(&json!({"owner": {"pid": leased_pid}})).expect("a run state"),
    )
    .expect("a run state");

    let mut worker = sleep_child();
    let worker_pid = worker.id();
    record_child(&state, worker_pid, &repo);
    let lock = state.join("lock.1.42.2");
    std::fs::write(
        &lock,
        serde_json::to_string(&json!({
            "pid": worker_pid,
            "startedAt": devboard::workers::watchdog::now_iso(),
            "repo": repo.to_string_lossy(),
            "stateDir": state.to_string_lossy(),
            "harnessVersion": "1.42.2",
            "argv": [],
        }))
        .expect("a worker lock"),
    )
    .expect("a worker lock");

    let report = sweep(&repo, &state);
    assert!(alive(leased_pid), "a live lease protects its run: {report}");
    assert!(
        alive(worker_pid),
        "an older-version worker is not signalled: {report}"
    );
    assert!(lock.exists(), "the worker lock survives the sweep");
    let lines =
        std::fs::read_to_string(state.join("supervision/reaped.jsonl")).expect("the reaped log");
    assert!(
        lines.contains("\"skipped\""),
        "the reaper records the skip: {lines}"
    );
    let _ = leased.kill();
    let _ = leased.wait();
    let _ = worker.kill();
    let _ = worker.wait();
}

#[tokio::test]
async fn sweep_spares_a_verification_fixture() {
    let scratch = Scratch::new("sweep-fixture");
    let repo = scratch.host("repo");
    let state = scratch.state("state");
    let mut fixture = start_dashboard(
        &repo,
        &scratch.state("fixture-state"),
        &scratch.path.join("fixture.log"),
        &[("DEVBOARD_DASHBOARD_SINGLETON_FIXTURE", "1")],
    );
    let port = wait_ready(&scratch.state("fixture-state")).await;
    let pid = fixture.id();
    let report = sweep(&repo, &state);
    assert!(
        alive(pid) && ready(port).await,
        "a verification fixture is spared: {report}"
    );
    let protected: Vec<u64> = report["protectedPids"]
        .as_array()
        .expect("protected pids")
        .iter()
        .filter_map(Value::as_u64)
        .collect();
    assert!(
        protected.contains(&u64::from(pid)),
        "the fixture is reported: {report}"
    );
    stop(&mut fixture);
}
