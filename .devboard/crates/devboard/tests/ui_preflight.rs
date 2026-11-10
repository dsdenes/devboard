//! The UI/UX preflight gate against real project fixtures.

use std::path::{Path, PathBuf};

use devboard::ui_preflight::{preflight, preflight_with, LintOutput};
use serde_json::{json, Value};

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp");
        std::fs::create_dir_all(&base).expect("the fixture base");
        let root = base
            .canonicalize()
            .expect("canonical fixture base")
            .join(format!("ui-preflight-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("the fixture root");
        Self { root }
    }

    fn write(&self, relative: &str, contents: &str) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("the fixture parent");
        }
        std::fs::write(path, contents).expect("the fixture file");
    }

    fn preflight(&self) -> Value {
        preflight(&self.root)
    }

    fn with_lint<F>(&self, lint: F) -> Value
    where
        F: Fn(&Path, &Path, &[&str]) -> LintOutput,
    {
        preflight_with(&self.root, lint)
    }

    /// A complete design stack: DESIGN.md, DTCG, OpenUI, and Storybook.
    fn complete_design(&self) {
        self.write(
            "DESIGN.md",
            "# Product design\n\n## Layout\n\nBase unit 4px; grid rhythm 8px. Padding 16px, \
             gaps 8px, sections 32px, containers 1200px with token mapping.\n",
        );
        self.write(
            "design/tokens.json",
            r##"{"color":{"primary":{"$value":"#3366ff","$type":"color"}}}"##,
        );
        self.write(
            "openui.json",
            r#"{"name":"Kit","version":"1.0","description":"Components","components":{"Button":{"description":"A button","props":{}}}}"#,
        );
        self.write(".storybook/main.ts", "export default {};\n");
        self.write("src/Button.stories.tsx", "export default {};\n");
    }

    fn local_design_md(&self) {
        self.write(
            "node_modules/@google/design.md/package.json",
            r#"{"name":"@google/design.md","bin":{"design.md":"bin/cli.js"}}"#,
        );
        self.write(
            "node_modules/@google/design.md/bin/cli.js",
            "#!/usr/bin/env node\n",
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

const LINT_DISPLAY: &str = "node_modules/.bin/design-md lint --format json DESIGN.md";
const LINT_BIN: &str = "node_modules/@google/design.md/bin/cli.js";
const LINT_NO_INSTALL: &str = "no local @google/design.md install; run `bun add -d \
                               @google/design.md@0.4.0` in the project root so the lint runs \
                               without a registry fetch";

fn summary(errors: i64, warnings: i64) -> String {
    json!({"summary": {"errors": errors, "warnings": warnings}, "findings": []}).to_string()
}

#[test]
fn without_ui_files_the_gate_is_not_applicable() {
    let fixture = Fixture::new("empty");
    let result = fixture.preflight();
    assert_eq!(
        result["root"],
        json!(fixture.root.to_string_lossy().to_string())
    );
    assert_eq!(result["applicable"], json!(false));
    assert_eq!(
        result["checks"]["designMd"],
        json!({"status": "missing", "path": "DESIGN.md"})
    );
    assert_eq!(result["checks"]["dtcg"], json!({"status": "missing"}));
    assert_eq!(result["checks"]["openui"], json!({"status": "missing"}));
    assert_eq!(
        result["checks"]["storybook"],
        json!({"status": "missing", "config": null, "storyCount": 0})
    );
    assert_eq!(
        result["checks"]["a2ui"],
        json!({
            "status": "provided-by-skill",
            "version": "0.9.1",
            "note": "Step 3 writes A2UI JSONL plus a standalone wireframe.",
        })
    );
    assert_eq!(
        result["checks"]["mcp"],
        json!({
            "status": "check-at-mutation",
            "requiredTools": [
                "mcp__designmd_search_design_kits",
                "mcp__designmd_get_design_kit",
            ],
            "note": "Not checked here. Verify before any design-system mutation; no research \
                     means no mutation.",
        })
    );
    let ids = result["missing"]
        .as_array()
        .expect("missing entries")
        .iter()
        .map(|entry| entry["id"].as_str().expect("an id").to_string())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["designMd", "dtcg", "openui", "storybook"]);
    assert_eq!(
        result["missing"][0],
        json!({
            "id": "designMd",
            "requirement": "DESIGN.md at the project root",
            "remediation": "Create DESIGN.md in the DESIGN.md alpha format; include tokens and \
                            a ## Layout spacing section; run `node_modules/.bin/design-md lint \
                            --format json DESIGN.md`.",
            "detail": "",
        })
    );
    assert_eq!(result["unverified"], json!([]));
}

#[test]
fn a_documented_design_system_passes_with_a_verified_lint() {
    let fixture = Fixture::new("documented");
    fixture.complete_design();
    fixture.local_design_md();
    let result = fixture.with_lint(|root, bin, args| {
        assert_eq!(bin, root.join(LINT_BIN).as_path());
        assert_eq!(args, &["lint", "--format", "json", "DESIGN.md"][..]);
        LintOutput {
            status: Some(0),
            stdout: summary(0, 2),
            stderr: String::new(),
            error: None,
        }
    });
    assert_eq!(result["applicable"], json!(true));
    assert_eq!(
        result["checks"]["designMd"],
        json!({
            "status": "pass",
            "path": "DESIGN.md",
            "layout": {"ok": true},
            "lint": {
                "status": "pass",
                "command": "node_modules/@google/design.md/bin/cli.js lint --format json \
                            DESIGN.md",
                "errors": 0,
                "warnings": 2,
                "errorFindings": [],
            },
        })
    );
    assert_eq!(
        result["checks"]["dtcg"],
        json!({"status": "pass", "path": "design/tokens.json", "tokenCount": 1})
    );
    assert_eq!(
        result["checks"]["openui"],
        json!({
            "status": "pass",
            "path": "openui.json",
            "componentCount": 1,
            "problems": [],
        })
    );
    assert_eq!(
        result["checks"]["storybook"],
        json!({
            "status": "pass",
            "config": ".storybook/main.ts",
            "storyCount": 1,
            "sampleStories": ["src/Button.stories.tsx"],
            "note": "Per-component story coverage is checked at Step 4 and completed at Step 5.",
        })
    );
    assert_eq!(result["missing"], json!([]));
    assert_eq!(result["unverified"], json!([]));
}

#[test]
fn missing_design_and_tokens_are_reported_with_their_remediations() {
    let fixture = Fixture::new("missing");
    fixture.write("openui.json", r#"{"name":"Kit","version":"1","description":"c","components":{"B":{"description":"b","props":{}}}}"#);
    fixture.write(".storybook/main.ts", "export default {};\n");
    fixture.write("src/B.stories.ts", "export default {};\n");
    let result = fixture.preflight();
    assert_eq!(result["applicable"], json!(false));
    assert_eq!(
        result["checks"]["designMd"],
        json!({"status": "missing", "path": "DESIGN.md"})
    );
    assert_eq!(result["checks"]["dtcg"], json!({"status": "missing"}));
    let dtcg = result["missing"]
        .as_array()
        .expect("missing entries")
        .iter()
        .find(|entry| entry["id"] == json!("dtcg"))
        .expect("the dtcg entry");
    assert_eq!(dtcg["requirement"], json!("DTCG token file"));
    assert_eq!(
        dtcg["remediation"],
        json!(
            "Generate it from DESIGN.md with `npx --yes @google/design.md@0.4.0 export \
                --format dtcg DESIGN.md > design/tokens.json`, or add the project's existing \
                DTCG source."
        )
    );
    assert_eq!(dtcg["detail"], json!(""));
}

#[test]
fn an_unavailable_local_lint_is_unverified_not_missing() {
    let fixture = Fixture::new("offline-lint");
    fixture.complete_design();
    let result = fixture.preflight();
    assert_eq!(result["applicable"], json!(true));
    assert_eq!(result["missing"], json!([]));
    assert_eq!(result["checks"]["designMd"]["status"], json!("unverified"));
    assert_eq!(
        result["checks"]["designMd"]["lint"],
        json!({
            "status": "unverified",
            "command": LINT_DISPLAY,
            "error": LINT_NO_INSTALL,
        })
    );
    assert_eq!(
        result["unverified"],
        json!([{
            "id": "designMd",
            "requirement": "DESIGN.md lint",
            "detail": format!(
                "The lint could not run, so DESIGN.md was checked for structure only: \
                 {LINT_NO_INSTALL}"
            ),
            "command": LINT_DISPLAY,
        }])
    );
}

#[test]
fn lint_errors_make_design_md_invalid_and_cap_the_findings() {
    let fixture = Fixture::new("lint-invalid");
    fixture.complete_design();
    fixture.local_design_md();
    let findings = (1..=6)
        .map(|index| {
            json!({
                "severity": "error",
                "path": "DESIGN.md",
                "message": format!("error {index}"),
            })
        })
        .collect::<Vec<_>>();
    let result = fixture.with_lint(|_root, _bin, _args| LintOutput {
        status: Some(1),
        stdout: json!({"summary": {"errors": 6, "warnings": 1}, "findings": findings}).to_string(),
        stderr: String::new(),
        error: None,
    });
    let design = &result["checks"]["designMd"];
    assert_eq!(design["status"], json!("invalid"));
    assert_eq!(design["lint"]["status"], json!("invalid"));
    assert_eq!(design["lint"]["errors"], json!(6));
    let errors = design["lint"]["errorFindings"]
        .as_array()
        .expect("error findings");
    assert_eq!(errors.len(), 5);
    assert_eq!(errors[0], json!("DESIGN.md: error 1"));
    assert_eq!(errors[4], json!("DESIGN.md: error 5"));
    let missing = result["missing"]
        .as_array()
        .expect("missing entries")
        .iter()
        .find(|entry| entry["id"] == json!("designMd"))
        .expect("the designMd entry");
    assert_eq!(
        missing["detail"],
        json!(
            "Lint: DESIGN.md: error 1; DESIGN.md: error 2; DESIGN.md: error 3; DESIGN.md: \
                error 4; DESIGN.md: error 5"
        )
    );
}

#[test]
fn a_lint_that_cannot_produce_json_is_unverified() {
    let fixture = Fixture::new("lint-broken");
    fixture.complete_design();
    fixture.local_design_md();
    let crashed = fixture.with_lint(|_root, _bin, _args| LintOutput {
        status: Some(3),
        stdout: String::new(),
        stderr: "boom\n".to_string(),
        error: None,
    });
    assert_eq!(crashed["checks"]["designMd"]["status"], json!("unverified"));
    assert_eq!(
        crashed["checks"]["designMd"]["lint"]["error"],
        json!("boom")
    );
    assert_eq!(
        crashed["unverified"][0]["detail"],
        json!("The lint could not run, so DESIGN.md was checked for structure only: boom")
    );

    let silent = fixture.with_lint(|_root, _bin, _args| LintOutput {
        status: Some(0),
        stdout: "not json".to_string(),
        stderr: String::new(),
        error: None,
    });
    assert_eq!(
        silent["checks"]["designMd"]["lint"]["error"],
        json!("lint exited 0 without parseable JSON")
    );

    let killed = fixture.with_lint(|_root, _bin, _args| LintOutput::default());
    assert_eq!(
        killed["checks"]["designMd"]["lint"]["error"],
        json!("lint exited null")
    );
}

#[test]
fn a_json_number_a2ui_version_is_rejected_without_coercion() {
    let fixture = Fixture::new("a2ui-numeric-version");
    fixture.write(".design/a2ui/config.json", r#"{"version": 1.0}"#);
    let result = fixture.preflight();
    assert_eq!(result["checks"]["a2ui"]["status"], json!("invalid"));
    let reason = result["checks"]["a2ui"]["reason"]
        .as_str()
        .expect("a reason");
    assert!(reason.contains("1.0"), "reason: {reason}");
    assert!(!reason.contains("\"1\""), "reason: {reason}");
    assert_eq!(result["applicable"], json!(false));
    let ids = result["missing"]
        .as_array()
        .expect("missing entries")
        .iter()
        .map(|entry| entry["id"].as_str().expect("an id").to_string())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"a2ui".to_string()), "missing: {ids:?}");
}

#[test]
fn a_non_object_a2ui_config_is_rejected() {
    for (name, text) in [
        ("a2ui-scalar-config", r#""2.0""#),
        ("a2ui-array-config", "[]"),
    ] {
        let fixture = Fixture::new(name);
        fixture.write(".design/a2ui/config.json", text);
        let result = fixture.preflight();
        assert_eq!(
            result["checks"]["a2ui"]["status"],
            json!("invalid"),
            "{text}"
        );
        assert_eq!(result["applicable"], json!(false), "{text}");
    }
}

#[test]
fn an_a2ui_config_version_is_read_verbatim() {
    let fixture = Fixture::new("a2ui-config-string");
    fixture.write(".design/a2ui/config.json", r#"{"version":"v1.0"}"#);
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["a2ui"],
        json!({
            "status": "provided-by-skill",
            "version": "1.0",
            "note": "Step 3 writes A2UI JSONL plus a standalone wireframe.",
        })
    );
}

#[test]
fn an_unsupported_a2ui_version_disables_the_gate() {
    let fixture = Fixture::new("a2ui-invalid");
    fixture.write(".design/a2ui/config.json", r#"{"version":"2.0"}"#);
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["a2ui"],
        json!({"status": "invalid", "reason": "unsupported A2UI version \"2.0\""})
    );
    assert_eq!(result["applicable"], json!(false));
    let a2ui = result["missing"]
        .as_array()
        .expect("missing entries")
        .iter()
        .find(|entry| entry["id"] == json!("a2ui"))
        .expect("the a2ui entry");
    assert_eq!(
        *a2ui,
        json!({
            "id": "a2ui",
            "requirement": "supported A2UI version",
            "remediation": "Set .design/a2ui/config.json to {\"version\":\"0.9.1\"} or \
                            {\"version\":\"1.0\"}, or remove the pin.",
            "detail": "unsupported A2UI version \"2.0\"",
        })
    );
}

#[test]
fn an_a2ui_version_file_is_trimmed_and_unprefixed() {
    let fixture = Fixture::new("a2ui-version-file");
    fixture.write(".design/a2ui/version", "v1.0\n");
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["a2ui"],
        json!({
            "status": "provided-by-skill",
            "version": "1.0",
            "note": "Step 3 writes A2UI JSONL plus a standalone wireframe.",
        })
    );
}

#[test]
fn an_openui_yaml_catalog_is_checked() {
    let fixture = Fixture::new("openui-yaml");
    fixture.write(
        "openui.yaml",
        "name: Kit\nversion: \"1.0\"\ndescription: Components\ncomponents:\n  Button:\n    \
         description: A button\n    props: {}\n",
    );
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["openui"],
        json!({
            "status": "pass",
            "path": "openui.yaml",
            "componentCount": 1,
            "problems": [],
        })
    );
}

