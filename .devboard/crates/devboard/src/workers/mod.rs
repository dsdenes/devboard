//! The detached worker engines, one module per family.
//!
//! `devboard worker <family> --repo <dir> --state-dir <dir> ...` runs one
//! engine. The dashboard starts these processes; they never start the
//! dashboard.

pub mod api_standards;
pub mod builds;
pub mod consistent_naming;
pub mod dead_code;
pub mod design;
pub mod goal_draft;
pub mod issues;
pub mod mcp_optimizer;
pub mod release_train;
pub mod run_owner;
pub mod scout;
pub mod single_responsibility;
pub mod startup;
pub mod watchdog;
pub mod worktrees;

use std::path::Path;

/// One worker invocation's resolved inputs.
#[derive(Debug, Clone)]
pub struct WorkerInvocation {
    pub family: String,
    pub repo_dir: std::path::PathBuf,
    pub state_dir: std::path::PathBuf,
    /// Family-specific flags and values, in the order given.
    pub rest: Vec<String>,
    /// The complete worker argument vector, after the `worker` token.
    pub raw: Vec<String>,
}

impl WorkerInvocation {
    /// The value of one `--name value` or `--name=value` option.
    pub fn option(&self, name: &str) -> Option<&str> {
        let prefix = format!("--{name}=");
        for (index, argument) in self.rest.iter().enumerate() {
            if let Some(value) = argument.strip_prefix(&prefix) {
                return Some(value);
            }
            if argument == &format!("--{name}") {
                return self.rest.get(index + 1).map(String::as_str);
            }
        }
        None
    }

    /// Every `--name value` occurrence of a repeated option.
    pub fn options(&self, name: &str) -> Vec<String> {
        let mut values = Vec::new();
        let flag = format!("--{name}");
        let prefix = format!("--{name}=");
        let mut index = 0;
        while index < self.rest.len() {
            if let Some(value) = self.rest[index].strip_prefix(&prefix) {
                values.push(value.to_string());
                index += 1;
                continue;
            }
            if self.rest[index] == flag {
                if let Some(value) = self.rest.get(index + 1) {
                    values.push(value.clone());
                }
                index += 2;
                continue;
            }
            index += 1;
        }
        values
    }
}

/// Parses `worker <family> --repo <dir> --state-dir <dir> [rest]`.
pub fn parse(args: &[String]) -> anyhow::Result<WorkerInvocation> {
    let family = args
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("worker needs a family"))?;
    let mut invocation = WorkerInvocation {
        family,
        repo_dir: std::path::PathBuf::new(),
        state_dir: std::path::PathBuf::new(),
        rest: Vec::new(),
        raw: args.to_vec(),
    };
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--repo" => {
                invocation.repo_dir = args
                    .get(index + 1)
                    .map(std::path::PathBuf::from)
                    .ok_or_else(|| anyhow::anyhow!("--repo needs a directory"))?;
                index += 2;
            }
            "--state-dir" => {
                invocation.state_dir = args
                    .get(index + 1)
                    .map(std::path::PathBuf::from)
                    .ok_or_else(|| anyhow::anyhow!("--state-dir needs a directory"))?;
                index += 2;
            }
            other => {
                invocation.rest.push(other.to_string());
                index += 1;
            }
        }
    }
    Ok(invocation)
}

/// Runs one family's engine.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    // Each worker process enforces the same global cap and joins the same
    // slice; only the dashboard owns the slice properties, so a worker never
    // rewrites the budget of a dashboard that is already running.
    crate::resources::install_attached(&invocation.state_dir);
    if !invocation.repo_dir.is_dir() {
        anyhow::bail!(
            "the repository directory {} does not exist",
            invocation.repo_dir.display()
        );
    }
    run_family(invocation).await
}

async fn run_family(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    match invocation.family.as_str() {
        "goal-draft" => goal_draft::run(invocation).await,
        "run-owner" => run_owner::run(invocation).await,
        "issues" => issues::run(invocation).await,
        "scout" => scout::run(invocation).await,
        "design" => design::run(invocation).await,
        "api-standards" => api_standards::run(invocation).await,
        "dead-code" => dead_code::run(invocation).await,
        "single-responsibility" => single_responsibility::run(invocation).await,
        "consistent-naming" => consistent_naming::run(invocation).await,
        "mcp-optimizer" => mcp_optimizer::run(invocation).await,
        "release-train" => release_train::run(invocation).await,
        "watchdog" => watchdog::run(invocation).await,
        other => anyhow::bail!("unknown worker family {other}"),
    }
}

/// Whether a family name is one the harness ships.
pub fn known_family(family: &str) -> bool {
    matches!(
        family,
        "issues"
            | "scout"
            | "design"
            | "api-standards"
            | "dead-code"
            | "single-responsibility"
            | "consistent-naming"
            | "mcp-optimizer"
            | "release-train"
            | "watchdog"
    )
}

/// A path inside the state directory, for family workers.
pub fn state_path(invocation: &WorkerInvocation, name: &str) -> std::path::PathBuf {
    invocation.state_dir.join(name)
}

/// A path inside the repository, for family workers.
pub fn repo_path(invocation: &WorkerInvocation, name: &str) -> std::path::PathBuf {
    invocation.repo_dir.join(name)
}

#[allow(dead_code)]
fn _is_dir(path: &Path) -> bool {
    path.is_dir()
}
