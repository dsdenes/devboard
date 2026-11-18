//! Release source resolution and transient update failures.

use std::collections::HashMap;
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn gitea_url_alone_resolves_a_release_source() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let restore: Vec<(String, Option<String>)> =
        ["DEVBOARD_GITEA_URL", "GITEA_URL", "DEVBOARD_RELEASE_URL"]
            .iter()
            .map(|key| (key.to_string(), std::env::var(key).ok()))
            .collect();
    for key in ["DEVBOARD_GITEA_URL", "DEVBOARD_RELEASE_URL"] {
        std::env::remove_var(key);
    }
    std::env::set_var("GITEA_URL", "http://localhost:3001");
    let source = devboard::updates::manifest_source_from_env(std::path::Path::new("."))
        .expect("GITEA_URL alone resolves a source");
    assert_eq!(source.base_url, "http://localhost:3001");
    for (key, value) in restore {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}

#[test]
fn only_a_transport_failure_is_transient() {
    assert!(devboard::updates::is_transient_update_failure(
        "error sending request for url (http://localhost:3001/api/v1/repos/dsdenes/devboard/releases/latest)"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/x/releases/latest failed (HTTP 429): slow down"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/x/releases/latest returned an empty body"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET https://github.com/x/y/releases/latest/download/devboard-manifest.json returned a body that is not JSON: EOF while parsing a value at line 1 column 0"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "cannot read the body of GET http://localhost:3001/api/v1/repos/x/releases/latest: error decoding response body"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "the release manifest is invalid"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "the Gitea manifest checksum does not match the manifest"
    ));
}

/// The line a dashboard journaled when `publish` had written the manifest
/// before the GitHub release served its archive. It names the release still
/// being written, so the next interval retries the install and the watchdog
/// files no issue. An artifact that downloaded but does not match its digest
/// stays a real error.
#[test]
fn an_artifact_that_is_not_downloadable_yet_is_transient() {
    assert!(devboard::updates::is_transient_update_failure(
        "GET https://github.com/dsdenes/devboard/releases/download/v1.57.13/devboard-x86_64-unknown-linux-gnu.tar.xz failed (HTTP 404); the release v1.57.13 is still being written: its artifact is not downloadable yet; Gitea fallback failed: the Gitea release carries no devboard-x86_64-unknown-linux-gnu.tar.xz"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "the downloaded artifact does not match its manifest digest"
    ));
}

/// The line a dashboard journaled when the connection cut a GitHub archive off
/// mid-transfer: the artifact installed on the following check two minutes
/// later, so the read is retried and the watchdog files no issue. The Gitea
/// release carries the manifest and checksums rather than the platform
/// archives, so its half of the same line names no permanent defect either.
#[test]
fn an_artifact_cut_off_mid_transfer_is_transient() {
    assert!(devboard::updates::is_transient_update_failure(
        "GET https://github.com/dsdenes/devboard/releases/download/v1.57.16/devboard-x86_64-unknown-linux-gnu.tar.xz failed (error decoding response body); Gitea fallback failed: the Gitea release carries no devboard-x86_64-unknown-linux-gnu.tar.xz"
    ));
}

/// A forge that answers 5xx is serving no release right now, not refusing the
/// request: the same line the live dashboard journaled for a restarting Gitea.
#[test]
fn a_server_error_status_is_a_transient_check_failure() {
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/dsdenes/devboard/releases/latest failed (HTTP 500): {\"message\":\"\",\"url\":\"http://localhost:3001/api/swagger\"}"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/dsdenes/devboard/releases/download/v1.44.13/devboard-manifest.json failed (HTTP 502)"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET https://github.com/dsdenes/devboard/releases/latest/download/devboard-manifest.json failed (HTTP 503)"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/dsdenes/devboard/releases/latest failed (HTTP 404): not found"
    ));
}

// ---------------------------------------------------------------------------
// The manifest check reads the tag first

type RecordedRequests = std::sync::Arc<Mutex<Vec<(String, HashMap<String, String>)>>>;

#[derive(Clone)]
struct StubState {
    requests: RecordedRequests,
    release: String,
    manifest_url: String,
    /// False for a release whose assets `publish` has not uploaded yet.
    manifest_uploaded: bool,
}

