//! The `forge-auth` command: target inference, credential selection, scope
//! refusal, JSON and human reports, and the `exec` child contract.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use devboard::forge::{self, Environment, Exec, ExecOptions, ExecResult};
use devboard::forge_auth::{self, Action, Context, Parsed, RunOutcome, Start};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Fixtures

#[derive(Clone, Debug)]
struct RecordedRequest {
    path: String,
    headers: HashMap<String, String>,
}

#[derive(Clone, Debug)]
struct StubResponse {
    status: u16,
    body: String,
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
    let record = RecordedRequest { path, headers };
    state
        .requests
        .lock()
        .expect("requests")
        .push(record.clone());
    let answer = (state.handler)(&record);
    axum::response::Response::builder()
        .status(answer.status)
        .header("content-type", "application/json")
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

    fn host(&self) -> String {
        self.base.trim_start_matches("http://").to_string()
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("requests").clone()
    }

    fn authorization(&self, path: &str) -> Option<String> {
        self.requests()
            .into_iter()
            .find(|request| request.path == path)
            .and_then(|request| request.headers.get("authorization").cloned())
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
        body: value.to_string(),
    }
}

fn text_response(status: u16, body: &str) -> StubResponse {
    StubResponse {
        status,
        body: body.to_string(),
    }
}

/// A Gitea stub answering the repository permission and the token's account.
fn gitea_handler(
    permissions: Value,
    login: &'static str,
) -> impl Fn(&RecordedRequest) -> StubResponse {
    move |request| match request.path.as_str() {
        "/api/v1/repos/owner/name" => json_response(json!({
            "permissions": permissions.clone(),
        })),
        "/api/v1/user" => json_response(json!({"login": login})),
        _ => text_response(500, "unexpected"),
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("forge-auth-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a fixture root");
    root
}

fn git_repo(label: &str, remote: Option<&str>) -> PathBuf {
    let root = temp_dir(label);
    let status = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["init", "-q"])
        .status()
        .expect("git init");
    assert!(status.success());
    if let Some(remote) = remote {
        let status = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["remote", "add", "origin", remote])
            .status()
            .expect("git remote add");
        assert!(status.success());
    }
    root
}

/// An `Exec` seam that answers every probe as unavailable, so the fallback
/// chain reaches Gitea without a real `gh` or `glab`.
fn unavailable_exec() -> Exec {
    Arc::new(|command: String, _args: Vec<String>, _options: ExecOptions| {
        Box::pin(async move {
            ExecResult {
                stdout: String::new(),
                stderr: format!("{command}: unavailable"),
                code: 1,
                killed: false,
            }
        })
    })
}

/// An `Exec` seam answering the three `gh` calls a GitHub resolution makes.
fn github_exec(permissions: Value) -> (Exec, Arc<Mutex<Vec<Vec<String>>>>) {
    let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let exec: Exec = Arc::new(
        move |command: String, args: Vec<String>, _options: ExecOptions| {
            seen.lock().expect("calls").push(args.clone());
            let permissions = permissions.clone();
            Box::pin(async move {
                if command != "gh" {
                    return ExecResult {
                        stderr: format!("{command}: not found"),
                        code: 127,
                        ..ExecResult::default()
                    };
                }
                let first = args.first().map(String::as_str).unwrap_or("");
                let second = args.get(1).map(String::as_str).unwrap_or("");
                if first == "auth" && second == "status" {
                    return ExecResult {
                        stdout: json!({
                            "hosts": {
                                "github.test": [{
                                    "login": "alice",
                                    "active": true,
                                    "state": "success",
                                    "error": "",
                                }],
                            },
                        })
                        .to_string(),
                        code: 0,
                        ..ExecResult::default()
                    };
                }
                if first == "auth" && second == "token" {
                    return ExecResult {
                        stdout: "secret-gh\n".to_string(),
                        code: 0,
                        ..ExecResult::default()
                    };
                }
                if first == "api" && args.iter().any(|argument| argument == "user") {
                    return ExecResult {
                        stdout: "alice\n".to_string(),
                        code: 0,
                        ..ExecResult::default()
                    };
                }
                if first == "api"
                    && args
                        .iter()
                        .any(|argument| argument.starts_with("repos/"))
                {
                    return ExecResult {
                        stdout: permissions.to_string(),
                        code: 0,
                        ..ExecResult::default()
                    };
                }
                ExecResult {
                    stderr: format!("unexpected gh invocation: {args:?}"),
                    code: 1,
                    ..ExecResult::default()
                }
            })
        },
    );
    (exec, calls)
}

