//! `devboard forge-auth`: resolve the one forge credential an agent should use,
//! or run a forge command with it.
//!
//! Prompts call this instead of `gh`/`glab` directly so every tracker read and
//! write goes through the same verified identity. `exec` places the selected
//! token in the child environment only: it never appears in an argument, a log
//! line, or an error.
//!
//! The credential resolution itself lives in [`crate::forge`]; this module owns
//! the command line (action, target inference, scope requirement), the reported
//! rendering, and the child process.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::json;
use url::Url;

use crate::forge::{
    self, AuthFailure, AuthOutcome, Environment, Forge, RequiredAccess, ResolveOptions,
    ResolvedAuth,
};

/// The command line contract. Keep the wording stable: prompts quote it.
pub const USAGE: &str = concat!(
    "Usage:\n",
    "  forge-auth check [--host <host>] [--project <owner/repo>] [options]\n",
    "  forge-auth exec  [--host <host>] [--project <owner/repo>] [options] --\n",
    "                   <command> <args...>\n",
    "\n",
    "Options:\n",
    "  --host <host>        forge hostname, e.g. github.com; defaults to the Gitea URL's\n",
    "                       host for --forge gitea, otherwise the origin remote's host\n",
    "  --project <path>     repository path; defaults to the origin remote's path\n",
    "  --forge <name>       github, gitlab, or gitea; inferred from the host when omitted\n",
    "  --required <access>  read or write; default read\n",
    "  --cwd <path>         working directory; default the current directory\n",
    "  --repo <path>        synonym for --cwd, for callers naming the checkout\n",
    "  --url <url>          Gitea HTTP origin; defaults to DEVBOARD_GITEA_URL\n",
    "  --json               machine-readable check output (check only)\n",
    "  --quiet              suppress the selected-identity line on stderr\n",
    "  -h, --help           show this help\n",
    "\n",
    "Exit status: 0 when a credential was selected and the command succeeded;\n",
    "1 when no authenticated account meets the requirement; 2 on usage errors.\n",
);

/// The two actions the wrapper performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Check,
    Exec,
}

/// One fully resolved command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub action: Action,
    pub host: String,
    pub project: String,
    /// The forge the caller pinned; `None` infers it from the host.
    pub forge: Option<Forge>,
    pub required: RequiredAccess,
    pub cwd: PathBuf,
    pub url: Option<String>,
    pub json: bool,
    pub quiet: bool,
    /// The child command of `exec`, empty for `check`.
    pub command: Vec<String>,
    /// Whether `--host` was omitted, so the origin (or the configured Gitea
    /// address) named the host. An inferred host is classified like the
    /// checkout's origin; an explicit one keeps the legacy GitHub and GitLab
    /// probe chain.
    pub host_inferred: bool,
}

/// The result of scanning the arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Start {
    Help,
    Run(Parsed),
}

/// A command line the wrapper refuses before any credential probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError {
    pub message: String,
}

impl UsageError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// One forge target named by a remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginTarget {
    pub host: String,
    pub project: String,
}

/// The origin remote's forge target, for callers that omit `--host` or
/// `--project`. Git resolves the remote from a subdirectory exactly as it does
/// in the checkout root.
pub fn origin_target(cwd: &Path, environment: &Environment) -> Option<OriginTarget> {
    let remote = forge::origin_remote_url(cwd)?;
    let parsed = forge::parse_forge_remote(&remote, environment)?;
    Some(OriginTarget {
        host: parsed.host,
        project: parsed.project,
    })
}

