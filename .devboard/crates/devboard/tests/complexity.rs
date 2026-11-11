//! The complexity analyzer, its snapshot store, and the once-per-UTC-day rule.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use devboard::complexity::{
    analyze_complexity, build_complexity_snapshot, complexity_clock_from_env, complexity_directory,
    measure_source, parse_snapshot, read_snapshots, snapshot_file, utc_date, write_snapshot,
    ComplexityOptions, ComplexitySnapshot, ComplexitySnapshots, FileMeasure, FunctionMeasure,
    FunctionRow, Language, ProjectMeasure,
};
use serde_json::json;
use time::macros::datetime;
use time::OffsetDateTime;

fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("complexity-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a fixture root");
    root
}

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("a fixture directory");
    }
    std::fs::write(path, text).expect("a fixture file");
}

/// The line repeated in two measured files, so duplication is non-zero.
const SHARED_LINE: &str = "    let total = items.len() + offset;";

/// One fixture whose decision points, nesting, and noise are known by hand.
fn fixture(label: &str) -> PathBuf {
    let root = scratch(label);
    write(
        &root,
        "crates/app/src/keep.rs",
        &[
            "// a header comment with if (x) {",
            "pub fn decide(a: i32, b: i32) -> i32 {",
            "    if a > 0 {",
            "        for i in 0..b {",
            "            if a == i {",
            "                return if i > 1 { 1 } else { 0 };",
            "            }",
            "        }",
            "    } else if b < 0 {",
            "        return -1;",
            "    }",
            "    b",
            "}",
            "",
            "/*",
            "  while (true) { }",
            "*/",
            "fn twice(value: i32) -> i32 {",
            "    value * 2",
            "}",
            "",
            "pub fn nested(flag: bool) -> i32 {",
            "    let inner = |value: i32| {",
            "        if value > 0 { 1 } else { 0 }",
            "    };",
            "    if flag && inner(1) > 0 {",
            "        return 1;",
            "    }",
            "    0",
            "}",
            "",
            "pub fn shared(items: &[i32], offset: usize) -> usize {",
            SHARED_LINE,
            "    total",
            "}",
            "",
        ]
        .join("\n"),
    );
    write(
        &root,
        "crates/app/src/keep.test.rs",
        "pub fn ignored() -> i32 { 0 }\n",
    );
    write(
        &root,
        "crates/app/tests/crate_test.rs",
        "pub fn ignored_too() -> i32 { 0 }\n",
    );
    write(
        &root,
        "crates/app/target/debug/generated.rs",
        "pub fn built() -> i32 { 0 }\n",
    );
    write(
        &root,
        "client/lib/util.ts",
        &[
            "// a header comment with if (x) {",
            "export function decideTs(a: number, b: number): number {",
            "  if (a > 0) {",
            "    for (let i = 0; i < b; i += 1) {",
            "      if (a === i) {",
            "        return a ? 1 : 0;",
            "      }",
            "    }",
            "  } else if (b < 0) {",
            "    return -1;",
            "  }",
            "  return b;",
            "}",
            "",
            "export const sharedTs = (items: number[], offset: number): number => {",
            "    let total = items.len() + offset;",
            "  return total;",
            "};",
            "",
        ]
        .join("\n"),
    );
    write(
        &root,
        "client/lib/util.test.ts",
        "export function ignoredTest(): void {}\n",
    );
    write(
        &root,
        "client/node_modules/pkg/index.ts",
        "export function dependency(): void {}\n",
    );
    write(
        &root,
        "client/dist/bundle.js",
        "export function built(): void {}\n",
    );
    write(
        &root,
        "client/.tmp/scratch.ts",
        "export function scratch(): void {}\n",
    );
    write(
        &root,
        "client/public/asset.js",
        "export function shipped(): void {}\n",
    );
    write(
        &root,
        "client/Widget.svelte",
        &[
            "<script lang=\"ts\">",
            "  export function widget(a: number): number {",
            "    return a > 0 ? a : 0;",
            "  }",
            "</script>",
            "",
            "<p>widget</p>",
            "",
        ]
        .join("\n"),
    );
    root
}

