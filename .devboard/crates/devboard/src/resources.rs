//! The resource governor.
//!
//! One budget bounds every agentic run the dashboard starts: a global cap on
//! concurrent agent peers and a memory reserve below which no new start is
//! admitted. The cap is shared by every process that starts a peer — the
//! dashboard, each worker, each run owner — through slot files in the state
//! directory, so the Issues worker, the background families, goal, flow, the
//! Release Train, and manual runs all draw from one pool. Discover runs
//! are outside the cap: a Discover start is admitted while every cap slot is
//! held, so its peer never waits in a silent `starting` state and never
//! records a cap deferral. The memory reserve and the slice's kernel
//! `MemoryMax` still apply to it.
//!
//! Reporting keeps the two sets apart: [`Governor::active_agents`] counts the
//! slots that hold the cap, [`Governor::exempt_agents`] counts the live
//! Discover peers outside it, and the cap's holder groups name only the
//! former.
//!
//! On Linux the same governor owns the transient `devboard.slice`. Every
//! worker, run owner, and peer the dashboard starts is either started through
//! a transient scope in that slice or already runs in it, so the kernel
//! enforces the hard `MemoryMax` while the governor only defers. It never
//! kills work for budget reasons; the kernel is the only hard stop.
//!
//! On macOS there is no cgroup: the cap and admission control still run, and
//! the slice is a no-op.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// The state-directory subtree the governor owns.
pub const RESOURCES_DIRECTORY: &str = "resources";
/// The run family the peer cap excludes. A Discover start is admitted at a
/// full cap; the memory reserve still applies to it.
pub const DISCOVER_KIND: &str = "discover";
/// The transient slice every agentic process joins on Linux.
pub const SLICE_NAME: &str = "devboard.slice";
/// The `IOWeight` the slice and every transient scope under it carry. The
/// desktop's session stays at io.weight's default 100, so a busy workspace
/// build yields the device to the desktop instead of competing one-for-one.
pub const DEFAULT_IO_WEIGHT: u64 = 10;
/// The environment variable that overrides [`DEFAULT_IO_WEIGHT`].
pub const IO_WEIGHT_ENV: &str = "DEVBOARD_IO_WEIGHT";
/// `io.weight` accepts 1..=10000; anything else is not a value the kernel
/// would take.
const IO_WEIGHT_RANGE: std::ops::RangeInclusive<u64> = 1..=10_000;
const SETTINGS_FILE: &str = "settings.json";
const SLOTS_DIRECTORY: &str = "slots";
const LOCK_FILE: &str = "lock";
const DEFERRALS_FILE: &str = "deferrals.jsonl";
const KILLS_FILE: &str = "kills.jsonl";
/// One MiB in bytes; every setting is expressed in whole MiB.
pub const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
/// The smallest hard maximum a budget may carry.
const MIN_MEMORY_MAX_MB: u64 = 128;
/// The smallest soft high mark and reserve a budget may carry.
const MIN_MEMORY_FLOOR_MB: u64 = 64;
/// How long the same deferral is kept out of the log.
const DEFERRAL_DEDUPE_MS: u64 = 30_000;
/// How often a deferred peer retries its admission in-process.
const ADMISSION_POLL_MS: u64 = 250;

/* ------------------------------------------------------------------------ */
/* Settings                                                                  */
/* ------------------------------------------------------------------------ */

/// The effective budget and cap.
///
/// The peer cap always exists. The memory marks exist only when the host's
/// total was read: a governor never derives a memory budget from a total the
/// [`MemoryReader`] did not supply, so [`Self::without_memory`] carries a cap
/// and no marks. `None` marks mean no memory property may be written to the
/// slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub max_agent_peers: u32,
    pub memory_high_mb: Option<u64>,
    pub memory_max_mb: Option<u64>,
    pub memory_reserve_mb: Option<u64>,
}

/// One peer per four CPUs, clamped to 1..=64.
fn peer_cap(cpus: u32) -> u32 {
    (cpus / 4).clamp(1, 64)
}

impl Settings {
    /// The documented defaults: a quarter of RAM (at least 1 GiB) as the
    /// reserve, everything above it as the hard maximum, 80% of that as the
    /// soft high mark, and one peer per four CPUs clamped to 1..=64.
    ///
    /// The reserve is also held inside the bounds [`Self::validate`] states:
    /// the hard maximum keeps its own floor and the reserve stays strictly
    /// below it, so a host of 2 GiB or less derives a budget its own validator
    /// accepts instead of one it refuses. Only a host smaller than both floors
    /// together has no valid budget at all; it gets the floors, and only
    /// [`Self::validate_for`] then refuses the host size.
    ///
    /// `total_mb` is a total a [`MemoryReader`] read. A host whose total could
    /// not be read uses [`Self::without_memory`] instead, so no mark is ever
    /// derived from a placeholder.
    pub fn derive(total_mb: u64, cpus: u32) -> Self {
        // What the documented formula asks for: a quarter of RAM, at least
        // 1 GiB.
        let wanted_reserve_mb = (total_mb / 4).max(GIB / MIB);
        // The most the reserve may take while the hard maximum keeps its floor
        // and stays strictly above the reserve.
        let reserve_ceiling_mb = total_mb
            .saturating_sub(MIN_MEMORY_MAX_MB)
            .min(total_mb.saturating_sub(1) / 2)
            .max(MIN_MEMORY_FLOOR_MB);
        let memory_reserve_mb = wanted_reserve_mb.min(reserve_ceiling_mb);
        let memory_max_mb = total_mb
            .saturating_sub(memory_reserve_mb)
            .max(MIN_MEMORY_MAX_MB);
        let memory_high_mb = (memory_max_mb.saturating_mul(4) / 5).max(MIN_MEMORY_FLOOR_MB);
        Self {
            max_agent_peers: peer_cap(cpus),
            memory_high_mb: Some(memory_high_mb),
            memory_max_mb: Some(memory_max_mb),
            memory_reserve_mb: Some(memory_reserve_mb),
        }
    }

    /// The budget of a host whose memory total was never read: the peer cap
    /// stands, and no memory mark exists to derive, report, or apply.
    pub fn without_memory(cpus: u32) -> Self {
        Self {
            max_agent_peers: peer_cap(cpus),
            memory_high_mb: None,
            memory_max_mb: None,
            memory_reserve_mb: None,
        }
    }

    /// True when this budget carries the memory marks at all.
    pub fn has_memory(&self) -> bool {
        self.memory_max_mb.is_some()
    }

    /// Drops every memory mark. A host whose total was never read has no
    /// memory budget, whatever a settings file or the environment names.
    fn forget_memory(&mut self) {
        self.memory_high_mb = None;
        self.memory_max_mb = None;
        self.memory_reserve_mb = None;
    }

    /// The values explicitly saved to disk; a missing key keeps the fallback.
    fn apply_saved(&mut self, saved: &SavedSettings) {
        if let Some(value) = saved.max_agent_peers {
            self.max_agent_peers = value;
        }
        if let Some(value) = saved.memory_high_mb {
            self.memory_high_mb = Some(value);
        }
        if let Some(value) = saved.memory_max_mb {
            self.memory_max_mb = Some(value);
        }
        if let Some(value) = saved.memory_reserve_mb {
            self.memory_reserve_mb = Some(value);
        }
        self.normalize();
    }

    /// Applies the environment overrides to the derived defaults.
    fn apply_environment(&mut self, env: &BTreeMap<String, String>) {
        if let Some(value) = env_u32(env, "DEVBOARD_MAX_AGENT_PEERS") {
            self.max_agent_peers = value.clamp(1, 64);
        }
        if let Some(value) = env_u64(env, "DEVBOARD_MEMORY_HIGH_MB") {
            self.memory_high_mb = Some(value.max(64));
        }
        if let Some(value) = env_u64(env, "DEVBOARD_MEMORY_MAX_MB") {
            self.memory_max_mb = Some(value.max(64));
        }
        if let Some(value) = env_u64(env, "DEVBOARD_MEMORY_RESERVE_MB") {
            self.memory_reserve_mb = Some(value.max(64));
        }
        self.normalize();
    }

    /// Keeps a budget inside the bounds [`Self::validate`] states, so a value
    /// read from a saved file, an environment override, or a decoded frame
    /// never leaves an effective budget its own validator refuses. A budget
    /// with no marks keeps none: an absent total never becomes a number here.
    fn normalize(&mut self) {
        self.max_agent_peers = self.max_agent_peers.clamp(1, 64);
        if let Some(max) = self.memory_max_mb {
            let max = max.max(MIN_MEMORY_MAX_MB);
            self.memory_max_mb = Some(max);
            self.memory_high_mb = Some(
                self.memory_high_mb
                    .unwrap_or(MIN_MEMORY_FLOOR_MB)
                    .clamp(MIN_MEMORY_FLOOR_MB, max),
            );
        }
        if let Some(reserve) = self.memory_reserve_mb {
            let ceiling = self
                .memory_max_mb
                .map(|max| max.saturating_sub(1))
                .unwrap_or(MIN_MEMORY_FLOOR_MB);
            self.memory_reserve_mb = Some(reserve.clamp(MIN_MEMORY_FLOOR_MB, ceiling));
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "maxAgentPeers": self.max_agent_peers,
            "memoryHighMb": self.memory_high_mb,
            "memoryMaxMb": self.memory_max_mb,
            "memoryReserveMb": self.memory_reserve_mb,
        })
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let number = |key: &str| object.get(key).and_then(Value::as_u64);
        let mut settings = Self {
            max_agent_peers: number("maxAgentPeers")?.try_into().ok()?,
            memory_high_mb: number("memoryHighMb"),
            memory_max_mb: number("memoryMaxMb"),
            memory_reserve_mb: number("memoryReserveMb"),
        };
        settings.normalize();
        Some(settings)
    }

    /// The values this save would write; refuses impossible combinations. A
    /// budget with no memory marks saves its cap alone, which is what a host
    /// whose total could not be read has to offer.
    pub fn validate(&self) -> Result<(), String> {
        if self.max_agent_peers == 0 || self.max_agent_peers > 64 {
            return Err("Max concurrent agents must be between 1 and 64.".to_string());
        }
        let (high, max, reserve) = match (
            self.memory_high_mb,
            self.memory_max_mb,
            self.memory_reserve_mb,
        ) {
            (None, None, None) => return Ok(()),
            (Some(high), Some(max), Some(reserve)) => (high, max, reserve),
            _ => return Err("Memory high, max, and reserve must be set together.".to_string()),
        };
        if max < MIN_MEMORY_MAX_MB {
            return Err(format!(
                "Memory max must be at least {MIN_MEMORY_MAX_MB} MB."
            ));
        }
        if high < MIN_MEMORY_FLOOR_MB || high > max {
            return Err(format!(
                "Memory high must be at least {MIN_MEMORY_FLOOR_MB} MB and at most memory max."
            ));
        }
        if reserve < MIN_MEMORY_FLOOR_MB || reserve >= max {
            return Err(format!(
                "Reserve must be at least {MIN_MEMORY_FLOOR_MB} MB and below memory max."
            ));
        }
        Ok(())
    }

    /// Like [`Self::validate`], and also refuses a hard maximum that reaches
    /// into the reserve the host must keep free. An unknown host total has no
    /// bound to check: a memory budget is refused before it is written.
    pub fn validate_for(&self, total_mb: Option<u64>) -> Result<(), String> {
        self.validate()?;
        let (Some(max), Some(reserve), Some(total_mb)) =
            (self.memory_max_mb, self.memory_reserve_mb, total_mb)
        else {
            return Ok(());
        };
        if max.saturating_add(reserve) > total_mb {
            return Err(format!(
                "Memory max plus reserve must not exceed the host's {total_mb} MB."
            ));
        }
        Ok(())
    }
}

