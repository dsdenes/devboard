//! Release metadata and installation for the native harness.
//!
//! GitHub Releases carries the cargo-dist artifacts publicly. Gitea is the
//! forge where version control happens and the authority for release metadata:
//! every published tag carries one Gitea release whose `devboard-manifest.json`
//! asset names the version and every platform artifact with its SHA-256. A
//! dashboard reads that manifest, downloads the artifact for its platform,
//! verifies the digest, and installs the binary beside its manifest.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

/// The manifest asset name every Gitea release carries.
pub const MANIFEST_ASSET: &str = "devboard-manifest.json";
/// The manifest file an installed harness keeps beside its binary.
pub const INSTALLED_MANIFEST: &str = "devboard.json";
/// The release repository the updater reads.
pub const RELEASE_REPOSITORY: &str = "dsdenes/devboard";
/// The phrase a release read reports when the newest release exists but its
/// manifest asset has not been uploaded yet.
///
/// `publish` creates the Gitea release and uploads its assets in separate
/// calls, so a check that lands in that window reads a release that is still
/// being written: it carries the new tag and no manifest. The next interval
/// reads the manifest the publish writes, so `updates::is_transient_update_failure`
/// recognizes this phrase and the journal records activity rather than an
/// update error. A release that never receives its manifest is a failed
/// publish, which `publish` itself reports.
pub const RELEASE_STILL_BEING_WRITTEN: &str = "is still being written";

/// The project `DEVBOARD_RELEASE_REPO` names: the trimmed value, or `None`
/// when the variable is unset or blank.
pub fn configured_project(configured: Option<&str>) -> Option<&str> {
    configured.map(str::trim).filter(|value| !value.is_empty())
}

/// The release project a reporting or update read targets: the configured
/// project, or [`RELEASE_REPOSITORY`] when the variable is unset or blank. One
/// rule, so no two consumers resolve the same variable differently.
pub fn release_project(configured: Option<&str>) -> String {
    configured_project(configured)
        .unwrap_or(RELEASE_REPOSITORY)
        .to_string()
}

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

    /// The artifact this machine installs, or the named error when the
    /// platform is unsupported.
    pub fn asset_for_this_platform(&self) -> Result<Option<&ReleaseAsset>, String> {
        let target = current_target()?;
        // A musl host never falls back to a gnu artifact: the libc differs,
        // so this platform names exactly one target.
        Ok(self.assets.iter().find(|asset| asset.target == target))
    }
}

/// The target environment this binary was built for.
pub fn current_target_env() -> &'static str {
    if cfg!(target_env = "musl") {
        "musl"
    } else if cfg!(target_env = "gnu") {
        "gnu"
    } else {
        ""
    }
}

/// The cargo-dist target name for one platform, when the release carries one.
pub fn platform_target(os: &str, arch: &str, env: &str) -> Option<&'static str> {
    match (os, arch, env) {
        ("linux", "x86_64", "musl") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64", "musl") => Some("aarch64-unknown-linux-musl"),
        ("linux", "x86_64", "gnu") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64", "gnu") => Some("aarch64-unknown-linux-gnu"),
        ("macos", "x86_64", _) => Some("x86_64-apple-darwin"),
        ("macos", "aarch64", _) => Some("aarch64-apple-darwin"),
        _ => None,
    }
}

/// The cargo-dist target name for the running platform, or the one named
/// error an unsupported platform produces.
pub fn current_target() -> Result<&'static str, String> {
    platform_target(
        std::env::consts::OS,
        std::env::consts::ARCH,
        current_target_env(),
    )
    .ok_or_else(|| {
        format!(
            "unsupported platform: {}-{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            current_target_env()
        )
    })
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

/// Which forge a release read talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseForge {
    Gitea,
    GitHub,
}

