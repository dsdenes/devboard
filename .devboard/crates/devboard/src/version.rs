//! The version this dashboard runs, the version a restart would load, and the
//! newest release the update check has seen.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

/// The harness manifest name.
pub const HARNESS_NAME: &str = "@dsdenes/devboard";
/// The version a checked-in source manifest records.
const SOURCE_VERSION: &str = "0.1.0";
const GIT_TIMEOUT_MS: u64 = 5_000;

/// The version facts a client reads from `versionState`.
#[derive(Debug, Clone)]
pub struct ServerVersion {
    pub running: Option<String>,
    pub installed: Option<String>,
    pub latest: Option<String>,
    pub stale: bool,
    pub source: bool,
    pub replacement: Option<ReplacementFailure>,
}

#[derive(Debug, Clone)]
pub struct ReplacementFailure {
    pub running: Option<String>,
    pub installed: Option<String>,
    pub error: String,
}

impl ServerVersion {
    pub fn to_json(&self, feedback_enabled: bool) -> Value {
        let mut value = json!({
            "type": "versionState",
            "running": self.running,
            "installed": self.installed,
            "latest": self.latest,
            "stale": self.stale,
            "source": self.source,
            "feedbackEnabled": feedback_enabled,
        });
        if let Some(replacement) = &self.replacement {
            value["replacement"] = json!({
                "running": replacement.running,
                "installed": replacement.installed,
                "error": replacement.error,
            });
        }
        value
    }
}

/// One harness manifest.
#[derive(Debug, Clone)]
pub struct HarnessManifest {
    pub name: Option<String>,
    pub version: Option<String>,
}

/// The installed harness a host prefix holds.
pub fn installed_harness_dir(prefix: &Path) -> PathBuf {
    prefix.join("bin")
}

/// Reads a harness manifest: `devboard.json` first, then `package.json`.
pub fn read_manifest(directory: &Path) -> Option<HarnessManifest> {
    for name in ["devboard.json", "package.json"] {
        let Some(source) = crate::sampling::text(&directory.join(name)) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&source) else {
            continue;
        };
        let field = |key: &str| parsed.get(key).and_then(Value::as_str).map(str::to_string);
        return Some(HarnessManifest {
            name: field("name"),
            version: field("version").filter(|version| !version.is_empty()),
        });
    }
    None
}

/// Whether a directory is an unpacked harness source tree.
pub fn is_harness_source(directory: &Path) -> bool {
    read_manifest(directory)
        .map(|manifest| manifest.name.as_deref() == Some(HARNESS_NAME))
        .unwrap_or(false)
}

/// Whether a directory carries the source marker version.
pub fn is_source_harness(directory: &Path) -> bool {
    read_manifest(directory)
        .map(|manifest| {
            manifest.name.as_deref() == Some(HARNESS_NAME)
                && manifest.version.as_deref() == Some(SOURCE_VERSION)
        })
        .unwrap_or(false)
}

/// Whether the host serves a harness source checkout rather than an installed
/// prefix.
pub fn is_harness_source_checkout(repo_dir: &Path) -> bool {
    let prefix = repo_dir.join(".devboard");
    is_harness_source(&prefix) && !installed_harness_dir(&prefix).join("devboard").exists()
}

/// True when `harness_dir` is exactly the source harness of `repo_dir`. A
/// dashboard serving a repository through some other harness never refreshes
/// itself from that repository's source tree.
pub fn is_own_checkout_harness(repo_dir: &Path, harness_dir: &Path) -> bool {
    let expected = repo_dir.join(".devboard");
    let expected = std::fs::canonicalize(&expected).unwrap_or(expected);
    let running = std::fs::canonicalize(harness_dir).unwrap_or_else(|_| harness_dir.to_path_buf());
    expected == running && is_harness_source_checkout(repo_dir)
}

/// True when this process runs the source harness of the repository it serves.
///
/// A launcher published-worktree dashboard is excluded even when its executable
/// resolves the checkout's `.devboard`: it runs a published release, so a
/// publish's source-refresh request is not its to apply, and its update path is
/// the release manifest.
pub fn serves_own_harness(repo_dir: &Path) -> bool {
    is_own_checkout_harness(repo_dir, &running_harness_dir())
        && published_dashboard_version(repo_dir).is_none()
}

