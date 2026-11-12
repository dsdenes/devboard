//! One process-wide cache of a repository's published releases.
//!
//! Every surface that needs the release list — the dashboard projection,
//! Scout, Design, Dead Code, and the MCP optimizer's forge reads — shares one
//! walk per repository. Without it, each periodic reader walked every release
//! page on its own cadence, and the idle dashboard kept the forge walking
//! hundreds of rows it had already read. A walk inside the TTL answers from
//! memory; the first read after it expires walks again, so a release published
//! while the process runs becomes visible within one TTL.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::forge::{
    gitea_list_releases, gitea_release_by_tag, GiteaCallOptions, GiteaError, GiteaRelease,
    GiteaTarget, Transport,
};

/// How long one walk answers future reads.
pub const DEFAULT_RELEASE_CACHE_TTL_MS: u64 = 300_000;

struct Entry {
    read_at: Instant,
    releases: Vec<GiteaRelease>,
}

fn cache() -> &'static tokio::sync::Mutex<HashMap<String, Entry>> {
    static CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// The configured TTL; a non-positive or unreadable value keeps the default.
pub fn configured_ttl_ms() -> u64 {
    std::env::var("DEVBOARD_GITEA_RELEASE_CACHE_TTL_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_RELEASE_CACHE_TTL_MS)
}

fn cache_key(target: &GiteaTarget) -> String {
    format!(
        "{}|{}",
        target.base_url.trim_end_matches('/'),
        target.project
    )
}

/// Every published release, newest first, from the cache or one walk.
pub async fn list(
    target: &GiteaTarget,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Vec<GiteaRelease>, GiteaError> {
    list_with_ttl(target, transport, options, configured_ttl_ms()).await
}

/// Every published release with an explicit TTL, for tests that drive expiry.
pub async fn list_with_ttl(
    target: &GiteaTarget,
    transport: &Transport,
    options: &GiteaCallOptions,
    ttl_ms: u64,
) -> Result<Vec<GiteaRelease>, GiteaError> {
    let key = cache_key(target);
    let mut cache = cache().lock().await;
    if let Some(entry) = cache.get(&key) {
        if entry.read_at.elapsed() < Duration::from_millis(ttl_ms) {
            return Ok(entry.releases.clone());
        }
    }
    let releases = gitea_list_releases(target, transport, options).await?;
    cache.insert(
        key,
        Entry {
            read_at: Instant::now(),
            releases: releases.clone(),
        },
    );
    Ok(releases)
}

/// One release by tag: a cached row when the walk still holds it, otherwise
/// the single tag read. A known version never walks every release page.
pub async fn release_by_tag(
    target: &GiteaTarget,
    tag: &str,
    transport: &Transport,
    options: &GiteaCallOptions,
) -> Result<Option<GiteaRelease>, GiteaError> {
    let key = cache_key(target);
    {
        let cache = cache().lock().await;
        if let Some(entry) = cache.get(&key) {
            if entry.read_at.elapsed() < Duration::from_millis(configured_ttl_ms()) {
                if let Some(release) = entry.releases.iter().find(|release| release.tag == tag) {
                    return Ok(Some(release.clone()));
                }
            }
        }
    }
    Ok(gitea_release_by_tag(target, tag, transport, options)
        .await?
        .as_ref()
        .and_then(crate::forge::release_from_document))
}

/// Drops every cached walk; a test starts from the forge's live answer.
pub fn clear_for_tests() {
    if let Ok(mut cache) = cache().try_lock() {
        cache.clear();
    }
}