fn function_values(source: &str, language: Language) -> Vec<(String, usize, usize, u64, u64, u64)> {
    measure_source(source, language)
        .functions
        .into_iter()
        .map(|entry| {
            (
                entry.name,
                entry.line,
                entry.lines,
                entry.cyclomatic,
                entry.nesting,
                entry.parameters,
            )
        })
        .collect()
}

#[test]
fn measures_per_function_complexity_length_nesting_and_parameters() {
    let root = fixture("metrics");
    let analysis = analyze_complexity(&root);

    let measured: Vec<_> = analysis
        .functions
        .iter()
        .map(|row| {
            (
                row.path.clone(),
                row.measure.name.clone(),
                row.measure.line,
                row.measure.lines,
                row.measure.cyclomatic,
                row.measure.nesting,
                row.measure.parameters,
            )
        })
        .collect();

    assert_eq!(
        measured,
        vec![
            (
                ".devboard/client/Widget.svelte".to_string(),
                "widget".to_string(),
                2,
                3,
                2,
                0,
                1
            ),
            (
                ".devboard/client/lib/util.ts".to_string(),
                "decideTs".to_string(),
                2,
                12,
                6,
                3,
                2
            ),
            (
                ".devboard/client/lib/util.ts".to_string(),
                "sharedTs".to_string(),
                15,
                4,
                1,
                0,
                2
            ),
            (
                ".devboard/crates/app/src/keep.rs".to_string(),
                "decide".to_string(),
                2,
                12,
                6,
                4,
                2
            ),
            (
                ".devboard/crates/app/src/keep.rs".to_string(),
                "twice".to_string(),
                18,
                3,
                1,
                0,
                1
            ),
            (
                ".devboard/crates/app/src/keep.rs".to_string(),
                "nested".to_string(),
                22,
                9,
                3,
                1,
                1
            ),
            (
                ".devboard/crates/app/src/keep.rs".to_string(),
                "inner".to_string(),
                23,
                3,
                2,
                1,
                1
            ),
            (
                ".devboard/crates/app/src/keep.rs".to_string(),
                "shared".to_string(),
                32,
                4,
                1,
                0,
                2
            ),
        ]
    );

    // A nested function's decisions belong to it, never to its parent.
    let rust = measure_source(
        &std::fs::read_to_string(root.join("crates/app/src/keep.rs")).expect("the fixture"),
        Language::Rust,
    );
    let nested = rust
        .functions
        .iter()
        .find(|entry| entry.name == "nested")
        .expect("the parent");
    let inner = rust
        .functions
        .iter()
        .find(|entry| entry.name == "inner")
        .expect("the closure");
    assert_eq!((nested.cyclomatic, inner.cyclomatic), (3, 2));
}

#[test]
fn comments_strings_and_regexes_contribute_no_decision() {
    let measured = measure_source(
        &[
            "fn quiet(value: &str) -> String {",
            "    // if (this) || (that) ? 1 : 2",
            "    let text = r#\"a ? b : c { }\"#;",
            "    let pattern = Regex::new(\"[{}()]\").unwrap();",
            "    text.to_string()",
            "}",
        ]
        .join("\n"),
        Language::Rust,
    );
    assert_eq!(measured.functions.len(), 1);
    assert_eq!(measured.functions[0].cyclomatic, 1);
    assert_eq!(measured.functions[0].nesting, 0);
    assert_eq!(measured.functions[0].parameters, 1);

    let ts = measure_source(
        &[
            "function quiet(value: string): string {",
            "  // if (this) || (that) ? 1 : 2",
            "  const text = value ?? 'a ? b : c';",
            "  return text;",
            "}",
        ]
        .join("\n"),
        Language::TypeScript,
    );
    assert_eq!(ts.functions.len(), 1);
    // The `??` operator is one decision; the commented `if`, `||`, and `?`,
    // and the quoted ternary are none.
    assert_eq!(ts.functions[0].cyclomatic, 2);
}

#[test]
fn an_optional_marker_is_not_a_ternary_branch() {
    let measured = measure_source(
        "function optional(value?: string): number {\n  return 0;\n}\n",
        Language::TypeScript,
    );
    assert_eq!(measured.functions[0].cyclomatic, 1);
    assert_eq!(measured.functions[0].parameters, 1);
}

