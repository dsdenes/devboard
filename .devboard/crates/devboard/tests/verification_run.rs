//! `verification_run`, its exact Rust check argv, and the build lease.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use devboard::build_lane::{cpu_count, derived_slots, jobs, BuildLane, BUILD_LANE_DIRECTORY};
use devboard::mcp_server::{run_stdio, McpContext};

struct Fixture {
    root: PathBuf,
    context: McpContext,
    log: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        Self::build(label, false)
    }

    /// A fixture whose stubs also record their program and build lease.
    fn recording(label: &str) -> Self {
        Self::build(label, true)
    }

    fn build(label: &str, record: bool) -> Self {
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
        let lease = if record {
            format!(
                "printf 'env|prog=%s|slot=%s|jobs=%s\\n' \"${{0##*/}}\" \
\"${{DEVBOARD_BUILD_SLOT:-}}\" \"${{CARGO_BUILD_JOBS:-}}\" >> '{}'\n",
                log.display()
            )
        } else {
            String::new()
        };
        for program in ["cargo", "bun"] {
            let stub = bin.join(program);
            std::fs::write(
                &stub,
                format!(
                    "#!/bin/sh\nprintf '%s|%s\\n' \"$PWD\" \"$*\" >> '{}'\n\
{lease}exit \"${{STUB_EXIT:-0}}\"\n",
                    log.display(),
                    lease = lease
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

    /// The lane this fixture's checks take.
    fn lane(&self, slots: usize) -> BuildLane {
        BuildLane::new(self.context.state_dir.join(BUILD_LANE_DIRECTORY), slots)
    }

    fn with_environment(mut self, pairs: &[(&str, &str)]) -> Self {
        for (key, value) in pairs {
            self.context
                .environment
                .insert((*key).to_string(), (*value).to_string());
        }
        self
    }

    /// The stub calls, one line each.
    fn calls(&self) -> Vec<String> {
        self.lines(|line| !line.starts_with("env|"))
    }

    /// The lease each stub call observed, one line each.
    fn leases(&self) -> Vec<String> {
        self.lines(|line| line.starts_with("env|"))
    }

    fn lines(&self, keep: impl Fn(&str) -> bool) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter(|line| keep(line))
            .map(str::to_string)
            .collect()
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
    run_owned(fixture.context.clone(), arguments, exit).await
}

async fn run_owned(context: McpContext, arguments: Value, exit: u8) -> Value {
    let mut environment = context.environment.clone();
    environment.insert("STUB_EXIT".to_string(), exit.to_string());
    let context = McpContext {
        environment,
        ..context
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
async fn the_focused_rust_gate_runs_its_exact_argv_and_never_the_full_runner() {
    let fixture = Fixture::recording("focused");
    let harness = fixture
        .context
        .harness_dir
        .canonicalize()
        .unwrap_or_else(|_| fixture.context.harness_dir.clone());

    let cases = [
        (
            json!({"check": "rust:test", "packages": ["devboard"], "tests": ["http_surface"]}),
            "test -p devboard --test http_surface",
        ),
        (
            json!({"check": "rust:test", "packages": ["devboard", "devboard-contract"]}),
            "test -p devboard -p devboard-contract",
        ),
        (json!({"check": "rust:test"}), "run test"),
    ];
    for (arguments, expected) in cases {
        let result = run_with(&fixture, arguments, 0).await;
        assert_eq!(result["exitCode"], 0, "{result}");
        let calls = fixture.calls();
        let line = calls.last().expect("a stub call");
        assert_eq!(line, &format!("{}|{expected}", harness.display()));
        if expected != "run test" {
            assert!(
                !line.contains("run test"),
                "the focused gate named the full runner: {line}"
            );
        }
        assert_eq!(
            fixture.leases().last().cloned(),
            Some(format!(
                "env|prog={}|slot=0|jobs={}",
                if expected == "run test" {
                    "bun"
                } else {
                    "cargo"
                },
                jobs(cpu_count(), derived_slots(cpu_count()))
            )),
            "the focused check's lease is wrong"
        );
    }
}

#[tokio::test]
async fn a_focused_check_rejects_a_name_a_cargo_flag_could_read() {
    let fixture = Fixture::recording("focused-refused");

    let cases = [
        (
            json!({"check": "rust:test", "tests": ["http_surface"]}),
            "tests requires packages",
        ),
        (
            json!({"check": "rust:test", "packages": ["devboard"], "tests": [7]}),
            "arguments.tests[0] does not match type",
        ),
        (
            json!({"check": "rust:test", "packages": ["devboard"], "tests": []}),
            "arguments.tests must hold at least 1 item(s).",
        ),
        (
            json!({"check": "rust:test", "packages": []}),
            "arguments.packages must hold at least 1 item(s).",
        ),
        (
            json!({"check": "rust:test", "packages": ["--workspace"]}),
            "A package name must not start with '-'",
        ),
    ];
    for (arguments, expected) in cases {
        let result = run_with(&fixture, arguments, 0).await;
        let error = result["error"].as_str().unwrap_or_default();
        assert!(error.contains(expected), "{expected} missing from {error}");
    }

    let too_many: Vec<Value> = (0..17).map(|index| json!(format!("p{index}"))).collect();
    let result = run_with(
        &fixture,
        json!({"check": "rust:test", "packages": too_many, "tests": ["http_surface"]}),
        0,
    )
    .await;
    assert!(
        result["error"]
            .as_str()
            .unwrap_or_default()
            .contains("arguments.packages must hold at most 16 item(s)."),
        "{result}"
    );
    let tests: Vec<Value> = (0..17).map(|index| json!(format!("t{index}"))).collect();
    let result = run_with(
        &fixture,
        json!({"check": "rust:test", "packages": ["devboard"], "tests": tests}),
        0,
    )
    .await;
    assert!(
        result["error"]
            .as_str()
            .unwrap_or_default()
            .contains("arguments.tests must hold at most 16 item(s)."),
        "{result}"
    );
    assert!(
        fixture.calls().is_empty(),
        "a refused argument spawned a build"
    );
}

#[tokio::test]
async fn a_rust_check_waits_for_a_free_slot_and_names_the_lease_it_holds() {
    let fixture = Fixture::recording("lease-waits")
        .with_environment(&[("DEVBOARD_MAX_BUILDS", "1"), ("CARGO_BUILD_JOBS", "3")]);
    let held = fixture.lane(1).acquire();

    let context = fixture.context.clone();
    let running =
        tokio::spawn(async move { run_owned(context, json!({"check": "rust:test"}), 0).await });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        fixture.calls().is_empty(),
        "a check ran while the only slot was held: {:?}",
        fixture.calls()
    );
    drop(held);

    let result = running.await.expect("the check task");
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(fixture.calls().len(), 1, "{:?}", fixture.calls());
    assert_eq!(
        fixture.leases(),
        vec!["env|prog=bun|slot=0|jobs=3".to_string()],
        "the child saw no lease or a derived job count over the caller's"
    );
}

#[tokio::test]
async fn a_rust_check_derives_the_job_count_of_its_slot_when_the_caller_set_none() {
    let fixture =
        Fixture::recording("lease-jobs").with_environment(&[("DEVBOARD_MAX_BUILDS", "2")]);
    let expected = jobs(cpu_count(), 2).to_string();

    let result = run_with(&fixture, json!({"check": "rust:clippy"}), 0).await;
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(
        fixture.leases(),
        vec![format!("env|prog=cargo|slot=0|jobs={expected}")],
        "the slot or the derived job count is wrong"
    );
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