fn parse(
    args: &[&str],
    cwd: &Path,
    environment: &Environment,
) -> Result<Parsed, forge_auth::UsageError> {
    let owned: Vec<String> = args.iter().map(|value| value.to_string()).collect();
    match forge_auth::parse(&owned, cwd, environment)? {
        Start::Run(parsed) => Ok(parsed),
        Start::Help => panic!("expected a runnable command"),
    }
}

fn parsed_of(args: &[&str], cwd: &Path, environment: &Environment) -> Parsed {
    parse(args, cwd, environment).expect("a runnable command")
}

fn json_of(outcome: &RunOutcome) -> Value {
    serde_json::from_str(&outcome.stdout).expect("a JSON report")
}

fn assert_no_token(outcome: &RunOutcome, token: &str) {
    assert!(!outcome.stdout.contains(token), "token reached stdout");
    assert!(!outcome.stderr.contains(token), "token reached stderr");
}

// ---------------------------------------------------------------------------
// Target inference

#[tokio::test]
async fn check_defaults_to_the_origin_and_reports_the_identity_as_json() {
    let server = StubServer::start(gitea_handler(
        json!({"pull": true, "push": false, "admin": false}),
        "alice",
    ))
    .await;
    let repo = git_repo(
        "origin",
        Some("https://gitea.test/owner/name.git"),
    );
    let environment = forge::environment(&[
        ("GITEA_TOKEN", "gitea-secret-value"),
        ("DEVBOARD_GITEA_URL", server.base.as_str()),
    ]);
    let context = Context {
        exec: unavailable_exec(),
        transport: forge::default_transport(5_000),
        environment,
    };

    let parsed = parsed_of(&["check", "--json"], &repo, &context.environment);
    assert_eq!(parsed.action, Action::Check);
    assert_eq!(parsed.host, "gitea.test");
    assert_eq!(parsed.project, "owner/name");
    assert_eq!(parsed.required, forge::RequiredAccess::Read);
    assert_eq!(parsed.forge, None);

    let outcome = forge_auth::execute(&parsed, &context).await;
    assert_eq!(outcome.exit_code, 0);
    assert_eq!(outcome.stderr, "");
    assert_eq!(
        outcome.stdout,
        format!(
            "{}\n",
            json!({
                "forge": "gitea",
                "host": "gitea.test",
                "project": "owner/name",
                "login": "alice",
                "source": "GITEA_TOKEN",
                "active": true,
                "permission": "pull",
                "canWrite": false,
            })
        )
    );
    let document = json_of(&outcome);
    assert_eq!(
        document
            .as_object()
            .expect("an object")
            .keys()
            .cloned()
            .collect::<Vec<String>>(),
        vec![
            "forge",
            "host",
            "project",
            "login",
            "source",
            "active",
            "permission",
            "canWrite"
        ]
    );
    assert!(document.get("token").is_none());
    assert_no_token(&outcome, "gitea-secret-value");

    let human = forge_auth::execute(
        &parsed_of(&["check"], &repo, &context.environment),
        &context,
    )
    .await;
    assert_eq!(human.exit_code, 0);
    assert_eq!(
        human.stdout,
        "gitea.test owner/name: alice (pull, active) via GITEA_TOKEN\n"
    );
    assert_no_token(&human, "gitea-secret-value");
}

