//! The fixture HTTP surface: the one route the API Standards audit reads.

use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

pub fn health() -> bool {
    true
}

/// `GET /health` answers the fixture's readiness; any other path is absent.
pub async fn handle(uri: Uri, method: Method) -> Response {
    match uri.path() {
        "/health" => {
            if method != Method::GET {
                return (StatusCode::METHOD_NOT_ALLOWED, "GET only.").into_response();
            }
            (StatusCode::OK, "ready").into_response()
        }
        _ => (StatusCode::NOT_FOUND, "absent").into_response(),
    }
}
