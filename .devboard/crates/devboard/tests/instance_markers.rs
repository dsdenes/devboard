//! A startup record names a live dashboard whose command line no longer does.
//!
//! A rebuild that removed the running binary leaves `/proc/<pid>/exe` as the
//! only executable copy, and a wrapper (`sh -c`, a unit file, a container)
//! rewrites `argv[0]`. Discovery must still find the dashboard through the
//! records it wrote at startup, and it must not trust a record a dead or
//! recycled pid left behind.

use std::path::{Path, PathBuf};

use devboard::instances::GuardOwner;
use devboard::workers::watchdog::{
    marker_instance, marker_instances, merge_marker_instances, own_started_at, Instance,
};
use serde_json::json;

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

    /// The state directory the dashboard guard lives in.
    fn state(&self) -> PathBuf {
        self.root.join(".devboard").join(".tmp")
    }

    /// The record this test process itself would write.
    fn live_owner(&self) -> GuardOwner {
        GuardOwner {
            pid: std::process::id(),
            port: 8080,
            repo_dir: self.root.to_string_lossy().into_owned(),
            state_dir: self.state().to_string_lossy().into_owned(),
            started_at: own_started_at(),
        }
    }

    fn record(&self, path: &Path, owner: &GuardOwner) {
        std::fs::write(path, record_json(owner)).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn record_json(owner: &GuardOwner) -> String {
    json!({
        "pid": owner.pid,
        "port": owner.port,
        "repoDir": owner.repo_dir,
        "stateDir": owner.state_dir,
        "startedAt": owner.started_at,
    })
    .to_string()
}

fn scanned(pid: u32, port: u32, repo: &str) -> Instance {
    Instance {
        pid,
        port,
        repo_dir: repo.to_string(),
        host: "127.0.0.1".to_string(),
        harness: format!("{repo}/.devboard"),
        state_dir: format!("{repo}/.devboard/.tmp"),
        journal: String::new(),
        instrumented: false,
        legacy_log: None,
    }
}

#[test]
fn a_guard_record_finds_a_dashboard_whose_argv_does_not() {
    let fixture = Fixture::new("found");
    let owner = fixture.live_owner();
    let instance =
        marker_instance(&fixture.root, Some(&owner)).expect("the guard names a live dashboard");
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
#[cfg(target_os = "linux")]
fn a_record_of_a_recycled_pid_is_ignored() {
    let fixture = Fixture::new("recycled");
    let mut owner = fixture.live_owner();
    owner.started_at = "2020-01-01T00:00:00.000Z".to_string();
    assert_eq!(marker_instance(&fixture.root, Some(&owner)), None);
}

#[test]
fn a_dead_pid_is_not_the_dashboard() {
    let fixture = Fixture::new("dead");
    let mut owner = fixture.live_owner();
    owner.pid = 999_999;
    assert_eq!(marker_instance(&fixture.root, Some(&owner)), None);
}

#[test]
fn a_guard_record_of_another_repository_is_ignored() {
    let fixture = Fixture::new("foreign");
    let mut owner = fixture.live_owner();
    owner.repo_dir = fixture
        .root
        .join("elsewhere")
        .to_string_lossy()
        .into_owned();
    assert_eq!(marker_instance(&fixture.root, Some(&owner)), None);
}

#[test]
fn an_absent_guard_record_names_no_dashboard() {
    let fixture = Fixture::new("absent");
    assert_eq!(marker_instance(&fixture.root, None), None);
}

#[test]
fn a_version_marker_alone_names_a_dashboard() {
    let fixture = Fixture::new("version");
    let owner = fixture.live_owner();
    fixture.record(&fixture.state().join("version.json"), &owner);
    let instances = marker_instances(&fixture.root);
    assert_eq!(instances.len(), 1, "{instances:?}");
    assert_eq!(instances[0].pid, owner.pid);
    assert_eq!(instances[0].port, 8080);
}

#[test]
#[cfg(target_os = "linux")]
fn a_stale_version_marker_names_no_dashboard() {
    let fixture = Fixture::new("stale-version");
    let mut owner = fixture.live_owner();
    owner.started_at = "2020-01-01T00:00:00.000Z".to_string();
    fixture.record(&fixture.state().join("version.json"), &owner);
    assert!(marker_instances(&fixture.root).is_empty());
}

#[test]
fn both_records_name_one_dashboard() {
    let fixture = Fixture::new("both");
    let owner = fixture.live_owner();
    fixture.record(
        &fixture.state().join(devboard::instances::GUARD_OWNER_FILE),
        &owner,
    );
    fixture.record(&fixture.state().join("version.json"), &owner);
    assert_eq!(marker_instances(&fixture.root).len(), 1);
}

#[test]
fn two_live_dashboards_of_one_repository_are_both_listed() {
    let mut instances = vec![scanned(11, 7000, "/repo")];
    merge_marker_instances(&mut instances, vec![scanned(22, 7001, "/repo")]);
    assert_eq!(instances.len(), 2, "{instances:?}");
    assert_eq!(instances[0].pid, 11);
    assert_eq!(instances[1].pid, 22);
}

#[test]
fn a_dashboard_the_scan_found_is_not_listed_twice() {
    let mut instances = vec![scanned(11, 7000, "/repo")];
    merge_marker_instances(&mut instances, vec![scanned(11, 7000, "/repo")]);
    assert_eq!(instances.len(), 1, "{instances:?}");
}

#[test]
fn a_marker_of_one_port_under_another_path_is_not_listed_twice() {
    let fixture = Fixture::new("same-port");
    let root = fixture.root.to_string_lossy().into_owned();
    let mut instances = vec![scanned(11, 7000, &root)];
    merge_marker_instances(&mut instances, vec![scanned(22, 7000, &root)]);
    assert_eq!(instances.len(), 1, "{instances:?}");
}
