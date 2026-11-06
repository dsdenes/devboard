//! The resource governor.
//!
//! One budget bounds every agentic run the dashboard starts: a global cap on
//! concurrent agent peers and a memory reserve below which no new start is
//! admitted. The cap is shared by every process that starts a peer — the
//! dashboard, each worker, each run owner — through slot files in the state
//! directory, so the Issues worker, the background families, goal, flow, and
//! discover runs, the Release Train, and manual runs all draw from one pool.
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
/// The transient slice every agentic process joins on Linux.
pub const SLICE_NAME: &str = "devboard.slice";
const SETTINGS_FILE: &str = "settings.json";
const SLOTS_DIRECTORY: &str = "slots";
const LOCK_FILE: &str = "lock";
const DEFERRALS_FILE: &str = "deferrals.jsonl";
const KILLS_FILE: &str = "kills.jsonl";
/// One MiB in bytes; every setting is expressed in whole MiB.
pub const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
/// How long the same deferral is kept out of the log.
const DEFERRAL_DEDUPE_MS: u64 = 30_000;
/// How often a deferred peer retries its admission in-process.
const ADMISSION_POLL_MS: u64 = 250;

/* ------------------------------------------------------------------------ */
/* Settings                                                                  */
/* ------------------------------------------------------------------------ */

/// The effective budget and cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub max_agent_peers: u32,
    pub memory_high_mb: u64,
    pub memory_max_mb: u64,
    pub memory_reserve_mb: u64,
}

impl Settings {
    /// The documented defaults: a quarter of RAM (at least 1 GiB) as the
    /// reserve, everything above it as the hard maximum, 80% of that as the
    /// soft high mark, and one peer per four CPUs clamped to 1..=64.
    pub fn derive(total_mb: u64, cpus: u32) -> Self {
        let total_mb = total_mb.max(1);
        let memory_reserve_mb = (total_mb / 4)
            .max(GIB / MIB)
            .min(total_mb.saturating_sub(64).max(64));
        let memory_max_mb = total_mb.saturating_sub(memory_reserve_mb).max(64);
        let memory_high_mb = (memory_max_mb.saturating_mul(4) / 5).max(64);
        let max_agent_peers = (cpus / 4).clamp(1, 64);
        Self {
            max_agent_peers,
            memory_high_mb,
            memory_max_mb,
            memory_reserve_mb,
        }
    }

    /// The values explicitly saved to disk; a missing key keeps the fallback.
    fn apply_saved(&mut self, saved: &SavedSettings) {
        if let Some(value) = saved.max_agent_peers {
            self.max_agent_peers = value;
        }
        if let Some(value) = saved.memory_high_mb {
            self.memory_high_mb = value;
        }
        if let Some(value) = saved.memory_max_mb {
            self.memory_max_mb = value;
        }
        if let Some(value) = saved.memory_reserve_mb {
            self.memory_reserve_mb = value;
        }
        self.normalize();
    }

    /// Applies the environment overrides to the derived defaults.
    fn apply_environment(&mut self, env: &BTreeMap<String, String>) {
        if let Some(value) = env_u32(env, "DEVBOARD_MAX_AGENT_PEERS") {
            self.max_agent_peers = value.clamp(1, 64);
        }
        if let Some(value) = env_u64(env, "DEVBOARD_MEMORY_HIGH_MB") {
            self.memory_high_mb = value.max(64);
        }
        if let Some(value) = env_u64(env, "DEVBOARD_MEMORY_MAX_MB") {
            self.memory_max_mb = value.max(64);
        }
        if let Some(value) = env_u64(env, "DEVBOARD_MEMORY_RESERVE_MB") {
            self.memory_reserve_mb = value.max(64);
        }
        self.normalize();
    }

