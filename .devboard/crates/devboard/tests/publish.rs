//! The release path against local bare repositories and stub GitHub and Gitea
//! servers: version derivation, every refusal, the workflow wait and its bound,
//! asset and checksum verification, the exact manifest and source-refresh
//! bytes, and the shared release lock. Nothing here reaches a network, a real
//! tag, or a real push.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use devboard::jsjson;
use devboard::publish::{
    acquire_release_lock, commit_level, deliver_source_refresh, dist_digest, next_release_version,
    parse_subject, publish, subject_rule, verify_release_bundle, Clock, CommandInvocation,
    CommandOutcome, CommandRunner, CommitRecord, DashboardInstance, ProcessRunner, PublishArgs,
    ReleaseLevel, ReleaseLockOptions, Sleeper, SourceRefreshOptions, EMPTY_TREE_SHA,
    RELEASE_INSTALLERS, RELEASE_TARGETS,
};
use devboard::release_suite::{
    BoxFuture, ReleaseSuiteGate, ReleaseSuiteOptions, ReleaseSuiteReport,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Fixtures

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    path: String,
    query: String,
    body: Vec<u8>,
}

#[derive(Clone, Debug)]
struct StubResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

type StubHandler = Arc<dyn Fn(&RecordedRequest) -> StubResponse + Send + Sync>;

#[derive(Clone)]
struct StubState {
    handler: StubHandler,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

async fn stub_entry(
    State(state): State<StubState>,
    request: axum::extract::Request,
) -> axum::response::Response {
    let method = request.method().as_str().to_string();
    let uri = request.uri().clone();
    let body = axum::body::to_bytes(request.into_body(), usize::MAX)
        .await
        .unwrap_or_default()
        .to_vec();
    let record = RecordedRequest {
        method,
        path: uri.path().to_string(),
        query: uri.query().unwrap_or("").to_string(),
        body,
    };
    state
        .requests
        .lock()
        .expect("requests")
        .push(record.clone());
    let answer = (state.handler)(&record);
    let mut builder = axum::response::Response::builder().status(answer.status);
    for (name, value) in &answer.headers {
        builder = builder.header(name, value);
    }
    builder
        .body(axum::body::Body::from(answer.body))
        .expect("a stub response")
}

struct StubServer {
    base: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl StubServer {
    async fn start(
        handler: impl Fn(&RecordedRequest) -> StubResponse + Send + Sync + 'static,
    ) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = StubState {
            handler: Arc::new(handler),
            requests: requests.clone(),
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("a stub listener");
        let port = listener.local_addr().expect("an address").port();
        let app = axum::Router::new().fallback(stub_entry).with_state(state);
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base: format!("http://127.0.0.1:{port}"),
            requests,
            handle,
        }
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("requests").clone()
    }

    fn find(&self, method: &str, path: &str) -> Option<RecordedRequest> {
        self.requests()
            .into_iter()
            .find(|request| request.method == method && request.path == path)
    }
}

impl Drop for StubServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

fn json_response(value: Value) -> StubResponse {
    StubResponse {
        status: 200,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: value.to_string().into_bytes(),
    }
}

fn bytes_response(bytes: Vec<u8>) -> StubResponse {
    StubResponse {
        status: 200,
        headers: vec![(
            "content-type".to_string(),
            "application/octet-stream".to_string(),
        )],
        body: bytes,
    }
}

fn not_found() -> StubResponse {
    StubResponse {
        status: 404,
        headers: vec![],
        body: br#"{"message":"not found"}"#.to_vec(),
    }
}

fn query_value(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            return Some(percent_decode(value));
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(decoded) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(decoded as char);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    out
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn read_str<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

// ---------------------------------------------------------------------------
// Gitea stub

#[derive(Clone)]
struct StoredRelease {
    id: u64,
    assets: BTreeMap<String, Vec<u8>>,
}

struct GiteaData {
    releases: BTreeMap<String, StoredRelease>,
    refs: HashMap<String, String>,
    /// The commit the forge's `main` names, once a push reached it.
    head: String,
    next_id: u64,
    credential: GiteaCredential,
    /// What the `devboard-ci.yml` reads answer for the checkout's HEAD.
    ci: CiState,
    ci_reads: usize,
}

/// How the Gitea CI stub answers the gate's reads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CiState {
    /// One settled success for the pushed commit.
    Success,
    /// An in-progress run for this many reads, then a settled success.
    Wait(usize),
    /// A settled run with this conclusion.
    Settles(&'static str),
    /// No run for the commit.
    Absent,
}

/// How the stub answers the repository read the publish preflight makes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum GiteaCredential {
    Writable,
    ReadOnly,
    Invalid,
}

#[derive(Clone)]
struct GiteaStub {
    state: Arc<Mutex<GiteaData>>,
}

struct GiteaFixture {
    stub: GiteaStub,
    server: StubServer,
}

impl GiteaStub {
    async fn start(
        repo_dir: PathBuf,
        seeded: BTreeMap<String, String>,
        published: Vec<String>,
    ) -> GiteaFixture {
        let mut releases = BTreeMap::new();
        let mut next_id = 9;
        for tag in published {
            releases.insert(
                tag.clone(),
                StoredRelease {
                    id: next_id,
                    assets: BTreeMap::new(),
                },
            );
            next_id += 1;
        }
        let state = Arc::new(Mutex::new(GiteaData {
            releases,
            refs: seeded.into_iter().collect(),
            head: String::new(),
            next_id,
            credential: GiteaCredential::Writable,
            ci: CiState::Success,
            ci_reads: 0,
        }));
        let base_slot = Arc::new(Mutex::new(String::new()));
        let inner = state.clone();
        let slot = base_slot.clone();
        let repo_dir = repo_dir.clone();
        let server =
            StubServer::start(move |request| gitea_route(&inner, &slot, &repo_dir, request)).await;
        *base_slot.lock().expect("base") = server.base.clone();
        GiteaFixture {
            stub: GiteaStub { state },
            server,
        }
    }

    fn set_credential(&self, credential: GiteaCredential) {
        self.state.lock().expect("gitea").credential = credential;
    }

    /// The CI answer the gate reads for the checkout's HEAD.
    fn set_ci(&self, ci: CiState) {
        self.state.lock().expect("gitea").ci = ci;
    }

    /// Records the refs a push delivered to the forge.
    fn accepted(&self, tag: &str, commit: &str) {
        let mut data = self.state.lock().expect("gitea");
        data.refs.insert(tag.to_string(), commit.to_string());
        data.head = commit.to_string();
    }

    fn release_bytes(&self, tag: &str, name: &str) -> Option<Vec<u8>> {
        self.state
            .lock()
            .expect("gitea")
            .releases
            .get(tag)
            .and_then(|release| release.assets.get(name).cloned())
    }
}

fn gitea_route(
    state: &Arc<Mutex<GiteaData>>,
    base: &Arc<Mutex<String>>,
    repo_dir: &Path,
    request: &RecordedRequest,
) -> StubResponse {
    let path = request.path.as_str();
    let repo = "/api/v1/repos/dsdenes/devboard";
    if request.method == "GET" && path == format!("{repo}/actions/runs") {
        let mut data = state.lock().expect("gitea");
        data.ci_reads += 1;
        let head = git_output(repo_dir, &["rev-parse", "HEAD"]);
        let (status, conclusion) = match data.ci {
            CiState::Success => ("completed", Some("success".to_string())),
            CiState::Wait(after) if data.ci_reads <= after => ("in_progress", None),
            CiState::Wait(_) => ("completed", Some("success".to_string())),
            CiState::Settles(conclusion) => ("completed", Some(conclusion.to_string())),
            CiState::Absent => ("completed", Some("success".to_string())),
        };
        let runs = if data.ci == CiState::Absent {
            vec![json!({
                "id": 900,
                "path": "devboard-ci.yml@refs/heads/main",
                "head_sha": "0".repeat(40),
                "status": "completed",
                "conclusion": "success",
            })]
        } else {
            vec![
                // A foreign workflow and a foreign commit prove the gate
                // filters by both.
                json!({
                    "id": 901,
                    "path": "another-workflow.yml@refs/heads/main",
                    "head_sha": head,
                    "status": "completed",
                    "conclusion": "failure",
                }),
                json!({
                    "id": 902,
                    "path": "devboard-ci.yml@refs/heads/other",
                    "head_sha": "f".repeat(40),
                    "status": "completed",
                    "conclusion": "failure",
                }),
                json!({
                    "id": 777,
                    "path": "devboard-ci.yml@refs/heads/main",
                    "head_sha": head,
                    "status": status,
                    "conclusion": conclusion,
                }),
            ]
        };
        return json_response(json!({"workflow_runs": runs}));
    }
    if request.method == "GET" && path == repo {
        let data = state.lock().expect("gitea");
        if data.credential == GiteaCredential::Invalid {
            return StubResponse {
                status: 401,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: br#"{"message":"invalid username, password or token"}"#.to_vec(),
            };
        }
        let push = data.credential == GiteaCredential::Writable;
        return json_response(json!({
            "full_name": "dsdenes/devboard",
            "private": false,
            "permissions": {"admin": false, "push": push, "pull": true},
        }));
    }
    if request.method == "GET" && path == format!("{repo}/releases") {
        let data = state.lock().expect("gitea");
        let releases: Vec<Value> = data
            .releases
            .keys()
            .map(|tag| {
                json!({
                    "tag_name": tag,
                    "draft": false,
                    "published_at": "2026-01-01T00:00:00Z",
                })
            })
            .collect();
        return json_response(Value::Array(releases));
    }
    if request.method == "POST" && path == format!("{repo}/releases") {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let tag = read_str(&body, "tag_name").to_string();
        let commit = read_str(&body, "target_commitish").to_string();
        let mut data = state.lock().expect("gitea");
        let id = data.next_id;
        data.next_id += 1;
        data.refs.insert(tag.clone(), commit);
        data.releases.insert(
            tag.clone(),
            StoredRelease {
                id,
                assets: BTreeMap::new(),
            },
        );
        return json_response(json!({
            "id": id,
            "tag_name": tag,
            "published_at": "2026-01-01T00:00:00Z",
            "assets": [],
        }));
    }
    if let Some(rest) = path.strip_prefix(&format!("{repo}/releases/tags/")) {
        let tag = percent_decode(rest);
        let data = state.lock().expect("gitea");
        let Some(release) = data.releases.get(&tag) else {
            return not_found();
        };
        let base = base.lock().expect("base").clone();
        let assets: Vec<Value> = release
            .assets
            .keys()
            .map(|name| {
                json!({
                    "name": name,
                    "browser_download_url": format!("{base}/gitea-assets/{tag}/{name}"),
                })
            })
            .collect();
        return json_response(json!({
            "id": release.id,
            "tag_name": tag,
            "published_at": "2026-01-01T00:00:00Z",
            "assets": assets,
        }));
    }
    if request.method == "POST" {
        if let Some(rest) = path.strip_prefix(&format!("{repo}/releases/")) {
            if let Some(id_text) = rest.strip_suffix("/assets") {
                let id: u64 = id_text.parse().unwrap_or(0);
                let name = query_value(&request.query, "name").unwrap_or_default();
                let start = find_bytes(&request.body, b"\r\n\r\n")
                    .map(|index| index + 4)
                    .unwrap_or(0);
                let end = find_bytes(&request.body[start..], b"\r\n--")
                    .map(|index| start + index)
                    .unwrap_or(request.body.len());
                let content = request.body[start..end].to_vec();
                let mut data = state.lock().expect("gitea");
                if let Some(release) = data.releases.values_mut().find(|entry| entry.id == id) {
                    release.assets.insert(name.clone(), content);
                }
                return json_response(json!({"name": name}));
            }
        }
    }
    if request.method == "GET" && path == format!("{repo}/git/refs/heads/main") {
        let data = state.lock().expect("gitea");
        if data.head.is_empty() {
            return not_found();
        }
        let sha = data.head.clone();
        return json_response(json!({
            "ref": "refs/heads/main",
            "object": {"sha": sha, "type": "commit"},
        }));
    }
    if let Some(rest) = path.strip_prefix(&format!("{repo}/git/refs/tags/")) {
        let tag = percent_decode(rest);
        let data = state.lock().expect("gitea");
        let Some(sha) = data.refs.get(&tag) else {
            return not_found();
        };
        return json_response(json!({
            "ref": format!("refs/tags/{tag}"),
            "object": {"sha": sha, "type": "commit"},
        }));
    }
    if let Some(rest) = path.strip_prefix("/gitea-assets/") {
        let Some((tag, name)) = rest.split_once('/') else {
            return not_found();
        };
        let data = state.lock().expect("gitea");
        let Some(release) = data.releases.get(tag) else {
            return not_found();
        };
        let Some(bytes) = release.assets.get(name) else {
            return not_found();
        };
        return bytes_response(bytes.clone());
    }
    not_found()
}

// ---------------------------------------------------------------------------
// GitHub stub

struct GithubData {
    runs: Vec<Value>,
    dispatched: usize,
    dispatch_attempts: usize,
    dispatch_failures: VecDeque<u16>,
    assets: BTreeMap<String, Vec<u8>>,
    complete: bool,
    /// The conclusion the dispatched run settles with.
    settled_conclusion: String,
    /// The jobs document the run's jobs route answers.
    jobs: Option<Value>,
    /// When set, the runs read reports a settled success once this many reads
    /// have happened, so a wait can be tested against a run that finishes
    /// after the last poll.
    settle_after: Option<usize>,
    reads: usize,
    /// Whether the GitHub release of the dispatched run exists.
    release_published: bool,
    /// The commit the release tag ref names after publish retags it.
    tag_commit: Option<String>,
    /// Whether the temporary build ref was deleted.
    build_ref_deleted: bool,
    /// Every asset uploaded to the GitHub release by name.
    uploaded: Vec<String>,
}

#[derive(Clone)]
struct GithubStub {
    state: Arc<Mutex<GithubData>>,
}

struct GithubFixture {
    stub: GithubStub,
    server: StubServer,
}

impl GithubStub {
    async fn start(
        repo_dir: PathBuf,
        assets: BTreeMap<String, Vec<u8>>,
        runs: Vec<Value>,
        complete: bool,
    ) -> GithubFixture {
        let state = Arc::new(Mutex::new(GithubData {
            runs,
            dispatched: 0,
            dispatch_attempts: 0,
            dispatch_failures: VecDeque::new(),
            assets,
            complete,
            settled_conclusion: "success".to_string(),
            jobs: None,
            settle_after: None,
            reads: 0,
            release_published: true,
            tag_commit: None,
            build_ref_deleted: false,
            uploaded: Vec::new(),
        }));
        let base_slot = Arc::new(Mutex::new(String::new()));
        let inner = state.clone();
        let slot = base_slot.clone();
        let server =
            StubServer::start(move |request| github_route(&inner, &slot, &repo_dir, request)).await;
        *base_slot.lock().expect("base") = server.base.clone();
        GithubFixture {
            stub: GithubStub { state },
            server,
        }
    }

