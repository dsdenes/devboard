//! The HTTP table: one row per path, method, and status family the contract
//! names. The same table runs against the TypeScript server while it exists and
//! against the Rust dashboard, so the table itself is proven to describe
//! current behavior before any of it is trusted.

use std::collections::BTreeMap;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, HOST, ORIGIN};
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
    pub expect_cookie: bool,
    pub expect_json: BodyExpectation,
}

/// What one row's body must carry.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BodyExpectation {
    None,
    Problem(u16),
    ReadyPid,
}

/// How a row's request carries its credentials and headers.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HeaderSpec {
    None,
    Token,
    TokenHost(&'static str),
    TokenOrigin(&'static str),
    FlowId(&'static str),
    Gzip,
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

/// The table every dashboard must answer identically.
pub fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "ready-get",
            method: Method::GET,
            path: "/ready",
            headers: HeaderSpec::None,
            expect_status: 200,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::ReadyPid,
        },
        Case {
            name: "ready-head",
            method: Method::HEAD,
            path: "/ready",
            headers: HeaderSpec::None,
            expect_status: 200,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::None,
        },
        Case {
            name: "ready-post",
            method: Method::POST,
            path: "/ready",
            headers: HeaderSpec::None,
            expect_status: 405,
            expect_allow: Some("GET, HEAD"),
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(405),
        },
        Case {
            name: "ws-post",
            method: Method::POST,
            path: "/ws",
            headers: HeaderSpec::None,
            expect_status: 405,
            expect_allow: Some("GET"),
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(405),
        },
        Case {
            name: "ws-refused-host",
            method: Method::GET,
            path: "/ws",
            headers: HeaderSpec::TokenHost("evil.test"),
            expect_status: 403,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(403),
        },
        Case {
            name: "ws-refused-origin",
            method: Method::GET,
            path: "/ws",
            headers: HeaderSpec::TokenOrigin("http://evil.test"),
            expect_status: 403,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(403),
        },
        Case {
            name: "ws-unauthorized",
            method: Method::GET,
            path: "/ws",
            headers: HeaderSpec::None,
            expect_status: 401,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(401),
        },
        Case {
            name: "static-control-character",
            method: Method::GET,
            path: "/%00index.html",
            headers: HeaderSpec::None,
            expect_status: 400,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(400),
        },
        Case {
            name: "static-document",
            method: Method::GET,
            path: "/",
            headers: HeaderSpec::None,
            expect_status: 200,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: true,
            expect_json: BodyExpectation::None,
        },
        Case {
            name: "static-unknown",
            method: Method::GET,
            path: "/missing.txt",
            headers: HeaderSpec::None,
            expect_status: 404,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(404),
        },
        Case {
            name: "feedback-unauthorized",
            method: Method::POST,
            path: "/feedback",
            headers: HeaderSpec::None,
            expect_status: 401,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(401),
        },
        Case {
            name: "feedback-method",
            method: Method::GET,
            path: "/feedback",
            headers: HeaderSpec::Token,
            expect_status: 405,
            expect_allow: Some("POST"),
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(405),
        },
        Case {
            name: "feedback-disabled",
            method: Method::POST,
            path: "/feedback",
            headers: HeaderSpec::Token,
            expect_status: 503,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(503),
        },
        Case {
            name: "goal-proposals-method",
            method: Method::GET,
            path: "/goal-proposals",
            headers: HeaderSpec::Token,
            expect_status: 405,
            expect_allow: Some("POST"),
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(405),
        },
        Case {
            name: "goal-proposals-unauthorized",
            method: Method::POST,
            path: "/goal-proposals",
            headers: HeaderSpec::None,
            expect_status: 401,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(401),
        },
        Case {
            name: "flow-id-malformed",
            method: Method::GET,
            path: "/ready",
            headers: HeaderSpec::FlowId("bad id"),
            expect_status: 400,
            expect_allow: None,
            expect_gzip: false,
            expect_cookie: false,
            expect_json: BodyExpectation::Problem(400),
        },
        Case {
            name: "ready-gzip",
            method: Method::GET,
            path: "/ready",
            headers: HeaderSpec::Gzip,
            expect_status: 200,
            expect_allow: None,
            expect_gzip: true,
            expect_cookie: false,
            expect_json: BodyExpectation::ReadyPid,
        },
    ]
}

/// Runs the whole table against one dashboard base URL.
pub async fn run(base: &str, token: &str) -> Vec<Result<Observed, String>> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .build()
        .expect("an HTTP client");
    let mut results = Vec::new();
    for case in cases() {
        results.push(run_case(&client, base, token, &case).await);
    }
    results
}

async fn run_case(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    case: &Case,
) -> Result<Observed, String> {
    let mut headers = HeaderMap::new();
    match case.headers {
        HeaderSpec::None => {}
        HeaderSpec::Token => {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|error| error.to_string())?,
            );
        }
        HeaderSpec::TokenHost(host) => {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|error| error.to_string())?,
            );
            headers.insert(HOST, HeaderValue::from_static(host));
        }
        HeaderSpec::TokenOrigin(origin) => {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|error| error.to_string())?,
            );
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
    if case.expect_cookie {
        let cookie = observed.header("set-cookie").unwrap_or("");
        if !cookie.starts_with("devboard_dashboard_") || !cookie.contains("HttpOnly") {
            return Err(format!(
                "{}: expected the dashboard cookie, got {cookie:?}",
                case.name
            ));
        }
    }
    match case.expect_json {
        BodyExpectation::None => {}
        BodyExpectation::Problem(status) => {
            let parsed: Value = serde_json::from_str(&observed.body)
                .map_err(|error| format!("{}: the body is not JSON: {error}", case.name))?;
            let actual = parsed.get("status").and_then(Value::as_u64);
            if actual != Some(u64::from(status)) {
                return Err(format!(
                    "{}: expected problem status {status}, got {actual:?}",
                    case.name
                ));
            }
        }
        BodyExpectation::ReadyPid => {
            let parsed: Value = serde_json::from_str(&observed.body)
                .map_err(|error| format!("{}: the body is not JSON: {error}", case.name))?;
            if parsed.get("pid").and_then(Value::as_u64).is_none() {
                return Err(format!("{}: the readiness answer carries a pid", case.name));
            }
        }
    }
    if observed.status == StatusCode::OK.as_u16() {
        // A successful answer declares the negotiation header everywhere it
        // writes a body.
        if observed.body != "[]" && observed.header("vary") != Some("Accept-Encoding") {
            return Err(format!("{}: expected Vary: Accept-Encoding", case.name));
        }
    }
    Ok(())
}