/// The keys a settings file carries; any key may be absent so an environment
/// variable still supplies the default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SavedSettings {
    pub max_agent_peers: Option<u32>,
    pub memory_high_mb: Option<u64>,
    pub memory_max_mb: Option<u64>,
    pub memory_reserve_mb: Option<u64>,
}

impl SavedSettings {
    /// Reads one settings object. A value that is not a JSON object, or that
    /// carries a setting of the wrong type, refuses the whole file: dropping a
    /// key silently would let the peer cap fall back to the derived default
    /// while the page still claimed a budget had been saved.
    pub fn from_value(value: &Value) -> Result<Self, String> {
        let Some(object) = value.as_object() else {
            return Err("the settings file must hold a JSON object".to_string());
        };
        let number = |key: &str| -> Result<Option<u64>, String> {
            match object.get(key) {
                None => Ok(None),
                Some(value) => value
                    .as_u64()
                    .map(Some)
                    .ok_or_else(|| format!("{key} must be a whole number")),
            }
        };
        let max_agent_peers = match number("maxAgentPeers")? {
            None => None,
            Some(value) => Some(
                value
                    .try_into()
                    .map_err(|_| "maxAgentPeers must be a whole number".to_string())?,
            ),
        };
        Ok(Self {
            max_agent_peers,
            memory_high_mb: number("memoryHighMb")?,
            memory_max_mb: number("memoryMaxMb")?,
            memory_reserve_mb: number("memoryReserveMb")?,
        })
    }

    pub fn from_settings(settings: &Settings) -> Self {
        Self {
            max_agent_peers: Some(settings.max_agent_peers),
            memory_high_mb: settings.memory_high_mb,
            memory_max_mb: settings.memory_max_mb,
            memory_reserve_mb: settings.memory_reserve_mb,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut object = serde_json::Map::new();
        if let Some(value) = self.max_agent_peers {
            object.insert("maxAgentPeers".to_string(), json!(value));
        }
        if let Some(value) = self.memory_high_mb {
            object.insert("memoryHighMb".to_string(), json!(value));
        }
        if let Some(value) = self.memory_max_mb {
            object.insert("memoryMaxMb".to_string(), json!(value));
        }
        if let Some(value) = self.memory_reserve_mb {
            object.insert("memoryReserveMb".to_string(), json!(value));
        }
        Value::Object(object)
    }

    pub fn is_empty(&self) -> bool {
        self.max_agent_peers.is_none()
            && self.memory_high_mb.is_none()
            && self.memory_max_mb.is_none()
            && self.memory_reserve_mb.is_none()
    }
}

/// The budget in force for one read of the host's memory and one settings
/// file: the derived defaults, the environment overrides, then the saved
/// values. A host whose total was never read carries no memory mark at all, so
/// a saved or exported memory budget is dropped rather than enforced against a
/// total nothing measured.
fn effective_settings(
    memory_total: &Result<u64, String>,
    cpus: u32,
    env: &BTreeMap<String, String>,
    saved: &SavedSettings,
) -> Settings {
    let mut effective = match memory_total {
        Ok(total) => Settings::derive(*total, cpus),
        Err(_) => Settings::without_memory(cpus),
    };
    effective.apply_environment(env);
    effective.apply_saved(saved);
    if memory_total.is_err() {
        effective.forget_memory();
    }
    effective
}

fn env_u64(env: &BTreeMap<String, String>, key: &str) -> Option<u64> {
    env.get(key)
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn env_u32(env: &BTreeMap<String, String>, key: &str) -> Option<u32> {
    env.get(key)
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
}

/// The `IOWeight` every harness-launched build carries: the default, or the
/// operator's `DEVBOARD_IO_WEIGHT` when it names a value the kernel accepts.
pub fn io_weight() -> u64 {
    io_weight_from(std::env::var(IO_WEIGHT_ENV).ok().as_deref())
}

/// Parses one `DEVBOARD_IO_WEIGHT` value. An absent, unparsable, or
/// out-of-range value keeps the default rather than writing a weight the
/// kernel rejects.
pub fn io_weight_from(raw: Option<&str>) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| IO_WEIGHT_RANGE.contains(value))
        .unwrap_or(DEFAULT_IO_WEIGHT)
}

/// The transient scope's property arguments. Every scope the harness starts
/// carries the IO weight, so a build's processes are never left at the
/// default weight while they compete with the desktop. A caller that proves a
/// memory bound adds its memory properties here too. A budget with no memory
/// marks adds none, so nothing derived from an unread total reaches a scope.
pub fn scope_property_arguments(weight: u64, limit: Option<Settings>) -> Vec<String> {
    let mut arguments = vec![format!("--property=IOWeight={weight}")];
    if let Some(settings) = limit {
        if let (Some(high), Some(max)) = (settings.memory_high_mb, settings.memory_max_mb) {
            arguments.push(format!(
                "--property=MemoryHigh={}",
                high.saturating_mul(MIB)
            ));
            arguments.push(format!("--property=MemoryMax={}", max.saturating_mul(MIB)));
            arguments.push("--property=MemorySwapMax=0".to_string());
        }
    }
    arguments
}

/* ------------------------------------------------------------------------ */
/* Memory                                                                    */
/* ------------------------------------------------------------------------ */

/// The facts admission control needs about the host.
pub trait MemoryReader: Send + Sync {
    /// The host's memory total, or the reason it could not be read. A
    /// governor never derives a budget from a total this did not supply.
    fn total_mb(&self) -> Result<u64, String>;
    /// The memory a new run may use before the reserve is breached.
    fn available_mb(&self) -> Option<u64>;
    fn cpu_count(&self) -> u32;
}

/// The production reader: `/proc/meminfo` on Linux, `sysctl`/`vm_stat` on
/// macOS.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemMemory;

impl MemoryReader for SystemMemory {
    fn total_mb(&self) -> Result<u64, String> {
        system_memory().0
    }

    fn available_mb(&self) -> Option<u64> {
        system_memory().1
    }

    fn cpu_count(&self) -> u32 {
        std::thread::available_parallelism()
            .map(|count| count.get() as u32)
            .unwrap_or(1)
    }
}

#[cfg(target_os = "linux")]
fn system_memory() -> (Result<u64, String>, Option<u64>) {
    match fs::read_to_string("/proc/meminfo") {
        Ok(text) => parse_meminfo(&text),
        Err(error) => (Err(format!("could not read /proc/meminfo: {error}")), None),
    }
}

#[cfg(target_os = "macos")]
fn system_memory() -> (Result<u64, String>, Option<u64>) {
    let total = command_stdout("sysctl", &["-n", "hw.memsize"])
        .and_then(|text| text.trim().parse::<u64>().ok())
        .map(|bytes| bytes / MIB)
        .filter(|total| *total > 0)
        .ok_or_else(|| "could not read hw.memsize from sysctl".to_string());
    let page_size = command_stdout("sysctl", &["-n", "hw.pagesize"])
        .and_then(|text| text.trim().parse::<u64>().ok())
        .unwrap_or(4096);
    let available = command_stdout("vm_stat", &[])
        .and_then(|text| parse_vm_stat(&text, page_size))
        .map(|bytes| bytes / MIB);
    (total, available)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn system_memory() -> (Result<u64, String>, Option<u64>) {
    (
        Err("the host's memory total is not readable on this platform".to_string()),
        None,
    )
}

/// Parses the two `meminfo` fields admission uses. A file with no positive
/// `MemTotal` is a failed read, never a zero total a budget is derived from.
pub fn parse_meminfo(text: &str) -> (Result<u64, String>, Option<u64>) {
    let mut total = None;
    let mut available = None;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let value = parts.next().and_then(|value| value.parse::<u64>().ok());
        let Some(value) = value else { continue };
        match key.trim_end_matches(':') {
            "MemTotal" => total = (value >= 1024).then_some(value / 1024),
            "MemAvailable" => available = Some(value / 1024),
            _ => {}
        }
    }
    let total = total.ok_or_else(|| "/proc/meminfo carries no MemTotal".to_string());
    (total, available)
}

/// Parses `vm_stat` output into available bytes: free, inactive, speculative,
/// and purgeable pages are the memory a new process may claim without paging.
pub fn parse_vm_stat(text: &str, page_size: u64) -> Option<u64> {
    let mut pages = 0u64;
    let mut found = false;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if !matches!(
            key,
            "Pages free" | "Pages inactive" | "Pages speculative" | "Pages purgeable"
        ) {
            continue;
        }
        let value = value.trim().trim_end_matches('.');
        if let Ok(value) = value.parse::<u64>() {
            pages = pages.saturating_add(value);
            found = true;
        }
    }
    found.then(|| pages.saturating_mul(page_size))
}

#[cfg(target_os = "macos")]
fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/* ------------------------------------------------------------------------ */
/* Admission                                                                 */
/* ------------------------------------------------------------------------ */

/// One starter's share of the live slots that hold the cap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapGroup {
    pub starter: String,
    pub count: u32,
}

impl CapGroup {
    /// The line fragment that names one group, e.g. `Watchdog 2`.
    fn message(&self) -> String {
        format!("{} {}", self.starter, self.count)
    }
}

/// One cap deferral: the live slots that hold the cap, the cap they reached,
/// and the starters they belong to.
///
/// The fields are private and one live-slot snapshot builds all of them, so
/// the counts always sum to [`Self::active`], every count is positive, and the
/// message can never describe a cap that is not full.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapDeferral {
    active: u32,
    cap: u32,
    /// The live slots grouped by the starter that created each one, ordered by
    /// count descending, then starter ascending.
    groups: Vec<CapGroup>,
}

