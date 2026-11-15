//! The one rule that decides whether a release tag belongs to a release line.
//!
//! A pinned release commits its version bump only on the tag and never advances
//! `main`, so the newest release is not merged into the line. A tag therefore
//! counts when its peeled commit is an ancestor of the head, or when that
//! commit's parent is: the release commit one past the tip still anchors the
//! line. A tag an operator made elsewhere satisfies neither test and never
//! moves the base.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::{Command, Stdio};

/// One release tag of a line, with its `v` stripped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseTag {
    pub tag: String,
    pub version: String,
}

/// The rule: a tag counts when its commit is on the line, or its parent is.
///
/// `is_ancestor` answers whether the argument is an ancestor of the line's
/// head. Both facts are resolved by the caller, so the async publisher and the
/// blocking gate share this one condition.
pub fn tag_counts(
    commit: Option<&str>,
    parent: Option<&str>,
    is_ancestor: &mut dyn FnMut(&str) -> bool,
) -> bool {
    let Some(commit) = commit.map(str::trim).filter(|commit| !commit.is_empty()) else {
        return false;
    };
    is_ancestor(commit)
        || parent
            .map(str::trim)
            .filter(|parent| !parent.is_empty())
            .is_some_and(is_ancestor)
}

/// A `v<major>.<minor>.<patch>` tag's version, or `None` for another tag.
pub fn release_tag_version(tag: &str) -> Option<String> {
    let version = tag.trim().strip_prefix('v')?;
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        Some(version.to_string())
    } else {
        None
    }
}

/// Every release tag on `head`'s line, read in three git commands whatever the
/// number of tags.
///
/// `run` executes one git command inside the repository and answers its
/// trimmed stdout on success. The tag refs name their peeled commits, one
/// `rev-list --parents --no-walk` names those commits' first parents, and one
/// `rev-list <head>` names the line's commits. A tag whose commit cannot be
/// peeled is skipped; it never anchors a line it cannot prove.
pub fn release_tags(run: &mut dyn FnMut(&[&str]) -> Option<String>, head: &str) -> Vec<ReleaseTag> {
    let Some(listing) = run(&[
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(*objectname)",
        "refs/tags/v*",
    ]) else {
        return Vec::new();
    };
    let mut entries: Vec<(String, String, String)> = Vec::new();
    for line in listing.split('\n') {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\t');
        let tag = fields.next().unwrap_or("").trim();
        let Some(version) = release_tag_version(tag) else {
            continue;
        };
        let object = fields.next().unwrap_or("").trim();
        let peeled = fields.next().unwrap_or("").trim();
        let commit = if peeled.is_empty() { object } else { peeled };
        if commit.is_empty() {
            continue;
        }
        entries.push((tag.to_string(), version, commit.to_string()));
    }
    if entries.is_empty() {
        return Vec::new();
    }
    let mut commits: Vec<&str> = entries
        .iter()
        .map(|(_, _, commit)| commit.as_str())
        .collect();
    commits.sort_unstable();
    commits.dedup();
    let mut arguments: Vec<&str> = vec!["rev-list", "--parents", "--no-walk"];
    arguments.extend(commits.iter().copied());
    let Some(parents_text) = run(&arguments) else {
        return Vec::new();
    };
    let mut parents: HashMap<&str, &str> = HashMap::new();
    for line in parents_text.split('\n') {
        let mut fields = line.split_whitespace();
        let (Some(commit), Some(parent)) = (fields.next(), fields.next()) else {
            continue;
        };
        parents.insert(commit, parent);
    }
    let Some(ancestors_text) = run(&["rev-list", head]) else {
        return Vec::new();
    };
    let ancestors: HashSet<&str> = ancestors_text.split_whitespace().collect();
    entries
        .into_iter()
        .filter(|(_, _, commit)| {
            tag_counts(
                Some(commit),
                parents.get(commit.as_str()).copied(),
                &mut |ancestor| ancestors.contains(ancestor),
            )
        })
        .map(|(tag, version, _)| ReleaseTag { tag, version })
        .collect()
}

/// [`release_tags`] against a repository, using the local git executable.
///
/// Tags are local objects, so no credential or remote is involved here.
pub fn release_tags_in(repo_dir: &Path, head: &str) -> Vec<ReleaseTag> {
    release_tags(
        &mut |args| {
            let output = Command::new("git")
                .arg("-C")
                .arg(repo_dir)
                .args(args)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .ok()?;
            output
                .status
                .success()
                .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        },
        head,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tag_counts_when_its_commit_or_its_parent_is_on_the_line() {
        assert!(tag_counts(Some("child"), None, &mut |_| true));
        assert!(tag_counts(Some("child"), Some("parent"), &mut |commit| {
            commit == "parent"
        }));
        assert!(!tag_counts(Some("child"), Some("parent"), &mut |_| false));
        assert!(!tag_counts(None, Some("parent"), &mut |_| true));
    }

    #[test]
    fn a_tag_one_past_the_tip_counts_through_its_parent() {
        let mut run = |args: &[&str]| -> Option<String> {
            match args {
                ["for-each-ref", ..] => Some("v1.2.3\tchild\t\nv9.9.9\thidden\t\n".to_string()),
                ["rev-list", "--parents", "--no-walk", ..] => {
                    Some("child parent\nhidden stranger\n".to_string())
                }
                ["rev-list", "HEAD"] => Some("parent\n".to_string()),
                _ => None,
            }
        };
        assert_eq!(
            release_tags(&mut run, "HEAD"),
            vec![ReleaseTag {
                tag: "v1.2.3".to_string(),
                version: "1.2.3".to_string(),
            }]
        );
    }

    #[test]
    fn only_release_shaped_tags_are_read() {
        assert_eq!(release_tag_version("v1.2.3"), Some("1.2.3".to_string()));
        assert_eq!(release_tag_version("v2.0.0-rc1"), None);
        assert_eq!(release_tag_version("nightly"), None);
    }
}
