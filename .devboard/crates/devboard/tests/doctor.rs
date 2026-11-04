//! Doctor coverage: a healthy host passes and each bad fixture names its check.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The environment is process-wide; these checks run one at a time.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn package_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn host(label: &str) -> PathBuf {
    let root = package_dir()
        .join(".test-tmp")
        .join(format!("doctor-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".devboard")).unwrap();
    devboard::cli_install::install(Some(&root), false).unwrap();
    root
}

fn failures(report: &devboard::cli_install::DoctorReport) -> Vec<String> {
    report.failures.clone()
}

#[test]
fn a_healthy_host_passes() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("healthy");
    std::env::remove_var("DEVBOARD_RELEASE_URL");
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    assert!(report.ok(), "{:?}", report.failures);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_missing_release_names_the_release_check() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("release");
    let release = root.join("release");
    std::fs::create_dir_all(&release).unwrap();
    std::env::set_var("DEVBOARD_RELEASE_URL", &release);
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    std::env::remove_var("DEVBOARD_RELEASE_URL");
    assert!(
        failures(&report)
            .iter()
            .any(|failure| failure.starts_with("release:")),
        "{:?}",
        report.failures
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_stale_running_version_and_an_unresponsive_dashboard_both_name_themselves() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("stale");
    let state = root.join(".devboard/.tmp");
    std::fs::create_dir_all(&state).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    std::fs::write(
        state.join("version.json"),
        serde_json::json!({
            "running": "0.0.1",
            "pid": std::process::id(),
            "port": port,
        })
        .to_string(),
    )
    .unwrap();
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    let text = report.failures.join("\n");
    assert!(text.contains("stale:"), "{text}");
    assert!(text.contains("dashboard: nothing answers"), "{text}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_symlinked_harness_names_the_layout_check() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("symlink");
    let target = root.join("real-devboard");
    std::fs::rename(root.join(".devboard"), &target).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, root.join(".devboard")).unwrap();
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    assert!(
        failures(&report)
            .iter()
            .any(|failure| failure.contains("layout: .devboard is a symlink")),
        "{:?}",
        report.failures
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_recorded_update_failure_names_the_update_check() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("update").canonicalize().unwrap();
    let state = root.join(".devboard/.tmp");
    std::fs::create_dir_all(&state).unwrap();
    let path = devboard::journal::journal_file(&state, &root);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        concat!(
            r#"{"ts":"2026-01-01T00:00:00.000Z","repo":"","port":0,"pid":1,"kind":"update","text":"installed"}"#,
            "\n",
            r#"{"ts":"2026-01-01T00:00:01.000Z","repo":"","port":0,"pid":1,"kind":"update-error","text":"checksum mismatch"}"#,
            "\n",
        ),
    )
    .unwrap();
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    assert!(
        failures(&report)
            .iter()
            .any(|failure| failure.starts_with("update: checksum mismatch")),
        "{:?}",
        report.failures
    );
    let _ = std::fs::remove_dir_all(&root);
}