impl CapDeferral {
    /// The cap deferral for one admission attempt, built from the live slots
    /// that attempt counted.
    fn new(cap: u32, cap_slots: &[Value]) -> Self {
        Self {
            active: cap_slots.len() as u32,
            cap,
            groups: cap_groups(cap_slots),
        }
    }

    /// The live slots that held the cap, none of them exempt.
    pub fn active(&self) -> u32 {
        self.active
    }

    /// The configured cap the snapshot reached.
    pub fn cap(&self) -> u32 {
        self.cap
    }

    /// The live slots grouped by the starter that created each one.
    pub fn groups(&self) -> &[CapGroup] {
        &self.groups
    }
}

/// Why a start waits. A deferral is never a failure: the caller keeps its work
/// queued and a later attempt may admit it.
///
/// A slot record that cannot be written is not a capacity fact, so it never
/// arrives as a deferral; it is [`AdmissionError::SlotWrite`] instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeferReason {
    Cap(CapDeferral),
    Memory {
        available_mb: u64,
        reserve_mb: u64,
    },
    /// The admission lock could not be taken, so the count and the slot
    /// write would not be serialized. The start is deferred rather than
    /// admitted without that guarantee.
    Lock {
        /// The lock file that could not be opened.
        path: String,
        /// The concrete cause the operating system reported.
        cause: String,
    },
}

impl DeferReason {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Cap(_) => "capacity",
            Self::Memory { .. } => "reserve",
            Self::Lock { .. } => "lock",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Cap(deferral) => {
                let groups = deferral
                    .groups()
                    .iter()
                    .map(CapGroup::message)
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "{} agent peer(s) already run at the cap of {} ({groups}); the start is deferred",
                    deferral.active(),
                    deferral.cap()
                )
            }
            Self::Memory {
                available_mb,
                reserve_mb,
            } => format!(
                "{available_mb} MB is available and the reserve is {reserve_mb} MB; the start is deferred"
            ),
            Self::Lock { path, cause } => format!(
                "the admission lock {path} could not be taken ({cause}); the start is deferred"
            ),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Cap(deferral) => json!({
                "reason": "capacity",
                "active": deferral.active(),
                "cap": deferral.cap(),
                "groups": deferral
                    .groups()
                    .iter()
                    .map(|group| json!({
                        "starter": group.starter,
                        "count": group.count,
                    }))
                    .collect::<Vec<_>>(),
                "message": self.message(),
            }),
            Self::Memory {
                available_mb,
                reserve_mb,
            } => json!({
                "reason": "reserve",
                "availableMb": available_mb,
                "reserveMb": reserve_mb,
                "message": self.message(),
            }),
            Self::Lock { path, cause } => json!({
                "reason": "lock",
                "path": path,
                "cause": cause,
                "message": self.message(),
            }),
        }
    }
}

/// A slot record the governor could not write: the directory it belongs in and
/// the I/O error that refused the write.
///
/// The failure is the state directory's, not the cap's, so it carries both the
/// path an operator has to fix and the error the kernel reported.
#[derive(Debug)]
pub struct SlotWriteError {
    directory: PathBuf,
    error: std::io::Error,
}

impl SlotWriteError {
    /// The slot directory the record belongs in.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// The I/O error the write reported.
    pub fn error(&self) -> &std::io::Error {
        &self.error
    }

    pub fn message(&self) -> String {
        format!(
            "could not write the agent slot in {}: {}",
            self.directory.display(),
            self.error
        )
    }
}

impl std::fmt::Display for SlotWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

/// Why a start was not admitted.
///
/// A [`DeferReason`] waits for capacity and is retried; a slot record that
/// cannot be written is a failure of the state directory and is never retried
/// as though the cap were full.
#[derive(Debug)]
pub enum AdmissionError {
    Deferred(DeferReason),
    SlotWrite(SlotWriteError),
}

impl AdmissionError {
    /// The reason one attempt was not admitted, for a status line or a log.
    pub fn message(&self) -> String {
        match self {
            Self::Deferred(reason) => reason.message(),
            Self::SlotWrite(error) => error.message(),
        }
    }
}

impl std::fmt::Display for AdmissionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

/// One admitted start. Dropping it returns the slot to the global pool; the
/// slot file is also reclaimed when its holder process dies.
pub struct Slot {
    path: PathBuf,
    id: String,
    starter: String,
}

impl Slot {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The surface that started the peer holding this slot.
    pub fn starter(&self) -> &str {
        &self.starter
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Slot")
            .field("id", &self.id)
            .field("starter", &self.starter)
            .finish()
    }
}

/// Groups live slot records by the starter that created each one. A slot an
/// older harness wrote without a starter is counted as `unknown`, so the
/// counts still sum to the live slot count.
fn cap_groups(slots: &[Value]) -> Vec<CapGroup> {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for slot in slots {
        let starter = slot
            .get("starter")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        *counts.entry(starter).or_default() += 1;
    }
    let mut groups: Vec<CapGroup> = counts
        .into_iter()
        .map(|(starter, count)| CapGroup { starter, count })
        .collect();
    groups.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.starter.cmp(&right.starter))
    });
    groups
}

/// True when a start of this kind is outside the peer cap.
fn cap_exempt(kind: &str) -> bool {
    kind == DISCOVER_KIND
}

/// True when a live slot record belongs outside the peer cap. A record an
/// older harness wrote carries no marker and counts toward the cap.
fn slot_exempt(slot: &Value) -> bool {
    slot.get("exempt").and_then(Value::as_bool).unwrap_or(false)
}

/* ------------------------------------------------------------------------ */
/* Governor                                                                  */
/* ------------------------------------------------------------------------ */

/// How one governor is built. Production uses [`GovernorOptions::system`];
/// tests inject a memory reader and can leave the slice alone.
#[derive(Clone)]
pub struct GovernorOptions {
    pub memory: Arc<dyn MemoryReader>,
    pub env: BTreeMap<String, String>,
    pub slice: bool,
}

impl GovernorOptions {
    pub fn system() -> Self {
        Self {
            memory: Arc::new(SystemMemory),
            env: std::env::vars().collect(),
            slice: cfg!(target_os = "linux"),
        }
    }

    pub fn in_memory(memory: Arc<dyn MemoryReader>, env: BTreeMap<String, String>) -> Self {
        Self {
            memory,
            env,
            slice: false,
        }
    }
}

/// The live slice facts the Resources tab and the slice tests read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SliceInfo {
    pub present: bool,
    pub memory_high_mb: u64,
    pub memory_max_mb: u64,
    pub memory_current_mb: u64,
}

/// One kernel kill the governor recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KillRecord {
    pub oom_kills: u64,
    pub memory_current_mb: u64,
    pub memory_max_mb: u64,
    pub at: String,
}

impl KillRecord {
    pub fn message(&self) -> String {
        format!(
            "{} process(es) killed in {SLICE_NAME} at its limit ({} MB used of {} MB)",
            self.oom_kills, self.memory_current_mb, self.memory_max_mb
        )
    }
}

/// The one governor a process uses.
pub struct Governor {
    state_dir: PathBuf,
    directory: PathBuf,
    memory: Arc<dyn MemoryReader>,
    /// The host's memory total as one read returned it. `Err` means the host's
    /// memory was never read, so the budget carries no memory mark and the
    /// slice is never limited to a number derived from nothing.
    memory_total: Result<u64, String>,
    /// Whether the failed read already reached the journal.
    memory_error_journaled: AtomicBool,
    env: BTreeMap<String, String>,
    settings: Mutex<Settings>,
    saved: Mutex<SavedSettings>,
    settings_stamp: Mutex<Option<SystemTime>>,
    /// The reason the saved settings file was rejected, when it was. The
    /// derived budget stays in force until the file reads as a budget again.
    settings_error: Mutex<Option<String>>,
    /// The rejection the journal already carries, so one unchanged file
    /// records one activity line.
    settings_error_journaled: Mutex<Option<String>>,
    slice_enabled: bool,
    /// Whether this process owns the slice properties. A dashboard does; a
    /// worker or a CLI that only joins the slice never rewrites its budget.
    slice_owned: bool,
    /// The slice unit this governor owns: `devboard.slice` in production, a
    /// transient child under it in the tests.
    slice_name: String,
    slice: Mutex<SliceInfo>,
    slice_cgroup: Mutex<Option<PathBuf>>,
    /// The budget the live slice was last proved to carry. A save that repeats
    /// it has nothing to write, so it costs the user manager no round trip.
    applied: Mutex<Option<Settings>>,
    /// Serializes the slice's property transaction. A save answers before its
    /// apply, so the applier a save leaves behind and the startup apply must
    /// never write the same slice's properties at once.
    apply_lock: Mutex<()>,
    slice_wrap: AtomicBool,
    last_oom_kills: AtomicU64,
    deferral_stamp: Mutex<BTreeMap<String, u64>>,
    /// The slot failure the journal already carries, so one unchanged broken
    /// state directory records one error line instead of one per retry.
    slot_error_journaled: Mutex<Option<String>>,
    journal: Mutex<Option<Arc<dyn Fn(&str, &str) + Send + Sync>>>,
}

impl Governor {
    pub fn new(state_dir: &Path, options: GovernorOptions) -> Arc<Self> {
        let apply = options.slice;
        Self::build(state_dir, options, SLICE_NAME, apply)
    }

    /// The governor for one explicit slice unit. Production always uses
    /// [`SLICE_NAME`]; the slices a test owns use their own unit so they never
    /// change or stop the dashboard's slice.
    pub fn in_slice(state_dir: &Path, options: GovernorOptions, slice_name: &str) -> Arc<Self> {
        let apply = options.slice;
        Self::build(state_dir, options, slice_name, apply)
    }

    /// Joins the production slice without changing its properties. The slice
    /// tests start their own limited scopes under it, so a test can prove the
    /// kernel kill without rewriting the budget a live dashboard uses.
    pub fn attached(state_dir: &Path, options: GovernorOptions) -> Arc<Self> {
        let slice = options.slice;
        Self::build(state_dir, options, SLICE_NAME, false).with_slice_ensured(slice)
    }

    fn with_slice_ensured(self: Arc<Self>, slice: bool) -> Arc<Self> {
        if !slice {
            return self;
        }
        let _ = ensure_slice_unit(&self.slice_name);
        if let Some(path) = slice_cgroup_path_for(&self.slice_name) {
            if let Ok(mut current) = self.slice_cgroup.lock() {
                *current = Some(path.clone());
            }
            self.last_oom_kills
                .store(read_oom_kills(&path), Ordering::SeqCst);
        }
        self
    }