    fn dispatch_count(&self) -> usize {
        self.state.lock().expect("github").dispatched
    }

    fn dispatch_attempts(&self) -> usize {
        self.state.lock().expect("github").dispatch_attempts
    }

    fn fail_next_dispatch(&self, status: u16) {
        self.state
            .lock()
            .expect("github")
            .dispatch_failures
            .push_back(status);
    }

    /// Settles the dispatched run with `conclusion` and answers its jobs.
    fn settle_with(&self, conclusion: &str, jobs: Value) {
        let mut data = self.state.lock().expect("github");
        data.settled_conclusion = conclusion.to_string();
        data.jobs = Some(jobs);
    }

    async fn settling_after(
        repo_dir: PathBuf,
        assets: BTreeMap<String, Vec<u8>>,
        after: usize,
    ) -> GithubFixture {
        let fixture = GithubStub::start(repo_dir, assets, Vec::new(), false).await;
        fixture.stub.state.lock().expect("github").settle_after = Some(after);
        fixture
    }

    /// Whether the GitHub release exists for the tag the release reads.
    fn release_exists(&self, exists: bool) {
        self.state.lock().expect("github").release_published = exists;
    }

    fn tag_commit(&self) -> Option<String> {
        self.state.lock().expect("github").tag_commit.clone()
    }

    fn build_ref_deleted(&self) -> bool {
        self.state.lock().expect("github").build_ref_deleted
    }