#[tokio::test]
async fn forge_gitea_defaults_the_host_to_the_configured_gitea_address() {
    let server = StubServer::start(gitea_handler(
        json!({"pull": true, "push": true}),
        "alice",
    ))
    .await;
    let root = git_repo("configured-host", None);
    let environment = forge::environment(&[
        ("GITEA_TOKEN", "configured-secret"),
        ("DEVBOARD_GITEA_URL", server.base.as_str()),
    ]);
    let context = Context {
        exec: unavailable_exec(),
        transport: forge::default_transport(5_000),
        environment,
    };

    let parsed = parsed_of(
        &["check", "--forge", "gitea", "--project", "owner/name", "--json"],
        &root,
        &context.environment,
    );
    assert_eq!(parsed.host, server.host());
    assert_eq!(parsed.forge, Some(forge::Forge::Gitea));

    let outcome = forge_auth::execute(&parsed, &context).await;
    assert_eq!(outcome.exit_code, 0);
    let document = json_of(&outcome);
    assert_eq!(document["forge"], json!("gitea"));
    assert_eq!(document["host"], json!(server.host()));
    assert_eq!(document["project"], json!("owner/name"));
    assert_eq!(document["canWrite"], json!(true));
    assert_no_token(&outcome, "configured-secret");
}

#[tokio::test]
async fn gitea_token_precedence_follows_the_configured_order() {
    let server = StubServer::start(gitea_handler(
        json!({"pull": true, "push": true}),
        "alice",
    ))
    .await;
    let root = git_repo("token-order", None);
    let environment = forge::environment(&[
        ("GITEA_TOKEN", "preferred-token"),
        ("DEVBOARD_GITEA_TOKEN", "fallback-token"),
        ("DEVBOARD_GITEA_URL", server.base.as_str()),
    ]);
    let context = Context {
        exec: unavailable_exec(),
        transport: forge::default_transport(5_000),
        environment,
    };

    let parsed = parsed_of(
        &["check", "--forge", "gitea", "--project", "owner/name", "--json"],
        &root,
        &context.environment,
    );
    let outcome = forge_auth::execute(&parsed, &context).await;
    assert_eq!(outcome.exit_code, 0);
    assert_eq!(
        server.authorization("/api/v1/repos/owner/name").as_deref(),
        Some("token preferred-token")
    );
    assert_eq!(json_of(&outcome)["source"], json!("GITEA_TOKEN"));
    assert_no_token(&outcome, "preferred-token");
    assert_no_token(&outcome, "fallback-token");

    let fallback_server = StubServer::start(gitea_handler(
        json!({"pull": true, "push": true}),
        "alice",
    ))
    .await;
    let fallback_environment = forge::environment(&[
        ("DEVBOARD_GITEA_TOKEN", "fallback-token"),
        ("DEVBOARD_GITEA_URL", fallback_server.base.as_str()),
    ]);
    let fallback_context = Context {
        exec: unavailable_exec(),
        transport: forge::default_transport(5_000),
        environment: fallback_environment,
    };
    let fallback = forge_auth::execute(
        &parsed_of(
            &["check", "--forge", "gitea", "--project", "owner/name", "--json"],
            &root,
            &fallback_context.environment,
        ),
        &fallback_context,
    )
    .await;
    assert_eq!(fallback.exit_code, 0);
    assert_eq!(
        fallback_server
            .authorization("/api/v1/repos/owner/name")
            .as_deref(),
        Some("token fallback-token")
    );
    assert_no_token(&fallback, "fallback-token");
}

#[tokio::test]
async fn a_public_repository_reports_an_anonymous_read_identity() {
    let server = StubServer::start(gitea_handler(
        json!({"pull": true, "push": false}),
        "alice",
    ))
    .await;
    let root = git_repo("anonymous", None);
    let environment = forge::environment(&[("DEVBOARD_GITEA_URL", server.base.as_str())]);
    let context = Context {
        exec: unavailable_exec(),
        transport: forge::default_transport(5_000),
        environment,
    };

    let parsed = parsed_of(
        &["check", "--forge", "gitea", "--project", "owner/name", "--json"],
        &root,
        &context.environment,
    );
    let outcome = forge_auth::execute(&parsed, &context).await;
    assert_eq!(outcome.exit_code, 0);
    let document = json_of(&outcome);
    assert_eq!(document["login"], json!("anonymous"));
    assert_eq!(document["source"], json!("public repository"));
    assert_eq!(document["canWrite"], json!(false));
    assert_eq!(server.authorization("/api/v1/repos/owner/name"), None);
}

