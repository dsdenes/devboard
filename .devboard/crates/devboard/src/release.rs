//! Release metadata and installation for the native harness.
//!
//! GitHub Releases carries the cargo-dist artifacts publicly. Gitea is the
//! forge where version control happens and the authority for release metadata:
//! every published tag carries one Gitea release whose `devboard-manifest.json`
//! asset names the version and every platform artifact with its SHA-256. A
//! dashboard reads that manifest, downloads the artifact for its platform,
//! verifies the digest, and installs the binary beside its manifest.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The manifest asset name every Gitea release carries.
pub const MANIFEST_ASSET: &str = "devboard-manifest.json";
/// The manifest file an installed harness keeps beside its binary.
pub const INSTALLED_MANIFEST: &str = "devboard.json";
/// The release repository the updater reads.
pub const RELEASE_REPOSITORY: &str = "dsdenes/devboard";

/// One platform artifact named by the manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub target: String,
    pub url: String,
    pub sha256: String,
}

/// One release as the Gitea manifest describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseInfo {
    pub version: String,
    pub tag: String,
    pub assets: Vec<ReleaseAsset>,
}

impl ReleaseInfo {
    pub fn from_manifest(value: &Value) -> Option<Self> {
        let version = value.get("version").and_then(Value::as_str)?;
        let tag = value.get("tag").and_then(Value::as_str)?;
        let assets = value.get("assets").and_then(Value::as_array)?;
        let mut parsed = Vec::new();
        for asset in assets {
            let target = asset.get("target").and_then(Value::as_str)?;
            let url = asset.get("url").and_then(Value::as_str)?;
            let sha256 = asset.get("sha256").and_then(Value::as_str)?;
            parsed.push(ReleaseAsset {
                target: target.to_string(),
                url: url.to_string(),
                sha256: sha256.to_string(),
            });
        }
        Some(Self {
            version: version.to_string(),
            tag: tag.to_string(),
            assets: parsed,
        })
    }

    pub fn to_manifest(&self) -> Value {
        json!({
            "version": self.version,
            "tag": self.tag,
            "assets": self.assets.iter().map(|asset| json!({
                "target": asset.target,
                "url": asset.url,
                "sha256": asset.sha256,
            })).collect::<Vec<_>>(),
        })
    }

    /// The artifact this machine installs.
    pub fn asset_for_this_platform(&self) -> Option<&ReleaseAsset> {
        let target = current_target();
        // A musl host still runs a gnu artifact only when the libc matches;
        // this platform names exactly one target, so there is no fallback.
        self.assets.iter().find(|asset| asset.target == target)
    }
}

/// The cargo-dist target name for the running platform.
pub fn current_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        _ => "unsupported",
    }
}

/// Whether `candidate` is a newer release than `installed`, by numeric parts.
pub fn is_newer_version(candidate: &str, installed: Option<&str>) -> bool {
    let Some(installed) = installed else {
        return true;
    };
    parse_version(candidate) > parse_version(installed)
}

fn parse_version(value: &str) -> (u64, u64, u64, bool) {
    let trimmed = value.trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let patch_part = parts.next().unwrap_or("0");
    let numeric: String = patch_part
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    let patch = numeric.parse().unwrap_or(0);
    // A prerelease suffix sorts before its release.
    let stable = patch_part.len() == numeric.len();
    (major, minor, patch, stable)
}

/// One Gitea target for the manifest read.
#[derive(Debug, Clone)]
pub struct ManifestSource {
    pub base_url: String,
    pub repository: String,
    pub token: Option<String>,
    pub timeout_ms: u64,
}

impl ManifestSource {
    fn api(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        format!("{base}/api/v1{path}")
    }

    fn repo_path(&self) -> String {
        let encoded: Vec<String> = self
            .repository
            .split('/')
            .map(|segment| {
                let mut out = String::new();
                for byte in segment.bytes() {
                    if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                        out.push(byte as char);
                    } else {
                        out.push_str(&format!("%{byte:02X}"));
                    }
                }
                out
            })
            .collect();
        format!("/repos/{}", encoded.join("/"))
    }

    fn client(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(self.timeout_ms.max(1)))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }
}

/// Reads the newest release's manifest from Gitea.
pub async fn latest_manifest(source: &ManifestSource) -> Result<ReleaseInfo, String> {
    let client = source.client();
    let url = source.api(&format!("{}/releases/latest", source.repo_path()));
    let mut request = client.get(&url).header("Accept", "application/json");
    if let Some(token) = source.token.as_deref().filter(|token| !token.is_empty()) {
        request = request.header("Authorization", format!("token {token}"));
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "GET {} failed (HTTP {}): {}",
            url,
            status.as_u16(),
            text.lines().next().unwrap_or("no response body")
        ));
    }
    let document: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let tag = document
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or_else(|| "the release names no tag".to_string())?;
    let assets = document
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| "the release carries no assets".to_string())?;
    let manifest_url = assets
        .iter()
        .find(|asset| asset.get("name").and_then(Value::as_str) == Some(MANIFEST_ASSET))
        .and_then(|asset| asset.get("browser_download_url").and_then(Value::as_str))
        .ok_or_else(|| format!("the release carries no {MANIFEST_ASSET}"))?;
    let mut request = client
        .get(manifest_url)
        .header("Accept", "application/json");
    if let Some(token) = source.token.as_deref().filter(|token| !token.is_empty()) {
        request = request.header("Authorization", format!("token {token}"));
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "GET {manifest_url} failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    let manifest: Value = response.json().await.map_err(|error| error.to_string())?;
    let mut release = ReleaseInfo::from_manifest(&manifest)
        .ok_or_else(|| "the release manifest is invalid".to_string())?;
    if release.tag.is_empty() {
        release.tag = tag.to_string();
    }
    Ok(release)
}