    fn uploaded(&self) -> Vec<String> {
        self.state.lock().expect("github").uploaded.clone()
    }
}

fn github_route(
    state: &Arc<Mutex<GithubData>>,
    base: &Arc<Mutex<String>>,
    repo_dir: &Path,
    request: &RecordedRequest,
) -> StubResponse {
    let path = request.path.as_str();
    if request.method == "GET"
        && path == "/repos/dsdenes/devboard/actions/workflows/devboard-build.yml/runs"
    {
        let mut data = state.lock().expect("github");
        data.reads += 1;
        let settled = (data.dispatched > 0 && data.complete)
            || data.settle_after.is_some_and(|after| data.reads > after);
        let head_named = data.settle_after.is_some();
        let runs = if settled || head_named {
            let sha = git_output(repo_dir, &["rev-parse", "HEAD"]);
            let sha = sha.trim();
            let id = 42 + data.dispatched.saturating_sub(1) as u64;
            if settled {
                vec![json!({
                    "id": id,
                    "head_sha": sha,
                    "status": "completed",
                    "conclusion": data.settled_conclusion.clone(),
                })]
            } else {
                vec![json!({
                    "id": id,
                    "head_sha": sha,
                    "status": "in_progress",
                    "conclusion": null,
                })]
            }
        } else {
            data.runs.clone()
        };
        return json_response(json!({"workflow_runs": runs}));
    }
    if request.method == "GET" && path == "/repos/dsdenes/devboard/actions/runs/42/jobs" {
        let data = state.lock().expect("github");
        return match &data.jobs {
            Some(document) => json_response(document.clone()),
            None => not_found(),
        };
    }
    if request.method == "POST"
        && path == "/repos/dsdenes/devboard/actions/workflows/devboard-build.yml/dispatches"
    {
        let mut data = state.lock().expect("github");
        data.dispatch_attempts += 1;
        if let Some(status) = data.dispatch_failures.pop_front() {
            return StubResponse {
                status,
                headers: vec![],
                body: Vec::new(),
            };
        }
        data.dispatched += 1;
        return StubResponse {
            status: 204,
            headers: vec![],
            body: Vec::new(),
        };
    }
    if request.method == "POST" && path == "/repos/dsdenes/devboard/git/trees" {
        return json_response(json!({"sha": "0".repeat(40)}));
    }
    if request.method == "POST" && path == "/repos/dsdenes/devboard/git/commits" {
        return json_response(json!({"sha": "e".repeat(40)}));
    }
    if request.method == "DELETE" && path == "/repos/dsdenes/devboard/git/refs/tags/v1.1.0" {
        return StubResponse {
            status: 204,
            headers: vec![],
            body: Vec::new(),
        };
    }
    if request.method == "POST" && path == "/repos/dsdenes/devboard/git/refs" {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let reference = read_str(&body, "ref").to_string();
        let sha = read_str(&body, "sha").to_string();
        if reference == "refs/tags/v1.1.0" {
            state.lock().expect("github").tag_commit = Some(sha.clone());
        }
        return json_response(json!({"ref": reference, "object": {"sha": sha}}));
    }
    if request.method == "DELETE"
        && path == "/repos/dsdenes/devboard/git/refs/heads/devboard-build/v1.1.0"
    {
        state.lock().expect("github").build_ref_deleted = true;
        return StubResponse {
            status: 204,
            headers: vec![],
            body: Vec::new(),
        };
    }
    if let Some(rest) = path.strip_prefix("/repos/dsdenes/devboard/releases/") {
        if let Some(id_text) = rest.strip_suffix("/assets") {
            let id: u64 = id_text.parse().unwrap_or(0);
            let name = query_value(&request.query, "name").unwrap_or_default();
            let mut data = state.lock().expect("github");
            data.uploaded.push(name.clone());
            data.assets.insert(name.clone(), request.body.clone());
            return StubResponse {
                status: 201,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: json!({"id": id, "name": name}).to_string().into_bytes(),
            };
        }
    }
    if let Some(rest) = path.strip_prefix("/repos/dsdenes/devboard/releases/tags/") {
        let tag = percent_decode(rest);
        let data = state.lock().expect("github");
        if !data.release_published {
            return not_found();
        }
        let base = base.lock().expect("base").clone();
        let assets: Vec<Value> = data
            .assets
            .keys()
            .map(|name| {
                json!({
                    "name": name,
                    "browser_download_url": format!("{base}/gh-assets/{name}"),
                })
            })
            .collect();
        return json_response(json!({
            "id": 7,
            "tag_name": tag,
            "assets": assets,
        }));
    }
    if let Some(name) = path.strip_prefix("/gh-assets/") {
        let data = state.lock().expect("github");
        let Some(bytes) = data.assets.get(name) else {
            return not_found();
        };
        return bytes_response(bytes.clone());
    }
    not_found()
}

// ---------------------------------------------------------------------------
// Git scratch

fn package_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn new(label: &str) -> Self {
        let root = package_dir()
            .join(".test-tmp")
            .join(format!("publish-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("a scratch root");
        Self {
            root: fs::canonicalize(&root).expect("a real scratch root"),
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git_output(directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=Release Test",
            "-c",
            "user.email=release@example.test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(directory)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn git_init(directory: &Path) {
    fs::create_dir_all(directory).expect("a repository directory");
    git_output(directory, &["init", "-q"]);
}

fn commit_file(directory: &Path, relative: &str, content: &str, message: &str) -> String {
    let path = directory.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("a file parent");
    }
    fs::write(&path, content).expect("a file");
    git_output(directory, &["add", "--", relative]);
    git_output(directory, &["commit", "-q", "--allow-empty", "-m", message]);
    git_output(directory, &["rev-parse", "HEAD"])
}

fn commit_message(directory: &Path, message: &str) -> String {
    git_output(directory, &["commit", "-q", "--allow-empty", "-m", message]);
    git_output(directory, &["rev-parse", "HEAD"])
}

fn write_harness(directory: &Path) {
    fs::create_dir_all(directory.join(".devboard/dist/assets")).expect("the harness");
    fs::write(
        directory.join(".devboard/Cargo.toml"),
        "[workspace]\nmembers = [\"crates/devboard\"]\n\n[workspace.package]\nversion = \"0.0.0\"\nedition = \"2021\"\n",
    )
    .expect("a workspace manifest");
    fs::write(
        directory.join(".devboard/package.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"0.1.0\"}\n",
    )
    .expect("a harness manifest");
    fs::write(
        directory.join(".devboard/dist/index.html"),
        "<!doctype html><script src=\"/assets/app.js\"></script>\n",
    )
    .expect("an index");
    fs::write(
        directory.join(".devboard/dist/assets/app.js"),
        "console.log(\"devboard\");\n",
    )
    .expect("an asset");
    fs::create_dir_all(directory.join(".devboard/crates/devboard/assets/assets"))
        .expect("the embedded client");
    fs::copy(
        directory.join(".devboard/dist/index.html"),
        directory.join(".devboard/crates/devboard/assets/index.html"),
    )
    .expect("an embedded index");
    fs::copy(
        directory.join(".devboard/dist/assets/app.js"),
        directory.join(".devboard/crates/devboard/assets/assets/app.js"),
    )
    .expect("an embedded asset");
}

fn origin_repository(root: &Path) -> (PathBuf, PathBuf) {
    let origin = root.join("origin.git");
    let github = root.join("github.git");
    fs::create_dir_all(&origin).expect("an origin");
    fs::create_dir_all(&github).expect("a mirror");
    git_output(&origin, &["init", "-q", "--bare"]);
    git_output(&github, &["init", "-q", "--bare"]);
    (origin, github)
}

fn git_origin(directory: &Path, origin: &Path, github: &Path) {
    git_output(
        directory,
        &["remote", "add", "origin", origin.to_string_lossy().as_ref()],
    );
    git_output(
        directory,
        &["remote", "add", "github", github.to_string_lossy().as_ref()],
    );
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn asset_bytes(name: &str) -> Vec<u8> {
    format!("archive contents for {name}\n").into_bytes()
}

fn checksum_bytes(name: &str) -> Vec<u8> {
    format!("{}  {name}\n", sha256_hex(&asset_bytes(name))).into_bytes()
}

fn release_assets() -> BTreeMap<String, Vec<u8>> {
    let mut assets = BTreeMap::new();
    let mut unified = String::new();
    for target in RELEASE_TARGETS {
        let name = format!("devboard-{target}.tar.xz");
        let bytes = asset_bytes(&name);
        unified.push_str(&format!("{} *{name}\n", sha256_hex(&bytes)));
        assets.insert(name.clone(), bytes);
        assets.insert(format!("{name}.sha256"), checksum_bytes(&name));
    }
    for installer in RELEASE_INSTALLERS {
        let bytes = asset_bytes(installer);
        unified.push_str(&format!("{} *{installer}\n", sha256_hex(&bytes)));
        assets.insert(installer.to_string(), bytes);
    }
    assets.insert("sha256.sum".to_string(), unified.into_bytes());
    assets
}

fn application_base(scratch: &Scratch, origin: &Path, github: &Path) -> PathBuf {
    let app = scratch.root.join("repo");
    git_init(&app);
    write_harness(&app);
    git_origin(&app, origin, github);
    git_output(&app, &["add", "-A"]);
    app
}

// ---------------------------------------------------------------------------
// Injected time

struct FakeClock {
    now: AtomicI64,
}

impl FakeClock {
    fn new(start: i64) -> Arc<Self> {
        Arc::new(Self {
            now: AtomicI64::new(start),
        })
    }

    fn advance(&self, millis: i64) {
        self.now.fetch_add(millis, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now_millis(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

struct FakeSleeper {
    clock: Arc<FakeClock>,
    step: i64,
}

impl Sleeper for FakeSleeper {
    fn sleep<'a>(&'a self, _duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        let clock = self.clock.clone();
        let step = self.step;
        Box::pin(async move {
            clock.advance(step);
        })
    }
}

/// A sleeper standing in for an integration landing's in-flight push: the
/// canonical checkout's `main` moves to the remote on the first wait, exactly
/// as a landing does moments after it merges.
struct LandingPusher {
    clock: Arc<FakeClock>,
    repo: PathBuf,
    sleeps: AtomicUsize,
}

impl LandingPusher {
    fn new(clock: Arc<FakeClock>, repo: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            clock,
            repo,
            sleeps: AtomicUsize::new(0),
        })
    }
}

impl Sleeper for LandingPusher {
    fn sleep<'a>(&'a self, _duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        let clock = self.clock.clone();
        Box::pin(async move {
            if self.sleeps.fetch_add(1, Ordering::SeqCst) == 0 {
                git_output(&self.repo, &["push", "-q", "origin", "main"]);
            }
            clock.advance(1);
        })
    }
}

/// The gate every publish test uses: no real suite runs, and the verdict is
/// the one the test asked for. It asserts the gate receives the harness
/// workspace.
struct StubSuiteGate {
    code: i32,
    structural: Option<String>,
}

impl ReleaseSuiteGate for StubSuiteGate {
    fn run<'a>(
        &'a self,
        options: ReleaseSuiteOptions,
    ) -> BoxFuture<'a, anyhow::Result<ReleaseSuiteReport>> {
        assert!(
            options.dir.ends_with(".devboard"),
            "the gate runs the harness workspace, got {}",
            options.dir.display()
        );
        let report = ReleaseSuiteReport {
            code: self.code,
            attempts: if self.code == 0 { 1 } else { 9 },
            quarantined: Vec::new(),
            structural: self.structural.clone(),
            error_line: self.structural.clone(),
        };
        Box::pin(async move { Ok(report) })
    }
}

/// A suite gate a landing races: `origin/main` moves while the suite runs,
/// after the attempt derived and tested its range.
struct RacingSuiteGate {
    /// The checkout whose commit the gate pushes to `origin/main`.
    landing: PathBuf,
    runs: AtomicUsize,
    /// Commits a fresh landing before every push, so the race never settles.
    every_run: bool,
}

impl ReleaseSuiteGate for RacingSuiteGate {
    fn run<'a>(
        &'a self,
        options: ReleaseSuiteOptions,
    ) -> BoxFuture<'a, anyhow::Result<ReleaseSuiteReport>> {
        assert!(
            options.dir.ends_with(".devboard"),
            "the gate runs the harness workspace, got {}",
            options.dir.display()
        );
        let run = self.runs.fetch_add(1, Ordering::SeqCst);
        if self.every_run {
            commit_file(
                &self.landing,
                "LANDING.md",
                &format!("landing {}\n", run + 1),
                &format!("fix: a landing during suite run {}", run + 1),
            );
        }
        if run == 0 || self.every_run {
            git_output(&self.landing, &["push", "-q", "origin", "main"]);
        }
        let report = ReleaseSuiteReport {
            code: 0,
            attempts: 1,
            quarantined: Vec::new(),
            structural: None,
            error_line: None,
        };
        Box::pin(async move { Ok(report) })
    }
}

/// One path named relative to another, without requiring either to be canonical.
fn relative_to(path: &Path, base: &Path) -> PathBuf {
    let path: Vec<_> = path.components().collect();
    let base: Vec<_> = base.components().collect();
    let shared = path
        .iter()
        .zip(&base)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = PathBuf::new();
    for _ in shared..base.len() {
        relative.push("..");
    }
    for component in &path[shared..] {
        relative.push(component.as_os_str());
    }
    relative
}

fn test_args(
    repo: &Path,
    gitea: &StubServer,
    github: &StubServer,
    instance: Option<DashboardInstance>,
) -> PublishArgs {
    let mut environment = HashMap::new();
    environment.insert("DEVBOARD_GITEA_URL".to_string(), gitea.base.clone());
    environment.insert("GITEA_TOKEN".to_string(), "test-token".to_string());
    environment.insert("DEVBOARD_GITHUB_API_URL".to_string(), github.base.clone());
    environment.insert("GH_TOKEN".to_string(), "test-token".to_string());
    environment.insert(
        "DEVBOARD_RELEASE_REPO".to_string(),
        "dsdenes/devboard".to_string(),
    );
    environment.insert(
        "DEVBOARD_GITHUB_REPO".to_string(),
        "dsdenes/devboard".to_string(),
    );
    let mut args = PublishArgs::new(repo);
    args.environment = environment;
    args.wait_timeout = Duration::from_secs(5);
    args.poll_interval = Duration::from_millis(5);
    args.lock_poll_interval = Duration::from_millis(5);
    args.instances = instance.map(|instance| vec![instance]);
    args.release_suite = Some(Arc::new(StubSuiteGate {
        code: 0,
        structural: None,
    }));
    args.log = Some(Arc::new(|_line: &str| {}));
    args
}

// ---------------------------------------------------------------------------
// Derivation and grammar

#[test]
fn the_conventional_derivation_covers_every_case() {
    assert!(parse_subject("feat(scope)!: thing").is_some_and(|parsed| parsed.breaking));
    assert!(subject_rule("feat: a thing").is_none());
    assert!(subject_rule("feat!: a thing").is_none());
    assert!(subject_rule("bad subject").is_some());
    assert!(subject_rule("Feature: a thing").is_some());
    let mut breaking = CommitRecord {
        sha: "a".repeat(40),
        subject: "fix: a change".to_string(),
        body: "BREAKING CHANGE: the shape moved".to_string(),
        parents: vec!["b".repeat(40)],
    };
    assert_eq!(commit_level(&breaking), Some(ReleaseLevel::Major));
    breaking.body = "BREAKING-CHANGE: the shape moved".to_string();
    assert_eq!(commit_level(&breaking), Some(ReleaseLevel::Major));
    assert_eq!(next_release_version(None, None), "1.0.0");
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
}

// ---------------------------------------------------------------------------
// Refusals

#[tokio::test]
async fn a_worktree_is_refused() {
    let scratch = Scratch::new("worktree");
    let (origin, github) = origin_repository(&scratch.root);
    let app = application_base(&scratch, &origin, &github);
    commit_message(&app, "feat: base");
    let worktree = scratch.root.join("linked");
    git_output(
        &app,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            worktree.to_string_lossy().as_ref(),
        ],
    );
    let gitea = StubServer::start(|_| not_found()).await;
    let gh = StubServer::start(|_| not_found()).await;
    let error = publish(test_args(&worktree, &gitea, &gh, None))
        .await
        .expect_err("a worktree is refused");
    assert!(format!("{error:#}").contains("not a worktree"), "{error:#}");
}

#[tokio::test]
async fn a_branch_other_than_main_is_refused() {
    let scratch = Scratch::new("branch");
    let (origin, github) = origin_repository(&scratch.root);
    let app = application_base(&scratch, &origin, &github);
    commit_message(&app, "feat: base");
    git_output(&app, &["checkout", "-q", "-b", "feature"]);
    let gitea = StubServer::start(|_| not_found()).await;
    let gh = StubServer::start(|_| not_found()).await;
    let error = publish(test_args(&app, &gitea, &gh, None))
        .await
        .expect_err("a branch is refused");
    assert!(
        format!("{error:#}").contains("the integration line is main"),
        "{error:#}"
    );
}

#[tokio::test]
async fn an_ahead_or_diverged_main_is_refused() {
    let scratch = Scratch::new("ahead");
    let (origin, github) = origin_repository(&scratch.root);
    let app = application_base(&scratch, &origin, &github);
    commit_message(&app, "feat: base");
    git_output(&app, &["push", "-q", "origin", "main"]);
    commit_message(&app, "feat: local only");
    let gitea = StubServer::start(|_| not_found()).await;
    let gh = StubServer::start(|_| not_found()).await;
    let mut args = test_args(&app, &gitea, &gh, None);
    // The settle window is real time in production; a fake sleeper keeps this
    // refusal immediate.
    let clock = FakeClock::new(0);
    args.clock = Some(clock.clone());
    args.sleeper = Some(Arc::new(FakeSleeper { clock, step: 5_000 }));
    let error = publish(args).await.expect_err("an ahead main is refused");
    assert!(
        format!("{error:#}").contains("ahead of or diverged"),
        "{error:#}"
    );
}

#[tokio::test]
async fn an_in_flight_landing_that_pushes_lets_the_release_run() {
    let live = live("landing", release_assets()).await;
    commit_file(&live.seed, "README.md", "landing\n", "feat: the landing");
    let clock = FakeClock::new(0);
    let sleeper = LandingPusher::new(clock.clone(), live.seed.clone());
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.clock = Some(clock);
    args.sleeper = Some(sleeper.clone());
    let report = publish(args).await.expect("the landing push settles");

    assert!(report.published, "the release ships once main is pushed");
    assert_eq!(report.version, "1.1.0");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        report.commit
    );
    assert!(sleeper.sleeps.load(Ordering::SeqCst) >= 1);
}

