//! The proposed-goal naming turn: one bounded ACP ask, its normalized slug,
//! and the deterministic fallback on every failure.

use std::path::PathBuf;

use serde_json::json;

fn root(label: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("goal-slug-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn submission(report: &str) -> devboard::feedback::GoalProposalSubmission {
    devboard::feedback::parse_goal_proposal_submission(&json!({"report": report})).unwrap()
}

fn drafts(directory: &PathBuf) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn stub(extra: &str) -> String {
    format!("{} acp-stub {extra}", env!("CARGO_BIN_EXE_devboard"))
}

#[tokio::test]
async fn the_naming_turn_supplies_the_normalized_slug() {
    let directory = root("used");
    let repo = directory.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let proposal = devboard::goal_proposal::write_goal_proposal(
        &submission("Calm the settings header\n\nMake the header calm."),
        &repo,
        &stub("--goal-slug=My-Chosen-Slug"),
        None,
        None,
    )
    .await
    .expect("the draft is written");
    let href = proposal["links"]["draft"]["href"].as_str().unwrap();
    assert!(href.ends_with("/my-chosen-slug.md"), "{href}");
    assert_eq!(
        drafts(&repo.join(".devboard/goal-proposals")),
        vec!["my-chosen-slug.md".to_string()]
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[tokio::test]
async fn an_exit_or_a_question_falls_back_to_the_deterministic_slug() {
    for (label, command) in [
        ("exit", "false".to_string()),
        ("question", stub("--questions=1")),
    ] {
        let directory = root(label);
        let repo = directory.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        devboard::goal_proposal::write_goal_proposal(
            &submission("Calm the settings header\n\nMake the header calm."),
            &repo,
            &command,
            None,
            None,
        )
        .await
        .expect("the draft is written");
        assert_eq!(
            drafts(&repo.join(".devboard/goal-proposals")),
            vec!["calm-the-settings-header.md".to_string()],
            "{label}"
        );
        let _ = std::fs::remove_dir_all(&directory);
    }
}
