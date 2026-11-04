//! The Conventional Commits pre-push gate, the release version it derives, and
//! the installer for the shared `pre-push` hook.
//!
//! One implementation backs the pre-push hook declared in
//! `.devboard/hooks/pre-push` and the `devboard gate-prepush` and
//! `devboard hooks install` commands. A merge commit is exempt from both the
//! grammar and the bump mapping: a real merge has two or more parents, and
//! Git's generated `Merge …` subject covers synthetic merges whose duplicate
//! parents Git dropped. The first release of this line is `1.0.0`, whatever
//! the commit types in its range are; later releases advance the newest
//! reachable release tag by the highest level in the non-merge commits after
//! it.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

pub use crate::publish::{
    commit_level, commit_violations, compare_versions, highest_version, is_merge_commit,
    parse_subject, release_level, subject_rule, CommitRecord, CommitViolation, ParsedSubject,
    ReleaseDerivation, ReleaseLevel, ReleaseTag, BASELINE_VERSION, CONVENTIONAL_TYPES,
};

use crate::git::run_git;

/// The manifest name the source harness must carry.
pub const HARNESS_NAME: &str = "@dsdenes/devboard";
/// The bounded time one git child of the gate may take.
const GIT_TIMEOUT_MS: u64 = 120_000;

/// One ref line as the pre-push hook receives it on standard input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrePushRef {
    pub local_ref: String,
    pub local_sha: String,
    pub remote_ref: String,
    pub remote_sha: String,
}

/// How the commit a release tag names relates to `HEAD`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagBinding {
    /// No tag of that name exists in this checkout.
    Absent,
    /// The tag points exactly at the target.
    Names,
    /// The target is an ancestor of the tagged commit.
    Contains,
    /// The tagged commit is an ancestor of the target.
    Behind,
    /// The two histories are independent.
    Unrelated,
}

impl TagBinding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Names => "names",
            Self::Contains => "contains",
            Self::Behind => "behind",
            Self::Unrelated => "unrelated",
        }
    }
}

/// What one hook installation did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookInstallReport {
    pub hooks_directory: PathBuf,
    pub target: PathBuf,
    /// True when the checked-in hook was already installed unchanged.
    pub current: bool,
}

impl HookInstallReport {
    /// The one line the installer reports.
    pub fn message(&self) -> String {
        if self.current {
            format!("hooks: {} is current", self.target.display())
        } else {
            format!("hooks: installed {}", self.target.display())
        }
    }
}

/// The next release version: the 1.0.0 baseline first, then the bump.
///
/// An unreadable previous version is an error rather than a silent reset, so
/// a caller cannot report a release that ignores the tag it came from.
pub fn next_release_version(previous: Option<&str>, level: Option<ReleaseLevel>) -> Result<String> {
    let Some(previous) = previous else {
        return Ok(BASELINE_VERSION.to_string());
    };
    if compare_versions(previous, previous).is_none() {
        bail!("unreadable release version: {previous}");
    }
    let Some(order) = compare_versions(previous, BASELINE_VERSION) else {
        bail!("unreadable release version: {previous}");
    };
    if order < 0 {
        return Ok(BASELINE_VERSION.to_string());
    }
    let Some(level) = level else {
        return Ok(previous.to_string());
    };
    let parts: Vec<u64> = previous
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    let major = parts.first().copied().unwrap_or(0);
    let minor = parts.get(1).copied().unwrap_or(0);
    let patch = parts.get(2).copied().unwrap_or(0);
    Ok(match level {
        ReleaseLevel::Major => format!("{}.0.0", major + 1),
        ReleaseLevel::Minor => format!("{major}.{}.0", minor + 1),
        ReleaseLevel::Patch => format!("{major}.{minor}.{}", patch + 1),
    })
}

fn record_separator() -> char {
    '\u{1e}'
}

fn field_separator() -> char {
    '\u{1f}'
}

fn log_format() -> String {
    format!(
        "%H{field}%P{field}%s{field}%b{record}",
        field = field_separator(),
        record = record_separator()
    )
}