async fn stub_entry(
    axum::extract::State(state): axum::extract::State<StubState>,
    request: axum::extract::Request,
) -> axum::response::Response {
    let path = request.uri().path().to_string();
    let headers = request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_ascii_lowercase(),
                value.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    state
        .requests
        .lock()
        .expect("requests")
        .push((path.clone(), headers));
    let (status, body) = if path.ends_with("/releases/latest") {
        let assets = if state.manifest_uploaded {
            serde_json::json!([{
                "name": "devboard-manifest.json",
                "browser_download_url": state.manifest_url,
            }])
        } else {
            serde_json::json!([])
        };
        (
            200,
            serde_json::json!({
                "tag_name": state.release,
                "assets": assets,
            })
            .to_string(),
        )
    } else if path.ends_with("/devboard-manifest.json") {
        (
            200,
            serde_json::json!({
                "version": state.release.trim_start_matches('v'),
                "tag": state.release,
                "assets": [],
            })
            .to_string(),
        )
    } else {
        (500, "unexpected".to_string())
    };
    axum::response::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .expect("a stub response")
}

struct StubServer {
    base: String,
    requests: RecordedRequests,
    handle: tokio::task::JoinHandle<()>,
}

impl StubServer {
    async fn start(release: &str) -> Self {
        Self::start_with_upload(release, true).await
    }

    /// A release that exists before its assets do: the window `publish` opens
    /// between creating the Gitea release and uploading its manifest.
    async fn start_before_assets(release: &str) -> Self {
        Self::start_with_upload(release, false).await
    }

    async fn start_with_upload(release: &str, manifest_uploaded: bool) -> Self {
        let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("a stub listener");
        let port = listener.local_addr().expect("an address").port();
        let base = format!("http://127.0.0.1:{port}");
        let state = StubState {
            requests: std::sync::Arc::clone(&requests),
            release: release.to_string(),
            manifest_url: format!(
                "{base}/dsdenes/devboard/releases/download/{release}/devboard-manifest.json"
            ),
            manifest_uploaded,
        };
        let app = axum::Router::new().fallback(stub_entry).with_state(state);
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base,
            requests,
            handle,
        }
    }

    fn source(&self) -> devboard::release::ManifestSource {
        devboard::release::ManifestSource {
            base_url: self.base.clone(),
            repository: "dsdenes/devboard".to_string(),
            token: None,
            timeout_ms: 5_000,
            local_dir: None,
            forge: devboard::release::ReleaseForge::Gitea,
            download_base: String::new(),
            gitea_fallback: None,
        }
    }
}

impl Drop for StubServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[tokio::test]
async fn the_same_running_tag_downloads_no_manifest_and_sends_no_credential() {
    let server = StubServer::start("v1.2.3").await;
    let release = devboard::release::latest_manifest_for(&server.source(), Some("1.2.3"))
        .await
        .expect("the check answers");
    assert!(release.is_none(), "the running release downloads nothing");
    let requests = server.requests.lock().expect("requests").clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].0.ends_with("/releases/latest"));
    assert!(!requests[0].1.contains_key("authorization"));
}

#[tokio::test]
async fn a_newer_tag_downloads_exactly_one_manifest() {
    let server = StubServer::start("v1.2.4").await;
    let release = devboard::release::latest_manifest_for(&server.source(), Some("1.2.3"))
        .await
        .expect("the check answers")
        .expect("a newer release");
    assert_eq!(release.version, "1.2.4");
    assert_eq!(release.tag, "v1.2.4");
    let requests = server.requests.lock().expect("requests").clone();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].0.ends_with("/releases/latest"));
    assert!(requests[1].0.ends_with("/devboard-manifest.json"));
    for (_, headers) in &requests {
        assert!(!headers.contains_key("authorization"));
    }
}

/// `publish` creates the Gitea release first and uploads its assets second, so
/// one check that lands between those two calls reads a release that exists
/// without a manifest. That release is still being written: the next interval
/// reads the manifest, so the failure is transient and the journal records
/// activity rather than an update error.
#[tokio::test]
async fn a_release_that_precedes_its_assets_is_a_transient_failure() {
    let server = StubServer::start_before_assets("v1.2.4").await;
    let error = devboard::release::latest_manifest_for(&server.source(), Some("1.2.3"))
        .await
        .expect_err("the manifest is not uploaded yet");
    assert!(
        error.contains("v1.2.4"),
        "the failure names the release: {error}"
    );
    assert!(
        devboard::updates::is_transient_update_failure(&error),
        "the next interval retries an unwritten manifest: {error}"
    );
    let requests = server.requests.lock().expect("requests").clone();
    assert_eq!(requests.len(), 1, "no manifest is downloaded: {requests:?}");
}

