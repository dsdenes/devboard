//! The installed-skills payload and the project OMP exclusion it toggles.

use std::path::{Path, PathBuf};

use devboard::installed_skills::{
    glob_matches, installed_skills_payload, set_installed_skill_enabled, toggle_installed_skill,
    ToggleOutcome,
};
use serde_json::{json, Value};

fn scratch(label: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("installed-skills-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".omp/skills")).expect("a fixture skills root");
    root
}

fn basic_skill(name: &str) -> String {
    format!("---\nname: {name}\ndescription: Guidance for {name}.\n---\n\n# {name}\n")
}

fn managed_skill(name: &str, family: Option<&str>) -> String {
    let mut source = format!(
        "---\nname: {name}\ndescription: Guidance for {name}.\nmetadata:\n  devboard-managed: \"true\"\n"
    );
    if let Some(family) = family {
        source.push_str(&format!("  devboard-family: {family}\n"));
    }
    source.push_str(&format!("---\n\n# {name}\n"));
    source
}

fn builtin_skill(name: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: Guidance for {name}.\nmetadata:\n  devboard-builtin: \"true\"\n---\n\n# {name}\n"
    )
}

fn write_skill(repo: &Path, name: &str, source: &str) {
    let directory = repo.join(".omp/skills").join(name);
    std::fs::create_dir_all(&directory).expect("a skill directory");
    std::fs::write(directory.join("SKILL.md"), source).expect("a SKILL.md");
}

fn settings_path(repo: &Path) -> PathBuf {
    repo.join(".omp/settings.json")
}

async fn toggle(repo: &Path, name: &str, enabled: bool) -> Result<Value, String> {
    let name = Value::String(name.to_string());
    let enabled = Value::Bool(enabled);
    set_installed_skill_enabled(repo, Some(&name), Some(&enabled)).await
}

/// One row as the frame carries it, in the frame's own key order.
fn row(name: &str, enabled: bool, content: String, builtin: bool, deletable: bool) -> Value {
    json!({
        "name": name,
        "enabled": enabled,
        "content": content,
        "builtin": builtin,
        "deletable": deletable,
    })
}

#[tokio::test]
async fn rows_follow_the_filesystem_and_classify_markers() {
    let repo = scratch("rows");
    write_skill(&repo, "gamma", &basic_skill("gamma"));
    write_skill(&repo, "alpha", &basic_skill("alpha"));
    write_skill(&repo, "prepared", &managed_skill("prepared", None));
    write_skill(
        &repo,
        "published",
        &managed_skill("published", Some("discover")),
    );
    write_skill(&repo, "package", &builtin_skill("package"));
    // A directory without a SKILL.md and a plain file contribute no row.
    std::fs::create_dir_all(repo.join(".omp/skills/incomplete")).expect("an empty directory");
    std::fs::write(repo.join(".omp/skills/notes.txt"), "not a skill\n").expect("a stray file");
    // A link is the operator's entry: it lists the target's bytes and is never
    // a row this page deletes.
    std::os::unix::fs::symlink("prepared", repo.join(".omp/skills/linked")).expect("a symlink");

    let payload = installed_skills_payload(&repo).await;

    assert_eq!(payload["type"], "installedSkills");
    let expected = json!({
        "type": "installedSkills",
        "skills": [
            row("alpha", true, basic_skill("alpha"), false, false),
            row("gamma", true, basic_skill("gamma"), false, false),
            row("linked", true, managed_skill("prepared", None), false, false),
            row("package", true, builtin_skill("package"), true, false),
            row("prepared", true, managed_skill("prepared", None), false, true),
            row("published", true, managed_skill("published", Some("discover")), false, false),
        ],
    });
    // The corpus compares frame text, so key order is part of the contract.
    assert_eq!(
        devboard::jsjson::stringify(&payload),
        devboard::jsjson::stringify(&expected)
    );
    assert_eq!(payload, expected);
}