/// One forge target for the manifest read.
#[derive(Debug, Clone)]
pub struct ManifestSource {
    /// The Gitea origin or the GitHub API base.
    pub base_url: String,
    pub repository: String,
    pub token: Option<String>,
    pub timeout_ms: u64,
    /// A local directory that carries `devboard-manifest.json` and its
    /// artifacts, for offline verification. When set, every read is a local
    /// file read.
    pub local_dir: Option<PathBuf>,
    /// The forge the read talks to.
    pub forge: ReleaseForge,
    /// The public download root a GitHub manifest is read from, e.g.
    /// `https://github.com/owner/repo`. Empty for a Gitea or local source.
    pub download_base: String,
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

/// Sends one release read with the credential it is given, when one is given.
async fn send_release_request(
    client: &reqwest::Client,
    url: &str,
    accept: &str,
    token: Option<&str>,
) -> Result<reqwest::Response, String> {
    let mut request = client.get(url).header("Accept", accept);
    if let Some(token) = token.filter(|token| !token.is_empty()) {
        request = request.header("Authorization", format!("token {token}"));
    }
    request.send().await.map_err(|error| error.to_string())
}

/// Reads one release URL, dropping a credential the forge refuses.
///
/// A long-running dashboard keeps the credential its launcher exported, and
/// the forge may since have rotated that token away. Gitea answers HTTP 401 to
/// a request that presents a token it does not accept, even for a public
/// repository, so a stale credential alone would fail every release read. The
/// read is retried without the header: a public release stays readable, and a
/// repository that really needs the credential answers 401 again for the
/// caller to report.
async fn get_release_response(
    client: &reqwest::Client,
    url: &str,
    accept: &str,
    token: Option<&str>,
) -> Result<reqwest::Response, String> {
    let token = token.filter(|token| !token.is_empty());
    let response = send_release_request(client, url, accept, token).await?;
    if token.is_none() || response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(response);
    }
    send_release_request(client, url, accept, None).await
}

/// Reads one successful release response as a JSON document.
///
/// A body the forge could not deliver is a transport failure, not a malformed
/// release: the response arrived empty, could not be read, or is not JSON, so
/// the message names the URL and `updates::is_transient_update_failure`
/// classifies it, and the next check retries it. A body that parses but is not
/// a release manifest stays a real error at the caller.
async fn release_json(response: reqwest::Response, url: &str) -> Result<Value, String> {
    let text = response
        .text()
        .await
        .map_err(|error| format!("cannot read the body of GET {url}: {error}"))?;
    if text.trim().is_empty() {
        return Err(format!("GET {url} returned an empty body"));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("GET {url} returned a body that is not JSON: {error}"))
}

/// Reads one local release directory's manifest.
///
/// `DEVBOARD_RELEASE_URL` names a directory that a publish run or a
/// verification fixture fills. A directory that carries no manifest yet is
/// that release still being written, so the failure names it with
/// `RELEASE_STILL_BEING_WRITTEN` and `updates::is_transient_update_failure`
/// retries it instead of the journal recording an update error. Every other
/// read failure, and a manifest that does not parse, stays a real error.
fn local_manifest(directory: &std::path::Path) -> Result<ReleaseInfo, String> {
    let path = directory.join(MANIFEST_ASSET);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "the local release directory {} {RELEASE_STILL_BEING_WRITTEN}: it carries no \
                 {MANIFEST_ASSET} yet",
                directory.display()
            ));
        }
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let manifest: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    ReleaseInfo::from_manifest(&manifest)
        .ok_or_else(|| format!("{} is not a release manifest", path.display()))
}

/// Reads the newest release's manifest from Gitea or GitHub, or from a local
/// release directory when `DEVBOARD_RELEASE_URL` names one.
pub async fn latest_manifest(source: &ManifestSource) -> Result<ReleaseInfo, String> {
    if let Some(directory) = &source.local_dir {
        return local_manifest(directory);
    }
    match source.forge {
        ReleaseForge::Gitea => latest_gitea_manifest(source).await,
        ReleaseForge::GitHub => latest_github_manifest(source).await,
    }
}

