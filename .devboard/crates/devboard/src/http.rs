//! The HTTP surface: readiness, static SPA serving, the two mutating
//! endpoints, and the WebSocket upgrade guards.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::FromRequestParts;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use flate2::write::GzEncoder;
use flate2::Compression;
use url::Url;

use crate::app::{App, Conn};
use crate::config::Config;
use crate::jsjson;
use crate::protocol::parse_client_message;

/// The header a client sends and the dashboard echoes.
const FLOW_ID_HEADER: &str = "x-flow-id";
/// The longest flow id a client may send.
const MAX_FLOW_ID: usize = 200;
/// A C0 control character or DEL in a decoded request path.
fn has_control_character(text: &str) -> bool {
    text.chars().any(|character| {
        let code = character as u32;
        code <= 0x1f || code == 0x7f
    })
}

/// Names a loopback listener answers to besides its configured address.
const LOOPBACK_HOSTNAMES: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// Bind addresses that name no host a browser can put in a URL.
fn is_wildcard(hostname: &str) -> bool {
    hostname == "0.0.0.0" || hostname == "[::]"
}

/// A hostname in the form JavaScript's `URL.hostname` reports, or `None`.
pub fn canonical_hostname(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(url) = Url::parse(&format!("http://{trimmed}")) {
        return Some(url.host_str()?.to_ascii_lowercase());
    }
    if !trimmed.contains(':') || trimmed.starts_with('[') {
        return None;
    }
    Url::parse(&format!("http://[{trimmed}]"))
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
}

/// The hostnames this listener serves.
pub fn allowed_request_hostnames(bound: &str, configured: &[String]) -> HashSet<String> {
    let mut allowed: HashSet<String> = LOOPBACK_HOSTNAMES
        .iter()
        .map(|value| (*value).to_string())
        .collect();
    if let Some(hostname) = canonical_hostname(bound) {
        if !is_wildcard(&hostname) {
            allowed.insert(hostname);
        }
    }
    for value in configured {
        if let Some(hostname) = canonical_hostname(value) {
            if !is_wildcard(&hostname) {
                allowed.insert(hostname);
            }
        }
    }
    allowed
}

/// Why a browser request must be refused, or `None` when it may proceed.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RequestRefusal {
    Host,
    Origin,
}

/// The host and origin guards shared by the mutating endpoints and the socket.
pub fn request_refusal(
    headers: &HeaderMap,
    url: &Url,
    allowed: &HashSet<String>,
) -> Option<RequestRefusal> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let hostname = host.and_then(canonical_hostname);
    match hostname {
        Some(hostname) if allowed.contains(&hostname) => {}
        _ => return Some(RequestRefusal::Host),
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())?;
    match Url::parse(origin) {
        Ok(origin) if host_with_port(&origin) == host_with_port(url) => None,
        _ => Some(RequestRefusal::Origin),
    }
}