#[tokio::test]
async fn disabling_writes_the_exclusion_and_a_rerun_reports_it() {
    let repo = scratch("toggle");
    for name in ["alpha", "beta", "gamma"] {
        write_skill(&repo, name, &basic_skill(name));
    }
    let untouched = std::fs::read(repo.join(".omp/skills/beta/SKILL.md")).expect("the skill");
    std::fs::write(
        settings_path(&repo),
        concat!(
            "{\"modelRoles\":{\"commit\":\"provider/model\"},",
            "\"skills\":{\"includeSkills\":[\"kept\"]},",
            "\"unrelated\":{\"keep\":true}}\n",
        ),
    )
    .expect("a settings document");

    let changed = toggle(&repo, "beta", false).await.expect("a change");
    assert_eq!(changed["type"], "installedSkills");
    let rows = changed["skills"].as_array().expect("rows");
    let names: Vec<&str> = rows
        .iter()
        .map(|value| value["name"].as_str().expect("a name"))
        .collect();
    assert_eq!(names, ["alpha", "beta", "gamma"]);
    assert_eq!(rows[1]["enabled"], false);
    assert_eq!(rows[0]["enabled"], true);

    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        concat!(
            "{\n",
            "  \"modelRoles\": {\n",
            "    \"commit\": \"provider/model\"\n",
            "  },\n",
            "  \"skills\": {\n",
            "    \"includeSkills\": [\n",
            "      \"kept\"\n",
            "    ],\n",
            "    \"ignoredSkills\": [\n",
            "      \"beta\"\n",
            "    ]\n",
            "  },\n",
            "  \"unrelated\": {\n",
            "    \"keep\": true\n",
            "  }\n",
            "}\n",
        )
    );

    let rerun = installed_skills_payload(&repo).await;
    let rows = rerun["skills"].as_array().expect("rows");
    assert_eq!(rows[1]["name"], "beta");
    assert_eq!(rows[1]["enabled"], false);
    assert_eq!(rows[0]["enabled"], true);
    assert_eq!(rows[2]["enabled"], true);

    let resumed = toggle(&repo, "beta", true).await.expect("a change");
    assert_eq!(
        resumed["skills"].as_array().expect("rows")[1]["enabled"],
        true
    );
    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        concat!(
            "{\n",
            "  \"modelRoles\": {\n",
            "    \"commit\": \"provider/model\"\n",
            "  },\n",
            "  \"skills\": {\n",
            "    \"includeSkills\": [\n",
            "      \"kept\"\n",
            "    ],\n",
            "    \"ignoredSkills\": []\n",
            "  },\n",
            "  \"unrelated\": {\n",
            "    \"keep\": true\n",
            "  }\n",
            "}\n",
        )
    );

    // Toggling never touches the skill's bytes.
    assert_eq!(
        std::fs::read(repo.join(".omp/skills/beta/SKILL.md")).expect("the skill"),
        untouched
    );
}

#[tokio::test]
async fn disabling_creates_the_settings_file_when_it_is_absent() {
    let repo = scratch("create");
    write_skill(&repo, "beta", &basic_skill("beta"));
    assert!(!settings_path(&repo).exists());

    toggle(&repo, "beta", false).await.expect("a change");

    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        concat!(
            "{\n",
            "  \"skills\": {\n",
            "    \"ignoredSkills\": [\n",
            "      \"beta\"\n",
            "    ]\n",
            "  }\n",
            "}\n",
        )
    );
}

#[tokio::test]
async fn a_missing_skill_refuses_and_writes_nothing() {
    let repo = scratch("missing");
    for name in ["alpha", "beta"] {
        write_skill(&repo, name, &basic_skill(name));
    }

    let error = toggle(&repo, "missing", false)
        .await
        .expect_err("a refusal");
    assert_eq!(error, "No skill named \"missing\" is installed.");
    assert!(!settings_path(&repo).exists());

    // The refusal is the error frame, then the authoritative rows.
    let name = json!("missing");
    let enabled = json!(false);
    match toggle_installed_skill(&repo, Some(&name), Some(&enabled)).await {
        ToggleOutcome::Refused(frames) => {
            assert_eq!(frames.len(), 2);
            assert_eq!(
                frames[0],
                json!({"type": "error", "message": "No skill named \"missing\" is installed."})
            );
            assert_eq!(frames[1]["type"], "installedSkills");
            assert_eq!(frames[1]["skills"].as_array().expect("rows").len(), 2);
        }
        ToggleOutcome::Changed(_) => panic!("a missing skill is never a change"),
    }
}

