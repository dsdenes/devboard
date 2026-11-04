//! The dual-run router.
//!
//! The TypeScript server is the only writer of durable state. This router
//! forwards every mutating command to it, mirrors read commands to the Rust
//! dashboard, compares each answer, and writes one divergence report per
//! window. A mutating command's recorded TypeScript answer, state tree, and
//! repository tree are replayed against fresh Rust instances, so a write is
//! compared without either server mutating the other's state. The Rust process
//! always starts from a copied state directory; it never opens the live one for
//! writing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Whether a command may change durable state.
pub fn is_mutating(command: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "start", "stop", "pause", "resume", "check", "answer", "close", "delete", "set", "save",
        "refresh", "create", "cancel", "reset", "merge", "mark", "retry", "send", "accept",
        "refuse", "open", "dismiss", "discover", "switch", "remove", "clear", "ask", "restart",
        "revise", "prepare", "flow", "confirm", "reject",
    ];
    if command == "ask" {
        return true;
    }
    PREFIXES.iter().any(|prefix| command.starts_with(prefix))
}

/// One command's comparison record for one window.
#[derive(Debug, Clone)]
pub struct CommandReport {
    pub command: String,
    pub kind: &'static str,
    pub comparisons: u64,
    pub divergences: Vec<String>,
}

/// The report one window writes.
#[derive(Debug, Default)]
pub struct WindowReport {
    pub window_seconds: u64,
    pub commands: BTreeMap<String, CommandReport>,
    /// Divergences not attributable to a known, ported difference.
    pub unexplained: Vec<String>,
    /// Divergences explained by the dual-run policy or a background timer.
    pub explained: Vec<ExplainedDivergence>,
}

#[derive(Debug, Clone)]
pub struct ExplainedDivergence {
    pub command: String,
    pub reason: &'static str,
}

impl WindowReport {
    pub fn to_json(&self) -> Value {
        json!({
            "windowSeconds": self.window_seconds,
            "commands": self.commands.values().map(|entry| json!({
                "command": entry.command,
                "kind": entry.kind,
                "comparisons": entry.comparisons,
                "divergences": entry.divergences,
            })).collect::<Vec<_>>(),
            "unexplained": self.unexplained,
            "explained": self.explained.iter().map(|entry| json!({
                "command": entry.command,
                "reason": entry.reason,
            })).collect::<Vec<_>>(),
        })
    }
}

/// Where both processes keep their state for one shadow run.
#[derive(Debug, Clone)]
pub struct ShadowLayout {
    pub work: PathBuf,
    pub typescript: PathBuf,
    pub rust: PathBuf,
}

impl ShadowLayout {
    /// The rust side always starts from a copy of the TypeScript state.
    pub fn new(work: &Path) -> Self {
        Self {
            work: work.to_path_buf(),
            typescript: work.join("typescript"),
            rust: work.join("rust"),
        }
    }

    /// Copies the live TypeScript state into the Rust directory once.
    pub fn prepare(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.rust)?;
        // The mirror owns only this copy; replace it wholesale so a file the
        // TypeScript server deleted does not survive.
        let _ = std::fs::remove_dir_all(self.rust.join("state"));
        let _ = std::fs::remove_dir_all(self.rust.join("repo"));
        let source = self.typescript.join("state");
        if source.is_dir() {
            copy_dir(&source, &self.rust.join("state"))?;
        }
        let repo = self.typescript.join("repo");
        if repo.is_dir() {
            copy_dir(&repo, &self.rust.join("repo"))?;
        }
        Ok(())
    }

    /// The Rust state directory. It is never the TypeScript one.
    pub fn rust_state_dir(&self) -> PathBuf {
        self.rust.join("state")
    }

    pub fn rust_repo_dir(&self) -> PathBuf {
        self.rust.join("repo")
    }
}

fn copy_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&path, &destination)?;
        } else {
            std::fs::copy(&path, &destination)?;
        }
    }
    Ok(())
}

/// The router's decision for one frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Sent to the TypeScript server only.
    TypeScriptOnly,
    /// Sent to both servers and compared.
    Mirror,
    /// Served by the Rust dashboard alone after a cutover.
    RustOnly,
}

/// Routes one command by its mutability.
pub fn route(command: &str) -> Route {
    if is_mutating(command) {
        Route::TypeScriptOnly
    } else {
        Route::Mirror
    }
}

