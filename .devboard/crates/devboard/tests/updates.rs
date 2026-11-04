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
fn only_an_unreachable_or_rate_limited_check_is_transient() {
    assert!(devboard::updates::is_transient_update_failure(
        "error sending request for url (http://localhost:3001/api/v1/repos/dsdenes/devboard/releases/latest)"
    ));
    assert!(devboard::updates::is_transient_update_failure(
        "GET http://localhost:3001/api/v1/repos/x/releases/latest failed (HTTP 429): slow down"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "the release manifest is invalid"
    ));
    assert!(!devboard::updates::is_transient_update_failure(
        "the Gitea manifest checksum does not match the manifest"
    ));
}
