//! The resource-oriented REST transport.
//!
//! Every action the browser used to send as a socket frame is one operation
//! here: a method, a root path, and the command the dashboard dispatches. A
//! request answers the frames the dispatcher produced, wrapped in one JSON
//! envelope, with ETag validation, gzip negotiation, and Problem JSON on every
//! refusal.

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value};
use url::Url;

use crate::app::App;
use crate::command::{command_from_json, Command};
use crate::http::{accepts_gzip, gzip_bytes, request_refusal, Replies, RequestRefusal};

/// Where one command field travels.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum From {
    Path,
    Query,
    Body,
}

/// One field the request carries for an operation.
pub struct Field {
    pub from: From,
    /// The name on the wire: a path segment or a snake_case query parameter.
    pub name: &'static str,
    /// The command field the dispatcher reads.
    pub field: &'static str,
}

/// Where a creation's `Location` comes from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Location {
    /// The operation answers no `Location`: it creates no addressable resource.
    None,
    /// The created run's own path, `/agent-runs/{run_id}`, from the run id the
    /// answer's `agentState` frame carries.
    AgentRun,
    /// The created draft's own item path, derived from the request path.
    Draft,
}

/// One REST operation.
pub struct Route {
    /// The retired command this operation replaces.
    pub command: &'static str,
    pub method: Method,
    /// The path template, with `{name}` placeholders for path fields.
    pub path: &'static str,
    pub fields: &'static [Field],
    /// The success status.
    pub status: u16,
    /// True when the operation creates a resource.
    pub creation: bool,
    /// Where the answer's `Location` comes from.
    pub location: Location,
}

const fn field(from: From, name: &'static str, field: &'static str) -> Field {
    Field { from, name, field }
}

macro_rules! path_field {
    ($name:literal, $field:literal) => {
        field(From::Path, $name, $field)
    };
}

macro_rules! body_field {
    ($name:literal, $field:literal) => {
        field(From::Body, $name, $field)
    };
}

macro_rules! route {
    ($command:literal, $method:ident, $path:literal, [$($field:expr),* $(,)?], $status:literal, $creation:literal) => {
        route!(
            $command,
            $method,
            $path,
            [$($field),*],
            $status,
            $creation,
            Location::None
        )
    };
    ($command:literal, $method:ident, $path:literal, [$($field:expr),* $(,)?], $status:literal, $creation:literal, $location:expr) => {
        Route {
            command: $command,
            method: Method::$method,
            path: $path,
            fields: &[$($field),*],
            status: $status,
            creation: $creation,
            location: $location,
        }
    };
}

