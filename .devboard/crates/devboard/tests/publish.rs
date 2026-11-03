//! The release path against local bare repositories and stub GitHub and Gitea
//! servers: version derivation, every refusal, the workflow wait and its bound,
//! asset and checksum verification, the exact manifest and source-refresh
//! bytes, and the shared release lock. Nothing here reaches a network, a real
//! tag, or a real push.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use devboard::jsjson;
use devboard::publish::{
    acquire_release_lock, commit_level, deliver_source_refresh, dist_digest, next_release_version,
    parse_subject, publish, subject_rule, Clock, CommitRecord, DashboardInstance, PublishArgs,
    ReleaseLevel, ReleaseLockOptions, Sleeper, SourceRefreshOptions, RELEASE_INSTALLERS,
    RELEASE_TARGETS,
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
    next_id: u64,
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
    async fn start(seeded: BTreeMap<String, String>, published: Vec<String>) -> GiteaFixture {
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
            next_id,
        }));
        let base_slot = Arc::new(Mutex::new(String::new()));
        let inner = state.clone();
        let slot = base_slot.clone();
        let server = StubServer::start(move |request| gitea_route(&inner, &slot, request)).await;
        *base_slot.lock().expect("base") = server.base.clone();
        GiteaFixture {
            stub: GiteaStub { state },
            server,
        }
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
    request: &RecordedRequest,
) -> StubResponse {
    let path = request.path.as_str();
    let repo = "/api/v1/repos/dsdenes/devboard";
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
    assets: BTreeMap<String, Vec<u8>>,
    complete: bool,
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
            assets,
            complete,
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
}

fn github_route(
    state: &Arc<Mutex<GithubData>>,
    base: &Arc<Mutex<String>>,
    repo_dir: &Path,
    request: &RecordedRequest,
) -> StubResponse {
    let path = request.path.as_str();
    if request.method == "GET" && path == "/repos/dsdenes/devboard/actions/runs" {
        let data = state.lock().expect("github");
        let runs = if data.dispatched > 0 && data.complete {
            let sha = git_output(repo_dir, &["rev-parse", "HEAD"]);
            vec![json!({
                "id": 42,
                "head_sha": sha.trim(),
                "status": "completed",
                "conclusion": "success",
            })]
        } else {
            data.runs.clone()
        };
        return json_response(json!({"workflow_runs": runs}));
    }
    if request.method == "POST"
        && path == "/repos/dsdenes/devboard/actions/workflows/release.yml/dispatches"
    {
        state.lock().expect("github").dispatched += 1;
        return StubResponse {
            status: 204,
            headers: vec![],
            body: Vec::new(),
        };
    }
    if let Some(rest) = path.strip_prefix("/repos/dsdenes/devboard/releases/tags/") {
        let tag = percent_decode(rest);
        let data = state.lock().expect("github");
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
    let error = publish(test_args(&app, &gitea, &gh, None))
        .await
        .expect_err("an ahead main is refused");
    assert!(
        format!("{error:#}").contains("ahead of or diverged"),
        "{error:#}"
    );
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
    let gitea = GiteaStub::start(refs, Vec::new()).await;
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
    assert_eq!(git_output(&live.github, &["rev-parse", "main"]), commit);
    assert_eq!(live.github_stub.dispatch_count(), 1);
    let dispatch = live
        .github_server
        .find(
            "POST",
            "/repos/dsdenes/devboard/actions/workflows/release.yml/dispatches",
        )
        .expect("a dispatch");
    assert_eq!(
        String::from_utf8_lossy(&dispatch.body),
        "{\"ref\":\"refs/tags/v1.1.0\"}"
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
    let gitea = GiteaStub::start(refs, vec!["v1.0.0".to_string(), "v1.1.0".to_string()]).await;
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