    fn build(
        state_dir: &Path,
        options: GovernorOptions,
        slice_name: &str,
        apply: bool,
    ) -> Arc<Self> {
        let directory = state_dir.join(RESOURCES_DIRECTORY);
        let (saved, settings_error) = read_saved_verdict(&directory);
        let memory_total = options.memory.total_mb();
        let effective = effective_settings(
            &memory_total,
            options.memory.cpu_count(),
            &options.env,
            &saved,
        );
        let governor = Arc::new(Self {
            state_dir: state_dir.to_path_buf(),
            directory,
            memory: options.memory,
            memory_total,
            memory_error_journaled: AtomicBool::new(false),
            env: options.env,
            settings: Mutex::new(effective),
            saved: Mutex::new(saved),
            settings_stamp: Mutex::new(file_stamp(&settings_path(state_dir))),
            settings_error: Mutex::new(settings_error),
            settings_error_journaled: Mutex::new(None),
            slice_enabled: options.slice,
            slice_owned: options.slice && apply,
            slice_name: slice_name.to_string(),
            slice: Mutex::new(SliceInfo::default()),
            slice_cgroup: Mutex::new(None),
            applied: Mutex::new(None),
            apply_lock: Mutex::new(()),
            slice_wrap: AtomicBool::new(options.slice),
            last_oom_kills: AtomicU64::new(0),
            deferral_stamp: Mutex::new(BTreeMap::new()),
            slot_error_journaled: Mutex::new(None),
            journal: Mutex::new(None),
        });
        if options.slice && apply {
            governor.apply_slice();
            if let Some(path) = governor
                .slice_cgroup
                .lock()
                .ok()
                .and_then(|path| path.clone())
            {
                governor
                    .last_oom_kills
                    .store(read_oom_kills(&path), Ordering::SeqCst);
            }
        }
        governor
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    pub fn settings(&self) -> Settings {
        *self
            .settings
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn saved_settings(&self) -> SavedSettings {
        self.saved
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    pub fn memory(&self) -> &Arc<dyn MemoryReader> {
        &self.memory
    }

    /// The derived defaults for this host without any override.
    pub fn defaults(&self) -> Settings {
        let cpus = self.memory.cpu_count();
        match &self.memory_total {
            Ok(total) => Settings::derive(*total, cpus),
            Err(_) => Settings::without_memory(cpus),
        }
    }

    /// Why the host's memory total is unknown, or `None` when it was read. The
    /// budget then carries no memory mark and the slice is left alone.
    pub fn memory_error(&self) -> Option<&str> {
        self.memory_total.as_ref().err().map(String::as_str)
    }

    /// Registers the dashboard journal (or a test collector) for deferrals
    /// and kernel kills.
    pub fn set_journal_hook(&self, hook: Arc<dyn Fn(&str, &str) + Send + Sync>) {
        if let Ok(mut journal) = self.journal.lock() {
            *journal = Some(hook);
        }
    }

    /// Re-reads `settings.json` when the dashboard saved new values. Workers
    /// see a cap or budget change without a restart.
    pub fn refresh_settings(&self) {
        self.journal_memory_error();
        let path = settings_path(&self.state_dir);
        let stamp = file_stamp(&path);
        let same = self
            .settings_stamp
            .lock()
            .map(|current| *current == stamp)
            .unwrap_or(true);
        if same {
            // A governor that started on a rejected file has not journaled it
            // yet; the first read that has a hook records it once.
            self.journal_settings_error();
            return;
        }
        let (saved, error) = read_saved_verdict(&self.directory);
        let effective = effective_settings(
            &self.memory_total,
            self.memory.cpu_count(),
            &self.env,
            &saved,
        );
        if let Ok(mut current) = self.settings.lock() {
            *current = effective;
        }
        if let Ok(mut current) = self.saved.lock() {
            *current = saved;
        }
        if let Ok(mut current) = self.settings_stamp.lock() {
            *current = stamp;
        }
        self.note_settings_error(error);
        self.journal_settings_error();
    }

    /// The reason the saved settings file was rejected, if it was.
    pub fn settings_error(&self) -> Option<String> {
        self.settings_error
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// Records the read verdict: the reason the file was rejected, or `None`
    /// when it read as a budget. A changed verdict starts a fresh journal
    /// dedupe, so a rejection of new bytes records its own line.
    fn note_settings_error(&self, error: Option<String>) {
        let changed = self
            .settings_error
            .lock()
            .map(|current| *current != error)
            .unwrap_or(false);
        if changed {
            if let Ok(mut journaled) = self.settings_error_journaled.lock() {
                *journaled = None;
            }
        }
        if let Ok(mut current) = self.settings_error.lock() {
            *current = error;
        }
    }

    /// Journals a rejected settings file as activity, once per unchanged
    /// reason. A governor with no hook records nothing, so the dashboard
    /// journals the rejection on its first read rather than losing the line at
    /// startup.
    fn journal_settings_error(&self) {
        let Some(hook) = self.journal.lock().ok().and_then(|hook| hook.clone()) else {
            return;
        };
        let Some(error) = self
            .settings_error
            .lock()
            .ok()
            .and_then(|error| error.clone())
        else {
            return;
        };
        let already = self
            .settings_error_journaled
            .lock()
            .map(|journaled| journaled.as_deref() == Some(error.as_str()))
            .unwrap_or(true);
        if already {
            return;
        }
        if let Ok(mut journaled) = self.settings_error_journaled.lock() {
            *journaled = Some(error.clone());
        }
        hook(
            "activity",
            &format!(
                "ignored the saved resource budget {error}; the derived defaults stay in force"
            ),
        );
    }

    /// Journals a host whose memory total could not be read as activity, once
    /// per governor. The budget keeps its peer cap and carries no memory mark,
    /// so no memory property is written to the slice and the Resources page
    /// reports why. A governor with no hook records nothing and journals the
    /// line on its first read once the dashboard installs one.
    fn journal_memory_error(&self) {
        let Some(reason) = self.memory_error() else {
            return;
        };
        let Some(hook) = self.journal.lock().ok().and_then(|hook| hook.clone()) else {
            return;
        };
        if self.memory_error_journaled.swap(true, Ordering::SeqCst) {
            return;
        }
        hook(
            "activity",
            &format!(
                "could not read the host's memory total ({reason}); no memory budget is derived \
                 and {SLICE_NAME} keeps its memory properties unchanged"
            ),
        );
    }

    /// Persists the operator's values and applies them to the live slice
    /// before returning.
    ///
    /// A budget whose marks the live slice already carries costs the user
    /// manager no round trip: the peer cap and the reserve reach admission, so
    /// only a changed memory mark rewrites the slice.
    pub fn save(&self, settings: Settings) -> Result<Settings, String> {
        let settings = self.persist(settings)?;
        self.converge();
        Ok(settings)
    }

    /// Validates the budget and writes it where every process reads it.
    ///
    /// This is the half of a save that answers the operator: the settings file
    /// is renamed into place and the in-memory budget follows it. The live
    /// slice is not touched here, so a caller that owes an answer owes it
    /// after this call and before any apply.
    fn persist(&self, settings: Settings) -> Result<Settings, String> {
        let total_mb = self.memory_total.as_ref().ok().copied();
        settings.validate_for(total_mb)?;
        // A memory budget is never written for a host whose total was never
        // read: nothing measured it, and the slice must not carry a number the
        // operator could not have validated. The cap still saves.
        if total_mb.is_none() && settings.has_memory() {
            return Err(
                "Memory high, max, and reserve cannot be set while the host's memory total is \
                 unreadable."
                    .to_string(),
            );
        }
        let saved = SavedSettings::from_settings(&settings);
        write_json_atomically(&settings_path(&self.state_dir), &saved.to_json())
            .map_err(|error| format!("could not save the resource settings: {error}"))?;
        if let Ok(mut current) = self.settings.lock() {
            *current = settings;
        }
        if let Ok(mut current) = self.saved.lock() {
            *current = saved;
        }
        if let Ok(mut current) = self.settings_stamp.lock() {
            *current = file_stamp(&settings_path(&self.state_dir));
        }
        // The save rewrote the file, so a rejection it had is answered.
        self.note_settings_error(None);
        Ok(settings)
    }

    /// Applies the budget in force when the live slice does not carry it.
    ///
    /// The applier a save leaves behind and the startup apply both land here,
    /// so the slice's properties are written by one caller at a time. The
    /// budget is read at apply time rather than captured at save time: two
    /// saves in flight converge on the newest one, never on the older.
    fn converge(&self) {
        if !self.slice_enabled || !self.slice_owned {
            return;
        }
        let _guard = self
            .apply_lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let settings = self.settings();
        if !settings.has_memory() || self.slice_carries(settings) {
            return;
        }
        self.apply_slice_locked();
    }

    /// Applies the saved budget after the caller has answered.
    ///
    /// One changed save costs the user manager a `show` and a `set-property`,
    /// and each is a serialized bus request: on a manager draining scope work
    /// one transaction measured over a second, which put the operator's answer
    /// behind work the answer does not need. The settings file is the save;
    /// the slice follows on its own thread, and a later save's applier skips
    /// the write the earlier one already made.
    fn schedule_apply(self: &Arc<Self>) {
        if !self.slice_enabled || !self.slice_owned {
            return;
        }
        let settings = self.settings();
        if !settings.has_memory() || self.slice_carries(settings) {
            return;
        }
        let governor = Arc::clone(self);
        let _ = std::thread::Builder::new()
            .name("slice-budget".to_string())
            .spawn(move || governor.converge());
    }

    /// True when the live slice still carries the marks this budget sets: the
    /// high and max marks it was last proved to hold, on a control group that
    /// is still there. The peer cap and the reserve are admission inputs the
    /// slice never sees, so changing only them needs no round trip.
    fn slice_carries(&self, settings: Settings) -> bool {
        let applied = self.applied.lock().map(|applied| *applied).unwrap_or(None);
        let Some(applied) = applied else {
            return false;
        };
        if applied.memory_high_mb != settings.memory_high_mb
            || applied.memory_max_mb != settings.memory_max_mb
        {
            return false;
        }
        self.slice_cgroup
            .lock()
            .ok()
            .and_then(|path| path.clone())
            .map(|path| path.is_dir())
            .unwrap_or(false)
    }

    /// Applies one `setResources` update and persists the result.
    ///
    /// Each argument is the client's field: absent or `null` keeps the value
    /// already in force. The decode and the cap rule are the governor's own,
    /// so the refusal text a client sees has one owner.
    ///
    /// This is the operator's path, so it answers after the settings write and
    /// never waits for the user manager: the slice's memory marks follow on
    /// the applier [`Self::schedule_apply`] leaves behind.
    pub fn apply_update(
        self: &Arc<Self>,
        max_agent_peers: Option<&Value>,
        memory_high_mb: Option<&Value>,
        memory_max_mb: Option<&Value>,
        memory_reserve_mb: Option<&Value>,
    ) -> Result<Settings, String> {
        let number = |value: Option<&Value>, label: &str| -> Result<Option<u64>, String> {
            match value {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value
                    .as_u64()
                    .map(Some)
                    .ok_or_else(|| format!("{label} must be a whole number of megabytes.")),
            }
        };
        let mut settings = self.settings();
        if let Some(value) = number(max_agent_peers, "Max concurrent agents")? {
            settings.max_agent_peers = value
                .try_into()
                .map_err(|_| "Max concurrent agents must be between 1 and 64.".to_string())?;
        }
        if let Some(value) = number(memory_high_mb, "Memory high")? {
            settings.memory_high_mb = Some(value);
        }
        if let Some(value) = number(memory_max_mb, "Memory max")? {
            settings.memory_max_mb = Some(value);
        }
        if let Some(value) = number(memory_reserve_mb, "Reserve")? {
            settings.memory_reserve_mb = Some(value);
        }
        let settings = self.persist(settings)?;
        self.schedule_apply();
        Ok(settings)
    }

    /* -------------------------------------------------------------------- */
    /* Admission                                                             */
    /* -------------------------------------------------------------------- */

    /// Tries once to admit a start. A deferral leaves the caller's work
    /// queued; nothing is marked failed and nothing already running stops.
    ///
    /// A Discover start is outside the cap: its slot is created while every
    /// cap slot is held. The memory reserve still defers it like any other
    /// start, and its slot is marked so the cap never counts it.
    pub fn try_acquire(
        &self,
        kind: &str,
        starter: &str,
        label: &str,
    ) -> Result<Slot, AdmissionError> {
        self.refresh_settings();
        let settings = self.settings();
        let exempt = cap_exempt(kind);
        // The count and the slot creation happen under one lock so two
        // processes cannot both see a free slot at the cap boundary. A lock
        // that cannot be taken defers the start: admitting without it would
        // void the serialization this section exists for.
        let lock_path = self.directory.join(LOCK_FILE);
        let _guard = file_lock(&lock_path).map_err(|error| {
            AdmissionError::Deferred(DeferReason::Lock {
                path: lock_path.display().to_string(),
                cause: error.to_string(),
            })
        })?;
        let (cap_slots, _) = self.split_live_slots();
        let active = cap_slots.len() as u32;
        if !exempt && active >= settings.max_agent_peers {
            return Err(AdmissionError::Deferred(DeferReason::Cap(
                CapDeferral::new(settings.max_agent_peers, &cap_slots),
            )));
        }
        if let (Some(available), Some(reserve)) =
            (self.memory.available_mb(), settings.memory_reserve_mb)
        {
            if available < reserve {
                return Err(AdmissionError::Deferred(DeferReason::Memory {
                    available_mb: available,
                    reserve_mb: reserve,
                }));
            }
        }
        let slot = self
            .create_slot(kind, starter, label, exempt)
            .map_err(|error| self.note_slot_write(error))?;
        // A slot written after a failed one proves the directory writable, so
        // a later failure of the same shape records its own line again.
        if let Ok(mut journaled) = self.slot_error_journaled.lock() {
            *journaled = None;
        }
        Ok(slot)
    }

    /// Waits until one slot is free. This is how an in-process start (a goal
    /// lane, a run owner, the Release Train peer) defers without failing.
    ///
    /// A slot record the state directory refuses is returned instead of waited
    /// on: no retry admits a start that cannot write its slot.
    pub async fn wait_for_admission(
        &self,
        kind: &str,
        starter: &str,
        label: &str,
    ) -> Result<Slot, SlotWriteError> {
        loop {
            match self.try_acquire(kind, starter, label) {
                Ok(slot) => return Ok(slot),
                Err(AdmissionError::Deferred(reason)) => {
                    self.record_deferral(kind, label, &reason);
                    tokio::time::sleep(Duration::from_millis(ADMISSION_POLL_MS)).await;
                }
                Err(AdmissionError::SlotWrite(error)) => return Err(error),
            }
        }
    }

    /// The live slot count that holds the cap. A Discover peer never counts.
    pub fn active_agents(&self) -> u32 {
        self.split_live_slots().0.len() as u32
    }

    /// The live Discover peers outside the cap.
    pub fn exempt_agents(&self) -> u32 {
        self.split_live_slots().1.len() as u32
    }

    /// The live slots grouped by the starter that created each one. The counts
    /// sum to [`Governor::active_agents`], and a slot an older harness wrote
    /// without a starter counts as `unknown`. A Discover peer is outside the
    /// cap and never appears here.
    pub fn active_by_starter(&self) -> BTreeMap<String, u32> {
        cap_groups(&self.split_live_slots().0)
            .into_iter()
            .map(|group| (group.starter, group.count))
            .collect()
    }

    /// How many live cap slots one starter holds. A family between cadence
    /// ticks holds none, which is narrower than its worker still running.
    pub fn active_for(&self, starter: &str) -> u32 {
        cap_groups(&self.split_live_slots().0)
            .into_iter()
            .find(|group| group.starter == starter)
            .map(|group| group.count)
            .unwrap_or(0)
    }

    /// Records one deferral in `deferrals.jsonl` and the dashboard journal.
    /// The same label is recorded at most once per [`DEFERRAL_DEDUPE_MS`].
    pub fn record_deferral(&self, kind: &str, label: &str, reason: &DeferReason) {
        let now = epoch_millis();
        let key = format!("{kind}\u{0}{label}\u{0}{}", reason.code());
        let due = self
            .deferral_stamp
            .lock()
            .map(|stamps| {
                stamps
                    .get(&key)
                    .map(|last| now.saturating_sub(*last) >= DEFERRAL_DEDUPE_MS)
                    .unwrap_or(true)
            })
            .unwrap_or(true);
        if let Ok(mut stamps) = self.deferral_stamp.lock() {
            if stamps.len() > 4_096 {
                stamps.clear();
            }
            stamps.insert(key, now);
        }
        if !due {
            return;
        }
        let mut line = reason.to_json();
        if let Some(object) = line.as_object_mut() {
            object.insert("at".to_string(), json!(iso_now()));
            object.insert("kind".to_string(), json!(kind));
            object.insert("label".to_string(), json!(label));
            object.insert("detail".to_string(), json!(reason.message()));
        }
        let _ = append_line(&self.directory.join(DEFERRALS_FILE), &line.to_string());
        if let Ok(journal) = self.journal.lock() {
            if let Some(hook) = journal.as_ref() {
                hook(
                    "resource-defer",
                    &format!("{kind} {label}: {}", reason.message()),
                );
            }
        }
    }

    /// Every recorded deferral, newest last.
    pub fn read_deferrals(&self) -> Vec<Value> {
        read_json_lines(&self.directory.join(DEFERRALS_FILE))
    }

    /// Journals one slot write that failed, once per unchanged directory and
    /// I/O reason, and hands the failure back as an admission error.
    ///
    /// A state directory the process cannot write is an error in the journal,
    /// never a cap deferral: the deferral log keeps naming capacity the
    /// governor actually saw, and the line names the path and the I/O reason an
    /// operator has to fix.
    fn note_slot_write(&self, error: SlotWriteError) -> AdmissionError {
        let key = format!("{}: {}", error.directory().display(), error.error());
        let already = self
            .slot_error_journaled
            .lock()
            .map(|journaled| journaled.as_deref() == Some(key.as_str()))
            .unwrap_or(true);
        if !already {
            if let Ok(mut journaled) = self.slot_error_journaled.lock() {
                *journaled = Some(key);
            }
            if let Some(hook) = self.journal.lock().ok().and_then(|hook| hook.clone()) {
                hook(
                    "server-error",
                    &format!("{}; the start failed", error.message()),
                );
            }
        }
        AdmissionError::SlotWrite(error)
    }

    /* -------------------------------------------------------------------- */
    /* Slots                                                                 */
    /* -------------------------------------------------------------------- */

    fn slots_directory(&self) -> PathBuf {
        self.directory.join(SLOTS_DIRECTORY)
    }

    fn live_slots(&self) -> Vec<Value> {
        let directory = self.slots_directory();
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => return Vec::new(),
        };
        let mut live = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                Err(_) => continue,
            };
            let value: Value = match serde_json::from_str(&text) {
                Ok(value) => value,
                Err(_) => {
                    let _ = fs::remove_file(&path);
                    continue;
                }
            };
            let pid = value.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
            let started = value.get("pidStart").and_then(Value::as_u64);
            if slot_holder_live(pid, started) {
                live.push(value);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
        live
    }

    /// The live slot records split into the ones that hold the cap and the
    /// ones outside it. The two lengths sum to the live slot count.
    fn split_live_slots(&self) -> (Vec<Value>, Vec<Value>) {
        let mut cap = Vec::new();
        let mut exempt = Vec::new();
        for slot in self.live_slots() {
            if slot_exempt(&slot) {
                exempt.push(slot);
            } else {
                cap.push(slot);
            }
        }
        (cap, exempt)
    }

    fn create_slot(
        &self,
        kind: &str,
        starter: &str,
        label: &str,
        exempt: bool,
    ) -> Result<Slot, SlotWriteError> {
        let directory = self.slots_directory();
        let id = uuid::Uuid::new_v4().to_string();
        let path = directory.join(format!("{id}.json"));
        let pid = std::process::id();
        let mut record = json!({
            "id": id,
            "pid": pid,
            "pidStart": process_start_ticks(pid),
            "kind": kind,
            "starter": starter,
            "label": label,
            "startedAt": iso_now(),
        });
        if exempt {
            record["exempt"] = Value::Bool(true);
        }
        write_json_atomically(&path, &record)
            .map_err(|error| SlotWriteError { directory, error })?;
        Ok(Slot {
            path,
            id,
            starter: starter.to_string(),
        })
    }

    /* -------------------------------------------------------------------- */
    /* Slice                                                                 */
    /* -------------------------------------------------------------------- */

    pub fn slice_enabled(&self) -> bool {
        self.slice_enabled
    }

    /// The full slice path, which the tests treat as a child of the root.
    pub fn slice_name(&self) -> &str {
        &self.slice_name
    }

    pub fn slice_info(&self) -> SliceInfo {
        if !self.slice_enabled {
            return SliceInfo::default();
        }
        let path = self.slice_cgroup.lock().ok().and_then(|path| path.clone());
        let live = slice_info_from_cgroup(path.as_deref());
        if live.present {
            return live;
        }
        self.slice
            .lock()
            .map(|info| info.clone())
            .unwrap_or_default()
    }

    /// Creates the transient slice if needed and applies the current budget.
    /// Returns whether the slice is available for membership.
    pub fn apply_slice(&self) -> SliceInfo {
        if !self.slice_enabled {
            return SliceInfo::default();
        }
        let _guard = self
            .apply_lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        self.apply_slice_locked()
    }

    /// One slice transaction with the apply lock already held.
    ///
    /// A budget with no memory mark never reaches the slice: the host's total
    /// was not read, so there is no maximum to enforce and nothing derived
    /// from an unknown total may be written. The slice keeps whatever it
    /// carries rather than being limited to a placeholder.
    fn apply_slice_locked(&self) -> SliceInfo {
        let settings = self.settings();
        if !settings.has_memory() {
            return SliceInfo::default();
        }
        let marker = slice_owner_marker(&self.state_dir);
        let applied = apply_slice_properties_owned(&self.slice_name, settings, Some(&marker));
        if applied.info.present {
            if let Some(path) = applied.path.clone() {
                if let Ok(mut current) = self.slice_cgroup.lock() {
                    *current = Some(path);
                }
            }
        } else {
            self.slice_wrap.store(false, Ordering::SeqCst);
        }
        if let Ok(mut current) = self.applied.lock() {
            *current = (applied.wrote && applied.info.present).then_some(settings);
        }
        if let Ok(mut current) = self.slice.lock() {
            *current = applied.info.clone();
        }
        applied.info
    }

    /// True when a spawned child must be wrapped in a transient scope to join
    /// the slice. A process already inside the slice needs no wrapper: its
    /// children inherit the membership.
    pub fn needs_wrapper(&self) -> bool {
        self.slice_enabled
            && self.slice_wrap.load(Ordering::SeqCst)
            && self.slice_info().present
            && !current_in_slice()
    }

    /// Prepends the transient-scope launcher so the child runs inside the
    /// governor's slice. The wrapper execs the command, keeping its pid, its
    /// stdio, and its process group.
    pub fn wrap_argv(&self, argv: Vec<String>) -> Vec<String> {
        self.wrap_argv_inner(argv, None, false)
    }

    /// Like [`Self::wrap_argv`], but the transient scope carries its own hard
    /// memory limit. The slice tests use this to prove the kernel kill without
    /// changing the budget the dashboard runs with. A scope is created even
    /// when this process already belongs to the slice, because the limit is
    /// what the caller wants to prove.
    pub fn wrap_argv_with_limit(&self, argv: Vec<String>, settings: Settings) -> Vec<String> {
        self.wrap_argv_inner(argv, Some(settings), true)
    }

    /// Wraps a child in this governor's slice even when this process already
    /// belongs to it. The slice tests use this to place an allocator in their
    /// own slice while the release suite itself runs inside `devboard.slice`.
    pub fn wrap_argv_in_slice(&self, argv: Vec<String>) -> Vec<String> {
        self.wrap_argv_inner(argv, None, true)
    }

    fn wrap_argv_inner(
        &self,
        argv: Vec<String>,
        limit: Option<Settings>,
        force: bool,
    ) -> Vec<String> {
        let wrap = if force {
            self.slice_enabled && self.slice_info().present
        } else {
            self.needs_wrapper()
        };
        if !wrap || argv.is_empty() {
            return argv;
        }
        let mut wrapped = vec![
            "systemd-run".to_string(),
            "--user".to_string(),
            "--scope".to_string(),
            "--quiet".to_string(),
            "--collect".to_string(),
        ];
        wrapped.extend(scope_property_arguments(io_weight(), limit));
        wrapped.push(format!("--slice={}", self.slice_name));
        wrapped.push("--".to_string());
        wrapped.extend(argv);
        wrapped
    }

    /// Reads the slice's kernel kill counter. Returns the new kills since the
    /// last poll, so the dashboard can journal them.
    pub fn collect_kills(&self) -> Vec<KillRecord> {
        if !self.slice_enabled {
            return Vec::new();
        }
        let Some(path) = self.slice_cgroup.lock().ok().and_then(|path| path.clone()) else {
            return Vec::new();
        };
        let kills = read_oom_kills(&path);
        let previous = self.last_oom_kills.swap(kills, Ordering::SeqCst);
        if kills <= previous {
            return Vec::new();
        }
        let info = self.slice_info();
        let record = KillRecord {
            oom_kills: kills - previous,
            memory_current_mb: info.memory_current_mb,
            memory_max_mb: info.memory_max_mb,
            at: iso_now(),
        };
        let line = json!({
            "at": record.at,
            "kills": record.oom_kills,
            "memoryCurrentMb": record.memory_current_mb,
            "memoryMaxMb": record.memory_max_mb,
        });
        let _ = append_line(&self.directory.join(KILLS_FILE), &line.to_string());
        if let Ok(journal) = self.journal.lock() {
            if let Some(hook) = journal.as_ref() {
                hook("resource-kill", &record.message());
            }
        }
        vec![record]
    }

    /// The Resources tab's readback: the saved values, the effective values,
    /// and the live counters.
    pub fn state_event(&self) -> Value {
        self.refresh_settings();
        let saved = self.saved_settings();
        let effective = self.settings();
        let settings_error = self.settings_error();
        let memory_error = self.memory_error();
        let info = self.slice_info();
        // One read answers both counts, so the cap's count and the exempt
        // count always add up to the slots a reader can list.
        let (cap_slots, exempt_slots) = self.split_live_slots();
        json!({
            "type": "resourcesState",
            "state": {
                "saved": if saved.is_empty() { Value::Null } else { saved.to_json() },
                "settingsError": settings_error,
                "memoryError": memory_error,
                "effective": effective.to_json(),
                "live": {
                    "activeAgents": cap_slots.len() as u32,
                    "exemptAgents": exempt_slots.len() as u32,
                    "availableMb": self.memory.available_mb().unwrap_or(0),
                    "slicePresent": info.present,
                    "memoryHighMb": info.memory_high_mb,
                    "memoryMaxMb": info.memory_max_mb,
                    "memoryCurrentMb": info.memory_current_mb,
                },
            },
        })
    }

    /// The stress harness's readback.
    pub fn status_json(&self) -> Value {
        let event = self.state_event();
        json!({
            "settings": event["state"]["effective"].clone(),
            "live": event["state"]["live"].clone(),
            "slots": self.live_slots(),
        })
    }
}

impl std::fmt::Debug for Governor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Governor")
            .field("state_dir", &self.state_dir)
            .field("settings", &self.settings())
            .field("slice_enabled", &self.slice_enabled)
            .finish()
    }
}

/* ------------------------------------------------------------------------ */
/* Process-wide governor                                                     */
/* ------------------------------------------------------------------------ */

static GLOBAL_GOVERNOR: OnceLock<Arc<Governor>> = OnceLock::new();

/// Installs the process-wide governor. The first install wins; a dashboard
/// and every worker it starts use one instance each.
pub fn install(state_dir: &Path, slice: bool) -> Arc<Governor> {
    GLOBAL_GOVERNOR
        .get_or_init(|| {
            let mut options = GovernorOptions::system();
            options.slice = slice && cfg!(target_os = "linux");
            Governor::new(state_dir, options)
        })
        .clone()
}

/// Installs the governor production paths use.
pub fn install_production(state_dir: &Path) -> Arc<Governor> {
    install(state_dir, true)
}

/// Installs a governor that joins the live slice without rewriting its
/// properties. Every CLI and worker entry point uses this: only the dashboard
/// owns the budget the slice enforces.
pub fn install_attached(state_dir: &Path) -> Arc<Governor> {
    GLOBAL_GOVERNOR
        .get_or_init(|| {
            let mut options = GovernorOptions::system();
            options.slice = cfg!(target_os = "linux");
            Governor::attached(state_dir, options)
        })
        .clone()
}

/// The installed governor, if this process owns one. A library or contract
/// test that never installed one starts peers ungoverned; every production
/// entry point installs one.
pub fn global() -> Option<&'static Arc<Governor>> {
    GLOBAL_GOVERNOR.get()
}

