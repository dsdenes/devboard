//! The HTTP table: one row per path, method, and status family the contract
//! names, plus one row for every served REST operation. The table runs against
//! the Rust dashboard, so it proves the transport before anything relies on it.

use std::collections::BTreeMap;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, HOST, ORIGIN, UPGRADE};
use reqwest::{Method, StatusCode};
use serde_json::Value;

/// One row of the table.
pub struct Case {
    pub name: &'static str,
    pub method: Method,
    pub path: &'static str,
    pub headers: HeaderSpec,
    pub expect_status: u16,
    pub expect_allow: Option<&'static str>,
    pub expect_gzip: bool,
    pub expect_json: BodyExpectation,
}

/// What one row's body must carry.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BodyExpectation {
    None,
    Problem(u16),
    ReadyPid,
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

#[allow(clippy::too_many_arguments)]
fn row(
    name: &'static str,
    method: Method,
    path: &'static str,
    headers: HeaderSpec,
    expect_status: u16,
    expect_allow: Option<&'static str>,
    expect_gzip: bool,
    expect_json: BodyExpectation,
) -> Case {
    Case {
        name,
        method,
        path,
        headers,
        expect_status,
        expect_allow,
        expect_gzip,
        expect_json,
    }
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
            BodyExpectation::ReadyPid,
        ),
        row(
            "ready-head",
            Method::HEAD,
            "/ready",
            HeaderSpec::None,
            200,
            None,
            false,
            BodyExpectation::None,
        ),
        row(
            "ready-post",
            Method::POST,
            "/ready",
            HeaderSpec::None,
            405,
            Some("GET, HEAD"),
            false,
            BodyExpectation::Problem(405),
        ),
        row(
            "missing-host",
            Method::GET,
            "/ready",
            HeaderSpec::EmptyHost,
            400,
            None,
            false,
            BodyExpectation::Problem(400),
        ),
        row(
            "ws-get-refused",
            Method::GET,
            "/ws",
            HeaderSpec::None,
            404,
            None,
            false,
            BodyExpectation::Problem(404),
        ),
        row(
            "ws-upgrade-refused",
            Method::GET,
            "/ws",
            HeaderSpec::Upgrade,
            404,
            None,
            false,
            BodyExpectation::Problem(404),
        ),
        row(
            "ws-post-refused",
            Method::POST,
            "/ws",
            HeaderSpec::None,
            404,
            None,
            false,
            BodyExpectation::Problem(404),
        ),
        row(
            "ws-refused-host",
            Method::GET,
            "/ws",
            HeaderSpec::Host("evil.test"),
            421,
            None,
            false,
            BodyExpectation::Problem(421),
        ),
        row(
            "reports-disabled",
            Method::POST,
            "/reports",
            HeaderSpec::None,
            503,
            None,
            false,
            BodyExpectation::Problem(503),
        ),
        row(
            "reports-method",
            Method::GET,
            "/reports",
            HeaderSpec::None,
            405,
            Some("POST"),
            false,
            BodyExpectation::Problem(405),
        ),
        row(
            "reports-refused-host",
            Method::POST,
            "/reports",
            HeaderSpec::Host("evil.test"),
            421,
            None,
            false,
            BodyExpectation::Problem(421),
        ),
        row(
            "reports-refused-origin",
            Method::POST,
            "/reports",
            HeaderSpec::Origin("http://evil.test"),
            403,
            None,
            false,
            BodyExpectation::Problem(403),
        ),
        row(
            "feedback-gone",
            Method::GET,
            "/feedback",
            HeaderSpec::None,
            404,
            None,
            false,
            BodyExpectation::Problem(404),
        ),
        row(
            "goal-proposals-method",
            Method::GET,
            "/goal-proposals",
            HeaderSpec::None,
            405,
            Some("POST"),
            false,
            BodyExpectation::Problem(405),
        ),
        row(
            "goal-proposals-refused-host",
            Method::POST,
            "/goal-proposals",
            HeaderSpec::Host("evil.test"),
            403,
            None,
            false,
            BodyExpectation::Problem(403),
        ),
        row(
            "goal-proposals-empty",
            Method::POST,
            "/goal-proposals",
            HeaderSpec::None,
            400,
            None,
            false,
            BodyExpectation::Problem(400),
        ),
        row(
            "flow-id-malformed",
            Method::GET,
            "/ready",
            HeaderSpec::FlowId("bad id"),
            400,
            None,
            false,
            BodyExpectation::Problem(400),
        ),
        row(
            "ready-gzip",
            Method::GET,
            "/ready",
            HeaderSpec::Gzip,
            200,
            None,
            true,
            BodyExpectation::ReadyPid,
        ),
        row(
            "records-get",
            Method::GET,
            "/records",
            HeaderSpec::None,
            200,
            None,
            false,
            BodyExpectation::None,
        ),
        row(
            "records-method",
            Method::POST,
            "/records",
            HeaderSpec::None,
            405,
            Some("GET, HEAD"),
            false,
            BodyExpectation::Problem(405),
        ),
        row(
            "records-refused-host",
            Method::GET,
            "/records",
            HeaderSpec::Host("evil.test"),
            421,
            None,
            false,
            BodyExpectation::Problem(421),
        ),
        row(
            "records-refused-origin",
            Method::GET,
            "/records",
            HeaderSpec::Origin("http://evil.test"),
            403,
            None,
            false,
            BodyExpectation::Problem(403),
        ),
        row(
            "static-control-character",
            Method::GET,
            "/%00index.html",
            HeaderSpec::None,
            400,
            None,
            false,
            BodyExpectation::Problem(400),
        ),
        row(
            "static-document",
            Method::GET,
            "/",
            HeaderSpec::None,
            200,
            None,
            false,
            BodyExpectation::None,
        ),
        row(
            "static-unknown",
            Method::GET,
            "/missing.txt",
            HeaderSpec::None,
            404,
            None,
            false,
            BodyExpectation::Problem(404),
        ),
        row(
            "flows-get",
            Method::GET,
            "/flows",
            HeaderSpec::None,
            200,
            None,
            false,
            BodyExpectation::None,
        ),
        row(
            "flows-head",
            Method::HEAD,
            "/flows",
            HeaderSpec::None,
            200,
            None,
            false,
            BodyExpectation::None,
        ),
        row(
            "agent-run-get",
            Method::GET,
            "/agent-runs/missing",
            HeaderSpec::None,
            404,
            None,
            false,
            BodyExpectation::Problem(404),
        ),
        row(
            "agent-run-output-get",
            Method::GET,
            "/agent-runs/missing/output",
            HeaderSpec::None,
            404,
            None,
            false,
            BodyExpectation::Problem(404),
        ),
        row(
            "goal-proposal-get",
            Method::GET,
            "/goal-proposals/missing.md",
            HeaderSpec::None,
            404,
            None,
            false,
            BodyExpectation::Problem(404),
        ),
        row(
            "agent-runs-get",
            Method::GET,
            "/agent-runs",
            HeaderSpec::None,
            200,
            None,
            false,
            BodyExpectation::None,
        ),
        row(
            "agent-runs-method",
            Method::POST,
            "/agent-runs",
            HeaderSpec::None,
            405,
            Some("GET, HEAD"),
            false,
            BodyExpectation::Problem(405),
        ),
    ]
}

