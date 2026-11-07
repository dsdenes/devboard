//! A deterministic ACP peer for the interface's tests and verification.
//!
//! It answers the protocol handshake, streams a little activity, optionally
//! interviews the developer, writes `status: accepted` into the frontmatter of
//! the record named in the prompt, and ends the turn. With `--discover` it
//! instead stages the sheet, glossary, contribution document, and six Discover
//! skills named by the agent's `/discover-*` command.
//!
//! The port keeps the TypeScript fixture's observable behavior: the same
//! flags, the same frames, and the same staged bytes. It is a std-only peer
//! speaking newline-delimited JSON-RPC on stdin and stdout.

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde_json::{json, Map, Value};

/// Runs the stub with the peer's command-line arguments (without the program
/// name). The caller wires `acp-stub` to this function.
pub fn run_stub(args: &[String]) -> Result<()> {
    let stub = Arc::new(Stub::new(args));
    stub.serve();
    stub.log_exit();
    Ok(())
}

const SESSION_ID: &str = "stub-session";
const SETTLE_DELAY_MS: u64 = 400;
const CREATED_GOAL: &str = "# Created goal\n\nThe agent wrote this.";
const REVISED_GOAL: &str = "# Revised goal\n\nThe agent rewrote this.";
const DISCOVER_SECRET: &str = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const CLOSED_UNMERGED_MARKER: &str = "CLOSED-UNMERGED-DESCRIPTION-MUST-NOT-LEAK";
const ASK_INSTRUCTION: &str = "\nQuestion: ";
const ASK_ANSWER_ONE: &str =
    "The issues indicator shows the lifecycle the detached worker published for this repository. \
     It turns amber while a run is working and shows failed when the last run failed. \
     It sits in the status bar and opens the Issues mode.";
const ASK_ANSWER_TWO: &str =
    "The status bar renders that label in StatusBar.svelte from the issues snapshot the server \
     sends. The count is the open issues the tracker returned for the host repository. \
     No other status item opens a mode.";

/// The peer's raw arguments, read with the TypeScript fixture's helpers.
struct Arguments {
    values: Vec<String>,
}

impl Arguments {
    fn new(values: &[String]) -> Self {
        Self {
            values: values.to_vec(),
        }
    }

    /// The value of the first `--name=value`, exactly as the fixture reads it.
    fn argument(&self, name: &str) -> Option<&str> {
        let prefix = format!("--{name}=");
        self.values
            .iter()
            .find_map(|value| value.strip_prefix(prefix.as_str()))
    }

    /// Every value of `--name=value`, in argument order.
    fn argument_all(&self, name: &str) -> Vec<&str> {
        let prefix = format!("--{name}=");
        self.values
            .iter()
            .filter_map(|value| value.strip_prefix(prefix.as_str()))
            .collect()
    }

    /// True when the exact flag `--name` is present.
    fn contains(&self, name: &str) -> bool {
        let flag = format!("--{name}");
        self.values.iter().any(|value| value == &flag)
    }

    /// Parses repeated `--name=<id>:<value>` arguments into an id-keyed map.
    fn id_options(&self, name: &str) -> HashMap<String, String> {
        let mut options = HashMap::new();
        for entry in self.argument_all(name) {
            if let Some(split) = entry.find(':') {
                options.insert(entry[..split].to_string(), entry[split + 1..].to_string());
            }
        }
        options
    }
}

/// One prompt the worker must answer in arrival order.
struct PromptJob {
    id: Value,
    params: Value,
}

struct Stub {
    cwd: PathBuf,
    arguments: Arguments,
    log_path: Option<PathBuf>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next_request_id: AtomicU64,
    log_lock: Mutex<()>,
    announced: AtomicBool,
    logged_exit: AtomicBool,
    ask_turns: AtomicU64,
    busy_remaining: AtomicU64,
}