fn git_failure(result: &crate::git::GitResult) -> String {
    let stderr = result.stderr.trim();
    if stderr.is_empty() {
        format!("exit {}", result.code)
    } else {
        stderr.to_string()
    }
}

fn parse_records(text: &str) -> Vec<CommitRecord> {
    let mut records = Vec::new();
    for chunk in text.split(record_separator()) {
        let record = chunk.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let mut fields = record.split(field_separator());
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

/// Every commit reachable from `range`, merges included.
pub async fn read_commits(directory: &Path, range: &str) -> Result<Vec<CommitRecord>> {
    let format = format!("--format={}", log_format());
    let result = run_git(
        directory,
        &["log", &format, range, "--"],
        &Default::default(),
        GIT_TIMEOUT_MS,
    )
    .await;
    if result.code != 0 {
        bail!(
            "could not read the commits of {}: {}",
            range,
            git_failure(&result)
        );
    }
    Ok(parse_records(&result.stdout))
}

async fn read_commits_by_sha(directory: &Path, shas: &[String]) -> Result<Vec<CommitRecord>> {
    if shas.is_empty() {
        return Ok(Vec::new());
    }
    let format = format!("--format={}", log_format());
    let mut args: Vec<&str> = vec!["log", "--no-walk=unsorted", &format];
    args.extend(shas.iter().map(String::as_str));
    args.push("--");
    let result = run_git(directory, &args, &Default::default(), GIT_TIMEOUT_MS).await;
    if result.code != 0 {
        bail!(
            "could not read {} commit(s): {}",
            shas.len(),
            git_failure(&result)
        );
    }
    Ok(parse_records(&result.stdout))
}

/// Every non-merge commit in the range whose subject breaks the grammar.
pub async fn check_commit_range(directory: &Path, range: &str) -> Result<Vec<CommitViolation>> {
    Ok(commit_violations(&read_commits(directory, range).await?))
}

/// One line per violation: the sha and subject, then the broken rule.
pub fn format_violations(violations: &[CommitViolation]) -> String {
    violations
        .iter()
        .map(|violation| {
            format!(
                "commit-gate: {} {}\n  {}",
                violation.sha, violation.subject, violation.rule
            )
        })
        .collect::<Vec<String>>()
        .join("\n")
}

/// Writes the violations and the retry instruction, and returns the exit code.
pub fn report_violations(violations: &[CommitViolation]) -> i32 {
    if violations.is_empty() {
        return 0;
    }
    eprintln!("{}", format_violations(violations));
    eprintln!(
        "commit-gate: {} commit(s) are not Conventional Commits; \
         reword them with `git commit --amend` or an interactive rebase and retry",
        violations.len()
    );
    1
}

/// The release tags reachable from `head`, with their `v` stripped.
pub async fn release_tags(directory: &Path, head: &str) -> Vec<ReleaseTag> {
    let result = run_git(
        directory,
        &["tag", "--merged", head, "--list", "v*"],
        &Default::default(),
        GIT_TIMEOUT_MS,
    )
    .await;
    if result.code != 0 {
        return Vec::new();
    }
    let mut tags = Vec::new();
    for line in result.stdout.split('\n') {
        if let Some(version) = release_version_of(line.trim()) {
            tags.push(ReleaseTag {
                tag: format!("v{version}"),
                version,
            });
        }
    }
    tags
}

/// The version inside one `v<major>.<minor>.<patch>` tag name, if any.
fn release_version_of(line: &str) -> Option<String> {
    let version = line.strip_prefix('v')?;
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    Some(version.to_string())
}

/// The newest release version reachable from `head`; the source-checkout rule.
pub async fn newest_release_version(directory: &Path, head: &str) -> Option<String> {
    let tags = release_tags(directory, head).await;
    highest_version(tags.iter().map(|tag| tag.version.as_str()))
}

/// The highest release tag reachable from `head`.
pub async fn previous_release_tag(directory: &Path, head: &str) -> Option<ReleaseTag> {
    let mut previous: Option<ReleaseTag> = None;
    for tag in release_tags(directory, head).await {
        let order = match &previous {
            None => Some(1),
            Some(current) => compare_versions(&tag.version, &current.version),
        };
        let Some(order) = order else {
            continue;
        };
        if order > 0 {
            previous = Some(tag);
        }
    }
    previous
}

/// The highest release version whose tag points exactly at `sha`.
pub async fn release_version_at(directory: &Path, sha: &str) -> Option<String> {
    let result = run_git(
        directory,
        &["tag", "--points-at", sha, "--list", "v*"],
        &Default::default(),
        GIT_TIMEOUT_MS,
    )
    .await;
    if result.code != 0 {
        return None;
    }
    let versions: Vec<String> = result
        .stdout
        .split('\n')
        .filter_map(|line| release_version_of(line.trim()))
        .collect();
    highest_version(versions.iter().map(String::as_str))
}

/// The commit a tag names, or `None` when this checkout has no such tag.
pub async fn tag_commit(directory: &Path, tag: &str) -> Option<String> {
    let reference = format!("refs/tags/{tag}^{{commit}}");
    let result = run_git(
        directory,
        &["rev-parse", "--verify", "--quiet", &reference],
        &Default::default(),
        GIT_TIMEOUT_MS,
    )
    .await;
    if result.code != 0 {
        return None;
    }
    let sha = result.stdout.split_whitespace().next().unwrap_or("");
    (!sha.is_empty()).then(|| sha.to_string())
}

async fn resolve_commit(directory: &Path, reference: &str) -> Option<String> {
    let expression = format!("{reference}^{{commit}}");
    let result = run_git(
        directory,
        &["rev-parse", "--verify", "--quiet", &expression],
        &Default::default(),
        GIT_TIMEOUT_MS,
    )
    .await;
    if result.code != 0 {
        return None;
    }
    let sha = result.stdout.split_whitespace().next().unwrap_or("");
    (!sha.is_empty()).then(|| sha.to_string())
}

async fn is_ancestor(directory: &Path, ancestor: &str, descendant: &str) -> bool {
    run_git(
        directory,
        &["merge-base", "--is-ancestor", ancestor, descendant],
        &Default::default(),
        GIT_TIMEOUT_MS,
    )
    .await
    .code
        == 0
}

/// How `tag` relates to `head`; see [`TagBinding`].
pub async fn tag_binding(directory: &Path, tag: &str, head: &str) -> TagBinding {
    let Some(tagged) = tag_commit(directory, tag).await else {
        return TagBinding::Absent;
    };
    let Some(sha) = resolve_commit(directory, head).await else {
        return TagBinding::Unrelated;
    };
    if sha == tagged {
        return TagBinding::Names;
    }
    if is_ancestor(directory, &sha, &tagged).await {
        return TagBinding::Contains;
    }
    if is_ancestor(directory, &tagged, &sha).await {
        return TagBinding::Behind;
    }
    TagBinding::Unrelated
}

/// True when `commit` is `head` itself or a descendant of it.
pub async fn commit_names_or_contains(directory: &Path, commit: Option<&str>, head: &str) -> bool {
    let Some(commit) = commit else {
        return false;
    };
    let Some(sha) = resolve_commit(directory, head).await else {
        return false;
    };
    if sha == commit {
        return true;
    }
    let exists = run_git(
        directory,
        &["cat-file", "-e", &format!("{commit}^{{commit}}")],
        &Default::default(),
        GIT_TIMEOUT_MS,
    )
    .await
    .code
        == 0;
    if !exists {
        return false;
    }
    is_ancestor(directory, &sha, commit).await
}

/// The version a `head` commit releases: the newest reachable release tag
/// advanced by the non-merge commits after it, or the 1.0.0 baseline while the
/// newest release is still below it.
pub async fn derive_release_version(directory: &Path, head: &str) -> Result<ReleaseDerivation> {
    let previous = previous_release_tag(directory, head).await;
    let range = match &previous {
        Some(previous) => format!("{}..{head}", previous.tag),
        None => head.to_string(),
    };
    let commits = read_commits(directory, &range).await?;
    let level = release_level(&commits);
    Ok(ReleaseDerivation {
        version: next_release_version(previous.as_ref().map(|tag| tag.version.as_str()), level)?,
        previous,
        level,
        range,
        commits,
    })
}

/// The four-field lines a pre-push hook receives on standard input.
pub fn parse_pre_push(input: &str) -> Result<Vec<PrePushRef>> {
    let mut refs = Vec::new();
    for line in input.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() != 4 {
            bail!("unreadable pre-push line: {trimmed}");
        }
        refs.push(PrePushRef {
            local_ref: parts[0].to_string(),
            local_sha: parts[1].to_string(),
            remote_ref: parts[2].to_string(),
            remote_sha: parts[3].to_string(),
        });
    }
    Ok(refs)
}

fn is_zero(sha: &str) -> bool {
    !sha.is_empty() && sha.bytes().all(|byte| byte == b'0')
}

async fn object_exists(directory: &Path, sha: &str) -> bool {
    run_git(
        directory,
        &["cat-file", "-e", &format!("{sha}^{{commit}}")],
        &Default::default(),
        GIT_TIMEOUT_MS,
    )
    .await
    .code
        == 0
}

/// The commits a push makes reachable that no remote already has. The remote
/// sha from the pre-push line is authoritative for its destination; every
/// known remote-tracking ref is excluded too, so a commit already pushed to
/// another remote is not re-checked and no network access is needed.
pub async fn pushed_commits(directory: &Path, refs: &[PrePushRef]) -> Result<Vec<CommitRecord>> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut shas: Vec<String> = Vec::new();
    for reference in refs {
        if is_zero(&reference.local_sha) {
            continue;
        }
        let mut args: Vec<&str> = vec!["rev-list", reference.local_sha.as_str(), "--not"];
        if !is_zero(&reference.remote_sha) && object_exists(directory, &reference.remote_sha).await
        {
            args.push(reference.remote_sha.as_str());
        }
        args.push("--remotes");
        let result = run_git(directory, &args, &Default::default(), GIT_TIMEOUT_MS).await;
        if result.code != 0 {
            bail!(
                "could not list the commits of {}: {}",
                reference.local_ref,
                git_failure(&result)
            );
        }
        for sha in result.stdout.split('\n') {
            let sha = sha.trim();
            if !sha.is_empty() && seen.insert(sha.to_string()) {
                shas.push(sha.to_string());
            }
        }
    }
    read_commits_by_sha(directory, &shas).await
}