/// The release workflow publishes the GitHub release before `publish` uploads
/// the manifest asset into it. A host that updates from the public GitHub
/// release reads the latest release's download address, which answers 404
/// during that window. The newest release is still being written, so the next
/// interval retries it and the journal records activity instead of the
/// update error the watchdog files an issue for.
#[tokio::test]
async fn a_github_manifest_that_is_not_uploaded_yet_is_a_transient_failure() {
    async fn missing_entry() -> axum::response::Response {
        axum::response::Response::builder()
            .status(404)
            .body(axum::body::Body::empty())
            .expect("a stub response")
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let port = listener.local_addr().expect("an address").port();
    let base = format!("http://127.0.0.1:{port}");
    let handle = tokio::spawn(async move {
        let app = axum::Router::new().fallback(missing_entry);
        let _ = axum::serve(listener, app).await;
    });
    let source = devboard::release::ManifestSource {
        base_url: String::new(),
        repository: "dsdenes/devboard".to_string(),
        token: None,
        timeout_ms: 5_000,
        local_dir: None,
        forge: devboard::release::ReleaseForge::GitHub,
        download_base: base,
        gitea_fallback: None,
    };
    let error = devboard::release::latest_manifest_for(&source, Some("1.2.4"))
        .await
        .expect_err("the latest release carries no manifest yet");
    handle.abort();
    assert!(
        error.contains("/releases/latest/download/devboard-manifest.json"),
        "the failure names the download address: {error}"
    );
    assert!(
        error.contains("HTTP 404"),
        "the failure names the status: {error}"
    );
    assert!(
        devboard::updates::is_transient_update_failure(&error),
        "the next interval retries an unwritten manifest: {error}"
    );
}

fn local_source(directory: &std::path::Path) -> devboard::release::ManifestSource {
    devboard::release::ManifestSource {
        base_url: String::new(),
        repository: "dsdenes/devboard".to_string(),
        token: None,
        timeout_ms: 5_000,
        local_dir: Some(directory.to_path_buf()),
        forge: devboard::release::ReleaseForge::Gitea,
        download_base: String::new(),
        gitea_fallback: None,
    }
}

fn local_scratch(label: &str) -> std::path::PathBuf {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("updates-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a local release directory");
    root
}

/// A local release directory is filled by a publish run or a verification
/// fixture, so a directory that carries no manifest yet is the release it will
/// hold still being written: the check records activity and retries instead of
/// raising the update error the watchdog files an issue for. A manifest that
/// exists and does not parse stays a real error.
#[tokio::test]
async fn a_local_release_directory_without_a_manifest_is_a_transient_failure() {
    let directory = local_scratch("no-manifest");
    let source = local_source(&directory);
    let error = devboard::release::latest_manifest_for(&source, Some("1.2.3"))
        .await
        .expect_err("an empty release directory carries no manifest");
    assert!(
        error.contains(&directory.display().to_string()),
        "the failure names the directory: {error}"
    );
    assert!(
        devboard::updates::is_transient_update_failure(&error),
        "the next interval retries an unwritten manifest: {error}"
    );

    std::fs::write(directory.join("devboard-manifest.json"), "{not json")
        .expect("a malformed manifest");
    let error = devboard::release::latest_manifest_for(&source, Some("1.2.3"))
        .await
        .expect_err("a malformed manifest is no release");
    assert!(
        !devboard::updates::is_transient_update_failure(&error),
        "a manifest that does not parse stays a real error: {error}"
    );
    let _ = std::fs::remove_dir_all(&directory);
}

/// A Gitea manifest source never carries the operator's credential.
#[test]
fn the_gitea_update_source_is_anonymous() {
    let environment = HashMap::from([
        (
            "DEVBOARD_GITEA_URL".to_string(),
            "http://localhost:3001".to_string(),
        ),
        ("GITEA_TOKEN".to_string(), "secret".to_string()),
    ]);
    let source = devboard::updates::manifest_source(&environment).expect("a source");
    assert_eq!(source.forge, devboard::release::ReleaseForge::Gitea);
    assert_eq!(source.token, None);
}

// ---------------------------------------------------------------------------
// A launcher published-worktree dashboard upgrades itself

/// Serializes the process environment a dashboard constructor reads.
static RUNTIME_ENV_LOCK: Mutex<()> = Mutex::new(());

fn dashboard_scratch(label: &str) -> std::path::PathBuf {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("updates-dashboard-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join(".devboard")).expect("a harness");
    std::fs::create_dir_all(repo.join(".devboard/.tmp/journal")).expect("a state directory");
    std::fs::write(repo.join("GOAL.md"), "# Goal\n").expect("a goal document");
    std::fs::write(
        repo.join(".devboard/package.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"0.1.0\"}\n",
    )
    .expect("a source manifest");
    root
}

fn dashboard_config(root: &std::path::Path) -> devboard::config::Config {
    let repo = root.join("repo");
    devboard::config::Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: "omp acp".to_string(),
        state_dir: repo.join(".devboard/.tmp"),
        allowed_hosts: Vec::new(),
        feedback: None,
    }
}

fn dashboard_app(
    root: &std::path::Path,
    running: &str,
    launched: Option<&str>,
) -> std::sync::Arc<devboard::app::App> {
    let config = dashboard_config(root);
    let guard = RUNTIME_ENV_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    std::env::set_var("DEVBOARD_RUNNING_VERSION", running);
    let app = devboard::app::App::with_launched_release(
        config.clone(),
        devboard::journal::Journal::open(&config.state_dir, &config.repo_dir, 0),
        launched.map(str::to_string),
    );
    std::env::remove_var("DEVBOARD_RUNNING_VERSION");
    drop(guard);
    app
}

/// One local release directory whose archive carries an executable script.
fn release_scratch(root: &std::path::Path, version: &str) -> std::path::PathBuf {
    let directory = root.join(format!("release-{version}"));
    std::fs::create_dir_all(&directory).expect("a release directory");
    let target = devboard::release::current_target().expect("a supported platform");
    let asset = format!("devboard-{target}.tar.gz");
    let bytes = b"#!/bin/sh\nexit 0\n";
    let file = std::fs::File::create(directory.join(&asset)).expect("an archive");
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o755);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_cksum();
    builder
        .append_data(&mut header, "devboard", &bytes[..])
        .expect("an archive entry");
    builder
        .into_inner()
        .expect("an archive stream")
        .finish()
        .expect("a finished archive");
    let manifest = serde_json::json!({
        "version": version,
        "tag": format!("v{version}"),
        "assets": [{
            "target": target,
            "url": asset,
            "sha256": "",
        }],
    });
    let text = format!(
        "{}\n",
        serde_json::to_string(&manifest).expect("a manifest")
    );
    std::fs::write(directory.join("devboard-manifest.json"), text).expect("a manifest file");
    directory
}

#[test]
fn the_version_facts_name_the_newest_published_release() {
    let root = dashboard_scratch("facts");
    let repo = root.join("repo");
    let artifact = repo.join(".devboard/published/.releases/v1.3.0/devboard");
    std::fs::create_dir_all(artifact.parent().expect("a release directory")).expect("a directory");
    std::fs::write(&artifact, b"binary").expect("an artifact");
    let worktree = repo.join(".devboard/published/v1.2.3/.devboard/target/release/devboard");
    std::fs::create_dir_all(worktree.parent().expect("a worktree directory")).expect("a directory");
    std::fs::write(&worktree, b"binary").expect("a worktree binary");
    let canonical = repo.join(".devboard/target/release/devboard");
    std::fs::create_dir_all(canonical.parent().expect("a build directory")).expect("a directory");
    std::fs::write(&canonical, b"binary").expect("a build binary");

    assert_eq!(
        devboard::version::published_dashboard_version_for(&repo, &worktree).as_deref(),
        Some("1.2.3"),
        "a launcher worktree names its tag"
    );
    assert_eq!(
        devboard::version::published_dashboard_version_for(&repo, &canonical),
        None,
        "a direct source build is not a launcher published worktree"
    );

    let facts = devboard::version::VersionFacts::resolve_for(&repo, &artifact);
    assert_eq!(facts.published.as_deref(), Some("1.3.0"));
    let older = devboard::version::server_version_from(
        &facts,
        Some("1.2.3".to_string()),
        Some("1.3.0".to_string()),
    );
    assert_eq!(older.installed.as_deref(), Some("1.3.0"));
    assert_eq!(older.latest.as_deref(), Some("1.3.0"));
    assert!(older.stale, "an older running version is stale");
    let current = devboard::version::server_version_from(
        &facts,
        Some("1.3.0".to_string()),
        Some("1.3.0".to_string()),
    );
    assert!(!current.stale, "the newest release is not stale");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_published_dashboard_installs_and_replaces_without_a_bin_prefix() {
    let root = dashboard_scratch("upgrade");
    let repo = root.join("repo");
    let app = dashboard_app(&root, "1.2.3", Some("1.2.3"));
    let replacements = std::sync::Arc::new(Mutex::new(Vec::new()));
    let seen = std::sync::Arc::clone(&replacements);
    app.set_replacement_hook(std::sync::Arc::new(move |program, version| {
        seen.lock().expect("replacements").push((
            program.map(std::path::Path::to_path_buf),
            version.to_string(),
        ));
        Ok(())
    }));
    let directory = release_scratch(&root, "1.3.0");
    let source = local_source(&directory);
    let outcome = devboard::updates::check_with_source(&app, &source).await;
    assert_eq!(outcome, devboard::updates::UpdateOutcome::Installed);
    let installed = devboard::release::published_release_binary(&repo, "1.3.0");
    assert!(installed.is_file(), "the release artifact is installed");
    assert_eq!(
        replacements.lock().expect("replacements").as_slice(),
        &[(Some(installed.clone()), "1.3.0".to_string())],
        "the replacement starts the installed release artifact"
    );
    assert!(
        !repo.join(".devboard/bin/devboard").exists(),
        "the checkout's installed prefix is never populated"
    );
    let state = app.version_state();
    assert_eq!(state["running"], "1.2.3");
    assert_eq!(state["installed"], "1.3.0");
    assert_eq!(state["latest"], "1.3.0");
    assert_eq!(state["stale"], true);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_canonical_source_checkout_never_installs_or_replaces_on_a_check() {
    let root = dashboard_scratch("canonical");
    let repo = root.join("repo");
    let app = dashboard_app(&root, "1.2.3", None);
    let replacements = std::sync::Arc::new(Mutex::new(Vec::new()));
    let seen = std::sync::Arc::clone(&replacements);
    app.set_replacement_hook(std::sync::Arc::new(move |program, version| {
        seen.lock().expect("replacements").push((
            program.map(std::path::Path::to_path_buf),
            version.to_string(),
        ));
        Ok(())
    }));
    let directory = release_scratch(&root, "1.3.0");
    let source = local_source(&directory);
    let outcome = devboard::updates::check_with_source(&app, &source).await;
    assert_eq!(outcome, devboard::updates::UpdateOutcome::Current);
    assert!(
        replacements.lock().expect("replacements").is_empty(),
        "a canonical source checkout never replaces itself on a check"
    );
    assert!(!devboard::release::published_release_binary(&repo, "1.3.0").exists());
    assert!(!repo.join(".devboard/bin").exists());
    let state = app.version_state();
    assert_eq!(state["latest"], "1.3.0");
    let _ = std::fs::remove_dir_all(&root);
}

/// A release whose manifest is readable before the GitHub release serves its
/// archive: `publish` uploads the manifest while the release is still settling
/// into its published form. The next interval reads the artifact the settled
/// release serves, so the install is journaled as activity and retried instead
/// of raising the update error the watchdog files an issue for.
#[tokio::test]
async fn an_install_that_precedes_its_artifact_is_a_transient_failure() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let root = dashboard_scratch("pending-artifact");
    let repo = root.join("repo");
    let app = dashboard_app(&root, "1.2.3", Some("1.2.3"));
    let target = devboard::release::current_target().expect("a supported platform");
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let port = listener.local_addr().expect("an address").port();
    let base = format!("http://127.0.0.1:{port}");
    let manifest = serde_json::json!({
        "version": "1.3.0",
        "tag": "v1.3.0",
        "assets": [{
            "target": target,
            "url": format!("{base}/assets/devboard-{target}.tar.xz"),
            "sha256": "0".repeat(64),
        }],
    })
    .to_string();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
            let (status, body) = if request.contains("/devboard-manifest.json") {
                ("200 OK", manifest.clone())
            } else {
                ("404 Not Found", String::new())
            };
            let head = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(body.as_bytes()).await;
        }
    });
    let source = devboard::release::ManifestSource {
        base_url: base.clone(),
        repository: "dsdenes/devboard".to_string(),
        token: None,
        timeout_ms: 5_000,
        local_dir: None,
        forge: devboard::release::ReleaseForge::GitHub,
        download_base: base.clone(),
        // The artifact 404 is what this test proves; a source that carried a
        // Gitea fallback would add its own line to the same message.
        gitea_fallback: None,
    };
    let outcome = devboard::updates::check_with_source(&app, &source).await;
    handle.abort();
    assert_eq!(outcome, devboard::updates::UpdateOutcome::Failed);
    let journal = std::fs::read_to_string(devboard::journal::journal_file(
        &repo.join(".devboard/.tmp"),
        &repo,
    ))
    .expect("a journal record");
    assert!(
        journal.contains("update install delayed"),
        "the pending artifact is retried on the next interval: {journal}"
    );
    assert!(
        journal.contains("is still being written"),
        "the record names the pending release: {journal}"
    );
    assert!(
        !journal.contains("update-error"),
        "a window the next interval closes files no update error: {journal}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