#[test]
fn a_comparison_never_lends_an_earlier_generic_to_a_nested_block() {
    let measured = measure_source(
        &[
            "pub fn process_argv(pid: u32) -> Option<Vec<String>> {",
            "    let owner = pid.to_string();",
            "    Some(vec![owner])",
            "}",
            "",
            "fn parse_record(value: &Value) -> Option<Record> {",
            "    if pid <= 0 || pid > i64::from(u32::MAX) {",
            "        return None;",
            "    }",
            "    None",
            "}",
        ]
        .join("\n"),
        Language::Rust,
    );
    let rows: Vec<(&str, usize, u64, u64)> = measured
        .functions
        .iter()
        .map(|entry| {
            (
                entry.name.as_str(),
                entry.line,
                entry.cyclomatic,
                entry.nesting,
            )
        })
        .collect();
    // The nested `if` block is not a second function: the comparison `>` finds
    // no `<` before the statement boundary, so it never reaches the earlier
    // signature's `Option<Vec<String>>`.
    assert_eq!(
        rows,
        vec![("process_argv", 1, 1, 0), ("parse_record", 6, 3, 1)]
    );
    assert_eq!(measured.functions[1].lines, 6);
}

#[test]
fn measures_application_source_only() {
    let root = fixture("discovery");
    let analysis = analyze_complexity(&root);

    assert_eq!(
        analysis
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            ".devboard/client/Widget.svelte",
            ".devboard/client/lib/util.ts",
            ".devboard/crates/app/src/keep.rs",
        ]
    );
    assert_eq!(analysis.project.files, 3);
    assert_eq!(analysis.project.functions, 8);
    assert!(analysis
        .functions
        .iter()
        .all(|entry| entry.path.starts_with(".devboard/")));
    assert_eq!(
        analysis.project.loc,
        analysis.files.iter().map(|file| file.loc).sum::<u64>()
    );
}

#[test]
fn two_analyses_of_the_same_tree_are_identical() {
    let root = fixture("determinism");
    assert_eq!(analyze_complexity(&root), analyze_complexity(&root));
}

#[test]
fn the_harness_tree_analyzes_and_is_deterministic() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let analysis = analyze_complexity(&root);
    assert!(analysis.project.files > 0);
    assert!(analysis.project.functions > 0);
    assert!(analysis
        .files
        .iter()
        .any(|file| file.path == ".devboard/crates/devboard/src/app.rs"));
    assert!(analysis.functions.iter().any(|row| {
        row.path == ".devboard/crates/devboard/src/app.rs" && row.measure.name == "dispatch"
    }));
    assert!(analysis
        .files
        .iter()
        .all(|file| file.path.starts_with(".devboard/")));
    assert_eq!(analysis, analyze_complexity(&root));
}

#[test]
fn duplicated_lines_count_in_both_files_and_the_project() {
    let root = fixture("duplication");
    let analysis = analyze_complexity(&root);
    let measured: HashMap<&str, &FileMeasure> = analysis
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();

    assert!(
        measured[".devboard/crates/app/src/keep.rs"].duplicated_line_ratio > 0.0,
        "the shared line counts in the Rust file"
    );
    assert!(
        measured[".devboard/client/lib/util.ts"].duplicated_line_ratio > 0.0,
        "the shared line counts in the TypeScript file"
    );
    assert!(analysis.project.duplicated_line_ratio > 0.0);
}

#[test]
fn per_function_values_aggregate_into_the_project_figures() {
    let root = fixture("aggregate");
    let analysis = analyze_complexity(&root);
    let complexity: Vec<u64> = analysis
        .functions
        .iter()
        .map(|entry| entry.measure.cyclomatic)
        .collect();
    let mean = complexity.iter().sum::<u64>() as f64 / complexity.len() as f64;

    assert_eq!(
        analysis.project.max_cyclomatic,
        *complexity.iter().max().expect("a maximum")
    );
    assert_eq!(
        analysis.project.mean_cyclomatic,
        ((mean + f64::EPSILON) * 100.0).round() / 100.0
    );
    assert_eq!(
        analysis.project.functions_over_threshold,
        complexity.iter().filter(|value| **value > 10).count() as u64
    );
    assert!((0.0..=100.0).contains(&analysis.project.mean_maintainability));
    for file in &analysis.files {
        assert!((0.0..=100.0).contains(&file.maintainability));
    }
}

