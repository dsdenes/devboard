//! The one activity-delta rule both detached workers' dashboards use.
//!
//! A whole replay replaces the log, a grown log appends, and a trimmed or
//! rewritten log is replayed; a streamed chunk continues the last line only
//! while it is a prefix extension of it.

use serde_json::{json, Value};

/// One activity entry in a delta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityEntry {
    pub text: String,
    pub append: bool,
}

impl ActivityEntry {
    pub fn to_json(&self) -> Value {
        json!({"text": self.text, "append": self.append})
    }
}

/// One delta: a replay replaces the log, otherwise the entries extend it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityDelta {
    pub replay: bool,
    pub entries: Vec<ActivityEntry>,
}

impl ActivityDelta {
    pub fn to_json(&self) -> Value {
        json!({
            "replay": self.replay,
            "entries": self.entries.iter().map(ActivityEntry::to_json).collect::<Vec<_>>(),
        })
    }
}

/// The delta between one previously delivered log and the current one.
pub fn activity_delta(previous: &[String], activity: &[String]) -> ActivityDelta {
    let replay = || ActivityDelta {
        replay: true,
        entries: activity
            .iter()
            .map(|text| ActivityEntry {
                text: text.clone(),
                append: false,
            })
            .collect(),
    };
    if activity.is_empty() {
        return ActivityDelta {
            replay: false,
            entries: Vec::new(),
        };
    }
    if previous.is_empty() {
        return replay();
    }
    if activity.len() < previous.len() {
        return replay();
    }
    let mut prefix = 0;
    while prefix < previous.len() && prefix < activity.len() && previous[prefix] == activity[prefix]
    {
        prefix += 1;
    }
    if prefix == previous.len() {
        return ActivityDelta {
            replay: false,
            entries: activity[prefix..]
                .iter()
                .map(|text| ActivityEntry {
                    text: text.clone(),
                    append: false,
                })
                .collect(),
        };
    }
    if prefix == previous.len() - 1 {
        let before = previous.get(prefix).map(String::as_str).unwrap_or("");
        let after = activity.get(prefix).map(String::as_str).unwrap_or("");
        if let Some(extension) = after.strip_prefix(before) {
            let mut entries = Vec::new();
            if !extension.is_empty() {
                entries.push(ActivityEntry {
                    text: extension.to_string(),
                    append: true,
                });
            }
            for text in &activity[previous.len()..] {
                entries.push(ActivityEntry {
                    text: text.clone(),
                    append: false,
                });
            }
            return ActivityDelta {
                replay: false,
                entries,
            };
        }
    }
    replay()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_log_replays_and_a_grown_log_appends() {
        let initial = activity_delta(&[], &["a".to_string()]);
        assert!(initial.replay);
        let grown = activity_delta(&["a".to_string()], &["a".to_string(), "b".to_string()]);
        assert!(!grown.replay);
        assert_eq!(grown.entries.len(), 1);
        assert!(!grown.entries[0].append);
    }

    #[test]
    fn a_streamed_chunk_continues_the_last_line() {
        let delta = activity_delta(&["run".to_string()], &["running".to_string()]);
        assert!(!delta.replay);
        assert_eq!(delta.entries[0].text, "ning");
        assert!(delta.entries[0].append);
    }
}