// ---------------------------------------------------------------------------
// Scope

#[tokio::test]
async fn write_against_a_read_only_identity_exits_nonzero_with_a_scope_message() {
    let server = StubServer::start(gitea_handler(
        json!({"pull": true, "push": false, "admin": false}),
        "alice",
    ))
    .await;
    let root = git_repo("read-only", None);
    let environment = forge::environment(&[
        ("GITEA_TOKEN", "read-only-secret"),
        ("DEVBOARD_GITEA_URL", server.base.as_str()),
    ]);
    let context = Context {
        exec: unavailable_exec(),
        transport: forge::default_transport(5_000),
        environment,
    };

    let parsed = parsed_of(
        &[
            "check",
            "--forge",
            "gitea",
            "--project",
            "owner/name",
            "--required",
            "write",
            "--json",
        ],
        &root,
        &context.environment,
    );
    let outcome = forge_auth::execute(&parsed, &context).await;
    assert_eq!(outcome.exit_code, 1);
    assert_eq!(outcome.stdout, "");
    assert_eq!(
        outcome.stderr,
        format!(
            "the Gitea account alice cannot write to owner/name on {}\n",
            server.base
        )
    );
    assert_no_token(&outcome, "read-only-secret");
}

// ---------------------------------------------------------------------------
// exec

