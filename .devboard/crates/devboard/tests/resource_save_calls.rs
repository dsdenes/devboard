//! What one resource save costs the user manager.
//!
//! A save is an operator waiting on a control, so its path to the slice is
//! measured in `systemctl` round trips: each one is a process spawn plus a
//! serialized bus request, and the endpoint answers only after the last one
//! returns. The governor may spend one read and one property write on a budget
//! that changed, and nothing on one the slice already carries. This fixture
//! shadows `systemctl` with a script that records and delays every invocation,
//! so the old eight-call save models 1.6 s against the fixed 1000 ms budget
//! while the current one models well inside it. The round trips, not a
//! wall-clock reading, are what the assertion counts: a loaded builder must
//! not decide this test.

#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use devboard::resources::{Governor, GovernorOptions, MemoryReader, Settings};

/// The fixed budget the interface holds every operator action to.
const UI_ACTION_BUDGET: Duration = Duration::from_millis(1000);
/// What one faked user-manager round trip costs.
const CALL_DELAY: Duration = Duration::from_millis(200);

/// The latency a list of `systemctl` calls adds to the action that made them.
fn modelled_latency(calls: &[String]) -> Duration {
    CALL_DELAY * u32::try_from(calls.len()).unwrap_or(u32::MAX)
}

struct FakeMemory;

impl MemoryReader for FakeMemory {
    fn total_mb(&self) -> u64 {
        131_072
    }
    fn available_mb(&self) -> Option<u64> {
        Some(65_000)
    }
    fn cpu_count(&self) -> u32 {
        32
    }
}

/// A scratch directory inside the repository.
fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.test-tmp")
        .join(format!("resource-save-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("the scratch directory");
    root
}

fn settings(high: u64) -> Settings {
    Settings {
        max_agent_peers: 8,
        memory_high_mb: high,
        memory_max_mb: 16_384,
        memory_reserve_mb: 1024,
    }
}

/// The fake `systemctl`: every call is recorded and delayed. A `show` answers
/// in the format it was asked for — `Name=Value` lines, or the bare value with
/// `--value` — from the control group the fixture owns and the description
/// file.
fn fake_systemctl(root: &Path) -> PathBuf {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("the fake bin directory");
    let log = root.join("calls.log");
    let description = root.join("description");
    let script = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> {log}
sleep 0.2
values=0
for arg in "$@"; do
  if [ "$arg" = '--value' ]; then values=1; fi
done
prev=''
for arg in "$@"; do
  if [ "$prev" = '-p' ]; then
    description="$(cat {description})"
    case "$arg" in
      ControlGroup)
        if [ "$values" = 1 ]; then printf '%s\n' user.slice
        else printf 'ControlGroup=user.slice\n'; fi ;;
      Description)
        if [ "$values" = 1 ]; then printf '%s\n' "$description"
        else printf 'Description=%s\n' "$description"; fi ;;
    esac
  fi
  prev="$arg"
done
exit 0
"#,
        log = log.display(),
        description = description.display(),
    );
    let program = bin.join("systemctl");
    std::fs::write(&program, script).expect("the fake systemctl");
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&program)
        .expect("the fake systemctl")
        .permissions()
        .mode();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(mode | 0o111))
        .expect("an executable fake systemctl");
    program
}

fn read_calls(root: &Path) -> Vec<String> {
    std::fs::read_to_string(root.join("calls.log"))
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

fn clear_calls(root: &Path) {
    std::fs::write(root.join("calls.log"), "").expect("the call log reset");
}

#[test]
fn a_resource_save_costs_one_read_and_one_write() {
    if !Path::new("/sys/fs/cgroup/user.slice").is_dir() {
        assert!(
            std::env::var("DEVBOARD_REQUIRE_SLICE").as_deref() != Ok("1"),
            "DEVBOARD_REQUIRE_SLICE=1 but there is no cgroup v2 hierarchy"
        );
        return;
    }
    let root = scratch("budget");
    fake_systemctl(&root);
    let state = root.join("state");
    let marker = format!("devboard owner {}", state.display());
    // A slice the manager started carries its own description; the first
    // apply claims it.
    std::fs::write(root.join("description"), "Slice /user.slice\n").expect("the description");
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{path}", root.join("bin").display()));

    let governor = Governor::in_slice(
        &state,
        GovernorOptions {
            memory: Arc::new(FakeMemory),
            env: Default::default(),
            slice: true,
        },
        "devboardsave1548.slice",
    );
    assert!(
        governor.slice_info().present,
        "the fixture's slice is the live control group"
    );
    let claim = read_calls(&root);
    let claimed = claim
        .iter()
        .find(|line| line.contains("set-property"))
        .expect("the first apply writes the slice");
    assert!(
        claimed.contains(&format!("Description={marker}")),
        "an unclaimed slice is named for its dashboard: {claimed}"
    );

    // The slice now carries the marker, so a save writes limits only.
    std::fs::write(root.join("description"), format!("{marker}\n")).expect("the description");
    clear_calls(&root);
    governor.save(settings(4096)).expect("the save validates");
    let calls = read_calls(&root);
    assert!(
        calls.len() <= 2,
        "a changed save spends one read and one write, not {} calls: {calls:?}",
        calls.len()
    );
    assert_eq!(
        calls.iter().filter(|line| line.contains(" show ")).count(),
        1,
        "the save reads the slice once: {calls:?}"
    );
    let written = calls
        .iter()
        .find(|line| line.contains("set-property"))
        .expect("the save writes the limits");
    for property in ["MemoryHigh=", "MemoryMax=", "MemorySwapMax=0"] {
        assert!(
            written.contains(property),
            "one transaction carries {property}: {written}"
        );
    }
    assert!(
        !written.contains("Description="),
        "a slice already named for this dashboard is not renamed: {written}"
    );
    let latency = modelled_latency(&calls);
    assert!(
        latency < UI_ACTION_BUDGET,
        "a changed save's {} calls at {CALL_DELAY:?} each model {latency:?}, \
         outside the {UI_ACTION_BUDGET:?} budget: {calls:?}",
        calls.len()
    );

    // The same budget again is already on the slice: no round trip at all.
    clear_calls(&root);
    governor
        .save(settings(4096))
        .expect("the repeat save validates");
    let calls = read_calls(&root);
    assert!(
        calls.is_empty(),
        "a repeated budget costs the user manager nothing: {calls:?}"
    );

    // The peer cap is admission's, not the slice's: changing it alone leaves
    // the marks untouched.
    clear_calls(&root);
    let mut capped = settings(4096);
    capped.max_agent_peers = 12;
    governor.save(capped).expect("the capped save validates");
    let calls = read_calls(&root);
    assert!(
        calls.is_empty(),
        "a cap-only edit rewrites no slice property: {calls:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
