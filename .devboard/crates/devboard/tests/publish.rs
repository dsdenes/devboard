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
    parse_subject, publish, subject_rule, Clock, CommandInvocation, CommandOutcome, CommandRunner,
    CommitRecord, DashboardInstance, ProcessRunner, PublishArgs, ReleaseLevel, ReleaseLockOptions,
    Sleeper, SourceRefreshOptions, RELEASE_INSTALLERS, RELEASE_TARGETS,
};
use devboard::release_suite::{
    attempt_line, BoxFuture, ReleaseSuiteGate, ReleaseSuiteOptions, ReleaseSuiteReport,
    RELEASE_SUITE_MAX_ATTEMPTS,
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

/// A minimal Gitea stub for a publish that must reach its own refusal: the
/// repository read proves write access, release lookups answer 404, and every
/// other route answers an empty list.
fn writable_gitea(request: &RecordedRequest) -> StubResponse {
    if request.method == "GET" && request.path == "/api/v1/repos/dsdenes/devboard" {
        return json_response(json!({
            "full_name": "dsdenes/devboard",
            "private": false,
            "permissions": {"admin": false, "push": true, "pull": true},
        }));
    }
    if request
        .path
        .starts_with("/api/v1/repos/dsdenes/devboard/releases/tags/")
    {
        return not_found();
    }
    json_response(json!([]))
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
    /// How many restarts the gate asked the forge for.
    rerun_count: usize,
    /// The CI reads answered since the last restart.
    reads_since_rerun: usize,
    /// Whether the run's job read is refused.
    jobs_refused: bool,
}

/// How the Gitea CI stub answers the gate's reads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CiState {
    /// One settled success for the pushed commit.
    Success,
    /// An in-progress run for this many reads, then a settled success.
    Wait(usize),
    /// A settled failure, then a restart that succeeds.
    RerunRecovers,
    /// A settled failure, then a restart that settles with this conclusion.
    RerunFails(&'static str),
    /// A settled run with this conclusion whose restart the forge refuses.
    RerunRefused(&'static str),
    /// No run for the commit.
    Absent,
    /// A run the forge never starts and no runner claims a job for.
    Queued,
    /// A refused `actions/runs` read, so the gate never reaches the forge.
    ReadRefused,
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
            rerun_count: 0,
            reads_since_rerun: 0,
            jobs_refused: false,
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

    /// Refuses every read of a run's jobs, so the gate keeps the run verdict.
    fn refuse_jobs(&self) {
        self.state.lock().expect("gitea").jobs_refused = true;
    }

    /// How many restarts the gate asked the forge for.
    fn rerun_count(&self) -> usize {
        self.state.lock().expect("gitea").rerun_count
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
        if data.ci == CiState::ReadRefused {
            return StubResponse {
                status: 404,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: br#"{"message":"the actions read is refused"}"#.to_vec(),
            };
        }
        if data.rerun_count > 0 {
            data.reads_since_rerun += 1;
        }
        // Gitea lists one run per pushed commit. Answering the newest few
        // models that, so a run for the pinned target is still listed after a
        // landing moves the checkout.
        let heads: Vec<String> = git_output(repo_dir, &["rev-list", "--max-count=8", "--all"])
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect();
        // A restart answers the same commit with its own run, so the gate
        // follows a run id the settled failure did not name.
        let restarted = data.rerun_count > 0;
        let id = if restarted { 778 } else { 777 };
        let (status, conclusion) = match data.ci {
            CiState::Success => ("completed", Some("success".to_string())),
            CiState::Wait(after) if data.ci_reads <= after => ("in_progress", None),
            CiState::Wait(_) => ("completed", Some("success".to_string())),
            CiState::RerunRecovers if !restarted => ("completed", Some("failure".to_string())),
            CiState::RerunRecovers if data.reads_since_rerun == 1 => ("in_progress", None),
            CiState::RerunRecovers => ("completed", Some("success".to_string())),
            CiState::RerunFails(conclusion) | CiState::RerunRefused(conclusion) if !restarted => {
                ("completed", Some(conclusion.to_string()))
            }
            CiState::RerunFails(_) if data.reads_since_rerun == 1 => ("in_progress", None),
            CiState::RerunFails(conclusion) => ("completed", Some(conclusion.to_string())),
            CiState::RerunRefused(conclusion) => ("completed", Some(conclusion.to_string())),
            CiState::Absent => ("completed", Some("success".to_string())),
            CiState::Queued => ("waiting", None),
            CiState::ReadRefused => ("completed", None),
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
            let mut runs = vec![
                // A foreign workflow and a foreign commit prove the gate
                // filters by both.
                json!({
                    "id": 901,
                    "path": "another-workflow.yml@refs/heads/main",
                    "head_sha": heads.first().cloned().unwrap_or_default(),
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
            ];
            for sha in &heads {
                runs.push(json!({
                    "id": id,
                    "path": "devboard-ci.yml@refs/heads/main",
                    "head_sha": sha,
                    "status": status,
                    "conclusion": conclusion,
                }));
            }
            runs
        };
        return json_response(json!({"workflow_runs": runs}));
    }
    if request.method == "POST" && path == format!("{repo}/actions/runs/777/rerun") {
        let mut data = state.lock().expect("gitea");
        if let CiState::RerunRefused(conclusion) = data.ci {
            return StubResponse {
                status: 403,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: format!(
                    r#"{{"message":"the run concluded {conclusion} and cannot be re-run"}}"#
                )
                .into_bytes(),
            };
        }
        data.rerun_count += 1;
        data.reads_since_rerun = 0;
        return StubResponse {
            status: 201,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: json!({
                "id": 778,
                "path": "devboard-ci.yml@refs/heads/main",
                "status": "queued",
            })
            .to_string()
            .into_bytes(),
        };
    }
    if request.method == "GET"
        && (path == format!("{repo}/actions/runs/777/jobs")
            || path == format!("{repo}/actions/runs/778/jobs"))
    {
        // The gate reads a run's jobs only for a run it refuses, so the stub
        // reports the job and the step that failed. A run no runner ever
        // claimed has no job to report.
        let data = state.lock().expect("gitea");
        if data.jobs_refused {
            return StubResponse {
                status: 404,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: br#"{"message":"the run's jobs cannot be read"}"#.to_vec(),
            };
        }
        if data.ci == CiState::Queued {
            return json_response(json!({"total_count": 0, "jobs": []}));
        }
        return json_response(json!({
            "total_count": 1,
            "jobs": [{
                "id": 5,
                "run_id": if path.contains("/778/") { 778 } else { 777 },
                "name": "check",
                "status": "completed",
                "conclusion": "failure",
                "steps": [
                    {
                        "number": 1,
                        "name": "Check out the repository",
                        "status": "completed",
                        "conclusion": "success",
                    },
                    {
                        "number": 2,
                        "name": "Test",
                        "status": "completed",
                        "conclusion": "failure",
                    },
                ],
            }],
        }));
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
        let Some(_sha) = data.refs.get(&tag) else {
            return not_found();
        };
        // A Gitea/Forgejo release answers one tag ref as a one-element array,
        // and an annotated tag names a tag object rather than its commit.
        return json_response(Value::Array(vec![json!({
            "ref": format!("refs/tags/{tag}"),
            "object": {"sha": tag_object_sha(&tag), "type": "tag"},
        })]));
    }
    if let Some(sha) = path.strip_prefix(&format!("{repo}/git/tags/")) {
        let data = state.lock().expect("gitea");
        let Some((tag, commit)) = data.refs.iter().find(|(tag, _)| tag_object_sha(tag) == sha)
        else {
            return not_found();
        };
        return json_response(json!({
            "tag": format!("v{tag}"),
            "object": {"sha": commit, "type": "commit"},
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
    /// When set, the runs list answers this commit instead of the checkout's
    /// HEAD, so a test can model a run the forge no longer lists by sha.
    run_head_sha: Option<String>,
    /// Whether the temporary build ref was deleted.
    build_ref_deleted: bool,
    /// The build ref the last dispatch named, so the runs list reports its
    /// commit as the run's head.
    build_ref: Option<String>,
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
            run_head_sha: None,
            build_ref_deleted: false,
            build_ref: None,
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

    /// Stops the runs list from naming the published commit.
    fn forget_run_for_commit(&self) {
        self.state.lock().expect("github").run_head_sha = Some("e".repeat(40));
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

/// The commit a checkout's `github` remote names for one tag's build ref, when
/// a release pushed it. The stub reads the mirror the way GitHub reports a
/// dispatched run's `head_sha`.
fn mirror_ref_commit(repo_dir: &Path, reference: &str) -> Option<String> {
    let mirror = Command::new("git")
        .args(["-C", repo_dir.to_string_lossy().as_ref()])
        .args(["config", "--get", "remote.github.url"])
        .output()
        .ok()?;
    if !mirror.status.success() {
        return None;
    }
    let mirror = String::from_utf8_lossy(&mirror.stdout).trim().to_string();
    let leaked = Command::new("git")
        .arg("-C")
        .arg(&mirror)
        .args(["rev-parse", "--verify", &format!("{reference}^{{commit}}")])
        .output()
        .ok()?;
    if !leaked.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&leaked.stdout).trim().to_string())
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
        if settled && data.settled_conclusion == "success" {
            // The successful workflow publishes the GitHub release the job
            // built its assets for.
            data.release_published = true;
        }
        let head_named = data.settle_after.is_some();
        let runs = if settled || head_named {
            // The dispatched run's head is the temporary build ref's commit,
            // exactly as GitHub reports it: the release commit, which is not
            // the integration checkout's HEAD once the release is pinned.
            let head = data
                .build_ref
                .clone()
                .and_then(|reference| mirror_ref_commit(repo_dir, &reference))
                .or_else(|| mirror_ref_commit(repo_dir, "refs/heads/devboard-build/v1.1.0"))
                .unwrap_or_else(|| git_output(repo_dir, &["rev-parse", "HEAD"]));
            let listed = data.run_head_sha.clone();
            let sha = listed.as_deref().unwrap_or(head.as_str());
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
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        if let Some(reference) = body.get("ref").and_then(Value::as_str) {
            data.build_ref = Some(reference.to_string());
        }
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
    if request.method == "PATCH" && path.starts_with("/repos/dsdenes/devboard/releases/") {
        return json_response(json!({"id": 7, "draft": false, "tag_name": "v1.1.0"}));
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

/// A stable fake tag-object id for one tag name, so the stub can answer the
/// annotated-tag route the forge serves.
fn tag_object_sha(tag: &str) -> String {
    sha256_hex(tag.as_bytes())[..40].to_string()
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

/// A gate that records the workspace directory it received and that
/// directory's `HEAD`, so a test can prove the pinned commit's tree is what
/// runs.
struct SuiteTreeGate {
    seen: Arc<Mutex<Option<(PathBuf, String)>>>,
}

impl ReleaseSuiteGate for SuiteTreeGate {
    fn run<'a>(
        &'a self,
        options: ReleaseSuiteOptions,
    ) -> BoxFuture<'a, anyhow::Result<ReleaseSuiteReport>> {
        let head = git_output(&options.dir, &["rev-parse", "HEAD"]);
        *self.seen.lock().expect("the gate's tree") = Some((options.dir.clone(), head));
        let report = ReleaseSuiteReport {
            code: 0,
            attempts: 1,
            findings: Vec::new(),
            structural: None,
            error_line: None,
        };
        Box::pin(async move { Ok(report) })
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
            findings: Vec::new(),
            structural: self.structural.clone(),
            error_line: self.structural.clone(),
        };
        Box::pin(async move { Ok(report) })
    }
}

/// A suite gate a landing races: `origin/main` moves while the suite runs,
/// proving a pinned release never follows it.
struct RacingSuiteGate {
    /// The checkout whose commit the gate pushes to `origin/main`.
    landing: PathBuf,
    runs: AtomicUsize,
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
        if run == 0 {
            commit_file(
                &self.landing,
                "LANDING.md",
                "landing\n",
                "fix: a landing during the suite",
            );
            git_output(&self.landing, &["push", "-q", "origin", "main"]);
        }
        let report = ReleaseSuiteReport {
            code: 0,
            attempts: 1,
            findings: Vec::new(),
            structural: None,
            error_line: None,
        };
        Box::pin(async move { Ok(report) })
    }
}

/// A suite gate that lands into `origin/main` and fast-forwards the canonical
/// checkout under the running attempt, the way a concurrent landing does, for
/// the first `moves` suite runs.
struct MovingCheckoutGate {
    /// The second checkout whose commits the gate pushes.
    landing: PathBuf,
    /// The integration checkout the release is cut from.
    checkout: PathBuf,
    runs: AtomicUsize,
    moves: usize,
}

impl ReleaseSuiteGate for MovingCheckoutGate {
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
        if run < self.moves {
            commit_file(
                &self.landing,
                "LANDING.md",
                &format!("landing {}\n", run + 1),
                &format!("fix: a landing during suite run {}", run + 1),
            );
            git_output(&self.landing, &["push", "-q", "origin", "main"]);
            // A landing agent fast-forwards the shared checkout before it
            // merges its own branch, which moves the head this attempt proved.
            git_output(&self.checkout, &["fetch", "-q", "origin"]);
            git_output(&self.checkout, &["merge", "--ff-only", "origin/main"]);
        }
        let report = ReleaseSuiteReport {
            code: 0,
            attempts: 1,
            findings: Vec::new(),
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
    // The GitHub build-ref push resolves `gh` through the environment's PATH,
    // so the fixture puts a stub where that lookup finds it.
    let gh_bin = package_dir().join(".test-tmp").join("gh-stub");
    fs::create_dir_all(&gh_bin).expect("a gh stub directory");
    let gh = gh_bin.join("gh");
    if !gh.exists() {
        fs::write(&gh, b"#!/bin/sh\nexit 1\n").expect("a gh stub");
    }
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    environment.insert(
        "PATH".to_string(),
        format!("{}:{inherited_path}", gh_bin.display()),
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
async fn an_ahead_main_waits_out_the_settle_window_then_names_what_to_push() {
    let scratch = Scratch::new("ahead");
    let (origin, github) = origin_repository(&scratch.root);
    let app = application_base(&scratch, &origin, &github);
    commit_message(&app, "feat: base");
    git_output(&app, &["push", "-q", "origin", "main"]);
    commit_message(&app, "feat: local only");
    let gitea = StubServer::start(|_| not_found()).await;
    let gh = StubServer::start(|_| not_found()).await;
    let mut args = test_args(&app, &gitea, &gh, None);
    // The settle window is real time in production; a fake sleeper drives it
    // without waiting, and its clock measures the window this refusal spent.
    let clock = FakeClock::new(0);
    args.clock = Some(clock.clone());
    args.sleeper = Some(Arc::new(FakeSleeper {
        clock: clock.clone(),
        step: 30_000,
    }));
    let error = publish(args).await.expect_err("an ahead main is refused");
    let message = format!("{error:#}");
    assert!(
        message.contains("local main carries commits origin/main does not have"),
        "{message}"
    );
    assert!(message.contains("feat: local only"), "{message}");
    assert!(
        message.contains("push main from the integration checkout"),
        "{message}"
    );
    assert!(
        clock.now_millis() >= 5 * 60_000,
        "the settle window waited only {} ms",
        clock.now_millis()
    );
}

#[tokio::test]
async fn a_diverged_main_is_refused_without_a_wait() {
    let scratch = Scratch::new("diverged");
    let (origin, github) = origin_repository(&scratch.root);
    let app = application_base(&scratch, &origin, &github);
    commit_file(&app, "tracked.txt", "one\n", "feat: base");
    git_output(&app, &["push", "-q", "origin", "main"]);

    let other = scratch.root.join("other");
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

    commit_file(&app, "tracked.txt", "three\n", "feat: local change");

    let gitea = StubServer::start(|_| not_found()).await;
    let gh = StubServer::start(|_| not_found()).await;
    let mut args = test_args(&app, &gitea, &gh, None);
    let clock = FakeClock::new(0);
    args.clock = Some(clock.clone());
    args.sleeper = Some(Arc::new(FakeSleeper {
        clock: clock.clone(),
        step: 30_000,
    }));
    let error = publish(args).await.expect_err("a diverged main is refused");
    let message = format!("{error:#}");
    assert!(message.contains("diverged from origin/main"), "{message}");
    assert!(
        message.contains("integrate origin/main into main"),
        "{message}"
    );
    assert_eq!(
        clock.now_millis(),
        0,
        "a divergence cannot settle by waiting"
    );
}

#[tokio::test]
async fn an_in_flight_landing_that_pushes_lets_the_release_run() {
    let live = live("landing", release_assets()).await;
    let landing = commit_file(&live.seed, "README.md", "landing\n", "feat: the landing");
    let clock = FakeClock::new(0);
    let sleeper = LandingPusher::new(clock.clone(), live.seed.clone());
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.clock = Some(clock);
    args.sleeper = Some(sleeper.clone());
    args.target = Some(landing.clone());
    let report = publish(args).await.expect("the landing push settles");

    assert!(report.published, "the release ships once main is pushed");
    assert_eq!(report.version, "1.1.0");
    // The release is pinned to the landing commit the fetch settled on; the
    // checkout itself is never advanced to the release commit.
    assert_eq!(git_output(&live.origin, &["rev-parse", "main"]), landing);
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
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

    let gitea = StubServer::start(writable_gitea).await;
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

    let gitea = StubServer::start(writable_gitea).await;
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
    // The fixture's harness is the commit it would tag, so the failure names
    // the compile error alone.
    assert!(
        !message.contains("uncommitted edits the tagged commit does not name"),
        "{message}"
    );

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

    // A suite whose tests are deterministic failures reports the same
    // refusal: no test proved the commit, so nothing may be tagged or
    // dispatched.
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.release_suite = Some(Arc::new(StubSuiteGate {
        code: 1,
        structural: Some(
            "the suite reported 1 deterministic failure(s) after 1 attempt(s)".to_string(),
        ),
    }));
    let error = publish(args)
        .await
        .expect_err("a deterministic suite blocks the release");
    let message = format!("{error:#}");
    assert!(message.contains("release suite did not pass"), "{message}");
    assert!(message.contains("1 deterministic failure(s)"), "{message}");
    assert_eq!(git_output(&live.seed, &["rev-parse", "HEAD"]), head);
    assert!(git_output(&live.seed, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
    assert_eq!(live.github_stub.dispatch_count(), 0);
}

/// The documented recovery path keeps uncommitted work in the integration
/// checkout. A pinned release never compiles or tags that checkout, so the
/// edit neither blocks nor contaminates the release.
#[tokio::test]
async fn a_passing_suite_releases_while_the_tree_carries_uncommitted_edits() {
    let live = live("suite-diverged-pass", release_assets()).await;
    let manifest = live.seed.join(".devboard/Cargo.toml");
    let mut text = fs::read_to_string(&manifest).expect("the manifest");
    text.push_str("\n# a concurrent run's partial edit\n");
    fs::write(&manifest, text.clone()).expect("an edit the commit does not carry");

    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    let report = publish(args).await.expect("a passing suite releases");

    assert!(report.published);
    assert_eq!(
        fs::read_to_string(&manifest).expect("the manifest"),
        text,
        "the release never wrote the shared checkout"
    );
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        report.commit
    );
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
    let target = git_output(&live.seed, &["rev-parse", "HEAD"]);
    assert_eq!(
        git_output(&live.origin, &["rev-parse", &format!("{tag}^{{commit}}")]).trim(),
        report.commit
    );
    assert_eq!(
        git_output(&live.origin, &["rev-list", &format!("{target}..{tag}")])
            .lines()
            .count(),
        1,
        "the release adds one commit after the pinned target"
    );
    assert_eq!(
        git_output(
            &live.origin,
            &["show", "-s", "--format=%s", &format!("{tag}^{{commit}}")]
        ),
        "chore(release): v1.1.0"
    );
    // The pinned release commits the bump in its own worktree, never in the
    // shared checkout.
    let manifest = fs::read_to_string(live.seed.join(".devboard/Cargo.toml")).expect("manifest");
    assert!(manifest.contains("version = \"0.0.0\""), "{manifest}");
    assert_eq!(git_output(&live.origin, &["rev-parse", "main"]), target);
    let commit = report.commit.clone();
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

    // A rerun on the same pinned target is refused: the release already
    // carries the tag, the assets, and the Gitea manifest. Nothing is bumped,
    // tagged, dispatched, or uploaded again.
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
    second_args.target = Some(target.clone());
    let error = publish(second_args)
        .await
        .expect_err("a released target is refused");
    assert!(
        format!("{error:#}").contains("already released"),
        "{error:#}"
    );
    assert_eq!(live.github_stub.dispatch_count(), 1);
    assert_eq!(git_output(&live.seed, &["rev-parse", "HEAD"]), target);
    assert_eq!(
        live.gitea_stub
            .release_bytes(tag, "devboard-manifest.json")
            .expect("the unchanged manifest"),
        report.manifest.as_bytes()
    );
}

type LogLines = Arc<Mutex<Vec<String>>>;
type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// A suite gate that reports whole attempts on the log through the production
/// formatter, so `publish` reads exactly the line the real suite writes.
struct LoggingSuiteGate;

impl ReleaseSuiteGate for LoggingSuiteGate {
    fn run<'a>(
        &'a self,
        options: ReleaseSuiteOptions,
    ) -> BoxFuture<'a, anyhow::Result<ReleaseSuiteReport>> {
        let log = options.log.clone();
        Box::pin(async move {
            if let Some(log) = log {
                log(&attempt_line(1, RELEASE_SUITE_MAX_ATTEMPTS, 2, 98, 0));
                log(&attempt_line(2, RELEASE_SUITE_MAX_ATTEMPTS, 0, 100, 2));
            }
            Ok(ReleaseSuiteReport {
                code: 0,
                attempts: 2,
                findings: Vec::new(),
                structural: None,
                error_line: None,
            })
        })
    }
}

/// A suite gate that records whether the environment it runs under carries the
/// release run's progress path, and reports one whole attempt on the log.
struct RunDirWatchingGate {
    saw: Arc<Mutex<Option<bool>>>,
}

impl ReleaseSuiteGate for RunDirWatchingGate {
    fn run<'a>(
        &'a self,
        options: ReleaseSuiteOptions,
    ) -> BoxFuture<'a, anyhow::Result<ReleaseSuiteReport>> {
        *self.saw.lock().expect("the observation") = Some(
            options
                .environment
                .contains_key(devboard::publish::RELEASE_RUN_DIR_VARIABLE),
        );
        if let Some(log) = options.log.clone() {
            log(&attempt_line(1, RELEASE_SUITE_MAX_ATTEMPTS, 0, 100, 0));
        }
        let report = ReleaseSuiteReport {
            code: 0,
            attempts: 1,
            findings: Vec::new(),
            structural: None,
            error_line: None,
        };
        Box::pin(async move { Ok(report) })
    }
}

/// The suite runs the workspace tests, and one of those tests may publish. It
/// must never inherit the release run's progress path, or its own phases would
/// land in the record the operator is watching.
#[tokio::test]
async fn the_release_suite_never_inherits_the_run_progress_path() {
    let live = live("release-suite-progress-env", release_assets()).await;
    let progress = live
        .state_dir
        .join(devboard::publish::PUBLISH_PROGRESS_FILE);
    let saw = Arc::new(Mutex::new(None));
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.progress_path = Some(progress.clone());
    args.environment.insert(
        devboard::publish::RELEASE_RUN_DIR_VARIABLE.to_string(),
        live.state_dir.to_string_lossy().into_owned(),
    );
    args.release_suite = Some(Arc::new(RunDirWatchingGate { saw: saw.clone() }));
    publish(args).await.expect("a release");

    assert_eq!(
        *saw.lock().expect("the observation"),
        Some(false),
        "the suite inherited the run directory and would write into the record"
    );
    let records = devboard::publish::read_publish_progress(&progress);
    let count = |phase: &str| {
        records
            .iter()
            .filter(|record| record.phase == phase)
            .count()
    };
    assert_eq!(count("start"), 1, "{records:?}");
    assert_eq!(count("fetch"), 1, "{records:?}");
    assert_eq!(count("tag"), 1, "{records:?}");
    assert_eq!(count("manifest"), 1, "{records:?}");
}

/// The harness owns the run's progress record: publish appends one timestamped
/// line per phase by itself, so the account survives a silent agent and a dead
/// shell without any `tee`. The record names every phase in the order the
/// release performs them.
#[tokio::test]
async fn publish_records_every_phase_into_the_run_directory() {
    let live = live("release-progress", release_assets()).await;
    let progress = live
        .state_dir
        .join(devboard::publish::PUBLISH_PROGRESS_FILE);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.progress_path = Some(progress.clone());
    args.release_suite = Some(Arc::new(LoggingSuiteGate));
    let report = publish(args).await.expect("a release");

    let records = devboard::publish::read_publish_progress(&progress);
    let phases: Vec<&str> = records.iter().map(|record| record.phase.as_str()).collect();
    assert_eq!(
        phases,
        [
            "start", "fetch", "version", "suite", "suite", "suite", "ci", "ci", "tag", "assets",
            "manifest",
        ],
        "publish records every phase in the order it performs them: {records:?}"
    );
    assert!(
        records.iter().all(|record| !record.at.is_empty()),
        "every record carries its own timestamp: {records:?}"
    );

    let attempts: Vec<_> = records
        .iter()
        .filter(|record| record.phase == "suite" && record.attempt.is_some())
        .collect();
    assert_eq!(attempts.len(), 2, "{records:?}");
    assert_eq!(
        (attempts[0].attempt, attempts[0].passed, attempts[0].failed),
        (Some(1), Some(98), Some(2))
    );
    assert_eq!(
        (attempts[1].attempt, attempts[1].passed, attempts[1].failed),
        (Some(2), Some(100), Some(0))
    );

    let version = records
        .iter()
        .find(|record| record.phase == "version")
        .expect("a derived version");
    assert!(version.detail.contains("v1.1.0"), "{}", version.detail);

    let ci = records
        .iter()
        .find(|record| record.phase == "ci" && record.conclusion.as_deref() == Some("success"))
        .expect("the CI verdict");
    assert!(ci.ci_run.is_some(), "{ci:?}");
    assert!(ci.detail.contains("concluded success"), "{}", ci.detail);

    let tag = records
        .iter()
        .find(|record| record.phase == "tag")
        .expect("the tag push");
    assert!(tag.detail.contains("pushed v1.1.0"), "{}", tag.detail);

    let assets = records
        .iter()
        .find(|record| record.phase == "assets")
        .expect("the GitHub asset check");
    assert_eq!(assets.assets, Some(report.github_assets.len()));

    let manifest = records
        .iter()
        .find(|record| record.phase == "manifest")
        .expect("the Gitea manifest check");
    assert!(manifest.detail.contains("v1.1.0"), "{}", manifest.detail);
}

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
        live.gitea_stub.set_ci(CiState::RerunFails(conclusion));
        let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
        args.wait_timeout = Duration::from_secs(2);
        let error = publish(args)
            .await
            .expect_err("a non-success conclusion refuses the tag");
        let message = format!("{error:#}");
        assert!(
            message.contains("devboard-ci.yml run 778")
                && message.contains(conclusion)
                && message.contains("after one re-run")
                && message.contains("check failed at Test"),
            "{conclusion}: {message}"
        );
        assert_eq!(
            live.gitea_stub.rerun_count(),
            1,
            "{conclusion}: the settled run is restarted once"
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
            "feat: the next release",
            "{conclusion}: the pinned release never advances main"
        );
        assert_eq!(live.github_stub.dispatch_count(), 0);
    }
}

#[tokio::test]
async fn ci_gate_re_runs_a_settled_failure_once() {
    let live = live("ci-rerun-recovers", release_assets()).await;
    let (lines, log) = recording_log();
    live.gitea_stub.set_ci(CiState::RerunRecovers);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.log = Some(log);
    let report = publish(args)
        .await
        .expect("the restarted run proves the commit and the tag lands");
    assert_eq!(
        live.gitea_stub.rerun_count(),
        1,
        "one restart proves the commit"
    );
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        report.commit,
        "the tag names the CI-proven commit"
    );
    let lines = lines.lock().expect("log").clone();
    let restart = line_after(&lines, "re-running the devboard-ci.yml run 777");
    let success = line_after(&lines, "CI run 778");
    assert!(
        restart < success && lines[restart].contains("concluded failure"),
        "the restart precedes the success it earned: {lines:?}"
    );
}

#[tokio::test]
async fn ci_gate_refuses_a_restart_the_forge_will_not_run() {
    let live = live("ci-rerun-refused", release_assets()).await;
    live.gitea_stub.set_ci(CiState::RerunRefused("failure"));
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(2);
    let error = publish(args)
        .await
        .expect_err("a refused restart leaves the range unreleased");
    let message = format!("{error:#}");
    assert!(
        message.contains("devboard-ci.yml run 777")
            && message.contains("concluded failure")
            && message.contains("check failed at Test")
            && message.contains("its re-run was refused")
            && message.contains("HTTP 403"),
        "{message}"
    );
    assert!(
        live.gitea_server
            .find(
                "POST",
                "/api/v1/repos/dsdenes/devboard/actions/runs/777/rerun"
            )
            .is_some(),
        "the gate asked the forge to restart the run"
    );
    assert!(git_output(&live.origin, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
}

#[tokio::test]
async fn ci_gate_keeps_the_run_verdict_when_the_job_read_is_refused() {
    let live = live("ci-jobs-refused", release_assets()).await;
    live.gitea_stub.set_ci(CiState::RerunFails("failure"));
    live.gitea_stub.refuse_jobs();
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(2);
    let error = publish(args)
        .await
        .expect_err("a refused job read keeps the run's refusal");
    let message = format!("{error:#}");
    assert!(
        message.contains("devboard-ci.yml run 778")
            && message.contains("concluded failure after one re-run")
            && !message.contains("failed at"),
        "{message}"
    );
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

/// A run the forge accepted but never started names itself in the refusal,
/// with its state and the job the forge never registered, so an operator sees
/// which run and which side of the CI gate has to be looked at.
#[tokio::test]
async fn ci_gate_names_the_run_that_never_settled() {
    let live = live("ci-queued", release_assets()).await;
    live.gitea_stub.set_ci(CiState::Queued);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_millis(60);
    args.poll_interval = Duration::from_millis(10);
    let error = publish(args)
        .await
        .expect_err("a queued run leaves the range unreleased");
    let message = format!("{error:#}");
    assert!(
        message.contains("devboard-ci.yml run 777")
            && message.contains("was still waiting")
            && message.contains("no job registered")
            && !message.contains("read failed")
            && message.contains("no tag was pushed"),
        "{message}"
    );
    assert!(git_output(&live.origin, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
}

/// A forge that refuses every run read is named as the cause, so the refusal
/// never reports an unreadable forge as a run that simply did not succeed.
#[tokio::test]
async fn ci_gate_names_a_refused_run_read() {
    let live = live("ci-read-refused", release_assets()).await;
    live.gitea_stub.set_ci(CiState::ReadRefused);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_millis(60);
    args.poll_interval = Duration::from_millis(10);
    let error = publish(args)
        .await
        .expect_err("an unreadable forge leaves the range unreleased");
    let message = format!("{error:#}");
    assert!(
        message.contains("could be read within")
            && message.contains("the devboard-ci.yml read failed")
            && message.contains("HTTP 404")
            && !message.contains("concluded success within")
            && message.contains("no tag was pushed"),
        "{message}"
    );
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
                let commit = git_output(
                    &self.origin,
                    &["rev-parse", &format!("refs/tags/{tag}^{{commit}}")],
                );
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
    let target = git_output(&live.seed, &["rev-parse", "HEAD"]);
    assert!(report.published);
    assert_eq!(report.tag, "v1.1.0");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        report.commit
    );
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        target,
        "the pinned release never advances main"
    );
    assert_eq!(runner.answered.load(Ordering::SeqCst), 1);
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

#[tokio::test]
async fn the_pinned_suite_runs_the_target_tree_while_the_checkout_is_dirty() {
    let live = live("pinned-tree", release_assets()).await;
    let target = git_output(&live.seed, &["rev-parse", "HEAD"]);
    // An uncommitted edit in the shared integration checkout is not the pinned
    // commit, so it must not reach the gate.
    fs::write(
        live.seed.join(".devboard/Cargo.toml"),
        "[workspace]\nmembers = [\"not-the-commit\"]\n",
    )
    .expect("an uncommitted edit the commit does not carry");

    let seen = Arc::new(Mutex::new(None));
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    args.release_suite = Some(Arc::new(SuiteTreeGate { seen: seen.clone() }));
    let report = publish(args).await.expect("the pinned tree is what runs");

    assert!(report.published);
    let seen = seen.lock().expect("the gate's tree").clone();
    let (dir, head) = seen.expect("the gate ran");
    assert!(
        dir.ends_with(".devboard")
            && dir.starts_with(
                live.seed
                    .join(devboard::publish::RELEASE_WORKTREE_DIRECTORY)
            ),
        "the gate ran in a release worktree, not the shared checkout: {}",
        dir.display()
    );
    assert_eq!(head, target, "the gate's HEAD is the pinned target");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        report.commit
    );
    let range = git_output(&live.origin, &["rev-list", &format!("{target}..v1.1.0")]);
    assert_eq!(
        range.lines().count(),
        1,
        "the tag carries the pinned target and one release commit: {range}"
    );
    assert_eq!(
        git_output(
            &live.origin,
            &["show", "-s", "--format=%s", "v1.1.0^{commit}"]
        ),
        "chore(release): v1.1.0"
    );
    // The uncommitted edit is untouched: no release ever wrote the checkout.
    assert!(fs::read_to_string(live.seed.join(".devboard/Cargo.toml"))
        .expect("the manifest")
        .contains("not-the-commit"));
}

#[tokio::test]
async fn a_landing_that_moves_the_checkout_during_the_suite_is_not_integrated() {
    let live = live("pinned-landing", release_assets()).await;
    let target = git_output(&live.origin, &["rev-parse", "main"]);
    let landing = landing_checkout(&live);
    let gate = Arc::new(MovingCheckoutGate {
        landing: landing.clone(),
        checkout: live.seed.clone(),
        runs: AtomicUsize::new(0),
        moves: 1,
    });
    let progress = live
        .state_dir
        .join(devboard::publish::PUBLISH_PROGRESS_FILE);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    args.release_suite = Some(gate.clone());
    args.progress_path = Some(progress.clone());
    let report = publish(args)
        .await
        .expect("the pinned release ships while the checkout moves");

    let landing_commit = git_output(&landing, &["rev-parse", "HEAD"]);
    assert_ne!(landing_commit, target);
    assert_eq!(gate.runs.load(Ordering::SeqCst), 1, "one frozen attempt");
    assert!(report.published);
    assert_eq!(report.tag, "v1.1.0");
    // The landing moved `main`, and the release did not follow it.
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        landing_commit
    );
    let range = git_output(&live.origin, &["rev-list", &format!("{target}..v1.1.0")]);
    assert_eq!(
        range.lines().count(),
        1,
        "only the release commit follows the pinned target: {range}"
    );
    assert!(
        !range.contains(&landing_commit),
        "the landing is absent from the tag's range: {range}"
    );
    assert_eq!(
        git_output(
            &live.origin,
            &["merge-base", "--is-ancestor", &target, "v1.1.0^{commit}"]
        ),
        ""
    );
    // The run recorded one fetch and one derivation for the target, and never
    // entered a moving-target retry.
    let records = devboard::publish::read_publish_progress(&progress);
    let count = |phase: &str| {
        records
            .iter()
            .filter(|record| record.phase == phase)
            .count()
    };
    assert_eq!(count("fetch"), 1, "{records:?}");
    assert_eq!(count("version"), 1, "{records:?}");
    assert!(
        !records
            .iter()
            .any(|record| record.detail.contains("integrating the landing")),
        "{records:?}"
    );
    assert!(records
        .iter()
        .any(|record| record.phase == "fetch" && record.detail.contains(&target[..7])));
}

#[tokio::test]
async fn a_landing_that_pushes_during_the_suite_is_not_integrated() {
    let live = live("pinned-landing-push", release_assets()).await;
    let target = git_output(&live.origin, &["rev-parse", "main"]);
    let landing = landing_checkout(&live);
    let gate = Arc::new(RacingSuiteGate {
        landing: landing.clone(),
        runs: AtomicUsize::new(0),
    });
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    args.release_suite = Some(gate.clone());
    let report = publish(args)
        .await
        .expect("the pinned release ships while a landing pushes");

    let landing_commit = git_output(&landing, &["rev-parse", "HEAD"]);
    assert_eq!(
        gate.runs.load(Ordering::SeqCst),
        1,
        "the suite runs once, for the pinned target"
    );
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        landing_commit,
        "the landing is what main carries"
    );
    let range = git_output(&live.origin, &["rev-list", &format!("{target}..v1.1.0")]);
    assert_eq!(
        range.lines().collect::<Vec<_>>(),
        [report.commit.as_str()],
        "the tag carries the target and one release commit: {range}"
    );
    assert!(
        !range.contains(&landing_commit),
        "the landing is absent from the tag's range"
    );
    assert_eq!(live.github_stub.dispatch_count(), 1);
    assert!(live
        .gitea_stub
        .release_bytes("v1.1.0", "devboard-manifest.json")
        .is_some());
}

#[tokio::test]
async fn a_pinned_target_the_run_version_does_not_name_fails_before_any_write() {
    let live = live("pinned-version", release_assets()).await;
    let target = git_output(&live.seed, &["rev-parse", "HEAD"]);
    let origin_head = git_output(&live.origin, &["rev-parse", "main"]);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target);
    args.expected_version = Some("9.9.9".to_string());
    let error = publish(args)
        .await
        .expect_err("a version the request does not name refuses the release");
    let message = format!("{error:#}");
    assert!(message.contains("derives v1.1.0"), "{message}");
    assert!(message.contains("request names v9.9.9"), "{message}");
    assert!(git_output(&live.origin, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
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
async fn a_malformed_or_missing_pinned_target_fails_before_any_write() {
    let live = live("pinned-target-shape", release_assets()).await;
    let origin_head = git_output(&live.origin, &["rev-parse", "main"]);
    for (target, expected) in [
        ("not-a-commit".to_string(), "not a full 40-character"),
        (String::new(), "pinned target is empty"),
        ("c".repeat(40), "not a commit this checkout can read"),
    ] {
        let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
        args.wait_timeout = Duration::from_secs(5);
        args.target = Some(target.clone());
        let error = publish(args)
            .await
            .expect_err("an unusable pinned target refuses the release");
        let message = format!("{error:#}");
        assert!(message.contains(expected), "{target}: {message}");
    }
    assert!(git_output(&live.origin, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "main"]),
        origin_head
    );
    assert_eq!(live.github_stub.dispatch_count(), 0);
}

#[tokio::test]
async fn a_pinned_target_outside_main_fails_before_any_write() {
    let live = live("pinned-target-unreachable", release_assets()).await;
    let side = git_output(&live.seed, &["rev-parse", "HEAD"]);
    git_output(&live.seed, &["checkout", "-q", "-b", "side"]);
    let orphan = commit_file(&live.seed, "SIDE.md", "side\n", "feat: a side commit");
    git_output(&live.seed, &["checkout", "-q", "main"]);
    assert_ne!(orphan, side);

    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(orphan.clone());
    let error = publish(args)
        .await
        .expect_err("a target outside main refuses the release");
    let message = format!("{error:#}");
    assert!(
        message.contains("not reachable from origin/main"),
        "{message}"
    );
    assert!(git_output(&live.origin, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
    assert_eq!(live.github_stub.dispatch_count(), 0);
}

#[tokio::test]
async fn an_already_released_pinned_target_fails_before_any_write() {
    let live = live("pinned-released", release_assets()).await;
    let target = git_output(&live.seed, &["rev-parse", "HEAD"]);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    let first = publish(args).await.expect("the first release ships");
    assert!(first.published);
    assert_eq!(live.github_stub.dispatch_count(), 1);

    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target);
    let error = publish(args)
        .await
        .expect_err("a released target is refused");
    let message = format!("{error:#}");
    assert!(message.contains("already released"), "{message}");
    assert!(message.contains("v1.1.0"), "{message}");
    assert_eq!(
        live.github_stub.dispatch_count(),
        1,
        "an already-released target dispatches nothing"
    );
    assert_eq!(
        live.gitea_server
            .requests()
            .iter()
            .filter(|request| request.method == "POST"
                && request.path == "/api/v1/repos/dsdenes/devboard/releases")
            .count(),
        1,
        "no second Gitea release is written"
    );
}

#[tokio::test]
async fn a_release_commit_off_main_advances_the_next_pinned_version() {
    let live = live("pinned-advance", release_assets()).await;
    let first_target = git_output(&live.seed, &["rev-parse", "HEAD"]);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(first_target.clone());
    let first = publish(args).await.expect("the first pinned release");
    assert_eq!(first.version, "1.1.0");
    assert_eq!(
        git_output(&live.seed, &["rev-parse", "HEAD"]),
        first_target,
        "the release never advances the checkout"
    );

    // A later commit lands on main after that release, whose bump commit is
    // only on the tag.
    let second_target = commit_file(&live.seed, "README.md", "second\n", "feat: the next range");
    git_output(&live.seed, &["push", "-q", "origin", "main"]);

    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(second_target.clone());
    args.expected_version = Some("1.2.0".to_string());
    args.expected_range = Some(format!("v1.1.0..{second_target}"));
    let second = publish(args)
        .await
        .expect("the next pinned release derives past the release commit");
    assert_eq!(second.version, "1.2.0");
    assert_eq!(second.tag, "v1.2.0");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.2.0^{commit}"]),
        second.commit
    );
    let range = git_output(
        &live.origin,
        &["rev-list", &format!("{second_target}..v1.2.0")],
    );
    assert_eq!(range.lines().count(), 1, "{range}");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        first.commit,
        "the previous release tag is untouched"
    );
}

#[tokio::test]
async fn a_superseded_unpublished_tag_is_withdrawn_and_the_range_is_retagged() {
    let live = live("stale-release", release_assets()).await;
    // An earlier run tagged a release commit for v1.1.0 but its release never
    // shipped, and `main` has since moved past that commit.
    git_output(&live.seed, &["checkout", "-q", "-b", "stale-release"]);
    let stale_bump = commit_message(&live.seed, "chore(release): v1.1.0");
    git_output(&live.seed, &["tag", "-a", "v1.1.0", "-m", "Devboard 1.1.0"]);
    git_output(&live.seed, &["checkout", "-q", "main"]);
    git_output(&live.seed, &["branch", "-q", "-D", "stale-release"]);
    git_output(&live.seed, &["push", "-q", "origin", "refs/tags/v1.1.0"]);
    let target = commit_file(
        &live.seed,
        "README.md",
        "after the stale tag\n",
        "fix: after the stale tag",
    );
    git_output(&live.seed, &["push", "-q", "origin", "main"]);
    // No release exists for the stale tag on either forge.
    live.github_stub.release_exists(false);

    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = lines.clone();
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    args.expected_version = Some("1.1.0".to_string());
    args.expected_range = Some(format!("v1.0.0..{target}"));
    args.log = Some(Arc::new(move |line: &str| {
        recorded.lock().expect("log").push(line.to_string());
    }));
    let report = publish(args)
        .await
        .expect("the stale tag is withdrawn and the range is retagged");

    assert!(report.published);
    let lines = lines.lock().expect("log").clone();
    assert!(
        lines.iter().any(|line| line.contains("withdrawing v1.1.0")),
        "{lines:?}"
    );
    assert_ne!(report.commit, stale_bump);
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        report.commit,
        "the tag names the new release commit"
    );
    let range = git_output(&live.origin, &["rev-list", &format!("{target}..v1.1.0")]);
    assert_eq!(range.lines().count(), 1, "{range}");
    assert_eq!(live.github_stub.dispatch_count(), 1);
    assert!(live
        .gitea_stub
        .release_bytes("v1.1.0", "devboard-manifest.json")
        .is_some());
}

#[tokio::test]
async fn a_superseded_tag_with_a_release_is_refused_and_kept() {
    let live = live("stale-release-released", release_assets()).await;
    git_output(&live.seed, &["checkout", "-q", "-b", "stale-release"]);
    let stale_bump = commit_message(&live.seed, "chore(release): v1.1.0");
    git_output(&live.seed, &["tag", "-a", "v1.1.0", "-m", "Devboard 1.1.0"]);
    git_output(&live.seed, &["checkout", "-q", "main"]);
    git_output(&live.seed, &["branch", "-q", "-D", "stale-release"]);
    git_output(&live.seed, &["push", "-q", "origin", "refs/tags/v1.1.0"]);
    let target = commit_file(
        &live.seed,
        "README.md",
        "after the stale tag\n",
        "fix: after the stale tag",
    );
    git_output(&live.seed, &["push", "-q", "origin", "main"]);

    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    args.expected_version = Some("1.1.0".to_string());
    args.expected_range = Some(format!("v1.0.0..{target}"));
    let error = publish(args)
        .await
        .expect_err("a released tag off the target's range is refused");
    let message = format!("{error:#}");
    assert!(message.contains("neither names nor contains"), "{message}");
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        stale_bump,
        "a released tag is never deleted"
    );
    assert_eq!(live.github_stub.dispatch_count(), 0);
}

#[tokio::test]
async fn a_request_range_that_does_not_end_at_the_target_fails_before_any_write() {
    let live = live("range-mismatch", release_assets()).await;
    let target = git_output(&live.seed, &["rev-parse", "HEAD"]);
    let other = git_output(&live.seed, &["rev-parse", "v1.0.0^{commit}"]);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    args.expected_range = Some(format!("v1.0.0..{other}"));
    let error = publish(args)
        .await
        .expect_err("a range that does not end at the target is refused");
    let message = format!("{error:#}");
    assert!(
        message.contains("does not end at the pinned target"),
        "{message}"
    );
    assert!(git_output(&live.origin, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
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
/// A checkout that never fetched the published tag cannot derive the pinned
/// target's range. The forge's newest release is the floor, so the run is
/// refused before anything is written instead of deriving a released range.
async fn a_stale_checkout_refuses_a_pinned_target_at_or_below_its_release() {
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
    let target = commit_file(&seed, "README.md", "after\n", "fix: after that release");
    git_output(&seed, &["push", "-q", "origin", "main"]);
    // `origin` never carried v1.1.0; only the forge names it.

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
    args.target = Some(target);
    let error = publish(args)
        .await
        .expect_err("a stale checkout refuses the pinned range");
    let message = format!("{error:#}");
    assert!(message.contains("v1.1.0 already names"), "{message}");
    assert!(message.contains("neither names nor contains"), "{message}");
    assert!(git_output(&origin, &["tag", "--list", "v1.1.0"])
        .trim()
        .is_empty());
    assert_eq!(github.stub.dispatch_count(), 0);
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
async fn a_withdrawn_release_is_retried_against_the_same_pinned_target() {
    let live = live("withdraw-retry", release_assets()).await;
    let target = git_output(&live.seed, &["rev-parse", "HEAD"]);
    live.github_stub.settle_with("cancelled", json!({}));
    live.github_stub.release_exists(false);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.instances = Some(Vec::new());
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    publish(args).await.expect_err("the first attempt fails");
    assert!(
        git_output(&live.origin, &["tag", "--list", "v1.1.0"])
            .trim()
            .is_empty(),
        "the failed attempt withdraws its tag"
    );
    assert_eq!(git_output(&live.seed, &["rev-parse", "HEAD"]), target);

    live.github_stub.settle_with("success", json!({}));
    live.github_stub.release_exists(true);
    let mut args = test_args(&live.seed, &live.gitea_server, &live.github_server, None);
    args.instances = Some(Vec::new());
    args.wait_timeout = Duration::from_secs(5);
    args.target = Some(target.clone());
    let report = publish(args)
        .await
        .expect("the retry releases the withdrawn version");

    assert_eq!(report.version, "1.1.0");
    assert_eq!(report.tag, "v1.1.0");
    assert!(report.published);
    assert_eq!(
        git_output(&live.seed, &["rev-parse", "HEAD"]),
        target,
        "neither attempt advances the integration checkout"
    );
    assert_eq!(
        git_output(&live.origin, &["rev-parse", "v1.1.0^{commit}"]),
        report.commit
    );
    let range = git_output(&live.origin, &["rev-list", &format!("{target}..v1.1.0")]);
    assert_eq!(range.lines().count(), 1, "{range}");
    assert_eq!(
        git_output(
            &live.origin,
            &["show", "-s", "--format=%s", "v1.1.0^{commit}"]
        ),
        "chore(release): v1.1.0"
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
async fn a_dashboard_through_another_harness_is_reported_skipped() {
    let scratch = Scratch::new("skipped");
    let app = scratch.root.join("repo");
    git_init(&app);
    write_harness(&app);
    let state_dir = scratch.root.join("state");
    let instance = DashboardInstance {
        pid: 8,
        port: 7200,
        repo_dir: app.clone(),
        harness: app.join(".worktree/perf/.devboard"),
        state_dir: state_dir.clone(),
    };
    let options = SourceRefreshOptions {
        repo_root: app.clone(),
        harness_root: app.join(".devboard"),
        commit: "a".repeat(40),
        version: "1.2.3".to_string(),
        dist_dir: app.join(".devboard/dist"),
        instances: vec![instance],
        requested_at: "2026-11-03T00:00:00.000Z".to_string(),
    };
    let report = deliver_source_refresh(options)
        .await
        .expect("a skipped delivery");
    assert!(report.written.is_empty(), "no other harness is refreshed");
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].pid, 8);
    assert!(
        !state_dir.join("source-refresh/request.json").exists(),
        "a skipped dashboard receives nothing"
    );
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

#[tokio::test]
async fn a_second_publish_of_a_released_target_dispatches_nothing() {
    let live = live("one-dispatch", release_assets()).await;
    // A new tag has no GitHub release until its workflow succeeds.
    live.github_stub.release_exists(false);
    let target = git_output(&live.seed, &["rev-parse", "HEAD"]);
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
        Some(instance.clone()),
    );
    args.target = Some(target.clone());
    let first = publish(args)
        .await
        .expect("the first pass ships the release");
    assert!(first.published);
    assert_eq!(first.tag, "v1.1.0");
    assert_eq!(live.github_stub.dispatch_count(), 1);

    // Every asset exists and the Gitea release is written, so a second pass
    // is a released target: refused before any second dispatch or write.
    live.github_stub.forget_run_for_commit();
    let mut args = test_args(
        &live.seed,
        &live.gitea_server,
        &live.github_server,
        Some(instance),
    );
    args.target = Some(target);
    let error = publish(args)
        .await
        .expect_err("a released target is refused");
    assert!(
        format!("{error:#}").contains("already released"),
        "{error:#}"
    );
    assert_eq!(
        live.github_stub.dispatch_count(),
        1,
        "one tag owns one workflow run across every pass"
    );
}