/// The violations in the refs a pre-push hook received, without reading stdin.
pub async fn check_pre_push(directory: &Path, input: &str) -> Result<Vec<CommitViolation>> {
    let refs = parse_pre_push(input)?;
    Ok(commit_violations(&pushed_commits(directory, &refs).await?))
}

/// The `gate-prepush` command: read the ref lines from standard input, check
/// only the commits the push adds, and return the process exit code.
pub async fn gate_prepush() -> Result<i32> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("reading the pre-push refs from standard input")?;
    let directory = std::env::current_dir().context("reading the working directory")?;
    let violations = check_pre_push(&directory, &input).await?;
    Ok(report_violations(&violations))
}

// ---------------------------------------------------------------------------
// Hook installation

/// The harness directory this binary belongs to: `<checkout>/.devboard` in a
/// source checkout, the installed prefix on a host.
pub fn source_harness_dir() -> PathBuf {
    crate::version::running_harness_dir()
}

/// The checked-in hook this installer copies.
pub fn hook_source(harness: &Path) -> PathBuf {
    harness.join("hooks").join("pre-push")
}

/// Installs the checked-in `pre-push` gate into this source checkout's shared
/// hooks directory, so every worktree of the checkout is gated without a
/// per-worktree step.
///
/// Idempotent: a matching hook is left alone. A differing hook is refused
/// unless `force` is set. The installer refuses any directory that is not the
/// source harness at `<checkout>/.devboard`, so an installed prefix never
/// receives this repository's gate.
pub fn hooks_install(force: bool) -> Result<HookInstallReport> {
    hooks_install_at(&source_harness_dir(), force)
}

