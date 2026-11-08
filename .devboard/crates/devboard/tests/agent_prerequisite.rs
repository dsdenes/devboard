//! Every dashboard start checks the agent command it would spawn: a program
//! it cannot run refuses the start, naming it, before the dashboard serves
//! anything.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn scratch(label: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("agent-prerequisite-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn serve(repo: &Path, state: &Path, agent_command: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_devboard"))
        .arg("serve")
        .arg("--repo-dir")
        .arg(repo)
        .arg("--port")
        .arg("0")
        .arg("--state-dir")
        .arg(state)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", repo)
        .env("REPO_DIR", repo)
        .env("STATE_DIR", state)
        .env("AGENT_COMMAND", agent_command)
        .env("DEVBOARD_UPDATE_INTERVAL_MS", "3600000")
        .output()
        .expect("serve runs")
}

#[test]
fn a_start_refuses_an_agent_program_it_cannot_run_and_names_it() {
    let directory = scratch("missing");
    let repo = directory.join("repo");
    let state = directory.join("state");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&state).unwrap();

    let output = serve(&repo, &state, "devboard-missing-agent-fixture acp");

    assert!(!output.status.success(), "the start is refused");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("devboard-missing-agent-fixture"),
        "{stderr}"
    );
    assert!(stderr.contains("AGENT_COMMAND"), "{stderr}");
    assert!(
        !state.join("version.json").exists(),
        "a refused start writes no dashboard marker"
    );
    let _ = std::fs::remove_dir_all(&directory);
}