/// The environment name a launcher uses to name the published release it
/// started, and a replacement uses to carry that fact forward.
pub const LAUNCHED_RELEASE_VARIABLE: &str = "DEVBOARD_LAUNCHED_RELEASE";

/// The directory every launcher-built release worktree and installed release
/// artifact lives under.
pub fn published_root(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".devboard").join("published")
}

/// The release version a path component names: `v<major>.<minor>.<patch>`.
pub fn release_version_from_tag(name: &str) -> Option<String> {
    let version = name.strip_prefix('v')?;
    let mut parts = version.split('.');
    for _ in 0..3 {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
    }
    if parts.next().is_some() {
        return None;
    }
    Some(version.to_string())
}

/// The published release a launcher-started executable belongs to.
///
/// The launcher builds and runs `<repo>/.devboard/published/v<version>/.devboard/
/// target/release/devboard`, and the update path installs
/// `<repo>/.devboard/published/.releases/v<version>/devboard`. Both name the
/// release in the first component under `published`, so the running executable
/// proves which release a process loaded and whether it is a launcher
/// published-worktree dashboard rather than a direct source build.
pub fn published_dashboard_version_for(repo_dir: &Path, executable: &Path) -> Option<String> {
    let root = std::fs::canonicalize(published_root(repo_dir)).ok()?;
    let executable = PathBuf::from(executable.to_string_lossy().trim_end_matches(" (deleted)"));
    let executable = std::fs::canonicalize(&executable).unwrap_or(executable);
    let relative = executable.strip_prefix(&root).ok()?;
    let mut parts = relative.components();
    let first = parts.next()?.as_os_str().to_string_lossy().into_owned();
    let name = if first == ".releases" {
        parts.next()?.as_os_str().to_string_lossy().into_owned()
    } else {
        first
    };
    release_version_from_tag(&name)
}

/// [`published_dashboard_version_for`] against this process's own executable.
pub fn published_dashboard_version(repo_dir: &Path) -> Option<String> {
    published_dashboard_version_for(repo_dir, &crate::relaunch::own_program())
}

