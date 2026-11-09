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
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["init", "--quiet"])
        .status()
        .unwrap();
    assert!(status.success(), "the fixture host is a git checkout");
    devboard::cli_install::install(Some(&root), false).unwrap();
    root
}

/// A directory holding a working `omp` stub, prepended to `PATH` while the
/// guard lives and restored when it drops. A test that asserts a healthy
/// report proves the payload's own checks, never the machine's installed
/// agent CLI.
struct OmpStub(Option<std::ffi::OsString>);

impl Drop for OmpStub {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("PATH", previous),
            None => std::env::remove_var("PATH"),
        }
    }
}

fn with_omp_stub(root: &Path) -> OmpStub {
    let bin = root.join("stub-bin");
    std::fs::create_dir_all(&bin).unwrap();
    let stub = bin.join("omp");
    std::fs::write(
        &stub,
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo \"omp 0.0.0\" ;;\n  *) echo \"usage: omp\" ;;\nesac\nexit 0\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let previous = std::env::var_os("PATH");
    let mut entries = vec![bin];
    if let Some(previous) = &previous {
        entries.extend(std::env::split_paths(previous));
    }
    std::env::set_var("PATH", std::env::join_paths(entries).unwrap());
    OmpStub(previous)
}

fn failures(report: &devboard::cli_install::DoctorReport) -> Vec<String> {
    report.failures.clone()
}

/// A local release a doctor run can read and verify without a network.
fn local_release(root: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let release = root.join("release");
    std::fs::create_dir_all(&release).unwrap();
    let target = devboard::release::current_target().expect("a platform target");
    let bytes = b"the platform artifact";
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    std::fs::write(release.join(format!("devboard-{target}.tar.xz")), bytes).unwrap();
    std::fs::write(
        release.join("devboard-manifest.json"),
        serde_json::to_string(&serde_json::json!({
            "version": "0.1.0",
            "tag": "v0.1.0",
            "assets": [{
                "target": target,
                "url": format!("https://github.test/devboard-{target}.tar.xz"),
                "sha256": digest,
            }],
        }))
        .unwrap(),
    )
    .unwrap();
    release
}

#[test]
fn a_healthy_host_passes() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("healthy");
    let _omp = with_omp_stub(&root);
    let release = local_release(&root);
    std::env::set_var("DEVBOARD_RELEASE_URL", &release);
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    std::env::remove_var("DEVBOARD_RELEASE_URL");
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

#[test]
fn a_tracked_package_file_differs_as_drift_not_failure() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("tracked-drift");
    std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["init", "--quiet"])
        .status()
        .unwrap();
    let file = root.join(".omp/commands/setup-devboard.md");
    std::fs::write(&file, b"host edit\n").unwrap();
    std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["add", "-f", ".omp/commands/setup-devboard.md"])
        .status()
        .unwrap();
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    assert!(
        report
            .drift
            .iter()
            .any(|entry| entry.contains(".omp/commands/setup-devboard.md")),
        "{:?}",
        report.drift
    );
    assert!(
        !report
            .failures
            .iter()
            .any(|failure| failure.contains("setup-devboard.md")),
        "{:?}",
        report.failures
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_missing_omp_or_git_names_its_check() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("missing-tools");
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", "/nonexistent-devboard-doctor");
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    std::env::set_var("PATH", &path);
    let failures = failures(&report).join("\n");
    assert!(failures.contains("omp --version"), "{failures}");
    assert!(failures.contains("git:"), "{failures}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_local_release_artifact_is_downloaded_and_its_digest_checked() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = host("release-artifact");
    let _omp = with_omp_stub(&root);
    let release = local_release(&root);
    let target = devboard::release::current_target().expect("a platform target");
    std::env::set_var("DEVBOARD_RELEASE_URL", &release);
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    assert!(report.ok(), "{:?}", report.failures);

    std::fs::write(
        release.join(format!("devboard-{target}.tar.xz")),
        b"tampered",
    )
    .unwrap();
    let report = devboard::cli_install::doctor(Some(&root)).unwrap();
    std::env::remove_var("DEVBOARD_RELEASE_URL");
    assert!(
        failures(&report)
            .iter()
            .any(|failure| failure.starts_with("release artifact:")),
        "{:?}",
        report.failures
    );
    let _ = std::fs::remove_dir_all(&root);
}