/// A second checkout of the fixture's remote, which the tests use to publish a
/// landing while a release runs.
fn landing_checkout(live: &Live) -> PathBuf {
    let landing = live._scratch.root.join("landing");
    git_output(
        &live._scratch.root,
        &[
            "clone",
            "-q",
            live.origin.to_string_lossy().as_ref(),
            landing.to_string_lossy().as_ref(),
        ],
    );
    landing
}

#[tokio::test]
async fn a_landing_that_pushes_during_the_suite_is_integrated_and_released() {
    let live = live("landing-during-suite", release_assets()).await;
    let landing = landing_checkout(&live);
    commit_file(
        &landing,
        "LANDING.md",
        "landing\n",
        "fix: a landing during the suite",
    );
    let landing_commit = git_output(&landing, &["rev-parse", "HEAD"]);
    let gate = Arc::new(RacingSuiteGate {
        landing: landing.clone(),
        runs: AtomicUsize::new(0),
        every_run: false,
    });
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.release_suite = Some(gate.clone());
    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = lines.clone();
    args.log = Some(Arc::new(move |line: &str| {
        recorded.lock().expect("log").push(line.to_string());
    }));

    let report = publish(args)
        .await
        .expect("the landing is integrated and the release ships");

    assert_eq!(
        gate.runs.load(Ordering::SeqCst),
        2,
        "the suite runs again at the integrated tip"
    );
    assert!(report.published);
    assert_eq!(report.tag, "v1.1.0");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        report.commit
    );
    assert_eq!(
        git_output(&live.seed, &["rev-parse", "HEAD"]),
        report.commit
    );
    // The released commit contains the landing, and the bump follows it.
    git_output(
        &live.origin,
        &[
            "merge-base",
            "--is-ancestor",
            &landing_commit,
            &report.commit,
        ],
    );
    assert_eq!(
        git_output(&live.origin, &["show", "-s", "--format=%s", &report.commit]),
        "chore(release): v1.1.0"
    );
    // The tag was withdrawn from the failed attempt and recreated at the
    // integrated tip; the GitHub tag names the empty release commit and the
    // build ref is gone.
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        report.commit
    );
    assert_eq!(live.github_stub.tag_commit(), Some("e".repeat(40)));
    assert!(live.github_stub.build_ref_deleted());
    let commit_request = live
        .github_server
        .find("POST", "/repos/dsdenes/devboard/git/commits")
        .expect("the empty release commit");
    assert!(
        String::from_utf8_lossy(&commit_request.body).contains(EMPTY_TREE_SHA),
        "the release commit names git's empty tree"
    );
    assert_eq!(live.github_stub.dispatch_count(), 1);
    assert!(
        live.gitea_stub
            .release_bytes("v1.1.0", "devboard-manifest.json")
            .is_some(),
        "the release continues past the integrated landing"
    );
    let lines = lines.lock().expect("log").clone();
    assert!(
        lines
            .iter()
            .any(|line| line.contains("integrating the landing at")),
        "{lines:?}"
    );
}

#[tokio::test]
async fn a_landing_that_never_settles_leaves_no_tag_behind() {
    let live = live("landing-churn", release_assets()).await;
    let landing = landing_checkout(&live);
    let gate = Arc::new(RacingSuiteGate {
        landing: landing.clone(),
        runs: AtomicUsize::new(0),
        every_run: true,
    });
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.release_suite = Some(gate.clone());

    let error = publish(args)
        .await
        .expect_err("a main that never settles stops the release");
    let message = format!("{error:#}");
    assert!(message.contains("could not push main"), "{message}");
    assert!(message.contains("moved during all 3 attempts"), "{message}");
    assert_eq!(gate.runs.load(Ordering::SeqCst), 3);
    // No tag survives the failed attempts on either remote or in the checkout,
    // and the checkout is back at the tip the landings published.
    let landing_commit = git_output(&landing, &["rev-parse", "HEAD"]);
    for remote in [&live.origin, &live.github] {
        let tags = git_output(remote, &["tag", "--list", "v1.1.0"]);
        assert!(tags.trim().is_empty(), "{remote:?}: {tags}");
    }
    let local_tags = git_output(&live.seed, &["tag", "--list", "v1.1.0"]);
    assert!(local_tags.trim().is_empty(), "{local_tags}");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        landing_commit
    );
    assert_eq!(
        git_output(&live.seed, &["rev-parse", "HEAD"]),
        landing_commit
    );
    assert_eq!(live.github_stub.dispatch_count(), 0);
    assert!(live
        .gitea_stub
        .release_bytes("v1.1.0", "devboard-manifest.json")
        .is_none());
}

#[tokio::test]
async fn uncommitted_work_that_blocks_the_fast_forward_is_refused() {
    let scratch = Scratch::new("dirty");
    let (origin, github) = origin_repository(&scratch.root);
    let app = application_base(&scratch, &origin, &github);
    commit_file(&app, "tracked.txt", "one\n", "feat: base");
    git_output(&app, &["push", "-q", "origin", "main"]);

    let other = scratch.root.join("other");
    fs::create_dir_all(&other).expect("another checkout");
    git_output(
        &scratch.root,
        &[
            "clone",
            "-q",
            origin.to_string_lossy().as_ref(),
            other.to_string_lossy().as_ref(),
        ],
    );
    commit_file(&other, "tracked.txt", "two\n", "feat: remote change");
    git_output(&other, &["push", "-q", "origin", "main"]);

    fs::write(app.join("tracked.txt"), "local edit\n").expect("a local edit");
    let gitea = StubServer::start(|_| not_found()).await;
    let gh = StubServer::start(|_| not_found()).await;
    let error = publish(test_args(&app, &gitea, &gh, None))
        .await
        .expect_err("blocking edits are refused");
    assert!(
        format!("{error:#}").contains("uncommitted changes would block the fast-forward"),
        "{error:#}"
    );
}

#[tokio::test]
async fn a_relative_checkout_root_publishes_from_its_own_directory() {
    let live = live("relative-root", release_assets()).await;
    let cwd = fs::canonicalize(std::env::current_dir().expect("a working directory"))
        .expect("a real working directory");
    let relative = relative_to(&live.seed, &cwd);

    // `devboard publish --repo .` names the checkout root relatively; every git
    // read must resolve it once, not once per directory it descends into.
    let args = test_args(&relative, &live.gitea_server, &live.github_server, None);
    let report = publish(args)
        .await
        .expect("a relative checkout root publishes");
    assert_eq!(report.version, "1.1.0");
}

#[tokio::test]
async fn an_invalid_subject_refuses_the_range() {
    let scratch = Scratch::new("subject");
    let (origin, github) = origin_repository(&scratch.root);
    let app = application_base(&scratch, &origin, &github);
    commit_message(&app, "feat: base");
    git_output(&app, &["tag", "v1.0.0"]);
    git_output(&app, &["push", "-q", "origin", "main", "v1.0.0"]);
    commit_message(&app, "bad subject");
    git_output(&app, &["push", "-q", "origin", "main"]);

    let gitea = StubServer::start(|_| json_response(json!([]))).await;
    let gh = StubServer::start(|_| not_found()).await;
    let error = publish(test_args(&app, &gitea, &gh, None))
        .await
        .expect_err("an invalid subject is refused");
    assert!(
        format!("{error:#}").contains("not Conventional Commits"),
        "{error:#}"
    );
}

#[tokio::test]
async fn a_tag_for_an_unrelated_commit_is_refused_before_any_write() {
    let scratch = Scratch::new("binding");
    let (origin, github) = origin_repository(&scratch.root);
    let app = application_base(&scratch, &origin, &github);
    commit_message(&app, "feat: base");
    git_output(&app, &["tag", "v1.0.0"]);
    git_output(&app, &["push", "-q", "origin", "main", "v1.0.0"]);
    commit_message(&app, "feat: the change under release");
    git_output(&app, &["push", "-q", "origin", "main"]);
    git_output(&app, &["checkout", "-q", "--orphan", "elsewhere"]);
    commit_message(&app, "fix: another line of work");
    git_output(&app, &["checkout", "-q", "main"]);
    git_output(&app, &["tag", "v1.1.0", "elsewhere"]);

    let gitea = StubServer::start(|_| json_response(json!([]))).await;
    let gh = StubServer::start(|_| not_found()).await;
    let error = publish(test_args(&app, &gitea, &gh, None))
        .await
        .expect_err("an unrelated tag is refused");
    let message = format!("{error:#}");
    assert!(message.contains("v1.1.0 already names"), "{message}");
    assert!(message.contains("neither names nor contains"), "{message}");
    assert_ne!(
        git_output(&app, &["rev-parse", "HEAD"]),
        git_output(&app, &["rev-parse", "v1.1.0^{commit}"])
    );
    assert!(gitea
        .find("POST", "/api/v1/repos/dsdenes/devboard/releases")
        .is_none());
}

// ---------------------------------------------------------------------------
// Full release path

#[tokio::test]
async fn release_suite_gate_prevents_tagging_and_dispatch() {
    let live = live("suite-gate", release_assets()).await;
    let head = git_output(&live.seed, &["rev-parse", "HEAD"]);
    let origin_head = git_output(&live.origin, &["rev-parse", "main"]);
    let github_head = git_output(&live.github, &["rev-parse", "main"]);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.release_suite = Some(Arc::new(StubSuiteGate {
        code: 1,
        structural: Some(
            "the suite could not compile: error[E0425]: cannot find value `missing` in this scope"
                .to_string(),
        ),
    }));
    let error = publish(args)
        .await
        .expect_err("a failing suite blocks the release");
    let message = format!("{error:#}");
    assert!(message.contains("release suite did not pass"), "{message}");
    assert!(message.contains("error[E0425]"), "{message}");

    // Nothing was bumped, committed, tagged, pushed, or dispatched.
    assert_eq!(git_output(&live.seed, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git_output(&live.seed, &["show", "-s", "--format=%s", "HEAD"]),
        "feat: the next release"
    );
    let tags = git_output(&live.seed, &["tag", "--list", "v1.1.0"]);
    assert!(tags.trim().is_empty(), "{tags}");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        origin_head
    );
    assert_eq!(
        git_output(&live.github, &["rev-parse", "main"]),
        github_head
    );
    assert_eq!(live.github_stub.dispatch_count(), 0);
    assert!(live
        .github_server
        .find(
            "POST",
            "/repos/dsdenes/devboard/actions/workflows/devboard-build.yml/dispatches"
        )
        .is_none());
    assert!(live
        .gitea_server
        .find("POST", "/api/v1/repos/dsdenes/devboard/releases")
        .is_none());
    let manifest = fs::read_to_string(live.seed.join(".devboard/Cargo.toml")).expect("manifest");
    assert!(manifest.contains("version = \"0.0.0\""), "{manifest}");
}