/// One free local port.
pub async fn free_port() -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutating_commands_never_reach_the_rust_side() {
        for command in [
            "startLifecycle",
            "answer",
            "saveProvider",
            "setInstalledSkillEnabled",
            "resetImplementation",
            "restartServer",
            "mergeFlowPr",
            "confirmGlossaryTerm",
            "ask",
        ] {
            assert_eq!(route(command), Route::TypeScriptOnly, "{command}");
        }
        for command in [
            "getGoal",
            "listRecords",
            "getProject",
            "getVersion",
            "getIssues",
            "getDiscover",
            "getProviders",
        ] {
            assert_eq!(route(command), Route::Mirror, "{command}");
        }
    }

    #[test]
    fn the_rust_layout_is_a_copy_and_never_the_live_directory() {
        let layout = ShadowLayout::new(Path::new("/repo/.shadow"));
        assert_eq!(
            layout.rust_state_dir(),
            PathBuf::from("/repo/.shadow/rust/state")
        );
        assert_ne!(layout.rust_state_dir(), layout.typescript.join("state"));
    }
}

/// The per-command cutover allowlist. A configuration file names the backend
/// for each command, so flipping one command needs no code change and a
/// restart; an unlisted command stays on the TypeScript server.
#[derive(Debug, Clone, Default)]
pub struct Cutover {
    backends: BTreeMap<String, Backend>,
}

/// Which process serves one command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    TypeScript,
    Rust,
}

impl Cutover {
    /// Reads the allowlist. `{ "commands": { "getGoal": "rust", ... } }`.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let source = std::fs::read_to_string(path)?;
        let value: Value = serde_json::from_str(&source)?;
        let mut backends = BTreeMap::new();
        if let Some(commands) = value.get("commands").and_then(Value::as_object) {
            for (command, backend) in commands {
                let backend = match backend.as_str() {
                    Some("rust") => Backend::Rust,
                    Some("typescript") => Backend::TypeScript,
                    other => anyhow::bail!(
                        "cutover for {command} names {other:?}, not rust or typescript"
                    ),
                };
                backends.insert(command.clone(), backend);
            }
        }
        Ok(Self { backends })
    }

    /// The backend for one command; an unlisted command stays on TypeScript.
    pub fn backend(&self, command: &str) -> Backend {
        self.backends
            .get(command)
            .copied()
            .unwrap_or(Backend::TypeScript)
    }

    /// Whether every mutating command has been cut over to Rust.
    pub fn fully_cut_over(&self, commands: &[String]) -> bool {
        commands
            .iter()
            .all(|command| !is_mutating(command) || self.backend(command) == Backend::Rust)
    }
}

#[cfg(test)]
mod cutover_tests {
    use super::*;

    #[test]
    fn a_flip_is_configuration_only() {
        let directory = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-tmp")
            .join(format!("cutover-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a scratch directory");
        let path = directory.join("cutover.json");
        std::fs::write(
            &path,
            r#"{"commands":{"getGoal":"rust","getProject":"typescript"}}"#,
        )
        .expect("an allowlist");
        let cutover = Cutover::load(&path).expect("the allowlist loads");
        assert_eq!(cutover.backend("getGoal"), Backend::Rust);
        assert_eq!(cutover.backend("getProject"), Backend::TypeScript);
        assert_eq!(cutover.backend("unlisted"), Backend::TypeScript);

        std::fs::write(&path, r#"{"commands":{"getGoal":"typescript"}}"#).expect("a flip");
        let flipped = Cutover::load(&path).expect("the allowlist loads");
        assert_eq!(flipped.backend("getGoal"), Backend::TypeScript);
        std::fs::remove_dir_all(&directory).expect("the scratch directory is removed");
    }
}

#[cfg(test)]
mod final_cutover_tests {
    use super::*;

    #[test]
    fn the_final_allowlist_names_every_command() {
        let harness = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let names: Vec<String> =
            std::fs::read_to_string(harness.join("contract/command-names.txt"))
                .expect("the command inventory")
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect();
        let cutover = Cutover::load(&harness.join("contract/cutover.json")).expect("the allowlist");
        for name in &names {
            assert_eq!(
                cutover.backend(name),
                Backend::Rust,
                "{name} must be cut over"
            );
        }
        assert!(cutover.fully_cut_over(&names));
    }
}

/// Whether one frame is an unsolicited background state push a timed refresh
/// may emit between a request and its reply.
pub fn is_background_frame(frame: &Value) -> bool {
    matches!(
        frame.get("type").and_then(Value::as_str),
        Some(
            "agentState"
                | "agentsState"
                | "agentActivity"
                | "providersState"
                | "discoverState"
                | "discoverPromptState"
                | "issuesState"
                | "flowSnapshot"
                | "activity"
        )
    )
}

/// Whether `actual` is `expected` plus trailing background frames.
pub fn explains_trailing_background(expected: &[Value], actual: &[Value]) -> bool {
    actual.len() > expected.len()
        && actual.starts_with(expected)
        && actual[expected.len()..].iter().all(is_background_frame)
}
