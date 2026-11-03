//! The version this dashboard runs, the version a restart would load, and the
//! newest release the update check has seen.

use std::collections::HashMap;
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
        let Ok(source) = std::fs::read_to_string(directory.join(name)) else {
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

/// The checkout that contains this binary's source code, when it has one.
pub fn running_harness_dir() -> PathBuf {
    if let Ok(value) = std::env::var("DEVBOARD_RUNNING_HARNESS_DIR") {
        return PathBuf::from(value);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The harness a host would start next.
pub fn host_harness_dir(repo_dir: &Path) -> PathBuf {
    let prefix = repo_dir.join(".devboard");
    let installed = installed_harness_dir(&prefix);
    if installed.join("devboard").exists() {
        return installed;
    }
    if is_harness_source(&prefix) || prefix.join("Cargo.toml").exists() {
        return prefix;
    }
    running_harness_dir()
}

/// The harness whose worker binaries can actually run.
pub fn runnable_harness_dir(repo_dir: &Path) -> PathBuf {
    let host = host_harness_dir(repo_dir);
    if host.join("bin").join("devboard").exists() || host.join("Cargo.toml").exists() {
        host
    } else {
        running_harness_dir()
    }
}

/// The release version an unpacked source tree represents: the newest `vX.Y.Z`
/// tag reachable from its `HEAD`.
fn source_version(directory: &Path) -> Option<String> {
    static CACHE: Mutex<Option<HashMap<PathBuf, Option<PathBuf>>>> = Mutex::new(None);
    let harness = directory.to_path_buf();
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
    let tags = git(&harness, &["tag", "--merged", "HEAD", "--list", "v*"])?;
    let versions: Vec<String> = tags
        .split('\n')
        .filter_map(|line| {
            let line = line.trim();
            let version = line.strip_prefix('v')?;
            is_release_version(version).then(|| version.to_string())
        })
        .collect();
    highest_release_version(&versions)
}

/// Whether a value is a plain `major.minor.patch` release version.
fn is_release_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
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
    let started = std::time::Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(status) => {
                if !status.success() {
                    return None;
                }
                let output = child.wait_with_output().ok()?;
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return (!text.is_empty()).then_some(text);
            }
            None if started.elapsed() > Duration::from_millis(GIT_TIMEOUT_MS) => {
                let _ = child.kill();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// The version state for one dashboard process.
pub fn server_version(
    repo_dir: &Path,
    running: Option<String>,
    latest: Option<String>,
) -> ServerVersion {
    let installed = read_harness_version(&host_harness_dir(repo_dir));
    ServerVersion {
        stale: running.is_some() && installed.is_some() && running != installed,
        running,
        installed,
        latest,
        source: is_source_harness(&running_harness_dir()),
        replacement: None,
    }
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
}