/// The governor an `App` reports through the Resources tab. Production has
/// already installed the real one; a test gets a slice-free view of its own
/// state directory.
pub fn for_app(state_dir: &Path) -> Arc<Governor> {
    match global() {
        Some(governor) => governor.clone(),
        None => Governor::new(
            state_dir,
            GovernorOptions::in_memory(Arc::new(SystemMemory), std::env::vars().collect()),
        ),
    }
}

/// Wraps a spawn argv in the transient slice when this process installed one
/// and is not already inside the slice.
pub fn wrap_argv(argv: Vec<String>) -> Vec<String> {
    match global() {
        Some(governor) => governor.wrap_argv(argv),
        None => argv,
    }
}

/// True when this process must join the slice through a wrapper.
pub fn needs_wrapper() -> bool {
    global()
        .map(|governor| governor.needs_wrapper())
        .unwrap_or(false)
}

/* ------------------------------------------------------------------------ */
/* Slice helpers                                                             */
/* ------------------------------------------------------------------------ */

fn settings_path(state_dir: &Path) -> PathBuf {
    state_dir.join(RESOURCES_DIRECTORY).join(SETTINGS_FILE)
}

/// Reads the saved budget. `Ok(None)` means the file is absent, so the derived
/// defaults stand. `Err` names the file and why its bytes are not a budget: the
/// caller reports that refusal instead of silently reverting the operator's
/// cap, and the derived defaults stay in force until the file reads again.
fn read_saved_settings(directory: &Path) -> Result<Option<SavedSettings>, String> {
    let path = directory.join(SETTINGS_FILE);
    let shown = path.display();
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{shown}: {error}")),
    };
    let value: Value = serde_json::from_str(&text).map_err(|error| format!("{shown}: {error}"))?;
    SavedSettings::from_value(&value)
        .map(Some)
        .map_err(|error| format!("{shown}: {error}"))
}

