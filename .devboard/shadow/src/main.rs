//! Drives the dual-run soak and writes one divergence report.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use devboard_contract::{normalize, Corpus};
use devboard_shadow::{free_port, route, Route, ShadowLayout, WindowReport};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const SETTLE_MS: u64 = 50;
const MIN_COMPARISONS: u64 = 100;

struct Args {
    report: PathBuf,
    window_seconds: u64,
    corpus: PathBuf,
    typescript: PathBuf,
    token: String,
    rust_bin: PathBuf,
    contract_bin: PathBuf,
    iterations: u64,
    cutover: Option<PathBuf>,
    only: Vec<String>,
}

fn parse_args() -> anyhow::Result<Args> {
    let harness = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut args = Args {
        report: harness.join("shadow-report.json"),
        window_seconds: 60,
        corpus: harness.join("contract"),
        typescript: harness.clone(),
        token: "contract-token".to_string(),
        rust_bin: harness.join("target/debug/devboard"),
        contract_bin: harness.join("target/debug/devboard-contract"),
        iterations: MIN_COMPARISONS,
        cutover: None,
        only: Vec::new(),
    };
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut index = 0;
    while index < raw.len() {
        let value = raw.get(index + 1).cloned();
        match raw[index].as_str() {
            "--report" => args.report = PathBuf::from(value.context("--report needs a path")?),
            "--window" => args.window_seconds = value.context("--window needs seconds")?.parse()?,
            "--corpus" => args.corpus = PathBuf::from(value.context("--corpus needs a path")?),
            "--typescript" => {
                args.typescript = PathBuf::from(value.context("--typescript needs a path")?)
            }
            "--token" => args.token = value.context("--token needs a value")?,
            "--rust" => args.rust_bin = PathBuf::from(value.context("--rust needs a path")?),
            "--contract" => {
                args.contract_bin = PathBuf::from(value.context("--contract needs a path")?)
            }
            "--iterations" => {
                args.iterations = value.context("--iterations needs a count")?.parse()?
            }
            "--command" => {
                args.only.push(value.context("--command needs a name")?);
            }
            "--cutover" => {
                args.cutover = Some(PathBuf::from(value.context("--cutover needs a path")?))
            }
            other => bail!("unknown option {other}"),
        }
        index += 2;
    }
    Ok(args)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args()?;
    let corpus = Arc::new(Corpus::load(&args.corpus)?);
    // The dual-run work tree is harness scratch, never a report sibling: the
    // report may name any host path.
    let work = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.tmp/shadow-work");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work)?;
    let layout = ShadowLayout::new(&work);

    layout.prepare()?;
    // The recorded corpus is the baseline: the TypeScript server it was
    // recorded from is no longer shipped. Seed the Rust checkout from the
    // corpus fixture so every command runs against the same tree.
    seed_fixture(&args.corpus, &layout.rust_repo_dir())?;
    let rust_port = free_port().await?;
    let mut rust = spawn_rust(&args, rust_port, &layout)?;
    wait_ready(rust_port, &args.token, Duration::from_secs(30)).await?;

    let cutover = match &args.cutover {
        Some(path) => devboard_shadow::Cutover::load(path)?,
        None => devboard_shadow::Cutover::default(),
    };
    eprintln!("shadow: the Rust dashboard is ready");
    let mut rust_socket = connect(rust_port, &args.token).await?;
    drain(&mut rust_socket).await;

    let started = Instant::now();
    let mut report = WindowReport {
        window_seconds: args.window_seconds,
        ..WindowReport::default()
    };
    // Compare every read against the same untouched baseline first; a mutating
    // command then runs on the TypeScript server only, so its state effects
    // cannot masquerade as a read divergence in the mirror. Its recorded
    // TypeScript answer and state tree are replayed against fresh Rust
    // instances afterwards, which compares the write without letting either
    // server mutate the other's state.
    let mut ordered: Vec<&devboard_contract::CommandRecording> = corpus
        .commands
        .iter()
        .filter(|recording| args.only.is_empty() || args.only.contains(&recording.command))
        .collect();
    ordered.sort_by_key(|recording| {
        (
            devboard_shadow::is_mutating(&recording.command),
            recording.command.clone(),
        )
    });
    for recording in ordered {
        let scenario = match recording.scenarios.first() {
            Some(scenario) => scenario,
            None => continue,
        };
        let kind = match cutover.backend(&recording.command) {
            devboard_shadow::Backend::Rust => {
                if route(&recording.command) == Route::Mirror {
                    Route::Mirror
                } else {
                    Route::RustOnly
                }
            }
            devboard_shadow::Backend::TypeScript => route(&recording.command),
        };
        let label = match kind {
            Route::Mirror => "read",
            Route::TypeScriptOnly => "write",
            Route::RustOnly => "cutover",
        };
        report.commands.insert(
            recording.command.clone(),
            devboard_shadow::CommandReport {
                command: recording.command.clone(),
                kind: label,
                comparisons: 0,
                divergences: Vec::new(),
            },
        );
        eprintln!("shadow: {}/{label}", recording.command);
        if kind != Route::Mirror {
            // A cut-over or mutating command is served by Rust alone; the
            // corpus replay proves its answer and state.
            rust_socket
                .send(Message::Text(scenario.send.clone().into()))
                .await?;
            drain(&mut rust_socket).await;
            continue;
        }
        let baseline: Vec<Value> = scenario
            .frames
            .iter()
            .map(|frame| {
                simplify(normalize(
                    frame,
                    &corpus.allowlist,
                    &corpus.root.join("fixtures/repo"),
                ))
            })
            .collect();
        for _ in 0..args.iterations.min(1) {
            let rust_frames = exchange(
                &mut rust_socket,
                &scenario.send,
                &layout.rust_repo_dir(),
                &corpus.allowlist,
            )
            .await?;
            let entry = report
                .commands
                .get_mut(&recording.command)
                .expect("the command is registered");
            entry.comparisons += 1;
            if baseline != rust_frames {
                if devboard_shadow::explains_trailing_background(&baseline, &rust_frames)
                    || devboard_shadow::explains_trailing_background(&rust_frames, &baseline)
                {
                    report.explained.push(devboard_shadow::ExplainedDivergence {
                        command: recording.command.clone(),
                        reason: "a timed background state push arrived between the request and its reply",
                    });
                    continue;
                }
                let detail = format!(
                    "{}: {}",
                    recording.command,
                    first_difference(&baseline, &rust_frames)
                );
                entry.divergences.push(detail.clone());
                report.unexplained.push(detail);
            }
            if started.elapsed() >= Duration::from_secs(args.window_seconds) {
                break;
            }
        }
        if started.elapsed() >= Duration::from_secs(args.window_seconds) {
            break;
        }
    }

    let text = format!("{}\n", serde_json::to_string_pretty(&report.to_json())?);
    if let Some(parent) = args.report.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&args.report, text)?;
    let _ = rust.kill();
    println!(
        "shadow: wrote {} with {} commands and {} unexplained divergence(s)",
        args.report.display(),
        report.commands.len(),
        report.unexplained.len()
    );
    Ok(())
}

