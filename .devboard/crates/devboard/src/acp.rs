//! The ACP peer connection over stdio.
//!
//! A minimal Agent Client Protocol client: JSON-RPC 2.0 over newline-delimited
//! JSON on the child's stdio. It starts a session, sends one prompt, relays
//! session updates as activity, and holds elicitation requests until the
//! developer answers.
//!
//! The TypeScript implementation (`server/acp.ts`) is the behavioral
//! reference. The callbacks it takes become one unbounded event channel: the
//! [`AcpEvent`] variants correspond one-for-one to the callbacks an owner
//! passed, so a caller can drive the same activity log, question list, text
//! stream, liveness signal, and stderr diagnostics.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, Weak};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

/// The ACP protocol version this client announces.
pub const PROTOCOL_VERSION: u64 = 1;
const CLIENT_NAME: &str = "devboard-adr-ui";
const CLIENT_VERSION: &str = "0.1.0";

/// One selectable answer a question offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpQuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// True for the option the peer's schema default names, or the first one
    /// when the schema carries no default.
    pub recommended: bool,
}

/// A question the peer is waiting for the developer to answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcpQuestion {
    /// The JSON-RPC id of the `elicitation/create` request.
    pub id: AcpId,
    pub message: String,
    pub options: Vec<AcpQuestionOption>,
    /// The request's `requestedSchema.properties`, kept verbatim so an owner
    /// can echo the schema it was given.
    pub properties: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
}

/// A JSON-RPC id as the protocol permits it: a number or a string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AcpId {
    Number(i64),
    String(String),
}

impl AcpId {
    /// Narrows a parsed JSON id, or returns `None` for any other shape.
    pub fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::String(text) => Some(AcpId::String(text.clone())),
            Value::Number(number) => number.as_i64().map(AcpId::Number),
            _ => None,
        }
    }

    /// The map key the TypeScript client uses (`String(id)`).
    pub fn as_key(&self) -> String {
        match self {
            AcpId::Number(number) => number.to_string(),
            AcpId::String(text) => text.clone(),
        }
    }
}

impl fmt::Display for AcpId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AcpId::Number(number) => write!(formatter, "{number}"),
            AcpId::String(text) => write!(formatter, "{text}"),
        }
    }
}

/// How the client answers permission requests and elicitations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PermissionPolicy {
    /// Select the first option whose kind starts with `allow`.
    #[default]
    Allow,
    /// Cancel every permission request and every elicitation, for a peer that
    /// must answer from its prompt alone.
    Deny,
    /// Cancel permission requests but still surface elicitations as questions.
    ReadOnly,
}

/// One stdio MCP server in the shape an ACP `session/new` request accepts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMcpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<McpEnvVar>,
}

/// One environment pair inside a [`SessionMcpServer`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpEnvVar {
    pub name: String,
    pub value: String,
}

/// Everything a connection needs to start one peer.
#[derive(Debug, Clone)]
pub struct AcpConnectionOptions {
    /// The configured agent command; split on whitespace exactly as the
    /// TypeScript client splits it.
    pub command: String,
    pub cwd: String,
    /// The exact peer environment. `None` inherits the server's own.
    pub env: Option<HashMap<String, String>>,
    /// MCP servers the session must be opened with. `None` reads the peer's
    /// generated `mcp.json` registration.
    pub mcp_servers: Option<Vec<SessionMcpServer>>,
    pub permission_policy: PermissionPolicy,
}

impl AcpConnectionOptions {
    pub fn new(command: impl Into<String>, cwd: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            cwd: cwd.into(),
            env: None,
            mcp_servers: None,
            permission_policy: PermissionPolicy::default(),
        }
    }

    pub fn with_env(mut self, env: HashMap<String, String>) -> Self {
        self.env = Some(env);
        self
    }

    pub fn with_mcp_servers(mut self, mcp_servers: Vec<SessionMcpServer>) -> Self {
        self.mcp_servers = Some(mcp_servers);
        self
    }

    pub fn with_permission_policy(mut self, permission_policy: PermissionPolicy) -> Self {
        self.permission_policy = permission_policy;
        self
    }
}

/// One entry in the developer-facing activity log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpActivity {
    pub text: String,
    /// True when `text` continues the previous activity line instead of
    /// starting one.
    pub append: bool,
}