#[test]
fn openui_problems_match_the_catalog_schema() {
    let fixture = Fixture::new("openui-problems");
    fixture.write(
        "openui.json",
        r#"{"name":"","version":1,"description":"x","components":{"Button":{"props":[]},"Card":5}}"#,
    );
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["openui"],
        json!({
            "status": "invalid",
            "path": "openui.json",
            "componentCount": 2,
            "problems": [
                "name must be a non-empty string",
                "version must be a non-empty string",
                "Button.description must be a non-empty string",
                "Button.props must be an object",
                "Card must be an object",
            ],
        })
    );
    let missing = result["missing"]
        .as_array()
        .expect("missing entries")
        .iter()
        .find(|entry| entry["id"] == json!("openui"))
        .expect("the openui entry");
    assert_eq!(
        missing["detail"],
        json!(
            "openui.json: name must be a non-empty string; version must be a non-empty string; \
                Button.description must be a non-empty string; Button.props must be an object; \
                Card must be an object"
        )
    );

    let fixture = Fixture::new("openui-components");
    fixture.write(
        "openui.json",
        r#"{"name":"Kit","version":"1","description":"c","components":[]}"#,
    );
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["openui"],
        json!({
            "status": "invalid",
            "path": "openui.json",
            "problems": ["components must be an object"],
        })
    );
}

