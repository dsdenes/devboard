//! The resource governor's regression suite: the global cap, admission
//! control, budget derivation, settings persistence, and — when the host
//! proves it has cgroup v2 and a user manager — the transient slice.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::resources::{
    apply_slice_properties_for, current_in_slice, slice_cgroup_path_for, stop_slice_for,
    DeferReason, Governor, GovernorOptions, MemoryReader, Settings, Slot,
};

/// The slice the tests own; it is separate from the production
/// `devboard.slice` so a test never rewrites a live budget.
const TEST_SLICE: &str = "devboard-resource-governor-test.slice";

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

struct FakeMemory {
    total_mb: u64,
    available_mb: AtomicU64,
    cpus: u32,
}

impl FakeMemory {
    fn new(total_mb: u64, available_mb: u64, cpus: u32) -> Arc<Self> {
        Arc::new(Self {
            total_mb,
            available_mb: AtomicU64::new(available_mb),
            cpus,
        })
    }

    fn set_available(&self, available_mb: u64) {
        self.available_mb.store(available_mb, Ordering::SeqCst);
    }
}

impl MemoryReader for FakeMemory {
    fn total_mb(&self) -> u64 {
        self.total_mb
    }

    fn available_mb(&self) -> Option<u64> {
        Some(self.available_mb.load(Ordering::SeqCst))
    }

    fn cpu_count(&self) -> u32 {
        self.cpus
    }
}

fn unique() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    static NEXT: AtomicU64 = AtomicU64::new(1);
    nanos ^ NEXT.fetch_add(1, Ordering::Relaxed)
}

/// A scratch directory inside the repository.
fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.test-tmp")
        .join(format!("resource-governor-{label}-{}", unique()));
    std::fs::create_dir_all(&root).expect("the scratch directory");
    root
}

fn env_map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn in_memory_governor(
    directory: &Path,
    memory: Arc<FakeMemory>,
    env: &[(&str, &str)],
) -> Arc<Governor> {
    Governor::new(
        directory,
        GovernorOptions {
            memory,
            env: env_map(env),
            slice: false,
        },
    )
}

fn sized_governor(
    directory: &Path,
    memory: Arc<FakeMemory>,
    settings: Settings,
    slice: bool,
) -> Arc<Governor> {
    let governor = Governor::in_slice(
        directory,
        GovernorOptions {
            memory,
            env: BTreeMap::new(),
            slice,
        },
        TEST_SLICE,
    );
    governor.save(settings).expect("the test settings validate");
    governor
}

/// Serializes every test that changes the transient slice, because the slice
/// is one host-wide resource.
fn slice_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    // A test that panicked before its final stop leaves the unit behind with
    // its own owner marker. Every slice test starts from a clean test slice.
    let _ = stop_slice_for(TEST_SLICE);
    guard
}

