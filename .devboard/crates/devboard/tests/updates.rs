//! Release source resolution and transient update failures.

use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn gitea_url_alone_resolves_a_release_source() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let restore: Vec<(String, Option<String>)> =
        ["DEVBOARD_GITEA_URL", "GITEA_URL", "DEVBOARD_RELEASE_URL"]
            .iter()
            .map(|key| (key.to_string(), std::env::var(key).ok()))
            .collect();
    for key in ["DEVBOARD_GITEA_URL", "DEVBOARD_RELEASE_URL"] {
        std::env::remove_var(key);
    }
    std::env::set_var("GITEA_URL", "http://localhost:3001");
    let source = devboard::updates::manifest_source_from_env(std::path::Path::new("."))
        .expect("GITEA_URL alone resolves a source");
    assert_eq!(source.base_url, "http://localhost:3001");
    for (key, value) in restore {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}

#[test]
fn only_a_transport_failure_is_transient() {
    assert!(devboard::updates::is_transient_update_failure(
        "error sending request for url (http://localhost:3001/api/v1/repos/dsdenes/devboard/releases/latest)"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/x/releases/latest failed (HTTP 429): slow down"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/x/releases/latest returned an empty body"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET https://github.com/x/y/releases/latest/download/devboard-manifest.json returned a body that is not JSON: EOF while parsing a value at line 1 column 0"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "cannot read the body of GET http://localhost:3001/api/v1/repos/x/releases/latest: error decoding response body"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "the release manifest is invalid"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "the Gitea manifest checksum does not match the manifest"
    ));
}

/// A forge that answers 5xx is serving no release right now, not refusing the
/// request: the same line the live dashboard journaled for a restarting Gitea.
#[test]
fn a_server_error_status_is_a_transient_check_failure() {
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/dsdenes/devboard/releases/latest failed (HTTP 500): {\"message\":\"\",\"url\":\"http://localhost:3001/api/swagger\"}"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/dsdenes/devboard/releases/download/v1.44.13/devboard-manifest.json failed (HTTP 502)"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET https://github.com/dsdenes/devboard/releases/latest/download/devboard-manifest.json failed (HTTP 503)"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/dsdenes/devboard/releases/latest failed (HTTP 404): not found"
    ));
}
