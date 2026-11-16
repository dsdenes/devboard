//! What one resource save costs the operator.
//!
//! A save is an operator waiting on a control, so the answer may spend neither
//! a serialized user-manager round trip nor a durable flush. The slice half is
//! measured in `systemctl` round trips: each one is a process spawn plus a
//! serialized bus request, and a manager draining scope work answers one in
//! well over a second. The save therefore answers after its rename: it
//! persists the budget and leaves the slice's memory marks to an applier, which
//! spends one read and one write on a budget that changed and nothing on one
//! the slice already carries.
//!
//! This fixture shadows `systemctl` with a script that records and delays every
//! invocation, and holds every call at a gate armed for the measured save. A
//! save that waited for the manager is therefore caught by the order of the two
//! events, never by a clock: the save cannot answer while its call is held, and
//! the gate opens only after the answer — the defect that filed issue 1951. The
//! applier is then observed making the one read and the one write the answer no
//! longer waits on.
//!
//! The storage half is a staged write and a rename. When the filesystem's own
//! flush is slow enough to exhibit a `sync_all` on the path — the defect this
//! file regresses — the save is timed against that flush instead.

#![cfg(target_os = "linux")]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use devboard::resources::{Governor, GovernorOptions, MemoryReader, Settings};
use serde_json::json;

/// The fixed budget the interface holds every operator action to.
const UI_ACTION_BUDGET: Duration = Duration::from_millis(1000);
/// What one faked user-manager round trip costs on a manager that is draining
/// scope work: the reading a workspace suite creating and stopping slices
/// produces on this host.
const CALL_DELAY: Duration = Duration::from_millis(1200);

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

