//! The release suite: retry, quarantine, and the durable record.
//!
//! The release workflow cannot publish while one flaky test fails, so its
//! suite step retries the whole suite and stops at the first attempt that
//! reports no failing test. A test that fails on three consecutive attempts is
//! skipped for the rest of the run: the next attempt runs only the remaining
//! test names through libtest's `--exact` filter. No tracked file is rewritten,
//! so the checkout, `main`, and `git status --porcelain` are byte-identical
//! before and after the run.
//!
//! Only a per-test failure is retried or quarantined. A failure of the suite
//! itself — a file that does not compile, a runner that crashes, output that
//! names no test — is structural, and no skip can address it: it ends the run
//! with a nonzero code, prints the first concrete error line, and files
//! nothing. A build that could not write its artifacts because the host
//! filesystem is full is structural too, and its reason names that host
//! condition instead of claiming a compile error: no repository change frees
//! the disk.
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
//! a test, so nothing about it is quarantined; the run retries the whole suite
//! and reports the condition, with the file or directory and the errno, only
//! once the attempt budget is spent.
//!
//! Every skipped test files one deduplicated issue in the origin forge.
//! Filing is best effort: an unreachable forge prints one failure line and
//! never changes the run's exit code. The dedupe key is the test's title, so a
//! run whose open-issue read fails files nothing: the next run comments on or
//! creates the single issue once its own read succeeds.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use crate::forge::{
    self, CreateIssueInput, Environment, GiteaCallOptions, GiteaTarget, IssueQueryState, Transport,
};
use crate::publish::{CommandInvocation, CommandRunner, ProcessRunner};

/// One boxed, sendable future, the form every injected seam returns.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The most whole-suite attempts one run makes.
pub const RELEASE_SUITE_MAX_ATTEMPTS: u32 = 9;
/// How many consecutive failed attempts quarantine one test.
pub const RELEASE_SUITE_CONSECUTIVE_FAILURES: u32 = 3;
/// The reason an attempt set that quarantined every test reports: the run
/// proved nothing, so it fails rather than passing with zero executed tests.
pub const EVERY_TEST_QUARANTINED: &str = "every test was quarantined; nothing ran";
/// The longest suffix of one failed attempt kept for diagnostics.
pub const ATTEMPT_OUTPUT_LIMIT: usize = 20_000;
/// The longest failure text kept for one quarantined test.
pub const FAILURE_OUTPUT_LIMIT: usize = 4_000;
/// The longest issue title the forge accepts.
pub const TITLE_LIMIT: usize = 200;
/// The longest issue body this run files.
pub const BODY_LIMIT: usize = 60_000;
/// The prefix every quarantine issue title carries.
pub const TITLE_PREFIX: &str = "quarantine(test): ";
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
// The retry loop

/// A test quarantined in this run, with every failed attempt's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarantineReport {
    pub file: String,
    pub name: String,
    pub full_name: String,
    pub attempts: Vec<AttemptLine>,
}

/// One failed attempt's contribution to a quarantine report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptLine {
    pub index: u32,
    pub output: String,
}

/// What one quarantine run decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuiteOutcome {
    pub code: i32,
    pub attempts: u32,
    pub quarantined: Vec<QuarantineReport>,
    /// Set when the run ended on a structural failure.
    pub structural: Option<String>,
    /// The first concrete failure the structural reason names.
    pub error_line: Option<String>,
}

/// One whole-suite attempt, injectable so the loop is testable.
pub trait SuiteAttempts: Send {
    /// Runs attempt `index`, filtered to `names` after a quarantine.
    fn attempt<'a>(
        &'a mut self,
        index: u32,
        names: Option<&'a [String]>,
    ) -> BoxFuture<'a, AttemptRecord>;
}

fn failure_key(failure: &AttemptFailure) -> String {
    format!("{}\u{0}{}", failure.file, failure.full_name)
}