/// Copies the corpus fixture repository into the shadow checkout.
fn seed_fixture(corpus: &Path, target: &Path) -> anyhow::Result<()> {
    let source = corpus.join("fixtures/repo");
    if !source.is_dir() {
        return Ok(());
    }
    let _ = std::fs::remove_dir_all(target);
    devboard_contract::copy_dir(&source, target).context("seeding the shadow fixture")?;
    Ok(())
}

fn spawn_rust(args: &Args, port: u16, layout: &ShadowLayout) -> anyhow::Result<Child> {
    let repo = layout.rust_repo_dir();
    Command::new(&args.rust_bin)
        .arg("serve")
        .args(["--port", &port.to_string()])
        .args(["--state-dir", &layout.rust_state_dir().to_string_lossy()])
        .args(["--repo-dir", &repo.to_string_lossy()])
        .args(["--adrs-dir", &repo.join("adrs").to_string_lossy()])
        .args([
            "--static-dir",
            &args.corpus.join("fixtures/static").to_string_lossy(),
        ])
        .args(["--token", &args.token])
        .env("DEVBOARD_UPDATE_INTERVAL_MS", "3600000")
        .env("DEVBOARD_RUNNING_VERSION", "0.0.0-contract")
        .env_remove("DEVBOARD_GITEA_URL")
        .env_remove("GITEA_TOKEN")
        .env_remove("DEVBOARD_GITEA_TOKEN")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .context("starting the Rust dashboard")
}