struct Live {
    _scratch: Scratch,
    seed: PathBuf,
    origin: PathBuf,
    github: PathBuf,
    gitea_stub: GiteaStub,
    gitea_server: StubServer,
    github_stub: GithubStub,
    github_server: StubServer,
    state_dir: PathBuf,
}

async fn live(label: &str, assets: BTreeMap<String, Vec<u8>>) -> Live {
    let scratch = Scratch::new(label);
    let (origin, github) = origin_repository(&scratch.root);
    let seed = scratch.root.join("seed");
    git_init(&seed);
    write_harness(&seed);
    git_origin(&seed, &origin, &github);
    git_output(&seed, &["add", "-A"]);
    let base = commit_file(&seed, "README.md", "base\n", "feat: base");
    git_output(&seed, &["tag", "v1.0.0"]);
    git_output(&seed, &["push", "-q", "origin", "main", "v1.0.0"]);
    git_output(&seed, &["push", "-q", "github", "main", "v1.0.0"]);
    commit_file(&seed, "README.md", "next\n", "feat: the next release");
    git_output(&seed, &["push", "-q", "origin", "main"]);

    let mut refs = BTreeMap::new();
    refs.insert("v1.0.0".to_string(), base);
    let gitea = GiteaStub::start(seed.clone(), refs, Vec::new()).await;
    let github_fixture = GithubStub::start(seed.clone(), assets, Vec::new(), true).await;
    let state_dir = scratch.root.join("state");
    fs::create_dir_all(&state_dir).expect("a state directory");
    Live {
        _scratch: scratch,
        seed,
        origin,
        github,
        gitea_stub: gitea.stub,
        gitea_server: gitea.server,
        github_stub: github_fixture.stub,
        github_server: github_fixture.server,
        state_dir,
    }
}

#[tokio::test]
async fn a_release_publishes_the_manifest_and_the_source_refresh() {
    let live = live("release", release_assets()).await;
    let version = "1.1.0";
    let tag = "v1.1.0";
    let dist_dir = live.seed.join(".devboard/dist");
    let expected_digest = dist_digest(&dist_dir).expect("a bundle digest");
    let instance = DashboardInstance {
        pid: 4242,
        port: 7300,
        repo_dir: live.seed.clone(),
        harness: live.seed.join(".devboard"),
        state_dir: live.state_dir.clone(),
    };
    let mut args = test_args(
        &live.seed,
        &live.gitea_server,
        &live.github_server,
        Some(instance),
    );
    args.wait_timeout = Duration::from_secs(5);
    let report = publish(args).await.expect("a release");

    assert_eq!(report.version, version);
    assert_eq!(report.tag, tag);
    assert!(report.published);
    assert_eq!(report.workflow_run, Some(42));
    let commit = git_output(&live.seed, &["rev-parse", "HEAD"]);
    assert_eq!(report.commit, commit);
    assert_eq!(
        git_output(&live.seed, &["rev-parse", &format!("{tag}^{{commit}}")]).trim(),
        commit
    );
    assert_eq!(
        git_output(&live.seed, &["show", "-s", "--format=%s", "HEAD"]),
        "chore(release): v1.1.0"
    );
    let manifest = fs::read_to_string(live.seed.join(".devboard/Cargo.toml")).expect("manifest");
    assert!(manifest.contains("version = \"1.1.0\""), "{manifest}");
    assert_eq!(git_output(&live.origin, &["rev-parse", "main"]), commit);
    // GitHub's main is never advanced to the released commit, and the release
    // tag names an empty-tree commit; only the temporary build ref carried the
    // canonical source, and publish deleted it.
    assert_ne!(git_output(&live.github, &["rev-parse", "main"]), commit);
    assert_eq!(
        live.github_stub.tag_commit(),
        Some("e".repeat(40)),
        "the release tag names the empty release commit"
    );
    assert!(live.github_stub.build_ref_deleted());
    assert_eq!(live.github_stub.dispatch_count(), 1);
    let dispatch = live
        .github_server
        .find(
            "POST",
            "/repos/dsdenes/devboard/actions/workflows/devboard-build.yml/dispatches",
        )
        .expect("a dispatch");
    assert_eq!(
        String::from_utf8_lossy(&dispatch.body),
        "{\"ref\":\"refs/heads/devboard-build/v1.1.0\",\"inputs\":{\"tag\":\"v1.1.0\"}}"
    );

    let expected_manifest = {
        let mut assets = Vec::new();
        for target in RELEASE_TARGETS {
            let name = format!("devboard-{target}.tar.xz");
            assets.push(json!({
                "target": target,
                "url": format!("{}/gh-assets/{name}", live.github_server.base),
                "sha256": sha256_hex(&asset_bytes(&name)),
            }));
        }
        let value = json!({
            "version": version,
            "tag": tag,
            "assets": assets,
        });
        jsjson::stringify(&value)
    };
    assert_eq!(report.manifest, expected_manifest);
    assert!(
        live.github_stub
            .uploaded()
            .contains(&"devboard-manifest.json".to_string()),
        "the public GitHub release carries the manifest: {:?}",
        live.github_stub.uploaded()
    );
    let stored = live
        .gitea_stub
        .release_bytes(tag, "devboard-manifest.json")
        .expect("the Gitea manifest");
    assert_eq!(stored, report.manifest.as_bytes());
    assert!(
        live.gitea_stub.release_bytes(tag, "sha256.sum").is_some(),
        "the Gitea release mirrors the unified checksum"
    );
    assert!(
        live.gitea_stub
            .release_bytes(tag, "devboard-x86_64-unknown-linux-gnu.tar.xz.sha256")
            .is_some(),
        "the Gitea release mirrors the platform checksum"
    );
    assert!(live
        .gitea_stub
        .release_bytes(tag, "devboard-manifest.json.sha256")
        .is_some());

    let request_path = live.state_dir.join("source-refresh/request.json");
    let bytes = fs::read(&request_path).expect("a source refresh request");
    let expected = {
        let mut text = jsjson::stringify(&json!({
            "schema": 1,
            "commit": commit,
            "version": version,
            "distDigest": expected_digest,
            "requestedAt": report.source_refresh.request.requested_at,
        }));
        text.push('\n');
        text
    };
    assert_eq!(String::from_utf8_lossy(&bytes), expected);
    assert_eq!(report.source_refresh.written.len(), 1);
    assert!(report.source_refresh.failed.is_empty());
    assert!(
        !live
            .state_dir
            .join("source-refresh")
            .read_dir()
            .expect("the source refresh directory")
            .any(|entry| entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")),
        "no staging file survives the atomic write"
    );

    // A rerun on the same commit completes and verifies the existing release
    // without bumping, tagging, dispatching again, or uploading again.
    fs::write(
        live.state_dir.join("source-refresh/applied.json"),
        format!(
            "{{\"commit\":\"{commit}\",\"version\":\"{version}\",\"distDigest\":\"{expected_digest}\",\"appliedAt\":\"2026-11-03T00:00:01.000Z\"}}\n"
        ),
    )
    .expect("an applied marker");
    let second_instance = DashboardInstance {
        pid: 4242,
        port: 7300,
        repo_dir: live.seed.clone(),
        harness: live.seed.join(".devboard"),
        state_dir: live.state_dir.clone(),
    };
    let mut second_args = test_args(
        &live.seed,
        &live.gitea_server,
        &live.github_server,
        Some(second_instance),
    );
    second_args.wait_timeout = Duration::from_secs(5);
    let second = publish(second_args).await.expect("a rerun");
    assert!(!second.published);
    assert_eq!(second.version, version);
    assert_eq!(second.tag, tag);
    assert_eq!(second.commit, commit);
    assert_eq!(live.github_stub.dispatch_count(), 1);
    assert_eq!(git_output(&live.seed, &["rev-parse", "HEAD"]), commit);
    assert_eq!(
        live.gitea_stub
            .release_bytes(tag, "devboard-manifest.json")
            .expect("the unchanged manifest"),
        report.manifest.as_bytes()
    );
    assert!(second.source_refresh.written.is_empty());
    assert_eq!(second.source_refresh.applied.len(), 1);
}

type LogLines = Arc<Mutex<Vec<String>>>;
type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// A publish log a test can read after the run.
fn recording_log() -> (LogLines, LogSink) {
    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = lines.clone();
    let log: LogSink = Arc::new(move |line: &str| {
        recorded.lock().expect("log").push(line.to_string());
    });
    (lines, log)
}

fn line_after(lines: &[String], needle: &str) -> usize {
    lines
        .iter()
        .position(|line| line.contains(needle))
        .unwrap_or_else(|| panic!("no line names {needle}: {lines:?}"))
}

#[tokio::test]
async fn ci_gate_waits_for_the_target_success_before_the_tag() {
    let live = live("ci-success", release_assets()).await;
    let (lines, log) = recording_log();
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.log = Some(log);
    let report = publish(args).await.expect("the release ships after CI");
    let commit = report.commit.clone();
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        commit,
        "the tag names the CI-proven commit"
    );
    let lines = lines.lock().expect("log").clone();
    let ci = line_after(&lines, "CI run 777");
    let push = line_after(&lines, "pushing v1.1.0 to origin");
    assert!(ci < push, "CI success precedes the tag push: {lines:?}");
    assert!(
        lines[ci].contains("concluded success"),
        "the CI line names its verdict: {lines:?}"
    );
}

#[tokio::test]
async fn ci_gate_refuses_every_non_success_conclusion() {
    for conclusion in ["failure", "cancelled", "timed_out", "startup_failure"] {
        let live = live(&format!("ci-{conclusion}"), release_assets()).await;
        live.gitea_stub.set_ci(CiState::Settles(conclusion));
        let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
        args.wait_timeout = Duration::from_secs(2);
        let error = publish(args)
            .await
            .expect_err("a non-success conclusion refuses the tag");
        let message = format!("{error:#}");
        assert!(
            message.contains("devboard-ci.yml run 777") && message.contains(conclusion),
            "{conclusion}: {message}"
        );
        assert!(
            git_output(&live.seed, &["tag", "--list", "v1.1.0"])
                .trim()
                .is_empty(),
            "{conclusion}: no local tag survives"
        );
        assert!(
            git_output(&live.origin, &["tag", "--list", "v1.1.0"])
                .trim()
                .is_empty(),
            "{conclusion}: no tag reaches the forge"
        );
        assert_eq!(
            git_output(&live.origin, &["log", "-1", "--format=%s"]),
            "chore(release): v1.1.0",
            "{conclusion}: the branch keeps the commit for the next tick"
        );
        assert_eq!(live.github_stub.dispatch_count(), 0);
    }
}

#[tokio::test]
async fn ci_gate_waits_for_an_in_progress_run() {
    let live = live("ci-in-progress", release_assets()).await;
    live.gitea_stub.set_ci(CiState::Wait(2));
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.poll_interval = Duration::from_millis(5);
    let report = publish(args)
        .await
        .expect("the run settles and the tag lands");
    assert!(report.published);
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        report.commit
    );
    let reads = live.gitea_stub.state.lock().expect("gitea").ci_reads;
    assert!(reads > 2, "the gate read the run until it settled: {reads}");
}