    /// Keeps the soft mark at or below the hard maximum.
    fn normalize(&mut self) {
        self.max_agent_peers = self.max_agent_peers.clamp(1, 64);
        self.memory_max_mb = self.memory_max_mb.max(64);
        self.memory_high_mb = self.memory_high_mb.clamp(64, self.memory_max_mb);
        self.memory_reserve_mb = self.memory_reserve_mb.max(64);
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
            memory_high_mb: number("memoryHighMb")?,
            memory_max_mb: number("memoryMaxMb")?,
            memory_reserve_mb: number("memoryReserveMb")?,
        };
        settings.normalize();
        Some(settings)
    }

    /// The values this save would write; refuses impossible combinations.
    pub fn validate(&self) -> Result<(), String> {
        if self.max_agent_peers == 0 || self.max_agent_peers > 64 {
            return Err("Max concurrent agents must be between 1 and 64.".to_string());
        }
        if self.memory_max_mb < 128 {
            return Err("Memory max must be at least 128 MB.".to_string());
        }
        if self.memory_high_mb < 64 || self.memory_high_mb > self.memory_max_mb {
            return Err("Memory high must be at least 64 MB and at most memory max.".to_string());
        }
        if self.memory_reserve_mb < 64 || self.memory_reserve_mb >= self.memory_max_mb {
            return Err("Reserve must be at least 64 MB and below memory max.".to_string());
        }
        Ok(())
    }

    /// Like [`Self::validate`], and also refuses a hard maximum that reaches
    /// into the reserve the host must keep free.
    pub fn validate_for(&self, total_mb: u64) -> Result<(), String> {
        self.validate()?;
        if self.memory_max_mb.saturating_add(self.memory_reserve_mb) > total_mb {
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
    pub fn from_value(value: &Value) -> Self {
        let object = match value.as_object() {
            Some(object) => object,
            None => return Self::default(),
        };
        Self {
            max_agent_peers: object
                .get("maxAgentPeers")
                .and_then(Value::as_u64)
                .and_then(|value| value.try_into().ok()),
            memory_high_mb: object.get("memoryHighMb").and_then(Value::as_u64),
            memory_max_mb: object.get("memoryMaxMb").and_then(Value::as_u64),
            memory_reserve_mb: object.get("memoryReserveMb").and_then(Value::as_u64),
        }
    }

    pub fn from_settings(settings: &Settings) -> Self {
        Self {
            max_agent_peers: Some(settings.max_agent_peers),
            memory_high_mb: Some(settings.memory_high_mb),
            memory_max_mb: Some(settings.memory_max_mb),
            memory_reserve_mb: Some(settings.memory_reserve_mb),
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

/* ------------------------------------------------------------------------ */
/* Memory                                                                    */
/* ------------------------------------------------------------------------ */

/// The facts admission control needs about the host.
pub trait MemoryReader: Send + Sync {
    fn total_mb(&self) -> u64;
    /// The memory a new run may use before the reserve is breached.
    fn available_mb(&self) -> Option<u64>;
    fn cpu_count(&self) -> u32;
}

/// The production reader: `/proc/meminfo` on Linux, `sysctl`/`vm_stat` on
/// macOS.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemMemory;

impl MemoryReader for SystemMemory {
    fn total_mb(&self) -> u64 {
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
fn system_memory() -> (u64, Option<u64>) {
    let text = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    parse_meminfo(&text)
}

#[cfg(target_os = "macos")]
fn system_memory() -> (u64, Option<u64>) {
    let total = command_stdout("sysctl", &["-n", "hw.memsize"])
        .and_then(|text| text.trim().parse::<u64>().ok())
        .map(|bytes| bytes / MIB)
        .unwrap_or(0);
    let page_size = command_stdout("sysctl", &["-n", "hw.pagesize"])
        .and_then(|text| text.trim().parse::<u64>().ok())
        .unwrap_or(4096);
    let available = command_stdout("vm_stat", &[])
        .and_then(|text| parse_vm_stat(&text, page_size))
        .map(|bytes| bytes / MIB);
    (total, available)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn system_memory() -> (u64, Option<u64>) {
    (0, None)
}

/// Parses the two `meminfo` fields admission uses.
pub fn parse_meminfo(text: &str) -> (u64, Option<u64>) {
    let mut total = 0;
    let mut available = None;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let value = parts.next().and_then(|value| value.parse::<u64>().ok());
        let Some(value) = value else { continue };
        match key.trim_end_matches(':') {
            "MemTotal" => total = value / 1024,
            "MemAvailable" => available = Some(value / 1024),
            _ => {}
        }
    }
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

/// Why a start was deferred. Deferral is never a failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeferReason {
    Cap { active: u32, cap: u32 },
    Memory { available_mb: u64, reserve_mb: u64 },
}

impl DeferReason {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Cap { .. } => "capacity",
            Self::Memory { .. } => "reserve",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Cap { active, cap } => {
                format!("{active} agent peer(s) already run at the cap of {cap}; the start is deferred")
            }
            Self::Memory {
                available_mb,
                reserve_mb,
            } => format!(
                "{available_mb} MB is available and the reserve is {reserve_mb} MB; the start is deferred"
            ),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Cap { active, cap } => json!({
                "reason": "capacity",
                "active": active,
                "cap": cap,
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
        }
    }
}

/// One admitted start. Dropping it returns the slot to the global pool; the
/// slot file is also reclaimed when its holder process dies.
pub struct Slot {
    path: PathBuf,
    id: String,
}

impl Slot {
    pub fn id(&self) -> &str {
        &self.id
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
            .finish()
    }
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
    env: BTreeMap<String, String>,
    settings: Mutex<Settings>,
    saved: Mutex<SavedSettings>,
    settings_stamp: Mutex<Option<SystemTime>>,
    slice_enabled: bool,
    /// Whether this process owns the slice properties. A dashboard does; a
    /// worker or a CLI that only joins the slice never rewrites its budget.
    slice_owned: bool,
    /// The slice unit this governor owns: `devboard.slice` in production, a
    /// transient child under it in the tests.
    slice_name: String,
    slice: Mutex<SliceInfo>,
    slice_cgroup: Mutex<Option<PathBuf>>,
    slice_wrap: AtomicBool,
    last_oom_kills: AtomicU64,
    deferral_stamp: Mutex<BTreeMap<String, u64>>,
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
        let saved = read_saved_settings(&directory).unwrap_or_default();
        let derived = Settings::derive(options.memory.total_mb(), options.memory.cpu_count());
        let mut effective = derived;
        effective.apply_environment(&options.env);
        effective.apply_saved(&saved);
        let governor = Arc::new(Self {
            state_dir: state_dir.to_path_buf(),
            directory,
            memory: options.memory,
            env: options.env,
            settings: Mutex::new(effective),
            saved: Mutex::new(saved),
            settings_stamp: Mutex::new(file_stamp(&settings_path(state_dir))),
            slice_enabled: options.slice,
            slice_owned: options.slice && apply,
            slice_name: slice_name.to_string(),
            slice: Mutex::new(SliceInfo::default()),
            slice_cgroup: Mutex::new(None),
            slice_wrap: AtomicBool::new(options.slice),
            last_oom_kills: AtomicU64::new(0),
            deferral_stamp: Mutex::new(BTreeMap::new()),
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
        Settings::derive(self.memory.total_mb(), self.memory.cpu_count())
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
        let path = settings_path(&self.state_dir);
        let stamp = file_stamp(&path);
        let same = self
            .settings_stamp
            .lock()
            .map(|current| *current == stamp)
            .unwrap_or(true);
        if same {
            return;
        }
        let saved = read_saved_settings(&self.directory).unwrap_or_default();
        let derived = self.defaults();
        let mut effective = derived;
        effective.apply_environment(&self.env);
        effective.apply_saved(&saved);
        if let Ok(mut current) = self.settings.lock() {
            *current = effective;
        }
        if let Ok(mut current) = self.saved.lock() {
            *current = saved;
        }
        if let Ok(mut current) = self.settings_stamp.lock() {
            *current = stamp;
        }
    }

    /// Persists the operator's values and applies them to the live slice.
    pub fn save(&self, settings: Settings) -> Result<Settings, String> {
        settings.validate_for(self.memory.total_mb())?;
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
        if self.slice_enabled && self.slice_owned {
            self.apply_slice();
        }
        Ok(settings)
    }

    /* -------------------------------------------------------------------- */
    /* Admission                                                             */
    /* -------------------------------------------------------------------- */

    /// Tries once to admit a start. A deferral leaves the caller's work
    /// queued; nothing is marked failed and nothing already running stops.
    pub fn try_acquire(&self, kind: &str, label: &str) -> Result<Slot, DeferReason> {
        self.refresh_settings();
        let settings = self.settings();
        // The count and the slot creation happen under one lock so two
        // processes cannot both see a free slot at the cap boundary.
        let _guard = file_lock(&self.directory.join(LOCK_FILE));
        let active = self.live_slots();
        if active.len() >= settings.max_agent_peers as usize {
            return Err(DeferReason::Cap {
                active: active.len() as u32,
                cap: settings.max_agent_peers,
            });
        }
        if let Some(available) = self.memory.available_mb() {
            if available < settings.memory_reserve_mb {
                return Err(DeferReason::Memory {
                    available_mb: available,
                    reserve_mb: settings.memory_reserve_mb,
                });
            }
        }
        self.create_slot(kind, label).ok_or(DeferReason::Cap {
            active: active.len() as u32,
            cap: settings.max_agent_peers,
        })
    }

    /// Waits until one slot is free. This is how an in-process start (a goal
    /// lane, a run owner, the Release Train peer) defers without failing.
    pub async fn wait_for_admission(&self, kind: &str, label: &str) -> Slot {
        loop {
            match self.try_acquire(kind, label) {
                Ok(slot) => return slot,
                Err(reason) => {
                    self.record_deferral(kind, label, &reason);
                    tokio::time::sleep(Duration::from_millis(ADMISSION_POLL_MS)).await;
                }
            }
        }
    }

    /// The live slot count.
    pub fn active_agents(&self) -> u32 {
        self.live_slots().len() as u32
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

    fn create_slot(&self, kind: &str, label: &str) -> Option<Slot> {
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.slots_directory().join(format!("{id}.json"));
        let pid = std::process::id();
        let record = json!({
            "id": id,
            "pid": pid,
            "pidStart": process_start_ticks(pid),
            "kind": kind,
            "label": label,
            "startedAt": iso_now(),
        });
        write_json_atomically(&path, &record).ok()?;
        Some(Slot { path, id })
    }

    /* -------------------------------------------------------------------- */
    /* Slice                                                                 */
    /* -------------------------------------------------------------------- */

    pub fn slice_enabled(&self) -> bool {
        self.slice_enabled
    }

    /// The slice unit this governor owns, without the parent path.
    pub fn slice_unit(&self) -> &str {
        leaf_slice_name(&self.slice_name)
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
        let settings = self.settings();
        let marker = slice_owner_marker(&self.state_dir);
        let info = apply_slice_properties_owned(&self.slice_name, settings, Some(&marker));
        if info.present {
            if let Some(path) = slice_cgroup_path_for(&self.slice_name) {
                if let Ok(mut current) = self.slice_cgroup.lock() {
                    *current = Some(path);
                }
            }
        } else {
            self.slice_wrap.store(false, Ordering::SeqCst);
        }
        if let Ok(mut current) = self.slice.lock() {
            *current = info.clone();
        }
        info
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
        self.wrap_argv_inner(argv, None)
    }

    /// Like [`Self::wrap_argv`], but the transient scope carries its own hard
    /// memory limit. The slice tests use this to prove the kernel kill without
    /// changing the budget the dashboard runs with.
    pub fn wrap_argv_with_limit(&self, argv: Vec<String>, settings: Settings) -> Vec<String> {
        self.wrap_argv_inner(argv, Some(settings))
    }

    fn wrap_argv_inner(&self, argv: Vec<String>, limit: Option<Settings>) -> Vec<String> {
        if !self.needs_wrapper() || argv.is_empty() {
            return argv;
        }
        let mut wrapped = vec![
            "systemd-run".to_string(),
            "--user".to_string(),
            "--scope".to_string(),
            "--quiet".to_string(),
            "--collect".to_string(),
        ];
        if let Some(settings) = limit {
            wrapped.push(format!(
                "--property=MemoryHigh={}",
                settings.memory_high_mb.saturating_mul(MIB)
            ));
            wrapped.push(format!(
                "--property=MemoryMax={}",
                settings.memory_max_mb.saturating_mul(MIB)
            ));
            wrapped.push("--property=MemorySwapMax=0".to_string());
        }
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

    /// Every kernel kill the governor recorded.
    pub fn read_kills(&self) -> Vec<Value> {
        read_json_lines(&self.directory.join(KILLS_FILE))
    }

    /// The Resources tab's readback: the saved values, the effective values,
    /// and the live counters.
    pub fn state_event(&self) -> Value {
        self.refresh_settings();
        let saved = self.saved_settings();
        let effective = self.settings();
        let info = self.slice_info();
        json!({
            "type": "resourcesState",
            "state": {
                "saved": if saved.is_empty() { Value::Null } else { saved.to_json() },
                "effective": effective.to_json(),
                "live": {
                    "activeAgents": self.active_agents(),
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

fn read_saved_settings(directory: &Path) -> Option<SavedSettings> {
    let text = fs::read_to_string(directory.join(SETTINGS_FILE)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    Some(SavedSettings::from_value(&value))
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

/// The absolute cgroup directory of the production slice, when it exists.
pub fn slice_cgroup_path() -> Option<PathBuf> {
    slice_cgroup_path_for(SLICE_NAME)
}

/// The unit description that names which dashboard owns the slice budget.
fn slice_owner_marker(state_dir: &Path) -> String {
    format!("devboard owner {}", state_dir.display())
}

/// The description systemd reports for one slice, when the slice exists.
#[cfg(target_os = "linux")]
fn slice_description(name: &str) -> Option<String> {
    run_output(
        "systemctl",
        &[
            "--user",
            "show",
            leaf_slice_name(name),
            "-p",
            "Description",
            "--value",
        ],
    )
}

#[cfg(not(target_os = "linux"))]
fn slice_description(_name: &str) -> Option<String> {
    None
}

/// Creates the named slice if needed and sets its memory limits. Returns the
/// live facts; `present: false` means this host cannot enforce a slice.
#[cfg(target_os = "linux")]
pub fn apply_slice_properties_for(name: &str, settings: Settings) -> SliceInfo {
    apply_slice_properties_owned(name, settings, None)
}

/// Like [`apply_slice_properties_for`], but refuses to rewrite a slice another
/// dashboard already owns. A workspace test's ephemeral dashboard, a second
/// dashboard, and a CLI all see the live description and only join it.
#[cfg(target_os = "linux")]
fn apply_slice_properties_owned(name: &str, settings: Settings, marker: Option<&str>) -> SliceInfo {
    if let Some(marker) = marker {
        if let Some(path) = slice_cgroup_path_for(name) {
            if let Some(existing) = slice_description(name) {
                // Only another dashboard's explicit marker blocks this one; a
                // system-generated description is a slice still to be claimed.
                if existing.starts_with("devboard owner ") && existing != marker {
                    return slice_info_from_cgroup(Some(&path));
                }
            }
        }
    }
    if !ensure_slice_unit(name) {
        return SliceInfo::default();
    }
    let Some(path) = slice_cgroup_path_for(name) else {
        return SliceInfo::default();
    };
    let leaf = leaf_slice_name(name);
    if let Some(marker) = marker {
        let _ = Command::new("systemctl")
            .args([
                "--user",
                "set-property",
                "--runtime",
                leaf,
                &format!("Description={marker}"),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let high = format!("MemoryHigh={}", settings.memory_high_mb.saturating_mul(MIB));
    let max = format!("MemoryMax={}", settings.memory_max_mb.saturating_mul(MIB));
    let set = Command::new("systemctl")
        .args(["--user", "set-property", "--runtime", leaf, &high, &max])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if !set.map(|status| status.success()).unwrap_or(false) {
        return SliceInfo::default();
    }
    // The hard limit bounds RAM. Unlimited swap would let a runaway agent
    // grow past it and pressure the session instead. An older systemd that
    // cannot set the swap bound still gets the RAM bound above.
    let _ = Command::new("systemctl")
        .args([
            "--user",
            "set-property",
            "--runtime",
            leaf,
            "MemorySwapMax=0",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    slice_info_from_cgroup(Some(&path))
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
) -> SliceInfo {
    SliceInfo::default()
}

/// Applies the budget to the production slice.
pub fn apply_slice_properties(settings: Settings) -> SliceInfo {
    apply_slice_properties_for(SLICE_NAME, settings)
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

/// Stops the production slice. Only tests that created it call this.
pub fn stop_slice() -> bool {
    stop_slice_for(SLICE_NAME)
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

fn write_json_atomically(path: &Path, value: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    write_text_atomically(path, &format!("{text}\n"))
}

fn write_text_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), epoch_millis()));
    {
        let mut file = File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all().ok();
    }
    fs::rename(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
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

fn file_lock(path: &Path) -> Option<FileLock> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .ok()?;
    #[cfg(unix)]
    unsafe {
        if libc::flock(std::os::unix::io::AsRawFd::as_raw_fd(&file), libc::LOCK_EX) != 0 {
            return None;
        }
    }
    Some(FileLock { file })
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
        assert_eq!(settings.memory_reserve_mb, 25_000);
        assert_eq!(settings.memory_max_mb, 75_000);
        assert_eq!(settings.memory_high_mb, 60_000);
        assert_eq!(settings.max_agent_peers, 8);
        let small = Settings::derive(4_096, 2);
        assert_eq!(small.memory_reserve_mb, 1_024);
        assert_eq!(small.memory_max_mb, 3_072);
        assert_eq!(small.memory_high_mb, 2_457);
        assert_eq!(small.max_agent_peers, 1);
    }

    #[test]
    fn the_meminfo_parser_reads_total_and_available() {
        let text =
            "MemTotal:       98783752 kB\nMemFree:         1234 kB\nMemAvailable:   50000000 kB\n";
        assert_eq!(parse_meminfo(text), (96_468, Some(48_828)));
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
}