impl Stub {
    fn new(args: &[String]) -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let arguments = Arguments::new(args);
        let log_path = arguments.argument("log").map(PathBuf::from);
        let busy_remaining = arguments
            .argument("busy-continuations")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let stub = Self {
            cwd,
            arguments,
            log_path,
            pending: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            log_lock: Mutex::new(()),
            announced: AtomicBool::new(false),
            logged_exit: AtomicBool::new(false),
            ask_turns: AtomicU64::new(0),
            busy_remaining: AtomicU64::new(busy_remaining),
        };
        if stub.arguments.contains("ask") {
            stub.log(&format!("ask-start {}", std::process::id()));
        }
        if stub.arguments.contains("goal-draft") {
            stub.log(&format!("goal-draft-start {}", std::process::id()));
        }
        if let Some(path) = stub.arguments.argument("provider-env") {
            stub.write_provider_environment(Path::new(path));
        }
        stub
    }

    /// Records the provider environment a peer received, without the keys.
    fn write_provider_environment(&self, path: &Path) {
        let fingerprint = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| sha256_hex(&value)[..16].to_string())
        };
        let agent_dir = std::env::var("PI_CODING_AGENT_DIR").ok();
        let line = json!({
            "pid": std::process::id(),
            "argv": self.arguments.values.clone(),
            "cwd": self.cwd.to_string_lossy(),
            "agentDir": agent_dir,
            "opencode": fingerprint("OPENCODE_API_KEY"),
            "openrouter": fingerprint("OPENROUTER_API_KEY"),
        });
        let Ok(text) = serde_json::to_string(&line) else {
            return;
        };
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{text}");
        }
    }

    /// Reads protocol lines until stdin closes; prompt turns run in order on
    /// one worker so a queued message answers in order.
    fn serve(self: &Arc<Self>) {
        let (sender, receiver) = mpsc::channel::<PromptJob>();
        let worker = Arc::clone(self);
        thread::spawn(move || {
            while let Ok(job) = receiver.recv() {
                worker.handle_prompt(job);
            }
        });

        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let Some(object) = message.as_object() else {
                continue;
            };
            if let Some(method) = object.get("method").and_then(Value::as_str) {
                let Some(id) = object.get("id").filter(|value| !value.is_null()) else {
                    continue;
                };
                let params = object.get("params").cloned().unwrap_or(Value::Null);
                match method {
                    "initialize" => self.handle_initialize(id, &params),
                    "session/new" => self.handle_session_new(id),
                    "session/prompt" => {
                        let text = prompt_text(&params).unwrap_or_default();
                        if self.take_busy(id, &text) {
                            continue;
                        }
                        let _ = sender.send(PromptJob {
                            id: id.clone(),
                            params,
                        });
                    }
                    "session/cancel" => {}
                    other => self.write_error(id, -32601, &format!("Method not found: {other}")),
                }
                continue;
            }
            if let Some(id) = object.get("id") {
                let result = object.get("result").cloned().unwrap_or(Value::Null);
                self.resolve_response(id, result);
            }
        }
    }

    /// Answers one `session/prompt` with a busy failure while continuations
    /// remain, exactly as the fixture does.
    fn take_busy(&self, id: &Value, text: &str) -> bool {
        if self.busy_remaining.load(Ordering::SeqCst) == 0
            || !text.starts_with("The implementation turn ended")
        {
            return false;
        }
        self.busy_remaining.fetch_sub(1, Ordering::SeqCst);
        self.log("busy");
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32003,
                "message": "Session is busy",
                "data": { "reason": "session_busy", "hint": "steer|followUp|wait" },
            },
        }));
        true
    }

    fn handle_initialize(&self, id: &Value, _params: &Value) {
        if self.arguments.contains("ask-refuse-initialize")
            && self.first_ask_handshake("initialize")
        {
            self.write_error(id, -32603, "The Ask agent refused the handshake.");
            return;
        }
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": 1,
                "agentInfo": { "name": "stub-agent", "version": "0.1.0" },
            },
        }));
    }

    fn handle_session_new(&self, id: &Value) {
        if self.arguments.contains("ask-no-session") && self.first_ask_handshake("session") {
            self.write_frame(json!({ "jsonrpc": "2.0", "id": id, "result": {} }));
            return;
        }
        self.log("session-new");
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "sessionId": SESSION_ID },
        }));
    }

    fn handle_prompt(&self, job: PromptJob) {
        match self.prompt_turn(&job.params) {
            Ok(()) => self.write_frame(json!({
                "jsonrpc": "2.0",
                "id": job.id,
                "result": { "stopReason": "end_turn" },
            })),
            Err(error) => self.write_error(&job.id, -32603, &error),
        }
    }

    fn resolve_response(&self, id: &Value, result: Value) {
        let key = match id {
            Value::Number(number) => number.as_u64(),
            Value::String(text) => text.parse::<u64>().ok(),
            _ => None,
        };
        let Some(key) = key else {
            return;
        };
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }

    /// Sends one request and waits for the client's response; a peer that
    /// never answers settles the request as null.
    fn request(&self, method: &str, params: Value) -> Value {
        let id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, sender);
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        receiver.recv().unwrap_or(Value::Null)
    }

    fn write_frame(&self, message: Value) {
        let Ok(text) = serde_json::to_string(&message) else {
            return;
        };
        let mut stdout = io::stdout().lock();
        let _ = stdout.write_all(text.as_bytes());
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }

    fn write_error(&self, id: &Value, code: i64, message: &str) {
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }));
    }

    /// Appends one line to `--log=`, when the peer was given one.
    fn log(&self, line: &str) {
        let Some(path) = &self.log_path else {
            return;
        };
        let _guard = self
            .log_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }

    /// Records that the peer left exactly once, so a test can prove the close.
    fn log_exit(&self) {
        if self.logged_exit.swap(true, Ordering::SeqCst) {
            return;
        }
        self.log(&format!("exit {}", std::process::id()));
    }

    fn exit_stub(&self, code: i32) -> ! {
        self.log_exit();
        std::process::exit(code)
    }

    /// True once per flag, so only the first peer fails that handshake step.
    fn first_ask_handshake(&self, flag: &str) -> bool {
        let Some(log) = &self.log_path else {
            return false;
        };
        let marker = PathBuf::from(format!("{}.{flag}", log.display()));
        if marker.exists() {
            return false;
        }
        let _ = fs::write(&marker, "");
        true
    }

    /// Streams one assistant message chunk.
    fn stream(&self, text: &str) {
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": text },
                },
            },
        }));
    }

    fn prompt_turn(&self, params: &Value) -> std::result::Result<(), String> {
        if !self.announced.swap(true, Ordering::SeqCst) {
            self.log(&format!("spawn {}", std::process::id()));
            self.log(&format!("argv {}", self.arguments.values.join(" ")));
        }
        let text = prompt_text(params);
        let file = text.as_deref().and_then(record_file);
        let first_line = text
            .as_deref()
            .and_then(|text| text.split('\n').next())
            .unwrap_or("");

        // A prompt-chat turn: the base prompt travels between the two markers,
        // and the reply proposes a complete replacement without writing files.
        if text.as_deref().is_some_and(|text| {
            text.contains("## Operator request") && text.contains("<<<PROMPT\n")
        }) {
            return self.run_prompt_chat(text.as_deref().unwrap_or(""));
        }

        if let Some(slug) = self.arguments.argument("goal-slug") {
            if text
                .as_deref()
                .is_some_and(|text| text.contains("Reply with only the slug"))
            {
                return self.run_goal_slug(slug, first_line);
            }
        }

        if self.arguments.contains("ask")
            && text
                .as_deref()
                .is_some_and(|text| text.contains(ASK_INSTRUCTION))
        {
            return self.run_ask(text.as_deref().unwrap_or(""));
        }

        if self.arguments.contains("goal-draft") && first_line.starts_with("/goal-draft ") {
            return self.run_goal_draft(first_line["/goal-draft ".len()..].trim());
        }

        if self.arguments.contains("flow-goal") && first_line.starts_with("/flow-goal ") {
            self.log(&format!("prompt {first_line}"));
            return self.run_flow_goal(first_line["/flow-goal ".len()..].trim());
        }
        if self.arguments.contains("flow-implement") && first_line.starts_with("/flow-implement ") {
            self.log(&format!("prompt {first_line}"));
            return self.run_flow_implementation(first_line["/flow-implement ".len()..].trim());
        }
        if self.arguments.contains("flow-change") && first_line.starts_with("/flow-change ") {
            self.log(&format!("prompt {first_line}"));
            return self.run_flow_change(first_line["/flow-change ".len()..].trim());
        }
        if self.arguments.contains("flow-widget") && first_line.starts_with("/flow-widget ") {
            self.log(&format!("prompt {first_line}"));
            return self.run_flow_widget(first_line["/flow-widget ".len()..].trim());
        }

        let revising = self.arguments.contains("revise-goal")
            && text
                .as_deref()
                .is_some_and(|text| text.contains("Revise the goal"));
        if self.arguments.contains("flow-widget")
            && text.is_some()
            && !first_line.starts_with('/')
            && !revising
        {
            self.log(&format!("flow-conversation {first_line}"));
            self.stream(&format!("Developer: {first_line}"));
            return Ok(());
        }

        if self.arguments.contains("discover") {
            let commands = [
                "/discover-sheet",
                "/discover-contribution",
                "/discover-testing-strategy",
                "/discover-naming-conventions",
                "/discover-coding-conventions",
                "/discover-architecture-boundaries",
                "/discover-glossary",
            ];
            if let Some(command) = commands
                .iter()
                .find(|command| first_line.starts_with(&format!("{command} ")))
            {
                self.log(&format!("prompt {first_line}"));
                let agent = if *command == "/discover-sheet" {
                    "sheet".to_string()
                } else {
                    command.trim_start_matches('/').to_string()
                };
                let staging = first_line[command.len()..].trim();
                return self.run_discover_agent(&agent, staging);
            }
        }

        let creating = self.arguments.contains("create-goal") && first_line == "/goal-outcome";
        self.log(&format!("prompt {first_line}"));
        if revising {
            self.log(&format!("request {}", text.as_deref().unwrap_or("")));
        }

        if self.arguments.contains("prepare-skills") && first_line == "/prepare-skills" {
            return self.run_prepare_skills();
        }

        let lane_epic = if first_line.starts_with("/implement-next-epic") && !creating && !revising
        {
            implementation_epic(first_line, self.arguments.argument("fixture-tracker"))
        } else {
            None
        };
        if let Some(epic) = lane_epic {
            return self.run_implementation_lane(&epic);
        }

        if first_line == "/epic-next" && !creating && !revising {
            return self.run_generation_lane();
        }

        // A remaining conversation turn probes the mutating action first, so a
        // read-only client's cancelled answer is observable.
        self.probe_permission();

        if creating {
            self.stream("Creating the goal");
        } else if revising {
            self.stream("Revising the goal");
        } else if file.is_none() {
            self.stream(&format!("Working on {first_line}"));
        }

        self.sleep_ms_with_progress(self.number_argument("delay-ms"));

        if let Some(file) = &file {
            if !revising {
                let name = path_basename(file);
                self.stream(&format!("Inspecting {name}"));
            }
        }

        let question_count = if creating || revising {
            1
        } else if let Some(forced) = self.number_argument("questions") {
            forced.max(0.0) as u64
        } else if let Some(file) = &file {
            let parent = Path::new(file).parent().unwrap_or_else(|| Path::new("."));
            let directory = if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            };
            if pending_count(directory) == 1 {
                1
            } else {
                0
            }
        } else {
            0
        };
        self.ask_questions(question_count)?;

        if creating {
            if let Some(goal_file) = self.arguments.argument("goal") {
                if !self.arguments.contains("no-create-goal-write") {
                    write_text(Path::new(goal_file), CREATED_GOAL)?;
                    self.log(&format!("created {goal_file}"));
                    self.stream("Created the goal");
                }
            }
            return Ok(());
        }

        if revising {
            if let Some(goal_file) = self.arguments.argument("goal") {
                write_text(Path::new(goal_file), REVISED_GOAL)?;
                self.log(&format!("revised {goal_file}"));
                self.stream("Revised the goal");
            }
            return Ok(());
        }

        if let Some(file) = file {
            thread::sleep(Duration::from_millis(SETTLE_DELAY_MS));
            if self.arguments.contains("remove-record") {
                fs::remove_file(&file).map_err(|error| error.to_string())?;
                self.log(&format!("removed {file}"));
            } else if !self.arguments.contains("no-resolve") {
                mark_accepted(&file)?;
                self.log(&format!("resolved {file}"));
                self.stream(&format!("Updated {}", path_basename(&file)));
            }
        }
        Ok(())
    }

    /// The read-only Ask turn: thought and tool noise, then the answer.
    fn run_ask(&self, text: &str) -> std::result::Result<(), String> {
        let turns = self.ask_turns.fetch_add(1, Ordering::SeqCst) + 1;
        let question = text
            .lines()
            .find_map(|line| line.strip_prefix("Question: "))
            .unwrap_or("");
        self.log(&format!("ask-prompt {turns} {question}"));
        let encoded = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
        self.log(&format!("ask-text {turns} {encoded}"));

        if self.arguments.contains("ask-stall") && self.first_ask_handshake("stall") {
            self.log("ask-stall");
            loop {
                thread::sleep(Duration::from_secs(3600));
            }
        }

        self.probe_permission();
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": {
                        "type": "text",
                        "text": "Considering the captured element before answering.",
                    },
                    "messageId": format!("ask-thought-{turns}"),
                },
            },
        }));
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": format!("ask-tool-{turns}"),
                    "title": "Reading the captured element",
                    "kind": "read",
                    "status": "pending",
                },
            },
        }));

        let delay = self.number_argument("ask-delay-ms");
        self.sleep_ms(delay);
        let first_peer = !text.contains("Earlier in this conversation:");
        if self.arguments.contains("ask-exit") && first_peer {
            self.log("ask-exit");
            self.exit_stub(0);
        }
        if self.arguments.contains("ask-fail") && turns == 1 {
            return Err("The ask agent failed.".to_string());
        }

        let answer = if turns == 1 {
            ASK_ANSWER_ONE
        } else {
            ASK_ANSWER_TWO
        };
        let split = answer.find(". ").map(|index| index + 2).unwrap_or(0);
        self.stream(answer[..split].trim());
        self.sleep_ms(delay);
        self.stream(answer[split..].trim());
        Ok(())
    }

    /// The prompt-chat turn: reply with a complete replacement proposal.
    fn run_prompt_chat(&self, text: &str) -> std::result::Result<(), String> {
        self.log("prompt-chat");
        let marker = "<<<PROMPT\n";
        let start = text
            .find(marker)
            .map(|index| index + marker.len())
            .unwrap_or(0);
        let end = text[start..]
            .find("\nPROMPT>>>")
            .map(|index| start + index)
            .unwrap_or(start);
        let base = &text[start..end];
        self.stream("Here is the revision.");
        let proposal = format!(
            "{}\n\n<!-- revised by the verification peer -->\n",
            base.trim_end()
        );
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {
                        "type": "text",
                        "text": format!("\n\n<prompt-file>\n{proposal}</prompt-file>\n"),
                    },
                },
            },
        }));
        Ok(())
    }

    /// The read-only naming turn: one thought, then the slug verbatim.
    fn run_goal_slug(&self, slug: &str, first_line: &str) -> std::result::Result<(), String> {
        self.log(&format!("goal-slug {first_line}"));
        self.probe_permission();
        self.write_frame(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "Considering the report." },
                    "messageId": "goal-slug-thought",
                },
            },
        }));
        self.stream(slug);
        Ok(())
    }

    /// The `/goal-draft` turn. The draft's own bytes choose the scenario:
    /// `STUB-QUESTION` asks one question first, `STUB-HANG` waits for Stop, and
    /// `STUB-FAIL` reports a failed label verification. A successful turn
    /// writes the five-section spec and removes the draft.
    fn run_goal_draft(&self, relative: &str) -> std::result::Result<(), String> {
        self.log(&format!("goal-draft {relative}"));
        let draft_path = self.cwd.join(relative);
        let source = fs::read_to_string(&draft_path).unwrap_or_default();
        self.stream(&format!(
            "Reading the draft and researching the repository {relative}"
        ));

        if source.contains("STUB-QUESTION") {
            self.ask_questions_with(1, false)?;
        }
        if source.contains("STUB-FAIL") {
            return Err("goal label verification failed".to_string());
        }
        if source.contains("STUB-HANG") {
            let finish = self
                .arguments
                .argument("goal-draft-finish")
                .map(PathBuf::from);
            loop {
                if finish.as_ref().is_some_and(|path| path.exists()) {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }

        let name = draft_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = name.strip_suffix(".md").unwrap_or(&name).to_string();
        let spec = self
            .cwd
            .join(".devboard")
            .join("goals")
            .join(format!("{name}.md"));
        let text = [
            "## Objective".to_string(),
            String::new(),
            format!("Finalized {name}."),
            String::new(),
            "## Success criteria".to_string(),
            String::new(),
            "- The stub wrote this spec.".to_string(),
            String::new(),
            "## Verification".to_string(),
            String::new(),
            "- Read this file.".to_string(),
            String::new(),
            "## Boundaries".to_string(),
            String::new(),
            "- The fixture only.".to_string(),
            String::new(),
            "## Stop conditions".to_string(),
            String::new(),
            "- Halt on a missing prerequisite.".to_string(),
            String::new(),
        ]
        .join("\n");
        write_text(&spec, &text)?;
        self.log(&format!("goal-draft-verified {relative}"));
        let _ = fs::remove_file(&draft_path);
        self.stream("Filed the goal issue and verified the goal label");
        Ok(())
    }

    fn run_flow_goal(&self, directory: &str) -> std::result::Result<(), String> {
        self.log(&format!("flow-goal {directory}"));
        self.stream("Interviewing the developer about the Flow goal");
        if let Some(path) = self.arguments.argument("flow-goal-hang") {
            if Path::new(path).exists() {
                self.log(&format!("flow-goal-hung {directory}"));
                loop {
                    thread::sleep(Duration::from_secs(3600));
                }
            }
        }
        if let Some(path) = self.arguments.argument("flow-goal-partial") {
            if Path::new(path).exists() {
                let goal_dir = PathBuf::from(directory);
                let _ = fs::create_dir_all(&goal_dir);
                let draft = self
                    .arguments
                    .argument("flow-goal-draft")
                    .unwrap_or("# Flow goal\n\nAn unfinished draft");
                let _ = fs::write(goal_dir.join("goal.md"), draft);
                self.log(&format!("flow-goal-partial {directory}"));
                loop {
                    thread::sleep(Duration::from_secs(3600));
                }
            }
        }
        self.sleep_ms(self.number_argument("delay-ms"));
        self.ask_questions(1)?;
        if self.arguments.contains("flow-goal-fail") {
            self.log("flow-goal-failed");
            self.exit_stub(1);
        }
        let goal_dir = PathBuf::from(directory);
        let _ = fs::create_dir_all(&goal_dir);
        let mut text = self
            .arguments
            .argument("flow-goal-text")
            .unwrap_or("# Flow goal\n\nMake the fixture behavior observable.")
            .to_string();
        if let Some(path) = self.arguments.argument("flow-goal-text-file") {
            if let Ok(read) = fs::read_to_string(path) {
                text = read;
            }
        }
        let text = if self.arguments.contains("flow-goal-empty") {
            String::new()
        } else {
            text
        };
        fs::write(goal_dir.join("goal.md"), text).map_err(|error| error.to_string())?;
        self.log(&format!("flow-goal-written {directory}"));
        self.sleep_ms(self.number_argument("flow-goal-settle"));
        self.stream("Wrote the Flow goal");
        Ok(())
    }

    fn run_flow_implementation(&self, directory: &str) -> std::result::Result<(), String> {
        // A fixture whose worktree could not be created must never commit the
        // harness checkout itself: `git add -A` there would rewrite the repo.
        if is_harness_checkout(&self.cwd) {
            self.log(&format!(
                "flow-implementation-refused-harness-root {}",
                self.cwd.display()
            ));
            return Ok(());
        }
        self.log(&format!(
            "flow-implement {directory} cwd={}",
            self.cwd.display()
        ));
        self.stream("Reading the plan");

        if self.arguments.contains("flow-question") {
            self.ask_questions(1)?;
        }
        self.sleep_ms(self.number_argument("flow-pre-commit-delay"));

        let raw_checkpoints = self.number_argument("flow-checkpoints").unwrap_or(1.0);
        let checkpoints = if raw_checkpoints.is_finite() {
            raw_checkpoints.max(1.0) as u64
        } else {
            0
        };
        let step_delay = self.number_argument("flow-step-delay");
        let verification = self
            .arguments
            .argument("flow-verification")
            .unwrap_or("passed");
        let goal_dir = PathBuf::from(directory);

        for index in 1..=checkpoints {
            let decisions = fs::read_to_string(goal_dir.join("decisions.md")).unwrap_or_default();
            self.log(&format!(
                "flow-decisions-read {index} {}",
                decisions.chars().count()
            ));
            if index > 1 {
                if let Some(path) = self.arguments.argument("flow-wait-file") {
                    let deadline = Instant::now() + Duration::from_secs(30);
                    while !Path::new(path).exists() && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(25));
                    }
                    self.log(&format!(
                        "flow-wait-done {}",
                        if Path::new(path).exists() {
                            "yes"
                        } else {
                            "timeout"
                        }
                    ));
                }
                self.consume_steering(&goal_dir);
            }
            let _ = fs::create_dir_all(self.cwd.join("src"));
            let _ = fs::write(self.cwd.join("src/app.txt"), format!("version {index}\n"));
            write_json_file(
                &self.cwd.join("src/config.json"),
                &json!({ "version": index }),
            );
            if index > 1 {
                let _ = fs::write(
                    self.cwd.join(format!("src/extra-{index}.txt")),
                    format!("extra {index}\n"),
                );
            }

            // The server runs its own git commands on this worktree while the
            // peer commits, so an occasional index.lock makes the pair fail.
            let mut added_stderr = String::new();
            let mut commit_stderr = String::new();
            let mut committed = false;
            for attempt in 1..=5 {
                let added = flow_git(&self.cwd, &["add", "-A"]);
                added_stderr = added.stderr.trim().to_string();
                if added.code == 0 {
                    let committed_result = flow_git(
                        &self.cwd,
                        &[
                            "commit",
                            "-m",
                            &format!("checkpoint {index}: fixture change"),
                        ],
                    );
                    commit_stderr = committed_result.stderr.trim().to_string();
                    if committed_result.code == 0 {
                        committed = true;
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(50 * attempt));
            }
            if !committed {
                let add_json = serde_json::to_string(&added_stderr).unwrap_or_default();
                self.log(&format!(
                    "flow-commit-failed {commit_stderr} add={add_json}"
                ));
                return Ok(());
            }
            let revision = flow_git(&self.cwd, &["rev-parse", "--short=7", "HEAD"]);
            let commit = revision.stdout.trim().to_string();
            let verified_at = iso_now();
            if let Some(path) = self.arguments.argument("flow-record-wait-file") {
                let deadline = Instant::now() + Duration::from_secs(30);
                while !Path::new(path).exists() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(25));
                }
                self.log(&format!(
                    "flow-record-wait-done {}",
                    if Path::new(path).exists() {
                        "yes"
                    } else {
                        "timeout"
                    }
                ));
            }
            if !self.arguments.contains("flow-no-verification") {
                write_json_file(
                    &goal_dir.join("verification.json"),
                    &json!({
                        "command": "bun test",
                        "status": verification,
                        "timestamp": verified_at,
                        "output": if verification == "failed" {
                            "1 failing test: fixture verification failed\n"
                        } else {
                            "0 failing tests: fixture verification passed\n"
                        },
                    }),
                );
            }
            let _ = fs::create_dir_all(&goal_dir);
            if !self.arguments.contains("flow-silent-checkpoints") {
                let line = json!({
                    "id": format!("cp-{index}"),
                    "timestamp": verified_at,
                    "summary": format!("checkpoint {index} — fixture change"),
                    "files": if index > 1 { 3 } else { 2 },
                    "commit": commit,
                    "verification": verification,
                });
                append_json_line(&goal_dir.join("checkpoints.jsonl"), &line);
            }
            self.log(&format!("flow-checkpoint {index} {commit}"));
            self.stream(&format!("Committed checkpoint {index}"));
            if index < checkpoints {
                self.sleep_ms(step_delay);
            }
        }

        if self.arguments.contains("flow-blocked") {
            let message = "DEVBOARD-BLOCKED: the fixture cannot continue past this checkpoint";
            self.log("flow-blocked");
            self.stream(message);
            let _ = fs::create_dir_all(&goal_dir);
            append_json_line(
                &goal_dir.join("blockers.jsonl"),
                &json!({
                    "id": "blocker-fixture",
                    "timestamp": iso_now(),
                    "text": message.trim_start_matches("DEVBOARD-BLOCKED: "),
                }),
            );
        }

        for (index, text) in self
            .arguments
            .argument_all("flow-blocker-line")
            .iter()
            .enumerate()
        {
            if index > 0 {
                if let Some(path) = self.arguments.argument("flow-blocker-wait-file") {
                    let deadline = Instant::now() + Duration::from_secs(30);
                    while !Path::new(path).exists() && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(25));
                    }
                    self.log(&format!(
                        "flow-blocker-wait-done {}",
                        if Path::new(path).exists() {
                            "yes"
                        } else {
                            "timeout"
                        }
                    ));
                }
            }
            self.log(&format!("flow-blocker {} {text}", index + 1));
            self.stream(&format!("DEVBOARD-BLOCKED: {text}"));
        }
        Ok(())
    }

    fn run_flow_change(&self, directory: &str) -> std::result::Result<(), String> {
        self.log(&format!("flow-change {directory}"));
        self.stream("Classifying the changed files");
        let goal_dir = PathBuf::from(directory);
        let source =
            fs::read_to_string(goal_dir.join("request.json")).map_err(|error| error.to_string())?;
        let request: Value = serde_json::from_str(&source).map_err(|error| error.to_string())?;
        let files: Vec<String> = request
            .get("files")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|file| file.get("path").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        if self.arguments.contains("flow-analyst-fail") {
            let _ = fs::write(goal_dir.join("widgets.json"), "this is not widget json");
            self.log("flow-widgets-failed");
            return Ok(());
        }
        if self.arguments.contains("flow-analyst-empty") {
            write_json_file(&goal_dir.join("widgets.json"), &json!({ "widgets": [] }));
            self.log("flow-widgets 0");
            return Ok(());
        }
        let selected: Vec<&String> = if self.arguments.contains("flow-analyst-partial") {
            files.iter().take(1).collect()
        } else {
            files.iter().collect()
        };
        let mut widgets: Vec<Value> = Vec::new();
        if let Some(first) = selected.first() {
            widgets.push(json!({
                "category": "contract",
                "concept": "Application contract",
                "summary": "The application's observable contract changed.",
                "rationale": "Callers observe a different result.",
                "files": [first],
            }));
        }
        if selected.len() > 1 {
            let rest: Vec<&String> = selected[1..].to_vec();
            widgets.push(json!({
                "category": "data",
                "concept": "Stored configuration",
                "summary": "The stored configuration changed.",
                "rationale": "Persisted values have a new shape.",
                "files": rest,
            }));
        }
        if self.arguments.contains("flow-analyst-foreign") {
            widgets.push(json!({
                "category": "entity",
                "concept": "A file outside the diff",
                "summary": "This widget invents a file.",
                "rationale": "It must be rejected by the server's validation.",
                "files": ["src/not-in-the-diff.txt"],
            }));
        }
        write_json_file(
            &goal_dir.join("widgets.json"),
            &json!({ "widgets": widgets }),
        );
        self.log(&format!("flow-widgets {}", widgets.len()));
        Ok(())
    }

    fn run_flow_widget(&self, rest: &str) -> std::result::Result<(), String> {
        let mut parts = rest.split_whitespace();
        let first = parts.next().unwrap_or("");
        let second = parts.next().unwrap_or("");
        self.log(&format!("flow-widget {first} {second}"));
        self.stream("Reviewing the widget and its diff");
        self.probe_permission();
        self.ask_questions(1)?;
        self.stream("The widget conversation is read-only");
        Ok(())
    }

    /// Reads new steering notes and acknowledges each one before a checkpoint.
    fn consume_steering(&self, directory: &Path) {
        let notes = read_json_lines(&directory.join("steering.jsonl"));
        let acked: BTreeSet<String> = read_json_lines(&directory.join("steering-ack.jsonl"))
            .iter()
            .map(|entry| {
                entry
                    .get("id")
                    .filter(|value| !value.is_null())
                    .map(js_string)
                    .unwrap_or_default()
            })
            .collect();
        let fresh: Vec<&Value> = notes
            .iter()
            .filter(|note| {
                let id = note
                    .get("id")
                    .filter(|value| !value.is_null())
                    .map(js_string)
                    .unwrap_or_default();
                !acked.contains(&id)
            })
            .collect();
        for note in &fresh {
            let _ = fs::create_dir_all(directory);
            let mut ack = Map::new();
            if let Some(id) = note.get("id").filter(|value| !value.is_null()) {
                ack.insert("id".to_string(), id.clone());
            }
            append_line(
                &directory.join("steering-ack.jsonl"),
                &Value::Object(ack).to_string(),
            );
            let id = note
                .get("id")
                .filter(|value| !value.is_null())
                .map(js_string)
                .unwrap_or_default();
            self.log(&format!("flow-ack {id}"));
            let text = note
                .get("text")
                .filter(|value| !value.is_null())
                .map(js_string)
                .unwrap_or_default();
            append_line(&self.cwd.join("steering-applied.txt"), &text);
        }
        self.log(&format!("flow-steering-read {}", fresh.len()));
    }

    /// A mutating action behind an ACP permission request. A read-only client
    /// must answer cancelled; only an explicit allow selection writes.
    fn probe_permission(&self) {
        let Some(probe) = self.arguments.argument("permission-probe") else {
            return;
        };
        let response = self.request(
            "session/request_permission",
            json!({
                "sessionId": SESSION_ID,
                "toolCall": {
                    "toolCallId": "permission-probe",
                    "title": "Write the permission probe",
                    "kind": "edit",
                    "status": "pending",
                },
                "options": [
                    { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
                    { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                ],
            }),
        );
        let outcome_record = response.get("outcome").and_then(Value::as_object);
        let outcome = outcome_record
            .and_then(|record| record.get("outcome"))
            .and_then(Value::as_str)
            .unwrap_or("none");
        let option_id = outcome_record
            .and_then(|record| record.get("optionId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let suffix = if option_id.is_empty() {
            String::new()
        } else {
            format!(" {option_id}")
        };
        self.log(&format!("permission {outcome}{suffix}"));
        if outcome == "selected" && option_id == "allow" {
            let target = if Path::new(probe).is_absolute() {
                PathBuf::from(probe)
            } else {
                self.cwd.join(probe)
            };
            let _ = fs::write(target, "granted\n");
        }
    }

    /// Interviews the developer with the fixture's form schema.
    fn ask_questions(&self, count: u64) -> std::result::Result<(), String> {
        let has_default = !self.arguments.contains("questions-unrecommended");
        self.ask_questions_with(count, has_default)
    }

    fn ask_questions_with(&self, count: u64, has_default: bool) -> std::result::Result<(), String> {
        for index in 0..count {
            let title = if index == 0 {
                "Choose an answer".to_string()
            } else {
                format!("Choose an answer {}", index + 1)
            };
            let mut property = Map::new();
            property.insert("type".to_string(), json!("string"));
            property.insert("title".to_string(), json!(title));
            property.insert(
                "oneOf".to_string(),
                json!([
                    {
                        "const": "Alpha",
                        "title": "Alpha",
                        "description": "Alpha leads to the first outcome.",
                    },
                    {
                        "const": "Beta",
                        "title": "Beta",
                        "description": "Beta leads to the second outcome.",
                    },
                ]),
            );
            if has_default {
                property.insert("default".to_string(), json!("Alpha"));
            }
            let mut properties = Map::new();
            properties.insert("value".to_string(), Value::Object(property));
            let response = self.request(
                "elicitation/create",
                json!({
                    "mode": "form",
                    "sessionId": SESSION_ID,
                    "message": title,
                    "requestedSchema": {
                        "type": "object",
                        "properties": properties,
                        "required": ["value"],
                    },
                }),
            );
            let value = response
                .get("content")
                .and_then(Value::as_object)
                .and_then(|content| content.get("value"))
                .map(js_string)
                .unwrap_or_default();
            self.log(&format!("answer {value}"));
            self.stream(&format!("Answer received: {value}"));
        }
        Ok(())
    }

    /// The `/prepare-skills` turn: research noise, then the installed skills.
    fn run_prepare_skills(&self) -> std::result::Result<(), String> {
        self.stream("Researching public standards, architecture patterns, and testing practice");
        self.sleep_ms(self.number_argument("delay-ms"));
        let count = self
            .number_argument("questions")
            .map(|value| value.max(0.0) as u64)
            .unwrap_or(0);
        self.ask_questions(count)?;
        if self.arguments.contains("prepare-skills-error") {
            self.exit_stub(1);
        }
        self.write_prepared_skills();
        self.log("prepared");
        self.stream("Reviewed every installed skill; no contradictions");
        Ok(())
    }

    fn write_prepared_skills(&self) {
        if self.arguments.contains("prepare-skills-empty") {
            return;
        }
        self.write_skill(
            "dependency-direction",
            "Choose dependency direction and boundary ownership for any layered design.",
            "# Dependency direction\n\n- Always declare dependencies in one direction.\n- \
             Keep policy separate from delivery and storage concerns.\n",
            None,
        );
        self.write_skill(
            "cohesive-units",
            "Organize units of code so each owns one cohesive responsibility.",
            "# Cohesive units\n\n- Prefer small units with one responsibility.\n- \
             Keep each public interface narrow and explicit.\n",
            None,
        );
        self.write_skill(
            "behavior-first-testing",
            "Verify observable behavior with focused automated tests.",
            "# Behavior-first testing\n\n- Test observable behavior at the public boundary.\n- \
             Prefer focused tests that fail for one reason.\n",
            None,
        );

        if self.arguments.contains("prepare-skills-conflict") {
            self.write_skill(
                "dependency-direction",
                "Choose dependency direction and boundary ownership for any layered design.",
                "# Dependency direction\n\n- Always use dependency injection.\n- \
                 Keep policy separate from delivery and storage concerns.\n",
                None,
            );
        }
        if self.arguments.contains("prepare-skills-collision") {
            let name = self
                .arguments
                .argument("collision-name")
                .unwrap_or("custom-skill");
            self.write_skill(
                name,
                "A generated skill placed at an unmanaged skill's name.",
                "# Generated skill\n\n- Keep one writer for every installed skill.\n",
                None,
            );
        }
        if self.arguments.contains("prepare-skills-invalid") {
            self.write_skill(
                "invalid-skill",
                "",
                "# Invalid skill\n\n- Missing a description.\n",
                Some("name: Invalid Name\ndescription:"),
            );
        }

        // The peer crosses the write boundary: a file inside a hand-authored
        // skill, and a whole new skill directory without the managed marker.
        if self.arguments.contains("prepare-skills-unmanaged-write") {
            let directory = self.cwd.join(".omp/skills/house-style");
            let _ = fs::create_dir_all(&directory);
            let _ = fs::write(
                directory.join("extra.md"),
                "# Extra\n\n- Added by the preparation peer.\n",
            );
            self.log("unmanaged house-style/extra.md");
        }
        if self.arguments.contains("prepare-skills-unmanaged-skill") {
            let directory = self.cwd.join(".omp/skills/stray-style");
            let _ = fs::create_dir_all(&directory);
            let _ = fs::write(
                directory.join("SKILL.md"),
                "---\nname: stray-style\ndescription: A hand-authored skill the peer invented.\n\
                 ---\n\n# Stray style\n\n- Keep one writer.\n",
            );
            self.log("unmanaged stray-style/SKILL.md");
        }
    }

    fn write_skill(&self, name: &str, description: &str, body: &str, header: Option<&str>) {
        let directory = self.cwd.join(".omp/skills").join(name);
        let _ = fs::create_dir_all(&directory);
        let header = header
            .map(str::to_string)
            .unwrap_or_else(|| format!("name: {name}\ndescription: {description}"));
        let text =
            format!("---\n{header}\nmetadata:\n  devboard-managed: \"true\"\n---\n\n{body}\n");
        let _ = fs::write(directory.join("SKILL.md"), text);
        self.log(&format!("skill {name}"));
    }

    fn number_argument(&self, name: &str) -> Option<f64> {
        self.arguments
            .argument(name)
            .map(|value| value.parse::<f64>().unwrap_or(f64::NAN))
    }

    fn sleep_ms(&self, delay: Option<f64>) {
        if let Some(delay) = delay {
            if delay.is_finite() && delay > 0.0 {
                thread::sleep(Duration::from_millis(delay as u64));
            }
        }
    }

    /// Sleeps for the delay, streaming one assistant chunk every `--tick-ms`
    /// when the peer was given one. A test uses it to prove that a peer which
    /// keeps reporting progress is never treated as a stuck run.
    fn sleep_ms_with_progress(&self, delay: Option<f64>) {
        let Some(delay) = delay.filter(|delay| delay.is_finite() && *delay > 0.0) else {
            return;
        };
        let tick = self
            .number_argument("tick-ms")
            .filter(|tick| tick.is_finite() && *tick > 0.0);
        let Some(tick) = tick else {
            self.sleep_ms(Some(delay));
            return;
        };
        let tick = Duration::from_millis(tick as u64).max(Duration::from_millis(1));
        let mut remaining = Duration::from_millis(delay as u64);
        let mut sent = 0;
        while remaining > Duration::ZERO {
            let slice = remaining.min(tick);
            thread::sleep(slice);
            remaining -= slice;
            sent += 1;
            self.stream(&format!("Still releasing ({sent})"));
        }
    }

    /// One implementation lane: activity, optional interview, blocker, close.
    fn run_implementation_lane(&self, id: &str) -> std::result::Result<(), String> {
        let activity = self
            .arguments
            .id_options("lane-activity")
            .get(id)
            .cloned()
            .unwrap_or_else(|| format!("Working on epic {id}"));
        self.stream(&activity);

        let override_delay = self.arguments.id_options("lane-delay").get(id).cloned();
        let delay = match override_delay {
            Some(value) => value.parse::<f64>().unwrap_or(f64::NAN),
            None => {
                let lane_delay = self.number_argument("lane-delay-ms").unwrap_or(0.0);
                if lane_delay > 0.0 {
                    lane_delay
                } else {
                    self.number_argument("delay-ms").unwrap_or(0.0)
                }
            }
        };
        self.sleep_ms(Some(delay));

        let question_epics: BTreeSet<String> = self
            .arguments
            .argument_all("question-epic")
            .into_iter()
            .map(str::to_string)
            .collect();
        let question_count = if question_epics.contains(id) {
            1
        } else {
            self.number_argument("questions")
                .map(|value| value.max(0.0) as u64)
                .unwrap_or(0)
        };
        if question_count > 0 {
            self.ask_questions(question_count)?;
        }

        let blocker_epics: BTreeSet<String> = self
            .arguments
            .argument_all("blocker-epic")
            .into_iter()
            .map(str::to_string)
            .collect();
        if blocker_epics.contains(id) {
            self.log(&format!("blocked {id}"));
            self.stream(&format!("DEVBOARD-BLOCKED: fixture blocker for epic {id}"));
            return Ok(());
        }

        if self.arguments.contains("no-close") {
            return Ok(());
        }
        self.sleep_ms(self.number_argument("lane-settle-ms"));
        self.merge_fixture_lane(id);
        self.close_fixture_epic(id);
        Ok(())
    }

    /// The `/epic-next` turn: file the configured epics into the fixture list.
    fn run_generation_lane(&self) -> std::result::Result<(), String> {
        self.stream("Choosing the next epics");
        self.sleep_ms(self.number_argument("delay-ms"));
        for entry in self.arguments.argument_all("generate-epic") {
            if self.file_fixture_epic(entry) {
                let number = entry.split(':').next().unwrap_or("");
                self.stream(&format!("Filed epic {number}"));
            }
        }
        self.sleep_ms(self.number_argument("lane-settle-ms"));
        Ok(())
    }

    fn read_fixture_tracker(&self, path: &Path) -> Vec<Value> {
        let Ok(source) = fs::read_to_string(path) else {
            return Vec::new();
        };
        let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&source) else {
            return Vec::new();
        };
        entries
            .into_iter()
            .filter(|entry| entry.get("number").is_some_and(Value::is_number))
            .collect()
    }

    fn write_fixture_tracker(&self, path: &Path, list: &[Value]) {
        let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
        let Ok(text) = serde_json::to_string_pretty(&Value::Array(list.to_vec())) else {
            return;
        };
        let _ = fs::write(&temporary, format!("{text}\n"));
        let _ = fs::rename(&temporary, path);
    }

    fn close_fixture_epic(&self, id: &str) {
        let Some(tracker) = self.arguments.argument("fixture-tracker") else {
            return;
        };
        let tracker = PathBuf::from(tracker);
        let lock = PathBuf::from(format!("{}.lock", tracker.display()));
        with_lock(&lock, || {
            let list: Vec<Value> = self
                .read_fixture_tracker(&tracker)
                .into_iter()
                .filter(|epic| epic_number(epic).as_deref() != Some(id))
                .collect();
            self.write_fixture_tracker(&tracker, &list);
        });
        self.log(&format!("closed {id}"));
    }

    fn file_fixture_epic(&self, entry: &str) -> bool {
        let Some(tracker) = self.arguments.argument("fixture-tracker") else {
            return false;
        };
        let Some(split) = entry.find(':') else {
            return false;
        };
        let head = entry[..split].trim();
        let parsed = if head.is_empty() {
            0.0
        } else {
            head.parse::<f64>().unwrap_or(f64::NAN)
        };
        if !parsed.is_finite() || parsed.fract() != 0.0 {
            return false;
        }
        let number = parsed as i64;
        let title = &entry[split + 1..];
        let tracker = PathBuf::from(tracker);
        let counter = PathBuf::from(format!("{}.generation-count", tracker.display()));
        let budget = self
            .arguments
            .argument("generation-budget")
            .map(|value| value.parse::<f64>().unwrap_or(f64::NAN))
            .unwrap_or_else(|| self.arguments.argument_all("generate-epic").len() as f64);

        let lock = PathBuf::from(format!("{}.lock", tracker.display()));
        let mut filed = false;
        with_lock(&lock, || {
            let count = fs::read_to_string(&counter)
                .ok()
                .and_then(|text| text.trim().parse::<f64>().ok())
                .unwrap_or(0.0);
            if !budget.is_nan() && count >= budget {
                return;
            }
            let mut list = self.read_fixture_tracker(&tracker);
            if list
                .iter()
                .any(|epic| epic_number(epic).as_deref() == Some(&number.to_string()))
            {
                return;
            }
            list.push(json!({
                "number": number,
                "title": title,
                "url": format!("https://fixture.test/issues/{number}"),
            }));
            self.write_fixture_tracker(&tracker, &list);
            let _ = fs::write(&counter, format!("{}\n", count + 1.0));
            filed = true;
        });
        if filed {
            self.log(&format!("filed {number}"));
        }
        filed
    }

    /// Simulates the peer's own merge: branch, sentinel commit, merge, cleanup.
    fn merge_fixture_lane(&self, id: &str) {
        let Some(repo) = self.arguments.argument("fixture-repo") else {
            return;
        };
        let repo = PathBuf::from(repo);
        if is_harness_checkout(&repo) {
            self.log(&format!("merge-refused-harness-root {}", repo.display()));
            return;
        }
        let worktree = repo.join(".worktree").join(format!("stub-epic-{id}"));
        let branch = format!("devboard/stub-epic-{id}");
        let _ = fs::create_dir_all(repo.join(".worktree"));
        let worktree_text = worktree.to_string_lossy().to_string();
        git(
            &repo,
            &["worktree", "remove", "--force", worktree_text.as_str()],
        );
        git(&repo, &["branch", "-D", branch.as_str()]);
        let added = git(
            &repo,
            &[
                "worktree",
                "add",
                worktree_text.as_str(),
                "-b",
                branch.as_str(),
                "main",
            ],
        );
        if added.code != 0 {
            self.log(&format!(
                "merge-failed {id} worktree {}",
                added.stderr.trim()
            ));
            return;
        }
        let _ = fs::write(
            worktree.join(format!("epic-{id}.txt")),
            format!("epic {id}\n"),
        );
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", &format!("feat: epic {id}")]);

        let lock = repo.join(".git").join("stub-merge.lock");
        with_lock(&lock, || {
            for _ in 0..40 {
                let merged = git(
                    &repo,
                    &[
                        "merge",
                        "--no-ff",
                        branch.as_str(),
                        "-m",
                        &format!("merge epic {id}"),
                    ],
                );
                if merged.code == 0 {
                    self.log(&format!("merged {id}"));
                    let pushed = git(&repo, &["push", "origin", "main"]);
                    if pushed.code == 0 {
                        self.log(&format!("pushed {id}"));
                    } else {
                        self.log(&format!("push-failed {id}"));
                    }
                    return;
                }
                thread::sleep(Duration::from_millis(25));
            }
            self.log(&format!("merge-failed {id}"));
        });

        git(
            &repo,
            &["worktree", "remove", "--force", worktree_text.as_str()],
        );
        git(&repo, &["branch", "-D", branch.as_str()]);
    }

    /// One Discover agent's slice: the skill, the sheet, or the glossary and
    /// its sidecars.
    fn run_discover_agent(&self, agent: &str, staging: &str) -> std::result::Result<(), String> {
        self.stream(&format!("Reading the host for {agent}"));
        self.stream(&format!("Staging {agent}"));
        self.sleep_ms(self.number_argument("discover-delay-ms"));
        if self.arguments.contains("discover-question") {
            self.ask_questions(1)?;
        }
        let fail_agent = self.arguments.argument("discover-fail-agent");
        if self.arguments.contains("discover-error") || fail_agent == Some(agent) {
            self.stream(&format!("{agent} failed while reading manifests"));
            self.exit_stub(1);
        }

        let staging = self.staging_directory(staging)?;
        if agent == "sheet" {
            self.stage_json(&staging, "sheet.json", &self.discover_sheet())?;
        } else if agent == "discover-glossary" {
            let (yaml, concepts) = self.discover_glossary();
            self.stage_glossary(&staging, "orders", &yaml)?;
            let significance = self
                .arguments
                .argument("discover-significance")
                .unwrap_or("");
            if significance != "missing" {
                if significance == "invalid" || significance == "array" {
                    let directory = staging.join("glossary");
                    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
                    let bytes = if significance == "invalid" {
                        "{ not json"
                    } else {
                        "[]"
                    };
                    fs::write(directory.join("significance.json"), bytes)
                        .map_err(|error| error.to_string())?;
                } else {
                    let sidecar = discover_significance_sidecar(&concepts, significance);
                    self.stage_json(&staging, "glossary/significance.json", &sidecar)?;
                }
            }
            let skill = self.discover_skill_for("discover-glossary");
            if let Some(skill) = skill {
                self.stage_skill(&staging, &skill)?;
            }
        } else {
            let Some(skill) = self.discover_skill_for(agent) else {
                eprintln!("stub: unknown discover agent {agent}");
                self.exit_stub(2);
            };
            let invalid = self
                .arguments
                .argument("discover-contribution-invalid")
                .unwrap_or("");
            if agent == "discover-contribution" && invalid != "missing-file" {
                let document = self.contribution_doc();
                self.stage_json(&staging, "contribution.json", &document)?;
            }
            if !self.arguments.contains("discover-missing-artifact") {
                self.stage_skill(&staging, &skill)?;
            }
        }

        if self.arguments.contains("discover-extra-artifact") {
            fs::write(staging.join("notes.txt"), "Extra staged note.\n")
                .map_err(|error| error.to_string())?;
        }
        if self.arguments.contains("discover-write-outside") {
            let note = self.cwd.join(".omp/discover/staging-note.txt");
            if let Some(parent) = note.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&note, "Written outside staging by the stub.\n");
            let _ = fs::write(
                self.cwd.join("GOAL.md"),
                "# Discover stub goal\n\nThe stub wrote outside staging.\n",
            );
            let _ = fs::remove_file(&note);
        }
        if self.arguments.contains("discover-no-exit") {
            let delay = self.number_argument("delay-ms").unwrap_or(0.0);
            thread::sleep(Duration::from_millis(if delay > 0.0 {
                delay as u64
            } else {
                60_000
            }));
        }
        Ok(())
    }

    /// Resolves a staging directory the way the staging tools do: under the
    /// repository's `.omp/discover/staging` root.
    fn staging_directory(&self, value: &str) -> std::result::Result<PathBuf, String> {
        let root = normalize_path(&self.cwd.join(".omp/discover/staging"));
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let candidate = if Path::new(value).is_absolute() {
            normalize_path(Path::new(value))
        } else {
            normalize_path(&root.join(value))
        };
        if !candidate.starts_with(&root) {
            return Err(format!("stagingDir {value} is outside the staging root."));
        }
        fs::create_dir_all(&candidate).map_err(|error| error.to_string())?;
        Ok(candidate)
    }

    fn stage_json(
        &self,
        staging: &Path,
        relative: &str,
        value: &Value,
    ) -> std::result::Result<(), String> {
        let path = staging.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
        fs::write(&path, format!("{text}\n")).map_err(|error| error.to_string())
    }

    fn stage_glossary(
        &self,
        staging: &Path,
        context: &str,
        yaml: &str,
    ) -> std::result::Result<(), String> {
        let path = staging
            .join("glossary")
            .join(format!("{context}.glossary.yaml"));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let text = if yaml.ends_with('\n') {
            yaml.to_string()
        } else {
            format!("{yaml}\n")
        };
        fs::write(path, text).map_err(|error| error.to_string())
    }

    fn stage_skill(
        &self,
        staging: &Path,
        skill: &DiscoverSkill,
    ) -> std::result::Result<(), String> {
        let body = if skill.body[0].starts_with("# ") {
            skill.body.join("\n")
        } else {
            format!("# {}\n\n{}", skill.title, skill.body.join("\n"))
        };
        let skill_name = skill.name.trim_start_matches("discover-");
        let description =
            serde_json::to_string(skill.description.trim()).map_err(|error| error.to_string())?;
        let text = [
            "---",
            &format!("name: {}", skill.name),
            &format!("description: {description}"),
            "metadata:",
            "  devboard-managed: \"true\"",
            "  devboard-family: \"discover\"",
            &format!("  devboard-skill: {skill_name}"),
            "---",
            "",
            body.trim_end(),
            "",
        ]
        .join("\n");
        let path = staging.join("skills").join(skill.name).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(path, text).map_err(|error| error.to_string())
    }

    fn discover_evidence(&self) -> EvidencePaths {
        discover_evidence_paths(&self.cwd)
    }

    fn discover_sheet(&self) -> Value {
        let paths = self.discover_evidence();
        let evidence = vec![paths.primary.clone()];
        let prose = self.arguments.argument("discover-prose").unwrap_or(
            "A fixture host with a small order domain used to verify the Discover crawl",
        );
        let definition = if self.arguments.contains("discover-sheet-two-sentences") {
            "First sentence describes the fixture project. Second sentence describes the crawl."
                .to_string()
        } else {
            discover_one_sentence(prose, 240)
        };
        let stack_value = if self.arguments.contains("discover-versioned-names") {
            json!(["Bun 1.2.3", "TypeScript 5.6.2"])
        } else {
            json!(["Bun", "TypeScript"])
        };
        let mut stack = leaf(
            stack_value,
            vec![paths.manifest.clone()],
            if paths.has_manifest {
                "declared"
            } else {
                "inferred"
            },
        );
        let mut deployment = json!({
            "class": leaf(
                json!(if paths.has_manifest { "package" } else { "none" }),
                vec![paths.manifest.clone()],
                "observed",
            ),
            "artifact": leaf(json!("fixture-host"), vec![paths.manifest.clone()], "declared"),
            "target": unknown("No publication target was found in the crawled files."),
            "pipelineSources": match &paths.ci {
                Some(ci) => leaf(json!([ci]), vec![ci.clone()], "observed"),
                None => unknown("No CI configuration was found in the crawled files."),
            },
        });

        let commands = json!({
            "install": if paths.has_manifest {
                leaf(json!("bun install"), vec![paths.manifest.clone()], "declared")
            } else {
                unknown("No install command was found in the crawled files.")
            },
            "build": if paths.has_manifest {
                leaf(json!("bun run build"), vec![paths.manifest.clone()], "declared")
            } else {
                unknown("No build command was found in the crawled files.")
            },
            "test": if paths.has_manifest {
                leaf(json!("bun test"), vec![paths.manifest.clone()], "declared")
            } else {
                unknown("No test command was found in the crawled files.")
            },
            "lint": unknown("No lint command was found in the crawled files."),
            "typecheck": unknown("No typecheck command was found in the crawled files."),
            "dev": if paths.has_manifest {
                leaf(json!("bun run dev"), vec![paths.manifest.clone()], "declared")
            } else {
                unknown("No dev command was found in the crawled files.")
            },
            "tryOut": unknown("No try-out command was found in the crawled files."),
            "release": unknown("No release command was found in the crawled files."),
        });

        let level = if self.arguments.contains("discover-sheet-no-happy-path") {
            json!({
                "level": "unit",
                "tests": "1",
                "paths": [paths.tests.clone()],
                "command": "npm test",
                "fixtures": [],
            })
        } else {
            json!({
                "level": "unit",
                "tests": "1",
                "happyPath": if self.arguments.contains("discover-sheet-happy-overflow") { "2" } else { "1" },
                "paths": [paths.tests.clone()],
                "command": "npm run test:unit",
                "fixtures": [],
            })
        };

        let architecture = if paths.has_source {
            json!({
                "contexts": leaf(
                    json!([
                        {
                            "name": "Checkout",
                            "path": "src/checkout",
                            "responsibility": "Turns a cart into a placed order.",
                            "entryPoints": ["src/checkout/flow.ts"],
                        },
                        {
                            "name": "Orders",
                            "path": "src",
                            "responsibility": "Owns order records and order totals.",
                            "entryPoints": ["src"],
                        },
                    ]),
                    vec!["src".to_string()],
                    "observed",
                ),
                "dependencies": leaf(
                    json!([{ "from": "Checkout", "to": "Orders" }]),
                    vec!["src".to_string()],
                    "observed",
                ),
                "dependencyDirection": leaf(
                    json!("Dependencies point inward toward the Orders domain code."),
                    vec!["src".to_string()],
                    "inferred",
                ),
                "externalBoundaries": leaf(
                    json!(["PostgreSQL", "api.stripe.com"]),
                    vec!["src".to_string()],
                    "observed",
                ),
                "sharedKernels": leaf(
                    json!(["src/shared"]),
                    vec!["src".to_string()],
                    "observed",
                ),
            })
        } else {
            let reason = "No source directory was found in the crawled files.";
            json!({
                "contexts": unknown(reason),
                "dependencies": unknown(reason),
                "dependencyDirection": unknown(reason),
                "externalBoundaries": unknown(reason),
                "sharedKernels": unknown(reason),
            })
        };

        let ci = match &paths.ci {
            Some(ci) => json!({
                "provider": leaf(json!("GitHub Actions"), vec![ci.clone()], "observed"),
                "triggers": leaf(json!(["push"]), vec![ci.clone()], "observed"),
                "jobs": leaf(json!(["test"]), vec![ci.clone()], "observed"),
                "qualityGates": leaf(
                    json!([{ "name": "bun test", "checks": "Runs the whole fixture test suite in CI." }]),
                    vec![ci.clone()],
                    "declared",
                ),
                "artifacts": leaf(json!([]), vec![ci.clone()], "observed"),
            }),
            None => json!({
                "provider": leaf(json!("none detected"), evidence.clone(), "observed"),
                "triggers": leaf(json!([]), evidence.clone(), "observed"),
                "jobs": leaf(json!([]), evidence.clone(), "observed"),
                "qualityGates": leaf(json!([]), evidence.clone(), "observed"),
                "artifacts": leaf(json!([]), evidence.clone(), "observed"),
            }),
        };

        let runtime = json!({
            "languages": leaf(
                json!([if self.arguments.contains("discover-versioned-names") { "TypeScript 5.6.2" } else { "TypeScript" }]),
                vec![paths.manifest.clone()],
                "declared",
            ),
            "runtimes": leaf(
                json!([if self.arguments.contains("discover-versioned-names") { "Bun 1.2.3" } else { "Bun" }]),
                vec![paths.manifest.clone()],
                "declared",
            ),
            "packageManagers": leaf(json!(["bun"]), vec![paths.manifest.clone()], "declared"),
            "versions": leaf(json!([]), vec![paths.manifest.clone()], "observed"),
            "manifests": if paths.has_manifest {
                leaf(json!(["package.json"]), vec![paths.manifest.clone()], "observed")
            } else {
                unknown("No manifest was found in the crawled files.")
            },
        });

        let routes = if self.arguments.contains("discover-sheet-routes") {
            json!(["/api/orders", "/", "GET /api/orders/:id"])
        } else {
            json!([])
        };
        let dependency_map = json!({
            "binaries": leaf(json!([]), vec![paths.manifest.clone()], "observed"),
            "packages": leaf(json!([]), vec![paths.manifest.clone()], "observed"),
            "routes": leaf(routes, vec![paths.manifest.clone()], "observed"),
            "jobs": leaf(json!([]), vec![paths.manifest.clone()], "observed"),
            "externalServices": leaf(json!([]), vec![paths.manifest.clone()], "observed"),
            "dataStores": leaf(json!([]), vec![paths.manifest.clone()], "observed"),
            "keyDependencies": leaf(json!([]), vec![paths.manifest.clone()], "declared"),
        });

        let delivery = json!({
            "artifactTarget": leaf(json!("package"), vec![paths.manifest.clone()], "declared"),
            "releaseChannels": leaf(json!([]), vec![paths.manifest.clone()], "declared"),
            "versionScheme": unknown("No versioning scheme was found in the crawled files."),
            "migrationPolicy": unknown("No migration policy was found in the crawled files."),
        });

        if self.arguments.contains("discover-invalid-sheet") {
            if let Some(stack) = stack.as_object_mut() {
                stack.insert("value".to_string(), json!(["x".repeat(200)]));
            }
        }
        if self.arguments.contains("discover-sheet-absolute") {
            if let Some(stack) = stack.as_object_mut() {
                stack.insert("evidence".to_string(), json!(["/etc/passwd"]));
            }
        }
        if self.arguments.contains("discover-sheet-stripped-home") {
            if let Some(stack) = stack.as_object_mut() {
                stack.insert("evidence".to_string(), json!(["home/ds/project/file.ts"]));
            }
        }
        if self.arguments.contains("discover-sheet-no-evidence") {
            if let Some(stack) = stack.as_object_mut() {
                stack.insert("evidence".to_string(), json!([]));
            }
        }
        if self.arguments.contains("discover-sheet-secret") {
            if let Some(artifact) = deployment
                .get_mut("artifact")
                .and_then(Value::as_object_mut)
            {
                artifact.insert("value".to_string(), json!(DISCOVER_SECRET));
            }
        }

        json!({
            "schemaVersion": 1,
            "definition": leaf(json!(definition), evidence.clone(), "declared"),
            "stack": stack,
            "deployment": deployment,
            "environments": leaf(
                json!([{ "name": "production", "purpose": "Changes reach production through a direct push." }]),
                evidence.clone(),
                "inferred",
            ),
            "commands": commands,
            "branching": {
                "defaultBranch": leaf(json!("main"), vec!["git branch".to_string()], "observed"),
                "mergeMethod": leaf(json!("merge commit"), vec!["git log".to_string()], "inferred"),
                "releaseBranches": leaf(json!([]), vec!["git branch".to_string()], "observed"),
                "model": leaf(json!("pull-request"), vec!["git log".to_string()], "inferred"),
            },
            "testing": {
                "levels": if paths.has_tests {
                    leaf(json!([level]), vec![paths.tests.clone()], "observed")
                } else {
                    unknown("No test files were found in the crawled files.")
                },
                "pyramid": if paths.has_tests {
                    leaf(
                        json!("Unit tests are the only observed level."),
                        vec![paths.tests.clone()],
                        "inferred",
                    )
                } else {
                    unknown("No test files were found in the crawled files.")
                },
            },
            "architecture": architecture,
            "ci": ci,
            "runtime": runtime,
            "dependencyMap": dependency_map,
            "delivery": delivery,
        })
    }

    fn discover_glossary(&self) -> (String, Vec<GlossaryConcept>) {
        let paths = self.discover_evidence();
        let available = if paths.available.is_empty() {
            vec![".".to_string()]
        } else {
            paths.available.clone()
        };
        let first = available[0].clone();
        let second = available.get(1).cloned().unwrap_or_else(|| first.clone());
        let first_grounding = format!("code:{first}");
        let second_grounding = format!("code:{second}");
        let prose = self.arguments.argument("discover-prose").unwrap_or(
            "A fixture host with a small order domain used to verify the Discover crawl",
        );
        let seed = discover_one_sentence(prose, 152);
        let seed = seed.trim_end_matches('.');
        let label = |language: &'static str, text: String| GlossaryLabel { language, text };

        let order = GlossaryConcept {
            id: "order".to_string(),
            pref_labels: vec![label("en", "Order".to_string())],
            alt_labels: Vec::new(),
            hidden_labels: Vec::new(),
            definitions: vec![label(
                "en",
                discover_one_sentence(&format!("{seed} names one customer order request"), 160),
            )],
            status: "unconfirmed",
            origin: "owner",
            kind: "entity",
            grounding: vec![if self.arguments.contains("discover-glossary-home-path") {
                "code:app/home/page.tsx".to_string()
            } else {
                first_grounding.clone()
            }],
            related: Vec::new(),
        };
        let order_total = GlossaryConcept {
            id: if self.arguments.contains("discover-glossary-invalid") {
                "order".to_string()
            } else {
                "order-total".to_string()
            },
            pref_labels: vec![label("en", "Order Total".to_string())],
            alt_labels: Vec::new(),
            hidden_labels: Vec::new(),
            definitions: vec![label(
                "en",
                discover_one_sentence(&format!("{seed} sums the lines of one order"), 160),
            )],
            status: "proposed",
            origin: "llm",
            kind: "value",
            grounding: vec![if self.arguments.contains("discover-glossary-grounding") {
                "code:src/does-not-exist.ts".to_string()
            } else {
                second_grounding.clone()
            }],
            related: Vec::new(),
        };
        let option = GlossaryConcept {
            id: "option".to_string(),
            pref_labels: vec![label("en", "Option".to_string())],
            alt_labels: Vec::new(),
            hidden_labels: Vec::new(),
            definitions: vec![label(
                "en",
                discover_one_sentence(&format!("{seed} names an entry of a choice list"), 160),
            )],
            status: "unconfirmed",
            origin: "owner",
            kind: "entity",
            grounding: vec![second_grounding.clone()],
            related: Vec::new(),
        };
        let concepts = if self.arguments.contains("discover-glossary-drop") {
            vec![order]
        } else {
            vec![order, option, order_total]
        };

        let mut lines = vec![
            "boundedContext: orders".to_string(),
            "titles:".to_string(),
            "  - language: en".to_string(),
            format!("    text: {}", json!("Orders")),
            "concepts:".to_string(),
        ];
        for concept in &concepts {
            lines.extend(glossary_concept_lines(concept));
        }
        (format!("{}\n", lines.join("\n")), concepts)
    }

    fn discover_skill_for(&self, agent: &str) -> Option<DiscoverSkill> {
        if agent == "discover-contribution" {
            let no_forge = self.arguments.contains("discover-contribution-no-forge");
            let invalid = self
                .arguments
                .argument("discover-contribution-invalid")
                .unwrap_or("");
            return Some(contribution_skill(no_forge, invalid));
        }
        discover_skills()
            .into_iter()
            .find(|skill| skill.name == agent)
    }

    fn contribution_doc(&self) -> Value {
        let no_forge = self.arguments.contains("discover-contribution-no-forge");
        let invalid = self
            .arguments
            .argument("discover-contribution-invalid")
            .unwrap_or("");
        let source = contribution_source(no_forge, invalid);
        let install_fact = match invalid {
            "no-value" => json!({
                "key": "install",
                "evidence": ["package.json"],
                "confidence": "declared",
            }),
            "unknown-value" => json!({
                "key": "install",
                "value": "bun install",
                "evidence": [],
                "confidence": "unknown",
                "reason": "No command was found.",
            }),
            "absolute" => json!({
                "key": "install",
                "value": "/home/operator/bin/install",
                "evidence": ["package.json"],
                "confidence": "declared",
            }),
            _ => json!({
                "key": "install",
                "value": "bun install",
                "evidence": ["package.json"],
                "confidence": "declared",
            }),
        };
        json!({
            "schemaVersion": 1,
            "source": source,
            "workflow": [
                {
                    "key": "entryPoints",
                    "value": ["CONTRIBUTING.md", ".github/pull_request_template.md"],
                    "evidence": ["README.md"],
                    "confidence": "declared",
                },
                {
                    "key": "steps",
                    "value": [
                        "Fork the repository and create a feature branch.",
                        "Run the whole test suite before requesting review.",
                        "Open a pull request that links the issue it closes.",
                    ],
                    "evidence": ["CONTRIBUTING.md"],
                    "confidence": "declared",
                },
                {
                    "key": "prerequisites",
                    "value": ["Bun"],
                    "evidence": ["package.json"],
                    "confidence": "declared",
                },
                install_fact,
                {
                    "key": "build",
                    "value": "bun run build",
                    "evidence": ["package.json"],
                    "confidence": "declared",
                },
                {
                    "key": "lint",
                    "value": "bun run lint",
                    "evidence": ["package.json"],
                    "confidence": "declared",
                },
                {
                    "key": "typecheck",
                    "value": "bunx tsc --noEmit",
                    "evidence": ["package.json"],
                    "confidence": "declared",
                },
                {
                    "key": "run",
                    "value": "bun run start",
                    "evidence": ["package.json"],
                    "confidence": "declared",
                },
            ],
            "testing": [
                {
                    "key": "suite",
                    "value": "bun test",
                    "evidence": ["package.json"],
                    "confidence": "declared",
                },
                {
                    "key": "levels",
                    "value": [
                        {
                            "level": "unit",
                            "command": "bun test",
                            "paths": ["test"],
                            "fixtures": [],
                        },
                    ],
                    "evidence": ["test/order.test.ts"],
                    "confidence": "observed",
                },
            ],
        })
    }
}