#[tokio::test]
async fn ci_gate_times_out_without_a_run() {
    let live = live("ci-absent", release_assets()).await;
    live.gitea_stub.set_ci(CiState::Absent);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_millis(60);
    args.poll_interval = Duration::from_millis(10);
    let error = publish(args)
        .await
        .expect_err("no run leaves the range unreleased");
    let message = format!("{error:#}");
    assert!(
        message.contains("no devboard-ci.yml run") && message.contains("within"),
        "{message}"
    );
    assert!(git_output(&live.seed, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
    assert!(git_output(&live.origin, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
}

/// The tag an origin push carries, when the invocation is one.
fn origin_push_tag(invocation: &CommandInvocation) -> Option<String> {
    if invocation.program != "git" {
        return None;
    }
    let position = invocation.args.iter().position(|arg| arg == "push")?;
    if invocation.args.get(position + 1).map(String::as_str) != Some("origin") {
        return None;
    }
    invocation
        .args
        .iter()
        .find_map(|arg| arg.strip_prefix("refs/tags/"))
        .map(|rest| rest.split(':').next().unwrap_or(rest).to_string())
}

/// A runner whose origin push is answered as a forge that loses the answer:
/// with `landed` it runs the real push first, so the refs reach the forge
/// exactly as they would and only the exit status is lost.
struct PushAnswerRunner {
    stub: GiteaStub,
    origin: PathBuf,
    landed: bool,
    answered: AtomicUsize,
}

impl PushAnswerRunner {
    fn new(stub: GiteaStub, origin: PathBuf, landed: bool) -> Arc<Self> {
        Arc::new(Self {
            stub,
            origin,
            landed,
            answered: AtomicUsize::new(0),
        })
    }
}

impl CommandRunner for PushAnswerRunner {
    fn run<'a>(
        &'a self,
        invocation: CommandInvocation,
    ) -> Pin<Box<dyn Future<Output = CommandOutcome> + Send + 'a>> {
        Box::pin(async move {
            let Some(tag) = origin_push_tag(&invocation) else {
                return ProcessRunner.run(invocation).await;
            };
            if self.landed {
                let outcome = ProcessRunner.run(invocation).await;
                assert_eq!(
                    outcome.code, 0,
                    "the fixture push lands: {}",
                    outcome.stderr
                );
                let commit = git_output(&self.origin, &["rev-parse", "main"]);
                self.stub.accepted(&tag, &commit);
            }
            self.answered.fetch_add(1, Ordering::SeqCst);
            let stderr = if self.landed {
                "remote: ** Checking 2 references\n".to_string()
            } else {
                let lines = [
                    "remote: ** Checking 2 references".to_string(),
                    "remote: ** Checking references succeeded".to_string(),
                    "To origin".to_string(),
                    format!(" ! [rejected]        {tag} -> {tag} (already exists)"),
                    "error: failed to push some refs to 'origin'".to_string(),
                ];
                format!("{}\n", lines.join("\n"))
            };
            CommandOutcome {
                code: 1,
                stdout: String::new(),
                stderr,
            }
        })
    }
}

#[tokio::test]
async fn a_push_the_forge_already_accepted_does_not_fail_the_release() {
    let live = live("landed-push", release_assets()).await;
    let runner = PushAnswerRunner::new(live.gitea_stub.clone(), live.origin.clone(), true);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.runner = Some(runner.clone());
    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = lines.clone();
    args.log = Some(Arc::new(move |line: &str| {
        recorded.lock().expect("log").push(line.to_string());
    }));

    let report = publish(args)
        .await
        .expect("the refs the forge carries decide the push, not its exit status");
    let commit = git_output(&live.seed, &["rev-parse", "HEAD"]);
    assert!(report.published);
    assert_eq!(report.tag, "v1.1.0");
    assert_eq!(report.commit, commit);
    assert_eq!(runner.answered.load(Ordering::SeqCst), 1);
    assert_eq!(git_output(&live.origin, &["rev-parse", "main"]), commit);
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        commit
    );
    assert_eq!(live.github_stub.dispatch_count(), 1);
    assert!(
        live.gitea_stub
            .release_bytes("v1.1.0", "devboard-manifest.json")
            .is_some(),
        "the release continues past the push"
    );
    let lines = lines.lock().expect("log").clone();
    assert!(
        lines
            .iter()
            .any(|line| line.contains("the push exited nonzero after the refs moved")),
        "{lines:?}"
    );
}

#[tokio::test]
async fn a_refused_push_names_the_refusal_not_the_progress_line() {
    let live = live("refused-push", release_assets()).await;
    let runner = PushAnswerRunner::new(live.gitea_stub.clone(), live.origin.clone(), false);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.runner = Some(runner.clone());

    let error = publish(args)
        .await
        .expect_err("a push the forge does not carry fails the release");
    let message = format!("{error:#}");
    assert!(message.contains("could not push v1.1.0"), "{message}");
    assert!(
        message.contains("error: failed to push some refs"),
        "{message}"
    );
    assert!(message.contains("[rejected]"), "{message}");
    assert!(!message.contains("Checking 2 references"), "{message}");
    assert_eq!(runner.answered.load(Ordering::SeqCst), 1);
    assert_eq!(live.github_stub.dispatch_count(), 0);
}

/// A record-and-delegate runner: `bun run build` writes a bundle carrying
/// `asset`, the embed step copies it where the binary reads it, and every other
/// command reaches the real process runner.
struct RebuildRunner {
    asset: &'static str,
    builds: AtomicUsize,
    embeds: AtomicUsize,
}

impl CommandRunner for RebuildRunner {
    fn run<'a>(
        &'a self,
        invocation: CommandInvocation,
    ) -> Pin<Box<dyn Future<Output = CommandOutcome> + Send + 'a>> {
        Box::pin(async move {
            if invocation.program == "bun" {
                let arguments: Vec<&str> = invocation.args.iter().map(String::as_str).collect();
                return match arguments.as_slice() {
                    ["run", "build"] => {
                        self.builds.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(10));
                        fs::create_dir_all(invocation.cwd.join("dist/assets")).expect("the bundle");
                        fs::write(
                            invocation.cwd.join("dist/index.html"),
                            "<!doctype html><script src=\"/assets/app.js\"></script>\n",
                        )
                        .expect("an index");
                        fs::write(invocation.cwd.join("dist/assets/app.js"), self.asset)
                            .expect("an asset");
                        CommandOutcome {
                            code: 0,
                            stdout: String::new(),
                            stderr: String::new(),
                        }
                    }
                    ["scripts/embed-client.mjs"] => {
                        self.embeds.fetch_add(1, Ordering::SeqCst);
                        let embedded = invocation.cwd.join("crates/devboard/assets");
                        fs::create_dir_all(embedded.join("assets")).expect("the embed");
                        fs::copy(
                            invocation.cwd.join("dist/index.html"),
                            embedded.join("index.html"),
                        )
                        .expect("an embedded index");
                        fs::copy(
                            invocation.cwd.join("dist/assets/app.js"),
                            embedded.join("assets/app.js"),
                        )
                        .expect("an embedded asset");
                        CommandOutcome {
                            code: 0,
                            stdout: String::new(),
                            stderr: String::new(),
                        }
                    }
                    other => panic!("unexpected bun invocation {other:?}"),
                };
            }
            ProcessRunner.run(invocation).await
        })
    }
}

#[tokio::test]
async fn a_checkout_whose_sources_moved_rebuilds_and_embeds_before_proving_it() {
    let live = live("stale-bundle", release_assets()).await;
    // A source newer than the committed bundle, exactly what a refreshed
    // integration checkout leaves behind.
    std::thread::sleep(Duration::from_millis(10));
    let source = live.seed.join(".devboard/client/Row.svelte");
    fs::create_dir_all(source.parent().expect("a parent")).expect("the client tree");
    fs::write(&source, "<p></p>\n").expect("a newer source");

    // The rebuild reproduces the committed client byte for byte, so the embed
    // step leaves `crates/devboard/assets` unchanged and the release proceeds.
    let runner = Arc::new(RebuildRunner {
        asset: "console.log(\"devboard\");\n",
        builds: AtomicUsize::new(0),
        embeds: AtomicUsize::new(0),
    });
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.runner = Some(runner.clone());
    let report = publish(args)
        .await
        .expect("the stale bundle is rebuilt before it is proven");

    assert_eq!(report.version, "1.1.0");
    assert_eq!(runner.builds.load(Ordering::SeqCst), 1);
    assert_eq!(runner.embeds.load(Ordering::SeqCst), 1);
    assert_eq!(
        fs::read_to_string(live.seed.join(".devboard/dist/assets/app.js"))
            .expect("the rebuilt asset"),
        "console.log(\"devboard\");\n"
    );
    let pending = git_output(
        &live.seed,
        &[
            "status",
            "--porcelain",
            "--",
            ".devboard/crates/devboard/assets",
        ],
    );
    assert!(pending.is_empty(), "{pending}");
    assert_eq!(live.github_stub.dispatch_count(), 1);
}

#[tokio::test]
async fn a_rebuild_the_commit_does_not_carry_fails_before_the_tag() {
    let live = live("stale-rebuild", release_assets()).await;
    std::thread::sleep(Duration::from_millis(10));
    let source = live.seed.join(".devboard/client/Row.svelte");
    fs::create_dir_all(source.parent().expect("a parent")).expect("the client tree");
    fs::write(&source, "<p></p>\n").expect("a newer source");
    let head = git_output(&live.seed, &["rev-parse", "HEAD"]);

    // The rebuilt bundle no longer matches the copy the commit carries: the
    // embed step writes the working tree, and a tag would still ship the
    // previous bundle.
    let runner = Arc::new(RebuildRunner {
        asset: "console.log(\"built\");\n",
        builds: AtomicUsize::new(0),
        embeds: AtomicUsize::new(0),
    });
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.runner = Some(runner.clone());
    args.wait_timeout = Duration::from_secs(5);
    let error = publish(args)
        .await
        .expect_err("a rebuild the commit does not carry fails the release");
    let message = format!("{error:#}");
    assert!(message.contains("crates/devboard/assets"), "{message}");
    assert!(message.contains("not committed"), "{message}");
    assert_eq!(runner.embeds.load(Ordering::SeqCst), 1);

    // Nothing was bumped, tagged, pushed, or dispatched.
    assert_eq!(git_output(&live.seed, &["rev-parse", "HEAD"]), head);
    let local = git_output(&live.seed, &["tag", "--list", "v1.1.0"]);
    assert!(local.trim().is_empty(), "{local}");
    assert_eq!(live.github_stub.dispatch_count(), 0);
}

#[tokio::test]
async fn a_client_edit_that_was_never_embedded_fails_before_the_tag() {
    let live = live("stale-embed", release_assets()).await;
    // The bundle is fresh, but the copy the binary embeds still serves the
    // client from before the edit.
    std::thread::sleep(Duration::from_millis(10));
    let asset = live
        .seed
        .join(".devboard/crates/devboard/assets/assets/app.js");
    fs::write(&asset, "console.log(\"never embedded\");\n").expect("a stale embed");
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);

    let error = publish(args)
        .await
        .expect_err("a stale embedded client fails the release");
    let message = format!("{error:#}");
    assert!(message.contains("crates/devboard/assets"), "{message}");
    assert!(message.contains("differs from dist"), "{message}");
    assert_eq!(live.github_stub.dispatch_count(), 0);
}