/// `url.host` in the JavaScript sense: host plus a non-default port.
fn host_with_port(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// The reason phrase each failure status carries.
fn problem_title(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Content Too Large",
        421 => "Misdirected Request",
        426 => "Upgrade Required",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

/// Whether an `Accept-Encoding` header admits a gzip response.
pub fn accepts_gzip(header: Option<&str>) -> bool {
    let Some(header) = header else {
        return false;
    };
    let mut wildcard: Option<bool> = None;
    for entry in header.split(',') {
        let mut parts = entry.split(';');
        let name = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        let mut quality = 1.0f64;
        for parameter in parts {
            let Some((key, value)) = parameter.split_once('=') else {
                continue;
            };
            if key.trim().eq_ignore_ascii_case("q") {
                quality = value.trim().parse::<f64>().unwrap_or(0.0);
                if !quality.is_finite() {
                    quality = 0.0;
                }
            }
        }
        if name == "gzip" {
            return quality > 0.0;
        }
        if name == "*" {
            wildcard = Some(quality > 0.0);
        }
    }
    wildcard.unwrap_or(false)
}

/// The gzip encoding of an in-memory body.
pub fn gzip_bytes(body: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    use std::io::Write as _;
    let _ = encoder.write_all(body);
    encoder.finish().unwrap_or_default()
}

/// One static file's negotiated answer cache.
pub struct StaticCache {
    inner: Mutex<std::collections::HashMap<PathBuf, CachedFile>>,
}

struct CachedFile {
    modified: Option<std::time::SystemTime>,
    size: u64,
    body: Vec<u8>,
}

impl Default for StaticCache {
    fn default() -> Self {
        Self::new()
    }
}

impl StaticCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn gzip(
        &self,
        path: &Path,
        body: &[u8],
        modified: Option<std::time::SystemTime>,
        size: u64,
    ) -> Vec<u8> {
        if let Ok(cache) = self.inner.lock() {
            if let Some(entry) = cache.get(path) {
                if entry.modified == modified && entry.size == size {
                    return entry.body.clone();
                }
            }
        }
        let encoded = gzip_bytes(body);
        if let Ok(mut cache) = self.inner.lock() {
            cache.insert(
                path.to_path_buf(),
                CachedFile {
                    modified,
                    size,
                    body: encoded.clone(),
                },
            );
        }
        encoded
    }
}

impl Server {
    /// Builds one dashboard server from its configuration and journal.
    pub fn new(config: Config, journal: crate::journal::Journal) -> Arc<Self> {
        let mut config = config;
        if let Some(source) = config.static_dir.clone() {
            let version =
                crate::version::read_harness_version(&crate::version::running_harness_dir())
                    .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
            match crate::assets::snapshot_static(&source, &config.state_dir, &version) {
                Ok(snapshot) => config.static_dir = Some(snapshot),
                Err(error) => {
                    journal.write("server-error", &format!("static snapshot: {error}"), None)
                }
            }
        }
        let allowed_hostnames = allowed_request_hostnames(&config.hostname, &config.allowed_hosts);
        let app = App::new(config.clone(), journal);
        Arc::new(Self {
            app,
            allowed_hostnames,
            static_cache: StaticCache::new(),
            config,
        })
    }
}

/// Everything one listener needs besides the application.
pub struct Server {
    pub app: Arc<App>,
    pub config: Config,
    pub allowed_hostnames: HashSet<String>,
    pub static_cache: StaticCache,
}

/// The HTTP answer helpers: JSON and Problem bodies negotiated through
/// `Accept-Encoding`.
pub struct Replies;

impl Replies {
    /// One JSON answer, gzip when the request accepts it.
    pub fn json(
        headers: &HeaderMap,
        body: serde_json::Value,
        status: u16,
        extra: &[(&str, &str)],
    ) -> Response {
        let document = jsjson::stringify(&body);
        Self::json_text(headers, document, status, extra)
    }

    /// One JSON answer already serialized.
    pub fn json_text(
        headers: &HeaderMap,
        document: String,
        status: u16,
        extra: &[(&str, &str)],
    ) -> Response {
        Self::document(
            headers,
            document,
            status,
            "application/json;charset=utf-8",
            extra,
        )
    }

    /// One serialized document with an explicit content type.
    fn document(
        headers: &HeaderMap,
        document: String,
        status: u16,
        content_type: &'static str,
        extra: &[(&str, &str)],
    ) -> Response {
        let gzip = accepts_gzip(
            headers
                .get(header::ACCEPT_ENCODING)
                .and_then(|value| value.to_str().ok()),
        );
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
            .header(header::CONTENT_TYPE, content_type)
            .header(header::VARY, "Accept-Encoding");
        let body = if gzip {
            builder = builder.header(header::CONTENT_ENCODING, "gzip");
            gzip_bytes(document.as_bytes())
        } else {
            document.into_bytes()
        };
        for (name, value) in extra {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::from(body)).unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::empty())
                .expect("a fixed empty answer builds")
        })
    }

    /// One RFC 9457 failure body.
    pub fn problem(
        headers: &HeaderMap,
        status: u16,
        detail: &str,
        extra: &[(&str, &str)],
    ) -> Response {
        let mut body = serde_json::Map::new();
        body.insert("type".into(), "about:blank".into());
        body.insert("title".into(), problem_title(status).into());
        body.insert("status".into(), status.into());
        body.insert("detail".into(), detail.into());
        let mut all: Vec<(&str, &str)> = vec![("Cache-Control", "no-store")];
        all.extend_from_slice(extra);
        Self::document(
            headers,
            jsjson::stringify(&serde_json::Value::Object(body)),
            status,
            "application/problem+json",
            &all,
        )
    }
}

