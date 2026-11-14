//! The cross-process build lane: its bound, its reclaim, and its isolation.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use devboard::build_lane::{
    cpu_count, derived_slots, jobs, slots, BuildLane, BUILD_LANE_DIRECTORY, MAX_BUILDS_ENV,
};
use devboard::resources::{Governor, GovernorOptions, MemoryReader};

fn scratch(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.test-tmp")
        .join(format!("build-lane-{label}-{stamp}"));
    std::fs::create_dir_all(&root).expect("a scratch directory");
    root
}

#[test]
fn a_capped_lane_never_overlaps_more_than_its_slots() {
    let root = scratch("overlap");
    let lane = BuildLane::new(root.join(BUILD_LANE_DIRECTORY), 3);
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let finished = Arc::new(AtomicUsize::new(0));
    let start = Arc::new(Barrier::new(4));
    let mut threads = Vec::new();
    for _ in 0..4 {
        let lane = lane.clone();
        let active = Arc::clone(&active);
        let peak = Arc::clone(&peak);
        let finished = Arc::clone(&finished);
        let start = Arc::clone(&start);
        threads.push(std::thread::spawn(move || {
            start.wait();
            let _lease = lane.acquire();
            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(current, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(150));
            active.fetch_sub(1, Ordering::SeqCst);
            finished.fetch_add(1, Ordering::SeqCst);
        }));
    }
    for thread in threads {
        thread.join().expect("a build thread");
    }
    assert_eq!(
        finished.load(Ordering::SeqCst),
        4,
        "a waiting build never ran"
    );
    let peak = peak.load(Ordering::SeqCst);
    assert!(peak <= 3, "{peak} builds overlapped a three-slot lane");
    assert!(peak > 1, "a three-slot lane serialized every build");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_slot_whose_holder_is_gone_is_reclaimed() {
    let root = scratch("stale");
    let lane_root = root.join(BUILD_LANE_DIRECTORY);
    std::fs::create_dir_all(&lane_root).expect("the lane directory");
    // The record a killed build leaves: a pid the kernel no longer knows and
    // no lock, because the kernel released the flock with the process.
    std::fs::write(lane_root.join("slot-0"), b"999999999\n").expect("the stale record");

    let lane = BuildLane::new(&lane_root, 1);
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let lease = lane.acquire();
        let _ = sender.send(lease.slot());
    });
    let slot = receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("a dead holder's slot is reclaimed");
    assert_eq!(slot, 0);
    let record = std::fs::read_to_string(lane_root.join("slot-0")).expect("the record");
    assert_ne!(record.trim(), "999999999", "the stale pid was not replaced");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_held_slot_blocks_the_next_build_until_it_is_released() {
    let root = scratch("release");
    let lane = BuildLane::new(root.join(BUILD_LANE_DIRECTORY), 1);
    let held = lane.acquire();
    let (sender, receiver) = mpsc::channel();
    let next = lane.clone();
    std::thread::spawn(move || {
        let lease = next.acquire();
        let _ = sender.send(lease.slot());
    });
    assert!(
        receiver.recv_timeout(Duration::from_millis(300)).is_err(),
        "a full lane admitted another build"
    );
    drop(held);
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(5)),
        Ok(0),
        "a released slot was never handed to the waiting build"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn build_slots_never_change_the_agent_governor() {
    let root = scratch("governor");
    let governor = Governor::new(
        &root,
        GovernorOptions::in_memory(
            Arc::new(FixedMemory {
                total_mb: 64_000,
                available_mb: 60_000,
                cpus: 16,
            }),
            Default::default(),
        ),
    );
    let cap = governor.settings().max_agent_peers;
    let lane = BuildLane::new(root.join(BUILD_LANE_DIRECTORY), 2);
    let first = lane.acquire();
    let second = lane.acquire();
    assert_eq!(governor.active_agents(), 0);
    assert_eq!(governor.settings().max_agent_peers, cap);
    drop(first);
    drop(second);
    assert_eq!(governor.active_agents(), 0);
    assert_eq!(governor.settings().max_agent_peers, cap);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_default_cap_is_derived_from_the_host_at_run_time() {
    assert_eq!(derived_slots(1), 1);
    assert_eq!(derived_slots(7), 1);
    assert_eq!(derived_slots(8), 1);
    assert_eq!(derived_slots(16), 2);
    assert_eq!(derived_slots(32), 4);
    assert_eq!(derived_slots(64), 8);
    assert_eq!(derived_slots(512), 8);
    assert!(cpu_count() >= 1);
    assert_eq!(slots(&HashMap::new()), derived_slots(cpu_count()));
}

#[test]
fn the_override_applies_only_inside_one_to_sixty_four() {
    let with = |value: &str| {
        slots(&HashMap::from([(
            MAX_BUILDS_ENV.to_string(),
            value.to_string(),
        )]))
    };
    assert_eq!(with("1"), 1);
    assert_eq!(with("7"), 7);
    assert_eq!(with("64"), 64);
    assert_eq!(with("0"), derived_slots(cpu_count()));
    assert_eq!(with("65"), derived_slots(cpu_count()));
    assert_eq!(with("many"), derived_slots(cpu_count()));
}

#[test]
fn the_job_count_spreads_the_host_over_the_slots_and_never_reaches_zero() {
    assert_eq!(jobs(32, 4), 8);
    assert_eq!(jobs(16, 2), 8);
    assert_eq!(jobs(2, 64), 1);
    assert_eq!(jobs(0, 1), 1);
    assert_eq!(jobs(8, 0), 8);
    let root = scratch("jobs");
    let lane = BuildLane::new(root.join(BUILD_LANE_DIRECTORY), 2);
    assert_eq!(lane.jobs(), jobs(cpu_count(), 2));
    let _ = std::fs::remove_dir_all(&root);
}

struct FixedMemory {
    total_mb: u64,
    available_mb: u64,
    cpus: u32,
}

impl MemoryReader for FixedMemory {
    fn total_mb(&self) -> u64 {
        self.total_mb
    }

    fn available_mb(&self) -> Option<u64> {
        Some(self.available_mb)
    }

    fn cpu_count(&self) -> u32 {
        self.cpus
    }
}
