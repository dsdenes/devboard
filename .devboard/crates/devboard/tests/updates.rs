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

fn local_source(directory: &std::path::Path) -> devboard::release::ManifestSource {
    devboard::release::ManifestSource {
        base_url: String::new(),
        repository: "dsdenes/devboard".to_string(),
        token: None,
        timeout_ms: 5_000,
        local_dir: Some(directory.to_path_buf()),
        forge: devboard::release::ReleaseForge::Gitea,
        download_base: String::new(),
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