/// The message whose streamed chunks are currently being joined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityStream {
    pub kind: String,
    pub message_id: Option<String>,
}

/// The result of mapping one ACP session update to an activity entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityUpdate {
    pub activity: AcpActivity,
    /// The stream the next update must continue, if any.
    pub stream: Option<ActivityStream>,
}

/// One callback the TypeScript connection made, carried on a channel.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpEvent {
    /// One activity-log entry, emitted for every update that maps to a line.
    Activity(AcpActivity),
    /// One elicitation the peer is waiting on.
    Question(AcpQuestion),
    /// Assistant message text only; thoughts and tool activity never appear.
    Text(String),
    /// Every `session/update` frame, including tool progress that maps to no
    /// visible activity line. An owner that bounds a silent turn uses it as
    /// the peer's liveness signal.
    SessionUpdate,
    /// Diagnostic stderr text. A peer this process terminates reports its own
    /// shutdown on stderr; that notice is suppressed once closing starts.
    Stderr(String),
}

/// One agent failure, carrying the JSON-RPC error members the TypeScript
/// client kept on the thrown `Error`.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpError {
    pub message: String,
    pub code: Option<i64>,
    pub data: Option<Value>,
}

impl AcpError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            data: None,
        }
    }

    fn from_wire(error: &Value) -> Self {
        let record = as_record(error);
        Self {
            message: record
                .and_then(|record| record.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Agent request failed.")
                .to_string(),
            code: record
                .and_then(|record| record.get("code"))
                .and_then(Value::as_i64),
            data: record.and_then(|record| record.get("data")).cloned(),
        }
    }
}

impl fmt::Display for AcpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AcpError {}

pub type AcpResult<T> = Result<T, AcpError>;

/// Splits a configured command string the way the TypeScript client does:
/// trim, then split on whitespace, dropping empty entries.
pub fn split_command(command: &str) -> AcpResult<Vec<String>> {
    let argv: Vec<String> = command.split_whitespace().map(str::to_string).collect();
    if argv.is_empty() {
        return Err(AcpError::new("AGENT_COMMAND is empty."));
    }
    Ok(argv)
}

