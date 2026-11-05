//! Release transport: a failed GitHub asset falls back to Gitea, and a local
//! release directory installs offline.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

use serde_json::json;
use sha2::{Digest, Sha256};

fn root(label: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("release-transport-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn archive() -> Vec<u8> {
    let encoder = xz2::write::XzEncoder::new(Vec::new(), 6);
    let mut tar = tar::Builder::new(encoder);
    let body = b"#!/bin/sh\necho installed\n";
    let mut header = tar::Header::new_gnu();
    header.set_size(body.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    tar.append_data(&mut header, "devboard", &body[..]).unwrap();
    let encoder = tar.into_inner().unwrap();
    encoder.finish().unwrap()
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// One tiny HTTP server: a Gitea release listing and its asset.
fn gitea_stub(archive: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let asset_url = format!("{base}/assets/devboard-x86_64-unknown-linux-gnu.tar.xz");
    let body = serde_json::to_vec(&json!({
        "tag_name": "v1.2.3",
        "assets": [{
            "name": "devboard-x86_64-unknown-linux-gnu.tar.xz",
            "browser_download_url": asset_url,
        }],
    }))
    .unwrap();
    let handle = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
            let (status, content_type, payload) = if request.starts_with("GET /api/v1/") {
                ("200 OK", "application/json", body.clone())
            } else if request.contains("devboard-x86_64-unknown-linux-gnu.tar.xz") {
                ("200 OK", "application/octet-stream", archive.clone())
            } else {
                ("404 Not Found", "text/plain", b"no".to_vec())
            };
            let head = format!(
                "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                payload.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(&payload).unwrap();
        }
    });
    (base, handle)
}

#[tokio::test]
async fn a_failed_github_asset_falls_back_to_the_gitea_artifact() {
    let directory = root("fallback");
    let bytes = archive();
    let digest = sha256(&bytes);
    let (base, handle) = gitea_stub(bytes.clone());
    std::env::set_var("DEVBOARD_GITEA_URL", &base);
    let dead = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_url = format!(
        "http://{}/devboard-x86_64-unknown-linux-gnu.tar.xz",
        dead.local_addr().unwrap()
    );
    drop(dead);
    let target = devboard::release::current_target().unwrap();
    let release = devboard::release::ReleaseInfo {
        version: "1.2.3".to_string(),
        tag: "v1.2.3".to_string(),
        assets: vec![devboard::release::ReleaseAsset {
            target: target.to_string(),
            url: dead_url,
            sha256: digest,
        }],
    };
    let source = devboard::release::ManifestSource {
        base_url: base.clone(),
        repository: "dsdenes/devboard".to_string(),
        token: None,
        timeout_ms: 5_000,
        local_dir: None,
    };
    let prefix = directory.join("prefix");
    let installed =
        devboard::release::install_release(&source, &release, &prefix, &directory.join("state"))
            .await
            .expect("the Gitea fallback installs");
    assert_eq!(installed, "1.2.3");
    assert_eq!(
        std::fs::read(prefix.join("bin/devboard")).unwrap(),
        b"#!/bin/sh\necho installed\n"
    );
    assert_eq!(
        devboard::release::installed_version(&prefix).as_deref(),
        Some("1.2.3")
    );
    std::env::remove_var("DEVBOARD_GITEA_URL");
    handle.join().unwrap();
    let _ = std::fs::remove_dir_all(&directory);
}

#[tokio::test]
async fn a_local_release_directory_installs_offline() {
    let directory = root("local");
    let bytes = archive();
    let target = devboard::release::current_target().unwrap();
    let name = format!("devboard-{target}.tar.xz");
    std::fs::write(directory.join(&name), &bytes).unwrap();
    let manifest = json!({
        "version": "9.9.9",
        "tag": "v9.9.9",
        "assets": [{
            "target": target,
            "url": name,
            "sha256": sha256(&bytes),
        }],
    });
    std::fs::write(
        directory.join("devboard-manifest.json"),
        serde_json::to_string(&manifest).unwrap(),
    )
    .unwrap();
    let source = devboard::release::ManifestSource {
        base_url: String::new(),
        repository: "dsdenes/devboard".to_string(),
        token: None,
        timeout_ms: 1_000,
        local_dir: Some(directory.clone()),
    };
    let release = devboard::release::latest_manifest(&source).await.unwrap();
    assert_eq!(release.version, "9.9.9");
    let prefix = directory.join("prefix");
    let installed =
        devboard::release::install_release(&source, &release, &prefix, &directory.join("state"))
            .await
            .unwrap();
    assert_eq!(installed, "9.9.9");
    assert!(prefix.join("bin/devboard").is_file());
    let _ = std::fs::remove_dir_all(&directory);
}

/// A Gitea stub that refuses every request carrying a credential, as Gitea
/// does for a token it does not accept. `serve_anonymous` decides whether the
/// anonymous read that follows is served, which separates a public repository
/// from a private one.
fn refusing_gitea_stub(
    serve_anonymous: bool,
    connections: usize,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let manifest_url = format!("{base}/releases/download/v1.2.3/devboard-manifest.json");
    let release = serde_json::to_vec(&json!({
        "tag_name": "v1.2.3",
        "assets": [{
            "name": "devboard-manifest.json",
            "browser_download_url": manifest_url,
        }],
    }))
    .unwrap();
    let manifest = serde_json::to_vec(&json!({
        "version": "1.2.3",
        "tag": "v1.2.3",
        "assets": [],
    }))
    .unwrap();
    let handle = std::thread::spawn(move || {
        for _ in 0..connections {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_lowercase();
            let (status, payload) = if request.contains("\r\nauthorization:") || !serve_anonymous {
                (
                    "401 Unauthorized",
                    br#"{"message":"invalid username, password or token"}"#.to_vec(),
                )
            } else if request.starts_with("get /api/v1/") {
                ("200 OK", release.clone())
            } else {
                ("200 OK", manifest.clone())
            };
            let head = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                payload.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(&payload).unwrap();
        }
    });
    (base, handle)
}

#[tokio::test]
async fn a_refused_credential_still_reads_a_public_release() {
    let (base, handle) = refusing_gitea_stub(true, 4);
    let source = devboard::release::ManifestSource {
        base_url: base,
        repository: "dsdenes/devboard".to_string(),
        token: Some("stale-token".to_string()),
        timeout_ms: 5_000,
        local_dir: None,
    };
    let release = devboard::release::latest_manifest(&source)
        .await
        .expect("a public release stays readable without the refused credential");
    assert_eq!(release.version, "1.2.3");
    assert_eq!(release.tag, "v1.2.3");
    handle.join().unwrap();
}

#[tokio::test]
async fn a_private_release_still_reports_a_refused_credential() {
    let (base, handle) = refusing_gitea_stub(false, 2);
    let source = devboard::release::ManifestSource {
        base_url: base,
        repository: "dsdenes/devboard".to_string(),
        token: Some("stale-token".to_string()),
        timeout_ms: 5_000,
        local_dir: None,
    };
    let error = devboard::release::latest_manifest(&source)
        .await
        .expect_err("a private release needs the credential");
    assert!(error.contains("HTTP 401"), "{error}");
    handle.join().unwrap();
}