fn slice_supported() -> bool {
    Command::new("systemctl")
        .args(["--user", "show-environment"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// True when the slice tests must run. Without `DEVBOARD_REQUIRE_SLICE=1` a
/// host with no user manager skips them; with it, the test fails loudly.
fn require_slice() -> bool {
    let required = std::env::var("DEVBOARD_REQUIRE_SLICE").as_deref() == Ok("1");
    if !cfg!(target_os = "linux") {
        assert!(!required, "these tests need Linux cgroup v2");
        return false;
    }
    if !slice_supported() {
        assert!(
            !required,
            "DEVBOARD_REQUIRE_SLICE=1 but there is no user systemd manager"
        );
        return false;
    }
    true
}

fn spawn_hold(seconds: f64) -> Child {
    Command::new("sh")
        .args(["-c", &format!("sleep {seconds}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the stub peer starts")
}

/// Waits briefly for a transient scope to move its leader out of the
/// governor's slice before the caller reads membership.
fn wait_outside_slice(canary: &mut Child) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let path = cgroup(canary.id());
        if !path.contains("devboard.slice")
            || canary.try_wait().ok().flatten().is_some()
            || std::time::Instant::now() > deadline
        {
            return path;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A canary that always lands outside the governor's slice, even when the
/// suite itself runs inside it (the Release Train's worker is a slice member).
fn spawn_session_canary(seconds: f64) -> Child {
    let unit = format!("devboard-canary-{}-{}", std::process::id(), unique());
    Command::new("systemd-run")
        .args([
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            &format!("--unit={unit}"),
            "--slice=session.slice",
            "--",
            "sh",
            "-c",
            &format!("sleep {seconds}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the session canary starts")
}

fn wait_children(children: &mut Vec<(u64, Slot, Child)>) -> Vec<u64> {
    let mut finished = Vec::new();
    let mut index = 0;
    while index < children.len() {
        let exited = children[index].2.try_wait().ok().flatten().is_some();
        if exited {
            let (number, slot, mut child) = children.remove(index);
            let _ = child.wait();
            drop(slot);
            finished.push(number);
        } else {
            index += 1;
        }
    }
    finished
}

/* ------------------------------------------------------------------------ */
/* Cap and admission                                                         */
/* ------------------------------------------------------------------------ */

#[tokio::test]
async fn concurrency_cap_defers_the_next_issue() {
    let directory = scratch("cap");
    let memory = FakeMemory::new(96_000, 90_000, 32);
    let governor = in_memory_governor(
        &directory,
        Arc::clone(&memory),
        &[("DEVBOARD_MAX_AGENT_PEERS", "2")],
    );
    let mut pending: Vec<u64> = (1..=5).collect();
    let mut started = Vec::new();
    let mut children: Vec<(u64, Slot, Child)> = Vec::new();
    let mut max_active = 0usize;
    let mut deferrals = 0usize;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        while let Some(number) = pending.first().copied() {
            let label = format!("issue #{number}");
            match governor.try_acquire("issue", &label) {
                Ok(slot) => {
                    pending.remove(0);
                    let child = spawn_hold(0.4);
                    started.push(number);
                    children.push((number, slot, child));
                    max_active = max_active.max(children.len());
                }
                Err(reason) => {
                    deferrals += 1;
                    governor.record_deferral("issue", &label, &reason);
                    break;
                }
            }
        }
        wait_children(&mut children);
        if pending.is_empty() && children.is_empty() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the queue never drained: pending {pending:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(started.len(), 5, "every queued issue starts exactly once");
    assert_eq!(max_active, 2, "a third peer must never run early");
    assert!(deferrals > 0, "the cap must defer a start at least once");
    assert_eq!(governor.active_agents(), 0, "every slot returns");
    assert!(
        !governor.read_deferrals().is_empty(),
        "a deferral is recorded with its reason"
    );
    let deferral = &governor.read_deferrals()[0];
    assert_eq!(deferral["reason"], "capacity");
    assert!(deferral["detail"]
        .as_str()
        .unwrap_or("")
        .contains("deferred"));
}

#[tokio::test]
async fn global_cap_spans_goal_and_issues() {
    let directory = scratch("global");
    let binary = env!("CARGO_BIN_EXE_devboard");
    let slice_before = live_slice_memory_max();
    let run = |label: &str, kind: &str, hold_ms: u64| {
        Command::new(binary)
            .args([
                "resources",
                "admit",
                "--state-dir",
                directory.to_str().expect("a UTF-8 path"),
                "--label",
                label,
                "--kind",
                kind,
                "--hold-ms",
                &hold_ms.to_string(),
            ])
            .env("DEVBOARD_MAX_AGENT_PEERS", "1")
            .stdin(Stdio::null())
            .output()
            .expect("the admit helper runs")
    };
    let mut goal = Command::new(binary)
        .args([
            "resources",
            "admit",
            "--state-dir",
            directory.to_str().expect("a UTF-8 path"),
            "--label",
            "goal",
            "--kind",
            "goal",
            "--hold-ms",
            "1500",
        ])
        .env("DEVBOARD_MAX_AGENT_PEERS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the goal admit helper starts");
    let slots = directory.join("resources").join("slots");
    let slot_count = || {
        std::fs::read_dir(&slots)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                    })
                    .count()
            })
            .unwrap_or(0)
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while slot_count() == 0 {
        assert!(
            std::time::Instant::now() < deadline,
            "the goal run never took the one slot"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    let issues = run("issue #1", "issue", 0);
    assert_eq!(issues.status.code(), Some(2), "an Issues start is deferred");
    assert!(String::from_utf8_lossy(&issues.stdout).contains("deferred:"));
    let flow = run("flow", "flow", 0);
    assert_eq!(flow.status.code(), Some(2), "a flow start is deferred");
    assert!(String::from_utf8_lossy(&flow.stdout).contains("deferred:"));
    let status = goal.wait().expect("the goal helper ends");
    assert!(status.success());
    // The same deferred start proceeds once the active run ends.
    let retried = run("issue #1", "issue", 0);
    assert_eq!(
        retried.status.code(),
        Some(0),
        "the deferred start proceeds"
    );
    assert!(String::from_utf8_lossy(&retried.stdout).contains("admitted"));
    assert_eq!(slot_count(), 0, "no slot leaks");
    assert_eq!(
        live_slice_memory_max(),
        slice_before,
        "a CLI helper never rewrites the live slice budget"
    );
}

#[test]
fn admission_defers_below_reserve() {
    let directory = scratch("reserve");
    let memory = FakeMemory::new(8_192, 3_000, 8);
    let governor = in_memory_governor(
        &directory,
        Arc::clone(&memory),
        &[
            ("DEVBOARD_MEMORY_RESERVE_MB", "2048"),
            ("DEVBOARD_MAX_AGENT_PEERS", "4"),
        ],
    );
    memory.set_available(1_000);
    match governor.try_acquire("goal", "lane") {
        Err(DeferReason::Memory {
            available_mb,
            reserve_mb,
        }) => {
            assert_eq!(available_mb, 1_000);
            assert_eq!(reserve_mb, 2_048);
            governor.record_deferral(
                "goal",
                "lane",
                &DeferReason::Memory {
                    available_mb,
                    reserve_mb,
                },
            );
        }
        other => panic!("below the reserve must defer, got {other:?}"),
    }
    memory.set_available(2_048);
    let slot = governor
        .try_acquire("goal", "lane")
        .expect("at the reserve admits");
    drop(slot);
    memory.set_available(500);
    assert!(matches!(
        governor.try_acquire("goal", "lane"),
        Err(DeferReason::Memory { .. })
    ));
    memory.set_available(4_096);
    governor
        .try_acquire("goal", "lane")
        .expect("a recovered snapshot admits the deferred start");
    let deferrals = governor.read_deferrals();
    assert_eq!(deferrals[0]["reason"], "reserve");
    assert!(deferrals[0]["reserveMb"].as_u64() == Some(2_048));
}

/* ------------------------------------------------------------------------ */
/* Budget and settings                                                       */
/* ------------------------------------------------------------------------ */

#[test]
fn budget_policy_uses_the_host_minus_the_reserve() {
    let directory = scratch("budget-policy");
    let memory = FakeMemory::new(96_468, 90_000, 32);
    let governor = in_memory_governor(&directory, Arc::clone(&memory), &[]);
    // The default maximum is everything the operator's reserve leaves.
    let derived = governor.defaults();
    assert_eq!(derived.memory_reserve_mb, 24_117);
    assert_eq!(derived.memory_max_mb, 72_351);

    let at_the_limit = Settings {
        max_agent_peers: 12,
        memory_high_mb: 60_000,
        memory_max_mb: 86_468,
        memory_reserve_mb: 10_000,
    };
    governor
        .save(at_the_limit)
        .expect("the host total minus the reserve is available");
    let over = Settings {
        memory_max_mb: 86_469,
        ..at_the_limit
    };
    assert!(
        governor.save(over).is_err(),
        "one MB into the reserve is refused"
    );
    governor
        .save(Settings {
            memory_max_mb: 72_351,
            memory_high_mb: 57_880,
            memory_reserve_mb: 24_117,
            ..at_the_limit
        })
        .expect("the default reserve bounds the maximum");
    governor
        .save(Settings {
            max_agent_peers: 64,
            ..at_the_limit
        })
        .expect("a cap of 64 is accepted");
    assert!(governor
        .save(Settings {
            max_agent_peers: 65,
            ..at_the_limit
        })
        .is_err());
    let saved = Settings {
        max_agent_peers: 12,
        memory_high_mb: 60_000,
        memory_max_mb: 70_000,
        memory_reserve_mb: 10_000,
    };
    governor
        .save(saved)
        .expect("the live saved budget is accepted");
    assert_eq!(governor.settings(), saved);

    // Saving applies the hard maximum to the slice this test owns.
    let _lock = slice_lock();
    if require_slice() {
        let slice_governor = sized_governor(
            &scratch("budget-slice"),
            FakeMemory::new(96_468, 90_000, 32),
            Settings {
                max_agent_peers: 12,
                memory_high_mb: 400,
                memory_max_mb: 512,
                memory_reserve_mb: 128,
            },
            true,
        );
        assert_eq!(slice_governor.slice_info().memory_max_mb, 512);
        let output = Command::new("systemctl")
            .args(["--user", "show", TEST_SLICE, "-p", "MemoryMax", "--value"])
            .output()
            .expect("systemctl show runs");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            (512 * 1024 * 1024).to_string()
        );
        stop_slice_for(TEST_SLICE);
    }
}

#[test]
fn a_second_dashboard_joins_without_rewriting_the_budget() {
    let _lock = slice_lock();
    if !require_slice() {
        return;
    }
    let owner = sized_governor(
        &scratch("slice-owner"),
        FakeMemory::new(64_000, 60_000, 16),
        Settings {
            max_agent_peers: 1,
            memory_high_mb: 1_600,
            memory_max_mb: 2_000,
            memory_reserve_mb: 256,
        },
        true,
    );
    assert_eq!(owner.slice_info().memory_max_mb, 2_000);
    let foreign = sized_governor(
        &scratch("slice-foreign"),
        FakeMemory::new(64_000, 60_000, 16),
        Settings {
            max_agent_peers: 1,
            memory_high_mb: 800,
            memory_max_mb: 1_024,
            memory_reserve_mb: 256,
        },
        true,
    );
    assert_eq!(
        foreign.slice_info().memory_max_mb,
        2_000,
        "a dashboard that does not own the slice only joins it"
    );
    assert_eq!(owner.slice_info().memory_max_mb, 2_000);
    owner
        .save(Settings {
            max_agent_peers: 1,
            memory_high_mb: 1_200,
            memory_max_mb: 1_536,
            memory_reserve_mb: 256,
        })
        .expect("the owner still applies its own budget");
    assert_eq!(owner.slice_info().memory_max_mb, 1_536);
    stop_slice_for(TEST_SLICE);
}

#[test]
fn budget_formula_and_overrides() {
    let derived = Settings::derive(100_000, 32);
    assert_eq!(derived.memory_reserve_mb, 25_000);
    assert_eq!(derived.memory_max_mb, 75_000);
    assert_eq!(derived.memory_high_mb, 60_000);
    assert_eq!(derived.max_agent_peers, 8);
    let small = Settings::derive(4_096, 2);
    assert_eq!(small.memory_reserve_mb, 1_024);
    assert_eq!(small.memory_max_mb, 3_072);
    assert_eq!(small.memory_high_mb, 2_457);
    assert_eq!(small.max_agent_peers, 1);
    assert_eq!(Settings::derive(100_000, 3).max_agent_peers, 1);
    assert_eq!(Settings::derive(100_000, 40).max_agent_peers, 10);
    assert_eq!(Settings::derive(100_000, 400).max_agent_peers, 64);

    // The unit fixture's own defaults.
    let directory = scratch("budget-default");
    let memory = FakeMemory::new(100_000, 90_000, 32);
    let governor = in_memory_governor(&directory, memory, &[]);
    assert_eq!(governor.settings(), derived);

    // Environment overrides apply when nothing is saved.
    let directory = scratch("budget-env");
    let memory = FakeMemory::new(100_000, 90_000, 32);
    let governor = in_memory_governor(
        &directory,
        memory,
        &[
            ("DEVBOARD_MAX_AGENT_PEERS", "7"),
            ("DEVBOARD_MEMORY_HIGH_MB", "3000"),
            ("DEVBOARD_MEMORY_MAX_MB", "4000"),
            ("DEVBOARD_MEMORY_RESERVE_MB", "1500"),
        ],
    );
    let overridden = governor.settings();
    assert_eq!(overridden.max_agent_peers, 7);
    assert_eq!(overridden.memory_high_mb, 3_000);
    assert_eq!(overridden.memory_max_mb, 4_000);
    assert_eq!(overridden.memory_reserve_mb, 1_500);

    // A saved value beats the environment on the next start.
    governor
        .save(Settings {
            max_agent_peers: 2,
            memory_high_mb: 1_600,
            memory_max_mb: 2_000,
            memory_reserve_mb: 900,
        })
        .expect("the settings validate");
    let restarted = in_memory_governor(
        &directory,
        FakeMemory::new(100_000, 90_000, 32),
        &[("DEVBOARD_MAX_AGENT_PEERS", "7")],
    );
    assert_eq!(restarted.settings().max_agent_peers, 2);
    assert_eq!(restarted.settings().memory_max_mb, 2_000);
}

#[test]
fn settings_persist_across_restart() {
    let directory = scratch("settings");
    let saved = Settings {
        max_agent_peers: 2,
        memory_high_mb: 256,
        memory_max_mb: 512,
        memory_reserve_mb: 128,
    };
    {
        let governor = in_memory_governor(&directory, FakeMemory::new(64_000, 60_000, 16), &[]);
        governor.save(saved).expect("the settings validate");
        let frame = governor.state_event();
        assert_eq!(frame["state"]["saved"]["maxAgentPeers"], 2);
        assert_eq!(frame["state"]["effective"]["memoryMaxMb"], 512);
        assert_eq!(frame["state"]["live"]["activeAgents"], 0);
    }
    // A restart reads the same values with no environment at all.
    let restarted = in_memory_governor(&directory, FakeMemory::new(64_000, 60_000, 16), &[]);
    assert_eq!(restarted.settings(), saved);
    let text = std::fs::read_to_string(directory.join("resources").join("settings.json"))
        .expect("the settings file");
    assert!(text.contains("\"maxAgentPeers\": 2"));
    assert!(text.contains("\"memoryReserveMb\": 128"));
    // Validation refuses impossible combinations.
    let refused = restarted.save(Settings {
        max_agent_peers: 0,
        ..saved
    });
    assert!(refused.is_err());

    // The live slice matches the saved values when this host can enforce one.
    let _lock = slice_lock();
    if require_slice() {
        let governor = sized_governor(
            &scratch("settings-slice"),
            FakeMemory::new(64_000, 60_000, 16),
            saved,
            true,
        );
        let info = governor.slice_info();
        assert!(info.present);
        assert_eq!(info.memory_high_mb, 256);
        assert_eq!(info.memory_max_mb, 512);
        // Saving again applies without a restart.
        governor
            .save(Settings {
                max_agent_peers: 2,
                memory_high_mb: 320,
                memory_max_mb: 640,
                memory_reserve_mb: 128,
            })
            .expect("the updated settings validate");
        let info = governor.slice_info();
        assert_eq!(info.memory_high_mb, 320);
        assert_eq!(info.memory_max_mb, 640);
        stop_slice_for(TEST_SLICE);
    }
}

/* ------------------------------------------------------------------------ */
/* The transient slice                                                       */
/* ------------------------------------------------------------------------ */

fn slice_budget() -> Settings {
    Settings {
        max_agent_peers: 2,
        memory_high_mb: 128,
        memory_max_mb: 128,
        memory_reserve_mb: 64,
    }
}

/// Starts a synthetic allocator through the governor's own wrapper, so it
/// joins the slice exactly as every peer the dashboard starts does. The scope
/// carries its own 128 MB hard limit, which leaves a live dashboard's budget
/// untouched while still proving the kernel kill.
fn spawn_allocator(governor: &Governor, limit: Settings) -> Child {
    let wrapped = governor.wrap_argv_with_limit(
        vec![
            "python3".to_string(),
            "-c".to_string(),
            "a = bytearray(512 * 1024 * 1024)".to_string(),
        ],
        limit,
    );
    assert_eq!(
        wrapped.first().map(String::as_str),
        Some("systemd-run"),
        "the governor must place the allocator in the slice"
    );
    assert!(
        wrapped.iter().any(|argument| argument
            == &format!("--property=MemoryMax={}", limit.memory_max_mb * 1024 * 1024)),
        "the scope carries the hard limit: {wrapped:?}"
    );
    Command::new(&wrapped[0])
        .args(&wrapped[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the allocator starts")
}

/// Starts the same synthetic allocator without a per-scope limit, so the
/// slice's own `MemoryMax` is the only bound it meets.
fn spawn_allocator_in_slice(governor: &Governor) -> Child {
    let wrapped = governor.wrap_argv_in_slice(vec![
        "python3".to_string(),
        "-c".to_string(),
        "a = bytearray(512 * 1024 * 1024)".to_string(),
    ]);
    assert_eq!(wrapped.first().map(String::as_str), Some("systemd-run"));
    assert!(
        wrapped
            .iter()
            .any(|argument| argument == &format!("--slice={}", governor.slice_name())),
        "the allocator joins the governor's slice: {wrapped:?}"
    );
    Command::new(&wrapped[0])
        .args(&wrapped[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the allocator starts")
}

fn wait_exit(child: &mut Child, seconds: u64) -> Option<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        if let Some(status) = child.try_wait().ok().flatten() {
            return Some(status);
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn cgroup(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap_or_default()
}

fn journal_since(seconds: u64) -> String {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
        .saturating_sub(seconds);
    let output = Command::new("journalctl")
        .args(["--since", &format!("@{since}"), "--no-pager"])
        .output()
        .expect("journalctl runs");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn slice_memory_max_kills_inside_and_spares_session() {
    let _lock = slice_lock();
    if !require_slice() {
        return;
    }
    let directory = scratch("slice-kill");
    let memory = FakeMemory::new(64_000, 60_000, 16);
    let governor = Governor::attached(
        &directory,
        GovernorOptions {
            memory: Arc::clone(&memory) as Arc<dyn MemoryReader>,
            env: BTreeMap::new(),
            slice: true,
        },
    );
    assert!(
        governor.slice_info().present,
        "the production slice must exist"
    );
    // The root budget is whatever the dashboard runs with; the test's own
    // scope carries the 128 MB limit, so this never rewrites a live budget.
    // Drain any kill from an earlier run before this allocator starts.
    let _ = governor.collect_kills();

    let mut canary = spawn_session_canary(120.0);
    let canary_cgroup = wait_outside_slice(&mut canary);
    assert!(
        !canary_cgroup.contains("devboard.slice"),
        "the canary stays in the session cgroup: {canary_cgroup}"
    );
    let started = SystemTime::now();
    let mut allocator = spawn_allocator(&governor, slice_budget());
    let allocator_pid = allocator.id();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !cgroup(allocator_pid).contains("devboard.slice") && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        cgroup(allocator_pid).contains("devboard.slice"),
        "the allocator is inside the slice: {}",
        cgroup(allocator_pid)
    );
    let status = wait_exit(&mut allocator, 20);
    assert!(status.is_some(), "the slice limit must end the allocator");
    assert!(
        !status.expect("the allocator exited").success(),
        "the allocator is killed, not successful"
    );
    let mut kills = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while kills.is_empty() && std::time::Instant::now() < deadline {
        kills = governor.collect_kills();
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!kills.is_empty(), "the slice records its kernel kill");
    assert!(
        canary.try_wait().ok().flatten().is_none(),
        "the canary outside the slice survives"
    );
    let elapsed = SystemTime::now()
        .duration_since(started)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let journal = journal_since(elapsed + 5);
    for line in journal.lines() {
        if line.contains("systemd-oomd") && line.contains("session-") {
            panic!("systemd-oomd killed the session: {line}");
        }
    }
    let _ = canary.kill();
    let _ = canary.wait();
}

#[test]
fn dashboard_survives_slice_kill() {
    let _lock = slice_lock();
    if !require_slice() {
        return;
    }
    let directory = scratch("slice-dashboard");
    let memory = FakeMemory::new(64_000, 60_000, 16);
    let governor = Governor::attached(
        &directory,
        GovernorOptions {
            memory: Arc::clone(&memory) as Arc<dyn MemoryReader>,
            env: BTreeMap::new(),
            slice: true,
        },
    );
    let recorded: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let recorded = Arc::clone(&recorded);
        governor.set_journal_hook(Arc::new(move |kind, text| {
            recorded
                .lock()
                .unwrap()
                .push((kind.to_string(), text.to_string()));
        }));
    }
    if !current_in_slice() {
        assert!(
            !cgroup(std::process::id()).contains("devboard.slice"),
            "the control plane stays outside the slice"
        );
    }
    let _ = governor.collect_kills();
    let mut allocator = spawn_allocator(&governor, slice_budget());
    assert!(
        wait_exit(&mut allocator, 20).is_some(),
        "the allocator is killed"
    );
    let mut kills = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while kills.is_empty() && std::time::Instant::now() < deadline {
        kills = governor.collect_kills();
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!kills.is_empty(), "the governor records the kill");
    if !current_in_slice() {
        assert!(
            cgroup(std::process::id()).is_empty()
                || !cgroup(std::process::id()).contains("devboard.slice"),
            "the dashboard process survives outside the slice"
        );
    }
    let journaled = recorded.lock().unwrap().clone();
    assert!(
        journaled
            .iter()
            .any(|(kind, text)| kind == "resource-kill" && text.contains("killed")),
        "the dashboard journal records the kill: {journaled:?}"
    );
    memory.set_available(10);
    assert!(
        matches!(
            governor.try_acquire("goal", "after-kill"),
            Err(DeferReason::Memory { .. })
        ),
        "a low memory snapshot still defers"
    );
    memory.set_available(60_000);
    governor
        .try_acquire("goal", "after-kill")
        .expect("a new run starts after the budget recovers");
}

#[test]
fn peers_join_the_slice() {
    let _lock = slice_lock();
    if !require_slice() {
        return;
    }
    let directory = scratch("slice-peers");
    let memory = FakeMemory::new(64_000, 60_000, 16);
    let governor = Governor::attached(
        &directory,
        GovernorOptions {
            memory,
            env: BTreeMap::new(),
            slice: true,
        },
    );
    // The peer spawns its MCP child; both must inherit the slice membership.
    let peer_script = "sleep 30 & child=$!; echo $child; wait";
    let wrapped = governor.wrap_argv(vec![
        "sh".to_string(),
        "-c".to_string(),
        peer_script.to_string(),
    ]);
    if !current_in_slice() {
        assert_eq!(wrapped.first().map(String::as_str), Some("systemd-run"));
    }
    let mut peer = Command::new(&wrapped[0])
        .args(&wrapped[1..])
        .stdout(Stdio::piped())
        .spawn()
        .expect("the peer starts");
    let mut worker = {
        let wrapped = governor.wrap_argv(vec![
            "sh".to_string(),
            "-c".to_string(),
            "sleep 30".to_string(),
        ]);
        Command::new(&wrapped[0])
            .args(&wrapped[1..])
            .spawn()
            .expect("the worker starts")
    };
    let mut owner = {
        let wrapped = governor.wrap_argv(vec![
            "sh".to_string(),
            "-c".to_string(),
            "sleep 30".to_string(),
        ]);
        Command::new(&wrapped[0])
            .args(&wrapped[1..])
            .spawn()
            .expect("the owner starts")
    };
    let child_pid = {
        use std::io::{BufRead, BufReader};
        let mut line = String::new();
        BufReader::new(peer.stdout.take().expect("the peer pipes stdout"))
            .read_line(&mut line)
            .expect("the peer reports its child");
        line.trim().parse::<u32>().ok()
    };
    for (role, pid) in [
        ("peer", peer.id()),
        ("worker", worker.id()),
        ("run owner", owner.id()),
    ] {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !cgroup(pid).contains("devboard.slice") && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            cgroup(pid).contains("devboard.slice"),
            "the {role} runs in the slice: {}",
            cgroup(pid)
        );
    }
    if let Some(pid) = child_pid {
        assert!(
            cgroup(pid).contains("devboard.slice"),
            "the MCP child inherits the slice: {}",
            cgroup(pid)
        );
    } else {
        panic!("the peer did not report its MCP child");
    }
    if !current_in_slice() {
        assert!(
            !cgroup(std::process::id()).contains("devboard.slice"),
            "the dashboard process is not in the slice"
        );
    }
    for child in [&mut peer, &mut worker, &mut owner] {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn live_slice_memory_max() -> String {
    let output = Command::new("systemctl")
        .args([
            "--user",
            "show",
            "devboard.slice",
            "-p",
            "MemoryMax",
            "--value",
        ])
        .output()
        .expect("systemctl show runs");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn spawn_slice_canary() -> Child {
    Command::new("systemd-run")
        .args([
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            "--slice=devboard.slice",
            "--",
            "sh",
            "-c",
            "sleep 120",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the slice canary starts")
}

fn assert_canary_alive(canary: &mut Child, step: &str) {
    assert!(
        canary.try_wait().ok().flatten().is_none(),
        "the slice canary must survive {step}"
    );
}

/// A workspace test, a release-suite run, and each CLI invocation only join
/// the live slice. None of them may rewrite its budget or kill its members.
#[test]
fn slice_rewrite_never_follows_a_workspace_or_cli_run() {
    let _lock = slice_lock();
    if !require_slice() {
        return;
    }
    let before = live_slice_memory_max();
    let directory = scratch("slice-rewrite");
    let fixture = directory.join("fixture");
    std::fs::create_dir_all(fixture.join(".devboard")).expect("a fixture checkout");
    let binary = env!("CARGO_BIN_EXE_devboard");
    let kills = directory.join("resources").join("kills.jsonl");
    let run = |args: &[&str], env: &[(&str, &str)]| {
        let mut command = Command::new(binary);
        command
            .args(args)
            .envs(env.iter().copied())
            .stdin(Stdio::null());
        command.output().expect("the CLI runs")
    };
    let assert_untouched = |step: &str, canary: &mut Child| {
        assert_eq!(
            live_slice_memory_max(),
            before,
            "{step} must not rewrite the live slice budget"
        );
        assert_canary_alive(canary, step);
        assert!(
            !kills.exists(),
            "{step} must not record a kernel kill: {}",
            kills.display()
        );
    };

    let mut canary = spawn_slice_canary();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !cgroup(canary.id()).contains("devboard.slice") && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        cgroup(canary.id()).contains("devboard.slice"),
        "the canary joins the live slice: {}",
        cgroup(canary.id())
    );

    let stress = run(
        &[
            "resources",
            "stress",
            "--state-dir",
            directory.to_str().expect("a UTF-8 path"),
            "--count",
            "4",
            "--hold-ms",
            "100",
        ],
        &[("DEVBOARD_MEMORY_MAX_MB", "2048")],
    );
    assert!(
        stress.status.success(),
        "stress failed: {}",
        String::from_utf8_lossy(&stress.stderr)
    );
    assert_untouched("resources stress", &mut canary);

    let admit = run(
        &[
            "resources",
            "admit",
            "--state-dir",
            directory.to_str().expect("a UTF-8 path"),
        ],
        &[],
    );
    assert!(
        admit.status.success(),
        "admit failed: {}",
        String::from_utf8_lossy(&admit.stderr)
    );
    assert_untouched("resources admit", &mut canary);

    // The worker fails fast on a fixture without an origin, but it has already
    // installed its governor by then; that install must not touch the slice.
    let worker = run(
        &[
            "worker",
            "issues",
            "--repo",
            fixture.to_str().expect("a UTF-8 path"),
            "--state-dir",
            directory.to_str().expect("a UTF-8 path"),
        ],
        &[(
            "GIT_CEILING_DIRECTORIES",
            directory.to_str().expect("a UTF-8 path"),
        )],
    );
    assert!(
        !worker.status.success(),
        "the fixture worker reports its missing origin"
    );
    assert_untouched("devboard worker", &mut canary);

    let _ = canary.kill();
    let _ = canary.wait();
}

#[test]
fn desktop_session_survives_a_slice_that_reaches_its_maximum() {
    let _lock = slice_lock();
    if !require_slice() {
        return;
    }
    let directory = scratch("desktop");
    let memory = FakeMemory::new(64_000, 60_000, 16);
    let governor = sized_governor(
        &directory,
        memory,
        Settings {
            max_agent_peers: 1,
            memory_high_mb: 128,
            memory_max_mb: 128,
            memory_reserve_mb: 64,
        },
        true,
    );
    let info = governor.slice_info();
    assert!(info.present, "the test slice exists");
    assert_eq!(info.memory_max_mb, 128);
    let limit = 128 * 1024 * 1024;
    let mut canary = spawn_session_canary(120.0);
    let canary_cgroup = wait_outside_slice(&mut canary);
    assert!(
        !canary_cgroup.contains("devboard.slice"),
        "the session canary: {canary_cgroup}"
    );
    let mut allocator = spawn_allocator_in_slice(&governor);
    let started = SystemTime::now();
    let mut peak = 0u64;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(path) = slice_cgroup_path_for(TEST_SLICE) {
            if let Ok(text) = std::fs::read_to_string(path.join("memory.current")) {
                peak = peak.max(text.trim().parse::<u64>().unwrap_or(0));
            }
        }
        if let Some(status) = allocator.try_wait().ok().flatten() {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the slice limit must end the allocator"
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    assert!(!status.success(), "the allocator is killed at the limit");
    assert!(
        peak <= limit,
        "the slice stays at or below its maximum: {peak} > {limit}"
    );
    assert!(
        canary.try_wait().ok().flatten().is_none(),
        "the session canary survives the slice kill"
    );
    let elapsed = SystemTime::now()
        .duration_since(started)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    for line in journal_since(elapsed + 5).lines() {
        let lowered = line.to_lowercase();
        if lowered.contains("session-") && (lowered.contains("oom") || lowered.contains("killed")) {
            panic!("the session scope was killed: {line}");
        }
    }
    let _ = canary.kill();
    let _ = canary.wait();
    stop_slice_for(TEST_SLICE);
}

#[test]
fn a_low_memory_snapshot_defers_every_start_in_the_cli() {
    // The live proof uses `devboard resources stress`; this proves its cap
    // arithmetic against a real set of child processes.
    let _lock = slice_lock();
    let directory = scratch("stress");
    let binary = env!("CARGO_BIN_EXE_devboard");
    let slice_before = live_slice_memory_max();
    let output = Command::new(binary)
        .args([
            "resources",
            "stress",
            "--state-dir",
            directory.to_str().expect("a UTF-8 path"),
            "--count",
            "6",
            "--hold-ms",
            "120",
        ])
        .env("DEVBOARD_MAX_AGENT_PEERS", "2")
        .env("DEVBOARD_MEMORY_MAX_MB", "2048")
        .env("DEVBOARD_MEMORY_HIGH_MB", "1600")
        .env("DEVBOARD_MEMORY_RESERVE_MB", "256")
        .stdin(Stdio::null())
        .output()
        .expect("the stress helper runs");
    assert!(
        output.status.success(),
        "stress failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("the stress report is JSON");
    assert_eq!(report["started"], 6);
    assert_eq!(report["maxActive"], 2);
    assert!(report["deferredAttempts"].as_u64().unwrap_or(0) > 0);
    assert_eq!(
        live_slice_memory_max(),
        slice_before,
        "the CLI never rewrites the live slice budget"
    );
}

#[test]
fn the_slice_defaults_follow_the_saved_budget() {
    let _lock = slice_lock();
    if !require_slice() {
        return;
    }
    let directory = scratch("slice-defaults");
    let memory = FakeMemory::new(64_000, 60_000, 16);
    let governor = sized_governor(
        &directory,
        memory,
        Settings {
            max_agent_peers: 3,
            memory_high_mb: 1_600,
            memory_max_mb: 2_000,
            memory_reserve_mb: 512,
        },
        true,
    );
    let info = governor.slice_info();
    assert_eq!(info.memory_high_mb, 1_600);
    assert_eq!(info.memory_max_mb, 2_000);
    // The slice properties are what `systemctl show` reports.
    let output = Command::new("systemctl")
        .args(["--user", "show", TEST_SLICE, "-p", "MemoryMax"])
        .output()
        .expect("systemctl show runs");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains(&format!("MemoryMax={}", 2_000 * 1024 * 1024)),
        "{text}"
    );
    let _ = apply_slice_properties_for(
        TEST_SLICE,
        Settings {
            max_agent_peers: 1,
            memory_high_mb: 256,
            memory_max_mb: 512,
            memory_reserve_mb: 128,
        },
    );
    stop_slice_for(TEST_SLICE);
}
