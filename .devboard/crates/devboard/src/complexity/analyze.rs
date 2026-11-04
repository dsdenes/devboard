//! The complexity analyzer: discovers the harness's own application source,
//! measures every file, and aggregates the per-function and per-file values
//! into the project-level figures one snapshot records.
//!
//! Ported from `.devboard/server/complexity/analyze.ts`. The Rust harness
//! measures its Rust crates and the TypeScript/Svelte client instead of the
//! TypeScript server tree.

use std::collections::HashMap;
use std::path::Path;

use time::OffsetDateTime;

use super::measure::{
    halstead_volume, maintainability_index, measure_source, round, FunctionMeasure, Language,
};

/// The snapshot schema this build writes and reads.
pub const COMPLEXITY_VERSION: u32 = 1;

/// The directories the application source lives in, with the extensions each
/// one contributes.
const ANALYZED_DIRECTORIES: &[(&str, &[&str])] =
    &[("crates", &[".rs"]), ("client", &[".ts", ".svelte"])];

/// Directories that hold build output, dependencies, or tests, never
/// application source.
const EXCLUDED_DIRECTORIES: &[&str] =
    &["node_modules", "dist", ".tmp", "public", "target", "tests"];

/// A function whose cyclomatic complexity exceeds this is counted as complex.
pub const COMPLEXITY_THRESHOLD: u64 = 10;

/// One function's measurements, attributed to its file.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionRow {
    /// Repository-relative path, e.g. `.devboard/crates/devboard/src/app.rs`.
    pub path: String,
    #[serde(flatten)]
    pub measure: FunctionMeasure,
}

/// One file's measurements in a snapshot.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeasure {
    pub path: String,
    /// Non-blank, non-comment code lines.
    pub loc: u64,
    pub functions: u64,
    /// Duplicated significant lines over this file's code lines, 0-1.
    pub duplicated_line_ratio: f64,
    /// Maintainability index clamped to 0-100.
    pub maintainability: f64,
}

/// The project-level figures one snapshot records.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeasure {
    pub files: u64,
    pub functions: u64,
    pub loc: u64,
    pub mean_cyclomatic: f64,
    pub max_cyclomatic: u64,
    pub functions_over_threshold: u64,
    pub duplicated_line_ratio: f64,
    pub mean_maintainability: f64,
}

/// One recorded daily snapshot of the harness's own complexity.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComplexitySnapshot {
    pub version: u32,
    /// The UTC calendar day the snapshot belongs to, `YYYY-MM-DD`.
    pub date: String,
    /// When the snapshot was recorded, ISO-8601.
    pub recorded_at: String,
    pub project: ProjectMeasure,
    pub files: Vec<FileMeasure>,
    pub functions: Vec<FunctionRow>,
}

/// What one analysis pass measured, before it is stamped with a date.
#[derive(Clone, Debug, PartialEq)]
pub struct ComplexityAnalysis {
    pub project: ProjectMeasure,
    pub files: Vec<FileMeasure>,
    pub functions: Vec<FunctionRow>,
}

/// A file discovery found, still carrying its repository-relative path.
struct Source {
    path: String,
    measure: super::measure::FileMeasureSource,
}

/// The UTC calendar day of an instant.
pub fn utc_date(now: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    )
}

fn is_source_file(name: &str, extensions: &[&str]) -> bool {
    if name.contains(".test.") {
        return false;
    }
    extensions.iter().any(|extension| name.ends_with(extension))
}

/// The repository-relative path of one source file, with `/` separators.
fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let mut parts = Vec::new();
    for component in relative.components() {
        if let std::path::Component::Normal(part) = component {
            parts.push(part.to_string_lossy().into_owned());
        }
    }
    parts.join("/")
}

/// Every measured file under one directory, depth-first and name-sorted.
fn collect_sources(directory: &Path, root: &Path, extensions: &[&str], sources: &mut Vec<Source>) {
    let mut entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(directory) {
        Ok(reader) => reader.flatten().collect(),
        Err(_) => return,
    };
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            if EXCLUDED_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            collect_sources(&entry.path(), root, extensions, sources);
            continue;
        }
        if !file_type.is_file() || !is_source_file(&name, extensions) {
            continue;
        }
        let text = match std::fs::read_to_string(entry.path()) {
            Ok(text) => text,
            Err(_) => continue,
        };
        sources.push(Source {
            path: relative_path(root, &entry.path()),
            measure: measure_source(&text, Language::from_name(&name)),
        });
    }
}