/// The newest Gitea release's tag and document, without reading a manifest.
async fn gitea_latest_document(source: &ManifestSource) -> Result<(String, Value), String> {
    let client = source.client();
    let url = source.api(&format!("{}/releases/latest", source.repo_path()));
    let response =
        get_release_response(&client, &url, "application/json", source.token.as_deref()).await?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "GET {} failed (HTTP {}): {}",
            url,
            status.as_u16(),
            text.lines().next().unwrap_or("no response body")
        ));
    }
    let document = release_json(response, &url).await?;
    let tag = document
        .get("tag_name")
        .and_then(Value::as_str)
        .filter(|tag| !tag.is_empty())
        .ok_or_else(|| "the release names no tag".to_string())?
        .to_string();
    Ok((tag, document))
}

/// Reads one Gitea release document's manifest asset.
async fn gitea_manifest_from_document(
    source: &ManifestSource,
    tag: &str,
    document: &Value,
) -> Result<ReleaseInfo, String> {
    let client = source.client();
    let assets = document
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| "the release carries no assets".to_string())?;
    let manifest_url = assets
        .iter()
        .find(|asset| asset.get("name").and_then(Value::as_str) == Some(MANIFEST_ASSET))
        .and_then(|asset| asset.get("browser_download_url").and_then(Value::as_str))
        .ok_or_else(|| {
            format!(
                "the release {tag} {RELEASE_STILL_BEING_WRITTEN}: it carries no {MANIFEST_ASSET} yet"
            )
        })?;
    let response = get_release_response(
        &client,
        manifest_url,
        "application/json",
        source.token.as_deref(),
    )
    .await?;
    if !response.status().is_success() {
        return Err(format!(
            "GET {manifest_url} failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    let manifest = release_json(response, manifest_url).await?;
    let mut release = ReleaseInfo::from_manifest(&manifest)
        .ok_or_else(|| "the release manifest is invalid".to_string())?;
    if release.tag.is_empty() {
        release.tag = tag.to_string();
    }
    Ok(release)
}

/// Reads the newest release's manifest from Gitea.
async fn latest_gitea_manifest(source: &ManifestSource) -> Result<ReleaseInfo, String> {
    let (tag, document) = gitea_latest_document(source).await?;
    gitea_manifest_from_document(source, &tag, &document).await
}

/// True when a release tag names the running version.
pub fn tag_names_version(tag: &str, version: &str) -> bool {
    tag.trim().trim_start_matches('v') == version.trim().trim_start_matches('v')
}

/// The newest manifest, or `None` when the forge's newest release already
/// names the running version.
///
/// The check asks the forge which release is newest before it downloads
/// anything. A Gitea `/releases/latest` naming the running version's tag is the
/// whole answer: the manifest describes a release this process already runs,
/// so downloading it every interval was pure load. A newer tag reads exactly
/// one manifest and the ordinary update rules apply.
pub async fn latest_manifest_for(
    source: &ManifestSource,
    running: Option<&str>,
) -> Result<Option<ReleaseInfo>, String> {
    if let Some(directory) = &source.local_dir {
        return local_manifest(directory).map(Some);
    }
    match source.forge {
        ReleaseForge::Gitea => {
            let (tag, document) = gitea_latest_document(source).await?;
            if running.is_some_and(|running| tag_names_version(&tag, running)) {
                return Ok(None);
            }
            Ok(Some(
                gitea_manifest_from_document(source, &tag, &document).await?,
            ))
        }
        ReleaseForge::GitHub => Ok(Some(latest_github_manifest(source).await?)),
    }
}

/// Reads the newest public release's manifest from GitHub.
///
/// A host that cannot reach Gitea installs, updates, and passes doctor from
/// the public GitHub release alone. The read is the release's own download
/// address — `releases/latest/download/devboard-manifest.json` — never the API,
/// so it needs no credential and cannot be rate-limited by an API quota.
async fn latest_github_manifest(source: &ManifestSource) -> Result<ReleaseInfo, String> {
    let client = source.client();
    let base = if source.download_base.trim().is_empty() {
        format!("https://github.com/{}", source.repository)
    } else {
        source.download_base.trim_end_matches('/').to_string()
    };
    let url = format!("{base}/releases/latest/download/{MANIFEST_ASSET}");
    let response = get_release_response(
        &client,
        &url,
        "application/octet-stream",
        source.token.as_deref(),
    )
    .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GET {url} failed (HTTP {})", status.as_u16()));
    }
    let manifest = release_json(response, &url).await?;
    ReleaseInfo::from_manifest(&manifest)
        .ok_or_else(|| "the public release manifest is invalid".to_string())
}

/// The GitHub API token a release uses.
///
/// The environment's `GH_TOKEN` or `GITHUB_TOKEN` wins; otherwise the token
/// `gh` is logged in with is asked for, because the release mirrors and reads
/// a private repository whose `git` writes already use that credential. An
/// absent `gh`, a failed read, or an empty token is no token: the caller then
/// reports the unauthenticated read.
pub async fn github_api_token(environment: &HashMap<String, String>) -> Option<String> {
    for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Some(token) = environment
            .get(key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return Some(token.to_string());
        }
    }
    token_from_command("gh", &["auth", "token"], environment).await
}