#[test]
fn ignored_directories_do_not_supply_tokens_or_stories() {
    let fixture = Fixture::new("ignored");
    fixture.write(
        "node_modules/dep/theme.tokens.json",
        r#"{"space":{"sm":{"$value":"4px"}}}"#,
    );
    fixture.write("dist/site.tokens.json", r#"{"a":{"$value":1}}"#);
    fixture.write("node_modules/dep/Thing.stories.ts", "export default {};\n");
    let result = fixture.preflight();
    assert_eq!(result["checks"]["dtcg"], json!({"status": "missing"}));
    assert_eq!(
        result["checks"]["storybook"],
        json!({"status": "missing", "config": null, "storyCount": 0})
    );
}

#[test]
fn gitignored_directories_supply_no_tokens_or_stories() {
    let fixture = Fixture::new("gitignored");
    fixture.write(".gitignore", "scratch/\npackages/*/generated/\n");
    fixture.write(
        "scratch/theme.tokens.json",
        r#"{"space":{"sm":{"$value":"4px"}}}"#,
    );
    fixture.write(
        "packages/ui/generated/kit.tokens.json",
        r#"{"a":{"$value":1}}"#,
    );
    fixture.write("scratch/.storybook/main.ts", "export default {};\n");
    fixture.write("scratch/Thing.stories.tsx", "export default {};\n");
    fixture.write(
        "packages/ui/generated/Kit.stories.ts",
        "export default {};\n",
    );
    let result = fixture.preflight();
    assert_eq!(result["checks"]["dtcg"], json!({"status": "missing"}));
    assert_eq!(
        result["checks"]["storybook"],
        json!({"status": "missing", "config": null, "storyCount": 0})
    );
    assert_eq!(result["applicable"], json!(false));
}

#[test]
fn a_negated_gitignore_rule_keeps_its_directory() {
    let fixture = Fixture::new("gitignore-negated");
    fixture.write(".gitignore", "generated/*\n!generated/keep/\n");
    fixture.write(
        "generated/keep/theme.tokens.json",
        r#"{"space":{"sm":{"$value":"4px"}}}"#,
    );
    fixture.write("generated/drop/other.tokens.json", r#"{"a":{"$value":1}}"#);
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["dtcg"],
        json!({
            "status": "pass",
            "path": "generated/keep/theme.tokens.json",
            "tokenCount": 1,
        })
    );
}

#[test]
fn token_files_are_found_by_glob_and_by_the_token_directory() {
    let fixture = Fixture::new("tokens-glob");
    fixture.write(
        "packages/theme/theme.tokens.json",
        r#"{"space":{"sm":{"$value":"4px"}}}"#,
    );
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["dtcg"],
        json!({
            "status": "pass",
            "path": "packages/theme/theme.tokens.json",
            "tokenCount": 1,
        })
    );

    let fixture = Fixture::new("tokens-directory");
    fixture.write(
        "design/tokens/colors.json",
        r##"{"color":{"primary":{"$value":"#fff"}}}"##,
    );
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["dtcg"],
        json!({
            "status": "pass",
            "path": "design/tokens/colors.json",
            "tokenCount": 1,
        })
    );
}