/// The static path one request selects, relative to the static root.
pub fn static_relative_path(raw_pathname: &str, pathname: &str) -> Option<String> {
    let lower = raw_pathname.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") {
        return None;
    }
    if pathname == "/" {
        return Some("index.html".to_string());
    }
    if !pathname.starts_with('/') || pathname.ends_with('/') {
        return None;
    }
    let segments: Vec<&str> = pathname[1..].split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return None;
    }
    Some(segments.join("/"))
}

/// The content type Bun's `Bun.file(path).type` reports for a name.
pub fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html;charset=utf-8",
        "js" | "mjs" => "text/javascript;charset=utf-8",
        "css" => "text/css;charset=utf-8",
        "json" => "application/json;charset=utf-8",
        "map" => "application/json;charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain;charset=utf-8",
        "md" => "text/markdown;charset=utf-8",
        "wasm" => "application/wasm",
        "webmanifest" => "application/manifest+json",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

/// Parses one request's `X-Flow-ID`, refusing a malformed value with 400.
fn parse_flow_id(headers: &HeaderMap) -> Result<Option<String>, String> {
    let Some(value) = headers
        .get(FLOW_ID_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(None);
    };
    let flow_id = value.trim();
    if flow_id.is_empty() {
        return Err("X-Flow-ID must not be empty.".to_string());
    }
    if flow_id.chars().count() > MAX_FLOW_ID {
        return Err(format!(
            "X-Flow-ID is longer than {MAX_FLOW_ID} characters."
        ));
    }
    if !flow_id.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err("X-Flow-ID must be a printable token.".to_string());
    }
    Ok(Some(flow_id.to_string()))
}

/// Binds one dashboard listener.
pub async fn bind(hostname: &str, port: u16) -> std::io::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind((hostname, port)).await
}

/// Serves one bound listener until the process stops.
pub async fn serve_on(
    listener: tokio::net::TcpListener,
    server: Arc<Server>,
) -> std::io::Result<()> {
    let app = Arc::clone(&server.app);
    let shared = server.app.shared.clone();
    let router = axum::Router::new().fallback(handle).with_state(server);
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            shared.shutdown.notified().await;
        })
        .await;
    crate::discover_mode::shutdown(&app);
    result
}

/// Starts serving one dashboard listener.
pub async fn serve(server: Arc<Server>) -> std::io::Result<()> {
    let listener = bind(&server.config.hostname, server.config.port).await?;
    serve_on(listener, server).await
}

