//! Every dashboard start runs one reaping pass, journals it, and never
//! signals a live recorded child.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn root(label: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("startup-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn reaped_lines(state: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(state.join("supervision/reaped.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[test]
fn a_recorded_dead_child_is_reaped_and_the_pass_is_journaled() {
    let directory = root("dead");
    let state = directory.join("state");
    let repo = directory.join("repo");
    let supervision = state.join("supervision");
    std::fs::create_dir_all(&supervision).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(
        supervision.join("4294967000.json"),
        serde_json::json!({
            "version": 1,
            "pid": 4_294_967_000u64,
            "argv": ["devboard", "worker"],
            "cwd": repo.to_string_lossy(),
            "ownerPid": 4_294_967_001u64,
            "startedAt": "2026-01-01T00:00:00.000Z",
            "startTicks": 1,
            "pgid": 4_294_967_000u64,
        })
        .to_string(),
    )
    .unwrap();

    devboard::workers::watchdog::reap_on_startup(&state, &repo);

    let lines = reaped_lines(&state);
    assert_eq!(lines.len(), 1, "one pass record: {lines:?}");
    assert_eq!(lines[0]["pass"], "startup");
    assert!(!supervision.join("4294967000.json").exists());
    let _ = std::fs::remove_dir_all(&directory);
}

#[tokio::test]
async fn a_live_recorded_child_with_a_live_owner_is_never_signalled() {
    let directory = root("live");
    let state = directory.join("state");
    let repo = directory.join("repo");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    let argv = vec!["sleep".to_string(), "60".to_string()];
    let pid = devboard::supervision::supervised_detach(
        &argv,
        devboard::supervision::SupervisedDetachOptions {
            cwd: repo.clone(),
            env: HashMap::from([(
                "PATH".to_string(),
                std::env::var("PATH").unwrap_or_default(),
            )]),
            state_dir: Some(state.clone()),
            stdio: devboard::supervision::DetachStdio::ignore(),
            on_error: None,
        },
    )
    .expect("the child starts");
    assert!(devboard::supervision::live_process(pid));

    devboard::workers::watchdog::reap_on_startup(&state, &repo);

    assert!(
        devboard::supervision::live_process(pid),
        "a live recorded child with a live owner is protected"
    );
    let lines = reaped_lines(&state);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["pass"], "startup");
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    let _ = std::fs::remove_dir_all(&directory);
}
