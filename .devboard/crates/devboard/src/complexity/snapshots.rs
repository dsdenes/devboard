//! The once-per-UTC-day snapshot rule. The dashboard calls `check()` at server
//! start and on a fixed tick; a day that already has a snapshot is left alone,
//! so a restart, a page open, a reload, and a reconnect on the same day never
//! add a second file. The check belongs to the server's own lifecycle: there is
//! no background worker, detached process, or service behind it.
//!
//! Ported from `.devboard/server/complexity/snapshots.ts`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use time::format_description::FormatItem;
use time::macros::format_description;
use time::OffsetDateTime;

use super::analyze::{build_complexity_snapshot, utc_date, ComplexitySnapshot};
use super::store::{complexity_directory, read_snapshots, write_snapshot, ComplexityFrame};
use crate::app::Conn;

/// One minute is enough for a midnight rollover to land within a minute.
pub const COMPLEXITY_CHECK_INTERVAL_MS: u64 = 60_000;

/// The smallest interval the controller accepts.
const COMPLEXITY_MIN_INTERVAL_MS: u64 = 1_000;

/// The clock the daily rule follows.
pub type Clock = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;

/// The measurement one day records.
pub type Analyze = Arc<dyn Fn(OffsetDateTime) -> Result<ComplexitySnapshot, String> + Send + Sync>;

/// Where a failed measurement or write is reported.
pub type ReportError = Arc<dyn Fn(String) + Send + Sync>;

const ISO_FORMAT: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