/// Verifies one downloaded artifact against its manifest digest.
pub fn verify_sha256(bytes: &[u8], expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(bytes));
    digest.eq_ignore_ascii_case(expected.trim())
}

/// Installs one release into a prefix, returning the installed version.
///
/// The archive is verified before anything is unpacked, the binary is staged
/// beside its destination, and one rename publishes it, so a failed download,
/// checksum, or extraction leaves the running harness untouched.
pub async fn install_release(
    source: &ManifestSource,
    release: &ReleaseInfo,
    prefix: &Path,
    state_dir: &Path,
) -> Result<String, String> {
    let asset = release
        .asset_for_this_platform()
        .ok_or_else(|| format!("the release carries no artifact for {}", current_target()))?;
    let client = source.client();
    let response = client
        .get(&asset.url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "GET {} failed (HTTP {})",
            asset.url,
            response.status().as_u16()
        ));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if !verify_sha256(&bytes, &asset.sha256) {
        return Err("the downloaded artifact does not match its manifest digest".to_string());
    }
    std::fs::create_dir_all(state_dir).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(prefix.join("bin")).map_err(|error| error.to_string())?;
    let archive = state_dir.join(format!("devboard-{}.tar.gz", release.version));
    std::fs::write(&archive, &bytes).map_err(|error| error.to_string())?;
    let unpacked = unpack_binary(&archive, state_dir)?;
    let destination = prefix.join("bin").join("devboard");
    let staged = destination.with_extension(format!("{}.new", std::process::id()));
    std::fs::copy(&unpacked, &staged).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&unpacked)
            .map(|metadata| metadata.permissions().mode())
            .unwrap_or(0o755);
        let _ = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(mode));
    }
    std::fs::rename(&staged, &destination).map_err(|error| error.to_string())?;
    write_installed_manifest(prefix, &release.version)?;
    let _ = std::fs::remove_file(&archive);
    Ok(release.version.clone())
}

/// Extracts the `devboard` binary from a `.tar.gz` release archive.
fn unpack_binary(archive: &Path, staging: &Path) -> Result<PathBuf, String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    let target = staging.join(format!("unpack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&target);
    let entries = tar.entries().map_err(|error| error.to_string())?;
    for entry in entries {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        if path.file_name().and_then(|name| name.to_str()) != Some("devboard") {
            continue;
        }
        std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        let destination = target.join("devboard");
        entry
            .unpack(&destination)
            .map_err(|error| error.to_string())?;
        return Ok(destination);
    }
    Err("the release archive carries no devboard binary".to_string())
}

/// Writes the manifest an installed harness keeps beside its binary.
pub fn write_installed_manifest(prefix: &Path, version: &str) -> Result<(), String> {
    let path = prefix.join(INSTALLED_MANIFEST);
    let text = format!(
        "{}\n",
        crate::jsjson::stringify(&json!({
            "name": "@dsdenes/devboard",
            "version": version,
        }))
    );
    crate::state::write_file_atomically_sync(&path, &text).map_err(|error| error.to_string())
}

/// The version an installed prefix records, if any.
pub fn installed_version(prefix: &Path) -> Option<String> {
    let source = std::fs::read_to_string(prefix.join(INSTALLED_MANIFEST)).ok()?;
    let parsed: Value = serde_json::from_str(&source).ok()?;
    parsed
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manifest_round_trips() {
        let release = ReleaseInfo {
            version: "1.2.3".to_string(),
            tag: "v1.2.3".to_string(),
            assets: vec![ReleaseAsset {
                target: "x86_64-unknown-linux-gnu".to_string(),
                url: "https://example.test/a.tar.gz".to_string(),
                sha256: "abc".to_string(),
            }],
        };
        assert_eq!(
            ReleaseInfo::from_manifest(&release.to_manifest()),
            Some(release)
        );
    }

    #[test]
    fn version_comparison_is_numeric() {
        assert!(is_newer_version("1.10.0", Some("1.9.0")));
        assert!(!is_newer_version("1.9.0", Some("1.10.0")));
        assert!(is_newer_version("2.0.0", None));
        assert!(!is_newer_version("1.0.0-rc.1", Some("1.0.0")));
    }
}
