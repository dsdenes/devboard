//! Snapshot persistence for the complexity dashboard. One file per UTC
//! calendar day lives under the dashboard's own state directory; a file whose
//! bytes do not validate is skipped, never rewritten, and never replaced by a
//! second snapshot for a day that already has one.
//!
//! Ported from `.devboard/server/complexity/store.ts`.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::analyze::{
    ComplexitySnapshot, FileMeasure, FunctionRow, ProjectMeasure, COMPLEXITY_VERSION,
};
use super::measure::FunctionMeasure;

/// `<STATE_DIR>/complexity`, the one root this feature writes under.
pub fn complexity_root(state_dir: &Path) -> PathBuf {
    state_dir.join("complexity")
}

/// This checkout's own snapshot directory, keyed like every other state file.
pub fn complexity_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    complexity_root(state_dir).join(crate::journal::repo_key(repo_dir))
}

/// The one file a UTC day owns.
pub fn snapshot_file(directory: &Path, date: &str) -> PathBuf {
    directory.join(format!("{date}.json"))
}

fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn is_count(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    value?.as_u64()
}

fn non_negative(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

fn ratio(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && (0.0..=1.0).contains(&number)).then_some(number)
}

fn maintainability(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && (0.0..=100.0).contains(&number)).then_some(number)
}

fn project_from(value: &Value) -> Option<ProjectMeasure> {
    let object = value.as_object()?;
    Some(ProjectMeasure {
        files: is_count(object.get("files"))?,
        functions: is_count(object.get("functions"))?,
        loc: is_count(object.get("loc"))?,
        mean_cyclomatic: non_negative(object.get("meanCyclomatic"))?,
        max_cyclomatic: is_count(object.get("maxCyclomatic"))?,
        functions_over_threshold: is_count(object.get("functionsOverThreshold"))?,
        duplicated_line_ratio: ratio(object.get("duplicatedLineRatio"))?,
        mean_maintainability: maintainability(object.get("meanMaintainability"))?,
    })
}

fn file_from(value: &Value) -> Option<FileMeasure> {
    let object = value.as_object()?;
    let path = object.get("path")?.as_str()?;
    if path.is_empty() {
        return None;
    }
    Some(FileMeasure {
        path: path.to_string(),
        loc: is_count(object.get("loc"))?,
        functions: is_count(object.get("functions"))?,
        duplicated_line_ratio: ratio(object.get("duplicatedLineRatio"))?,
        maintainability: maintainability(object.get("maintainability"))?,
    })
}

fn function_from(value: &Value) -> Option<FunctionRow> {
    let object = value.as_object()?;
    let path = object.get("path")?.as_str()?.to_string();
    let name = object.get("name")?.as_str()?.to_string();
    Some(FunctionRow {
        path,
        measure: FunctionMeasure {
            name,
            line: is_count(object.get("line"))? as usize,
            lines: is_count(object.get("lines"))? as usize,
            cyclomatic: is_count(object.get("cyclomatic"))?,
            nesting: is_count(object.get("nesting"))?,
            parameters: is_count(object.get("parameters"))?,
        },
    })
}

/// One snapshot from its stored bytes, or `None` when any part is malformed. A
/// stored snapshot is read whole or not at all: a partially valid one would
/// report figures the analyzer never produced.
pub fn parse_snapshot(value: &Value) -> Option<ComplexitySnapshot> {
    let record = value.as_object()?;
    if is_count(record.get("version"))? != u64::from(COMPLEXITY_VERSION) {
        return None;
    }
    let date = record.get("date")?.as_str()?;
    if !is_date(date) {
        return None;
    }
    let recorded_at = record.get("recordedAt")?.as_str()?;
    if recorded_at.is_empty() {
        return None;
    }
    let project = project_from(record.get("project")?)?;
    let files = record
        .get("files")?
        .as_array()?
        .iter()
        .map(file_from)
        .collect::<Option<Vec<_>>>()?;
    let functions = record
        .get("functions")?
        .as_array()?
        .iter()
        .map(function_from)
        .collect::<Option<Vec<_>>>()?;
    Some(ComplexitySnapshot {
        version: COMPLEXITY_VERSION,
        date: date.to_string(),
        recorded_at: recorded_at.to_string(),
        project,
        files,
        functions,
    })
}

