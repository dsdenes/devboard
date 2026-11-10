//! The HTTP table: one row per path, method, and status family the contract
//! names, plus one row for every served REST operation. The table runs against
//! the Rust dashboard, so it proves the transport before anything relies on it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, HOST, ORIGIN, UPGRADE};
use reqwest::{Method, StatusCode};
use serde_json::Value;

/// One row of the table.
pub struct Case {
    pub name: &'static str,
    pub method: Method,
    /// The route template the corpus names; it keeps its `{field}` placeholders.
    pub path: &'static str,
    /// The concrete path the corpus sends, with every placeholder resolved to
    /// the fixture identity that names no real resource.
    pub request_path: String,
    pub headers: HeaderSpec,
    pub expect_status: u16,
    pub expect_allow: Option<&'static str>,
    pub expect_gzip: bool,
    /// How the row's answer is compared with its recording.
    pub answer: Answer,
}

/// How one row's answer is compared with its recording.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// The whole body, field by field, apart from the allowlist.
    Exact,
    /// The frames envelope only, for a row whose frames the request cannot
    /// pin: a spawned handler answers after the request may already have
    /// returned, and a measurement frame names a live host fact. The
    /// recording still names the envelope the server answered.
    Envelope,
}

/// How a row's request carries its headers.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HeaderSpec {
    None,
    Host(&'static str),
    Origin(&'static str),
    FlowId(&'static str),
    Gzip,
    EmptyHost,
    Upgrade,
}

/// One row's observed answer.
#[derive(Debug, Clone)]
pub struct Observed {
    pub name: &'static str,
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

impl Observed {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

fn row(
    name: &'static str,
    method: Method,
    path: &'static str,
    headers: HeaderSpec,
    expect_status: u16,
    expect_allow: Option<&'static str>,
    expect_gzip: bool,
) -> Case {
    Case {
        name,
        method,
        path,
        request_path: request_path(path),
        headers,
        expect_status,
        expect_allow,
        expect_gzip,
        answer: Answer::Exact,
    }
}

/// The fixture identity a route placeholder resolves to. Every one names no
/// real resource, so a replayed request reaches the handler's own refusal or
/// empty state instead of starting work against a named run or draft.
fn request_path(template: &str) -> String {
    let mut path = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        path.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else {
            path.push_str(&rest[open..]);
            return path;
        };
        let name = &rest[open + 1..open + close];
        path.push_str(match name {
            "url" => "https%3A%2F%2Fexample.test%2Frepo.git",
            "path" => "missing.md",
            _ => "missing",
        });
        rest = &rest[open + close + 1..];
    }
    path.push_str(rest);
    path
}

/// The hand-written surface rows.
pub fn cases() -> Vec<Case> {
    vec![
        row(
            "ready-get",
            Method::GET,
            "/ready",
            HeaderSpec::None,
            200,
            None,
            false,
        ),
        row(
            "ready-head",
            Method::HEAD,
            "/ready",
            HeaderSpec::None,
            200,
            None,
            false,
        ),
        row(
            "ready-post",
            Method::POST,
            "/ready",
            HeaderSpec::None,
            405,
            Some("GET, HEAD"),
            false,
        ),
        row(
            "missing-host",
            Method::GET,
            "/ready",
            HeaderSpec::EmptyHost,
            400,
            None,
            false,
        ),
        row(
            "ws-get-refused",
            Method::GET,
            "/ws",
            HeaderSpec::None,
            404,
            None,
            false,
        ),
        row(
            "ws-upgrade-refused",
            Method::GET,
            "/ws",
            HeaderSpec::Upgrade,
            404,
            None,
            false,
        ),
        row(
            "ws-post-refused",
            Method::POST,
            "/ws",
            HeaderSpec::None,
            404,
            None,
            false,
        ),
        row(
            "ws-refused-host",
            Method::GET,
            "/ws",
            HeaderSpec::Host("evil.test"),
            421,
            None,
            false,
        ),
        row(
            "reports-disabled",
            Method::POST,
            "/reports",
            HeaderSpec::None,
            503,
            None,
            false,
        ),
        row(
            "reports-method",
            Method::GET,
            "/reports",
            HeaderSpec::None,
            405,
            Some("POST"),
            false,
        ),
        row(
            "reports-refused-host",
            Method::POST,
            "/reports",
            HeaderSpec::Host("evil.test"),
            421,
            None,
            false,
        ),
        row(
            "reports-refused-origin",
            Method::POST,
            "/reports",
            HeaderSpec::Origin("http://evil.test"),
            403,
            None,
            false,
        ),
        row(
            "feedback-gone",
            Method::GET,
            "/feedback",
            HeaderSpec::None,
            404,
            None,
            false,
        ),
        row(
            "goal-proposals-method",
            Method::GET,
            "/goal-proposals",
            HeaderSpec::None,
            405,
            Some("POST"),
            false,
        ),
        row(
            "goal-proposals-refused-host",
            Method::POST,
            "/goal-proposals",
            HeaderSpec::Host("evil.test"),
            403,
            None,
            false,
        ),
        row(
            "goal-proposals-empty",
            Method::POST,
            "/goal-proposals",
            HeaderSpec::None,
            400,
            None,
            false,
        ),
        row(
            "flow-id-malformed",
            Method::GET,
            "/ready",
            HeaderSpec::FlowId("bad id"),
            400,
            None,
            false,
        ),
        row(
            "ready-gzip",
            Method::GET,
            "/ready",
            HeaderSpec::Gzip,
            200,
            None,
            true,
        ),
        row(
            "records-get",
            Method::GET,
            "/records",
            HeaderSpec::None,
            200,
            None,
            false,
        ),
        row(
            "records-method",
            Method::POST,
            "/records",
            HeaderSpec::None,
            405,
            Some("GET, HEAD"),
            false,
        ),
        row(
            "records-refused-host",
            Method::GET,
            "/records",
            HeaderSpec::Host("evil.test"),
            421,
            None,
            false,
        ),
        row(
            "records-refused-origin",
            Method::GET,
            "/records",
            HeaderSpec::Origin("http://evil.test"),
            403,
            None,
            false,
        ),
        row(
            "static-control-character",
            Method::GET,
            "/%00index.html",
            HeaderSpec::None,
            400,
            None,
            false,
        ),
        row(
            "static-document",
            Method::GET,
            "/",
            HeaderSpec::None,
            200,
            None,
            false,
        ),
        row(
            "static-unknown",
            Method::GET,
            "/missing.txt",
            HeaderSpec::None,
            404,
            None,
            false,
        ),
        row(
            "flows-get",
            Method::GET,
            "/flows",
            HeaderSpec::None,
            200,
            None,
            false,
        ),
        row(
            "flows-head",
            Method::HEAD,
            "/flows",
            HeaderSpec::None,
            200,
            None,
            false,
        ),
        row(
            "agent-run-get",
            Method::GET,
            "/agent-runs/missing",
            HeaderSpec::None,
            404,
            None,
            false,
        ),
        row(
            "agent-run-output-get",
            Method::GET,
            "/agent-runs/missing/output",
            HeaderSpec::None,
            404,
            None,
            false,
        ),
        row(
            "goal-proposal-get",
            Method::GET,
            "/goal-proposals/missing.md",
            HeaderSpec::None,
            404,
            None,
            false,
        ),
        row(
            "agent-runs-get",
            Method::GET,
            "/agent-runs",
            HeaderSpec::None,
            200,
            None,
            false,
        ),
        row(
            "agent-runs-method",
            Method::POST,
            "/agent-runs",
            HeaderSpec::None,
            405,
            Some("GET, HEAD"),
            false,
        ),
    ]
}

/// One row for every served REST operation. A parameterized path keeps its
/// template in the row and carries the fixture identity its replay sends;
/// `--compare-http` skips those rows because a live dashboard names no such
/// resource, and the fixture replay sends them.
pub fn route_cases() -> Vec<Case> {
    devboard::rest::ROUTES
        .iter()
        .map(|route| {
            let mut case = row(
                route.command,
                route.method.clone(),
                route.path,
                HeaderSpec::None,
                route.status,
                None,
                false,
            );
            if matches!(
                route.command,
                "discoverAgent" | "discoverProject" | "startRun" | "getComplexity"
            ) {
                case.answer = Answer::Envelope;
            }
            case
        })
        .collect()
}

/// Every recorded row: the hand-written surface and the served operations.
pub fn all_cases() -> Vec<Case> {
    let mut rows = cases();
    rows.extend(route_cases());
    rows
}

/// The rows `--compare-http` sends: every read and the hand-written refusals.
/// A mutating operation has a row and a recording, but the compared dashboard
/// may be a live one, where replaying it would start real work; the fixture
/// replay sends it.
pub fn runnable_cases() -> Vec<Case> {
    let mut rows = cases();
    rows.extend(
        route_cases()
            .into_iter()
            .filter(|case| case.method == Method::GET)
            .filter(|case| !case.path.contains('{')),
    );
    rows
}

/// One recorded answer: what the fixture dashboard answered for one row.
#[derive(Debug, Clone)]
pub struct Recording {
    pub name: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    /// The answer's body: a JSON document when the answer was JSON, the text
    /// itself otherwise.
    pub body: Value,
}

impl Recording {
    fn from_json(value: &Value, source: &Path) -> Result<Self, String> {
        let text = |field: &str| {
            value
                .get(field)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("{}: no {field}", source.display()))
        };
        let status = value
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .ok_or_else(|| format!("{}: no status", source.display()))?;
        let body = value
            .get("body")
            .cloned()
            .ok_or_else(|| format!("{}: no body", source.display()))?;
        Ok(Self {
            name: text("name")?,
            method: text("method")?,
            path: text("path")?,
            status,
            body,
        })
    }

    fn to_json(&self) -> Value {
        let mut object = serde_json::Map::new();
        object.insert("name".to_string(), Value::String(self.name.clone()));
        object.insert("method".to_string(), Value::String(self.method.clone()));
        object.insert("path".to_string(), Value::String(self.path.clone()));
        object.insert("status".to_string(), Value::from(self.status));
        object.insert("body".to_string(), self.body.clone());
        Value::Object(object)
    }
}

/// The recorded corpus, one entry per table row.
#[derive(Default)]
pub struct Corpus {
    recordings: BTreeMap<String, Recording>,
}

impl Corpus {
    /// Reads every recording under one directory.
    pub fn load(directory: &Path) -> Result<Self, String> {
        let mut recordings = BTreeMap::new();
        let entries = std::fs::read_dir(directory)
            .map_err(|error| format!("{}: {error}", directory.display()))?;
        for entry in entries {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let text = std::fs::read_to_string(&path)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            let value: Value = serde_json::from_str(&text)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            let recording = Recording::from_json(&value, &path)?;
            if path.file_stem().and_then(|value| value.to_str()) != Some(recording.name.as_str()) {
                return Err(format!(
                    "{}: the file name does not name {}",
                    path.display(),
                    recording.name
                ));
            }
            if recordings
                .insert(recording.name.clone(), recording)
                .is_some()
            {
                return Err(format!(
                    "{}: a second recording for one row",
                    path.display()
                ));
            }
        }
        Ok(Self { recordings })
    }

    /// Writes every recording, one file per row.
    pub fn write(&self, directory: &Path) -> Result<(), String> {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("{}: {error}", directory.display()))?;
        for recording in self.recordings.values() {
            let path = directory.join(format!("{}.json", recording.name));
            let mut text = serde_json::to_string_pretty(&recording.to_json())
                .map_err(|error| format!("{}: {error}", path.display()))?;
            text.push('\n');
            std::fs::write(&path, text).map_err(|error| format!("{}: {error}", path.display()))?;
        }
        Ok(())
    }

    /// Adds one recording, replacing the row of the same name.
    pub fn insert(&mut self, recording: Recording) {
        self.recordings.insert(recording.name.clone(), recording);
    }

    pub fn get(&self, name: &str) -> Option<&Recording> {
        self.recordings.get(name)
    }

    pub fn len(&self) -> usize {
        self.recordings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.recordings.is_empty()
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.recordings.keys().map(String::as_str)
    }
}

/// Every field a comparison ignores, and its reason.
pub struct Allowlist {
    fields: BTreeSet<String>,
}

impl Allowlist {
    /// Reads the allowlist a comparison applies.
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        let value: Value =
            serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
        let entries = value
            .get("fields")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{}: no fields", path.display()))?;
        let mut fields = BTreeSet::new();
        for entry in entries {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{}: a field with no name", path.display()))?;
            let reason = entry
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if reason.trim().is_empty() {
                return Err(format!("{}: {name} has no reason", path.display()));
            }
            if !fields.insert(name.to_string()) {
                return Err(format!("{}: {name} is listed twice", path.display()));
            }
        }
        Ok(Self { fields })
    }

    /// True when a comparison ignores this field's value.
    pub fn contains(&self, name: &str) -> bool {
        self.fields.contains(name)
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }
}