/// The MCP servers one ACP peer's session must be opened with.
///
/// An ACP session disables the agent's on-disk MCP discovery, so the
/// registration the peer's generated agent directory carries in `mcp.json`
/// reaches the session only through `session/new`.
pub fn session_mcp_servers(environment: &HashMap<String, String>) -> Vec<SessionMcpServer> {
    let Some(agent_dir) = environment
        .get("PI_CODING_AGENT_DIR")
        .filter(|directory| !directory.is_empty())
    else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(Path::new(agent_dir).join("mcp.json")) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(servers) = as_record(&parsed)
        .and_then(|parsed| parsed.get("mcpServers"))
        .and_then(as_record)
    else {
        return Vec::new();
    };
    let mut resolved = Vec::new();
    for (name, value) in servers {
        let Some(entry) = as_record(value) else {
            continue;
        };
        if entry.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let Some(command) = entry
            .get("command")
            .and_then(Value::as_str)
            .filter(|command| !command.is_empty())
        else {
            continue;
        };
        let args = entry
            .get("args")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let env = entry
            .get("env")
            .and_then(as_record)
            .map(|configured| {
                configured
                    .iter()
                    .filter_map(|(key, configured_value)| {
                        configured_value.as_str().map(|value| McpEnvVar {
                            name: key.clone(),
                            value: value.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        resolved.push(SessionMcpServer {
            name: name.clone(),
            command: command.to_string(),
            args,
            env,
        });
    }
    resolved
}

/// Maps one ACP session update to an activity entry.
///
/// Text updates arrive as deltas of one assistant message, identified by
/// `messageId`; a delta that continues the stream already in progress is
/// marked for appending so the log shows the message, not its chunks. Without
/// a message id a text update is taken as a complete line.
pub fn next_activity(update: &Value, stream: Option<&ActivityStream>) -> Option<ActivityUpdate> {
    let notification = as_record(update)?;
    let session_update = notification.get("sessionUpdate").and_then(Value::as_str)?;

    match session_update {
        "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" => {
            let text = as_record(notification.get("content")?)
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)?;
            if text.is_empty() {
                return None;
            }
            let message_id = notification
                .get("messageId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let append = match (&message_id, stream) {
                (Some(message_id), Some(stream)) => {
                    stream.kind == session_update
                        && stream.message_id.as_deref() == Some(message_id.as_str())
                }
                _ => false,
            };
            Some(ActivityUpdate {
                activity: AcpActivity {
                    text: text.to_string(),
                    append,
                },
                stream: Some(ActivityStream {
                    kind: session_update.to_string(),
                    message_id,
                }),
            })
        }
        "tool_call" | "tool_call_update" => {
            let title = notification.get("title").and_then(Value::as_str)?;
            if title.is_empty() {
                return None;
            }
            Some(ActivityUpdate {
                activity: AcpActivity {
                    text: title.to_string(),
                    append: false,
                },
                stream: None,
            })
        }
        "plan" => {
            let entries = notification.get("entries").and_then(Value::as_array)?;
            let lines: Vec<&str> = entries
                .iter()
                .filter_map(|entry| as_record(entry)?.get("content")?.as_str())
                .filter(|line| !line.is_empty())
                .collect();
            if lines.is_empty() {
                return None;
            }
            Some(ActivityUpdate {
                activity: AcpActivity {
                    text: lines.join("\n"),
                    append: false,
                },
                stream: None,
            })
        }
        _ => None,
    }
}

/// The prompt that starts one ADR resolution turn.
pub fn agent_prompt(adr_dir: &str, file: &str) -> String {
    let trimmed = adr_dir.trim_end_matches(['/', '\\']);
    let path = format!("{trimmed}/{file}");
    format!(
        "/adr-resolve {path}\n\nResolve only {path}.\nDo not open, read, or resolve any other \
         record. Stop as soon as this record's `status` is no longer `proposed` or `draft`."
    )
}

/// A minimal ACP client over one child process.
pub struct AcpConnection {
    inner: Arc<Inner>,
    /// Ends a child the owner forgot to close. Disarmed by `close`, which
    /// records the close before signalling.
    _guard: Option<ProcessGuard>,
}

impl AcpConnection {
    /// Spawns the peer and returns the connection together with the channel
    /// carrying its callbacks.
    ///
    /// The child leads its own process group, so the tools it started end with
    /// it. Its stdin, stdout, and stderr are piped; stdout and stderr are read
    /// by background tasks until end of file.
    pub async fn connect(
        options: AcpConnectionOptions,
    ) -> AcpResult<(Self, mpsc::UnboundedReceiver<AcpEvent>)> {
        let argv = split_command(&options.command)?;
        let mut command = Command::new(&argv[0]);
        command
            .args(&argv[1..])
            .current_dir(&options.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(environment) = &options.env {
            command.env_clear();
            for (key, value) in environment {
                command.env(key, value);
            }
        }
        #[cfg(unix)]
        {
            // One process group per peer, so a signal reaches its tools too.
            command.process_group(0);
        }

        let mut child = command
            .spawn()
            .map_err(|error| AcpError::new(error.to_string()))?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.start_kill();
            return Err(AcpError::new("Agent stdio was not piped."));
        };
        let pid = child.id().unwrap_or(0);
        // Reap the child once it exits. The connection only keeps the pid,
        // because every signal goes to the process group.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });

        let (events, receiver) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            argv,
            cwd: options.cwd,
            environment: options.env,
            mcp_servers: options.mcp_servers,
            permission_policy: options.permission_policy,
            stdin: Mutex::new(Some(stdin)),
            pending: StdMutex::new(HashMap::new()),
            questions: StdMutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            session_id: StdMutex::new(None),
            activity_stream: StdMutex::new(None),
            pid,
            events,
        });

        tokio::spawn(read_stdout(inner.clone(), stdout));
        tokio::spawn(read_stderr(inner.clone(), stderr));

        let guard = (pid != 0).then(|| ProcessGuard {
            pid,
            inner: Arc::downgrade(&inner),
        });
        Ok((
            Self {
                inner,
                _guard: guard,
            },
            receiver,
        ))
    }

    /// True once the peer exited or the connection closed.
    pub fn closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// True once the peer opened a session this connection can prompt again.
    pub fn has_session(&self) -> bool {
        lock(&self.inner.session_id).is_some()
    }

    /// The child's pid, recorded so a replacement can end an orphaned peer.
    pub fn pid(&self) -> Option<u32> {
        if self.closed() || self.inner.pid == 0 {
            None
        } else {
            Some(self.inner.pid)
        }
    }

    /// The exact argv the child was spawned with, used to prove its identity.
    pub fn argv(&self) -> Vec<String> {
        self.inner.argv.clone()
    }

    /// The session the handshake opened, if any.
    pub fn session_id(&self) -> Option<String> {
        lock(&self.inner.session_id).clone()
    }

    /// Initializes the peer, opens a session, then sends the first prompt.
    pub async fn run(&self, prompt: &str) -> AcpResult<Value> {
        self.inner
            .request("initialize", initialize_params())
            .await?;

        let mcp_servers = match &self.inner.mcp_servers {
            Some(servers) => servers.clone(),
            None => {
                let environment = match &self.inner.environment {
                    Some(environment) => environment.clone(),
                    None => std::env::vars().collect(),
                };
                session_mcp_servers(&environment)
            }
        };
        let session = self
            .inner
            .request(
                "session/new",
                json!({
                    "cwd": self.inner.cwd.as_str(),
                    "mcpServers": mcp_servers,
                }),
            )
            .await?;

        let session_id = as_record(&session)
            .and_then(|session| session.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(session_id) = session_id else {
            return Err(AcpError::new("Agent did not return a session id."));
        };
        *lock(&self.inner.session_id) = Some(session_id);

        self.prompt(prompt).await
    }

    /// Sends another prompt on the session this connection opened.
    pub async fn prompt(&self, prompt: &str) -> AcpResult<Value> {
        let session_id = lock(&self.inner.session_id).clone();
        let Some(session_id) = session_id else {
            return Err(AcpError::new("No agent session is open."));
        };
        self.inner
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": prompt }],
                }),
            )
            .await
    }

    /// Answers one held elicitation. Returns false when no question with that
    /// id is waiting.
    pub async fn answer(&self, id: &AcpId, value: &str) -> bool {
        let Some(pending) = lock(&self.inner.questions).remove(&id.as_key()) else {
            return false;
        };
        let content = answer_content(&pending.question, value);
        let message = json!({
            "jsonrpc": "2.0",
            "id": pending.wire_id,
            "result": {
                "action": "accept",
                "content": content,
            },
        });
        let _ = self.inner.write_message(&message).await;
        true
    }

    /// Asks the peer to cancel the turn in progress, without ending its
    /// session. The pending prompt settles when the peer answers the cancel.
    pub async fn cancel(&self) -> AcpResult<()> {
        let session_id = lock(&self.inner.session_id).clone();
        let Some(session_id) = session_id else {
            return Err(AcpError::new("No agent session is open."));
        };
        self.inner
            .write_message(&json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": session_id },
            }))
            .await
    }

    /// Suspends the child without ending its ACP session. The pipe buffers
    /// keep any answer written meanwhile, and the pending request survives.
    pub fn pause(&self) -> bool {
        if self.closed() {
            return false;
        }
        signal_process(self.inner.pid, signal_stop())
    }

    pub fn resume(&self) -> bool {
        if self.closed() {
            return false;
        }
        signal_process(self.inner.pid, signal_continue())
    }

    /// Ends the peer and its process group. A stopped child is resumed first,
    /// because it would not process SIGTERM until it runs again.
    pub fn close(&self) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.inner.closing.store(true, Ordering::SeqCst);
        let pid = self.inner.pid;
        if pid != 0 {
            signal_process(pid, signal_continue());
            signal_group(pid, signal_terminate());
            signal_process(pid, signal_terminate());
        }
    }
}