/// The fake `systemctl`: every call is delayed and then recorded, so a call in
/// the log has returned. An armed gate records the call in `called.log` and
/// holds it until the test opens the gate, so a save that waits on the manager
/// cannot answer while the gate is shut. A `show` answers in the format it was
/// asked for — `Name=Value` lines, or the bare value with `--value` — from the
/// control group the fixture owns and the description file.
fn fake_systemctl(root: &Path) -> PathBuf {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("the fake bin directory");
    let log = root.join("calls.log");
    let called = root.join("called.log");
    let armed = root.join("gate-armed");
    let opened = root.join("gate-open");
    let description = root.join("description");
    // The gate loop is bounded well above the test's own answer budget, so a
    // call the fixture holds on a starved host still exits after the test has
    // settled its verdict.
    let script = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> "{called}"
if [ -e "{armed}" ]; then
  waits=0
  while [ ! -e "{opened}" ]; do
    sleep 0.05
    waits=$((waits + 1))
    if [ "$waits" -ge 2400 ]; then break; fi
  done
fi
sleep "${{FAKE_SYSTEMCTL_DELAY:-0.2}}"
printf '%s\n' "$*" >> "{log}"
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
        called = called.display(),
        armed = armed.display(),
        opened = opened.display(),
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

/// The fake logs a call after its delay, so a call in the log has returned.
fn wait_for_calls(root: &Path, count: usize) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let calls = read_calls(root);
        if calls.len() >= count {
            return calls;
        }
        assert!(
            Instant::now() < deadline,
            "the applier made {} of {count} calls: {calls:?}",
            calls.len()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// One operator save: every field the page submits, as the wire carries them.
fn update(governor: &Arc<Governor>, settings: Settings) -> Result<Settings, String> {
    governor.apply_update(
        Some(&json!(settings.max_agent_peers)),
        Some(&json!(settings.memory_high_mb)),
        Some(&json!(settings.memory_max_mb)),
        Some(&json!(settings.memory_reserve_mb)),
    )
}

#[test]
fn a_save_answers_before_the_user_manager_is_asked() {
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
    std::env::set_var("FAKE_SYSTEMCTL_DELAY", CALL_DELAY.as_secs_f64().to_string());

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

    // The slice now carries the marker, so the applier writes limits only. The
    // save itself must answer first, and the verdict is the order of the two
    // events, not a clock: every call the fixture sees is held at the gate
    // armed below, so a save that waited on the manager could not return until
    // the gate opened, and the gate opens only after the save has answered. A
    // loaded host starves a wall-clock budget — a whole-suite attempt measured
    // 5.86 s on a save that costs 2-4 ms — while this verdict is the same on an
    // idle host and a saturated one.
    std::fs::write(root.join("description"), format!("{marker}\n")).expect("the description");
    clear_calls(&root);
    std::fs::write(root.join("called.log"), "").expect("the call record reset");
    std::fs::write(root.join("gate-armed"), "").expect("the gate is armed");
    let saver = Arc::clone(&governor);
    let (sender, answered) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(update(&saver, settings(4096)));
    });
    let answer = answered
        .recv_timeout(Duration::from_secs(60))
        .unwrap_or_else(|_| {
            let asked = std::fs::read_to_string(root.join("called.log")).unwrap_or_default();
            panic!(
                "the save did not answer in 60 s while the user manager held its reply: the \
                 operator's answer is waiting on a {CALL_DELAY:?} round trip. the fixture \
                 recorded: {asked:?}"
            )
        });
    answer.expect("the save validates");
    std::fs::write(root.join("gate-open"), "").expect("the gate opens after the answer");

    // The applier then spends one read and one write on the changed budget.
    let calls = wait_for_calls(&root, 2);
    assert_eq!(
        calls.len(),
        2,
        "a changed save spends one read and one write, not {} calls: {calls:?}",
        calls.len()
    );
    assert_eq!(
        calls.iter().filter(|line| line.contains(" show ")).count(),
        1,
        "the applier reads the slice once: {calls:?}"
    );
    let written = calls
        .iter()
        .find(|line| line.contains("set-property"))
        .expect("the applier writes the limits");
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
    assert!(
        modelled_latency(&calls) > UI_ACTION_BUDGET,
        "these are the calls the answer no longer waits on: {} calls at \
         {CALL_DELAY:?} each model {:?}, and the save must answer inside {:?}",
        calls.len(),
        modelled_latency(&calls),
        UI_ACTION_BUDGET
    );

    // The applier records the budget after its transaction returns, so a short
    // settle keeps the assertions below from racing that bookkeeping.
    std::thread::sleep(Duration::from_millis(250));

    // The same budget again is already on the slice: no round trip at all.
    clear_calls(&root);
    update(&governor, settings(4096)).expect("the repeat save validates");
    std::thread::sleep(Duration::from_millis(300));
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
    update(&governor, capped).expect("the capped save validates");
    std::thread::sleep(Duration::from_millis(300));
    let calls = read_calls(&root);
    assert!(
        calls.is_empty(),
        "a cap-only edit rewrites no slice property: {calls:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// One durable flush of a settings-sized file in the directory the save
/// writes, so the probe pays what a flushing save pays in the same window.
fn flush_probe(directory: &Path, index: usize) -> Duration {
    let path = directory.join(format!("flush-probe-{index}.json"));
    let started = Instant::now();
    {
        let mut file = std::fs::File::create(&path).expect("the flush probe");
        file.write_all(b"{\"maxAgentPeers\":8}\n")
            .expect("the flush probe write");
        file.sync_all().expect("the flush probe sync");
    }
    let elapsed = started.elapsed();
    let _ = std::fs::remove_file(&path);
    elapsed
}

/// Saving the settings answers after the staged write is renamed, not after
/// the filesystem flushes it.
///
/// The save used to `sync_all` its hundred-byte settings file, so the
/// operator's request waited on the disk: on this host one flush measured
/// 250 ms to 1 s, and a save pressed twice in that window breached the 1000 ms
/// action budget. A host whose flush is already instant cannot exhibit the
/// defect, so the test skips there, the way the slice tests skip without a
/// user manager. Each probe runs beside one save, so a loaded builder moves
/// both readings together instead of deciding the verdict.
#[test]
fn a_resource_save_does_not_wait_for_the_settings_flush() {
    let root = scratch("flush");
    let state = root.join("state");
    let settings_directory = state.join("resources");
    std::fs::create_dir_all(&settings_directory).expect("the state directory");
    let governor = Governor::new(
        &state,
        GovernorOptions {
            memory: Arc::new(FakeMemory),
            env: Default::default(),
            slice: false,
        },
    );
    let mut flushes = Vec::new();
    let mut saves = Vec::new();
    for index in 0..9usize {
        flushes.push(flush_probe(&settings_directory, index));
        let started = Instant::now();
        governor
            .save(settings(4096 + index as u64))
            .expect("the save validates");
        saves.push(started.elapsed());
    }
    flushes.sort();
    saves.sort();
    let flush = flushes[flushes.len() / 2];
    let save = saves[saves.len() / 2];
    if flush < Duration::from_micros(500) {
        // A filesystem whose flush is free (tmpfs) cannot separate the two
        // paths at all.
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    assert!(
        save * 2 < flush,
        "the median save takes {save:?} while the median flush of the same file \
         takes {flush:?}: the settings write must answer after its rename, not \
         after the disk. saves: {saves:?} flushes: {flushes:?}"
    );
    assert!(
        save < UI_ACTION_BUDGET,
        "a save is held to the operator's action budget: {save:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
