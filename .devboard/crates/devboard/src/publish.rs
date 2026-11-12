//! The one release path: derive a version from Conventional Commits, bump the
//! workspace version, tag and push the released commit, dispatch the cargo-dist
//! workflow on GitHub, prove the platform archives and installers, publish the
//! Gitea release manifest and checksums, and write one source-refresh request
//! into every live source dashboard's state directory.
//!
//! Every external effect is injectable. Git commands run through
//! [`CommandRunner`], HTTP requests through [`HttpTransport`], and every wait
//! through [`Clock`] and [`Sleeper`], so the whole path is exercised against
//! local bare repositories and stub servers without a network, a real tag, or a
//! real push.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::forge;
pub use crate::forge::Environment;
use crate::gitea::{self, GiteaTarget};
use crate::jsjson;
use crate::release::{configured_project, MANIFEST_ASSET, RELEASE_REPOSITORY};
use crate::release_suite;

/// The workflow cargo-dist generates for the GitHub release host.
pub const RELEASE_WORKFLOW: &str = "release.yml";
/// The Gitea workflow whose success gates the release tag.
pub const CI_WORKFLOW: &str = "devboard-ci.yml";
/// The GitHub workflow that builds the artifacts from the canonical source.
pub const BUILD_WORKFLOW: &str = "devboard-build.yml";
/// Git's empty-tree object identifier, the tree the release tag names.
pub const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// The temporary GitHub branch one release's build is dispatched from.
pub fn build_ref(tag: &str) -> String {
    format!("refs/heads/devboard-build/{tag}")
}
/// The manifest checksum asset the release carries beside the manifest.
pub const MANIFEST_CHECKSUM_ASSET: &str = "devboard-manifest.json.sha256";
/// The lock path variable shared by concurrent release jobs.
pub const RELEASE_LOCK_VARIABLE: &str = "DEVBOARD_RELEASE_LOCK";
/// How long a release waits for the shared lock.
pub const RELEASE_LOCK_WAIT_MS: i64 = 10 * 60 * 1_000;
/// The default bound for the workflow and propagation wait.
pub const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(1_800);
/// The interval between workflow reads.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(5);
/// The interval between lock attempts.
pub const DEFAULT_LOCK_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// How often one idempotent Gitea read is attempted while the forge answers a
/// transient refusal, such as a busy database.
const GITEA_READ_ATTEMPTS: usize = 6;
/// How often one Gitea write is attempted while the forge answers a transient
/// refusal. The write is proven applied by a read-back before it is resent, so
/// the budget never creates a second release or asset.
const GITEA_WRITE_ATTEMPTS: usize = 6;
/// The delay between those attempts.
const GITEA_RETRY_DELAY: Duration = Duration::from_secs(5);
/// The six targets `.devboard/dist-workspace.toml` asks cargo-dist to build.
pub const RELEASE_TARGETS: [&str; 6] = [
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "aarch64-unknown-linux-musl",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "x86_64-unknown-linux-musl",
];
/// The installers cargo-dist generates.
pub const RELEASE_INSTALLERS: [&str; 1] = ["devboard-installer.sh"];
/// The directory source-refresh documents live under.
pub const SOURCE_REFRESH_DIRECTORY: &str = "source-refresh";
/// The request a publish writes.
pub const SOURCE_REFRESH_REQUEST_FILE: &str = "request.json";
/// The marker a dashboard writes after it applied a request.
pub const SOURCE_REFRESH_APPLIED_FILE: &str = "applied.json";
/// The request schema this module writes and reads.
pub const SOURCE_REFRESH_SCHEMA: u64 = 1;
/// Conventional Commit types, matching the push gate.
pub const CONVENTIONAL_TYPES: [&str; 11] = [
    "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
];
/// The first release of a line.
pub const BASELINE_VERSION: &str = "1.0.0";

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ---------------------------------------------------------------------------
// Injected process commands

/// One external command invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandInvocation {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub timeout: Duration,
}

/// One command's captured outcome.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs one external command; tests replace this with a recorder.
pub trait CommandRunner: Send + Sync {
    fn run<'a>(&'a self, invocation: CommandInvocation) -> BoxFuture<'a, CommandOutcome>;
}

/// The production runner: a bounded child with captured streams.
pub struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn run<'a>(&'a self, invocation: CommandInvocation) -> BoxFuture<'a, CommandOutcome> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&invocation.program);
            command
                .args(&invocation.args)
                .current_dir(&invocation.cwd)
                .envs(&invocation.env)
                .env("NO_COLOR", "1")
                .env("FORCE_COLOR", "0")
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GH_PROMPT_DISABLED", "1")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            let child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    return CommandOutcome {
                        code: -1,
                        stdout: String::new(),
                        stderr: error.to_string(),
                    }
                }
            };
            match tokio::time::timeout(invocation.timeout, child.wait_with_output()).await {
                Ok(Ok(output)) => CommandOutcome {
                    code: output.status.code().unwrap_or(-1),
                    stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                },
                Ok(Err(error)) => CommandOutcome {
                    code: -1,
                    stdout: String::new(),
                    stderr: error.to_string(),
                },
                Err(_) => CommandOutcome {
                    code: -1,
                    stdout: String::new(),
                    stderr: format!(
                        "{} timed out after {}ms",
                        invocation.program,
                        invocation.timeout.as_millis()
                    ),
                },
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Injected HTTP transport

/// One HTTP request the release path makes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// One HTTP response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Result<Value> {
        serde_json::from_slice(&self.body)
            .with_context(|| format!("the response is not JSON: {}", first_line(&self.text())))
    }
}

/// Sends one HTTP request; tests replace this with an in-memory server.
pub trait HttpTransport: Send + Sync {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, String>>;
}

/// The production transport.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { client }
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for ReqwestTransport {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, String>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| error.to_string())?;
            let mut builder = self.client.request(method, &request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if !request.body.is_empty() {
                builder = builder.body(request.body.clone());
            }
            let response = builder.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .await
                .map_err(|error| error.to_string())?
                .to_vec();
            Ok(HttpResponse { status, body })
        })
    }
}

// ---------------------------------------------------------------------------
// Injected time

/// Wall-clock milliseconds since the Unix epoch.
pub trait Clock: Send + Sync {
    fn now_millis(&self) -> i64;
}

/// The production clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_millis(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// Suspends one wait; tests advance a fake clock instead of sleeping.
pub trait Sleeper: Send + Sync {
    fn sleep<'a>(&'a self, duration: Duration) -> BoxFuture<'a, ()>;
}

/// The production sleeper.
pub struct TokioSleeper;

impl Sleeper for TokioSleeper {
    fn sleep<'a>(&'a self, duration: Duration) -> BoxFuture<'a, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}

/// Formats one epoch instant exactly as `Date.prototype.toISOString` does.
pub fn iso_from_millis(millis: i64) -> String {
    const FORMAT: &[time::format_description::FormatItem<'static>] = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    match time::OffsetDateTime::from_unix_timestamp_nanos(millis as i128 * 1_000_000) {
        Ok(moment) => moment.format(FORMAT).unwrap_or_else(|_| millis.to_string()),
        Err(_) => millis.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Release version derivation

/// The bump one commit contributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseLevel {
    Major,
    Minor,
    Patch,
}

impl ReleaseLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Major => "major",
            Self::Minor => "minor",
            Self::Patch => "patch",
        }
    }
}

/// One commit as `git log` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRecord {
    pub sha: String,
    pub subject: String,
    pub body: String,
    pub parents: Vec<String>,
}

/// One release tag reachable from the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseTag {
    pub tag: String,
    pub version: String,
}

/// The parsed parts of a Conventional Commit subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSubject {
    pub kind: String,
    pub scope: Option<String>,
    pub breaking: bool,
    pub description: String,
}

/// The version one range releases.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseDerivation {
    pub version: String,
    pub previous: Option<ReleaseTag>,
    pub level: Option<ReleaseLevel>,
    pub range: String,
    pub commits: Vec<CommitRecord>,
}

static SUBJECT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z]+)(?:\(([^)]*)\))?(!)?: (.*)$").expect("the subject grammar")
});
static RELEASE_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^v(\d+\.\d+\.\d+)$").expect("the release tag grammar"));
static BREAKING_FOOTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^BREAKING[ -]CHANGE:").expect("the breaking footer"));

/// The parsed parts of a subject, or `None` when it has no Conventional shape.
pub fn parse_subject(subject: &str) -> Option<ParsedSubject> {
    let captures = SUBJECT.captures(subject)?;
    Some(ParsedSubject {
        kind: captures.get(1)?.as_str().to_string(),
        scope: captures.get(2).map(|value| value.as_str().to_string()),
        breaking: captures.get(3).is_some(),
        description: captures
            .get(4)
            .map(|value| value.as_str().to_string())
            .unwrap_or_default(),
    })
}

/// The rule a subject breaks, or `None` when it conforms.
pub fn subject_rule(subject: &str) -> Option<String> {
    if subject.trim().is_empty() {
        return Some("the subject is empty".to_string());
    }
    let Some(parsed) = parse_subject(subject) else {
        return Some("the subject is not `<type>[(<scope>)][!]: <description>`".to_string());
    };
    if parsed.kind != parsed.kind.to_ascii_lowercase() {
        return Some(format!("the type \"{}\" must be lowercase", parsed.kind));
    }
    if !CONVENTIONAL_TYPES.contains(&parsed.kind.as_str()) {
        return Some(format!(
            "the type \"{}\" is not one of {}",
            parsed.kind,
            CONVENTIONAL_TYPES.join(", ")
        ));
    }
    if let Some(scope) = &parsed.scope {
        let valid = !scope.is_empty()
            && scope.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            });
        if !valid {
            return Some(format!("the scope \"{scope}\" must match [a-z0-9._-]+"));
        }
    }
    if parsed.description.is_empty() || parsed.description != parsed.description.trim() {
        return Some(
            "the description must be non-empty with no leading or trailing whitespace".to_string(),
        );
    }
    None
}

/// True for a merge commit: two parents, or Git's generated merge subject.
pub fn is_merge_commit(commit: &CommitRecord) -> bool {
    commit.parents.len() >= 2 || commit.subject.starts_with("Merge ")
}

/// The bump one non-merge commit contributes.
pub fn commit_level(commit: &CommitRecord) -> Option<ReleaseLevel> {
    if is_merge_commit(commit) {
        return None;
    }
    let parsing = parse_subject(&commit.subject);
    if parsing.as_ref().is_some_and(|parsed| parsed.breaking)
        || BREAKING_FOOTER.is_match(&commit.body)
    {
        return Some(ReleaseLevel::Major);
    }
    if parsing.as_ref().is_some_and(|parsed| parsed.kind == "feat") {
        return Some(ReleaseLevel::Minor);
    }
    Some(ReleaseLevel::Patch)
}

/// The highest bump among the commits; `None` when no non-merge commit exists.
pub fn release_level(commits: &[CommitRecord]) -> Option<ReleaseLevel> {
    let mut level: Option<ReleaseLevel> = None;
    for commit in commits {
        match commit_level(commit) {
            Some(ReleaseLevel::Major) => return Some(ReleaseLevel::Major),
            Some(ReleaseLevel::Minor) => level = Some(ReleaseLevel::Minor),
            Some(ReleaseLevel::Patch) => {
                if level.is_none() {
                    level = Some(ReleaseLevel::Patch);
                }
            }
            None => {}
        }
    }
    level
}

/// Orders two dotted numeric versions; `None` when either is unreadable.
pub fn compare_versions(left: &str, right: &str) -> Option<i32> {
    fn parse(version: &str) -> Option<[u64; 3]> {
        let parts: Vec<&str> = version.split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        let mut parsed = [0u64; 3];
        for (index, part) in parts.iter().enumerate() {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            parsed[index] = part.parse().ok()?;
        }
        Some(parsed)
    }
    let first = parse(left)?;
    let second = parse(right)?;
    for index in 0..3 {
        if first[index] != second[index] {
            return Some(if first[index] > second[index] { 1 } else { -1 });
        }
    }
    Some(0)
}

/// The highest valid release version among the candidates.
pub fn highest_version<'a>(versions: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut highest: Option<String> = None;
    for version in versions {
        if compare_versions(version, version).is_none() {
            continue;
        }
        let replace = highest
            .as_deref()
            .and_then(|current| compare_versions(version, current))
            .map(|order| order > 0)
            .unwrap_or(true);
        if replace {
            highest = Some(version.to_string());
        }
    }
    highest
}

/// The next release: the 1.0.0 baseline first, then the bump.
pub fn next_release_version(previous: Option<&str>, level: Option<ReleaseLevel>) -> String {
    let Some(previous) = previous else {
        return BASELINE_VERSION.to_string();
    };
    if compare_versions(previous, BASELINE_VERSION).is_none() {
        return BASELINE_VERSION.to_string();
    }
    if compare_versions(previous, BASELINE_VERSION) == Some(-1) {
        return BASELINE_VERSION.to_string();
    }
    let Some(level) = level else {
        return previous.to_string();
    };
    let parts: Vec<u64> = previous
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    let major = parts.first().copied().unwrap_or(0);
    let minor = parts.get(1).copied().unwrap_or(0);
    let patch = parts.get(2).copied().unwrap_or(0);
    match level {
        ReleaseLevel::Major => format!("{}.0.0", major + 1),
        ReleaseLevel::Minor => format!("{major}.{}.0", minor + 1),
        ReleaseLevel::Patch => format!("{major}.{minor}.{}", patch + 1),
    }
}

fn valid_version(value: &str) -> bool {
    compare_versions(value, value).is_some()
}

// ---------------------------------------------------------------------------
// Public argument and report types

/// One live dashboard that may receive a source-refresh request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardInstance {
    pub pid: u32,
    pub port: u16,
    pub repo_dir: PathBuf,
    /// The harness directory that serves this dashboard.
    pub harness: PathBuf,
    /// The dashboard's own state directory.
    pub state_dir: PathBuf,
}

/// One source-refresh request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRefreshRequest {
    pub schema: u64,
    pub commit: String,
    pub version: String,
    pub dist_digest: String,
    pub requested_at: String,
}

impl SourceRefreshRequest {
    pub fn to_json(&self) -> Value {
        json!({
            "schema": self.schema,
            "commit": self.commit,
            "version": self.version,
            "distDigest": self.dist_digest,
            "requestedAt": self.requested_at,
        })
    }

    /// The exact bytes written to `request.json`.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut text = jsjson::stringify(&self.to_json());
        text.push('\n');
        text.into_bytes()
    }
}

/// One dashboard that received a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshTarget {
    pub state_dir: PathBuf,
    pub pid: u32,
    pub port: u16,
}

/// One dashboard whose request could not be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshFailure {
    pub state_dir: PathBuf,
    pub pid: u32,
    pub port: u16,
    pub error: String,
}

/// One dashboard that serves this checkout's repository through another
/// harness, so a request written for the checkout's own harness would never
/// reach it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshSkip {
    pub harness: PathBuf,
    pub pid: u32,
    pub port: u16,
}

/// What one source-refresh delivery did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRefreshReport {
    pub request: SourceRefreshRequest,
    pub written: Vec<RefreshTarget>,
    /// Dashboards whose `applied.json` already named this commit.
    pub applied: Vec<RefreshTarget>,
    pub failed: Vec<RefreshFailure>,
    /// Dashboards on this repository that another harness serves.
    pub skipped: Vec<RefreshSkip>,
}

/// Inputs to one source-refresh delivery.
#[derive(Debug, Clone)]
pub struct SourceRefreshOptions {
    pub repo_root: PathBuf,
    /// The checkout's serving harness, `<repo_root>/.devboard`.
    pub harness_root: PathBuf,
    pub commit: String,
    pub version: String,
    /// The built bundle whose digest authorizes the refresh.
    pub dist_dir: PathBuf,
    pub instances: Vec<DashboardInstance>,
    pub requested_at: String,
}

/// Inputs to one release.
#[derive(Clone)]
pub struct PublishArgs {
    /// The integration checkout the release is cut from.
    pub repo_dir: PathBuf,
    /// That checkout's harness tree, `<repo_dir>/.devboard`.
    pub harness_root: PathBuf,
    pub environment: Environment,
    /// Bounds the workflow and asset-propagation wait.
    pub wait_timeout: Duration,
    pub poll_interval: Duration,
    pub lock_poll_interval: Duration,
    /// The process runner; the production runner when absent.
    pub runner: Option<Arc<dyn CommandRunner>>,
    /// The HTTP transport; the production transport when absent.
    pub transport: Option<Arc<dyn HttpTransport>>,
    pub clock: Option<Arc<dyn Clock>>,
    pub sleeper: Option<Arc<dyn Sleeper>>,
    /// Every dashboard to consider; discovered from `/proc` when absent.
    pub instances: Option<Vec<DashboardInstance>>,
    /// The workspace whose release suite must pass before tagging; `None`
    /// skips the gate.
    pub release_suite_dir: Option<PathBuf>,
    /// The release-suite gate; the production gate when absent.
    pub release_suite: Option<Arc<dyn release_suite::ReleaseSuiteGate>>,
    /// Receives each progress line; stderr when absent.
    pub log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

impl PublishArgs {
    /// The production defaults for one checkout, read from this process's
    /// environment.
    pub fn new(repo_dir: impl Into<PathBuf>) -> Self {
        let repo_dir = repo_dir.into();
        let harness_root = repo_dir.join(".devboard");
        let release_suite_dir = Some(harness_root.clone());
        Self {
            repo_dir,
            harness_root,
            environment: forge::process_environment(),
            wait_timeout: DEFAULT_WAIT_TIMEOUT,
            poll_interval: DEFAULT_POLL_INTERVAL,
            lock_poll_interval: DEFAULT_LOCK_POLL_INTERVAL,
            runner: None,
            transport: None,
            clock: None,
            sleeper: None,
            instances: None,
            release_suite_dir,
            release_suite: None,
            log: None,
        }
    }
}

/// What one release did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishReport {
    pub version: String,
    pub tag: String,
    /// The released commit, after the version bump.
    pub commit: String,
    /// False when a tag for the derived version already covered the commit.
    pub published: bool,
    pub workflow_run: Option<u64>,
    pub github_assets: Vec<String>,
    /// The exact `devboard-manifest.json` bytes the Gitea release carries.
    pub manifest: String,
    pub source_refresh: SourceRefreshReport,
    /// One row per live dashboard, for the CLI inventory.
    pub dashboards: Vec<DashboardInventory>,
}

/// One live dashboard as the publish inventory prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardInventory {
    pub host: PathBuf,
    pub port: u16,
    pub pid: u32,
    pub running: Option<String>,
    pub installed: Option<String>,
    pub stale: bool,
}