/// Every operation the interface invokes. The order is the retired command
/// list; the tests compare the table with `contract/command-map.json`.
pub static ROUTES: &[Route] = &[
    route!("listRecords", GET, "/records", [], 200, false),
    route!("getGoal", GET, "/goal", [], 200, false),
    route!("getProject", GET, "/project", [], 200, false),
    route!("getVersion", GET, "/version", [], 200, false),
    route!("getMcpTools", GET, "/mcp-tools", [], 200, false),
    route!(
        "getInstalledSkills",
        GET,
        "/installed-skills",
        [],
        200,
        false
    ),
    route!("getComplexity", GET, "/complexity", [], 200, false),
    route!("getResources", GET, "/resources", [], 200, false),
    route!(
        "setResources",
        PUT,
        "/resources",
        [
            body_field!("max_agent_peers", "maxAgentPeers"),
            body_field!("memory_high_mb", "memoryHighMb"),
            body_field!("memory_max_mb", "memoryMaxMb"),
            body_field!("memory_reserve_mb", "memoryReserveMb"),
        ],
        200,
        false
    ),
    route!(
        "setInstalledSkillEnabled",
        PATCH,
        "/installed-skills/{name}",
        [
            path_field!("name", "name"),
            body_field!("enabled", "enabled"),
        ],
        200,
        false
    ),
    route!("getIssues", GET, "/issues", [], 200, false),
    route!(
        "getIssuesRun",
        GET,
        "/issues/runs/{run_id}",
        [path_field!("run_id", "runId")],
        200,
        false
    ),
    route!("startIssues", POST, "/issues/workers", [], 201, true),
    route!("pauseIssues", PATCH, "/issues/workers", [], 200, false),
    route!("resumeIssues", PUT, "/issues/workers", [], 200, false),
    route!("stopIssues", DELETE, "/issues/workers", [], 200, false),
    route!("checkIssues", POST, "/issues/checks", [], 202, true),
    route!(
        "answerIssues",
        POST,
        "/issues/runs/{run_id}/answers",
        [
            path_field!("run_id", "runId"),
            body_field!("id", "id"),
            body_field!("value", "value"),
        ],
        202,
        true
    ),
    route!(
        "closeIssue",
        DELETE,
        "/issues/{number}",
        [path_field!("number", "number")],
        200,
        false
    ),
    route!("getGoalDrafts", GET, "/goal-drafts", [], 200, false),
    route!(
        "getGoalDraft",
        GET,
        "/goal-drafts/{path}",
        [path_field!("path", "path")],
        200,
        false
    ),
    route!(
        "startGoalDraft",
        POST,
        "/goal-drafts/{path}/runs",
        [path_field!("path", "path")],
        201,
        true,
        Location::Draft
    ),
    route!(
        "stopGoalDraft",
        DELETE,
        "/goal-drafts/{path}/runs",
        [path_field!("path", "path")],
        200,
        false
    ),
    route!(
        "deleteGoalDraft",
        DELETE,
        "/goal-drafts/{path}",
        [path_field!("path", "path")],
        200,
        false
    ),
    route!(
        "answerGoalDraft",
        POST,
        "/goal-drafts/{path}/answers",
        [
            path_field!("path", "path"),
            body_field!("id", "id"),
            body_field!("value", "value"),
        ],
        202,
        true
    ),
    route!("getAgents", GET, "/agents", [], 200, false),
    route!(
        "getAgent",
        GET,
        "/agents/{id}",
        [path_field!("id", "id")],
        200,
        false
    ),
    route!(
        "refreshAgent",
        POST,
        "/agents/{id}/refreshes",
        [path_field!("id", "id")],
        202,
        true
    ),
    route!(
        "startAgent",
        POST,
        "/agents/{id}/runs",
        [path_field!("id", "id")],
        201,
        true,
        Location::AgentRun
    ),
    route!(
        "stopAgent",
        DELETE,
        "/agents/{id}/runs",
        [path_field!("id", "id")],
        200,
        false
    ),
    route!(
        "setAgentSettings",
        PUT,
        "/agents/{id}/settings",
        [
            path_field!("id", "id"),
            body_field!("minutes", "minutes"),
            body_field!("max_per_hour", "maxPerHour"),
            body_field!("max_pending", "maxPending"),
        ],
        200,
        false
    ),
    route!(
        "disableAgentTimer",
        DELETE,
        "/agents/{id}/timer",
        [path_field!("id", "id")],
        200,
        false
    ),
    route!(
        "getAgentPrompt",
        GET,
        "/agents/{id}/prompt",
        [path_field!("id", "id")],
        200,
        false
    ),
    route!("restartServer", POST, "/server-restarts", [], 202, true),
    route!(
        "startRun",
        POST,
        "/runs",
        [body_field!("file", "file")],
        201,
        true
    ),
    route!("startLifecycle", POST, "/lifecycles", [], 201, true),
    route!("stopLifecycle", DELETE, "/lifecycles", [], 200, false),
    route!("pauseLifecycle", POST, "/lifecycle-pauses", [], 202, true),
    route!(
        "resumeLifecycle",
        DELETE,
        "/lifecycle-pauses",
        [],
        200,
        false
    ),
    route!(
        "reviseGoal",
        POST,
        "/goal-revisions",
        [body_field!("request", "request")],
        201,
        true
    ),
    route!("createGoal", POST, "/goal-creations", [], 201, true),
    route!("prepareSkills", POST, "/skill-preparations", [], 201, true),
    route!("getSkills", GET, "/skills", [], 200, false),
    route!(
        "deleteSkill",
        DELETE,
        "/skills/{name}",
        [path_field!("name", "name")],
        200,
        false
    ),
    route!(
        "resetImplementation",
        POST,
        "/implementation-resets",
        [],
        201,
        true
    ),
    route!("createFlowGoal", POST, "/flows/goals", [], 201, true),
    route!("cancelFlowGoal", DELETE, "/flows/goals", [], 200, false),
    route!(
        "startFlowImplementation",
        POST,
        "/flows/implementations",
        [],
        201,
        true
    ),
    route!(
        "stopFlowImplementation",
        DELETE,
        "/flows/implementations",
        [],
        200,
        false
    ),
    route!(
        "retryFlowPr",
        POST,
        "/flows/pull-request-retries",
        [],
        202,
        true
    ),
    route!(
        "markFlowPrReady",
        PATCH,
        "/flows/pull-requests",
        [],
        200,
        false
    ),
    route!(
        "mergeFlowPr",
        POST,
        "/flows/pull-request-merges",
        [],
        202,
        true
    ),
    route!(
        "sendFlowSteering",
        POST,
        "/flows/steering",
        [body_field!("text", "text")],
        202,
        true
    ),
    route!(
        "acceptFlowWidget",
        PATCH,
        "/flows/widgets/{id}",
        [path_field!("id", "id"), body_field!("accepted", "accepted"),],
        200,
        false
    ),
    route!(
        "refuseFlowWidget",
        POST,
        "/flows/widget-refusals",
        [body_field!("id", "id"), body_field!("reason", "reason"),],
        202,
        true
    ),
    route!(
        "openFlowWidget",
        POST,
        "/flows/widget-opens",
        [body_field!("id", "id")],
        202,
        true
    ),
    route!(
        "closeFlowWidget",
        DELETE,
        "/flows/widget-opens",
        [],
        200,
        false
    ),
    route!(
        "sendFlowConversation",
        POST,
        "/flows/conversations/messages",
        [body_field!("text", "text")],
        202,
        true
    ),
    route!(
        "sendFlowConclusion",
        POST,
        "/flows/conclusions",
        [body_field!("text", "text")],
        202,
        true
    ),
    route!(
        "dismissFlowBlocker",
        DELETE,
        "/flows/blockers/{id}",
        [path_field!("id", "id")],
        200,
        false
    ),
    route!(
        "flowAnswer",
        POST,
        "/flows/answers",
        [
            body_field!("id", "id"),
            body_field!("value", "value"),
            body_field!("target", "target"),
        ],
        202,
        true
    ),
    route!(
        "answer",
        POST,
        "/answers",
        [
            body_field!("id", "id"),
            body_field!("value", "value"),
            body_field!("lane", "lane"),
        ],
        202,
        true
    ),
    route!("discoverProject", POST, "/discoveries/scans", [], 201, true),
    route!(
        "discoverAgent",
        POST,
        "/discoveries/agent-scans",
        [body_field!("agent", "agent")],
        201,
        true
    ),
    route!(
        "discoverRemote",
        POST,
        "/discoveries/remotes",
        [body_field!("url", "url")],
        201,
        true
    ),
    route!(
        "switchDiscoverRemote",
        PATCH,
        "/discoveries/remotes",
        [body_field!("url", "url")],
        200,
        false
    ),
    route!(
        "removeDiscoverRemote",
        DELETE,
        "/discoveries/remotes/{url}",
        [path_field!("url", "url")],
        200,
        false
    ),
    route!(
        "clearDiscoverRemote",
        DELETE,
        "/discoveries/remote-selections",
        [],
        200,
        false
    ),
    route!("stopDiscover", DELETE, "/discoveries/scans", [], 200, false),
    route!(
        "answerDiscover",
        POST,
        "/discoveries/answers",
        [body_field!("id", "id"), body_field!("value", "value"),],
        202,
        true
    ),
    route!("getDiscover", GET, "/discoveries/workspace", [], 200, false),
    route!(
        "confirmGlossaryTerm",
        PUT,
        "/discoveries/glossary-terms/{id}",
        [path_field!("id", "id"), body_field!("context", "context"),],
        200,
        false
    ),
    route!(
        "rejectGlossaryTerm",
        DELETE,
        "/discoveries/glossary-terms/{id}",
        [
            path_field!("id", "id"),
            body_field!("context", "context"),
            body_field!("reason", "reason"),
        ],
        200,
        false
    ),
    route!(
        "ask",
        POST,
        "/inquiries/conversations",
        [
            body_field!("conversation_id", "conversationId"),
            body_field!("question", "question"),
            body_field!("context", "context"),
        ],
        201,
        true
    ),
    route!(
        "getInquiry",
        GET,
        "/inquiries/conversations/{conversation_id}",
        [path_field!("conversation_id", "conversationId")],
        200,
        false
    ),
    route!(
        "closeAsk",
        DELETE,
        "/inquiries/conversations/{conversation_id}",
        [path_field!("conversation_id", "conversationId")],
        200,
        false
    ),
    route!("getProviders", GET, "/providers", [], 200, false),
    route!(
        "createProvider",
        POST,
        "/providers",
        [
            body_field!("request_id", "requestId"),
            body_field!("provider", "provider"),
            body_field!("label", "label"),
            body_field!("key", "key"),
        ],
        201,
        true
    ),
    route!(
        "saveProvider",
        PUT,
        "/providers/{id}",
        [
            path_field!("id", "id"),
            body_field!("request_id", "requestId"),
            body_field!("provider", "provider"),
            body_field!("label", "label"),
            body_field!("key", "key"),
        ],
        200,
        false
    ),
    route!(
        "deleteProvider",
        DELETE,
        "/providers/{id}",
        [
            path_field!("id", "id"),
            body_field!("request_id", "requestId"),
        ],
        200,
        false
    ),
    route!(
        "setProviderEnabled",
        PATCH,
        "/providers/{id}",
        [
            path_field!("id", "id"),
            body_field!("request_id", "requestId"),
            body_field!("enabled", "enabled"),
        ],
        200,
        false
    ),
    route!(
        "refreshProviders",
        POST,
        "/provider-refreshes",
        [],
        202,
        true
    ),
];

