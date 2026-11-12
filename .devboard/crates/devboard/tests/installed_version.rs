//! The installed version, its staleness, the replacement program, and the
//! harness directory an installed binary resolves.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use devboard::app::App;
use devboard::command::Command;
use devboard::config::Config;
use devboard::journal::Journal;
use serde_json::{json, Value};

fn fixture(label: &str) -> PathBuf {
    let host = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("installed-version-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&host);
    std::fs::create_dir_all(host.join(".devboard/bin")).unwrap();
    std::fs::write(host.join(".devboard/bin/devboard"), b"binary").unwrap();
    std::fs::write(
        host.join(".devboard/devboard.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"1.2.3\"}\n",
    )
    .unwrap();
    host
}

#[test]
fn installed_version_comes_from_the_host_manifest_and_staleness_is_exact() {
    let host = fixture("state");
    let current = devboard::version::server_version(&host, Some("1.2.3".into()), None);
    assert_eq!(current.installed.as_deref(), Some("1.2.3"));
    assert!(!current.stale);

    let old = devboard::version::server_version(&host, Some("1.1.0".into()), Some("1.2.3".into()));
    assert_eq!(old.running.as_deref(), Some("1.1.0"));
    assert_eq!(old.installed.as_deref(), Some("1.2.3"));
    assert!(old.stale, "a differing running version is stale");

    let _ = std::fs::remove_dir_all(&host);
}

#[test]
fn the_replacement_program_is_the_installed_binary() {
    let host = fixture("replacement");
    let program = devboard::relaunch::replacement_program(&host).unwrap();
    assert_eq!(program, host.join(".devboard/bin/devboard"));

    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("installed-version-source-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&source);
    std::fs::create_dir_all(source.join(".devboard")).unwrap();
    let program = devboard::relaunch::replacement_program(&source).unwrap();
    assert_eq!(program, std::env::current_exe().unwrap());
    let _ = std::fs::remove_dir_all(&source);
    let _ = std::fs::remove_dir_all(&host);
}

#[test]
fn running_harness_dir_resolves_an_installed_prefix_and_its_manifest() {
    let host = fixture("resolution");
    let harness = host.join(".devboard");
    std::env::set_var("DEVBOARD_RUNNING_HARNESS_DIR", &harness);
    assert_eq!(devboard::version::running_harness_dir(), harness);
    assert_eq!(
        devboard::version::read_harness_version(&devboard::version::running_harness_dir())
            .as_deref(),
        Some("1.2.3")
    );
    std::env::remove_var("DEVBOARD_RUNNING_HARNESS_DIR");
    let _ = std::fs::remove_dir_all(&host);
}

#[test]
fn a_rebuilt_binary_resolves_to_a_runnable_path() {
    let host = fixture("deleted");
    let path = host.join(".devboard/bin/devboard");
    let linked = PathBuf::from(format!("{} (deleted)", path.display()));
    assert_eq!(devboard::relaunch::live_path(&linked), path);
    assert_eq!(
        devboard::relaunch::live_path(&path),
        path,
        "a live link is returned unchanged"
    );
    let absent = host.join(".devboard/bin/absent");
    let linked_absent = PathBuf::from(format!("{} (deleted)", absent.display()));
    let resolved = devboard::relaunch::live_path(&linked_absent);
    if cfg!(target_os = "linux") {
        assert_eq!(
            resolved,
            PathBuf::from(format!("/proc/{}/exe", std::process::id())),
            "a removed binary is runnable through this process's own image"
        );
        let running = std::fs::metadata(std::env::current_exe().unwrap()).unwrap();
        let image = std::fs::metadata(&resolved).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                (image.dev(), image.ino()),
                (running.dev(), running.ino()),
                "the fallback names the running image"
            );
        }
    } else {
        assert_eq!(
            resolved, linked_absent,
            "a replaced path with nothing behind it is never renamed away"
        );
    }
    let _ = std::fs::remove_dir_all(&host);
}

#[tokio::test]
async fn devboard_status_names_the_installed_manifest_directory() {
    let host = fixture("status");
    let host = host.canonicalize().unwrap();
    std::env::set_var("REPO_DIR", &host);
    let context = devboard::mcp_server::resolve_context();
    std::env::remove_var("REPO_DIR");
    assert_eq!(context.harness_dir, host.join(".devboard"));
    assert_eq!(
        devboard::version::read_harness_version(&context.harness_dir).as_deref(),
        Some("1.2.3")
    );
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "devboard_status", "arguments": {}}
    });
    let mut input = serde_json::to_string(&request).unwrap();
    input.push('\n');
    let mut output = Vec::new();
    let mut diagnostics = Vec::new();
    devboard::mcp_server::run_stdio(context, input.as_bytes(), &mut output, &mut diagnostics)
        .await
        .unwrap();
    let frames: Vec<serde_json::Value> = String::from_utf8_lossy(&output)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let text = frames[0]["result"]["content"][0]["text"].as_str().unwrap();
    let status: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(
        status["harnessDirectory"].as_str().unwrap(),
        host.join(".devboard").to_string_lossy()
    );
    let _ = std::fs::remove_dir_all(&host);
}

