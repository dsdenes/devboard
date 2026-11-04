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
use crate::release::{MANIFEST_ASSET, RELEASE_REPOSITORY};

/// The workflow cargo-dist generates for the GitHub release host.
pub const RELEASE_WORKFLOW: &str = "release.yml";
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

/// What one source-refresh delivery did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRefreshReport {
    pub request: SourceRefreshRequest,
    pub written: Vec<RefreshTarget>,
    /// Dashboards whose `applied.json` already named this commit.
    pub applied: Vec<RefreshTarget>,
    pub failed: Vec<RefreshFailure>,
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
    /// Receives each progress line; stderr when absent.
    pub log: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}

impl PublishArgs {
    /// The production defaults for one checkout, read from this process's
    /// environment.
    pub fn new(repo_dir: impl Into<PathBuf>) -> Self {
        let repo_dir = repo_dir.into();
        let harness_root = repo_dir.join(".devboard");
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
        let mut argv = Vec::with_capacity(args.len() + 2);
        argv.push("-C".to_string());
        argv.push(self.repo_dir.to_string_lossy().into_owned());
        argv.extend(args.iter().map(|arg| (*arg).to_string()));
        self.runner
            .run(CommandInvocation {
                program: "git".to_string(),
                args: argv,
                cwd: self.repo_dir.to_path_buf(),
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

// ---------------------------------------------------------------------------
// HTTP API access

struct Api {
    transport: Arc<dyn HttpTransport>,
    gitea: GiteaTarget,
    github_base: String,
    github_repo: String,
    github_token: Option<String>,
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

    async fn gitea_request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<HttpResponse> {
        let url = gitea::api_url(&self.gitea, path);
        let mut headers = self.gitea_headers("application/json");
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

    async fn gitea_upload(
        &self,
        release_id: u64,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<HttpResponse> {
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
        self.send(HttpRequest {
            method: "POST".to_string(),
            url,
            headers,
            body,
        })
        .await
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

    async fn gitea_tag_commit(&self, tag: &str) -> Result<Option<String>> {
        let path = format!(
            "{}/git/refs/tags/{}",
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
        let document = response.json()?;
        let object = document.get("object");
        let sha = object
            .and_then(|value| value.get("sha"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if sha.is_empty() {
            return Ok(None);
        }
        let kind = object
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind != "tag" {
            return Ok(Some(sha.to_string()));
        }
        let path = format!(
            "{}/git/tags/{}",
            gitea::repo_path(&self.gitea),
            encode_component(sha)
        );
        let annotated = self.gitea_json("GET", &path, None).await?;
        let commit = annotated
            .get("object")
            .and_then(|value| value.get("sha"))
            .and_then(Value::as_str)
            .unwrap_or("");
        Ok((!commit.is_empty()).then(|| commit.to_string()))
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

    async fn gitea_create_release(&self, tag: &str, version: &str, commit: &str) -> Result<u64> {
        let path = format!("{}/releases", gitea::repo_path(&self.gitea));
        let document = self
            .gitea_json(
                "POST",
                &path,
                Some(json!({
                    "tag_name": tag,
                    "target_commitish": commit,
                    "name": format!("Devboard {version}"),
                    "body": format!(
                        "Devboard {version}\n\nGitHub release: https://github.com/{}/releases/tag/{tag}",
                        self.github_repo
                    ),
                    "draft": false,
                    "prerelease": false,
                })),
            )
            .await?;
        document
            .get("id")
            .and_then(Value::as_u64)
            .context("the created release has no identifier")
    }

    async fn github_runs(&self, commit: &str) -> Result<Vec<WorkflowRun>> {
        let path = format!(
            "/repos/{}/actions/workflows/{}/runs?head_sha={}&per_page=50",
            github_repo_path(&self.github_repo),
            encode_component(RELEASE_WORKFLOW),
            encode_component(commit)
        );
        let document = self
            .github_json("GET", &path, None, "application/vnd.github+json")
            .await?;
        Ok(workflow_runs(&document))
    }

    async fn github_dispatch(&self, workflow: &str, reference: &str) -> Result<()> {
        if self.github_token.as_deref().unwrap_or("").is_empty() {
            bail!("GH_TOKEN is required to dispatch the release workflow");
        }
        let path = format!(
            "/repos/{}/actions/workflows/{}/dispatches",
            github_repo_path(&self.github_repo),
            encode_component(workflow)
        );
        let response = self
            .github_request(
                "POST",
                &path,
                Some(json!({ "ref": reference })),
                "application/vnd.github+json",
            )
            .await?;
        if !(200..300).contains(&response.status) {
            bail!(
                "POST {}{} failed (HTTP {}): {}",
                self.github_base.trim_end_matches('/'),
                path,
                response.status,
                failure_message(&response)
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

    preflight.published = refresh_main(&args, runner.as_ref(), &preflight.remote, &log).await?;

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
        gitea,
        github_base,
        github_repo,
        github_token,
    };
    let git = Git::new(runner.as_ref(), &args.repo_dir, &args.environment);

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
    let existing_at_head = git.tag_commit(&tag).await.as_deref() == Some(published_head.as_str());
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

        bump_workspace_version(&args.harness_root.join("Cargo.toml"), &version)?;
        refresh_lockfile(git.runner, &args.environment, &args.harness_root).await?;
        let manifest = relative_git_path(&args.repo_dir, &args.harness_root.join("Cargo.toml"));
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

    (log)(&format!("pushing {tag} and main to {}", preflight.remote));
    let pushed = git
        .run(&[
            "push",
            &preflight.remote,
            "refs/heads/main:refs/heads/main",
            &format!("refs/tags/{tag}:refs/tags/{tag}"),
        ])
        .await;
    if pushed.code != 0 {
        bail!(
            "could not push main and {tag} to {}: {}",
            preflight.remote,
            first_line(if pushed.stderr.is_empty() {
                pushed.stdout.as_str()
            } else {
                pushed.stderr.as_str()
            })
        );
    }

    // The workflow lives on GitHub, so the mirror receives the tagged commit
    // before the run can be selected or dispatched.
    if preflight.remotes.iter().any(|remote| remote == "github") {
        push_github_mirror(&git, &commit, &log).await?;
    } else {
        (log)("no github mirror remote; skipped");
    }

    let workflow_run =
        dispatch_and_wait(&api, &clock, &sleeper, &args, &commit, &tag, &log).await?;

    let verified =
        verify_github_assets(&api, &clock, &sleeper, &args, &tag, &version, &log).await?;
    let manifest_text = String::from_utf8_lossy(&verified.manifest).into_owned();

    write_gitea_release(&api, &git, &version, &tag, &commit, &verified, &log).await?;

    let mirror_state = if preflight.remotes.iter().any(|remote| remote == "github") {
        Some(mirror_carries(&git, &commit).await)
    } else {
        None
    };
    if let Some((sha, carries)) = mirror_state {
        if !carries {
            bail!(
                "the GitHub mirror main ({}) does not name {}",
                if sha.is_empty() {
                    "missing".to_string()
                } else {
                    short_sha(&sha)
                },
                short_sha(&commit)
            );
        }
        (log)(&format!("github/main carries {}", short_sha(&commit)));
    }

    let dist_dir = args.harness_root.join("dist");
    let instances = args
        .instances
        .clone()
        .unwrap_or_else(discover_dashboard_instances);
    let source_refresh = deliver_source_refresh(SourceRefreshOptions {
        repo_root: args.repo_dir.clone(),
        harness_root: args.harness_root.clone(),
        commit: commit.clone(),
        version: version.clone(),
        dist_dir,
        instances,
        requested_at: iso_from_millis(clock.now_millis()),
    })
    .await?;
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

/// Fetches the canonical `main` and fast-forwards without discarding work.
async fn refresh_main(
    args: &PublishArgs,
    runner: &dyn CommandRunner,
    remote: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<String> {
    let git = Git::new(runner, &args.repo_dir, &args.environment);
    (log)(&format!("fetching {remote}/main"));
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
            "could not fetch {remote}/main: {}",
            first_line(if fetched.stderr.is_empty() {
                fetched.stdout.as_str()
            } else {
                fetched.stderr.as_str()
            })
        );
    }

    let head = git
        .must(&["rev-parse", "HEAD"], "could not read HEAD")
        .await?;
    let tip = git
        .must(
            &["rev-parse", &format!("{remote}/main")],
            &format!("could not read {remote}/main"),
        )
        .await?;
    if head != tip {
        if !git.is_ancestor(&head, &tip).await {
            bail!(
                "local main is ahead of or diverged from {remote}/main; integrate and push the worktree first"
            );
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
    } else {
        (log)(&format!("main is at {}", short_sha(&head)));
    }

    git.must(
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
    let project = args
        .environment
        .get("DEVBOARD_RELEASE_REPO")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let target = forge::gitea_target(
        parsed.as_ref(),
        project.as_deref(),
        None,
        None,
        &args.environment,
    )
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
            args: vec![
                "metadata".to_string(),
                "--format-version=1".to_string(),
                "--no-deps".to_string(),
            ],
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

fn relative_git_path(repo_dir: &Path, path: &Path) -> String {
    path.strip_prefix(repo_dir)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// GitHub workflow selection and waiting

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
    let runs = api.github_runs(commit).await?;
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
    api.github_dispatch(RELEASE_WORKFLOW, &format!("refs/tags/{tag}"))
        .await
        .with_context(|| {
            format!(
                "could not dispatch {RELEASE_WORKFLOW} for {}",
                short_sha(commit)
            )
        })?;
    (log)(&format!(
        "dispatched {RELEASE_WORKFLOW} for {}",
        short_sha(commit)
    ));
    Ok(DispatchAttempt {
        dispatched: true,
        previous_ids,
    })
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
    let attempt = dispatch_release_when_needed(api, commit, tag, log).await?;
    let deadline = clock.now_millis() + args.wait_timeout.as_millis() as i64;
    let mut selected: Option<WorkflowRun> = None;
    loop {
        if clock.now_millis() >= deadline {
            break;
        }
        let runs = api.github_runs(commit).await?;
        let candidates: Vec<WorkflowRun> = if attempt.dispatched {
            runs.into_iter()
                .filter(|run| !attempt.previous_ids.contains(&run.id))
                .collect()
        } else {
            runs
        };
        if let Some(run) = choose_workflow_run(&candidates, commit) {
            let finished = workflow_finished(&run);
            selected = Some(run);
            if finished {
                break;
            }
        }
        sleeper.sleep(args.poll_interval).await;
    }
    let Some(workflow) = selected else {
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
        bail!(
            "the release workflow concluded {}",
            if concluded.is_empty() {
                "no conclusion".to_string()
            } else {
                concluded
            }
        );
    }
    (log)(&format!("release workflow {} succeeded", workflow.id));
    Ok(workflow.id)
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
        let (url, digest, checksum) = verify_one_asset(api, &assets, &name).await?;
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
    let expected = unified
        .get(name)
        .or_else(|| {
            Path::new(name)
                .file_name()
                .and_then(|value| value.to_str())
                .and_then(|value| unified.get(value))
        })
        .ok_or_else(|| anyhow!("sha256.sum does not name {name}"))?;
    if expected != &digest {
        bail!("{name} does not match sha256.sum");
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

async fn push_github_mirror(
    git: &Git<'_>,
    commit: &str,
    log: &Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<()> {
    (log)("pushing the GitHub mirror");
    let pushed = git
        .run(&[
            "-c",
            "credential.helper=",
            "-c",
            "credential.https://github.com.helper=!/usr/bin/gh auth git-credential",
            "push",
            "github",
            "refs/heads/main:refs/heads/main",
            "refs/tags/*:refs/tags/*",
        ])
        .await;
    if pushed.code != 0 {
        let (sha, carries) = mirror_carries(git, commit).await;
        if !carries {
            bail!(
                "could not push the GitHub mirror: {}",
                first_line(if pushed.stderr.is_empty() {
                    pushed.stdout.as_str()
                } else {
                    pushed.stderr.as_str()
                })
            );
        }
        (log)(&format!(
            "the GitHub mirror moved to {} during the push and already carries main",
            short_sha(&sha)
        ));
    }
    Ok(())
}

async fn mirror_carries(git: &Git<'_>, commit: &str) -> (String, bool) {
    let tip = git.run(&["ls-remote", "github", "refs/heads/main"]).await;
    let sha = tip
        .stdout
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    if tip.code != 0 || sha.is_empty() {
        return (sha, false);
    }
    if sha == commit {
        return (sha, true);
    }
    let carries = git.is_ancestor(commit, &sha).await;
    (sha, carries)
}

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
        });
    }

    let mut written = Vec::new();
    let mut applied = Vec::new();
    let mut failed = Vec::new();
    let mut outcomes: HashMap<PathBuf, Result<(), String>> = HashMap::new();
    for instance in &options.instances {
        if !same_path(&instance.repo_dir, &repo_root) {
            continue;
        }
        if !same_path(&instance.harness, &harness_root) {
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
    let self_pid = std::process::id();
    let mut instances = Vec::new();
    let mut seen = HashSet::new();
    for process in crate::supervision::process_table() {
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
        let Some(port) = process
            .env
            .get("PORT")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0)
        else {
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
            .or_else(|| process.cwd.clone());
        let Some(harness) = harness else {
            continue;
        };
        let state_dir = process
            .env
            .get("STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| harness.join(".tmp"));
        let key = format!("{repo_dir}\0{port}");
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