/// [`hooks_install`] against an explicit harness directory.
pub fn hooks_install_at(harness: &Path, force: bool) -> Result<HookInstallReport> {
    let harness = normalize(harness);
    let checkout = harness
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    if harness.file_name().and_then(|name| name.to_str()) != Some(".devboard") {
        bail!(
            "hooks: refusing to install: {} is not named .devboard",
            harness.display()
        );
    }
    if manifest_name(&harness).as_deref() != Some(HARNESS_NAME) {
        bail!(
            "hooks: refusing to install: {} is not the source harness checkout; \
             an installed npm prefix never receives the commit gate",
            harness.display()
        );
    }
    if harness
        .join("node_modules")
        .join("@dsdenes")
        .join("devboard")
        .exists()
    {
        bail!(
            "hooks: refusing to install: {} holds an installed harness; \
             an installed npm prefix never receives the commit gate",
            harness.display()
        );
    }
    let Some(top_level) = git_stdout(&checkout, &["rev-parse", "--show-toplevel"]) else {
        bail!(
            "hooks: refusing to install: {} is not inside a git checkout",
            checkout.display()
        );
    };
    let top_level = normalize(Path::new(&top_level));
    let checkout = normalize(&checkout);
    if top_level != checkout {
        bail!(
            "hooks: refusing to install: {} is not <checkout>/.devboard",
            harness.display()
        );
    }

    let source = hook_source(&harness);
    if !source.is_file() {
        bail!("hooks: the hook source is missing: {}", source.display());
    }
    let contents =
        fs::read(&source).with_context(|| format!("hooks: could not read {}", source.display()))?;

    let Some(common) = git_stdout(
        &checkout,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) else {
        bail!(
            "hooks: cannot read the git directory of {}",
            checkout.display()
        );
    };
    if common.is_empty() {
        bail!(
            "hooks: cannot read the git directory of {}",
            checkout.display()
        );
    }
    let hooks_directory = PathBuf::from(common).join("hooks");
    let target = hooks_directory.join("pre-push");

    let mut existing: Option<Vec<u8>> = None;
    let mut existing_is_link = false;
    if target.exists() || target.symlink_metadata().is_ok() {
        let metadata = target
            .symlink_metadata()
            .with_context(|| format!("hooks: could not read {}", target.display()))?;
        if metadata.is_dir() {
            bail!("hooks: {} is a directory, not a hook", target.display());
        }
        existing_is_link = metadata.file_type().is_symlink();
        existing = fs::read(&target).ok();
    }

    if existing.as_deref() == Some(contents.as_slice()) && !existing_is_link {
        make_executable(&target)?;
        return Ok(HookInstallReport {
            hooks_directory,
            target,
            current: true,
        });
    }
    if existing.is_some() && !force {
        bail!(
            "hooks: {} differs from the checked-in hook; pass --force to replace it",
            target.display()
        );
    }

    fs::create_dir_all(&hooks_directory)
        .with_context(|| format!("hooks: could not create {}", hooks_directory.display()))?;
    if existing.is_some() || existing_is_link || target.symlink_metadata().is_ok() {
        let _ = fs::remove_file(&target);
    }
    fs::write(&target, &contents)
        .with_context(|| format!("hooks: could not write {}", target.display()))?;
    make_executable(&target)?;
    Ok(HookInstallReport {
        hooks_directory,
        target,
        current: false,
    })
}

fn normalize(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn manifest_name(directory: &Path) -> Option<String> {
    let bytes = fs::read(directory.join("package.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    parsed.get("name")?.as_str().map(str::to_string)
}

fn git_stdout(directory: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .with_context(|| format!("hooks: could not make {} executable", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}