#[tokio::test]
async fn a_version_state_read_answers_the_facts_the_process_resolved_at_startup() {
    // Resolving these facts reads a manifest and, on a source checkout, spawns
    // `git rev-parse` and `git tag --merged HEAD`. A `versionState` read is
    // polled every second, so it answers what this process resolved when it
    // started; only an install landing beside it moves that value.
    let host = fixture("facts");
    let state_dir = host.join(".devboard/.tmp");
    std::fs::create_dir_all(&state_dir).unwrap();
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: host.join("adrs"),
        repo_dir: host.clone(),
        goal_file: host.join("GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: state_dir.clone(),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let app = App::new(config, Journal::open(&state_dir, &host, 0));

    let first = app.version_state();
    assert_eq!(first["installed"], "1.2.3");

    // An install rewrites the manifest beside the process. A read that resolved
    // the manifest again would answer the new value, and pay the filesystem
    // work on the request path.
    std::fs::write(
        host.join(".devboard/devboard.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"1.2.4\"}\n",
    )
    .unwrap();
    assert_eq!(
        app.version_state()["installed"],
        "1.2.3",
        "a read answers the facts the process resolved at startup"
    );

    // The install the update check lands is recorded, so the frame names what a
    // restart would load even when the replacement never starts.
    app.note_installed_version("1.2.4");
    assert_eq!(app.version_state()["installed"], "1.2.4");

    let _ = std::fs::remove_dir_all(&host);
}

#[test]
fn only_the_served_checkout_own_harness_starts_source_refresh() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("own-harness-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let repo = root.join("repo");
    let own = repo.join(".devboard");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(
        own.join("devboard.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"0.0.0-source\"}\n",
    )
    .unwrap();
    assert!(devboard::version::is_own_checkout_harness(&repo, &own));
    assert!(devboard::version::is_harness_source_checkout(&repo));

    let other = root.join("other/.devboard");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(
        other.join("devboard.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"0.0.0-source\"}\n",
    )
    .unwrap();
    assert!(
        !devboard::version::is_own_checkout_harness(&repo, &other),
        "another harness never refreshes this checkout"
    );

    let installed = repo.join("installed/.devboard");
    std::fs::create_dir_all(installed.join("bin")).unwrap();
    std::fs::write(
        installed.join("devboard.json"),
        "{\"name\":\"@dsdenes/devboard\",\"version\":\"1.0.0\"}\n",
    )
    .unwrap();
    std::fs::write(installed.join("bin/devboard"), b"binary").unwrap();
    assert!(
        !devboard::version::is_own_checkout_harness(&repo, &installed),
        "an installed prefix is not a source checkout"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A repository fixture with the prompt tree the agent registry reads and a
/// state directory beside it.
fn agents_fixture(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("resolver-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/.devboard/prompts")).unwrap();
    std::fs::create_dir_all(root.join("repo/adrs")).unwrap();
    std::fs::create_dir_all(root.join("state")).unwrap();
    for prompt in [
        "scout-recommendations.md",
        "design-system.md",
        "dead-code-removal.md",
        "api-standards.md",
        "single-responsibility.md",
        "consistent-naming.md",
        "release-train.md",
    ] {
        std::fs::write(
            root.join("repo/.devboard/prompts").join(prompt),
            format!("# {prompt}\n"),
        )
        .unwrap();
    }
    root
}

fn agents_app(root: &Path) -> Arc<App> {
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
    App::new(config, journal)
}

fn latest_agent<'a>(frames: &'a [Value], id: &str) -> Option<&'a Value> {
    frames
        .iter()
        .filter(|frame| frame.get("type").and_then(Value::as_str) == Some("agentState"))
        .filter_map(|frame| frame.get("agent"))
        .filter(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
        .next_back()
}

#[test]
fn a_deleted_executable_falls_back_to_the_installed_binary() {
    let host = fixture("deleted-installed");
    let installed = host.join(".devboard/bin/devboard");
    let linked = PathBuf::from(format!("{} (deleted)", installed.display()));
    let resolved =
        devboard::relaunch::harness_program_for(&host, &linked).expect("the installed binary");
    assert_eq!(resolved, installed);
    assert!(resolved.is_file());
    assert!(
        !resolved.to_string_lossy().contains(" (deleted)"),
        "a child is never started from a deleted link"
    );
    let _ = std::fs::remove_dir_all(&host);
}

#[test]
fn a_source_checkout_uses_the_live_suffixless_executable() {
    let source = fixture("source-live");
    let _ = std::fs::remove_dir_all(source.join(".devboard/bin"));
    let linked = PathBuf::from(format!(
        "{} (deleted)",
        std::env::current_exe().unwrap().display()
    ));
    assert_eq!(
        devboard::relaunch::harness_program_for(&source, &linked).unwrap(),
        std::env::current_exe().unwrap()
    );
    let missing = source.join(".devboard/bin/devboard");
    let linked_missing = PathBuf::from(format!("{} (deleted)", missing.display()));
    let refusal = devboard::relaunch::harness_program_for(&source, &linked_missing)
        .expect_err("neither path exists");
    assert!(refusal.contains(&missing.to_string_lossy().into_owned()));
    assert!(refusal.starts_with("missing prerequisite:"));
    let _ = std::fs::remove_dir_all(&source);
}

#[tokio::test]
async fn a_missing_executable_refuses_before_any_spawn() {
    let root = agents_fixture("missing-executable");
    let repo = root.join("repo");
    let app = agents_app(&root);
    let missing = repo.join(".devboard/bin/devboard");
    devboard::agents_mode::set_program_link(
        &app,
        "dead-code",
        Some(PathBuf::from(format!("{} (deleted)", missing.display()))),
    );
    let recorded: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&recorded);
    devboard::agents_mode::set_spawn(&app, move |argv, _environment| {
        seen.lock().unwrap().push(argv.to_vec());
        None
    });

    let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let conn = devboard::app::Conn::new(outbox);
    app.register(conn.clone()).await;
    let started = std::time::Instant::now();
    devboard::agents_mode::handle(
        &app,
        &conn,
        &Command::StartAgent {
            id: Some(json!("dead-code")),
        },
    )
    .await;
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    let frames: Vec<Value> = {
        let mut frames = Vec::new();
        while let Ok(text) = inbox.try_recv() {
            frames.push(serde_json::from_str(&text).expect("a frame"));
        }
        frames
    };
    assert!(
        recorded.lock().unwrap().is_empty(),
        "a missing executable spawned a child: {frames:?}"
    );
    let agent = latest_agent(&frames, "dead-code").expect("a dead-code snapshot");
    let error = agent["error"].as_str().unwrap_or_default();
    assert!(
        error.contains(&missing.to_string_lossy().into_owned()),
        "the refusal names the missing executable: {agent:?}"
    );
    assert_ne!(agent["lifecycle"], json!("running"));
    let _ = std::fs::remove_dir_all(&root);
}
