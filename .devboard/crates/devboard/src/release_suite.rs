//! The release suite: one whole run, per-test classification, and the durable
//! record.
//!
//! The suite runs the workspace once. A test that fails that whole-suite
//! attempt is retried alone through libtest's `--exact` filter. A test that
//! passes the isolated retry is flaky: it does not block the release, it is
//! skipped for the rest of this run, and one issue records it. A test that
//! fails the isolated retry is deterministic: it blocks the release, and one
//! issue records it. A run never starts a second whole-suite attempt after a
//! per-test failure, because the first one already executed every test that
//! did not fail. No tracked file is rewritten, so the suite checkout, `main`,
//! and `git status --porcelain` are byte-identical before and after the run.
//!
//! The skip is run-only. Nothing is read back from the forge to decide what
//! runs, so a test with an open flaky issue still executes on the next run; a
//! finding for the same test appends one comment to that open issue and never
//! creates a second one.
//!
//! Only a per-test failure is classified. A failure of the suite itself — a
//! file that does not compile, a runner that crashes, output that names no
//! test — is structural, and no retry can address it: it ends the run with a
//! nonzero code, prints the first concrete error line, and files nothing. A
//! build that could not write its artifacts because the host filesystem is
//! full is structural too, and its reason names that host condition instead of
//! claiming a compile error: no repository change frees the disk.
//!
//! Every attempt builds with `TMPDIR`, `TMP`, and `TEMP` naming a directory
//! inside the workspace's own `target/tmp`, so the compiler temporaries
//! `cargo`, `rustc`, and a build script's C compiler write stay on the disk
//! the build already uses. The host temporary directory is never a build
//! input: a small or full one there fails a build the workspace could hold,
//! and the harness neither owns nor cleans the files it leaves behind. The
//! run removes its directory when the suite ends.
//!
//! Two conditions are retried instead of ending the run. One is the kernel
//! refusing to start a freshly built test binary, which is what another build
//! writing the same target directory does while that binary's executable bit
//! is not yet set. The other is a target directory that left while the build
//! ran: cargo creates a unit's fingerprint directory once and never recreates
//! it, so unlinking it under a running build fails every in-flight unit with
//! `No such file or directory` while writing its dep info. Neither attempt ran
//! a test, so nothing is classified; the run retries the whole suite and
//! reports the condition, with the file or directory and the errno, only once
//! the attempt budget is spent.
//!
//! Every classified test files one deduplicated issue in the origin forge.
//! Filing is best effort: an unreachable forge prints one failure line and
//! never changes the run's exit code. The dedupe key is the test's title, so a
//! run whose open-issue read fails files nothing: the next run comments on or
//! creates the single issue once its own read succeeds.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use crate::build_lane::BuildLane;
use crate::forge::{
    self, CreateIssueInput, Environment, GiteaCallOptions, GiteaTarget, IssueQueryState, Transport,
};
use crate::publish::{CommandInvocation, CommandRunner, ProcessRunner};

/// One boxed, sendable future, the form every injected seam returns.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The most whole-suite attempts one run makes. Only an attempt that ran no
/// test — the kernel refused to start a freshly built binary, or a target tree
/// left under the build — is retried; a per-test failure ends the attempt count
/// at the attempt that reported it.
pub const RELEASE_SUITE_MAX_ATTEMPTS: u32 = 9;
/// The longest suffix of one failed attempt kept for diagnostics.
pub const ATTEMPT_OUTPUT_LIMIT: usize = 20_000;
/// The longest failure text kept for one classified test.
pub const FAILURE_OUTPUT_LIMIT: usize = 4_000;
/// The longest issue title the forge accepts.
pub const TITLE_LIMIT: usize = 200;
/// The longest issue body this run files.
pub const BODY_LIMIT: usize = 60_000;
/// The prefix a flaky test's issue title carries.
pub const FLAKY_TITLE_PREFIX: &str = "flaky(test): ";
/// The prefix a deterministic test's issue title carries.
pub const DETERMINISTIC_TITLE_PREFIX: &str = "deterministic(test): ";
const FENCE: &str = "````";
/// What cargo, rustc, or a runner prints when the host filesystem is full.
const STORAGE_FAILURE_MARKERS: [&str; 2] = ["No space left on device", "ENOSPC"];
/// What cargo prints when the kernel refused to start a test binary.
const EXEC_BLOCKED_MARKER: &str = "could not execute process";
/// The errnos a binary still being written by another build raises.
const EXEC_BLOCKED_ERRNOS: [&str; 2] = ["Permission denied", "Text file busy"];
/// What cargo prints when it translates a freshly compiled unit's dep info.
const DEP_INFO_MARKER: &str = "could not parse/generate dep info at:";
/// The directory cargo writes that translation into, one per compiled unit.
const FINGERPRINT_MARKER: &str = ".fingerprint/";
/// What a target directory that left under a running build raises.
const MISSING_TREE_MARKERS: [&str; 2] = ["No such file or directory", "ENOENT"];

// ---------------------------------------------------------------------------
// One test result

/// What the runner said about one test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaseState {
    Pass,
    Skip,
    Fail,
}

/// One test the runner reported, with the file that registers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuiteCase {
    /// Path the runner reported, relative to the suite's working root.
    pub file: String,
    /// The exact test name, the module path included.
    pub name: String,
    /// The name with its suite chain, outermost first; the Rust runner's
    /// names are already hierarchical, so this equals `name`.
    pub full_name: String,
    pub state: CaseState,
    /// The failure text the runner recorded; empty for a passing test.
    pub output: String,
}

/// Everything one attempt's console output named.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SuiteParse {
    pub cases: Vec<SuiteCase>,
    /// Suite-level defects that are not a per-test result.
    pub errors: Vec<String>,
}

/// The first line that states a concrete failure, or `None`.
pub fn first_error_line(output: &str) -> Option<String> {
    output.lines().map(str::trim).find_map(|line| {
        if line.starts_with("error[") {
            return Some(line.to_string());
        }
        if !line.starts_with("error:") {
            return None;
        }
        if line.starts_with("error: test failed")
            || line.contains("target failed")
            || line.contains("targets failed")
        {
            return None;
        }
        Some(line.to_string())
    })
}

/// The line that names a build which could not write its artifacts because the
/// host filesystem is full, or `None`.
///
/// cargo reports that as `error: could not compile …` with
/// `Caused by: No space left on device`, so the marker decides, not the
/// compiler's summary line. A concrete `error:` line that carries the marker
/// wins over a bare `Caused by:` line, because it names what failed to write.
fn host_storage_failure(output: &str) -> Option<String> {
    let named = |line: &str| {
        !line.is_empty()
            && STORAGE_FAILURE_MARKERS
                .iter()
                .any(|marker| line.contains(marker))
    };
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    lines
        .iter()
        .copied()
        .find(|line| line.starts_with("error") && named(line))
        .or_else(|| lines.iter().copied().find(|line| named(line)))
        .map(str::to_string)
}

/// The line that names a test binary the kernel refused to start because
/// another build was writing it, or `None`.
///
/// cargo prints `error: test failed, to rerun pass …` and then
/// `Caused by: could not execute process <path> (never executed)` with the
/// errno on the following block. `Permission denied` is what a binary whose
/// executable bit is not set yet raises, and `Text file busy` is the same race
/// one step later; both name the binary, which the bare exit code cannot.
fn exec_blocked(output: &str) -> Option<String> {
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    let index = lines
        .iter()
        .position(|line| line.contains(EXEC_BLOCKED_MARKER))?;
    let line = lines[index];
    let errno = lines[index + 1..]
        .iter()
        .take(4)
        .find(|line| EXEC_BLOCKED_ERRNOS.iter().any(|errno| line.contains(errno)));
    Some(match errno {
        Some(errno) => format!("{line}: {errno}"),
        None => line.to_string(),
    })
}

/// The line that names a build whose target directory left while it ran, or
/// `None`.
///
/// Cargo creates `<target>/<profile>/.fingerprint/<pkg>-<hash>` once when a
/// unit starts and never recreates it, then translates that unit's dep info
/// into the directory. A sweep or a hand-run `rm -rf target` that unlinks the
/// directory under a running build therefore fails every in-flight unit with
/// `No such file or directory` while writing there. Nothing about the sources
/// is wrong, so the run retries whole: the next attempt rebuilds the tree
/// instead of ending as a compile failure.
fn target_tree_vanished(output: &str) -> Option<String> {
    if !output.contains(FINGERPRINT_MARKER)
        || !MISSING_TREE_MARKERS
            .iter()
            .any(|marker| output.contains(marker))
    {
        return None;
    }
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    lines
        .iter()
        .copied()
        .find(|line| line.starts_with("error") && line.contains(DEP_INFO_MARKER))
        .or_else(|| {
            lines
                .iter()
                .copied()
                .find(|line| line.starts_with("error") && line.contains(FINGERPRINT_MARKER))
        })
        .map(str::to_string)
}

/// The file a `Running …` header names, or `None` for an unrelated line.
///
/// Cargo writes these headers to its own stderr; the test binary's output is
/// forwarded on stdout separately, so the two streams are correlated by
/// position rather than interleaved text.
fn running_file(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("Running ")?;
    let (target, _binary) = rest.rsplit_once(" (")?;
    let file = target.trim();
    let file = file.strip_prefix("unittests ").unwrap_or(file).trim();
    if file.is_empty() {
        None
    } else {
        Some(file.to_string())
    }
}

/// The file a `Doc-tests <crate>` header names.
fn doc_tests_file(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix("Doc-tests ")?.trim();
    if rest.is_empty() {
        None
    } else {
        Some(format!("doc-tests {rest}"))
    }
}

/// A `running <n> test(s)` line that opens one target's output.
fn segment_header(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.starts_with("running ") {
        return false;
    }
    trimmed.ends_with(" test") || trimmed.ends_with(" tests")
}

/// One `test <name> ... <verdict>` line.
fn test_outcome(line: &str) -> Option<(&str, CaseState)> {
    let trimmed = line.trim_end();
    let rest = trimmed.strip_prefix("test ")?;
    let (name, verdict) = rest.rsplit_once(" ... ")?;
    let state = match verdict {
        "ok" => CaseState::Pass,
        "FAILED" => CaseState::Fail,
        "ignored" => CaseState::Skip,
        _ => return None,
    };
    Some((name, state))
}

