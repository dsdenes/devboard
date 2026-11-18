//! The operator's durable Start/Stop intent for one background family.
//!
//! A family's worker state is a report, not a command. It can be stale, it can
//! be inherited from a predecessor of another harness version, and it can read
//! `stopped` while the process that wrote it still runs. The intent lives in
//! the dashboard's own state directory, so an operator Stop survives a
//! dashboard restart and a version change, and a takeover never starts a family
//! the operator switched off.
//!
//! The record answers two questions:
//!
//! - `enabled`: the operator's last Start/Stop. An enabled family is on; a
//!   disabled one is off and nothing may start it without another Start.
//! - `confirmed`: a worker of this intent generation actually attached. Only a
//!   family that was really running is restarted after its worker exits; a
//!   Start that never produced a worker is not retried behind the operator's
//!   back.
//!
//! The projection is normalized from the intent and the live processes, never
//! from a state file's own word: a live worker (or one of the family's agent
//! peers) means the card never says `stopped`.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::journal::repo_key;

/// One family's durable operator intent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FamilyIntent {
    pub enabled: bool,
    pub confirmed: bool,
}

impl FamilyIntent {
    pub fn enabled() -> Self {
        Self {
            enabled: true,
            confirmed: false,
        }
    }

    pub fn disabled() -> Self {
        Self {
            enabled: false,
            confirmed: false,
        }
    }
}

/// `<state>/families/<repo-key>/<family>.json`.
///
/// The control plane is dashboard-owned and version-independent: a harness
/// upgrade reads the same record the dashboard that wrote it did.
pub fn intent_path(state_dir: &Path, repo_dir: &Path, family_id: &str) -> PathBuf {
    state_dir
        .join("families")
        .join(repo_key(repo_dir))
        .join(format!("{family_id}.json"))
}

/// Reads one family's intent. A missing or unreadable record is `None`: the
/// dashboard then falls back to the family's own state, exactly as it did
/// before the control plane existed, and never invents a command.
pub fn read(state_dir: &Path, repo_dir: &Path, family_id: &str) -> Option<FamilyIntent> {
    let text = std::fs::read_to_string(intent_path(state_dir, repo_dir, family_id)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let object = value.as_object()?;
    let enabled = object.get("enabled")?.as_bool()?;
    let confirmed = object
        .get("confirmed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(FamilyIntent { enabled, confirmed })
}

/// Writes one family's intent atomically.
pub fn write(
    state_dir: &Path,
    repo_dir: &Path,
    family_id: &str,
    intent: FamilyIntent,
) -> std::io::Result<()> {
    let text = format!(
        "{}\n",
        crate::jsjson::stringify(&json!({
            "version": 1,
            "family": family_id,
            "enabled": intent.enabled,
            "confirmed": intent.confirmed,
            "updatedAt": crate::journal::now_iso8601(),
        }))
    );
    crate::state::write_file_atomically_sync(&intent_path(state_dir, repo_dir, family_id), &text)
}

/// One live worker of a family, as a lock names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveWorker {
    pub pid: u32,
    pub version: Option<String>,
    pub state_dir: String,
    pub started_at: String,
}

/// Normalizes one family projection against the operator's intent and the
/// processes that are actually alive.
///
/// The rules are the user-visible promise: a live worker means the card never
/// says `stopped`; a disabled intent means a still-live worker reads
/// `stopping`; a live peer with no worker reads `stopping` and names the pids
/// that are still working.
pub fn apply_presence(
    snapshot: &mut Value,
    intent: Option<FamilyIntent>,
    live_workers: &[LiveWorker],
    peer_pids: &[u32],
) {
    let Some(object) = snapshot.as_object_mut() else {
        return;
    };
    if let Some(intent) = intent {
        object.insert("enabled".to_string(), json!(intent.enabled));
    }
    let lifecycle = object
        .get("lifecycle")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let live = !live_workers.is_empty();
    let mut next = lifecycle.clone();
    if live {
        object.insert("attached".to_string(), json!(true));
        if lifecycle == "stopped" {
            // A worker the family's own state does not map is new: it is
            // running, not exiting. One whose record says stopped is ending.
            let any_running = object
                .get("workers")
                .and_then(Value::as_array)
                .map(|workers| {
                    workers.is_empty()
                        || workers.iter().any(|worker| {
                            matches!(
                                worker.get("lifecycle").and_then(Value::as_str),
                                Some("running") | Some("starting")
                            )
                        })
                })
                .unwrap_or(true);
            next = if any_running {
                "running".to_string()
            } else {
                "stopping".to_string()
            };
        } else if !enabled && lifecycle == "running" {
            next = "stopping".to_string();
        }
    } else if !peer_pids.is_empty() {
        if lifecycle == "stopped" {
            next = "stopping".to_string();
        }
        let notice_is_empty = object.get("notice").map(Value::is_null).unwrap_or(true);
        if notice_is_empty {
            let pids = peer_pids
                .iter()
                .map(u32::to_string)
                .collect::<Vec<String>>()
                .join(", ");
            object.insert(
                "notice".to_string(),
                json!(format!(
                    "{} agent peer(s) are still running (pid {pids}); they end with the family.",
                    peer_pids.len()
                )),
            );
        }
    }
    if next != lifecycle {
        object.insert("lifecycle".to_string(), json!(next));
    }
    if live {
        let workers_are_empty = object
            .get("workers")
            .and_then(Value::as_array)
            .map(|workers| workers.is_empty())
            .unwrap_or(true);
        if workers_are_empty {
            let workers: Vec<Value> = live_workers
                .iter()
                .map(|worker| {
                    json!({
                        "pid": worker.pid,
                        "version": worker.version,
                        "stateDir": worker.state_dir,
                        "lifecycle": if next == "stopping" { "stopping" } else { "running" },
                        "startedAt": worker.started_at,
                    })
                })
                .collect();
            object.insert("workers".to_string(), Value::Array(workers));
        }
    }
}

/// What the dashboard owes one family on one reconcile pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reconcile {
    None,
    /// The operator stopped it and a worker (or its start) is still live.
    Stop,
    /// A live worker of an older harness version needs the running version's
    /// worker beside it, and the older one drained.
    Takeover,
    /// The family was running and its worker is gone; start it again.
    Start,
}