#[tokio::test]
async fn invalid_arguments_refuse_with_one_frame_and_no_write() {
    let repo = scratch("invalid");
    write_skill(&repo, "alpha", &basic_skill("alpha"));

    let enabled = json!(false);
    let named = value("Bad Name");
    assert_eq!(
        set_installed_skill_enabled(&repo, Some(&named), Some(&enabled))
            .await
            .expect_err("a refusal"),
        "Choose an installed skill to change."
    );
    assert_eq!(
        set_installed_skill_enabled(&repo, None, Some(&enabled))
            .await
            .expect_err("a refusal"),
        "A skill change needs its name and enabled value."
    );
    let name = value("alpha");
    assert_eq!(
        set_installed_skill_enabled(&repo, Some(&name), None)
            .await
            .expect_err("a refusal"),
        "A skill change needs its name and enabled value."
    );
    assert_eq!(
        set_installed_skill_enabled(&repo, Some(&name), Some(&json!("no")))
            .await
            .expect_err("a refusal"),
        "A skill change needs its name and enabled value."
    );
    // Enabling a name no exclusion lists is already the requested state: the
    // command still answers with the authoritative rows and writes nothing.
    let enabled_flag = json!(true);
    let unchanged = set_installed_skill_enabled(&repo, Some(&name), Some(&enabled_flag))
        .await
        .expect("already enabled");
    assert_eq!(unchanged["skills"].as_array().expect("rows").len(), 1);
    assert!(!settings_path(&repo).exists());

    let bad = value("Bad Name");
    let outcome = toggle_installed_skill(&repo, Some(&bad), Some(&enabled)).await;
    match outcome {
        ToggleOutcome::Refused(frames) => assert_eq!(frames.len(), 1),
        ToggleOutcome::Changed(_) => panic!("an invalid name is never a change"),
    }
    assert!(!settings_path(&repo).exists());
}

#[tokio::test]
async fn glob_patterns_disable_matching_names() {
    let repo = scratch("globs");
    for name in ["alpha", "beta", "gamma"] {
        write_skill(&repo, name, &basic_skill(name));
    }
    // A non-string entry is not a pattern and disables nothing.
    std::fs::write(
        settings_path(&repo),
        "{\"skills\":{\"ignoredSkills\":[\"beta\",\"gam*\",7]}}\n",
    )
    .expect("a settings document");

    let payload = installed_skills_payload(&repo).await;
    let rows = payload["skills"].as_array().expect("rows");
    let states: Vec<(&str, bool)> = rows
        .iter()
        .map(|value| {
            (
                value["name"].as_str().expect("a name"),
                value["enabled"].as_bool().expect("an enabled flag"),
            )
        })
        .collect();
    assert_eq!(states, [("alpha", true), ("beta", false), ("gamma", false)]);
}

#[tokio::test]
async fn enabling_a_skill_a_pattern_disables_refuses_and_names_the_pattern() {
    let repo = scratch("glob-enable");
    for name in ["alpha", "gamma"] {
        write_skill(&repo, name, &basic_skill(name));
    }
    let settings = "{\"skills\":{\"ignoredSkills\":[\"gam*\"]}}\n";
    std::fs::write(settings_path(&repo), settings).expect("a settings document");

    assert_eq!(
        toggle(&repo, "gamma", true).await.expect_err("a refusal"),
        "\"gamma\" stays disabled by the pattern \"gam*\" in .omp/settings.json; edit that pattern to enable it."
    );
    // The stored pattern and every other byte survive the refusal.
    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        settings
    );

    // The sender receives the refusal, then the rows that agree with the file.
    let name = value("gamma");
    let enabled = json!(true);
    match toggle_installed_skill(&repo, Some(&name), Some(&enabled)).await {
        ToggleOutcome::Refused(frames) => {
            assert_eq!(frames.len(), 2);
            assert_eq!(
                frames[0],
                json!({
                    "type": "error",
                    "message": "\"gamma\" stays disabled by the pattern \"gam*\" in .omp/settings.json; edit that pattern to enable it.",
                })
            );
            let rows = frames[1]["skills"].as_array().expect("rows");
            assert_eq!(rows[1]["name"], "gamma");
            assert_eq!(rows[1]["enabled"], false);
        }
        ToggleOutcome::Changed(_) => panic!("a pattern keeps gamma disabled"),
    }
}

