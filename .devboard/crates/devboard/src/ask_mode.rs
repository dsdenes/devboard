//! Ask conversations: the element-scoped question panel.
//!
//! One conversation belongs to each open report panel. Every turn runs the ACP
//! peer with the provider's environment and a read-only permission policy,
//! streams assistant text as `askChunk` frames, and ends the turn with
//! `askDone`; a refused request, an agent failure, or the turn deadline
//! answers `askError`. The visible turns are retained under
//! `<state>/ask/<repository key>` so a replacement dashboard answers the next
//! question from the same transcript.
//!
//! Each turn runs in a detached owner process, so a dashboard replacement
//! re-attaches to the peer that is still answering. The owner owns the ACP
//! peer and its text journal; this module validates requests, streams the
//! replayed answer through `askChunk`, and emits `askDone` exactly once when
//! the turn settles.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::acp::{AcpActivity, PermissionPolicy};
use crate::app::{App, Conn};
use crate::command::Command;
use crate::detached_run::{ActivityCallback, DetachedPeer, DetachedPeerOptions, TextCallback};

/// The longest conversation id a client may name.
const MAX_CONVERSATION_ID: usize = 200;
/// The longest question a client may ask.
const MAX_QUESTION: usize = 4000;
/// How long a turn may stream no text or activity before it is dead.
pub const ASK_TURN_SILENCE_MS: u64 = 120_000;
/// The outer bound on one turn, even while it keeps reporting progress.
pub const ASK_TURN_MAX_MS: u64 = 15 * 60_000;
/// Bounds shared with the client's capture, in their wire order; a larger
/// value is refused.
const ASK_CONTEXT_LIMITS: [(&str, usize); 7] = [
    ("route", 2000),
    ("url", 2000),
    ("selector", 500),
    ("viewport", 500),
    ("captured_at", 100),
    ("visible_text", 1500),
    ("dom_excerpt", 4000),
];

const READ_ONLY_SENTENCE: &str = "This conversation is read-only. Never edit files, run mutating \
                                  commands, file issues, commit, or push.";
const BREVITY_SENTENCE: &str = "Answer in at most three short sentences and about 400 \
                                characters. No preamble and no restating the question.";
const PLAIN_SENTENCE: &str = "Reply in plain text without Markdown.";

/// One validated client ask.
#[derive(Debug, Clone)]
struct AskRequest {
    conversation_id: String,
    question: String,
    /// The captured element context, in [`ASK_CONTEXT_LIMITS`] order.
    context: Vec<(&'static str, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Developer,
    Agent,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Developer => "developer",
            Role::Agent => "agent",
        }
    }
}

/// One visible turn, replayed to a replacement peer.
#[derive(Debug, Clone)]
struct TranscriptEntry {
    role: Role,
    text: String,
}

/// The whitespace JavaScript's `String.prototype.trim` removes.
fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | ' '
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// JavaScript's `trim`, whose character set differs from Rust's `trim`.
fn js_trim(value: &str) -> String {
    value.trim_matches(is_js_whitespace).to_string()
}

/// Validates one client ask; unknown fields are ignored for forwards
/// compatibility.
fn parse_ask_request(
    conversation_id: Option<&Value>,
    question: Option<&Value>,
    context: Option<&Value>,
) -> Result<AskRequest, String> {
    let Some(conversation_id) = conversation_id.and_then(Value::as_str) else {
        return Err("The ask has no conversation id.".to_string());
    };
    let id = js_trim(conversation_id);
    if id.is_empty() || crate::feedback::js_len(&id) > MAX_CONVERSATION_ID {
        return Err(format!(
            "The conversation id must be 1-{MAX_CONVERSATION_ID} characters."
        ));
    }

    let Some(question) = question.and_then(Value::as_str) else {
        return Err("The ask has no question.".to_string());
    };
    let question = js_trim(question);
    if question.is_empty() {
        return Err("The question is empty.".to_string());
    }
    if crate::feedback::js_len(&question) > MAX_QUESTION {
        return Err(format!(
            "The question is longer than {MAX_QUESTION} characters."
        ));
    }

    let Some(context) = context.filter(|value| value.is_object() || value.is_array()) else {
        return Err("The ask has no element context.".to_string());
    };
    // JavaScript's `typeof` check accepts an array as a record, which then
    // carries none of the named fields; only a non-object is refused outright.
    let context = context.as_object();
    let mut captured = Vec::with_capacity(ASK_CONTEXT_LIMITS.len());
    for (name, limit) in ASK_CONTEXT_LIMITS {
        let Some(value) = context
            .and_then(|context| context.get(name))
            .and_then(Value::as_str)
        else {
            return Err(format!("The ask context is missing {name}."));
        };
        if crate::feedback::js_len(value) > limit {
            return Err(format!("The ask context {name} is longer than {limit}."));
        }
        captured.push((name, value.to_string()));
    }

    Ok(AskRequest {
        conversation_id: id,
        question,
        context: captured,
    })
}

