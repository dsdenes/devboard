//! The watchdog worker: discovery, retention, reaping, durable state, the
//! cycle, and multi-version coexistence.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use devboard::journal::journal_file;
use devboard::supervision::ProcessSnapshot;
use devboard::workers::watchdog::*;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn scratch(label: &str) -> PathBuf {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("watchdog-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    // One repository per parent, so a sweep's sibling rule can never reach
    // another test's fixture.
    let root = base.join("repo");
    std::fs::create_dir_all(&root).expect("a scratch root");
    std::fs::canonicalize(&root).expect("a canonical scratch root")
}

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("a fixture parent");
    }
    std::fs::write(path, text).expect("a fixture file");
}

/// Sets one path's mtime (and atime) without following symlinks.
fn set_mtime(path: &Path, ms: i64) {
    use std::os::unix::ffi::OsStrExt;
    let times = [
        libc::timespec {
            tv_sec: (ms / 1000) as libc::time_t,
            tv_nsec: ((ms % 1000) * 1_000_000) as libc::c_long,
        },
        libc::timespec {
            tv_sec: (ms / 1000) as libc::time_t,
            tv_nsec: ((ms % 1000) * 1_000_000) as libc::c_long,
        },
    ];
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("a path");
    let result = unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) };
    assert_eq!(result, 0, "utimensat");
}

fn fixture_instance(root: &Path, state_dir: &Path) -> Instance {
    let repo_dir = root.to_string_lossy().into_owned();
    Instance {
        pid: 4040,
        port: 4747,
        repo_dir,
        host: "127.0.0.1".to_string(),
        harness: root.join(".devboard").to_string_lossy().into_owned(),
        state_dir: state_dir.to_string_lossy().into_owned(),
        token: String::new(),
        journal: journal_file(state_dir, root).to_string_lossy().into_owned(),
        instrumented: true,
        legacy_log: None,
    }
}

fn event(now: i64, minutes_ago: i64, text: &str, kind: &str, instance: &Instance) -> EvidenceEvent {
    let ts_ms = now - minutes_ago * 60 * 1000;
    EvidenceEvent {
        source: format!("{}/journal/fixture.jsonl", instance.state_dir),
        kind: kind.to_string(),
        ts: iso_from_ms(ts_ms),
        ts_ms,
        text: text.to_string(),
        scope: None,
        level: None,
        detail: None,
        instance: Some(instance.clone()),
    }
}

/// A delivery that records what it was asked and never touches a forge.
struct RecordingDelivery {
    repository: String,
    calls: Mutex<Vec<String>>,
}

