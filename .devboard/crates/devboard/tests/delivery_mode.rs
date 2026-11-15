//! The per-repository delivery mode: its default, its persistence across a
//! restart, its refusal of an unknown value, and the harness source checkout's
//! pin to merge.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::journal::Journal;
use serde_json::{json, Value};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!(
            "delivery-mode-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("state")).expect("a state root");
    std::fs::create_dir_all(root.join("repo/adrs")).expect("an adr root");
    root
}

fn config(repo: &Path, state: &Path) -> Config {
    Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.to_path_buf(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: "omp acp".to_string(),
        state_dir: state.to_path_buf(),
        allowed_hosts: Vec::new(),
        feedback: None,
    }
}

fn dashboard(repo: &Path, state: &Path) -> std::sync::Arc<App> {
    let config = config(repo, state);
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    App::new(config, journal)
}

async fn frame(app: &std::sync::Arc<App>, command: Command) -> Value {
    let (outbox, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    app.command(&Conn::new(outbox), command).await;
    let text = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .expect("a frame before the deadline")
        .expect("a frame");
    serde_json::from_str(&text).expect("frame JSON")
}

async fn project(app: &std::sync::Arc<App>) -> Value {
    frame(app, Command::GetProject).await
}

async fn set_mode(app: &std::sync::Arc<App>, mode: &str) -> Value {
    frame(
        app,
        Command::SetDeliveryMode {
            mode: Some(json!(mode)),
        },
    )
    .await
}

#[tokio::test]
async fn delivery_mode_defaults_to_merge() {
    let root = scratch("default");
    let repo = root.join("repo");
    let state = root.join("state");
    let app = dashboard(&repo, &state);
    let payload = project(&app).await;
    assert_eq!(payload["type"], "project");
    assert_eq!(payload["deliveryMode"], "merge");
    assert_eq!(
        payload["deliveryModeAvailability"],
        json!({"state": "enabled", "reason": null})
    );
}

#[tokio::test]
async fn delivery_mode_persists_per_repository() {
    let root = scratch("persist");
    let state = root.join("state");
    let first = root.join("first");
    let second = root.join("second");
    std::fs::create_dir_all(first.join("adrs")).expect("the first adr root");
    std::fs::create_dir_all(second.join("adrs")).expect("the second adr root");

    let first_app = dashboard(&first, &state);
    let second_app = dashboard(&second, &state);
    assert_eq!(project(&first_app).await["deliveryMode"], "merge");
    assert_eq!(project(&second_app).await["deliveryMode"], "merge");

    let answer = set_mode(&first_app, "pull-request").await;
    assert_eq!(answer["deliveryMode"], "pull-request");
    assert_eq!(answer["deliveryModeAvailability"]["state"], "enabled");
    assert_eq!(project(&second_app).await["deliveryMode"], "merge");

    // A restart reads the saved value back from the same state directory,
    // and the other repository keeps its own.
    drop(first_app);
    let restarted = dashboard(&first, &state);
    assert_eq!(project(&restarted).await["deliveryMode"], "pull-request");
    let second_restarted = dashboard(&second, &state);
    assert_eq!(project(&second_restarted).await["deliveryMode"], "merge");
    assert_eq!(
        set_mode(&second_restarted, "merge").await["deliveryMode"],
        "merge"
    );
}

#[tokio::test]
async fn delivery_mode_refuses_an_unknown_value() {
    let root = scratch("unknown");
    let repo = root.join("repo");
    let state = root.join("state");
    let app = dashboard(&repo, &state);
    let answer = set_mode(&app, "fast-forward").await;
    assert_eq!(answer["type"], "error");
    let message = answer["message"].as_str().unwrap_or_default();
    assert!(message.contains("fast-forward"), "{message}");
    assert_eq!(project(&app).await["deliveryMode"], "merge");

    // Nothing was written: a restart still reads merge.
    drop(app);
    let restarted = dashboard(&repo, &state);
    assert_eq!(project(&restarted).await["deliveryMode"], "merge");
}

#[tokio::test]
async fn a_harness_source_checkout_is_pinned_to_merge() {
    let root = scratch("harness");
    let repo = root.join("repo");
    let state = root.join("state");
    std::fs::create_dir_all(repo.join(".devboard")).expect("the harness directory");
    std::fs::write(
        repo.join(".devboard/package.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"1.52.1\"}\n",
    )
    .expect("the harness manifest");
    // The saved state says pull-request; the checkout is still pinned.
    let saved = devboard::state::state_envelope(&json!({"deliveryMode": "pull-request"}));
    let path = devboard::state::state_file(&state, &repo);
    std::fs::create_dir_all(path.parent().expect("a state directory")).expect("the state root");
    std::fs::write(&path, saved).expect("the saved state");

    let app = dashboard(&repo, &state);
    let payload = project(&app).await;
    assert_eq!(payload["deliveryMode"], "merge");
    assert_eq!(payload["deliveryModeAvailability"]["state"], "disabled");
    assert_eq!(
        payload["deliveryModeAvailability"]["reason"],
        "Delivery mode applies to host projects; this project is the harness source checkout."
    );

    let answer = set_mode(&app, "pull-request").await;
    assert_eq!(answer["type"], "error");
    let message = answer["message"].as_str().unwrap_or_default();
    assert!(
        message.contains(
            "Delivery mode applies to host projects; this project is the harness source checkout."
        ),
        "{message}"
    );
    assert_eq!(project(&app).await["deliveryMode"], "merge");
    let text = std::fs::read_to_string(&path).expect("the state file");
    let value: Value = serde_json::from_str(&text).expect("state JSON");
    assert_eq!(value["state"]["deliveryMode"], "pull-request");
}