struct Inner {
    argv: Vec<String>,
    cwd: String,
    environment: Option<HashMap<String, String>>,
    mcp_servers: Option<Vec<SessionMcpServer>>,
    permission_policy: PermissionPolicy,
    stdin: Mutex<Option<ChildStdin>>,
    pending: StdMutex<HashMap<String, oneshot::Sender<AcpResult<Value>>>>,
    questions: StdMutex<HashMap<String, PendingQuestion>>,
    next_request_id: AtomicU64,
    closed: AtomicBool,
    closing: AtomicBool,
    session_id: StdMutex<Option<String>>,
    activity_stream: StdMutex<Option<ActivityStream>>,
    pid: u32,
    events: mpsc::UnboundedSender<AcpEvent>,
}

struct PendingQuestion {
    wire_id: Value,
    question: AcpQuestion,
}

impl Inner {
    /// Writes one newline-delimited JSON-RPC frame.
    async fn write_message(&self, message: &Value) -> AcpResult<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AcpError::new("Agent process is not running."));
        }
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(AcpError::new("Agent process is not running."));
        };
        let mut text = crate::jsjson::stringify(message);
        text.push('\n');
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|error| AcpError::new(error.to_string()))?;
        stdin
            .flush()
            .await
            .map_err(|error| AcpError::new(error.to_string()))?;
        Ok(())
    }

    /// Sends one numbered request and waits for its response.
    async fn request(&self, method: &str, params: Value) -> AcpResult<Value> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AcpError::new("Agent process is not running."));
        }
        let id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        lock(&self.pending).insert(id.to_string(), sender);

        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write_message(&message).await {
            lock(&self.pending).remove(&id.to_string());
            return Err(error);
        }

        match receiver.await {
            Ok(outcome) => outcome,
            Err(_) => Err(AcpError::new("Agent process exited before answering.")),
        }
    }

    async fn respond(&self, id: &Value, result: Value) {
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        // The peer is gone; nothing left to answer.
        let _ = self.write_message(&message).await;
    }

    async fn respond_error(&self, id: &Value, code: i64, message: &str) {
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        });
        let _ = self.write_message(&frame).await;
    }

    /// Handles one complete protocol line.
    async fn handle_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let Some(object) = message.as_object() else {
            return;
        };

        if let Some(method) = object.get("method").and_then(Value::as_str) {
            let id = object.get("id").filter(|value| !value.is_null()).cloned();
            if let Some(id) = id {
                let params = object.get("params").cloned().unwrap_or(Value::Null);
                self.handle_request(id, method, params).await;
            } else if method == "session/update" {
                self.handle_session_update(object.get("params").unwrap_or(&Value::Null));
            }
            return;
        }

        let Some(id) = object.get("id").filter(|value| !value.is_null()) else {
            return;
        };
        let Some(pending) = lock(&self.pending).remove(&id_key(id)) else {
            return;
        };
        let outcome = match object.get("error") {
            Some(error) => Err(AcpError::from_wire(error)),
            None => Ok(object.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = pending.send(outcome);
    }

    async fn handle_request(&self, id: Value, method: &str, params: Value) {
        match method {
            "session/update" => {
                self.handle_session_update(&params);
                self.respond(&id, Value::Null).await;
            }
            "elicitation/create" => self.handle_elicitation(id, &params).await,
            "session/request_permission" => {
                if matches!(
                    self.permission_policy,
                    PermissionPolicy::Deny | PermissionPolicy::ReadOnly
                ) {
                    self.respond(&id, cancelled_permission()).await;
                    return;
                }
                let allow_option = as_record(&params)
                    .and_then(|request| request.get("options"))
                    .and_then(Value::as_array)
                    .and_then(|options| {
                        options.iter().find(|candidate| {
                            as_record(candidate)
                                .and_then(|candidate| candidate.get("kind"))
                                .and_then(Value::as_str)
                                .is_some_and(|kind| kind.starts_with("allow"))
                        })
                    });
                let option_id = allow_option
                    .and_then(as_record)
                    .and_then(|candidate| candidate.get("optionId"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let result = match option_id {
                    Some(option_id) => json!({
                        "outcome": { "outcome": "selected", "optionId": option_id },
                    }),
                    None => cancelled_permission(),
                };
                self.respond(&id, result).await;
            }
            _ => {
                self.respond_error(&id, -32601, &format!("Method not found: {method}"))
                    .await;
            }
        }
    }

    fn handle_session_update(&self, params: &Value) {
        let _ = self.events.send(AcpEvent::SessionUpdate);
        let update = as_record(params).and_then(|params| params.get("update"));
        let stream = lock(&self.activity_stream).clone();
        let Some(next) = update.and_then(|update| next_activity(update, stream.as_ref())) else {
            return;
        };
        let ActivityUpdate {
            activity,
            stream: next_stream,
        } = next;
        *lock(&self.activity_stream) = next_stream.clone();
        let text = activity.text.clone();
        let _ = self.events.send(AcpEvent::Activity(activity));
        if next_stream
            .as_ref()
            .is_some_and(|stream| stream.kind == "agent_message_chunk")
        {
            let _ = self.events.send(AcpEvent::Text(text));
        }
    }

    async fn handle_elicitation(&self, wire_id: Value, params: &Value) {
        let Some(request) = as_record(params) else {
            self.respond(&wire_id, json!({ "action": "cancel" })).await;
            return;
        };
        if self.permission_policy == PermissionPolicy::Deny {
            self.respond(&wire_id, json!({ "action": "cancel" })).await;
            return;
        }

        let schema = request.get("requestedSchema").and_then(as_record);
        let properties = schema
            .and_then(|schema| schema.get("properties"))
            .and_then(as_record)
            .cloned()
            .unwrap_or_default();
        let required = schema
            .and_then(|schema| schema.get("required"))
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            });
        let message = request
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let id = AcpId::from_value(&wire_id).unwrap_or_else(|| AcpId::String(wire_id.to_string()));

        let question = AcpQuestion {
            id: id.clone(),
            message,
            options: question_options(&properties),
            properties,
            required,
        };
        lock(&self.questions).insert(
            id.as_key(),
            PendingQuestion {
                wire_id,
                question: question.clone(),
            },
        );
        let _ = self.events.send(AcpEvent::Question(question));
    }

    /// The stdout reader reached end of file: no request can settle anymore.
    fn finish(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let pending: Vec<_> = lock(&self.pending)
            .drain()
            .map(|(_, sender)| sender)
            .collect();
        for sender in pending {
            let _ = sender.send(Err(AcpError::new("Agent process exited before answering.")));
        }
        lock(&self.questions).clear();
    }
}

