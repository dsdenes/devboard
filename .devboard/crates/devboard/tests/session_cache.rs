//! The transcript cache: an unchanged transcript is parsed once, and a repeat
//! listing or search returns byte-identical output.

use std::path::PathBuf;
use std::sync::Mutex;

use devboard::agent_sessions::{list_sessions, reset_session_cache, search_sessions};

/// The parse counters are process-wide; these tests prove them one at a time.
static CACHE_LOCK: Mutex<()> = Mutex::new(());

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("session-cache-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let state = root.join("state");
        std::fs::create_dir_all(&repo).expect("a repository");
        let directory = state.join("providers/agents/scout/sessions");
        std::fs::create_dir_all(&directory).expect("a transcript directory");
        let cwd = repo.to_string_lossy().replace('\\', "/");
        let lines = [
            format!(
                r#"{{"type":"session","id":"session-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"{cwd}"}}"#
            ),
            r#"{"type":"title","title":"A fixture session"}"#.to_string(),
            r#"{"type":"message","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello world"}}"#.to_string(),
            r#"{"type":"message","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"usage":{"input":3,"output":4,"cacheRead":1,"cacheWrite":0,"cost":{"total":0.01}}}}"#.to_string(),
        ];
        std::fs::write(directory.join("a.jsonl"), lines.join("\n")).expect("the transcript");
        Self { root, repo, state }
    }

    fn list(&self) -> serde_json::Value {
        list_sessions(&devboard::agent_sessions::ListSessionsOptions {
            state_dir: self.state.clone(),
            repo_dir: self.repo.clone(),
            since: None,
            until: None,
            cwd: None,
            limit: None,
            offset: None,
            max_files: None,
            mtime_since: None,
        })
    }

    fn search(&self) -> serde_json::Value {
        search_sessions(&self.state, &self.repo, "hello", None, None)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn an_unchanged_transcript_is_not_parsed_twice() {
    let _guard = CACHE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new("repeat");
    reset_session_cache();
    let first = fixture.list();
    assert_eq!(first["total"], 1, "{first}");
    let after_first = devboard::agent_sessions::session_cache_stats();
    assert_eq!(after_first.headers_parsed, 1);
    assert_eq!(after_first.transcripts_parsed, 1);

    let second = fixture.list();
    assert_eq!(
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap(),
        "the repeated listing is byte-identical"
    );
    let after_second = devboard::agent_sessions::session_cache_stats();
    assert_eq!(
        after_second, after_first,
        "an unchanged transcript is not parsed again"
    );

    let first_search = fixture.search();
    assert_eq!(first_search["matches"][0]["sessionId"], "session-1");
    let after_search = devboard::agent_sessions::session_cache_stats();
    assert_eq!(after_search.headers_parsed, 1);
    assert_eq!(after_search.transcripts_parsed, 1);
    let second_search = fixture.search();
    assert_eq!(
        serde_json::to_string(&first_search).unwrap(),
        serde_json::to_string(&second_search).unwrap()
    );
    assert_eq!(
        devboard::agent_sessions::session_cache_stats(),
        after_search,
        "a repeated search re-parses nothing"
    );
}

#[test]
fn a_changed_transcript_is_parsed_again() {
    let _guard = CACHE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new("changed");
    reset_session_cache();
    let first = fixture.list();
    assert_eq!(first["total"], 1);
    let parsed_once = devboard::agent_sessions::session_cache_stats();
    assert_eq!(parsed_once.transcripts_parsed, 1);
    std::thread::sleep(std::time::Duration::from_millis(10));
    let path = fixture
        .state
        .join("providers/agents/scout/sessions/a.jsonl");
    let text = std::fs::read_to_string(&path).expect("the transcript");
    std::fs::write(
        &path,
        format!(
            "{}\n{}",
            text,
            r#"{"type":"message","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":"changed"}}"#
        ),
    )
    .expect("the appended transcript");
    let second = fixture.list();
    assert_eq!(second["total"], 1);
    let parsed_twice = devboard::agent_sessions::session_cache_stats();
    assert_eq!(
        parsed_twice.transcripts_parsed, 2,
        "a changed transcript is parsed again"
    );
}
