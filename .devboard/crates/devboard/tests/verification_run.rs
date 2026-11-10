//! `verification_run` and its exact Rust check argv.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use serde_json::{json, Value};

use devboard::mcp_server::{run_stdio, McpContext};

struct Fixture {
    root: PathBuf,
    context: McpContext,
    log: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("verification-run-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let harness = repo.join(".devboard");
        let state = root.join("state");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&harness).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(
            harness.join("package.json"),
            r#"{"name":"fixture","version":"0.0.0","scripts":{"test:client":"bun scripts/test-client.mjs"}}"#,
        )
        .unwrap();
        let log = root.join("calls.log");
        for program in ["cargo", "bun"] {
            let stub = bin.join(program);
            std::fs::write(
                &stub,
                format!(
                    "#!/bin/sh\nprintf '%s|%s\\n' \"$PWD\" \"$*\" >> '{}'\nexit \"${{STUB_EXIT:-0}}\"\n",
                    log.display()
                ),
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&stub).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&stub, permissions).unwrap();
        }
        let environment = HashMap::from([
            ("PATH".to_string(), bin.to_string_lossy().into_owned()),
            ("STUB_LOG".to_string(), log.to_string_lossy().into_owned()),
        ]);
        let context = McpContext {
            repo_dir: repo,
            harness_dir: harness,
            state_dir: state,
            environment,
            dashboards: Some(Vec::new()),
        };
        Self { root, context, log }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

async fn run(fixture: &Fixture, check: &str, exit: u8) -> Value {
    run_with(fixture, json!({"check": check}), exit).await
}

async fn run_with(fixture: &Fixture, arguments: Value, exit: u8) -> Value {
    let mut environment = fixture.context.environment.clone();
    environment.insert("STUB_EXIT".to_string(), exit.to_string());
    let context = McpContext {
        environment,
        ..fixture.context.clone()
    };
    let mut request = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "verification_run", "arguments": arguments},
    }))
    .unwrap();
    request.push('\n');
    let mut output = Vec::new();
    let mut diagnostics = Vec::new();
    run_stdio(context, request.as_bytes(), &mut output, &mut diagnostics)
        .await
        .expect("the stdio loop");
    let frames: Vec<Value> = String::from_utf8_lossy(&output)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let text = frames[0]["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    serde_json::from_str(text).expect("tool JSON")
}

#[tokio::test]
async fn the_rust_checks_run_their_exact_argv_from_the_harness_directory() {
    let fixture = Fixture::new("checks");
    let harness = fixture
        .context
        .harness_dir
        .canonicalize()
        .unwrap_or_else(|_| fixture.context.harness_dir.clone());

    let cases = [
        ("rust:fmt", "fmt --check --all"),
        (
            "rust:clippy",
            "clippy --workspace --all-targets -- -D warnings",
        ),
        ("rust:test", "run test"),
    ];
    for (check, expected) in cases {
        let result = run(&fixture, check, 0).await;
        assert_eq!(result["check"], check);
        assert_eq!(result["exitCode"], 0, "{result}");
        let call = std::fs::read_to_string(&fixture.log).unwrap();
        let line = call.lines().last().expect("a stub call");
        assert_eq!(line, format!("{}|{expected}", harness.display()));
        let log = result["log"].as_str().expect("a log path");
        assert!(fixture.context.repo_dir.join(log).is_file(), "{log}");
    }

    let failing = run(&fixture, "rust:test", 3).await;
    assert_eq!(failing["exitCode"], 3, "{failing}");
}

#[tokio::test]
async fn the_client_check_runs_the_entry_point_and_forwards_its_paths() {
    let fixture = Fixture::new("client");
    let harness = fixture
        .context
        .harness_dir
        .canonicalize()
        .unwrap_or_else(|_| fixture.context.harness_dir.clone());
    std::fs::create_dir_all(harness.join("client/lib")).unwrap();
    std::fs::write(harness.join("client/lib/example.test.ts"), "").unwrap();

    let arguments = json!({"check": "test", "paths": ["client/lib/example.test.ts"]});
    let result = run_with(&fixture, arguments, 0).await;
    assert_eq!(result["check"], "test");
    assert_eq!(result["exitCode"], 0, "{result}");
    let call = std::fs::read_to_string(&fixture.log).unwrap();
    let line = call.lines().last().expect("a stub call");
    assert_eq!(
        line,
        format!(
            "{}|run test:client -- ./client/lib/example.test.ts",
            harness.display()
        )
    );
}

#[tokio::test]
async fn an_unknown_check_names_every_accepted_check() {
    let fixture = Fixture::new("unknown");
    let result = run(&fixture, "nope", 0).await;
    let text = result.to_string();
    for expected in [
        "test",
        "check",
        "build",
        "typecheck",
        "verify:<name>",
        "rust:fmt",
        "rust:clippy",
        "rust:test",
    ] {
        assert!(text.contains(expected), "{expected} missing from {text}");
    }
}
