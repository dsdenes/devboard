//! Manual cleanup and legacy watchdog removal.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use devboard::providers::{agent_directory, ProviderId};
use devboard::workers::builds::{run_build_cleanup_with, BuildCandidateKind, TargetLock};
use devboard::workers::watchdog::{
    apparent_tree_bytes, covered_state_dirs, epoch_ms, run_cleanup, run_cleanup_with,
    sweep_state_dir_with, CleanupSource, CoveredStateDir, Instance, ProviderRetention,
    PROVIDER_FLOOR_MS, PROVIDER_RETENTION_MS,
};
use devboard::workers::worktrees::{run_worktree_cleanup, WorktreeCandidateKind};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn root(label: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("cleanup-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::canonicalize(&path).unwrap()
}

#[test]
fn a_dry_run_reports_and_a_real_pass_sweeps_with_retention_exceptions() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let directory = root("sweep");
    let state = directory.join("state");
    let repo = directory.join("repo");
    std::fs::create_dir_all(state.join("providers")).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    let old = state.join("stale.log");
    std::fs::write(&old, b"old").unwrap();
    let credentials = state.join("providers/credentials.json");
    std::fs::write(&credentials, b"{}").unwrap();
    let ancient = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86_400);
    let file = std::fs::OpenOptions::new().write(true).open(&old).unwrap();
    file.set_modified(ancient).unwrap();

    let dry = devboard::workers::watchdog::run_cleanup(
        &repo,
        1_800_000_000_000,
        true,
        &[],
        Some(&[devboard::workers::watchdog::CoveredStateDir {
            state_dir: state.clone(),
            source: devboard::workers::watchdog::CleanupSource::Canonical,
        }]),
        None,
    );
    assert!(!dry.roots[0].candidates.is_empty());
    assert!(old.exists(), "a dry run changes nothing");

    let real = devboard::workers::watchdog::run_cleanup(
        &repo,
        1_800_000_000_000,
        false,
        &[],
        Some(&[devboard::workers::watchdog::CoveredStateDir {
            state_dir: state.clone(),
            source: devboard::workers::watchdog::CleanupSource::Canonical,
        }]),
        None,
    );
    assert!(!real.roots[0].removed.is_empty());
    assert!(!old.exists(), "an old file is swept");
    assert!(credentials.exists(), "provider credentials are retained");
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn complexity_and_worker_state_survive_every_sweep() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let directory = root("durable");
    let state = directory.join("state");
    let repo = directory.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let key = "0123456789abcdef01234567";
    let ancient = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86_400);
    let mut retained = Vec::new();
    for name in [
        "complexity",
        "api-standards",
        "dead-code",
        "single-responsibility",
        "consistent-naming",
        "mcp-optimizer",
        "release-train",
    ] {
        let file = state.join(name).join(key).join("2026-01-01.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"{}").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(ancient)
            .unwrap();
        retained.push(file);
    }
    let covered = [devboard::workers::watchdog::CoveredStateDir {
        state_dir: state.clone(),
        source: devboard::workers::watchdog::CleanupSource::Canonical,
    }];
    let dry = devboard::workers::watchdog::run_cleanup(
        &repo,
        1_800_000_000_000,
        true,
        &[],
        Some(&covered),
        None,
    );
    for file in &retained {
        assert!(
            !dry.roots[0]
                .candidates
                .iter()
                .any(|candidate| &candidate.path == file),
            "{} is a cleanup candidate",
            file.display()
        );
    }
    devboard::workers::watchdog::run_cleanup(
        &repo,
        1_800_000_000_000,
        false,
        &[],
        Some(&covered),
        None,
    );
    for file in &retained {
        assert!(file.exists(), "{} was swept", file.display());
    }
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn uninstall_removes_the_legacy_unit_and_timer() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let directory = root("units");
    std::env::set_var("DEVBOARD_SYSTEMD_USER_DIR", &directory);
    let timer = directory.join("devboard-watchdog.timer");
    let service = directory.join("devboard-watchdog.service");
    std::fs::write(&timer, "[Timer]\n").unwrap();
    std::fs::write(&service, "[Service]\n").unwrap();
    devboard::workers::watchdog::uninstall_legacy_units();
    std::env::remove_var("DEVBOARD_SYSTEMD_USER_DIR");
    assert!(!timer.exists(), "the timer is removed");
    assert!(!service.exists(), "the unit is removed");
    let _ = std::fs::remove_dir_all(&directory);
}

// ---------------------------------------------------------------------------
// Fixtures shared by the retention tests
// ---------------------------------------------------------------------------

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;

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

fn write_bytes(path: &Path, bytes: usize) -> Vec<u8> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("a fixture parent");
    }
    let data = vec![b'x'; bytes];
    std::fs::write(path, &data).expect("a fixture file");
    data
}

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("a fixture parent");
    }
    std::fs::write(path, text).expect("a fixture file");
}

fn git(directory: &Path, args: &[&str]) -> String {
    git_with_env(directory, args, &[])
}