/// Every `---- <name> stdout ----` block, keyed by test name.
fn failure_blocks(output: &str) -> HashMap<String, String> {
    let lines: Vec<&str> = output.lines().collect();
    let mut blocks = HashMap::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if let Some(rest) = line.strip_prefix("---- ") {
            if let Some(name) = rest.strip_suffix(" stdout ----") {
                let mut body: Vec<&str> = Vec::new();
                index += 1;
                while index < lines.len() {
                    let current = lines[index];
                    if current.starts_with("---- ")
                        || current.trim() == "failures:"
                        || current.starts_with("test result:")
                    {
                        break;
                    }
                    body.push(current);
                    index += 1;
                }
                blocks.insert(name.to_string(), body.join("\n").trim().to_string());
                continue;
            }
        }
        index += 1;
    }
    blocks
}

/// Reads one attempt's two output streams into per-test results.
///
/// Cargo prints one `Running <target>` (or `Doc-tests <crate>`) header per test
/// binary on stderr and runs the binaries one at a time; each binary's stdout
/// opens with `running <n> test(s)`. Pairing the headers with the segments in
/// order attributes every test line to the file that registers it.
pub fn parse_suite_output(stdout: &str, stderr: &str) -> SuiteParse {
    let headers: Vec<String> = stderr
        .lines()
        .filter_map(|line| running_file(line).or_else(|| doc_tests_file(line)))
        .collect();
    let blocks = failure_blocks(stdout);
    let mut parsed = SuiteParse::default();
    let mut file: Option<String> = None;
    let mut segment = 0;
    let mut in_block = false;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("---- ") {
            if rest.ends_with(" stdout ----") || rest.ends_with(" stderr ----") {
                in_block = true;
            }
            continue;
        }
        if in_block {
            // A failed test's captured output and panic text can repeat the
            // runner's own lines; they never contribute a test result.
            if line.trim() == "failures:" || line.starts_with("test result:") {
                in_block = false;
            }
            continue;
        }
        if segment_header(line) {
            file = headers.get(segment).cloned();
            segment += 1;
            continue;
        }
        let Some((name, state)) = test_outcome(line) else {
            continue;
        };
        let Some(current) = file.as_deref() else {
            parsed.errors.push(format!(
                "the runner reported the test \"{name}\" without a file"
            ));
            continue;
        };
        parsed.cases.push(SuiteCase {
            file: current.to_string(),
            name: name.to_string(),
            full_name: name.to_string(),
            state,
            output: if state == CaseState::Fail {
                blocks.get(name).cloned().unwrap_or_default()
            } else {
                String::new()
            },
        });
    }
    parsed
}

// ---------------------------------------------------------------------------
// One whole-suite attempt

/// One per-test failure, with the text the runner recorded for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptFailure {
    pub file: String,
    pub name: String,
    pub full_name: String,
    pub output: String,
}

/// Everything one whole-suite attempt reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptRecord {
    pub index: u32,
    pub code: i32,
    pub pass: usize,
    pub skip: usize,
    pub failures: Vec<AttemptFailure>,
    /// Every test name the attempt named, in console order.
    pub names: Vec<String>,
    /// Set when the attempt failed for a reason no test's skip can address.
    pub structural: Option<String>,
    /// Set when the attempt failed on a transient host condition: the kernel
    /// refused to start a freshly built binary, or the target directory left
    /// while the build ran. The attempt ran no test, so the run retries it
    /// whole.
    pub transient: Option<String>,
    /// The first concrete failure the structural reason names, carried so the
    /// release gate can refuse with it without parsing the reason's prose.
    pub error_line: Option<String>,
    /// The runner's console output, bounded for diagnostics.
    pub output: String,
}

fn bound(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut cut = limit;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n… ({} more bytes)", &text[..cut], text.len() - cut)
}

/// Sorts one attempt's output into per-test results or a structural failure.
///
/// A compiler error, output that names no test, a crashed runner, an exit code
/// that contradicts the parsed results, and a build that could not write its
/// artifacts because the host filesystem is full are structural: none of them
/// is a test that failed, so none of them may be retried or skipped into a
/// pass. The full filesystem is reported as that host condition, never as a
/// compile error. Two conditions are retried whole instead: a binary the kernel
/// refused to start because another build was still writing it, and a target
/// directory that left while the build ran. Both ran no test, and the next
/// attempt rebuilds the file or the tree.
pub fn classify_attempt(index: u32, code: i32, stdout: &str, stderr: &str) -> AttemptRecord {
    let parsed = parse_suite_output(stdout, stderr);
    let output = format!(
        "{}\n{}",
        bound(stdout, ATTEMPT_OUTPUT_LIMIT),
        bound(stderr, ATTEMPT_OUTPUT_LIMIT)
    );
    let failures: Vec<AttemptFailure> = parsed
        .cases
        .iter()
        .filter(|case| case.state == CaseState::Fail)
        .map(|case| AttemptFailure {
            file: case.file.clone(),
            name: case.name.clone(),
            full_name: case.full_name.clone(),
            output: bound(&case.output, FAILURE_OUTPUT_LIMIT),
        })
        .collect();
    let pass = parsed
        .cases
        .iter()
        .filter(|case| case.state == CaseState::Pass)
        .count();
    let skip = parsed
        .cases
        .iter()
        .filter(|case| case.state == CaseState::Skip)
        .count();

    let mut structural: Vec<String> = parsed.errors.clone();
    let exec_line = exec_blocked(stderr).or_else(|| exec_blocked(stdout));
    let compile_line = first_error_line(stderr).or_else(|| first_error_line(stdout));
    let storage_line = host_storage_failure(stderr).or_else(|| host_storage_failure(stdout));
    let vanished_line = target_tree_vanished(stderr).or_else(|| target_tree_vanished(stdout));
    let could_not_compile =
        stderr.contains("could not compile") || stdout.contains("could not compile");
    let mut error_line: Option<String> = None;
    let mut transient: Option<String> = None;
    if let Some(line) = exec_line {
        let reason = format!("the runner could not execute a freshly built test binary: {line}");
        error_line = Some(reason.clone());
        transient = Some(reason);
    } else if let Some(line) = storage_line {
        let reason = format!("the host filesystem is full: {line}");
        error_line = Some(reason.clone());
        structural.push(reason);
    } else if let Some(line) = vanished_line {
        let reason = format!("the target directory left while the suite built: {line}");
        error_line = Some(reason.clone());
        transient = Some(reason);
    } else if could_not_compile {
        match &compile_line {
            Some(line) => {
                structural.push(format!("the suite could not compile: {line}"));
                error_line = Some(line.clone());
            }
            None => structural.push("the suite could not compile".to_string()),
        }
    } else if parsed.cases.is_empty() {
        match (&compile_line, code) {
            (Some(line), _) => {
                structural.push(format!("the suite could not compile: {line}"));
                error_line = Some(line.clone());
            }
            (None, 0) => structural.push("the runner's result named no test".to_string()),
            (None, _) => structural.push(format!(
                "the runner exited {code} without a failing test result"
            )),
        }
    } else if code != 0 && failures.is_empty() {
        structural.push(format!(
            "the runner exited {code} without a failing test result"
        ));
    } else if code == 0 && !failures.is_empty() {
        structural.push(format!(
            "the runner exited 0 while reporting {} failing test(s)",
            failures.len()
        ));
    }

    AttemptRecord {
        index,
        code,
        pass,
        skip,
        failures,
        names: parsed.cases.iter().map(|case| case.name.clone()).collect(),
        structural: if structural.is_empty() {
            None
        } else {
            Some(structural.join("; "))
        },
        transient,
        error_line,
        output,
    }
}

// ---------------------------------------------------------------------------
// The classification loop

/// What one failing test's isolated retry proved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// The whole-suite attempt failed the test and its isolated retry passed
    /// it, so the failure does not block this release.
    Flaky,
    /// The whole-suite attempt and its isolated retry both failed the test, so
    /// the release must not ship.
    Deterministic,
}

impl Classification {
    /// The one word the log, the issue, and the report use.
    pub fn as_str(self) -> &'static str {
        match self {
            Classification::Flaky => "flaky",
            Classification::Deterministic => "deterministic",
        }
    }
}

/// One test the whole-suite attempt failed, with the text that decided it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestFinding {
    pub file: String,
    pub name: String,
    pub full_name: String,
    pub classification: Classification,
    /// The whole-suite attempt that reported the failure.
    pub attempt: AttemptLine,
    /// What the isolated retry printed, when it printed anything.
    pub retry_output: Option<String>,
}

/// One attempt's index and the failure text it recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptLine {
    pub index: u32,
    pub output: String,
}

/// What one release-suite run decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuiteOutcome {
    pub code: i32,
    pub attempts: u32,
    /// Every test the whole-suite attempt failed, classified.
    pub findings: Vec<TestFinding>,
    /// Set when the run ended on a structural failure.
    pub structural: Option<String>,
    /// The first concrete failure the structural reason names.
    pub error_line: Option<String>,
}

/// One whole-suite attempt as the run reports it on its log: its number and
/// its passed and failed counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuiteAttempt {
    pub attempt: u32,
    pub passed: u64,
    pub failed: u64,
}

/// Formats one attempt's log line, `attempt 2/9: 3 fail, 100 pass, 4 skip`.
///
/// This function and `parse_attempt_line` are the wording's only owner:
/// `publish` reads the record they write, so no other module spells these
/// separators or count suffixes.
pub fn attempt_line(index: u32, max: u32, failed: usize, passed: usize, skipped: usize) -> String {
    format!("attempt {index}/{max}: {failed} fail, {passed} pass, {skipped} skip")
}

