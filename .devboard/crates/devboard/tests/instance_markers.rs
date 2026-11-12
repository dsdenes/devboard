//! A guard record names a live dashboard whose command line no longer does.
//!
//! A rebuild that removed the running binary leaves `/proc/<pid>/exe` as the
//! only executable copy, and a replacement started through it presents that
//! link as `argv[0]`. Discovery must still find the dashboard, and it must not
//! trust a record a dead or recycled pid left behind.

use std::path::PathBuf;

use devboard::instances::GuardOwner;
use devboard::workers::watchdog::marker_instance;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("instance-markers-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".devboard").join(".tmp")).unwrap();
        Self { root }
    }

    fn owner(&self) -> GuardOwner {
        GuardOwner {
            pid: std::process::id(),
            port: 8080,
            repo_dir: self.root.to_string_lossy().into_owned(),
            state_dir: self
                .root
                .join(".devboard")
                .join(".tmp")
                .to_string_lossy()
                .into_owned(),
            started_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    /// The path a dashboard of this checkout runs from. The name is what the
    /// guard proves; the file need not exist for discovery.
    fn harness_exe(&self) -> PathBuf {
        self.root.join(".devboard").join("bin").join("devboard")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn a_guard_record_finds_a_dashboard_whose_argv_does_not() {
    let fixture = Fixture::new("found");
    let owner = fixture.owner();
    let instance = marker_instance(&fixture.root, Some(&owner), Some(&fixture.harness_exe()))
        .expect("the guard names a live dashboard");
    assert_eq!(instance.pid, owner.pid);
    assert_eq!(instance.port, 8080);
    assert_eq!(instance.repo_dir, owner.repo_dir);
    assert_eq!(
        instance.harness,
        fixture.root.join(".devboard").to_string_lossy()
    );
    assert!(!instance.instrumented);
    assert!(instance.journal.ends_with(".jsonl"));
}

#[test]
fn a_recycled_pid_is_not_the_dashboard() {
    let fixture = Fixture::new("recycled");
    let owner = fixture.owner();
    assert_eq!(
        marker_instance(
            &fixture.root,
            Some(&owner),
            Some(std::path::Path::new("/usr/bin/true"))
        ),
        None
    );
}

#[test]
fn a_dead_pid_is_not_the_dashboard() {
    let fixture = Fixture::new("dead");
    let mut owner = fixture.owner();
    owner.pid = 999_999;
    assert_eq!(
        marker_instance(&fixture.root, Some(&owner), Some(&fixture.harness_exe())),
        None
    );
}

#[test]
fn a_guard_record_of_another_repository_is_ignored() {
    let fixture = Fixture::new("foreign");
    let mut owner = fixture.owner();
    owner.repo_dir = fixture
        .root
        .join("elsewhere")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        marker_instance(&fixture.root, Some(&owner), Some(&fixture.harness_exe())),
        None
    );
}

#[test]
fn an_absent_guard_record_names_no_dashboard() {
    let fixture = Fixture::new("absent");
    assert_eq!(
        marker_instance(&fixture.root, None, Some(&fixture.harness_exe())),
        None
    );
}