/// Writes a child named `gh` that records the credential it received.
#[cfg(unix)]
fn recording_gh(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let executable = root.join("gh");
    std::fs::write(
        &executable,
        concat!(
            "#!/bin/sh\n",
            "printf '%s' \"${GH_TOKEN-}\" > \"$MARKER_TOKEN_FILE\"\n",
            "printf '%s' \"${GH_HOST-}\" > \"$MARKER_HOST_FILE\"\n",
            "exit \"${MARKER_EXIT_CODE:-0}\"\n",
        ),
    )
    .expect("the child script");
    let mut permissions = std::fs::metadata(&executable)
        .expect("the child metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&executable, permissions).expect("an executable child");
    let token_file = root.join("token.txt");
    let host_file = root.join("host.txt");
    (executable, token_file, host_file)
}

#[cfg(unix)]
#[tokio::test]
async fn exec_runs_the_child_with_the_selected_token_in_its_environment() {
    let root = temp_dir("exec-env");
    let (executable, token_file, host_file) = recording_gh(&root);
    let (exec, calls) = github_exec(json!({"pull": true, "push": true, "admin": false}));
    let mut environment = forge::environment(&[("PATH", "/usr/bin:/bin")]);
    environment.insert(
        "MARKER_TOKEN_FILE".to_string(),
        token_file.to_string_lossy().into_owned(),
    );
    environment.insert(
        "MARKER_HOST_FILE".to_string(),
        host_file.to_string_lossy().into_owned(),
    );
    environment.insert("MARKER_EXIT_CODE".to_string(), "7".to_string());
    let context = Context {
        exec,
        transport: forge::default_transport(5_000),
        environment,
    };

    let parsed = parsed_of(
        &[
            "exec",
            "--host",
            "github.test",
            "--project",
            "owner/name",
            "--required",
            "write",
            "--",
            &executable.to_string_lossy(),
            "api",
            "user",
        ],
        &root,
        &context.environment,
    );
    assert_eq!(parsed.action, Action::Exec);
    assert_eq!(
        parsed.command,
        vec![
            executable.to_string_lossy().into_owned(),
            "api".to_string(),
            "user".to_string()
        ]
    );

    let outcome = forge_auth::execute(&parsed, &context).await;
    assert_eq!(outcome.exit_code, 7);
    assert_eq!(
        std::fs::read_to_string(&token_file).expect("the token marker"),
        "secret-gh"
    );
    assert_eq!(
        std::fs::read_to_string(&host_file).expect("the host marker"),
        "github.test"
    );
    assert_eq!(
        outcome.stderr,
        "forge-auth: using alice (push) for github.test/owner/name\n"
    );
    assert!(!outcome.stderr.contains("secret-gh"));
    assert!(!outcome.stdout.contains("secret-gh"));
    assert!(calls
        .lock()
        .expect("calls")
        .iter()
        .all(|args| !args.iter().any(|argument| argument.contains("secret-gh"))));
}

#[cfg(unix)]
#[tokio::test]
async fn exec_never_starts_the_child_when_the_scope_check_fails() {
    let root = temp_dir("exec-refused");
    let (executable, token_file, host_file) = recording_gh(&root);
    let (exec, _calls) = github_exec(json!({"pull": true, "push": false, "admin": false}));
    let mut environment = forge::environment(&[("PATH", "/usr/bin:/bin")]);
    environment.insert(
        "MARKER_TOKEN_FILE".to_string(),
        token_file.to_string_lossy().into_owned(),
    );
    environment.insert(
        "MARKER_HOST_FILE".to_string(),
        host_file.to_string_lossy().into_owned(),
    );
    let context = Context {
        exec,
        transport: forge::default_transport(5_000),
        environment,
    };

    let parsed = parsed_of(
        &[
            "exec",
            "--host",
            "github.test",
            "--project",
            "owner/name",
            "--required",
            "write",
            "--",
            &executable.to_string_lossy(),
            "api",
            "user",
        ],
        &root,
        &context.environment,
    );
    let outcome = forge_auth::execute(&parsed, &context).await;
    assert_eq!(outcome.exit_code, 1);
    assert_eq!(outcome.stdout, "");
    assert!(
        outcome.stderr.contains(
            "no authenticated GitHub account has write access to owner/name on github.test"
        ),
        "unexpected refusal: {}",
        outcome.stderr
    );
    assert!(outcome.stderr.contains("pull access only"));
    assert!(!token_file.exists(), "the child wrote its marker");
    assert!(!host_file.exists(), "the child wrote its marker");
    assert!(!outcome.stderr.contains("secret-gh"));
}

#[cfg(unix)]
#[tokio::test]
async fn exec_refuses_a_child_that_is_not_the_forge_cli() {
    let root = temp_dir("exec-name");
    let environment = forge::environment(&[]);
    let (exec, _calls) = github_exec(json!({"pull": true, "push": true}));
    let context = Context {
        exec,
        transport: forge::default_transport(5_000),
        environment,
    };
    let parsed = parsed_of(
        &[
            "exec",
            "--host",
            "github.test",
            "--project",
            "owner/name",
            "--",
            "/bin/sh",
            "-c",
            "exit 0",
        ],
        &root,
        &context.environment,
    );
    let outcome = forge_auth::execute(&parsed, &context).await;
    assert_eq!(outcome.exit_code, 2);
    assert_eq!(
        outcome.stderr,
        "forge-auth: github requires gh, got /bin/sh\n"
    );
}

// ---------------------------------------------------------------------------
// Usage

#[test]
fn usage_errors_name_the_flag_and_never_run_a_probe() {
    let root = git_repo("usage", None);
    let environment = forge::environment(&[]);

    let missing = parse(&["check"], &root, &environment).expect_err("no target");
    assert_eq!(
        missing.message,
        "--host is required when neither DEVBOARD_GITEA_URL nor the origin remote names one"
    );

    let project = parse(&["check", "--host", "gitea.test"], &root, &environment)
        .expect_err("no project");
    assert_eq!(
        project.message,
        "--project is required when the origin remote does not name a repository"
    );

    let forge = parse(&["check", "--forge", "bitbucket"], &root, &environment)
        .expect_err("bad forge");
    assert_eq!(
        forge.message,
        "--forge must be github, gitlab, or gitea, got: bitbucket"
    );

    let required = parse(&["check", "--required", "admin"], &root, &environment)
        .expect_err("bad access");
    assert_eq!(
        required.message,
        "--required must be read or write, got: admin"
    );

    let action = parse(&["frobnicate"], &root, &environment).expect_err("bad action");
    assert_eq!(action.message, "unknown action: frobnicate");

    let option = parse(
        &["check", "--host", "h", "--project", "o/n", "--bogus"],
        &root,
        &environment,
    )
    .expect_err("bad option");
    assert_eq!(option.message, "unknown option: --bogus");

    let argument = parse(
        &["check", "--host", "h", "--project", "o/n", "extra"],
        &root,
        &environment,
    )
    .expect_err("bad argument");
    assert_eq!(argument.message, "unexpected argument: extra");

    let empty = parse(
        &["exec", "--host", "h", "--project", "o/n"],
        &root,
        &environment,
    )
    .expect_err("no command");
    assert_eq!(empty.message, "exec requires a command after --");

    let trimmed = parse(
        &["check", "--host", " h ", "--project", "/o/n/"],
        &root,
        &environment,
    )
    .expect("a target");
    assert_eq!(trimmed.host, "h");
    assert_eq!(trimmed.project, "o/n");

    let owned: Vec<String> = Vec::new();
    assert_eq!(
        forge_auth::parse(&owned, &root, &environment).expect("help"),
        Start::Help
    );
    let help = vec!["check".to_string(), "--help".to_string()];
    assert_eq!(
        forge_auth::parse(&help, &root, &environment).expect("help"),
        Start::Help
    );
}

// ---------------------------------------------------------------------------
// The shipped binary

/// A `PATH` holding unauthenticated `gh` and `glab` stubs, so the fallback
/// chain is deterministic without touching a real credential store.
#[cfg(unix)]
fn placeholder_cli_path(root: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;

    let directory = root.join("bin");
    std::fs::create_dir_all(&directory).expect("a PATH directory");
    for name in ["gh", "glab"] {
        let executable = directory.join(name);
        std::fs::write(&executable, "#!/bin/sh\nexit 1\n").expect("a CLI stub");
        let mut permissions = std::fs::metadata(&executable)
            .expect("the stub metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).expect("an executable stub");
    }
    format!(
        "{}:{}",
        directory.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

#[cfg(unix)]
#[tokio::test]
async fn the_binary_exits_with_the_check_verdict_and_prints_no_token() {
    let server = StubServer::start(gitea_handler(
        json!({"pull": true, "push": false, "admin": false}),
        "alice",
    ))
    .await;
    let repo = git_repo(
        "binary",
        Some("https://gitea.test/owner/name.git"),
    );
    let path = placeholder_cli_path(&repo);
    let binary = env!("CARGO_BIN_EXE_devboard");

    let read = tokio::process::Command::new(binary)
        .args(["forge-auth", "check", "--required", "read", "--json"])
        .current_dir(&repo)
        .env("DEVBOARD_GITEA_URL", server.base.as_str())
        .env("GITEA_TOKEN", "binary-secret")
        .env("PATH", &path)
        .output()
        .await
        .expect("the binary");
    assert!(read.status.success());
    let stdout = String::from_utf8_lossy(&read.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&read.stderr).into_owned();
    assert_eq!(stderr, "");
    assert!(!stdout.contains("binary-secret"));
    let document: Value = serde_json::from_str(&stdout).expect("the check report");
    assert_eq!(document["forge"], json!("gitea"));
    assert_eq!(document["host"], json!("gitea.test"));
    assert_eq!(document["project"], json!("owner/name"));
    assert_eq!(document["source"], json!("GITEA_TOKEN"));

    let write = tokio::process::Command::new(binary)
        .args(["forge-auth", "check", "--required", "write"])
        .current_dir(&repo)
        .env("DEVBOARD_GITEA_URL", server.base.as_str())
        .env("GITEA_TOKEN", "binary-secret")
        .env("PATH", &path)
        .output()
        .await
        .expect("the binary");
    assert_eq!(write.status.code(), Some(1));
    let refusal = String::from_utf8_lossy(&write.stderr).into_owned();
    assert!(refusal.contains("cannot write to owner/name"));
    assert!(!refusal.contains("binary-secret"));
    assert!(write.stdout.is_empty());
}
