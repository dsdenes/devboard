//! The complexity dashboard: a deterministic analyzer over the harness's own
//! source, a daily snapshot store, and the frame the page renders.
//!
//! Ported from `.devboard/server/complexity/` after the TypeScript runtime was
//! replaced by this Rust harness. The measured tree is the harness itself:
//! `.devboard/crates/**/*.rs` and `.devboard/client/**/*.{ts,svelte}`, with
//! tests, `target`, `node_modules`, `dist`, `.tmp`, and `public` excluded.

pub mod analyze;
pub mod measure;
pub mod snapshots;
pub mod store;

pub use analyze::{
    analyze_complexity, build_complexity_snapshot, utc_date, ComplexityAnalysis,
    ComplexitySnapshot, FileMeasure, FunctionRow, ProjectMeasure, COMPLEXITY_THRESHOLD,
    COMPLEXITY_VERSION,
};
pub use measure::{
    halstead_volume, maintainability_index, measure_source, round, tokenize, FileMeasureSource,
    FunctionMeasure, HalsteadCounts, Language, Token, TokenKind,
};
pub use snapshots::{
    complexity_clock, complexity_clock_from_env, harness_root, iso_instant, Analyze, Clock,
    ComplexityOptions, ComplexitySnapshots, ReportError, COMPLEXITY_CHECK_INTERVAL_MS,
};
pub use store::{
    complexity_directory, complexity_root, parse_snapshot, read_snapshots, snapshot_file,
    write_snapshot, ComplexityFrame, SnapshotSummary,
};
