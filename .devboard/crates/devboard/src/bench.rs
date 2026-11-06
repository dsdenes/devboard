//! Read-command latency measurement against one running dashboard.

use std::time::{Duration, Instant};

use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// Measures round-trip latency for one read command and returns the summary.
pub async fn measure(port: u16, iterations: u64, command: &str) -> anyhow::Result<Value> {
    let request = format!("ws://127.0.0.1:{port}/ws").into_client_request()?;
    let (mut socket, _response) = tokio_tungstenite::connect_async(request)
        .await
        .context("connecting the benchmark socket")?;
    drain(&mut socket).await;
    let frame = format!(
        "{{\"type\":{}}}",
        crate::jsjson::stringify(&Value::String(command.to_string()))
    );
    let mut samples: Vec<f64> = Vec::with_capacity(iterations as usize);
    for _ in 0..iterations {
        let started = Instant::now();
        socket
            .send(Message::Text(frame.clone().into()))
            .await
            .context("sending a benchmark frame")?;
        loop {
            match tokio::time::timeout(Duration::from_secs(10), socket.next()).await {
                Ok(Some(Ok(Message::Text(_)))) => break,
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(error))) => anyhow::bail!("the benchmark socket failed: {error}"),
                Ok(None) => anyhow::bail!("the benchmark socket closed"),
                Err(_) => anyhow::bail!("the benchmark frame never answered"),
            }
        }
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let _ = socket.close(None).await;
    samples.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    Ok(json!({
        "command": command,
        "iterations": iterations,
        "p50Ms": percentile(&samples, 50.0),
        "p95Ms": percentile(&samples, 95.0),
    }))
}

fn percentile(samples: &[f64], percentile: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let index = ((percentile / 100.0) * (samples.len() as f64 - 1.0)).round() as usize;
    samples[index.min(samples.len() - 1)]
}

async fn drain(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(500) {
        match tokio::time::timeout(Duration::from_millis(50), socket.next()).await {
            Ok(Some(Ok(_))) => continue,
            _ => break,
        }
    }
}
