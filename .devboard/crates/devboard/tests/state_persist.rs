//! The dashboard's whole-state write. A failed write is journaled once and
//! leaves the saved-state cache untouched, so the next flush retries it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use devboard::app::App;
use devboard::config::Config;
use devboard::journal::Journal;
use serde_json::Value;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!(
            "state-persist-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/adrs")).expect("an adr root");
    std::fs::create_dir_all(root.join("state")).expect("a state root");
    root
}

fn app_at(root: &Path) -> (Arc<App>, Config) {
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: None,
        agent_command: "omp acp".to_string(),
        state_dir: root.join("state"),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config.clone(), journal);
    (app, config)
}

/// Every record the dashboard journal holds for this checkout.
fn journal_records(config: &Config) -> Vec<Value> {
    let path = devboard::journal::journal_file(&config.state_dir, &config.repo_dir);
    std::fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// A state write that cannot land is journaled as a server error and never
/// recorded as saved, so the unchanged state is written once the path is
/// writable again.
///
/// A directory at the state file's own path makes the write fail while the
/// rest of the state directory stays writable, which is the case the journal
/// record must survive. On the parent commit the failed write had already
/// cached its text, so the next flush returned at the equality check and the
/// file stayed missing; the failure reached stderr only.
#[tokio::test]
async fn a_failed_state_write_is_journaled_and_retried() {
    let root = scratch("failed-write");
    let (app, config) = app_at(&root);
    let state_path = devboard::state::state_file(&config.state_dir, &config.repo_dir);
    std::fs::create_dir_all(&state_path).expect("a directory where the state file belongs");

    app.shared.flush_state();
    app.shared.flush_state();

    let errors: Vec<Value> = journal_records(&config)
        .into_iter()
        .filter(|record| record["kind"].as_str() == Some("server-error"))
        .collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    let detail = errors[0]["text"].as_str().unwrap_or_default();
    assert!(detail.contains("could not write"), "{detail}");
    assert!(
        detail.contains(&state_path.display().to_string()),
        "{detail}"
    );
    assert!(state_path.is_dir(), "the failed write leaves no state file");

    std::fs::remove_dir(&state_path).expect("the blocking directory");
    app.shared.flush_state();

    let text = std::fs::read_to_string(&state_path).expect("the state file the retry wrote");
    serde_json::from_str::<Value>(&text).expect("a state envelope");
}
