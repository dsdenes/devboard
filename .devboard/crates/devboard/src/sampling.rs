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

/// One file's retained content for one representation and the stamp it was
/// read at.
struct Entry<T> {
    modified: SystemTime,
    len: u64,
    value: T,
}

/// The representations are cached apart. One `text`, one `lossy_text`, and one
/// `json` read of the same unchanged file each cost one content read, and none
/// makes another look like a document it is not. The strict and lossy text
/// entries stay separate because the same bytes are different documents to
/// them.
#[derive(Default)]
struct Cache {
    json: HashMap<PathBuf, Entry<Option<Arc<Value>>>>,
    text: HashMap<PathBuf, Entry<Result<Arc<String>, String>>>,
    lossy_text: HashMap<PathBuf, Entry<Result<Arc<String>, String>>>,
    reads: HashMap<PathBuf, u64>,
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

fn matches<T>(entry: &Entry<T>, modified: SystemTime, len: u64) -> bool {
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
    let Ok(mut cache) = cache().lock() else {
        return std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(Arc::new);
    };
    if let Some(entry) = cache.json.get(path) {
        if matches(entry, modified, len) {
            return entry.value.clone();
        }
    }
    let value = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(Arc::new);
    cache.json.insert(
        path.to_path_buf(),
        Entry {
            modified,
            len,
            value: value.clone(),
        },
    );
    *cache.reads.entry(path.to_path_buf()).or_insert(0) += 1;
    value
}

/// One file's text, read only when the file changed since the last sample.
pub fn text(path: &Path) -> Option<Arc<String>> {
    try_text(path).ok()
}

/// One file's text, decoding every byte sequence that is not valid UTF-8 as
/// U+FFFD.
///
/// Every reader of a skill document uses this rule: a document saved in
/// another encoding, or carrying one stray byte, still yields text, so that
/// byte changes one character instead of making the reader drop or refuse the
/// whole directory. [`text`] stays strict for a caller that must tell a
/// document with no text from one it cannot read.
pub fn text_lossy(path: &Path) -> Option<Arc<String>> {
    sample_text(path, Decode::Lossy).ok()
}

/// One file's text, or the cause that stopped the read.
///
/// `text` answers "is there text here"; this answers "why is there none", for
/// a caller that must tell a file that vanished from one it cannot read. The
/// failed read is retained by the same stamp, so an unchanged unreadable file
/// costs no content read per sample.
pub fn try_text(path: &Path) -> Result<Arc<String>, String> {
    sample_text(path, Decode::Strict)
}

/// Which decode a text sample asks for.
#[derive(Clone, Copy)]
enum Decode {
    /// Invalid UTF-8 has no text.
    Strict,
    /// Invalid UTF-8 becomes U+FFFD.
    Lossy,
}

fn sample_text(path: &Path, decode: Decode) -> Result<Arc<String>, String> {
    let read = |path: &Path| -> Result<Arc<String>, String> {
        match decode {
            Decode::Strict => std::fs::read_to_string(path)
                .map(Arc::new)
                .map_err(|error| error.to_string()),
            Decode::Lossy => std::fs::read(path)
                .map(|bytes| Arc::new(String::from_utf8_lossy(&bytes).into_owned()))
                .map_err(|error| error.to_string()),
        }
    };
    let Some((modified, len)) = stamp_of(path) else {
        forget(path);
        // A path whose metadata cannot be read — a vanished file, a link with
        // no target — costs no content read, so its cause is the stamp that
        // failed.
        return Err("its metadata could not be read".to_string());
    };
    let Ok(mut cache) = cache().lock() else {
        return read(path);
    };
    let entries = match decode {
        Decode::Strict => &mut cache.text,
        Decode::Lossy => &mut cache.lossy_text,
    };
    if let Some(entry) = entries.get(path) {
        if matches(entry, modified, len) {
            return entry.value.clone();
        }
    }
    let value = read(path);
    entries.insert(
        path.to_path_buf(),
        Entry {
            modified,
            len,
            value: value.clone(),
        },
    );
    *cache.reads.entry(path.to_path_buf()).or_insert(0) += 1;
    value
}

/// Drops one path's retained content, so a vanished file is read again when
/// it returns.
fn forget(path: &Path) {
    if let Ok(mut cache) = cache().lock() {
        cache.json.remove(path);
        cache.text.remove(path);
        cache.lossy_text.remove(path);
        cache.reads.remove(path);
    }
}

/// The content reads one exact path has performed since the last reset.
pub fn reads(path: &Path) -> u64 {
    cache()
        .lock()
        .ok()
        .and_then(|cache| cache.reads.get(path).copied())
        .unwrap_or(0)
}

/// The content reads every path under one directory has performed.
pub fn reads_under(directory: &Path) -> u64 {
    cache()
        .lock()
        .ok()
        .map(|cache| {
            cache
                .reads
                .iter()
                .filter(|(path, _)| path.starts_with(directory))
                .map(|(_, reads)| *reads)
                .sum()
        })
        .unwrap_or(0)
}

/// Clears the per-path read counts of every path under one directory, keeping
/// the retained content.
pub fn reset_reads_under(directory: &Path) {
    if let Ok(mut cache) = cache().lock() {
        for (path, reads) in cache.reads.iter_mut() {
            if path.starts_with(directory) {
                *reads = 0;
            }
        }
    }
}

/// Clears every count and every retained document. A test that writes a
/// fixture before another test sampled the same path starts from a cold cache.
pub fn reset() {
    if let Ok(mut cache) = cache().lock() {
        cache.json.clear();
        cache.text.clear();
        cache.lossy_text.clear();
        cache.reads.clear();
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

    #[test]
    fn a_text_sample_never_hides_a_json_sample() {
        let root = scratch("representations");
        let path = root.join("worker.json");
        std::fs::write(&path, "{\"lifecycle\":\"running\"}").expect("a fixture");
        assert_eq!(
            text(&path).map(|text| text.to_string()),
            Some("{\"lifecycle\":\"running\"}".to_string())
        );
        assert_eq!(
            json(&path).map(|value| value["lifecycle"].clone()),
            Some(Value::String("running".into())),
            "a text sample of an unchanged file leaves its JSON a parsed document"
        );
        assert_eq!(reads(&path), 2, "one content read per representation");
        assert!(text(&path).is_some() && json(&path).is_some());
        assert_eq!(
            reads(&path),
            2,
            "an unchanged file is sampled without a read"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unreadable_file_reports_its_cause_and_keeps_its_one_read() {
        let root = scratch("unreadable");
        let path = root.join("record.md");
        std::fs::write(&path, [0x80]).expect("a fixture");
        assert!(
            try_text(&path).is_err(),
            "an invalid UTF-8 file has no text"
        );
        assert!(text(&path).is_none(), "the optional read reports the same");
        assert_eq!(reads(&path), 1, "an unchanged failure is retained");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// One stray byte makes a document unreadable to the strict reader but
    /// still a document to the lossy one; the two samples are retained apart.
    #[test]
    fn a_lossy_sample_keeps_a_document_the_strict_reader_refuses() {
        let root = scratch("lossy");
        let path = root.join("SKILL.md");
        std::fs::write(&path, [b'a', 0xe9, b'b']).expect("a fixture");
        assert!(text(&path).is_none(), "the strict reader refuses the bytes");
        assert_eq!(
            text_lossy(&path).map(|text| text.to_string()),
            Some("a\u{fffd}b".to_string())
        );
        assert_eq!(
            text_lossy(&path).map(|text| text.to_string()),
            Some("a\u{fffd}b".to_string()),
            "an unchanged lossy sample is read once"
        );
        assert_eq!(reads(&path), 2, "one read per representation");
        let _ = std::fs::remove_dir_all(&root);
    }
}