/// Whether one first path segment belongs to the REST surface.
///
/// A path under such a root is an operation request, never a file: the static
/// surface must not answer one as a missing document.
pub fn serves_root(segment: &str) -> bool {
    ROUTES.iter().any(|route| {
        route
            .path
            .trim_start_matches('/')
            .split('/')
            .next()
            .is_some_and(|root| root == segment)
    })
}

/// The methods one path serves, in the order the table lists them.
pub fn methods_for_path(path: &str) -> Vec<&'static str> {
    let mut methods = Vec::new();
    for route in ROUTES {
        if match_template(route.path, path).is_some() {
            let method = route.method.as_str();
            if !methods.contains(&method) {
                methods.push(method);
            }
            if route.method == Method::GET && !methods.contains(&"HEAD") {
                methods.push("HEAD");
            }
        }
    }
    methods
}

/// Splits a path into percent-decoded segments.
fn path_segments(path: &str) -> Option<Vec<String>> {
    if path == "/" || path.is_empty() {
        return None;
    }
    if path.ends_with('/') {
        return None;
    }
    let raw = path.strip_prefix('/').unwrap_or(path);
    let mut segments = Vec::new();
    for segment in raw.split('/') {
        if segment.is_empty() {
            return None;
        }
        segments.push(percent_decode(segment)?);
    }
    Some(segments)
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let hex = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    };
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex(*bytes.get(index + 1)?)?;
            let low = hex(*bytes.get(index + 2)?)?;
            out.push(high * 16 + low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Matches one template against decoded path segments, returning the fields.
fn match_template<'a>(template: &'a str, path: &str) -> Option<Vec<(&'a str, String)>> {
    let template_segments: Vec<&str> = template
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let path_segments = path_segments(path)?;
    if template_segments.len() != path_segments.len() {
        return None;
    }
    let mut captures = Vec::new();
    for (template_segment, actual) in template_segments.iter().zip(path_segments.iter()) {
        if let Some(name) = template_segment
            .strip_prefix('{')
            .and_then(|rest| rest.strip_suffix('}'))
        {
            if actual.is_empty() {
                return None;
            }
            captures.push((name, actual.clone()));
        } else if template_segment != actual {
            return None;
        }
    }
    Some(captures)
}

