//! Forge identity, credentials, and REST access shared by every Devboard
//! surface.
//!
//! The canonical forge is read from the checkout's `origin` remote, never from
//! a literal in this repository. GitHub and GitLab are recognised by host name;
//! every other git host is treated as a Gitea instance, whose HTTP address comes
//! from the environment or, for an HTTP(S) origin, from the remote itself.
//!
//! The Gitea API is the one HTTP forge this module speaks directly. GitHub and
//! GitLab credentials are resolved through their CLIs, exactly as the
//! TypeScript harness does, so a stale ambient token never decides which
//! identity writes. Every HTTP call takes an injectable transport and every
//! command takes an injectable runner, so the contract can be tested against
//! stub servers without a network or a real credential.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::future::join_all;
use regex::Regex;
use serde_json::{json, Map, Value};
use url::Url;

/// A process environment, or the environment a test supplies.
pub type Environment = HashMap<String, String>;

/// The process environment as a map.
pub fn process_environment() -> Environment {
    std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// One environment from literal pairs, for tests and callers.
pub fn environment(pairs: &[(&str, &str)]) -> Environment {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

fn trimmed(value: Option<&str>) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    let trimmed = trimmed.trim_end_matches('/');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn env_value<'a>(environment: &'a Environment, key: &str) -> Option<&'a str> {
    environment.get(key).map(String::as_str)
}

// ---------------------------------------------------------------------------
// Forge identity and addresses

/// The three forges the harness names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Forge {
    GitHub,
    GitLab,
    Gitea,
}

impl Forge {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
            Self::Gitea => "gitea",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "github" => Some(Self::GitHub),
            "gitlab" => Some(Self::GitLab),
            "gitea" => Some(Self::Gitea),
            _ => None,
        }
    }
}

/// One classified remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeRemote {
    pub forge: Forge,
    /// Hostname only; no credentials and no port.
    pub host: String,
    /// `owner/name` for GitHub and Gitea, all namespace segments for GitLab.
    pub project: String,
    /// The HTTP origin plus the path prefix the repository sits under.
    pub origin_url: Option<String>,
}

/// The Gitea HTTP origin the environment configures, if any.
pub const GITEA_URL_KEYS: [&str; 2] = ["DEVBOARD_GITEA_URL", "GITEA_URL"];
/// The Gitea token keys, in resolution order.
pub const GITEA_TOKEN_KEYS: [&str; 2] = ["GITEA_TOKEN", "DEVBOARD_GITEA_TOKEN"];
/// The synthetic token used by a public forge with no configured credential.
pub const PUBLIC_FORGE_TOKEN: &str = "";

pub fn configured_gitea_url(environment: &Environment) -> Option<String> {
    for key in GITEA_URL_KEYS {
        let value = trimmed(env_value(environment, key));
        if value.is_some() {
            return value;
        }
    }
    None
}

pub fn configured_gitea_token(environment: &Environment) -> Option<String> {
    for key in GITEA_TOKEN_KEYS {
        let value = trimmed(env_value(environment, key));
        if let Some(value) = value {
            return Some(value);
        }
    }
    None
}

fn valid_project_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn path_segments(path: &str) -> Vec<String> {
    let mut value = path.trim_start_matches('/').trim_end_matches('/');
    if value.len() >= 4 && value[value.len() - 4..].eq_ignore_ascii_case(".git") {
        value = &value[..value.len() - 4];
    }
    value
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect()
}

/// The repository path a forge addresses. GitHub and Gitea name exactly
/// `owner/name`, so only the final two segments count. A GitLab project keeps
/// its whole namespace.
pub fn project_from_path(path: &str, forge: Forge) -> Option<String> {
    let segments = path_segments(path);
    if segments.len() < 2 {
        return None;
    }
    let kept: Vec<String> = match forge {
        Forge::GitLab => segments.clone(),
        Forge::GitHub | Forge::Gitea => segments[segments.len() - 2..].to_vec(),
    };
    if !kept.iter().all(|segment| valid_project_segment(segment)) {
        return None;
    }
    Some(kept.join("/"))
}

fn instance_prefix(path: &str, forge: Forge) -> String {
    let segments = path_segments(path);
    let kept = match forge {
        Forge::GitLab => segments.len(),
        Forge::GitHub | Forge::Gitea => 2,
    };
    let split = segments.len().saturating_sub(kept);
    let prefix = &segments[..split];
    if prefix.is_empty() {
        String::new()
    } else {
        format!("/{}", prefix.join("/"))
    }
}

/// The forge a hostname names. An explicit `DEVBOARD_FORGE` always wins.
pub fn forge_from_host(host: &str, environment: &Environment) -> Forge {
    let lower = host.to_ascii_lowercase();
    let forced =
        trimmed(env_value(environment, "DEVBOARD_FORGE")).map(|value| value.to_ascii_lowercase());
    if let Some(forge) = forced.as_deref().and_then(Forge::parse) {
        return forge;
    }
    if lower == "github.com" {
        return Forge::GitHub;
    }
    if lower.contains("gitlab") {
        Forge::GitLab
    } else {
        Forge::Gitea
    }
}

fn scp_remote_regex() -> &'static Regex {
    static REGEX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:[^@/\s]+@)?([^:/\s]+):(.+)$").expect("the scp form"));
    &REGEX
}

/// Classifies a git remote. `None` for a local path or a remote without a
/// repository path. An explicit `DEVBOARD_FORGE` pins a self-hosted forge.
pub fn parse_forge_remote(remote: &str, environment: &Environment) -> Option<ForgeRemote> {
    let value = remote.trim();
    if value.is_empty() || value.starts_with('/') || value.starts_with('.') {
        return None;
    }

    let scp = scp_remote_regex().captures(value);
    let (host, path, http_origin) = if let Some(captures) = scp.filter(|_| !value.contains("://")) {
        let host = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let path = captures
            .get(2)
            .map(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        (host, path, None)
    } else {
        let parsed = Url::parse(value).ok()?;
        if !matches!(parsed.scheme(), "http" | "https" | "ssh" | "git") {
            return None;
        }
        let host = parsed.host_str().unwrap_or("").to_string();
        let path = parsed.path().to_string();
        let origin = if parsed.scheme() == "http" || parsed.scheme() == "https" {
            Some(parsed.origin().ascii_serialization())
        } else {
            None
        };
        (host, path, origin)
    };

    if host.is_empty() {
        return None;
    }
    let forge = forge_from_host(&host, environment);
    let project = project_from_path(&path, forge)?;
    let origin_url = http_origin.map(|origin| format!("{origin}{}", instance_prefix(&path, forge)));
    Some(ForgeRemote {
        forge,
        host: host.to_ascii_lowercase(),
        project,
        origin_url,
    })
}

/// The Gitea instance address for a resolved remote: explicit configuration
/// first, then the HTTP(S) remote's instance address.
pub fn gitea_base_url(remote: Option<&ForgeRemote>, environment: &Environment) -> Option<String> {
    let configured = configured_gitea_url(environment);
    if configured.is_some() {
        return configured;
    }
    remote
        .filter(|remote| remote.forge == Forge::Gitea)
        .and_then(|remote| remote.origin_url.clone())
}

// ---------------------------------------------------------------------------
// Git checkout facts

/// One git command's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs one git command with its streams captured and trimmed.
pub fn git(directory: &Path, args: &[&str]) -> GitOutcome {
    let result = ProcessCommand::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    match result {
        Ok(output) => GitOutcome {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        },
        Err(error) => GitOutcome {
            code: 1,
            stdout: String::new(),
            stderr: error.to_string(),
        },
    }
}

/// The checkout root containing `directory`, or `None` outside a checkout.
pub fn top_level(directory: &Path) -> Option<String> {
    let result = git(directory, &["rev-parse", "--show-toplevel"]);
    (result.code == 0 && !result.stdout.is_empty()).then_some(result.stdout)
}

/// Whether the checkout at `root` is a linked worktree, not the canonical one.
pub fn is_linked_worktree(root: &Path) -> bool {
    let absolute = git(root, &["rev-parse", "--absolute-git-dir"]);
    let common = git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    if absolute.code != 0 || common.code != 0 {
        return false;
    }
    !absolute.stdout.is_empty() && absolute.stdout != common.stdout
}

/// Repository path from any git remote URL form, or `None`.
pub fn repository_from_url(url: &str, environment: &Environment) -> Option<String> {
    parse_forge_remote(url, environment).map(|remote| remote.project)
}

/// The remote URL of `origin`, if the checkout has one.
pub fn origin_remote_url(root: &Path) -> Option<String> {
    let remote = git(root, &["remote", "get-url", "origin"]);
    (remote.code == 0 && !remote.stdout.is_empty()).then_some(remote.stdout)
}

/// Whether the remote URL names github.com.
pub fn is_github_remote(url: &str) -> bool {
    static SCP: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+@([^:/]+):").expect("the scp form"));
    let trimmed = url.trim();
    if let Some(captures) = SCP.captures(trimmed) {
        return captures
            .get(1)
            .map(|host| host.as_str().eq_ignore_ascii_case("github.com"))
            .unwrap_or(false);
    }
    Url::parse(trimmed)
        .ok()
        .and_then(|parsed| {
            parsed
                .host_str()
                .map(|host| host.eq_ignore_ascii_case("github.com"))
        })
        .unwrap_or(false)
}

fn lexical_absolute(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The forge the checkout's origin names, or `None` outside a supported remote.
pub fn origin_forge(root: &Path) -> Option<ForgeRemote> {
    origin_forge_with(root, &process_environment())
}

/// The forge the checkout's origin names under a supplied environment.
pub fn origin_forge_with(root: &Path, environment: &Environment) -> Option<ForgeRemote> {
    // A directory below a checkout must not inherit that checkout's remote:
    // the caller's root is the host, and only its own top level names the origin.
    let top = git(root, &["rev-parse", "--show-toplevel"]);
    if top.code != 0 {
        return None;
    }
    let found = lexical_absolute(Path::new(&top.stdout));
    if found != lexical_absolute(root) {
        return None;
    }
    let remote = origin_remote_url(root)?;
    parse_forge_remote(&remote, environment)
}

/// The repository path the checkout's origin names, or `None`.
pub fn origin_repository(root: &Path) -> Option<String> {
    origin_repository_with(root, &process_environment())
}

pub fn origin_repository_with(root: &Path, environment: &Environment) -> Option<String> {
    let url = origin_remote_url(root)?;
    repository_from_url(&url, environment)
}

/// A live `owner/name` lookup for a process that outlives the origin's setup.
pub struct CachedRepository {
    root: PathBuf,
    ttl_ms: u64,
    value: Option<String>,
    checked_at: i64,
}

impl CachedRepository {
    pub fn new(root: impl Into<PathBuf>, ttl_ms: u64) -> Self {
        let root = root.into();
        let value = origin_repository(&root);
        Self {
            root,
            ttl_ms,
            value,
            checked_at: now_millis(),
        }
    }

    pub fn get(&mut self) -> Option<String> {
        let now = now_millis();
        if now - self.checked_at >= self.ttl_ms as i64 {
            self.value = origin_repository(&self.root);
            self.checked_at = now;
        }
        self.value.clone()
    }
}

/// Whether a value is a repository path: `owner/name`, or a GitLab namespace.
pub fn is_repository_name(value: &str) -> bool {
    static REGEX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$").expect("the repository form")
    });
    REGEX.is_match(value)
}

/// The harness directory a canonical checkout carries.
pub fn harness_directory(root: &Path) -> PathBuf {
    root.join(".devboard")
}

/// Validates a root as the canonical checkout carrying `.devboard/`.
pub fn root_problem(root: &Path) -> Option<String> {
    let absolute = lexical_absolute(root);
    let text = path_text(&absolute);
    if !absolute.exists() {
        return Some(format!("{text} does not exist"));
    }
    let Some(top) = top_level(&absolute) else {
        return Some(format!("{text} is not a git checkout"));
    };
    let top_path = lexical_absolute(Path::new(&top));
    if top_path != absolute {
        return Some(format!(
            "{text} is not the checkout root ({} is)",
            path_text(&top_path)
        ));
    }
    if is_linked_worktree(&absolute) {
        return Some(format!(
            "{text} is a linked git worktree, not the canonical checkout"
        ));
    }
    if !harness_directory(&absolute).exists() {
        return Some(format!("{text} has no .devboard directory"));
    }
    None
}

/// Resolves symlinks so a worker started from a link sees the real harness.
pub fn real_directory(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// Finds an executable the way a shell would, using the supplied environment.
pub fn find_on_path(name: &str, environment: &Environment) -> Option<PathBuf> {
    let path = env_value(environment, "PATH").unwrap_or("");
    for directory in path.split(':') {
        if directory.is_empty() {
            continue;
        }
        let candidate = Path::new(directory).join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Clock and HTTP transport

/// Unix milliseconds, the clock the retry and deadline code reads.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// One HTTP request an injected transport sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// Per-request bound; the transport falls back to its own default.
    pub timeout_ms: Option<u64>,
}

/// One HTTP response; the body is bytes so a caller can decode what it needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    Timeout,
    Unreachable(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout => formatter.write_str("the request timed out"),
            Self::Unreachable(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for HttpError {}

pub type HttpFuture = Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send>>;
/// The injected-transport seam, the Rust form of the TypeScript `FetchLike`.
pub type Transport = Arc<dyn Fn(HttpRequest) -> HttpFuture + Send + Sync>;

/// The real transport, bounded per request (or by `default_timeout_ms`).
pub fn default_transport(default_timeout_ms: u64) -> Transport {
    Arc::new(move |request: HttpRequest| -> HttpFuture {
        Box::pin(async move {
            static CLIENT: LazyLock<Option<reqwest::Client>> =
                LazyLock::new(|| reqwest::Client::builder().build().ok());
            let Some(client) = CLIENT.as_ref() else {
                return Err(HttpError::Unreachable(
                    "could not build the HTTP client".to_string(),
                ));
            };
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| HttpError::Unreachable(error.to_string()))?;
            let timeout =
                Duration::from_millis(request.timeout_ms.unwrap_or(default_timeout_ms).max(1));
            let mut builder = client.request(method, &request.url).timeout(timeout);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }
            let response = builder.send().await.map_err(|error| {
                if error.is_timeout() {
                    HttpError::Timeout
                } else {
                    HttpError::Unreachable(error.to_string())
                }
            })?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_string(), value.to_string()))
                })
                .collect();
            let body = response
                .bytes()
                .await
                .map_err(|error| HttpError::Unreachable(error.to_string()))?;
            Ok(HttpResponse {
                status,
                headers,
                body: body.to_vec(),
            })
        })
    })
}

/// One response header, matched case-insensitively.
pub fn response_header<'a>(response: &'a HttpResponse, name: &str) -> Option<&'a str> {
    response
        .headers
        .iter()
        .find(|(header, _)| header.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// One response body as text, lossily decoded.
pub fn response_text(response: &HttpResponse) -> String {
    String::from_utf8_lossy(&response.body).into_owned()
}

/// The first non-empty line, trimmed, or `no diagnostic`.
pub fn first_line(text: &str) -> String {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic")
        .to_string()
}

fn truncate_300(value: &str) -> String {
    if value.encode_utf16().count() > 300 {
        format!("{}…", crate::feedback::js_truncate(value, 300))
    } else {
        value.to_string()
    }
}

// ---------------------------------------------------------------------------
// Commit text helpers

/// The most candidates one issue may resolve, so a verbose thread stays bounded.
pub const COMMIT_CANDIDATE_LIMIT: usize = 12;

pub fn is_sha(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn is_full_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Every 7-40 character hex token in a comment, in the order it appears.
pub fn sha_tokens(text: &str) -> Vec<String> {
    static REGEX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\b[0-9a-fA-F]{7,40}\b").expect("the sha token form"));
    REGEX
        .find_iter(text)
        .map(|found| found.as_str().to_string())
        .collect()
}

/// The commit candidates a comment set names, newest comment first and last
/// token first inside one comment.
pub fn commit_candidates_from_comments(comments: &[String], limit: usize) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for comment in comments.iter().rev() {
        let tokens = sha_tokens(comment);
        for token in tokens.iter().rev() {
            if !seen.insert(token.clone()) {
                continue;
            }
            candidates.push(token.clone());
            if candidates.len() >= limit {
                return candidates;
            }
        }
    }
    candidates
}

/// The newest comment that carries a SHA yields its last SHA; else `None`.
pub fn closing_commit_from_comments(comments: &[String]) -> Option<String> {
    commit_candidates_from_comments(comments, 1)
        .into_iter()
        .next()
}

// ---------------------------------------------------------------------------
// Gitea REST client

/// How long one API call waits when the caller supplies no bound.
pub const GITEA_REQUEST_TIMEOUT_MS: u64 = 30_000;
pub const GITEA_PAGE_SIZE: usize = 50;
pub const GITEA_MAX_PAGES: usize = 100;
/// The most issues one paged Gitea issue read returns.
pub const GITEA_ISSUE_READ_MAX: usize = GITEA_MAX_PAGES * GITEA_PAGE_SIZE;

/// One Gitea target: origin, `owner/name` project, and an optional token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiteaTarget {
    /// HTTP origin, without a trailing slash.
    pub base_url: String,
    /// `owner/name`.
    pub project: String,
    pub token: Option<String>,
}

/// One failure from the Gitea API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiteaError {
    pub status: Option<u16>,
    pub message: String,
}

impl GiteaError {
    pub fn new(message: impl Into<String>, status: Option<u16>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for GiteaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GiteaError {}

/// Cancellation correlation for one API call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GiteaCallOptions {
    /// The caller's `X-Flow-ID`, sent so both sides correlate.
    pub flow_id: Option<String>,
    /// Per-request bound; defaults to `GITEA_REQUEST_TIMEOUT_MS`.
    pub timeout_ms: Option<u64>,
}

impl GiteaCallOptions {
    pub fn with_flow_id(flow_id: impl Into<String>) -> Self {
        Self {
            flow_id: Some(flow_id.into()),
            timeout_ms: None,
        }
    }
}

/// The method and body of one API call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GiteaRequestInit {
    pub method: Option<String>,
    pub body: Option<Vec<u8>>,
}

impl GiteaRequestInit {
    pub fn get() -> Self {
        Self::default()
    }

    pub fn post(body: Vec<u8>) -> Self {
        Self {
            method: Some("POST".to_string()),
            body: Some(body),
        }
    }

    pub fn patch(body: Vec<u8>) -> Self {
        Self {
            method: Some("PATCH".to_string()),
            body: Some(body),
        }
    }

    pub fn delete() -> Self {
        Self {
            method: Some("DELETE".to_string()),
            body: None,
        }
    }