/// Extracts the first prompt text block.
fn prompt_text(params: &Value) -> Option<String> {
    let blocks = params.get("prompt")?.as_array()?;
    blocks.iter().find_map(|block| {
        block
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

/// The first whitespace-delimited token ending in `.md`, as the fixture's
/// record regex finds it.
fn record_file(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|token| token.ends_with(".md"))
        .map(str::to_string)
}

fn path_basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// JavaScript's `String(value)` for a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn write_text(path: &Path, text: &str) -> std::result::Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = fs::create_dir_all(parent);
        }
    }
    fs::write(path, text).map_err(|error| error.to_string())
}

/// The status field of a record's leading YAML frontmatter block, if it has one.
fn frontmatter_status(source: &str) -> Option<String> {
    status_line(source).map(|(_, _, status)| status)
}

/// The byte range and value of the frontmatter `status:` line.
fn status_line(source: &str) -> Option<(usize, usize, String)> {
    let mut offset = 0;
    let mut lines = source.split_inclusive('\n');
    let first = lines.next()?;
    let first_text = first.trim_end_matches(['\r', '\n']);
    if first_text != "---" {
        return None;
    }
    offset += first.len();
    let block_start = offset;
    for line in lines {
        let text = line.trim_end_matches(['\r', '\n']);
        if text == "---" {
            let block = &source[block_start..offset];
            let (line_start, line_end, value) = status_in_block(block)?;
            return Some((block_start + line_start, block_start + line_end, value));
        }
        offset += line.len();
    }
    None
}