/// Every readable snapshot in the directory, oldest first, reduced to what a
/// page renders: one summary per day plus the newest day's detail. A missing
/// directory is an empty history; an unreadable or malformed file is skipped
/// so one damaged day never hides the days around it.
///
/// Each file is read once, straight from the filesystem. The sampling cache is
/// not consulted: it retains every path it read for the life of the process,
/// and a stored day is never sampled again, so caching it would pin the whole
/// history's bytes beside the parsed history.
pub fn read_snapshots(directory: &Path) -> ComplexityFrame {
    let mut names: Vec<String> = match std::fs::read_dir(directory) {
        Ok(reader) => reader
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => return ComplexityFrame::default(),
    };
    names.sort();
    let mut frame = ComplexityFrame::default();
    for name in names {
        let Some(date) = name.strip_suffix(".json") else {
            continue;
        };
        if !is_date(date) || name.len() != date.len() + 5 {
            continue;
        }
        let text = match std::fs::read_to_string(directory.join(&name)) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let parsed: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(snapshot) = parse_snapshot(&parsed) else {
            continue;
        };
        if snapshot.date != date {
            continue;
        }
        // Names sort chronologically, and `snapshot.date == date`, so the last
        // parsed file is the newest day and its detail is the one a page reads.
        frame.record(&snapshot);
    }
    frame
}

/// Writes one day's snapshot atomically; the whole file replaces the last one.
pub async fn write_snapshot(directory: &Path, snapshot: &ComplexitySnapshot) -> Result<(), String> {
    let value = serde_json::to_value(snapshot).map_err(|error| error.to_string())?;
    let text = format!("{}\n", crate::jsjson::stringify(&value));
    crate::state::write_file_atomically(&snapshot_file(directory, &snapshot.date), &text)
        .await
        .map_err(|error| error.to_string())
}

/// The payload one snapshot contributes to every connected page.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub date: String,
    pub recorded_at: String,
    pub project: ProjectMeasure,
}

impl SnapshotSummary {
    pub(crate) fn of(snapshot: &ComplexitySnapshot) -> SnapshotSummary {
        SnapshotSummary {
            date: snapshot.date.clone(),
            recorded_at: snapshot.recorded_at.clone(),
            project: snapshot.project.clone(),
        }
    }
}

/// The newest snapshot as the page renders it: its date, project figures, and
/// per-file rows. The per-function rows stay in the stored snapshot; no page
/// reads them, and shipping them made every poll serialize about a megabyte.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestDetail {
    pub date: String,
    pub recorded_at: String,
    pub project: ProjectMeasure,
    pub files: Vec<FileMeasure>,
}

impl LatestDetail {
    pub(crate) fn of(snapshot: &ComplexitySnapshot) -> LatestDetail {
        LatestDetail {
            date: snapshot.date.clone(),
            recorded_at: snapshot.recorded_at.clone(),
            project: snapshot.project.clone(),
            files: snapshot.files.clone(),
        }
    }
}

/// The frame the server pushes: every recorded date, plus the newest detail.
/// It is also the whole history the process keeps: one stored day contributes
/// a summary and, only while it is the newest day, its per-file rows. A
/// snapshot's function rows are dropped as soon as its file is parsed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ComplexityFrame {
    pub snapshots: Vec<SnapshotSummary>,
    pub latest: Option<LatestDetail>,
}

impl ComplexityFrame {
    /// Adds one measured day, oldest first, and keeps its detail only while it
    /// is the newest day.
    pub fn record(&mut self, snapshot: &ComplexitySnapshot) {
        let summary = SnapshotSummary::of(snapshot);
        match self
            .snapshots
            .binary_search_by(|stored| stored.date.as_str().cmp(summary.date.as_str()))
        {
            Ok(_) => return,
            Err(index) => self.snapshots.insert(index, summary),
        }
        let newest = self
            .snapshots
            .last()
            .is_some_and(|stored| stored.date == snapshot.date);
        if newest {
            self.latest = Some(LatestDetail::of(snapshot));
        }
    }

    /// The frame as the JSON object the socket carries.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert(
            "snapshots".to_string(),
            Value::Array(
                self.snapshots
                    .iter()
                    .map(|summary| serde_json::to_value(summary).unwrap_or(Value::Null))
                    .collect(),
            ),
        );
        object.insert(
            "latest".to_string(),
            self.latest
                .as_ref()
                .and_then(|detail| serde_json::to_value(detail).ok())
                .unwrap_or(Value::Null),
        );
        Value::Object(object)
    }
}
