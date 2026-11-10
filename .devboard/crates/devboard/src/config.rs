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
        Self::from_environment(|name| env::var(name).ok())
    }

    /// The resolution [`Self::from_env`] applies, over one environment read.
    fn from_environment(read: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let base_url = read("DEVBOARD_GITEA_URL")?.trim().to_string();
        if base_url.is_empty() {
            return None;
        }
        let token = read("GITEA_TOKEN")
            .or_else(|| read("DEVBOARD_GITEA_TOKEN"))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let timeout_ms = read("DEVBOARD_FEEDBACK_TIMEOUT_MS")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(60_000);
        Some(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            repo: crate::release::release_project(read("DEVBOARD_RELEASE_REPO").as_deref()),
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
        let repo_dir = env::var("REPO_DIR").ok().map(PathBuf::from);
        let goal_file = env::var("GOAL_FILE").ok().map(PathBuf::from);
        let static_dir = env::var("STATIC_DIR").ok().map(PathBuf::from);
        let agent_command = env::var("AGENT_COMMAND").unwrap_or_else(|_| "omp acp".to_string());
        let state_dir = env::var("STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| running_harness_dir.join(".tmp"));
        let repo_dir_supplied = repo_dir.is_some();
        let goal_file_supplied = goal_file.is_some();
        let mut config = Self {
            hostname,
            port,
            adrs_dir,
            // Both are filled by `derive_path_defaults` below when the
            // environment supplied neither.
            repo_dir: repo_dir.unwrap_or_default(),
            goal_file: goal_file.unwrap_or_default(),
            static_dir,
            agent_command,
            state_dir,
            allowed_hosts,
            feedback: FeedbackConfig::from_env(),
        };
        config.derive_path_defaults(repo_dir_supplied, goal_file_supplied);
        config
    }

    /// Fills the path defaults that no explicit input supplied, from the values
    /// actually in force.
    ///
    /// The repository directory is the ADR directory's parent and the goal
    /// document is the repository's `GOAL.md`. The serve flag loop runs before
    /// the call that lands, so a `--adrs-dir` flag that replaced the ADR
    /// directory also moves the repository derived from it, exactly as an
    /// `ADRS_DIR` from the environment does. A `REPO_DIR`/`--repo-dir` and a
    /// `GOAL_FILE` stay authoritative: a supplied value is never re-derived.
    pub fn derive_path_defaults(&mut self, repo_dir_supplied: bool, goal_file_supplied: bool) {
        if !repo_dir_supplied {
            self.repo_dir = self
                .adrs_dir
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("/repo"));
        }
        if !goal_file_supplied {
            self.goal_file = self.repo_dir.join("GOAL.md");
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

    fn feedback(environment: &[(&str, &str)]) -> FeedbackConfig {
        FeedbackConfig::from_environment(|name| {
            environment
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        })
        .expect("DEVBOARD_GITEA_URL enables reporting")
    }

    fn feedback_with_repo(repo: Option<&str>) -> FeedbackConfig {
        let mut environment = vec![("DEVBOARD_GITEA_URL", "http://forge.example:3000")];
        if let Some(repo) = repo {
            environment.push(("DEVBOARD_RELEASE_REPO", repo));
        }
        feedback(&environment)
    }

    #[test]
    fn a_blank_release_repo_resolves_the_default_report_project() {
        for blank in ["", " ", "\t\n "] {
            assert_eq!(
                feedback_with_repo(Some(blank)).repo,
                crate::release::RELEASE_REPOSITORY,
                "{blank:?}"
            );
        }
    }

    #[test]
    fn an_absent_release_repo_resolves_the_default_report_project() {
        assert_eq!(
            feedback_with_repo(None).repo,
            crate::release::RELEASE_REPOSITORY
        );
    }

    #[test]
    fn a_set_release_repo_names_the_report_project() {
        assert_eq!(feedback_with_repo(Some(" owner/name ")).repo, "owner/name");
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

    #[test]
    fn an_adr_directory_moves_the_repository_derived_from_it() {
        let mut config = config("omp acp");
        config.adrs_dir = PathBuf::from("/host/checkout/adrs");
        config.derive_path_defaults(false, false);
        assert_eq!(config.repo_dir, PathBuf::from("/host/checkout"));
        assert_eq!(config.goal_file, PathBuf::from("/host/checkout/GOAL.md"));
    }

    #[test]
    fn a_supplied_repository_keeps_its_own_derived_goal() {
        let mut config = config("omp acp");
        config.adrs_dir = PathBuf::from("/host/other/adrs");
        config.repo_dir = PathBuf::from("/host/checkout");
        config.derive_path_defaults(true, false);
        assert_eq!(config.repo_dir, PathBuf::from("/host/checkout"));
        assert_eq!(config.goal_file, PathBuf::from("/host/checkout/GOAL.md"));
    }

    #[test]
    fn a_supplied_goal_file_is_never_re_derived() {
        let mut config = config("omp acp");
        config.adrs_dir = PathBuf::from("/host/checkout/adrs");
        config.goal_file = PathBuf::from("/host/goals/CUSTOM.md");
        config.derive_path_defaults(false, true);
        assert_eq!(config.repo_dir, PathBuf::from("/host/checkout"));
        assert_eq!(config.goal_file, PathBuf::from("/host/goals/CUSTOM.md"));
    }
}