/// The governor's startup and refresh verdict: the saved budget, or the
/// derived defaults plus the reason the file was refused.
fn read_saved_verdict(directory: &Path) -> (SavedSettings, Option<String>) {
    match read_saved_settings(directory) {
        Ok(saved) => (saved.unwrap_or_default(), None),
        Err(error) => (SavedSettings::default(), Some(error)),
    }
}

fn file_stamp(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|meta| meta.modified()).ok()
}

/// Runs one short command and returns its trimmed stdout.
#[cfg(target_os = "linux")]
fn run_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The flat unit name of a slice, which `systemctl` addresses.
fn leaf_slice_name(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

/// Starts one slice unit. A slice unit is runtime-only; this creates it when
/// it is absent and is a no-op when it already runs.
#[cfg(target_os = "linux")]
fn ensure_slice_unit(name: &str) -> bool {
    Command::new("systemctl")
        .args(["--user", "start", leaf_slice_name(name)])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn ensure_slice_unit(_name: &str) -> bool {
    false
}

/// The absolute cgroup directory of one transient slice, when it exists.
#[cfg(target_os = "linux")]
pub fn slice_cgroup_path_for(name: &str) -> Option<PathBuf> {
    let leaf = leaf_slice_name(name);
    let control = run_output(
        "systemctl",
        &["--user", "show", leaf, "-p", "ControlGroup", "--value"],
    )?;
    if control.is_empty() {
        return None;
    }
    let path = Path::new("/sys/fs/cgroup").join(control.trim_start_matches('/'));
    path.is_dir().then_some(path)
}

/// There is no cgroup outside Linux; the cap and admission control still run.
#[cfg(not(target_os = "linux"))]
pub fn slice_cgroup_path_for(_name: &str) -> Option<PathBuf> {
    None
}

/// The unit description that names which dashboard owns the slice budget.
fn slice_owner_marker(state_dir: &Path) -> String {
    format!("devboard owner {}", state_dir.display())
}

/// One `systemctl` read of the facts an apply needs: the slice's control group
/// and its description. `None` means the unit is absent or systemd answered
/// nothing, so the caller has to start it first.
///
/// systemd chooses the order the properties print in, so each line is matched
/// by name rather than by position.
#[cfg(target_os = "linux")]
fn slice_facts(name: &str) -> Option<(PathBuf, String)> {
    let text = run_output(
        "systemctl",
        &[
            "--user",
            "show",
            leaf_slice_name(name),
            "-p",
            "ControlGroup",
            "-p",
            "Description",
        ],
    )?;
    let mut control = "";
    let mut description = "";
    for line in text.lines() {
        match line.split_once('=') {
            Some(("ControlGroup", value)) => control = value.trim(),
            Some(("Description", value)) => description = value.trim(),
            _ => {}
        }
    }
    if control.is_empty() {
        return None;
    }
    let path = Path::new("/sys/fs/cgroup").join(control.trim_start_matches('/'));
    path.is_dir().then(|| (path, description.to_string()))
}

/// What one slice apply found, wrote, and can report.
#[derive(Default)]
struct AppliedSlice {
    info: SliceInfo,
    /// The control group the apply resolved, so no second `show` is needed.
    path: Option<PathBuf>,
    /// True when this process wrote the properties. False leaves the budget
    /// unrecorded, so a later save tries again.
    wrote: bool,
}

/// Creates the named slice if needed and sets its memory limits. Returns the
/// live facts; `present: false` means this host cannot enforce a slice.
#[cfg(target_os = "linux")]
pub fn apply_slice_properties_for(name: &str, settings: Settings) -> SliceInfo {
    apply_slice_properties_owned(name, settings, None).info
}

/// Like [`apply_slice_properties_for`], but refuses to rewrite a slice another
/// dashboard already owns. A workspace test's ephemeral dashboard, a second
/// dashboard, and a CLI all see the live description and only join it.
///
/// A warm slice costs one `systemctl show` and one `set-property`: every
/// property this slice owns travels in a single transaction, because each
/// separate call is another wait in the user manager's queue and the caller is
/// an operator waiting for the save.
#[cfg(target_os = "linux")]
fn apply_slice_properties_owned(
    name: &str,
    settings: Settings,
    marker: Option<&str>,
) -> AppliedSlice {
    let mut facts = slice_facts(name);
    if let (Some(marker), Some((path, description))) = (marker, facts.as_ref()) {
        // Only another dashboard's explicit marker blocks this one; a
        // system-generated description is a slice still to be claimed.
        if description.starts_with("devboard owner ") && description != marker {
            return AppliedSlice {
                info: slice_info_from_cgroup(Some(path)),
                path: Some(path.clone()),
                wrote: false,
            };
        }
    }
    if facts.is_none() {
        if !ensure_slice_unit(name) {
            return AppliedSlice::default();
        }
        facts = slice_facts(name);
    }
    let Some((path, description)) = facts else {
        return AppliedSlice::default();
    };
    let leaf = leaf_slice_name(name);
    let mut properties = Vec::new();
    // A budget with no memory mark carries no maximum to enforce, so no memory
    // property is written: an unknown total never becomes a limit.
    if let (Some(high), Some(max)) = (settings.memory_high_mb, settings.memory_max_mb) {
        properties.push(format!("MemoryHigh={}", high.saturating_mul(MIB)));
        // The hard limit bounds RAM. Unlimited swap would let a runaway agent
        // grow past it and pressure the session instead.
        properties.push(format!("MemoryMax={}", max.saturating_mul(MIB)));
        properties.push("MemorySwapMax=0".to_string());
    }
    properties.push(format!("IOWeight={}", io_weight()));
    if let Some(marker) = marker {
        // A slice already named for this dashboard is left as it is; the
        // description is a claim, not a value a save has to rewrite.
        if description != marker {
            properties.push(format!("Description={marker}"));
        }
    }
    let mut wrote = set_slice_properties(leaf, &properties);
    if !wrote {
        // A systemd or cgroup that does not take an IO weight still gets the
        // memory bounds; the build weight is the optional half of this
        // transaction.
        properties.retain(|property| !property.starts_with("IOWeight="));
        wrote = set_slice_properties(leaf, &properties);
    }
    if !wrote {
        // An older systemd that cannot set the swap bound still gets the RAM
        // bound: the next transaction drops that one property too.
        properties.retain(|property| !property.starts_with("MemorySwapMax="));
        wrote = set_slice_properties(leaf, &properties);
    }
    if !wrote {
        return AppliedSlice::default();
    }
    AppliedSlice {
        info: slice_info_from_cgroup(Some(&path)),
        path: Some(path),
        wrote: true,
    }
}

/// Runs one `set-property` transaction on a slice. Every property travels in
/// the same call, because each separate call is another wait in the user
/// manager's queue.
#[cfg(target_os = "linux")]
fn set_slice_properties(leaf: &str, properties: &[String]) -> bool {
    let mut command = Command::new("systemctl");
    command.args(["--user", "set-property", "--runtime", leaf]);
    command.args(properties);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// No cgroup on this platform; the cap and admission control still apply.
#[cfg(not(target_os = "linux"))]
pub fn apply_slice_properties_for(_name: &str, _settings: Settings) -> SliceInfo {
    SliceInfo::default()
}

#[cfg(not(target_os = "linux"))]
fn apply_slice_properties_owned(
    _name: &str,
    _settings: Settings,
    _marker: Option<&str>,
) -> AppliedSlice {
    AppliedSlice::default()
}

fn slice_info_from_cgroup(path: Option<&Path>) -> SliceInfo {
    let Some(path) = path else {
        return SliceInfo::default();
    };
    let read = |name: &str| -> Option<u64> {
        let text = fs::read_to_string(path.join(name)).ok()?;
        let text = text.trim();
        if text == "max" {
            return Some(0);
        }
        text.parse::<u64>().ok()
    };
    let high = read("memory.high").unwrap_or(0);
    let max = read("memory.max").unwrap_or(0);
    let current = read("memory.current").unwrap_or(0);
    SliceInfo {
        present: true,
        memory_high_mb: high / MIB,
        memory_max_mb: max / MIB,
        memory_current_mb: current / MIB,
    }
}

fn read_oom_kills(path: &Path) -> u64 {
    let text = match fs::read_to_string(path.join("memory.events")) {
        Ok(text) => text,
        Err(_) => return 0,
    };
    let mut total = 0;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let value = parts.next().and_then(|value| value.parse::<u64>().ok());
        if matches!(key, "oom_kill" | "oom_group_kill") {
            total += value.unwrap_or(0);
        }
    }
    total
}

/// True when this process is already a member of the slice.
#[cfg(target_os = "linux")]
pub fn current_in_slice() -> bool {
    let text = match fs::read_to_string("/proc/self/cgroup") {
        Ok(text) => text,
        Err(_) => return false,
    };
    text.contains(SLICE_NAME)
}

#[cfg(not(target_os = "linux"))]
pub fn current_in_slice() -> bool {
    false
}

/// Stops one transient slice. The slice tests own their unit; the dashboard
/// only sets properties.
#[cfg(target_os = "linux")]
pub fn stop_slice_for(name: &str) -> bool {
    Command::new("systemctl")
        .args(["--user", "stop", leaf_slice_name(name)])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
pub fn stop_slice_for(_name: &str) -> bool {
    false
}

/* ------------------------------------------------------------------------ */
/* Process facts                                                             */
/* ------------------------------------------------------------------------ */

/// True while the process that wrote a slot still runs.
#[cfg(target_os = "linux")]
fn slot_holder_live(pid: u32, started: Option<u64>) -> bool {
    pid != 0 && process_start_ticks(pid) == started
}

/// True while the process that wrote a slot still runs. Without `/proc`, a
/// signal-0 probe is the available liveness check.
#[cfg(not(target_os = "linux"))]
fn slot_holder_live(pid: u32, _started: Option<u64>) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The kernel start time (field 22 of `stat`) that distinguishes a live pid
/// from a recycled one.
#[cfg(target_os = "linux")]
pub fn process_start_ticks(pid: u32) -> Option<u64> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = text.rfind(')')?;
    let fields: Vec<&str> = text[close + 1..].split_whitespace().collect();
    // After the command name, field 3 is state; start time is field 22, so
    // index 19 in the tail.
    fields.get(19).and_then(|value| value.parse::<u64>().ok())
}

#[cfg(not(target_os = "linux"))]
pub fn process_start_ticks(_pid: u32) -> Option<u64> {
    None
}

/* ------------------------------------------------------------------------ */
/* File helpers                                                              */
/* ------------------------------------------------------------------------ */

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn iso_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Replaces one governor file through the harness's one atomic writer.
///
/// A staged write plus a rename keeps the file whole and is what answers the
/// operator; the kernel's writeback owns the flush. A `sync_all` here put the
/// filesystem's own flush latency on every `setResources` request, and on this
/// host that flush measured 250 ms to 1 s for a hundred-byte settings file.
/// The dashboard state file, which is the larger and more consequential
/// record, is written the same way.
fn write_json_atomically(path: &Path, value: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    crate::state::write_state_file(path, &format!("{text}\n"))
}

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// An exclusive advisory lock for the slot directory. The guard releases the
/// lock when dropped.
struct FileLock {
    file: File,
}

impl Drop for FileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::flock(
                std::os::unix::io::AsRawFd::as_raw_fd(&self.file),
                libc::LOCK_UN,
            );
        }
    }
}