impl RecordingDelivery {
    fn new() -> Self {
        Self {
            repository: "acme/fixture".to_string(),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl WatchdogDelivery for RecordingDelivery {
    fn repository(&self) -> &str {
        &self.repository
    }

    fn owns(&self, url: &str) -> bool {
        url.contains("github.com")
    }

    fn create(&self, input: &IssueInput) -> DeliveryResult {
        self.calls
            .lock()
            .expect("calls")
            .push(format!("create {}", input.fingerprint));
        DeliveryResult::Ok {
            url: "https://github.com/acme/fixture/issues/9".to_string(),
        }
    }

    fn comment(&self, url: &str, _input: &IssueInput) -> CommentResult {
        self.calls
            .lock()
            .expect("calls")
            .push(format!("comment {url}"));
        CommentResult::Ok
    }

    fn state(&self, _url: &str) -> Option<IssueState> {
        None
    }
}

/// A deduplication turn that files the candidates the room allows.
struct RoomDedup {
    rooms: Mutex<Vec<i64>>,
}

impl RoomDedup {
    fn new() -> Self {
        Self {
            rooms: Mutex::new(Vec::new()),
        }
    }
}

impl DedupRunner for RoomDedup {
    fn run(&self, request: &DedupRequest, run_dir: &Path) -> Result<String, String> {
        self.rooms.lock().expect("rooms").push(request.filing_room);
        std::fs::create_dir_all(run_dir).expect("the dedup directory");
        let room = request.filing_room.max(0) as usize;
        let chosen = &request.candidates[..room.min(request.candidates.len())];
        let records: String = chosen
            .iter()
            .enumerate()
            .map(|(index, candidate)| {
                format!(
                    "{}\n",
                    serde_json::to_string(&json!({
                        "fingerprint": candidate.fingerprint,
                        "action": "filed",
                        "url": format!("https://github.com/acme/fixture/issues/{}", 100 + index),
                    }))
                    .expect("a record")
                )
            })
            .collect();
        if !records.is_empty() {
            write(&run_dir.join("dedup-records.jsonl"), &records);
        }
        write(&run_dir.join("dedup-reads.jsonl"), "{\"count\":1}\n");
        Ok(String::new())
    }
}

fn production_root(label: &str) -> PathBuf {
    let root = scratch(label);
    std::fs::create_dir_all(root.join(".devboard").join(".tmp")).expect("a harness");
    root
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

#[test]
fn posix_cksum_matches_the_standard() {
    assert_eq!(posix_cksum(b"abc"), 1_219_131_554);
    assert_eq!(posix_cksum(b""), 4_294_967_295);
    assert_eq!(posix_cksum(b"a"), 1_220_704_766);
}

#[test]
fn discovery_deduplicates_excludes_the_watchdog_and_resolves_the_harness() {
    let root = scratch("discovery");
    let harness = root.join("repo").join(".devboard");
    let state_dir = harness.join(".tmp");
    std::fs::create_dir_all(state_dir.join("journal")).expect("a state directory");
    let repo = root.join("repo");
    let other_harness = root.join("other").join(".devboard");
    std::fs::create_dir_all(&other_harness).expect("another harness");
    let omitted = root.join(".devboard").join(".tmp").join("fixture");
    std::fs::create_dir_all(&omitted).expect("a fixture dashboard");

    let snapshot = |pid: u32,
                    cmdline: &str,
                    cwd: &Path,
                    _repo_dir: &Path,
                    env: HashMap<String, String>,
                    ancestors: Vec<u32>|
     -> ProcessSnapshot {
        ProcessSnapshot {
            pid,
            cmdline: cmdline.to_string(),
            env,
            cwd: Some(cwd.to_path_buf()),
            ancestors,
        }
    };
    let base_env = |repo_dir: &Path| {
        HashMap::from([
            (
                "REPO_DIR".to_string(),
                repo_dir.to_string_lossy().into_owned(),
            ),
            ("PORT".to_string(), "4747".to_string()),
            (
                "STATE_DIR".to_string(),
                state_dir.to_string_lossy().into_owned(),
            ),
        ])
    };
    let mut opted_in = base_env(&omitted);
    opted_in.insert("DEVBOARD_WATCHDOG_FIXTURE".to_string(), "1".to_string());

    let processes = vec![
        snapshot(
            100,
            "bun server/index.ts",
            &harness,
            &repo,
            base_env(&repo),
            vec![1],
        ),
        snapshot(
            100,
            "bun server/index.ts",
            &harness,
            &repo,
            base_env(&repo),
            vec![1],
        ),
        snapshot(
            101,
            "bun server/index.ts",
            &harness,
            &repo,
            base_env(&repo),
            vec![1],
        ),
        snapshot(
            102,
            "bun server/index.ts",
            &harness,
            &repo,
            base_env(&repo),
            vec![101],
        ),
        snapshot(
            103,
            "bun other.ts",
            &other_harness,
            &repo,
            base_env(&repo),
            vec![1],
        ),
        snapshot(
            104,
            "bun server/index.ts",
            &omitted,
            &omitted,
            base_env(&omitted),
            vec![1],
        ),
        snapshot(
            105,
            "bun server/index.ts",
            &omitted,
            &omitted,
            opted_in,
            vec![1],
        ),
    ];
    let self_pids = HashSet::from([101]);
    let instances = instances_from_processes(&processes, &self_pids);
    assert_eq!(
        instances.len(),
        2,
        "deduplicated, minus the watchdog and fixtures"
    );
    let first = &instances[0];
    assert_eq!(first.pid, 100);
    assert_eq!(first.port, 4747);
    assert_eq!(first.repo_dir, repo.to_string_lossy());
    assert_eq!(
        first.harness,
        std::fs::canonicalize(&harness)
            .expect("a harness")
            .to_string_lossy()
    );
    assert_eq!(
        first.journal,
        journal_file(&state_dir, &repo).to_string_lossy()
    );
    assert!(first.instrumented);
    assert_eq!(instances[1].pid, 105);
}

// ---------------------------------------------------------------------------
// Settings, worker state, locks, control, projection
// ---------------------------------------------------------------------------

#[test]
fn settings_validate_and_round_trip_atomically() {
    assert_eq!(parse_watchdog_settings("{}"), None);
    assert_eq!(
        parse_watchdog_settings("{\"intervalMinutes\":0,\"maxPerHour\":null,\"maxPending\":null}"),
        None
    );
    assert_eq!(
        parse_watchdog_settings("{\"intervalMinutes\":10,\"maxPerHour\":0,\"maxPending\":null}"),
        None
    );
    assert_eq!(
        parse_watchdog_settings("{\"intervalMinutes\":10,\"maxPerHour\":null,\"maxPending\":101}"),
        None
    );
    let settings = WatchdogSettings {
        interval_minutes: 5,
        max_per_hour: Some(2),
        max_pending: None,
    };
    let directory = scratch("settings");
    write_watchdog_settings(&directory, &settings).expect("the settings");
    assert_eq!(read_watchdog_settings(&directory), settings);
    let text = std::fs::read_to_string(settings_path(&directory)).expect("settings text");
    assert!(text.ends_with("}\n"));
    assert!(text.contains("\"intervalMinutes\": 5"));
    assert_eq!(
        read_watchdog_settings(&scratch("settings-missing")),
        WatchdogSettings::default()
    );
}

#[test]
fn worker_state_rejects_bad_documents_and_the_newest_wins() {
    let directory = scratch("worker-state");
    let state = |version: Option<&str>, updated_at: &str| WatchdogWorkerState {
        version: WORKER_STATE_VERSION,
        pid: 12_345,
        started_at: "2026-10-24T12:00:00.000Z".to_string(),
        root: "/repo".to_string(),
        state_dir: "/repo/.devboard/.tmp".to_string(),
        lifecycle: AgentLifecycle::Running,
        enabled: true,
        harness_version: version.map(str::to_string),
        argv: vec!["devboard".to_string(), "worker".to_string()],
        last_run_at: None,
        next_run_at: None,
        last_error: None,
        notice: None,
        draining: false,
        updated_at: updated_at.to_string(),
    };
    write_worker_state(
        &versioned_worker_directory(&directory, Some("0.1.1")),
        &state(Some("0.1.1"), "2026-10-24T12:00:00.000Z"),
    )
    .expect("the older state");
    write_worker_state(
        &versioned_worker_directory(&directory, Some("0.1.2")),
        &state(Some("0.1.2"), "2026-10-24T12:05:00.000Z"),
    )
    .expect("the newer state");
    let newest = read_newest_worker_state(&directory).expect("the newest state");
    assert_eq!(newest.harness_version.as_deref(), Some("0.1.2"));
    assert_eq!(read_worker_states(&directory).len(), 2);

    let older = std::fs::read_to_string(worker_state_path(&versioned_worker_directory(
        &directory,
        Some("0.1.1"),
    )))
    .expect("the state text");
    assert!(!older.contains("draining"));

    assert!(parse_worker_state("{\"version\":2}").is_none());
    assert!(parse_worker_state(
        "{\"version\":1,\"pid\":1,\"startedAt\":\"x\",\"root\":\"r\",\"stateDir\":\"s\",\"lifecycle\":\"nope\",\"enabled\":true,\"harnessVersion\":null,\"argv\":[],\"lastRunAt\":null,\"nextRunAt\":null,\"lastError\":null,\"notice\":null,\"updatedAt\":\"u\"}"
    )
    .is_none());
    assert!(parse_worker_state(
        "{\"version\":1,\"pid\":1,\"startedAt\":\"x\",\"root\":\"r\",\"stateDir\":\"s\",\"lifecycle\":\"running\",\"enabled\":true,\"harnessVersion\":null,\"lastRunAt\":null,\"nextRunAt\":null,\"lastError\":null,\"notice\":null,\"updatedAt\":\"u\"}"
    )
    .is_none());
}

fn details(version: Option<&str>) -> LockDetails {
    LockDetails {
        repo: "/repo".to_string(),
        state_dir: "/state".to_string(),
        harness_version: version.map(str::to_string),
        argv: vec!["worker".to_string()],
    }
}

#[test]
fn worker_locks_are_per_version_and_reclaim_a_stale_owner() {
    let base = scratch("lock").join("lock");
    let first = match acquire_worker_lock(&base, Some("1.0.0"), &details(Some("1.0.0"))) {
        LockResult::Acquired(handle) => handle,
        other => panic!("expected the lock, got {other:?}"),
    };
    assert!(versioned_lock_path(&base, Some("1.0.0")).exists());
    match acquire_worker_lock(&base, Some("1.0.0"), &details(Some("1.0.0"))) {
        LockResult::Busy(Some(owner)) => assert_eq!(owner.pid, std::process::id()),
        other => panic!("expected a live owner, got {other:?}"),
    }
    match acquire_worker_lock(&base, Some("2.0.0"), &details(Some("2.0.0"))) {
        LockResult::Acquired(parallel) => parallel.release(),
        other => panic!("a parallel version's lock, got {other:?}"),
    }
    assert!(!versioned_lock_path(&base, Some("2.0.0")).exists());
    first.release();
    assert!(!versioned_lock_path(&base, Some("1.0.0")).exists());

    // A stale lock whose owner is gone is reclaimed.
    let stale = versioned_lock_path(&base, Some("1.0.0"));
    write(
        &stale,
        &format!(
            "{}\n",
            json!({
                "pid": 999_999,
                "startedAt": now_iso(),
                "repo": "/repo",
                "stateDir": "/state",
                "harnessVersion": "1.0.0",
                "argv": [],
                "token": "stale",
            })
        ),
    );
    match acquire_worker_lock(&base, Some("1.0.0"), &details(Some("1.0.0"))) {
        LockResult::Acquired(handle) => handle.release(),
        other => panic!("a stale lock is reclaimed, got {other:?}"),
    }

    // A live legacy lock belongs to the version that wrote it.
    let legacy = match acquire_lock(&base, &details(None)) {
        LockResult::Acquired(handle) => handle,
        other => panic!("the legacy lock, got {other:?}"),
    };
    match acquire_worker_lock(&base, Some("3.0.0"), &details(Some("3.0.0"))) {
        LockResult::Busy(Some(owner)) => assert_eq!(owner.pid, std::process::id()),
        other => panic!("the legacy owner, got {other:?}"),
    }
    legacy.release();
}

#[test]
fn cycle_claims_serialize_across_versions_and_reclaim_a_stale_claim() {
    let path = scratch("claim").join("cycle-claim.json");
    let first = claim_cycle(&path, Some("0.1.1")).expect("the first claim");
    assert!(claim_cycle(&path, Some("0.1.2")).is_none());
    assert_eq!(
        live_cycle_claim(&path).and_then(|claim| claim.harness_version),
        Some("0.1.1".to_string())
    );
    first.release();
    assert!(read_cycle_claim(&path).is_none());

    write(
        &path,
        &format!(
            "{}\n",
            json!({
                "pid": 999_999,
                "startedAt": now_iso(),
                "harnessVersion": null,
                "token": "stale",
            })
        ),
    );
    let reclaimed = claim_cycle(&path, Some("0.1.2")).expect("the reclaimed claim");
    assert_eq!(
        read_cycle_claim(&path).and_then(|claim| claim.harness_version),
        Some("0.1.2".to_string())
    );
    reclaimed.release();
}

#[test]
fn control_commands_are_submitted_in_order_and_consumed_once() {
    let directory = scratch("control").join("control");
    write_watchdog_command(&directory, &WatchdogCommand::Stop).expect("stop");
    write_watchdog_command(&directory, &WatchdogCommand::Drain).expect("drain");
    let settings = WatchdogCommand::Settings {
        interval_minutes: 5,
        max_per_hour: Some(2),
        max_pending: None,
    };
    write_watchdog_command(&directory, &settings).expect("settings");
    let commands = take_watchdog_commands(&directory);
    assert_eq!(
        commands,
        vec![WatchdogCommand::Stop, WatchdogCommand::Drain, settings]
    );
    assert!(take_watchdog_commands(&directory).is_empty());

    write(
        &directory.join("99999999999999-000001.json"),
        "{\"type\":\"bogus\"}",
    );
    assert!(take_watchdog_commands(&directory).is_empty());
    assert!(!directory.join("99999999999999-000001.json").exists());
}

#[test]
fn projection_round_trips_and_drops_unreadable_rows() {
    let directory = scratch("projection");
    let projection = WatchdogProjection {
        state: ProjectionState::Ok,
        at: Some("2026-10-24T12:00:00.000Z".to_string()),
        error: None,
        issues: vec![
            ProjectionIssue {
                url: "https://github.com/acme/fixture/issues/1".to_string(),
                state: ProjectionIssueState::Pending,
                version: None,
            },
            ProjectionIssue {
                url: "https://github.com/acme/fixture/issues/2".to_string(),
                state: ProjectionIssueState::Implemented,
                version: Some("1.0.0".to_string()),
            },
            ProjectionIssue {
                url: "https://github.com/acme/fixture/issues/3".to_string(),
                state: ProjectionIssueState::Unreadable,
                version: None,
            },
        ],
    };
    write_projection(&directory, &projection).expect("the projection");
    assert_eq!(read_projection(&directory), Some(projection));

    write(
        &projection_path(&directory),
        "{\"version\":1,\"state\":\"ok\",\"at\":null,\"error\":null,\"issues\":[{\"url\":\"u\",\"state\":\"unknown\",\"version\":null},{\"url\":\"v\",\"state\":\"pending\"}]}\n",
    );
    let read = read_projection(&directory).expect("the projection");
    assert!(read.issues.is_empty());
    write(
        &projection_path(&directory),
        "{\"version\":2,\"state\":\"ok\",\"at\":null,\"error\":null,\"issues\":[]}\n",
    );
    assert!(read_projection(&directory).is_none());
}

// ---------------------------------------------------------------------------
// Journal retention and cleanup
// ---------------------------------------------------------------------------

#[test]
fn journal_pruning_respects_retention_and_the_total_bound() {
    let key = "a".repeat(24);
    let now = epoch_ms();
    let retention = JOURNAL_RETENTION_MS;

    let state = scratch("prune-retention");
    let directory = state.join("journal");
    std::fs::create_dir_all(&directory).expect("the journal directory");
    let live = directory.join(format!("{key}.jsonl"));
    write(&live, "live");
    set_mtime(&live, now - retention - 60_000);
    let old = directory.join(format!("{key}.jsonl.{}-1", now - retention - 120_000));
    write(&old, "old");
    set_mtime(&old, now - retention - 120_000);
    let boundary = directory.join(format!("{key}.jsonl.{}-2", now - retention));
    write(&boundary, "boundary");
    set_mtime(&boundary, now - retention);
    let removed = prune_journal(&state, now, now, retention, u64::MAX);
    assert_eq!(
        removed,
        vec![old.file_name().unwrap().to_string_lossy().into_owned()]
    );
    assert!(!old.exists());
    assert!(live.exists(), "the live file belongs to its writer");
    assert!(boundary.exists(), "a file at the cutoff is kept");

    let state = scratch("prune-bound");
    let directory = state.join("journal");
    std::fs::create_dir_all(&directory).expect("the journal directory");
    let live = directory.join(format!("{key}.jsonl"));
    write(&live, "0123456789");
    set_mtime(&live, now);
    let first = directory.join(format!("{key}.jsonl.{}-1", now - 3000));
    write(&first, &"a".repeat(100));
    set_mtime(&first, now - 3000);
    let second = directory.join(format!("{key}.jsonl.{}-1", now - 2000));
    write(&second, &"b".repeat(100));
    set_mtime(&second, now - 2000);
    let third = directory.join(format!("{key}.jsonl.{}-1", now - 1000));
    write(&third, &"c".repeat(100));
    set_mtime(&third, now - 1000);
    let in_window = directory.join(format!("{key}.jsonl.{now}-1"));
    write(&in_window, &"d".repeat(100));
    set_mtime(&in_window, now);
    let removed = prune_journal(&state, now, now, retention, 250);
    assert_eq!(
        removed,
        vec![
            first.file_name().unwrap().to_string_lossy().into_owned(),
            second.file_name().unwrap().to_string_lossy().into_owned()
        ]
    );
    assert!(!first.exists());
    assert!(!second.exists());
    assert!(third.exists(), "the bound stops once it fits");
    assert!(in_window.exists(), "evidence inside the window stays");
    assert!(live.exists());
}

#[test]
fn cleanup_removes_old_entries_and_protects_watchdog_state() {
    let root = scratch("cleanup");
    let state = root.join(".tmp");
    std::fs::create_dir_all(&state).expect("a state directory");
    let now = epoch_ms();
    let old = now - CLEANUP_RETENTION_MS - 1000;
    write(&state.join("old.txt"), "old");
    set_mtime(&state.join("old.txt"), old);
    write(&state.join("fresh.txt"), "fresh");
    set_mtime(&state.join("fresh.txt"), now);
    write(&state.join("boundary.txt"), "boundary");
    set_mtime(&state.join("boundary.txt"), now - CLEANUP_RETENTION_MS);
    write(&state.join("old-dir").join("old.txt"), "old");
    set_mtime(&state.join("old-dir").join("old.txt"), old);
    set_mtime(&state.join("old-dir"), old);
    write(&state.join("watchdog").join("state.json"), "{}");
    set_mtime(&state.join("watchdog").join("state.json"), old);
    write(
        &state
            .join("journal")
            .join(format!("{}.jsonl.1000-1", "c".repeat(24))),
        "rotated",
    );
    set_mtime(
        &state
            .join("journal")
            .join(format!("{}.jsonl.1000-1", "c".repeat(24))),
        old,
    );

    let report = sweep_state_dir(&state, now, false, None);
    assert!(!state.join("old.txt").exists());
    assert!(!state.join("old-dir").exists());
    assert!(state.join("fresh.txt").exists());
    assert!(state.join("boundary.txt").exists());
    assert!(state.join("watchdog").join("state.json").exists());
    assert!(state
        .join("journal")
        .join(format!("{}.jsonl.1000-1", "c".repeat(24)))
        .exists());
    assert_eq!(report.files, 2);
    assert_eq!(report.directories, 1);
    assert_eq!(report.bytes, 6);
    assert!(report.errors.is_empty(), "{:?}", report.errors);

    let dry_state = root.join("dry");
    std::fs::create_dir_all(&dry_state).expect("a dry state directory");
    write(&dry_state.join("old.txt"), "old");
    set_mtime(&dry_state.join("old.txt"), old);
    let dry = sweep_state_dir(&dry_state, now, true, None);
    assert!(dry_state.join("old.txt").exists());
    assert!(dry.removed.is_empty());
    assert_eq!(
        dry.candidates
            .iter()
            .map(|candidate| candidate.path.clone())
            .collect::<Vec<PathBuf>>(),
        vec![dry_state.join("old.txt")]
    );
    assert_eq!(dry.bytes, 3);
}

// ---------------------------------------------------------------------------
// Reaper
// ---------------------------------------------------------------------------

#[test]
fn reaper_decisions_protect_live_leases_and_report_scratch_orphans() {
    let root = scratch("reaper");
    let state_dir = root.join(".devboard").join(".tmp");
    std::fs::create_dir_all(&state_dir).expect("a state directory");
    let protected_pid = 555_555u32;
    let orphan_pid = 444_444u32;

    let run_root = state_dir
        .join("runs")
        .join(devboard::journal::journal_key(&root))
        .join("lane")
        .join("record");
    write(
        &run_root.join("state.json"),
        &format!(
            "{}\n",
            json!({"owner": {"pid": protected_pid}, "peer": null, "status": "running"})
        ),
    );
    // A fresh handoff still belongs to the replacement, which is what protects
    // the run's owner for the grace period.
    write(
        &state_dir
            .join("runs")
            .join(devboard::journal::journal_key(&root))
            .join("handoff.json"),
        &format!("{}\n", json!({"at": epoch_ms(), "pid": 999_999})),
    );

    let scratch_cwd = state_dir.join("scratch");
    std::fs::create_dir_all(&scratch_cwd).expect("scratch");
    let candidate = |pid: u32| ProcessSnapshot {
        pid,
        cmdline: format!("{}/server/run-owner.ts", root.join(".devboard").display()),
        env: HashMap::new(),
        cwd: Some(scratch_cwd.clone()),
        ancestors: Vec::new(),
    };
    let mut options = OrphanReaperRunOptions::new(root.clone());
    options.state_dir = Some(state_dir.clone());
    options.dry_run = true;
    options.instances = Some(Vec::new());
    options.processes = Some(vec![candidate(orphan_pid), candidate(protected_pid)]);
    options.alive = Some(Box::new(move |pid| {
        pid == orphan_pid || pid == protected_pid
    }));
    options.orphan_grace_ms = Some(0);
    let report = run_orphan_reaper(options);

    assert!(report.available);
    assert!(report.killed.is_empty(), "a dry run signals nothing");
    let orphan = report
        .decisions
        .iter()
        .find(|decision| decision.pid == orphan_pid)
        .expect("the orphan decision");
    assert_eq!(orphan.action, devboard::supervision::ReapAction::WouldKill);
    assert_eq!(orphan.reason, devboard::supervision::ReapReason::Scratch);
    let protected = report
        .decisions
        .iter()
        .find(|decision| decision.pid == protected_pid)
        .expect("the protected decision");
    assert_eq!(protected.action, devboard::supervision::ReapAction::Skipped);

    let log = std::fs::read_to_string(state_dir.join("supervision").join("reaped.jsonl"))
        .expect("the reaper journal");
    assert!(log.contains(&format!("\"pid\":{orphan_pid}")));
    assert!(log.contains("\"action\":\"would-kill\""));
    assert!(log.contains("\"action\":\"skipped\""));
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

#[test]
fn a_full_cycle_files_each_finding_and_writes_its_reports() {
    let root = production_root("cycle");
    let state_dir = root.join(".devboard").join(".tmp").join(WATCHDOG_DIRECTORY);
    std::fs::create_dir_all(&state_dir).expect("a watchdog state");
    let instance = fixture_instance(&root, &root.join(".devboard").join(".tmp"));
    let now = epoch_ms();
    let events = vec![
        event(
            now,
            1,
            "Synthetic error: ENOTFOUND one",
            "server-error",
            &instance,
        ),
        event(
            now,
            2,
            "Synthetic error: ENOTFOUND two",
            "server-error",
            &instance,
        ),
    ];
    let stub = root.join("dedup-stub.json");
    write(
        &stub,
        &format!(
            "{}\n",
            json!({
                "decisions": [{"fingerprint": "*", "action": "filed", "url": "https://github.com/acme/fixture/issues/7"}],
                "reads": 1,
            })
        ),
    );
    // An old rotated journal and an old scratch file prove the cycle prunes
    // and sweeps before it collects.
    let canonical_state = root.join(".devboard").join(".tmp");
    let rotated = canonical_state
        .join("journal")
        .join(format!("{}.jsonl.1000-1", "d".repeat(24)));
    write(&rotated, "rotated");
    set_mtime(&rotated, now - JOURNAL_RETENTION_MS - 60_000);
    let old_file = canonical_state.join("old-run").join("stdout.log");
    write(&old_file, "old");
    set_mtime(&old_file, now - CLEANUP_RETENTION_MS - 60_000);

    let delivery = Arc::new(RecordingDelivery::new());
    let deps = CycleDeps {
        discover: Arc::new(move |_root: &Path| vec![instance.clone()]),
        collect: Arc::new(
            move |_root: &Path, _instances: &[Instance], _window: Window| Collection {
                events: events.clone(),
                malformed: 0,
                unattributed: 0,
            },
        ),
        gh: Arc::new(|_argv: &[String], _stdin: &str| GhOutcome::default()),
        delivery: Some(delivery.clone()),
        dedup: Some(Arc::new(StubDedup::new(stub))),
    };
    let mut options = CycleOptions::new(root.clone());
    options.state_dir = Some(state_dir.clone());
    options.now_ms = now;
    let result = run_cycle(&options, &deps).expect("the cycle");

    assert_eq!(result.report.action(), "filed");
    assert_eq!(result.report.issues().len(), 2);
    assert_eq!(result.exit_code, 0);
    assert_eq!(
        result.report.value["deduplication"]["openIssuesRead"],
        json!(1)
    );
    assert!(!rotated.exists(), "the cycle pruned an old rotated journal");
    assert!(!old_file.exists(), "the cycle swept an old scratch file");

    let ledger = load_ledger(&state_dir);
    assert!(ledger.pending_filing.is_empty());
    assert_eq!(ledger.findings.len(), 2);
    assert!(ledger
        .findings
        .iter()
        .all(|(_, entry)| entry.disposition.starts_with("filed:")));
    let ledger_text = std::fs::read_to_string(ledger_path(&state_dir)).expect("the ledger");
    assert!(ledger_text.contains("\"version\": 2"));

    let run_dir = result.run_dir.expect("the run directory");
    let report_text = std::fs::read_to_string(run_dir.join("report.json")).expect("the report");
    assert_eq!(
        report_text,
        std::fs::read_to_string(latest_path(&state_dir)).expect("the latest report")
    );
    let report: Value = serde_json::from_str(&report_text).expect("report JSON");
    assert_eq!(report["action"], json!("filed"));
    assert_eq!(report["findings"].as_array().map(Vec::len), Some(2));
    let markdown = std::fs::read_to_string(run_dir.join("report.md")).expect("the markdown");
    assert!(markdown.starts_with("# Watchdog cycle "));
    assert!(markdown.contains("- Action: filed"));
    let log = std::fs::read_to_string(run_dir.join("coordinator.log")).expect("the log");
    assert!(log.contains("discovered 1 instance(s)"));
}

#[test]
fn a_dry_run_cycle_changes_nothing() {
    let root = production_root("cycle-dry");
    let state_dir = root.join(".devboard").join(".tmp").join(WATCHDOG_DIRECTORY);
    let instance = fixture_instance(&root, &root.join(".devboard").join(".tmp"));
    let now = epoch_ms();
    let events = vec![event(now, 1, "Synthetic error", "server-error", &instance)];
    let old_file = root
        .join(".devboard")
        .join(".tmp")
        .join("old-run")
        .join("stdout.log");
    write(&old_file, "old");
    set_mtime(&old_file, now - CLEANUP_RETENTION_MS - 60_000);
    let deps = CycleDeps {
        discover: Arc::new(move |_root: &Path| vec![instance.clone()]),
        collect: Arc::new(
            move |_root: &Path, _i: &[Instance], _w: Window| Collection {
                events: events.clone(),
                malformed: 0,
                unattributed: 0,
            },
        ),
        gh: Arc::new(|_argv: &[String], _stdin: &str| GhOutcome::default()),
        delivery: None,
        dedup: None,
    };
    let mut options = CycleOptions::new(root.clone());
    options.state_dir = Some(state_dir.clone());
    options.now_ms = now;
    options.dry_run = true;
    let result = run_cycle(&options, &deps).expect("the dry run");

    assert!(result.run_dir.is_none());
    assert!(old_file.exists(), "a dry run deletes nothing");
    assert!(!latest_path(&state_dir).exists());
    assert!(!ledger_path(&state_dir).exists());
    assert_eq!(result.report.action(), "none");
    assert!(result.report.reason().unwrap_or("").contains("dry run"));
    assert_eq!(result.report.value["cleanup"]["dryRun"], json!(true));
    let candidates = result.report.value["cleanup"]["roots"][0]["candidates"]
        .as_array()
        .expect("candidates");
    assert!(candidates
        .iter()
        .any(|candidate| candidate["path"] == json!(old_file.to_string_lossy())));
}

#[test]
fn filing_caps_limit_the_room_and_keep_the_rest_pending() {
    let root = production_root("caps");
    let state_dir = root.join(".devboard").join(".tmp").join(WATCHDOG_DIRECTORY);
    std::fs::create_dir_all(&state_dir).expect("a watchdog state");
    let instance = fixture_instance(&root, &root.join(".devboard").join(".tmp"));
    let now = epoch_ms();
    let events = vec![
        event(now, 1, "first capped error", "server-error", &instance),
        event(now, 2, "second capped error", "server-error", &instance),
    ];
    let rooms = Arc::new(RoomDedup::new());
    let deps = CycleDeps {
        discover: Arc::new(move |_root: &Path| vec![instance.clone()]),
        collect: Arc::new(
            move |_root: &Path, _i: &[Instance], _w: Window| Collection {
                events: events.clone(),
                malformed: 0,
                unattributed: 0,
            },
        ),
        gh: Arc::new(|_argv: &[String], _stdin: &str| GhOutcome::default()),
        delivery: Some(Arc::new(RecordingDelivery::new())),
        dedup: Some(rooms.clone()),
    };
    write_projection(
        &state_dir,
        &WatchdogProjection {
            state: ProjectionState::Ok,
            at: Some(iso_from_ms(now)),
            error: None,
            issues: Vec::new(),
        },
    )
    .expect("the projection");
    let settings = WatchdogSettings {
        interval_minutes: 10,
        max_per_hour: Some(1),
        max_pending: None,
    };
    let mut options = CycleOptions::new(root.clone());
    options.state_dir = Some(state_dir.clone());
    options.now_ms = now;
    options.settings = Some(settings.clone());
    let first = run_cycle(&options, &deps).expect("the first cycle");
    assert_eq!(first.report.issues().len(), 1);
    assert_eq!(load_ledger(&state_dir).pending_filing.len(), 1);

    let second = run_cycle(&options, &deps).expect("the second cycle");
    assert!(second.report.issues().is_empty());
    assert_eq!(second.report.action(), "capped");
    assert_eq!(load_ledger(&state_dir).pending_filing.len(), 1);
    assert_eq!(*rooms.rooms.lock().expect("rooms"), vec![1, 0]);
}

// ---------------------------------------------------------------------------
// Multi-version coexistence
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drained_worker_finishes_its_cycle_and_releases_its_lock() {
    let root = scratch("drain");
    std::fs::create_dir_all(root.join(".devboard")).expect("a harness");
    let state_dir = root.join("watchdog");
    std::fs::create_dir_all(&state_dir).expect("a watchdog state");
    write_watchdog_settings(
        &state_dir,
        &WatchdogSettings {
            interval_minutes: 1440,
            max_per_hour: None,
            max_pending: None,
        },
    )
    .expect("settings");

    let cycles = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(AtomicBool::new(false));
    let (gate_sender, gate_receiver) = std::sync::mpsc::channel::<()>();
    let gate = Arc::new(Mutex::new(gate_receiver));
    let cycle: CycleRunner = {
        let cycles = cycles.clone();
        let started = started.clone();
        let gate = gate.clone();
        Arc::new(
            move |_request: &CycleRunRequest| -> anyhow::Result<Report> {
                cycles.fetch_add(1, Ordering::SeqCst);
                started.store(true, Ordering::SeqCst);
                let receiver = gate.lock().expect("the gate");
                let _ = receiver.recv();
                Ok(Report {
                    value: json!({"action": "none"}),
                })
            },
        )
    };
    let supervisor = |_root: &Path, _state_dir: &Path, _interval: u64| {
        devboard::supervision::start_orphan_supervisor(
            devboard::supervision::OrphanSupervisorOptions::new(|| {}),
        )
    };

    let old_worker = {
        let mut options =
            WatchdogWorkerOptions::new(root.clone(), state_dir.clone(), root.join("state"));
        options.harness_version = Some("0.1.1".to_string());
        options.cycle = Some(cycle.clone());
        options.supervisor = Some(Arc::new(supervisor));
        options.poll_ms = 20;
        tokio::spawn(run_worker(options))
    };
    for _ in 0..500 {
        if started.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(started.load(Ordering::SeqCst), "the first cycle started");

    let new_worker = {
        let mut options =
            WatchdogWorkerOptions::new(root.clone(), state_dir.clone(), root.join("state"));
        options.harness_version = Some("0.1.2".to_string());
        options.cycle = Some(cycle.clone());
        options.supervisor = Some(Arc::new(supervisor));
        options.poll_ms = 20;
        tokio::spawn(run_worker(options))
    };
    let new_directory = versioned_worker_directory(&state_dir, Some("0.1.2"));
    for _ in 0..500 {
        if worker_state_path(&new_directory).exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(cycles.load(Ordering::SeqCst), 1, "one cycle per window");
    assert_eq!(
        read_cycle_claim(&cycle_claim_path(&state_dir)).and_then(|claim| claim.harness_version),
        Some("0.1.1".to_string())
    );
    let old_state = read_worker_state(&versioned_worker_directory(&state_dir, Some("0.1.1")))
        .expect("the old state");
    let new_state = read_worker_state(&new_directory).expect("the new state");
    assert_eq!(old_state.lifecycle, AgentLifecycle::Running);
    assert_eq!(new_state.lifecycle, AgentLifecycle::Running);
    assert_eq!(new_state.last_run_at, old_state.last_run_at);
    assert!(versioned_lock_path(&lock_path(&state_dir), Some("0.1.1")).exists());
    assert!(versioned_lock_path(&lock_path(&state_dir), Some("0.1.2")).exists());

    write_watchdog_command(
        &versioned_control_directory(&state_dir, Some("0.1.1")),
        &WatchdogCommand::Drain,
    )
    .expect("the drain command");
    gate_sender.send(()).expect("the gate");
    old_worker.await.expect("the old worker");
    assert_eq!(cycles.load(Ordering::SeqCst), 1);
    let drained = read_worker_state(&versioned_worker_directory(&state_dir, Some("0.1.1")))
        .expect("the drained state");
    assert_eq!(drained.lifecycle, AgentLifecycle::Stopped);
    assert!(drained.draining);
    assert!(!versioned_lock_path(&lock_path(&state_dir), Some("0.1.1")).exists());
    assert!(read_cycle_claim(&cycle_claim_path(&state_dir)).is_none());
    assert!(versioned_lock_path(&lock_path(&state_dir), Some("0.1.2")).exists());

    write_watchdog_command(
        &versioned_control_directory(&state_dir, Some("0.1.2")),
        &WatchdogCommand::Stop,
    )
    .expect("the stop command");
    new_worker.await.expect("the new worker");
    assert!(!versioned_lock_path(&lock_path(&state_dir), Some("0.1.2")).exists());
}

// ---------------------------------------------------------------------------
// CLI exit semantics
// ---------------------------------------------------------------------------

#[test]
fn the_cli_exits_two_for_missing_prerequisites_and_bad_flags() {
    let root = scratch("cli-missing");
    let binary = env!("CARGO_BIN_EXE_devboard");
    let output = std::process::Command::new(binary)
        .args(["worker", "watchdog", "--repo"])
        .arg(&root)
        .arg("--state-dir")
        .arg(root.join("state"))
        .output()
        .expect("the binary");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("missing prerequisite"));

    std::fs::create_dir_all(root.join(".devboard")).expect("a harness");
    let output = std::process::Command::new(binary)
        .args(["worker", "watchdog", "--repo"])
        .arg(&root)
        .arg("--state-dir")
        .arg(root.join("state"))
        .arg("--collect")
        .output()
        .expect("the binary");
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--collect runs with --dry-run"));
}
