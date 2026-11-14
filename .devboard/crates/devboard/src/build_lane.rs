//! The cross-process build lease.
//!
//! One workspace build writes gigabytes: a test binary carries its debug info
//! and `target/debug/incremental` keeps a cache per compiler unit. Several
//! peers that each start a full build stack those writes past the kernel's
//! dirty-page cap, and every writer then stalls behind writeback.
//!
//! The lane bounds how many builds run at once instead of serializing them. A
//! host gets one slot per eight CPUs, at least one and at most eight, and
//! `DEVBOARD_MAX_BUILDS` overrides that inside 1..=64. A caller waits for a
//! free slot rather than failing. Each slot is a `flock(2)` lock on one file in
//! the state directory, so the bound holds across processes and across
//! worktrees that share one state directory; the kernel drops a dead holder's
//! lock, so a slot whose process is gone is reclaimed by the next caller.
//!
//! The lane bounds writes, not agents: it never reads or writes the governor's
//! admission slots, so `Governor::active_agents()` and the agent cap are the
//! same with or without a build running.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The state-directory subtree the lane owns.
pub const BUILD_LANE_DIRECTORY: &str = "build-lane";
/// The environment variable that overrides the derived slot count.
pub const MAX_BUILDS_ENV: &str = "DEVBOARD_MAX_BUILDS";
/// The environment variable that names the slot a child build holds.
pub const SLOT_ENV: &str = "DEVBOARD_BUILD_SLOT";
/// The environment variable the child's cargo reads for its own job count.
pub const JOBS_ENV: &str = "CARGO_BUILD_JOBS";
/// One slot per this many CPUs.
const CPUS_PER_SLOT: usize = 8;
/// The most slots a derived cap reaches.
const DEFAULT_MAX_SLOTS: usize = 8;
/// The most slots an override can name.
const MAX_BUILDS: usize = 64;
/// How long a waiter sleeps between passes over the slots.
const WAIT: Duration = Duration::from_millis(100);

/// The host's CPU count, read at run time.
pub fn cpu_count() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

/// The slot count a host with `cpus` CPUs derives: one per eight cores, never
/// zero, never more than eight.
pub fn derived_slots(cpus: usize) -> usize {
    (cpus / CPUS_PER_SLOT).clamp(1, DEFAULT_MAX_SLOTS)
}

/// The effective slot count: `DEVBOARD_MAX_BUILDS` inside 1..=64 when the
/// environment sets one, the derived value otherwise. Computed at run time, so
/// a value a long-lived process started with never freezes the cap.
pub fn slots(environment: &HashMap<String, String>) -> usize {
    if let Some(value) = environment.get(MAX_BUILDS_ENV) {
        if let Ok(parsed) = value.trim().parse::<usize>() {
            if (1..=MAX_BUILDS).contains(&parsed) {
                return parsed;
            }
        }
    }
    derived_slots(cpu_count())
}

/// The cargo job count one build gets: the host's CPUs spread over the slots,
/// rounded up so a slot never gets zero jobs.
pub fn jobs(cpus: usize, slots: usize) -> usize {
    cpus.max(1).div_ceil(slots.max(1))
}

/// One lane: a fixed number of slots in one directory.
#[derive(Clone, Debug)]
pub struct BuildLane {
    root: PathBuf,
    slots: usize,
}

impl BuildLane {
    /// A lane over exactly `slots` slots, never fewer than one.
    pub fn new(root: impl Into<PathBuf>, slots: usize) -> Self {
        Self {
            root: root.into(),
            slots: slots.max(1),
        }
    }

    /// The lane a harness run under `state_dir` shares with every other
    /// process that uses the same state directory.
    pub fn for_state(state_dir: &Path, environment: &HashMap<String, String>) -> Self {
        Self::new(state_dir.join(BUILD_LANE_DIRECTORY), slots(environment))
    }

    /// The lane for a build rooted at `checkout`. A caller with a state
    /// directory shares the one lane; a bare checkout falls back to its own
    /// `target/tmp`, which is already build scratch.
    pub fn for_checkout(checkout: &Path, environment: &HashMap<String, String>) -> Self {
        let state = environment
            .get("STATE_DIR")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| checkout.join("target").join("tmp"));
        Self::for_state(&state, environment)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn slots(&self) -> usize {
        self.slots
    }

    /// The job count one slot's build gets on this host.
    pub fn jobs(&self) -> usize {
        jobs(cpu_count(), self.slots)
    }

    /// Takes a slot, waiting until one is free. A caller never fails on a busy
    /// lane and never stops work already holding a slot.
    pub fn acquire(&self) -> BuildLease {
        loop {
            if let Some(lease) = self.try_acquire() {
                return lease;
            }
            std::thread::sleep(WAIT);
        }
    }

    /// [`BuildLane::acquire`] for an async caller.
    pub async fn acquire_async(&self) -> BuildLease {
        loop {
            if let Some(lease) = self.try_acquire() {
                return lease;
            }
            tokio::time::sleep(WAIT).await;
        }
    }

    /// Exports one held lease to a child's environment: the slot it holds and,
    /// only when the caller left it unset, the job count that slot gets.
    pub fn export(&self, lease: &BuildLease, environment: &mut HashMap<String, String>) {
        environment.insert(SLOT_ENV.to_string(), lease.slot().to_string());
        environment
            .entry(JOBS_ENV.to_string())
            .or_insert_with(|| self.jobs().to_string());
    }

    fn slot_path(&self, slot: usize) -> PathBuf {
        self.root.join(format!("slot-{slot}"))
    }

    fn try_acquire(&self) -> Option<BuildLease> {
        std::fs::create_dir_all(&self.root).ok()?;
        for slot in 0..self.slots {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(self.slot_path(slot))
                .ok()?;
            // A lock the kernel already dropped belongs to a holder that is
            // gone, so taking it is the reclaim; the stale record below is
            // overwritten with this holder.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                continue;
            }
            let _ = file.set_len(0);
            let _ = file.seek(SeekFrom::Start(0));
            let _ = writeln!(file, "{}", std::process::id());
            return Some(BuildLease { file, slot });
        }
        None
    }
}

/// One held slot. Dropping it releases the slot for the next build.
pub struct BuildLease {
    file: File,
    slot: usize,
}

impl BuildLease {
    pub fn slot(&self) -> usize {
        self.slot
    }
}

impl Drop for BuildLease {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
