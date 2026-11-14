//! The replay cache that makes one keyed `POST` create one resource.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::feedback::RequestError;
use crate::journal::repo_key;
use crate::state::write_file_atomically;

/// The longest `Idempotency-Key` a client may send.
pub const MAX_IDEMPOTENCY_KEY: usize = 255;
const RETENTION_MS: u128 = 24 * 60 * 60 * 1000;
const MAX_ENTRIES: usize = 1000;
const STORE_VERSION: u64 = 1;

/// Validates the client's `Idempotency-Key` header.
pub fn parse_idempotency_key(value: Option<&str>) -> Result<Option<String>, RequestError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let key = value.trim();
    if key.is_empty() {
        return Err(RequestError::bad_request(
            "Idempotency-Key must not be empty.",
        ));
    }
    if key.encode_utf16().count() > MAX_IDEMPOTENCY_KEY {
        return Err(RequestError::bad_request(format!(
            "Idempotency-Key is longer than {MAX_IDEMPOTENCY_KEY} characters."
        )));
    }
    if key.chars().any(|character| {
        let code = character as u32;
        code <= 0x1f || code == 0x7f
    }) {
        return Err(RequestError::bad_request(
            "Idempotency-Key must not contain control characters.",
        ));
    }
    Ok(Some(key.to_string()))
}

fn entry_id(scope: &str, key: &str) -> String {
    format!("{scope}\u{0}{key}")
}

/// What one keyed operation answered, and whether it settles the key.
///
/// A refusal travels under the route's success status, so the dispatcher —
/// never the status — decides whether the answer completed the operation.
pub enum Answer {
    /// The operation completed: the key keeps this answer, and every retry
    /// replays it.
    Settled(Value),
    /// The operation refused the request: the answer travels back unchanged
    /// and the key stays free, so a retry after the refusal condition clears
    /// runs the operation again.
    Refused(Value),
}

/// The value one keyed answer carries, whether or not it settled the key.
fn into_value(answer: Answer) -> Value {
    match answer {
        Answer::Settled(value) | Answer::Refused(value) => value,
    }
}

#[derive(Clone)]
struct StoredEntry {
    scope: String,
    key: String,
    result: Value,
    created_at: u128,
}

/// Remembers what one keyed operation created.
pub struct IdempotencyStore {
    path: PathBuf,
    entries: Mutex<HashMap<String, StoredEntry>>,
    locks: Mutex<HashMap<String, std::sync::Arc<AsyncMutex<()>>>>,
}

impl IdempotencyStore {
    pub fn open(state_dir: &Path, repo_dir: &Path) -> Self {
        let path = state_dir
            .join("idempotency")
            .join(format!("{}.json", repo_key(repo_dir)));
        let store = Self {
            path,
            entries: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
        };
        store.load();
        store
    }

    fn now_ms() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    }

    /// Runs `operation` once per `(scope, key)`.
    ///
    /// An answer that completed the operation is kept under the key; one that
    /// refused the request is answered and dropped, so the retry after the
    /// refusal condition clears is dispatched again.
    pub async fn run<F, Fut>(
        &self,
        scope: &str,
        key: Option<&str>,
        operation: F,
    ) -> Result<Value, RequestError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Answer, RequestError>>,
    {
        let Some(key) = key else {
            return operation().await.map(into_value);
        };
        let id = entry_id(scope, key);
        if let Some(entry) = self
            .entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(&id).cloned())
        {
            return Ok(entry.result);
        }
        let lock = {
            let mut locks = self.locks.lock().expect("the idempotency locks");
            locks
                .entry(id.clone())
                .or_insert_with(|| std::sync::Arc::new(AsyncMutex::new(())))
                .clone()
        };
        let _held = lock.lock().await;
        if let Some(entry) = self
            .entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(&id).cloned())
        {
            return Ok(entry.result);
        }
        let (result, settled) = match operation().await? {
            Answer::Settled(value) => (value, true),
            Answer::Refused(value) => (value, false),
        };
        if settled {
            if let Ok(mut entries) = self.entries.lock() {
                entries.insert(
                    id,
                    StoredEntry {
                        scope: scope.to_string(),
                        key: key.to_string(),
                        result: result.clone(),
                        created_at: Self::now_ms(),
                    },
                );
                prune(&mut entries);
            }
            self.persist().await;
        }
        Ok(result)
    }

    fn load(&self) {
        let Ok(source) = std::fs::read_to_string(&self.path) else {
            return;
        };
        let Ok(document) = serde_json::from_str::<Value>(&source) else {
            return;
        };
        if document.get("version").and_then(Value::as_u64) != Some(STORE_VERSION) {
            return;
        }
        let Some(entries) = document.get("entries").and_then(Value::as_array) else {
            return;
        };
        let threshold = Self::now_ms().saturating_sub(RETENTION_MS);
        let Ok(mut stored) = self.entries.lock() else {
            return;
        };
        for entry in entries {
            let Some(scope) = entry.get("scope").and_then(Value::as_str) else {
                continue;
            };
            let Some(key) = entry.get("key").and_then(Value::as_str) else {
                continue;
            };
            let Some(created_at) = entry.get("createdAt").and_then(Value::as_u64) else {
                continue;
            };
            if u128::from(created_at) < threshold {
                continue;
            }
            let Some(result) = entry.get("result") else {
                continue;
            };
            stored.insert(
                entry_id(scope, key),
                StoredEntry {
                    scope: scope.to_string(),
                    key: key.to_string(),
                    result: result.clone(),
                    created_at: u128::from(created_at),
                },
            );
        }
        prune(&mut stored);
    }

    async fn persist(&self) {
        let document = {
            let Ok(entries) = self.entries.lock() else {
                return;
            };
            let items: Vec<Value> = entries
                .values()
                .map(|entry| {
                    serde_json::json!({
                        "scope": entry.scope,
                        "key": entry.key,
                        "result": entry.result,
                        "createdAt": entry.created_at as u64,
                    })
                })
                .collect();
            serde_json::json!({"version": STORE_VERSION, "entries": items})
        };
        let mut text = serde_json::to_string_pretty(&document).unwrap_or_default();
        text.push('\n');
        if let Err(error) = write_file_atomically(&self.path, &text).await {
            eprintln!("Could not persist the idempotency store: {error}");
        }
    }
}