/// Takes the slot directory's admission lock, naming the cause when it cannot.
///
/// The failure is reported rather than swallowed: a caller that continued
/// without the guard would serialize neither the live count nor the slot
/// write. A platform without `flock` has no lock to take and no failure to
/// report, so the guard is a documented no-op there.
fn file_lock(path: &Path) -> std::io::Result<FileLock> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    #[cfg(unix)]
    unsafe {
        if libc::flock(std::os::unix::io::AsRawFd::as_raw_fd(&file), libc::LOCK_EX) != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(FileLock { file })
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_budget_follows_the_documented_formula() {
        let settings = Settings::derive(100_000, 32);
        assert_eq!(settings.memory_reserve_mb, Some(25_000));
        assert_eq!(settings.memory_max_mb, Some(75_000));
        assert_eq!(settings.memory_high_mb, Some(60_000));
        assert_eq!(settings.max_agent_peers, 8);
        let small = Settings::derive(4_096, 2);
        assert_eq!(small.memory_reserve_mb, Some(1_024));
        assert_eq!(small.memory_max_mb, Some(3_072));
        assert_eq!(small.memory_high_mb, Some(2_457));
        assert_eq!(small.max_agent_peers, 1);
    }

    #[test]
    fn a_loaded_budget_is_normalized_into_the_validator_bounds() {
        // A frame or a saved file that carries values under the floors loads
        // inside them, so the effective budget is never one `validate` refuses.
        let mut settings = Settings {
            max_agent_peers: 8,
            memory_high_mb: 64,
            memory_max_mb: 64,
            memory_reserve_mb: 512,
        };
        settings.normalize();
        assert_eq!(settings.memory_max_mb, MIN_MEMORY_MAX_MB);
        assert_eq!(settings.memory_reserve_mb, MIN_MEMORY_MAX_MB - 1);
        assert_eq!(settings.memory_high_mb, MIN_MEMORY_FLOOR_MB);
        assert_eq!(settings.validate(), Ok(()));
        let decoded = Settings::from_value(&settings.to_json()).expect("the frame decodes");
        assert_eq!(decoded, settings);
    }

    #[test]
    fn the_meminfo_parser_reads_total_and_available() {
        let text =
            "MemTotal:       98783752 kB\nMemFree:         1234 kB\nMemAvailable:   50000000 kB\n";
        assert_eq!(parse_meminfo(text), (Ok(96_468), Some(48_828)));
    }

    #[test]
    fn a_meminfo_without_a_total_is_a_failed_read() {
        let (total, available) = parse_meminfo("MemFree: 1234 kB\nMemAvailable: 4096 kB\n");
        assert!(
            total.is_err(),
            "a file without MemTotal never reads as a total"
        );
        assert_eq!(available, Some(4));
        // A zero total is a failed read too: no budget is derived from it.
        let (total, _) = parse_meminfo("MemTotal: 0 kB\n");
        assert!(total.is_err(), "a zero total is not a total");
    }

    #[test]
    fn the_macos_vm_stat_parser_sums_reclaimable_pages() {
        let text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
Pages free:                               1000.\n\
Pages active:                             9999.\n\
Pages inactive:                           2000.\n\
Pages speculative:                         500.\n\
Pages purgeable:                           250.\n";
        assert_eq!(parse_vm_stat(text, 16_384), Some(61_440_000));
    }

    /// The governor the update tests build: fixed host facts, no slice.
    struct TestMemory {
        total_mb: u64,
        available_mb: u64,
        cpus: u32,
    }

    impl MemoryReader for TestMemory {
        fn total_mb(&self) -> Result<u64, String> {
            Ok(self.total_mb)
        }

        fn available_mb(&self) -> Option<u64> {
            Some(self.available_mb)
        }

        fn cpu_count(&self) -> u32 {
            self.cpus
        }
    }

    /// A scratch state directory inside the repository.
    fn scratch(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or(0);
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-tmp")
            .join(format!(
                "resources-{label}-{}",
                nanos ^ NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&root).expect("the scratch directory");
        root
    }

    fn test_governor(directory: &Path) -> Arc<Governor> {
        Governor::new(
            directory,
            GovernorOptions::in_memory(
                Arc::new(TestMemory {
                    total_mb: 64_000,
                    available_mb: 60_000,
                    cpus: 16,
                }),
                BTreeMap::new(),
            ),
        )
    }

    #[test]
    fn an_update_refuses_a_zero_peer_cap_before_writing() {
        let directory = scratch("update-refused");
        let governor = test_governor(&directory);
        let zero = json!(0);
        let refused = governor.apply_update(Some(&zero), None, None, None);
        assert_eq!(
            refused,
            Err("Max concurrent agents must be between 1 and 64.".to_string())
        );
        assert!(!settings_path(&directory).exists());
        assert_eq!(governor.settings(), governor.defaults());
    }

    #[test]
    fn the_live_peers_are_counted_per_starter() {
        let directory = scratch("peers-per-starter");
        let governor = test_governor(&directory);
        assert!(governor.active_by_starter().is_empty());
        let first = governor
            .try_acquire("peer", "Auto Scout", "scan 1")
            .expect("a slot");
        let second = governor
            .try_acquire("peer", "Auto Scout", "scan 2")
            .expect("a second slot");
        let third = governor
            .try_acquire("peer", "MCP optimizer", "cycle 1")
            .expect("a third slot");
        assert_eq!(
            governor.active_by_starter(),
            BTreeMap::from([
                ("Auto Scout".to_string(), 2),
                ("MCP optimizer".to_string(), 1),
            ])
        );
        assert_eq!(governor.active_for("Auto Scout"), 2);
        assert_eq!(governor.active_for("MCP optimizer"), 1);
        // A family between cadence ticks holds none while its worker runs.
        assert_eq!(governor.active_for("Dead Code"), 0);
        drop(first);
        drop(second);
        drop(third);
        assert!(governor.active_by_starter().is_empty());
        assert_eq!(governor.active_for("Auto Scout"), 0);
    }

    #[test]
    fn an_update_persists_the_merged_settings_and_reports_them() {
        let directory = scratch("update-saved");
        let governor = test_governor(&directory);
        let peers = json!(2);
        let high = json!(512);
        let max = json!(1_024);
        let reserve = json!(256);
        let saved = governor
            .apply_update(Some(&peers), Some(&high), Some(&max), Some(&reserve))
            .expect("the update validates");
        assert_eq!(
            saved,
            Settings {
                max_agent_peers: 2,
                memory_high_mb: Some(512),
                memory_max_mb: Some(1_024),
                memory_reserve_mb: Some(256),
            }
        );
        assert_eq!(governor.settings(), saved);
        let text = fs::read_to_string(settings_path(&directory)).expect("the settings file");
        assert!(text.contains("\"maxAgentPeers\": 2"));
        assert!(text.contains("\"memoryReserveMb\": 256"));
        let frame = governor.state_event();
        assert_eq!(frame["state"]["saved"]["maxAgentPeers"], 2);
        assert_eq!(frame["state"]["effective"]["memoryMaxMb"], 1_024);
        // An absent field keeps the value already in force.
        let peers = json!(3);
        let kept = governor
            .apply_update(Some(&peers), None, None, None)
            .expect("the update validates");
        assert_eq!(kept.max_agent_peers, 3);
        assert_eq!(kept.memory_max_mb, Some(1_024));
    }

    /// Writes `text` as the saved settings file under one scratch directory.
    fn write_settings(directory: &Path, text: &str) {
        let path = settings_path(directory);
        fs::create_dir_all(path.parent().expect("the resources directory"))
            .expect("the resources directory");
        fs::write(&path, text).expect("the settings file");
        // A fresh write must reach a new modification time, so the governor's
        // stamp check re-reads it.
        std::thread::sleep(Duration::from_millis(20));
    }

    #[test]
    fn a_rejected_settings_file_is_reported_and_the_derived_budget_stands() {
        let directory = scratch("settings-refused");
        write_settings(&directory, "{");
        let governor = test_governor(&directory);
        let derived = governor.defaults();
        assert_eq!(governor.settings(), derived);

        let frame = governor.state_event();
        let reason = frame["state"]["settingsError"]
            .as_str()
            .expect("the frame names the refusal")
            .to_string();
        assert!(
            reason.contains("settings.json"),
            "the reason names the file: {reason}"
        );
        assert_eq!(frame["state"]["saved"], Value::Null);
        assert_eq!(governor.settings(), derived);

        // A wrong-typed key refuses the whole file rather than dropping that
        // key, so the saved cap cannot silently revert.
        write_settings(&directory, "{\"maxAgentPeers\": \"4\"}");
        let frame = governor.state_event();
        let reason = frame["state"]["settingsError"]
            .as_str()
            .expect("the frame names the refusal")
            .to_string();
        assert!(
            reason.contains("maxAgentPeers"),
            "the reason names the key: {reason}"
        );
        assert_eq!(frame["state"]["saved"], Value::Null);
        assert_eq!(governor.settings(), derived);

        // The file reads as a budget again; the saved values apply.
        write_settings(
            &directory,
            "{\"maxAgentPeers\": 2, \"memoryHighMb\": 256, \"memoryMaxMb\": 512, \"memoryReserveMb\": 128}",
        );
        let frame = governor.state_event();
        assert_eq!(frame["state"]["settingsError"], Value::Null);
        assert_eq!(frame["state"]["saved"]["maxAgentPeers"], 2);
        assert_eq!(governor.settings().max_agent_peers, 2);
    }

    #[test]
    fn a_rejected_settings_file_is_journaled_once_per_unchanged_reason() {
        let directory = scratch("settings-journal");
        let recorded: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let governor = test_governor(&directory);
        {
            let recorded = Arc::clone(&recorded);
            governor.set_journal_hook(Arc::new(move |kind, text| {
                recorded
                    .lock()
                    .unwrap()
                    .push((kind.to_string(), text.to_string()));
            }));
        }
        // An absent file records nothing and keeps the derived defaults.
        let frame = governor.state_event();
        assert_eq!(frame["state"]["saved"], Value::Null);
        assert_eq!(frame["state"]["settingsError"], Value::Null);
        assert!(recorded.lock().unwrap().is_empty());

        // A file that never read records one activity line, however often the
        // page polls it.
        write_settings(&directory, "{");
        let _ = governor.state_event();
        let _ = governor.state_event();
        let lines = recorded.lock().unwrap().clone();
        assert_eq!(
            lines.len(),
            1,
            "one unchanged file records one line: {lines:?}"
        );
        assert_eq!(lines[0].0, "activity");
        assert!(lines[0].1.contains("settings.json"), "{}", lines[0].1);

        // The same bytes written again are still one unchanged reason.
        write_settings(&directory, "{");
        let _ = governor.state_event();
        assert_eq!(recorded.lock().unwrap().len(), 1);

        // Fixed bytes clear the refusal; a later rejection records its own line.
        write_settings(&directory, "{}");
        let _ = governor.state_event();
        let _ = governor.state_event();
        assert_eq!(recorded.lock().unwrap().len(), 1);
        write_settings(&directory, "{");
        let _ = governor.state_event();
        assert_eq!(recorded.lock().unwrap().len(), 2);
    }
}
