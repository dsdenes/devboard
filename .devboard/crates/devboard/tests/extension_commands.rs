//! The two lifecycle commands are installed prompt templates with no
//! harness-runtime TypeScript, and the ACP stub completes both turns.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

fn host(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("extension-commands-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".devboard")).unwrap();
    devboard::cli_install::install(Some(&root), false).unwrap();
    root
}

fn no_typescript(directory: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return true;
    };
    entries
        .flatten()
        .all(|entry| entry.path().extension().and_then(|value| value.to_str()) != Some("ts"))
}

#[test]
fn both_commands_install_without_a_typescript_runtime() {
    let root = host("installed");
    for command in ["implement-next-epic", "implement-goal-issue"] {
        let path = root.join(format!(".omp/commands/{command}.md"));
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{} is missing: {error}", path.display()));
        assert!(!text.contains(".ts"), "{command} imports TypeScript");
        assert!(!text.is_empty());
    }
    assert!(no_typescript(&root.join(".omp/extensions")));
    assert!(no_typescript(&root.join(".devboard/extensions")));
    let _ = std::fs::remove_dir_all(&root);
}

async fn stub_turn(prompt: &str) -> bool {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("extension-commands-turn-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let command = format!("{} acp-stub", env!("CARGO_BIN_EXE_devboard"));
    let options = devboard::acp::AcpConnectionOptions::new(command, root.display().to_string())
        .with_permission_policy(devboard::acp::PermissionPolicy::Allow);
    let (peer, mut events) = devboard::acp::AcpConnection::connect(options)
        .await
        .expect("the stub connects");
    let peer = Arc::new(peer);
    let runner = Arc::clone(&peer);
    let text = prompt.to_string();
    let mut run = tokio::spawn(async move { runner.run(&text).await });
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            tokio::select! {
                event = events.recv() => {
                    if event.is_none() {
                        return false;
                    }
                }
                outcome = &mut run => {
                    return outcome.map(|result| result.is_ok()).unwrap_or(false);
                }
            }
        }
    })
    .await
    .unwrap_or(false);
    peer.close();
    let _ = std::fs::remove_dir_all(&root);
    completed
}

#[tokio::test]
async fn the_acp_stub_completes_both_lifecycle_turns() {
    assert!(stub_turn("/implement-next-epic 5").await);
    assert!(stub_turn("/implement-goal-issue 7").await);
}