/// One matched route with its path parameters.
struct Matched<'a> {
    route: &'a Route,
    captures: Vec<(&'static str, String)>,
}

fn match_route(method: &Method, path: &str) -> Option<Matched<'static>> {
    let wanted = if *method == Method::HEAD {
        Method::GET
    } else {
        method.clone()
    };
    for route in ROUTES {
        if route.method != wanted {
            continue;
        }
        if let Some(captures) = match_template(route.path, path) {
            return Some(Matched { route, captures });
        }
    }
    None
}

/// Reads one JSON object from the request body.
async fn read_object(body: Body) -> Result<Map<String, Value>, String> {
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .map_err(|_| "The request body could not be read.".to_string())?;
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The request body is not valid JSON.".to_string())?;
    match value {
        Value::Object(object) => Ok(object),
        _ => Err("The request body must be a JSON object.".to_string()),
    }
}

/// Parses a query or path value into the JSON shape the dispatcher reads.
fn scalar(text: &str) -> Value {
    if text == "null" {
        return Value::Null;
    }
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        if value.is_boolean() || value.is_number() {
            return value;
        }
    }
    Value::String(text.to_string())
}

/// Builds one command object from the request pieces.
fn build_command(
    matched: &Matched<'static>,
    query: &[(String, String)],
    body: &Map<String, Value>,
) -> Result<Command, String> {
    let mut object = Map::new();
    object.insert(
        "type".to_string(),
        Value::String(matched.route.command.to_string()),
    );
    for field in matched.route.fields {
        let value = match field.from {
            From::Path => matched
                .captures
                .iter()
                .find(|(name, _)| *name == field.name)
                .map(|(_, value)| Value::String(value.clone()))
                .ok_or_else(|| format!("The request path has no {}.", field.name))?,
            From::Query => match query
                .iter()
                .find(|(name, _)| name == field.name)
                .map(|(_, value)| value)
            {
                Some(value) => scalar(value),
                None => return Err(format!("The query parameter {} is required.", field.name)),
            },
            From::Body => match body.get(field.name).or_else(|| body.get(field.field)) {
                Some(value) => value.clone(),
                None => continue,
            },
        };
        object.insert(field.field.to_string(), value);
    }
    let text = serde_json::to_string(&Value::Object(object))
        .map_err(|_| "The command could not be encoded.".to_string())?;
    command_from_json(&text).ok_or_else(|| "The request names an unknown operation.".to_string())
}

