//! The report resource `POST /reports` creates.
//!
//! Filing a report is one write to an external forge, and a forge is not bound
//! by the dashboard's latency budget: a backed-up forge answers an issue
//! creation in seconds. The endpoint therefore records the report here, answers
//! at once, and files it on this process's runtime. The record is the report's
//! state — `FILING`, `FILED`, or `FAILED` — and `GET /reports/<id>` serves it
//! until the dashboard settles it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::journal::repo_key;
use crate::state::write_file_atomically;

/// The newest records one store keeps.
const MAX_RECORDS: usize = 200;
/// How long a settled record answers a replay of its `Idempotency-Key`.
const RETENTION_MS: u128 = 24 * 60 * 60 * 1000;
const STORE_VERSION: u64 = 1;
/// The detail an interrupted filing carries once the dashboard restarts.
const INTERRUPTED_DETAIL: &str = "The dashboard stopped before the report was filed.";

/// Where one report stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReportStatus {
    /// The dashboard owns the delivery and the forge has not answered yet.
    Filing,
    /// The forge created the issue.
    Filed,
    /// The delivery settled without an issue.
    Failed,
}

impl ReportStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Filing => "FILING",
            Self::Filed => "FILED",
            Self::Failed => "FAILED",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "FILING" => Some(Self::Filing),
            "FILED" => Some(Self::Filed),
            "FAILED" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// One report the dashboard accepted.
#[derive(Clone, Debug)]
struct ReportRecord {
    pub id: u64,
    pub title: String,
    pub status: ReportStatus,
    /// The created issue's own URL, once the forge filed it.
    pub href: Option<String>,
    /// Why the delivery settled without an issue.
    pub detail: Option<String>,
    /// The `Idempotency-Key` that owns this record, when the client sent one.
    pub key: Option<String>,
    created_at: u128,
}

impl ReportRecord {
    /// The resource representation `POST /reports` and `GET /reports/<id>` serve.
    fn to_json(&self) -> Value {
        let mut document = json!({
            "id": self.id,
            "title": self.title,
            "status": self.status.as_str(),
        });
        if let Some(detail) = &self.detail {
            document["detail"] = json!(detail);
        }
        let mut links = json!({});
        if let Some(href) = &self.href {
            links["issue"] = json!({"href": href});
        }
        document["links"] = links;
        document
    }
}

/// What one claim of a report decided.
pub enum ReportClaim {
    /// The dashboard owns this delivery; `id` names the record it settles.
    Start(u64),
    /// The record already exists and needs no second delivery.
    Replay(Value),
}

struct Inner {
    records: Vec<ReportRecord>,
    next_id: u64,
}

/// Every report this dashboard accepted, and the one it is filing.
pub struct ReportStore {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl ReportStore {
    /// Opens the store under `state_dir`, keeping the records one ledger holds.
    pub fn open(state_dir: &Path, repo_dir: &Path) -> Self {
        let path = state_dir
            .join("reports")
            .join(format!("{}.json", repo_key(repo_dir)));
        let store = Self {
            path,
            inner: Mutex::new(Inner {
                records: Vec::new(),
                next_id: 1,
            }),
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

    /// Claims the delivery one report needs, or answers the record it already
    /// has.
    ///
    /// A keyed claim replays a `FILED` record and joins a `FILING` one, so one
    /// key files one issue. A `FAILED` record is filed again under the same id,
    /// because a failed delivery is the retry the operator asked for.
    pub async fn claim(&self, key: Option<&str>, title: &str) -> ReportClaim {
        let claim = {
            let mut inner = self.inner.lock().expect("the report records");
            let threshold = Self::now_ms().saturating_sub(RETENTION_MS);
            let existing = key.and_then(|key| {
                inner.records.iter().position(|record| {
                    record.key.as_deref() == Some(key) && record.created_at >= threshold
                })
            });
            match existing {
                Some(index) => match inner.records[index].status {
                    ReportStatus::Filing | ReportStatus::Filed => {
                        ReportClaim::Replay(inner.records[index].to_json())
                    }
                    ReportStatus::Failed => {
                        let record = &mut inner.records[index];
                        record.status = ReportStatus::Filing;
                        record.href = None;
                        record.detail = None;
                        record.created_at = Self::now_ms();
                        ReportClaim::Start(record.id)
                    }
                },
                None => {
                    let id = inner.next_id;
                    inner.next_id += 1;
                    inner.records.push(ReportRecord {
                        id,
                        title: title.to_string(),
                        status: ReportStatus::Filing,
                        href: None,
                        detail: None,
                        key: key.map(str::to_string),
                        created_at: Self::now_ms(),
                    });
                    prune(&mut inner.records);
                    ReportClaim::Start(id)
                }
            }
        };
        self.persist().await;
        claim
    }

    /// Records the outcome of one delivery.
    pub async fn settle(&self, id: u64, outcome: Result<String, String>) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(record) = inner.records.iter_mut().find(|record| record.id == id) {
                match outcome {
                    Ok(href) => {
                        record.status = ReportStatus::Filed;
                        record.href = Some(href);
                        record.detail = None;
                    }
                    Err(detail) => {
                        record.status = ReportStatus::Failed;
                        record.href = None;
                        record.detail = Some(detail);
                    }
                }
            }
        }
        self.persist().await;
    }