#[test]
fn a_invalid_token_file_is_reported_with_its_reason() {
    let fixture = Fixture::new("tokens-invalid");
    fixture.write("design/tokens.json", r##"{"color":{"primary":"#fff"}}"##);
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["dtcg"],
        json!({
            "status": "invalid",
            "path": "design/tokens.json",
            "reason": "no DTCG token with a $value found",
        })
    );
    let missing = result["missing"]
        .as_array()
        .expect("missing entries")
        .iter()
        .find(|entry| entry["id"] == json!("dtcg"))
        .expect("the dtcg entry");
    assert_eq!(
        missing["detail"],
        json!("design/tokens.json: no DTCG token with a $value found")
    );
}

#[test]
fn a_nested_storybook_config_is_found_through_the_glob() {
    let fixture = Fixture::new("nested-storybook");
    fixture.write("packages/ui/.storybook/main.mjs", "export default {};\n");
    fixture.write("packages/ui/src/Thing.stories.mts", "export default {};\n");
    let result = fixture.preflight();
    assert_eq!(
        result["checks"]["storybook"],
        json!({
            "status": "pass",
            "config": "packages/ui/.storybook/main.mjs",
            "storyCount": 1,
            "sampleStories": ["packages/ui/src/Thing.stories.mts"],
            "note": "Per-component story coverage is checked at Step 4 and completed at Step 5.",
        })
    );
}