/// Builds the inventory rows for the live dashboards.
pub fn dashboard_inventory(instances: &[DashboardInstance]) -> Vec<DashboardInventory> {
    instances
        .iter()
        .map(|instance| {
            let host = instance.repo_dir.clone();
            let installed = crate::release::installed_version(&host.join(".devboard"))
                .or_else(|| crate::version::read_harness_version(&host.join(".devboard")));
            let running = std::fs::read_to_string(instance.state_dir.join("version.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| {
                    value
                        .get("running")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            let stale = match (&running, &installed) {
                (Some(running), Some(installed)) => running != installed,
                _ => false,
            };
            DashboardInventory {
                host,
                port: instance.port,
                pid: instance.pid,
                running,
                installed,
                stale,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Git access

struct Git<'a> {
    runner: &'a dyn CommandRunner,
    repo_dir: &'a Path,
    environment: &'a Environment,
}

impl<'a> Git<'a> {
    fn new(
        runner: &'a dyn CommandRunner,
        repo_dir: &'a Path,
        environment: &'a Environment,
    ) -> Self {
        Self {
            runner,
            repo_dir,
            environment,
        }
    }

    async fn run(&self, args: &[&str]) -> CommandOutcome {
        // One absolute root for both `-C` and the working directory: a relative
        // root applied to both would be resolved twice, once per nested
        // directory, and `publish --repo .` names the checkout root relatively.
        let root = absolute_path(self.repo_dir);
        let mut argv = Vec::with_capacity(args.len() + 2);
        argv.push("-C".to_string());
        argv.push(root.to_string_lossy().into_owned());
        argv.extend(args.iter().map(|arg| (*arg).to_string()));
        self.runner
            .run(CommandInvocation {
                program: "git".to_string(),
                args: argv,
                cwd: root,
                env: self.environment.clone(),
                timeout: Duration::from_secs(600),
            })
            .await
    }

    async fn must(&self, args: &[&str], description: &str) -> Result<String> {
        let result = self.run(args).await;
        if result.code != 0 {
            bail!(
                "{}: {}",
                description,
                first_line(if result.stderr.is_empty() {
                    result.stdout.as_str()
                } else {
                    result.stderr.as_str()
                })
            );
        }
        Ok(result.stdout)
    }

    async fn ok(&self, args: &[&str]) -> bool {
        self.run(args).await.code == 0
    }

    async fn tag_commit(&self, tag: &str) -> Option<String> {
        let reference = format!("refs/tags/{tag}^{{commit}}");
        let result = self
            .run(&["rev-parse", "--verify", "--quiet", &reference])
            .await;
        if result.code != 0 {
            return None;
        }
        let sha = result.stdout.split_whitespace().next().unwrap_or("");
        (!sha.is_empty()).then(|| sha.to_string())
    }

    async fn resolve(&self, reference: &str) -> Option<String> {
        let expression = format!("{reference}^{{commit}}");
        let result = self
            .run(&["rev-parse", "--verify", "--quiet", &expression])
            .await;
        if result.code != 0 {
            return None;
        }
        let sha = result.stdout.split_whitespace().next().unwrap_or("");
        (!sha.is_empty()).then(|| sha.to_string())
    }

    async fn is_ancestor(&self, ancestor: &str, descendant: &str) -> bool {
        self.ok(&["merge-base", "--is-ancestor", ancestor, descendant])
            .await
    }

    async fn commit_names_or_contains(&self, commit: &str, head: &str) -> bool {
        let Some(target) = self.resolve(head).await else {
            return false;
        };
        if target == commit {
            return true;
        }
        if !self
            .ok(&["cat-file", "-e", &format!("{commit}^{{commit}}")])
            .await
        {
            return false;
        }
        self.is_ancestor(&target, commit).await
    }

    async fn release_tags(&self, head: &str) -> Vec<ReleaseTag> {
        let output = self.run(&["tag", "--merged", head, "--list", "v*"]).await;
        if output.code != 0 {
            return Vec::new();
        }
        let mut tags = Vec::new();
        for line in output.stdout.split('\n') {
            if let Some(captures) = RELEASE_TAG.captures(line.trim()) {
                if let Some(version) = captures.get(1) {
                    tags.push(ReleaseTag {
                        tag: format!("v{}", version.as_str()),
                        version: version.as_str().to_string(),
                    });
                }
            }
        }
        tags
    }

    async fn previous_release_tag(&self, head: &str) -> Option<ReleaseTag> {
        let mut previous: Option<ReleaseTag> = None;
        for tag in self.release_tags(head).await {
            let replace = previous
                .as_ref()
                .and_then(|current| compare_versions(&tag.version, &current.version))
                .map(|order| order > 0)
                .unwrap_or(true);
            if replace {
                previous = Some(tag);
            }
        }
        previous
    }

    async fn read_commits(&self, range: &str) -> Result<Vec<CommitRecord>> {
        let format = "%H\u{1f}%P\u{1f}%s\u{1f}%b\u{1e}";
        let output = self
            .run(&["log", &format!("--format={format}"), range, "--"])
            .await;
        if output.code != 0 {
            bail!(
                "could not read the commits of {}: {}",
                range,
                first_line(if output.stderr.is_empty() {
                    output.stdout.as_str()
                } else {
                    output.stderr.as_str()
                })
            );
        }
        Ok(parse_records(&output.stdout))
    }
}

fn parse_records(text: &str) -> Vec<CommitRecord> {
    let mut records = Vec::new();
    for chunk in text.split('\u{1e}') {
        let record = chunk.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let mut fields = record.split('\u{1f}');
        let sha = fields.next().unwrap_or("").to_string();
        let parents: Vec<String> = fields
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let subject = fields.next().unwrap_or("").to_string();
        let body = fields.next().unwrap_or("").to_string();
        records.push(CommitRecord {
            sha,
            subject,
            body,
            parents,
        });
    }
    records
}

fn first_line(text: &str) -> String {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic")
        .to_string()
}

/// How many trailing lines a failed command is reported with.
const FAILURE_DETAIL_LINES: usize = 3;

/// The last lines a failed command printed.
///
/// A `git push` answers with the remote's progress first, so the reason it
/// refused is at the end of stderr, not at the start: a report built from the
/// first line names `remote: ** Checking 2 references` instead of the refusal.
fn failure_detail(outcome: &CommandOutcome) -> String {
    let text = if outcome.stderr.trim().is_empty() {
        outcome.stdout.as_str()
    } else {
        outcome.stderr.as_str()
    };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return "no diagnostic".to_string();
    }
    lines[lines.len().saturating_sub(FAILURE_DETAIL_LINES)..].join(" / ")
}

// ---------------------------------------------------------------------------
// HTTP API access

struct Api {
    transport: Arc<dyn HttpTransport>,
    sleeper: Arc<dyn Sleeper>,
    gitea: GiteaTarget,
    github_base: String,
    github_repo: String,
    github_token: Option<String>,
}

/// A refusal the same read may succeed at: a rate limit or a server-side
/// failure. Gitea answers a busy database as HTTP 500 "database is locked".
fn transient_status(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
}

impl Api {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        self.transport
            .send(request)
            .await
            .map_err(|error| anyhow!(error))
    }

    fn gitea_headers(&self, accept: &str) -> Vec<(String, String)> {
        let mut headers = vec![("Accept".to_string(), accept.to_string())];
        if let Some(token) = self
            .gitea
            .token
            .as_deref()
            .filter(|token| !token.is_empty())
        {
            headers.push(("Authorization".to_string(), format!("token {token}")));
        }
        headers
    }

    fn github_headers(&self, accept: &str) -> Vec<(String, String)> {
        let mut headers = vec![
            ("Accept".to_string(), accept.to_string()),
            ("X-GitHub-Api-Version".to_string(), "2022-11-28".to_string()),
            ("User-Agent".to_string(), "devboard-publish".to_string()),
        ];
        if let Some(token) = self
            .github_token
            .as_deref()
            .filter(|token| !token.is_empty())
        {
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        headers
    }

    /// One Gitea call. A GET is idempotent, so a transient refusal — a busy
    /// database, a rate limit, or another server-side failure — is retried
    /// before the caller sees it. A write is sent once here, because a retry
    /// blind to what the refused attempt committed could create the same
    /// release or asset twice; the release writes retry above this layer,
    /// after reading back what the forge already holds.
    async fn gitea_request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<HttpResponse> {
        let url = gitea::api_url(&self.gitea, path);
        let mut headers = self.gitea_headers("application/json");
        if body.is_some() {
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
        }
        let attempts = if method == "GET" {
            GITEA_READ_ATTEMPTS
        } else {
            1
        };
        let mut attempt = 0;
        loop {
            attempt += 1;
            if attempt > 1 {
                self.sleeper.sleep(GITEA_RETRY_DELAY).await;
            }
            let request = HttpRequest {
                method: method.to_string(),
                url: url.clone(),
                headers: headers.clone(),
                body: body
                    .as_ref()
                    .map(|value| jsjson::stringify(value).into_bytes())
                    .unwrap_or_default(),
            };
            match self.send(request).await {
                Ok(response) => {
                    if attempt == attempts || !transient_status(response.status) {
                        return Ok(response);
                    }
                }
                Err(error) => {
                    if attempt == attempts {
                        return Err(error);
                    }
                }
            }
        }
    }

    /// Uploads one release asset, retrying a transient refusal safely.
    ///
    /// Gitea answers a busy database with HTTP 500 "database is locked", and
    /// that refusal may still commit. A retry never resends blindly: the
    /// release is read back after every refusal, so the asset the release
    /// already holds is adopted as the upload the refused request performed
    /// and no asset is uploaded twice. A retried upload that the forge already
    /// applied answers HTTP 409; the read-back settles that case too.
    async fn gitea_upload(&self, release_id: u64, name: &str, bytes: Vec<u8>) -> Result<()> {
        let boundary = format!("----devboard{}", uuid::Uuid::new_v4().simple());
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"attachment\"; filename=\"{}\"\r\n",
                name.replace('"', "")
            )
            .as_bytes(),
        );
        body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
        body.extend_from_slice(&bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let mut headers = self.gitea_headers("application/json");
        headers.push((
            "Content-Type".to_string(),
            format!("multipart/form-data; boundary={boundary}"),
        ));
        let url = gitea::api_url(
            &self.gitea,
            &format!(
                "{}/releases/{release_id}/assets?name={}",
                gitea::repo_path(&self.gitea),
                encode_component(name)
            ),
        );
        for attempt in 1..=GITEA_WRITE_ATTEMPTS {
            let response = self
                .send(HttpRequest {
                    method: "POST".to_string(),
                    url: url.clone(),
                    headers: headers.clone(),
                    body: body.clone(),
                })
                .await?;
            if (200..300).contains(&response.status) {
                return Ok(());
            }
            let applied_elsewhere = transient_status(response.status) || response.status == 409;
            if attempt == GITEA_WRITE_ATTEMPTS || !applied_elsewhere {
                bail!(
                    "POST {url} failed (HTTP {}): {}",
                    response.status,
                    failure_message(&response)
                );
            }
            self.sleeper.sleep(GITEA_RETRY_DELAY).await;
            if self.gitea_release_has_asset(release_id, name).await? {
                return Ok(());
            }
        }
        unreachable!("the retry budget returns on its last attempt")
    }

    /// Whether one release already carries the named asset.
    async fn gitea_release_has_asset(&self, release_id: u64, name: &str) -> Result<bool> {
        let path = format!("{}/releases/{release_id}", gitea::repo_path(&self.gitea));
        let response = self.gitea_request("GET", &path, None).await?;
        if response.status == 404 {
            return Ok(false);
        }
        if !(200..300).contains(&response.status) {
            bail!(
                "GET {} failed (HTTP {}): {}",
                gitea::api_url(&self.gitea, &path),
                response.status,
                failure_message(&response)
            );
        }
        let document: Value = response.json()?;
        Ok(release_assets(&document)
            .iter()
            .any(|asset| asset_field(asset, "name") == Some(name)))
    }

    async fn github_request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        accept: &str,
    ) -> Result<HttpResponse> {
        let url = format!("{}{}", self.github_base.trim_end_matches('/'), path);
        let mut headers = self.github_headers(accept);
        let bytes = match body {
            Some(value) => {
                headers.push(("Content-Type".to_string(), "application/json".to_string()));
                jsjson::stringify(&value).into_bytes()
            }
            None => Vec::new(),
        };
        self.send(HttpRequest {
            method: method.to_string(),
            url,
            headers,
            body: bytes,
        })
        .await
    }

    async fn gitea_json(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let response = self.gitea_request(method, path, body).await?;
        if !(200..300).contains(&response.status) {
            bail!(
                "{} {} failed (HTTP {}): {}",
                method,
                gitea::api_url(&self.gitea, path),
                response.status,
                failure_message(&response)
            );
        }
        response.json()
    }

    async fn github_json(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        accept: &str,
    ) -> Result<Value> {
        let response = self.github_request(method, path, body, accept).await?;
        if !(200..300).contains(&response.status) {
            let url = format!("{}{}", self.github_base.trim_end_matches('/'), path);
            bail!(
                "{} {} failed (HTTP {}): {}",
                method,
                url,
                response.status,
                failure_message(&response)
            );
        }
        response.json()
    }

    async fn download(&self, url: &str, gitea: bool) -> Result<Vec<u8>> {
        let headers = if gitea {
            self.gitea_headers("*/*")
        } else {
            self.github_headers("application/octet-stream")
        };
        let response = self
            .send(HttpRequest {
                method: "GET".to_string(),
                url: url.to_string(),
                headers,
                body: Vec::new(),
            })
            .await?;
        if !(200..300).contains(&response.status) {
            bail!(
                "GET {} failed (HTTP {}): {}",
                url,
                response.status,
                failure_message(&response)
            );
        }
        Ok(response.body)
    }

    async fn gitea_release_by_tag(&self, tag: &str) -> Result<Option<Value>> {
        let path = format!(
            "{}/releases/tags/{}",
            gitea::repo_path(&self.gitea),
            encode_component(tag)
        );
        let response = self.gitea_request("GET", &path, None).await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&response.status) {
            bail!(
                "GET {} failed (HTTP {}): {}",
                gitea::api_url(&self.gitea, &path),
                response.status,
                failure_message(&response)
            );
        }
        Ok(Some(response.json()?))
    }

    /// The `object` a forge git ref names, or `None` when the ref is absent.
    async fn gitea_ref_object(&self, kind: &str, name: &str) -> Result<Option<Value>> {
        let path = format!(
            "{}/git/refs/{}/{}",
            gitea::repo_path(&self.gitea),
            kind,
            encode_component(name)
        );
        let response = self.gitea_request("GET", &path, None).await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&response.status) {
            bail!(
                "GET {} failed (HTTP {}): {}",
                gitea::api_url(&self.gitea, &path),
                response.status,
                failure_message(&response)
            );
        }
        // A forge answers one ref either as a bare object or as an array of
        // refs, one entry per matching name (Gitea/Forgejo 28 serves the
        // array). Read the entry that names this ref in both shapes.
        let document: Value = response.json()?;
        let expected = format!("refs/{kind}/{name}");
        let entry = match &document {
            Value::Array(entries) => entries
                .iter()
                .find(|entry| entry.get("ref").and_then(Value::as_str) == Some(expected.as_str()))
                .or_else(|| entries.first()),
            _ => Some(&document),
        };
        Ok(entry.and_then(|entry| entry.get("object")).cloned())
    }

    async fn gitea_tag_commit(&self, tag: &str) -> Result<Option<String>> {
        let Some(mut object) = self.gitea_ref_object("tags", tag).await? else {
            return Ok(None);
        };
        // An annotated tag names a tag object that names the commit; peel
        // every tag object in the chain and stop at the commit it names.
        for _ in 0..4 {
            let sha = object.get("sha").and_then(Value::as_str).unwrap_or("");
            if sha.is_empty() {
                return Ok(None);
            }
            let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
            if kind != "tag" {
                return Ok(Some(sha.to_string()));
            }
            let path = format!(
                "{}/git/tags/{}",
                gitea::repo_path(&self.gitea),
                encode_component(sha)
            );
            let annotated = self.gitea_json("GET", &path, None).await?;
            let Some(next) = annotated.get("object") else {
                return Ok(None);
            };
            object = next.clone();
        }
        Ok(None)
    }

    /// The commit the forge's branch names, or `None` when the branch is
    /// absent.
    /// The `devboard-ci.yml` runs of one commit, from the newest read.
    async fn gitea_ci_runs(&self, commit: &str) -> Result<Vec<WorkflowRun>> {
        let mut runs = Vec::new();
        for page in 1..=10u32 {
            let path = format!(
                "{}/actions/runs?limit=50&page={page}",
                gitea::repo_path(&self.gitea)
            );
            let document = self.gitea_json("GET", &path, None).await?;
            let Some(entries) = document
                .get("workflow_runs")
                .and_then(Value::as_array)
                .or_else(|| document.as_array())
            else {
                break;
            };
            if entries.is_empty() {
                break;
            }
            let mut added = 0usize;
            for entry in entries {
                let workflow = entry
                    .get("path")
                    .and_then(Value::as_str)
                    .map(|path| path.split('@').next().unwrap_or(path));
                if workflow != Some(CI_WORKFLOW) {
                    continue;
                }
                let Some(head_sha) = entry.get("head_sha").and_then(Value::as_str) else {
                    continue;
                };
                if head_sha != commit {
                    continue;
                }
                let Some(id) = entry.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                runs.push(WorkflowRun {
                    id,
                    head_sha: head_sha.to_string(),
                    status: entry
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    conclusion: entry
                        .get("conclusion")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
                added += 1;
            }
            if added == 0 {
                break;
            }
        }
        Ok(runs)
    }

    /// The jobs of one `devboard-ci.yml` run, each with its first failed step.
    ///
    /// The forge answers the same `jobs` document GitHub serves, so a gate
    /// that refuses the tag names the job and the step that failed instead of
    /// only the run's conclusion. A refused read keeps the run verdict.
    async fn gitea_ci_jobs(&self, run_id: u64) -> Result<Vec<WorkflowJob>> {
        let mut jobs = Vec::new();
        for page in 1..=10u32 {
            let path = format!(
                "{}/actions/runs/{run_id}/jobs?per_page=100&page={page}",
                gitea::repo_path(&self.gitea)
            );
            let document = self.gitea_json("GET", &path, None).await?;
            let Some(entries) = document.get("jobs").and_then(Value::as_array) else {
                break;
            };
            if entries.is_empty() {
                break;
            }
            let full = entries.len() >= 100;
            jobs.extend(workflow_jobs(&document));
            if !full {
                break;
            }
        }
        Ok(jobs)
    }

    /// Restarts one settled `devboard-ci.yml` run on the canonical forge.
    ///
    /// The run names a commit the branch already carries, so no later push
    /// produces a second run for it: without this restart one failure would
    /// refuse every later attempt of the same range. The forge answers a
    /// restart with the run it restarted (HTTP 201); any other status is a
    /// refusal the caller records beside the run's verdict.
    async fn gitea_ci_rerun(&self, run_id: u64) -> Result<()> {
        let path = format!(
            "{}/actions/runs/{run_id}/rerun",
            gitea::repo_path(&self.gitea)
        );
        let response = self.gitea_request("POST", &path, None).await?;
        if !(200..300).contains(&response.status) {
            bail!(
                "{} POST failed (HTTP {}): {}",
                gitea::api_url(&self.gitea, &path),
                response.status,
                failure_message(&response)
            );
        }
        Ok(())
    }

    async fn gitea_published_versions(&self) -> Result<Vec<String>> {
        let mut versions = Vec::new();
        let mut seen = HashSet::new();
        for page in 1..=50u32 {
            let path = format!(
                "{}/releases?limit=50&page={page}",
                gitea::repo_path(&self.gitea)
            );
            let document = self.gitea_json("GET", &path, None).await?;
            let Some(entries) = document.as_array() else {
                break;
            };
            if entries.is_empty() {
                break;
            }
            let mut added = 0usize;
            for entry in entries {
                if entry.get("draft").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let tag = entry.get("tag_name").and_then(Value::as_str).unwrap_or("");
                let Some(captures) = RELEASE_TAG.captures(tag) else {
                    continue;
                };
                let Some(version) = captures.get(1) else {
                    continue;
                };
                if seen.insert(version.as_str().to_string()) {
                    versions.push(version.as_str().to_string());
                    added += 1;
                }
            }
            if added == 0 {
                break;
            }
        }
        Ok(versions)
    }

    /// Creates one Gitea release, retrying a transient refusal safely.
    ///
    /// Gitea answers a busy database with HTTP 500 "database is locked", and
    /// that refusal may still commit. A retry never posts the same release
    /// twice: the tag is read back after every refusal, so the release a
    /// refused attempt created is adopted. A retried create that the forge
    /// already applied answers HTTP 409; the read-back settles that case too.
    async fn gitea_create_release(&self, tag: &str, version: &str, commit: &str) -> Result<u64> {
        let path = format!("{}/releases", gitea::repo_path(&self.gitea));
        let body = json!({
            "tag_name": tag,
            "target_commitish": commit,
            "name": format!("Devboard {version}"),
            "body": format!(
                "Devboard {version}\n\nGitHub release: https://github.com/{}/releases/tag/{tag}",
                self.github_repo
            ),
            "draft": false,
            "prerelease": false,
        });
        for attempt in 1..=GITEA_WRITE_ATTEMPTS {
            let response = self
                .gitea_request("POST", &path, Some(body.clone()))
                .await?;
            if (200..300).contains(&response.status) {
                return release_identifier(&response.json()?, tag);
            }
            let applied_elsewhere = transient_status(response.status) || response.status == 409;
            if attempt == GITEA_WRITE_ATTEMPTS || !applied_elsewhere {
                bail!(
                    "POST {} failed (HTTP {}): {}",
                    gitea::api_url(&self.gitea, &path),
                    response.status,
                    failure_message(&response)
                );
            }
            self.sleeper.sleep(GITEA_RETRY_DELAY).await;
            if let Some(release) = self.gitea_release_by_tag(tag).await? {
                return release_identifier(&release, tag);
            }
        }
        unreachable!("the retry budget returns on its last attempt")
    }

    /// Proves the configured Gitea credential may create this project's
    /// release. The manifest is written only after the tag push, the mirror
    /// push, and the GitHub assets, so a credential that cannot write must
    /// fail here instead of leaving a released tag with no Gitea manifest.
    async fn gitea_verify_write_credential(&self) -> Result<()> {
        if self.gitea.token.as_deref().unwrap_or("").is_empty() {
            bail!(
                "GITEA_TOKEN is required to create the release for {}",
                self.gitea.project
            );
        }
        let path = gitea::repo_path(&self.gitea);
        let response = self.gitea_request("GET", &path, None).await?;
        if !(200..300).contains(&response.status) {
            bail!(
                "the Gitea credential for {} is not valid (HTTP {}): {}; set GITEA_TOKEN to a token that can create a release",
                self.gitea.project,
                response.status,
                failure_message(&response)
            );
        }
        let repository = response.json()?;
        let writable = ["admin", "push"].iter().any(|key| {
            repository
                .get("permissions")
                .and_then(|permissions| permissions.get(*key))
                .and_then(Value::as_bool)
                == Some(true)
        });
        if !writable {
            bail!(
                "the Gitea credential for {} cannot create a release; set GITEA_TOKEN to a token with repository write access",
                self.gitea.project
            );
        }
        Ok(())
    }

    async fn github_runs(&self, workflow: &str, commit: &str) -> Result<Vec<WorkflowRun>> {
        let path = format!(
            "/repos/{}/actions/workflows/{}/runs?head_sha={}&per_page=50",
            github_repo_path(&self.github_repo),
            encode_component(workflow),
            encode_component(commit)
        );
        let document = self
            .github_json("GET", &path, None, "application/vnd.github+json")
            .await?;
        Ok(workflow_runs(&document))
    }

    /// The jobs of one workflow run, each with its first failed step.
    async fn github_jobs(&self, run_id: u64) -> Result<Vec<WorkflowJob>> {
        let path = format!(
            "/repos/{}/actions/runs/{run_id}/jobs?per_page=100",
            github_repo_path(&self.github_repo)
        );
        let document = self
            .github_json("GET", &path, None, "application/vnd.github+json")
            .await?;
        Ok(workflow_jobs(&document))
    }

    /// Dispatches one workflow at a ref, with optional inputs.
    async fn github_dispatch_at(
        &self,
        workflow: &str,
        reference: &str,
        inputs: Option<Value>,
    ) -> Result<()> {
        if self.github_token.as_deref().unwrap_or("").is_empty() {
            bail!("GH_TOKEN is required to dispatch the release workflow");
        }
        let path = format!(
            "/repos/{}/actions/workflows/{}/dispatches",
            github_repo_path(&self.github_repo),
            encode_component(workflow)
        );
        let body = match inputs {
            Some(inputs) => json!({ "ref": reference, "inputs": inputs }),
            None => json!({ "ref": reference }),
        };
        let response = self
            .github_request("POST", &path, Some(body), "application/vnd.github+json")
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(anyhow::Error::new(GithubDispatchError {
                status: response.status,
                url: format!("{}{}", self.github_base.trim_end_matches('/'), path),
                message: failure_message(&response),
            }));
        }
        Ok(())
    }

    /// The host GitHub accepts release-asset uploads on.
    fn github_upload_base(&self) -> String {
        let base = self.github_base.trim_end_matches('/');
        if base == "https://api.github.com" {
            "https://uploads.github.com".to_string()
        } else {
            base.to_string()
        }
    }

    /// Uploads one release asset by its release identifier.
    async fn github_upload_release_asset(
        &self,
        release_id: u64,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<()> {
        let path = format!(
            "/repos/{}/releases/{release_id}/assets?name={}",
            github_repo_path(&self.github_repo),
            encode_component(name)
        );
        // GitHub uploads assets through `uploads.github.com`, not the API
        // host; the API host answers the same POST with 404.
        let url = format!("{}{}", self.github_upload_base(), path);
        let mut headers = self.github_headers("application/vnd.github+json");
        headers.push((
            "Content-Type".to_string(),
            "application/octet-stream".to_string(),
        ));
        let response = self
            .send(HttpRequest {
                method: "POST".to_string(),
                url: url.clone(),
                headers,
                body: bytes,
            })
            .await?;
        if !(200..300).contains(&response.status) {
            bail!(
                "POST {url} failed (HTTP {}): {}",
                response.status,
                failure_message(&response)
            );
        }
        Ok(())
    }

    /// Creates a parentless commit over the empty tree, points `tag` at it,
    /// and publishes the release the ref move detached.
    ///
    /// GitHub refuses `POST /git/trees` with an empty `tree`, so the commit
    /// names git's well-known empty-tree object directly. Deleting the
    /// release's tag ref turns the release into a draft, so the release is
    /// published again and read back by tag before publish reports.
    async fn github_retag_empty(
        &self,
        tag: &str,
        version: &str,
        release_id: u64,
    ) -> Result<String> {
        let repository = github_repo_path(&self.github_repo);
        let commit = self
            .github_json(
                "POST",
                &format!("/repos/{repository}/git/commits"),
                Some(json!({
                    "message": format!("Devboard {version}"),
                    "tree": EMPTY_TREE_SHA,
                    "parents": [],
                })),
                "application/vnd.github+json",
            )
            .await?;
        let commit_sha = commit
            .get("sha")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("the release commit has no identifier"))?
            .to_string();
        let ref_path = format!(
            "/repos/{repository}/git/refs/tags/{}",
            encode_component(tag)
        );
        let _ = self
            .github_request("DELETE", &ref_path, None, "application/vnd.github+json")
            .await;
        self.github_json(
            "POST",
            &format!("/repos/{repository}/git/refs"),
            Some(json!({
                "ref": format!("refs/tags/{tag}"),
                "sha": commit_sha,
            })),
            "application/vnd.github+json",
        )
        .await?;
        self.github_json(
            "PATCH",
            &format!("/repos/{repository}/releases/{release_id}"),
            Some(json!({"draft": false})),
            "application/vnd.github+json",
        )
        .await?;
        let mut published = false;
        for _ in 0..10 {
            if self.github_release_by_tag(tag).await?.is_some() {
                published = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if !published {
            bail!("the GitHub release {tag} is not published after the tag move");
        }
        Ok(commit_sha)
    }

    /// Deletes one git ref on the GitHub repository.
    async fn github_delete_ref(&self, reference: &str) -> Result<()> {
        let path = format!(
            "/repos/{}/git/refs/{}",
            github_repo_path(&self.github_repo),
            reference.trim_start_matches("refs/")
        );
        let response = self
            .github_request("DELETE", &path, None, "application/vnd.github+json")
            .await?;
        if !(200..300).contains(&response.status) && response.status != 404 {
            bail!(
                "DELETE {}{} failed (HTTP {})",
                self.github_base.trim_end_matches('/'),
                path,
                response.status
            );
        }
        Ok(())
    }

    async fn github_release_by_tag(&self, tag: &str) -> Result<Option<Value>> {
        let path = format!(
            "/repos/{}/releases/tags/{}",
            github_repo_path(&self.github_repo),
            encode_component(tag)
        );
        let response = self
            .github_request("GET", &path, None, "application/vnd.github+json")
            .await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&response.status) {
            bail!(
                "GET {}{} failed (HTTP {}): {}",
                self.github_base.trim_end_matches('/'),
                path,
                response.status,
                failure_message(&response)
            );
        }
        Ok(Some(response.json()?))
    }
}

fn failure_message(response: &HttpResponse) -> String {
    let text = response.text();
    if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
        if let Some(message) = parsed.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    first_line(&text)
}

fn github_repo_path(project: &str) -> String {
    project
        .split('/')
        .map(encode_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Workflow runs

/// One GitHub workflow run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRun {
    pub id: u64,
    pub head_sha: String,
    pub status: String,
    pub conclusion: Option<String>,
}

fn workflow_runs(document: &Value) -> Vec<WorkflowRun> {
    let entries = document
        .get("workflow_runs")
        .and_then(Value::as_array)
        .or_else(|| document.as_array());
    let Some(entries) = entries else {
        return Vec::new();
    };
    let mut runs = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(head_sha) = entry.get("head_sha").and_then(Value::as_str) else {
            continue;
        };
        runs.push(WorkflowRun {
            id,
            head_sha: head_sha.to_string(),
            status: entry
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            conclusion: entry
                .get("conclusion")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    runs
}

/// True when the run has settled, successfully or not.
pub fn workflow_finished(run: &WorkflowRun) -> bool {
    run.conclusion.is_some()
        || [
            "completed",
            "success",
            "failure",
            "cancelled",
            "skipped",
            "timed_out",
        ]
        .contains(&run.status.as_str())
}

/// The run the wait should follow: an active one, then the successful one.
pub fn choose_workflow_run(runs: &[WorkflowRun], commit: &str) -> Option<WorkflowRun> {
    let matching: Vec<&WorkflowRun> = runs.iter().filter(|run| run.head_sha == commit).collect();
    if let Some(active) = matching.iter().find(|run| !workflow_finished(run)) {
        return Some((*active).clone());
    }
    if let Some(success) = matching
        .iter()
        .find(|run| run.conclusion.as_deref() == Some("success"))
    {
        return Some((*success).clone());
    }
    matching.first().map(|run| (*run).clone())
}

/// One GitHub workflow job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowJob {
    pub name: String,
    pub conclusion: Option<String>,
    /// The first step that failed, when a step did.
    pub failed_step: Option<String>,
}

/// How many failing jobs one message names before it counts the rest.
const FAILED_JOB_LIMIT: usize = 3;

fn workflow_jobs(document: &Value) -> Vec<WorkflowJob> {
    let Some(entries) = document.get("jobs").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut jobs = Vec::new();
    for entry in entries {
        let Some(name) = entry.get("name").and_then(Value::as_str) else {
            continue;
        };
        let failed_step = entry
            .get("steps")
            .and_then(Value::as_array)
            .and_then(|steps| failed_step_name(steps));
        jobs.push(WorkflowJob {
            name: name.to_string(),
            conclusion: entry
                .get("conclusion")
                .and_then(Value::as_str)
                .map(str::to_string),
            failed_step,
        });
    }
    jobs
}

fn failed_step_name(steps: &[Value]) -> Option<String> {
    steps.iter().find_map(|step| {
        let conclusion = step.get("conclusion").and_then(Value::as_str)?;
        if conclusion != "failure" && conclusion != "timed_out" && conclusion != "startup_failure" {
            return None;
        }
        step.get("name").and_then(Value::as_str).map(str::to_string)
    })
}

fn job_failed(job: &WorkflowJob) -> bool {
    matches!(
        job.conclusion.as_deref(),
        Some("failure") | Some("timed_out") | Some("startup_failure") | Some("action_required")
    )
}

/// Names the jobs that failed, so a cancelled or failed run reports its cause.
///
/// GitHub cancels the queued siblings of a failed matrix job and can settle the
/// run's own conclusion as `cancelled`, which names no cause at all. The first
/// `FAILED_JOB_LIMIT` failing jobs with the step that failed are the cause.
fn failed_jobs_detail(jobs: &[WorkflowJob]) -> Option<String> {
    let failed: Vec<String> = jobs
        .iter()
        .filter(|job| job_failed(job))
        .map(|job| match &job.failed_step {
            Some(step) => format!("{} failed at {step}", job.name),
            None => format!("{} failed", job.name),
        })
        .collect();
    if failed.is_empty() {
        return None;
    }
    let shown = failed
        .iter()
        .take(FAILED_JOB_LIMIT)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    let rest = failed.len().saturating_sub(FAILED_JOB_LIMIT);
    Some(match rest {
        0 => shown,
        1 => format!("{shown}; and 1 more job"),
        rest => format!("{shown}; and {rest} more jobs"),
    })
}

// ---------------------------------------------------------------------------
// Verified GitHub assets

struct VerifiedAssets {
    manifest: Vec<u8>,
    manifest_digest: String,
    manifest_checksum: Vec<u8>,
    /// Every checksum asset mirrored to Gitea, by asset name.
    checksums: Vec<(String, Vec<u8>)>,
    /// Every GitHub asset the verification read, by name.
    names: Vec<String>,
}

// ---------------------------------------------------------------------------
// Publish

/// Runs the release suite and refuses a publish the suite does not pass. The
/// gate runs before the version bump, the tag, the push, and the workflow
/// dispatch, so a failing suite can never ship a release.
async fn run_release_suite_gate(
    args: &PublishArgs,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
    runner: Arc<dyn CommandRunner>,
    suite_dir: PathBuf,
) -> Result<()> {
    let gate: Arc<dyn release_suite::ReleaseSuiteGate> = args
        .release_suite
        .clone()
        .unwrap_or_else(|| Arc::new(release_suite::ProcessSuiteGate));
    (log)("release suite: the workspace suite runs before the tag");
    let report = gate
        .run(release_suite::ReleaseSuiteOptions {
            dir: suite_dir,
            forge_dir: Some(args.repo_dir.clone()),
            environment: args.environment.clone(),
            runner: Some(runner),
            transport: None,
            log: Some(log.clone()),
            max_attempts: release_suite::RELEASE_SUITE_MAX_ATTEMPTS,
            consecutive_failures: release_suite::RELEASE_SUITE_CONSECUTIVE_FAILURES,
            file_issues: true,
            attempt_timeout: Duration::from_secs(3_600),
        })
        .await?;
    if report.code != 0 {
        let reason = report
            .error_line
            .clone()
            .or_else(|| report.structural.clone())
            .unwrap_or_else(|| {
                format!(
                    "the suite still failed after {} attempt(s)",
                    report.attempts
                )
            });
        bail!("the release suite did not pass; nothing was tagged or dispatched: {reason}");
    }
    Ok(())
}

/// Publishes one release from the integration checkout.
///
/// The returned report is `Ok` once the release itself shipped. Source-refresh
/// delivery failures are reported in `source_refresh.failed` because the
/// release has already shipped and must never be recorded as a failed release.
pub async fn publish(args: PublishArgs) -> Result<PublishReport> {
    if args.wait_timeout.is_zero() {
        bail!("--wait-timeout needs positive seconds");
    }
    let runner: Arc<dyn CommandRunner> = args
        .runner
        .clone()
        .unwrap_or_else(|| Arc::new(ProcessRunner));
    let transport: Arc<dyn HttpTransport> = args
        .transport
        .clone()
        .unwrap_or_else(|| Arc::new(ReqwestTransport::new()));
    let clock: Arc<dyn Clock> = args.clock.clone().unwrap_or_else(|| Arc::new(SystemClock));
    let sleeper: Arc<dyn Sleeper> = args
        .sleeper
        .clone()
        .unwrap_or_else(|| Arc::new(TokioSleeper));
    let log: Arc<dyn Fn(&str) + Send + Sync> = args.log.clone().unwrap_or_else(|| {
        Arc::new(|line: &str| {
            eprintln!("publish: {line}");
        })
    });

    let mut preflight = preflight(&args, runner.as_ref()).await?;

    let mut lock: Option<ReleaseLock> = None;
    if let Some(path) = release_lock_path(&args.environment) {
        let lock_state = args.harness_root.join(".tmp");
        lock = Some(
            acquire_release_lock(ReleaseLockOptions {
                path,
                repo_dir: args.repo_dir.clone(),
                state_dir: lock_state,
                timeout: Duration::from_millis(RELEASE_LOCK_WAIT_MS as u64),
                poll_interval: args.lock_poll_interval,
                argv: std::env::args().collect(),
                clock: Some(clock.clone()),
                sleeper: Some(sleeper.clone()),
                log: Some(log.clone()),
            })
            .await?,
        );
    }

    let gitea = resolve_gitea_target(&args, runner.as_ref(), &preflight.remote).await?;
    let github_base = args
        .environment
        .get("DEVBOARD_GITHUB_API_URL")
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://api.github.com".to_string());
    let github_repo = args
        .environment
        .get("DEVBOARD_GITHUB_REPO")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| RELEASE_REPOSITORY.to_string());
    let github_token = crate::release::github_api_token(&args.environment).await;
    let api = Api {
        transport,
        sleeper: sleeper.clone(),
        gitea,
        github_base,
        github_repo,
        github_token,
    };
    // The environment every git command of this release runs with. A fetch
    // that had to reach the checkout's `origin` through the configured Gitea
    // HTTP address switches this for the rest of the run, because the tag and
    // the pushes go to the same remote.
    let mut git_environment = args.environment.clone();

    // One attempt refreshes the checkout, proves the bundle, derives the
    // version, tests it, and pushes it. A landing that publishes into `main`
    // between the derivation and the push settles a range this attempt derived
    // and tested at the older tip, so a refused push integrates that landing
    // and derives again instead of failing a release nothing is wrong with.
    // The window those retries share starts here, before the first fetch.
    let race_started = clock.now_millis();
    let mut attempt: u32 = 0;
    let (version, tag, commit, existing_at_head) = loop {
        attempt += 1;
        preflight.published = refresh_main(
            &args,
            runner.as_ref(),
            &preflight.remote,
            &mut git_environment,
            &log,
            &sleeper,
        )
        .await?;
        let git = Git::new(runner.as_ref(), &args.repo_dir, &git_environment);
        // A client bundle older than the checkout is rebuilt from the released
        // sources before anything is proven or tagged.
        if dist_is_stale(&args.harness_root)? {
            rebuild_client(&args, runner.as_ref(), &log).await?;
        }
        // The bundle, the staged manifest, and the tag are proven before
        // anything is tagged, pushed, or written, and only after the checkout
        // is current and its stale bundle rebuilt: proving first would refuse a
        // checkout whose sources moved ahead of a bundle this very run is about
        // to rebuild.
        verify_release_bundle(&args.harness_root)?;
        // The tag names the released commit, not this working tree, so the copy
        // the release ships must already be committed there.
        verify_embedded_client_committed(&args, runner.as_ref()).await?;

        let published_head = preflight.published.clone();

        // Refresh the release tags before deriving. A failed refresh is not fatal
        // by itself: it is reported only when the newest release stays unreachable.
        let refreshed = git
            .run(&["fetch", "--quiet", "--tags", "--force", &preflight.remote])
            .await;
        let refresh_problem = (refreshed.code != 0).then(|| {
            format!(
                "could not refresh the release tags: {}",
                first_line(if refreshed.stderr.is_empty() {
                    refreshed.stdout.as_str()
                } else {
                    refreshed.stderr.as_str()
                })
            )
        });

        let newest = highest_version(
            api.gitea_published_versions()
                .await?
                .iter()
                .map(String::as_str),
        );

        let mut derivation = derive_release_version(&git, &published_head).await?;
        if let Some(newest) = newest.as_deref() {
            let order = compare_versions(&derivation.version, newest)
                .ok_or_else(|| anyhow!("cannot order {} against {newest}", derivation.version))?;
            if order <= 0 {
                derivation = rederive_from_published(
                    &git,
                    &api,
                    &published_head,
                    newest,
                    refresh_problem.as_deref(),
                )
                .await?;
            }
        }

        let version = derivation.version.clone();
        if !valid_version(&version) {
            bail!("computed an invalid version: {version}");
        }
        let tag = format!("v{version}");

        // A tag already naming this commit means the tag push and the release step
        // of a previous run happened (or an external release named it). A rerun
        // still verifies and completes the GitHub and Gitea halves; it never bumps
        // the version, commits, or tags again.
        let existing_at_head =
            git.tag_commit(&tag).await.as_deref() == Some(published_head.as_str());
        if derivation.level.is_none() && !existing_at_head {
            (log)(&format!(
                "nothing to release; {tag} already covers {}",
                short_sha(&published_head)
            ));
            return Ok(not_published(&version, &tag, &published_head));
        }

        let commit = if existing_at_head {
            (log)(&format!(
                "{tag} already names {}; verifying the existing release",
                short_sha(&published_head)
            ));
            // The Gitea manifest is written only after the tag push and the GitHub
            // assets, so a credential that cannot write must fail before the
            // mirror push and the dispatch.
            api.gitea_verify_write_credential().await?;
            // Nothing is pushed or dispatched before the suite passes.
            if let Some(suite_dir) = args.release_suite_dir.clone() {
                run_release_suite_gate(&args, &log, runner.clone(), suite_dir).await?;
            }
            published_head.clone()
        } else {
            // The tag must name this commit or contain it. A tag made for an
            // unrelated commit is a refusal before anything is committed or pushed.
            if let Some(bound) = git.tag_commit(&tag).await {
                if bound == published_head {
                    (log)(&format!(
                        "nothing to release; {tag} already names {}",
                        short_sha(&published_head)
                    ));
                    return Ok(not_published(&version, &tag, &published_head));
                }
                if git.is_ancestor(&published_head, &bound).await {
                    (log)(&format!(
                        "nothing to release; {tag} already contains {}",
                        short_sha(&published_head)
                    ));
                    return Ok(not_published(&version, &tag, &published_head));
                }
                if git.is_ancestor(&bound, &published_head).await {
                    (log)(&format!(
                        "nothing to release; {tag} already covers {}",
                        short_sha(&published_head)
                    ));
                    return Ok(not_published(&version, &tag, &published_head));
                }
                bail!(
                "{tag} already names {}, which neither names nor contains {}; refusing to report a release for another commit",
                short_sha(&bound),
                short_sha(&published_head)
            );
            }
            if let Some(forge_commit) = api.gitea_tag_commit(&tag).await? {
                if git
                    .commit_names_or_contains(&forge_commit, &published_head)
                    .await
                {
                    (log)(&format!(
                        "nothing to release; {tag} already names or contains {}",
                        short_sha(&published_head)
                    ));
                    return Ok(not_published(&version, &tag, &published_head));
                }
                bail!(
                "{tag} already names {}, which neither names nor contains {}; refusing to report a release for another commit",
                short_sha(&forge_commit),
                short_sha(&published_head)
            );
            }

            let violations = commit_violations(&derivation.commits);
            if !violations.is_empty() {
                for violation in &violations {
                    (log)(&format!(
                        "commit-gate: {} {}\n  {}",
                        violation.sha, violation.subject, violation.rule
                    ));
                }
                bail!(
                    "the commits in {} are not Conventional Commits",
                    derivation.range
                );
            }

            (log)(&format!("{tag} at {}", short_sha(&published_head)));

            // The Gitea manifest is written only after the tag push and the GitHub
            // assets, so a credential that cannot write must fail before the first
            // irreversible step.
            api.gitea_verify_write_credential().await?;

            // Nothing is bumped, tagged, pushed, or dispatched before the suite
            // passes.
            if let Some(suite_dir) = args.release_suite_dir.clone() {
                run_release_suite_gate(&args, &log, runner.clone(), suite_dir).await?;
            }
            if let Some(head) = head_moved_after_proof(&git, &published_head).await? {
                if race_spent(race_started, &clock) {
                    bail!(
                        "the checkout kept moving for {} minutes across {attempt} attempts; \
                         nothing was tagged or pushed to {}/main",
                        race_minutes(race_started, &clock),
                        preflight.remote
                    );
                }
                (log)(&format!(
                    "integrating the landing at {} and deriving again (attempt {})",
                    short_sha(&head),
                    attempt + 1
                ));
                sleeper.sleep(RACE_INTEGRATION_PAUSE).await;
                continue;
            }

            let manifest_path = args.harness_root.join("Cargo.toml");
            // An earlier attempt of this same version committed the bump and then
            // withdrew its tag when the release did not ship, so main already
            // carries the version: the retry tags the head it derived instead of
            // committing an unchanged manifest.
            if workspace_version(&manifest_path).as_deref() == Some(version.as_str()) {
                (log)(&format!(
                    "{tag} reuses the version bump already committed on main"
                ));
            } else {
                bump_workspace_version(&manifest_path, &version)?;
                refresh_lockfile(git.runner, &args.environment, &args.harness_root).await?;
                let manifest = relative_git_path(&args.repo_dir, &manifest_path);
                let lock_path = args.harness_root.join("Cargo.lock");
                let lock = relative_git_path(&args.repo_dir, &lock_path);
                let commit_message = format!("chore(release): v{version}");
                let mut commit_args: Vec<&str> = vec![
                    "-c",
                    "user.name=Devboard Release",
                    "-c",
                    "user.email=release@devboard.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--only",
                    "-m",
                    &commit_message,
                    "--",
                    &manifest,
                ];
                if lock_path.exists() {
                    commit_args.push(&lock);
                }
                let committed = git.run(&commit_args).await;
                if committed.code != 0 {
                    bail!(
                        "could not commit the version bump: {}",
                        first_line(if committed.stderr.is_empty() {
                            committed.stdout.as_str()
                        } else {
                            committed.stderr.as_str()
                        })
                    );
                }
            }
            let tag_created = git
                .run(&[
                    "-c",
                    "user.name=Devboard Release",
                    "-c",
                    "user.email=release@devboard.invalid",
                    "tag",
                    "-a",
                    &tag,
                    "-m",
                    &format!("Devboard {version}"),
                ])
                .await;
            if tag_created.code != 0 {
                bail!(
                    "could not create {tag}: {}",
                    first_line(if tag_created.stderr.is_empty() {
                        tag_created.stdout.as_str()
                    } else {
                        tag_created.stderr.as_str()
                    })
                );
            }
            git.must(&["rev-parse", "HEAD"], "could not read HEAD after the bump")
                .await?
        };

        // The branch lands first so the canonical forge can prove the exact
        // commit in CI; the tag is pushed only after that run concludes
        // success. A single push of both refs made the tag visible before
        // anything proved the commit it names.
        (log)(&format!("pushing main to {}", preflight.remote));
        let pushed = git
            .run(&["push", &preflight.remote, "refs/heads/main:refs/heads/main"])
            .await;
        if pushed.code != 0 {
            // A forge can accept the push and then lose its answer, so a
            // nonzero exit is not evidence that nothing landed: the remote's
            // main decides, and a push it already carries never fails a
            // release that shipped.
            match landed_main_tip(&git, &preflight.remote, &published_head).await? {
                Some(tip) if tip == commit => (log)(&format!(
                    "{} carries {}; the push exited nonzero after the ref moved",
                    preflight.remote,
                    short_sha(&commit)
                )),
                Some(tip) => {
                    // The range this attempt derived and tested is not the
                    // range `main` now carries, so the attempt's tag is
                    // withdrawn and its version bump dropped before anything
                    // derives again: a tag whose release never appeared must
                    // not advance the next derivation past a version that has
                    // no artifacts, and a local-only bump commit would block
                    // every later attempt. A tag an earlier run created is
                    // left to the shipped-release rule instead.
                    if existing_at_head {
                        withdraw_unreleased_tag(&api, &git, &preflight, &tag, &log).await;
                    } else {
                        withdraw_refused_tag(&git, &preflight, &tag, &commit, &log).await?;
                    }
                    git.must(
                        &["reset", "--keep", tip.as_str()],
                        "could not integrate the landing",
                    )
                    .await?;
                    if race_spent(race_started, &clock) {
                        bail!(
                            "could not push main to {}: {}; {}/main kept moving for {} minutes \
                             across {attempt} attempts",
                            preflight.remote,
                            failure_detail(&pushed),
                            preflight.remote,
                            race_minutes(race_started, &clock)
                        );
                    }
                    (log)(&format!(
                        "integrating the landing at {} and deriving again (attempt {})",
                        short_sha(&tip),
                        attempt + 1
                    ));
                    sleeper.sleep(RACE_INTEGRATION_PAUSE).await;
                    continue;
                }
                None => bail!(
                    "could not push main to {}: {}",
                    preflight.remote,
                    failure_detail(&pushed)
                ),
            }
        }
        // The tag waits for the canonical CI run of the commit it names. A
        // failing run leaves the range unreleased: the branch keeps the commit,
        // the tag is dropped locally, and the next tick derives it again.
        if !existing_at_head {
            if let Err(error) =
                wait_for_ci_success(&api, &clock, &sleeper, &args, &commit, &log).await
            {
                let _ = git.run(&["tag", "-d", &tag]).await;
                return Err(error);
            }
        } else {
            (log)(&format!(
                "{tag} is already pushed; its CI gate ran when the tag was created"
            ));
        }
        (log)(&format!("pushing {tag} to {}", preflight.remote));
        let tag_pushed = git
            .run(&[
                "push",
                &preflight.remote,
                &format!("refs/tags/{tag}:refs/tags/{tag}"),
            ])
            .await;
        if tag_pushed.code != 0 {
            // A forge can accept the tag and lose the push's answer. The ref
            // the remote actually carries decides, exactly as it does for the
            // branch.
            let landed = remote_tag_commit(&git, &preflight.remote, &tag)
                .await?
                .as_deref()
                == Some(commit.as_str());
            if landed {
                (log)(&format!(
                    "{} carries {tag}; the push exited nonzero after the refs moved",
                    preflight.remote
                ));
            } else {
                if !existing_at_head {
                    // The branch already carries the commit, but the release
                    // tag did not land. Dropping it locally lets the next tick
                    // retag the same range instead of deriving past it.
                    let _ = git.run(&["tag", "-d", &tag]).await;
                }
                bail!(
                    "could not push {tag} to {}: {}",
                    preflight.remote,
                    failure_detail(&tag_pushed)
                );
            }
        }
        break (version, tag, commit, existing_at_head);
    };
    // The release tail runs in the transport the attempt settled on: a build
    // ref and a withdrawn tag go to the same remotes the fetch reached.
    let git = Git::new(runner.as_ref(), &args.repo_dir, &git_environment);

    // A release that fails before its GitHub release exists must not leave its
    // tag behind: the gate derives the next version from the newest release
    // tag, so a tag whose release never shipped would move the range past a
    // version that has no artifacts at all.
    let created_tag = !existing_at_head;
    let shipped = async {
        // The canonical source reaches the GitHub-hosted builders through a
        // temporary build ref only: no lasting GitHub ref may reach it, and
        // only GitHub's runners can build the macOS targets.
        if !preflight.remotes.iter().any(|remote| remote == "github") {
            bail!("the GitHub remote is required to build the release artifacts");
        }
        push_github_build_ref(&git, &args.environment, &commit, &tag, &log).await?;

        let workflow_run =
            dispatch_and_wait(&api, &clock, &sleeper, &args, &commit, &tag, &log).await?;
        (log)(&format!(
            "canonical build: {BUILD_WORKFLOW} run {workflow_run} built {tag} from the canonical \
             Gitea commit {} at {}",
            short_sha(&commit),
            build_ref(&tag)
        ));

        let verified =
            verify_github_assets(&api, &clock, &sleeper, &args, &tag, &version, &log).await?;

        write_gitea_release(&api, &git, &version, &tag, &commit, &verified, &log).await?;

        // The public GitHub release carries the same manifest, so a host that
        // cannot reach Gitea installs from GitHub alone.
        let release = api
            .github_release_by_tag(&tag)
            .await?
            .ok_or_else(|| anyhow!("the GitHub release {tag} disappeared before its manifest"))?;
        let release_id = release
            .get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow!("the GitHub release {tag} has no identifier"))?;
        if find_asset(&release_assets(&release), MANIFEST_ASSET).is_none() {
            api.github_upload_release_asset(release_id, MANIFEST_ASSET, verified.manifest.clone())
                .await?;
            (log)(&format!("uploaded {MANIFEST_ASSET} to the GitHub release"));
        }

        // The release tag names an empty-tree commit: the built assets are all
        // it points at, and the temporary build ref is deleted. GitHub's main
        // is never advanced to the released commit.
        let empty = api.github_retag_empty(&tag, &version, release_id).await?;
        api.github_delete_ref(&build_ref(&tag)).await?;
        (log)(&format!(
            "GitHub tag {tag} names the empty release commit {}; the build ref is gone",
            short_sha(&empty)
        ));

        let instances = args
            .instances
            .clone()
            .unwrap_or_else(discover_dashboard_instances);
        let source_refresh = deliver_source_refresh(SourceRefreshOptions {
            repo_root: args.repo_dir.clone(),
            harness_root: args.harness_root.clone(),
            commit: commit.clone(),
            version: version.clone(),
            dist_dir: args.harness_root.join("dist"),
            instances: instances.clone(),
            requested_at: iso_from_millis(clock.now_millis()),
        })
        .await?;
        let inventory = dashboard_inventory(&instances);

        Ok::<_, anyhow::Error>((workflow_run, verified, source_refresh, inventory))
    }
    .await;

    let (workflow_run, verified, source_refresh, dashboards) = match shipped {
        Ok(shipped) => shipped,
        Err(error) => {
            let _ = api.github_delete_ref(&build_ref(&tag)).await;
            if created_tag {
                withdraw_unreleased_tag(&api, &git, &preflight, &tag, &log).await;
            }
            return Err(error);
        }
    };
    let manifest_text = String::from_utf8_lossy(&verified.manifest).into_owned();
    for target in &source_refresh.written {
        (log)(&format!(
            "source refresh requested for {} (pid {}, port {})",
            target.state_dir.display(),
            target.pid,
            target.port
        ));
    }
    for target in &source_refresh.applied {
        (log)(&format!(
            "source refresh already applied by {} (pid {})",
            target.state_dir.display(),
            target.pid
        ));
    }
    for failure in &source_refresh.failed {
        (log)(&format!(
            "source refresh delivery failed for {} (pid {}): {}",
            failure.state_dir.display(),
            failure.pid,
            failure.error
        ));
    }

    drop(lock.take());

    Ok(PublishReport {
        version,
        tag,
        commit,
        published: !existing_at_head,
        workflow_run: Some(workflow_run),
        github_assets: verified.names,
        manifest: manifest_text,
        source_refresh,
        dashboards,
    })
}

fn empty_refresh_report() -> SourceRefreshReport {
    SourceRefreshReport {
        request: SourceRefreshRequest {
            schema: SOURCE_REFRESH_SCHEMA,
            commit: String::new(),
            version: String::new(),
            dist_digest: String::new(),
            requested_at: String::new(),
        },
        written: Vec::new(),
        applied: Vec::new(),
        failed: Vec::new(),
        skipped: Vec::new(),
    }
}

fn not_published(version: &str, tag: &str, commit: &str) -> PublishReport {
    PublishReport {
        version: version.to_string(),
        tag: tag.to_string(),
        commit: commit.to_string(),
        published: false,
        workflow_run: None,
        github_assets: Vec::new(),
        manifest: String::new(),
        source_refresh: empty_refresh_report(),
        dashboards: Vec::new(),
    }
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

// ---------------------------------------------------------------------------
// Preflight

struct Preflight {
    remote: String,
    remotes: Vec<String>,
    published: String,
}

async fn preflight(args: &PublishArgs, runner: &dyn CommandRunner) -> Result<Preflight> {
    let git = Git::new(runner, &args.repo_dir, &args.environment);
    let git_dir = git
        .must(
            &["rev-parse", "--absolute-git-dir"],
            "could not read the git dir",
        )
        .await?;
    let common_dir = git
        .must(
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            "could not read the common git dir",
        )
        .await?;
    let real_git = std::fs::canonicalize(git_dir.trim()).ok();
    let real_common = std::fs::canonicalize(common_dir.trim()).ok();
    if let (Some(git_dir), Some(common_dir)) = (real_git, real_common) {
        if git_dir != common_dir {
            bail!("run publish from the integration checkout, not a worktree");
        }
    }

    let branch = git
        .must(
            &["symbolic-ref", "--short", "HEAD"],
            "the checkout is not on a branch",
        )
        .await?;
    if branch.trim() != "main" {
        bail!("the integration line is main, not {}", branch.trim());
    }

    let remotes_output = git.must(&["remote"], "could not list remotes").await?;
    let remotes: Vec<String> = remotes_output
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    let remote = if remotes.iter().any(|name| name == "origin") {
        "origin".to_string()
    } else if remotes.len() == 1 {
        remotes[0].clone()
    } else {
        bail!("could not determine the canonical remote (origin, or the only remote)");
    };
    Ok(Preflight {
        remote,
        remotes,
        published: String::new(),
    })
}

/// How many times publish reads the remote `main` before it refuses a checkout
/// that is ahead of or diverged from it.
///
/// An integration landing merges into the canonical checkout's `main` and then
/// pushes it, so a release that starts in that window sees a local tip the
/// remote does not carry yet. That push settles the checkout, so publish waits
/// for it instead of failing a release nothing is wrong with.
const MAIN_SETTLE_ATTEMPTS: u32 = 12;

/// The pause between those reads.
const MAIN_SETTLE_DELAY: Duration = Duration::from_secs(5);

/// How long one publish keeps integrating landings that move the checkout
/// underneath it before it leaves the range to the next tick.
///
/// A landing that publishes while the release suite runs, or between the
/// derivation and the push, settles a range the attempt derived and tested at
/// the older tip, so the run integrates the landing and derives again rather
/// than failing a release nothing is wrong with. The bound is time, not a
/// count of attempts: the suite takes longer than the gap between landings
/// whenever the integration checkout is busy, so a handful of attempts is
/// spent inside one landing burst — the observed failure integrated three
/// landings in twelve minutes and gave up with a quiet window a few minutes
/// away. This budget rides out a burst and still leaves the run's own bound
/// room for the last suite, the CI gate, and the asset propagation.
const RACE_INTEGRATION_BUDGET: Duration = Duration::from_secs(90 * 60);

/// The pause before an attempt derives again, so a landing's in-flight push
/// settles before the next suite starts.
const RACE_INTEGRATION_PAUSE: Duration = Duration::from_secs(5);

/// Fetches the canonical `main` and fast-forwards without discarding work.
///
/// `environment` is what every git command of this release runs with. The
/// checkout's own remote answers unless it cannot be reached: a detached
/// release holds no SSH agent, and its Gitea SSH server may be down, while the
/// configured Gitea HTTP address and token read and write the same repository.
/// That fallback is adopted on success and kept for the rest of the run,
/// because the tag and the pushes go to that remote too.
async fn refresh_main(
    args: &PublishArgs,
    runner: &dyn CommandRunner,
    remote: &str,
    environment: &mut Environment,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
    sleeper: &Arc<dyn Sleeper>,
) -> Result<String> {
    (log)(&format!("fetching {remote}/main"));
    let refspec = format!("+refs/heads/main:refs/remotes/{remote}/main");
    let fetch = ["fetch", "--prune", remote, refspec.as_str()];
    // No fallback once the run has adopted one: the environment it is handed
    // already reaches the remote through the configured address.
    let fallback = (environment == &args.environment)
        .then(|| forge::gitea_git_process_environment(&args.repo_dir, &args.environment))
        .flatten();
    let mut remaining = MAIN_SETTLE_ATTEMPTS;
    let mut waited = false;
    loop {
        let fetched = Git::new(runner, &args.repo_dir, environment)
            .run(&fetch)
            .await;
        let fetched = match fallback.as_ref() {
            Some(fallback) if fetched.code != 0 => {
                (log)(&format!(
                    "{remote}/main could not be fetched through its own URL; reading it through \
                     the configured Gitea HTTP address"
                ));
                let retried = Git::new(runner, &args.repo_dir, fallback).run(&fetch).await;
                if retried.code == 0 {
                    *environment = fallback.clone();
                }
                retried
            }
            _ => fetched,
        };
        if fetched.code != 0 {
            bail!(
                "could not fetch {remote}/main: {}",
                first_line(if fetched.stderr.is_empty() {
                    fetched.stdout.as_str()
                } else {
                    fetched.stderr.as_str()
                })
            );
        }

        let git = Git::new(runner, &args.repo_dir, environment);
        let head = git
            .must(&["rev-parse", "HEAD"], "could not read HEAD")
            .await?;
        let tip = git
            .must(
                &["rev-parse", &format!("{remote}/main")],
                &format!("could not read {remote}/main"),
            )
            .await?;
        if head == tip {
            (log)(&format!("main is at {}", short_sha(&head)));
            break;
        }
        if !git.is_ancestor(&head, &tip).await {
            remaining -= 1;
            if remaining == 0 {
                bail!(
                    "local main is ahead of or diverged from {remote}/main; integrate and push the worktree first"
                );
            }
            if !waited {
                waited = true;
                (log)(&format!(
                    "local main is ahead of {remote}/main; waiting for the landing push to settle"
                ));
            }
            sleeper.sleep(MAIN_SETTLE_DELAY).await;
            continue;
        }
        let dirty = git
            .must(
                &["diff", "--name-only"],
                "could not read uncommitted changes",
            )
            .await?;
        let incoming = git
            .must(
                &["diff", "--name-only", "HEAD", &format!("{remote}/main")],
                "could not read the incoming changes",
            )
            .await?;
        let incoming: HashSet<&str> = incoming
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let blocking: Vec<&str> = dirty
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty() && incoming.contains(line))
            .collect();
        if !blocking.is_empty() {
            bail!(
                "uncommitted changes would block the fast-forward: {}. Keep those edits, apply the published revision, then rerun.",
                blocking.join(", ")
            );
        }
        (log)(&format!("fast-forwarding main to {}", short_sha(&tip)));
        let merged = git
            .run(&["merge", "--ff-only", &format!("{remote}/main")])
            .await;
        if merged.code != 0 {
            bail!(
                "could not fast-forward main: {}",
                first_line(if merged.stderr.is_empty() {
                    merged.stdout.as_str()
                } else {
                    merged.stderr.as_str()
                })
            );
        }
        break;
    }

    Git::new(runner, &args.repo_dir, environment)
        .must(
            &["rev-parse", "HEAD"],
            "could not read HEAD after the update",
        )
        .await
}

async fn resolve_gitea_target(
    args: &PublishArgs,
    runner: &dyn CommandRunner,
    remote: &str,
) -> Result<GiteaTarget> {
    let git = Git::new(runner, &args.repo_dir, &args.environment);
    let origin = git.run(&["remote", "get-url", remote]).await.stdout;
    let parsed = forge::parse_forge_remote(&origin, &args.environment);
    let project = configured_project(
        args.environment
            .get("DEVBOARD_RELEASE_REPO")
            .map(String::as_str),
    );
    let target = forge::gitea_target(parsed.as_ref(), project, None, None, &args.environment)
        .map_err(|error| anyhow!(error.to_string()))?;
    Ok(GiteaTarget {
        base_url: target.base_url,
        project: target.project,
        token: target.token,
    })
}

// ---------------------------------------------------------------------------
// Derivation

async fn derive_release_version(git: &Git<'_>, head: &str) -> Result<ReleaseDerivation> {
    let previous = git.previous_release_tag(head).await;
    let range = previous
        .as_ref()
        .map(|tag| format!("{}..{head}", tag.tag))
        .unwrap_or_else(|| head.to_string());
    let commits = git.read_commits(&range).await?;
    let level = release_level(&commits);
    let version = next_release_version(previous.as_ref().map(|tag| tag.version.as_str()), level);
    Ok(ReleaseDerivation {
        version,
        previous,
        level,
        range,
        commits,
    })
}

async fn rederive_from_published(
    git: &Git<'_>,
    api: &Api,
    head: &str,
    newest: &str,
    refresh_problem: Option<&str>,
) -> Result<ReleaseDerivation> {
    let tag = format!("v{newest}");
    let local = git.tag_commit(&tag).await;
    let commit = match local {
        Some(commit) => Some(commit),
        None => api.gitea_tag_commit(&tag).await.unwrap_or(None),
    };
    let Some(commit) = commit else {
        bail!(
            "the newest published release {tag} is not in this checkout and its commit could not be read; {}",
            refresh_problem.unwrap_or("fetch the release tags and run the release again")
        );
    };
    let range = format!("{commit}..{head}");
    let commits = match git.read_commits(&range).await {
        Ok(commits) => commits,
        Err(_) => bail!(
            "the newest published release {tag} names {}, which this checkout cannot read; {}",
            short_sha(&commit),
            refresh_problem.unwrap_or("fetch the release tags and run the release again")
        ),
    };
    let level = release_level(&commits);
    Ok(ReleaseDerivation {
        version: next_release_version(Some(newest), level),
        previous: Some(ReleaseTag {
            tag,
            version: newest.to_string(),
        }),
        level,
        range,
        commits,
    })
}

/// One commit whose subject breaks the Conventional Commit grammar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitViolation {
    pub sha: String,
    pub subject: String,
    pub rule: String,
}

/// Every non-merge commit whose subject breaks the grammar.
pub fn commit_violations(commits: &[CommitRecord]) -> Vec<CommitViolation> {
    let mut violations = Vec::new();
    for commit in commits {
        if is_merge_commit(commit) {
            continue;
        }
        if let Some(rule) = subject_rule(&commit.subject) {
            violations.push(CommitViolation {
                sha: commit.sha.clone(),
                subject: commit.subject.clone(),
                rule,
            });
        }
    }
    violations
}

async fn refresh_lockfile(
    runner: &dyn CommandRunner,
    environment: &Environment,
    root: &Path,
) -> Result<()> {
    if !root.join("Cargo.toml").is_file() || !root.join("Cargo.lock").is_file() {
        return Ok(());
    }
    let outcome = runner
        .run(CommandInvocation {
            program: "cargo".to_string(),
            args: vec!["metadata".to_string(), "--format-version=1".to_string()],
            cwd: root.to_path_buf(),
            env: environment.clone(),
            timeout: Duration::from_secs(600),
        })
        .await;
    if outcome.code != 0 {
        bail!(
            "could not refresh Cargo.lock: {}",
            first_line(if outcome.stderr.is_empty() {
                outcome.stdout.as_str()
            } else {
                outcome.stderr.as_str()
            })
        );
    }
    Ok(())
}

/// The version `[workspace.package]` declares, when the manifest carries one.
fn workspace_version(path: &Path) -> Option<String> {
    let source = std::fs::read_to_string(path).ok()?;
    let line_pattern =
        Regex::new(r#"^(\s*version\s*=\s*")([^"]*)(".*)$"#).expect("the workspace version line");
    let mut in_section = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed == "[workspace.package]" {
            in_section = true;
            continue;
        }
        if in_section && trimmed.starts_with('[') {
            return None;
        }
        if in_section {
            if let Some(captures) = line_pattern.captures(line) {
                return captures.get(2).map(|value| value.as_str().to_string());
            }
        }
    }
    None
}

fn bump_workspace_version(path: &Path, version: &str) -> Result<()> {
    let source = std::fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path.display()))?;
    let line_pattern =
        Regex::new(r#"^(\s*version\s*=\s*")([^"]*)(".*)$"#).expect("the workspace version line");
    let mut in_section = false;
    let mut replaced = false;
    let mut lines: Vec<String> = Vec::new();
    for line in source.split_inclusive('\n') {
        let without_newline = line.trim_end_matches(['\n', '\r']);
        let trimmed = without_newline.trim();
        if trimmed == "[workspace.package]" {
            in_section = true;
            lines.push(line.to_string());
            continue;
        }
        if in_section && trimmed.starts_with('[') {
            in_section = false;
        }
        if in_section {
            if let Some(captures) = line_pattern.captures(without_newline) {
                let replacement = format!(
                    "{}{}{}",
                    captures.get(1).map(|value| value.as_str()).unwrap_or(""),
                    version,
                    captures.get(3).map(|value| value.as_str()).unwrap_or("")
                );
                lines.push(format!("{replacement}{}", &line[without_newline.len()..]));
                replaced = true;
                continue;
            }
        }
        lines.push(line.to_string());
    }
    if !replaced {
        bail!("{} has no [workspace.package] version", path.display());
    }
    std::fs::write(path, lines.concat())
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

/// Removes the tag of a release that did not ship.
///
/// The release gate derives the next version from the newest release tag, so a
/// tag whose release never appeared would advance the range past a version
/// that carries no artifacts. A tag whose release does exist is a real
/// release and is never withdrawn.
async fn withdraw_unreleased_tag(
    api: &Api,
    git: &Git<'_>,
    preflight: &Preflight,
    tag: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) {
    match api.github_release_by_tag(tag).await {
        Ok(None) => {}
        Ok(Some(_)) => {
            (log)(&format!(
                "keeping {tag}: its release exists although the run did not settle"
            ));
            return;
        }
        Err(error) => {
            (log)(&format!(
                "keeping {tag}: its release could not be read ({})",
                first_line(&format!("{error:#}"))
            ));
            return;
        }
    }
    delete_tag(git, preflight, tag, log).await;
    (log)(&format!("withdrew {tag}: the release did not ship"));
}

/// Deletes a tag from every remote and from the checkout.
///
/// A remote that does not carry the tag answers the deletion with a warning and
/// a zero exit, so every remote is named without a read first.
async fn delete_tag(
    git: &Git<'_>,
    preflight: &Preflight,
    tag: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) {
    for remote in &preflight.remotes {
        let deleted = git
            .run(&["push", remote.as_str(), &format!(":refs/tags/{tag}")])
            .await;
        if deleted.code != 0 {
            (log)(&format!(
                "could not withdraw {tag} from {remote}: {}",
                first_line(if deleted.stderr.is_empty() {
                    deleted.stdout.as_str()
                } else {
                    deleted.stderr.as_str()
                })
            ));
        }
    }
    let local = git.run(&["tag", "-d", tag]).await;
    if local.code != 0 {
        (log)(&format!(
            "could not withdraw the local {tag}: {}",
            first_line(if local.stderr.is_empty() {
                local.stdout.as_str()
            } else {
                local.stderr.as_str()
            })
        ));
    }
}

/// Reads the remote `main` after a refused push and returns its tip when a
/// landing published past the base this attempt pushed from.
///
/// `None` means the remote `main` the attempt pushed from is unchanged, so the
/// refusal is not a landing and the release fails with the push's own detail.
async fn landed_main_tip(git: &Git<'_>, remote: &str, base: &str) -> Result<Option<String>> {
    let fetched = git
        .run(&[
            "fetch",
            "--prune",
            remote,
            &format!("+refs/heads/main:refs/remotes/{remote}/main"),
        ])
        .await;
    if fetched.code != 0 {
        bail!(
            "could not fetch {remote}/main after the refused push: {}",
            first_line(if fetched.stderr.is_empty() {
                fetched.stdout.as_str()
            } else {
                fetched.stderr.as_str()
            })
        );
    }
    let tip = git
        .must(
            &["rev-parse", &format!("{remote}/main")],
            &format!("could not read {remote}/main"),
        )
        .await?;
    let tip = tip.trim().to_string();
    if tip == base || git.is_ancestor(&tip, base).await {
        return Ok(None);
    }
    if !git.is_ancestor(base, &tip).await {
        bail!(
            "{remote}/main moved to {} and no longer contains {}; integrate the checkout and rerun",
            short_sha(&tip),
            short_sha(base)
        );
    }
    Ok(Some(tip))
}

/// Reads the commit a remote's tag names, peeled from the tag object.
///
/// `None` means the remote does not carry the tag at all. The remotes answer
/// this, not the forge's API: a refused push can deliver the tag before the
/// branch is rejected, and the next attempt's tag refresh would resurrect a
/// local tag the remotes still carry.
async fn remote_tag_commit(git: &Git<'_>, remote: &str, tag: &str) -> Result<Option<String>> {
    let reference = format!("refs/tags/{tag}");
    let peeled = format!("refs/tags/{tag}^{{}}");
    let listed = git
        .must(
            &["ls-remote", "--tags", remote, &reference, &peeled],
            &format!("could not read {tag} from {remote}"),
        )
        .await?;
    let mut object = None;
    let mut commit = None;
    for line in listed.split('\n') {
        let mut fields = line.split_whitespace();
        let Some(sha) = fields.next() else { continue };
        let Some(name) = fields.next() else { continue };
        if name == peeled {
            commit = Some(sha.to_string());
        } else if name == reference {
            object = Some(sha.to_string());
        }
    }
    // An annotated tag peels to the commit its release names; a lightweight tag
    // is already that commit.
    Ok(commit.or(object))
}

/// Withdraws the tag a refused attempt pushed before the next attempt derives.
///
/// The tag was created by this attempt, so no release can name it: the dispatch
/// runs only after the push that was refused. It is deleted from every remote
/// that carries it and from the checkout, because the next attempt's tag
/// refresh would otherwise resurrect it and the next derivation would skip the
/// range it covers. A remote carrying the tag at another commit belongs to
/// another release: it is never removed, and the release fails instead.
async fn withdraw_refused_tag(
    git: &Git<'_>,
    preflight: &Preflight,
    tag: &str,
    commit: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<()> {
    for remote in &preflight.remotes {
        let Some(named) = remote_tag_commit(git, remote, tag).await? else {
            continue;
        };
        if named != commit {
            bail!(
                "{} carries {tag} at {}, not this attempt's {}; refusing to release it",
                remote,
                short_sha(&named),
                short_sha(commit)
            );
        }
    }
    delete_tag(git, preflight, tag, log).await;
    (log)(&format!(
        "withdrew {tag}: the push that would have shipped it was refused"
    ));
    Ok(())
}

fn relative_git_path(repo_dir: &Path, path: &Path) -> String {
    path.strip_prefix(repo_dir)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// GitHub workflow selection and waiting

/// One refused `workflow_dispatch`, typed so a transient refusal can be
/// retried while a permanent one fails the run immediately.
#[derive(Debug)]
struct GithubDispatchError {
    status: u16,
    url: String,
    message: String,
}

impl std::fmt::Display for GithubDispatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "POST {} failed (HTTP {}): {}",
            self.url, self.status, self.message
        )
    }
}