/// The ISO 8601 text one instant carries, with milliseconds.
pub fn iso_instant(instant: OffsetDateTime) -> String {
    instant
        .format(ISO_FORMAT)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/// The working files the analyzer measures: the harness source tree of the
/// served repository when it ships one, otherwise the running harness package.
pub fn harness_root(repo_dir: &std::path::Path) -> PathBuf {
    if let Ok(value) = std::env::var("DEVBOARD_COMPLEXITY_ROOT") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let checkout = repo_dir.join(".devboard");
    if checkout.join("crates").is_dir() || checkout.join("client").is_dir() {
        return checkout;
    }
    crate::version::running_harness_dir()
}

/// Parses one ISO 8601 instant (`2026-11-01T09:00:00.000Z`), or `None`.
fn parse_instant(text: &str) -> Option<OffsetDateTime> {
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(&bytes[range]).ok()?.parse().ok()
    };
    let year = number(0..4)? as i32;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    let (millis, rest) = if bytes.get(19) == Some(&b'.') {
        let mut digits = String::new();
        let mut index = 20;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            digits.push(bytes[index] as char);
            index += 1;
        }
        if digits.is_empty() {
            return None;
        }
        while digits.len() < 3 {
            digits.push('0');
        }
        (digits[..3].parse::<i64>().ok()?, index)
    } else {
        (0, 19)
    };
    if rest + 1 != bytes.len() || bytes.get(rest) != Some(&b'Z') {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .map(|instant| instant + time::Duration::milliseconds(millis))
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(year: i32, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year } as i64;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The clock a pinned instant produces; an unset or unparseable value leaves
/// the real clock in place, so a bad variable never stops a dashboard.
fn clock_from_value(raw: Option<String>) -> Clock {
    let fixed = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(parse_instant);
    match fixed {
        Some(instant) => Arc::new(move || instant),
        None => Arc::new(OffsetDateTime::now_utc),
    }
}

/// The clock the daily rule follows. `DEVBOARD_COMPLEXITY_NOW` pins an instant
/// for a verification run or a fixture host.
pub fn complexity_clock() -> Clock {
    clock_from_value(std::env::var("DEVBOARD_COMPLEXITY_NOW").ok())
}

/// The clock one environment map pins, for tests and fixture hosts.
pub fn complexity_clock_from_env(env: &HashMap<String, String>) -> Clock {
    clock_from_value(env.get("DEVBOARD_COMPLEXITY_NOW").cloned())
}

/// Everything one dashboard's snapshot controller needs.
pub struct ComplexityOptions {
    pub state_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub now: Clock,
    pub analyze: Analyze,
    pub interval: Duration,
    pub report_error: ReportError,
}

impl ComplexityOptions {
    /// The production options for one served repository.
    pub fn production(state_dir: PathBuf, repo_dir: PathBuf) -> Self {
        let root = harness_root(&repo_dir);
        Self {
            state_dir,
            repo_dir,
            now: complexity_clock(),
            analyze: Arc::new(move |now| Ok(build_complexity_snapshot(&root, now))),
            interval: Duration::from_millis(COMPLEXITY_CHECK_INTERVAL_MS),
            report_error: Arc::new(|line| eprintln!("{line}")),
        }
    }
}

/// Owns the recorded history and the daily check for one dashboard process.
pub struct ComplexitySnapshots {
    directory: PathBuf,
    now: Clock,
    analyze: Analyze,
    interval: Duration,
    report_error: ReportError,
    snapshots: Mutex<Vec<ComplexitySnapshot>>,
    pending: tokio::sync::Mutex<()>,
    subscribers: Mutex<HashMap<u64, Conn>>,
    started: AtomicBool,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ComplexitySnapshots {
    pub fn new(options: ComplexityOptions) -> Self {
        let directory = complexity_directory(&options.state_dir, &options.repo_dir);
        let snapshots = read_snapshots(&directory);
        Self {
            directory,
            now: options.now,
            analyze: options.analyze,
            interval: options
                .interval
                .max(Duration::from_millis(COMPLEXITY_MIN_INTERVAL_MS)),
            report_error: options.report_error,
            snapshots: Mutex::new(snapshots),
            pending: tokio::sync::Mutex::new(()),
            subscribers: Mutex::new(HashMap::new()),
            started: AtomicBool::new(false),
            task: Mutex::new(None),
        }
    }

    /// The directory every snapshot file lives in.
    pub fn directory(&self) -> &std::path::Path {
        &self.directory
    }

    /// Every recorded snapshot, oldest to newest.
    pub fn snapshots(&self) -> Vec<ComplexitySnapshot> {
        self.snapshots
            .lock()
            .map(|snapshots| snapshots.clone())
            .unwrap_or_default()
    }

    /// The newest recorded snapshot, or `None` before the first one.
    pub fn latest(&self) -> Option<ComplexitySnapshot> {
        self.snapshots().into_iter().next_back()
    }

    /// The page payload: every recorded date plus the newest detail. It reads
    /// the recorded snapshots under their lock and copies only the fields the
    /// page renders, so a poll never clones each snapshot's function rows.
    pub fn frame(&self) -> ComplexityFrame {
        let Ok(snapshots) = self.snapshots.lock() else {
            return ComplexityFrame::build(&[], None);
        };
        ComplexityFrame::build(&snapshots, snapshots.last())
    }

    /// The `complexityState` frame's `state` object.
    pub fn state(&self) -> Value {
        self.frame().to_json()
    }

    /// The `complexityState` event a page receives.
    pub fn state_event(&self) -> Value {
        json!({ "type": "complexityState", "state": self.state() })
    }

    /// Registers one page that asked for the history.
    pub fn subscribe(&self, conn: &Conn) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.insert(conn.id(), conn.clone());
        }
    }

    /// Drops one disconnected page.
    pub fn unsubscribe(&self, id: u64) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.remove(&id);
        }
    }

    /// Records this UTC day's snapshot and starts the rollover check.
    pub fn begin(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        let handle = tokio::spawn(async move {
            let mut timer = tokio::time::interval(this.interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                this.check_and_publish().await;
            }
        });
        if let Ok(mut slot) = self.task.lock() {
            *slot = Some(handle);
        }
    }

    /// Ends the rollover check.
    pub fn dispose(&self) {
        if let Ok(mut slot) = self.task.lock() {
            if let Some(handle) = slot.take() {
                handle.abort();
            }
        }
        self.started.store(false, Ordering::SeqCst);
    }

    /// Records a snapshot for the current UTC day when none exists.
    /// Overlapping calls share one measurement, so a tick that lands while the
    /// first one runs can never write a second file.
    pub async fn check(&self) -> Option<ComplexitySnapshot> {
        let _pending = self.pending.lock().await;
        let now = (self.now)();
        let date = utc_date(now);
        if self
            .snapshots
            .lock()
            .map(|snapshots| snapshots.iter().any(|snapshot| snapshot.date == date))
            .unwrap_or(false)
        {
            return None;
        }
        let mut snapshot = match (self.analyze)(now) {
            Ok(snapshot) => snapshot,
            Err(message) => {
                (self.report_error)(format!(
                    "complexity: measurement for {date} failed: {message}"
                ));
                return None;
            }
        };
        snapshot.date = date.clone();
        snapshot.recorded_at = iso_instant(now);
        if let Err(error) = write_snapshot(&self.directory, &snapshot).await {
            (self.report_error)(format!(
                "complexity: writing {date}/snapshot failed: {error}"
            ));
            return None;
        }
        if let Ok(mut snapshots) = self.snapshots.lock() {
            snapshots.push(snapshot.clone());
            snapshots.sort_by(|left, right| left.date.cmp(&right.date));
        }
        Some(snapshot)
    }

    async fn check_and_publish(&self) {
        if self.check().await.is_some() {
            self.publish();
        }
    }

    /// Sends the current history to every page that asked for it.
    fn publish(&self) {
        let subscribers: Vec<Conn> = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect())
            .unwrap_or_default();
        if subscribers.is_empty() {
            return;
        }
        let event = self.state_event();
        for conn in subscribers {
            conn.send(event.clone());
        }
    }
}