/// The HTTP request one command object becomes. The MCP server and the
/// benchmark use this so no consumer rebuilds the retired frame protocol.
pub fn request_for_command(command: &Value) -> Result<(Method, String, Value), String> {
    let object = command
        .as_object()
        .ok_or_else(|| "The command must be a JSON object.".to_string())?;
    let name = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "The command has no type.".to_string())?;
    let route = ROUTES
        .iter()
        .find(|route| route.command == name)
        .ok_or_else(|| format!("{name} has no HTTP operation."))?;
    let mut path = route.path.to_string();
    let mut body = Map::new();
    let path_fields: Vec<&str> = route
        .fields
        .iter()
        .filter(|field| field.from == From::Path)
        .map(|field| field.field)
        .collect();
    for field in route.fields {
        match field.from {
            From::Path => {
                let value = object
                    .get(field.field)
                    .ok_or_else(|| format!("The command has no {}.", field.field))?;
                let text = match value {
                    Value::String(text) => text.clone(),
                    other => crate::jsjson::stringify(other),
                };
                path = path.replace(&format!("{{{}}}", field.name), &percent_encode(&text));
            }
            From::Query => {
                if let Some(value) = object.get(field.field) {
                    let text = match value {
                        Value::String(text) => text.clone(),
                        other => crate::jsjson::stringify(other),
                    };
                    let separator = if path.contains('?') { '&' } else { '?' };
                    path.push(separator);
                    path.push_str(&format!("{}={}", field.name, percent_encode(&text)));
                }
            }
            From::Body => {
                if let Some(value) = object.get(field.field) {
                    body.insert(field.field.to_string(), value.clone());
                }
            }
        }
    }
    for (key, value) in object {
        if key == "type" || path_fields.contains(&key.as_str()) {
            continue;
        }
        if !body.contains_key(key) {
            body.insert(key.clone(), value.clone());
        }
    }
    Ok((route.method.clone(), path, Value::Object(body)))
}

fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The one JSON envelope every operation answers.
pub fn envelope(frames: Vec<Value>) -> Value {
    let mut object = Map::new();
    object.insert("frames".to_string(), Value::Array(frames));
    Value::Object(object)
}

fn etag_for(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    format!("\"{}\"", &hex::encode(digest)[..32])
}

fn header_matches(header: Option<&str>, etag: &str) -> bool {
    let Some(header) = header else {
        return false;
    };
    header.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate == etag || candidate == format!("W/{etag}")
    })
}

/// One representation answer: ETag, conditional GET, gzip, and HEAD.
pub fn representation(
    method: &Method,
    headers: &HeaderMap,
    status: u16,
    body: Value,
    extra: &[(&str, String)],
) -> Response {
    let document = crate::jsjson::stringify(&body);
    let etag = etag_for(document.as_bytes());
    let mut extras: Vec<(&str, String)> = vec![
        ("ETag", etag.clone()),
        ("Cache-Control", "no-cache".to_string()),
        ("Vary", "Accept-Encoding".to_string()),
    ];
    extras.extend(extra.iter().cloned());
    let not_modified = *method == Method::GET
        && header_matches(
            headers
                .get(header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok()),
            &etag,
        );
    if not_modified {
        let mut builder = Response::builder().status(StatusCode::NOT_MODIFIED);
        for (name, value) in extras {
            builder = builder.header(name, value);
        }
        return builder.body(Body::empty()).unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::empty())
                .expect("a fixed empty answer builds")
        });
    }
    let gzip = accepts_gzip(
        headers
            .get(header::ACCEPT_ENCODING)
            .and_then(|value| value.to_str().ok()),
    );
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header(header::CONTENT_TYPE, "application/json;charset=utf-8");
    let payload = if gzip {
        builder = builder.header(header::CONTENT_ENCODING, "gzip");
        gzip_bytes(document.as_bytes())
    } else {
        document.into_bytes()
    };
    for (name, value) in extras {
        builder = builder.header(name, value);
    }
    let payload = if *method == Method::HEAD {
        Vec::new()
    } else {
        payload
    };
    builder
        .body(Body::from(payload))
        .unwrap_or_else(|_| Replies::problem(headers, 500, "An internal error occurred.", &[]))
}

fn absolute(url: &Url, path: &str) -> String {
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str()
            .map(|host| match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            })
            .unwrap_or_default(),
        path
    )
}

