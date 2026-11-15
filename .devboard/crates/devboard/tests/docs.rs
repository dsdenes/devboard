//! The root contract and the shipped template are one document.

#[test]
fn the_root_agents_contract_is_byte_identical_to_the_template() {
    let harness = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = std::fs::read(harness.join("../AGENTS.md")).expect("the root contract");
    let template =
        std::fs::read(harness.join("templates/host-AGENTS.md")).expect("the shipped template");
    assert_eq!(root, template, "AGENTS.md and its template must match");
}

fn harness_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn the_contract_scopes_completion_by_project_kind() {
    let text =
        std::fs::read_to_string(harness_root().join("../AGENTS.md")).expect("the root contract");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(text.contains(
        "Harness source: a change is finished when it is merged, pushed, and released by the Release Train."
    ));
    assert!(text.contains("Host project: a change is finished when it is merged and pushed."));
    assert!(text.contains(
        "Deployment belongs to the host's own Deploy on main path; no background agent waits for, inspects, or claims a release or a deployment."
    ));
}

#[test]
fn the_issue_prompt_ends_at_the_landing_proof() {
    let text = std::fs::read_to_string(harness_root().join("prompts/implement-issue.md"))
        .expect("the issue prompt");
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(normalized.contains(
        "Close the issue with `issue_close` after `devboard land` proved the push and the required checks pass."
    ));
    assert!(normalized.contains("The landed and pushed commit is the completion"));
    assert!(text.contains("## Completion"));
    assert!(!text.contains("the Release Train publishes on its own schedule"));
    assert!(!text.contains("the Release Train releases later"));
}

#[test]
fn the_prompts_name_no_host_release_train() {
    for prompt in [
        "implement-issue.md",
        "design-system.md",
        "deploy-on-main.md",
    ] {
        let text = std::fs::read_to_string(harness_root().join("prompts").join(prompt))
            .unwrap_or_else(|error| panic!("{prompt}: {error}"));
        assert!(
            !text.contains("The Release Train releases the pushed commit later"),
            "{prompt} claims the Release Train releases a host change"
        );
        assert!(
            !text.contains("the Release Train releases later"),
            "{prompt} instructs a wait for the Release Train"
        );
        assert!(
            !text.contains("Release Train publishes on its own schedule"),
            "{prompt} instructs a wait for the Release Train"
        );
    }
}

#[test]
fn the_design_prompt_pushes_without_a_release_train() {
    let prompt = std::fs::read_to_string(harness_root().join("prompts/design-system.md"))
        .expect("the design prompt");
    let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(!prompt.contains("The Release Train releases the pushed commit later"));
    assert!(normalized.contains("The worker delivers"));
    assert!(normalized.contains("never you"));
    assert!(normalized.contains("never waits for a workflow, a release, or a deployment"));
    assert!(normalized.contains("`merge` pushes `main` without force"));
    assert!(normalized.contains("`pull-request` pushes one documentation branch"));
    assert!(
        normalized.contains("never pushes `main`"),
        "the pull-request mode never pushes the integration branch"
    );
    let wrapper = std::fs::read_to_string(harness_root().join("omp/commands/design-system.md"))
        .expect("the design command");
    assert!(wrapper.contains("documentation delivery"));
}
