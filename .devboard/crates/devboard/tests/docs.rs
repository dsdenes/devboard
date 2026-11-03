//! The root contract and the shipped template are one document.

#[test]
fn the_root_agents_contract_is_byte_identical_to_the_template() {
    let harness = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = std::fs::read(harness.join("../AGENTS.md")).expect("the root contract");
    let template =
        std::fs::read(harness.join("templates/host-AGENTS.md")).expect("the shipped template");
    assert_eq!(root, template, "AGENTS.md and its template must match");
}