fn status_in_block(block: &str) -> Option<(usize, usize, String)> {
    let mut offset = 0;
    for line in block.split_inclusive('\n') {
        let text = line.trim_end_matches(['\r', '\n']);
        if let Some(rest) = text.strip_prefix("status:") {
            let value = rest.trim();
            if !value.is_empty() && value.chars().all(|c| c.is_ascii_lowercase()) {
                let start = offset;
                let end = offset + text.len();
                return Some((start, end, value.to_string()));
            }
        }
        offset += line.len();
    }
    None
}

fn is_pending_status(status: &str) -> bool {
    status == "draft" || status == "proposed"
}

/// Counts pending `.md` records in one directory.
fn pending_count(directory: &Path) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".md"))
        .filter(|entry| {
            fs::read_to_string(entry.path())
                .ok()
                .and_then(|source| frontmatter_status(&source))
                .is_some_and(|status| is_pending_status(&status))
        })
        .count()
}

/// Rewrites the status field inside the frontmatter, leaving the rest of the
/// file untouched.
fn mark_accepted(file: &str) -> std::result::Result<(), String> {
    let source = fs::read_to_string(file).map_err(|error| error.to_string())?;
    let Some((start, end, _)) = status_line(&source) else {
        return Ok(());
    };
    let mut updated = String::with_capacity(source.len());
    updated.push_str(&source[..start]);
    updated.push_str("status: accepted");
    updated.push_str(&source[end..]);
    fs::write(file, updated).map_err(|error| error.to_string())
}