/// The item path a creation's answer names, or `None` when the operation
/// creates nothing addressable and answers no `Location`.
fn created_location(route: &Route, request_path: &str, body: &Value) -> Option<String> {
    match route.location {
        Location::None => None,
        Location::AgentRun => {
            let frame = body
                .get("frames")
                .and_then(Value::as_array)?
                .iter()
                .rev()
                .find(|frame| frame.get("type").and_then(Value::as_str) == Some("agentState"))?;
            let run_id = frame
                .get("agent")
                .and_then(|agent| agent.get("runId"))
                .and_then(Value::as_str)?;
            Some(format!("/agent-runs/{}", percent_encode(run_id)))
        }
        Location::Draft => request_path.strip_suffix("/runs").map(str::to_string),
    }
}

fn page_links(url: &Url, path: &str, cursor: u64, limit: u64, next: bool, prev: bool) -> Value {
    let link = |cursor: u64| absolute(url, &format!("{path}?cursor={cursor}&limit={limit}"));
    let self_link = absolute(url, &format!("{path}?cursor={cursor}&limit={limit}"));
    json_object(vec![
        ("self", Value::String(self_link)),
        (
            "next",
            if next {
                Value::String(link(cursor + limit))
            } else {
                Value::Null
            },
        ),
        (
            "prev",
            if prev {
                Value::String(link(cursor.saturating_sub(limit)))
            } else {
                Value::Null
            },
        ),
    ])
}

