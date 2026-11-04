//! Manual cleanup and legacy watchdog removal.

use std::path::PathBuf;
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn root(label: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("cleanup-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
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
