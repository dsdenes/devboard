//! Process configuration, resolved from the same environment variables the
//! TypeScript dashboard reads.

use std::env;
use std::path::{Path, PathBuf};

/// Every input a dashboard process takes from its environment.
#[derive(Clone, Debug)]
pub struct Config {
    pub hostname: String,
    pub port: u16,
    pub adrs_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub goal_file: PathBuf,
    /// The client directory to serve; `None` serves the embedded build.
    pub static_dir: Option<PathBuf>,
    pub agent_command: String,
    pub state_dir: PathBuf,
    pub allowed_hosts: Vec<String>,
    /// Harness reporting, enabled only by `DEVBOARD_GITEA_URL`.
    pub feedback: Option<FeedbackConfig>,
}

/// The Gitea target that receives harness reports.
#[derive(Clone, Debug)]
pub struct FeedbackConfig {
    pub base_url: String,
    pub repo: String,
    pub token: Option<String>,
    pub timeout_ms: u64,
}

impl FeedbackConfig {
    /// Resolves the configuration from the environment, or `None` when
    /// harness reporting is disabled.
    pub fn from_env() -> Option<Self> {
        let base_url = env::var("DEVBOARD_GITEA_URL").ok()?.trim().to_string();
        if base_url.is_empty() {
            return None;
        }
        let token = env::var("GITEA_TOKEN")
            .ok()
            .or_else(|| env::var("DEVBOARD_GITEA_TOKEN").ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let timeout_ms = env::var("DEVBOARD_FEEDBACK_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(60_000);
        Some(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            repo: env::var("DEVBOARD_RELEASE_REPO")
                .unwrap_or_else(|_| "dsdenes/devboard".to_string()),
            token,
            timeout_ms,
        })
    }
}

impl Config {
    /// Resolves the configuration from the process environment.
    ///
    /// `running_harness_dir` is the directory of the running harness, which is
    /// the default static root's parent and the default state directory's
    /// parent, exactly as the TypeScript entry point computes them.
    pub fn from_env(running_harness_dir: &Path) -> Self {
        let hostname = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let allowed_hosts = env::var("DEVBOARD_ALLOWED_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
        let port = env::var("PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        let adrs_dir = env::var("ADRS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/repo/adrs"));
        let repo_dir = env::var("REPO_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            adrs_dir
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("/repo"))
        });
        let goal_file = env::var("GOAL_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| repo_dir.join("GOAL.md"));
        let static_dir = env::var("STATIC_DIR").ok().map(PathBuf::from);
        let agent_command = env::var("AGENT_COMMAND").unwrap_or_else(|_| "omp acp".to_string());
        let state_dir = env::var("STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| running_harness_dir.join(".tmp"));
        Self {
            hostname,
            port,
            adrs_dir,
            repo_dir,
            goal_file,
            static_dir,
            agent_command,
            state_dir,
            allowed_hosts,
            feedback: FeedbackConfig::from_env(),
        }
    }

    /// The executable the configured agent command would spawn.
    ///
    /// This is the dashboard's agent prerequisite: the first whitespace-split
    /// token of `AGENT_COMMAND` must name a file this process can execute. A
    /// missing program is an error that names it, so a start refuses a command
    /// it could never run instead of failing every Start later. `Ok` carries
    /// the program a start would spawn.
    pub fn agent_executable(&self) -> Result<PathBuf, String> {
        let Some(program) = program_token(&self.agent_command) else {
            return Err(
                "AGENT_COMMAND is empty; name the agent CLI the dashboard should start".to_string(),
            );
        };
        resolve_executable(program).ok_or_else(|| {
            format!(
                "the agent command \"{}\" cannot start: \"{program}\" is not an executable \
                 file and is not on PATH; install the agent CLI or point AGENT_COMMAND at an \
                 executable path the operator mounts",
                self.agent_command
            )
        })
    }
}

/// The program token of an agent command: its first whitespace-separated word,
/// exactly as [`crate::acp::split_command`] splits the same string for a spawn.
fn program_token(command: &str) -> Option<&str> {
    command.split_whitespace().next()
}

/// Resolves `program` to the executable file a spawn would run.
///
/// A token carrying a path separator is checked in place; a bare name is
/// searched on `PATH` in order. A file the process cannot execute never
/// matches, because the spawn would fail on it exactly as on a missing one.
fn resolve_executable(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if program.contains(std::path::MAIN_SEPARATOR) || path.is_absolute() {
        return executable_file(path).then_some(path.to_path_buf());
    }
    let search = env::var_os("PATH")?;
    env::split_paths(&search)
        .map(|directory| directory.join(program))
        .find(|candidate| executable_file(candidate))
}

fn executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(agent_command: &str) -> Config {
        Config {
            hostname: "127.0.0.1".to_string(),
            port: 8080,
            adrs_dir: PathBuf::from("adrs"),
            repo_dir: PathBuf::from("repo"),
            goal_file: PathBuf::from("repo/GOAL.md"),
            static_dir: None,
            agent_command: agent_command.to_string(),
            state_dir: PathBuf::from("state"),
            allowed_hosts: Vec::new(),
            feedback: None,
        }
    }

    #[test]
    fn the_program_token_is_the_first_word_of_the_agent_command() {
        assert_eq!(program_token("omp acp"), Some("omp"));
        assert_eq!(
            program_token("  /opt/agent/cli --flag"),
            Some("/opt/agent/cli")
        );
        assert_eq!(program_token("   "), None);
    }

    #[test]
    fn an_absolute_agent_program_resolves_in_place() {
        let resolved = config("/bin/sh -l").agent_executable().expect("sh exists");
        assert_eq!(resolved, PathBuf::from("/bin/sh"));
    }

    #[test]
    fn a_missing_agent_program_is_named_in_the_refusal() {
        let error = config("devboard-missing-agent-fixture acp")
            .agent_executable()
            .expect_err("the fixture is not on PATH");
        assert!(error.contains("devboard-missing-agent-fixture"), "{error}");
        assert!(error.contains("PATH"), "{error}");
    }

    #[test]
    fn an_absolute_agent_program_that_is_not_executable_is_refused() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/config.rs");
        let error = config(&format!("{} acp", fixture.display()))
            .agent_executable()
            .expect_err("the source file is not an executable");
        assert!(error.contains(&fixture.display().to_string()), "{error}");
    }

    #[test]
    fn an_empty_agent_command_is_refused_by_name() {
        let error = config("  ").agent_executable().expect_err("empty");
        assert!(error.contains("AGENT_COMMAND"), "{error}");
    }
}