impl std::error::Error for GithubDispatchError {}

/// A dispatch the same request may succeed at: GitHub answered a rate limit
/// or a server-side failure rather than refusing the request itself.
fn transient_dispatch(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<GithubDispatchError>()
        .map(|error| transient_status(error.status))
        .unwrap_or(false)
}

struct DispatchAttempt {
    dispatched: bool,
    previous_ids: HashSet<u64>,
}

async fn dispatch_release_when_needed(
    api: &Api,
    commit: &str,
    tag: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<DispatchAttempt> {
    let runs = api.github_runs(BUILD_WORKFLOW, commit).await?;
    let matching: Vec<&WorkflowRun> = runs.iter().filter(|run| run.head_sha == commit).collect();
    let previous_ids: HashSet<u64> = matching.iter().map(|run| run.id).collect();
    if matching.iter().any(|run| !workflow_finished(run)) {
        return Ok(DispatchAttempt {
            dispatched: false,
            previous_ids,
        });
    }
    if matching
        .iter()
        .any(|run| run.conclusion.as_deref() == Some("success"))
    {
        return Ok(DispatchAttempt {
            dispatched: false,
            previous_ids,
        });
    }
    api.github_dispatch_at(BUILD_WORKFLOW, &build_ref(tag), Some(json!({ "tag": tag })))
        .await
        .with_context(|| {
            format!(
                "could not dispatch {BUILD_WORKFLOW} for {}",
                short_sha(commit)
            )
        })?;
    (log)(&format!(
        "dispatched {BUILD_WORKFLOW} at {} for {}",
        build_ref(tag),
        short_sha(commit)
    ));
    Ok(DispatchAttempt {
        dispatched: true,
        previous_ids,
    })
}

/// Reads the release workflow runs for one commit and selects the run to follow.
///
/// The dispatch's own run is identified by the ids captured before it, so a
/// finished run from an earlier attempt is never mistaken for this wait.
async fn follow_release_run(
    api: &Api,
    attempt: &DispatchAttempt,
    commit: &str,
) -> Result<Option<WorkflowRun>> {
    let runs = api.github_runs(BUILD_WORKFLOW, commit).await?;
    let candidates: Vec<WorkflowRun> = if attempt.dispatched {
        runs.into_iter()
            .filter(|run| !attempt.previous_ids.contains(&run.id))
            .collect()
    } else {
        runs
    };
    Ok(choose_workflow_run(&candidates, commit))
}

async fn dispatch_and_wait(
    api: &Api,
    clock: &Arc<dyn Clock>,
    sleeper: &Arc<dyn Sleeper>,
    args: &PublishArgs,
    commit: &str,
    tag: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<u64> {
    (log)(&format!(
        "waiting for the release workflow of {}",
        short_sha(commit)
    ));
    let deadline = clock.now_millis() + args.wait_timeout.as_millis() as i64;
    let attempt = loop {
        match dispatch_release_when_needed(api, commit, tag, log).await {
            Ok(attempt) => break attempt,
            Err(error) => {
                if !transient_dispatch(&error) || clock.now_millis() >= deadline {
                    return Err(error);
                }
                (log)(&format!(
                    "the release workflow dispatch is temporarily refused ({error:#}); retrying"
                ));
                sleeper.sleep(args.poll_interval).await;
            }
        }
    };
    let mut selected: Option<WorkflowRun> = None;
    let mut last_error: Option<String> = None;
    loop {
        if clock.now_millis() >= deadline {
            break;
        }
        match follow_release_run(api, &attempt, commit).await {
            Ok(Some(run)) => {
                let finished = workflow_finished(&run);
                selected = Some(run);
                if finished {
                    break;
                }
            }
            Ok(None) => {}
            Err(error) => {
                let text = format!("{error:#}");
                if last_error.as_deref() != Some(text.as_str()) {
                    (log)(&format!("the release workflow read failed: {text}"));
                    last_error = Some(text);
                }
            }
        }
        sleeper.sleep(args.poll_interval).await;
    }
    // The bound can expire while the process was stalled — a suspended host
    // resumes with the deadline already passed — or during the last poll
    // interval, so an unfinished selection is read once more instead of
    // deciding the verdict on a snapshot that predates a finish.
    if !selected.as_ref().is_some_and(workflow_finished) {
        match follow_release_run(api, &attempt, commit).await {
            Ok(Some(run)) => selected = Some(run),
            Ok(None) => {}
            Err(error) => last_error = Some(format!("{error:#}")),
        }
    }
    let Some(workflow) = selected else {
        if let Some(error) = last_error {
            bail!(
                "no release workflow run for {} could be read within the wait: {error}",
                short_sha(commit)
            );
        }
        bail!(
            "no release workflow run for {} within the wait",
            short_sha(commit)
        );
    };
    if !workflow_finished(&workflow) {
        bail!(
            "no release workflow run for {} settled within the wait",
            short_sha(commit)
        );
    }
    let concluded = workflow
        .conclusion
        .clone()
        .unwrap_or_else(|| workflow.status.clone());
    if concluded != "success" && workflow.status != "success" {
        let concluded = if concluded.is_empty() {
            "no conclusion".to_string()
        } else {
            concluded
        };
        // A failed matrix job cancels its queued siblings, and GitHub can then
        // settle the run itself as `cancelled`, so the job detail is the only
        // place the cause appears. A refused job read keeps the run verdict.
        let jobs = api.github_jobs(workflow.id).await.unwrap_or_default();
        return match failed_jobs_detail(&jobs) {
            Some(detail) => Err(anyhow!(
                "the release workflow concluded {concluded}: {detail}"
            )),
            None => Err(anyhow!("the release workflow concluded {concluded}")),
        };
    }
    (log)(&format!("release workflow {} succeeded", workflow.id));
    Ok(workflow.id)
}

/// Waits for the target commit's `devboard-ci.yml` run to conclude success.
///
/// The tag is pushed only after the canonical forge proves the exact commit
/// the tag names. A settled failure of any kind — `failure`, `cancelled`,
/// `timed_out`, `startup_failure`, or any other non-success conclusion — is
/// re-run once through the forge first: the commit is already on the branch,
/// so no later push can produce a second run, and without the restart a
/// single failure of an unchanged commit would refuse every later attempt of
/// the same range forever. The re-run gets the same bound; a refusal, or a
/// re-run that settles without success, refuses the release without pushing
/// the tag. A commit with no run yet is waited for; after the documented
/// bound the release is refused the same way.
async fn wait_for_ci_success(
    api: &Api,
    clock: &Arc<dyn Clock>,
    sleeper: &Arc<dyn Sleeper>,
    args: &PublishArgs,
    commit: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<u64> {
    let bound = args.wait_timeout.as_secs();
    (log)(&format!(
        "waiting up to {bound}s for the {CI_WORKFLOW} run of {}",
        short_sha(commit)
    ));
    let mut deadline = clock.now_millis() + args.wait_timeout.as_millis() as i64;
    let mut last_error: Option<String> = None;
    // The run already restarted in this call, and whether its fresh attempt
    // has been visible since. The snapshot that still describes the settled
    // run right after the restart is never the re-run's verdict.
    let mut rerun: Option<u64> = None;
    let mut rerun_live = false;
    loop {
        match api.gitea_ci_runs(commit).await {
            Ok(runs) => {
                if let Some(success) = runs
                    .iter()
                    .find(|run| run.conclusion.as_deref() == Some("success"))
                {
                    (log)(&format!(
                        "CI run {} for {} concluded success",
                        success.id,
                        short_sha(commit)
                    ));
                    return Ok(success.id);
                }
                if runs.iter().any(|run| !workflow_finished(run)) {
                    if rerun.is_some() {
                        rerun_live = true;
                    }
                } else if let Some(settled) = runs.iter().max_by_key(|run| run.id) {
                    let conclusion = ci_conclusion(settled);
                    match rerun {
                        None => match api.gitea_ci_rerun(settled.id).await {
                            Ok(()) => {
                                (log)(&format!(
                                    "re-running the {CI_WORKFLOW} run {} for {} once after it concluded {conclusion}",
                                    settled.id,
                                    short_sha(commit)
                                ));
                                rerun = Some(settled.id);
                                deadline =
                                    clock.now_millis() + args.wait_timeout.as_millis() as i64;
                            }
                            Err(error) => {
                                let detail = ci_failed_jobs(api, settled.id).await;
                                bail!(
                                    "the {CI_WORKFLOW} run {} for {} concluded {conclusion}{detail}; its re-run was refused: {error:#}; no tag was pushed",
                                    settled.id,
                                    short_sha(commit)
                                )
                            }
                        },
                        Some(_) if !rerun_live => {}
                        Some(_) => {
                            let detail = ci_failed_jobs(api, settled.id).await;
                            bail!(
                                "the {CI_WORKFLOW} run {} for {} concluded {conclusion} after one re-run{detail}; no tag was pushed",
                                settled.id,
                                short_sha(commit)
                            )
                        }
                    }
                }
            }
            Err(error) => {
                let text = format!("{error:#}");
                if last_error.as_deref() != Some(text.as_str()) {
                    (log)(&format!("the {CI_WORKFLOW} read failed: {text}"));
                    last_error = Some(text);
                }
            }
        }
        if clock.now_millis() >= deadline {
            if let Ok(runs) = api.gitea_ci_runs(commit).await {
                if let Some(success) = runs
                    .iter()
                    .find(|run| run.conclusion.as_deref() == Some("success"))
                {
                    (log)(&format!(
                        "CI run {} for {} concluded success",
                        success.id,
                        short_sha(commit)
                    ));
                    return Ok(success.id);
                }
                if let Some(settled) = runs.iter().find(|run| workflow_finished(run)) {
                    let conclusion = ci_conclusion(settled);
                    let detail = ci_failed_jobs(api, settled.id).await;
                    bail!(
                        "the {CI_WORKFLOW} run {} for {} concluded {conclusion}{detail}; no tag was pushed",
                        settled.id,
                        short_sha(commit)
                    );
                }
            }
            bail!(
                "no {CI_WORKFLOW} run for {} concluded success within {bound}s; no tag was pushed",
                short_sha(commit)
            );
        }
        sleeper.sleep(args.poll_interval).await;
    }
}

/// What a settled non-success run adds to its refusal: `: <job and step>`
/// when the forge answers the job read, and nothing when that read is
/// refused. The run verdict stands in either case.
async fn ci_failed_jobs(api: &Api, run_id: u64) -> String {
    let jobs = api.gitea_ci_jobs(run_id).await.unwrap_or_default();
    match failed_jobs_detail(&jobs) {
        Some(detail) => format!(": {detail}"),
        None => String::new(),
    }
}

/// The verdict one settled run reports: its conclusion, else its status.
fn ci_conclusion(run: &WorkflowRun) -> String {
    let conclusion = run.conclusion.clone().unwrap_or_else(|| run.status.clone());
    if conclusion.is_empty() {
        "no conclusion".to_string()
    } else {
        conclusion
    }
}

// ---------------------------------------------------------------------------
// GitHub assets

fn asset_field<'a>(asset: &'a Value, key: &str) -> Option<&'a str> {
    asset.get(key).and_then(Value::as_str)
}

fn release_asset_url(asset: &Value) -> Option<String> {
    // The API asset URL honors the token and the octet-stream Accept header;
    // the browser URL redirects to a signed storage address that a private
    // repository's token cannot follow reliably.
    asset_field(asset, "url")
        .or_else(|| asset_field(asset, "browser_download_url"))
        .map(str::to_string)
}

/// The address a consumer downloads an asset from: the public browser
/// download URL, never the API URL that needs a token and an Accept header.
fn public_asset_url(asset: &Value) -> Option<String> {
    asset_field(asset, "browser_download_url")
        .or_else(|| asset_field(asset, "url"))
        .map(str::to_string)
}

fn asset_sha256(asset: &Value) -> Option<String> {
    let digest = asset_field(asset, "digest")?;
    let digest = digest.strip_prefix("sha256:")?;
    if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(digest.to_ascii_lowercase())
    } else {
        None
    }
}