/// The implementation epic a lane prompt names, or the single open epic.
fn implementation_epic(text: &str, tracker: Option<&str>) -> Option<String> {
    let rest = text.strip_prefix("/implement-next-epic")?;
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if !digits.is_empty() {
        return Some(digits);
    }
    let tracker = tracker?;
    let source = fs::read_to_string(tracker).ok()?;
    let parsed: Value = serde_json::from_str(&source).ok()?;
    let list = parsed.as_array()?;
    if list.len() == 1 {
        epic_number(&list[0])
    } else {
        None
    }
}

fn epic_number(epic: &Value) -> Option<String> {
    match epic.get("number")? {
        Value::Number(number) => Some(
            number
                .as_i64()
                .map(|value| value.to_string())
                .unwrap_or_else(|| number.to_string()),
        ),
        _ => None,
    }
}

struct GitOutput {
    code: i32,
    stderr: String,
}

fn git(repo: &Path, args: &[&str]) -> GitOutput {
    let output = Command::new("git").arg("-C").arg(repo).args(args).output();
    match output {
        Ok(output) => GitOutput {
            code: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(_) => GitOutput {
            code: -1,
            stderr: String::new(),
        },
    }
}

/// True when `repo` resolves to the harness's own source checkout.
/// True when `repo` is the canonical Devboard source checkout. The stub never
/// runs `git add -A` or a merge there; it would rewrite the harness itself.
pub fn is_harness_checkout(repo: &Path) -> bool {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--show-toplevel"])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let top = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if top.is_empty() {
        return false;
    }
    let prefix = Path::new(&top).join(".devboard");
    prefix.join("Cargo.toml").is_file() && prefix.join("crates/devboard/src").is_dir()
}