    /// One record's representation, or `None` for an id this store never issued.
    pub fn view(&self, id: u64) -> Option<Value> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .records
                .iter()
                .find(|record| record.id == id)
                .map(ReportRecord::to_json)
        })
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
        let Some(records) = document.get("records").and_then(Value::as_array) else {
            return;
        };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let threshold = Self::now_ms().saturating_sub(RETENTION_MS);
        for record in records {
            let Some(id) = record.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let Some(title) = record.get("title").and_then(Value::as_str) else {
                continue;
            };
            let Some(status) = record
                .get("status")
                .and_then(Value::as_str)
                .and_then(ReportStatus::from_str)
            else {
                continue;
            };
            let Some(created_at) = record.get("createdAt").and_then(Value::as_u64) else {
                continue;
            };
            if u128::from(created_at) < threshold {
                continue;
            }
            inner.next_id = inner.next_id.max(id + 1);
            // A filing this process never finished belonged to a dashboard that
            // stopped mid-delivery: no second process can settle it, so it is
            // answered as failed instead of filing forever.
            let (status, detail) = match status {
                ReportStatus::Filing => {
                    (ReportStatus::Failed, Some(INTERRUPTED_DETAIL.to_string()))
                }
                settled => (settled, None),
            };
            inner.records.push(ReportRecord {
                id,
                title: title.to_string(),
                status,
                href: record
                    .get("href")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                detail: record
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(detail),
                key: record
                    .get("key")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                created_at: u128::from(created_at),
            });
        }
        inner.records.sort_by_key(|record| record.id);
        prune(&mut inner.records);
        let interrupted = inner.records.iter().any(|record| {
            record.status == ReportStatus::Failed
                && record.detail.as_deref() == Some(INTERRUPTED_DETAIL)
        });
        drop(inner);
        if !interrupted {
            return;
        }
        // Rewriting the ledger keeps the interrupted state durable, so a later
        // start reads the same answer without a second delivery attempt.
        let Ok(text) = self.ledger() else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.path, text);
    }

    fn ledger(&self) -> Result<String, serde_json::Error> {
        let inner = self.inner.lock().expect("the report records");
        let records: Vec<Value> = inner
            .records
            .iter()
            .map(|record| {
                json!({
                    "id": record.id,
                    "title": record.title,
                    "status": record.status.as_str(),
                    "href": record.href,
                    "detail": record.detail,
                    "key": record.key,
                    "createdAt": record.created_at as u64,
                })
            })
            .collect();
        let mut text = serde_json::to_string_pretty(&json!({
            "version": STORE_VERSION,
            "records": records,
        }))?;
        text.push('\n');
        Ok(text)
    }

    async fn persist(&self) {
        let Ok(text) = self.ledger() else {
            return;
        };
        if let Err(error) = write_file_atomically(&self.path, &text).await {
            eprintln!("Could not persist the report records: {error}");
        }
    }
}