/// One row for every served REST operation. A parameterized path keeps its
/// template in the row; `--compare-http` skips it because it names no real
/// identity in a fixture dashboard.
pub fn route_cases() -> Vec<Case> {
    devboard::rest::ROUTES
        .iter()
        .map(|route| {
            row(
                route.command,
                route.method.clone(),
                route.path,
                HeaderSpec::None,
                route.status,
                None,
                false,
                BodyExpectation::None,
            )
        })
        .collect()
}

/// Every recorded row: the hand-written surface and the served operations.
pub fn all_cases() -> Vec<Case> {
    let mut rows = cases();
    rows.extend(route_cases());
    rows
}

/// The rows `--compare-http` actually sends: every read and the hand-written
/// refusals. A mutating operation has a row and a recording but is not replayed
/// against a fixture dashboard, where it would start real work.
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

/// Runs the runnable table against one dashboard base URL.
pub async fn run(base: &str) -> Vec<Result<Observed, String>> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .build()
        .expect("an HTTP client");
    let mut results = Vec::new();
    for case in runnable_cases() {
        results.push(run_case(&client, base, &case).await);
    }
    results
}

async fn run_case(client: &reqwest::Client, base: &str, case: &Case) -> Result<Observed, String> {
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
        .request(case.method.clone(), format!("{base}{}", case.path))
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
    check(case, &observed)?;
    Ok(observed)
}

/// Asserts one row against its expected status and contract headers.
pub fn check(case: &Case, observed: &Observed) -> Result<(), String> {
    if observed.status != case.expect_status {
        return Err(format!(
            "{}: expected status {}, got {}",
            case.name, case.expect_status, observed.status
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
    let parsed_problem = || -> Result<Value, String> {
        serde_json::from_str(&observed.body)
            .map_err(|error| format!("{}: the body is not JSON: {error}", case.name))
    };
    match case.expect_json {
        BodyExpectation::None => {}
        BodyExpectation::Problem(status) => {
            let parsed = parsed_problem()?;
            let actual = parsed.get("status").and_then(Value::as_u64);
            if actual != Some(u64::from(status)) {
                return Err(format!(
                    "{}: expected problem status {status}, got {actual:?}",
                    case.name
                ));
            }
        }
        BodyExpectation::ReadyPid => {
            let parsed = parsed_problem()?;
            if parsed.get("pid").and_then(Value::as_u64).is_none() {
                return Err(format!("{}: the readiness answer carries a pid", case.name));
            }
        }
    }
    if observed.status == StatusCode::OK.as_u16()
        && observed.body != "[]"
        && observed.header("vary") != Some("Accept-Encoding")
    {
        return Err(format!("{}: expected Vary: Accept-Encoding", case.name));
    }
    Ok(())
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
}