/// The host label of the configured Gitea HTTP origin, if any.
pub fn configured_gitea_host(environment: &Environment) -> Option<String> {
    let url = forge::configured_gitea_url(environment)?;
    let parsed = Url::parse(&url).ok()?;
    let host = parsed.host_str()?;
    Some(match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

/// Parses the wrapper's arguments, resolving a missing host or project from the
/// origin remote and the configured Gitea address.
pub fn parse(args: &[String], cwd: &Path, environment: &Environment) -> Result<Start, UsageError> {
    let Some(action) = args.first() else {
        return Ok(Start::Help);
    };
    if action == "-h" || action == "--help" {
        return Ok(Start::Help);
    }
    let action = match action.as_str() {
        "check" => Action::Check,
        "exec" => Action::Exec,
        other => return Err(UsageError::new(format!("unknown action: {other}"))),
    };

    let mut host: Option<String> = None;
    let mut project: Option<String> = None;
    let mut forge_name: Option<Forge> = None;
    let mut required = RequiredAccess::Read;
    let mut working = cwd.to_path_buf();
    let mut url: Option<String> = None;
    let mut json_output = false;
    let mut quiet = false;
    let mut command: Vec<String> = Vec::new();

    let mut index = 1;
    while index < args.len() {
        let argument = args[index].as_str();
        index += 1;
        match argument {
            "--" => {
                command.extend(args[index..].iter().cloned());
                break;
            }
            "-h" | "--help" => return Ok(Start::Help),
            "--host" => {
                host = args.get(index).cloned();
                index += 1;
            }
            "--project" => {
                project = args.get(index).cloned();
                index += 1;
            }
            "--forge" => {
                let value = args.get(index).cloned();
                index += 1;
                match value.as_deref() {
                    Some("github") => forge_name = Some(Forge::GitHub),
                    Some("gitlab") => forge_name = Some(Forge::GitLab),
                    Some("gitea") => forge_name = Some(Forge::Gitea),
                    other => {
                        return Err(UsageError::new(format!(
                            "--forge must be github, gitlab, or gitea, got: {}",
                            other.unwrap_or("nothing")
                        )))
                    }
                }
            }
            "--required" => {
                let value = args.get(index).cloned();
                index += 1;
                match value.as_deref() {
                    Some("read") => required = RequiredAccess::Read,
                    Some("write") => required = RequiredAccess::Write,
                    other => {
                        return Err(UsageError::new(format!(
                            "--required must be read or write, got: {}",
                            other.unwrap_or("nothing")
                        )))
                    }
                }
            }
            "--cwd" | "--repo" => {
                if let Some(value) = args.get(index) {
                    working = PathBuf::from(value);
                }
                index += 1;
            }
            "--url" => {
                url = args.get(index).cloned();
                index += 1;
            }
            "--json" => json_output = true,
            "--quiet" => quiet = true,
            other => {
                if other.starts_with('-') {
                    return Err(UsageError::new(format!("unknown option: {other}")));
                }
                return Err(UsageError::new(format!("unexpected argument: {other}")));
            }
        }
    }

    let host_inferred = host.is_none();
    let origin = if host.is_none() || project.is_none() {
        origin_target(&working, environment)
    } else {
        None
    };
    let origin_host = origin.as_ref().map(|target| target.host.clone());
    let origin_project = origin.as_ref().map(|target| target.project.clone());
    let inferred_host = if forge_name == Some(Forge::Gitea) {
        configured_gitea_host(environment).or(origin_host)
    } else {
        origin_host
    };
    let host = host
        .filter(|value| !value.trim().is_empty())
        .or(inferred_host);
    let project = project
        .filter(|value| !value.trim().is_empty())
        .or(origin_project);
    let Some(host) = host else {
        return Err(UsageError::new(
            "--host is required when neither DEVBOARD_GITEA_URL nor the origin remote names one",
        ));
    };
    let Some(project) = project else {
        return Err(UsageError::new(
            "--project is required when the origin remote does not name a repository",
        ));
    };
    if action == Action::Exec && command.is_empty() {
        return Err(UsageError::new("exec requires a command after --"));
    }

    Ok(Start::Run(Parsed {
        action,
        host: host.trim().to_string(),
        project: project.trim().trim_matches('/').to_string(),
        forge: forge_name,
        required,
        cwd: working,
        url,
        json: json_output,
        quiet,
        command,
        host_inferred,
    }))
}

/// Everything one invocation needs, with the seams a test replaces.
#[derive(Clone)]
pub struct Context {
    /// The credential probe runner (`gh`/`glab`).
    pub exec: forge::Exec,
    /// The Gitea API transport.
    pub transport: forge::Transport,
    /// The base environment, already string-valued.
    pub environment: Environment,
}

impl Context {
    /// A context over `environment` with the real command and HTTP seams.
    pub fn new(environment: Environment) -> Self {
        Self {
            exec: forge::default_exec(),
            transport: forge::default_transport(forge::GITEA_REQUEST_TIMEOUT_MS),
            environment,
        }
    }

    /// The production context: this process's environment and real seams.
    pub fn production() -> Self {
        Self::new(forge::process_environment())
    }
}

/// Resolves the one credential a command should use.
///
/// A pinned `--forge` decides directly. A host inferred from the checkout's
/// origin is classified exactly like the origin: `github.com` is GitHub, a
/// GitLab host is GitLab, an explicit `DEVBOARD_FORGE` wins, and every other
/// host — including this checkout's Gitea origin — is Gitea. No `gh` or `glab`
/// probe starts for a Gitea host. An explicit `--host` that is not
/// `github.com` or GitLab keeps the legacy GitHub and GitLab probe, which a
/// self-hosted GitHub Enterprise `--host` needs. The Gitea probe runs only for
/// the configured Gitea address, because every Gitea request goes to that
/// address: a foreign `--host` is refused instead of being reported as
/// resolved from a server it does not name.
pub async fn resolve(parsed: &Parsed, context: &Context) -> AuthOutcome {
    if let Some(forge) = parsed.forge {
        return resolve_for(parsed, context, forge).await;
    }
    let lower = parsed.host.to_ascii_lowercase();
    let gitea_host =
        configured_gitea_host(&context.environment).map(|host| host.to_ascii_lowercase());
    if lower == "github.com" || lower.contains("gitlab") {
        return resolve_for(
            parsed,
            context,
            forge::forge_from_host(&lower, &context.environment),
        )
        .await;
    }
    if parsed.host_inferred || gitea_host.as_deref() == Some(lower.as_str()) {
        return resolve_for(
            parsed,
            context,
            forge::forge_from_host(&lower, &context.environment),
        )
        .await;
    }

    let github = resolve_for(parsed, context, Forge::GitHub).await;
    if !github.is_failure() {
        return github;
    }
    let gitlab = resolve_for(parsed, context, Forge::GitLab).await;
    if !gitlab.is_failure() {
        return gitlab;
    }
    // The Gitea probe queries the configured address and reports the requested
    // host, so it answers only for a host that address serves. An exact match
    // already resolved above; a foreign `--host` must never inherit an
    // identity read from a server it does not name.
    if let Some(address) = configured_gitea_host(&context.environment) {
        return AuthOutcome::Failure(AuthFailure {
            error: format!(
                "{} is not the configured Gitea address {address}; pass --host {address} or omit --host\ngh: {}\nglab: {}",
                parsed.host,
                failure_message(&github),
                failure_message(&gitlab),
            ),
        });
    }
    let gitea = resolve_for(parsed, context, Forge::Gitea).await;
    if !gitea.is_failure() {
        return gitea;
    }
    AuthOutcome::Failure(AuthFailure {
        error: format!(
            "no authenticated forge account has {} access to {} on {}\ngh: {}\nglab: {}\ngitea: {}",
            parsed.required.as_str(),
            parsed.project,
            parsed.host,
            failure_message(&github),
            failure_message(&gitlab),
            failure_message(&gitea),
        ),
    })
}

async fn resolve_for(parsed: &Parsed, context: &Context, forge: Forge) -> AuthOutcome {
    let options = ResolveOptions {
        forge,
        host: parsed.host.clone(),
        project: parsed.project.clone(),
        cwd: parsed.cwd.clone(),
        required: parsed.required,
        env: context.environment.clone(),
        deadline_ms: None,
        base_url: parsed.url.clone(),
        gitea_transport: Some(context.transport.clone()),
    };
    forge::resolve_forge_auth(&context.exec, &options).await
}

fn failure_message(outcome: &AuthOutcome) -> String {
    match outcome {
        AuthOutcome::Failure(failure) => failure.error.clone(),
        AuthOutcome::Resolved(_) => String::new(),
    }
}

/// The `--json` document. It names the selected identity and never the token.
pub fn json_report(auth: &ResolvedAuth) -> String {
    let document = json!({
        "forge": auth.forge.as_str(),
        "host": auth.host,
        "project": auth.project,
        "login": auth.login,
        "source": auth.source,
        "active": auth.active,
        "permission": auth.permission.as_str(),
        "canWrite": auth.can_write,
    });
    format!("{}\n", crate::jsjson::stringify(&document))
}

/// The human line `check` prints without `--json`.
pub fn human_report(auth: &ResolvedAuth) -> String {
    format!(
        "{} {}: {} ({}{}) via {}\n",
        auth.host,
        auth.project,
        auth.login,
        auth.permission.as_str(),
        if auth.active { ", active" } else { "" },
        auth.source
    )
}

/// Everything one invocation produced: the text a caller prints and the status
/// the process exits with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl RunOutcome {
    fn success(stdout: String) -> Self {
        Self {
            stdout,
            stderr: String::new(),
            exit_code: 0,
        }
    }

    fn refusal(exit_code: i32, stderr: String) -> Self {
        Self {
            stdout: String::new(),
            stderr,
            exit_code,
        }
    }
}

/// Runs one parsed command: validates the scope, reports the identity, and, for
/// `exec`, starts the child only once the credential is known to suffice.
pub async fn execute(parsed: &Parsed, context: &Context) -> RunOutcome {
    let auth = match resolve(parsed, context).await {
        AuthOutcome::Resolved(auth) => auth,
        AuthOutcome::Failure(failure) => {
            return RunOutcome::refusal(1, format!("{}\n", failure.error))
        }
    };
    match parsed.action {
        Action::Check => RunOutcome::success(if parsed.json {
            json_report(&auth)
        } else {
            human_report(&auth)
        }),
        Action::Exec => exec(parsed, &auth, context).await,
    }
}

async fn exec(parsed: &Parsed, auth: &ResolvedAuth, context: &Context) -> RunOutcome {
    // A Gitea identity reaches the API through `GITEA_TOKEN`, so any child is
    // admissible; GitHub and GitLab are only ever driven by their CLIs.
    if auth.forge != Forge::Gitea {
        let expected = if auth.forge == Forge::GitHub {
            "gh"
        } else {
            "glab"
        };
        let executable = parsed.command.first().cloned().unwrap_or_default();
        let name = Path::new(&executable)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if name != expected {
            let got = if executable.is_empty() {
                "nothing".to_string()
            } else {
                executable
            };
            return RunOutcome::refusal(
                2,
                format!(
                    "forge-auth: {} requires {expected}, got {got}\n",
                    auth.forge.as_str()
                ),
            );
        }
    }

    let mut announcement = String::new();
    if !parsed.quiet {
        announcement = format!(
            "forge-auth: using {} ({}) for {}/{}\n",
            auth.login,
            auth.permission.as_str(),
            auth.host,
            auth.project
        );
    }
    let environment = match forge::auth_environment(auth, &context.environment) {
        Ok(environment) => environment,
        Err(error) => {
            return RunOutcome::refusal(1, format!("{announcement}forge-auth: {}\n", error.message))
        }
    };

    let mut child = tokio::process::Command::new(&parsed.command[0]);
    child
        .args(&parsed.command[1..])
        .current_dir(&parsed.cwd)
        .env_clear()
        .envs(environment.iter())
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    match child.status().await {
        Ok(status) => RunOutcome {
            stdout: String::new(),
            stderr: announcement,
            exit_code: status_code(&status),
        },
        Err(error) => RunOutcome::refusal(
            127,
            format!(
                "{announcement}forge-auth: could not run {}: {error}\n",
                parsed.command[0]
            ),
        ),
    }
}

fn status_code(status: &std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

/// `devboard forge-auth <args>`: prints the report and returns the process exit
/// status, so the caller's verdict and the child's status both survive.
pub async fn main(args: &[String]) -> i32 {
    let context = Context::production();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    match parse(args, &cwd, &context.environment) {
        Ok(Start::Help) => {
            print!("{USAGE}");
            0
        }
        Ok(Start::Run(parsed)) => {
            let outcome = execute(&parsed, &context).await;
            print!("{}", outcome.stdout);
            eprint!("{}", outcome.stderr);
            outcome.exit_code
        }
        Err(error) => {
            eprint!("forge-auth: {}\n\n{USAGE}", error.message);
            2
        }
    }
}