async fn read_stdout(inner: Arc<Inner>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    inner.handle_line(trimmed).await;
                }
            }
            Err(_) => break,
        }
    }
    inner.finish();
}

async fn read_stderr(inner: Arc<Inner>, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) => break,
            Ok(_) => {
                if inner.closing.load(Ordering::SeqCst) {
                    continue;
                }
                let text = String::from_utf8_lossy(&line);
                if !text.is_empty() {
                    let _ = inner.events.send(AcpEvent::Stderr(text.into_owned()));
                }
            }
            Err(_) => break,
        }
    }
}

/// Ends a child whose owner dropped the connection without closing it.
struct ProcessGuard {
    pid: u32,
    inner: Weak<Inner>,
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        let exited = self
            .inner
            .upgrade()
            .is_none_or(|inner| inner.closed.load(Ordering::SeqCst));
        if !exited {
            signal_group(self.pid, signal_kill());
        }
    }
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientCapabilities": { "elicitation": { "form": {} } },
        "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
    })
}

fn cancelled_permission() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

fn answer_content(question: &AcpQuestion, value: &str) -> Map<String, Value> {
    let keys: Vec<String> = question.properties.keys().cloned().collect();
    let choice_keys: Vec<String> = keys
        .iter()
        .filter(|key| !property_labels(&question.properties[key.as_str()]).is_empty())
        .cloned()
        .collect();

    let matching_key = choice_keys
        .iter()
        .find(|key| {
            property_labels(&question.properties[key.as_str()])
                .iter()
                .any(|label| label == value)
        })
        .cloned();
    if let Some(key) = matching_key {
        let is_array = as_record(&question.properties[&key])
            .and_then(|record| record.get("type"))
            .and_then(Value::as_str)
            == Some("array");
        let entry = if is_array {
            Value::Array(vec![Value::String(value.to_string())])
        } else {
            Value::String(value.to_string())
        };
        let mut content = Map::new();
        content.insert(key, entry);
        return content;
    }

    let primary_key = choice_keys.first().cloned();
    if let Some(primary_key) = &primary_key {
        let other_key = format!("{primary_key}__other");
        if question.properties.contains_key(&other_key) {
            let mut content = Map::new();
            content.insert(other_key, Value::String(value.to_string()));
            return content;
        }
    }
    if let Some(primary_key) = primary_key {
        let mut content = Map::new();
        content.insert(primary_key, Value::String(value.to_string()));
        return content;
    }

    let key = question
        .required
        .as_ref()
        .and_then(|required| {
            required
                .iter()
                .find(|candidate| question.properties.contains_key(*candidate))
        })
        .cloned()
        .or_else(|| keys.first().cloned());
    let mut content = Map::new();
    if let Some(key) = key {
        content.insert(key, Value::String(value.to_string()));
    }
    content
}

