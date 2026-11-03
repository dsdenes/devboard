//! Process configuration, resolved from the same environment variables the
//! TypeScript dashboard reads.

use std::env;
use std::path::{Path, PathBuf};

/// Every input a dashboard process takes from its environment.
#[derive(Clone, Debug)]
pub struct Config {
    pub hostname: String,
    pub port: u16,
    pub addr_dir: PathBuf,
    pub repo_dir: PathBuf,
    pub goal_file: PathBuf,
    /// The client directory to serve; `None` serves the embedded build.
    pub static_dir: Option<PathBuf>,
    pub agent_command: String,
    pub state_dir: PathBuf,
    pub allowed_hosts: Vec<String>,
    pub token: String,
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
        let addr_dir = env::var("ADRS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/repo/adrs"));
        let repo_dir = env::var("REPO_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            addr_dir
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
        let token = env::var("DEVBOARD_DASHBOARD_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(crate::config::generated_token);
        Self {
            hostname,
            port,
            addr_dir,
            repo_dir,
            goal_file,
            static_dir,
            agent_command,
            state_dir,
            allowed_hosts,
            token,
            feedback: FeedbackConfig::from_env(),
        }
    }
}

/// The RFC 6750 characters a dashboard credential may carry.
pub fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~+/=:-".contains(&byte))
}

/// A fresh dashboard credential: 32 random bytes in base64url without padding.
fn generated_token() -> String {
    use base64::Engine as _;
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