#[test]
fn source_length_counts_code_lines_only() {
    let measured = measure_source(
        &[
            "// a header comment with if (x) {",
            "export function decide(a: number, b: number): number {",
            "  if (a > 0) {",
            "    for (let i = 0; i < b; i += 1) {",
            "      if (a === i) {",
            "        return a ? 1 : 0;",
            "      }",
            "    }",
            "  } else if (b < 0) {",
            "    return -1;",
            "  }",
            "  return b;",
            "}",
            "",
            "/*",
            "  while (true) { }",
            "*/",
            "const twice = (value: number): number => {",
            "  return value * 2;",
            "};",
            "",
            "export function nested(flag: boolean): number {",
            "  const decide = (value: number): number => {",
            "    return value ? 1 : 0;",
            "  };",
            "  if (flag) {",
            "    return decide(flag ? 1 : 0);",
            "  }",
            "  return 0;",
            "}",
        ]
        .join("\n"),
        Language::TypeScript,
    );

    // Every line above holds code except the two inside the block comment,
    // the blank lines, and the comment-only header.
    assert_eq!(measured.loc, 24);
    assert_eq!(
        function_values(
            &[
                "export function decide(a: number, b: number): number {",
                "  if (a > 0) {",
                "    for (let i = 0; i < b; i += 1) {",
                "      if (a === i) {",
                "        return a ? 1 : 0;",
                "      }",
                "    }",
                "  } else if (b < 0) {",
                "    return -1;",
                "  }",
                "  return b;",
                "}",
            ]
            .join("\n"),
            Language::TypeScript,
        ),
        vec![("decide".to_string(), 1, 12, 6, 3, 2)]
    );
}

#[test]
fn halstead_counts_operands_and_operators_separately() {
    let counts = measure_source("const a = 1;\n", Language::TypeScript).halstead;
    assert_eq!((counts.operators, counts.distinct_operators), (3, 3));
    assert_eq!((counts.operands, counts.distinct_operands), (2, 2));
}

#[test]
fn the_same_text_measures_the_same_values_twice() {
    let source = std::fs::read_to_string(fixture("measure-twice").join("crates/app/src/keep.rs"))
        .expect("the fixture");
    assert_eq!(
        measure_source(&source, Language::Rust),
        measure_source(&source, Language::Rust)
    );
}

#[test]
fn tokenizer_skips_comments_and_keeps_one_token_per_literal() {
    let tokens = devboard::complexity::tokenize(
        "/* one */ // two\n const value = \"three\";\n",
        Language::TypeScript,
    );
    assert_eq!(
        tokens
            .iter()
            .map(|token| token.text.as_str())
            .collect::<Vec<_>>(),
        vec!["const", "value", "=", "\"three\"", ";"]
    );
    assert_eq!(
        tokens.iter().map(|token| token.line).collect::<Vec<_>>(),
        vec![2, 2, 2, 2, 2]
    );

    let tokens =
        devboard::complexity::tokenize("const text = `line\nif (x) {`;\n", Language::TypeScript);
    assert_eq!(
        tokens
            .iter()
            .filter(|token| token.kind == devboard::complexity::TokenKind::String)
            .count(),
        1
    );
    assert!(!tokens.iter().any(|token| token.text == "if"));
}

#[test]
fn utc_date_reads_the_utc_calendar_day() {
    assert_eq!(
        utc_date(datetime!(2026 - 11 - 01 23:59:59.999 UTC)),
        "2026-11-01"
    );
    assert_eq!(
        utc_date(datetime!(2026 - 11 - 02 00:00:00.000 UTC)),
        "2026-11-02"
    );
}