fn question_options(properties: &Map<String, Value>) -> Vec<AcpQuestionOption> {
    let mut options = Vec::new();
    let mut labels = HashSet::new();
    for (key, property) in properties {
        if key.ends_with("__other") {
            continue;
        }
        let recommended = as_record(property)
            .and_then(|record| record.get("default"))
            .and_then(Value::as_str);
        for option in property_options(property) {
            if !labels.insert(option.label.clone()) {
                continue;
            }
            options.push(AcpQuestionOption {
                recommended: recommended == Some(option.label.as_str()),
                label: option.label,
                description: option.description,
            });
        }
    }
    // A question with choices always shows one recommendation: when the peer
    // omits a default, the first option is the suggestion the UI marks.
    let any_recommended = options.iter().any(|option| option.recommended);
    if !any_recommended {
        if let Some(first) = options.first_mut() {
            first.recommended = true;
        }
    }
    options
}

struct ParsedOption {
    label: String,
    description: Option<String>,
}

fn parsed_option(entry: &Value) -> Option<ParsedOption> {
    if let Value::String(label) = entry {
        return Some(ParsedOption {
            label: label.clone(),
            description: None,
        });
    }
    let record = as_record(entry)?;
    let label = ["title", "const", "label", "value"]
        .iter()
        .find_map(|key| record.get(*key).and_then(Value::as_str))?
        .to_string();
    let description = record
        .get("description")
        .and_then(Value::as_str)
        .filter(|description| !description.trim().is_empty())
        .map(str::to_string);
    Some(ParsedOption { label, description })
}

