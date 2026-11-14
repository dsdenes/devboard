//! The canonical forge's CI workflow contract.
//!
//! One commit runs one build. The workflow's `concurrency` block is what makes
//! that true on a forge that restarts a run or receives the same push twice;
//! this test parses the committed file rather than a copy.

use std::path::PathBuf;

fn workflow() -> serde_yaml::Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.gitea/workflows/devboard-ci.yml");
    let text = std::fs::read_to_string(&path).expect("the CI workflow is readable");
    serde_yaml::from_str(&text).expect("the CI workflow is YAML")
}

#[test]
fn a_duplicate_run_for_one_commit_cancels_the_older_one() {
    let workflow = workflow();
    let concurrency = workflow
        .get("concurrency")
        .and_then(serde_yaml::Value::as_mapping)
        .expect("the workflow declares a concurrency mapping");
    let group = concurrency
        .get(serde_yaml::Value::String("group".into()))
        .and_then(serde_yaml::Value::as_str)
        .expect("the concurrency group is a string");
    assert!(
        group.contains("github.sha"),
        "the group is per commit, not per workflow: {group}"
    );
    let cancel = concurrency
        .get(serde_yaml::Value::String("cancel-in-progress".into()))
        .and_then(serde_yaml::Value::as_bool)
        .expect("cancel-in-progress is a boolean");
    assert!(
        cancel,
        "an in-progress run for the same commit is cancelled"
    );
}

#[test]
fn the_check_job_still_runs_the_workspace_gates() {
    let workflow = workflow();
    let job = workflow
        .get("jobs")
        .and_then(|jobs| jobs.get("check"))
        .expect("the check job exists");
    let steps = job
        .get("steps")
        .and_then(serde_yaml::Value::as_sequence)
        .expect("the check job has steps");
    let names: Vec<&str> = steps
        .iter()
        .filter_map(|step| step.get("name").and_then(serde_yaml::Value::as_str))
        .collect();
    for gate in ["Format", "Lint", "Test"] {
        assert!(names.contains(&gate), "the {gate} step survives: {names:?}");
    }
}