/// Measures the harness at `root` and aggregates the result. The same
/// unchanged tree yields the same values: discovery is name-sorted and no
/// measurement reads a clock or the network.
pub fn analyze_complexity(root: &Path) -> ComplexityAnalysis {
    let mut sources: Vec<Source> = Vec::new();
    for (directory, extensions) in ANALYZED_DIRECTORIES {
        collect_sources(&root.join(directory), root, extensions, &mut sources);
    }

    let mut occurrences: HashMap<String, u64> = HashMap::new();
    for source in &sources {
        for (line, count) in &source.measure.lines {
            *occurrences.entry(line.clone()).or_insert(0) += count;
        }
    }

    let mut files: Vec<FileMeasure> = Vec::new();
    let mut functions: Vec<FunctionRow> = Vec::new();
    let mut total_loc = 0u64;
    let mut duplicated_loc = 0u64;
    let mut complexity_total = 0u64;
    let mut max_cyclomatic = 0u64;
    let mut complex_functions = 0u64;
    let mut maintainability_total = 0f64;

    for source in &sources {
        let path = format!(".devboard/{}", source.path);
        let measured = &source.measure.functions;
        let mut complexity_sum = 0u64;
        let mut deepest = 0u64;
        for entry in measured {
            complexity_sum += entry.cyclomatic;
            deepest = deepest.max(entry.cyclomatic);
            if entry.cyclomatic > COMPLEXITY_THRESHOLD {
                complex_functions += 1;
            }
            functions.push(FunctionRow {
                path: path.clone(),
                measure: entry.clone(),
            });
        }
        let mean_complexity = if measured.is_empty() {
            1.0
        } else {
            complexity_sum as f64 / measured.len() as f64
        };
        let mut duplicated = 0u64;
        for (line, count) in &source.measure.lines {
            if occurrences.get(line).copied().unwrap_or(0) > 1 {
                duplicated += count;
            }
        }
        let maintainability = maintainability_index(
            halstead_volume(&source.measure.halstead),
            mean_complexity,
            source.measure.loc,
        );
        files.push(FileMeasure {
            path: path.clone(),
            loc: source.measure.loc,
            functions: measured.len() as u64,
            duplicated_line_ratio: round(
                if source.measure.loc == 0 {
                    0.0
                } else {
                    duplicated as f64 / source.measure.loc as f64
                },
                4,
            ),
            maintainability,
        });
        total_loc += source.measure.loc;
        duplicated_loc += duplicated;
        complexity_total += complexity_sum;
        max_cyclomatic = max_cyclomatic.max(deepest);
        maintainability_total += maintainability;
    }

    let project = ProjectMeasure {
        files: files.len() as u64,
        functions: functions.len() as u64,
        loc: total_loc,
        mean_cyclomatic: round(
            if functions.is_empty() {
                0.0
            } else {
                complexity_total as f64 / functions.len() as f64
            },
            2,
        ),
        max_cyclomatic,
        functions_over_threshold: complex_functions,
        duplicated_line_ratio: round(
            if total_loc == 0 {
                0.0
            } else {
                duplicated_loc as f64 / total_loc as f64
            },
            4,
        ),
        mean_maintainability: round(
            if files.is_empty() {
                0.0
            } else {
                maintainability_total / files.len() as f64
            },
            2,
        ),
    };

    // Directory order is a discovery detail; the snapshot orders its rows by
    // path so the page and the stored bytes are stable.
    files.sort_by(|left, right| left.path.cmp(&right.path));
    functions.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.measure.line.cmp(&right.measure.line))
    });

    ComplexityAnalysis {
        project,
        files,
        functions,
    }
}

/// The full snapshot for the UTC day of `now`.
pub fn build_complexity_snapshot(root: &Path, now: OffsetDateTime) -> ComplexitySnapshot {
    let analysis = analyze_complexity(root);
    ComplexitySnapshot {
        version: COMPLEXITY_VERSION,
        date: utc_date(now),
        recorded_at: super::snapshots::iso_instant(now),
        project: analysis.project,
        files: analysis.files,
        functions: analysis.functions,
    }
}