/// One request for the dashboard.
async fn handle(State(server): State<Arc<Server>>, request: Request) -> Response {
    let method = request.method().clone();
    let headers = request.headers().clone();
    let uri = request.uri().clone();
    let flow_id = match parse_flow_id(&headers) {
        Ok(flow_id) => flow_id,
        Err(detail) => return Replies::problem(&headers, 400, &detail, &[]),
    };
    let reply = |mut answer: Response| -> Response {
        if let Some(flow_id) = &flow_id {
            if let Ok(value) = HeaderValue::from_str(flow_id) {
                answer.headers_mut().insert(FLOW_ID_HEADER, value);
            }
        }
        answer
    };
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
    else {
        return reply(Replies::problem(
            &headers,
            400,
            "The request carries no valid Host header.",
            &[],
        ));
    };
    let url = match Url::parse(&format!(
        "http://{}{}",
        host,
        uri.path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/")
    )) {
        Ok(url) => url,
        Err(_) => {
            return reply(Replies::problem(
                &headers,
                400,
                "The request carries no valid Host header.",
                &[],
            ))
        }
    };
    // A Host this listener does not serve is misdirected: the three request
    // paths a browser opens directly never run against another site's name.
    let guarded_path = matches!(uri.path(), "/ws" | "/feedback" | "/goal-proposals")
        || uri.path().starts_with("/goal-proposals/");
    if guarded_path {
        if let Some(RequestRefusal::Host) =
            request_refusal(&headers, &url, &server.allowed_hostnames)
        {
            // The socket keeps 421; a mutation answers 403, naming the host.
            if uri.path() == "/ws" {
                return reply(refusal_answer(&headers, RequestRefusal::Host));
            }
            return reply(Replies::problem(
                &headers,
                403,
                "The request host is not served by this dashboard.",
                &[],
            ));
        }
    }

    match uri.path() {
        "/feedback" => {
            let (_parts, body) = request.into_parts();
            return reply(
                server
                    .app
                    .feedback(&method, &headers, &url, flow_id.as_deref(), body)
                    .await,
            );
        }
        "/ready" => {
            return reply(ready(&headers, &method));
        }
        "/goal-proposals" => {
            let (_parts, body) = request.into_parts();
            return reply(
                server
                    .app
                    .goal_proposals(&method, &headers, &url, flow_id.as_deref(), body)
                    .await,
            );
        }
        "/ws" => {
            if method != Method::GET {
                return reply(Replies::problem(
                    &headers,
                    405,
                    "This path serves GET only.",
                    &[("Allow", "GET")],
                ));
            }
            if let Some(refusal) = request_refusal(&headers, &url, &server.allowed_hostnames) {
                return reply(refusal_answer(&headers, refusal));
            }
            return reply(upgrade(server.clone(), request, &headers, flow_id.as_deref()).await);
        }
        _ => {}
    }

    if let Some(name) = uri.path().strip_prefix("/goal-proposals/") {
        return reply(draft_answer(&server, name, &method, &headers));
    }

    let raw_pathname = uri.path();
    let pathname = match percent_decode(raw_pathname) {
        Some(pathname) => pathname,
        None => {
            return reply(Replies::problem(
                &headers,
                400,
                "The request path is not valid percent-encoding.",
                &[],
            ))
        }
    };
    if has_control_character(&pathname) {
        let mut quoted = String::new();
        jsjson::write_string(raw_pathname, &mut quoted);
        return reply(Replies::problem(
            &headers,
            400,
            &format!("The request path {quoted} carries a control character."),
            &[],
        ));
    }
    let Some(relative) = static_relative_path(raw_pathname, &pathname) else {
        return reply(Replies::problem(
            &headers,
            404,
            "The requested file was not found.",
            &[],
        ));
    };
    // A file answer is never correlated with the call that asked for it: a
    // shared cache must not replay one client's flow id to another.
    static_file(&server, &relative, &method, &headers)
}

/// The 421 for a host this listener does not serve, or the 403 for a
/// cross-origin browser request.
pub fn refusal_problem(
    headers: &HeaderMap,
    refusal: RequestRefusal,
    origin_detail: &str,
) -> Response {
    match refusal {
        RequestRefusal::Host => Replies::problem(
            headers,
            421,
            "The request host is not served by this dashboard.",
            &[],
        ),
        RequestRefusal::Origin => Replies::problem(headers, 403, origin_detail, &[]),
    }
}

fn refusal_answer(headers: &HeaderMap, refusal: RequestRefusal) -> Response {
    refusal_problem(
        headers,
        refusal,
        "Cross-origin WebSocket upgrades are refused.",
    )
}

