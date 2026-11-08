//! The proposed-goal draft name: derived from the report inside the request,
//! with no agent turn between the click and the answer.

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

#[tokio::test]
async fn the_report_names_the_draft() {
    let directory = root("used");
    let repo = directory.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let proposal = devboard::goal_proposal::write_goal_proposal(
        &submission("Calm the settings header\n\nMake the header calm."),
        &repo,
        None,
    )
    .await
    .expect("the draft is written");
    let href = proposal["links"]["draft"]["href"].as_str().unwrap();
    assert!(href.ends_with("/calm-the-settings-header.md"), "{href}");
    assert_eq!(
        drafts(&repo.join(".devboard/goal-proposals")),
        vec!["calm-the-settings-header.md".to_string()]
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[tokio::test]
async fn a_second_report_with_the_same_first_line_earns_the_next_name() {
    let directory = root("taken");
    let repo = directory.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for _ in 0..2 {
        devboard::goal_proposal::write_goal_proposal(
            &submission("Calm the settings header\n\nMake the header calm."),
            &repo,
            None,
        )
        .await
        .expect("the draft is written");
    }
    assert_eq!(
        drafts(&repo.join(".devboard/goal-proposals")),
        vec![
            "calm-the-settings-header-2.md".to_string(),
            "calm-the-settings-header.md".to_string(),
        ]
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[tokio::test]
async fn a_report_with_no_usable_line_falls_back_to_the_default_name() {
    let directory = root("fallback");
    let repo = directory.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    devboard::goal_proposal::write_goal_proposal(&submission("!!!"), &repo, None)
        .await
        .expect("the draft is written");
    assert_eq!(
        drafts(&repo.join(".devboard/goal-proposals")),
        vec!["ui-goal.md".to_string()]
    );
    let _ = std::fs::remove_dir_all(&directory);
}