#[tokio::test]
async fn a_revoked_gitea_credential_fails_before_the_tag_is_pushed() {
    let live = live("credential-revoked", release_assets()).await;
    live.gitea_stub.set_credential(GiteaCredential::Invalid);
    let head = git_output(&live.seed, &["rev-parse", "HEAD"]);
    let origin_head = git_output(&live.origin, &["rev-parse", "main"]);
    let github_head = git_output(&live.github, &["rev-parse", "main"]);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    let error = publish(args)
        .await
        .expect_err("a revoked credential refuses the release");
    let message = format!("{error:#}");
    assert!(message.contains("HTTP 401"), "{message}");
    assert!(
        message.contains("invalid username, password or token"),
        "{message}"
    );

    // Nothing was bumped, tagged, pushed, or dispatched.
    assert_eq!(git_output(&live.seed, &["rev-parse", "HEAD"]), head);
    let local = git_output(&live.seed, &["tag", "--list", "v1.1.0"]);
    assert!(local.trim().is_empty(), "{local}");
    let published = git_output(&live.origin, &["tag", "--list", "v1.1.0"]);
    assert!(published.trim().is_empty(), "{published}");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        origin_head
    );
    assert_eq!(
        git_output(&live.github, &["rev-parse", "main"]),
        github_head
    );
    assert_eq!(live.github_stub.dispatch_count(), 0);
    assert!(live
        .gitea_server
        .find("POST", "/api/v1/repos/dsdenes/devboard/releases")
        .is_none());
}

#[tokio::test]
async fn a_read_only_gitea_credential_fails_before_the_tag_is_pushed() {
    let live = live("credential-read-only", release_assets()).await;
    live.gitea_stub.set_credential(GiteaCredential::ReadOnly);
    let origin_head = git_output(&live.origin, &["rev-parse", "main"]);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    let error = publish(args)
        .await
        .expect_err("a read-only credential refuses the release");
    let message = format!("{error:#}");
    assert!(message.contains("cannot create a release"), "{message}");
    assert!(message.contains("repository write access"), "{message}");

    let local = git_output(&live.seed, &["tag", "--list", "v1.1.0"]);
    assert!(local.trim().is_empty(), "{local}");
    let published = git_output(&live.origin, &["tag", "--list", "v1.1.0"]);
    assert!(published.trim().is_empty(), "{published}");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        origin_head
    );
    assert_eq!(live.github_stub.dispatch_count(), 0);
    assert!(live
        .gitea_server
        .find("POST", "/api/v1/repos/dsdenes/devboard/releases")
        .is_none());
}

#[tokio::test]
async fn a_stale_checkout_rederives_from_the_forge_release() {
    let scratch = Scratch::new("rederive");
    let (origin, github) = origin_repository(&scratch.root);
    let seed = scratch.root.join("seed");
    git_init(&seed);
    write_harness(&seed);
    git_origin(&seed, &origin, &github);
    git_output(&seed, &["add", "-A"]);
    let first = commit_file(&seed, "README.md", "base\n", "feat: base");
    git_output(&seed, &["tag", "v1.0.0"]);
    git_output(&seed, &["push", "-q", "origin", "main", "v1.0.0"]);
    let released = commit_file(
        &seed,
        "README.md",
        "released\n",
        "feat: the release the checkout cannot see",
    );
    git_output(&seed, &["push", "-q", "origin", "main"]);
    commit_file(&seed, "README.md", "after\n", "fix: after that release");
    git_output(&seed, &["push", "-q", "origin", "main"]);
    // The checkout never fetched v1.1.0; only the forge names it.

    let mut refs = BTreeMap::new();
    refs.insert("v1.0.0".to_string(), first);
    refs.insert("v1.1.0".to_string(), released);
    let gitea = GiteaStub::start(
        seed.clone(),
        refs,
        vec!["v1.0.0".to_string(), "v1.1.0".to_string()],
    )
    .await;
    let github = GithubStub::start(seed.clone(), release_assets(), Vec::new(), true).await;
    let mut args = test_args(&seed, &gitea.server, &github.server, None);
    args.wait_timeout = Duration::from_secs(5);
    let report = publish(args).await.expect("a rederived release");
    assert_eq!(report.version, "1.1.1");
    assert!(report.published);
}

#[tokio::test]
async fn a_missing_platform_asset_fails_the_verification() {
    let mut assets = release_assets();
    assets.remove("devboard-installer.sh");
    let live = live("missing-asset", assets).await;
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_millis(60);
    args.poll_interval = Duration::from_millis(10);
    let error = publish(args).await.expect_err("a missing installer fails");
    let message = format!("{error:#}");
    assert!(message.contains("GitHub assets"), "{message}");
    assert!(message.contains("devboard-installer.sh"), "{message}");
}

#[tokio::test]
async fn a_wrong_checksum_fails_the_verification() {
    let mut assets = release_assets();
    assets.insert(
        "devboard-x86_64-unknown-linux-gnu.tar.xz.sha256".to_string(),
        b"0000000000000000000000000000000000000000000000000000000000000000  devboard-x86_64-unknown-linux-gnu.tar.xz\n".to_vec(),
    );
    let live = live("checksum", assets).await;
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_millis(60);
    args.poll_interval = Duration::from_millis(10);
    let error = publish(args).await.expect_err("a bad checksum fails");
    let message = format!("{error:#}");
    assert!(
        message.contains("does not match its checksum asset"),
        "{message}"
    );
}

#[tokio::test]
async fn an_empty_workflow_wait_times_out() {
    let mut live = live("timeout", release_assets()).await;
    let clock = FakeClock::new(0);
    let sleeper = Arc::new(FakeSleeper {
        clock: clock.clone(),
        step: 50,
    });
    let github = GithubStub::start(live.seed.clone(), BTreeMap::new(), Vec::new(), false).await;
    live.github_server = github.server;
    live.github_stub = github.stub;
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_millis(100);
    args.poll_interval = Duration::from_millis(50);
    args.clock = Some(clock);
    args.sleeper = Some(sleeper);
    let error = publish(args).await.expect_err("the wait is bounded");
    assert!(
        format!("{error:#}").contains("no release workflow run"),
        "{error:#}"
    );
}

#[tokio::test]
async fn a_cancelled_workflow_names_the_job_and_step_that_failed() {
    let mut live = live("cancelled-run", release_assets()).await;
    let github = GithubStub::start(live.seed.clone(), BTreeMap::new(), Vec::new(), true).await;
    github.stub.settle_with(
        "cancelled",
        json!({
            "total_count": 2,
            "jobs": [
                {
                    "name": "build-local-artifacts (x86_64-unknown-linux-gnu)",
                    "status": "completed",
                    "conclusion": "failure",
                    "steps": [
                        {"name": "Set up job", "conclusion": "success"},
                        {"name": "enable windows longpaths", "conclusion": "failure"},
                    ],
                },
                {
                    "name": "build-local-artifacts (aarch64-apple-darwin)",
                    "status": "completed",
                    "conclusion": "cancelled",
                    "steps": [{"name": "checkout", "conclusion": "cancelled"}],
                },
            ],
        }),
    );
    live.github_server = github.server;
    live.github_stub = github.stub;
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.poll_interval = Duration::from_millis(10);
    let error = publish(args)
        .await
        .expect_err("a cancelled run fails the release");
    let message = format!("{error:#}");
    assert!(message.contains("concluded cancelled"), "{message}");
    assert!(
        message.contains(
            "build-local-artifacts (x86_64-unknown-linux-gnu) failed at enable windows longpaths"
        ),
        "{message}"
    );
    assert!(
        !message.contains("aarch64-apple-darwin"),
        "a cancelled sibling is not a cause: {message}"
    );
}

#[tokio::test]
async fn a_transient_dispatch_refusal_is_retried_within_the_wait() {
    let live = live("dispatch-retry", release_assets()).await;
    live.github_stub.fail_next_dispatch(500);
    live.github_stub.fail_next_dispatch(502);
    let clock = FakeClock::new(0);
    let sleeper = Arc::new(FakeSleeper {
        clock: clock.clone(),
        step: 50,
    });
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.instances = Some(Vec::new());
    args.wait_timeout = Duration::from_secs(10);
    args.poll_interval = Duration::from_millis(50);
    args.clock = Some(clock);
    args.sleeper = Some(sleeper);
    let report = publish(args)
        .await
        .expect("a transient dispatch refusal is retried");
    assert_eq!(report.workflow_run, Some(42));
    assert_eq!(live.github_stub.dispatch_attempts(), 3);
    assert_eq!(live.github_stub.dispatch_count(), 1);
}

#[tokio::test]
async fn a_refused_dispatch_fails_without_retrying() {
    let live = live("dispatch-refused", release_assets()).await;
    live.github_stub.fail_next_dispatch(404);
    let clock = FakeClock::new(0);
    let sleeper = Arc::new(FakeSleeper {
        clock: clock.clone(),
        step: 50,
    });
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.instances = Some(Vec::new());
    args.wait_timeout = Duration::from_secs(10);
    args.poll_interval = Duration::from_millis(50);
    args.clock = Some(clock);
    args.sleeper = Some(sleeper);
    let error = publish(args)
        .await
        .expect_err("a refused dispatch fails the run");
    let message = format!("{error:#}");
    assert!(message.contains("HTTP 404"), "{message}");
    assert_eq!(live.github_stub.dispatch_attempts(), 1);
}

#[tokio::test]
async fn the_workflow_verdict_reads_the_run_once_more_at_the_deadline() {
    let mut live = live("settle", release_assets()).await;
    // Reads: one for the dispatch decision, two polls before the deadline, and
    // the final read the verdict takes — the run settles before that last one.
    let github = GithubStub::settling_after(live.seed.clone(), release_assets(), 3).await;
    live.github_server = github.server;
    live.github_stub = github.stub;
    let clock = FakeClock::new(0);
    let sleeper = Arc::new(FakeSleeper {
        clock: clock.clone(),
        step: 50,
    });
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_millis(100);
    args.poll_interval = Duration::from_millis(50);
    args.clock = Some(clock);
    args.sleeper = Some(sleeper);
    let report = publish(args)
        .await
        .expect("the run that settled after the last poll is followed");
    assert_eq!(report.workflow_run, Some(42));
    assert_eq!(live.github_stub.dispatch_count(), 0);
}

#[tokio::test]
async fn a_failed_workflow_withdraws_the_tag_it_created() {
    let live = live("withdraw", release_assets()).await;
    live.github_stub.settle_with("cancelled", json!({}));
    live.github_stub.release_exists(false);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.instances = Some(Vec::new());
    args.wait_timeout = Duration::from_secs(5);
    let error = publish(args)
        .await
        .expect_err("a cancelled run fails the release");
    assert!(
        format!("{error:#}").contains("concluded cancelled"),
        "{error:#}"
    );
    assert!(
        git_output(&live.seed, &["tag", "--list", "v1.1.0"]).is_empty(),
        "the failed release leaves no tag in the checkout"
    );
    assert!(
        git_output(&live.origin, &["tag", "--list", "v1.1.0"]).is_empty(),
        "the failed release leaves no tag on the origin"
    );
    assert!(
        git_output(&live.github, &["tag", "--list", "v1.1.0"]).is_empty(),
        "the failed release leaves no tag on the mirror"
    );
}

