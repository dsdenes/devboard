//! A wall-clock bound for work that must never leave a caller waiting.

use std::future::Future;
use std::time::Duration;

/// Awaits `work`, or `None` when the deadline expires first. The work keeps
/// running in the background.
pub async fn within_deadline<T>(work: impl Future<Output = T>, timeout_ms: u64) -> Option<T> {
    tokio::time::timeout(Duration::from_millis(timeout_ms.max(1)), work)
        .await
        .ok()
}