#[tokio::test]
async fn removing_the_exact_entry_still_refuses_a_matching_pattern() {
    let repo = scratch("glob-exact");
    write_skill(&repo, "gamma", &basic_skill("gamma"));
    let settings = "{\"skills\":{\"ignoredSkills\":[\"gamma\",\"gam*\"]}}\n";
    std::fs::write(settings_path(&repo), settings).expect("a settings document");

    assert_eq!(
        toggle(&repo, "gamma", true).await.expect_err("a refusal"),
        "\"gamma\" stays disabled by the pattern \"gam*\" in .omp/settings.json; edit that pattern to enable it."
    );
    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        settings
    );
}

#[tokio::test]
async fn disabling_a_skill_a_pattern_already_excludes_writes_nothing() {
    let repo = scratch("glob-disable");
    write_skill(&repo, "gamma", &basic_skill("gamma"));
    let settings = "{\"skills\":{\"ignoredSkills\":[\"gam*\"]}}\n";
    std::fs::write(settings_path(&repo), settings).expect("a settings document");

    let unchanged = toggle(&repo, "gamma", false).await.expect("no change");
    assert_eq!(
        unchanged["skills"].as_array().expect("rows")[0]["enabled"],
        false
    );
    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        settings
    );
}

#[test]
fn patterns_match_as_bun_matches_them() {
    // Every expectation below was read off `new Bun.Glob(pattern).match(name)`.
    assert!(glob_matches("gam*", "gamma"));
    assert!(glob_matches("*", ".hidden"));
    assert!(glob_matches("{alpha,beta}", "beta"));
    assert!(!glob_matches("{alpha,beta}", "gamma"));
    assert!(glob_matches("{a}", "a"));
    assert!(glob_matches("a[!b]c", "axc"));
    assert!(glob_matches("[]]", "]"));
    assert!(!glob_matches("[a-c]", "A"));
    assert!(!glob_matches("ALPHA", "alpha"));
    assert!(!glob_matches("*", "a/b"));
    assert!(!glob_matches("[", "["));
    assert!(!glob_matches("a{b", "ab"));
    assert!(glob_matches("a{b,c", "ab"));
    assert!(glob_matches("x{a,b}y", "xby"));
}

#[tokio::test]
async fn rows_sort_as_locale_compare_sorts_them() {
    let repo = scratch("sort");
    for name in ["Beta", "ab", "a-b", "ALPHA", "aab", "alpha"] {
        write_skill(&repo, name, &basic_skill(name));
    }

    let payload = installed_skills_payload(&repo).await;
    let names: Vec<&str> = payload["skills"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|value| value["name"].as_str().expect("a name"))
        .collect();
    assert_eq!(names, ["a-b", "aab", "ab", "alpha", "ALPHA", "Beta"]);
}

fn value(text: &str) -> Value {
    Value::String(text.to_string())
}

#[tokio::test]
async fn an_unreadable_settings_document_is_an_error_frame() {
    let repo = scratch("unreadable");
    write_skill(&repo, "alpha", &basic_skill("alpha"));
    std::fs::write(settings_path(&repo), "{not json\n").expect("a settings document");

    assert_eq!(
        installed_skills_payload(&repo).await,
        json!({
            "type": "error",
            "message": "Could not read the installed skills: The project OMP settings are not valid JSON.",
        })
    );
    assert_eq!(
        toggle(&repo, "alpha", false).await.expect_err("a refusal"),
        "Could not save the skill setting: The project OMP settings are not valid JSON."
    );
    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        "{not json\n"
    );
}

#[tokio::test]
async fn a_malformed_skills_setting_refuses_without_a_write() {
    let repo = scratch("malformed");
    write_skill(&repo, "alpha", &basic_skill("alpha"));

    std::fs::write(settings_path(&repo), "{\"skills\":5}\n").expect("a settings document");
    assert_eq!(
        toggle(&repo, "alpha", false).await.expect_err("a refusal"),
        "Could not save the skill setting: The project OMP skills setting is not an object."
    );
    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        "{\"skills\":5}\n"
    );

    std::fs::write(
        settings_path(&repo),
        "{\"skills\":{\"ignoredSkills\":\"beta\"}}\n",
    )
    .expect("a settings document");
    assert_eq!(
        toggle(&repo, "alpha", false).await.expect_err("a refusal"),
        "Could not save the skill setting: The project OMP skill exclusion is not an array."
    );
    assert_eq!(
        std::fs::read_to_string(settings_path(&repo)).expect("the settings"),
        "{\"skills\":{\"ignoredSkills\":\"beta\"}}\n"
    );
}
