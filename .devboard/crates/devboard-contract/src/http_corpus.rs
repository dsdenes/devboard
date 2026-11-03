//! The recorded HTTP table, replayed against the Rust dashboard.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Context;
use serde_json::Value;

use crate::Allowlist;

/// One recorded HTTP case.
#[derive(Debug, Clone)]
pub struct HttpCase {
    pub name: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub request_headers: BTreeMap<String, String>,
    pub request_body: String,
    pub body: String,
}

/// Loads every recorded HTTP case, sorted by name.
pub fn load(root: &Path) -> anyhow::Result<Vec<HttpCase>> {
    let directory = root.join("http");
    let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(&directory)
        .with_context(|| format!("reading {}", directory.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect();
    paths.sort();
    let mut cases = Vec::new();
    for path in paths {
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        let mut headers = BTreeMap::new();
        if let Some(entries) = value.get("headers").and_then(Value::as_object) {
            for (name, header) in entries {
                if let Some(header) = header.as_str() {
                    headers.insert(name.to_ascii_lowercase(), header.to_string());
                }
            }
        }
        let mut request_headers = BTreeMap::new();
        if let Some(entries) = value.get("requestHeaders").and_then(Value::as_object) {
            for (name, header) in entries {
                if let Some(header) = header.as_str() {
                    request_headers.insert(name.to_ascii_lowercase(), header.to_string());
                }
            }
        }
        cases.push(HttpCase {
            name: value
                .get("name")
                .and_then(Value::as_str)
                .context("a case name")?
                .to_string(),
            method: value
                .get("method")
                .and_then(Value::as_str)
                .context("a method")?
                .to_string(),
            path: value
                .get("path")
                .and_then(Value::as_str)
                .context("a path")?
                .to_string(),
            status: value.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
            headers,
            request_headers,
            request_body: value
                .get("requestBody")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            body: value
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(cases)
}

/// Replays every case against one dashboard base URL.
pub async fn replay(
    base: &str,
    token: &str,
    cases: &[HttpCase],
    allowlist: &Allowlist,
    root: &Path,
) -> Vec<String> {
    let client = RawClient;
    let mut failures = Vec::new();
    for case in cases {
        match run_case(&client, base, token, case, allowlist, root).await {
            Ok(()) => {}
            Err(error) => failures.push(error),
        }
    }
    failures
}

async fn run_case(
    client: &RawClient,
    base: &str,
    token: &str,
    case: &HttpCase,
    allowlist: &Allowlist,
    root: &Path,
) -> Result<(), String> {
    let response = client
        .request(base, case, token)
        .await
        .map_err(|error| format!("{}: {error}", case.name))?;
    if response.status != case.status {
        return Err(format!(
            "{}: expected status {}, got {}",
            case.name, case.status, response.status
        ));
    }
    for name in [
        "content-type",
        "allow",
        "cache-control",
        "content-encoding",
        "vary",
    ] {
        if let Some(expected) = case.headers.get(name) {
            if response.headers.get(name) != Some(expected) {
                return Err(format!(
                    "{}: {name} expected {expected:?}, got {:?}",
                    case.name,
                    response.headers.get(name)
                ));
            }
        }
    }
    if case.headers.contains_key("set-cookie") && !response.headers.contains_key("set-cookie") {
        return Err(format!("{}: expected a Set-Cookie header", case.name));
    }
    let expected = normalized_body(&case.body, allowlist, root);
    let actual = normalized_body(&response.body, allowlist, root);
    if expected != actual {
        return Err(format!(
            "{}: body expected {expected:?}, got {actual:?}",
            case.name
        ));
    }
    Ok(())
}

/// A raw HTTP/1.1 client, so a case controls the exact Host and Origin bytes.
struct RawClient;

struct RawResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

impl RawClient {
    async fn request(
        &self,
        base: &str,
        case: &HttpCase,
        token: &str,
    ) -> anyhow::Result<RawResponse> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let address = base.trim_start_matches("http://");
        let mut headers = BTreeMap::new();
        let request_headers = if case.request_headers.is_empty() {
            &case.headers
        } else {
            &case.request_headers
        };
        for (name, value) in request_headers {
            let value = if name == "authorization" && value.contains("contract-token") {
                format!("Bearer {token}")
            } else {
                value.clone()
            };
            headers.insert(name.clone(), value);
        }
        headers
            .entry("host".to_string())
            .or_insert_with(|| address.to_string());
        headers
            .entry("connection".to_string())
            .or_insert_with(|| "close".to_string());
        if !case.request_body.is_empty() || case.method == "POST" {
            headers.insert(
                "content-length".to_string(),
                case.request_body.len().to_string(),
            );
        }
        let mut request = format!("{} {} HTTP/1.1\r\n", case.method, case.path);
        for (name, value) in &headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        request.push_str(&case.request_body);
        let mut stream = tokio::net::TcpStream::connect(address).await?;
        stream.write_all(request.as_bytes()).await?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await?;
        let text = raw;
        let split = text
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .ok_or_else(|| anyhow::anyhow!("no response headers"))?;
        let head = String::from_utf8_lossy(&text[..split]).into_owned();
        let body = &text[split + 4..];
        let mut lines = head.lines();
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or_else(|| anyhow::anyhow!("no status line"))?;
        let mut parsed = BTreeMap::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                parsed.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        let body = if parsed.get("content-encoding").map(String::as_str) == Some("gzip") {
            use std::io::Read as _;
            let mut decoder = flate2::read::GzDecoder::new(body);
            let mut out = Vec::new();
            decoder.read_to_end(&mut out)?;
            String::from_utf8_lossy(&out).into_owned()
        } else {
            String::from_utf8_lossy(body).into_owned()
        };
        Ok(RawResponse {
            status,
            headers: parsed,
            body,
        })
    }
}

/// Normalizes a JSON body when it parses, and the raw text otherwise.
fn normalized_body(text: &str, allowlist: &Allowlist, root: &Path) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => devboard::jsjson::stringify(&crate::normalize(&value, allowlist, root)),
        Err(_) => crate::sanitize_text(text, root),
    }
}
