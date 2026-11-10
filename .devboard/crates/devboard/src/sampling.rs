//! One content read per state file per change.
//!
//! The dashboard, every background family worker, and the client that drives
//! them read durable state through this cache. A file is read only when its
//! `(modified, len)` pair changed, so an idle sampler performs no content
//! reads at all and the cost of a sample is a `stat` per file, never a read of
//! the file. One snapshot then fans out to every subscriber.
//!
//! Every content read is counted per path. The counts are what the run-output
//! tests and `devboard bench cpu` prove the bound with; they are cheap atomic
//! increments on a path that already took the global lock.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

use serde_json::Value;

/// One file's cached content and the stamp it was read at.
struct Entry {
    modified: SystemTime,
    len: u64,
    json: Option<Arc<Value>>,
    text: Option<Arc<String>>,
    reads: u64,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<PathBuf, Entry>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));

fn cache() -> &'static Mutex<Cache> {
    &CACHE
}

/// The stamp a cached read is keyed by. A file whose metadata cannot be read
/// (a directory, a vanished path) is never cached.
fn stamp_of(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    Some((modified, metadata.len()))
}

fn matches(entry: &Entry, modified: SystemTime, len: u64) -> bool {
    entry.len == len && entry.modified == modified
}

/// One file's `(modified, len)`: the stamp a caller compares before it asks
/// for the content at all.
pub fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    stamp_of(path)
}

/// One file's JSON, read only when the file changed since the last sample.
pub fn json(path: &Path) -> Option<Arc<Value>> {
    let Some((modified, len)) = stamp_of(path) else {
        forget(path);
        return None;
    };
    if let Ok(cache) = cache().lock() {
        if let Some(entry) = cache.entries.get(path) {
            if matches(entry, modified, len) {
                return entry.json.clone();
            }
        }
    }
    let text = std::fs::read_to_string(path).ok();
    let json = text
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .map(Arc::new);
    store(path, modified, len, json.clone(), text.map(Arc::new));
    json
}

/// One file's text, read only when the file changed since the last sample.
pub fn text(path: &Path) -> Option<Arc<String>> {
    let Some((modified, len)) = stamp_of(path) else {
        forget(path);
        return None;
    };
    if let Ok(cache) = cache().lock() {
        if let Some(entry) = cache.entries.get(path) {
            if matches(entry, modified, len) {
                return entry.text.clone();
            }
        }
    }
    let text = std::fs::read_to_string(path).ok().map(Arc::new);
    store(path, modified, len, None, text.clone());
    text
}

fn store(
    path: &Path,
    modified: SystemTime,
    len: u64,
    json: Option<Arc<Value>>,
    text: Option<Arc<String>>,
) {
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    let entry = cache
        .entries
        .entry(path.to_path_buf())
        .or_insert_with(|| Entry {
            modified,
            len,
            json: None,
            text: None,
            reads: 0,
        });
    entry.modified = modified;
    entry.len = len;
    entry.json = json;
    entry.text = text;
    entry.reads += 1;
}

/// Drops one path's retained content, so a vanished file is read again when
/// it returns.
fn forget(path: &Path) {
    if let Ok(mut cache) = cache().lock() {
        cache.entries.remove(path);
    }
}

/// The content reads one exact path has performed since the last reset.
pub fn reads(path: &Path) -> u64 {
    cache()
        .lock()
        .ok()
        .and_then(|cache| cache.entries.get(path).map(|entry| entry.reads))
        .unwrap_or(0)
}

/// The content reads every path under one directory has performed.
pub fn reads_under(directory: &Path) -> u64 {
    cache()
        .lock()
        .ok()
        .map(|cache| {
            cache
                .entries
                .iter()
                .filter(|(path, _)| path.starts_with(directory))
                .map(|(_, entry)| entry.reads)
                .sum()
        })
        .unwrap_or(0)
}

/// Clears the per-path read counts of every path under one directory, keeping
/// the retained content.
pub fn reset_reads_under(directory: &Path) {
    if let Ok(mut cache) = cache().lock() {
        for (path, entry) in cache.entries.iter_mut() {
            if path.starts_with(directory) {
                entry.reads = 0;
            }
        }
    }
}

/// Clears every count and every retained document. A test that writes a
/// fixture before another test sampled the same path starts from a cold cache.
pub fn reset() {
    if let Ok(mut cache) = cache().lock() {
        cache.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("sampling-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a scratch directory");
        root
    }

    #[test]
    fn an_unchanged_file_is_read_once() {
        let root = scratch("unchanged");
        let path = root.join("state.json");
        std::fs::write(&path, "{\"lifecycle\":\"running\"}").expect("a fixture");
        assert_eq!(
            json(&path).map(|value| value["lifecycle"].clone()),
            Some(Value::String("running".into()))
        );
        assert_eq!(
            json(&path).map(|value| value["lifecycle"].clone()),
            Some(Value::String("running".into()))
        );
        assert_eq!(reads(&path), 1, "one content read for two samples");
        std::fs::write(&path, "{\"lifecycle\":\"stopped\"} ").expect("a changed fixture");
        assert_eq!(
            json(&path).map(|value| value["lifecycle"].clone()),
            Some(Value::String("stopped".into()))
        );
        assert_eq!(reads(&path), 2, "a changed file is read again");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_vanished_file_is_not_retained() {
        let root = scratch("vanished");
        let path = root.join("state.json");
        std::fs::write(&path, "{}").expect("a fixture");
        assert!(json(&path).is_some());
        std::fs::remove_file(&path).expect("removed");
        assert!(json(&path).is_none());
        std::fs::write(&path, "{\"a\":1}").expect("a returning fixture");
        assert_eq!(
            json(&path).map(|value| value["a"].clone()),
            Some(Value::from(1))
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