    pub fn method(&self) -> &str {
        self.method.as_deref().unwrap_or("GET")
    }
}

fn required(value: &str, name: &str) -> Result<String, GiteaError> {
    if value.trim().is_empty() {
        return Err(GiteaError::new(format!("{name} is not configured"), None));
    }
    Ok(value.to_string())
}

/// Resolves the API target from explicit arguments, the environment, and the
/// remote.
pub fn gitea_target(
    remote: Option<&ForgeRemote>,
    project: Option<&str>,
    base_url: Option<&str>,
    token: Option<&str>,
    environment: &Environment,
) -> Result<GiteaTarget, GiteaError> {
    let project = required(
        project
            .or_else(|| remote.map(|remote| remote.project.as_str()))
            .unwrap_or(""),
        "the Gitea repository",
    )?;
    let configured_base = gitea_base_url(remote, environment);
    let base_url = required(
        base_url.or(configured_base.as_deref()).unwrap_or(""),
        "the Gitea address (set DEVBOARD_GITEA_URL)",
    )?;
    let token = token
        .map(str::to_string)
        .or_else(|| configured_gitea_token(environment));
    Ok(GiteaTarget {
        base_url: base_url.trim_end_matches('/').to_string(),
        project,
        token,
    })
}

/// `/api/v1` under the configured origin.
pub fn api_url(target: &GiteaTarget, path: &str) -> String {
    let suffix = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    format!("{}/api/v1{suffix}", target.base_url)
}

/// `/repos/<owner>/<name>` with each path segment encoded.
pub fn repo_path(target: &GiteaTarget) -> String {
    let segments: Vec<String> = target
        .project
        .split('/')
        .map(encode_uri_component)
        .collect();
    format!("/repos/{}", segments.join("/"))
}

/// One segment encoded exactly as `encodeURIComponent` does.
fn encode_uri_component(value: &str) -> String {
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

fn gitea_headers(target: &GiteaTarget, accept: &str) -> Vec<(String, String)> {
    let mut headers = vec![("Accept".to_string(), accept.to_string())];
    if let Some(token) = target.token.as_deref().filter(|token| !token.is_empty()) {
        headers.push(("Authorization".to_string(), format!("token {token}")));
    }
    headers
}

/// The exact header form Gitea expects for a configured credential.
pub fn gitea_authorization(token: &str) -> String {
    format!("token {token}")
}

fn message_from_body(body: &str) -> String {
    let first = body
        .split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty());
    let Some(first) = first else {
        return "no response body".to_string();
    };
    if let Ok(parsed) = serde_json::from_str::<Value>(first) {
        if let Some(message) = parsed.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    truncate_300(first)
}

fn json_body(value: &Value) -> Vec<u8> {
    crate::jsjson::stringify(value).into_bytes()
}

/// One API call; a non-2xx status becomes a `GiteaError` with the server
/// message.
pub async fn gitea_request(
    target: &GiteaTarget,
    path: &str,
    init: Option<GiteaRequestInit>,
    transport: &Transport,
    accept: Option<&str>,
    options: &GiteaCallOptions,
) -> Result<HttpResponse, GiteaError> {
    let init = init.unwrap_or_default();
    let method = init.method().to_string();
    let mut headers = gitea_headers(target, accept.unwrap_or("application/json"));
    if let Some(flow_id) = options.flow_id.as_deref() {
        headers.push(("X-Flow-ID".to_string(), flow_id.to_string()));
    }
    if init.body.is_some() {
        let has_content_type = headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-type"));
        if !has_content_type {
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
        }
    }
    let request = HttpRequest {
        method: method.clone(),
        url: api_url(target, path),
        headers,
        body: init.body,
        timeout_ms: Some(options.timeout_ms.unwrap_or(GITEA_REQUEST_TIMEOUT_MS)),
    };
    let response = transport(request)
        .await
        .map_err(|error| GiteaError::new(error.to_string(), None))?;
    if (200..300).contains(&response.status) {
        return Ok(response);
    }
    let body = response_text(&response);
    Err(GiteaError::new(
        format!(
            "{method} {path} failed (HTTP {}): {}",
            response.status,
            message_from_body(&body)
        ),
        Some(response.status),
    ))
}

/// One JSON API call.
pub async fn gitea_json(
    target: &GiteaTarget,
    path: &str,
    init: Option<GiteaRequestInit>,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Value, GiteaError> {
    let init = init.unwrap_or_default();
    let method = init.method().to_string();
    let response = gitea_request(target, path, Some(init), transport, None, options).await?;
    let text = response_text(&response);
    serde_json::from_str(&text).map_err(|_| {
        let first = text
            .trim()
            .split('\n')
            .next()
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let snippet = if first.is_empty() {
            "no output".to_string()
        } else {
            truncate_300(&first)
        };
        GiteaError::new(
            format!("{method} {path} returned invalid JSON: {snippet}"),
            None,
        )
    })
}

/// The repository document, whose `permissions` object the console probes.
#[derive(Debug, Clone, PartialEq)]
pub struct GiteaRepository {
    pub document: Value,
}

impl GiteaRepository {
    pub fn permissions(&self) -> Option<&Value> {
        self.document.get("permissions")
    }

    pub fn full_name(&self) -> Option<&str> {
        self.document.get("full_name").and_then(Value::as_str)
    }

    pub fn private(&self) -> bool {
        self.document.get("private").and_then(Value::as_bool) == Some(true)
    }
}

pub async fn gitea_repository(
    target: &GiteaTarget,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<GiteaRepository, GiteaError> {
    let document = gitea_json(target, &repo_path(target), None, transport, options).await?;
    Ok(GiteaRepository { document })
}

/// The account a token belongs to.
pub async fn gitea_user(
    target: &GiteaTarget,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<String, GiteaError> {
    let document = gitea_json(target, "/user", None, transport, options).await?;
    Ok(document
        .get("login")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueState {
    Open,
    Closed,
}

impl IssueState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
        }
    }
}

/// The state one issue page is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueQueryState {
    Open,
    Closed,
    All,
}

impl IssueQueryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::All => "all",
        }
    }
}

/// One issue as Gitea reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiteaIssueDocument {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub state: IssueState,
    pub body: String,
    pub labels: Vec<String>,
}

fn label_names(value: Option<&Value>) -> Vec<String> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in entries {
        if let Some(name) = entry.as_str() {
            names.push(name.to_string());
        } else if let Some(name) = entry.get("name").and_then(Value::as_str) {
            names.push(name.to_string());
        }
    }
    names
}

fn issue_state_of(value: Option<&Value>) -> IssueState {
    if value.and_then(Value::as_str) == Some("closed") {
        IssueState::Closed
    } else {
        IssueState::Open
    }
}

fn issue_from_document(value: &Value) -> Option<GiteaIssueDocument> {
    let number = value.get("number").and_then(Value::as_i64)?;
    let title = value.get("title").and_then(Value::as_str)?;
    let url = value.get("html_url").and_then(Value::as_str)?;
    let created_at = value
        .get("created_at")
        .and_then(Value::as_str)
        .or_else(|| value.get("createdAt").and_then(Value::as_str))
        .unwrap_or("1970-01-01T00:00:00.000Z")
        .to_string();
    let closed_at = value
        .get("closed_at")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(GiteaIssueDocument {
        number,
        title: title.to_string(),
        url: url.to_string(),
        created_at,
        closed_at,
        state: issue_state_of(value.get("state")),
        body: value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        labels: label_names(value.get("labels")),
    })
}

