//! `background_agents_list` and `background_agent_get` with persisted worker
//! state and no live dashboard.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("persisted-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let state = root.join("state");
        std::fs::create_dir_all(repo.join(".devboard")).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["init", "--quiet"])
            .status()
            .unwrap();
        Self { root, repo, state }
    }

    fn write(&self, relative: &str, value: Value) {
        let path = self.state.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();
    }

    fn seed(&self) {
        let dead = 999_999u32;
        self.write(
            "watchdog/worker.json",
            json!({
                "version": 1,
                "pid": dead,
                "lifecycle": "stopped",
                "enabled": true,
                "startedAt": "2026-01-01T00:00:00.000Z",
                "root": self.repo,
                "stateDir": self.state,
                "argv": ["devboard", "worker", "watchdog"],
                "updatedAt": "2026-01-02T00:00:00.000Z",
                "lastRunAt": "2026-01-02T00:00:00.000Z",
                "nextRunAt": "2026-01-02T00:10:00.000Z",
            }),
        );
        self.write(
            "watchdog/state.json",
            json!({
                "version": 2,
                "findings": {
                    "fp-1": {
                        "category": "server-error",
                        "line": "a machine failure",
                        "firstSeen": "2026-01-01T00:00:00.000Z",
                        "lastSeen": "2026-01-02T00:00:00.000Z",
                        "count": 2,
                        "disposition": "filed:https://forge.test/acme/fixture/issues/7",
                        "filedAt": "2026-01-02T00:00:01.000Z",
                        "instances": [],
                    }
                },
            }),
        );
        self.write(
            "watchdog/settings.json",
            json!({"intervalMinutes": 12, "maxPerHour": null, "maxPending": null}),
        );
        self.write(
            "mcp-optimizer/worker.json",
            json!({
                "version": 1,
                "pid": dead,
                "lifecycle": "stopped",
                "enabled": true,
                "startedAt": "2026-01-01T00:00:00.000Z",
                "root": self.repo,
                "stateDir": self.state,
                "argv": ["devboard", "worker", "mcp-optimizer"],
                "updatedAt": "2026-01-02T00:00:00.000Z",
                "lastRunAt": "2026-01-02T00:00:00.000Z",
                "nextRunAt": "2026-01-02T01:00:00.000Z",
            }),
        );
        self.write(
            "mcp-optimizer/settings.json",
            json!({"intervalMinutes": 7, "maxPerHour": 3, "maxPending": 5}),
        );
        self.write(
            "mcp-optimizer/projection.json",
            json!({
                "version": 1,
                "state": "ok",
                "at": "2026-01-02T00:00:00.000Z",
                "error": null,
                "issues": [{"number": 9, "title": "Repeated command", "url": "https://forge.test/acme/fixture/issues/9"}],
            }),
        );
        self.write(
            "release-train/worker.json",
            json!({
                "version": 1,
                "pid": dead,
                "lifecycle": "stopped",
                "enabled": true,
                "paused": false,
                "startedAt": "2026-01-01T00:00:00.000Z",
                "root": self.repo,
                "stateDir": self.state,
                "argv": ["devboard", "worker", "release-train"],
                "updatedAt": "2026-01-02T00:00:00.000Z",
                "lastRunAt": "2026-01-02T00:00:00.000Z",
                "nextRunAt": "2026-01-02T00:10:00.000Z",
            }),
        );
        self.write(
            "dead-code/state.json",
            json!({
                "version": 2,
                "lifecycle": "idle",
                "enabled": true,
                "issues": [{
                    "number": 11,
                    "title": "A dead function",
                    "url": "https://forge.test/acme/fixture/issues/11",
                    "createdAt": "2026-01-02T00:00:05.000Z",
                    "state": "pending",
                }],
                "notices": ["Filed #11", "Settings saved"],
                "lastScan": {
                    "scanId": "cycle-1",
                    "status": "incomplete",
                    "requested": 2,
                    "filed": 1,
                    "shortfall": "filed 1 of the 2 requested",
                    "startedAt": "2026-01-02T00:00:00.000Z",
                    "finishedAt": "2026-01-02T00:01:00.000Z",
                },
                "updatedAt": "2026-01-02T00:01:00.000Z",
            }),
        );
        self.write(
            "release-train/state.json",
            json!({
                "version": 1,
                "repo": "acme/fixture",
                "root": self.repo,
                "runs": [{"id": "run-1"}],
                "activity": ["released v1.2.3"],
                "updatedAt": "2026-01-02T00:00:00.000Z",
            }),
        );
    }

    fn mcp(&self, requests: &[Value]) -> Vec<Value> {
        let mut child = Command::new(env!("CARGO_BIN_EXE_devboard"))
            .arg("mcp")
            .current_dir(&self.repo)
            .env("REPO_DIR", &self.repo)
            .env("STATE_DIR", &self.state)
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the MCP server starts");
        {
            let stdin = child.stdin.as_mut().unwrap();
            for request in requests {
                writeln!(stdin, "{}", serde_json::to_string(request).unwrap()).unwrap();
            }
        }
        drop(child.stdin.take());
        let mut frames = Vec::new();
        for line in BufReader::new(child.stdout.take().unwrap())
            .lines()
            .map_while(Result::ok)
        {
            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                frames.push(frame);
            }
        }
        let _ = child.wait();
        frames
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn tool(frames: &[Value], id: i64) -> Value {
    let reply = frames
        .iter()
        .find(|frame| frame["id"] == id)
        .expect("a reply");
    let text = reply["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    serde_json::from_str(text).expect("tool JSON")
}

#[test]
fn persisted_workers_answer_without_a_dashboard() {
    let fixture = Fixture::new("list");
    fixture.seed();
    let frames = fixture.mcp(&[
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-01-01"}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "background_agents_list", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "background_agent_get", "arguments": {"id": "mcp-optimizer"}}}),
    ]);
    let agents = tool(&frames, 2);
    let list = agents["agents"]
        .as_array()
        .unwrap_or_else(|| panic!("an agent array: {agents}"));
    assert_eq!(list.len(), 9, "{agents}");
    let find = |id: &str| {
        list.iter()
            .find(|agent| agent["id"] == id)
            .unwrap_or_else(|| panic!("{id} is listed"))
            .clone()
    };

    let watchdog = find("watchdog");
    assert_eq!(watchdog["provenance"], "persisted");
    assert!(
        watchdog["asOf"]
            .as_str()
            .is_some_and(|text| !text.is_empty()),
        "a persisted snapshot names the instant it observed: {watchdog}"
    );
    assert_eq!(watchdog["lifecycle"], "stopped");
    assert_eq!(watchdog["enabled"], true);
    assert_eq!(watchdog["attached"], false);
    assert_eq!(watchdog["owned"], false);
    assert_eq!(watchdog["cadence"]["minutes"], 12);
    assert_eq!(watchdog["cadence"]["lastRunAt"], "2026-01-02T00:00:00.000Z");
    assert_eq!(watchdog["cadence"]["nextRunAt"], "2026-01-02T00:10:00.000Z");
    assert_eq!(watchdog["issues"].as_array().unwrap().len(), 1);
    assert_eq!(
        watchdog["issues"][0]["url"],
        "https://forge.test/acme/fixture/issues/7"
    );
    assert!(watchdog["sync"]["state"].is_string());
    assert!(watchdog["detail"]["entries"].is_array());

    let scout = find("scout");
    assert_eq!(scout["provenance"], "persisted");
    assert_eq!(
        scout["lifecycle"],
        Value::Null,
        "a family no file names never claims a lifecycle: {scout}"
    );

    let optimizer = find("mcp-optimizer");
    assert_eq!(optimizer["limits"]["maxPerHour"], 3);
    assert_eq!(optimizer["limits"]["maxPending"], 5);
    assert_eq!(optimizer["issues"].as_array().unwrap().len(), 1);
    assert_eq!(optimizer["issues"][0]["title"], "Repeated command");

    let dead_code = find("dead-code");
    assert_eq!(
        dead_code["notices"],
        json!(["Filed #11", "Settings saved"]),
        "the recent status lines survive: {dead_code}"
    );
    assert_eq!(dead_code["lastScan"]["status"], "incomplete");
    assert_eq!(
        dead_code["lastScan"]["shortfall"],
        "filed 1 of the 2 requested"
    );
    assert_eq!(
        dead_code["issues"][0]["filedAt"], "2026-01-02T00:00:05.000Z",
        "a row filed without a filedAt names its creation instant"
    );

    let release = find("release-train");
    let entries: Vec<&str> = release["detail"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(entries.contains(&"run-1"), "{entries:?}");
    assert!(entries.contains(&"released v1.2.3"), "{entries:?}");

    let single = tool(&frames, 3);
    assert_eq!(single["id"], "mcp-optimizer");
    assert_eq!(
        serde_json::to_string(&single).unwrap(),
        serde_json::to_string(&optimizer).unwrap(),
        "get returns the same record as the list"
    );
}

#[test]
fn an_unknown_live_agent_is_an_error_not_null() {
    let fixture = Fixture::new("unknown");
    let frames = fixture.mcp(&[
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-01-01"}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "background_agent_get", "arguments": {"id": "nope"}}}),
    ]);
    let reply = frames
        .iter()
        .find(|frame| frame["id"] == 2)
        .expect("a reply");
    assert_eq!(reply["result"]["isError"], true, "{reply}");
    let text = reply["result"]["content"][0]["text"]
        .as_str()
        .expect("tool text");
    assert!(
        text.contains("Unknown background agent: nope."),
        "not null, and names the id: {text}"
    );
    assert!(!text.trim().is_empty());
}