fn git_with_env(directory: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
    let mut command = Command::new("git");
    command.arg("-C").arg(directory).args(args);
    for (name, value) in env {
        command.env(name, value);
    }
    let output = command.output().expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn init_repo(root: &Path) {
    std::fs::create_dir_all(root).expect("a fixture root");
    git(root, &["init", "-q", "."]);
    git(root, &["config", "user.email", "test@example.com"]);
    git(root, &["config", "user.name", "Test"]);
    write_text(&root.join("tracked.txt"), "one\n");
    git(root, &["add", "tracked.txt"]);
    git(root, &["commit", "-qm", "initial"]);
    git(root, &["branch", "-m", "main"]);
}

fn add_worktree(root: &Path, name: &str, branch: &str) -> PathBuf {
    let path = root.join(".worktree").join(name);
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            path.to_str().expect("a utf-8 path"),
            "-b",
            branch,
        ],
    );
    path
}

/// A worktree whose administrative entry has moved aside: `git worktree list`
/// no longer names it, while git commands inside it still work.
fn unregistered_worktree(root: &Path, name: &str, branch: &str) -> PathBuf {
    let path = add_worktree(root, name, branch);
    let admin = root.join(".git").join("worktrees").join(name);
    let moved = root
        .join(".devboard")
        .join(".test-tmp")
        .join(format!("{name}-admin"));
    std::fs::create_dir_all(moved.parent().expect("a parent")).expect("an admin parent");
    std::fs::rename(&admin, &moved).expect("a moved admin");
    std::fs::write(
        moved.join("gitdir"),
        format!("gitdir: {}\n", path.join(".git").display()),
    )
    .expect("a gitdir");
    std::fs::write(
        moved.join("commondir"),
        format!("{}\n", root.join(".git").display()),
    )
    .expect("a commondir");
    std::fs::write(path.join(".git"), format!("gitdir: {}\n", moved.display()))
        .expect("a worktree gitdir");
    path
}

fn instance(repo: &Path) -> Instance {
    Instance {
        pid: 4040,
        port: 4747,
        repo_dir: repo.to_string_lossy().into_owned(),
        host: "127.0.0.1".to_string(),
        harness: repo.join(".devboard").to_string_lossy().into_owned(),
        state_dir: repo.join(".devboard/.tmp").to_string_lossy().into_owned(),
        journal: String::new(),
        instrumented: true,
        legacy_log: None,
    }
}

fn credentials_with(id: &str) -> String {
    format!(
        "{{\"version\":1,\"subscriptions\":[{{\"id\":\"{id}\",\"provider\":\"opencode-go\",\"enabled\":true}}]}}\n"
    )
}

fn paths_of<'a>(
    candidates: impl Iterator<Item = &'a devboard::workers::watchdog::CleanupCandidate>,
) -> Vec<PathBuf> {
    candidates.map(|candidate| candidate.path.clone()).collect()
}

// ---------------------------------------------------------------------------
// State-directory retention
// ---------------------------------------------------------------------------

