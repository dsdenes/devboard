//! The bounded cycle summary every run directory records beside its report.
//!
//! A run report carries the whole cycle evidence — tens of megabytes on a
//! populated host — while every reader of the cycle history needs six small
//! fields. A family projection is a Start's answer frame, so it reads the
//! summary; the report is parsed once, by whichever reader first finds a run
//! that predates its summary.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// The summary a run directory records beside `report.json`.
pub const SUMMARY_FILE: &str = "cycle.json";
const REPORT_FILE: &str = "report.json";

#[cfg(test)]
thread_local! {
    /// Run reports this thread parsed. A projection reads each run once, so a
    /// test proves the count without depending on another test's directories.
    pub static REPORT_PARSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The bounded part of one report that a cycle row reads.
pub fn summary(report: &Value) -> Option<Value> {
    let object = report.as_object()?;
    let at = object.get("cycle").and_then(Value::as_str)?;
    if at.is_empty() {
        return None;
    }
    // Every finding stays, so a row's count is the report's count; only the
    // ledger fingerprint a row resolves is kept.
    let findings: Vec<Value> = object
        .get("findings")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| match row.get("fingerprint") {
                    Some(fingerprint) => json!({ "fingerprint": fingerprint }),
                    None => json!({}),
                })
                .collect()
        })
        .unwrap_or_default();
    let issues: Vec<Value> = object
        .get("issues")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("url").map(|url| json!({ "url": url })))
                .collect()
        })
        .unwrap_or_default();
    let mut bounded = Map::new();
    bounded.insert("cycle".to_string(), Value::String(at.to_string()));
    for key in ["window", "action", "reason"] {
        if let Some(value) = object.get(key) {
            bounded.insert(key.to_string(), value.clone());
        }
    }
    bounded.insert("findings".to_string(), Value::Array(findings));
    bounded.insert("issues".to_string(), Value::Array(issues));
    Some(Value::Object(bounded))
}

/// One run's cycle summary, derived from the report and recorded when the run
/// predates the summary. A summary is written only after its report, so an
/// existing one always describes that run.
pub fn read_run(run: &Path) -> Option<Value> {
    let summary_path = run.join(SUMMARY_FILE);
    if let Some(summary) = read_json(&summary_path) {
        return Some(summary);
    }
    let report = read_report(&run.join(REPORT_FILE))?;
    let summary = summary(&report)?;
    let _ = write_atomic(&summary_path, &summary);
    Some(summary)
}

/// Records one finished run's summary beside its report.
pub fn record(run: &Path, report: &Value) -> std::io::Result<()> {
    match summary(report) {
        Some(summary) => write_atomic(&run.join(SUMMARY_FILE), &summary),
        None => Ok(()),
    }
}

/// The newest run's summary, or `None` when the family holds no run: the same
/// cycle `latest.json` copies, read without parsing the whole report.
pub fn latest_run(directory: &Path) -> Option<Value> {
    let newest = std::fs::read_dir(directory.join("runs"))
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .max()?;
    read_run(&directory.join("runs").join(newest))
}

fn read_report(path: &Path) -> Option<Value> {
    #[cfg(test)]
    REPORT_PARSES.with(|parses| parses.set(parses.get() + 1));
    read_json(path)
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Writes one document so a reader sees either the old bytes or the new.
fn write_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    text.push('\n');
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root(label: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("cycle-summary-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a fixture root");
        root
    }

    fn report_document(index: usize, action: &str) -> Value {
        json!({
            "cycle": format!("2026-11-09T10:1{index}:00.000Z"),
            "window": {
                "start": format!("2026-11-09T10:0{index}:00.000Z"),
                "end": format!("2026-11-09T10:1{index}:00.000Z"),
            },
            "action": action,
            "findings": [{"fingerprint": format!("finding-{index}"), "line": "evidence"}],
            "issues": [{"url": format!("http://forge.invalid/issues/{}", index + 1)}],
            "reason": "filed 1 issue(s)",
            // The evidence a cycle writes and a projection never reads.
            "cleanup": {
                "entries": vec![json!({"path": "/fixture/build", "bytes": 1}); 20_000],
            },
        })
    }

    fn run_directory(root: &Path, stamp: &str) -> PathBuf {
        let directory = root.join("runs").join(stamp);
        std::fs::create_dir_all(&directory).expect("a run directory");
        directory
    }

    #[test]
    fn a_summary_carries_only_what_a_cycle_row_reads() {
        let summary = summary(&report_document(0, "filed")).expect("a summary");
        assert!(summary.get("cleanup").is_none());
        assert_eq!(summary["cycle"], json!("2026-11-09T10:10:00.000Z"));
        assert_eq!(summary["action"], json!("filed"));
        assert_eq!(summary["findings"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            summary["issues"][0]["url"],
            json!("http://forge.invalid/issues/1")
        );
        assert!(summary["findings"][0].get("line").is_none());
    }

    #[test]
    fn a_run_is_parsed_once_and_then_answered_from_its_summary() {
        let root = fixture_root("once");
        let run = run_directory(&root, "2026-11-09T10-10-00-000Z");
        std::fs::write(
            run.join(REPORT_FILE),
            report_document(0, "filed").to_string(),
        )
        .expect("a run report");

        REPORT_PARSES.with(|parses| parses.set(0));
        let first = read_run(&run).expect("the first summary");
        assert_eq!(REPORT_PARSES.with(|parses| parses.get()), 1);
        assert!(run.join(SUMMARY_FILE).exists());

        REPORT_PARSES.with(|parses| parses.set(0));
        let second = read_run(&run).expect("the recorded summary");
        assert_eq!(
            REPORT_PARSES.with(|parses| parses.get()),
            0,
            "a recorded summary is never re-derived from its report"
        );
        assert_eq!(second, first);

        std::fs::remove_file(run.join(SUMMARY_FILE)).expect("the summary removed");
        REPORT_PARSES.with(|parses| parses.set(0));
        let recovered = read_run(&run).expect("the recovered summary");
        assert_eq!(REPORT_PARSES.with(|parses| parses.get()), 1);
        assert_eq!(recovered, first);
    }

    #[test]
    fn the_newest_run_answers_the_latest_cycle() {
        let root = fixture_root("latest");
        for (index, stamp) in [
            (0, "2026-11-09T10-10-00-000Z"),
            (1, "2026-11-09T10-11-00-000Z"),
        ] {
            let run = run_directory(&root, stamp);
            std::fs::write(
                run.join(REPORT_FILE),
                report_document(index, "none").to_string(),
            )
            .expect("a run report");
        }
        let latest = latest_run(&root).expect("the newest summary");
        assert_eq!(latest["cycle"], json!("2026-11-09T10:11:00.000Z"));
        assert_eq!(latest["findings"].as_array().map(Vec::len), Some(1));
    }
}