#[test]
fn a_missing_directory_is_an_error_result() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp");
    std::fs::create_dir_all(&base).expect("the fixture base");
    let root = base
        .canonicalize()
        .expect("canonical fixture base")
        .join(format!("ui-preflight-{}-absent", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let result = preflight(&root);
    assert_eq!(
        result["error"],
        json!(format!("not a directory: {}", root.display()))
    );
    assert_eq!(result["applicable"], json!(false));
    assert_eq!(result["checks"], json!({}));
    assert_eq!(result["missing"], json!([]));
    assert_eq!(result["unverified"], json!([]));
}

#[test]
fn the_skill_ships_a_shell_wrapper_and_no_node_script() {
    let skill = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../omp/skills/devboard-ui-ux");
    let scripts = skill.join("scripts");
    let wrapper = std::fs::read_to_string(scripts.join("preflight.sh")).expect("the wrapper");
    assert!(wrapper.starts_with("#!/bin/sh"));
    assert!(wrapper.contains("preflight ui-ux"));
    assert!(wrapper.contains("DEVBOARD_BIN"));
    assert!(wrapper.contains(".devboard/bin/devboard"));
    for forbidden in ["node:", "from \"bun\"", "import("] {
        assert!(!wrapper.contains(forbidden), "wrapper contains {forbidden}");
    }
    assert!(!scripts.join("preflight.mjs").exists());
    let document = std::fs::read_to_string(skill.join("SKILL.md")).expect("the skill document");
    assert!(document.contains("scripts/preflight.sh"));
    assert!(!document.contains("preflight.mjs"));
}