fn release_assets(release: &Value) -> Vec<Value> {
    release
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The identifier one Gitea release document carries.
fn release_identifier(release: &Value, tag: &str) -> Result<u64> {
    release
        .get("id")
        .and_then(Value::as_u64)
        .with_context(|| format!("the Gitea release {tag} has no identifier"))
}

fn find_asset<'a>(assets: &'a [Value], name: &str) -> Option<&'a Value> {
    assets
        .iter()
        .find(|asset| asset_field(asset, "name") == Some(name))
}

async fn verify_github_assets(
    api: &Api,
    clock: &Arc<dyn Clock>,
    sleeper: &Arc<dyn Sleeper>,
    args: &PublishArgs,
    tag: &str,
    version: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<VerifiedAssets> {
    let deadline = clock.now_millis() + args.wait_timeout.as_millis() as i64;
    loop {
        let attempt = tokio::time::timeout(
            Duration::from_secs(120),
            verify_github_assets_once(api, tag, version),
        );
        let attempt = match attempt.await {
            Ok(result) => result,
            Err(_) => Err(anyhow!("asset verification timed out")),
        };
        match attempt {
            Ok(verified) => {
                (log)(&format!(
                    "verified {} GitHub asset(s) for {tag}",
                    verified.names.len()
                ));
                return Ok(verified);
            }
            Err(error) => {
                if clock.now_millis() >= deadline {
                    return Err(anyhow!("GitHub assets: {error}"));
                }
                sleeper.sleep(args.poll_interval).await;
            }
        }
    }
}

async fn verify_github_assets_once(api: &Api, tag: &str, version: &str) -> Result<VerifiedAssets> {
    let release = api
        .github_release_by_tag(tag)
        .await?
        .ok_or_else(|| anyhow!("the release {tag} does not exist"))?;
    let assets = release_assets(&release);
    let unified_name = "sha256.sum";
    let unified_asset = find_asset(&assets, unified_name)
        .ok_or_else(|| anyhow!("the release is missing {unified_name}"))?;
    let unified_url = release_asset_url(unified_asset)
        .ok_or_else(|| anyhow!("{unified_name} has no download address"))?;
    let unified_bytes = api.download(&unified_url, false).await?;
    let unified = parse_unified_checksums(&String::from_utf8_lossy(&unified_bytes));
    let mut manifest_assets = Vec::new();
    let mut checksums = vec![(unified_name.to_string(), unified_bytes)];
    let mut names = Vec::new();
    for target in RELEASE_TARGETS {
        let name = format!("devboard-{target}.tar.xz");
        let (_, digest, checksum) = verify_one_asset(api, &assets, &name).await?;
        let asset =
            find_asset(&assets, &name).ok_or_else(|| anyhow!("the release is missing {name}"))?;
        let url = public_asset_url(asset)
            .ok_or_else(|| anyhow!("{name} has no public download address"))?;
        manifest_assets.push(json!({
            "target": target,
            "url": url,
            "sha256": digest,
        }));
        checksums.push((format!("{name}.sha256"), checksum));
        names.push(name);
    }
    for installer in RELEASE_INSTALLERS {
        verify_installer_asset(api, &assets, installer, &unified).await?;
        names.push(installer.to_string());
    }
    let manifest_value = json!({
        "version": version,
        "tag": tag,
        "assets": manifest_assets,
    });
    let manifest = jsjson::stringify(&manifest_value).into_bytes();
    let manifest_digest = sha256_hex(&manifest);
    let manifest_checksum = format!("{manifest_digest}  {MANIFEST_ASSET}\n").into_bytes();
    Ok(VerifiedAssets {
        manifest,
        manifest_digest,
        manifest_checksum,
        checksums,
        names,
    })
}

async fn verify_one_asset(
    api: &Api,
    assets: &[Value],
    name: &str,
) -> Result<(String, String, Vec<u8>)> {
    let asset = find_asset(assets, name).ok_or_else(|| anyhow!("the release is missing {name}"))?;
    let url = release_asset_url(asset).ok_or_else(|| anyhow!("{name} has no download address"))?;
    let digest = match asset_sha256(asset) {
        Some(digest) => digest,
        None => sha256_hex(&api.download(&url, false).await?),
    };
    let checksum_name = format!("{name}.sha256");
    let checksum_asset = find_asset(assets, &checksum_name)
        .ok_or_else(|| anyhow!("the release is missing {checksum_name}"))?;
    let checksum_url = release_asset_url(checksum_asset)
        .ok_or_else(|| anyhow!("{checksum_name} has no download address"))?;
    let checksum_bytes = api.download(&checksum_url, false).await?;
    let text = String::from_utf8_lossy(&checksum_bytes);
    let expected = parse_checksum(&text)
        .ok_or_else(|| anyhow!("{checksum_name} carries no SHA-256 digest"))?;
    if expected != digest {
        bail!("{name} does not match its checksum asset");
    }
    Ok((url, digest, checksum_bytes))
}

async fn verify_installer_asset(
    api: &Api,
    assets: &[Value],
    name: &str,
    unified: &HashMap<String, String>,
) -> Result<()> {
    let asset = find_asset(assets, name).ok_or_else(|| anyhow!("the release is missing {name}"))?;
    let url = release_asset_url(asset).ok_or_else(|| anyhow!("{name} has no download address"))?;
    let digest = match asset_sha256(asset) {
        Some(digest) => digest,
        None => sha256_hex(&api.download(&url, false).await?),
    };
    let expected = unified.get(name).or_else(|| {
        Path::new(name)
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|value| unified.get(value))
    });
    if let Some(expected) = expected {
        if expected != &digest {
            bail!("{name} does not match sha256.sum");
        }
    }
    Ok(())
}