fn summary(date: &str, loc: u64) -> ComplexitySnapshot {
    ComplexitySnapshot {
        version: 1,
        date: date.to_string(),
        recorded_at: format!("{date}T00:00:00.000Z"),
        project: ProjectMeasure {
            files: 1,
            functions: 1,
            loc,
            mean_cyclomatic: 2.0,
            max_cyclomatic: 3,
            functions_over_threshold: 0,
            duplicated_line_ratio: 0.125,
            mean_maintainability: 80.0,
        },
        files: vec![FileMeasure {
            path: ".devboard/crates/app/src/keep.rs".to_string(),
            loc,
            functions: 1,
            duplicated_line_ratio: 0.125,
            maintainability: 80.0,
        }],
        functions: vec![devboard::complexity::FunctionRow {
            path: ".devboard/crates/app/src/keep.rs".to_string(),
            measure: devboard::complexity::FunctionMeasure {
                name: "keep".to_string(),
                line: 1,
                lines: 3,
                cyclomatic: 2,
                nesting: 0,
                parameters: 1,
            },
        }],
    }
}

#[tokio::test]
async fn snapshot_persistence_round_trips_every_level() {
    let root = scratch("store");
    let directory = complexity_directory(&root, &root.join("checkout"));
    let stored = summary("2026-11-01", 10);

    write_snapshot(&directory, &stored)
        .await
        .expect("a snapshot write");

    let names: Vec<String> = std::fs::read_dir(&directory)
        .expect("the snapshot directory")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["2026-11-01.json"]);
    let text = std::fs::read_to_string(snapshot_file(&directory, "2026-11-01"))
        .expect("the snapshot file");
    assert!(text.contains("\"version\":1"));
    assert_eq!(read_snapshots(&directory), vec![stored.clone()]);
    assert_eq!(
        parse_snapshot(&serde_json::to_value(&stored).expect("JSON")),
        Some(stored)
    );
}

#[tokio::test]
async fn reads_recorded_days_oldest_first_and_skips_damaged_files() {
    let root = scratch("damaged");
    let directory = complexity_directory(&root, &root.join("checkout"));

    write_snapshot(&directory, &summary("2026-11-02", 12))
        .await
        .expect("a second day");
    write_snapshot(&directory, &summary("2026-11-01", 11))
        .await
        .expect("a first day");
    std::fs::write(snapshot_file(&directory, "2026-11-03"), "{ not json").expect("a damaged day");
    let mut unsupported = serde_json::to_value(summary("2026-11-04", 13)).expect("JSON");
    unsupported["version"] = json!(2);
    std::fs::write(
        snapshot_file(&directory, "2026-11-04"),
        serde_json::to_string(&unsupported).expect("JSON"),
    )
    .expect("an unsupported day");
    std::fs::write(directory.join("notes.txt"), "ignore me").expect("an unrelated file");

    assert_eq!(
        read_snapshots(&directory)
            .into_iter()
            .map(|entry| entry.date)
            .collect::<Vec<_>>(),
        vec!["2026-11-01", "2026-11-02"]
    );
    let mut malformed = serde_json::to_value(summary("2026-11-01", 1)).expect("JSON");
    malformed["files"] = json!([{"path": ""}]);
    assert_eq!(parse_snapshot(&malformed), None);
}

#[tokio::test]
async fn a_missing_directory_is_an_empty_history() {
    let root = scratch("missing");
    assert_eq!(read_snapshots(&root.join("absent")), Vec::new());
}

fn controller(
    state_dir: &Path,
    repo_dir: &Path,
    instant: Arc<Mutex<OffsetDateTime>>,
    analyze: impl Fn(OffsetDateTime) -> Result<ComplexitySnapshot, String> + Send + Sync + 'static,
    measurements: Option<Arc<AtomicU64>>,
    errors: Option<Arc<Mutex<Vec<String>>>>,
) -> ComplexitySnapshots {
    let now = Arc::clone(&instant);
    ComplexitySnapshots::new(ComplexityOptions {
        state_dir: state_dir.to_path_buf(),
        repo_dir: repo_dir.to_path_buf(),
        now: Arc::new(move || *now.lock().expect("the clock")),
        analyze: Arc::new(move |now| {
            if let Some(measurements) = &measurements {
                measurements.fetch_add(1, Ordering::SeqCst);
            }
            analyze(now)
        }),
        interval: Duration::from_millis(60_000),
        report_error: Arc::new(move |line| {
            if let Some(errors) = &errors {
                errors.lock().expect("the error log").push(line);
            }
        }),
    })
}