/// Parses the line `attempt_line` writes. Every other attempt shape — `nothing
/// ran`, `structural failure` — yields `None`, because it reports no attempt's
/// passed and failed counts.
pub fn parse_attempt_line(line: &str) -> Option<SuiteAttempt> {
    let rest = line.strip_prefix("attempt ")?;
    let (index, rest) = rest.split_once('/')?;
    let attempt: u32 = index.trim().parse().ok()?;
    let (_, counts) = rest.split_once(": ")?;
    let mut parts = counts.split(", ");
    let failed: u64 = parts.next()?.strip_suffix(" fail")?.trim().parse().ok()?;
    let passed: u64 = parts.next()?.strip_suffix(" pass")?.trim().parse().ok()?;
    parts
        .next()?
        .strip_suffix(" skip")?
        .trim()
        .parse::<u64>()
        .ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(SuiteAttempt {
        attempt,
        passed,
        failed,
    })
}

/// One whole-suite attempt, injectable so the loop is testable.
pub trait SuiteAttempts: Send {
    /// Runs one attempt, filtered to `names` when the caller retries a failing
    /// test alone through libtest's `--exact`.
    fn attempt<'a>(
        &'a mut self,
        index: u32,
        names: Option<&'a [String]>,
    ) -> BoxFuture<'a, AttemptRecord>;
}

/// How one failing test's isolated retry ended.
struct Retried {
    classification: Classification,
    output: Option<String>,
}

/// Retries one failing test alone, through libtest's `--exact`.
///
/// A retry that ran no test — the kernel refused to start a freshly built
/// binary, or the target tree left under the build — is retried again within
/// the attempt budget, exactly as a whole-suite attempt is. Any result that
/// names a test decides: a clean exit is a pass, and everything else is a
/// failure of the test itself.
async fn retry_alone(
    attempts: &mut dyn SuiteAttempts,
    failure: &AttemptFailure,
    max_attempts: u32,
) -> Retried {
    let names = [failure.full_name.clone()];
    let mut output = Some(failure.output.clone());
    for index in 1..=max_attempts {
        let record = attempts.attempt(index, Some(&names)).await;
        if record.transient.is_some() {
            continue;
        }
        output = Some(record.output);
        let passed = record.structural.is_none() && record.code == 0 && record.failures.is_empty();
        return Retried {
            classification: if passed {
                Classification::Flaky
            } else {
                Classification::Deterministic
            },
            output,
        };
    }
    Retried {
        classification: Classification::Deterministic,
        output,
    }
}

/// Drives one release-suite run: one whole-suite attempt, then one isolated
/// retry for every test it failed.
///
/// The first attempt that reports no failing test passes the run. An attempt
/// that ran no test is retried whole, because another build was still writing
/// the binary or the target tree moved; a structural failure ends the run
/// immediately. A per-test failure is classified by its isolated retry: a test
/// that passed it is flaky and does not block the release, a test that failed
/// it is deterministic and blocks the release. No second whole-suite attempt
/// follows a per-test failure, because the attempt that reported it already
/// executed every test that did not fail.
pub async fn run_classification_suite(
    attempts: &mut dyn SuiteAttempts,
    log: &(dyn Fn(&str) + Sync),
    max_attempts: u32,
) -> SuiteOutcome {
    let mut attempt_count = 0;
    let mut unexecuted: Option<(String, Option<String>)> = None;

    for index in 1..=max_attempts {
        let record = attempts.attempt(index, None).await;
        attempt_count = index;
        if let Some(transient) = &record.transient {
            log(&format!(
                "attempt {index}/{max_attempts}: nothing ran, retrying: {transient}"
            ));
            unexecuted = Some((transient.clone(), record.error_line.clone()));
            continue;
        }
        if let Some(structural) = &record.structural {
            log(&format!(
                "attempt {index}/{max_attempts}: structural failure: {structural}"
            ));
            if !record.output.trim().is_empty() {
                log(record.output.trim_end());
            }
            return SuiteOutcome {
                code: 1,
                attempts: attempt_count,
                findings: Vec::new(),
                structural: Some(structural.clone()),
                error_line: record.error_line.clone(),
            };
        }
        log(&attempt_line(
            index,
            max_attempts,
            record.failures.len(),
            record.pass,
            record.skip,
        ));
        if record.failures.is_empty() {
            return SuiteOutcome {
                code: 0,
                attempts: attempt_count,
                findings: Vec::new(),
                structural: None,
                error_line: None,
            };
        }
        let mut findings = Vec::new();
        let mut blocked = false;
        for failure in &record.failures {
            let retried = retry_alone(attempts, failure, max_attempts).await;
            if retried.classification == Classification::Deterministic {
                blocked = true;
            }
            log(&format!(
                "{}: {} :: {}",
                retried.classification.as_str(),
                failure.file,
                failure.full_name
            ));
            if retried.classification == Classification::Flaky {
                log(&format!(
                    "skipped for the rest of this run: {}",
                    failure.full_name
                ));
            }
            findings.push(TestFinding {
                file: failure.file.clone(),
                name: failure.name.clone(),
                full_name: failure.full_name.clone(),
                classification: retried.classification,
                attempt: AttemptLine {
                    index,
                    output: failure.output.clone(),
                },
                retry_output: retried.output,
            });
        }
        return SuiteOutcome {
            code: if blocked { 1 } else { 0 },
            attempts: attempt_count,
            findings,
            structural: None,
            error_line: None,
        };
    }

    if let Some((transient, error_line)) = unexecuted {
        return SuiteOutcome {
            code: 1,
            attempts: attempt_count,
            findings: Vec::new(),
            structural: Some(transient),
            error_line,
        };
    }
    SuiteOutcome {
        code: 1,
        attempts: attempt_count,
        findings: Vec::new(),
        structural: None,
        error_line: None,
    }
}

// ---------------------------------------------------------------------------
// The runner's attempts

/// One attempt through `cargo test` in a suite directory.
pub struct CommandAttempts<'a> {
    pub dir: &'a Path,
    pub environment: &'a Environment,
    pub runner: &'a dyn CommandRunner,
    pub timeout: Duration,
}

/// The temporary directory one run's compiler children use, inside the
/// workspace the run builds.
///
/// `cargo` and `rustc` pass `TMPDIR` to every build script, and the `cc` crate
/// writes its assembly there. A path under `target/tmp` keeps those writes on
/// the filesystem the build already uses and inside the workspace's own
/// `target` tree, never in the host temporary directory.
///
/// The value is always absolute: `rustc` resolves a relative `TMPDIR` against
/// the crate directory it compiles, which for a registry dependency is the
/// extracted source tree, so a relative suite directory — `devboard publish
/// --repo .` hands one in — would name a directory that does not exist there.
fn attempt_temp_directory(dir: &Path) -> PathBuf {
    let root = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    root.join("target")
        .join("tmp")
        .join(format!("release-suite-{}", std::process::id()))
}

impl SuiteAttempts for CommandAttempts<'_> {
    fn attempt<'a>(
        &'a mut self,
        index: u32,
        names: Option<&'a [String]>,
    ) -> BoxFuture<'a, AttemptRecord> {
        let mut args = vec![
            "test".to_string(),
            "--workspace".to_string(),
            "--no-fail-fast".to_string(),
        ];
        if let Some(names) = names {
            args.push("--".to_string());
            args.push("--exact".to_string());
            args.extend(names.iter().cloned());
        }
        let temp = attempt_temp_directory(self.dir);
        if let Err(error) = std::fs::create_dir_all(&temp) {
            let reason = format!(
                "the release suite cannot use its temporary directory {}: {error}",
                temp.display()
            );
            return Box::pin(async move {
                AttemptRecord {
                    index,
                    code: -1,
                    pass: 0,
                    skip: 0,
                    failures: Vec::new(),
                    names: Vec::new(),
                    structural: Some(reason.clone()),
                    transient: None,
                    error_line: Some(reason),
                    output: String::new(),
                }
            });
        }
        let temp_value = temp.to_string_lossy().into_owned();
        let mut environment = self.environment.clone();
        for key in ["TMPDIR", "TMP", "TEMP"] {
            environment.insert(key.to_string(), temp_value.clone());
        }
        let lane = BuildLane::for_checkout(self.dir, self.environment);
        let mut invocation = CommandInvocation {
            program: "cargo".to_string(),
            args,
            cwd: self.dir.to_path_buf(),
            env: environment,
            timeout: self.timeout,
        };
        let runner = self.runner;
        Box::pin(async move {
            // One attempt is a full workspace build, so it takes the same lane
            // slot every harness build takes. The slot is held for the whole
            // cargo invocation and released before the attempt is classified;
            // waiting for it is not part of the attempt's own timeout.
            let lease = lane.acquire_async().await;
            lane.export(&lease, &mut invocation.env);
            let outcome = runner.run(invocation).await;
            drop(lease);
            classify_attempt(index, outcome.code, &outcome.stdout, &outcome.stderr)
        })
    }
}

// ---------------------------------------------------------------------------
// Issue filing

/// One open issue a dedupe compares against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenIssue {
    pub number: u64,
    pub title: String,
}

/// The forge reads and writes filing needs; tests inject their own.
pub trait QuarantineForge: Send + Sync {
    fn list_open<'a>(&'a self) -> BoxFuture<'a, Result<Vec<OpenIssue>, String>>;
    fn create<'a>(&'a self, title: &'a str, body: &'a str) -> BoxFuture<'a, Result<u64, String>>;
    fn comment<'a>(&'a self, number: u64, body: &'a str) -> BoxFuture<'a, Result<(), String>>;
}

/// The origin repository's Gitea API, through the existing forge client.
pub struct GiteaQuarantineForge {
    target: GiteaTarget,
    transport: Transport,
}

impl GiteaQuarantineForge {
    /// Resolves the target from the checkout's origin remote and the
    /// environment. The project always comes from the remote; the address and
    /// token come from `DEVBOARD_GITEA_URL` and `DEVBOARD_GITEA_TOKEN` first.
    pub fn for_checkout(
        repo_dir: &Path,
        environment: &Environment,
        transport: Option<Transport>,
    ) -> std::result::Result<Self, String> {
        let remote = forge::origin_forge_with(repo_dir, environment);
        if remote.is_none() {
            return Err("the checkout's origin remote names no repository".to_string());
        }
        let target = forge::gitea_target(remote.as_ref(), None, None, None, environment)
            .map_err(|error| error.message)?;
        Ok(Self {
            target,
            transport: transport
                .unwrap_or_else(|| forge::default_transport(forge::GITEA_REQUEST_TIMEOUT_MS)),
        })
    }
}