fn parse_unified_checksums(text: &str) -> HashMap<String, String> {
    let mut sums = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(digest) = parts.next() else {
            continue;
        };
        let Some(path) = parts.next() else {
            continue;
        };
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let path = path.trim_start_matches('*');
        sums.insert(path.to_string(), digest.to_ascii_lowercase());
    }
    sums
}

fn parse_checksum(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let trimmed = token.trim_start_matches('*');
        if trimmed.len() == 64 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Some(trimmed.to_ascii_lowercase());
        }
    }
    None
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

// ---------------------------------------------------------------------------
// Gitea release write

async fn write_gitea_release(
    api: &Api,
    git: &Git<'_>,
    version: &str,
    tag: &str,
    commit: &str,
    verified: &VerifiedAssets,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<()> {
    let mut expected: Vec<(String, Vec<u8>)> = vec![
        (MANIFEST_ASSET.to_string(), verified.manifest.clone()),
        (
            MANIFEST_CHECKSUM_ASSET.to_string(),
            verified.manifest_checksum.clone(),
        ),
    ];
    expected.extend(verified.checksums.iter().cloned());

    let existing = api.gitea_release_by_tag(tag).await?;
    let _release_id = match existing {
        Some(release) => {
            let named = api.gitea_tag_commit(tag).await?;
            let carries = match named.as_deref() {
                Some(named) => git.commit_names_or_contains(named, commit).await,
                None => false,
            };
            if !carries {
                bail!(
                    "{tag} already names {}, which neither names nor contains {}; the existing release does not carry this commit",
                    named.as_deref().map(short_sha).unwrap_or_else(|| "a commit this step cannot read".to_string()),
                    short_sha(commit)
                );
            }
            let id = release
                .get("id")
                .and_then(Value::as_u64)
                .ok_or_else(|| anyhow!("release {tag} has no identifier"))?;
            let names: HashSet<String> = release_assets(&release)
                .iter()
                .filter_map(|asset| asset_field(asset, "name").map(str::to_string))
                .collect();
            let mut uploaded = 0usize;
            for (name, bytes) in &expected {
                if names.contains(name) {
                    continue;
                }
                api.gitea_upload(id, name, bytes.clone()).await?;
                uploaded += 1;
            }
            if uploaded == 0 {
                (log)(&format!("{tag} already exists; its assets are intact"));
            } else {
                (log)(&format!("uploaded {uploaded} missing asset(s) to {tag}"));
            }
            id
        }
        None => {
            if api.gitea.token.as_deref().unwrap_or("").is_empty() {
                bail!("GITEA_TOKEN is required to create a release");
            }
            let id = api.gitea_create_release(tag, version, commit).await?;
            for (name, bytes) in &expected {
                api.gitea_upload(id, name, bytes.clone()).await?;
            }
            (log)(&format!(
                "created {tag} with the manifest and {} checksum asset(s)",
                expected.len() - 1
            ));
            id
        }
    };

    let release = api
        .gitea_release_by_tag(tag)
        .await?
        .ok_or_else(|| anyhow!("the Gitea release {tag} disappeared after the write"))?;
    let assets = release_assets(&release);
    for (name, _) in &expected {
        if find_asset(&assets, name).is_none() {
            bail!("the Gitea release {tag} is missing {name}");
        }
    }
    let manifest_asset = find_asset(&assets, MANIFEST_ASSET)
        .ok_or_else(|| anyhow!("the Gitea release {tag} is missing {MANIFEST_ASSET}"))?;
    let manifest_url = release_asset_url(manifest_asset)
        .ok_or_else(|| anyhow!("{MANIFEST_ASSET} has no download address"))?;
    let downloaded = api.download(&manifest_url, true).await?;
    if downloaded != verified.manifest {
        bail!("the Gitea manifest asset does not match the manifest that was written");
    }
    let checksum_asset = find_asset(&assets, MANIFEST_CHECKSUM_ASSET)
        .ok_or_else(|| anyhow!("the Gitea release {tag} is missing {MANIFEST_CHECKSUM_ASSET}"))?;
    let checksum_url = release_asset_url(checksum_asset)
        .ok_or_else(|| anyhow!("{MANIFEST_CHECKSUM_ASSET} has no download address"))?;
    let checksum = api.download(&checksum_url, true).await?;
    let text = String::from_utf8_lossy(&checksum);
    if parse_checksum(&text).as_deref() != Some(verified.manifest_digest.as_str()) {
        bail!("the Gitea manifest checksum does not match the manifest");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// GitHub mirror

/// Pushes the canonical commit to the temporary GitHub build ref.
///
/// The ref exists only for the build: publish deletes it after the release tag
/// is moved to an empty-tree commit, so no lasting GitHub ref reaches harness
/// source.
async fn push_github_build_ref(
    git: &Git<'_>,
    environment: &Environment,
    commit: &str,
    tag: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<()> {
    let reference = build_ref(tag);
    // `gh` is where the environment's PATH finds it: a host installs it under
    // Homebrew, a version manager, or a nonstandard prefix, and an absolute
    // host path would make the push depend on one machine's layout.
    let Some(gh) = crate::forge::find_on_path("gh", environment) else {
        bail!("pushing the GitHub build ref {reference} needs `gh` on PATH, and none was found");
    };
    let helper = format!(
        "credential.https://github.com.helper=!{} auth git-credential",
        gh.display()
    );
    (log)(&format!(
        "pushing {} to the GitHub build ref {reference}",
        short_sha(commit)
    ));
    let pushed = git
        .run(&[
            "-c",
            "credential.helper=",
            "-c",
            &helper,
            "push",
            "github",
            &format!("{commit}:{reference}"),
        ])
        .await;
    if pushed.code != 0 {
        bail!(
            "could not push the canonical source to {reference}: {}",
            failure_detail(&pushed)
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Canonical remote push

// ---------------------------------------------------------------------------
// Source refresh

/// The deterministic SHA-256 of a built bundle tree.
///
/// Every relative path and its bytes, in path order, with a NUL between the
/// path, the bytes, and the next file. Identical output digests identically;
/// added, removed, renamed, or edited files never do.
pub fn dist_digest(directory: &Path) -> Result<String> {
    let root = std::fs::canonicalize(directory)
        .with_context(|| format!("the bundle directory is missing at {}", directory.display()))?;
    if !root.is_dir() {
        bail!("the bundle directory is missing at {}", directory.display());
    }
    let mut files = BTreeMap::new();
    collect_files(&root, "", &mut files)?;
    let mut hasher = Sha256::new();
    for (relative, path) in files {
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        let bytes =
            std::fs::read(&path).with_context(|| format!("could not read {}", path.display()))?;
        hasher.update(&bytes);
        hasher.update([0u8]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn collect_files(
    directory: &Path,
    prefix: &str,
    files: &mut BTreeMap<String, PathBuf>,
) -> Result<()> {
    let entries = std::fs::read_dir(directory)
        .with_context(|| format!("could not read {}", directory.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("could not read {}", directory.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_files(&entry.path(), &relative, files)?;
        } else if file_type.is_file() {
            files.insert(relative, entry.path());
        }
    }
    Ok(())
}

fn source_refresh_directory(state_dir: &Path) -> PathBuf {
    state_dir.join(SOURCE_REFRESH_DIRECTORY)
}

/// Writes one request for every live dashboard that serves this checkout.
pub async fn deliver_source_refresh(options: SourceRefreshOptions) -> Result<SourceRefreshReport> {
    let digest = dist_digest(&options.dist_dir)?;
    let request = SourceRefreshRequest {
        schema: SOURCE_REFRESH_SCHEMA,
        commit: options.commit.clone(),
        version: options.version.clone(),
        dist_digest: digest,
        requested_at: options.requested_at.clone(),
    };
    validate_request(&request)?;

    let repo_root = absolute_path(&options.repo_root);
    let harness_root = absolute_path(&options.harness_root);
    if !crate::version::is_harness_source_checkout(&repo_root) {
        return Ok(SourceRefreshReport {
            request,
            written: Vec::new(),
            applied: Vec::new(),
            failed: Vec::new(),
            skipped: Vec::new(),
        });
    }

    let mut written = Vec::new();
    let mut applied = Vec::new();
    let mut failed = Vec::new();
    let mut skipped = Vec::new();
    let mut outcomes: HashMap<PathBuf, Result<(), String>> = HashMap::new();
    for instance in &options.instances {
        if !same_path(&instance.repo_dir, &repo_root) {
            continue;
        }
        if !same_path(&instance.harness, &harness_root) {
            skipped.push(RefreshSkip {
                harness: instance.harness.clone(),
                pid: instance.pid,
                port: instance.port,
            });
            continue;
        }
        let state_dir = absolute_path(&instance.state_dir);
        if let Some(outcome) = outcomes.get(&state_dir) {
            match outcome {
                Ok(()) => written.push(target(&state_dir, instance)),
                Err(error) => failed.push(failure(&state_dir, instance, error.clone())),
            }
            continue;
        }
        match deliver_one(&state_dir, &request).await {
            Ok(true) => {
                outcomes.insert(state_dir.clone(), Ok(()));
                written.push(target(&state_dir, instance));
            }
            Ok(false) => {
                outcomes.insert(state_dir.clone(), Ok(()));
                applied.push(target(&state_dir, instance));
            }
            Err(error) => {
                outcomes.insert(state_dir.clone(), Err(error.clone()));
                failed.push(failure(&state_dir, instance, error));
            }
        }
    }
    Ok(SourceRefreshReport {
        request,
        written,
        applied,
        failed,
        skipped,
    })
}

async fn deliver_one(state_dir: &Path, request: &SourceRefreshRequest) -> Result<bool, String> {
    if read_applied_commit(state_dir).as_deref() == Some(request.commit.as_str()) {
        return Ok(false);
    }
    let path = source_refresh_directory(state_dir).join(SOURCE_REFRESH_REQUEST_FILE);
    crate::state::write_file_atomically(&path, &String::from_utf8_lossy(&request.to_bytes()))
        .await
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    Ok(true)
}

fn read_applied_commit(state_dir: &Path) -> Option<String> {
    let path = source_refresh_directory(state_dir).join(SOURCE_REFRESH_APPLIED_FILE);
    let source = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&source).ok()?;
    let commit = parsed.get("commit").and_then(Value::as_str)?.to_string();
    (!commit.is_empty()).then_some(commit)
}

fn target(state_dir: &Path, instance: &DashboardInstance) -> RefreshTarget {
    RefreshTarget {
        state_dir: state_dir.to_path_buf(),
        pid: instance.pid,
        port: instance.port,
    }
}

fn failure(state_dir: &Path, instance: &DashboardInstance, error: String) -> RefreshFailure {
    RefreshFailure {
        state_dir: state_dir.to_path_buf(),
        pid: instance.pid,
        port: instance.port,
        error,
    }
}

fn validate_request(request: &SourceRefreshRequest) -> Result<()> {
    if request.schema != SOURCE_REFRESH_SCHEMA {
        bail!("the source refresh request schema is not {SOURCE_REFRESH_SCHEMA}");
    }
    let commit = request.commit.trim();
    if commit.len() < 7 || commit.len() > 64 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("not a source refresh request: commit {}", request.commit);
    }
    if request.version.trim().is_empty() {
        bail!("not a source refresh request: the version is empty");
    }
    if request.dist_digest.len() != 64
        || !request
            .dist_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("not a source refresh request: the dist digest is not SHA-256");
    }
    if request.requested_at.trim().is_empty() {
        bail!("not a source refresh request: the requested time is empty");
    }
    Ok(())
}

fn absolute_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path)
        .or_else(|_| std::path::absolute(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(left: &Path, right: &Path) -> bool {
    absolute_path(left) == absolute_path(right)
}

fn discover_dashboard_instances() -> Vec<DashboardInstance> {
    dashboard_instances(&crate::supervision::process_table(), std::process::id())
}

fn dashboard_instances(
    processes: &[crate::supervision::ProcessSnapshot],
    self_pid: u32,
) -> Vec<DashboardInstance> {
    dashboard_instances_with(processes, self_pid, listening_ports_of)
}

fn dashboard_instances_with(
    processes: &[crate::supervision::ProcessSnapshot],
    self_pid: u32,
    ports_of: impl Fn(u32) -> Vec<u16>,
) -> Vec<DashboardInstance> {
    let mut instances = Vec::new();
    let mut seen = HashSet::new();
    for process in processes {
        if process.pid == self_pid || process.ancestors.contains(&self_pid) {
            continue;
        }
        let command = &process.cmdline;
        if !command.contains("devboard") || !command.contains("serve") {
            continue;
        }
        let Some(repo_dir) = process.env.get("REPO_DIR") else {
            continue;
        };
        if repo_dir.is_empty() {
            continue;
        }
        // `PORT` is inherited by every child of a dashboard, so it names the
        // socket the caller was told about, not the one this process bound. An
        // agent-started server in a worktree therefore claimed the host's port
        // and hid the real dashboard from refresh delivery.
        let Some(port) = dashboard_port(&process.env, &ports_of(process.pid)) else {
            continue;
        };
        if crate::supervision::is_verification_scratch(repo_dir)
            && process
                .env
                .get("DEVBOARD_WATCHDOG_FIXTURE")
                .map(String::as_str)
                != Some("1")
        {
            continue;
        }
        let harness = process
            .env
            .get("STATIC_DIR")
            .and_then(|value| Path::new(value).parent().map(Path::to_path_buf))
            .or_else(|| {
                let cwd = process.cwd.clone()?;
                // A source dashboard started at the repository root serves
                // `<repo>/.devboard`; its cwd alone names the wrong harness.
                let source = Path::new(repo_dir).join(".devboard");
                if same_path(&cwd, Path::new(repo_dir)) && source.is_dir() {
                    return Some(source);
                }
                Some(cwd)
            });
        let Some(harness) = harness else {
            continue;
        };
        let state_dir = process
            .env
            .get("STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| harness.join(".tmp"));
        // Two processes with the same repository and port are one dashboard
        // during a handoff, but a process that serves the same repository
        // through another harness is a different one and must never take the
        // real dashboard's place.
        let key = format!("{repo_dir}\0{port}\0{}", harness.display());
        if !seen.insert(key) {
            continue;
        }
        instances.push(DashboardInstance {
            pid: process.pid,
            port,
            repo_dir: PathBuf::from(repo_dir),
            harness,
            state_dir,
        });
    }
    instances
}

/// The port one dashboard actually owns: an inherited `PORT` counts only when
/// this process listens on it.
fn dashboard_port(environment: &HashMap<String, String>, listening: &[u16]) -> Option<u16> {
    let port = environment
        .get("PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0 && listening.contains(port));
    if port.is_some() {
        return port;
    }
    match listening {
        [only] => Some(*only),
        _ => None,
    }
}

/// The listening ports one process owns, read from `/proc`.
fn listening_ports_of(pid: u32) -> Vec<u16> {
    let inodes = socket_inodes_of(pid);
    if inodes.is_empty() {
        return Vec::new();
    }
    let mut table = HashMap::new();
    for source in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(text) = std::fs::read_to_string(source) {
            table.extend(listening_sockets_from(&text));
        }
    }
    let mut ports: Vec<u16> = inodes
        .iter()
        .filter_map(|inode| table.get(inode).copied())
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// The socket inodes one process holds open.
fn socket_inodes_of(pid: u32) -> Vec<u64> {
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let link = std::fs::read_link(entry.ok()?.path()).ok()?;
            let text = link.to_str()?;
            let inode = text.strip_prefix("socket:[")?.strip_suffix(']')?;
            inode.parse().ok()
        })
        .collect()
}

/// Every listening socket in one `/proc/net/tcp` table: inode to local port.
///
/// Only `0A` (LISTEN) rows count; the port is the hex field after the address,
/// and the inode is the tenth whitespace-separated field.
fn listening_sockets_from(table: &str) -> HashMap<u64, u16> {
    let mut sockets = HashMap::new();
    for line in table.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some(port) = fields[1]
            .rsplit(':')
            .next()
            .and_then(|hex| u16::from_str_radix(hex, 16).ok())
        else {
            continue;
        };
        let Some(inode) = fields[9].parse::<u64>().ok() else {
            continue;
        };
        if inode != 0 {
            sockets.insert(inode, port);
        }
    }
    sockets
}

// ---------------------------------------------------------------------------
// Release lock

/// One held release lock. Dropping it releases the file.
#[derive(Debug)]
pub struct ReleaseLock {
    path: PathBuf,
    token: String,
}

impl ReleaseLock {
    pub fn release(self) {
        drop(self);
    }
}

impl Drop for ReleaseLock {
    fn drop(&mut self) {
        if let Some(token) = read_lock_token(&self.path) {
            if token == self.token {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

/// How one lock acquisition waits.
#[derive(Clone)]
pub struct ReleaseLockOptions {
    pub path: PathBuf,
    pub repo_dir: PathBuf,
    pub state_dir: PathBuf,
    pub timeout: Duration,
    pub poll_interval: Duration,
    pub argv: Vec<String>,
    pub clock: Option<Arc<dyn Clock>>,
    pub sleeper: Option<Arc<dyn Sleeper>>,
    pub log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

fn release_lock_path(environment: &Environment) -> Option<PathBuf> {
    let value = environment.get(RELEASE_LOCK_VARIABLE)?.trim();
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

/// Takes the shared release lock, waiting until `timeout` when another release
/// holds it.
pub async fn acquire_release_lock(options: ReleaseLockOptions) -> Result<ReleaseLock> {
    let clock = options
        .clock
        .clone()
        .unwrap_or_else(|| Arc::new(SystemClock));
    let sleeper = options
        .sleeper
        .clone()
        .unwrap_or_else(|| Arc::new(TokioSleeper));
    let deadline = clock.now_millis() + options.timeout.as_millis() as i64;
    let token = uuid::Uuid::new_v4().to_string();
    let mut announced = false;
    loop {
        match try_acquire_lock(&options, &clock, &token) {
            Ok(true) => {
                return Ok(ReleaseLock {
                    path: options.path.clone(),
                    token,
                })
            }
            Ok(false) => {}
            Err(error) => return Err(error),
        }
        if clock.now_millis() >= deadline {
            bail!(
                "timed out waiting for the release lock at {}",
                options.path.display()
            );
        }
        if !announced {
            if let Some(log) = &options.log {
                (log)(&format!(
                    "waiting for the release lock at {}",
                    options.path.display()
                ));
            }
            announced = true;
        }
        sleeper.sleep(options.poll_interval).await;
    }
}

fn try_acquire_lock(
    options: &ReleaseLockOptions,
    clock: &Arc<dyn Clock>,
    token: &str,
) -> Result<bool> {
    if let Some(parent) = options.path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }
    if let Some(owner) = read_lock_owner(&options.path) {
        if owner.pid != std::process::id() && !pid_alive(owner.pid) {
            let _ = std::fs::remove_file(&options.path);
        } else {
            return Ok(false);
        }
    } else if options.path.exists() {
        // An unreadable lock is stale: no owner can release it.
        let _ = std::fs::remove_file(&options.path);
    }
    let document = json!({
        "pid": std::process::id(),
        "startedAt": iso_from_millis(clock.now_millis()),
        "repo": options.repo_dir.to_string_lossy(),
        "stateDir": options.state_dir.to_string_lossy(),
        "harnessVersion": Value::Null,
        "argv": options.argv.clone(),
        "token": token,
    });
    let mut text = jsjson::stringify(&document);
    text.push('\n');
    let staged = PathBuf::from(format!(
        "{}.new-{}-{}",
        options.path.display(),
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| -> std::io::Result<()> {
        std::fs::write(&staged, text.as_bytes())?;
        std::fs::hard_link(&staged, &options.path)
    })();
    let _ = std::fs::remove_file(&staged);
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(anyhow!(
            "could not take the release lock at {}: {error}",
            options.path.display()
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LockOwner {
    pid: u32,
    token: Option<String>,
}

fn read_lock_owner(path: &Path) -> Option<LockOwner> {
    let source = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&source).ok()?;
    let pid = parsed.get("pid").and_then(Value::as_u64)?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    Some(LockOwner {
        pid: pid as u32,
        token: parsed
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn read_lock_token(path: &Path) -> Option<String> {
    read_lock_owner(path)?.token
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if result == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// True when `dist` exists but is older than the newest source file.
fn dist_is_stale(harness_root: &Path) -> Result<bool> {
    // `dist` is build output, so it can be older than the sources it must be
    // built from: a fast-forward writes the committed client now and leaves a
    // bundle from an earlier run behind. That alone decides a rebuild.
    let dist = harness_root.join("dist");
    if !dist.is_dir() {
        return Ok(true);
    }
    let newest_source = newest_source_mtime(harness_root)?;
    if newest_source > newest_mtime(&dist) {
        return Ok(true);
    }
    // The committed embedded copy is what the release ships; a source edited
    // after that copy was embedded is rebuilt too. A `dist` that already
    // matches the sources is never rebuilt to paper over an edited embed — the
    // bundle proof refuses that instead, so the edit must be committed.
    let embedded = embedded_client_root(harness_root);
    Ok(embedded.is_dir() && newest_source > newest_mtime(&embedded))
}

/// The head a landing moved the checkout to, when it no longer names the
/// commit this attempt proved.
///
/// The integration checkout is shared, so an agent's landing can fast-forward
/// it while the suite runs; tagging the new head would then ship sources this
/// attempt never proved. The caller derives again from the landed tip instead.
async fn head_moved_after_proof(git: &Git<'_>, proven: &str) -> Result<Option<String>> {
    let head = git
        .must(
            &["rev-parse", "HEAD"],
            "could not read HEAD after the release suite",
        )
        .await?;
    Ok((head != proven).then_some(head))
}

/// Whether the publish has spent its window for integrating landings.
fn race_spent(started: i64, clock: &Arc<dyn Clock>) -> bool {
    clock.now_millis() - started >= RACE_INTEGRATION_BUDGET.as_millis() as i64
}

/// How long that window has been running, in whole minutes.
fn race_minutes(started: i64, clock: &Arc<dyn Clock>) -> u64 {
    (clock.now_millis() - started).max(0) as u64 / 60_000
}

/// Rebuilds the client bundle from the released sources and embeds the result
/// where the binary reads it.
///
/// `dist` is build output, but `crates/devboard/assets` is the copy the binary
/// embeds at compile time and the release workflow builds from the tagged
/// commit. A rebuild that changes it therefore leaves the tree dirty, and the
/// bundle proof refuses a tag the working tree does not carry.
async fn rebuild_client(
    args: &PublishArgs,
    runner: &dyn CommandRunner,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<()> {
    let package = args.harness_root.join("package.json");
    if !package.is_file() {
        bail!(
            "dist is older than its sources and {} carries no client build",
            args.harness_root.display()
        );
    }
    (log)("rebuilding the client bundle from the released sources");
    run_bun(args, runner, &["run", "build"], "rebuild the client bundle").await?;
    // The binary embeds `crates/devboard/assets`, never `dist`: the embed step
    // is what puts this run's bundle where the release build reads it.
    (log)("embedding the rebuilt client the binary serves");
    run_bun(
        args,
        runner,
        &["scripts/embed-client.mjs"],
        "embed the rebuilt client",
    )
    .await?;
    Ok(())
}

/// The `bun` executable this publish can start.
///
/// A dashboard launched by the desktop icon carries a login PATH that may not
/// include a version-manager install of Bun. Resolve it through the given PATH
/// first, then the common per-user locations, so a client rebuild does not fail
/// with a bare "No such file or directory".
fn bun_program(environment: &Environment) -> String {
    fn on_path(path: &str) -> Option<String> {
        for directory in path.split(':').filter(|directory| !directory.is_empty()) {
            let candidate = Path::new(directory).join("bun");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }
    if let Some(path) = environment.get("PATH") {
        if let Some(found) = on_path(path) {
            return found;
        }
    }
    let mut candidates = Vec::new();
    if let Some(home) = environment.get("HOME") {
        candidates.push(format!("{home}/.bun/bin/bun"));
        candidates.push(format!("{home}/.cargo/bin/bun"));
        if let Ok(entries) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
            for entry in entries.flatten() {
                candidates.push(entry.path().join("bin").join("bun").display().to_string());
            }
        }
    }
    candidates
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file())
        .unwrap_or_else(|| "bun".to_string())
}

/// Runs one Bun command in the harness root and refuses a nonzero exit.
async fn run_bun(
    args: &PublishArgs,
    runner: &dyn CommandRunner,
    arguments: &[&str],
    what: &str,
) -> Result<()> {
    let outcome = runner
        .run(CommandInvocation {
            program: bun_program(&args.environment),
            args: arguments
                .iter()
                .map(|argument| (*argument).to_string())
                .collect(),
            cwd: args.harness_root.clone(),
            env: args.environment.clone(),
            timeout: Duration::from_secs(900),
        })
        .await;
    if outcome.code != 0 {
        bail!(
            "could not {what}: {}",
            first_line(if outcome.stderr.is_empty() {
                outcome.stdout.as_str()
            } else {
                outcome.stderr.as_str()
            })
        );
    }
    Ok(())
}

/// Proves the release bundle before the publish tags, dispatches, or writes a
/// release. The publish calls this after it refreshes the checkout and rebuilds
/// a stale bundle, so the proof reads the current sources.
///
/// The client bundle must be newer than its sources, the copy at
/// `crates/devboard/assets` the binary embeds must match it byte for byte,
/// every `/assets/...` reference in `dist/index.html` must exist, and a staged
/// manifest must carry a matching `devboard-manifest.json.sha256` whose version
/// matches its tag.
pub fn verify_release_bundle(harness_root: &Path) -> Result<()> {
    let dist = harness_root.join("dist");
    if !dist.is_dir() {
        bail!(
            "the release bundle is missing: {} does not exist",
            dist.display()
        );
    }
    let newest_source = newest_source_mtime(harness_root)?;
    let newest_dist = newest_mtime(&dist);
    if newest_source > newest_dist {
        bail!(
            "dist is older than its sources: {} was built before the newest source file; rebuild the client before publishing",
            dist.display()
        );
    }
    verify_index_assets(&dist)?;
    verify_embedded_client(harness_root, &dist)?;

    let manifest = harness_root.join(MANIFEST_ASSET_NAME);
    let checksum = harness_root.join(MANIFEST_CHECKSUM_ASSET);
    if manifest.is_file() || checksum.is_file() {
        let bytes = std::fs::read(&manifest).map_err(|error| {
            anyhow!(
                "the staged {} could not be read: {error}",
                manifest.display()
            )
        })?;
        let text = std::fs::read_to_string(&checksum).map_err(|error| {
            anyhow!("the staged manifest has no matching {MANIFEST_CHECKSUM_ASSET}: {error}")
        })?;
        let expected = parse_checksum(&text)
            .ok_or_else(|| anyhow!("{} names no SHA-256 digest", checksum.display()))?;
        if expected != sha256_hex(&bytes) {
            bail!("{MANIFEST_CHECKSUM_ASSET} does not match the staged manifest's SHA-256");
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| anyhow!("the staged manifest is not valid JSON: {error}"))?;
        let version = value
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let tag = value
            .get("tag")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if version.is_empty() || tag != format!("v{version}") {
            bail!("the staged manifest version {version} differs from its tag {tag}");
        }
    }
    Ok(())
}

/// The committed copy of the built client the binary embeds at compile time.
///
/// `scripts/embed-client.mjs` refreshes it from `dist`, so it is build output
/// rather than source: the freshness walk skips it and the bundle proof
/// compares it with the bundle the release serves.
fn embedded_client_root(harness_root: &Path) -> PathBuf {
    harness_root.join("crates/devboard/assets")
}

/// Refuses a release whose embedded client differs from the built bundle in
/// one path, one file, or one byte.
fn verify_embedded_client(harness_root: &Path, dist: &Path) -> Result<()> {
    let embedded = embedded_client_root(harness_root);
    if !embedded.is_dir() {
        bail!(
            "the embedded client is missing: {} does not exist; run `bun scripts/embed-client.mjs` before publishing",
            embedded.display()
        );
    }
    if dist_digest(dist)? != dist_digest(&embedded)? {
        bail!(
            "the embedded client differs from dist: {} is stale; run `bun scripts/embed-client.mjs` and commit the result before publishing",
            embedded.display()
        );
    }
    Ok(())
}

/// Refuses a release whose embedded client is not in the commit it tags.
///
/// The tag names a commit, and the release workflow builds that commit without
/// running the embed step, so a rebuild this run performed lives only in the
/// working tree: a pending change under `crates/devboard/assets` means the
/// release would carry the previous bundle while this checkout already serves
/// the new one.
async fn verify_embedded_client_committed(
    args: &PublishArgs,
    runner: &dyn CommandRunner,
) -> Result<()> {
    let embedded = embedded_client_root(&args.harness_root);
    let git = Git::new(runner, &args.harness_root, &args.environment);
    let pending = git
        .must(
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--",
                "crates/devboard/assets",
            ],
            "could not read uncommitted changes under crates/devboard/assets",
        )
        .await?;
    let pending = pending.trim();
    if pending.is_empty() {
        return Ok(());
    }
    bail!(
        "the embedded client is not committed: {} differs from the commit the release would tag ({}), so the release would ship the previous bundle; run `bun scripts/embed-client.mjs`, commit the result, and rerun",
        embedded.display(),
        pending.lines().next().unwrap_or_default().trim()
    )
}

/// The newest modification time below `directory`.
fn newest_mtime(directory: &Path) -> std::time::SystemTime {
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    let Ok(entries) = std::fs::read_dir(directory) else {
        return newest;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            newest = newest.max(newest_mtime(&path));
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) {
            newest = newest.max(modified);
        }
    }
    newest
}

/// The newest source file below the harness, ignoring build output and state.
fn newest_source_mtime(harness_root: &Path) -> Result<std::time::SystemTime> {
    let embedded = embedded_client_root(harness_root);
    fn visit(directory: &Path, embedded: &Path, newest: &mut std::time::SystemTime) -> Result<()> {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return Ok(());
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path == embedded {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if matches!(
                name.as_str(),
                "dist"
                    | "target"
                    | ".git"
                    | "node_modules"
                    | ".tmp"
                    | ".test-tmp"
                    | ".worktree"
                    | "Cargo.toml"
                    | "Cargo.lock"
                    | "package.json"
                    | "bun.lock"
                    | "devboard-manifest.json"
                    | "devboard-manifest.json.sha256"
            ) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                visit(&path, embedded, newest)?;
                continue;
            }
            if let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) {
                *newest = (*newest).max(modified);
            }
        }
        Ok(())
    }
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    visit(harness_root, &embedded, &mut newest)?;
    Ok(newest)
}

/// Every `/assets/...` reference `dist/index.html` names must exist.
fn verify_index_assets(dist: &Path) -> Result<()> {
    static ASSET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"(?:src|href)="(/assets/[^"?#]+)""#).expect("an asset reference")
    });
    let index = dist.join("index.html");
    let text = std::fs::read_to_string(&index)
        .map_err(|error| anyhow!("{} could not be read: {error}", index.display()))?;
    for capture in ASSET.captures_iter(&text) {
        let Some(reference) = capture.get(1) else {
            continue;
        };
        let relative = reference.as_str().trim_start_matches('/');
        if !dist.join(relative).is_file() {
            bail!(
                "{} references the missing asset {}",
                index.display(),
                reference.as_str()
            );
        }
    }
    Ok(())
}

const MANIFEST_ASSET_NAME: &str = "devboard-manifest.json";

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    /// A runner whose plain `origin` fetch is refused and whose rewritten
    /// fetch lands: the checkout's SSH remote is down while the configured
    /// Gitea HTTP address answers.
    struct RefusedSshRunner {
        head: String,
        attempts: Mutex<Vec<(Vec<String>, bool)>>,
    }

    impl CommandRunner for RefusedSshRunner {
        fn run<'a>(&'a self, invocation: CommandInvocation) -> BoxFuture<'a, CommandOutcome> {
            Box::pin(async move {
                let rewritten = invocation.env.contains_key("GIT_CONFIG_COUNT");
                self.attempts
                    .lock()
                    .expect("attempts")
                    .push((invocation.args.clone(), rewritten));
                let git = |name: &str| invocation.args.iter().any(|arg| arg == name);
                if git("fetch") {
                    if rewritten {
                        return CommandOutcome::default();
                    }
                    return CommandOutcome {
                        code: 1,
                        stdout: String::new(),
                        stderr: "ssh: connect to host localhost port 2223: Connection refused"
                            .to_string(),
                    };
                }
                if git("rev-parse") {
                    return CommandOutcome {
                        code: 0,
                        stdout: self.head.clone(),
                        stderr: String::new(),
                    };
                }
                CommandOutcome::default()
            })
        }
    }

    struct NeverSleep;

    impl Sleeper for NeverSleep {
        fn sleep<'a>(&'a self, _duration: Duration) -> BoxFuture<'a, ()> {
            Box::pin(async {})
        }
    }

    /// A checkout whose `origin` is the Gitea SSH remote this host refused,
    /// with the configured HTTP address and token in its environment.
    fn ssh_origin_checkout(label: &str, token: bool) -> (PathBuf, PublishArgs) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("publish-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a fixture root");
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .expect("git")
        };
        assert!(git(&["init", "-q"]).success());
        assert!(git(&[
            "remote",
            "add",
            "origin",
            "ssh://ds@localhost:2223/dsdenes/devboard.git",
        ])
        .success());
        let mut args = PublishArgs::new(&root);
        args.environment = HashMap::from([(
            "DEVBOARD_GITEA_URL".to_string(),
            "http://localhost:3001".to_string(),
        )]);
        if token {
            args.environment
                .insert("GITEA_TOKEN".to_string(), "secret-token".to_string());
        }
        (root, args)
    }

    #[tokio::test]
    async fn an_unreachable_origin_adopts_the_configured_gitea_address() {
        let (root, args) = ssh_origin_checkout("gitea-fallback", true);
        let head = "a".repeat(40);
        let runner = RefusedSshRunner {
            head: head.clone(),
            attempts: Mutex::new(Vec::new()),
        };
        let mut environment = args.environment.clone();
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = lines.clone();
        let log: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| {
            recorded.lock().expect("log").push(line.to_string());
        });
        let sleeper: Arc<dyn Sleeper> = Arc::new(NeverSleep);

        let published = refresh_main(&args, &runner, "origin", &mut environment, &log, &sleeper)
            .await
            .expect("the rewritten fetch lands");
        assert_eq!(published, head);

        // The rewrite is kept, so the tag and the pushes that follow go to the
        // same address rather than failing on the refused SSH remote again.
        assert_eq!(
            environment.get("GIT_CONFIG_COUNT").map(String::as_str),
            Some("2")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_KEY_0").map(String::as_str),
            Some("url.http://localhost:3001/dsdenes/devboard.git.insteadOf")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_VALUE_0").map(String::as_str),
            Some("ssh://ds@localhost:2223/dsdenes/devboard.git")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_VALUE_1").map(String::as_str),
            Some("Authorization: token secret-token")
        );
        let lines = lines.lock().expect("log").clone();
        assert!(
            lines
                .iter()
                .any(|line| line.contains("the configured Gitea HTTP address")),
            "{lines:?}"
        );

        // A second attempt of the same release does not re-ask the refused
        // remote: the adopted transport is the one it was handed.
        let again = refresh_main(&args, &runner, "origin", &mut environment, &log, &sleeper)
            .await
            .expect("the adopted transport answers");
        assert_eq!(again, head);
        let attempts = runner.attempts.lock().expect("attempts").clone();
        let plain_fetches = attempts
            .iter()
            .filter(|(args, rewritten)| args.iter().any(|arg| arg == "fetch") && !rewritten)
            .count();
        assert_eq!(plain_fetches, 1, "{attempts:?}");
        assert!(
            attempts.iter().skip(1).all(|(_, rewritten)| *rewritten),
            "{attempts:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_unreachable_origin_without_a_configured_credential_reports_its_own_failure() {
        let (root, args) = ssh_origin_checkout("gitea-no-credential", false);
        let runner = RefusedSshRunner {
            head: "a".repeat(40),
            attempts: Mutex::new(Vec::new()),
        };
        let mut environment = args.environment.clone();
        let log: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_line: &str| {});
        let sleeper: Arc<dyn Sleeper> = Arc::new(NeverSleep);

        let error = refresh_main(&args, &runner, "origin", &mut environment, &log, &sleeper)
            .await
            .expect_err("no configured address reads no remote");
        let message = format!("{error:#}");
        assert!(message.contains("could not fetch origin/main"), "{message}");
        assert!(message.contains("Connection refused"), "{message}");
        assert_eq!(environment, args.environment, "nothing was adopted");
        assert_eq!(runner.attempts.lock().expect("attempts").len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn record(subject: &str) -> CommitRecord {
        CommitRecord {
            sha: "a".repeat(40),
            subject: subject.to_string(),
            body: String::new(),
            parents: vec!["b".repeat(40)],
        }
    }

    #[test]
    fn the_subject_grammar_matches_the_push_gate() {
        assert!(subject_rule("feat: a thing").is_none());
        assert!(subject_rule("feat(scope): a thing").is_none());
        assert!(subject_rule("feat!: a thing").is_none());
        assert!(subject_rule("Feat: a thing").is_some());
        assert!(subject_rule("feat(Scope): a thing").is_some());
        assert!(subject_rule("nope").is_some());
        assert!(subject_rule(" feat: a thing").is_some());
    }

    #[test]
    fn the_bump_is_the_highest_non_merge_commit() {
        assert_eq!(commit_level(&record("feat: x")), Some(ReleaseLevel::Minor));
        assert_eq!(commit_level(&record("fix: x")), Some(ReleaseLevel::Patch));
        assert_eq!(commit_level(&record("feat!: x")), Some(ReleaseLevel::Major));
        assert_eq!(
            release_level(&[record("fix: x"), record("feat: y")]),
            Some(ReleaseLevel::Minor)
        );
        assert_eq!(release_level(&[]), None);
    }

    #[test]
    fn the_next_version_advances_or_stays_at_the_baseline() {
        assert_eq!(next_release_version(None, None), "1.0.0");
        assert_eq!(
            next_release_version(Some("0.9.0"), Some(ReleaseLevel::Patch)),
            "1.0.0"
        );
        assert_eq!(
            next_release_version(Some("1.2.3"), Some(ReleaseLevel::Patch)),
            "1.2.4"
        );
        assert_eq!(
            next_release_version(Some("1.2.3"), Some(ReleaseLevel::Minor)),
            "1.3.0"
        );
        assert_eq!(
            next_release_version(Some("1.2.3"), Some(ReleaseLevel::Major)),
            "2.0.0"
        );
        assert_eq!(next_release_version(Some("1.2.3"), None), "1.2.3");
    }

    #[test]
    fn the_failing_jobs_are_named_with_the_step_that_failed() {
        let job = |name: &str, conclusion: &str, step: Option<&str>| WorkflowJob {
            name: name.to_string(),
            conclusion: Some(conclusion.to_string()),
            failed_step: step.map(str::to_string),
        };
        assert_eq!(
            failed_jobs_detail(&[
                job("build", "success", None),
                job("macos", "cancelled", None),
            ]),
            None
        );
        assert_eq!(
            failed_jobs_detail(&[
                job(
                    "build-local-artifacts (x86_64-unknown-linux-gnu)",
                    "failure",
                    Some("enable windows longpaths")
                ),
                job("build-local-artifacts (aarch64-apple-darwin)", "cancelled", None),
            ]),
            Some(
                "build-local-artifacts (x86_64-unknown-linux-gnu) failed at enable windows longpaths"
                    .to_string()
            )
        );
        assert_eq!(
            failed_jobs_detail(&[
                job("a", "failure", None),
                job("b", "startup_failure", Some("Set up job")),
                job("c", "failure", None),
                job("d", "timed_out", None),
            ]),
            Some("a failed; b failed at Set up job; c failed; and 1 more job".to_string())
        );
    }

    #[test]
    fn a_source_dashboard_at_the_repo_root_names_its_harness() {
        use crate::supervision::ProcessSnapshot;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("publish-instance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".devboard")).expect("a source harness");
        let mut env = std::collections::HashMap::new();
        env.insert("REPO_DIR".to_string(), root.display().to_string());
        env.insert("PORT".to_string(), "8080".to_string());
        env.insert("DEVBOARD_WATCHDOG_FIXTURE".to_string(), "1".to_string());
        let process = ProcessSnapshot {
            pid: 424242,
            cmdline: format!("{}/devboard serve", root.display()),
            env,
            cwd: Some(root.clone()),
            exe: None,
            ancestors: vec![1],
        };
        let instances = dashboard_instances_with(&[process], 999_999, |_| vec![8080]);
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].harness, root.join(".devboard"));
        assert!(instances[0].state_dir.ends_with(".devboard/.tmp"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_port_is_the_socket_the_process_bound_not_the_one_it_inherited() {
        use crate::supervision::ProcessSnapshot;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("publish-bound-port-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".devboard")).expect("a source harness");
        let mut env = std::collections::HashMap::new();
        env.insert("REPO_DIR".to_string(), root.display().to_string());
        env.insert("PORT".to_string(), "8080".to_string());
        env.insert("DEVBOARD_WATCHDOG_FIXTURE".to_string(), "1".to_string());
        let process = ProcessSnapshot {
            pid: 424243,
            cmdline: format!("{}/devboard serve --port 8204", root.display()),
            env,
            cwd: Some(root.clone()),
            exe: None,
            ancestors: vec![1],
        };
        let instances = dashboard_instances_with(&[process], 999_999, |_| vec![8204]);
        assert_eq!(instances.len(), 1, "the inherited port names no socket");
        assert_eq!(instances[0].port, 8204);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_inherited_port_hidden_behind_another_harness_never_hides_the_dashboard() {
        use crate::supervision::ProcessSnapshot;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("publish-shadow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".devboard")).expect("a source harness");
        let environment = || {
            let mut env = std::collections::HashMap::new();
            env.insert("REPO_DIR".to_string(), root.display().to_string());
            env.insert("PORT".to_string(), "8080".to_string());
            env.insert("DEVBOARD_WATCHDOG_FIXTURE".to_string(), "1".to_string());
            env
        };
        let shadow = ProcessSnapshot {
            pid: 424244,
            cmdline: format!("{}/devboard serve", root.display()),
            env: environment(),
            cwd: Some(root.join(".worktree/perf/.devboard")),
            exe: None,
            ancestors: vec![1],
        };
        let dashboard = ProcessSnapshot {
            pid: 424245,
            cmdline: format!("{}/devboard serve", root.display()),
            env: environment(),
            cwd: Some(root.clone()),
            exe: None,
            ancestors: vec![1],
        };
        let instances = dashboard_instances_with(&[shadow, dashboard], 999_999, |_| vec![8080]);
        assert_eq!(instances.len(), 2, "another harness is its own instance");
        assert!(instances
            .iter()
            .any(|instance| instance.pid == 424245 && instance.harness == root.join(".devboard")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_dist_older_than_its_sources_is_rebuilt_even_beside_a_newer_embed() {
        use std::time::{Duration, SystemTime};
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("publish-stale-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let embedded = root.join("crates/devboard/assets");
        let dist = root.join("dist");
        let client = root.join("client");
        std::fs::create_dir_all(&embedded).expect("an embedded copy");
        std::fs::create_dir_all(&dist).expect("a built bundle");
        std::fs::create_dir_all(&client).expect("a client tree");
        std::fs::write(embedded.join("index.html"), "current").expect("the embedded index");
        std::fs::write(dist.join("index.html"), "older").expect("the older bundle");
        std::fs::write(client.join("Row.svelte"), "<p></p>\n").expect("a client source");
        let age = |path: &Path, seconds: i64| {
            let handle = std::fs::File::options()
                .write(true)
                .open(path)
                .expect("an open file");
            let now = SystemTime::now();
            let time = if seconds < 0 {
                now - Duration::from_secs(seconds.unsigned_abs())
            } else {
                now + Duration::from_secs(seconds as u64)
            };
            handle
                .set_times(std::fs::FileTimes::new().set_modified(time))
                .expect("a file time");
        };
        age(&client.join("Row.svelte"), -30);
        age(&embedded.join("index.html"), 0);
        age(&dist.join("index.html"), -60);
        assert!(
            dist_is_stale(&root).expect("a verdict"),
            "a dist older than its sources is rebuilt even when the embed is newer"
        );
        age(&dist.join("index.html"), 0);
        assert!(
            !dist_is_stale(&root).expect("a verdict"),
            "a dist newer than its sources is current"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bound_listener_is_found_through_the_proc_socket_tables() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("a listener");
        let port = listener.local_addr().expect("an address").port();
        let ports = listening_ports_of(std::process::id());
        assert!(
            ports.contains(&port),
            "the bound listener is found: {ports:?}"
        );
    }

    #[test]
    fn the_listening_table_names_only_the_sockets_in_the_listen_state() {
        let table = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0\n\
   1: 0100007F:8AE4 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 99 1 0000000000000000 20 4 30 10 -1\n";
        let sockets = listening_sockets_from(table);
        assert_eq!(sockets.get(&424242), Some(&8080));
        assert!(
            !sockets.contains_key(&99),
            "an established socket is not a listener"
        );
        assert_eq!(listening_sockets_from(""), HashMap::new());
    }

    #[test]
    fn release_asset_uploads_use_the_uploads_host() {
        let api = Api {
            transport: Arc::new(ReqwestTransport::new()),
            sleeper: Arc::new(TokioSleeper),
            gitea: GiteaTarget {
                base_url: "http://gitea.test".to_string(),
                project: "dsdenes/devboard".to_string(),
                token: None,
            },
            github_base: "https://api.github.com".to_string(),
            github_repo: "dsdenes/devboard".to_string(),
            github_token: None,
        };
        assert_eq!(api.github_upload_base(), "https://uploads.github.com");
        let local = Api {
            github_base: "http://127.0.0.1:9".to_string(),
            ..api
        };
        assert_eq!(local.github_upload_base(), "http://127.0.0.1:9");
    }

    struct ScriptedTransport {
        statuses: std::sync::Mutex<Vec<u16>>,
        requests: std::sync::Mutex<Vec<HttpRequest>>,
    }

    impl HttpTransport for ScriptedTransport {
        fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, String>> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(request);
                let status = self.statuses.lock().unwrap().remove(0);
                Ok(HttpResponse {
                    status,
                    body: b"[]".to_vec(),
                })
            })
        }
    }

    struct RecordingSleeper {
        waits: std::sync::Mutex<Vec<Duration>>,
    }

    impl RecordingSleeper {
        fn new() -> Self {
            Self {
                waits: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    impl Sleeper for RecordingSleeper {
        fn sleep<'a>(&'a self, duration: Duration) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                self.waits.lock().unwrap().push(duration);
            })
        }
    }

    fn test_api(transport: Arc<dyn HttpTransport>, sleeper: Arc<dyn Sleeper>) -> Api {
        Api {
            transport,
            sleeper,
            gitea: GiteaTarget {
                base_url: "http://gitea.test".to_string(),
                project: "dsdenes/devboard".to_string(),
                token: None,
            },
            github_base: "https://api.github.com".to_string(),
            github_repo: "dsdenes/devboard".to_string(),
            github_token: None,
        }
    }

    #[tokio::test]
    async fn a_busy_gitea_database_retries_the_read() {
        let transport = Arc::new(ScriptedTransport {
            statuses: std::sync::Mutex::new(vec![500, 200]),
            requests: std::sync::Mutex::new(Vec::new()),
        });
        let sleeper = Arc::new(RecordingSleeper::new());
        let api = test_api(transport.clone(), sleeper.clone());
        let document = api
            .gitea_json(
                "GET",
                "/repos/dsdenes/devboard/releases?limit=50&page=1",
                None,
            )
            .await
            .expect("the retried read answers");
        assert_eq!(document, json!([]));
        assert_eq!(transport.requests.lock().unwrap().len(), 2);
        assert_eq!(
            sleeper.waits.lock().unwrap().as_slice(),
            [GITEA_RETRY_DELAY]
        );
    }

    #[tokio::test]
    async fn a_gitea_write_request_is_never_retried_at_the_request_layer() {
        let transport = Arc::new(ScriptedTransport {
            statuses: std::sync::Mutex::new(vec![500, 200]),
            requests: std::sync::Mutex::new(Vec::new()),
        });
        let sleeper = Arc::new(RecordingSleeper::new());
        let api = test_api(transport.clone(), sleeper.clone());
        let error = api
            .gitea_json(
                "POST",
                "/repos/dsdenes/devboard/releases",
                Some(json!({ "tag_name": "v1.2.3" })),
            )
            .await
            .expect_err("the refused write fails");
        assert!(error.to_string().contains("HTTP 500"), "{error}");
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
        assert!(sleeper.waits.lock().unwrap().is_empty());
    }

    /// Answers each call with the queued status and body, so a retried write
    /// and the read-back that proves it are scripted as they reach the forge.
    struct QueuedTransport {
        responses: std::sync::Mutex<Vec<(u16, &'static str)>>,
        requests: std::sync::Mutex<Vec<HttpRequest>>,
    }

    impl HttpTransport for QueuedTransport {
        fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, String>> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(request);
                let (status, body) = self.responses.lock().unwrap().remove(0);
                Ok(HttpResponse {
                    status,
                    body: body.as_bytes().to_vec(),
                })
            })
        }
    }

    #[tokio::test]
    async fn a_busy_gitea_database_retries_the_release_creation() {
        let transport = Arc::new(QueuedTransport {
            responses: std::sync::Mutex::new(vec![
                (500, r#"{"message":"database is locked (5) (SQLITE_BUSY)"}"#),
                (404, r#"{"message":"release not found"}"#),
                (201, r#"{"id":7}"#),
            ]),
            requests: std::sync::Mutex::new(Vec::new()),
        });
        let sleeper = Arc::new(RecordingSleeper::new());
        let api = test_api(transport.clone(), sleeper.clone());
        let id = api
            .gitea_create_release("v1.2.3", "1.2.3", "abc123")
            .await
            .expect("the retried create answers");
        assert_eq!(id, 7);
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[1].method, "GET");
        assert!(
            requests[1].url.ends_with("/releases/tags/v1.2.3"),
            "{}",
            requests[1].url
        );
        assert_eq!(requests[2].method, "POST");
        assert_eq!(
            sleeper.waits.lock().unwrap().as_slice(),
            [GITEA_RETRY_DELAY]
        );
    }

    #[tokio::test]
    async fn a_refused_release_creation_that_committed_is_adopted() {
        let transport = Arc::new(QueuedTransport {
            responses: std::sync::Mutex::new(vec![
                (500, r#"{"message":"database is locked (5) (SQLITE_BUSY)"}"#),
                (200, r#"{"id":9,"assets":[]}"#),
            ]),
            requests: std::sync::Mutex::new(Vec::new()),
        });
        let sleeper = Arc::new(RecordingSleeper::new());
        let api = test_api(transport.clone(), sleeper.clone());
        let id = api
            .gitea_create_release("v1.2.3", "1.2.3", "abc123")
            .await
            .expect("the created release is read back");
        assert_eq!(id, 9);
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].method, "GET");
    }

    #[tokio::test]
    async fn a_busy_gitea_database_retries_the_asset_upload() {
        let transport = Arc::new(QueuedTransport {
            responses: std::sync::Mutex::new(vec![
                (500, r#"{"message":"database is locked (5) (SQLITE_BUSY)"}"#),
                (
                    200,
                    r#"{"id":5,"assets":[{"name":"devboard-manifest.json"}]}"#,
                ),
            ]),
            requests: std::sync::Mutex::new(Vec::new()),
        });
        let sleeper = Arc::new(RecordingSleeper::new());
        let api = test_api(transport.clone(), sleeper.clone());
        api.gitea_upload(5, MANIFEST_ASSET, "{}".as_bytes().to_vec())
            .await
            .expect("the upload the refused attempt performed is read back");
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, "POST");
        assert!(
            requests[0]
                .url
                .ends_with("/releases/5/assets?name=devboard-manifest.json"),
            "{}",
            requests[0].url
        );
        assert_eq!(requests[1].method, "GET");
        assert!(
            requests[1].url.ends_with("/releases/5"),
            "{}",
            requests[1].url
        );
    }

    #[tokio::test]
    async fn a_refused_release_creation_reports_the_forge_status() {
        let transport = Arc::new(QueuedTransport {
            responses: std::sync::Mutex::new(vec![(
                401,
                r#"{"message":"token does not have write access"}"#,
            )]),
            requests: std::sync::Mutex::new(Vec::new()),
        });
        let sleeper = Arc::new(RecordingSleeper::new());
        let api = test_api(transport.clone(), sleeper.clone());
        let error = api
            .gitea_create_release("v1.2.3", "1.2.3", "abc123")
            .await
            .expect_err("the refused create fails");
        assert!(error.to_string().contains("HTTP 401"), "{error}");
        assert!(error.to_string().contains("write access"), "{error}");
        assert_eq!(transport.requests.lock().unwrap().len(), 1);
        assert!(sleeper.waits.lock().unwrap().is_empty());
    }

    /// Records every command it is handed and answers success, so a caller's
    /// exact invocation can be read back.
    struct IntegrationRecorder {
        invocations: Mutex<Vec<CommandInvocation>>,
    }

    impl CommandRunner for IntegrationRecorder {
        fn run<'a>(&'a self, invocation: CommandInvocation) -> BoxFuture<'a, CommandOutcome> {
            Box::pin(async move {
                self.invocations.lock().expect("recorded").push(invocation);
                CommandOutcome::default()
            })
        }
    }

    fn gh_stub_root(label: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.test-tmp")
            .join(format!("{label}-{}", std::process::id()))
    }

    #[tokio::test]
    async fn the_github_build_ref_push_resolves_gh_through_the_environment() {
        let root = gh_stub_root("gh-probe");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let gh = root.join("bin/gh");
        std::fs::write(&gh, b"#!/bin/sh\n").unwrap();
        let mut environment = Environment::new();
        environment.insert("PATH".to_string(), root.join("bin").display().to_string());

        let runner = IntegrationRecorder {
            invocations: Mutex::new(Vec::new()),
        };
        let git = Git::new(&runner, Path::new("/repo"), &environment);
        let log: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
        push_github_build_ref(&git, &environment, "abc1234", "v1.2.3", &log)
            .await
            .expect("the push invocation is recorded");

        let invocations = runner.invocations.lock().expect("recorded");
        let push = invocations
            .iter()
            .find(|invocation| invocation.args.iter().any(|arg| arg == "push"))
            .expect("the build-ref push ran");
        assert!(push.args.iter().any(|arg| arg == "credential.helper="));
        assert_eq!(
            push.args
                .iter()
                .find(|arg| arg.starts_with("credential.https://github.com.helper=")),
            Some(&format!(
                "credential.https://github.com.helper=!{} auth git-credential",
                gh.display()
            ))
        );
        assert!(push.args.iter().any(|arg| arg == "github"));
        assert!(push
            .args
            .iter()
            .any(|arg| arg == "abc1234:refs/heads/devboard-build/v1.2.3"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_github_build_ref_push_names_gh_when_none_is_on_the_path() {
        let root = gh_stub_root("gh-missing");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("empty")).unwrap();
        let mut environment = Environment::new();
        environment.insert("PATH".to_string(), root.join("empty").display().to_string());

        let runner = IntegrationRecorder {
            invocations: Mutex::new(Vec::new()),
        };
        let git = Git::new(&runner, Path::new("/repo"), &environment);
        let log: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
        let error = push_github_build_ref(&git, &environment, "abc1234", "v1.2.3", &log)
            .await
            .expect_err("a missing gh fails before the push");
        let message = error.to_string();
        assert!(message.contains("`gh`"), "{message}");
        assert!(
            runner.invocations.lock().expect("recorded").is_empty(),
            "no git command ran"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bun_resolves_through_the_path_or_a_user_install() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-tmp")
            .join(format!("bun-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("path")).unwrap();
        std::fs::create_dir_all(root.join("home/.bun/bin")).unwrap();
        std::fs::write(root.join("path/bun"), b"#!/bin/sh\n").unwrap();
        std::fs::write(root.join("home/.bun/bin/bun"), b"#!/bin/sh\n").unwrap();
        let mut environment = Environment::new();
        environment.insert("PATH".to_string(), root.join("path").display().to_string());
        assert_eq!(
            bun_program(&environment),
            root.join("path/bun").display().to_string()
        );
        environment.remove("PATH");
        environment.insert("HOME".to_string(), root.join("home").display().to_string());
        assert_eq!(
            bun_program(&environment),
            root.join("home/.bun/bin/bun").display().to_string()
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