/// Runs one token command and answers its first non-empty line.
async fn token_from_command(
    program: &str,
    args: &[&str],
    environment: &HashMap<String, String>,
) -> Option<String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(environment)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let token = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(token.to_string())
}

/// Verifies one downloaded artifact against its manifest digest.
pub fn verify_sha256(bytes: &[u8], expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(bytes));
    digest.eq_ignore_ascii_case(expected.trim())
}

/// The last path segment of a download address.
fn asset_name(url: &str) -> String {
    url.split('?')
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

/// Downloads one artifact, falling back to the same version's Gitea artifact
/// when the manifest's GitHub address cannot serve it.
///
/// A local release directory serves its own files. Otherwise the GitHub asset
/// is tried first; when that read fails and `DEVBOARD_GITEA_URL` is configured,
/// the release's Gitea assets are listed and the matching artifact is read
/// with the same credentials. Both failures are reported together so a journal
/// names the transport that failed.
pub(crate) async fn download_release_asset(
    source: &ManifestSource,
    release: &ReleaseInfo,
    asset: &ReleaseAsset,
) -> Result<Vec<u8>, String> {
    if let Some(directory) = &source.local_dir {
        let name = asset_name(&asset.url);
        let path = directory.join(&name);
        let path = if path.is_file() {
            path
        } else {
            directory.join(format!("devboard-{}.tar.xz", asset.target))
        };
        return std::fs::read(&path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()));
    }
    let client = source.client();
    let github_error = match client.get(&asset.url).send().await {
        Ok(response) if response.status().is_success() => match response.bytes().await {
            Ok(bytes) if verify_sha256(&bytes, &asset.sha256) => return Ok(bytes.to_vec()),
            Ok(_) => "the downloaded artifact does not match its manifest digest".to_string(),
            Err(error) => error.to_string(),
        },
        Ok(response) => format!("HTTP {}", response.status().as_u16()),
        Err(error) => error.to_string(),
    };
    let Some(base_url) = std::env::var("DEVBOARD_GITEA_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
    else {
        return Err(format!(
            "GET {} failed ({github_error}); DEVBOARD_GITEA_URL is not set",
            asset.url
        ));
    };
    let fallback = ManifestSource {
        base_url,
        repository: source.repository.clone(),
        token: source.token.clone(),
        timeout_ms: source.timeout_ms,
        local_dir: None,
        forge: ReleaseForge::Gitea,
        download_base: String::new(),
    };
    let bytes = match gitea_asset_bytes(&fallback, release, asset).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(format!(
                "GET {} failed ({github_error}); Gitea fallback failed: {error}",
                asset.url
            ))
        }
    };
    if !verify_sha256(&bytes, &asset.sha256) {
        return Err("the Gitea artifact does not match the manifest digest".to_string());
    }
    Ok(bytes)
}

