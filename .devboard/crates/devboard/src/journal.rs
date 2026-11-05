//! The dashboard journal: one JSONL file per project, appended by the server
//! and read by the watchdog.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use sha2::{Digest, Sha256};
use time::OffsetDateTime;

/// The live journal rotates at this size.
pub const JOURNAL_ROTATE_BYTES: u64 = 8 * 1024 * 1024;

/// The journal record kinds the debugger and watchdog distinguish.
pub const JOURNAL_KINDS: &[&str] = &[
    "activity",
    "question",
    "run-start",
    "run-stop",
    "lane-start",
    "lane-stop",
    "lifecycle",
    "acp-stderr",
    "server-error",
    "update",
    "update-error",
    "resource-defer",
    "resource-kill",
];

/// The 24-hex project key that names this project's journal.
pub fn journal_key(repo_dir: &Path) -> String {
    let digest = Sha256::digest(repo_dir.to_string_lossy().as_bytes());
    hex::encode(digest)[..24].to_string()
}

/// The live journal path under one state directory.
pub fn journal_file(state_dir: &Path, repo_dir: &Path) -> PathBuf {
    state_dir
        .join("journal")
        .join(format!("{}.jsonl", journal_key(repo_dir)))
}

/// A JSONL line for one record: the record's text is bounded to 2000 chars.
pub fn journal_line(
    timestamp: &str,
    repo_dir: &Path,
    port: u16,
    pid: u32,
    kind: &str,
    text: &str,
    scope: Option<&str>,
) -> String {
    let bounded: String = if text.chars().count() > 2000 {
        let mut truncated: String = text.chars().take(2000).collect();
        truncated.push('…');
        truncated
    } else {
        text.to_string()
    };
    let mut record = serde_json::Map::new();
    record.insert("ts".into(), timestamp.into());
    record.insert(
        "repo".into(),
        repo_dir.to_string_lossy().into_owned().into(),
    );
    record.insert("port".into(), port.into());
    record.insert("pid".into(), pid.into());
    record.insert("kind".into(), kind.into());
    record.insert("text".into(), bounded.into());
    if let Some(scope) = scope {
        record.insert("scope".into(), scope.into());
    }
    let mut line = crate::jsjson::stringify(&serde_json::Value::Object(record));
    line.push('\n');
    line
}

/// One dashboard journal writer. A failed write is reported once and never
/// interrupts a run.
pub struct Journal {
    pub path: PathBuf,
    repo_dir: PathBuf,
    port: u16,
    pid: u32,
    rotate_bytes: u64,
    state: Mutex<JournalState>,
    reported: AtomicBool,
    rotations: AtomicU64,
}

struct JournalState {
    opened: bool,
    size: u64,
}

impl Journal {
    pub fn open(state_dir: &Path, repo_dir: &Path, port: u16) -> Self {
        let path = journal_file(state_dir, repo_dir);
        let _ = fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
        Self {
            path,
            repo_dir: repo_dir.to_path_buf(),
            port,
            pid: std::process::id(),
            rotate_bytes: JOURNAL_ROTATE_BYTES,
            state: Mutex::new(JournalState {
                opened: false,
                size: 0,
            }),
            reported: AtomicBool::new(false),
            rotations: AtomicU64::new(0),
        }
    }

    /// Appends one record. The scope names the run, lane, peer, or call flow.
    pub fn write(&self, kind: &str, text: &str, scope: Option<&str>) {
        let timestamp = now_iso8601();
        let line = journal_line(
            &timestamp,
            &self.repo_dir,
            self.port,
            self.pid,
            kind,
            text,
            scope,
        );
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if !state.opened {
            let _ = fs::create_dir_all(self.path.parent().unwrap_or(Path::new(".")));
            state.size = fs::metadata(&self.path).map(|meta| meta.len()).unwrap_or(0);
            state.opened = true;
        }
        let bytes = line.len() as u64;
        if state.size > 0 && state.size + bytes > self.rotate_bytes {
            self.rotate(&mut state);
        }
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| file.write_all(line.as_bytes()))
        {
            Ok(()) => state.size += bytes,
            Err(error) => {
                if !self.reported.swap(true, Ordering::Relaxed) {
                    eprintln!(
                        "journal: could not write {}: {}",
                        self.path.display(),
                        error
                    );
                }
            }
        }
    }

    fn rotate(&self, state: &mut JournalState) {
        let rotation = self.rotations.fetch_add(1, Ordering::Relaxed) + 1;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let aside = self
            .path
            .with_extension(format!("jsonl.{stamp}-{rotation}"));
        if let Err(error) = fs::rename(&self.path, &aside) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return;
            }
        }
        state.size = 0;
    }
}

/// The current instant as an ISO 8601 UTC timestamp with milliseconds.
pub fn now_iso8601() -> String {
    let now = OffsetDateTime::now_utc();
    let format = time::format_description::well_known::Rfc3339;
    now.format(&format)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}