/// Drops the oldest entries beyond the entry bound.
fn prune(entries: &mut HashMap<String, StoredEntry>) {
    if entries.len() <= MAX_ENTRIES {
        return;
    }
    let mut ordered: Vec<(String, u128)> = entries
        .iter()
        .map(|(id, entry)| (id.clone(), entry.created_at))
        .collect();
    ordered.sort_by(|left, right| right.1.cmp(&left.1));
    for (id, _) in ordered.into_iter().skip(MAX_ENTRIES) {
        entries.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use serde_json::json;

    use super::*;

    /// A scratch state and repository pair under `.devboard/.test-tmp`.
    fn scratch(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("the devboard harness directory exists")
            .join(".test-tmp")
            .join(format!("{label}-{}-{nanos}", std::process::id()));
        let state = root.join("state");
        let repo = root.join("repo");
        std::fs::create_dir_all(&state).expect("a state directory");
        std::fs::create_dir_all(&repo).expect("a repository");
        (root, state, repo)
    }

    /// A refusal answers its value and leaves the key free, so the retry runs
    /// the operation again; a settled answer is kept and replays unchanged,
    /// across a reopen of the store.
    #[tokio::test]
    async fn a_refusal_does_not_settle_the_key() {
        let (root, state, repo) = scratch("idempotency-refused");
        let scope = "POST /inquiries/conversations";
        let calls = Arc::new(AtomicU64::new(0));
        let store = IdempotencyStore::open(&state, &repo);

        let counted = Arc::clone(&calls);
        let refused = store
            .run(scope, Some("retry-1"), || async move {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(Answer::Refused(json!({"status": 201, "frames": ["busy"]})))
            })
            .await
            .expect("a refused answer");
        assert_eq!(refused, json!({"status": 201, "frames": ["busy"]}));

        let counted = Arc::clone(&calls);
        let settled = store
            .run(scope, Some("retry-1"), || async move {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(Answer::Settled(
                    json!({"status": 201, "frames": ["inquiry"]}),
                ))
            })
            .await
            .expect("a settled answer");
        assert_eq!(
            settled,
            json!({"status": 201, "frames": ["inquiry"]}),
            "the retry ran once the refusal cleared"
        );

        let counted = Arc::clone(&calls);
        let replay = store
            .run(scope, Some("retry-1"), || async move {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(Answer::Settled(json!({"status": 500})))
            })
            .await
            .expect("a replayed answer");
        assert_eq!(
            replay,
            json!({"status": 201, "frames": ["inquiry"]}),
            "a settled answer replays instead of dispatching"
        );

        let settled_again = {
            let counted = Arc::clone(&calls);
            IdempotencyStore::open(&state, &repo)
                .run(scope, Some("retry-1"), || async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    Ok(Answer::Settled(json!({"status": 500})))
                })
                .await
                .expect("a replayed answer after a reopen")
        };
        assert_eq!(
            settled_again,
            json!({"status": 201, "frames": ["inquiry"]}),
            "the settled answer survives the store's reload"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "the refusal and the settled answer each ran once"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