#[tokio::test]
async fn records_one_snapshot_per_day_across_repeats_and_restarts() {
    let root = scratch("daily");
    let state_dir = root.join("state");
    let repo_dir = root.join("checkout");
    let instant = Arc::new(Mutex::new(datetime!(2026 - 11 - 01 09:00:00 UTC)));
    let measurements = Arc::new(AtomicU64::new(0));

    let first = controller(
        &state_dir,
        &repo_dir,
        Arc::clone(&instant),
        |now| Ok(summary(&utc_date(now), 10)),
        Some(Arc::clone(&measurements)),
        None,
    );

    let created = first.check().await.expect("the first day");
    assert_eq!(created.date, "2026-11-01");
    assert_eq!(measurements.load(Ordering::SeqCst), 1);

    // A later check, a page reload, and a reconnect on the same day add
    // nothing and measure nothing.
    assert_eq!(first.check().await, None);
    assert_eq!(measurements.load(Ordering::SeqCst), 1);

    // The UTC date rolls over while the server runs: one new file.
    *instant.lock().expect("the clock") = datetime!(2026 - 11 - 02 00:00:30 UTC);
    assert_eq!(
        first.check().await.map(|snapshot| snapshot.date),
        Some("2026-11-02".to_string())
    );
    assert_eq!(measurements.load(Ordering::SeqCst), 2);

    // A restart on the second day finds the day already recorded.
    let restarted = controller(
        &state_dir,
        &repo_dir,
        instant,
        |now| Ok(summary(&utc_date(now), 10)),
        Some(Arc::clone(&measurements)),
        None,
    );
    assert_eq!(restarted.check().await, None);
    assert_eq!(measurements.load(Ordering::SeqCst), 2);
    assert_eq!(
        read_snapshots(&complexity_directory(&state_dir, &repo_dir))
            .into_iter()
            .map(|entry| entry.date)
            .collect::<Vec<_>>(),
        vec!["2026-11-01", "2026-11-02"]
    );
}

#[tokio::test]
async fn overlapping_checks_share_one_measurement_and_one_file() {
    let root = scratch("overlap");
    let state_dir = root.join("state");
    let repo_dir = root.join("checkout");
    let measurements = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&measurements);
    let controller = controller(
        &state_dir,
        &repo_dir,
        Arc::new(Mutex::new(datetime!(2026 - 11 - 01 12:00:00 UTC))),
        move |now| {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(summary(&utc_date(now), 10))
        },
        None,
        None,
    );

    let (left, right) = tokio::join!(controller.check(), controller.check());

    assert_eq!(measurements.load(Ordering::SeqCst), 1);
    assert_eq!(
        left.map(|snapshot| snapshot.date),
        Some("2026-11-01".to_string())
    );
    assert_eq!(right, None);
    assert_eq!(read_snapshots(controller.directory()).len(), 1);
}

#[tokio::test]
async fn the_frame_lists_every_date_and_carries_the_newest_detail() {
    let root = scratch("frame");
    let state_dir = root.join("state");
    let repo_dir = root.join("checkout");
    let instant = Arc::new(Mutex::new(datetime!(2026 - 11 - 01 12:00:00 UTC)));
    let controller = controller(
        &state_dir,
        &repo_dir,
        Arc::clone(&instant),
        |now| Ok(summary(&utc_date(now), 10)),
        None,
        None,
    );

    controller.check().await.expect("the first day");
    *instant.lock().expect("the clock") = datetime!(2026 - 11 - 02 12:00:00 UTC);
    controller.check().await.expect("the second day");

    let frame = controller.frame();
    assert_eq!(
        frame
            .snapshots
            .iter()
            .map(|entry| entry.date.as_str())
            .collect::<Vec<_>>(),
        vec!["2026-11-01", "2026-11-02"]
    );
    assert_eq!(
        frame
            .snapshots
            .iter()
            .map(|entry| entry.project.loc)
            .collect::<Vec<_>>(),
        vec![10, 10]
    );
    assert_eq!(frame.latest.expect("the newest").date, "2026-11-02");
    let event = controller.state_event();
    assert_eq!(event["type"], "complexityState");
    assert_eq!(
        event["state"]["snapshots"].as_array().map(Vec::len),
        Some(2)
    );
}