/// One written draft, served where `POST /goal-proposals` linked it.
fn draft_answer(server: &Server, raw_name: &str, method: &Method, headers: &HeaderMap) -> Response {
    let name = percent_decode(raw_name).unwrap_or_default();
    if name.is_empty() || name.contains('/') || !name.ends_with(".md") {
        return Replies::problem(headers, 404, "The requested draft was not found.", &[]);
    }
    let directory = server
        .config
        .repo_dir
        .join(crate::goal_drafts::GOAL_PROPOSALS_DIRECTORY);
    let path = directory.join(&name);
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        return Replies::problem(headers, 404, "The requested draft was not found.", &[]);
    };
    if !metadata.is_file() {
        return Replies::problem(headers, 404, "The requested draft was not found.", &[]);
    }
    if *method != Method::GET && *method != Method::HEAD {
        return Replies::problem(
            headers,
            405,
            "This path serves GET and HEAD only.",
            &[("Allow", "GET, HEAD")],
        );
    }
    let Ok(body) = std::fs::read(&path) else {
        return Replies::problem(headers, 500, "An internal error occurred.", &[]);
    };
    let gzip = accepts_gzip(
        headers
            .get(header::ACCEPT_ENCODING)
            .and_then(|value| value.to_str().ok()),
    );
    let payload = if gzip { gzip_bytes(&body) } else { body };
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/markdown;charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::VARY, "Accept-Encoding");
    if gzip {
        builder = builder.header(header::CONTENT_ENCODING, "gzip");
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

/// `/ready`: the pid of the process that answered.
fn ready(headers: &HeaderMap, method: &Method) -> Response {
    if *method != Method::GET && *method != Method::HEAD {
        return Replies::problem(
            headers,
            405,
            "This path serves GET and HEAD only.",
            &[("Allow", "GET, HEAD")],
        );
    }
    let mut body = serde_json::Map::new();
    body.insert("pid".into(), std::process::id().into());
    let answer = Replies::json(
        headers,
        serde_json::Value::Object(body),
        200,
        &[("Cache-Control", "no-store")],
    );
    if *method == Method::HEAD {
        let (parts, _) = answer.into_parts();
        return Response::from_parts(parts, Body::empty());
    }
    answer
}

/// Serves one file under the static root, or from the embedded client.
fn static_file(server: &Server, relative: &str, method: &Method, headers: &HeaderMap) -> Response {
    let served: Option<(Vec<u8>, Option<std::time::SystemTime>, u64)> =
        match &server.config.static_dir {
            Some(root) => match read_static_file(root, relative) {
                Ok(served) => served,
                Err(detail) => {
                    server.app.shared.journal.write(
                        "server-error",
                        &format!("GET static: {detail}"),
                        None,
                    );
                    return Replies::problem(headers, 500, "An internal error occurred.", &[]);
                }
            },
            None => crate::assets::lookup(relative)
                .map(|bytes| (bytes.to_vec(), None, bytes.len() as u64)),
        };
    let Some((body, modified, size)) = served else {
        return Replies::problem(headers, 404, "The requested file was not found.", &[]);
    };
    if *method != Method::GET && *method != Method::HEAD {
        return Replies::problem(
            headers,
            405,
            "This path serves GET and HEAD only.",
            &[("Allow", "GET, HEAD")],
        );
    }
    let cache_control = if relative.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let gzip = accepts_gzip(
        headers
            .get(header::ACCEPT_ENCODING)
            .and_then(|value| value.to_str().ok()),
    );
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(relative))
        .header(header::VARY, "Accept-Encoding")
        .header(header::CACHE_CONTROL, cache_control);
    let payload = if gzip {
        builder = builder.header(header::CONTENT_ENCODING, "gzip");
        server
            .static_cache
            .gzip(&PathBuf::from(relative), &body, modified, size)
    } else {
        body
    };
    let payload = if *method == Method::HEAD {
        Vec::new()
    } else {
        payload
    };
    builder
        .body(Body::from(payload))
        .unwrap_or_else(|_| Replies::problem(headers, 500, "An internal error occurred.", &[]))
}

