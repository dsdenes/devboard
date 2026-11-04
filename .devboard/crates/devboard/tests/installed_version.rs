//! The installed version, its staleness, the replacement program, and the
//! harness directory an installed binary resolves.

use std::path::PathBuf;

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
fn a_rebuilt_binary_resolves_to_the_path_the_rebuild_left() {
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
    assert_eq!(
        devboard::relaunch::live_path(&linked_absent),
        linked_absent,
        "a replaced path with nothing behind it is never renamed away"
    );
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