/// The polled `complexityState` frame carries no per-function row: the page
/// reads only the newest snapshot's project figures and per-file rows, and the
/// function rows were 97% of a ~1 MB frame rebuilt on every one-second poll.
/// This test fails on the base frame, which serializes the whole snapshot.
#[tokio::test]
async fn the_state_frame_omits_the_function_rows_a_page_never_reads() {
    let root = scratch("state-frame");
    let state_dir = root.join("state");
    let repo_dir = root.join("checkout");
    let directory = complexity_directory(&state_dir, &repo_dir);
    let mut stored = summary("2026-11-01", 10);
    stored.functions = (0..4_000)
        .map(|index| FunctionRow {
            path: format!(".devboard/crates/app/src/file-{index}.rs"),
            measure: FunctionMeasure {
                name: format!("function_{index}"),
                line: index + 1,
                lines: 3,
                cyclomatic: 2,
                nesting: 0,
                parameters: 1,
            },
        })
        .collect();
    write_snapshot(&directory, &stored)
        .await
        .expect("a stored snapshot");

    let controller = controller(
        &state_dir,
        &repo_dir,
        Arc::new(Mutex::new(datetime!(2026 - 11 - 01 12:00:00 UTC))),
        |now| Ok(summary(&utc_date(now), 10)),
        None,
        None,
    );
    let event = controller.state_event();
    let latest = &event["state"]["latest"];
    assert!(
        latest.get("functions").is_none(),
        "the state frame ships per-function rows no page reads"
    );
    assert_eq!(latest["date"], "2026-11-01");
    assert_eq!(latest["files"].as_array().map(Vec::len), Some(1));
    assert_eq!(latest["project"]["loc"], 10);

    let frame_bytes = serde_json::to_string(&event).expect("the event").len();
    let stored_bytes = serde_json::to_string(&stored)
        .expect("the stored snapshot")
        .len();
    assert!(
        frame_bytes * 4 < stored_bytes,
        "the state frame ({frame_bytes} bytes) still carries the stored snapshot's bulk ({stored_bytes} bytes)"
    );
}

#[tokio::test]
async fn a_failed_measurement_records_nothing_and_is_reported_once() {
    let root = scratch("failure");
    let errors = Arc::new(Mutex::new(Vec::new()));
    let controller = controller(
        &root.join("state"),
        &root.join("checkout"),
        Arc::new(Mutex::new(datetime!(2026 - 11 - 01 12:00:00 UTC))),
        |_| Err("unreadable source".to_string()),
        None,
        Some(Arc::clone(&errors)),
    );

    assert_eq!(controller.check().await, None);
    assert_eq!(
        *errors.lock().expect("the errors"),
        vec!["complexity: measurement for 2026-11-01 failed: unreadable source"]
    );
    assert!(controller.snapshots().is_empty());
}

#[test]
fn the_pinned_clock_fixes_the_day_and_an_unusable_value_falls_back() {
    let mut env = HashMap::new();
    env.insert(
        "DEVBOARD_COMPLEXITY_NOW".to_string(),
        "2026-11-01T06:00:00.000Z".to_string(),
    );
    let pinned = complexity_clock_from_env(&env)();
    assert_eq!(
        devboard::complexity::iso_instant(pinned),
        "2026-11-01T06:00:00.000Z"
    );

    let mut env = HashMap::new();
    env.insert(
        "DEVBOARD_COMPLEXITY_NOW".to_string(),
        "not a date".to_string(),
    );
    let real = complexity_clock_from_env(&env)();
    assert!(real > OffsetDateTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000));
}

#[test]
fn an_empty_tree_measures_zero_without_failing() {
    let root = scratch("empty");
    let analysis = analyze_complexity(&root);
    assert_eq!(analysis.project.files, 0);
    assert_eq!(analysis.project.functions, 0);
    assert_eq!(analysis.project.loc, 0);
    assert_eq!(analysis.project.mean_maintainability, 0.0);
    assert!((0.0..=100.0).contains(
        &build_complexity_snapshot(&root, datetime!(2026 - 11 - 01 00:00:00 UTC))
            .project
            .mean_maintainability
    ));
}