/// One HTTP client for the replay.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .build()
        .expect("an HTTP client")
}

/// Runs the runnable table against one dashboard base URL and compares every
/// answer with its recording.
pub async fn run(
    base: &str,
    corpus: &Corpus,
    allowlist: &Allowlist,
) -> Vec<Result<Observed, String>> {
    replay(base, corpus, allowlist, &runnable_cases()).await
}

/// Replays one set of rows against one dashboard base URL.
pub async fn replay(
    base: &str,
    corpus: &Corpus,
    allowlist: &Allowlist,
    cases: &[Case],
) -> Vec<Result<Observed, String>> {
    let client = client();
    let mut results = Vec::new();
    for case in cases {
        results.push(run_case(&client, base, corpus, allowlist, case).await);
    }
    results
}

/// Sends one row's request and returns the answer, without comparing it.
pub async fn send(client: &reqwest::Client, base: &str, case: &Case) -> Result<Observed, String> {
    let mut headers = HeaderMap::new();
    match case.headers {
        HeaderSpec::None => {}
        HeaderSpec::Host(host) => {
            headers.insert(HOST, HeaderValue::from_static(host));
        }
        HeaderSpec::Origin(origin) => {
            headers.insert(ORIGIN, HeaderValue::from_static(origin));
        }
        HeaderSpec::FlowId(flow_id) => {
            headers.insert(
                "x-flow-id",
                HeaderValue::from_str(flow_id).map_err(|error| error.to_string())?,
            );
        }
        HeaderSpec::Gzip => {
            headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
        }
        HeaderSpec::EmptyHost => {
            headers.insert(HOST, HeaderValue::from_static(""));
        }
        HeaderSpec::Upgrade => {
            headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
            headers.insert("connection", HeaderValue::from_static("Upgrade"));
            headers.insert(
                "sec-websocket-key",
                HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="),
            );
            headers.insert("sec-websocket-version", HeaderValue::from_static("13"));
        }
    }
    let request = client
        .request(case.method.clone(), format!("{base}{}", case.request_path))
        .headers(headers);
    let response = request.send().await.map_err(|error| format!("{error}"))?;
    let status = response.status().as_u16();
    let mut observed = BTreeMap::new();
    for (name, value) in response.headers() {
        observed.insert(name.to_string(), value.to_str().unwrap_or("").to_string());
    }
    let mut body = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    let mut decoded = None;
    if observed.get("content-encoding").map(String::as_str) == Some("gzip") {
        use std::io::Read as _;
        let mut decoder = flate2::read::GzDecoder::new(body.as_slice());
        let mut text = Vec::new();
        decoder
            .read_to_end(&mut text)
            .map_err(|error| error.to_string())?;
        decoded = Some(String::from_utf8_lossy(&text).into_owned());
        body = text;
    }
    let text = decoded.unwrap_or_else(|| String::from_utf8_lossy(&body).into_owned());
    let observed = Observed {
        name: case.name,
        status,
        headers: observed,
        body: text,
    };
    Ok(observed)
}