struct FlowGitOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// One fixture git command with the identity flags the Flow fixture needs.
fn flow_git(repo: &Path, args: &[&str]) -> FlowGitOutput {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["-c", "user.name=Flow Stub"])
        .args(["-c", "user.email=stub@example.test"])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .output();
    match output {
        Ok(output) => FlowGitOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(_) => FlowGitOutput {
            code: -1,
            stdout: String::new(),
            stderr: String::new(),
        },
    }
}

/// The current UTC time in JavaScript's `toISOString` shape.
fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        remainder / 3600,
        (remainder % 3600) / 60,
        remainder % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (year + i64::from(month <= 2), month, day)
}

/// Writes pretty JSON with the fixture's trailing newline.
fn write_json_file(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(value) {
        let _ = fs::write(path, format!("{text}\n"));
    }
}

/// Appends one compact JSON line.
fn append_json_line(path: &Path, value: &Value) {
    if let Ok(text) = serde_json::to_string(value) {
        append_line(path, &text);
    }
}

/// Appends one text line, creating the file when needed.
fn append_line(path: &Path, text: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{text}");
    }
}

/// JSON lines of a Flow session file, tolerant of an absent or partial file.
fn read_json_lines(path: &Path) -> Vec<Value> {
    let Ok(source) = fs::read_to_string(path) else {
        return Vec::new();
    };
    source
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(Value::is_object)
        .collect()
}

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// The lowercase hexadecimal SHA-256 digest the provider log fingerprints use.
fn sha256_hex(value: &str) -> String {
    let mut message = value.as_bytes().to_vec();
    let bit_length = (message.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());

    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for chunk in message.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                chunk[index * 4],
                chunk[index * 4 + 1],
                chunk[index * 4 + 2],
                chunk[index * 4 + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choose = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(choose)
                .wrapping_add(SHA256_K[index])
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

/// Serializes the stub's own tracker and merge writes across lane processes.
fn with_lock<T>(lock_path: &Path, action: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    loop {
        match fs::create_dir(lock_path) {
            Ok(()) => break,
            Err(_) => {
                if started.elapsed() > Duration::from_secs(10) {
                    let _ = fs::remove_dir_all(lock_path);
                    continue;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
    let outcome = action();
    let _ = fs::remove_dir_all(lock_path);
    outcome
}

/// Lexically normalizes a path without touching the filesystem.
fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

struct EvidencePaths {
    available: Vec<String>,
    primary: String,
    manifest: String,
    tests: String,
    ci: Option<String>,
    has_manifest: bool,
    has_tests: bool,
    has_source: bool,
}

const DISCOVER_EVIDENCE_CANDIDATES: [&str; 5] = [
    "README.md",
    "package.json",
    "src",
    "test",
    ".github/workflows",
];

/// Existing repo-relative evidence paths, in candidate order, plus a safe
/// fallback.
fn discover_evidence_paths(cwd: &Path) -> EvidencePaths {
    let available: Vec<String> = DISCOVER_EVIDENCE_CANDIDATES
        .iter()
        .filter(|path| cwd.join(path).exists())
        .map(|path| path.to_string())
        .collect();
    let fallback = if available.is_empty() {
        vec![".".to_string()]
    } else {
        available.clone()
    };
    let first = fallback[0].clone();
    let has_manifest = cwd.join("package.json").exists();
    let has_source = cwd.join("src").exists();
    let has_tests = cwd.join("test").exists();
    EvidencePaths {
        available,
        primary: first.clone(),
        manifest: if has_manifest {
            "package.json".to_string()
        } else {
            first.clone()
        },
        tests: if has_tests { "test".to_string() } else { first },
        ci: cwd
            .join(".github/workflows")
            .exists()
            .then(|| ".github/workflows".to_string()),
        has_manifest,
        has_tests,
        has_source,
    }
}

fn leaf(value: Value, evidence: Vec<String>, confidence: &str) -> Value {
    let unique: BTreeSet<String> = evidence.into_iter().collect();
    json!({
        "value": value,
        "evidence": unique.into_iter().collect::<Vec<String>>(),
        "confidence": confidence,
    })
}

fn unknown(reason: &str) -> Value {
    json!({
        "value": null,
        "evidence": [],
        "confidence": "unknown",
        "reason": reason,
    })
}

/// One-line, one-sentence bounded prose no longer than `limit` characters.
fn discover_one_sentence(text: &str, limit: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<&str>>().join(" ");
    let mut flat = collapsed.trim_end_matches(['.', '!', '?']).to_string();
    let mut cleaned = String::with_capacity(flat.len());
    let mut chars = flat.chars().peekable();
    while let Some(character) = chars.next() {
        if matches!(character, '.' | '!' | '?')
            && chars.peek().is_some_and(|next| next.is_whitespace())
        {
            cleaned.push(' ');
            while chars.peek().is_some_and(|next| next.is_whitespace()) {
                chars.next();
            }
            continue;
        }
        cleaned.push(character);
    }
    flat = cleaned;
    let length = flat.chars().count();
    if length > limit.saturating_sub(1) {
        let truncated: String = flat.chars().take(limit.saturating_sub(1)).collect();
        format!("{}.", truncated.trim_end())
    } else {
        format!("{flat}.")
    }
}

struct GlossaryLabel {
    language: &'static str,
    text: String,
}

struct HiddenLabel {
    language: &'static str,
    text: String,
    reason: String,
    rejected_on: String,
}

struct GlossaryConcept {
    id: String,
    pref_labels: Vec<GlossaryLabel>,
    alt_labels: Vec<GlossaryLabel>,
    hidden_labels: Vec<HiddenLabel>,
    definitions: Vec<GlossaryLabel>,
    status: &'static str,
    origin: &'static str,
    kind: &'static str,
    grounding: Vec<String>,
    related: Vec<String>,
}

fn glossary_label_lines(field: &str, labels: &[GlossaryLabel]) -> Vec<String> {
    if labels.is_empty() {
        return vec![format!("    {field}: []")];
    }
    let mut lines = vec![format!("    {field}:")];
    for label in labels {
        lines.push(format!("      - language: {}", label.language));
        lines.push(format!("        text: {}", json!(label.text)));
    }
    lines
}

fn glossary_concept_lines(concept: &GlossaryConcept) -> Vec<String> {
    let mut lines = vec![format!("  - id: {}", concept.id)];
    lines.extend(glossary_label_lines("prefLabels", &concept.pref_labels));
    lines.extend(glossary_label_lines("altLabels", &concept.alt_labels));
    if concept.hidden_labels.is_empty() {
        lines.push("    hiddenLabels: []".to_string());
    } else {
        lines.push("    hiddenLabels:".to_string());
        for label in &concept.hidden_labels {
            lines.push(format!("      - language: {}", label.language));
            lines.push(format!("        text: {}", json!(label.text)));
            lines.push(format!("        reason: {}", json!(label.reason)));
            lines.push(format!("        rejectedOn: {}", json!(label.rejected_on)));
        }
    }
    lines.extend(glossary_label_lines("definitions", &concept.definitions));
    lines.push("    scopeNote: null".to_string());
    lines.push("    example: null".to_string());
    lines.push("    historyNote: null".to_string());
    lines.push(format!("    status: {}", concept.status));
    lines.push(format!("    origin: {}", concept.origin));
    lines.push("    standardRef: null".to_string());
    lines.push(format!("    kind: {}", concept.kind));
    lines.push("    grounding:".to_string());
    for entry in &concept.grounding {
        lines.push(format!("      - {}", json!(entry)));
    }
    lines.push("    broader: null".to_string());
    lines.push(format!("    related: {}", json!(concept.related)));
    lines
}

/// Scores the fixture concepts; the generic `option` scores lowest on purpose.
fn significance_score(id: &str) -> Value {
    match id {
        "order" => json!({
            "score": 80,
            "reason": "Every fixture checkout creates one order record.",
        }),
        "option" => json!({
            "score": 10,
            "reason": "A framework option token, not a domain term.",
        }),
        "order-total" => json!({
            "score": 90,
            "reason": "The order total is the domain's central summed value.",
        }),
        _ => json!({
            "score": 50,
            "reason": "Observed in the fixture host.",
        }),
    }
}

fn discover_significance_sidecar(concepts: &[GlossaryConcept], defect: &str) -> Value {
    let mut ids: Vec<String> = Vec::new();
    for concept in concepts {
        if !ids.contains(&concept.id) {
            ids.push(concept.id.clone());
        }
    }
    let mut entries = Map::new();
    for id in &ids {
        entries.insert(id.clone(), significance_score(id));
    }
    let first = ids.first().cloned();
    let second = ids.get(1).cloned().or_else(|| first.clone());
    match defect {
        "unknown-concept" => {
            if let Some(id) = &second {
                entries.remove(id);
            }
        }
        "extra-concept" => {
            if first.is_some() {
                entries.insert(
                    "ghost-term".to_string(),
                    json!({ "score": 50, "reason": "A concept that is not staged." }),
                );
            }
        }
        "score" => {
            entries.insert(
                "option".to_string(),
                json!({ "score": 101, "reason": "Out of range." }),
            );
        }
        "reason-empty" => {
            entries.insert("option".to_string(), json!({ "score": 10, "reason": "  " }));
        }
        "reason-multiline" => {
            entries.insert(
                "option".to_string(),
                json!({ "score": 10, "reason": "One line.\nA second line." }),
            );
        }
        "reason-absolute" => {
            entries.insert(
                "option".to_string(),
                json!({ "score": 10, "reason": "/home/operator/secret.ts defines it." }),
            );
        }
        "reason-secret" => {
            entries.insert(
                "option".to_string(),
                json!({ "score": 10, "reason": format!("Pinned by {DISCOVER_SECRET}") }),
            );
        }
        _ => {}
    }
    let mut contexts = Map::new();
    contexts.insert("orders".to_string(), Value::Object(entries));
    match defect {
        "unknown-context" => {
            contexts.insert(
                "other-context".to_string(),
                json!({ "another-term": { "score": 50, "reason": "Not a staged context." } }),
            );
        }
        "extra-key" => {
            return json!({ "schemaVersion": 1, "contexts": contexts, "note": "extra" });
        }
        "schema" => {
            return json!({ "schemaVersion": 2, "contexts": contexts });
        }
        "score-object" => {
            return json!({
                "schemaVersion": 1,
                "contexts": {
                    "orders": { "order": { "score": "80", "reason": "Text score." } },
                },
            });
        }
        _ => {}
    }
    json!({ "schemaVersion": 1, "contexts": contexts })
}

struct DiscoverSkill {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    body: Vec<String>,
}

fn discover_skills() -> Vec<DiscoverSkill> {
    let body = |lines: &[&str]| {
        lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<String>>()
    };
    vec![
        DiscoverSkill {
            name: "discover-testing-strategy",
            title: "Testing strategy",
            description: "Apply the observed unit-test level and the project's recorded test command before requesting review.",
            body: body(&[
                "- Run `bun test` from the repository root before review.",
                "- Treat the unit level as the only implemented test level; add new cases there.",
                "- Add a failing case first and keep one assertion focus per test file.",
                "- Report untested areas as unknown instead of inventing an integration or end-to-end suite.",
            ]),
        },
        DiscoverSkill {
            name: "discover-naming-conventions",
            title: "Naming conventions",
            description: "Name code after the grounded glossary terms and keep the observed casing across the project.",
            body: body(&[
                "- Name domain types and functions after the preferred labels in .omp/discover/glossary/orders.glossary.yaml.",
                "- Keep file names kebab-case and exported types PascalCase.",
                "- Use camelCase for functions, variables, and flags.",
                "- Reject aliases the glossary does not define; propose new terms through the glossary process in .omp/discover/glossary/orders.glossary.yaml.",
            ]),
        },
        DiscoverSkill {
            name: "discover-coding-conventions",
            title: "Coding conventions",
            description: "Keep typed, explicit code that reuses the dependencies the manifest already records.",
            body: body(&[
                "- Keep exported functions typed; never leave an implicit any boundary.",
                "- Handle recoverable errors at the caller; never swallow a failure silently.",
                "- Prefer an already-installed dependency over adding a new one.",
                "- Run `bun test` before claiming a change is complete.",
            ]),
        },
        DiscoverSkill {
            name: "discover-architecture-boundaries",
            title: "Architecture and boundaries",
            description: "Keep domain behavior inside its bounded context and preserve the observed dependency direction.",
            body: body(&[
                "- Keep domain behavior inside its bounded context.",
                "- Point imports inward toward domain modules; never import delivery code from the domain.",
                "- Do not add a cross-context import without recording the boundary in .omp/discover/glossary/orders.glossary.yaml.",
                "- Treat an external service as absent until a manifest or source file declares one.",
            ]),
        },
        DiscoverSkill {
            name: "discover-glossary",
            title: "Glossary",
            description: "Use the canonical glossary, honor human decisions, and propose new terms explicitly.",
            body: body(&[
                "- Treat .omp/discover/glossary/orders.glossary.yaml as the canonical glossary for every naming decision.",
                "- Never write a confirmed status into a generated glossary; only a human confirm decision may do that.",
                "- Reject a proposed term with a non-empty reason instead of deleting it.",
                "- Propose new terms through Discover with grounding and let a human confirm them.",
                "- Never label code with an invalidated preferred label; no concept is invalidated in this baseline.",
            ]),
        },
    ]
}

struct StubPullRequest {
    number: i64,
    title: &'static str,
    body: &'static str,
    merged_at: &'static str,
    additions: i64,
    deletions: i64,
    files: Vec<&'static str>,
    test_files: i64,
    documentation_files: i64,
    labels: Vec<&'static str>,
    draft: bool,
    approvals: i64,
    checks: Vec<&'static str>,
    commits: Vec<(&'static str, &'static str)>,
    branch: &'static str,
    merge_method: &'static str,
    references: Vec<i64>,
}

/// Four merged pull requests, newest first, and one closed-unmerged number.
fn merged_pull_requests() -> Vec<StubPullRequest> {
    vec![
        StubPullRequest {
            number: 12,
            title: "feat(orders): keep empty order totals at zero",
            body: "## Summary\n- Return zero for an empty order.\n- Cover the empty case.\n\nCloses #40",
            merged_at: "2026-05-04T10:00:00.000Z",
            additions: 12,
            deletions: 3,
            files: vec!["src/order.ts", "test/order.test.ts"],
            test_files: 1,
            documentation_files: 0,
            labels: vec!["area:orders"],
            draft: false,
            approvals: 1,
            checks: vec!["ci/test"],
            commits: vec![("feat(orders): return zero for empty totals", "")],
            branch: "feat/empty-order-total",
            merge_method: "squash",
            references: vec![40],
        },
        StubPullRequest {
            number: 11,
            title: "fix(checkout): reuse the order total",
            body: "## Summary\n- Reuse the existing total.\n\n## Test plan\n- Run the suite.\n\nCloses #38",
            merged_at: "2026-04-20T09:30:00.000Z",
            additions: 20,
            deletions: 5,
            files: vec!["src/checkout/flow.ts", "test/order.test.ts", "docs/orders.md"],
            test_files: 1,
            documentation_files: 1,
            labels: vec!["area:checkout"],
            draft: false,
            approvals: 1,
            checks: vec!["ci/lint", "ci/test"],
            commits: vec![("fix(checkout): reuse the order total", "")],
            branch: "fix/reuse-order-total",
            merge_method: "squash",
            references: vec![38],
        },
        StubPullRequest {
            number: 9,
            title: "docs(orders): document the total",
            body: "## Summary\nUpdate the guide.\n\n## Checklist\n- [x] Docs updated",
            merged_at: "2026-03-15T12:00:00.000Z",
            additions: 4,
            deletions: 0,
            files: vec!["CHANGELOG.md", "docs/orders.md"],
            test_files: 0,
            documentation_files: 2,
            labels: vec!["documentation"],
            draft: false,
            approvals: 1,
            checks: vec!["ci/test"],
            commits: vec![("docs(orders): document the total", "Refs #30")],
            branch: "docs/order-total",
            merge_method: "squash",
            references: vec![30],
        },
        StubPullRequest {
            number: 7,
            title: "test(orders): cover the empty total",
            body: "## Summary\n- Add a regression test.",
            merged_at: "2026-02-01T08:00:00.000Z",
            additions: 8,
            deletions: 1,
            files: vec!["test/order.test.ts"],
            test_files: 1,
            documentation_files: 0,
            labels: vec!["tests"],
            draft: true,
            approvals: 2,
            checks: vec!["ci/test"],
            commits: vec![("test(orders): cover the empty total", "")],
            branch: "test/empty-total",
            merge_method: "merge",
            references: vec![],
        },
    ]
}

fn sorted(mut values: Vec<&'static str>) -> Vec<&'static str> {
    values.sort();
    values
}

fn contribution_source(no_forge: bool, invalid: &str) -> Value {
    if no_forge {
        return json!({
            "forge": null,
            "host": null,
            "unavailable": "No forge credential or network was available for the target.",
            "window": null,
            "mergedPullRequests": [],
            "closedUnmergedPullRequests": [],
        });
    }
    let merged: Vec<Value> = merged_pull_requests()
        .into_iter()
        .map(|pull_request| {
            let body = if invalid == "secret" {
                format!("{}\n\nToken: {DISCOVER_SECRET}", pull_request.body)
            } else {
                pull_request.body.to_string()
            };
            let commits: Vec<Value> = pull_request
                .commits
                .iter()
                .map(|(subject, body)| json!({ "subject": subject, "body": body }))
                .collect();
            json!({
                "number": pull_request.number,
                "title": pull_request.title,
                "body": body,
                "mergedAt": pull_request.merged_at,
                "additions": pull_request.additions,
                "deletions": pull_request.deletions,
                "filesChanged": pull_request.files.len(),
                "files": sorted(pull_request.files),
                "testFiles": pull_request.test_files,
                "documentationFiles": pull_request.documentation_files,
                "labels": sorted(pull_request.labels),
                "draft": pull_request.draft,
                "approvals": pull_request.approvals,
                "checks": sorted(pull_request.checks),
                "commits": commits,
                "branch": pull_request.branch,
                "mergeMethod": pull_request.merge_method,
                "references": pull_request.references,
            })
        })
        .collect();
    let times = {
        let mut values: Vec<&str> = merged_pull_requests()
            .iter()
            .map(|pull_request| pull_request.merged_at)
            .collect();
        values.sort();
        values
    };
    json!({
        "forge": "gitea",
        "host": "localhost",
        "unavailable": null,
        "window": { "from": times[0], "to": times[times.len() - 1] },
        "mergedPullRequests": merged,
        "closedUnmergedPullRequests": [10],
    })
}

fn contribution_skill(no_forge: bool, invalid: &str) -> DiscoverSkill {
    let sample: Vec<StubPullRequest> = if no_forge {
        Vec::new()
    } else {
        let mut sorted_requests = merged_pull_requests();
        sorted_requests.sort_by(|left, right| {
            right
                .merged_at
                .cmp(left.merged_at)
                .then(right.number.cmp(&left.number))
        });
        sorted_requests.truncate(3);
        sorted_requests
    };
    let bullets: Vec<String> = if no_forge {
        vec![
            "- Read `.omp/discover/contribution.json` before writing a pull request.".to_string(),
            "- Treat every pull-request-derived rule and exemplar as unknown: No forge credential or network was available for the target.".to_string(),
            "- Run `bun test` and report the test evidence in the pull request.".to_string(),
        ]
    } else {
        vec![
            "- Read `.omp/discover/contribution.json` before writing a pull request.".to_string(),
            "- Keep one accepted change to a median of 2 files (range 1-3) and median 10 additions (range 4-20).".to_string(),
            "- Lead with a summary bullet, then the Summary and Test plan sections in that order.".to_string(),
            "- Write the description in the imperative voice with a short, specific vocabulary.".to_string(),
            "- Run `bun test` and include the test evidence in the pull request.".to_string(),
            "- Reference the issue the change closes with a closing keyword and its number.".to_string(),
            "- Use `feat(scope): summary` or `fix(scope): summary` commit subjects and `feat/` or `fix/` branches.".to_string(),
            "- Wait for one approval and the ci/test and ci/lint checks before merging.".to_string(),
            "- Update the documentation and CHANGELOG.md in the same pull request.".to_string(),
        ]
    };
    let mut exemplars: Vec<String> = Vec::new();
    if !sample.is_empty() {
        exemplars.push("## Exemplars".to_string());
        for pull_request in &sample {
            exemplars.push(format!(
                "> PR #{} — {}",
                pull_request.number, pull_request.title
            ));
            if invalid == "unmerged-excerpt" && pull_request.number == 12 {
                exemplars.push("> PR #10 — closed: never merged".to_string());
                exemplars.push(format!("> {CLOSED_UNMERGED_MARKER}"));
            }
            for line in pull_request.body.split('\n') {
                if line.is_empty() {
                    exemplars.push(">".to_string());
                } else {
                    exemplars.push(format!("> {line}"));
                }
            }
        }
    }
    let body: Vec<String> = if invalid == "bad-skill" {
        vec![
            "# Contribution".to_string(),
            "A paragraph instead of a bullet.".to_string(),
        ]
    } else {
        let mut lines = vec!["# Author a pull request this repository accepts".to_string()];
        lines.extend(bullets);
        lines.extend(exemplars);
        lines
    };
    DiscoverSkill {
        name: "discover-contribution",
        title: "Contribution",
        description:
            "Author a pull request that matches the merged pull requests this repository accepts.",
        body,
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    #[test]
    fn the_harness_checkout_is_recognised_and_the_fixture_is_not() {
        let harness = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("the harness root");
        assert!(is_harness_checkout(&harness));
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("stub-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&fixture);
        std::fs::create_dir_all(&fixture).expect("a fixture");
        let status = Command::new("git")
            .arg("-C")
            .arg(&fixture)
            .args(["init", "--quiet"])
            .status()
            .expect("git runs");
        assert!(status.success());
        assert!(!is_harness_checkout(&fixture));
        let _ = std::fs::remove_dir_all(&fixture);
    }
}