/// Drives the retry loop: stop at the first attempt with no failing test,
/// quarantine a test on its third consecutive failure, never quarantine a test
/// that passed in between, and give up after `max_attempts` whole-suite
/// attempts. A structural failure ends the run immediately; an attempt whose
/// test binary the kernel refused to start is retried whole, because another
/// build was still writing that binary. A run that quarantined every name in
/// the universe is a failure, not a pass: its next attempt would execute no
/// test, so it reports `EVERY_TEST_QUARANTINED` and a nonzero code.
pub async fn run_quarantine_suite(
    attempts: &mut dyn SuiteAttempts,
    log: &(dyn Fn(&str) + Sync),
    max_attempts: u32,
    consecutive_failures: u32,
) -> SuiteOutcome {
    let mut consecutive: BTreeMap<String, (AttemptFailure, Vec<AttemptLine>)> = BTreeMap::new();
    let mut quarantined: BTreeMap<String, QuarantineReport> = BTreeMap::new();
    let mut universe: Vec<String> = Vec::new();
    let mut attempt_count = 0;
    let mut unexecuted: Option<(String, Option<String>)> = None;

    for index in 1..=max_attempts {
        let allowed: Option<Vec<String>> = if quarantined.is_empty() {
            None
        } else {
            Some(
                universe
                    .iter()
                    .filter(|name| !quarantined.values().any(|report| &report.name == *name))
                    .cloned()
                    .collect(),
            )
        };
        if let Some(names) = &allowed {
            if names.is_empty() {
                attempt_count = index;
                log(&format!(
                    "attempt {index}/{max_attempts}: 0 fail, 0 pass, {} skip",
                    quarantined.len()
                ));
                let reason = EVERY_TEST_QUARANTINED.to_string();
                log("release suite: every test was quarantined; nothing left to run");
                return SuiteOutcome {
                    code: 1,
                    attempts: attempt_count,
                    quarantined: quarantined.into_values().collect(),
                    structural: Some(reason.clone()),
                    error_line: Some(reason),
                };
            }
        }
        let record = attempts.attempt(index, allowed.as_deref()).await;
        attempt_count = index;
        if let Some(transient) = &record.transient {
            log(&format!(
                "attempt {index}/{max_attempts}: nothing ran, retrying: {transient}"
            ));
            unexecuted = Some((transient.clone(), record.error_line.clone()));
            continue;
        }
        unexecuted = None;
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
                quarantined: quarantined.into_values().collect(),
                structural: Some(structural.clone()),
                error_line: record.error_line.clone(),
            };
        }
        if universe.is_empty() {
            universe = record.names.clone();
        }
        let failed_keys: HashSet<String> = record.failures.iter().map(failure_key).collect();
        consecutive.retain(|key, _| failed_keys.contains(key));
        for failure in &record.failures {
            let key = failure_key(failure);
            if quarantined.contains_key(&key) {
                continue;
            }
            let entry = consecutive
                .entry(key)
                .or_insert_with(|| (failure.clone(), Vec::new()));
            entry.0 = failure.clone();
            entry.1.push(AttemptLine {
                index,
                output: failure.output.clone(),
            });
        }
        log(&format!(
            "attempt {index}/{max_attempts}: {} fail, {} pass, {} skip",
            record.failures.len(),
            record.pass,
            record.skip
        ));
        if record.failures.is_empty() {
            return SuiteOutcome {
                code: 0,
                attempts: attempt_count,
                quarantined: quarantined.into_values().collect(),
                structural: None,
                error_line: None,
            };
        }
        let reached: Vec<(String, AttemptFailure, Vec<AttemptLine>)> = consecutive
            .iter()
            .filter(|(_, (_, lines))| lines.len() as u32 >= consecutive_failures)
            .map(|(key, (failure, lines))| (key.clone(), failure.clone(), lines.clone()))
            .collect();
        for (key, failure, lines) in reached {
            log(&format!(
                "quarantined: {} :: {}",
                failure.file, failure.full_name
            ));
            quarantined.insert(
                key.clone(),
                QuarantineReport {
                    file: failure.file.clone(),
                    name: failure.name.clone(),
                    full_name: failure.full_name.clone(),
                    attempts: lines,
                },
            );
            consecutive.remove(&key);
        }
    }

    if let Some((transient, error_line)) = unexecuted {
        return SuiteOutcome {
            code: 1,
            attempts: attempt_count,
            quarantined: quarantined.into_values().collect(),
            structural: Some(transient),
            error_line,
        };
    }
    SuiteOutcome {
        code: 1,
        attempts: attempt_count,
        quarantined: quarantined.into_values().collect(),
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
        let invocation = CommandInvocation {
            program: "cargo".to_string(),
            args,
            cwd: self.dir.to_path_buf(),
            env: environment,
            timeout: self.timeout,
        };
        let runner = self.runner;
        Box::pin(async move {
            let outcome = runner.run(invocation).await;
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
pub fn quarantine_issue_title(report: &QuarantineReport) -> Option<String> {
    for candidate in [&report.full_name, &report.name] {
        let candidate = one_line(candidate);
        let title = format!("{TITLE_PREFIX}{candidate}");
        if !candidate.is_empty() && title.chars().count() <= TITLE_LIMIT {
            return Some(title);
        }
    }
    None
}

fn attempts_section(report: &QuarantineReport) -> String {
    report
        .attempts
        .iter()
        .map(|attempt| {
            format!(
                "### attempt {}\n\n{FENCE}text\n{}\n{FENCE}",
                attempt.index,
                attempt.output.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
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

/// The body of the issue a first quarantine files.
pub fn quarantine_issue_body(report: &QuarantineReport, context: &QuarantineContext) -> String {
    let body = [
        format!(
            "The release suite's test `{}` failed three consecutive attempts,",
            one_line(&report.full_name)
        ),
        "so it was skipped for the rest of that run. No tracked file was rewritten:".to_string(),
        "no file, commit, or tag carries the skip, and this issue is the durable record."
            .to_string(),
        String::new(),
        format!("- test: `{}`", one_line(&report.full_name)),
        format!("- file: `{}`", report.file),
        context_section(context),
        String::new(),
        attempts_section(report),
    ]
    .join("\n");
    bounded_body(body)
}

/// The comment a later quarantine appends to the existing issue.
pub fn quarantine_comment_body(report: &QuarantineReport, context: &QuarantineContext) -> String {
    let body = [
        format!(
            "Quarantined again: {} skipped `{}` in `{}`.",
            context.run_url.as_deref().unwrap_or("a release suite run"),
            one_line(&report.full_name),
            report.file
        ),
        String::new(),
        context_section(context),
        String::new(),
        attempts_section(report),
    ]
    .join("\n");
    bounded_body(body)
}

/// Files one issue per report, or appends one comment to the open issue whose
/// title already names the test. Every failure is reported on its own line and
/// swallowed: filing never changes the suite's exit code.
///
/// An unreadable open-issue list means dedupe is unavailable, so the run files
/// nothing at all: with the open issues unseen every create could duplicate a
/// test's existing issue. One line records the failure and the next
/// release-suite run files or comments once its own read succeeds.
pub async fn file_quarantine_reports(
    reports: &[QuarantineReport],
    forge: &dyn QuarantineForge,
    context: &QuarantineContext,
    log: &(dyn Fn(&str) + Sync),
) {
    if reports.is_empty() {
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
    for report in reports {
        let Some(title) = quarantine_issue_title(report) else {
            log(&format!(
                "filing failed: {} :: {}: the name does not fit a title",
                report.file, report.full_name
            ));
            continue;
        };
        let name_key = forge::normalize_issue_title(&one_line(&report.name));
        if let Some(existing) = open
            .iter()
            .find(|issue| forge::normalize_issue_title(&issue.title).contains(&name_key))
        {
            let number = existing.number;
            match forge
                .comment(number, &quarantine_comment_body(report, context))
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
            .create(&title, &quarantine_issue_body(report, context))
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
    pub max_attempts: u32,
    pub consecutive_failures: u32,
    /// Whether a quarantining run files issues.
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
            consecutive_failures: RELEASE_SUITE_CONSECUTIVE_FAILURES,
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
    pub quarantined: Vec<QuarantineReport>,
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

/// Runs the release suite: up to `max_attempts` whole-suite attempts, a
/// quarantine after `consecutive_failures` consecutive failures, and one
/// deduplicated issue per skipped test.
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
        "release suite: up to {max_attempts} whole-suite attempts"
    ));
    let mut attempts = CommandAttempts {
        dir: &options.dir,
        environment: &options.environment,
        runner: runner.as_ref(),
        timeout: options.attempt_timeout,
    };
    let outcome = run_quarantine_suite(
        &mut attempts,
        &|line| log(line),
        max_attempts,
        options.consecutive_failures.max(1),
    )
    .await;
    // No child of this run is alive once the outcome is in, so the compiler
    // temporaries can leave with it instead of growing the build tree.
    let _ = std::fs::remove_dir_all(attempt_temp_directory(&options.dir));

    let error_line = outcome.error_line.clone();

    if outcome.structural.is_none() {
        if outcome.code == 0 {
            (log)(&format!(
                "release suite: {} attempt(s), {} quarantined, 0 fail",
                outcome.attempts,
                outcome.quarantined.len()
            ));
        } else {
            (log)(&format!(
                "release suite: {} attempt(s) still reported failures",
                outcome.attempts
            ));
        }
    }
    for report in &outcome.quarantined {
        (log)(&format!("skipped: {} :: {}", report.file, report.full_name));
    }

    // A report is filed whatever the verdict: the run that quarantined every
    // test fails on exactly the reports an operator has to read.
    if options.file_issues && !outcome.quarantined.is_empty() {
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
                file_quarantine_reports(&outcome.quarantined, &forger, &context, &|line| log(line))
                    .await;
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
            if outcome.quarantined.is_empty() {
                "; nothing was filed"
            } else {
                ""
            }
        ));
        (log)(structural);
        return Ok(ReleaseSuiteReport {
            code: 1,
            attempts: outcome.attempts,
            quarantined: outcome.quarantined,
            structural: outcome.structural,
            error_line,
        });
    }

    Ok(ReleaseSuiteReport {
        code: outcome.code,
        attempts: outcome.attempts,
        quarantined: outcome.quarantined,
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
        let mut options = ReleaseSuiteOptions::new(env!("CARGO_MANIFEST_DIR"));
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
        let mut options = ReleaseSuiteOptions::new(env!("CARGO_MANIFEST_DIR"));
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
        run_quarantine_suite(
            &mut attempts,
            &|_line| {},
            max_attempts,
            RELEASE_SUITE_CONSECUTIVE_FAILURES,
        )
        .await
    }

    #[tokio::test]
    async fn release_suite_skips_only_after_three_consecutive_failures() {
        let outcome = drive(
            vec![
                failing_among(1, "flaky", &["flaky", "keeps"]),
                failing_among(2, "flaky", &["flaky", "keeps"]),
                failing_among(3, "flaky", &["flaky", "keeps"]),
                clean(4, &["keeps"]),
            ],
            RELEASE_SUITE_MAX_ATTEMPTS,
        )
        .await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.attempts, 4);
        assert_eq!(outcome.quarantined.len(), 1);
        assert_eq!(
            outcome.quarantined[0]
                .attempts
                .iter()
                .map(|attempt| attempt.index)
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
    }

    #[tokio::test]
    async fn release_suite_never_skips_a_test_that_passed_in_between() {
        let outcome = drive(
            vec![
                failing(1, &["intermittent"]),
                failing(2, &["intermittent"]),
                clean(3, &["intermittent"]),
            ],
            5,
        )
        .await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.attempts, 3);
        assert!(outcome.quarantined.is_empty());
    }

    #[tokio::test]
    async fn release_suite_resets_a_streak_when_another_test_still_fails() {
        let outcome = drive(
            vec![
                failing(1, &["streak", "persistent"]),
                failing(2, &["streak", "persistent"]),
                failing(3, &["persistent"]),
                clean(4, &["streak"]),
            ],
            RELEASE_SUITE_MAX_ATTEMPTS,
        )
        .await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.quarantined.len(), 1);
        assert_eq!(outcome.quarantined[0].full_name, "persistent");
    }

    #[tokio::test]
    async fn release_suite_ends_a_structural_failure_before_any_skip() {
        let mut broken = failing(1, &[]);
        broken.code = 101;
        broken.structural = Some("the suite could not compile: error[E0425]".to_string());
        let outcome = drive(vec![broken], RELEASE_SUITE_MAX_ATTEMPTS).await;
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.attempts, 1);
        assert!(outcome.quarantined.is_empty());
        assert!(outcome.structural.is_some());
    }

    #[tokio::test]
    async fn release_suite_stops_after_nine_failing_attempts() {
        let records = (1..=9)
            .map(|index| failing(index, &[&format!("distinct-{index}")]))
            .collect();
        let outcome = drive(records, RELEASE_SUITE_MAX_ATTEMPTS).await;
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.attempts, 9);
    }

    #[tokio::test]
    async fn release_suite_filters_quarantined_names_out_of_later_attempts() {
        fn two_failures(index: u32, names: &[&str]) -> AttemptRecord {
            AttemptRecord {
                index,
                code: 101,
                pass: 1,
                skip: 0,
                failures: vec![failure("one"), failure("two")],
                names: names.iter().map(|name| (*name).to_string()).collect(),
                structural: None,
                transient: None,
                error_line: None,
                output: String::new(),
            }
        }
        let mut attempts = FakeAttempts {
            records: vec![
                two_failures(1, &["one", "two", "keeps"]),
                two_failures(2, &["one", "two", "keeps"]),
                two_failures(3, &["one", "two", "keeps"]),
                clean(4, &["keeps"]),
            ]
            .into(),
            skipped: Arc::new(Mutex::new(Vec::new())),
            seen_filters: Arc::new(Mutex::new(Vec::new())),
        };
        let outcome = run_quarantine_suite(
            &mut attempts,
            &|_line| {},
            RELEASE_SUITE_MAX_ATTEMPTS,
            RELEASE_SUITE_CONSECUTIVE_FAILURES,
        )
        .await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.attempts, 4);
        assert_eq!(outcome.quarantined.len(), 2);
        let filters = attempts.seen_filters.lock().expect("filters").clone();
        assert_eq!(filters[0], None);
        assert_eq!(filters[1], None);
        assert_eq!(filters[2], None);
        assert_eq!(filters[3], Some(vec!["keeps".to_string()]));
    }

    #[tokio::test]
    async fn release_suite_fails_when_every_test_was_quarantined() {
        let mut attempts = FakeAttempts {
            records: vec![
                failing(1, &["only"]),
                failing(2, &["only"]),
                failing(3, &["only"]),
            ]
            .into(),
            skipped: Arc::new(Mutex::new(Vec::new())),
            seen_filters: Arc::new(Mutex::new(Vec::new())),
        };
        let outcome = run_quarantine_suite(
            &mut attempts,
            &|_line| {},
            RELEASE_SUITE_MAX_ATTEMPTS,
            RELEASE_SUITE_CONSECUTIVE_FAILURES,
        )
        .await;
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.structural.as_deref(), Some(EVERY_TEST_QUARANTINED));
        assert_eq!(outcome.error_line.as_deref(), Some(EVERY_TEST_QUARANTINED));
        assert_eq!(outcome.attempts, 4);
        assert_eq!(outcome.quarantined.len(), 1);
        assert_eq!(outcome.quarantined[0].full_name, "only");
        assert_eq!(
            attempts.seen_filters.lock().expect("filters").len(),
            3,
            "the empty remaining set needs no fourth process"
        );

        // The same loop still passes when only some tests are quarantined and
        // the remaining ones run green.
        let mut partial = FakeAttempts {
            records: vec![
                failing_among(1, "broken", &["broken", "keeps"]),
                failing_among(2, "broken", &["broken", "keeps"]),
                failing_among(3, "broken", &["broken", "keeps"]),
                clean(4, &["keeps"]),
            ]
            .into(),
            skipped: Arc::new(Mutex::new(Vec::new())),
            seen_filters: Arc::new(Mutex::new(Vec::new())),
        };
        let outcome = run_quarantine_suite(
            &mut partial,
            &|_line| {},
            RELEASE_SUITE_MAX_ATTEMPTS,
            RELEASE_SUITE_CONSECUTIVE_FAILURES,
        )
        .await;
        assert_eq!(outcome.code, 0, "{outcome:?}");
        assert_eq!(outcome.structural, None);
        assert_eq!(outcome.quarantined.len(), 1);
        assert_eq!(outcome.quarantined[0].full_name, "broken");
        assert_eq!(
            partial
                .seen_filters
                .lock()
                .expect("filters")
                .last()
                .cloned(),
            Some(Some(vec!["keeps".to_string()]))
        );
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
    async fn release_suite_retries_an_unexecuted_attempt_and_then_passes() {
        let outcome = drive(vec![unexecuted(1), clean(2, &["passes"])], 9).await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.attempts, 2);
        assert!(outcome.quarantined.is_empty());
        assert_eq!(outcome.structural, None);
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
        assert!(outcome.quarantined.is_empty());
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

    #[tokio::test]
    async fn release_suite_keeps_a_streak_across_an_unexecuted_attempt() {
        let outcome = drive(
            vec![
                failing_among(1, "flaky", &["flaky", "keeps"]),
                unexecuted(2),
                failing_among(3, "flaky", &["flaky", "keeps"]),
                failing_among(4, "flaky", &["flaky", "keeps"]),
                clean(5, &["keeps"]),
            ],
            RELEASE_SUITE_MAX_ATTEMPTS,
        )
        .await;
        assert_eq!(outcome.code, 0);
        assert_eq!(outcome.quarantined.len(), 1);
        assert_eq!(
            outcome.quarantined[0]
                .attempts
                .iter()
                .map(|attempt| attempt.index)
                .collect::<Vec<_>>(),
            [1, 3, 4]
        );
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

    fn report(name: &str) -> QuarantineReport {
        QuarantineReport {
            file: "tests/always.rs".to_string(),
            name: name.to_string(),
            full_name: name.to_string(),
            attempts: vec![
                AttemptLine {
                    index: 1,
                    output: "attempt one\nsecond line".to_string(),
                },
                AttemptLine {
                    index: 2,
                    output: "attempt two".to_string(),
                },
                AttemptLine {
                    index: 3,
                    output: "attempt three".to_string(),
                },
            ],
        }
    }

    fn context() -> QuarantineContext {
        QuarantineContext {
            commit: "a".repeat(40),
            run_url: Some("http://forge.test/acme/name/actions/runs/77".to_string()),
        }
    }

    #[tokio::test]
    async fn release_suite_files_one_deduplicated_issue_per_skipped_test() {
        let forge = StubForge::new();
        let lines = Mutex::new(Vec::new());
        let reports = vec![report("always fails: integration fixture")];
        file_quarantine_reports(&reports, &forge, &context(), &|line| {
            lines.lock().expect("lines").push(line.to_string())
        })
        .await;
        let created = forge.created.lock().expect("created").clone();
        assert_eq!(created.len(), 1);
        assert!(created[0]
            .0
            .starts_with("quarantine(test): always fails: integration fixture"));
        assert!(created[0].1.contains("tests/always.rs"));
        assert!(created[0].1.contains("always fails: integration fixture"));
        assert!(created[0]
            .1
            .contains("http://forge.test/acme/name/actions/runs/77"));
        assert_eq!(created[0].1.matches("### attempt").count(), 3);

        file_quarantine_reports(&reports, &forge, &context(), &|_line| {}).await;
        assert_eq!(forge.created.lock().expect("created").len(), 1);
        let comments = forge.comments.lock().expect("comments").clone();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].0, 1);
        assert!(comments[0].1.contains("Quarantined again"));
    }

    #[tokio::test]
    async fn release_suite_files_nothing_when_the_open_issue_read_fails() {
        let mut forge = StubForge::new();
        forge.list_fails = true;
        let lines = Mutex::new(Vec::new());
        file_quarantine_reports(&[report("flaky")], &forge, &context(), &|line| {
            lines.lock().expect("lines").push(line.to_string())
        })
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
            title: "quarantine(test): flaky".to_string(),
        });
        file_quarantine_reports(&[report("flaky")], &forge, &context(), &|_line| {}).await;
        assert!(forge.created.lock().expect("created").is_empty());
        let comments = forge.comments.lock().expect("comments").clone();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].0, 7);
    }

    #[tokio::test]
    async fn release_suite_swallows_filing_failures() {
        let mut forge = StubForge::new();
        forge.create_fails = true;
        let lines = Mutex::new(Vec::new());
        file_quarantine_reports(&[report("flaky")], &forge, &context(), &|line| {
            lines.lock().expect("lines").push(line.to_string())
        })
        .await;
        let lines = lines.lock().expect("lines").clone();
        assert!(lines.iter().any(|line| line.starts_with("filing failed")));
        assert!(lines.iter().all(|line| !line.contains("panicked")));
    }

    #[test]
    fn release_suite_keeps_the_exact_test_name_in_the_title() {
        let title = quarantine_issue_title(&report("a very flaky test")).expect("a title");
        assert_eq!(title, "quarantine(test): a very flaky test");
        assert!(title.chars().count() <= TITLE_LIMIT);
        let long = report(&"n".repeat(TITLE_LIMIT + 1));
        assert_eq!(quarantine_issue_title(&long), None);
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