#[tokio::test]
async fn a_withdrawn_release_reuses_the_committed_version_bump() {
    let live = live("withdraw-retry", release_assets()).await;
    live.github_stub.settle_with("cancelled", json!({}));
    live.github_stub.release_exists(false);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.instances = Some(Vec::new());
    args.wait_timeout = Duration::from_secs(5);
    publish(args).await.expect_err("the first attempt fails");
    let bumped = git_output(&live.seed, &["rev-parse", "HEAD"]);

    live.github_stub.settle_with("success", json!({}));
    live.github_stub.release_exists(true);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.instances = Some(Vec::new());
    args.wait_timeout = Duration::from_secs(5);
    let report = publish(args)
        .await
        .expect("the retry releases the withdrawn version");

    assert_eq!(report.version, "1.1.0");
    assert_eq!(report.tag, "v1.1.0");
    assert!(report.published);
    assert_eq!(
        git_output(&live.seed, &["rev-parse", "HEAD"]),
        bumped,
        "the retry commits no second version bump"
    );
    let log = git_output(&live.seed, &["log", "--format=%s"]);
    assert_eq!(
        log.lines()
            .filter(|line| *line == "chore(release): v1.1.0")
            .count(),
        1,
        "{log}"
    );
    assert_eq!(
        git_output(&live.seed, &["rev-parse", "v1.1.0^{commit}"]),
        bumped
    );
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        bumped
    );
}

// ---------------------------------------------------------------------------
// Source refresh dedupe and the shared lock

#[tokio::test]
async fn source_refresh_dedupes_against_applied() {
    let scratch = Scratch::new("dedupe");
    let app = scratch.root.join("repo");
    git_init(&app);
    write_harness(&app);
    let state_dir = scratch.root.join("state");
    let instance = DashboardInstance {
        pid: 7,
        port: 7100,
        repo_dir: app.clone(),
        harness: app.join(".devboard"),
        state_dir: state_dir.clone(),
    };
    let options = SourceRefreshOptions {
        repo_root: app.clone(),
        harness_root: app.join(".devboard"),
        commit: "a".repeat(40),
        version: "1.2.3".to_string(),
        dist_dir: app.join(".devboard/dist"),
        instances: vec![instance.clone()],
        requested_at: "2026-11-03T00:00:00.000Z".to_string(),
    };
    let first = deliver_source_refresh(options.clone())
        .await
        .expect("a request");
    assert_eq!(first.written.len(), 1);
    assert!(first.applied.is_empty());

    fs::create_dir_all(state_dir.join("source-refresh")).expect("the directory");
    fs::write(
        state_dir.join("source-refresh/applied.json"),
        format!(
            "{{\"commit\":\"{}\",\"version\":\"1.2.3\",\"distDigest\":\"{}\",\"appliedAt\":\"2026-11-03T00:00:01.000Z\"}}\n",
            "a".repeat(40),
            dist_digest(&app.join(".devboard/dist")).expect("a digest")
        ),
    )
    .expect("an applied marker");
    let second = deliver_source_refresh(options)
        .await
        .expect("a deduped delivery");
    assert!(second.written.is_empty());
    assert_eq!(second.applied.len(), 1);
}

#[tokio::test]
async fn the_release_lock_serialises_two_releases() {
    let scratch = Scratch::new("lock");
    let path = scratch.root.join("release.lock");
    let first = acquire_release_lock(ReleaseLockOptions {
        path: path.clone(),
        repo_dir: scratch.root.clone(),
        state_dir: scratch.root.join("state"),
        timeout: Duration::from_secs(2),
        poll_interval: Duration::from_millis(5),
        argv: vec!["devboard".to_string(), "publish".to_string()],
        clock: None,
        sleeper: None,
        log: None,
    })
    .await
    .expect("the first lock");
    let waiter = {
        let path = path.clone();
        let root = scratch.root.clone();
        tokio::spawn(async move {
            acquire_release_lock(ReleaseLockOptions {
                path,
                repo_dir: root.clone(),
                state_dir: root.join("state"),
                timeout: Duration::from_secs(2),
                poll_interval: Duration::from_millis(5),
                argv: vec!["devboard".to_string(), "publish".to_string()],
                clock: None,
                sleeper: None,
                log: None,
            })
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!waiter.is_finished(), "the second release waits");
    drop(first);
    let second = tokio::time::timeout(Duration::from_secs(2), waiter)
        .await
        .expect("the waiter settles")
        .expect("the waiter task")
        .expect("the second lock");
    assert!(path.exists(), "the second release holds the lock");
    drop(second);
    assert!(!path.exists());
}

#[tokio::test]
async fn the_workflow_choice_prefers_an_active_run_then_a_success() {
    use devboard::publish::{choose_workflow_run, WorkflowRun};
    let commit = "a".repeat(40);
    let runs = vec![
        WorkflowRun {
            id: 1,
            head_sha: commit.clone(),
            status: "completed".to_string(),
            conclusion: Some("failure".to_string()),
        },
        WorkflowRun {
            id: 2,
            head_sha: commit.clone(),
            status: "in_progress".to_string(),
            conclusion: None,
        },
        WorkflowRun {
            id: 3,
            head_sha: commit.clone(),
            status: "completed".to_string(),
            conclusion: Some("success".to_string()),
        },
    ];
    assert_eq!(
        choose_workflow_run(&runs, &commit).map(|run| run.id),
        Some(2)
    );
    let done = vec![
        WorkflowRun {
            id: 4,
            head_sha: commit.clone(),
            status: "completed".to_string(),
            conclusion: Some("failure".to_string()),
        },
        WorkflowRun {
            id: 5,
            head_sha: commit.clone(),
            status: "completed".to_string(),
            conclusion: Some("success".to_string()),
        },
    ];
    assert_eq!(
        choose_workflow_run(&done, &commit).map(|run| run.id),
        Some(5)
    );
}

#[test]
fn two_live_dashboards_render_one_inventory_row_each() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("publish-inventory-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let mut instances = Vec::new();
    for (index, (running, installed)) in [("1.0.0", "1.1.0"), ("2.0.0", "2.0.0")]
        .into_iter()
        .enumerate()
    {
        let host = root.join(format!("host-{index}"));
        let state = host.join(".devboard/.tmp");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(
            host.join(".devboard/devboard.json"),
            format!("{{\"name\":\"@dsdenes/devboard\",\"version\":\"{installed}\"}}\n"),
        )
        .unwrap();
        std::fs::write(
            state.join("version.json"),
            format!(
                "{{\"running\":\"{running}\",\"pid\":{},\"port\":{}}}",
                100 + index,
                9000 + index
            ),
        )
        .unwrap();
        instances.push(devboard::publish::DashboardInstance {
            pid: 100 + index as u32,
            port: 9000 + index as u16,
            repo_dir: host.clone(),
            harness: host.join(".devboard"),
            state_dir: state,
        });
    }
    let inventory = devboard::publish::dashboard_inventory(&instances);
    assert_eq!(inventory.len(), 2);
    assert_eq!(inventory[0].port, 9000);
    assert_eq!(inventory[0].running.as_deref(), Some("1.0.0"));
    assert_eq!(inventory[0].installed.as_deref(), Some("1.1.0"));
    assert!(inventory[0].stale);
    assert_eq!(inventory[1].running.as_deref(), Some("2.0.0"));
    assert_eq!(inventory[1].installed.as_deref(), Some("2.0.0"));
    assert!(!inventory[1].stale);
    let _ = std::fs::remove_dir_all(&root);
}

fn bundle_root(label: &str) -> std::path::PathBuf {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("publish-bundle-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("client")).unwrap();
    std::fs::write(root.join("client/App.svelte"), "<script></script>\n").unwrap();
    std::fs::create_dir_all(root.join("dist/assets")).unwrap();
    std::fs::write(
        root.join("dist/index.html"),
        "<!doctype html><script src=\"/assets/app.js\"></script>\n",
    )
    .unwrap();
    std::fs::write(root.join("dist/assets/app.js"), "console.log(1);\n").unwrap();
    std::fs::create_dir_all(root.join("crates/devboard/assets/assets")).unwrap();
    std::fs::write(
        root.join("crates/devboard/assets/index.html"),
        "<!doctype html><script src=\"/assets/app.js\"></script>\n",
    )
    .unwrap();
    std::fs::write(
        root.join("crates/devboard/assets/assets/app.js"),
        "console.log(1);\n",
    )
    .unwrap();
    root
}

#[test]
fn the_bundle_preflight_refuses_every_damaged_input() {
    let root = bundle_root("refusals");
    verify_release_bundle(&root).expect("a fresh bundle passes");

    // A source newer than the bundle.
    std::thread::sleep(Duration::from_millis(10));
    std::fs::write(root.join("client/Row.svelte"), "<p></p>\n").unwrap();
    let error = verify_release_bundle(&root).expect_err("a stale bundle is refused");
    assert!(
        error.to_string().contains("older than its sources"),
        "{error}"
    );
    std::fs::remove_file(root.join("client/Row.svelte")).unwrap();

    // An index reference with no file behind it.
    std::fs::write(
        root.join("dist/index.html"),
        "<!doctype html><script src=\"/assets/missing.js\"></script>\n",
    )
    .unwrap();
    let error = verify_release_bundle(&root).expect_err("a missing asset is refused");
    assert!(error.to_string().contains("/assets/missing.js"), "{error}");
    std::fs::write(
        root.join("dist/index.html"),
        "<!doctype html><script src=\"/assets/app.js\"></script>\n",
    )
    .unwrap();

    // An embedded copy that no longer matches the built bundle.
    std::fs::write(
        root.join("crates/devboard/assets/assets/app.js"),
        "console.log(2);\n",
    )
    .unwrap();
    let error = verify_release_bundle(&root).expect_err("a stale embed is refused");
    assert!(
        error.to_string().contains("crates/devboard/assets"),
        "{error}"
    );
    std::fs::write(
        root.join("crates/devboard/assets/assets/app.js"),
        "console.log(1);\n",
    )
    .unwrap();

    // A staged manifest with no checksum, then a wrong one.
    let manifest = serde_json::json!({
        "version": "1.2.3",
        "tag": "v1.2.3",
        "assets": [],
    });
    let bytes = serde_json::to_vec(&manifest).unwrap();
    std::fs::write(root.join("devboard-manifest.json"), &bytes).unwrap();
    let error = verify_release_bundle(&root).expect_err("a missing checksum is refused");
    assert!(
        error.to_string().contains("devboard-manifest.json.sha256"),
        "{error}"
    );
    std::fs::write(
        root.join("devboard-manifest.json.sha256"),
        "0000000000000000000000000000000000000000000000000000000000000000  devboard-manifest.json\n",
    )
    .unwrap();
    let error = verify_release_bundle(&root).expect_err("a wrong checksum is refused");
    assert!(error.to_string().contains("does not match"), "{error}");
    let digest = bundle_sha256_hex(&bytes);
    std::fs::write(
        root.join("devboard-manifest.json.sha256"),
        format!("{digest}  devboard-manifest.json\n"),
    )
    .unwrap();

    // A manifest whose version and tag disagree.
    let mismatched = serde_json::json!({
        "version": "1.2.3",
        "tag": "v9.9.9",
        "assets": [],
    });
    let bytes = serde_json::to_vec(&mismatched).unwrap();
    std::fs::write(root.join("devboard-manifest.json"), &bytes).unwrap();
    let digest = bundle_sha256_hex(&bytes);
    std::fs::write(
        root.join("devboard-manifest.json.sha256"),
        format!("{digest}  devboard-manifest.json\n"),
    )
    .unwrap();
    let error = verify_release_bundle(&root).expect_err("a version/tag mismatch is refused");
    assert!(
        error.to_string().contains("differs from its tag"),
        "{error}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

fn bundle_sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