async fn run_case(
    client: &reqwest::Client,
    base: &str,
    corpus: &Corpus,
    allowlist: &Allowlist,
    case: &Case,
) -> Result<Observed, String> {
    let recording = corpus
        .get(case.name)
        .ok_or_else(|| format!("{}: no recording", case.name))?;
    let observed = send(client, base, case).await?;
    check(case, recording, allowlist, &observed)?;
    Ok(observed)
}

/// Asserts one answer against its recording and the row's contract headers.
pub fn check(
    case: &Case,
    recording: &Recording,
    allowlist: &Allowlist,
    observed: &Observed,
) -> Result<(), String> {
    if observed.status != recording.status {
        return Err(format!(
            "{}: recorded status {}, got {}",
            case.name, recording.status, observed.status
        ));
    }
    if let Some(allow) = case.expect_allow {
        if observed.header("allow") != Some(allow) {
            return Err(format!(
                "{}: expected Allow {allow}, got {:?}",
                case.name,
                observed.header("allow")
            ));
        }
    }
    if case.expect_gzip && observed.header("content-encoding") != Some("gzip") {
        return Err(format!(
            "{}: expected gzip, got {:?}",
            case.name,
            observed.header("content-encoding")
        ));
    }
    match case.answer {
        Answer::Exact => compare_body(case, &recording.body, &observed.body, allowlist)?,
        Answer::Envelope => assert_envelope(case, &observed.body)?,
    }
    if observed.status == StatusCode::OK.as_u16()
        && observed.body != "[]"
        && observed.header("vary") != Some("Accept-Encoding")
    {
        return Err(format!("{}: expected Vary: Accept-Encoding", case.name));
    }
    Ok(())
}