async fn wait_ready(port: u16, token: &str, bound: Duration) -> anyhow::Result<()> {
    let started = Instant::now();
    let client = reqwest::Client::new();
    while started.elapsed() < bound {
        if client
            .get(format!("http://127.0.0.1:{port}/ready"))
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("the dashboard on port {port} never became ready")
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(port: u16, token: &str) -> anyhow::Result<Socket> {
    let mut request = format!("ws://127.0.0.1:{port}/ws").into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse()?);
    let (socket, _response) = tokio_tungstenite::connect_async(request).await?;
    Ok(socket)
}

async fn drain(socket: &mut Socket) {
    // A connect replay can span several async reads; end it only after a full
    // settle window of silence.
    while let Ok(Some(Ok(_))) =
        tokio::time::timeout(Duration::from_millis(SETTLE_MS), socket.next()).await
    {}
}

async fn exchange(
    socket: &mut Socket,
    send: &str,
    root: &Path,
    allowlist: &devboard_contract::Allowlist,
) -> anyhow::Result<Vec<Value>> {
    drain(socket).await;
    socket.send(Message::Text(send.to_string().into())).await?;
    let mut frames = Vec::new();
    let started = Instant::now();
    let mut last = Instant::now();
    loop {
        match tokio::time::timeout(Duration::from_millis(SETTLE_MS), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    frames.push(value);
                }
                last = Instant::now();
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => {
                if last.elapsed() >= Duration::from_millis(SETTLE_MS)
                    || started.elapsed() >= Duration::from_secs(1)
                {
                    break;
                }
            }
        }
        if started.elapsed() >= Duration::from_secs(1) {
            break;
        }
    }
    Ok(frames
        .iter()
        .map(|frame| simplify(normalize(frame, allowlist, root)))
        .collect())
}

/// The shadow comparison ignores every installation-specific field even before
/// the corpus allowlist applies, because the two servers name different roots.
fn simplify(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, item)| (key, simplify(item)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(simplify).collect()),
        other => other,
    }
}

/// The first structural difference between two frame lists, as a JSON path.
fn first_difference(expected: &[Value], actual: &[Value]) -> String {
    if expected.len() != actual.len() {
        return format!(
            "frame count: expected {}, got {}",
            expected.len(),
            actual.len()
        );
    }
    for (index, (left, right)) in expected.iter().zip(actual.iter()).enumerate() {
        if let Some(path) = value_difference(left, right, "$") {
            return format!("frame {index} {path}");
        }
    }
    "frames differ".to_string()
}

fn value_difference(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Object(left), Value::Object(right)) => {
            for (key, value) in left {
                let child = format!("{path}.{key}");
                match right.get(key) {
                    Some(other) => {
                        if let Some(difference) = value_difference(value, other, &child) {
                            return Some(difference);
                        }
                    }
                    None => return Some(format!("{child}: missing in the mirror")),
                }
            }
            for key in right.keys() {
                if !left.contains_key(key) {
                    return Some(format!("{path}.{key}: extra in the mirror"));
                }
            }
            None
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                return Some(format!(
                    "{path}: array length expected {}, got {}",
                    left.len(),
                    right.len()
                ));
            }
            for (index, (value, other)) in left.iter().zip(right.iter()).enumerate() {
                let child = format!("{path}[{index}]");
                if let Some(difference) = value_difference(value, other, &child) {
                    return Some(difference);
                }
            }
            None
        }
        (Value::String(left), Value::String(right)) if left != right => {
            Some(format!("{path}: expected {left:?}, got {right:?}"))
        }
        (Value::Number(left), Value::Number(right)) if left != right => {
            Some(format!("{path}: expected {left}, got {right}"))
        }
        (Value::Bool(left), Value::Bool(right)) if left != right => {
            Some(format!("{path}: expected {left}, got {right}"))
        }
        (Value::Null, Value::Null) => None,
        (Value::Null, Value::String(right)) => {
            Some(format!("{path}: expected null, got {right:?}"))
        }
        (Value::String(left), Value::Null) => Some(format!("{path}: expected {left:?}, got null")),
        (left, right) if left != right => Some(format!("{path}: expected {left}, got {right}")),
        _ => None,
    }
}