impl QuarantineForge for GiteaQuarantineForge {
    fn list_open<'a>(&'a self) -> BoxFuture<'a, Result<Vec<OpenIssue>, String>> {
        Box::pin(async move {
            let issues = forge::gitea_list_issues(
                &self.target,
                IssueQueryState::Open,
                &self.transport,
                &GiteaCallOptions::default(),
            )
            .await
            .map_err(|error| error.message)?;
            Ok(issues
                .into_iter()
                .filter_map(|issue| {
                    u64::try_from(issue.number).ok().map(|number| OpenIssue {
                        number,
                        title: issue.title,
                    })
                })
                .collect())
        })
    }

    fn create<'a>(&'a self, title: &'a str, body: &'a str) -> BoxFuture<'a, Result<u64, String>> {
        Box::pin(async move {
            let created = forge::gitea_create_issue(
                &self.target,
                &CreateIssueInput {
                    title: title.to_string(),
                    body: body.to_string(),
                    labels: None,
                },
                &self.transport,
                &GiteaCallOptions::default(),
            )
            .await
            .map_err(|error| error.message)?;
            u64::try_from(created.number)
                .map_err(|_| "the issue has no positive number".to_string())
        })
    }

    fn comment<'a>(&'a self, number: u64, body: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let number =
                i64::try_from(number).map_err(|_| "the issue number is too large".to_string())?;
            forge::gitea_comment_issue(
                &self.target,
                number,
                body,
                &self.transport,
                &GiteaCallOptions::default(),
            )
            .await
            .map_err(|error| error.message)
        })
    }
}

/// What one run contributes to an issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarantineContext {
    /// The commit the release was cut from.
    pub commit: String,
    /// The workflow run, when the runner exposes one.
    pub run_url: Option<String>,
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_line(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic")
        .to_string()
}

/// A one-line title that contains the exact test name. The suite chain is
/// dropped before the name, and a name that cannot fit is left for the body:
/// the title never shortens the name it reports.
pub fn finding_issue_title(finding: &TestFinding) -> Option<String> {
    let prefix = match finding.classification {
        Classification::Flaky => FLAKY_TITLE_PREFIX,
        Classification::Deterministic => DETERMINISTIC_TITLE_PREFIX,
    };
    for candidate in [&finding.full_name, &finding.name] {
        let candidate = one_line(candidate);
        let title = format!("{prefix}{candidate}");
        if !candidate.is_empty() && title.chars().count() <= TITLE_LIMIT {
            return Some(title);
        }
    }
    None
}

fn attempts_section(finding: &TestFinding) -> String {
    let mut sections = vec![format!(
        "### whole-suite attempt {}\n\n{FENCE}text\n{}\n{FENCE}",
        finding.attempt.index,
        finding.attempt.output.trim()
    )];
    if let Some(retry) = finding.retry_output.as_deref() {
        sections.push(format!(
            "### isolated retry\n\n{FENCE}text\n{}\n{FENCE}",
            retry.trim()
        ));
    }
    sections.join("\n\n")
}

fn context_section(context: &QuarantineContext) -> String {
    format!(
        "- commit: `{}`\n- workflow run: {}",
        context.commit,
        context.run_url.as_deref().unwrap_or("unavailable")
    )
}

fn truncated_at_chars(text: &str, limit: usize) -> &str {
    match text.char_indices().nth(limit) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

fn bounded_body(body: String) -> String {
    if body.chars().count() <= BODY_LIMIT {
        return body;
    }
    format!("{}\n… (truncated)", truncated_at_chars(&body, BODY_LIMIT))
}

/// What the whole-suite attempt and the isolated retry together prove.
fn classification_sentence(finding: &TestFinding) -> String {
    match finding.classification {
        Classification::Flaky => {
            "failed a whole-suite attempt and passed its isolated retry, so it is \
flaky: it is skipped for the rest of that run and does not block the release."
                .to_string()
        }
        Classification::Deterministic => {
            "failed a whole-suite attempt and then failed its isolated retry, so it is \
deterministic: it blocks the release until it passes."
                .to_string()
        }
    }
}

/// The body of the issue a first finding files.
pub fn finding_issue_body(finding: &TestFinding, context: &QuarantineContext) -> String {
    let body = [
        format!(
            "The release suite's test `{}` {}",
            one_line(&finding.full_name),
            classification_sentence(finding)
        ),
        "No tracked file was rewritten: no file, commit, or tag carries the skip, and this \
issue is the durable record."
            .to_string(),
        String::new(),
        format!("- test: `{}`", one_line(&finding.full_name)),
        format!("- file: `{}`", finding.file),
        format!("- classification: `{}`", finding.classification.as_str()),
        context_section(context),
        String::new(),
        attempts_section(finding),
    ]
    .join("\n");
    bounded_body(body)
}

/// The comment a later finding appends to the existing issue.
pub fn finding_comment_body(finding: &TestFinding, context: &QuarantineContext) -> String {
    let body = [
        format!(
            "Found again: {} classified `{}` in `{}` as {}.",
            context.run_url.as_deref().unwrap_or("a release suite run"),
            one_line(&finding.full_name),
            finding.file,
            finding.classification.as_str()
        ),
        String::new(),
        context_section(context),
        String::new(),
        attempts_section(finding),
    ]
    .join("\n");
    bounded_body(body)
}

/// Whether an open issue's title already names this finding's test.
///
/// The title's prefix names the classification, so the test is the title's
/// suffix: one test keeps one issue across both classifications and across
/// runs. The skip itself is never read back from the forge.
fn issue_names_test(title: &str, finding: &TestFinding) -> bool {
    let title = forge::normalize_issue_title(title);
    let name = forge::normalize_issue_title(&one_line(&finding.full_name));
    !name.is_empty() && title.ends_with(&name)
}

/// Files one issue per finding, or appends one comment to the open issue whose
/// title already names the test. Every failure is reported on its own line and
/// swallowed: filing never changes the suite's exit code.
///
/// An unreadable open-issue list means dedupe is unavailable, so the run files
/// nothing at all: with the open issues unseen every create could duplicate a
/// test's existing issue. One line records the failure and the next
/// release-suite run files or comments once its own read succeeds.
pub async fn file_findings(
    findings: &[TestFinding],
    forge: &dyn QuarantineForge,
    context: &QuarantineContext,
    log: &(dyn Fn(&str) + Sync),
) {
    if findings.is_empty() {
        return;
    }
    let mut open: Vec<OpenIssue> = match forge.list_open().await {
        Ok(issues) => issues,
        Err(error) => {
            log(&format!(
                "filing failed: open issue list: {}",
                first_line(&error)
            ));
            return;
        }
    };
    for finding in findings {
        let Some(title) = finding_issue_title(finding) else {
            log(&format!(
                "filing failed: {} :: {}: the name does not fit a title",
                finding.file, finding.full_name
            ));
            continue;
        };
        if let Some(existing) = open
            .iter()
            .find(|issue| issue_names_test(&issue.title, finding))
        {
            let number = existing.number;
            match forge
                .comment(number, &finding_comment_body(finding, context))
                .await
            {
                Ok(()) => log(&format!("commented on issue #{number}: {title}")),
                Err(error) => log(&format!(
                    "filing failed: comment on issue #{number}: {}",
                    first_line(&error)
                )),
            }
            continue;
        }
        match forge
            .create(&title, &finding_issue_body(finding, context))
            .await
        {
            Ok(number) => {
                open.push(OpenIssue {
                    number,
                    title: title.clone(),
                });
                log(&format!("filed issue #{number}: {title}"));
            }
            Err(error) => log(&format!(
                "filing failed: create issue \"{title}\": {}",
                first_line(&error)
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// The run

/// Inputs to one release-suite run.
#[derive(Clone)]
pub struct ReleaseSuiteOptions {
    /// The workspace whose suite runs.
    pub dir: PathBuf,
    /// The checkout whose origin remote names the forge; `dir` when absent.
    pub forge_dir: Option<PathBuf>,
    pub environment: Environment,
    /// The process runner; the production runner when absent.
    pub runner: Option<Arc<dyn CommandRunner>>,
    /// The forge HTTP transport; the production transport when absent.
    pub transport: Option<Transport>,
    /// Receives each progress line; stdout when absent.
    pub log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// The most whole-suite attempts one run makes. Only an attempt that ran no
    /// test is retried whole.
    pub max_attempts: u32,
    /// Whether a run with findings files issues.
    pub file_issues: bool,
    /// Bound on one `cargo test` invocation.
    pub attempt_timeout: Duration,
}

impl ReleaseSuiteOptions {
    /// The production defaults for one suite directory.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            forge_dir: None,
            environment: forge::process_environment(),
            runner: None,
            transport: None,
            log: None,
            max_attempts: RELEASE_SUITE_MAX_ATTEMPTS,
            file_issues: true,
            attempt_timeout: Duration::from_secs(3_600),
        }
    }
}

/// What one run reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseSuiteReport {
    /// The process exit code the run asks for.
    pub code: i32,
    pub attempts: u32,
    /// Every test the whole-suite attempt failed, classified.
    pub findings: Vec<TestFinding>,
    /// Set when the run ended on a structural failure.
    pub structural: Option<String>,
    /// The first concrete error line, when the suite could not run.
    pub error_line: Option<String>,
}

/// The injected release-suite seam; `publish` substitutes its own in tests.
pub trait ReleaseSuiteGate: Send + Sync {
    fn run<'a>(&'a self, options: ReleaseSuiteOptions)
        -> BoxFuture<'a, Result<ReleaseSuiteReport>>;
}

/// The production gate: one real release-suite run.
pub struct ProcessSuiteGate;

impl ReleaseSuiteGate for ProcessSuiteGate {
    fn run<'a>(
        &'a self,
        options: ReleaseSuiteOptions,
    ) -> BoxFuture<'a, Result<ReleaseSuiteReport>> {
        Box::pin(async move { run_suite(options).await })
    }
}