#[test]
fn worktree_state_directories_are_covered_and_swept_once() {
    let directory = root("worktree-state");
    let repo = directory.join("repo");
    std::fs::create_dir_all(&repo).expect("a repository");
    let now = epoch_ms();
    let old = now - 8 * DAY_MS;
    let alpha = repo.join(".worktree/alpha/.devboard/.tmp/old.log");
    let beta = repo.join(".worktree/beta/.devboard/.tmp/old.log");
    for path in [&alpha, &beta] {
        write_text(path, "old");
        set_mtime(path, old);
    }

    let covered = covered_state_dirs(&repo, &[]);
    let worktree_dirs: Vec<&CoveredStateDir> = covered
        .iter()
        .filter(|entry| entry.source == CleanupSource::Worktree)
        .collect();
    assert_eq!(worktree_dirs.len(), 2, "{covered:?}");
    let unique: std::collections::HashSet<&PathBuf> =
        worktree_dirs.iter().map(|entry| &entry.state_dir).collect();
    assert_eq!(unique.len(), 2, "each real path is listed once");

    let dry = run_cleanup(&repo, now, true, &[], Some(&covered), None);
    let candidates: Vec<PathBuf> = dry
        .roots
        .iter()
        .flat_map(|entry| paths_of(entry.candidates.iter()))
        .collect();
    assert!(candidates.contains(&alpha));
    assert!(candidates.contains(&beta));
    assert!(alpha.exists() && beta.exists(), "a dry run changes nothing");

    let real = run_cleanup(&repo, now, false, &[], Some(&covered), None);
    let removed: Vec<PathBuf> = real
        .roots
        .iter()
        .flat_map(|entry| paths_of(entry.removed.iter()))
        .collect();
    assert!(removed.contains(&alpha));
    assert!(removed.contains(&beta));
    assert!(
        !alpha.exists() && !beta.exists(),
        "a real pass removes them"
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn provider_transcripts_sibling_directories_and_blobs_follow_the_retention_rule() {
    let directory = root("providers");
    let state = directory.join("state");
    let id = "11111111-2222-3333-4444-555555555555";
    let agents = state
        .join("providers/agents")
        .join(format!("opencode-go-{id}"));
    let project = agents.join("sessions/project");
    let now = epoch_ms();
    let old = now - 8 * DAY_MS;
    let fresh = now - HOUR_MS;

    let old_transcript = project.join("old.jsonl");
    let old_sibling = project.join("old");
    let old_payload = old_sibling.join("payload");
    let fresh_transcript = project.join("fresh.jsonl");
    let fresh_sibling = project.join("fresh");
    let fresh_payload = fresh_sibling.join("payload");
    let old_blob = agents.join("blobs/old.bin");
    let fresh_blob = agents.join("blobs/fresh.bin");
    for (path, mtime) in [
        (&old_transcript, old),
        (&old_payload, old),
        (&fresh_transcript, fresh),
        (&fresh_payload, fresh),
        (&old_blob, old),
        (&fresh_blob, fresh),
    ] {
        write_bytes(path, 8);
        set_mtime(path, mtime);
    }
    write_text(
        &state.join("providers/credentials.json"),
        &credentials_with(id),
    );

    let retention = ProviderRetention::default();
    let dry = sweep_state_dir_with(&state, now, true, None, &retention);
    let candidates: Vec<PathBuf> = paths_of(dry.candidates.iter());
    for path in [&old_transcript, &old_sibling, &old_blob] {
        assert!(
            candidates.contains(path),
            "{} is not a candidate",
            path.display()
        );
    }
    for path in [&fresh_transcript, &fresh_sibling, &fresh_blob] {
        assert!(
            !candidates.contains(path),
            "{} is a candidate",
            path.display()
        );
    }
    assert!(old_transcript.exists(), "a dry run changes nothing");

    let real = sweep_state_dir_with(&state, now, false, None, &retention);
    assert!(!old_transcript.exists());
    assert!(!old_sibling.exists());
    assert!(!old_blob.exists());
    assert!(fresh_transcript.exists());
    assert!(fresh_sibling.exists());
    assert!(fresh_blob.exists());
    assert!(real
        .removed
        .iter()
        .any(|entry| entry.path == old_transcript));
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn provider_floors_keep_young_files_and_the_newest_thousand_transcripts() {
    let directory = root("providers-floors");
    let state = directory.join("state");
    let id = "22222222-3333-4444-5555-666666666666";
    let agents = state
        .join("providers/agents")
        .join(format!("opencode-go-{id}"));
    let project = agents.join("sessions/project");
    let now = epoch_ms();
    let mut transcripts = Vec::new();
    for index in 0..1005i64 {
        let path = project.join(format!("s{index:04}.jsonl"));
        write_bytes(&path, 2);
        // The newest 1,000 are indices 0..999.
        set_mtime(&path, now - PROVIDER_RETENTION_MS - 60_000 - index * 1000);
        transcripts.push(path);
    }
    let young_transcript = project.join("young.jsonl");
    let young_blob = agents.join("blobs/young.bin");
    write_bytes(&young_transcript, 2 * 1024 * 1024);
    set_mtime(&young_transcript, now - HOUR_MS);
    write_bytes(&young_blob, 2 * 1024 * 1024);
    set_mtime(&young_blob, now - HOUR_MS);
    write_text(
        &state.join("providers/credentials.json"),
        &credentials_with(id),
    );

    let retention = ProviderRetention {
        max_bytes: 1,
        ..ProviderRetention::default()
    };
    sweep_state_dir_with(&state, now, false, None, &retention);
    // The young transcript ranks first, so the newest 1,000 are `young` and
    // indices 0..998; indices 999..1004 are outside the floor.
    assert!(young_transcript.exists(), "the newest transcript stays");
    for (index, path) in transcripts.iter().enumerate().take(999) {
        assert!(
            path.exists(),
            "transcript {index} is inside the newest-1,000 floor"
        );
    }
    for (index, path) in transcripts.iter().enumerate().skip(999) {
        assert!(
            !path.exists(),
            "transcript {index} is older than the floor and the cutoff"
        );
    }
    assert!(young_blob.exists(), "the 24-hour floor holds for a blob");
    assert!(apparent_tree_bytes(&agents) > retention.max_bytes);
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn provider_cap_evicts_the_oldest_units_until_the_tree_fits() {
    let directory = root("providers-cap");
    let state = directory.join("state");
    let id = "33333333-4444-5555-6666-777777777777";
    let agents = state
        .join("providers/agents")
        .join(format!("opencode-go-{id}"));
    let project = agents.join("sessions/project");
    let now = epoch_ms();
    let mut transcripts = Vec::new();
    for index in 0..1005i64 {
        let path = project.join(format!("s{index:04}.jsonl"));
        write_bytes(&path, 1000);
        // Every unit is outside the 24-hour floor and inside the age window;
        // only ranks at or beyond 1,000 are evictable by the cap.
        set_mtime(&path, now - 2 * DAY_MS - index * 1000);
        transcripts.push(path);
    }
    write_text(
        &state.join("providers/credentials.json"),
        &credentials_with(id),
    );

    let agents_root = state.join("providers/agents");
    let before = apparent_tree_bytes(&agents_root);
    let cap = before - 2_500;
    let retention = ProviderRetention {
        max_bytes: cap,
        ..ProviderRetention::default()
    };
    let report = sweep_state_dir_with(&state, now, false, None, &retention);
    for (index, path) in transcripts.iter().enumerate().take(1002) {
        assert!(path.exists(), "the newest unit {index} must survive");
    }
    for path in transcripts.iter().skip(1002) {
        assert!(!path.exists(), "the oldest units are evicted");
    }
    assert!(apparent_tree_bytes(&agents_root) <= cap, "the cap holds");
    assert!(report.removed.len() >= 3);
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn providers_orphan_selection_directories_follow_the_credentials_rule() {
    let directory = root("providers-orphans");
    let state = directory.join("state");
    let agents = state.join("providers/agents");
    let now = epoch_ms();
    let old = now - 8 * DAY_MS;
    let fresh = now - HOUR_MS;
    let known = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    let known_dir = agents.join(format!("opencode-go-{known}"));
    let dedup_dir = agents.join(format!("opencode-go-{known}-watchdog-dedup"));
    let orphan = agents.join("opencode-go-unknown");
    let fresh_orphan = agents.join("opencode-go-fresh-orphan");
    for path in [&known_dir, &dedup_dir, &orphan, &fresh_orphan] {
        write_bytes(&path.join("config.yml"), 8);
    }
    set_mtime(&known_dir.join("config.yml"), old);
    set_mtime(&dedup_dir.join("config.yml"), old);
    set_mtime(&orphan.join("config.yml"), old);
    set_mtime(&fresh_orphan.join("config.yml"), fresh);
    write_text(
        &state.join("providers/credentials.json"),
        &credentials_with(known),
    );

    sweep_state_dir_with(&state, now, false, None, &ProviderRetention::default());
    assert!(
        known_dir.exists(),
        "a matching subscription is never removed"
    );
    assert!(
        dedup_dir.exists(),
        "a trailing -watchdog-dedup does not orphan a matching directory"
    );
    assert!(!orphan.exists(), "an old unmatched directory is removed");
    assert!(
        fresh_orphan.exists(),
        "a directory holding a file younger than 24 hours stays"
    );

    // The directory name is the sanitized id, so an id that needs sanitizing
    // still names its live selection directory.
    let sanitized = directory.join("sanitized");
    let sanitized_state = sanitized.join("state");
    let sanitized_id = "id+with/slash";
    let sanitized_dir = agent_directory(&sanitized_state, ProviderId::OpenCodeGo, sanitized_id);
    write_bytes(&sanitized_dir.join("config.yml"), 8);
    write_bytes(&sanitized_dir.join("agent.db"), 8);
    set_mtime(
        &sanitized_dir.join("config.yml"),
        now - PROVIDER_FLOOR_MS - HOUR_MS,
    );
    set_mtime(
        &sanitized_dir.join("agent.db"),
        now - PROVIDER_FLOOR_MS - HOUR_MS,
    );
    let sanitized_orphan = sanitized_state.join("providers/agents/opencode-go-unknown");
    write_bytes(&sanitized_orphan.join("config.yml"), 8);
    set_mtime(&sanitized_orphan.join("config.yml"), old);
    let sanitized_dedup = sanitized_state.join(format!(
        "{}-watchdog-dedup",
        sanitized_dir.file_name().unwrap().to_string_lossy()
    ));
    write_bytes(&sanitized_dedup.join("config.yml"), 8);
    set_mtime(&sanitized_dedup.join("config.yml"), old);
    write_text(
        &sanitized_state.join("providers/credentials.json"),
        &credentials_with(sanitized_id),
    );
    sweep_state_dir_with(
        &sanitized_state,
        now,
        false,
        None,
        &ProviderRetention::default(),
    );
    assert!(
        sanitized_dir.exists(),
        "a live subscription whose id needs sanitizing is never removed"
    );
    assert!(
        sanitized_dedup.exists(),
        "the dedup suffix strips before the sanitized id matches"
    );
    assert!(
        !sanitized_orphan.exists(),
        "an old unmatched directory is still removed"
    );

    // A missing credentials file removes none.
    let missing = directory.join("missing");
    let missing_orphan = missing.join("providers/agents/opencode-go-unknown/config.yml");
    write_bytes(&missing_orphan, 8);
    set_mtime(&missing_orphan, old);
    sweep_state_dir_with(&missing, now, false, None, &ProviderRetention::default());
    assert!(missing_orphan.exists(), "missing credentials remove none");

    // An unparseable credentials file removes none.
    let unparseable = directory.join("unparseable");
    let unparseable_orphan = unparseable.join("providers/agents/opencode-go-unknown/config.yml");
    write_bytes(&unparseable_orphan, 8);
    set_mtime(&unparseable_orphan, old);
    write_text(
        &unparseable.join("providers/credentials.json"),
        "not json\n",
    );
    sweep_state_dir_with(
        &unparseable,
        now,
        false,
        None,
        &ProviderRetention::default(),
    );
    assert!(
        unparseable_orphan.exists(),
        "unparseable credentials remove none"
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn durable_provider_and_worker_state_survives_every_sweep() {
    let directory = root("durable-state");
    let repo = directory.join("repo");
    let state = repo.join("state");
    let id = "44444444-5555-6666-7777-888888888888";
    let selection = format!("providers/agents/opencode-go-{id}");
    let mut retained = Vec::new();
    let mut names = vec![
        format!("{selection}/agent.db"),
        format!("{selection}/agent.db-wal"),
        format!("{selection}/models.db"),
        format!("{selection}/models.db-wal"),
        format!("{selection}/skill-descriptions.db"),
        format!("{selection}/config.yml"),
        format!("{selection}/mcp.json"),
        format!("{selection}/devboard-mcp.ts"),
        "state/repository.json".to_string(),
        format!("journal/{}.jsonl.1000-1", "a".repeat(24)),
        "issues/1.json".to_string(),
        "flow/1.json".to_string(),
        "coach/state.json".to_string(),
        "goal-drafts/draft/status.json".to_string(),
        "watchdog/state.json".to_string(),
        "watchdog/latest.json".to_string(),
        "watchdog/control/0001.json".to_string(),
        "watchdog/workers/v1/worker.json".to_string(),
        "orchestrator/state.json".to_string(),
        "runs/run/report.json".to_string(),
    ];
    names.push("providers/selection.json".to_string());
    for name in &names {
        let path = state.join(name);
        write_text(&path, "{}");
        set_mtime(&path, epoch_ms() - 30 * DAY_MS);
        retained.push(path);
    }
    let credentials = state.join("providers/credentials.json");
    write_text(&credentials, &credentials_with(id));
    set_mtime(&credentials, epoch_ms() - 30 * DAY_MS);
    retained.push(credentials);

    let covered = [CoveredStateDir {
        state_dir: state.clone(),
        source: CleanupSource::Canonical,
    }];
    let now = epoch_ms();
    run_cleanup(
        &repo,
        now,
        false,
        &[],
        Some(&covered),
        Some(&state.join("runs/run")),
    );
    for path in &retained {
        assert!(path.exists(), "{} was swept", path.display());
    }
    let _ = std::fs::remove_dir_all(&directory);
}

// ---------------------------------------------------------------------------
// Worktree retention
// ---------------------------------------------------------------------------

#[test]
fn merged_clean_worktrees_are_removed_but_guarded_worktrees_stay() {
    let directory = root("worktree-guards");
    let repo = directory.join("repo");
    init_repo(&repo);

    let merged = add_worktree(&repo, "merged-clean", "merged-clean");
    let dirty = add_worktree(&repo, "dirty", "dirty-branch");
    write_text(&dirty.join("tracked.txt"), "dirty\n");
    let unmerged = add_worktree(&repo, "unmerged", "unmerged-branch");
    write_text(&unmerged.join("new.txt"), "new\n");
    git(&unmerged, &["add", "new.txt"]);
    git(&unmerged, &["commit", "-qm", "new"]);
    let detached = add_worktree(&repo, "detached", "detached-branch");
    git(&detached, &["checkout", "-q", "--detach", "HEAD"]);
    let busy = add_worktree(&repo, "busy", "busy-branch");
    let mut child = Command::new("sleep")
        .arg("60")
        .current_dir(&busy)
        .spawn()
        .expect("a live process");
    std::thread::sleep(std::time::Duration::from_millis(200));
    let served = add_worktree(&repo, "served", "served-branch");
    let instances = vec![instance(&served)];
    let test_tmp = repo.join(".worktree/.test-tmp");
    std::fs::create_dir_all(&test_tmp).expect("a test tmp");
    let no_git = repo.join(".worktree/no-git");
    std::fs::create_dir_all(&no_git).expect("a plain directory");

    let report = run_worktree_cleanup(&repo, epoch_ms(), false, &instances);
    let _ = child.kill();
    let _ = child.wait();

    assert!(!merged.exists(), "a merged, clean worktree leaves");
    for path in [&dirty, &unmerged, &detached, &busy, &served] {
        assert!(path.exists(), "{} must stay", path.display());
    }
    assert!(test_tmp.exists());
    assert!(no_git.exists());
    assert!(report.removed.iter().any(|candidate| candidate.kind
        == WorktreeCandidateKind::Worktree
        && candidate.path == merged));
    assert!(git(&repo, &["branch", "--list", "merged-clean"])
        .trim()
        .is_empty());
    for branch in [
        "dirty-branch",
        "unmerged-branch",
        "detached-branch",
        "busy-branch",
        "served-branch",
    ] {
        assert!(
            !git(&repo, &["branch", "--list", branch]).trim().is_empty(),
            "{branch} must stay"
        );
    }
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn unregistered_worktree_directories_follow_the_same_rule() {
    let directory = root("worktree-unregistered");
    let repo = directory.join("repo");
    init_repo(&repo);
    let unregistered = unregistered_worktree(&repo, "unregistered", "unregistered-branch");
    let dirty = unregistered_worktree(&repo, "unregistered-dirty", "unregistered-dirty-branch");
    write_text(&dirty.join("tracked.txt"), "dirty\n");
    let no_git = repo.join(".worktree/no-git");
    std::fs::create_dir_all(&no_git).expect("a plain directory");

    let report = run_worktree_cleanup(&repo, epoch_ms(), false, &[]);
    assert!(!unregistered.exists());
    assert!(dirty.exists());
    assert!(no_git.exists());
    assert!(report.pruned);
    assert!(git(&repo, &["branch", "--list", "unregistered-branch"])
        .trim()
        .is_empty());
    assert!(
        !git(&repo, &["branch", "--list", "unregistered-dirty-branch"])
            .trim()
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn idle_unmerged_branches_are_patched_before_they_are_deleted() {
    let directory = root("branch-patch");
    let repo = directory.join("repo");
    init_repo(&repo);
    git(&repo, &["checkout", "-q", "-b", "idle-feature"]);
    write_text(&repo.join("feature.txt"), "feature\n");
    git(&repo, &["add", "feature.txt"]);
    git_with_env(
        &repo,
        &["commit", "-qm", "feature"],
        &[
            ("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z"),
            ("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z"),
        ],
    );
    git(&repo, &["checkout", "-q", "main"]);

    let report = run_worktree_cleanup(&repo, epoch_ms(), false, &[]);
    let patch = repo.join(".devboard/.tmp/worktree-cleanup/branches/idle-feature.patch");
    assert!(patch.exists(), "the patch is written before the deletion");
    assert!(std::fs::read_to_string(&patch)
        .expect("the patch")
        .contains("feature.txt"));
    assert!(git(&repo, &["branch", "--list", "idle-feature"])
        .trim()
        .is_empty());
    assert!(report
        .removed
        .iter()
        .any(|candidate| candidate.branch.as_deref() == Some("idle-feature")));
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn a_checked_out_branch_is_never_deleted() {
    let directory = root("branch-checked-out");
    let repo = directory.join("repo");
    init_repo(&repo);
    git(&repo, &["checkout", "-q", "-b", "held-feature"]);
    write_text(&repo.join("feature.txt"), "feature\n");
    git(&repo, &["add", "feature.txt"]);
    git_with_env(
        &repo,
        &["commit", "-qm", "feature"],
        &[
            ("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z"),
            ("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z"),
        ],
    );
    git(&repo, &["checkout", "-q", "main"]);
    let held = repo.join(".worktree/held");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            held.to_str().expect("a utf-8 path"),
            "held-feature",
        ],
    );
    write_text(&held.join("tracked.txt"), "dirty\n");

    run_worktree_cleanup(&repo, epoch_ms(), false, &[]);
    assert!(held.exists(), "a dirty worktree stays");
    assert!(!git(&repo, &["branch", "--list", "held-feature"])
        .trim()
        .is_empty());
    let patch = repo.join(".devboard/.tmp/worktree-cleanup/branches/held-feature.patch");
    assert!(
        !patch.exists(),
        "a checked-out branch is never patched away"
    );
    let _ = std::fs::remove_dir_all(&directory);
}

// ---------------------------------------------------------------------------
// Build retention
// ---------------------------------------------------------------------------

#[test]
fn target_duplicates_keep_only_the_newest_and_the_cap_removes_the_rest() {
    let directory = root("target-dedup");
    let repo = directory.join("repo");
    let deps = repo.join(".devboard/target/debug/deps");
    std::fs::create_dir_all(&deps).expect("a deps directory");
    let now = epoch_ms();
    let old = deps.join("libfoo-aaaaaaaaaaaaaaaa.rlib");
    let new = deps.join("libfoo-bbbbbbbbbbbbbbbb.rlib");
    let single = deps.join("libbar-cccccccccccccccc.rlib");
    for path in [&old, &new, &single] {
        write_bytes(path, 100);
    }
    set_mtime(&old, now - 2 * HOUR_MS);
    set_mtime(&new, now - HOUR_MS);
    set_mtime(&single, now - HOUR_MS);
    let binary = repo.join(".devboard/target/debug/devboard");
    write_bytes(&binary, 50);

    let report = run_build_cleanup_with(&repo, false, u64::MAX, &|_| false, &|| Vec::new());
    assert!(!old.exists(), "the superseded duplicate leaves");
    assert!(new.exists(), "the newest duplicate survives");
    assert!(single.exists(), "a single artifact survives");
    assert!(binary.exists(), "the binary outside deps survives");
    assert!(report
        .removed
        .iter()
        .any(|candidate| candidate.kind == BuildCandidateKind::Duplicate && candidate.path == old));

    let capped = root("target-cap");
    let capped_repo = capped.join("repo");
    let debug = capped_repo.join(".devboard/target/debug");
    let capped_deps = debug.join("deps");
    std::fs::create_dir_all(&capped_deps).expect("a deps directory");
    write_bytes(&capped_deps.join("libx-dddddddddddddddd.rlib"), 100);
    write_bytes(&debug.join("devboard"), 100);
    let capped_report = run_build_cleanup_with(&capped_repo, false, 10, &|_| false, &|| Vec::new());
    assert!(!debug.exists(), "the cap removes the whole directory");
    assert!(capped_report.cap_removed);
    assert!(capped_report
        .candidates
        .iter()
        .any(|candidate| candidate.kind == BuildCandidateKind::TargetDebug));

    let busy = root("target-busy");
    let busy_repo = busy.join("repo");
    let busy_deps = busy_repo.join(".devboard/target/debug/deps");
    std::fs::create_dir_all(&busy_deps).expect("a deps directory");
    let busy_old = busy_deps.join("libfoo-aaaaaaaaaaaaaaaa.rlib");
    let busy_new = busy_deps.join("libfoo-bbbbbbbbbbbbbbbb.rlib");
    write_bytes(&busy_old, 100);
    write_bytes(&busy_new, 100);
    let busy_report = run_build_cleanup_with(&busy_repo, false, 0, &|_| true, &|| Vec::new());
    assert!(busy_old.exists() && busy_new.exists());
    assert!(busy_report.skipped.is_some());
    assert!(busy_report.removed.is_empty());
    let _ = std::fs::remove_dir_all(&directory);
    let _ = std::fs::remove_dir_all(&capped);
    let _ = std::fs::remove_dir_all(&busy);
}

#[test]
fn a_worktree_build_directory_leaves_when_nothing_works_in_it() {
    let directory = root("worktree-target");
    let repo = directory.join("repo");
    init_repo(&repo);
    let abandoned = add_worktree(&repo, "abandoned", "abandoned-branch");
    let taken = add_worktree(&repo, "taken", "taken-branch");
    let abandoned_debug = abandoned.join(".devboard/target/debug");
    let abandoned_deps = abandoned_debug.join("deps");
    std::fs::create_dir_all(&abandoned_deps).expect("a deps directory");
    write_bytes(&abandoned_deps.join("libfoo-aaaaaaaaaaaaaaaa.rlib"), 100);
    write_bytes(&abandoned_debug.join("devboard"), 50);
    let taken_debug = taken.join(".devboard/target/debug");
    let taken_artifact = taken_debug.join("deps/libfoo-bbbbbbbbbbbbbbbb.rlib");
    write_bytes(&taken_artifact, 100);
    let canonical_deps = repo.join(".devboard/target/debug/deps");
    std::fs::create_dir_all(&canonical_deps).expect("a deps directory");
    let canonical_artifact = canonical_deps.join("libbar-cccccccccccccccc.rlib");
    write_bytes(&canonical_artifact, 100);

    let busy = taken.clone();
    let dry = run_build_cleanup_with(&repo, true, u64::MAX, &|_| false, &|| vec![busy.clone()]);
    assert!(
        abandoned_debug.exists() && taken_debug.exists(),
        "a dry run removes nothing"
    );
    assert!(
        dry.candidates.iter().any(|candidate| candidate.kind
            == BuildCandidateKind::WorktreeTargetDebug
            && candidate.path == abandoned_debug),
        "{:?}",
        dry.candidates
    );
    assert!(
        !dry.candidates
            .iter()
            .any(|candidate| candidate.path == taken_debug),
        "a worktree a live process works in keeps its build output"
    );

    let busy = taken.clone();
    let real = run_build_cleanup_with(&repo, false, u64::MAX, &|_| false, &|| vec![busy.clone()]);
    assert!(
        !abandoned_debug.exists(),
        "the abandoned worktree's build output leaves"
    );
    assert!(abandoned.exists(), "the worktree itself stays");
    assert!(
        taken_artifact.exists(),
        "the worktree a live process works in keeps its artifact"
    );
    assert!(
        canonical_artifact.exists(),
        "the canonical checkout keeps its artifact"
    );
    assert!(
        real.removed.iter().any(|candidate| candidate.kind
            == BuildCandidateKind::WorktreeTargetDebug
            && candidate.path == abandoned_debug),
        "{:?}",
        real.removed
    );
    assert!(
        real.bytes_after < real.bytes_before,
        "the report accounts for the reclaimed bytes"
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn a_build_elsewhere_never_holds_the_canonical_retention_back() {
    let directory = root("scoped-build-gate");
    let repo = directory.join("repo");
    init_repo(&repo);
    let worktree = add_worktree(&repo, "building", "building-branch");
    let deps = repo.join(".devboard/target/debug/deps");
    std::fs::create_dir_all(&deps).expect("a deps directory");
    let old = deps.join("libfoo-aaaaaaaaaaaaaaaa.rlib");
    let new = deps.join("libfoo-bbbbbbbbbbbbbbbb.rlib");
    write_bytes(&old, 100);
    write_bytes(&new, 100);
    let now = epoch_ms();
    set_mtime(&old, now - 2 * HOUR_MS);
    set_mtime(&new, now - HOUR_MS);

    // The only build on the host runs inside the worktree, so the canonical
    // checkout's own pass still runs its dedup step.
    let building = worktree.clone();
    let elsewhere = run_build_cleanup_with(
        &repo,
        false,
        u64::MAX,
        &|checkout| checkout != repo.as_path(),
        &|| vec![building.clone()],
    );
    assert!(elsewhere.skipped.is_none(), "{:?}", elsewhere.skipped);
    assert!(!old.exists(), "the canonical duplicate leaves");
    assert!(new.exists());

    // The same rule keeps the directory when the build is its own.
    let busy_old = deps.join("libbar-dddddddddddddddd.rlib");
    let busy_new = deps.join("libbar-eeeeeeeeeeeeeeee.rlib");
    write_bytes(&busy_old, 100);
    write_bytes(&busy_new, 100);
    let local = run_build_cleanup_with(&repo, false, u64::MAX, &|_| true, &|| Vec::new());
    assert!(local.skipped.is_some());
    assert!(busy_old.exists() && busy_new.exists());
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn a_held_build_lock_keeps_the_canonical_tree() {
    let directory = root("target-lock");
    let repo = directory.join("repo");
    let debug = repo.join(".devboard/target/debug");
    let deps = debug.join("deps");
    std::fs::create_dir_all(&deps).expect("a deps directory");
    let now = epoch_ms();
    let old = deps.join("libfoo-aaaaaaaaaaaaaaaa.rlib");
    let new = deps.join("libfoo-bbbbbbbbbbbbbbbb.rlib");
    write_bytes(&old, 100);
    write_bytes(&new, 100);
    set_mtime(&old, now - 2 * HOUR_MS);
    set_mtime(&new, now - HOUR_MS);

    // Cargo holds this lock for a whole build and creates each unit's
    // fingerprint directory once, so a pass that unlinked a file under it would
    // fail the build instead of freeing space.
    let held = TargetLock::acquire(&debug)
        .expect("the lock file")
        .expect("the lock");

    let dry = run_build_cleanup_with(&repo, true, 0, &|_| false, &|| Vec::new());
    assert_eq!(
        dry.skipped.as_deref(),
        Some("a cargo build holds the target directory lock")
    );
    assert!(dry.candidates.is_empty(), "{:?}", dry.candidates);
    assert!(old.exists() && new.exists(), "a dry run removes nothing");

    let busy = run_build_cleanup_with(&repo, false, 0, &|_| false, &|| Vec::new());
    assert!(busy.removed.is_empty(), "{:?}", busy.removed);
    assert!(!busy.cap_removed);
    assert!(old.exists() && new.exists(), "a held lock keeps every artifact");

    drop(held);

    // A child process that another test spawns while this lock is open
    // inherits its open file description until the child's `exec` closes it, so
    // the first sample after the drop can still see the lock held — exactly the
    // skip a live build's lock produces. Retry briefly, as the next cleanup
    // cycle would.
    let mut after = run_build_cleanup_with(&repo, false, 0, &|_| false, &|| Vec::new());
    for _ in 0..50 {
        if after.skipped.is_none() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
        after = run_build_cleanup_with(&repo, false, 0, &|_| false, &|| Vec::new());
    }
    assert!(after.skipped.is_none(), "{:?}", after.skipped);
    assert!(!old.exists(), "the duplicate leaves once the lock is free");
    assert!(after.cap_removed, "the cap removes the tree once the lock is free");
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn a_held_worktree_build_lock_keeps_its_build_output() {
    let directory = root("worktree-target-lock");
    let repo = directory.join("repo");
    init_repo(&repo);
    let worktree = add_worktree(&repo, "building-too", "building-too-branch");
    let debug = worktree.join(".devboard/target/debug");
    let deps = debug.join("deps");
    std::fs::create_dir_all(&deps).expect("a deps directory");
    write_bytes(&deps.join("libfoo-aaaaaaaaaaaaaaaa.rlib"), 100);
    let held = TargetLock::acquire(&debug)
        .expect("the lock file")
        .expect("the lock");

    let busy = run_build_cleanup_with(&repo, false, u64::MAX, &|_| false, &|| Vec::new());
    assert!(debug.exists(), "a build in the worktree keeps its output");
    assert!(
        !busy
            .candidates
            .iter()
            .any(|candidate| candidate.kind == BuildCandidateKind::WorktreeTargetDebug),
        "{:?}",
        busy.candidates
    );
    assert!(busy.removed.is_empty());

    drop(held);

    // Same inherited-description window as the canonical lock: retry briefly
    // before requiring the reclaim.
    let mut after = run_build_cleanup_with(&repo, false, u64::MAX, &|_| false, &|| Vec::new());
    for _ in 0..50 {
        if debug.exists() {
            std::thread::sleep(std::time::Duration::from_millis(2));
            after = run_build_cleanup_with(&repo, false, u64::MAX, &|_| false, &|| Vec::new());
        } else {
            break;
        }
    }
    assert!(
        !debug.exists(),
        "the abandoned worktree's output leaves once the lock is free"
    );
    assert!(after
        .removed
        .iter()
        .any(|candidate| candidate.kind == BuildCandidateKind::WorktreeTargetDebug));
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn a_dry_run_predicts_the_real_state_worktree_and_build_candidates() {
    let directory = root("dry-predict");
    let repo = directory.join("repo");
    init_repo(&repo);
    let state = repo.join(".devboard/.tmp");
    std::fs::create_dir_all(&state).expect("a state directory");
    let now = epoch_ms();
    let old_state = state.join("old.log");
    write_text(&old_state, "old");
    set_mtime(&old_state, now - 8 * DAY_MS);
    let worktree = add_worktree(&repo, "merged", "merged-branch");
    let deps = repo.join(".devboard/target/debug/deps");
    std::fs::create_dir_all(&deps).expect("a deps directory");
    let old_artifact = deps.join("libfoo-aaaaaaaaaaaaaaaa.rlib");
    let new_artifact = deps.join("libfoo-bbbbbbbbbbbbbbbb.rlib");
    write_bytes(&old_artifact, 100);
    write_bytes(&new_artifact, 100);
    set_mtime(&old_artifact, now - 2 * HOUR_MS);
    set_mtime(&new_artifact, now - HOUR_MS);

    let dry = run_cleanup_with(&repo, now, true, &[], None, None, &|_| false);
    let mut dry_paths: std::collections::BTreeSet<PathBuf> = dry
        .roots
        .iter()
        .flat_map(|entry| paths_of(entry.candidates.iter()))
        .collect();
    dry_paths.extend(
        dry.worktrees
            .candidates
            .iter()
            .map(|candidate| candidate.path.clone()),
    );
    dry_paths.extend(
        dry.builds
            .candidates
            .iter()
            .map(|candidate| candidate.path.clone()),
    );
    assert!(old_state.exists() && worktree.exists() && old_artifact.exists());

    let real = run_cleanup_with(&repo, now, false, &[], None, None, &|_| false);
    let mut real_paths: std::collections::BTreeSet<PathBuf> = real
        .roots
        .iter()
        .flat_map(|entry| paths_of(entry.removed.iter()))
        .collect();
    real_paths.extend(
        real.worktrees
            .removed
            .iter()
            .map(|candidate| candidate.path.clone()),
    );
    real_paths.extend(
        real.builds
            .removed
            .iter()
            .map(|candidate| candidate.path.clone()),
    );
    assert_eq!(dry_paths, real_paths, "the dry run predicts the real pass");
    assert!(!old_state.exists(), "the old state file is swept");
    assert!(!worktree.exists(), "the merged worktree is removed");
    assert!(!old_artifact.exists(), "the duplicate artifact is removed");
    assert!(new_artifact.exists());
    let _ = std::fs::remove_dir_all(&directory);
}
