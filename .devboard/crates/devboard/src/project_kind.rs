//! Which project a served checkout is, and which agent families that kind
//! permits.
//!
//! Two background families are project-kind specific: the Release Train runs
//! only in the harness source checkout, and Deploy on main runs only on host
//! projects. Everything else is [`Gate::Any`]. The snapshot, the dashboard's
//! Start refusal, and the `worker` command all read the same verdict here, so
//! a family can never be disabled on the card and startable from the CLI.

use std::path::Path;

/// The project kind a checkout is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectKind {
    /// The harness source checkout: the repository whose `.devboard` is the
    /// canonical harness source, not an installed prefix.
    HarnessSource,
    /// A host project: every other checkout, whether it carries an installed
    /// harness or no harness at all.
    Host,
}

/// Which project kind a family runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// Runs on every project.
    Any,
    /// Runs only in the harness source checkout.
    HarnessSource,
    /// Runs only on a host project.
    HostProject,
}

/// The reason a gated-off family carries, naming the project kind that
/// permits it. `None` means the family is available on this project.
pub fn disabled_reason(gate: Gate, kind: ProjectKind) -> Option<&'static str> {
    match (gate, kind) {
        (Gate::Any, _) => None,
        (Gate::HarnessSource, ProjectKind::HarnessSource) => None,
        (Gate::HostProject, ProjectKind::Host) => None,
        (Gate::HarnessSource, ProjectKind::Host) => Some(
            "Release Train runs only in a harness source checkout; this project is a host project.",
        ),
        (Gate::HostProject, ProjectKind::HarnessSource) => Some(
            "Deploy on main runs only on host projects; this project is the harness source checkout.",
        ),
    }
}

/// The project kind of one served checkout.
pub fn of(repo_dir: &Path) -> ProjectKind {
    if crate::version::is_harness_source_checkout(repo_dir) {
        ProjectKind::HarnessSource
    } else {
        ProjectKind::Host
    }
}

/// The reason a family is gated off on this checkout, or `None` when it runs.
pub fn reason(gate: Gate, repo_dir: &Path) -> Option<&'static str> {
    disabled_reason(gate, of(repo_dir))
}

/// The refusal one `worker` command answers when its family is gated off on
/// this checkout. It names the checkout and the project kind that permits the
/// family, so the first stderr line is the whole answer.
pub fn refusal(family: &str, gate: Gate, repo_dir: &Path) -> Option<String> {
    let reason = reason(gate, repo_dir)?;
    Some(format!("{family}: {reason} ({})", repo_dir.display()))
}

/// The gate one worker family id runs under. A family that is not
/// project-kind specific is `Any`.
pub fn gate_for_family(family: &str) -> Gate {
    match family {
        "release-train" => Gate::HarnessSource,
        "deploy-on-main" => Gate::HostProject,
        _ => Gate::Any,
    }
}
