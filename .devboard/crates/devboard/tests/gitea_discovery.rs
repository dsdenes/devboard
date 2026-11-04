//! Source-checkout Gitea discovery: the lowest loopback HTTP origin wins only
//! from a canonical source checkout with no explicit URL; an installed host
//! never probes.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn root(label: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("gitea-discovery-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn git_repo(root: &Path, origin: &str) -> PathBuf {
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(&repo)
        .status()
        .unwrap()
        .success());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["remote", "add", "origin", origin])
        .status()
        .unwrap()
        .success());
    repo
}

fn gitea_stub() -> (String, u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let base = format!("http://127.0.0.1:{port}");
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            counter.fetch_add(1, Ordering::SeqCst);
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let body = b"{\"version\":\"1.21.0\"}";
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
        }
    });
    (base, port, hits)
}

fn environment(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

#[tokio::test]
async fn a_source_checkout_discovers_the_lowest_loopback_gitea() {
    let directory = root("source");
    let repo = git_repo(&directory, "git@localhost:owner/name.git");
    let (base, port, hits) = gitea_stub();
    let options = devboard::forge::SourceCheckoutGiteaOptions {
        repo_dir: repo.clone(),
        environment: environment(&[]),
        source_checkout: Some(true),
        ports: Some(vec![port]),
        timeout_ms: Some(2_000),
        transport: None,
    };
    assert_eq!(
        devboard::forge::source_checkout_gitea_url(&options).await,
        Some(base)
    );
    assert!(hits.load(Ordering::SeqCst) > 0);
    let _ = std::fs::remove_dir_all(&directory);
}

#[tokio::test]
async fn an_explicit_url_wins_and_an_installed_host_never_probes() {
    let directory = root("explicit");
    let repo = git_repo(&directory, "git@localhost:owner/name.git");
    let (base, port, hits) = gitea_stub();
    let explicit = devboard::forge::SourceCheckoutGiteaOptions {
        repo_dir: repo.clone(),
        environment: environment(&[("DEVBOARD_GITEA_URL", "https://explicit.test")]),
        source_checkout: Some(true),
        ports: Some(vec![port]),
        timeout_ms: Some(2_000),
        transport: None,
    };
    assert_eq!(
        devboard::forge::source_checkout_gitea_url(&explicit).await,
        None
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "an explicit URL probes nothing"
    );

    let installed = devboard::forge::SourceCheckoutGiteaOptions {
        repo_dir: repo,
        environment: environment(&[]),
        source_checkout: Some(false),
        ports: Some(vec![port]),
        timeout_ms: Some(2_000),
        transport: None,
    };
    assert_eq!(
        devboard::forge::source_checkout_gitea_url(&installed).await,
        None
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "an installed host probes nothing"
    );
    assert!(!base.is_empty());
    let _ = std::fs::remove_dir_all(&directory);
}