/// Decides one family's reconcile step.
///
/// `boot` is the pass a dashboard makes before serving: a live worker of an
/// older version is taken over then, never on every later tick (the adapters'
/// takeover is a one-shot). `auto_starts` is false for a push-triggered family
/// (Deploy) and for one that already owns its durable intent (Release Train).
pub fn reconcile(
    intent: Option<FamilyIntent>,
    live: bool,
    starting: bool,
    auto_starts: bool,
    boot: bool,
) -> Reconcile {
    match intent {
        // No recorded command: keep the pre-control-plane behavior, which is
        // the one-shot version takeover.
        None => {
            if boot && live {
                Reconcile::Takeover
            } else {
                Reconcile::None
            }
        }
        Some(intent) if !intent.enabled => {
            if live || starting {
                Reconcile::Stop
            } else {
                Reconcile::None
            }
        }
        Some(intent) => {
            if live {
                if boot {
                    Reconcile::Takeover
                } else {
                    Reconcile::None
                }
            } else if intent.confirmed && !starting && auto_starts {
                Reconcile::Start
            } else {
                Reconcile::None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> (PathBuf, PathBuf) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("family-intent-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("repo")).expect("a fixture repo");
        std::fs::create_dir_all(root.join("state")).expect("a fixture state");
        (root.join("state"), root.join("repo"))
    }

    #[test]
    fn a_missing_intent_is_no_command() {
        let (state, repo) = scratch("missing");
        assert_eq!(read(&state, &repo, "scout"), None);
    }

    #[test]
    fn an_intent_round_trips() {
        let (state, repo) = scratch("round-trip");
        write(&state, &repo, "scout", FamilyIntent::enabled()).expect("the write");
        assert_eq!(
            read(&state, &repo, "scout"),
            Some(FamilyIntent {
                enabled: true,
                confirmed: false
            })
        );
        write(
            &state,
            &repo,
            "scout",
            FamilyIntent {
                enabled: true,
                confirmed: true,
            },
        )
        .expect("the confirmation");
        assert_eq!(
            read(&state, &repo, "scout"),
            Some(FamilyIntent {
                enabled: true,
                confirmed: true
            })
        );
        write(&state, &repo, "scout", FamilyIntent::disabled()).expect("the stop");
        assert_eq!(
            read(&state, &repo, "scout"),
            Some(FamilyIntent {
                enabled: false,
                confirmed: false
            })
        );
    }

    #[test]
    fn families_never_share_one_record() {
        let (state, repo) = scratch("separate");
        write(&state, &repo, "scout", FamilyIntent::enabled()).expect("scout");
        write(&state, &repo, "watchdog", FamilyIntent::disabled()).expect("watchdog");
        assert!(read(&state, &repo, "scout").expect("scout").enabled);
        assert!(!read(&state, &repo, "watchdog").expect("watchdog").enabled);
    }

    #[test]
    fn a_damaged_record_is_no_command() {
        let (state, repo) = scratch("damaged");
        let path = intent_path(&state, &repo, "scout");
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("the directory");
        std::fs::write(&path, "{not json").expect("the damage");
        assert_eq!(read(&state, &repo, "scout"), None);
        std::fs::write(&path, "{\"enabled\":\"yes\"}").expect("the wrong type");
        assert_eq!(read(&state, &repo, "scout"), None);
    }

    fn snapshot(lifecycle: &str, enabled: bool) -> Value {
        json!({
            "lifecycle": lifecycle,
            "enabled": enabled,
            "attached": false,
            "workers": [],
            "notice": Value::Null,
        })
    }

    fn worker(pid: u32) -> LiveWorker {
        LiveWorker {
            pid,
            version: Some("1.0.0".to_string()),
            state_dir: "/state".to_string(),
            started_at: "2026-11-18T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn a_live_worker_never_reads_stopped() {
        let mut value = snapshot("stopped", true);
        value["workers"] = json!([{"pid": 7, "lifecycle": "stopped"}]);
        apply_presence(&mut value, None, &[worker(7)], &[]);
        assert_eq!(value["lifecycle"], "stopping");
        assert_eq!(value["attached"], true);
        assert_eq!(value["workers"][0]["pid"], 7);
    }

    #[test]
    fn a_new_live_worker_with_no_state_reads_running() {
        let mut value = snapshot("stopped", true);
        apply_presence(&mut value, None, &[worker(7)], &[]);
        assert_eq!(value["lifecycle"], "running");
        assert_eq!(value["attached"], true);
        assert_eq!(value["workers"][0]["pid"], 7);
    }

    #[test]
    fn a_disabled_family_that_still_runs_reads_stopping() {
        let mut value = snapshot("running", true);
        apply_presence(
            &mut value,
            Some(FamilyIntent::disabled()),
            &[worker(7)],
            &[],
        );
        assert_eq!(value["enabled"], false);
        assert_eq!(value["lifecycle"], "stopping");
    }

    #[test]
    fn a_live_peer_with_no_worker_names_its_pid() {
        let mut value = snapshot("stopped", false);
        apply_presence(&mut value, Some(FamilyIntent::disabled()), &[], &[11, 12]);
        assert_eq!(value["lifecycle"], "stopping");
        let notice = value["notice"].as_str().expect("the peer notice");
        assert!(notice.contains("2 agent peer(s)"), "{notice}");
        assert!(notice.contains("pid 11, 12"), "{notice}");
    }

    #[test]
    fn an_enabled_intent_reports_itself_on_a_stopped_projection() {
        let mut value = snapshot("stopped", false);
        apply_presence(&mut value, Some(FamilyIntent::enabled()), &[], &[]);
        assert_eq!(value["enabled"], true);
        assert_eq!(value["lifecycle"], "stopped");
    }

    #[test]
    fn an_abandoned_start_is_not_restarted() {
        assert_eq!(
            reconcile(Some(FamilyIntent::enabled()), false, false, true, false),
            Reconcile::None
        );
        assert_eq!(
            reconcile(
                Some(FamilyIntent {
                    enabled: true,
                    confirmed: true
                }),
                false,
                false,
                true,
                false
            ),
            Reconcile::Start
        );
    }

    #[test]
    fn a_stopped_family_is_never_started_by_reconcile() {
        assert_eq!(
            reconcile(Some(FamilyIntent::disabled()), true, false, true, true),
            Reconcile::Stop
        );
        assert_eq!(
            reconcile(Some(FamilyIntent::disabled()), false, false, true, false),
            Reconcile::None
        );
    }

    #[test]
    fn a_live_older_worker_is_taken_over_only_on_boot() {
        assert_eq!(
            reconcile(
                Some(FamilyIntent {
                    enabled: true,
                    confirmed: true
                }),
                true,
                false,
                true,
                true
            ),
            Reconcile::Takeover
        );
        assert_eq!(
            reconcile(
                Some(FamilyIntent {
                    enabled: true,
                    confirmed: true
                }),
                true,
                false,
                true,
                false
            ),
            Reconcile::None
        );
    }

    #[test]
    fn a_push_triggered_family_is_never_started() {
        assert_eq!(
            reconcile(
                Some(FamilyIntent {
                    enabled: true,
                    confirmed: true
                }),
                false,
                false,
                false,
                false
            ),
            Reconcile::None
        );
    }
}