/// Drops the oldest records beyond the bound.
fn prune(records: &mut Vec<ReportRecord>) {
    if records.len() <= MAX_RECORDS {
        return;
    }
    let overflow = records.len() - MAX_RECORDS;
    records.sort_by_key(|record| record.created_at);
    records.drain(..overflow);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(label: &str) -> (ReportStore, PathBuf) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("reports-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a state root");
        (ReportStore::open(&root, &root), root)
    }

    #[tokio::test]
    async fn a_claim_starts_one_delivery_and_a_replay_answers_the_same_record() {
        let (store, _root) = store("claim");
        let id = match store.claim(Some("key-1"), "[ui] Fix it").await {
            ReportClaim::Start(id) => id,
            ReportClaim::Replay(_) => panic!("the first claim starts the delivery"),
        };
        let replay = match store.claim(Some("key-1"), "[ui] Fix it").await {
            ReportClaim::Replay(view) => view,
            ReportClaim::Start(_) => panic!("the second claim replays the record"),
        };
        assert_eq!(replay["id"], id);
        assert_eq!(replay["status"], "FILING");
        store
            .settle(
                id,
                Ok("https://gitea.test/dsdenes/devboard/issues/7".into()),
            )
            .await;
        let filed = match store.claim(Some("key-1"), "[ui] Fix it").await {
            ReportClaim::Replay(view) => view,
            ReportClaim::Start(_) => panic!("a filed record is never filed twice"),
        };
        assert_eq!(filed["status"], "FILED");
        assert_eq!(
            filed["links"]["issue"]["href"],
            "https://gitea.test/dsdenes/devboard/issues/7"
        );
    }

    #[tokio::test]
    async fn a_failed_record_is_filed_again_under_the_same_id() {
        let (store, _root) = store("retry");
        let id = match store.claim(Some("key-2"), "[ui] Fix it").await {
            ReportClaim::Start(id) => id,
            ReportClaim::Replay(_) => panic!("the first claim starts the delivery"),
        };
        store
            .settle(id, Err("The issue could not be filed.".into()))
            .await;
        let view = store.view(id).expect("the failed record");
        assert_eq!(view["status"], "FAILED");
        assert_eq!(view["detail"], "The issue could not be filed.");
        match store.claim(Some("key-2"), "[ui] Fix it").await {
            ReportClaim::Start(again) => assert_eq!(again, id),
            ReportClaim::Replay(_) => panic!("a failed record is filed again"),
        }
        assert_eq!(store.view(id).expect("the record")["status"], "FILING");
    }

    #[tokio::test]
    async fn an_unkeyed_claim_never_replays_another_report() {
        let (store, _root) = store("unkeyed");
        let first = match store.claim(None, "[ui] One").await {
            ReportClaim::Start(id) => id,
            ReportClaim::Replay(_) => panic!("an unkeyed claim always starts"),
        };
        let second = match store.claim(None, "[ui] One").await {
            ReportClaim::Start(id) => id,
            ReportClaim::Replay(_) => panic!("an unkeyed claim always starts"),
        };
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn an_interrupted_filing_is_answered_failed_after_a_restart() {
        let (store, root) = store("restart");
        let id = match store.claim(Some("key-3"), "[ui] Fix it").await {
            ReportClaim::Start(id) => id,
            ReportClaim::Replay(_) => panic!("the first claim starts the delivery"),
        };
        let reopened = ReportStore::open(&root, &root);
        let view = reopened.view(id).expect("the reloaded record");
        assert_eq!(view["status"], "FAILED");
        assert_eq!(view["detail"], INTERRUPTED_DETAIL);
        match reopened.claim(Some("key-3"), "[ui] Fix it").await {
            ReportClaim::Start(again) => assert_eq!(again, id),
            ReportClaim::Replay(_) => panic!("an interrupted record is filed again"),
        }
    }

    #[tokio::test]
    async fn a_settled_record_survives_a_restart() {
        let (store, root) = store("durable");
        let id = match store.claim(Some("key-4"), "[ui] Fix it").await {
            ReportClaim::Start(id) => id,
            ReportClaim::Replay(_) => panic!("the first claim starts the delivery"),
        };
        store
            .settle(
                id,
                Ok("https://gitea.test/dsdenes/devboard/issues/9".into()),
            )
            .await;
        let reopened = ReportStore::open(&root, &root);
        let view = reopened.view(id).expect("the reloaded record");
        assert_eq!(view["status"], "FILED");
        assert_eq!(
            view["links"]["issue"]["href"],
            "https://gitea.test/dsdenes/devboard/issues/9"
        );
        let third = match reopened.claim(None, "[ui] Next").await {
            ReportClaim::Start(id) => id,
            ReportClaim::Replay(_) => panic!("a fresh claim always starts"),
        };
        assert!(third > id, "the reloaded store keeps its id sequence");
    }
}