/// Asserts that an answer is the one frames envelope and carries nothing else.
fn assert_envelope(case: &Case, served: &str) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(served)
        .map_err(|error| format!("{}: the body is not JSON: {error}", case.name))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| format!("{}: the body is not the frames envelope", case.name))?;
    if object.len() != 1 || !matches!(object.get("frames"), Some(Value::Array(_))) {
        return Err(format!(
            "{}: the body is not the frames envelope: {served}",
            case.name
        ));
    }
    Ok(())
}

/// Compares one answer's body with its recording. A recorded JSON document is
/// compared field by field, apart from the allowlisted fields; a recorded text
/// body is compared as text.
fn compare_body(
    case: &Case,
    recorded: &Value,
    served: &str,
    allowlist: &Allowlist,
) -> Result<(), String> {
    if let Value::String(text) = recorded {
        if served == text {
            return Ok(());
        }
        return Err(format!(
            "{}: recorded body {text:?}, served {served:?}",
            case.name
        ));
    }
    let parsed: Value = serde_json::from_str(served)
        .map_err(|error| format!("{}: the body is not JSON: {error}", case.name))?;
    compare_value(case.name, "", recorded, &parsed, allowlist)
}

fn compare_value(
    name: &str,
    at: &str,
    recorded: &Value,
    served: &Value,
    allowlist: &Allowlist,
) -> Result<(), String> {
    match (recorded, served) {
        (Value::Object(recorded), Value::Object(served)) => {
            for (key, value) in recorded {
                let Some(other) = served.get(key) else {
                    return Err(format!("{name}: the answer has no {at}{key}"));
                };
                if allowlist.contains(key) {
                    // A recorded null names no type to compare: the field is
                    // asserted present, and its value is ignored.
                    if !value.is_null() && json_type(value) != json_type(other) {
                        return Err(format!(
                            "{name}: {at}{key} is recorded as {}, served as {}",
                            json_type(value),
                            json_type(other)
                        ));
                    }
                } else {
                    compare_value(name, &format!("{at}{key}."), value, other, allowlist)?;
                }
            }
            if let Some(extra) = served.keys().find(|key| !recorded.contains_key(*key)) {
                return Err(format!(
                    "{name}: the answer carries {at}{extra}, which the recording does not name"
                ));
            }
            Ok(())
        }
        (Value::Array(recorded), Value::Array(served)) => {
            if recorded.len() != served.len() {
                return Err(format!(
                    "{name}: {at} is recorded with {} entries, served with {}",
                    recorded.len(),
                    served.len()
                ));
            }
            for (index, (recorded, served)) in recorded.iter().zip(served).enumerate() {
                compare_value(name, &format!("{at}{index}."), recorded, served, allowlist)?;
            }
            Ok(())
        }
        _ => {
            if recorded == served {
                Ok(())
            } else {
                Err(format!("{name}: {at} recorded {recorded}, served {served}"))
            }
        }
    }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_served_route_has_a_table_row() {
        let names: std::collections::BTreeSet<&str> =
            all_cases().iter().map(|case| case.name).collect();
        for route in devboard::rest::ROUTES {
            assert!(names.contains(route.command), "{} has a row", route.command);
        }
        assert!(names.contains("ws-get-refused"));
        assert!(names.contains("feedback-gone"));
    }

    fn case(answer: Answer) -> Case {
        let mut case = row(
            "synthetic",
            Method::GET,
            "/synthetic",
            HeaderSpec::None,
            200,
            None,
            false,
        );
        case.answer = answer;
        case
    }

    fn recording(body: Value) -> Recording {
        Recording {
            name: "synthetic".to_string(),
            method: "GET".to_string(),
            path: "/synthetic".to_string(),
            status: 200,
            body,
        }
    }

    fn observed(body: &str) -> Observed {
        let mut headers = BTreeMap::new();
        headers.insert("vary".to_string(), "Accept-Encoding".to_string());
        Observed {
            name: "synthetic",
            status: 200,
            headers,
            body: body.to_string(),
        }
    }

    fn allowlist(names: &[&str]) -> Allowlist {
        Allowlist {
            fields: names.iter().map(|name| name.to_string()).collect(),
        }
    }

    #[test]
    fn a_changed_answer_fails_the_comparison() {
        let recorded = recording(serde_json::json!({"frames": [{"type": "goal", "text": "a"}]}));
        let error = check(
            &case(Answer::Exact),
            &recorded,
            &allowlist(&[]),
            &observed(r#"{"frames":[{"type":"goal","text":"b"}]}"#),
        )
        .expect_err("a changed text diverges");
        assert!(error.contains("frames.0.text"), "{error}");
    }

    #[test]
    fn an_allowlisted_field_keeps_its_presence_and_type() {
        let recorded = recording(serde_json::json!({"pid": 0, "live": true}));
        let allowed = allowlist(&["pid", "live"]);
        check(
            &case(Answer::Exact),
            &recorded,
            &allowed,
            &observed(r#"{"pid":123,"live":false}"#),
        )
        .expect("a per-run value is ignored");
        let error = check(
            &case(Answer::Exact),
            &recorded,
            &allowed,
            &observed(r#"{"pid":"123","live":false}"#),
        )
        .expect_err("a changed type diverges");
        assert!(error.contains("pid"), "{error}");
        let error = check(
            &case(Answer::Exact),
            &recorded,
            &allowed,
            &observed(r#"{"live":false}"#),
        )
        .expect_err("a missing field diverges");
        assert!(error.contains("pid"), "{error}");
    }

    #[test]
    fn a_recorded_null_allowlisted_field_keeps_its_presence() {
        let recorded = recording(serde_json::json!({"latest": null}));
        let allowed = allowlist(&["latest"]);
        check(
            &case(Answer::Exact),
            &recorded,
            &allowed,
            &observed(r#"{"latest":"1.2.3"}"#),
        )
        .expect("a null recording names no type");
        check(
            &case(Answer::Exact),
            &recorded,
            &allowed,
            &observed(r#"{}"#),
        )
        .expect_err("a missing field diverges");
    }

    #[test]
    fn an_answer_field_the_recording_does_not_name_fails() {
        let recorded = recording(serde_json::json!({"frames": []}));
        let error = check(
            &case(Answer::Exact),
            &recorded,
            &allowlist(&[]),
            &observed(r#"{"frames":[],"extra":1}"#),
        )
        .expect_err("an extra field diverges");
        assert!(error.contains("extra"), "{error}");
    }

    #[test]
    fn an_envelope_row_compares_the_envelope_only() {
        let recorded = recording(serde_json::json!({"frames": []}));
        check(
            &case(Answer::Envelope),
            &recorded,
            &allowlist(&[]),
            &observed(r#"{"frames":[{"type":"discoverError"}]}"#),
        )
        .expect("the frames of an envelope row are not pinned");
        let error = check(
            &case(Answer::Envelope),
            &recorded,
            &allowlist(&[]),
            &observed(r#"{"status":400,"title":"Bad Request"}"#),
        )
        .expect_err("a non-envelope body diverges");
        assert!(error.contains("frames envelope"), "{error}");
    }
}