fn property_options(property: &Value) -> Vec<ParsedOption> {
    let Some(record) = as_record(property) else {
        return Vec::new();
    };
    let mut containers: Vec<&Value> = Vec::new();
    for key in ["enum", "oneOf", "anyOf"] {
        if let Some(container) = record.get(key) {
            containers.push(container);
        }
    }
    if let Some(items) = record.get("items").and_then(as_record) {
        for key in ["enum", "oneOf", "anyOf", "const"] {
            if let Some(container) = items.get(key) {
                containers.push(container);
            }
        }
    }
    if let Some(container) = record.get("const") {
        containers.push(container);
    }

    let mut options = Vec::new();
    let mut labels = HashSet::new();
    for container in containers {
        let entries: Vec<&Value> = match container {
            Value::Array(entries) => entries.iter().collect(),
            entry => vec![entry],
        };
        for entry in entries {
            let Some(option) = parsed_option(entry) else {
                continue;
            };
            if labels.insert(option.label.clone()) {
                options.push(option);
            }
        }
    }
    options
}

fn property_labels(property: &Value) -> Vec<String> {
    property_options(property)
        .into_iter()
        .map(|option| option.label)
        .collect()
}

fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn id_key(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(unix)]
fn signal_process(pid: u32, signal: i32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe { libc::kill(pid as i32, signal) == 0 }
}

#[cfg(not(unix))]
fn signal_process(_pid: u32, _signal: i32) -> bool {
    false
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) {
    if pid == 0 {
        return;
    }
    // The peer leads its own group; fall back to the process itself when the
    // group is already gone.
    if unsafe { libc::kill(-(pid as i32), signal) } != 0 {
        unsafe {
            libc::kill(pid as i32, signal);
        }
    }
}

#[cfg(not(unix))]
fn signal_group(_pid: u32, _signal: i32) {}

#[cfg(unix)]
fn signal_stop() -> i32 {
    libc::SIGSTOP
}

#[cfg(not(unix))]
fn signal_stop() -> i32 {
    0
}

#[cfg(unix)]
fn signal_continue() -> i32 {
    libc::SIGCONT
}

#[cfg(not(unix))]
fn signal_continue() -> i32 {
    0
}

#[cfg(unix)]
fn signal_terminate() -> i32 {
    libc::SIGTERM
}

#[cfg(not(unix))]
fn signal_terminate() -> i32 {
    0
}

#[cfg(unix)]
fn signal_kill() -> i32 {
    libc::SIGKILL
}

#[cfg(not(unix))]
fn signal_kill() -> i32 {
    0
}
