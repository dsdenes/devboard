//! REST read latency measurement against one running dashboard.

use std::time::Instant;

use serde_json::{json, Value};

/// Measures round-trip latency for one named read operation and returns the
/// summary, naming the HTTP method and path it measured.
pub async fn measure(port: u16, iterations: u64, command: &str) -> anyhow::Result<Value> {
    let (method, path, _body) =
        crate::rest::request_for_command(&json!({"type": command})).map_err(anyhow::Error::msg)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .build()?;
    let url = format!("http://127.0.0.1:{port}{path}");
    let mut samples: Vec<f64> = Vec::with_capacity(iterations as usize);
    for _ in 0..iterations {
        let started = Instant::now();
        let response = client
            .request(method.clone(), &url)
            .header("accept", "application/json")
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!(
                "{} {} answered HTTP {}",
                method.as_str(),
                path,
                response.status().as_u16()
            );
        }
        let _ = response.bytes().await?;
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    Ok(json!({
        "command": command,
        "method": method.as_str(),
        "path": path,
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