/// Reads one file under a static root, refusing anything that escapes it.
fn read_static_file(
    root: &Path,
    relative: &str,
) -> Result<Option<(Vec<u8>, Option<std::time::SystemTime>, u64)>, String> {
    let canonical_root = match root.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let canonical_file = match root.join(relative).canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !canonical_file.starts_with(&canonical_root) {
        return Ok(None);
    }
    let metadata = match std::fs::metadata(&canonical_file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    match std::fs::read(&canonical_file) {
        Ok(body) => Ok(Some((body, metadata.modified().ok(), metadata.len()))),
        Err(error) => Err(error.to_string()),
    }
}

/// Decodes percent escapes in a request path, refusing invalid ones.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let hex_value = |byte: u8| -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    };
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_value(*bytes.get(index + 1)?)?;
            let low = hex_value(*bytes.get(index + 2)?)?;
            out.push(high * 16 + low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The 426 for a request that could not be upgraded.
async fn upgrade(
    server: Arc<Server>,
    request: Request,
    headers: &HeaderMap,
    flow_id: Option<&str>,
) -> Response {
    let (mut parts, _body) = request.into_parts();
    let upgraded = WebSocketUpgrade::from_request_parts(&mut parts, &()).await;
    let Ok(upgraded) = upgraded else {
        return Replies::problem(
            headers,
            426,
            "This path upgrades to a WebSocket.",
            &[("Upgrade", "websocket")],
        );
    };
    let mut answer = upgraded.on_upgrade(move |socket| run_socket(server, socket));
    if let Some(flow_id) = flow_id {
        if let Ok(value) = HeaderValue::from_str(flow_id) {
            answer.headers_mut().insert(FLOW_ID_HEADER, value);
        }
    }
    answer
}

/// One connected client's outbound queue.
pub type Outbox = tokio::sync::mpsc::UnboundedSender<String>;

async fn run_socket(server: Arc<Server>, socket: axum::extract::ws::WebSocket) {
    use futures_util::{SinkExt, StreamExt};

    let (out, mut outgoing) = tokio::sync::mpsc::unbounded_channel::<String>();
    let conn = Conn::new(out);
    server.app.register(conn.clone()).await;
    // The writer is its own task. A frame crosses the socket as soon as the
    // server produces it, even while this connection's command is still
    // running — a Start publishes its starting snapshot before its preflight,
    // and that snapshot is never withheld behind the preflight.
    let (mut sink, mut stream) = socket.split();
    let mut writer = tokio::spawn(async move {
        while let Some(frame) = outgoing.recv().await {
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    // The connect replay streams from its own task. It may spend seconds on
    // the slow parts (a timer read, a prompt read), and a `getAgents` read
    // must not wait behind it; the snapshot cache answers that read at once.
    let opener = {
        let server = Arc::clone(&server);
        let conn = conn.clone();
        tokio::spawn(async move {
            server.app.open(&conn).await;
        })
    };
    loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => match parse_client_message(&text) {
                Some(command) => server.app.command(&conn, command).await,
                None => {
                    let mut event = serde_json::Map::new();
                    event.insert("type".into(), "error".into());
                    event.insert("message".into(), "Invalid WebSocket message.".into());
                    conn.send(serde_json::Value::Object(event));
                }
            },
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Binary(_))) => {
                let mut event = serde_json::Map::new();
                event.insert("type".into(), "error".into());
                event.insert("message".into(), "Invalid WebSocket message.".into());
                conn.send(serde_json::Value::Object(event));
            }
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
        }
    }
    opener.abort();
    server.app.unregister(conn.id()).await;
    server.app.close(&conn).await;
    // Dropping the last sender this surface holds ends the writer, which
    // closes the socket after every queued frame is written. A mode may keep
    // a clone for a later push; that clone must not pin this task forever, so
    // a writer still waiting after the grace is stopped.
    drop(conn);
    if tokio::time::timeout(std::time::Duration::from_millis(250), &mut writer)
        .await
        .is_err()
    {
        writer.abort();
    }
}

/// Unused import guard: axum's `IntoResponse` is part of the response type.
#[allow(dead_code)]
fn _assert_into_response<T: IntoResponse>(_value: T) {}