/// The published release a launcher named for this process, if any.
pub fn launched_release_from_env() -> Option<String> {
    std::env::var(LAUNCHED_RELEASE_VARIABLE)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The harness directory this process belongs to.
///
/// An installed binary resolves it from its own executable: the installed
/// layout is `<host>/.devboard/bin/devboard` with the manifest beside `bin`,
/// so the harness is the parent of the executable's directory. A source build
/// resolves from an ancestor named `.devboard` that carries the source
/// manifest. The environment override wins. The compile-time path is only the
/// last resort for a binary moved somewhere unrecognizable, never the primary
/// answer.
pub fn running_harness_dir() -> PathBuf {
    if let Ok(value) = std::env::var("DEVBOARD_RUNNING_HARNESS_DIR") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    let current = crate::relaunch::own_program();
    let current = current.canonicalize().unwrap_or(current);
    if let Some(harness) = harness_dir_from_executable(&current) {
        return harness;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The harness directory an executable path implies, if it names one.
fn harness_dir_from_executable(executable: &Path) -> Option<PathBuf> {
    // Installed layout: `<prefix>/bin/devboard`, manifest at `<prefix>`.
    if let Some(parent) = executable.parent() {
        if parent.file_name().and_then(|name| name.to_str()) == Some("bin") {
            if let Some(prefix) = parent.parent() {
                if read_manifest(prefix).is_some() || prefix.join("Cargo.toml").exists() {
                    return Some(prefix.to_path_buf());
                }
            }
        }
    }
    // Build-tree layout: any ancestor named `.devboard` that carries a
    // manifest. A built binary sits under `.devboard/target/<profile>/`.
    for ancestor in executable.ancestors() {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some(".devboard")
            && (read_manifest(ancestor).is_some() || ancestor.join("Cargo.toml").exists())
        {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

/// Whether the host carries an installed harness prefix (a binary and its
/// manifest), as opposed to a bare checkout the updater must not populate.
pub fn is_installed_host(repo_dir: &Path) -> bool {
    let prefix = repo_dir.join(".devboard");
    installed_harness_dir(&prefix).join("devboard").is_file()
        && prefix.join(release_manifest_name()).is_file()
}

fn release_manifest_name() -> &'static str {
    "devboard.json"
}

/// The harness a host would start next.
pub fn host_harness_dir(repo_dir: &Path) -> PathBuf {
    let prefix = repo_dir.join(".devboard");
    if installed_harness_dir(&prefix).join("devboard").exists() {
        // The harness is the prefix that carries the manifest and the binary;
        // `<prefix>/bin` is only where the binary lives.
        return prefix;
    }
    if is_harness_source(&prefix) || prefix.join("Cargo.toml").exists() {
        return prefix;
    }
    running_harness_dir()
}

/// The release version an unpacked source tree represents: the newest `vX.Y.Z`
/// tag reachable from its `HEAD`.
fn source_version(directory: &Path) -> Option<String> {
    static CACHE: Mutex<Option<HashMap<PathBuf, Option<PathBuf>>>> = Mutex::new(None);
    // One spelling per directory: `<repo>/../repo/.devboard` and its canonical
    // path name the same harness and must hit the same cache entry and root
    // comparison.
    let harness = std::fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
    let root = {
        let mut cache = CACHE.lock().ok()?;
        let map = cache.get_or_insert_with(HashMap::new);
        if let Some(root) = map.get(&harness) {
            root.clone()
        } else {
            let root = git(&harness, &["rev-parse", "--show-toplevel"]).map(PathBuf::from);
            map.insert(harness.clone(), root.clone());
            root
        }
    }?;
    if root.join(".devboard") != harness {
        return None;
    }
    // A pinned release commits its bump only on the tag, so a merged-only read
    // would miss the release one commit past this tip. The shared release-line
    // rule counts that tag through its parent.
    let tags = crate::release_line::release_tags(&mut |args| git(&harness, args), "HEAD");
    let versions: Vec<String> = tags.into_iter().map(|tag| tag.version).collect();
    highest_release_version(&versions)
}

/// The highest release version, by numeric component.
pub fn highest_release_version(versions: &[String]) -> Option<String> {
    let parse = |value: &str| -> Option<(u64, u64, u64)> {
        let mut parts = value.split('.');
        Some((
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        ))
    };
    let mut best: Option<((u64, u64, u64), &String)> = None;
    for version in versions {
        let Some(parsed) = parse(version) else {
            continue;
        };
        if best.map(|(current, _)| parsed > current).unwrap_or(true) {
            best = Some((parsed, version));
        }
    }
    best.map(|(_, version)| version.clone())
}

/// The version a directory's manifest represents.
pub fn read_harness_version(directory: &Path) -> Option<String> {
    let manifest = read_manifest(directory)?;
    if manifest.name.as_deref() == Some(HARNESS_NAME)
        && manifest.version.as_deref() == Some(SOURCE_VERSION)
    {
        return source_version(directory).or(manifest.version);
    }
    manifest.version
}

/// Runs one git command, bounded, and returns its trimmed stdout.
fn git(directory: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;
    // A tag listing or revision walk can exceed the pipe buffer. Draining it
    // beside the wait keeps a large answer from parking the child until the
    // timeout and turning a readable repository into no version at all.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(status) => {
                let bytes = reader.join().ok()?;
                if !status.success() {
                    return None;
                }
                // Success is the answer even with empty stdout: an ancestor
                // check prints nothing on success, and the release-line rule
                // reads that as `true`.
                return Some(String::from_utf8_lossy(&bytes).trim().to_string());
            }
            None if started.elapsed() > Duration::from_millis(GIT_TIMEOUT_MS) => {
                let _ = child.kill();
                let _ = reader.join();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// The version facts a serving process resolved once, when it started.
///
/// Resolving them reads the harness manifest and, for a source checkout, spawns
/// `git rev-parse` and the release-line tag reads behind a blocking poll loop. A
/// `versionState` read is polled every second by every open page, so it must
/// never pay that: the facts hold for the process's lifetime. Only a publish or
/// an install moves them, and either one replaces the process.
#[derive(Debug, Clone, Default)]
pub struct VersionFacts {
    /// The version a restart would load at the moment this process started.
    pub installed: Option<String>,
    /// Whether this process runs a source harness rather than an install.
    pub source: bool,
    /// The published release a launcher started, when this is a launcher
    /// published-worktree dashboard. Its `installed` value names the newest
    /// fully published release a launcher restart would load.
    pub published: Option<String>,
}

impl VersionFacts {
    /// Resolves the facts once for the repository and harness this process
    /// serves.
    pub fn resolve(repo_dir: &Path) -> Self {
        Self::resolve_for(repo_dir, &crate::relaunch::own_program())
    }

    /// Resolves the facts for one executable, so a launcher published-worktree
    /// dashboard is recognized from the release its own path names.
    pub fn resolve_for(repo_dir: &Path, executable: &Path) -> Self {
        let published = published_dashboard_version_for(repo_dir, executable);
        // The environment override names the harness a fixture or an operator
        // pinned, exactly as `running_harness_dir` reads it.
        let harness = match std::env::var("DEVBOARD_RUNNING_HARNESS_DIR") {
            Ok(value) if !value.is_empty() => PathBuf::from(value),
            _ => harness_dir_from_executable(executable).unwrap_or_else(running_harness_dir),
        };
        Self {
            installed: published
                .clone()
                .or_else(|| read_harness_version(&host_harness_dir(repo_dir))),
            source: is_source_harness(&harness),
            published,
        }
    }
}

/// One launcher replacement that finished before this process started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUpgrade {
    pub from: String,
    pub to: String,
}

/// Consumes the upgrade record a launcher wrote for the release it started.
///
/// The record is journaled once by the new process, so the automatic swap a
/// launch performs is visible in the dashboard's own journal. A record naming
/// another version belongs to a process that never started, so it stays for it.
pub fn take_pending_upgrade(state_dir: &Path, running: Option<&str>) -> Option<PendingUpgrade> {
    let path = state_dir.join("desktop").join("upgrade.json");
    let source = std::fs::read_to_string(&path).ok()?;
    let value: Value = serde_json::from_str(&source).ok()?;
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let from = field("from")?;
    let to = field("to")?;
    if running != Some(to.as_str()) {
        return None;
    }
    let _ = std::fs::remove_file(&path);
    Some(PendingUpgrade { from, to })
}

/// The version state for one dashboard process, from the facts it holds.
pub fn server_version_from(
    facts: &VersionFacts,
    running: Option<String>,
    latest: Option<String>,
) -> ServerVersion {
    ServerVersion {
        stale: running.is_some() && facts.installed.is_some() && running != facts.installed,
        running,
        installed: facts.installed.clone(),
        latest,
        source: facts.source,
        replacement: None,
    }
}

/// The version state resolved now, for a reader that has no serving process to
/// ask, like the MCP status call.
pub fn server_version(
    repo_dir: &Path,
    running: Option<String>,
    latest: Option<String>,
) -> ServerVersion {
    server_version_from(&VersionFacts::resolve(repo_dir), running, latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_highest_release_version_wins_numerically() {
        let versions = vec![
            "1.9.0".to_string(),
            "1.10.0".to_string(),
            "1.2.3".to_string(),
        ];
        assert_eq!(highest_release_version(&versions), Some("1.10.0".into()));
        assert_eq!(highest_release_version(&[]), None);
    }

    fn git_fixture(label: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("version-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("repo/.devboard")).expect("a harness");
        run_git(&root.join("repo"), &["init", "-q"]);
        run_git(&root.join("repo"), &["config", "user.name", "Test"]);
        run_git(
            &root.join("repo"),
            &["config", "user.email", "test@example.invalid"],
        );
        root
    }

    fn run_git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn a_release_tag_one_commit_past_the_tip_still_names_the_source_version() {
        let root = git_fixture("one-past");
        let repo = root.join("repo");
        std::fs::write(repo.join("base.txt"), "base\n").expect("a file");
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-q", "-m", "base"]);
        let base = run_git(&repo, &["rev-parse", "HEAD"]);
        std::fs::write(repo.join("version.txt"), "1.2.3\n").expect("a release file");
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-q", "-m", "chore(release): v1.2.3"]);
        run_git(&repo, &["tag", "v1.2.3"]);
        // The release commit sits one past the tip, exactly as a pinned
        // release leaves it: `main` never advances to the tag.
        run_git(&repo, &["reset", "--hard", &base]);
        assert_eq!(
            source_version(&repo.join(".devboard")),
            Some("1.2.3".to_string())
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