fn json_object(entries: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    for (key, value) in entries {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

/// Paginates the one large collection: `/records`.
fn paginate_records(url: &Url, query: &[(String, String)], frames: &mut [Value], body: &mut Value) {
    let cursor: u64 = query
        .iter()
        .find(|(name, _)| name == "cursor")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let limit: u64 = query
        .iter()
        .find(|(name, _)| name == "limit")
        .and_then(|(_, value)| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(200)
        .min(200);
    let Some(frame) = frames
        .iter_mut()
        .find(|frame| frame.get("type").and_then(Value::as_str) == Some("records"))
    else {
        return;
    };
    let Some(records) = frame.get("records").and_then(Value::as_array).cloned() else {
        return;
    };
    let total = records.len() as u64;
    let start = cursor.min(total);
    let end = (start + limit).min(total);
    let page: Vec<Value> = records[start as usize..end as usize].to_vec();
    if let Some(object) = frame.as_object_mut() {
        object.insert("records".to_string(), Value::Array(page));
    }
    let links = page_links(url, "/records", cursor, limit, end < total, start > 0);
    if let Some(object) = body.as_object_mut() {
        if let Some(link_object) = links.as_object() {
            for (key, value) in link_object {
                object.insert(key.clone(), value.clone());
            }
        }
    }
}

/// Handles one REST request, or returns `None` when the path is not an API
/// route and the static surface must answer it.
pub async fn handle(app: &App, request: axum::extract::Request) -> Option<Response> {
    let method = request.method().clone();
    let headers = request.headers().clone();
    let uri = request.uri().clone();
    let path = uri.path();
    let query = uri.query().unwrap_or("");
    let parsed_query = Url::parse(&format!(
        "http://placeholder{}{}",
        path,
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    ))
    .ok()
    .map(|url| {
        url.query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    let matched = match_route(&method, path);
    let Some(matched) = matched else {
        if methods_for_path(path).is_empty() {
            return None;
        }
        let allow = methods_for_path(path).join(", ");
        return Some(Replies::problem(
            &headers,
            405,
            "This path does not serve the request method.",
            &[("Allow", allow.as_str())],
        ));
    };
    let idempotency_key = match crate::idempotency::parse_idempotency_key(
        headers
            .get("idempotency-key")
            .and_then(|value| value.to_str().ok()),
    ) {
        Ok(key) => key,
        Err(error) => {
            return Some(Replies::problem(
                &headers,
                error.status,
                &error.message,
                &[],
            ))
        }
    };
    let body = request.into_body();
    let body_object = match read_object(body).await {
        Ok(object) => object,
        Err(detail) => return Some(Replies::problem(&headers, 400, &detail, &[])),
    };
    let command = match build_command(&matched, &parsed_query, &body_object) {
        Ok(command) => command,
        Err(detail) => return Some(Replies::problem(&headers, 400, &detail, &[])),
    };
    let url = Url::parse(&format!(
        "http://{}{}{}",
        headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("127.0.0.1"),
        path,
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    ))
    .unwrap_or_else(|_| Url::parse("http://127.0.0.1/").expect("a fixed URL"));
    let scope = format!("{} {}", method.as_str(), path);
    let cached = match app
        .idempotency
        .run(&scope, idempotency_key.as_deref(), || async move {
            let frames = app.dispatch_captured(command).await;
            let mut response_body = envelope(frames);
            if matched.route.command == "listRecords" {
                let mut records = response_body
                    .get("frames")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                paginate_records(&url, &parsed_query, &mut records, &mut response_body);
                if let Some(object) = response_body.as_object_mut() {
                    object.insert("frames".to_string(), Value::Array(records));
                }
            }
            let mut extra: Vec<(&str, String)> = Vec::new();
            if let Some(item) = created_location(matched.route, path, &response_body) {
                extra.push(("Location", absolute(&url, &item)));
            }
            Ok(stored_rest(matched.route.status, &response_body, &extra))
        })
        .await
    {
        Ok(cached) => cached,
        Err(error) => {
            return Some(Replies::problem(
                &headers,
                error.status,
                &error.message,
                &[],
            ))
        }
    };
    let (status, body, extra) = replay_rest(&cached);
    let extra: Vec<(&str, String)> = extra
        .iter()
        .map(|(name, value)| (name.as_str(), value.clone()))
        .collect();
    Some(representation(&method, &headers, status, body, &extra))
}

/// The answer one keyed request keeps in the idempotency store.
///
/// The status, the body, and the headers a replay must reproduce travel as
/// one JSON value, so the store persists exactly what the first request
/// answered and a restart replays it unchanged.
fn stored_rest(status: u16, body: &Value, extra: &[(&str, String)]) -> Value {
    let headers: Vec<Value> = extra
        .iter()
        .map(|(name, value)| {
            Value::Array(vec![
                Value::String((*name).to_string()),
                Value::String(value.clone()),
            ])
        })
        .collect();
    let mut stored = Map::new();
    stored.insert("status".to_string(), Value::from(status));
    stored.insert("body".to_string(), body.clone());
    stored.insert("headers".to_string(), Value::Array(headers));
    Value::Object(stored)
}

/// The status, body, and extra headers a replay answers.
fn replay_rest(stored: &Value) -> (u16, Value, Vec<(String, String)>) {
    let status = stored
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .unwrap_or(500);
    let body = stored.get("body").cloned().unwrap_or(Value::Null);
    let extra = stored
        .get("headers")
        .and_then(Value::as_array)
        .map(|pairs| {
            pairs
                .iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    Some((
                        pair.first()?.as_str()?.to_string(),
                        pair.get(1)?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    (status, body, extra)
}

/// The 421 for a host this listener does not serve, or the 403 for a
/// cross-origin request.
pub fn guard_answer(headers: &HeaderMap, refusal: RequestRefusal) -> Response {
    crate::http::refusal_problem(headers, refusal, "Cross-origin requests are refused.")
}

/// Checks a request against the host and origin guards.
pub fn guard(
    headers: &HeaderMap,
    url: &Url,
    allowed: &std::collections::HashSet<String>,
) -> Option<Response> {
    request_refusal(headers, url, allowed).map(|refusal| guard_answer(headers, refusal))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_table_lists_every_served_operation_and_no_socket() {
        assert_eq!(ROUTES.len(), 82);
        for route in ROUTES {
            assert!(route.path.starts_with('/'));
            assert!(!route.path.starts_with("/api"));
            assert!(!route.path.ends_with('/'));
            assert!(!route.path.contains("/ws"));
        }
    }

    #[test]
    fn the_inquiry_read_maps_to_the_conversation_resource() {
        let (method, path, body) = request_for_command(&json!({
            "type": "getInquiry",
            "conversationId": "conversation-1",
        }))
        .expect("an inquiry request");
        assert_eq!(method, Method::GET);
        assert_eq!(path, "/inquiries/conversations/conversation-1");
        assert!(body.as_object().map(|object| object.is_empty()) == Some(true));
    }

    #[test]
    fn only_a_creation_with_an_addressable_answer_names_a_location() {
        for route in ROUTES {
            if !route.creation {
                assert_eq!(
                    route.location,
                    Location::None,
                    "{} creates nothing and answers no Location",
                    route.command
                );
            }
        }
        let source = |command: &str| {
            ROUTES
                .iter()
                .find(|route| route.command == command)
                .unwrap_or_else(|| panic!("{command} is served"))
                .location
        };
        assert_eq!(source("startAgent"), Location::AgentRun);
        assert_eq!(source("startGoalDraft"), Location::Draft);
        assert_eq!(source("startRun"), Location::None);
        assert_eq!(source("createProvider"), Location::None);
        assert_eq!(source("retryFlowPr"), Location::None);
    }

    #[test]
    fn every_creation_either_answers_no_location_or_names_a_served_read() {
        let body = json!({"frames": [
            {"type": "agentState", "agent": {"id": "scout", "runId": "scout--1.2.3"}},
        ]});
        for route in ROUTES.iter().filter(|route| route.creation) {
            match route.location {
                Location::None => assert_eq!(
                    created_location(route, route.path, &body),
                    None,
                    "{} creates nothing addressable",
                    route.command
                ),
                Location::AgentRun => {
                    let path = created_location(route, route.path, &body)
                        .expect("a run creation names its run");
                    assert_eq!(path, "/agent-runs/scout--1.2.3");
                }
                Location::Draft => {
                    let path = created_location(
                        route,
                        "/goal-drafts/.devboard%2Fgoal-proposals%2Fa.md/runs",
                        &body,
                    )
                    .expect("a draft creation names its draft");
                    assert!(
                        methods_for_path(&path).contains(&"GET"),
                        "{path} is served by a GET"
                    );
                }
            }
        }
    }

    #[test]
    fn a_run_location_names_the_run_the_answer_reports() {
        let route = ROUTES
            .iter()
            .find(|route| route.command == "startAgent")
            .expect("startAgent is served");
        let body = json!({"frames": [
            {"type": "agentState", "agent": {"id": "scout", "runId": null}},
            {"type": "agentState", "agent": {"id": "scout", "runId": "scout--1.2.3"}},
        ]});
        assert_eq!(
            created_location(route, "/agents/scout/runs", &body).as_deref(),
            Some("/agent-runs/scout--1.2.3")
        );
        let stopped = json!({"frames": [
            {"type": "agentState", "agent": {"id": "scout", "runId": null}},
            {"type": "error", "message": "unknown"},
        ]});
        assert_eq!(
            created_location(route, "/agents/scout/runs", &stopped),
            None,
            "a start that created no run answers no Location"
        );
    }

    #[test]
    fn a_draft_location_names_the_draft_not_the_run_collection() {
        let route = ROUTES
            .iter()
            .find(|route| route.command == "startGoalDraft")
            .expect("startGoalDraft is served");
        assert_eq!(
            created_location(
                route,
                "/goal-drafts/.devboard%2Fgoal-proposals%2Fa.md/runs",
                &json!({"frames": []}),
            )
            .as_deref(),
            Some("/goal-drafts/.devboard%2Fgoal-proposals%2Fa.md")
        );
    }

    #[test]
    fn ask_maps_to_one_creation_request() {
        let (method, path, body) = request_for_command(&json!({
            "type": "ask",
            "conversationId": "conversation-1",
            "question": "What?",
            "context": {"route": "/issues"},
        }))
        .expect("an ask request");
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/inquiries/conversations");
        assert_eq!(body["conversationId"], "conversation-1");
    }

    #[test]
    fn provider_create_and_update_map_to_the_collection_and_item() {
        let (method, path, body) = request_for_command(&json!({
            "type": "createProvider",
            "requestId": 1,
            "provider": "opencode-go",
            "label": "main",
            "key": "sk-test",
        }))
        .expect("a create request");
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/providers");
        assert_eq!(body["requestId"], 1);
        assert_eq!(body["provider"], "opencode-go");

        let (method, path, _) = request_for_command(&json!({
            "type": "saveProvider",
            "id": "subscription-1",
            "requestId": 2,
            "provider": "opencode-go",
            "label": "main",
        }))
        .expect("an update request");
        assert_eq!(method, Method::PUT);
        assert_eq!(path, "/providers/subscription-1");
    }

    #[test]
    fn a_large_collection_answers_a_page_object() {
        let url = Url::parse("http://127.0.0.1:8080/records?cursor=2&limit=2").expect("a URL");
        let mut frames = vec![json!({
            "type": "records",
            "records": (0..6).map(|index| json!({"file": format!("{index}.md")})).collect::<Vec<_>>(),
        })];
        let mut body = envelope(frames.clone());
        let query = vec![
            ("cursor".to_string(), "2".to_string()),
            ("limit".to_string(), "2".to_string()),
        ];
        paginate_records(&url, &query, &mut frames, &mut body);
        let page = frames[0]["records"].as_array().expect("records");
        assert_eq!(page.len(), 2);
        assert_eq!(page[0]["file"], "2.md");
        assert_eq!(
            body["self"],
            "http://127.0.0.1:8080/records?cursor=2&limit=2"
        );
        assert!(body["next"].is_string());
        assert!(body["prev"].is_string());
    }

    #[test]
    fn path_templates_match_and_decode() {
        let matched = match_route(&Method::GET, "/issues/runs/abc").expect("a route");
        assert_eq!(matched.route.command, "getIssuesRun");
        assert_eq!(matched.captures[0].1, "abc");
        let matched = match_route(&Method::GET, "/goal-drafts/a%2Fb.md").expect("a route");
        assert_eq!(matched.route.command, "getGoalDraft");
        assert_eq!(matched.captures[0].1, "a/b.md");
    }
}