/// The workflow run URL the environment exposes, if any.
pub fn workflow_run_url(environment: &Environment) -> Option<String> {
    let server = environment.get("GITHUB_SERVER_URL")?;
    let repository = environment.get("GITHUB_REPOSITORY")?;
    let run_id = environment.get("GITHUB_RUN_ID")?;
    if server.trim().is_empty() || repository.trim().is_empty() || run_id.trim().is_empty() {
        return None;
    }
    Some(format!(
        "{}/{}/actions/runs/{}",
        server.trim_end_matches('/'),
        repository.trim_matches('/'),
        run_id.trim()
    ))
}

fn commit_sha(dir: &Path) -> String {
    let outcome = forge::git(dir, &["rev-parse", "HEAD"]);
    let sha = outcome.stdout.trim().to_string();
    if outcome.code == 0 && !sha.is_empty() {
        sha
    } else {
        "unknown".to_string()
    }
}

/// Runs the release suite: one whole-suite attempt, one isolated retry per
/// failing test, and one deduplicated issue per classified test.
pub async fn run_suite(options: ReleaseSuiteOptions) -> Result<ReleaseSuiteReport> {
    let runner: Arc<dyn CommandRunner> = options
        .runner
        .clone()
        .unwrap_or_else(|| Arc::new(ProcessRunner));
    let log: Arc<dyn Fn(&str) + Send + Sync> = options.log.clone().unwrap_or_else(|| {
        Arc::new(|line: &str| {
            println!("{line}");
        })
    });
    let max_attempts = options.max_attempts.max(1);
    let forge_dir = options
        .forge_dir
        .clone()
        .unwrap_or_else(|| options.dir.clone());

    (log)(&format!(
        "release suite: one whole-suite attempt, then an isolated retry per failing test \
(up to {max_attempts} attempts when nothing ran)"
    ));
    let mut attempts = CommandAttempts {
        dir: &options.dir,
        environment: &options.environment,
        runner: runner.as_ref(),
        timeout: options.attempt_timeout,
    };
    let outcome = run_classification_suite(&mut attempts, &|line| log(line), max_attempts).await;
    // No child of this run is alive once the outcome is in, so the compiler
    // temporaries can leave with it instead of growing the build tree.
    let _ = std::fs::remove_dir_all(attempt_temp_directory(&options.dir));

    let error_line = outcome.error_line.clone();

    if outcome.structural.is_none() {
        let flaky = outcome
            .findings
            .iter()
            .filter(|finding| finding.classification == Classification::Flaky)
            .count();
        let deterministic = outcome.findings.len() - flaky;
        (log)(&format!(
            "release suite: {} attempt(s), {flaky} flaky, {deterministic} deterministic, {} fail",
            outcome.attempts,
            if outcome.code == 0 { 0 } else { deterministic },
        ));
    }
    for finding in &outcome.findings {
        (log)(&format!(
            "{}: {} :: {}",
            finding.classification.as_str(),
            finding.file,
            finding.full_name
        ));
    }

    // A finding is filed whatever the verdict: a flaky test is recorded even
    // though it does not block the release, and a deterministic one is the
    // report the operator has to read to make the release pass.
    if options.file_issues && !outcome.findings.is_empty() {
        let context = QuarantineContext {
            commit: commit_sha(&forge_dir),
            run_url: workflow_run_url(&options.environment),
        };
        match GiteaQuarantineForge::for_checkout(
            &forge_dir,
            &options.environment,
            options.transport.clone(),
        ) {
            Ok(forger) => {
                file_findings(&outcome.findings, &forger, &context, &|line| log(line)).await;
            }
            Err(error) => {
                (log)(&format!(
                    "filing failed: open issue list: {}",
                    first_line(&error)
                ));
            }
        }
    }

    if let Some(structural) = &outcome.structural {
        (log)(&format!(
            "release suite: structural failure after {} attempt(s){}",
            outcome.attempts,
            if outcome.findings.is_empty() {
                "; nothing was filed"
            } else {
                ""
            }
        ));
        (log)(structural);
        return Ok(ReleaseSuiteReport {
            code: 1,
            attempts: outcome.attempts,
            findings: outcome.findings,
            structural: outcome.structural,
            error_line,
        });
    }

    Ok(ReleaseSuiteReport {
        code: outcome.code,
        attempts: outcome.attempts,
        findings: outcome.findings,
        structural: None,
        error_line: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish::CommandOutcome;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    const SUITE_STDOUT: &str = "running 3 tests
test tests::top_passes ... ok
test tests::nested_fails ... FAILED
test tests::top_skip ... ignored

failures:

---- tests::nested_fails stdout ----

thread 'tests::nested_fails' panicked at src/lib.rs:9:25:
assertion `left == right` failed
  left: 2
 right: 3
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    tests::nested_fails

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
";

    const SUITE_STDERR: &str = "\
     Running unittests src/lib.rs (target/debug/deps/fixture-abc)
error: test failed, to rerun pass `--lib`
";

    #[test]
    fn release_suite_parses_every_case_with_its_file_state_and_output() {
        let parsed = parse_suite_output(SUITE_STDOUT, SUITE_STDERR);
        assert!(parsed.errors.is_empty(), "{:?}", parsed.errors);
        let names: Vec<&str> = parsed.cases.iter().map(|case| case.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "tests::top_passes",
                "tests::nested_fails",
                "tests::top_skip"
            ]
        );
        let states: Vec<CaseState> = parsed.cases.iter().map(|case| case.state).collect();
        assert_eq!(states, [CaseState::Pass, CaseState::Fail, CaseState::Skip]);
        assert_eq!(parsed.cases[1].file, "src/lib.rs");
        assert_eq!(parsed.cases[1].full_name, "tests::nested_fails");
        assert!(parsed.cases[1].output.contains("left: 2"));
        assert!(parsed.cases[1].output.contains('\n'));
        assert_eq!(parsed.cases[0].output, "");
    }

    #[test]
    fn release_suite_parses_integration_and_doc_targets() {
        let stdout = "running 1 test
test always_fails ... FAILED

failures:

---- always_fails stdout ----

panicked at tests/always.rs:2:1
";
        let stderr = "\
     Running tests/always.rs (target/debug/deps/always-1)
   Doc-tests fixture
";
        let parsed = parse_suite_output(stdout, stderr);
        assert_eq!(parsed.cases[0].file, "tests/always.rs");
        assert_eq!(parsed.cases[0].name, "always_fails");
        assert!(parsed.cases[0]
            .output
            .contains("panicked at tests/always.rs:2:1"));
    }

    #[test]
    fn release_suite_pairs_each_segment_with_its_target_header() {
        let stdout = "running 1 test
test tests::unit_ok ... ok

running 1 test
test src/lib.rs - doc (line 3) ... ok
";
        let stderr = "\
     Running unittests src/lib.rs (target/debug/deps/fixture-abc)
   Doc-tests fixture
";
        let parsed = parse_suite_output(stdout, stderr);
        assert_eq!(parsed.cases[0].file, "src/lib.rs");
        assert_eq!(parsed.cases[1].file, "doc-tests fixture");
        assert_eq!(parsed.cases[1].name, "src/lib.rs - doc (line 3)");
    }

    #[test]
    fn release_suite_ignores_runner_lines_inside_a_failure_block() {
        let stdout = "running 1 test
test one ... FAILED

failures:

---- one stdout ----

running 1 test
test nested ... ok


failures:
    one

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out

running 1 test
test two ... ok
";
        let stderr = "\
     Running tests/one.rs (target/debug/deps/one-1)
     Running tests/two.rs (target/debug/deps/two-2)
";
        let parsed = parse_suite_output(stdout, stderr);
        assert_eq!(parsed.cases.len(), 2, "{:?}", parsed.cases);
        assert_eq!(parsed.cases[0].file, "tests/one.rs");
        assert_eq!(parsed.cases[0].name, "one");
        assert_eq!(parsed.cases[1].file, "tests/two.rs");
        assert_eq!(parsed.cases[1].name, "two");
    }

    #[test]
    fn release_suite_parses_every_case_in_a_suite_larger_than_the_diagnostic_bound() {
        let mut stdout = String::from("running 1000 tests\n");
        for index in 0..1000 {
            stdout.push_str(&format!("test tests::case_{index:04} ... ok\n"));
        }
        let stderr = "     Running unittests src/lib.rs (target/debug/deps/fixture-abc)\n";
        assert!(stdout.len() > ATTEMPT_OUTPUT_LIMIT);
        let record = classify_attempt(1, 0, &stdout, stderr);
        assert_eq!(record.structural, None);
        assert_eq!(record.pass, 1000);
        assert_eq!(record.names.len(), 1000);
        assert!(
            record.output.len() < stdout.len(),
            "the diagnostic copy stays bounded"
        );
    }

    #[test]
    fn release_suite_classifies_a_per_test_failure_as_retryable() {
        let record = classify_attempt(1, 101, SUITE_STDOUT, SUITE_STDERR);
        assert_eq!(record.structural, None);
        assert_eq!(record.pass, 1);
        assert_eq!(record.skip, 1);
        assert_eq!(record.failures.len(), 1);
        assert_eq!(record.failures[0].full_name, "tests::nested_fails");
        assert!(record.failures[0].output.contains("left: 2"));
    }

    #[test]
    fn release_suite_classifies_a_compile_error_as_structural() {
        let stderr = "\
   Compiling fixture v0.1.0 (/tmp/fixture)
error[E0425]: cannot find value `missing` in this scope
 --> src/lib.rs:1:26
  |
1 | pub fn broken() -> i32 { missing + 1 }
  |                          ^^^^^^^ not found in this scope

error: could not compile `fixture` (lib test) due to 1 previous error
";
        let record = classify_attempt(1, 101, "", stderr);
        let structural = record.structural.expect("a structural failure");
        assert!(structural.contains("could not compile"), "{structural}");
        assert_eq!(
            first_error_line(stderr).as_deref(),
            Some("error[E0425]: cannot find value `missing` in this scope")
        );
        assert!(record.failures.is_empty());
    }

    #[test]
    fn release_suite_refuses_a_run_that_names_no_test() {
        let record = classify_attempt(1, 0, "", "     Running unittests src/lib.rs (x)\n");
        assert!(record
            .structural
            .as_deref()
            .is_some_and(|reason| reason.contains("named no test")));
        let empty = classify_attempt(1, 0, "", "");
        assert!(empty.structural.is_some());
    }

    #[test]
    fn release_suite_refuses_an_exit_code_that_contradicts_the_results() {
        let stdout = "running 1 test
test passes ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
";
        let stderr = "     Running unittests src/lib.rs (target/debug/deps/fixture-abc)\n";
        let record = classify_attempt(1, 1, stdout, stderr);
        assert!(
            record
                .structural
                .as_deref()
                .is_some_and(|reason| reason.contains("without a failing test result")),
            "{:?}",
            record.structural
        );
        let failures_but_zero = classify_attempt(1, 0, SUITE_STDOUT, SUITE_STDERR);
        assert!(failures_but_zero
            .structural
            .as_deref()
            .is_some_and(|reason| reason.contains("exited 0")));
    }

    #[test]
    fn release_suite_names_a_full_host_filesystem_instead_of_a_compile_error() {
        let stderr = "\
   Compiling fixture v0.1.0 (/repo/fixture)
error: failed to write work product index to `target/debug/incremental/issues_mode-0g8403di8ac6z/s-hnwtllhtml-05xbdro-working/work-products.bin`: No space left on device (os error 28)

error: could not compile `fixture` (test \"issues_mode\") due to 1 previous error

Caused by:
  No space left on device (os error 28)
";
        let record = classify_attempt(1, 101, "", stderr);
        let structural = record.structural.expect("a structural failure");
        assert!(
            structural.starts_with("the host filesystem is full: error: failed to write"),
            "{structural}"
        );
        assert!(!structural.contains("could not compile"), "{structural}");
        let line = record.error_line.expect("the concrete error line");
        assert!(line.contains("work-products.bin"), "{line}");
        assert!(line.contains("No space left on device"), "{line}");
        assert!(record.failures.is_empty());
    }

    /// A scratch workspace inside the harness for one unit test.
    fn scratch_workspace(label: &str) -> PathBuf {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("release-suite-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&workspace);
        std::fs::create_dir_all(&workspace).expect("a scratch workspace");
        workspace
    }

    struct StubRunner {
        outcome: CommandOutcome,
    }

    impl CommandRunner for StubRunner {
        fn run<'a>(&'a self, _invocation: CommandInvocation) -> BoxFuture<'a, CommandOutcome> {
            let outcome = self.outcome.clone();
            Box::pin(async move { outcome })
        }
    }

    struct RecordingRunner {
        outcome: CommandOutcome,
        invocations: Arc<Mutex<Vec<CommandInvocation>>>,
    }

    impl CommandRunner for RecordingRunner {
        fn run<'a>(&'a self, invocation: CommandInvocation) -> BoxFuture<'a, CommandOutcome> {
            self.invocations
                .lock()
                .expect("recorded invocations")
                .push(invocation);
            let outcome = self.outcome.clone();
            Box::pin(async move { outcome })
        }
    }

    #[tokio::test]
    async fn release_suite_builds_with_its_temporaries_inside_the_workspace() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("release-suite-temp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&workspace);
        std::fs::create_dir_all(&workspace).expect("a scratch workspace");
        let invocations: Arc<Mutex<Vec<CommandInvocation>>> = Arc::new(Mutex::new(Vec::new()));
        let mut options = ReleaseSuiteOptions::new(workspace.clone());
        options.runner = Some(Arc::new(RecordingRunner {
            outcome: CommandOutcome {
                code: 0,
                stdout: "running 1 test\ntest passes ... ok\n".to_string(),
                stderr: "     Running unittests src/lib.rs (target/debug/deps/fixture-abc)\n"
                    .to_string(),
            },
            invocations: invocations.clone(),
        }));
        options.file_issues = false;
        let report = run_suite(options).await.expect("a suite report");
        assert_eq!(report.code, 0);
        let temp = attempt_temp_directory(&workspace);
        assert!(temp.starts_with(&workspace), "{}", temp.display());
        let recorded = invocations.lock().expect("recorded invocations").clone();
        assert!(!recorded.is_empty());
        for invocation in &recorded {
            assert_eq!(invocation.cwd, workspace);
            for key in ["TMPDIR", "TMP", "TEMP"] {
                assert_eq!(
                    invocation.env.get(key).map(String::as_str),
                    Some(temp.to_string_lossy().as_ref()),
                    "{key}"
                );
            }
        }
        assert!(!temp.exists(), "the run removes its temporary directory");
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[tokio::test]
    async fn release_suite_hands_an_absolute_tmpdir_from_a_relative_directory() {
        // `cargo test` runs with the package root as its working directory, so
        // `../..` is the harness workspace a `--repo .` publish hands in
        // relatively.
        let workspace = Path::new("../..")
            .join(".test-tmp")
            .join(format!("release-suite-relative-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&workspace);
        std::fs::create_dir_all(&workspace).expect("a scratch workspace");
        let invocations: Arc<Mutex<Vec<CommandInvocation>>> = Arc::new(Mutex::new(Vec::new()));
        let mut options = ReleaseSuiteOptions::new(workspace.clone());
        options.runner = Some(Arc::new(RecordingRunner {
            outcome: CommandOutcome {
                code: 0,
                stdout: "running 1 test\ntest passes ... ok\n".to_string(),
                stderr: "     Running unittests src/lib.rs (target/debug/deps/fixture-abc)\n"
                    .to_string(),
            },
            invocations: invocations.clone(),
        }));
        options.file_issues = false;
        let report = run_suite(options).await.expect("a suite report");
        assert_eq!(report.code, 0);
        let expected = std::path::absolute(&workspace).expect("an absolute workspace");
        let temp = attempt_temp_directory(&workspace);
        assert!(temp.is_absolute(), "{}", temp.display());
        assert!(temp.starts_with(&expected), "{}", temp.display());
        let recorded = invocations.lock().expect("recorded invocations").clone();
        assert!(!recorded.is_empty());
        for invocation in &recorded {
            for key in ["TMPDIR", "TMP", "TEMP"] {
                let value = invocation.env.get(key).expect(key);
                assert!(Path::new(value).is_absolute(), "{key}={value}");
                assert_eq!(value, temp.to_string_lossy().as_ref(), "{key}");
            }
        }
        assert!(!temp.exists(), "the run removes its temporary directory");
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[tokio::test]
    async fn release_suite_reports_a_full_disk_as_the_host_condition() {
        let stderr = "\
error: failed to write work product index to `target/debug/incremental/issues_mode-0123/s-abc-working/work-products.bin`: No space left on device (os error 28)

error: could not compile `fixture` (test \"issues_mode\") due to 1 previous error
";
        let workspace = scratch_workspace("full-disk");
        let mut options = ReleaseSuiteOptions::new(workspace.clone());
        options.runner = Some(Arc::new(StubRunner {
            outcome: CommandOutcome {
                code: 101,
                stdout: String::new(),
                stderr: stderr.to_string(),
            },
        }));
        options.file_issues = false;
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = lines.clone();
        options.log = Some(Arc::new(move |line: &str| {
            captured.lock().expect("log lines").push(line.to_string());
        }));
        let report = run_suite(options).await.expect("a suite report");
        assert_eq!(report.code, 1);
        assert_eq!(report.attempts, 1);
        let structural = report.structural.expect("a structural failure");
        assert!(
            structural.starts_with("the host filesystem is full: error: failed to write"),
            "{structural}"
        );
        assert!(!structural.contains("could not compile"), "{structural}");
        let reason = report.error_line.expect("the refusal reason");
        assert_eq!(reason, structural);
        let lines = lines.lock().expect("log lines").clone();
        assert!(
            lines.iter().any(|line| line
                == "release suite: structural failure after 1 attempt(s); nothing was filed"),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("the host filesystem is full")),
            "{lines:?}"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[tokio::test]
    async fn release_suite_retries_an_unexecuted_binary_before_it_refuses() {
        let stderr = "\
     Running tests/extension_commands.rs (target/debug/deps/extension_commands-dd68)
error: test failed, to rerun pass `-p devboard --test extension_commands`

Caused by:
  could not execute process `/repo/.devboard/target/debug/deps/extension_commands-dd68` (never executed)

Caused by:
  Permission denied (os error 13)
";
        let workspace = scratch_workspace("unexecuted");
        let mut options = ReleaseSuiteOptions::new(workspace.clone());
        options.runner = Some(Arc::new(StubRunner {
            outcome: CommandOutcome {
                code: 101,
                stdout: String::new(),
                stderr: stderr.to_string(),
            },
        }));
        options.max_attempts = 2;
        options.file_issues = false;
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = lines.clone();
        options.log = Some(Arc::new(move |line: &str| {
            captured.lock().expect("log lines").push(line.to_string());
        }));
        let report = run_suite(options).await.expect("a suite report");
        assert_eq!(report.code, 1);
        assert_eq!(report.attempts, 2);
        let reason = report.error_line.expect("the refusal reason");
        assert!(
            reason.ends_with("Permission denied (os error 13)"),
            "{reason}"
        );
        assert_eq!(report.structural.as_deref(), Some(reason.as_str()));
        let lines = lines.lock().expect("log lines").clone();
        assert!(
            lines
                .iter()
                .any(|line| line.starts_with("attempt 1/2: nothing ran, retrying:")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|line| line
                == "release suite: structural failure after 2 attempt(s); nothing was filed"),
            "{lines:?}"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    struct FakeAttempts {
        records: VecDeque<AttemptRecord>,
        skipped: Arc<Mutex<Vec<String>>>,
        seen_filters: Arc<Mutex<Vec<Option<Vec<String>>>>>,
    }

    impl SuiteAttempts for FakeAttempts {
        fn attempt<'a>(
            &'a mut self,
            _index: u32,
            names: Option<&'a [String]>,
        ) -> BoxFuture<'a, AttemptRecord> {
            self.seen_filters
                .lock()
                .expect("filters")
                .push(names.map(|names| names.to_vec()));
            let next = self.records.pop_front().expect("a scripted attempt");
            let skipped = self.skipped.clone();
            for failure in &next.failures {
                skipped
                    .lock()
                    .expect("skipped")
                    .push(failure.full_name.clone());
            }
            Box::pin(async move { next })
        }
    }

    fn failure(name: &str) -> AttemptFailure {
        AttemptFailure {
            file: "src/lib.rs".to_string(),
            name: name.to_string(),
            full_name: name.to_string(),
            output: format!("{name} failed"),
        }
    }

    fn failing(index: u32, names: &[&str]) -> AttemptRecord {
        AttemptRecord {
            index,
            code: 101,
            pass: 0,
            skip: 0,
            failures: names.iter().map(|name| failure(name)).collect(),
            names: names.iter().map(|name| (*name).to_string()).collect(),
            structural: None,
            transient: None,
            error_line: None,
            output: String::new(),
        }
    }

    /// One name failing while the rest of its universe keeps running.
    fn failing_among(index: u32, name: &str, names: &[&str]) -> AttemptRecord {
        let mut record = failing(index, names);
        record.failures = vec![failure(name)];
        record
    }

    fn clean(index: u32, names: &[&str]) -> AttemptRecord {
        AttemptRecord {
            index,
            code: 0,
            pass: names.len(),
            skip: 0,
            failures: Vec::new(),
            names: names.iter().map(|name| (*name).to_string()).collect(),
            structural: None,
            transient: None,
            error_line: None,
            output: String::new(),
        }
    }

    /// What a concurrent build in the same target directory leaves behind: a
    /// binary that exists but whose executable bit is not set yet.
    const UNEXECUTED: &str = "the runner could not execute a freshly built test binary: \
could not execute process `/repo/.devboard/target/debug/deps/extension_commands-dd68` (never executed): \
Permission denied (os error 13)";

    fn unexecuted(index: u32) -> AttemptRecord {
        AttemptRecord {
            index,
            code: 101,
            pass: 0,
            skip: 0,
            failures: Vec::new(),
            names: Vec::new(),
            structural: None,
            transient: Some(UNEXECUTED.to_string()),
            error_line: Some(UNEXECUTED.to_string()),
            output: String::new(),
        }
    }

    /// What a retained target tree that lost a unit's fingerprint directory
    /// under a running build leaves behind.
    const VANISHED_TREE: &str = "the target directory left while the suite built: \
error: could not parse/generate dep info at: \
/repo/.devboard/target/debug/build/zerocopy-0b98911506e12cd7/build_script_build-0b98911506e12cd7.d";

    fn vanished(index: u32) -> AttemptRecord {
        AttemptRecord {
            index,
            code: 101,
            pass: 0,
            skip: 0,
            failures: Vec::new(),
            names: Vec::new(),
            structural: None,
            transient: Some(VANISHED_TREE.to_string()),
            error_line: Some(VANISHED_TREE.to_string()),
            output: String::new(),
        }
    }

    async fn drive(records: Vec<AttemptRecord>, max_attempts: u32) -> SuiteOutcome {
        let mut attempts = FakeAttempts {
            records: records.into(),
            skipped: Arc::new(Mutex::new(Vec::new())),
            seen_filters: Arc::new(Mutex::new(Vec::new())),
        };
        run_classification_suite(&mut attempts, &|_line| {}, max_attempts).await
    }

    fn classification(outcome: &SuiteOutcome, name: &str) -> Classification {
        outcome
            .findings
            .iter()
            .find(|finding| finding.full_name == name)
            .unwrap_or_else(|| panic!("no finding names {name}: {outcome:?}"))
            .classification
    }

    #[test]
    fn release_suite_round_trips_the_attempt_line_it_writes() {
        let line = attempt_line(2, 9, 3, 100, 4);
        assert_eq!(line, "attempt 2/9: 3 fail, 100 pass, 4 skip");
        assert_eq!(
            parse_attempt_line(&line),
            Some(SuiteAttempt {
                attempt: 2,
                passed: 100,
                failed: 3,
            })
        );
        // The other attempt shapes carry no passed and failed counts, and a
        // changed separator is not an attempt record either.
        assert_eq!(
            parse_attempt_line("attempt 2/9: nothing ran, retrying: a vanished target tree"),
            None
        );
        assert_eq!(
            parse_attempt_line("attempt 2/9: structural failure: could not compile"),
            None
        );
        assert_eq!(
            parse_attempt_line("attempt 2/9 | 3 fail | 100 pass | 4 skip"),
            None
        );
    }

    #[tokio::test]
    async fn release_suite_classifies_a_flaky_test_and_passes_the_run() {
        let mut attempts = FakeAttempts {
            records: vec![
                failing_among(1, "flaky", &["flaky", "keeps"]),
                clean(2, &["flaky"]),
            ]
            .into(),
            skipped: Arc::new(Mutex::new(Vec::new())),
            seen_filters: Arc::new(Mutex::new(Vec::new())),
        };
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = lines.clone();
        let sink = move |line: &str| captured.lock().expect("log lines").push(line.to_string());
        let outcome =
            run_classification_suite(&mut attempts, &sink, RELEASE_SUITE_MAX_ATTEMPTS).await;

        assert_eq!(outcome.code, 0, "a flaky test does not block the run");
        assert_eq!(outcome.attempts, 1, "one whole-suite attempt");
        assert_eq!(classification(&outcome, "flaky"), Classification::Flaky);
        assert_eq!(outcome.findings.len(), 1);
        let filters = attempts.seen_filters.lock().expect("filters").clone();
        assert_eq!(filters[0], None, "the whole suite runs once");
        assert_eq!(
            filters[1],
            Some(vec!["flaky".to_string()]),
            "the failing test is retried alone"
        );
        let recorded = lines.lock().expect("log lines").clone();
        assert!(
            recorded
                .iter()
                .any(|line| line == "flaky: src/lib.rs :: flaky"),
            "{recorded:?}"
        );
        assert!(
            recorded
                .iter()
                .any(|line| line == "skipped for the rest of this run: flaky"),
            "{recorded:?}"
        );
    }

    #[tokio::test]
    async fn release_suite_blocks_a_deterministic_test() {
        let outcome = drive(
            vec![failing(1, &["broken"]), failing(2, &["broken"])],
            RELEASE_SUITE_MAX_ATTEMPTS,
        )
        .await;
        assert_eq!(outcome.code, 1, "a deterministic test blocks the release");
        assert_eq!(outcome.attempts, 1);
        assert_eq!(
            classification(&outcome, "broken"),
            Classification::Deterministic
        );
        assert_eq!(outcome.findings.len(), 1);
    }

    #[tokio::test]
    async fn release_suite_classifies_every_failing_test_in_the_attempt() {
        let outcome = drive(
            vec![
                failing(1, &["one", "two"]),
                clean(2, &["one"]),
                failing(3, &["two"]),
            ],
            RELEASE_SUITE_MAX_ATTEMPTS,
        )
        .await;
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.attempts, 1);
        assert_eq!(classification(&outcome, "one"), Classification::Flaky);
        assert_eq!(
            classification(&outcome, "two"),
            Classification::Deterministic
        );
    }

    #[tokio::test]
    async fn release_suite_never_starts_a_second_whole_suite_attempt() {
        let mut attempts = FakeAttempts {
            records: vec![failing(1, &["one"]), clean(2, &["one"])].into(),
            skipped: Arc::new(Mutex::new(Vec::new())),
            seen_filters: Arc::new(Mutex::new(Vec::new())),
        };
        let outcome =
            run_classification_suite(&mut attempts, &|_line| {}, RELEASE_SUITE_MAX_ATTEMPTS).await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.attempts, 1);
        let filters = attempts.seen_filters.lock().expect("filters").clone();
        assert_eq!(
            filters,
            [None, Some(vec!["one".to_string()])],
            "only the isolated retry follows the whole-suite attempt"
        );
    }

    #[tokio::test]
    async fn release_suite_retries_an_isolated_retry_that_ran_nothing() {
        let outcome = drive(
            vec![failing(1, &["one"]), unexecuted(2), clean(3, &["one"])],
            RELEASE_SUITE_MAX_ATTEMPTS,
        )
        .await;
        assert_eq!(outcome.code, 0);
        assert_eq!(classification(&outcome, "one"), Classification::Flaky);
        assert_eq!(outcome.findings.len(), 1);
    }

    #[tokio::test]
    async fn release_suite_ends_a_structural_failure_before_any_retry() {
        let mut broken = failing(1, &[]);
        broken.code = 101;
        broken.structural = Some("the suite could not compile: error[E0425]".to_string());
        let outcome = drive(vec![broken], RELEASE_SUITE_MAX_ATTEMPTS).await;
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.attempts, 1);
        assert!(outcome.findings.is_empty());
        assert!(outcome.structural.is_some());
    }

    #[tokio::test]
    async fn release_suite_retries_an_unexecuted_whole_attempt() {
        let outcome = drive(vec![unexecuted(1), clean(2, &["passes"])], 9).await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.attempts, 2);
        assert!(outcome.findings.is_empty());
        assert_eq!(outcome.structural, None);
    }

    #[test]
    fn release_suite_classifies_an_unexecuted_binary_as_retryable() {
        let stderr = "\
     Running tests/extension_commands.rs (target/debug/deps/extension_commands-dd68)
error: test failed, to rerun pass `-p devboard --test extension_commands`

Caused by:
  could not execute process `/repo/.devboard/target/debug/deps/extension_commands-dd68` (never executed)

Caused by:
  Permission denied (os error 13)
     Running tests/forge.rs (target/debug/deps/forge-4cd4)
error: test failed, to rerun pass `-p devboard --test forge`

Caused by:
  could not execute process `/repo/.devboard/target/debug/deps/forge-4cd4` (never executed)

Caused by:
  Permission denied (os error 13)
error: 2 targets failed:
    `-p devboard --test extension_commands`
    `-p devboard --test forge`
";
        let record = classify_attempt(1, 101, "", stderr);
        let transient = record.transient.expect("a retryable execution failure");
        assert!(
            transient.starts_with(
                "the runner could not execute a freshly built test binary: \
could not execute process"
            ),
            "{transient}"
        );
        assert!(transient.contains("extension_commands-dd68"), "{transient}");
        assert!(
            transient.ends_with("Permission denied (os error 13)"),
            "{transient}"
        );
        assert_eq!(record.structural, None);
        assert_eq!(record.error_line.as_deref(), Some(transient.as_str()));
        assert!(record.failures.is_empty());
    }

    #[tokio::test]
    async fn release_suite_reports_an_unexecuted_binary_once_the_budget_is_spent() {
        let outcome = drive(vec![unexecuted(1), unexecuted(2)], 2).await;
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.attempts, 2);
        assert_eq!(outcome.structural.as_deref(), Some(UNEXECUTED));
        assert_eq!(outcome.error_line.as_deref(), Some(UNEXECUTED));
    }

    #[test]
    fn release_suite_classifies_a_vanished_target_tree_as_retryable() {
        let stderr = "\
error: could not parse/generate dep info at: /repo/.devboard/target/debug/build/zerocopy-0b98911506e12cd7/build_script_build-0b98911506e12cd7.d

Caused by:
  failed to write `/repo/.devboard/target/debug/.fingerprint/zerocopy-0b98911506e12cd7/dep-build-script-build-script-build`

Caused by:
  No such file or directory (os error 2)
warning: build failed, waiting for other jobs to finish...
";
        let record = classify_attempt(1, 101, "", stderr);
        let transient = record.transient.expect("a retryable tree loss");
        assert!(
            transient.starts_with(
                "the target directory left while the suite built: \
error: could not parse/generate dep info at:"
            ),
            "{transient}"
        );
        assert!(
            transient.ends_with("build_script_build-0b98911506e12cd7.d"),
            "{transient}"
        );
        assert_eq!(record.structural, None);
        assert_eq!(record.error_line.as_deref(), Some(transient.as_str()));
        assert!(record.failures.is_empty());
    }

    #[test]
    fn release_suite_keeps_a_full_filesystem_structural() {
        let stderr = "\
error: could not parse/generate dep info at: /repo/.devboard/target/debug/deps/ryu-88888919f90a49ef.d

Caused by:
  failed to write `/repo/.devboard/target/debug/.fingerprint/ryu-88888919f90a49ef/dep-lib-ryu`

Caused by:
  No space left on device (os error 28)
";
        let record = classify_attempt(1, 101, "", stderr);
        assert_eq!(record.transient, None);
        let structural = record.structural.expect("a structural failure");
        assert!(
            structural.starts_with("the host filesystem is full:"),
            "{structural}"
        );
    }

    #[tokio::test]
    async fn release_suite_retries_a_vanished_target_tree_and_then_passes() {
        let outcome = drive(vec![vanished(1), clean(2, &["passes"])], 9).await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.attempts, 2);
        assert!(outcome.findings.is_empty());
        assert_eq!(outcome.structural, None);
    }

    #[tokio::test]
    async fn release_suite_reports_a_vanished_target_tree_once_the_budget_is_spent() {
        let outcome = drive(vec![vanished(1), vanished(2)], 2).await;
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.attempts, 2);
        assert_eq!(outcome.structural.as_deref(), Some(VANISHED_TREE));
        assert_eq!(outcome.error_line.as_deref(), Some(VANISHED_TREE));
    }

    struct StubForge {
        open: Mutex<Vec<OpenIssue>>,
        created: Mutex<Vec<(String, String)>>,
        comments: Mutex<Vec<(u64, String)>>,
        list_fails: bool,
        create_fails: bool,
    }

    impl StubForge {
        fn new() -> Self {
            Self {
                open: Mutex::new(Vec::new()),
                created: Mutex::new(Vec::new()),
                comments: Mutex::new(Vec::new()),
                list_fails: false,
                create_fails: false,
            }
        }
    }

    impl QuarantineForge for StubForge {
        fn list_open<'a>(&'a self) -> BoxFuture<'a, Result<Vec<OpenIssue>, String>> {
            let fails = self.list_fails;
            let open = self.open.lock().expect("open").clone();
            Box::pin(async move {
                if fails {
                    Err("the forge is unreachable".to_string())
                } else {
                    Ok(open)
                }
            })
        }

        fn create<'a>(
            &'a self,
            title: &'a str,
            body: &'a str,
        ) -> BoxFuture<'a, Result<u64, String>> {
            let fails = self.create_fails;
            if fails {
                return Box::pin(async move { Err("the forge refused".to_string()) });
            }
            let number = {
                let mut open = self.open.lock().expect("open");
                let number = open.len() as u64 + 1;
                open.push(OpenIssue {
                    number,
                    title: title.to_string(),
                });
                number
            };
            self.created
                .lock()
                .expect("created")
                .push((title.to_string(), body.to_string()));
            Box::pin(async move { Ok(number) })
        }

        fn comment<'a>(&'a self, number: u64, body: &'a str) -> BoxFuture<'a, Result<(), String>> {
            self.comments
                .lock()
                .expect("comments")
                .push((number, body.to_string()));
            Box::pin(async move { Ok(()) })
        }
    }

    fn finding(name: &str, classification: Classification) -> TestFinding {
        TestFinding {
            file: "tests/always.rs".to_string(),
            name: name.to_string(),
            full_name: name.to_string(),
            classification,
            attempt: AttemptLine {
                index: 1,
                output: "attempt one\nsecond line".to_string(),
            },
            retry_output: Some("retried alone".to_string()),
        }
    }

    fn context() -> QuarantineContext {
        QuarantineContext {
            commit: "a".repeat(40),
            run_url: Some("http://forge.test/acme/name/actions/runs/77".to_string()),
        }
    }

    #[tokio::test]
    async fn release_suite_files_one_deduplicated_issue_per_finding() {
        let forge = StubForge::new();
        let lines = Mutex::new(Vec::new());
        let findings = vec![finding(
            "always fails: integration fixture",
            Classification::Flaky,
        )];
        file_findings(&findings, &forge, &context(), &|line| {
            lines.lock().expect("lines").push(line.to_string())
        })
        .await;
        let created = forge.created.lock().expect("created").clone();
        assert_eq!(created.len(), 1);
        assert!(created[0]
            .0
            .starts_with("flaky(test): always fails: integration fixture"));
        assert!(created[0].1.contains("tests/always.rs"));
        assert!(created[0].1.contains("always fails: integration fixture"));
        assert!(created[0].1.contains("passed its isolated retry"));
        assert!(created[0]
            .1
            .contains("http://forge.test/acme/name/actions/runs/77"));
        assert_eq!(created[0].1.matches("### whole-suite attempt").count(), 1);
        assert_eq!(created[0].1.matches("### isolated retry").count(), 1);

        file_findings(&findings, &forge, &context(), &|_line| {}).await;
        assert_eq!(forge.created.lock().expect("created").len(), 1);
        let comments = forge.comments.lock().expect("comments").clone();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].0, 1);
        assert!(comments[0].1.contains("Found again"));
    }

    #[tokio::test]
    async fn release_suite_files_nothing_when_the_open_issue_read_fails() {
        let mut forge = StubForge::new();
        forge.list_fails = true;
        let lines = Mutex::new(Vec::new());
        file_findings(
            &[finding("flaky", Classification::Flaky)],
            &forge,
            &context(),
            &|line| lines.lock().expect("lines").push(line.to_string()),
        )
        .await;
        assert!(forge.created.lock().expect("created").is_empty());
        let lines = lines.lock().expect("lines").clone();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("filing failed: open issue list:"));
    }

    #[tokio::test]
    async fn release_suite_comments_on_the_open_issue_naming_the_test() {
        let forge = StubForge::new();
        forge.open.lock().expect("open").push(OpenIssue {
            number: 7,
            title: "flaky(test): flaky".to_string(),
        });
        file_findings(
            &[finding("flaky", Classification::Deterministic)],
            &forge,
            &context(),
            &|_line| {},
        )
        .await;
        assert!(
            forge.created.lock().expect("created").is_empty(),
            "one test keeps one issue across classifications"
        );
        let comments = forge.comments.lock().expect("comments").clone();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].0, 7);
    }

    #[tokio::test]
    async fn release_suite_swallows_filing_failures() {
        let mut forge = StubForge::new();
        forge.create_fails = true;
        let lines = Mutex::new(Vec::new());
        file_findings(
            &[finding("flaky", Classification::Flaky)],
            &forge,
            &context(),
            &|line| lines.lock().expect("lines").push(line.to_string()),
        )
        .await;
        let lines = lines.lock().expect("lines").clone();
        assert!(lines.iter().any(|line| line.starts_with("filing failed")));
        assert!(lines.iter().all(|line| !line.contains("panicked")));
    }

    #[test]
    fn release_suite_keeps_the_exact_test_name_in_the_title() {
        let title =
            finding_issue_title(&finding("a very flaky test", Classification::Deterministic))
                .expect("a title");
        assert_eq!(title, "deterministic(test): a very flaky test");
        assert!(title.chars().count() <= TITLE_LIMIT);
        let long = finding(&"n".repeat(TITLE_LIMIT + 1), Classification::Flaky);
        assert_eq!(finding_issue_title(&long), None);
    }

    #[test]
    fn release_suite_builds_the_workflow_run_url_from_the_environment() {
        let environment = forge::environment(&[
            ("GITHUB_SERVER_URL", "http://forge.test/"),
            ("GITHUB_REPOSITORY", "acme/name"),
            ("GITHUB_RUN_ID", "77"),
        ]);
        assert_eq!(
            workflow_run_url(&environment).as_deref(),
            Some("http://forge.test/acme/name/actions/runs/77")
        );
        assert_eq!(workflow_run_url(&forge::environment(&[])), None);
    }

    #[test]
    fn release_suite_output_bounding_stays_on_char_boundaries() {
        let text = "é".repeat(10);
        let bounded = bound(&text, 3);
        assert!(bounded.starts_with("é"));
        assert!(bounded.contains("more bytes"));
    }
}