/// Reads one release artifact from Gitea by tag and asset name.
async fn gitea_asset_bytes(
    source: &ManifestSource,
    release: &ReleaseInfo,
    asset: &ReleaseAsset,
) -> Result<Vec<u8>, String> {
    let client = source.client();
    let url = source.api(&format!(
        "{}/releases/tags/{}",
        source.repo_path(),
        release.tag
    ));
    let response =
        get_release_response(&client, &url, "application/json", source.token.as_deref()).await?;
    if !response.status().is_success() {
        return Err(format!(
            "GET {url} failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    let document: Value = response.json().await.map_err(|error| error.to_string())?;
    let name = asset_name(&asset.url);
    let target_name = format!("devboard-{}.tar.xz", asset.target);
    let asset_url = document
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|entry| {
                entry
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|entry| entry == name || entry == target_name)
            })
        })
        .and_then(|entry| {
            entry
                .get("browser_download_url")
                .and_then(Value::as_str)
                .or_else(|| entry.get("url").and_then(Value::as_str))
        })
        .ok_or_else(|| format!("the Gitea release carries no {target_name}"))?;
    let response = get_release_response(
        &client,
        asset_url,
        "application/octet-stream",
        source.token.as_deref(),
    )
    .await?;
    if !response.status().is_success() {
        return Err(format!(
            "GET {asset_url} failed (HTTP {})",
            response.status().as_u16()
        ));
    }
    Ok(response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec())
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
    let target = current_target()?;
    let asset = release
        .asset_for_this_platform()?
        .ok_or_else(|| format!("the release carries no artifact for {target}"))?;
    let bytes = download_release_asset(source, release, asset).await?;
    std::fs::create_dir_all(state_dir).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(prefix.join("bin")).map_err(|error| error.to_string())?;
    let archive = state_dir.join(format!("devboard-{}.archive", release.version));
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

/// Extracts the `devboard` binary from a release archive.
///
/// cargo-dist publishes `.tar.xz`; older fixtures carry `.tar.gz`. The
/// decoder is chosen by magic bytes, so both work without a name guess.
fn unpack_binary(archive: &Path, staging: &Path) -> Result<PathBuf, String> {
    let bytes = std::fs::read(archive).map_err(|error| error.to_string())?;
    let cursor = std::io::Cursor::new(bytes);
    if cursor
        .get_ref()
        .starts_with(&[0xFD, b'7', b'z', b'X', b'Z', 0x00])
    {
        let decoder = xz2::read::XzDecoder::new(cursor);
        return unpack_tar(tar::Archive::new(decoder), staging);
    }
    let decoder = flate2::read::GzDecoder::new(cursor);
    unpack_tar(tar::Archive::new(decoder), staging)
}

/// Extracts the `devboard` binary from one decoded tar stream.
fn unpack_tar<R: std::io::Read>(
    mut tar: tar::Archive<R>,
    staging: &Path,
) -> Result<PathBuf, String> {
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
    fn a_blank_release_project_falls_back_to_the_release_repository() {
        for blank in [None, Some(""), Some(" \t\n ")] {
            assert_eq!(release_project(blank), RELEASE_REPOSITORY, "{blank:?}");
        }
        assert_eq!(release_project(Some(" owner/name ")), "owner/name");
    }

    #[test]
    fn version_comparison_is_numeric() {
        assert!(is_newer_version("1.10.0", Some("1.9.0")));
        assert!(!is_newer_version("1.9.0", Some("1.10.0")));
        assert!(is_newer_version("2.0.0", None));
        assert!(!is_newer_version("1.0.0-rc.1", Some("1.0.0")));
    }

    #[tokio::test]
    async fn a_token_command_answers_its_first_line() {
        let environment = HashMap::new();
        assert_eq!(
            token_from_command(
                "/bin/sh",
                &["-c", "printf '\\nsecret-token\\nsecond\\n'"],
                &environment
            )
            .await,
            Some("secret-token".to_string())
        );
        assert_eq!(
            token_from_command("/bin/sh", &["-c", "exit 3"], &environment).await,
            None
        );
    }

    #[tokio::test]
    async fn the_environment_token_wins_over_the_command() {
        let mut environment = HashMap::new();
        environment.insert("GH_TOKEN".to_string(), "  from-environment  ".to_string());
        assert_eq!(
            github_api_token(&environment).await,
            Some("from-environment".to_string())
        );
    }
}
