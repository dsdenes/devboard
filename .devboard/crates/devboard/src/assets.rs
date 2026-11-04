//! The built Svelte client, embedded in the binary so no client tooling ships
//! to a host and a dashboard never serves a bundle from a half-written install.

use include_dir::{include_dir, Dir};

/// The client build. `scripts/embed-client.mjs` refreshes it from `dist` before
/// a release build; the committed copy lets a fresh checkout build and test
/// without Node, Bun, or npm.
static CLIENT: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/assets");

/// The bytes of one static path, or `None` when the build does not carry it.
pub fn lookup(relative: &str) -> Option<&'static [u8]> {
    CLIENT.get_file(relative).map(|file| file.contents())
}

/// The immutable static snapshot one process serves.
///
/// A `STATIC_DIR` source bundle is copied once into
/// `<STATE_DIR>/serving/<pid>-<version>` and every answer reads the copy, so a
/// rebuild under the source directory never changes what a running dashboard
/// serves. Snapshots whose process is gone are pruned first.
pub fn snapshot_static(
    source: &std::path::Path,
    state_dir: &std::path::Path,
    version: &str,
) -> Result<std::path::PathBuf, String> {
    let serving = state_dir.join("serving");
    std::fs::create_dir_all(&serving).map_err(|error| error.to_string())?;
    prune_dead_snapshots(&serving);
    let name = format!("{}-{}", std::process::id(), snapshot_label(version));
    let target = serving.join(&name);
    if target.is_dir() {
        return Ok(target);
    }
    let staging = serving.join(format!(".{name}.tmp"));
    let _ = std::fs::remove_dir_all(&staging);
    copy_tree(source, &staging)?;
    std::fs::rename(&staging, &target).map_err(|error| error.to_string())?;
    Ok(target)
}

fn snapshot_label(version: &str) -> String {
    let label: String = version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '.' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();
    if label.is_empty() {
        "unknown".to_string()
    } else {
        label
    }
}

fn prune_dead_snapshots(serving: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(serving) else {
        return;
    };
    let self_pid = std::process::id();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Some(pid) = name
            .split_once('-')
            .and_then(|(pid, _)| pid.parse::<u32>().ok())
        else {
            continue;
        };
        if pid != self_pid && !crate::supervision::live_process(pid) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn copy_tree(source: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
    let entries = std::fs::read_dir(source).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        let destination = target.join(&name);
        if metadata.is_dir() {
            copy_tree(&path, &destination)?;
        } else if metadata.file_type().is_symlink() {
            let resolved = std::fs::metadata(&path).map_err(|error| error.to_string())?;
            if resolved.is_dir() {
                copy_tree(&path, &destination)?;
            } else {
                std::fs::copy(&path, &destination).map_err(|error| error.to_string())?;
            }
        } else if metadata.is_file() {
            std::fs::copy(&path, &destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    #[test]
    fn a_dead_pid_snapshot_is_pruned_and_a_live_one_is_kept() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("assets-snapshot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let source = root.join("source");
        let state = root.join("state");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("index.html"), "<!doctype html>\n").unwrap();
        std::fs::create_dir_all(state.join("serving/999999-1.0.0")).unwrap();
        std::fs::create_dir_all(
            state
                .join("serving")
                .join(format!("{}-0.1.0", std::process::id())),
        )
        .unwrap();
        let snapshot = snapshot_static(&source, &state, "1.0.0").expect("a snapshot");
        assert!(snapshot.is_dir());
        assert!(
            !state.join("serving/999999-1.0.0").exists(),
            "a snapshot of a dead pid is pruned"
        );
        assert!(
            state
                .join("serving")
                .join(format!("{}-0.1.0", std::process::id()))
                .exists(),
            "the running process keeps its own snapshot"
        );
        // A source change never reaches the snapshot.
        std::fs::write(
            source.join("index.html"),
            "<!doctype html><title>x</title>\n",
        )
        .unwrap();
        let bytes = std::fs::read(snapshot.join("index.html")).unwrap();
        assert_eq!(bytes, b"<!doctype html>\n");
        let _ = std::fs::remove_dir_all(&root);
    }
}