fn context_lines(context: &[(&'static str, String)]) -> Vec<String> {
    context
        .iter()
        .map(|(name, value)| format!("{name}: {value}"))
        .collect()
}

/// The deadline in the ask error; milliseconds below one second stay exact.
fn timeout_label(timeout_ms: u64) -> String {
    if timeout_ms % 1000 == 0 {
        format!("{} seconds", timeout_ms / 1000)
    } else {
        format!("{timeout_ms}ms")
    }
}

/// A long bound in minutes, so the outer deadline reads naturally.
fn minutes_label(timeout_ms: u64) -> String {
    if timeout_ms >= 60_000 && timeout_ms % 60_000 == 0 {
        format!("{} minutes", timeout_ms / 60_000)
    } else {
        timeout_label(timeout_ms)
    }
}

/// The prompt's invariant instruction block, repeated on every turn.
fn instructions() -> [&'static str; 3] {
    [READ_ONLY_SENTENCE, BREVITY_SENTENCE, PLAIN_SENTENCE]
}

fn earlier_turns(transcript: &[TranscriptEntry]) -> Vec<String> {
    if transcript.is_empty() {
        return Vec::new();
    }
    let mut lines = vec!["Earlier in this conversation:".to_string()];
    for entry in transcript {
        let speaker = match entry.role {
            Role::Developer => "Developer",
            Role::Agent => "Agent",
        };
        lines.push(format!("{speaker}: {}", entry.text));
    }
    lines.push(String::new());
    lines
}

/// The first prompt of a conversation, or of a replacement peer.
fn ask_prompt(request: &AskRequest, transcript: &[TranscriptEntry]) -> String {
    let mut lines = vec![
        "You are answering a question about a UI element in the running Devboard interface."
            .to_string(),
        "Answer from the captured context and this conversation; change nothing.".to_string(),
        String::new(),
    ];
    lines.extend(instructions().iter().map(|line| line.to_string()));
    lines.push(String::new());
    lines.extend(earlier_turns(transcript));
    lines.push(format!("Question: {}", request.question));
    lines.push(String::new());
    lines.push("Captured element context:".to_string());
    lines.extend(context_lines(&request.context));
    lines.join("\n")
}

/// A follow-up keeps the live session's context and repeats the instructions.
fn follow_up_prompt(question: &str) -> String {
    let mut lines: Vec<String> = instructions().iter().map(|line| line.to_string()).collect();
    lines.push(String::new());
    lines.push(format!("Question: {question}"));
    lines.join("\n")
}

/// The file name for one conversation: the first 32 hex digits of its id.
fn conversation_key(id: &str) -> String {
    let digest = Sha256::digest(id.as_bytes());
    hex::encode(digest)[..32].to_string()
}

/// `<STATE_DIR>/ask/<repository key>`.
fn ask_directory(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    crate::detached_run::absolute(state_dir)
        .join("ask")
        .join(crate::journal::journal_key(&crate::detached_run::absolute(
            repo_dir,
        )))
}

/// One live conversation.
struct Conversation {
    id: String,
    socket: Option<Conn>,
    /// The detached owner of this conversation's peer.
    peer: Option<Arc<DetachedPeer>>,
    /// Visible turns, replayed to a replacement peer.
    transcript: Vec<TranscriptEntry>,
    busy: bool,
    /// The answer being streamed; a closed or replaced turn discards it.
    answer: String,
    closed: bool,
    turn: u64,
    /// The prompt of the turn in flight, so a replacement can re-attach.
    last_prompt: Option<String>,
    /// When the live turn last streamed text or activity.
    last_progress: Instant,
}

impl Conversation {
    fn new(id: String) -> Self {
        Self {
            id,
            socket: None,
            peer: None,
            transcript: Vec::new(),
            busy: false,
            answer: String::new(),
            closed: false,
            turn: 0,
            last_prompt: None,
            last_progress: Instant::now(),
        }
    }

    /// True while this conversation is on the given turn for this socket.
    fn live(&self, turn: u64, socket_id: u64) -> bool {
        !self.closed
            && self.turn == turn
            && self
                .socket
                .as_ref()
                .is_some_and(|owner| owner.id() == socket_id)
    }

    /// The persisted shape, in the TypeScript key order.
    fn stored(&self) -> Value {
        let mut stored = Map::new();
        stored.insert("id".to_string(), Value::String(self.id.clone()));
        stored.insert(
            "transcript".to_string(),
            Value::Array(
                self.transcript
                    .iter()
                    .map(|entry| {
                        let mut value = Map::new();
                        value.insert(
                            "role".to_string(),
                            Value::String(entry.role.as_str().into()),
                        );
                        value.insert("text".to_string(), Value::String(entry.text.clone()));
                        Value::Object(value)
                    })
                    .collect(),
            ),
        );
        stored.insert("turn".to_string(), json!(self.turn));
        stored.insert("busy".to_string(), json!(self.busy));
        stored.insert(
            "lastPrompt".to_string(),
            self.last_prompt
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        Value::Object(stored)
    }
}

struct Inner {
    conversations: HashMap<String, Conversation>,
}

/// Every conversation this dashboard serves.
pub struct AskMode {
    state_dir: PathBuf,
    repo_dir: PathBuf,
    command: String,
    instance: String,
    harness_version: Option<String>,
    turn_silence: Duration,
    turn_max: Duration,
    inner: Mutex<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// One mode per application, keyed weakly so a dropped dashboard takes its
/// conversations with it.
static MODES: Mutex<Vec<(Weak<App>, Arc<AskMode>)>> = Mutex::new(Vec::new());

fn restore_conversations(state_dir: &Path, repo_dir: &Path) -> HashMap<String, Conversation> {
    let mut conversations = HashMap::new();
    let Ok(entries) = std::fs::read_dir(ask_directory(state_dir, repo_dir)) else {
        return conversations;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(".json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        // An unreadable conversation is not a reason to stop serving.
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(value) = parsed.as_object() else {
            continue;
        };
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(transcript) = value.get("transcript").and_then(Value::as_array) else {
            continue;
        };
        let mut conversation = Conversation::new(id.to_string());
        conversation.transcript = transcript
            .iter()
            .filter_map(|entry| {
                let entry = entry.as_object()?;
                let role = match entry.get("role").and_then(Value::as_str)? {
                    "developer" => Role::Developer,
                    "agent" => Role::Agent,
                    _ => return None,
                };
                let text = entry.get("text").and_then(Value::as_str)?;
                Some(TranscriptEntry {
                    role,
                    text: text.to_string(),
                })
            })
            .collect();
        conversation.turn = value.get("turn").and_then(Value::as_u64).unwrap_or(0);
        conversation.busy = value.get("busy") == Some(&Value::Bool(true));
        conversation.last_prompt = value
            .get("lastPrompt")
            .and_then(Value::as_str)
            .map(str::to_string);
        conversations.insert(conversation.id.clone(), conversation);
    }
    conversations
}

impl AskMode {
    fn new(app: &Arc<App>) -> Self {
        let config = app.config();
        let state_dir = config.state_dir.clone();
        let repo_dir = config.repo_dir.clone();
        let conversations = restore_conversations(&state_dir, &repo_dir);
        Self {
            state_dir,
            repo_dir,
            command: config.agent_command.clone(),
            instance: app.instance.clone(),
            harness_version: app.running_version.clone(),
            turn_silence: Duration::from_millis(ASK_TURN_SILENCE_MS.max(1)),
            turn_max: Duration::from_millis(ASK_TURN_MAX_MS.max(ASK_TURN_SILENCE_MS)),
            inner: Mutex::new(Inner { conversations }),
        }
    }

    fn conversation_path(&self, id: &str) -> PathBuf {
        ask_directory(&self.state_dir, &self.repo_dir)
            .join(format!("{}.json", conversation_key(id)))
    }

    /// Writes the conversation's durable record; a read-only state directory
    /// still serves the conversation in memory.
    fn persist(&self, id: &str) {
        let stored = {
            let state = lock(&self.inner);
            let Some(conversation) = state.conversations.get(id) else {
                return;
            };
            conversation.stored()
        };
        let mut text = crate::jsjson::stringify(&stored);
        text.push('\n');
        let _ = crate::state::write_file_atomically_sync(&self.conversation_path(id), &text);
    }

    fn live(&self, id: &str, turn: u64, socket_id: u64) -> bool {
        let state = lock(&self.inner);
        state
            .conversations
            .get(id)
            .is_some_and(|conversation| conversation.live(turn, socket_id))
    }

    /// Relays one assistant chunk and records it as turn progress.
    fn text_callback(self: &Arc<Self>, socket: &Conn, id: &str) -> TextCallback {
        let mode = Arc::clone(self);
        let text_id = id.to_string();
        let text_socket = socket.clone();
        Arc::new(move |text: String| {
            let frame = {
                let mut state = lock(&mode.inner);
                match state.conversations.get_mut(&text_id) {
                    Some(conversation) if conversation.busy && !conversation.closed => {
                        conversation.last_progress = Instant::now();
                        conversation.answer.push_str(&text);
                        Some(json!({
                            "type": "askChunk",
                            "conversationId": conversation.id,
                            "text": text,
                        }))
                    }
                    _ => None,
                }
            };
            if let Some(frame) = frame {
                text_socket.send(frame);
            }
        })
    }

    /// Treats peer activity as turn progress without relaying it.
    fn activity_callback(self: &Arc<Self>, id: &str) -> ActivityCallback {
        let mode = Arc::clone(self);
        let activity_id = id.to_string();
        Arc::new(move |_activity: AcpActivity| {
            let mut state = lock(&mode.inner);
            if let Some(conversation) = state.conversations.get_mut(&activity_id) {
                if conversation.busy && !conversation.closed {
                    conversation.last_progress = Instant::now();
                }
            }
        })
    }

    /// Waits for one turn, ending it when the peer stops reporting progress
    /// or when the outer bound passes while it still reports.
    async fn await_turn<F>(self: &Arc<Self>, id: &str, future: F) -> TurnOutcome
    where
        F: Future<Output = TurnOutcome>,
    {
        tokio::pin!(future);
        let max_deadline = Instant::now() + self.turn_max;
        let mut ticker = tokio::time::interval(Duration::from_millis(100));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                outcome = &mut future => return outcome,
                _ = ticker.tick() => {
                    let silent_for = {
                        let state = lock(&self.inner);
                        state
                            .conversations
                            .get(id)
                            .map(|conversation| conversation.last_progress.elapsed())
                            .unwrap_or(self.turn_silence)
                    };
                    if silent_for >= self.turn_silence {
                        return TurnOutcome::Expired(Expiry::Silence);
                    }
                    if Instant::now() >= max_deadline {
                        return TurnOutcome::Expired(Expiry::Max);
                    }
                }
            }
        }
    }

    /// Builds the detached handle for one conversation's peer.
    fn detached(self: &Arc<Self>, socket: &Conn, id: &str, attach_only: bool) -> Arc<DetachedPeer> {
        let mut options = DetachedPeerOptions::new(
            self.repo_dir.clone(),
            self.state_dir.clone(),
            "ask",
            id.to_string(),
            self.instance.clone(),
            self.command.clone(),
            self.repo_dir.to_string_lossy().into_owned(),
        )
        .permission(PermissionPolicy::Deny)
        .multi(true)
        .attach_only(attach_only)
        .activity(self.activity_callback(id))
        .text(self.text_callback(socket, id));
        options.harness_version = self.harness_version.clone();
        DetachedPeer::new(options)
    }

    /// Opens one conversation turn: validates the request, admits it, and
    /// starts or attaches to its detached owner.
    async fn ask(
        self: &Arc<Self>,
        app: &Arc<App>,
        socket: &Conn,
        conversation_id: Option<&Value>,
        question: Option<&Value>,
        context: Option<&Value>,
    ) {
        let candidate = conversation_id.and_then(Value::as_str).unwrap_or("");
        let request = match parse_ask_request(conversation_id, question, context) {
            Ok(request) => request,
            Err(message) => {
                send_error(socket, candidate, &message);
                return;
            }
        };
        let id = request.conversation_id.clone();

        let refusal = {
            let state = lock(&self.inner);
            match state.conversations.get(&id) {
                Some(existing)
                    if existing
                        .socket
                        .as_ref()
                        .is_some_and(|owner| owner.id() != socket.id()) =>
                {
                    Some("This conversation belongs to another client.")
                }
                Some(existing) if existing.busy && existing.peer.is_some() => {
                    Some("The agent is still answering the previous question.")
                }
                _ => None,
            }
        };
        if let Some(message) = refusal {
            send_error(socket, &id, message);
            return;
        }

        // A replacement re-attaches to the turn that was already in flight.
        let (attached_turn, attach) = {
            let mut state = lock(&self.inner);
            let conversation = state
                .conversations
                .entry(id.clone())
                .or_insert_with(|| Conversation::new(id.clone()));
            conversation.socket = Some(socket.clone());
            conversation.closed = false;
            let attach = conversation.busy
                && conversation.last_prompt.is_some()
                && conversation.peer.is_none();
            (conversation.turn, attach)
        };

        if attach {
            let peer = self.detached(socket, &id, true);
            {
                let mut state = lock(&self.inner);
                if let Some(conversation) = state.conversations.get_mut(&id) {
                    conversation.peer = Some(Arc::clone(&peer));
                }
            }
            self.persist(&id);
            // Attachment begins polling only through `run`; the owner already
            // has the turn, so this settles with the run's own outcome.
            if let Err(message) = peer.run("").await {
                self.fail(&id, attached_turn, socket, &message);
                return;
            }
            match peer.wait_turn(attached_turn).await {
                Ok(()) => self.complete_attached(&id, attached_turn, socket),
                Err(message) => self.fail(&id, attached_turn, socket, &message),
            }
            return;
        }

        let (turn, first_turn, prompt) = {
            let mut state = lock(&self.inner);
            let conversation = state
                .conversations
                .entry(id.clone())
                .or_insert_with(|| Conversation::new(id.clone()));
            let first_turn = conversation.peer.as_ref().is_none_or(|peer| peer.closed());
            conversation.turn += 1;
            let turn = conversation.turn;
            conversation.busy = true;
            conversation.answer.clear();
            conversation.last_progress = Instant::now();
            conversation.transcript.push(TranscriptEntry {
                role: Role::Developer,
                text: request.question.clone(),
            });
            let earlier = &conversation.transcript[..conversation.transcript.len() - 1];
            let prompt = if first_turn {
                ask_prompt(&request, earlier)
            } else {
                follow_up_prompt(&request.question)
            };
            conversation.last_prompt = Some(prompt.clone());
            (turn, first_turn, prompt)
        };
        self.persist(&id);

        let outcome = self
            .await_turn(
                &id,
                self.run_turn(app, socket, &id, turn, first_turn, &prompt),
            )
            .await;

        match outcome {
            TurnOutcome::Done => self.complete(&id, turn, socket),
            TurnOutcome::Failed(message) => self.fail(&id, turn, socket, &message),
            TurnOutcome::Expired(expiry) => self.expire(&id, turn, socket, expiry),
            TurnOutcome::Dropped => {}
        }
    }

    /// Starts or reuses the detached peer and sends one prompt, relaying its
    /// text while the prompt is in flight.
    async fn run_turn(
        self: &Arc<Self>,
        app: &Arc<App>,
        socket: &Conn,
        id: &str,
        turn: u64,
        first_turn: bool,
        prompt: &str,
    ) -> TurnOutcome {
        if !first_turn {
            let peer = {
                let state = lock(&self.inner);
                state
                    .conversations
                    .get(id)
                    .and_then(|conversation| conversation.peer.clone())
            };
            let Some(peer) = peer else {
                return TurnOutcome::Failed("The agent process is not running.".to_string());
            };
            return match peer.prompt(prompt).await {
                Ok(()) => TurnOutcome::Done,
                Err(message) => TurnOutcome::Failed(message),
            };
        }

        let environment = match app.providers.select_environment().await {
            Ok(environment) => environment,
            Err(error) => return TurnOutcome::Failed(error.message),
        };
        // A close, disconnect, or deadline during provider selection ends the
        // turn without a process.
        if !self.live(id, turn, socket.id()) {
            return TurnOutcome::Dropped;
        }
        let environment: HashMap<String, String> = environment
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect();
        let mut options = DetachedPeerOptions::new(
            self.repo_dir.clone(),
            self.state_dir.clone(),
            "ask",
            id.to_string(),
            self.instance.clone(),
            self.command.clone(),
            self.repo_dir.to_string_lossy().into_owned(),
        )
        .permission(PermissionPolicy::Deny)
        .multi(true)
        .env(environment)
        .activity(self.activity_callback(id))
        .text(self.text_callback(socket, id));
        options.harness_version = self.harness_version.clone();
        let created = DetachedPeer::new(options);
        {
            let mut state = lock(&self.inner);
            match state.conversations.get_mut(id) {
                Some(conversation) if conversation.live(turn, socket.id()) => {
                    if let Some(previous) = conversation.peer.take() {
                        previous.close();
                    }
                    conversation.peer = Some(Arc::clone(&created));
                }
                _ => {
                    created.close();
                    return TurnOutcome::Dropped;
                }
            }
        }
        match created.run(prompt).await {
            Ok(_) => TurnOutcome::Done,
            Err(message) => TurnOutcome::Failed(message),
        }
    }

    /// Settles a finished turn and appends the answer it streamed.
    fn complete(&self, id: &str, turn: u64, socket: &Conn) {
        self.complete_turn(id, turn, socket, None)
    }

    /// Settles a turn a replacement dashboard re-attached to.
    fn complete_attached(&self, id: &str, turn: u64, socket: &Conn) {
        self.complete_turn(id, turn, socket, Some(turn))
    }

    fn complete_turn(&self, id: &str, turn: u64, socket: &Conn, _attached: Option<u64>) {
        let frame = {
            let mut state = lock(&self.inner);
            let Some(conversation) = state.conversations.get_mut(id) else {
                return;
            };
            if !conversation.live(turn, socket.id()) {
                return;
            }
            conversation.busy = false;
            if !js_trim(&conversation.answer).is_empty() {
                conversation.transcript.push(TranscriptEntry {
                    role: Role::Agent,
                    text: conversation.answer.clone(),
                });
            }
            conversation.answer.clear();
            json!({"type": "askDone", "conversationId": conversation.id})
        };
        self.persist(id);
        socket.send(frame);
    }

    /// Reports one failed turn; a peer that is gone needs a fresh owner, a
    /// live peer that refused one turn keeps its session.
    fn fail(&self, id: &str, turn: u64, socket: &Conn, message: &str) {
        let frame = {
            let mut state = lock(&self.inner);
            let Some(conversation) = state.conversations.get_mut(id) else {
                return;
            };
            if !conversation.live(turn, socket.id()) {
                return;
            }
            conversation.busy = false;
            let stale = conversation
                .peer
                .as_ref()
                .is_some_and(|peer| peer.closed() || peer.pid().is_none());
            if stale {
                if let Some(peer) = conversation.peer.take() {
                    peer.close();
                }
            }
            json!({
                "type": "askError",
                "conversationId": conversation.id,
                "message": message,
            })
        };
        self.persist(id);
        socket.send(frame);
    }

    /// Ends a turn the deadline invalidated, dropping its peer.
    fn expire(&self, id: &str, turn: u64, socket: &Conn, expiry: Expiry) {
        let frame = {
            let mut state = lock(&self.inner);
            let Some(conversation) = state.conversations.get_mut(id) else {
                return;
            };
            if !conversation.live(turn, socket.id()) {
                return;
            }
            conversation.turn += 1;
            conversation.busy = false;
            conversation.answer.clear();
            if let Some(peer) = conversation.peer.take() {
                peer.close();
            }
            json!({
                "type": "askError",
                "conversationId": conversation.id,
                "message": expiry_message(expiry),
            })
        };
        self.persist(id);
        socket.send(frame);
    }

    /// Closes one conversation and stops its run; a stale id is ignored.
    fn close(&self, socket: &Conn, conversation_id: Option<&Value>) {
        let Some(id) = conversation_id.and_then(Value::as_str) else {
            return;
        };
        {
            let state = lock(&self.inner);
            let Some(conversation) = state.conversations.get(id) else {
                return;
            };
            if !socket.is_request()
                && conversation
                    .socket
                    .as_ref()
                    .is_some_and(|owner| owner.id() != socket.id())
            {
                return;
            }
        }
        self.discard(id);
    }

    /// Drops every conversation this connection owned. A replacement keeps
    /// them, so the reconnected page re-attaches to the turn in flight.
    fn discard_owned_by(&self, socket: &Conn) {
        let owned: Vec<String> = {
            let state = lock(&self.inner);
            state
                .conversations
                .values()
                .filter(|conversation| {
                    conversation
                        .socket
                        .as_ref()
                        .is_some_and(|owner| owner.id() == socket.id())
                })
                .map(|conversation| conversation.id.clone())
                .collect()
        };
        let restarting = crate::detached_run::in_detached_handoff(&self.repo_dir, &self.instance);
        for id in owned {
            if restarting {
                let mut state = lock(&self.inner);
                if let Some(conversation) = state.conversations.get_mut(&id) {
                    conversation.socket = None;
                }
                drop(state);
                self.persist(&id);
            } else {
                self.discard(&id);
            }
        }
    }

    fn discard(&self, id: &str) {
        {
            let mut state = lock(&self.inner);
            let Some(mut conversation) = state.conversations.remove(id) else {
                return;
            };
            conversation.closed = true;
            conversation.busy = false;
            conversation.turn += 1;
            conversation.answer.clear();
            conversation.transcript.clear();
            conversation.last_prompt = None;
            if let Some(peer) = conversation.peer.take() {
                peer.close();
            }
        }
        let _ = std::fs::remove_file(self.conversation_path(id));
    }
}

enum TurnOutcome {
    /// The peer settled the turn.
    Done,
    /// The turn ended without a visible answer.
    Dropped,
    /// The peer or the provider selection refused the turn.
    Failed(String),
    /// A bound ended the turn.
    Expired(Expiry),
}

/// Which bound ended a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expiry {
    /// The peer streamed nothing for the silence window.
    Silence,
    /// The turn reached its outer bound while still reporting progress.
    Max,
}

/// The ask error a bound produces.
fn expiry_message(expiry: Expiry) -> String {
    match expiry {
        Expiry::Silence => format!(
            "The ask agent did not answer within {}.",
            timeout_label(ASK_TURN_SILENCE_MS)
        ),
        Expiry::Max => format!(
            "The ask agent did not finish within {}.",
            minutes_label(ASK_TURN_MAX_MS)
        ),
    }
}

fn send_error(socket: &Conn, conversation_id: &str, message: &str) {
    socket.send(json!({
        "type": "askError",
        "conversationId": conversation_id,
        "message": message,
    }));
}

/// Registers this mode's durable state with the dashboard.
pub fn init(app: &Arc<App>) {
    let mode = Arc::new(AskMode::new(app));
    let mut modes = lock(&MODES);
    modes.retain(|(weak, _)| weak.strong_count() > 0);
    modes.push((Arc::downgrade(app), mode));
}

/// The mode serving one application, created on demand for a dashboard that
/// was built without [`init`].
fn mode_for(app: &Arc<App>) -> Arc<AskMode> {
    let mut modes = lock(&MODES);
    modes.retain(|(weak, _)| weak.strong_count() > 0);
    if let Some((_, mode)) = modes
        .iter()
        .find(|(weak, _)| weak.as_ptr() == Arc::as_ptr(app))
    {
        return Arc::clone(mode);
    }
    let mode = Arc::new(AskMode::new(app));
    modes.push((Arc::downgrade(app), Arc::clone(&mode)));
    mode
}

/// Replays the frames a connecting client owes before its own replies.
///
/// An Ask conversation answers only the client that asked, so a new connection
/// owes no frame.
pub fn replay(_app: &Arc<App>, _conn: &Conn) {}

/// Drops the conversations one closed socket owned.
pub fn disconnect(app: &Arc<App>, conn: &Conn) {
    mode_for(app).discard_owned_by(conn);
}

/// Applies one command; `false` when it belongs to another mode.
pub async fn handle(app: &Arc<App>, conn: &Conn, command: &Command) -> bool {
    match command {
        Command::Ask {
            conversation_id,
            question,
            context,
        } => {
            let mode = mode_for(app);
            mode.ask(
                app,
                conn,
                conversation_id.as_ref(),
                question.as_ref(),
                context.as_ref(),
            )
            .await;
            true
        }
        Command::CloseAsk { conversation_id } => {
            mode_for(app).close(conn, conversation_id.as_ref());
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> Value {
        json!({
            "route": "/issues",
            "url": "http://127.0.0.1:8080/issues",
            "selector": "#issues-indicator",
            "viewport": "1280x800",
            "captured_at": "2026-11-03T12:00:00.000Z",
            "visible_text": "Issues",
            "dom_excerpt": "<button id=\"issues-indicator\">Issues</button>",
        })
    }

    fn request(id: &str, question: &str) -> AskRequest {
        parse_ask_request(Some(&json!(id)), Some(&json!(question)), Some(&captured()))
            .expect("a valid ask")
    }

    /// One mode with a busy conversation and short test bounds.
    fn mode_with_timeouts(silence: Duration, max: Duration) -> Arc<AskMode> {
        let mut conversation = Conversation::new("conversation".to_string());
        conversation.busy = true;
        let mut conversations = HashMap::new();
        conversations.insert("conversation".to_string(), conversation);
        Arc::new(AskMode {
            state_dir: PathBuf::from("state"),
            repo_dir: PathBuf::from("repo"),
            command: "omp acp".to_string(),
            instance: "test".to_string(),
            harness_version: None,
            turn_silence: silence,
            turn_max: max,
            inner: Mutex::new(Inner { conversations }),
        })
    }

    fn last_progress(mode: &AskMode) -> Instant {
        lock(&mode.inner)
            .conversations
            .get("conversation")
            .expect("the fixture conversation")
            .last_progress
    }

    #[test]
    fn the_deadline_labels_name_each_bound() {
        assert_eq!(timeout_label(ASK_TURN_SILENCE_MS), "120 seconds");
        assert_eq!(timeout_label(1_500), "1500ms");
        assert_eq!(timeout_label(1_000), "1 seconds");
        assert_eq!(minutes_label(ASK_TURN_MAX_MS), "15 minutes");
        assert_eq!(
            expiry_message(Expiry::Silence),
            "The ask agent did not answer within 120 seconds."
        );
        assert_eq!(
            expiry_message(Expiry::Max),
            "The ask agent did not finish within 15 minutes."
        );
    }

    #[tokio::test]
    async fn a_stalled_turn_expires_after_the_silence_window() {
        let mode = mode_with_timeouts(Duration::from_millis(80), Duration::from_secs(5));
        let outcome = mode
            .await_turn("conversation", std::future::pending::<TurnOutcome>())
            .await;
        assert!(matches!(outcome, TurnOutcome::Expired(Expiry::Silence)));
    }

    #[tokio::test]
    async fn a_turn_reporting_progress_outlives_the_silence_window() {
        let mode = mode_with_timeouts(Duration::from_millis(80), Duration::from_secs(5));
        let progress = Arc::clone(&mode);
        let future = async move {
            for _ in 0..4 {
                tokio::time::sleep(Duration::from_millis(30)).await;
                lock(&progress.inner)
                    .conversations
                    .get_mut("conversation")
                    .expect("the fixture conversation")
                    .last_progress = Instant::now();
            }
            TurnOutcome::Done
        };
        let outcome = mode.await_turn("conversation", future).await;
        assert!(matches!(outcome, TurnOutcome::Done));
    }

    #[tokio::test]
    async fn a_turn_reporting_progress_still_hits_the_outer_bound() {
        let mode = mode_with_timeouts(Duration::from_secs(5), Duration::from_millis(150));
        let progress = Arc::clone(&mode);
        let future = async move {
            for _ in 0..100 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                lock(&progress.inner)
                    .conversations
                    .get_mut("conversation")
                    .expect("the fixture conversation")
                    .last_progress = Instant::now();
            }
            TurnOutcome::Done
        };
        let outcome = mode.await_turn("conversation", future).await;
        assert!(matches!(outcome, TurnOutcome::Expired(Expiry::Max)));
    }

    #[tokio::test]
    async fn streamed_text_and_activity_mark_turn_progress() {
        let mode = mode_with_timeouts(Duration::from_secs(5), Duration::from_secs(10));
        let (outbox, mut inbox) = tokio::sync::mpsc::unbounded_channel();
        let socket = Conn::new(outbox);

        let before = last_progress(&mode);
        tokio::time::sleep(Duration::from_millis(5)).await;
        mode.text_callback(&socket, "conversation")("An answer.".to_string());
        assert!(last_progress(&mode) > before);
        let frame = inbox.try_recv().expect("one askChunk frame");
        let frame: Value = serde_json::from_str(&frame).expect("a JSON frame");
        assert_eq!(frame["type"], "askChunk");
        assert_eq!(frame["text"], "An answer.");

        let before = last_progress(&mode);
        tokio::time::sleep(Duration::from_millis(5)).await;
        mode.activity_callback("conversation")(AcpActivity {
            text: "Reading the captured element".to_string(),
            append: false,
        });
        assert!(last_progress(&mode) > before);
        assert!(inbox.try_recv().is_err(), "activity stays off the wire");
    }

    #[test]
    fn refusals_carry_the_typescript_messages() {
        let context = captured();
        let refuse = |id: Option<Value>, question: Option<Value>, context: Option<Value>| {
            parse_ask_request(id.as_ref(), question.as_ref(), context.as_ref())
                .expect_err("a refused ask")
        };
        assert_eq!(
            refuse(None, Some(json!("What?")), Some(context.clone())),
            "The ask has no conversation id."
        );
        assert_eq!(
            refuse(
                Some(json!("   ")),
                Some(json!("What?")),
                Some(context.clone())
            ),
            "The conversation id must be 1-200 characters."
        );
        assert_eq!(
            refuse(
                Some(json!("i".repeat(MAX_CONVERSATION_ID + 1))),
                Some(json!("What?")),
                Some(context.clone())
            ),
            "The conversation id must be 1-200 characters."
        );
        assert_eq!(
            refuse(Some(json!("id")), None, Some(context.clone())),
            "The ask has no question."
        );
        assert_eq!(
            refuse(Some(json!("id")), Some(json!("   ")), Some(context.clone())),
            "The question is empty."
        );
        assert_eq!(
            refuse(
                Some(json!("id")),
                Some(json!("q".repeat(MAX_QUESTION + 1))),
                Some(context.clone())
            ),
            "The question is longer than 4000 characters."
        );
        assert_eq!(
            refuse(Some(json!("id")), Some(json!("What?")), None),
            "The ask has no element context."
        );
        let mut missing = context.as_object().cloned().expect("an object");
        missing.remove("selector");
        assert_eq!(
            refuse(
                Some(json!("id")),
                Some(json!("What?")),
                Some(Value::Object(missing))
            ),
            "The ask context is missing selector."
        );
        assert_eq!(
            refuse(Some(json!("id")), Some(json!("What?")), Some(json!([1, 2]))),
            "The ask context is missing route."
        );
        assert_eq!(
            refuse(
                Some(json!("id")),
                Some(json!("What?")),
                Some(json!("a string"))
            ),
            "The ask has no element context."
        );
        let mut long = context.as_object().cloned().expect("an object");
        long.insert("dom_excerpt".to_string(), json!("x".repeat(4001)));
        assert_eq!(
            refuse(
                Some(json!("id")),
                Some(json!("What?")),
                Some(Value::Object(long))
            ),
            "The ask context dom_excerpt is longer than 4000."
        );
    }

    #[test]
    fn the_id_and_question_are_trimmed() {
        let parsed = parse_ask_request(
            Some(&json!("  conversation  ")),
            Some(&json!("\n What? \t")),
            Some(&captured()),
        )
        .expect("a valid ask");
        assert_eq!(parsed.conversation_id, "conversation");
        assert_eq!(parsed.question, "What?");
    }

    #[test]
    fn the_first_prompt_frames_the_captured_context() {
        let prompt = ask_prompt(&request("id", "What does it show?"), &[]);
        assert_eq!(
            prompt,
            [
                "You are answering a question about a UI element in the running Devboard \
                 interface.",
                "Answer from the captured context and this conversation; change nothing.",
                "",
                READ_ONLY_SENTENCE,
                BREVITY_SENTENCE,
                PLAIN_SENTENCE,
                "",
                "Question: What does it show?",
                "",
                "Captured element context:",
                "route: /issues",
                "url: http://127.0.0.1:8080/issues",
                "selector: #issues-indicator",
                "viewport: 1280x800",
                "captured_at: 2026-11-03T12:00:00.000Z",
                "visible_text: Issues",
                "dom_excerpt: <button id=\"issues-indicator\">Issues</button>",
            ]
            .join("\n")
        );
    }

    #[test]
    fn earlier_turns_precede_the_question() {
        let transcript = vec![
            TranscriptEntry {
                role: Role::Developer,
                text: "First?".to_string(),
            },
            TranscriptEntry {
                role: Role::Agent,
                text: "An answer.".to_string(),
            },
        ];
        let prompt = ask_prompt(&request("id", "Second?"), &transcript);
        assert!(prompt.contains(
            "Earlier in this conversation:\nDeveloper: First?\nAgent: An answer.\n\nQuestion: \
             Second?"
        ));
    }

    #[test]
    fn a_follow_up_repeats_the_instructions_only() {
        let prompt = follow_up_prompt("Second?");
        assert_eq!(
            prompt,
            [
                READ_ONLY_SENTENCE,
                BREVITY_SENTENCE,
                PLAIN_SENTENCE,
                "",
                "Question: Second?",
            ]
            .join("\n")
        );
    }
}