/// One issue by number, with its labels and body.
pub async fn gitea_issue(
    target: &GiteaTarget,
    number: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<GiteaIssueDocument, GiteaError> {
    let path = format!("{}/issues/{number}", repo_path(target));
    let document = gitea_json(target, &path, None, transport, options).await?;
    issue_from_document(&document)
        .ok_or_else(|| GiteaError::new("the issue has no number, title, or URL", None))
}

/// Every issue in the requested state, pull requests excluded, ascending.
pub async fn gitea_list_issues(
    target: &GiteaTarget,
    state: IssueQueryState,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Vec<GiteaIssueDocument>, GiteaError> {
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    for page in 1..=GITEA_MAX_PAGES {
        let path = format!(
            "{}/issues?state={}&type=issues&limit={}&page={page}",
            repo_path(target),
            state.as_str(),
            GITEA_PAGE_SIZE
        );
        let document = gitea_json(target, &path, None, transport, options).await?;
        let Some(entries) = document.as_array() else {
            break;
        };
        if entries.is_empty() {
            break;
        }
        let mut added = 0;
        for entry in entries {
            let Some(issue) = issue_from_document(entry) else {
                continue;
            };
            if !seen.insert(issue.number) {
                continue;
            }
            issues.push(issue);
            added += 1;
        }
        // A server that ignores the page parameter repeats the first response;
        // treating a page without new issues as the end keeps this loop finite.
        if added == 0 {
            break;
        }
    }
    issues.sort_by_key(|issue| issue.number);
    Ok(issues)
}

/// One issue to create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateIssueInput {
    pub title: String,
    pub body: String,
    pub labels: Option<Vec<i64>>,
}

pub async fn gitea_create_issue(
    target: &GiteaTarget,
    input: &CreateIssueInput,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<GiteaIssueDocument, GiteaError> {
    let mut body = Map::new();
    body.insert("title".to_string(), json!(input.title));
    body.insert("body".to_string(), json!(input.body));
    if let Some(labels) = &input.labels {
        body.insert("labels".to_string(), json!(labels));
    }
    let path = format!("{}/issues", repo_path(target));
    let document = gitea_json(
        target,
        &path,
        Some(GiteaRequestInit::post(json_body(&Value::Object(body)))),
        transport,
        options,
    )
    .await?;
    issue_from_document(&document)
        .ok_or_else(|| GiteaError::new("the created issue has no number or URL", None))
}

pub async fn gitea_close_issue(
    target: &GiteaTarget,
    number: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<(), GiteaError> {
    let path = format!("{}/issues/{number}", repo_path(target));
    gitea_request(
        target,
        &path,
        Some(GiteaRequestInit::patch(json_body(
            &json!({"state": "closed"}),
        ))),
        transport,
        None,
        options,
    )
    .await?;
    Ok(())
}

pub async fn gitea_comment_issue(
    target: &GiteaTarget,
    number: i64,
    body: &str,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<(), GiteaError> {
    let path = format!("{}/issues/{number}/comments", repo_path(target));
    gitea_request(
        target,
        &path,
        Some(GiteaRequestInit::post(json_body(&json!({"body": body})))),
        transport,
        None,
        options,
    )
    .await?;
    Ok(())
}

/// The commits a Gitea timeline names for the issue's closure, newest first.
pub fn closing_commits_from_gitea_timeline(timeline: &[Value]) -> Vec<String> {
    let mut close_index: Option<usize> = None;
    for (index, entry) in timeline.iter().enumerate().rev() {
        if entry.get("type").and_then(Value::as_str) != Some("close") {
            continue;
        }
        close_index = Some(index);
        if let Some(sha) = entry.get("ref_commit_sha").and_then(Value::as_str) {
            if is_sha(sha) {
                return vec![sha.to_string()];
            }
        }
        if let Some(sha) = entry.get("commit_id").and_then(Value::as_str) {
            if is_sha(sha) {
                return vec![sha.to_string()];
            }
        }
        break;
    }
    let Some(close_index) = close_index else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for entry in timeline[..close_index].iter().rev() {
        if entry.get("type").and_then(Value::as_str) != Some("commit_ref") {
            continue;
        }
        let sha = entry
            .get("ref_commit_sha")
            .and_then(Value::as_str)
            .filter(|value| is_sha(value))
            .or_else(|| entry.get("commit_id").and_then(Value::as_str));
        let Some(sha) = sha.filter(|value| is_sha(value)) else {
            continue;
        };
        if !seen.insert(sha.to_string()) {
            continue;
        }
        candidates.push(sha.to_string());
        if candidates.len() >= COMMIT_CANDIDATE_LIMIT {
            break;
        }
    }
    candidates
}

/// The newest timeline candidate, or `None`.
pub fn closing_commit_from_gitea_timeline(timeline: &[Value]) -> Option<String> {
    closing_commits_from_gitea_timeline(timeline)
        .into_iter()
        .next()
}

fn paged_entry_key(entry: &Value) -> String {
    if let Some(id) = entry.get("id") {
        if let Some(number) = id.as_i64() {
            return format!("id:{number}");
        }
        if let Some(number) = id.as_u64() {
            return format!("id:{number}");
        }
        if let Some(number) = id.as_f64() {
            return format!("id:{}", crate::jsjson::number_f64(number));
        }
        if let Some(text) = id.as_str() {
            return format!("id:{text}");
        }
    }
    format!("entry:{}", crate::jsjson::stringify(entry))
}

/// Every entry of an ascending Gitea issue collection, in server order.
async fn gitea_paged_entries(
    target: &GiteaTarget,
    path: &str,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Vec<Value>, GiteaError> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for page in 1..=GITEA_MAX_PAGES {
        let page_path = format!("{path}?limit={GITEA_PAGE_SIZE}&page={page}");
        let document = gitea_json(target, &page_path, None, transport, options).await?;
        let Some(items) = document.as_array() else {
            break;
        };
        if items.is_empty() {
            break;
        }
        let mut added = 0;
        for entry in items {
            if !seen.insert(paged_entry_key(entry)) {
                continue;
            }
            entries.push(entry.clone());
            added += 1;
        }
        if added == 0 {
            break;
        }
    }
    Ok(entries)
}

/// Every candidate for the commit that shipped a Gitea issue, newest first.
pub async fn gitea_closing_commits(
    target: &GiteaTarget,
    number: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Vec<String>, GiteaError> {
    let timeline_path = format!("{}/issues/{number}/timeline", repo_path(target));
    let timeline = gitea_paged_entries(target, &timeline_path, transport, options).await?;
    let closing = closing_commits_from_gitea_timeline(&timeline);
    if !closing.is_empty() {
        return Ok(closing);
    }
    let comments_path = format!("{}/issues/{number}/comments", repo_path(target));
    let comments = gitea_paged_entries(target, &comments_path, transport, options).await?;
    let bodies: Vec<String> = comments
        .iter()
        .filter_map(|entry| entry.get("body").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    Ok(commit_candidates_from_comments(
        &bodies,
        COMMIT_CANDIDATE_LIMIT,
    ))
}

/// The newest candidate, or `None`.
pub async fn gitea_closing_commit(
    target: &GiteaTarget,
    number: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Option<String>, GiteaError> {
    Ok(gitea_closing_commits(target, number, transport, options)
        .await?
        .into_iter()
        .next())
}

/// The trailing issue number of an issue URL, or `None`.
pub fn issue_number_from_url(url: &str) -> Option<i64> {
    static REGEX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"/issues/(\d+)/?$").expect("the issue URL form"));
    let number = REGEX
        .captures(url.trim())
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<i64>().ok())?;
    (number > 0).then_some(number)
}

fn loopback_hosts() -> &'static HashSet<&'static str> {
    static HOSTS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
        ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]
            .into_iter()
            .collect()
    });
    &HOSTS
}

fn origin_of(parsed: &Url) -> String {
    let host = parsed.host_str().unwrap_or("");
    let host = if loopback_hosts().contains(host) {
        "loopback"
    } else {
        host
    };
    let port = match parsed.port() {
        Some(port) => port.to_string(),
        None if parsed.scheme() == "https" => "443".to_string(),
        None => "80".to_string(),
    };
    format!("{}://{host}:{port}", parsed.scheme())
}

/// The scheme, host, and port of a URL, with loopback aliases folded together.
pub fn gitea_origin(value: &str) -> Option<String> {
    Url::parse(value).ok().map(|parsed| origin_of(&parsed))
}

/// The issue number of `url` when it names an issue on `target`'s origin and
/// repository, or `None` when it belongs to another forge or repository.
pub fn gitea_issue_number(target: &GiteaTarget, url: &str) -> Option<i64> {
    let number = issue_number_from_url(url)?;
    let parsed = Url::parse(url.trim()).ok()?;
    if Some(origin_of(&parsed)) != gitea_origin(&target.base_url) {
        return None;
    }
    let suffix = format!("/issues/{number}");
    let path = parsed.path().trim_end_matches('/');
    if !path.ends_with(&suffix) {
        return None;
    }
    let repository =
        decode_uri_component(path[..path.len() - suffix.len()].trim_start_matches('/'))?;
    (repository == target.project).then_some(number)
}

fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = (bytes[index + 1] as char).to_digit(16)?;
            let low = (bytes[index + 2] as char).to_digit(16)?;
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One repository label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiteaLabel {
    pub id: i64,
    pub name: String,
}

pub async fn gitea_labels(
    target: &GiteaTarget,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Vec<GiteaLabel>, GiteaError> {
    let mut labels = Vec::new();
    let mut seen = HashSet::new();
    for page in 1..=GITEA_MAX_PAGES {
        let path = format!(
            "{}/labels?limit={GITEA_PAGE_SIZE}&page={page}",
            repo_path(target)
        );
        let document = gitea_json(target, &path, None, transport, options).await?;
        let Some(entries) = document.as_array() else {
            break;
        };
        if entries.is_empty() {
            break;
        }
        let mut added = 0;
        for entry in entries {
            let Some(id) = entry.get("id").and_then(Value::as_i64) else {
                continue;
            };
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            labels.push(GiteaLabel {
                id,
                name: name.to_string(),
            });
            added += 1;
        }
        if added == 0 {
            break;
        }
    }
    Ok(labels)
}

pub async fn gitea_create_label(
    target: &GiteaTarget,
    name: &str,
    color: &str,
    description: &str,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<GiteaLabel, GiteaError> {
    let path = format!("{}/labels", repo_path(target));
    let document = gitea_json(
        target,
        &path,
        Some(GiteaRequestInit::post(json_body(&json!({
            "name": name,
            "color": color,
            "description": description,
        })))),
        transport,
        options,
    )
    .await?;
    let Some(id) = document.get("id").and_then(Value::as_i64) else {
        return Err(GiteaError::new("the created label has no id", None));
    };
    let Some(created) = document.get("name").and_then(Value::as_str) else {
        return Err(GiteaError::new("the created label has no id or name", None));
    };
    Ok(GiteaLabel {
        id,
        name: created.to_string(),
    })
}

/// The label id, created when the repository does not have it yet.
pub async fn gitea_ensure_label(
    target: &GiteaTarget,
    name: &str,
    color: &str,
    description: &str,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<i64, GiteaError> {
    if let Some(existing) = gitea_labels(target, transport, options)
        .await?
        .into_iter()
        .find(|label| label.name == name)
    {
        return Ok(existing.id);
    }
    Ok(
        gitea_create_label(target, name, color, description, transport, options)
            .await?
            .id,
    )
}

/// Adds one existing label to an issue, keeping every other label.
pub async fn gitea_add_issue_label(
    target: &GiteaTarget,
    number: i64,
    label_id: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<(), GiteaError> {
    let path = format!("{}/issues/{number}/labels", repo_path(target));
    gitea_request(
        target,
        &path,
        Some(GiteaRequestInit::post(json_body(
            &json!({"labels": [label_id]}),
        ))),
        transport,
        None,
        options,
    )
    .await?;
    Ok(())
}

/// Removes one label from an issue, leaving every other label in place.
pub async fn gitea_remove_issue_label(
    target: &GiteaTarget,
    number: i64,
    label_id: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<(), GiteaError> {
    let path = format!("{}/issues/{number}/labels/{label_id}", repo_path(target));
    gitea_request(
        target,
        &path,
        Some(GiteaRequestInit::delete()),
        transport,
        None,
        options,
    )
    .await?;
    Ok(())
}

/// Gitea marks a draft by the `WIP:` title prefix.
pub const DRAFT_PREFIX: &str = "WIP: ";

pub fn draft_title(title: &str) -> String {
    if title.starts_with(DRAFT_PREFIX) {
        title.to_string()
    } else {
        format!("{DRAFT_PREFIX}{title}")
    }
}

pub fn ready_title(title: &str) -> String {
    title
        .strip_prefix(DRAFT_PREFIX)
        .unwrap_or(title)
        .to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullState {
    Open,
    Merged,
    Closed,
}

impl PullState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Merged => "merged",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiteaPullDocument {
    pub number: i64,
    pub url: String,
    pub state: PullState,
    pub draft: bool,
    pub title: String,
}

fn pull_from_document(value: &Value) -> Option<GiteaPullDocument> {
    let number = value.get("number").and_then(Value::as_i64)?;
    let url = value.get("html_url").and_then(Value::as_str)?;
    let title = value.get("title").and_then(Value::as_str)?;
    let merged = value.get("merged").and_then(Value::as_bool) == Some(true)
        || value.get("merged_at").is_some_and(|value| !value.is_null());
    let state = if merged {
        PullState::Merged
    } else if value.get("state").and_then(Value::as_str) == Some("closed") {
        PullState::Closed
    } else {
        PullState::Open
    };
    Some(GiteaPullDocument {
        number,
        url: url.to_string(),
        state,
        draft: title.starts_with(DRAFT_PREFIX),
        title: title.to_string(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatePullInput {
    pub head: String,
    pub base: String,
    pub title: String,
    pub body: String,
}

pub async fn gitea_create_pull(
    target: &GiteaTarget,
    input: &CreatePullInput,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<GiteaPullDocument, GiteaError> {
    let path = format!("{}/pulls", repo_path(target));
    let document = gitea_json(
        target,
        &path,
        Some(GiteaRequestInit::post(json_body(&json!({
            "head": input.head,
            "base": input.base,
            "title": draft_title(&input.title),
            "body": input.body,
        })))),
        transport,
        options,
    )
    .await?;
    pull_from_document(&document)
        .ok_or_else(|| GiteaError::new("the created pull request has no number or URL", None))
}

pub async fn gitea_edit_pull(
    target: &GiteaTarget,
    number: i64,
    title: Option<&str>,
    body: Option<&str>,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<(), GiteaError> {
    let mut document = Map::new();
    if let Some(title) = title {
        document.insert("title".to_string(), json!(title));
    }
    if let Some(body) = body {
        document.insert("body".to_string(), json!(body));
    }
    let path = format!("{}/pulls/{number}", repo_path(target));
    gitea_request(
        target,
        &path,
        Some(GiteaRequestInit::patch(json_body(&Value::Object(document)))),
        transport,
        None,
        options,
    )
    .await?;
    Ok(())
}

pub async fn gitea_pull(
    target: &GiteaTarget,
    number: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<GiteaPullDocument, GiteaError> {
    let path = format!("{}/pulls/{number}", repo_path(target));
    let document = gitea_json(target, &path, None, transport, options).await?;
    pull_from_document(&document)
        .ok_or_else(|| GiteaError::new("the pull request has no readable state", None))
}

/// Removes Gitea's draft prefix, so the pull request is ready for review.
pub async fn gitea_ready_pull(
    target: &GiteaTarget,
    number: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<(), GiteaError> {
    let pull = gitea_pull(target, number, transport, options).await?;
    let title = ready_title(&pull.title);
    gitea_edit_pull(target, number, Some(&title), None, transport, options).await
}

/// Merges with a merge commit: never squash, never rebase.
pub async fn gitea_merge_pull(
    target: &GiteaTarget,
    number: i64,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<(), GiteaError> {
    let path = format!("{}/pulls/{number}/merge", repo_path(target));
    gitea_request(
        target,
        &path,
        Some(GiteaRequestInit::post(json_body(&json!({"Do": "merge"})))),
        transport,
        None,
        options,
    )
    .await?;
    Ok(())
}

/// One published, non-draft release with the time it was published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GiteaRelease {
    pub tag: String,
    pub published_at: String,
}

fn published_release(value: &Value) -> Option<GiteaRelease> {
    let tag = value.get("tag_name").and_then(Value::as_str)?;
    if tag.is_empty() || value.get("draft").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let published_at = value.get("published_at").and_then(Value::as_str)?;
    if published_at.is_empty() {
        return None;
    }
    Some(GiteaRelease {
        tag: tag.to_string(),
        published_at: published_at.to_string(),
    })
}

/// Every published release, newest first, drafts excluded.
pub async fn gitea_list_releases(
    target: &GiteaTarget,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Vec<GiteaRelease>, GiteaError> {
    let mut releases = Vec::new();
    let mut seen = HashSet::new();
    for page in 1..=GITEA_MAX_PAGES {
        let path = format!(
            "{}/releases?limit={GITEA_PAGE_SIZE}&page={page}",
            repo_path(target)
        );
        let document = gitea_json(target, &path, None, transport, options).await?;
        let Some(entries) = document.as_array() else {
            break;
        };
        if entries.is_empty() {
            break;
        }
        let mut added = 0;
        for entry in entries {
            let Some(release) = published_release(entry) else {
                continue;
            };
            if !seen.insert(release.tag.clone()) {
                continue;
            }
            releases.push(release);
            added += 1;
        }
        if added == 0 {
            break;
        }
    }
    Ok(releases)
}

/// The newest published release document.
pub async fn gitea_latest_release(
    target: &GiteaTarget,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Value, GiteaError> {
    let path = format!("{}/releases/latest", repo_path(target));
    gitea_json(target, &path, None, transport, options).await
}

/// One release by tag, or `None` when it does not exist.
pub async fn gitea_release_by_tag(
    target: &GiteaTarget,
    tag: &str,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Option<Value>, GiteaError> {
    let path = format!(
        "{}/releases/tags/{}",
        repo_path(target),
        encode_uri_component(tag)
    );
    match gitea_json(target, &path, None, transport, options).await {
        Ok(document) => Ok(Some(document)),
        Err(error) if error.status == Some(404) => Ok(None),
        Err(error) => Err(error),
    }
}

/// One release to create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateReleaseInput {
    pub tag: String,
    pub title: String,
    pub notes: String,
    /// The commit the tag names; defaults to `main` for a caller without one.
    pub target_commitish: Option<String>,
}

pub async fn gitea_create_release(
    target: &GiteaTarget,
    input: &CreateReleaseInput,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Value, GiteaError> {
    let path = format!("{}/releases", repo_path(target));
    gitea_json(
        target,
        &path,
        Some(GiteaRequestInit::post(json_body(&json!({
            "tag_name": input.tag,
            "target_commitish": input.target_commitish.clone().unwrap_or_else(|| "main".to_string()),
            "name": input.title,
            "body": input.notes,
            "draft": false,
            "prerelease": false,
        })))),
        transport,
        options,
    )
    .await
}

// ---------------------------------------------------------------------------
// Forge read retry policy

/// Delay before each automatic retry, measured from the end of the last attempt.
pub const FORGE_READ_RETRY_DELAYS_MS: [u64; 4] = [1_000, 2_000, 4_000, 8_000];
/// The initial attempt plus one per configured delay.
pub const FORGE_READ_MAX_ATTEMPTS: usize = FORGE_READ_RETRY_DELAYS_MS.len() + 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeReadFailureKind {
    RateLimit,
    Permanent,
    Transient,
}

const RATE_LIMIT_PATTERNS: [&str; 6] = [
    "rate limit exceeded",
    "secondary rate limit",
    "abuse detection",
    "too many requests",
    "http 429",
    "429 too many requests",
];

const PERMANENT_PATTERNS: &[&str] = &[
    "bad credentials",
    "authentication failed",
    "unauthorized",
    "http 401",
    "http 403",
    "resource not accessible",
    "forbidden",
    "invalid token",
    "token is invalid",
    "permission denied",
    "write permission",
    "not found",
    "http 404",
    "repository not found",
    "does not exist",
    "not a supported issue url",
    "not a github issue url",
    "did not print a json",
    "did not answer with json",
    "invalid json",
    "invalid response",
    "malformed",
    "unexpected response",
    "unknown issue state",
    "devboard_gitea_url",
    "no forge client",
    "missing prerequisite",
    "http 400",
    "http 422",
];

const TRANSIENT_PATTERNS: &[&str] = &[
    "timed out",
    "timeout",
    "etimedout",
    "econnreset",
    "econnrefused",
    "econnaborted",
    "eai_again",
    "ehostunreach",
    "enetunreach",
    "epipe",
    "socket hang up",
    "connection reset",
    "connection refused",
    "network",
    "fetch failed",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
    "internal server error",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "temporarily unavailable",
    "overloaded",
    "try again",
    "unavailable",
];

/// Classifies one failed periodic read from its diagnostic. An unrecognized
/// failure is transient: another attempt may fix a fault the forge does not
/// name.
pub fn classify_forge_read_failure(message: &str) -> ForgeReadFailureKind {
    let message = message.to_ascii_lowercase();
    if RATE_LIMIT_PATTERNS
        .iter()
        .any(|pattern| message.contains(pattern))
    {
        return ForgeReadFailureKind::RateLimit;
    }
    if PERMANENT_PATTERNS
        .iter()
        .any(|pattern| message.contains(pattern))
    {
        return ForgeReadFailureKind::Permanent;
    }
    if TRANSIENT_PATTERNS
        .iter()
        .any(|pattern| message.contains(pattern))
    {
        return ForgeReadFailureKind::Transient;
    }
    ForgeReadFailureKind::Transient
}

/// One agent's consecutive transient failures. A success resets the schedule.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForgeReadRetry {
    transient_failures: usize,
}

impl ForgeReadRetry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn failures(&self) -> usize {
        self.transient_failures
    }

    pub fn exhausted(&self) -> bool {
        self.transient_failures >= FORGE_READ_MAX_ATTEMPTS
    }

    /// A successful read clears every failure and the next schedule.
    pub fn succeed(&mut self) {
        self.transient_failures = 0;
    }

    /// Records one failure. A transient failure below the cap returns the delay
    /// before the automatic retry; an exhausted, permanent, or rate-limited
    /// failure returns `None` and resets the schedule for a later outage.
    pub fn record(&mut self, kind: ForgeReadFailureKind) -> Option<u64> {
        if kind != ForgeReadFailureKind::Transient {
            self.transient_failures = 0;
            return None;
        }
        if self.exhausted() {
            return None;
        }
        let delay = FORGE_READ_RETRY_DELAYS_MS
            .get(self.transient_failures)
            .copied();
        self.transient_failures += 1;
        delay
    }
}

pub type SleepFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
/// The injected-sleep seam used by [`read_with_retry`].
pub type Sleep = Arc<dyn Fn(u64) -> SleepFuture + Send + Sync>;

/// The real sleep, used by production callers.
pub fn real_sleep() -> Sleep {
    Arc::new(|millis| Box::pin(tokio::time::sleep(Duration::from_millis(millis.max(1)))))
}

/// Runs one periodic forge read under the bounded transient-retry schedule.
/// A permanent or rate-limited failure surfaces on the first attempt, exactly
/// as the workers report it; a transient failure is retried while the budget
/// lasts.
pub async fn read_with_retry<T, F, Fut>(
    retry: &mut ForgeReadRetry,
    sleep: &Sleep,
    mut read: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    loop {
        match read().await {
            Ok(value) => {
                retry.succeed();
                return Ok(value);
            }
            Err(detail) => {
                let kind = classify_forge_read_failure(&detail);
                match retry.record(kind) {
                    Some(delay) => sleep(delay).await,
                    None => return Err(detail),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Forge credentials

pub const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 60_000;

pub const GITHUB_TOKEN_KEYS: [&str; 4] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];
pub const GITLAB_TOKEN_KEYS: [&str; 3] = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];
pub const TOKEN_KEYS: [&str; 9] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITLAB_TOKEN",
    "GITLAB_ACCESS_TOKEN",
    "OAUTH_TOKEN",
    "GITEA_TOKEN",
    "DEVBOARD_GITEA_TOKEN",
];

const CLI_ENV: [(&str, &str); 4] = [
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("NO_COLOR", "1"),
];

/// One forge child or credential probe that outlived its deadline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeTimeoutError {
    pub message: String,
}

impl std::fmt::Display for ForgeTimeoutError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ForgeTimeoutError {}

/// A credential selection that failed; the message names every candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthFailure {
    pub error: String,
}

/// A credential environment that cannot be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeAuthError {
    pub message: String,
}

impl std::fmt::Display for ForgeAuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ForgeAuthError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAuth {
    pub forge: Forge,
    pub host: String,
    pub project: String,
    pub login: String,
    /// Undefined means the CLI credential store itself is authenticated.
    pub token: Option<String>,
    /// Where the credential came from, for diagnostics. Never a token value.
    pub source: String,
    /// Gitea HTTP origin, when the forge is Gitea.
    pub base_url: Option<String>,
    pub active: bool,
    pub permission: Permission,
    pub can_write: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthOutcome {
    Resolved(ResolvedAuth),
    Failure(AuthFailure),
}

impl AuthOutcome {
    pub fn is_failure(&self) -> bool {
        matches!(self, Self::Failure(_))
    }

    pub fn into_result(self) -> Result<ResolvedAuth, AuthFailure> {
        match self {
            Self::Resolved(auth) => Ok(auth),
            Self::Failure(failure) => Err(failure),
        }
    }
}

pub fn is_auth_failure(value: &AuthOutcome) -> bool {
    value.is_failure()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RequiredAccess {
    Read,
    Write,
}

impl RequiredAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    None,
    Pull,
    Triage,
    Push,
    Maintain,
    Admin,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Pull => "pull",
            Self::Triage => "triage",
            Self::Push => "push",
            Self::Maintain => "maintain",
            Self::Admin => "admin",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Pull => 1,
            Self::Triage => 2,
            Self::Push => 3,
            Self::Maintain => 4,
            Self::Admin => 5,
        }
    }
}

/// One command's result. `killed` names a deadline, not the child's own exit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub killed: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    pub cwd: Option<PathBuf>,
    pub env: Environment,
    pub timeout_ms: Option<u64>,
    pub stdin: Option<String>,
}

pub type ExecFuture = Pin<Box<dyn Future<Output = ExecResult> + Send>>;
/// The injected-command seam, the Rust form of the TypeScript `Exec`.
pub type Exec = Arc<dyn Fn(String, Vec<String>, ExecOptions) -> ExecFuture + Send + Sync>;

/// The real command runner: explicit environment, optional stdin, bounded.
pub fn default_exec() -> Exec {
    Arc::new(
        |command: String, args: Vec<String>, options: ExecOptions| -> ExecFuture {
            Box::pin(async move {
                let mut process = tokio::process::Command::new(&command);
                process
                    .args(&args)
                    .env_clear()
                    .envs(&options.env)
                    .stdin(if options.stdin.is_some() {
                        Stdio::piped()
                    } else {
                        Stdio::null()
                    })
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);
                if let Some(cwd) = &options.cwd {
                    process.current_dir(cwd);
                }
                let mut child = match process.spawn() {
                    Ok(child) => child,
                    Err(error) => {
                        return ExecResult {
                            stdout: String::new(),
                            stderr: error.to_string(),
                            code: -1,
                            killed: false,
                        };
                    }
                };
                if let Some(input) = &options.stdin {
                    if let Some(mut stdin) = child.stdin.take() {
                        use tokio::io::AsyncWriteExt;
                        let _ = stdin.write_all(input.as_bytes()).await;
                    }
                }
                let pending = child.wait_with_output();
                let timeout_ms = options.timeout_ms.map(|value| value.max(1));
                let outcome = match timeout_ms {
                    None => pending.await,
                    Some(millis) => {
                        match tokio::time::timeout(Duration::from_millis(millis), pending).await {
                            Ok(outcome) => outcome,
                            Err(_) => {
                                return ExecResult {
                                    stdout: String::new(),
                                    stderr: format!("the command timed out after {millis} ms."),
                                    code: -1,
                                    killed: true,
                                };
                            }
                        }
                    }
                };
                match outcome {
                    Ok(output) => {
                        let code = output.status.code().unwrap_or(-1);
                        ExecResult {
                            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                            code,
                            killed: code == 137,
                        }
                    }
                    Err(error) => ExecResult {
                        stdout: String::new(),
                        stderr: error.to_string(),
                        code: -1,
                        killed: false,
                    },
                }
            })
        },
    )
}

/// Bounds one forge operation, reporting the operation that timed out.
pub async fn with_forge_deadline<T>(
    pending: impl Future<Output = T>,
    timeout_ms: u64,
    operation: &str,
) -> Result<T, ForgeTimeoutError> {
    let bound = timeout_ms.max(1);
    match crate::deadline::within_deadline(pending, bound).await {
        Some(value) => Ok(value),
        None => Err(ForgeTimeoutError {
            message: format!("{operation} timed out after {bound} ms; retry the request."),
        }),
    }
}

/// The string-valued view of an environment, for a child's `env`.
pub fn string_environment(source: &Environment) -> Environment {
    source.clone()
}

fn without_tokens(base: &Environment, forge: Forge) -> Environment {
    let mut environment = base.clone();
    for key in token_keys(forge) {
        environment.remove(*key);
    }
    environment
}

fn token_keys(forge: Forge) -> &'static [&'static str] {
    match forge {
        Forge::GitHub => &GITHUB_TOKEN_KEYS,
        Forge::GitLab => &GITLAB_TOKEN_KEYS,
        Forge::Gitea => &GITEA_TOKEN_KEYS,
    }
}

fn cli_environment(base: &Environment) -> Environment {
    let mut environment = base.clone();
    for (key, value) in CLI_ENV {
        environment.insert(key.to_string(), value.to_string());
    }
    environment
}

fn probe_options(options: &ResolveOptions, environment: &Environment) -> ExecOptions {
    ExecOptions {
        cwd: Some(options.cwd.clone()),
        env: environment.clone(),
        timeout_ms: options
            .deadline_ms
            .map(|deadline| (deadline - now_millis()).max(1) as u64),
        stdin: None,
    }
}

#[derive(Debug, Clone, Default)]
struct Diagnostic {
    label: String,
    detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    token: String,
    login: Option<String>,
    source: String,
    active: bool,
    from_environment: bool,
    order: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Inspected {
    login: String,
    token: String,
    source: String,
    active: bool,
    from_environment: bool,
    order: usize,
    permission: Permission,
    can_write: bool,
}

/// Everything one credential resolution needs.
#[derive(Clone)]
pub struct ResolveOptions {
    pub forge: Forge,
    pub host: String,
    pub project: String,
    pub cwd: PathBuf,
    pub required: RequiredAccess,
    pub env: Environment,
    /// Absolute epoch deadline for the whole resolution.
    pub deadline_ms: Option<i64>,
    /// Gitea HTTP origin; defaults to the environment or the origin remote.
    pub base_url: Option<String>,
    /// Injectable HTTP transport for the Gitea API.
    pub gitea_transport: Option<Transport>,
}

impl ResolveOptions {
    pub fn new(
        forge: Forge,
        host: impl Into<String>,
        project: impl Into<String>,
        cwd: impl Into<PathBuf>,
    ) -> Self {
        Self {
            forge,
            host: host.into(),
            project: project.into(),
            cwd: cwd.into(),
            required: RequiredAccess::Read,
            env: process_environment(),
            deadline_ms: None,
            base_url: None,
            gitea_transport: None,
        }
    }
}

fn parse_object(stdout: &str) -> Option<Value> {
    serde_json::from_str::<Value>(stdout)
        .ok()
        .filter(|value| value.is_object())
}

fn github_permission(value: &Value) -> Permission {
    if value.get("admin").and_then(Value::as_bool) == Some(true) {
        return Permission::Admin;
    }
    if value.get("maintain").and_then(Value::as_bool) == Some(true) {
        return Permission::Maintain;
    }
    if value.get("push").and_then(Value::as_bool) == Some(true) {
        return Permission::Push;
    }
    if value.get("triage").and_then(Value::as_bool) == Some(true) {
        return Permission::Triage;
    }
    if value.get("pull").and_then(Value::as_bool) == Some(true) {
        return Permission::Pull;
    }
    Permission::None
}

fn gitea_permission(value: Option<&Value>) -> Permission {
    let Some(value) = value else {
        return Permission::None;
    };
    if value.get("admin").and_then(Value::as_bool) == Some(true) {
        return Permission::Admin;
    }
    if value.get("push").and_then(Value::as_bool) == Some(true) {
        return Permission::Push;
    }
    if value.get("pull").and_then(Value::as_bool) == Some(true) {
        return Permission::Pull;
    }
    Permission::None
}

fn gitlab_permission(value: Option<&Value>) -> Permission {
    let Some(value) = value else {
        return Permission::None;
    };
    let access_level = |name: &str| {
        value
            .get(name)
            .and_then(|entry| entry.get("access_level"))
            .and_then(Value::as_f64)
    };
    let access = [access_level("project_access"), access_level("group_access")]
        .into_iter()
        .flatten()
        .fold(0.0_f64, f64::max);
    if access >= 50.0 {
        Permission::Admin
    } else if access >= 40.0 {
        Permission::Maintain
    } else if access >= 30.0 {
        Permission::Push
    } else if access >= 20.0 {
        Permission::Triage
    } else if access >= 10.0 {
        Permission::Pull
    } else {
        Permission::None
    }
}

fn select_best(
    inspected: &[Inspected],
    required: RequiredAccess,
    host: &str,
    project: &str,
    forge: Forge,
    diagnostics: &mut Vec<Diagnostic>,
) -> AuthOutcome {
    for entry in inspected {
        if !entry.can_write && required == RequiredAccess::Write {
            diagnostics.push(Diagnostic {
                label: format!("{} ({})", entry.login, entry.source),
                detail: format!("{} access only", entry.permission.as_str()),
            });
        }
    }
    let mut usable: Vec<Inspected> = inspected
        .iter()
        .filter(|entry| match required {
            RequiredAccess::Read => entry.permission != Permission::None,
            RequiredAccess::Write => entry.can_write,
        })
        .cloned()
        .collect();
    if usable.is_empty() {
        let forge_name = if forge == Forge::GitHub {
            "GitHub"
        } else {
            "GitLab"
        };
        let mut lines = vec![format!(
            "no authenticated {forge_name} account has {} access to {project} on {host}",
            required.as_str()
        )];
        for entry in diagnostics {
            lines.push(format!("- {}: {}", entry.label, entry.detail));
        }
        if forge == Forge::GitHub {
            lines.push(format!(
                "Run 'gh auth login --hostname {host}' for an account with {} access to {project}, or set GH_TOKEN to its token.",
                required.as_str()
            ));
        } else {
            lines.push(format!(
                "Run 'glab auth login --hostname {host}' for an account with {} access to {project}, or set GITLAB_TOKEN to its token.",
                required.as_str()
            ));
        }
        return AuthOutcome::Failure(AuthFailure {
            error: lines.join("\n"),
        });
    }

    let owner = project.split('/').next().unwrap_or("").to_ascii_lowercase();
    usable.sort_by(|left, right| {
        right
            .permission
            .rank()
            .cmp(&left.permission.rank())
            .then_with(|| {
                let right_owner = right.login.to_ascii_lowercase() == owner;
                let left_owner = left.login.to_ascii_lowercase() == owner;
                right_owner.cmp(&left_owner)
            })
            .then_with(|| right.active.cmp(&left.active))
            .then_with(|| right.from_environment.cmp(&left.from_environment))
            .then_with(|| left.order.cmp(&right.order))
    });
    let best = &usable[0];
    AuthOutcome::Resolved(ResolvedAuth {
        forge,
        host: host.to_string(),
        project: project.to_string(),
        login: best.login.clone(),
        token: Some(best.token.clone()),
        source: best.source.clone(),
        base_url: None,
        active: best.active,
        permission: best.permission,
        can_write: best.can_write,
    })
}

fn github_token_environment(base: &Environment, host: &str, token: &str) -> Environment {
    let mut environment = without_tokens(base, Forge::GitHub);
    if host == "github.com" {
        environment.insert("GH_TOKEN".to_string(), token.to_string());
    } else {
        environment.insert("GH_ENTERPRISE_TOKEN".to_string(), token.to_string());
        environment.insert("GITHUB_ENTERPRISE_TOKEN".to_string(), token.to_string());
        environment.insert("GH_TOKEN".to_string(), token.to_string());
    }
    environment.insert("GH_HOST".to_string(), host.to_string());
    cli_environment(&environment)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubAccount {
    login: String,
    active: bool,
    state: String,
    error: String,
}

fn parse_github_accounts(stdout: &str, host: &str) -> Option<Vec<GithubAccount>> {
    let document = parse_object(stdout)?;
    let hosts = document.get("hosts")?.as_object()?;
    let entries = hosts
        .get(host)
        .or_else(|| hosts.get(&host.to_ascii_lowercase()));
    let Some(entries) = entries else {
        return Some(Vec::new());
    };
    let entries = entries.as_array()?;
    let mut accounts = Vec::new();
    for entry in entries {
        if !entry.is_object() {
            continue;
        }
        accounts.push(GithubAccount {
            login: entry
                .get("login")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            active: entry.get("active").and_then(Value::as_bool) == Some(true),
            state: entry
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            error: entry
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    Some(accounts)
}

fn environment_candidates(base: &Environment, host: &str, forge: Forge) -> Vec<Candidate> {
    let names: &[&str] = match forge {
        Forge::GitHub if host == "github.com" => &["GH_TOKEN", "GITHUB_TOKEN"],
        Forge::GitHub => &[
            "GH_ENTERPRISE_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
        ],
        Forge::GitLab => &["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"],
        Forge::Gitea => &GITEA_TOKEN_KEYS,
    };
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let mut order = 0;
    for name in names {
        let token = base.get(*name).map(|value| value.trim()).unwrap_or("");
        if token.is_empty() || !seen.insert(token.to_string()) {
            continue;
        }
        candidates.push(Candidate {
            token: token.to_string(),
            login: None,
            source: (*name).to_string(),
            active: false,
            from_environment: true,
            order,
        });
        order += 1;
    }
    candidates
}

async fn inspect_github(
    exec: &Exec,
    options: &ResolveOptions,
    base: &Environment,
    candidate: &Candidate,
) -> Result<Inspected, Diagnostic> {
    let environment = github_token_environment(base, &options.host, &candidate.token);
    let mut login = candidate.login.clone();
    if login.as_deref().unwrap_or("").is_empty() {
        let user = exec(
            "gh".to_string(),
            vec![
                "api".to_string(),
                "--hostname".to_string(),
                options.host.clone(),
                "user".to_string(),
                "--jq".to_string(),
                ".login".to_string(),
            ],
            probe_options(options, &environment),
        )
        .await;
        if user.code != 0 {
            return Err(Diagnostic {
                label: candidate.source.clone(),
                detail: format!("token rejected ({})", first_line(&user.stderr)),
            });
        }
        login = Some(user.stdout.trim().to_string());
        if login.as_deref().unwrap_or("").is_empty() {
            return Err(Diagnostic {
                label: candidate.source.clone(),
                detail: "token rejected (no user returned)".to_string(),
            });
        }
    }
    let login = login.unwrap_or_default();
    let repository = exec(
        "gh".to_string(),
        vec![
            "api".to_string(),
            "--hostname".to_string(),
            options.host.clone(),
            format!("repos/{}", options.project),
            "--jq".to_string(),
            ".permissions".to_string(),
        ],
        probe_options(options, &environment),
    )
    .await;
    if repository.code != 0 {
        let detail = first_line(&repository.stderr);
        let denied = Regex::new(r"HTTP (403|404)")
            .map(|regex| regex.is_match(&detail))
            .unwrap_or(false);
        let detail_name = if denied {
            "no access"
        } else {
            "request failed"
        };
        return Err(Diagnostic {
            label: format!("{login} ({})", candidate.source),
            detail: format!("{detail_name} ({detail})"),
        });
    }
    let Some(parsed) = parse_object(&repository.stdout) else {
        return Err(Diagnostic {
            label: format!("{login} ({})", candidate.source),
            detail: "repository permission response was not JSON".to_string(),
        });
    };
    let permission = github_permission(&parsed);
    if permission == Permission::None {
        return Err(Diagnostic {
            label: format!("{login} ({})", candidate.source),
            detail: "no repository access".to_string(),
        });
    }
    Ok(Inspected {
        login,
        token: candidate.token.clone(),
        source: candidate.source.clone(),
        active: candidate.active,
        from_environment: candidate.from_environment,
        order: candidate.order,
        permission,
        can_write: permission != Permission::Pull,
    })
}

async fn resolve_github(exec: &Exec, options: &ResolveOptions, base: &Environment) -> AuthOutcome {
    let required = options.required;
    let mut diagnostics = Vec::new();
    let mut candidates = environment_candidates(base, &options.host, Forge::GitHub);
    let mut order = candidates.len();

    let status = exec(
        "gh".to_string(),
        vec![
            "auth".to_string(),
            "status".to_string(),
            "--hostname".to_string(),
            options.host.clone(),
            "--json".to_string(),
            "hosts".to_string(),
        ],
        probe_options(options, &without_tokens(base, Forge::GitHub)),
    )
    .await;
    if status.code != 0 && status.stdout.trim().is_empty() {
        return AuthOutcome::Failure(AuthFailure {
            error: format!(
                "gh is unavailable or failed: {}",
                first_line(&status.stderr)
            ),
        });
    }
    let Some(accounts) = parse_github_accounts(&status.stdout, &options.host) else {
        return AuthOutcome::Failure(AuthFailure {
            error: "gh auth status returned an unexpected JSON shape".to_string(),
        });
    };

    for account in accounts {
        if account.state != "success" || account.login.is_empty() {
            let label = if account.active {
                "active account".to_string()
            } else {
                "gh account".to_string()
            };
            let detail = if account.error.is_empty() {
                "authentication failed".to_string()
            } else {
                first_line(&account.error)
            };
            diagnostics.push(Diagnostic { label, detail });
            continue;
        }
        let token = exec(
            "gh".to_string(),
            vec![
                "auth".to_string(),
                "token".to_string(),
                "--hostname".to_string(),
                options.host.clone(),
                "--user".to_string(),
                account.login.clone(),
            ],
            probe_options(options, &without_tokens(base, Forge::GitHub)),
        )
        .await;
        if token.code != 0 || token.stdout.trim().is_empty() {
            let detail = first_line(&token.stderr);
            diagnostics.push(Diagnostic {
                label: account.login.clone(),
                detail: format!(
                    "token unavailable ({})",
                    if detail == "no diagnostic" {
                        "no token"
                    } else {
                        &detail
                    }
                ),
            });
            continue;
        }
        candidates.push(Candidate {
            token: token.stdout.trim().to_string(),
            login: Some(account.login.clone()),
            source: "gh account".to_string(),
            active: account.active,
            from_environment: false,
            order,
        });
        order += 1;
    }

    if candidates.is_empty() {
        let mut lines = vec![format!(
            "no authenticated GitHub account is available for {}",
            options.host
        )];
        if diagnostics.is_empty() {
            lines.push("- no authenticated account for the host".to_string());
        } else {
            for entry in &diagnostics {
                lines.push(format!("- {}: {}", entry.label, entry.detail));
            }
        }
        lines.push(format!(
            "Run 'gh auth login --hostname {}' for an account with access to {}.",
            options.host, options.project
        ));
        return AuthOutcome::Failure(AuthFailure {
            error: lines.join("\n"),
        });
    }

    let mut inspected = Vec::new();
    for candidate in &candidates {
        match inspect_github(exec, options, base, candidate).await {
            Ok(entry) => inspected.push(entry),
            Err(diagnostic) => diagnostics.push(diagnostic),
        }
    }
    select_best(
        &inspected,
        required,
        &options.host,
        &options.project,
        Forge::GitHub,
        &mut diagnostics,
    )
}

#[derive(Debug, Clone, Default)]
struct GitlabStatus {
    accounts: Vec<Candidate>,
    diagnostics: Vec<Diagnostic>,
}

fn token_line_regex() -> &'static Regex {
    static REGEX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?:^|\s)Token:\s*(\S+)\s*$").expect("the token line form"));
    &REGEX
}

fn parse_gitlab_tokens(stdout: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut seen = HashSet::new();
    for line in stdout.split('\n') {
        let Some(captures) = token_line_regex().captures(line) else {
            continue;
        };
        let Some(token) = captures.get(1).map(|value| value.as_str().trim()) else {
            continue;
        };
        if token.is_empty() || !seen.insert(token.to_string()) {
            continue;
        }
        tokens.push(token.to_string());
    }
    tokens
}

async fn gitlab_status(exec: &Exec, options: &ResolveOptions, base: &Environment) -> GitlabStatus {
    let environment = without_tokens(base, Forge::GitLab);
    let status = exec(
        "glab".to_string(),
        vec![
            "auth".to_string(),
            "status".to_string(),
            "--hostname".to_string(),
            options.host.clone(),
            "--show-token".to_string(),
        ],
        probe_options(options, &environment),
    )
    .await;
    if status.code != 0 && status.stdout.trim().is_empty() {
        let detail = first_line(&status.stderr);
        return GitlabStatus {
            accounts: Vec::new(),
            diagnostics: vec![Diagnostic {
                label: "glab".to_string(),
                detail: if detail == "no diagnostic" {
                    "not authenticated".to_string()
                } else {
                    detail
                },
            }],
        };
    }
    let tokens = parse_gitlab_tokens(&status.stdout);
    let mut accounts: Vec<Candidate> = tokens
        .iter()
        .enumerate()
        .map(|(index, token)| Candidate {
            token: token.clone(),
            login: None,
            source: "glab token".to_string(),
            active: true,
            from_environment: false,
            order: index,
        })
        .collect();
    if accounts.is_empty() && status.code == 0 {
        accounts.push(Candidate {
            token: String::new(),
            login: None,
            source: "glab credential store".to_string(),
            active: true,
            from_environment: false,
            order: 0,
        });
    }
    let diagnostics = if status.code == 0 {
        Vec::new()
    } else {
        let detail = first_line(&status.stderr);
        vec![Diagnostic {
            label: "glab".to_string(),
            detail: if detail == "no diagnostic" {
                "authentication failed".to_string()
            } else {
                detail
            },
        }]
    };
    GitlabStatus {
        accounts,
        diagnostics,
    }
}

fn gitlab_token_environment(base: &Environment, host: &str, token: &str) -> Environment {
    let mut environment = without_tokens(base, Forge::GitLab);
    if !token.is_empty() {
        environment.insert("GITLAB_TOKEN".to_string(), token.to_string());
    }
    environment.insert("GITLAB_HOST".to_string(), host.to_string());
    cli_environment(&environment)
}

async fn inspect_gitlab(
    exec: &Exec,
    options: &ResolveOptions,
    base: &Environment,
    candidate: &Candidate,
) -> Result<Inspected, Diagnostic> {
    let environment = gitlab_token_environment(base, &options.host, &candidate.token);
    let user = exec(
        "glab".to_string(),
        vec![
            "api".to_string(),
            "--hostname".to_string(),
            options.host.clone(),
            "user".to_string(),
        ],
        probe_options(options, &environment),
    )
    .await;
    if user.code != 0 {
        return Err(Diagnostic {
            label: candidate.source.clone(),
            detail: format!("token rejected ({})", first_line(&user.stderr)),
        });
    }
    let login = parse_object(&user.stdout)
        .and_then(|document| {
            document
                .get("username")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    if login.is_empty() {
        return Err(Diagnostic {
            label: candidate.source.clone(),
            detail: "token returned no username".to_string(),
        });
    }
    let endpoint = format!("projects/{}", encode_uri_component(&options.project));
    let project = exec(
        "glab".to_string(),
        vec![
            "api".to_string(),
            "--hostname".to_string(),
            options.host.clone(),
            endpoint,
        ],
        probe_options(options, &environment),
    )
    .await;
    if project.code != 0 {
        let detail = first_line(&project.stderr);
        let denied = Regex::new(r"(401|403|404)")
            .map(|regex| regex.is_match(&detail))
            .unwrap_or(false);
        let detail_name = if denied {
            "no access"
        } else {
            "request failed"
        };
        return Err(Diagnostic {
            label: format!("{login} ({})", candidate.source),
            detail: format!("{detail_name} ({detail})"),
        });
    }
    let Some(document) = parse_object(&project.stdout) else {
        return Err(Diagnostic {
            label: format!("{login} ({})", candidate.source),
            detail: "repository permission response was not JSON".to_string(),
        });
    };
    let mut permission = gitlab_permission(document.get("permissions"));
    if permission == Permission::None
        && document.get("visibility").and_then(Value::as_str) == Some("public")
    {
        permission = Permission::Pull;
    }
    if permission == Permission::None {
        return Err(Diagnostic {
            label: format!("{login} ({})", candidate.source),
            detail: "no repository access".to_string(),
        });
    }
    Ok(Inspected {
        login,
        token: candidate.token.clone(),
        source: candidate.source.clone(),
        active: candidate.active,
        from_environment: candidate.from_environment,
        order: candidate.order,
        permission,
        can_write: permission != Permission::Pull,
    })
}

async fn resolve_gitlab(exec: &Exec, options: &ResolveOptions, base: &Environment) -> AuthOutcome {
    let required = options.required;
    let mut diagnostics = Vec::new();
    let mut candidates = environment_candidates(base, &options.host, Forge::GitLab);
    let status = gitlab_status(exec, options, base).await;
    diagnostics.extend(status.diagnostics);
    let mut order = candidates.len();
    for account in status.accounts {
        let mut account = account;
        account.order = order;
        candidates.push(account);
        order += 1;
    }
    if candidates.is_empty() {
        let mut lines = vec![format!(
            "no authenticated GitLab account is available for {}",
            options.host
        )];
        if diagnostics.is_empty() {
            lines.push("- no authenticated account for the host".to_string());
        } else {
            for entry in &diagnostics {
                lines.push(format!("- {}: {}", entry.label, entry.detail));
            }
        }
        lines.push(format!(
            "Run 'glab auth login --hostname {}' for an account with access to {}.",
            options.host, options.project
        ));
        return AuthOutcome::Failure(AuthFailure {
            error: lines.join("\n"),
        });
    }

    let mut inspected = Vec::new();
    for candidate in &candidates {
        match inspect_gitlab(exec, options, base, candidate).await {
            Ok(entry) => inspected.push(entry),
            Err(diagnostic) => diagnostics.push(diagnostic),
        }
    }
    select_best(
        &inspected,
        required,
        &options.host,
        &options.project,
        Forge::GitLab,
        &mut diagnostics,
    )
}

async fn resolve_gitea_inner(
    options: &ResolveOptions,
    base_url: &str,
    token: &str,
) -> Result<AuthOutcome, GiteaError> {
    let required = options.required;
    let target = GiteaTarget {
        base_url: base_url.to_string(),
        project: options.project.clone(),
        token: (!token.is_empty()).then(|| token.to_string()),
    };
    let transport = options
        .gitea_transport
        .clone()
        .unwrap_or_else(|| default_transport(GITEA_REQUEST_TIMEOUT_MS));
    let call_options = GiteaCallOptions::default();
    let repository = gitea_repository(&target, &transport, &call_options).await?;
    let permission = gitea_permission(repository.permissions());
    if token.is_empty() {
        if permission == Permission::None {
            return Ok(AuthOutcome::Failure(AuthFailure {
                error: format!(
                    "no Gitea credential is configured for {} on {base_url}, and the repository is not public",
                    options.project
                ),
            }));
        }
        if required == RequiredAccess::Write {
            return Ok(AuthOutcome::Failure(AuthFailure {
                error: format!(
                    "no Gitea credential is configured for {} on {base_url}; writing needs GITEA_TOKEN",
                    options.project
                ),
            }));
        }
        return Ok(AuthOutcome::Resolved(ResolvedAuth {
            forge: Forge::Gitea,
            host: options.host.clone(),
            project: options.project.clone(),
            login: "anonymous".to_string(),
            token: None,
            source: "public repository".to_string(),
            base_url: Some(base_url.to_string()),
            active: true,
            permission,
            can_write: false,
        }));
    }
    let login = gitea_user(&target, &transport, &call_options).await?;
    if login.is_empty() {
        return Ok(AuthOutcome::Failure(AuthFailure {
            error: format!("the Gitea token returned no account for {base_url}"),
        }));
    }
    if permission == Permission::None {
        return Ok(AuthOutcome::Failure(AuthFailure {
            error: format!(
                "the Gitea account {login} has no access to {} on {base_url}",
                options.project
            ),
        }));
    }
    if required == RequiredAccess::Write && permission == Permission::Pull {
        return Ok(AuthOutcome::Failure(AuthFailure {
            error: format!(
                "the Gitea account {login} cannot write to {} on {base_url}",
                options.project
            ),
        }));
    }
    Ok(AuthOutcome::Resolved(ResolvedAuth {
        forge: Forge::Gitea,
        host: options.host.clone(),
        project: options.project.clone(),
        login,
        token: Some(token.to_string()),
        source: "GITEA_TOKEN".to_string(),
        base_url: Some(base_url.to_string()),
        active: true,
        permission,
        can_write: permission != Permission::Pull,
    }))
}

async fn resolve_gitea(options: &ResolveOptions, base: &Environment) -> AuthOutcome {
    let base_url = options
        .base_url
        .clone()
        .or_else(|| configured_gitea_url(base))
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    if base_url.is_empty() {
        return AuthOutcome::Failure(AuthFailure {
            error: format!(
                "no Gitea address is configured for {}; set DEVBOARD_GITEA_URL",
                options.host
            ),
        });
    }
    let token = base
        .get("GITEA_TOKEN")
        .or_else(|| base.get("DEVBOARD_GITEA_TOKEN"))
        .map(|value| value.trim())
        .unwrap_or("")
        .to_string();
    match resolve_gitea_inner(options, &base_url, &token).await {
        Ok(outcome) => outcome,
        Err(error) => AuthOutcome::Failure(AuthFailure {
            error: format!(
                "could not resolve Gitea access for {} on {base_url}: {}",
                options.project, error.message
            ),
        }),
    }
}

/// Resolves the one credential the lifecycle should use for a project.
pub async fn resolve_forge_auth(exec: &Exec, options: &ResolveOptions) -> AuthOutcome {
    let base = string_environment(&options.env);
    match options.forge {
        Forge::GitHub => resolve_github(exec, options, &base).await,
        Forge::GitLab => resolve_gitlab(exec, options, &base).await,
        Forge::Gitea => resolve_gitea(options, &base).await,
    }
}

/// The environment for one forge command. The selected credential wins over
/// every ambient token, and the host is pinned so `GH_HOST` cannot redirect it.
pub fn auth_environment(
    auth: &ResolvedAuth,
    base: &Environment,
) -> Result<Environment, ForgeAuthError> {
    let mut environment = string_environment(base);
    match auth.forge {
        Forge::GitHub => {
            for key in GITHUB_TOKEN_KEYS {
                environment.remove(key);
            }
            let Some(token) = auth.token.as_deref() else {
                return Err(ForgeAuthError {
                    message: "GitHub auth resolution returned no token".to_string(),
                });
            };
            if auth.host == "github.com" {
                environment.insert("GH_TOKEN".to_string(), token.to_string());
            } else {
                environment.insert("GH_ENTERPRISE_TOKEN".to_string(), token.to_string());
                environment.insert("GITHUB_ENTERPRISE_TOKEN".to_string(), token.to_string());
                environment.insert("GH_TOKEN".to_string(), token.to_string());
            }
            environment.insert("GH_HOST".to_string(), auth.host.clone());
        }
        Forge::GitLab => {
            for key in GITLAB_TOKEN_KEYS {
                environment.remove(key);
            }
            if let Some(token) = auth.token.as_deref().filter(|token| !token.is_empty()) {
                environment.insert("GITLAB_TOKEN".to_string(), token.to_string());
            }
            environment.insert("GITLAB_HOST".to_string(), auth.host.clone());
        }
        Forge::Gitea => {
            for key in GITEA_TOKEN_KEYS {
                environment.remove(key);
            }
            if let Some(token) = auth.token.as_deref().filter(|token| !token.is_empty()) {
                environment.insert("GITEA_TOKEN".to_string(), token.to_string());
            }
            if let Some(base_url) = auth.base_url.as_deref().filter(|value| !value.is_empty()) {
                environment.insert("DEVBOARD_GITEA_URL".to_string(), base_url.to_string());
            }
        }
    }
    Ok(cli_environment(&environment))
}

/// Applies the selection to this process so every child sees the same identity.
pub fn apply_auth_to_process(auth: &ResolvedAuth) -> Result<(), ForgeAuthError> {
    let environment = auth_environment(auth, &process_environment())?;
    for key in TOKEN_KEYS
        .iter()
        .copied()
        .chain(["GH_HOST", "GITLAB_HOST", "DEVBOARD_GITEA_URL"])
    {
        std::env::remove_var(key);
    }
    for key in TOKEN_KEYS
        .iter()
        .copied()
        .chain(["GH_HOST", "GITLAB_HOST", "DEVBOARD_GITEA_URL"])
        .chain(CLI_ENV.iter().map(|(key, _)| *key))
    {
        if let Some(value) = environment.get(key) {
            std::env::set_var(key, value);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// GitHub release reads and release resolution

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubRelease {
    pub tag: String,
    /// ISO publication time; only published releases are listed.
    pub published_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitHubCommandOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub type GitHubCommandFuture = Pin<Box<dyn Future<Output = GitHubCommandOutcome> + Send>>;
/// The injected `gh` seam for release reads.
pub type GitHubCommandRunner =
    Arc<dyn Fn(Vec<String>, Environment) -> GitHubCommandFuture + Send + Sync>;

#[derive(Clone)]
pub struct RepositoryGitHubOptions {
    /// `owner/name` on github.com.
    pub repository: String,
    /// The checkout used to resolve a short commit and contain release tags.
    pub repo_dir: PathBuf,
    /// The forge command, already bound to its credential.
    pub run: GitHubCommandRunner,
    pub environment: Environment,
}

#[derive(Clone)]
pub struct RepositoryGitHub {
    repository: String,
    repo_dir: PathBuf,
    run: GitHubCommandRunner,
    environment: Environment,
}

impl RepositoryGitHub {
    pub fn new(options: RepositoryGitHubOptions) -> Self {
        Self {
            repository: options.repository,
            repo_dir: options.repo_dir,
            run: options.run,
            environment: options.environment,
        }
    }

    async fn read(&self, argv: Vec<String>) -> Result<String, String> {
        let result = (self.run)(argv, self.environment.clone()).await;
        if result.code != 0 {
            return Err(first_line(&result.stderr));
        }
        Ok(result.stdout)
    }

    async fn api(&self, endpoint: &str, jq: &str) -> Result<String, String> {
        self.read(vec![
            "api".to_string(),
            format!("repos/{}/{endpoint}", self.repository),
            "--paginate".to_string(),
            "--jq".to_string(),
            jq.to_string(),
        ])
        .await
    }

    /// Every published release, drafts excluded.
    pub async fn list_releases(&self) -> Result<Vec<GitHubRelease>, String> {
        let text = self
            .read(vec![
                "api".to_string(),
                format!("repos/{}/releases", self.repository),
                "--paginate".to_string(),
                "--jq".to_string(),
                ".[] | {tag: .tag_name, publishedAt: .published_at, draft: .draft}".to_string(),
            ])
            .await?;
        let mut releases = Vec::new();
        for entry in parse_json_lines(&text) {
            let Some(tag) = entry.get("tag").and_then(Value::as_str) else {
                continue;
            };
            if tag.is_empty() {
                continue;
            }
            if entry.get("draft").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(published_at) = entry.get("publishedAt").and_then(Value::as_str) else {
                continue;
            };
            if published_at.is_empty() {
                continue;
            }
            releases.push(GitHubRelease {
                tag: tag.to_string(),
                published_at: published_at.to_string(),
            });
        }
        Ok(releases)
    }

    /// The issue's state and both timestamps, as GitHub reports them.
    pub async fn issue_times(&self, issue_number: i64) -> Result<IssueTimes, String> {
        let text = self
            .read(vec![
                "api".to_string(),
                format!("repos/{}/issues/{issue_number}", self.repository),
                "--jq".to_string(),
                "[.state, .created_at, .closed_at] | @tsv".to_string(),
            ])
            .await?;
        let fields: Vec<&str> = text.trim().split('\t').collect();
        let reported = fields.first().copied().unwrap_or("").to_ascii_lowercase();
        let state = match reported.as_str() {
            "open" => IssueState::Open,
            "closed" => IssueState::Closed,
            _ => {
                return Err(format!(
                    "gh reported an unknown issue state for {}#{issue_number}",
                    self.repository
                ));
            }
        };
        Ok(IssueTimes {
            state,
            created_at: timestamp_field(fields.get(1).copied()),
            closed_at: timestamp_field(fields.get(2).copied()),
        })
    }

    /// The timeline's closing commit when GitHub reports one, otherwise every
    /// hex token of the newest comment, most recent first.
    pub async fn closing_commits(&self, issue_number: i64) -> Result<Vec<String>, String> {
        let mut timeline_failure: Option<String> = None;
        let timeline = self
            .api(
                &format!("issues/{issue_number}/timeline"),
                r#".[] | select(.event == "closed" and .commit_id != null) | .commit_id"#,
            )
            .await;
        match timeline {
            Ok(text) => {
                let commits: Vec<String> = text
                    .split('\n')
                    .map(str::trim)
                    .filter(|line| is_sha(line))
                    .map(str::to_string)
                    .collect();
                let timeline = closing_commit_from_timeline(
                    &commits
                        .into_iter()
                        .map(|commit| TimelineEvent {
                            event: Some("closed".to_string()),
                            commit_id: Some(commit),
                        })
                        .collect::<Vec<_>>(),
                );
                if let Some(commit) = timeline {
                    return Ok(vec![commit]);
                }
            }
            Err(error) => timeline_failure = Some(error),
        }

        let comments = self
            .api(
                &format!("issues/{issue_number}/comments"),
                ".[] | {body: .body}",
            )
            .await;
        match comments {
            Ok(text) => {
                let comments: Vec<String> = parse_json_lines(&text)
                    .into_iter()
                    .filter_map(|entry| {
                        entry
                            .get("body")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect();
                Ok(commit_candidates_from_comments(
                    &comments,
                    COMMIT_CANDIDATE_LIMIT,
                ))
            }
            Err(detail) => Err(match timeline_failure {
                Some(timeline) => format!("{timeline}; {detail}"),
                None => detail,
            }),
        }
    }

    pub async fn closing_commit(&self, issue_number: i64) -> Result<Option<String>, String> {
        Ok(self.closing_commits(issue_number).await?.into_iter().next())
    }

    /// The checkout's own commits whose landed subject ends with `(#<number>)`.
    pub fn landed_commits(&self, issue_number: i64) -> Vec<String> {
        landed_commits(&self.repo_dir, issue_number)
    }

    /// One unambiguous full commit, through the checkout or GitHub.
    pub async fn resolve_commit(&self, short: &str) -> Result<Option<String>, String> {
        if !is_sha(short) {
            return Ok(None);
        }
        let local = git(
            &self.repo_dir,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{short}^{{commit}}"),
            ],
        );
        if local.code == 0 {
            let sha = local.stdout.split_whitespace().next().unwrap_or("");
            if is_full_sha(sha) {
                return Ok(Some(sha.to_string()));
            }
        }
        let result = (self.run)(
            vec![
                "api".to_string(),
                format!("repos/{}/commits/{short}", self.repository),
                "--jq".to_string(),
                ".sha".to_string(),
            ],
            self.environment.clone(),
        )
        .await;
        if result.code != 0 {
            if missing_commit_status().is_match(&result.stderr) {
                return Ok(None);
            }
            return Err(first_line(&result.stderr));
        }
        let sha = result.stdout.trim();
        if is_full_sha(sha) {
            return Ok(Some(sha.to_string()));
        }
        Err(format!("gh did not name a commit for {short}"))
    }

    /// The published release tags whose history contains `commit`.
    pub async fn containing_release_tags(
        &self,
        commit: &str,
        releases: &[GitHubRelease],
    ) -> Result<Vec<String>, String> {
        let local = local_release_containment(&self.repo_dir, commit, releases);
        if local.pending.is_empty() {
            return Ok(local.contained);
        }
        let mut contained = local.contained;
        for release in local.pending {
            let result = (self.run)(
                vec![
                    "api".to_string(),
                    format!(
                        "repos/{}/compare/{commit}...{}",
                        self.repository,
                        encode_uri_component(&release.tag)
                    ),
                    "--jq".to_string(),
                    ".status".to_string(),
                ],
                self.environment.clone(),
            )
            .await;
            if result.code != 0 {
                continue;
            }
            let status = result.stdout.trim();
            if status == "ahead" || status == "identical" {
                contained.push(release.tag);
            }
        }
        Ok(contained)
    }
}

fn missing_commit_status() -> &'static Regex {
    static REGEX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\bHTTP\s*:?\s*\(?(?:404|422)\b").expect("the missing commit status")
    });
    &REGEX
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueTimes {
    pub state: IssueState,
    pub created_at: Option<String>,
    pub closed_at: Option<String>,
}

fn timestamp_field(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| !value.is_empty() && *value != "null")
        .map(str::to_string)
}

/// The timeline's closing commit when GitHub reports one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineEvent {
    pub event: Option<String>,
    pub commit_id: Option<String>,
}

pub fn closing_commit_from_timeline(events: &[TimelineEvent]) -> Option<String> {
    for event in events.iter().rev() {
        if event.event.as_deref() != Some("closed") {
            continue;
        }
        if let Some(commit) = event.commit_id.as_deref().filter(|value| is_sha(value)) {
            return Some(commit.to_string());
        }
    }
    None
}

/// Parses a JSON array `gh` printed, refusing a shape it does not know.
pub fn parse_json_array(text: &str) -> Option<Vec<Value>> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.as_array().cloned())
}

/// Parses one JSON object per line, as `gh api --jq` emits it.
pub fn parse_json_lines(text: &str) -> Vec<Value> {
    let mut values = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            values.push(value);
        }
    }
    values
}

/// Days from the Unix epoch to a proleptic Gregorian date.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month as i64 + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn split_zone(rest: &str) -> Option<(&str, Option<&str>)> {
    if rest.ends_with('Z') || rest.ends_with('z') {
        return Some((&rest[..rest.len() - 1], Some("Z")));
    }
    for (index, character) in rest.char_indices().skip(8) {
        if character == '+' || character == '-' {
            return Some((&rest[..index], Some(&rest[index..])));
        }
    }
    Some((rest, None))
}

fn parse_instant(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (date, rest) = match value.split_once('T') {
        Some((date, rest)) => (date, rest),
        None => match value.split_once(' ') {
            Some((date, rest)) => (date, rest),
            None => (value, ""),
        },
    };
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hour, minute, second, millis, offset) = if rest.is_empty() {
        (0_i64, 0_i64, 0_i64, 0_i64, 0_i64)
    } else {
        let (clock, zone) = split_zone(rest)?;
        let offset = match zone {
            None => 0,
            Some("Z") => 0,
            Some(zone) => {
                let sign = if zone.starts_with('-') { -1 } else { 1 };
                let digits = zone.trim_start_matches(['+', '-']);
                let (hours, minutes) = match digits.split_once(':') {
                    Some((hours, minutes)) => (hours, minutes),
                    None => (digits, "0"),
                };
                let hours: i64 = hours.parse().ok()?;
                let minutes: i64 = minutes.parse().ok()?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                sign * (hours * 3600 + minutes * 60)
            }
        };
        let mut clock_parts = clock.split(':');
        let hour: i64 = clock_parts.next()?.parse().ok()?;
        let minute: i64 = clock_parts.next()?.parse().ok()?;
        let second_part = clock_parts.next()?;
        if clock_parts.next().is_some() || hour > 23 || minute > 59 {
            return None;
        }
        let (second_text, fraction) = match second_part.split_once('.') {
            Some((second, fraction)) => (second, fraction),
            None => (second_part, ""),
        };
        let second: i64 = second_text.parse().ok()?;
        if second > 60 {
            return None;
        }
        let mut millis = 0_i64;
        let mut scale = 100_i64;
        for digit in fraction.chars().take(3) {
            millis += digit.to_digit(10)? as i64 * scale;
            scale /= 10;
        }
        (hour, minute, second, millis, offset)
    };
    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3600 + minute * 60 + second - offset) * 1000 + millis)
}

/// The earliest published release whose tag is in `tags`.
pub fn earliest_release(releases: &[GitHubRelease], tags: &[String]) -> Option<String> {
    let contained: HashSet<&str> = tags.iter().map(String::as_str).collect();
    let mut candidates: Vec<&GitHubRelease> = releases
        .iter()
        .filter(|release| contained.contains(release.tag.as_str()))
        .collect();
    candidates.sort_by(|left, right| {
        let left_at = parse_instant(&left.published_at);
        let right_at = parse_instant(&right.published_at);
        match (left_at, right_at) {
            (Some(left_at), Some(right_at)) if left_at != right_at => left_at.cmp(&right_at),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            _ => left.tag.cmp(&right.tag),
        }
    });
    candidates.first().map(|release| release.tag.clone())
}

/// The release closest to the issue's close, for a forge that records no
/// closing commit at all.
pub fn release_at_close(
    releases: &[GitHubRelease],
    created_at: Option<&str>,
    closed_at: Option<&str>,
) -> Option<String> {
    let closed = parse_instant(closed_at.unwrap_or(""))?;
    let filed = created_at.and_then(parse_instant);
    let mut candidates: Vec<(&str, i64)> = Vec::new();
    for release in releases {
        let Some(at) = parse_instant(&release.published_at) else {
            continue;
        };
        if let Some(filed) = filed {
            if at < filed {
                continue;
            }
        }
        candidates.push((release.tag.as_str(), at));
    }
    candidates.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(right.0)));
    let preceding = candidates
        .iter()
        .rev()
        .find(|(_, at)| *at <= closed)
        .map(|(tag, _)| *tag);
    preceding
        .or_else(|| candidates.first().map(|(tag, _)| *tag))
        .map(str::to_string)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosingCommitIssue {
    pub number: i64,
    pub state: IssueState,
    pub created_at: Option<String>,
    pub closed_at: Option<String>,
}

pub type ClientFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// The release resolver's view of a forge and its checkout.
pub trait ClosingCommitClient: Send + Sync {
    fn closing_commit(&self, issue_number: i64) -> ClientFuture<'_, Option<String>>;

    fn closing_commits(&self, issue_number: i64) -> ClientFuture<'_, Vec<String>> {
        Box::pin(async move {
            Ok(self
                .closing_commit(issue_number)
                .await?
                .into_iter()
                .collect())
        })
    }

    /// The checkout's own commits naming the issue, newest first. A client
    /// without a checkout returns none.
    fn landed_commits(&self, _issue_number: i64) -> Vec<String> {
        Vec::new()
    }

    fn resolve_commit(&self, short: String) -> ClientFuture<'_, Option<String>>;

    fn containing_release_tags(
        &self,
        commit: String,
        releases: Vec<GitHubRelease>,
    ) -> ClientFuture<'_, Vec<String>>;
}

impl ClosingCommitClient for RepositoryGitHub {
    fn closing_commit(&self, issue_number: i64) -> ClientFuture<'_, Option<String>> {
        Box::pin(async move { RepositoryGitHub::closing_commit(self, issue_number).await })
    }

    fn closing_commits(&self, issue_number: i64) -> ClientFuture<'_, Vec<String>> {
        Box::pin(async move { RepositoryGitHub::closing_commits(self, issue_number).await })
    }

    fn landed_commits(&self, issue_number: i64) -> Vec<String> {
        RepositoryGitHub::landed_commits(self, issue_number)
    }

    fn resolve_commit(&self, short: String) -> ClientFuture<'_, Option<String>> {
        Box::pin(async move { RepositoryGitHub::resolve_commit(self, &short).await })
    }

    fn containing_release_tags(
        &self,
        commit: String,
        releases: Vec<GitHubRelease>,
    ) -> ClientFuture<'_, Vec<String>> {
        Box::pin(async move {
            RepositoryGitHub::containing_release_tags(self, &commit, &releases).await
        })
    }
}

/// The shipped release and, when there is none, why the resolution failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionResolution {
    pub version: Option<String>,
    /// Why `version` is `None`; `None` when the issue is open or it shipped.
    pub error: Option<String>,
    /// True when no commit named the fix and `version` came from the timeline.
    pub inferred: bool,
}

async fn closing_candidates(
    client: &dyn ClosingCommitClient,
    issue_number: i64,
) -> Result<Vec<String>, String> {
    client.closing_commits(issue_number).await
}

async fn landed_shipped_version(
    issue_number: i64,
    client: &dyn ClosingCommitClient,
    releases: &[GitHubRelease],
) -> Result<Option<VersionResolution>, String> {
    let candidates = client.landed_commits(issue_number);
    if candidates.is_empty() {
        return Ok(None);
    }
    let mut tags: HashSet<String> = HashSet::new();
    let mut resolved: Option<String> = None;
    for candidate in candidates {
        let Some(commit) = client.resolve_commit(candidate).await? else {
            continue;
        };
        if resolved.is_none() {
            resolved = Some(commit.clone());
        }
        for tag in client
            .containing_release_tags(commit, releases.to_vec())
            .await?
        {
            tags.insert(tag);
        }
    }
    let Some(resolved) = resolved else {
        return Ok(None);
    };
    let tags: Vec<String> = tags.into_iter().collect();
    Ok(Some(match earliest_release(releases, &tags) {
        Some(version) => VersionResolution {
            version: Some(version),
            error: None,
            inferred: false,
        },
        None => VersionResolution {
            version: None,
            error: Some(format!("no published release contains {resolved}")),
            inferred: false,
        },
    }))
}

async fn resolve_shipped_version_inner(
    issue: &ClosingCommitIssue,
    client: &dyn ClosingCommitClient,
    releases: &[GitHubRelease],
) -> Result<VersionResolution, String> {
    let nearest = release_at_close(
        releases,
        issue.created_at.as_deref(),
        issue.closed_at.as_deref(),
    );
    let without_commit = |error: String| match &nearest {
        Some(tag) => VersionResolution {
            version: Some(tag.clone()),
            error: None,
            inferred: true,
        },
        None => VersionResolution {
            version: None,
            error: Some(error),
            inferred: false,
        },
    };
    if let Some(landed) = landed_shipped_version(issue.number, client, releases).await? {
        return Ok(landed);
    }
    let candidates = closing_candidates(client, issue.number).await?;
    if candidates.is_empty() {
        return Ok(without_commit("no closing commit was found".to_string()));
    }
    let mut error = format!("closing commit {} could not be resolved", candidates[0]);
    let mut resolved: Option<String> = None;
    for candidate in candidates {
        let Some(commit) = client.resolve_commit(candidate).await? else {
            continue;
        };
        resolved = Some(commit.clone());
        let tags = client
            .containing_release_tags(commit.clone(), releases.to_vec())
            .await?;
        if let Some(version) = earliest_release(releases, &tags) {
            return Ok(VersionResolution {
                version: Some(version),
                error: None,
                inferred: false,
            });
        }
        error = format!("no published release contains {commit}");
    }
    Ok(if resolved.is_none() {
        without_commit(error)
    } else {
        VersionResolution {
            version: None,
            error: Some(error),
            inferred: false,
        }
    })
}

/// The release that shipped the issue's closing commit, with every failure
/// reported rather than thrown.
pub async fn resolve_shipped_version(
    issue: &ClosingCommitIssue,
    client: &dyn ClosingCommitClient,
    releases: &[GitHubRelease],
) -> VersionResolution {
    if issue.state != IssueState::Closed {
        return VersionResolution {
            version: None,
            error: None,
            inferred: false,
        };
    }
    match resolve_shipped_version_inner(issue, client, releases).await {
        Ok(resolution) => resolution,
        Err(error) => VersionResolution {
            version: None,
            error: Some(error),
            inferred: false,
        },
    }
}

pub async fn shipped_version(
    issue: &ClosingCommitIssue,
    client: &dyn ClosingCommitClient,
    releases: &[GitHubRelease],
) -> Option<String> {
    resolve_shipped_version(issue, client, releases)
        .await
        .version
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalReleaseContainment {
    contained: Vec<String>,
    pending: Vec<GitHubRelease>,
}

fn tag_names(output: &str) -> HashSet<String> {
    output
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// The landed commits that name an issue, newest first.
pub fn landed_commits(repo_dir: &Path, issue_number: i64) -> Vec<String> {
    if issue_number <= 0 {
        return Vec::new();
    }
    let marker = format!("(#{issue_number})");
    let result = git(repo_dir, &["log", "HEAD", "--format=%H%x09%s"]);
    if result.code != 0 {
        return Vec::new();
    }
    let mut commits = Vec::new();
    for line in result.stdout.split('\n') {
        let Some(separator) = line.find('\t') else {
            continue;
        };
        if separator == 0 {
            continue;
        }
        let sha = &line[..separator];
        let subject = &line[separator + 1..];
        if !is_full_sha(sha) || !subject.ends_with(&marker) {
            continue;
        }
        commits.push(sha.to_string());
        if commits.len() >= COMMIT_CANDIDATE_LIMIT {
            break;
        }
    }
    commits
}

fn local_release_containment(
    repo_dir: &Path,
    commit: &str,
    releases: &[GitHubRelease],
) -> LocalReleaseContainment {
    let listed = git(repo_dir, &["tag", "--list"]);
    let containing = git(repo_dir, &["tag", "--contains", commit]);
    let present = if listed.code == 0 {
        tag_names(&listed.stdout)
    } else {
        HashSet::new()
    };
    let named = if containing.code == 0 {
        Some(tag_names(&containing.stdout))
    } else {
        None
    };
    let mut contained = Vec::new();
    let mut pending = Vec::new();
    for release in releases {
        match (&named, present.contains(&release.tag)) {
            (Some(named), true) => {
                if named.contains(&release.tag) {
                    contained.push(release.tag.clone());
                }
            }
            _ => pending.push(release.clone()),
        }
    }
    LocalReleaseContainment { contained, pending }
}

// ---------------------------------------------------------------------------
// Forge issue client

/// The one forge issue client the MCP tools share.
pub const FORGE_ISSUE_LIST_MAX: usize = 201;
pub const FORGE_ISSUE_ALL_MAX: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeIssueDocument {
    pub number: i64,
    pub title: String,
    pub body: String,
    pub state: IssueState,
    pub labels: Vec<String>,
    pub url: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeIssueSummary {
    pub number: i64,
    pub title: String,
    pub state: IssueState,
    pub labels: Vec<String>,
    pub url: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateForgeIssueInput {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    Completed,
    NotPlanned,
}

impl CloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::NotPlanned => "not planned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommentTarget {
    Number(i64),
    Url(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeIssueError {
    pub message: String,
}

impl ForgeIssueError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ForgeIssueError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ForgeIssueError {}

impl From<GiteaError> for ForgeIssueError {
    fn from(error: GiteaError) -> Self {
        Self::new(error.message)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForgeCommandOutcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub type ForgeRunnerFuture =
    Pin<Box<dyn Future<Output = Result<ForgeCommandOutcome, ForgeTimeoutError>> + Send>>;
/// The injected `gh` seam for the issue client.
pub type ForgeRunner =
    Arc<dyn Fn(Vec<String>, String, Environment) -> ForgeRunnerFuture + Send + Sync>;

#[derive(Clone)]
pub struct ForgeIssuesOptions {
    pub repo_dir: PathBuf,
    pub environment: Environment,
    pub transport: Option<Transport>,
    pub exec: Option<Exec>,
    /// Test seam: replaces the forge CLI.
    pub run: Option<ForgeRunner>,
    /// Bound on one credential probe and one forge command.
    pub timeout_ms: Option<u64>,
}

impl ForgeIssuesOptions {
    pub fn new(repo_dir: impl Into<PathBuf>) -> Self {
        Self {
            repo_dir: repo_dir.into(),
            environment: process_environment(),
            transport: None,
            exec: None,
            run: None,
            timeout_ms: None,
        }
    }
}

/// The default forge CLI runner, sharing the bounded command seam.
fn gh_runner(timeout_ms: u64, exec: Exec) -> ForgeRunner {
    Arc::new(
        move |argv: Vec<String>, stdin: String, environment: Environment| {
            let exec = exec.clone();
            Box::pin(async move {
                let mut exec_environment = string_environment(&environment);
                for (key, value) in CLI_ENV {
                    exec_environment.insert(key.to_string(), value.to_string());
                }
                let result = exec(
                    "gh".to_string(),
                    argv,
                    ExecOptions {
                        cwd: None,
                        env: exec_environment,
                        timeout_ms: Some(timeout_ms),
                        stdin: (!stdin.is_empty()).then_some(stdin),
                    },
                )
                .await;
                if result.killed && result.code == -1 {
                    return Err(ForgeTimeoutError {
                        message: format!(
                            "the forge command timed out after {timeout_ms} ms; retry the request."
                        ),
                    });
                }
                Ok(ForgeCommandOutcome {
                    code: result.code,
                    stdout: result.stdout,
                    stderr: result.stderr,
                })
            })
        },
    )
}

fn labels_of(value: Option<&Value>) -> Vec<String> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut labels = Vec::new();
    for entry in entries {
        if let Some(name) = entry.as_str() {
            labels.push(name.to_string());
            continue;
        }
        if !entry.is_object() {
            continue;
        }
        if let Some(name) = entry.get("name").and_then(Value::as_str) {
            labels.push(name.to_string());
        }
    }
    labels
}

fn state_of(value: Option<&Value>) -> IssueState {
    if value
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case("closed"))
        .unwrap_or(false)
    {
        IssueState::Closed
    } else {
        IssueState::Open
    }
}

fn newest_first(left: &ForgeIssueSummary, right: &ForgeIssueSummary) -> std::cmp::Ordering {
    let left_at = left.created_at.as_deref().and_then(parse_instant);
    let right_at = right.created_at.as_deref().and_then(parse_instant);
    let by_created = match (left_at, right_at) {
        (Some(left_at), Some(right_at)) if right_at != left_at => right_at.cmp(&left_at),
        _ => std::cmp::Ordering::Equal,
    };
    if by_created != std::cmp::Ordering::Equal {
        return by_created;
    }
    right.number.cmp(&left.number)
}

fn github_document(value: &Value) -> Result<ForgeIssueDocument, ForgeIssueError> {
    if !value.is_object() {
        return Err(ForgeIssueError::new("the forge returned no issue document"));
    }
    let Some(number) = value.get("number").and_then(Value::as_i64) else {
        return Err(ForgeIssueError::new(
            "the forge returned an issue without a number or title",
        ));
    };
    let Some(title) = value.get("title").and_then(Value::as_str) else {
        return Err(ForgeIssueError::new(
            "the forge returned an issue without a number or title",
        ));
    };
    Ok(ForgeIssueDocument {
        number,
        title: title.to_string(),
        body: value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        state: state_of(value.get("state")),
        labels: labels_of(value.get("labels")),
        url: value
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        created_at: value
            .get("createdAt")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn gitea_document(document: GiteaIssueDocument) -> ForgeIssueDocument {
    ForgeIssueDocument {
        number: document.number,
        title: document.title,
        body: document.body,
        state: document.state,
        labels: document.labels,
        url: document.url,
        created_at: Some(document.created_at),
    }
}

fn issue_url_number(url: &str) -> Option<i64> {
    issue_number_from_url(url)
}

fn summary_of(issue: &ForgeIssueDocument) -> ForgeIssueSummary {
    ForgeIssueSummary {
        number: issue.number,
        title: issue.title.clone(),
        state: issue.state,
        labels: issue.labels.clone(),
        url: issue.url.clone(),
        created_at: issue.created_at.clone(),
    }
}

/// The one forge issue client the MCP optimizer delivery and the Devboard MCP
/// tools share.
pub struct ForgeIssuesClient {
    forge: Forge,
    repository: String,
    remote: ForgeRemote,
    repo_dir: PathBuf,
    environment: Environment,
    transport: Transport,
    exec: Exec,
    run: ForgeRunner,
    timeout_ms: u64,
    auth_cache: tokio::sync::Mutex<HashMap<RequiredAccess, AuthOutcome>>,
}

impl ForgeIssuesClient {
    /// Resolves the origin and returns the shared client.
    pub fn new(options: ForgeIssuesOptions) -> Result<Self, ForgeIssueError> {
        let repo_dir = options.repo_dir.clone();
        let environment = options.environment;
        let remote = origin_forge_with(&options.repo_dir, &environment).ok_or_else(|| {
            ForgeIssueError::new("the checkout's origin does not name a supported repository")
        })?;
        if remote.forge == Forge::GitLab {
            return Err(ForgeIssueError::new(format!(
                "Issue tools support a GitHub or Gitea origin, not {}",
                remote.host
            )));
        }
        let timeout_ms = options
            .timeout_ms
            .unwrap_or(DEFAULT_COMMAND_TIMEOUT_MS)
            .max(1);
        let transport = options
            .transport
            .unwrap_or_else(|| default_transport(GITEA_REQUEST_TIMEOUT_MS));
        let exec = options.exec.unwrap_or_else(default_exec);
        let run = options
            .run
            .unwrap_or_else(|| gh_runner(timeout_ms, exec.clone()));
        Ok(Self {
            forge: remote.forge,
            repository: remote.project.clone(),
            remote,
            repo_dir,
            environment,
            transport,
            exec,
            run,
            timeout_ms,
            auth_cache: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    pub fn forge(&self) -> Forge {
        self.forge
    }

    pub fn repository(&self) -> &str {
        &self.repository
    }

    async fn auth(&self, required: RequiredAccess) -> Result<ResolvedAuth, ForgeIssueError> {
        let mut cache = self.auth_cache.lock().await;
        if let Some(outcome) = cache.get(&required) {
            return match outcome.clone() {
                AuthOutcome::Resolved(auth) => Ok(auth),
                AuthOutcome::Failure(failure) => {
                    Err(ForgeIssueError::new(first_line(&failure.error)))
                }
            };
        }
        let options = ResolveOptions {
            forge: self.forge,
            host: self.remote.host.clone(),
            project: self.remote.project.clone(),
            cwd: self.repo_dir.clone(),
            required,
            env: self.environment.clone(),
            deadline_ms: Some(now_millis() + self.timeout_ms as i64),
            base_url: if self.forge == Forge::Gitea {
                gitea_base_url(Some(&self.remote), &self.environment)
            } else {
                None
            },
            gitea_transport: Some(self.transport.clone()),
        };
        let outcome = with_forge_deadline(
            resolve_forge_auth(&self.exec, &options),
            self.timeout_ms,
            "resolving the forge credential",
        )
        .await;
        let outcome = match outcome {
            Err(error) => return Err(ForgeIssueError::new(error.message)),
            Ok(outcome) => outcome,
        };
        cache.insert(required, outcome.clone());
        match outcome {
            AuthOutcome::Resolved(auth) => Ok(auth),
            AuthOutcome::Failure(failure) => Err(ForgeIssueError::new(first_line(&failure.error))),
        }
    }

    async fn gitea_target(&self, required: RequiredAccess) -> Result<GiteaTarget, ForgeIssueError> {
        let resolved = self.auth(required).await?;
        let base_url = resolved
            .base_url
            .clone()
            .or_else(|| gitea_base_url(Some(&self.remote), &self.environment));
        let Some(base_url) = base_url.filter(|value| !value.is_empty()) else {
            return Err(ForgeIssueError::new("the Gitea address is not configured"));
        };
        Ok(GiteaTarget {
            base_url,
            project: self.remote.project.clone(),
            token: resolved.token,
        })
    }

    async fn github(
        &self,
        required: RequiredAccess,
        argv: Vec<String>,
        stdin: String,
    ) -> Result<ForgeCommandOutcome, ForgeIssueError> {
        let resolved = self.auth(required).await?;
        let environment = auth_environment(&resolved, &self.environment)
            .map_err(|error| ForgeIssueError::new(error.message))?;
        let outcome = with_forge_deadline(
            (self.run)(argv, stdin, environment),
            self.timeout_ms,
            "the forge command",
        )
        .await
        .map_err(|error| ForgeIssueError::new(error.message))?;
        outcome.map_err(|error| ForgeIssueError::new(error.message))
    }

    async fn github_rows(
        &self,
        current: IssueState,
        limit: usize,
    ) -> Result<Vec<ForgeIssueSummary>, ForgeIssueError> {
        let outcome = self
            .github(
                RequiredAccess::Read,
                vec![
                    "issue".to_string(),
                    "list".to_string(),
                    "--repo".to_string(),
                    self.remote.project.clone(),
                    "--state".to_string(),
                    current.as_str().to_string(),
                    "--limit".to_string(),
                    limit.to_string(),
                    "--json".to_string(),
                    "number,title,state,labels,url,createdAt".to_string(),
                ],
                String::new(),
            )
            .await?;
        if outcome.code != 0 {
            let detail = if outcome.stderr.is_empty() {
                &outcome.stdout
            } else {
                &outcome.stderr
            };
            return Err(ForgeIssueError::new(first_line(detail)));
        }
        let parsed = serde_json::from_str::<Value>(&outcome.stdout)
            .map_err(|_| ForgeIssueError::new("gh issue list returned invalid JSON"))?;
        let Some(entries) = parsed.as_array() else {
            return Err(ForgeIssueError::new("gh issue list returned no array"));
        };
        let mut rows = Vec::new();
        for entry in entries {
            if !entry.is_object() {
                continue;
            }
            let Some(number) = entry.get("number").and_then(Value::as_i64) else {
                continue;
            };
            let Some(title) = entry.get("title").and_then(Value::as_str) else {
                continue;
            };
            rows.push(ForgeIssueSummary {
                number,
                title: title.to_string(),
                state: state_of(entry.get("state")),
                labels: labels_of(entry.get("labels")),
                url: entry
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                created_at: entry
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        Ok(rows)
    }

    /// The newest `limit` rows across the requested state; one bounded page.
    pub async fn list(
        &self,
        state: IssueQueryState,
        limit: Option<usize>,
    ) -> Result<Vec<ForgeIssueSummary>, ForgeIssueError> {
        let limit = limit.unwrap_or(100);
        if self.forge == Forge::Gitea {
            let target = self.gitea_target(RequiredAccess::Read).await?;
            let mut issues = gitea_list_issues(
                &target,
                state,
                &self.transport,
                &GiteaCallOptions::default(),
            )
            .await?;
            let mut summaries: Vec<ForgeIssueSummary> = issues
                .drain(..)
                .map(|issue| summary_of(&gitea_document(issue)))
                .collect();
            summaries.sort_by(newest_first);
            summaries.truncate(limit);
            return Ok(summaries);
        }
        let states = match state {
            IssueQueryState::All => vec![IssueState::Open, IssueState::Closed],
            IssueQueryState::Open => vec![IssueState::Open],
            IssueQueryState::Closed => vec![IssueState::Closed],
        };
        let bounded = limit.clamp(1, FORGE_ISSUE_LIST_MAX);
        let mut rows = Vec::new();
        for current in states {
            rows.extend(self.github_rows(current, bounded).await?);
        }
        let mut seen = HashSet::new();
        let mut unique: Vec<ForgeIssueSummary> = rows
            .into_iter()
            .filter(|row| seen.insert(row.number))
            .collect();
        unique.sort_by(newest_first);
        unique.truncate(limit);
        Ok(unique)
    }

    /// Every issue in the requested state, read page by page.
    pub async fn list_all(
        &self,
        state: IssueQueryState,
    ) -> Result<Vec<ForgeIssueSummary>, ForgeIssueError> {
        if self.forge == Forge::Gitea {
            let target = self.gitea_target(RequiredAccess::Read).await?;
            let mut issues = gitea_list_issues(
                &target,
                state,
                &self.transport,
                &GiteaCallOptions::default(),
            )
            .await?;
            let mut summaries: Vec<ForgeIssueSummary> = issues
                .drain(..)
                .map(|issue| summary_of(&gitea_document(issue)))
                .collect();
            summaries.sort_by(newest_first);
            return Ok(summaries);
        }
        let states = match state {
            IssueQueryState::All => vec![IssueState::Open, IssueState::Closed],
            IssueQueryState::Open => vec![IssueState::Open],
            IssueQueryState::Closed => vec![IssueState::Closed],
        };
        let mut rows: HashMap<i64, ForgeIssueSummary> = HashMap::new();
        for current in states {
            let mut limit = FORGE_ISSUE_LIST_MAX;
            loop {
                let page = self.github_rows(current, limit).await?;
                let page_len = page.len();
                for row in page {
                    rows.insert(row.number, row);
                }
                if page_len < limit || limit >= FORGE_ISSUE_ALL_MAX {
                    break;
                }
                limit = (limit * 2).min(FORGE_ISSUE_ALL_MAX);
            }
        }
        let mut values: Vec<ForgeIssueSummary> = rows.into_values().collect();
        values.sort_by(newest_first);
        Ok(values)
    }

    pub async fn get(&self, number: i64) -> Result<ForgeIssueDocument, ForgeIssueError> {
        if number <= 0 {
            return Err(ForgeIssueError::new(
                "An issue number must be a positive integer.",
            ));
        }
        if self.forge == Forge::Gitea {
            let target = self.gitea_target(RequiredAccess::Read).await?;
            return Ok(gitea_document(
                gitea_issue(
                    &target,
                    number,
                    &self.transport,
                    &GiteaCallOptions::default(),
                )
                .await?,
            ));
        }
        let outcome = self
            .github(
                RequiredAccess::Read,
                vec![
                    "issue".to_string(),
                    "view".to_string(),
                    number.to_string(),
                    "--repo".to_string(),
                    self.remote.project.clone(),
                    "--json".to_string(),
                    "number,title,body,state,labels,url,createdAt".to_string(),
                ],
                String::new(),
            )
            .await?;
        if outcome.code != 0 {
            let detail = if outcome.stderr.is_empty() {
                &outcome.stdout
            } else {
                &outcome.stderr
            };
            return Err(ForgeIssueError::new(first_line(detail)));
        }
        let parsed = serde_json::from_str::<Value>(&outcome.stdout)
            .map_err(|_| ForgeIssueError::new("gh issue view returned invalid JSON"))?;
        github_document(&parsed)
    }

    pub async fn ensure_label(&self, name: &str) -> Result<(), ForgeIssueError> {
        if self.forge == Forge::Gitea {
            let target = self.gitea_target(RequiredAccess::Write).await?;
            gitea_ensure_label(
                &target,
                name,
                "1d76db",
                "Devboard goal specification",
                &self.transport,
                &GiteaCallOptions::default(),
            )
            .await?;
            return Ok(());
        }
        let outcome = self
            .github(
                RequiredAccess::Write,
                vec![
                    "label".to_string(),
                    "create".to_string(),
                    name.to_string(),
                    "--repo".to_string(),
                    self.remote.project.clone(),
                    "--force".to_string(),
                    "--color".to_string(),
                    "1d76db".to_string(),
                    "--description".to_string(),
                    "Devboard goal specification".to_string(),
                ],
                String::new(),
            )
            .await?;
        if outcome.code != 0 {
            let detail = if outcome.stderr.is_empty() {
                &outcome.stdout
            } else {
                &outcome.stderr
            };
            return Err(ForgeIssueError::new(first_line(detail)));
        }
        Ok(())
    }

    pub async fn create(
        &self,
        input: &CreateForgeIssueInput,
    ) -> Result<ForgeIssueDocument, ForgeIssueError> {
        if self.forge == Forge::Gitea {
            let target = self.gitea_target(RequiredAccess::Write).await?;
            let labels = if input.labels.is_empty() {
                None
            } else {
                let wanted: HashSet<&str> = input.labels.iter().map(String::as_str).collect();
                let labels: Vec<i64> =
                    gitea_labels(&target, &self.transport, &GiteaCallOptions::default())
                        .await?
                        .into_iter()
                        .filter(|label| wanted.contains(label.name.as_str()))
                        .map(|label| label.id)
                        .collect();
                (!labels.is_empty()).then_some(labels)
            };
            return Ok(gitea_document(
                gitea_create_issue(
                    &target,
                    &CreateIssueInput {
                        title: input.title.clone(),
                        body: input.body.clone(),
                        labels,
                    },
                    &self.transport,
                    &GiteaCallOptions::default(),
                )
                .await?,
            ));
        }
        let mut argv = vec![
            "issue".to_string(),
            "create".to_string(),
            "--repo".to_string(),
            self.remote.project.clone(),
            "--title".to_string(),
            input.title.clone(),
            "--body-file".to_string(),
            "-".to_string(),
        ];
        for label in &input.labels {
            argv.push("--label".to_string());
            argv.push(label.clone());
        }
        let outcome = self
            .github(RequiredAccess::Write, argv, input.body.clone())
            .await?;
        if outcome.code != 0 {
            let detail = if outcome.stderr.is_empty() {
                &outcome.stdout
            } else {
                &outcome.stderr
            };
            return Err(ForgeIssueError::new(first_line(detail)));
        }
        let url = outcome
            .stdout
            .split('\n')
            .map(str::trim)
            .rev()
            .find(|line| line.starts_with("http://") || line.starts_with("https://"))
            .ok_or_else(|| ForgeIssueError::new("gh printed no issue URL"))?;
        let number = issue_url_number(url)
            .ok_or_else(|| ForgeIssueError::new("gh printed no issue number"))?;
        self.get(number).await
    }

    pub async fn comment(&self, target: &CommentTarget, body: &str) -> Result<(), ForgeIssueError> {
        if self.forge == Forge::Gitea {
            let gitea = self.gitea_target(RequiredAccess::Write).await?;
            let number = match target {
                CommentTarget::Number(number) => Some(*number),
                CommentTarget::Url(url) => gitea_issue_number(&gitea, url),
            };
            let Some(number) = number else {
                let url = match target {
                    CommentTarget::Number(number) => number.to_string(),
                    CommentTarget::Url(url) => url.clone(),
                };
                return Err(ForgeIssueError::new(format!(
                    "not an issue in {}/{}: {url}",
                    gitea.base_url, gitea.project
                )));
            };
            gitea_comment_issue(
                &gitea,
                number,
                body,
                &self.transport,
                &GiteaCallOptions::default(),
            )
            .await?;
            return Ok(());
        }
        let mut argv = vec!["issue".to_string(), "comment".to_string()];
        match target {
            CommentTarget::Number(number) => {
                argv.push(number.to_string());
                argv.push("--repo".to_string());
                argv.push(self.remote.project.clone());
            }
            CommentTarget::Url(url) => argv.push(url.clone()),
        }
        argv.push("--body-file".to_string());
        argv.push("-".to_string());
        let outcome = self
            .github(RequiredAccess::Write, argv, body.to_string())
            .await?;
        if outcome.code != 0 {
            let detail = if outcome.stderr.is_empty() {
                &outcome.stdout
            } else {
                &outcome.stderr
            };
            return Err(ForgeIssueError::new(first_line(detail)));
        }
        Ok(())
    }

    pub async fn close(
        &self,
        number: i64,
        reason: CloseReason,
    ) -> Result<ForgeIssueDocument, ForgeIssueError> {
        if self.forge == Forge::Gitea {
            let target = self.gitea_target(RequiredAccess::Write).await?;
            gitea_close_issue(
                &target,
                number,
                &self.transport,
                &GiteaCallOptions::default(),
            )
            .await?;
            return self.get(number).await;
        }
        let outcome = self
            .github(
                RequiredAccess::Write,
                vec![
                    "issue".to_string(),
                    "close".to_string(),
                    number.to_string(),
                    "--repo".to_string(),
                    self.remote.project.clone(),
                    "--reason".to_string(),
                    reason.as_str().to_string(),
                ],
                String::new(),
            )
            .await?;
        if outcome.code != 0 {
            let detail = if outcome.stderr.is_empty() {
                &outcome.stdout
            } else {
                &outcome.stderr
            };
            return Err(ForgeIssueError::new(first_line(detail)));
        }
        self.get(number).await
    }
}

// ---------------------------------------------------------------------------
// Issue tracker reads and writes

/// The issues tracker reads GitHub and Gitea origins; a GitLab origin is not
/// supported.
pub const GITLAB_TRACKER_UNSUPPORTED: &str =
    "the issues tracker reads GitHub and Gitea origins; a GitLab origin is not supported";

/// Default wall-clock bound for one tracker read, including the `gh` child.
pub const TRACKER_TIMEOUT_MS: u64 = 20_000;

const TRACKER_QUERY: &str =
    ".[] | select(.pull_request == null) | {number, title, body, url: .html_url, createdAt: .created_at, labels: [.labels[].name]}";

/// One open issue as the tracker reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolledIssue {
    pub number: i64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub created_at: String,
    pub labels: Vec<String>,
}

/// One conditional poll's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollResult {
    Issues {
        issues: Vec<PolledIssue>,
        etag: Option<String>,
    },
    NotModified {
        etag: Option<String>,
    },
    RateLimited {
        until: String,
        detail: String,
    },
    Error {
        detail: String,
    },
    Unsupported {
        detail: String,
    },
}

/// One issue's lifecycle state, or why it could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueStateResult {
    State(IssueState),
    Error { detail: String },
}

/// The result of writing or clearing the `processing` label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessingWriteResult {
    Ok,
    Error { detail: String },
}

/// Everything one tracker read or write needs.
#[derive(Clone)]
pub struct TrackerOptions {
    /// The origin forge; defaults to GitHub for callers without one.
    pub forge: Forge,
    pub repository: String,
    pub etag: Option<String>,
    /// Injected for tests; defaults to the operator's `gh`.
    pub run: Option<ForgeRunner>,
    pub environment: Environment,
    /// Whole-read deadline; defaults to `TRACKER_TIMEOUT_MS`.
    pub timeout_ms: Option<u64>,
    /// Gitea HTTP origin.
    pub base_url: Option<String>,
    /// Injected transport for the Gitea API.
    pub transport: Option<Transport>,
}

impl TrackerOptions {
    pub fn new(forge: Forge, repository: impl Into<String>) -> Self {
        Self {
            forge,
            repository: repository.into(),
            etag: None,
            run: None,
            environment: process_environment(),
            timeout_ms: None,
            base_url: None,
            transport: None,
        }
    }
}

/// One status block of `gh api --include` output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResponseBlock {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<String>,
}

/// Splits `gh api --include` output into status blocks.
pub fn parse_gh_response(text: &str) -> Vec<ResponseBlock> {
    static STATUS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^HTTP/\S+\s+(\d{3})").expect("the status line form"));
    let mut blocks: Vec<ResponseBlock> = Vec::new();
    let mut in_headers = false;
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(captures) = STATUS.captures(line) {
            let status = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<u16>().ok())
                .unwrap_or(0);
            blocks.push(ResponseBlock {
                status,
                headers: HashMap::new(),
                body: Vec::new(),
            });
            in_headers = true;
            continue;
        }
        let Some(block) = blocks.last_mut() else {
            continue;
        };
        if in_headers {
            if line.trim().is_empty() {
                in_headers = false;
                continue;
            }
            if let Some(separator) = line.find(':') {
                let name = line[..separator].trim().to_ascii_lowercase();
                let value = line[separator + 1..].trim().to_string();
                block.headers.insert(name, value);
            }
            continue;
        }
        block.body.push(line.to_string());
    }
    blocks
}

fn optional_first_line(text: &str) -> Option<String> {
    text.split('\n')
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn iso_from_millis(millis: i64) -> String {
    let nanos = i128::from(millis).saturating_mul(1_000_000);
    let moment = time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        moment.year(),
        moment.month() as u8,
        moment.day(),
        moment.hour(),
        moment.minute(),
        moment.second(),
        moment.millisecond()
    )
}

fn rate_limit_until(headers: &HashMap<String, String>, now_millis_value: i64) -> String {
    if let Some(retry_after) = headers.get("retry-after") {
        if let Ok(seconds) = retry_after.parse::<f64>() {
            if seconds.is_finite() && seconds > 0.0 {
                return iso_from_millis(now_millis_value + (seconds * 1000.0) as i64);
            }
        }
        if let Some(at) = parse_instant(retry_after) {
            return iso_from_millis(at);
        }
    }
    if let Some(reset) = headers.get("x-ratelimit-reset") {
        if let Ok(seconds) = reset.parse::<f64>() {
            if seconds.is_finite() && seconds > 0.0 {
                return iso_from_millis((seconds * 1000.0) as i64);
            }
        }
    }
    iso_from_millis(now_millis_value + 60_000)
}

fn tracker_issue(value: &Value) -> Option<PolledIssue> {
    let number = value.get("number").and_then(Value::as_i64)?;
    let title = value.get("title").and_then(Value::as_str)?;
    let url = value.get("url").and_then(Value::as_str)?;
    let created_at = value.get("createdAt").and_then(Value::as_str)?;
    let labels = match value.get("labels") {
        None | Some(Value::Null) => Vec::new(),
        Some(labels) => labels
            .as_array()?
            .iter()
            .map(|label| label.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()?,
    };
    let body = match value.get("body") {
        None | Some(Value::Null) => String::new(),
        Some(body) => body.as_str()?.to_string(),
    };
    Some(PolledIssue {
        number,
        title: title.to_string(),
        body,
        url: url.to_string(),
        created_at: created_at.to_string(),
        labels,
    })
}

fn parse_tracker_lines(lines: &[String]) -> Result<Vec<PolledIssue>, String> {
    let mut issues = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: Value = serde_json::from_str(trimmed).map_err(|_| {
            format!(
                "the tracker printed a line that is not JSON: {}",
                crate::feedback::js_truncate(trimmed, 200)
            )
        })?;
        let entries: Vec<&Value> = match &parsed {
            Value::Array(entries) => entries.iter().collect(),
            other => vec![other],
        };
        for entry in entries {
            let Some(issue) = tracker_issue(entry) else {
                return Err("the tracker printed an issue of an unexpected shape".to_string());
            };
            issues.push(issue);
        }
    }
    let mut seen = HashSet::new();
    issues.retain(|issue| seen.insert(issue.number));
    issues.sort_by_key(|issue| issue.number);
    Ok(issues)
}

/// One conditional poll of the origin's open, non-pull-request issues.
pub async fn poll_open_issues(options: &TrackerOptions) -> PollResult {
    if options.forge == Forge::GitLab {
        return PollResult::Unsupported {
            detail: GITLAB_TRACKER_UNSUPPORTED.to_string(),
        };
    }
    if options.forge == Forge::Gitea {
        let Some(base_url) = options.base_url.clone().filter(|value| !value.is_empty()) else {
            return PollResult::Error {
                detail: "the Gitea address is not configured; set DEVBOARD_GITEA_URL".to_string(),
            };
        };
        let target = GiteaTarget {
            base_url,
            project: options.repository.clone(),
            token: configured_gitea_token(&options.environment),
        };
        let transport = options
            .transport
            .clone()
            .unwrap_or_else(|| default_transport(GITEA_REQUEST_TIMEOUT_MS));
        return match gitea_list_issues(
            &target,
            IssueQueryState::Open,
            &transport,
            &GiteaCallOptions::default(),
        )
        .await
        {
            Ok(issues) => PollResult::Issues {
                issues: issues
                    .into_iter()
                    .map(|issue| PolledIssue {
                        number: issue.number,
                        title: issue.title,
                        body: issue.body,
                        url: issue.url,
                        created_at: issue.created_at,
                        labels: issue.labels,
                    })
                    .collect(),
                etag: options.etag.clone(),
            },
            Err(error) => {
                if matches!(error.status, Some(403) | Some(429)) {
                    PollResult::RateLimited {
                        until: iso_from_millis(now_millis() + 60_000),
                        detail: error.message,
                    }
                } else {
                    PollResult::Error {
                        detail: error.message,
                    }
                }
            }
        };
    }

    let timeout_ms = options.timeout_ms.unwrap_or(TRACKER_TIMEOUT_MS).max(1);
    let run = options
        .run
        .clone()
        .unwrap_or_else(|| gh_runner(timeout_ms, default_exec()));
    let mut argv = vec![
        "api".to_string(),
        "--include".to_string(),
        "--paginate".to_string(),
    ];
    if let Some(etag) = options.etag.as_deref() {
        argv.push("-H".to_string());
        argv.push(format!("If-None-Match: {etag}"));
    }
    argv.push(format!(
        "repos/{}/issues?state=open&per_page=100",
        options.repository
    ));
    argv.push("--jq".to_string());
    argv.push(TRACKER_QUERY.to_string());
    let outcome = match run(argv, String::new(), options.environment.clone()).await {
        Ok(outcome) => outcome,
        Err(error) => {
            return PollResult::Error {
                detail: error.message,
            };
        }
    };
    let blocks = parse_gh_response(&outcome.stdout);
    let etag = blocks
        .first()
        .and_then(|block| block.headers.get("etag").cloned())
        .or_else(|| options.etag.clone());
    if blocks.iter().any(|block| block.status == 304) {
        return PollResult::NotModified { etag };
    }
    if let Some(limited) = blocks
        .iter()
        .find(|block| block.status == 403 || block.status == 429)
    {
        let detail = optional_first_line(&outcome.stderr)
            .or_else(|| optional_first_line(&limited.body.join("\n")))
            .unwrap_or_else(|| format!("gh exited with code {}", outcome.code));
        return PollResult::RateLimited {
            until: rate_limit_until(&limited.headers, now_millis()),
            detail,
        };
    }
    if outcome.code != 0 {
        let detail = optional_first_line(&outcome.stderr)
            .or_else(|| {
                optional_first_line(
                    &blocks
                        .iter()
                        .flat_map(|block| block.body.clone())
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
            })
            .unwrap_or_else(|| format!("gh exited with code {}", outcome.code));
        return PollResult::Error { detail };
    }
    let lines: Vec<String> = blocks.into_iter().flat_map(|block| block.body).collect();
    match parse_tracker_lines(&lines) {
        Ok(issues) => PollResult::Issues { issues, etag },
        Err(detail) => PollResult::Error { detail },
    }
}

/// The tracker's current state for one issue.
pub async fn fetch_issue_state(options: &TrackerOptions, number: i64) -> IssueStateResult {
    if options.forge == Forge::GitLab {
        return IssueStateResult::Error {
            detail: GITLAB_TRACKER_UNSUPPORTED.to_string(),
        };
    }
    if options.forge == Forge::Gitea {
        let Some(base_url) = options.base_url.clone().filter(|value| !value.is_empty()) else {
            return IssueStateResult::Error {
                detail: "the Gitea address is not configured; set DEVBOARD_GITEA_URL".to_string(),
            };
        };
        let target = GiteaTarget {
            base_url,
            project: options.repository.clone(),
            token: configured_gitea_token(&options.environment),
        };
        let transport = options
            .transport
            .clone()
            .unwrap_or_else(|| default_transport(GITEA_REQUEST_TIMEOUT_MS));
        return match gitea_issue(&target, number, &transport, &GiteaCallOptions::default()).await {
            Ok(issue) => IssueStateResult::State(issue.state),
            Err(error) => IssueStateResult::Error {
                detail: error.message,
            },
        };
    }
    let timeout_ms = options.timeout_ms.unwrap_or(TRACKER_TIMEOUT_MS).max(1);
    let run = options
        .run
        .clone()
        .unwrap_or_else(|| gh_runner(timeout_ms, default_exec()));
    let outcome = match run(
        vec![
            "api".to_string(),
            format!("repos/{}/issues/{number}", options.repository),
            "--jq".to_string(),
            ".state".to_string(),
        ],
        String::new(),
        options.environment.clone(),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            return IssueStateResult::Error {
                detail: error.message,
            };
        }
    };
    if outcome.code != 0 {
        return IssueStateResult::Error {
            detail: optional_first_line(&outcome.stderr)
                .unwrap_or_else(|| format!("gh exited with code {}", outcome.code)),
        };
    }
    match outcome.stdout.trim() {
        "open" => IssueStateResult::State(IssueState::Open),
        "closed" => IssueStateResult::State(IssueState::Closed),
        other => IssueStateResult::Error {
            detail: format!(
                "the tracker returned an unexpected issue state: {}",
                crate::feedback::js_truncate(other, 100)
            ),
        },
    }
}

/// Writes or clears the one `processing` label on one issue.
pub async fn write_issue_processing(
    options: &TrackerOptions,
    number: i64,
    active: bool,
) -> ProcessingWriteResult {
    if options.forge == Forge::GitLab {
        return ProcessingWriteResult::Error {
            detail: GITLAB_TRACKER_UNSUPPORTED.to_string(),
        };
    }
    if options.forge == Forge::Gitea {
        let Some(base_url) = options.base_url.clone().filter(|value| !value.is_empty()) else {
            return ProcessingWriteResult::Error {
                detail: "the Gitea address is not configured; set DEVBOARD_GITEA_URL".to_string(),
            };
        };
        let target = GiteaTarget {
            base_url,
            project: options.repository.clone(),
            token: configured_gitea_token(&options.environment),
        };
        let transport = options
            .transport
            .clone()
            .unwrap_or_else(|| default_transport(GITEA_REQUEST_TIMEOUT_MS));
        let call_options = GiteaCallOptions::default();
        if active {
            let ensured = gitea_ensure_label(
                &target,
                PROCESSING_LABEL,
                PROCESSING_LABEL_COLOR,
                PROCESSING_LABEL_DESCRIPTION,
                &transport,
                &call_options,
            )
            .await;
            let result = match ensured {
                Ok(label_id) => {
                    gitea_add_issue_label(&target, number, label_id, &transport, &call_options)
                        .await
                }
                Err(error) => Err(error),
            };
            return match result {
                Ok(()) => ProcessingWriteResult::Ok,
                Err(error) => ProcessingWriteResult::Error {
                    detail: error.message,
                },
            };
        }
        let labels = match gitea_labels(&target, &transport, &call_options).await {
            Ok(labels) => labels,
            Err(error) => {
                return ProcessingWriteResult::Error {
                    detail: error.message,
                };
            }
        };
        let Some(label) = labels
            .into_iter()
            .find(|label| label.name == PROCESSING_LABEL)
        else {
            return ProcessingWriteResult::Ok;
        };
        return match gitea_remove_issue_label(&target, number, label.id, &transport, &call_options)
            .await
        {
            Ok(()) => ProcessingWriteResult::Ok,
            Err(error) => ProcessingWriteResult::Error {
                detail: error.message,
            },
        };
    }
    let timeout_ms = options.timeout_ms.unwrap_or(TRACKER_TIMEOUT_MS).max(1);
    let run = options
        .run
        .clone()
        .unwrap_or_else(|| gh_runner(timeout_ms, default_exec()));
    let environment = options.environment.clone();
    let run_one = |argv: Vec<String>| {
        let run = run.clone();
        let environment = environment.clone();
        async move {
            match run(argv, String::new(), environment).await {
                Ok(outcome) if outcome.code == 0 => Ok(()),
                Ok(outcome) => Err(optional_first_line(&outcome.stderr)
                    .unwrap_or_else(|| format!("gh exited with code {}", outcome.code))),
                Err(error) => Err(error.message),
            }
        }
    };
    if active {
        if let Err(detail) = run_one(vec![
            "label".to_string(),
            "create".to_string(),
            PROCESSING_LABEL.to_string(),
            "--repo".to_string(),
            options.repository.clone(),
            "--color".to_string(),
            PROCESSING_LABEL_COLOR.to_string(),
            "--description".to_string(),
            PROCESSING_LABEL_DESCRIPTION.to_string(),
            "--force".to_string(),
        ])
        .await
        {
            return ProcessingWriteResult::Error { detail };
        }
    }
    match run_one(vec![
        "issue".to_string(),
        "edit".to_string(),
        number.to_string(),
        if active {
            "--add-label"
        } else {
            "--remove-label"
        }
        .to_string(),
        PROCESSING_LABEL.to_string(),
        "--repo".to_string(),
        options.repository.clone(),
    ])
    .await
    {
        Ok(()) => ProcessingWriteResult::Ok,
        Err(detail) => ProcessingWriteResult::Error { detail },
    }
}

// ---------------------------------------------------------------------------
// Labels and issue titles

/// The one label that marks an open issue's run in progress.
pub const PROCESSING_LABEL: &str = "processing";
pub const PROCESSING_LABEL_COLOR: &str = "FBCA04";
pub const PROCESSING_LABEL_DESCRIPTION: &str = "A Devboard issues run is processing this issue";

/// Whether a forge-listed issue carries the processing label.
pub fn has_processing_label(labels: &[String]) -> bool {
    labels.iter().any(|label| label == PROCESSING_LABEL)
}

/// The identity every duplicate comparison uses: lowercase, whitespace
/// collapsed, trimmed.
pub fn normalize_issue_title(title: &str) -> String {
    title
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Local Gitea discovery

/// Ports tried when the platform exposes no listener table.
pub const FALLBACK_PORTS: [u16; 7] = [3000, 3001, 8000, 8080, 8443, 80, 443];
pub const PROBE_TIMEOUT_MS: u64 = 500;

/// Every listening TCP port in a `/proc/net/tcp` or `/proc/net/tcp6` table.
pub fn listening_ports_from(table: &str) -> Vec<u16> {
    let mut ports = HashSet::new();
    for line in table.split('\n') {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 || fields[3] != "0A" {
            continue;
        }
        let local = fields[1];
        let Some(separator) = local.rfind(':') else {
            continue;
        };
        let Ok(port) = u16::from_str_radix(&local[separator + 1..], 16) else {
            continue;
        };
        if port > 0 {
            ports.insert(port);
        }
    }
    let mut ports: Vec<u16> = ports.into_iter().collect();
    ports.sort_unstable();
    ports
}

/// Listening ports on this machine, or the documented fallback when unknown.
pub async fn local_listening_ports() -> Vec<u16> {
    let mut ports = HashSet::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(source) = tokio::fs::read_to_string(table).await else {
            continue;
        };
        for port in listening_ports_from(&source) {
            ports.insert(port);
        }
    }
    if ports.is_empty() {
        return FALLBACK_PORTS.to_vec();
    }
    let mut ports: Vec<u16> = ports.into_iter().collect();
    ports.sort_unstable();
    ports
}

/// Whether a value is the documented Gitea `GET /api/v1/version` reply.
pub fn is_gitea_version_document(value: &Value) -> bool {
    let Some(version) = value.get("version").and_then(Value::as_str) else {
        return false;
    };
    !version.trim().is_empty()
}

#[derive(Clone, Default)]
pub struct LocalGiteaOptions {
    /// Candidate ports; defaults to the local listener table with a fallback.
    pub ports: Option<Vec<u16>>,
    /// Per-probe deadline.
    pub timeout_ms: Option<u64>,
    /// Injectable transport.
    pub transport: Option<Transport>,
}

async fn probe(port: u16, transport: &Transport, timeout_ms: u64) -> Option<String> {
    let request = HttpRequest {
        method: "GET".to_string(),
        url: format!("http://127.0.0.1:{port}/api/v1/version"),
        headers: vec![("Accept".to_string(), "application/json".to_string())],
        body: None,
        timeout_ms: Some(timeout_ms),
    };
    let response = transport(request).await.ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    if !response_header(&response, "content-type")
        .unwrap_or("")
        .contains("application/json")
    {
        return None;
    }
    let document: Value = serde_json::from_slice(&response.body).ok()?;
    is_gitea_version_document(&document).then(|| format!("http://127.0.0.1:{port}"))
}

/// The lowest loopback port that answers as a Gitea API, or `None`.
pub async fn discover_local_gitea(options: &LocalGiteaOptions) -> Option<String> {
    let mut ports: Vec<u16> = match &options.ports {
        Some(ports) => ports.clone(),
        None => local_listening_ports().await,
    };
    ports.sort_unstable();
    ports.dedup();
    let transport = options
        .transport
        .clone()
        .unwrap_or_else(|| default_transport(PROBE_TIMEOUT_MS));
    let timeout_ms = options.timeout_ms.unwrap_or(PROBE_TIMEOUT_MS);
    let probes = ports
        .iter()
        .map(|port| probe(*port, &transport, timeout_ms));
    let results = join_all(probes).await;
    results.into_iter().flatten().next()
}

/// Everything source-checkout discovery needs.
#[derive(Clone)]
pub struct SourceCheckoutGiteaOptions {
    pub repo_dir: PathBuf,
    pub environment: Environment,
    /// Overrides the filesystem predicate; tests set it directly.
    pub source_checkout: Option<bool>,
    pub ports: Option<Vec<u16>>,
    pub timeout_ms: Option<u64>,
    pub transport: Option<Transport>,
}

/// The loopback Gitea origin a source-checkout dashboard discovers, or `None`.
pub async fn source_checkout_gitea_url(options: &SourceCheckoutGiteaOptions) -> Option<String> {
    let environment = &options.environment;
    if configured_gitea_url(environment).is_some() {
        return None;
    }
    let source = match options.source_checkout {
        Some(source) => source,
        None => crate::version::is_harness_source_checkout(&options.repo_dir),
    };
    if !source {
        return None;
    }
    let remote = origin_forge_with(&options.repo_dir, environment)?;
    if remote.forge != Forge::Gitea {
        return None;
    }
    if remote.origin_url.is_some() || !loopback_hosts().contains(remote.host.as_str()) {
        return None;
    }
    discover_local_gitea(&LocalGiteaOptions {
        ports: options.ports.clone(),
        timeout_ms: options.timeout_ms,
        transport: options.transport.clone(),
    })
    .await
}
