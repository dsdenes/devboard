//! `devboard install <host> --port <n>`: one dashboard, one plain URL, a
//! live `/ready`, a replaced stale dashboard, and a named bind failure.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn scratch(label: &str) -> PathBuf {
    let index = COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!(
            "install-start-{label}-{}-{index}",
            std::process::id()
        ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a host directory");
    root
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a listener");
    listener.local_addr().expect("an address").port()
}

fn install(host: &Path, port: u16) -> Output {
    Command::new(env!("CARGO_BIN_EXE_devboard"))
        .arg("install")
        .arg(host)
        .args(["--port", &port.to_string()])
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env(
            "AGENT_COMMAND",
            format!("{} acp-stub", env!("CARGO_BIN_EXE_devboard")),
        )
        .output()
        .expect("install runs")
}

fn http(port: u16, path: &str) -> (u16, String) {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .expect("the dashboard accepts a connection");
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).expect("a request");
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    let status = answer
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    (status, answer)
}

fn dashboard_pid(host: &Path) -> u32 {
    let text = std::fs::read_to_string(host.join(".devboard/.tmp/version.json"))
        .expect("the dashboard marker");
    let value: serde_json::Value = serde_json::from_str(&text).expect("a valid marker");
    value["pid"].as_u64().expect("a pid") as u32
}

fn live(pid: u32) -> bool {
    devboard::supervision::live_process(pid)
}

fn stop(host: &Path) {
    if let Ok(text) = std::fs::read_to_string(host.join(".devboard/.tmp/version.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(pid) = value["pid"].as_u64() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
        }
    }
}

#[test]
fn install_starts_exactly_one_dashboard_and_prints_its_url() {
    let host = scratch("start");
    let port = free_port();
    let first = install(&host, port);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let stdout = String::from_utf8_lossy(&first.stdout).to_string();
    assert_eq!(
        stdout.matches("dashboard on ").count(),
        1,
        "one dashboard line: {stdout}"
    );
    assert!(
        stdout.contains(&format!("dashboard on http://127.0.0.1:{port}/ (pid ")),
        "the plain dashboard URL: {stdout}"
    );
    assert!(
        !stdout.contains('?'),
        "the printed URL carries no query string: {stdout}"
    );
    let pid = dashboard_pid(&host);
    assert!(live(pid));

    let (status, _) = http(port, "/ready");
    assert_eq!(status, 200, "readiness answers without a credential");
    let url = stdout
        .lines()
        .find_map(|line| line.split_once("dashboard on "))
        .map(|(_, rest)| rest.split(' ').next().unwrap_or_default())
        .expect("the dashboard URL");
    assert_eq!(url, format!("http://127.0.0.1:{port}/"));
    let (status, answer) = http(port, "/");
    assert_eq!(status, 200, "opening the printed URL answers 200");
    assert!(
        !answer.to_ascii_lowercase().contains("set-cookie:"),
        "the page sets no cookie: {answer}"
    );

    // A second install starts no second dashboard.
    let second = install(&host, port);
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(dashboard_pid(&host), pid, "the same dashboard serves");
    assert_eq!(
        devboard::mcp_server::discover_dashboards(&host).len(),
        1,
        "exactly one dashboard for the host"
    );

    // A stale dashboard on the same port is replaced.
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while live(pid) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    let third = install(&host, port);
    assert!(
        third.status.success(),
        "{}",
        String::from_utf8_lossy(&third.stderr)
    );
    let replacement = dashboard_pid(&host);
    assert_ne!(replacement, pid, "a stale dashboard is replaced");
    assert!(live(replacement));
    stop(&host);
    let _ = std::fs::remove_dir_all(&host);
}

#[test]
fn a_child_that_cannot_bind_fails_the_install_with_the_bind_error() {
    let host = scratch("bind");
    let listener = TcpListener::bind("127.0.0.1:0").expect("a listener");
    let port = listener.local_addr().expect("an address").port();
    let output = install(&host, port);
    drop(listener);
    assert!(
        !output.status.success(),
        "a bind failure exits nonzero: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Address already in use")
            || stderr.contains("before it served port")
            || stderr.contains("did not serve port"),
        "{stderr}"
    );
    stop(&host);
    let _ = std::fs::remove_dir_all(&host);
}
