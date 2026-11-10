//! The `devboard-ui-ux` skill preflight gate.
//!
//! This is a Rust port of `omp/skills/devboard-ui-ux/scripts/preflight.mjs`. It
//! keeps the script's check ids, requirement and remediation text, glob
//! patterns, ignored directories, applicability rule, and JSON shape: the same
//! project answers the same JSON, and the skill prints it with
//! `devboard preflight ui-ux [project-root]`.
//!
//! The glob walk prunes [`IGNORED_DIRS`] and every directory the scanned root's
//! own `.gitignore` excludes, read from that root alone so an enclosing
//! repository's rules never change the answer.
//!
//! The `design-md` lint runs through [`preflight_with`], so tests never spawn
//! the package. [`preflight`] runs the local bin directly; a project without an
//! install, or without a JavaScript runtime the bin's shebang can find, gets an
//! `unverified` entry instead of an error.

use std::path::{Component, Path, PathBuf};
use std::process::Command;

use regex::Regex;
use serde_json::{json, Map, Number, Value};

/// Directories the glob walk never enters, mirroring the script's ignore set.
/// The scanned root's own `.gitignore` adds prune rules on top of these names.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".worktree",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "coverage",
    ".turbo",
    ".cache",
    "vendor",
    "out",
    "target",
];

const DESIGN_MD_LINT_ARGS: &[&str] = &["lint", "--format", "json", "DESIGN.md"];
const DESIGN_MD_LINT_DISPLAY: &str = "node_modules/.bin/design-md lint --format json DESIGN.md";

const DTCG_CANDIDATES: &[&str] = &[
    "design/tokens.json",
    "tokens.json",
    "src/design/tokens.json",
    "src/styles/tokens.json",
    ".design/tokens.json",
];

const OPENUI_CANDIDATES: &[&str] = &[
    "openui.json",
    "openui.yaml",
    "design/openui.json",
    "design/openui.yaml",
];

const STORYBOOK_CANDIDATES: &[&str] = &[
    ".storybook/main.js",
    ".storybook/main.ts",
    ".storybook/main.mjs",
    ".storybook/main.cjs",
    ".storybook/main.mts",
    ".storybook/main.cts",
    "storybook/main.js",
    "storybook/main.ts",
];

/// What one `design-md lint` invocation returned, before any parsing.
#[derive(Debug, Clone, Default)]
pub struct LintOutput {
    /// The process exit code, or `None` when it was killed or never started.
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// A spawn failure, reported verbatim as the lint's error.
    pub error: Option<String>,
}

/// The preflight result for one project root.
///
/// Keys appear in the script's insertion order: `root`, `applicable`,
/// `checks`, `missing`, `unverified`, and `error` only for a non-directory.
pub fn preflight(root: &Path) -> Value {
    preflight_with(root, run_lint)
}

/// The preflight result, with the lint command replaced by `lint`.
pub fn preflight_with<F>(root: &Path, lint: F) -> Value
where
    F: Fn(&Path, &Path, &[&str]) -> LintOutput,
{
    let root = resolve(root);
    let mut report = Report::new(root.clone());
    if !root.is_dir() {
        return report.finish_error(format!("not a directory: {}", text(&root)));
    }
    let tree = Tree::scan(&root);
    design_md_check(&mut report, &root, &lint);
    dtcg_check(&mut report, &root, &tree);
    openui_check(&mut report, &root);
    storybook_check(&mut report, &root, &tree);
    a2ui_check(&mut report, &root);
    report.set_check("mcp", mcp_check());
    report.finish()
}

/// The default lint runner: execute the local package bin.
fn run_lint(root: &Path, bin: &Path, args: &[&str]) -> LintOutput {
    match Command::new(bin).args(args).current_dir(root).output() {
        Ok(output) => LintOutput {
            status: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            error: None,
        },
        Err(error) => LintOutput {
            status: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(error.to_string()),
        },
    }
}

struct Report {
    root: PathBuf,
    checks: Map<String, Value>,
    missing: Vec<Value>,
    unverified: Vec<Value>,
}

impl Report {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            checks: Map::new(),
            missing: Vec::new(),
            unverified: Vec::new(),
        }
    }

    fn set_check(&mut self, id: &str, check: Map<String, Value>) {
        self.checks.insert(id.to_string(), Value::Object(check));
    }

    fn add_missing(&mut self, id: &str, requirement: &str, remediation: &str, detail: &str) {
        self.missing.push(json!({
            "id": id,
            "requirement": requirement,
            "remediation": remediation,
            "detail": detail,
        }));
    }

    fn add_unverified(&mut self, id: &str, requirement: &str, detail: &str, command: &str) {
        self.unverified.push(json!({
            "id": id,
            "requirement": requirement,
            "detail": detail,
            "command": command,
        }));
    }

    fn assemble(&self, applicable: bool) -> Map<String, Value> {
        let mut object = Map::new();
        object.insert("root".into(), Value::String(text(&self.root)));
        object.insert("applicable".into(), Value::Bool(applicable));
        object.insert("checks".into(), Value::Object(self.checks.clone()));
        object.insert("missing".into(), Value::Array(self.missing.clone()));
        object.insert("unverified".into(), Value::Array(self.unverified.clone()));
        object
    }

    fn finish(self) -> Value {
        let applicable = self.missing.is_empty();
        Value::Object(self.assemble(applicable))
    }

    fn finish_error(self, error: String) -> Value {
        let mut object = self.assemble(false);
        object.insert("error".into(), Value::String(error));
        Value::Object(object)
    }
}

fn design_md_check<F>(report: &mut Report, root: &Path, lint: &F)
where
    F: Fn(&Path, &Path, &[&str]) -> LintOutput,
{
    let path = root.join("DESIGN.md");
    if !path.is_file() {
        let mut check = Map::new();
        check.insert("status".into(), json!("missing"));
        check.insert("path".into(), json!("DESIGN.md"));
        report.set_check("designMd", check);
        report.add_missing(
            "designMd",
            "DESIGN.md at the project root",
            "Create DESIGN.md in the DESIGN.md alpha format; include tokens and a ## Layout spacing \
             section; run `node_modules/.bin/design-md lint --format json DESIGN.md`.",
            "",
        );
        return;
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let layout = check_layout(&text);
    let lint = lint_report(root, lint);
    let mut details = Vec::new();
    if !layout.ok {
        details.push(format!(
            "Layout: {}",
            layout.reason.clone().unwrap_or_default()
        ));
    }
    if lint.status == "invalid" {
        let findings = lint.findings.as_deref().unwrap_or(&[]);
        let detail = if findings.is_empty() {
            lint.error
                .clone()
                .unwrap_or_else(|| "lint reported errors".to_string())
        } else {
            findings.join("; ")
        };
        details.push(format!("Lint: {detail}"));
    }
    let invalid = !layout.ok || lint.status == "invalid";
    let status = if invalid {
        "invalid"
    } else if lint.status == "unverified" {
        "unverified"
    } else {
        "pass"
    };
    let mut check = Map::new();
    check.insert("status".into(), json!(status));
    check.insert("path".into(), json!("DESIGN.md"));
    check.insert("layout".into(), layout.value());
    check.insert("lint".into(), lint.value());
    let command = lint.command.clone();
    let lint_error = lint.error.clone().unwrap_or_default();
    report.set_check("designMd", check);
    if invalid {
        report.add_missing(
            "designMd",
            "valid DESIGN.md with mandatory spacing conventions",
            "Fix the DESIGN.md findings; add a ## Layout section with base unit, scale, rhythm, \
             component padding, gaps, section spacing, container widths, and token mapping; rerun \
             `node_modules/.bin/design-md lint --format json DESIGN.md`.",
            &details.join(" "),
        );
    } else if lint.status == "unverified" {
        report.add_unverified(
            "designMd",
            "DESIGN.md lint",
            &format!(
                "The lint could not run, so DESIGN.md was checked for structure only: {lint_error}"
            ),
            &command,
        );
    }
}

#[derive(Default)]
struct Layout {
    ok: bool,
    reason: Option<String>,
}

impl Layout {
    fn value(&self) -> Value {
        let mut object = Map::new();
        object.insert("ok".into(), Value::Bool(self.ok));
        if let Some(reason) = &self.reason {
            object.insert("reason".into(), Value::String(reason.clone()));
        }
        Value::Object(object)
    }
}

fn check_layout(text: &str) -> Layout {
    let heading = Regex::new(r"(?im)^##\s+(Layout|Layout & Spacing)\s*$").expect("static regex");
    let Some(found) = heading.find(text) else {
        return Layout {
            ok: false,
            reason: Some("missing a ## Layout or ## Layout & Spacing section".into()),
        };
    };
    let after = &text[found.end()..];
    let next = Regex::new(r"(?m)^##\s+").expect("static regex");
    let section = match next.find(after) {
        Some(found) => &after[..found.start()],
        None => after,
    };
    let system =
        Regex::new(r"(?i)\b(base(?:\s+unit)?|scale|rhythm|grid|token)\b").expect("static regex");
    let measure = Regex::new(r"(?i)\b\d+(?:\.\d+)?\s*(?:px|rem|em)\b").expect("static regex");
    let convention = Regex::new(r"(?i)\b(padding|margin|gap|section|container|gutter|component)\b")
        .expect("static regex");
    let has_system = system.is_match(section);
    let has_measure = measure.is_match(section);
    let has_convention = convention.is_match(section);
    if (!has_system && !has_measure) || !has_convention {
        return Layout {
            ok: false,
            reason: Some(
                "Layout must state a spacing system (base unit/scale/rhythm/grid or a measure) and \
                 conventions for padding, gaps, sections, containers, or components"
                    .into(),
            ),
        };
    }
    Layout {
        ok: true,
        reason: None,
    }
}

struct LintReport {
    status: &'static str,
    command: String,
    error: Option<String>,
    errors: Option<Option<f64>>,
    warnings: Option<Option<f64>>,
    findings: Option<Vec<String>>,
}

impl LintReport {
    fn unverified(command: String, error: String) -> Self {
        Self {
            status: "unverified",
            command,
            error: Some(error),
            errors: None,
            warnings: None,
            findings: None,
        }
    }

    fn parsed(command: String, errors: Option<f64>, warnings: Option<f64>) -> Self {
        Self {
            status: if errors.is_some_and(|errors| errors > 0.0) {
                "invalid"
            } else {
                "pass"
            },
            command,
            error: None,
            errors: Some(errors),
            warnings: Some(warnings),
            findings: Some(Vec::new()),
        }
    }

    fn value(&self) -> Value {
        let mut object = Map::new();
        object.insert("status".into(), Value::String(self.status.into()));
        object.insert("command".into(), Value::String(self.command.clone()));
        if let Some(error) = &self.error {
            object.insert("error".into(), Value::String(error.clone()));
        }
        if let Some(errors) = self.errors {
            object.insert("errors".into(), number_value(errors));
        }
        if let Some(warnings) = self.warnings {
            object.insert("warnings".into(), number_value(warnings));
        }
        if let Some(findings) = &self.findings {
            object.insert(
                "errorFindings".into(),
                Value::Array(findings.iter().cloned().map(Value::String).collect()),
            );
        }
        Value::Object(object)
    }
}

fn lint_report<F>(root: &Path, lint: &F) -> LintReport
where
    F: Fn(&Path, &Path, &[&str]) -> LintOutput,
{
    let Some(bin) = resolve_design_md_bin(root) else {
        return LintReport::unverified(
            DESIGN_MD_LINT_DISPLAY.to_string(),
            "no local @google/design.md install; run `bun add -d @google/design.md@0.4.0` in the \
             project root so the lint runs without a registry fetch"
                .to_string(),
        );
    };
    let command = format!("{} {}", rel(root, &bin), DESIGN_MD_LINT_ARGS.join(" "));
    let output = lint(root, &bin, DESIGN_MD_LINT_ARGS);
    if let Some(error) = output.error {
        return LintReport::unverified(command, error);
    }
    let parsed = serde_json::from_str::<Value>(&output.stdout).ok();
    let summary = parsed
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|object| object.get("summary"))
        .filter(|summary| truthy(summary));
    if let Some(summary) = summary {
        let summary = summary.as_object().cloned().unwrap_or_default();
        let errors = number_or_zero(summary.get("errors"));
        let warnings = number_or_zero(summary.get("warnings"));
        let mut report = LintReport::parsed(command, errors, warnings);
        let findings = parsed
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|object| object.get("findings"))
            .and_then(Value::as_array)
            .map(|findings| {
                findings
                    .iter()
                    .filter(|finding| {
                        finding.get("severity").and_then(Value::as_str) == Some("error")
                    })
                    .take(5)
                    .map(|finding| {
                        let path = match finding.get("path") {
                            Some(Value::Null) | None => "?".to_string(),
                            Some(path) => js_string(path),
                        };
                        let message = match finding.get("message") {
                            None => "undefined".to_string(),
                            Some(message) => js_string(message),
                        };
                        format!("{path}: {message}")
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        report.findings = Some(findings);
        return report;
    }
    if output.status == Some(0) {
        return LintReport::unverified(command, "lint exited 0 without parseable JSON".into());
    }
    let stderr = output.stderr.trim();
    let stdout = output.stdout.trim();
    let error = if !stderr.is_empty() {
        stderr.to_string()
    } else if !stdout.is_empty() {
        stdout.to_string()
    } else {
        match output.status {
            Some(code) => format!("lint exited {code}"),
            None => "lint exited null".to_string(),
        }
    };
    LintReport::unverified(command, error)
}

fn resolve_design_md_bin(root: &Path) -> Option<PathBuf> {
    let package_dir = root.join("node_modules").join("@google").join("design.md");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(package_dir.join("package.json")).ok()?)
            .ok()?;
    let bin = manifest.get("bin")?;
    let entry = match bin {
        Value::String(entry) => entry.clone(),
        Value::Object(values) => match values.get("design.md") {
            Some(Value::String(entry)) => entry.clone(),
            Some(Value::Null) | None => values.values().next().and_then(Value::as_str)?.to_string(),
            Some(_) => return None,
        },
        _ => return None,
    };
    let path = package_dir.join(entry);
    path.is_file().then_some(path)
}

fn count_dtcg(value: &Value) -> u64 {
    match value {
        Value::Object(object) => {
            if object.contains_key("$value") {
                return 1;
            }
            object
                .iter()
                .filter(|(key, _)| !key.starts_with('$'))
                .map(|(_, value)| count_dtcg(value))
                .sum()
        }
        _ => 0,
    }
}

fn check_dtcg_file(path: &Path) -> Result<u64, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("invalid JSON: {error}"))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("invalid JSON: {error}"))?;
    let count = count_dtcg(&value);
    if count == 0 {
        return Err("no DTCG token with a $value found".to_string());
    }
    Ok(count)
}

fn dtcg_check(report: &mut Report, root: &Path, tree: &Tree) {
    let mut path = first_file(root, DTCG_CANDIDATES);
    if path.is_none() {
        path = tree
            .glob("**/*.tokens.json", false)
            .first()
            .map(|found| root.join(found));
    }
    if path.is_none() && root.join("design/tokens").is_dir() {
        path = tree
            .glob("design/tokens/**/*.json", false)
            .first()
            .map(|found| root.join(found));
    }
    let Some(path) = path else {
        let mut check = Map::new();
        check.insert("status".into(), json!("missing"));
        report.set_check("dtcg", check);
        report.add_missing(
            "dtcg",
            "DTCG token file",
            "Generate it from DESIGN.md with `npx --yes @google/design.md@0.4.0 export --format \
             dtcg DESIGN.md > design/tokens.json`, or add the project's existing DTCG source.",
            "",
        );
        return;
    };
    let relative = rel(root, &path);
    match check_dtcg_file(&path) {
        Ok(count) => {
            let mut check = Map::new();
            check.insert("status".into(), json!("pass"));
            check.insert("path".into(), Value::String(relative));
            check.insert("tokenCount".into(), json!(count));
            report.set_check("dtcg", check);
        }
        Err(reason) => {
            let mut check = Map::new();
            check.insert("status".into(), json!("invalid"));
            check.insert("path".into(), Value::String(relative.clone()));
            check.insert("reason".into(), Value::String(reason.clone()));
            report.set_check("dtcg", check);
            report.add_missing(
                "dtcg",
                "valid DTCG token file",
                "Regenerate design/tokens.json from DESIGN.md or fix the DTCG structure \
                 ($value/$type).",
                &format!("{relative}: {reason}"),
            );
        }
    }
}

struct OpenUiCheck {
    component_count: Option<u64>,
    problems: Vec<String>,
}

fn check_openui(value: &Value) -> OpenUiCheck {
    let Some(object) = value.as_object() else {
        return OpenUiCheck {
            component_count: None,
            problems: vec!["root must be an object".to_string()],
        };
    };
    let mut problems = Vec::new();
    for key in ["name", "version", "description"] {
        let present = object
            .get(key)
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if !present {
            problems.push(format!("{key} must be a non-empty string"));
        }
    }
    let Some(components) = object.get("components").and_then(Value::as_object) else {
        problems.push("components must be an object".to_string());
        return OpenUiCheck {
            component_count: None,
            problems,
        };
    };
    if components.is_empty() {
        problems.push("components must not be empty".to_string());
    }
    for (name, component) in components {
        let Some(component) = component.as_object() else {
            problems.push(format!("{name} must be an object"));
            continue;
        };
        let described = component
            .get("description")
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if !described {
            problems.push(format!("{name}.description must be a non-empty string"));
        }
        if !matches!(component.get("props"), Some(Value::Object(_))) {
            problems.push(format!("{name}.props must be an object"));
        }
    }
    OpenUiCheck {
        component_count: Some(components.len() as u64),
        problems,
    }
}

fn openui_check(report: &mut Report, root: &Path) {
    let Some(path) = first_file(root, OPENUI_CANDIDATES) else {
        let mut check = Map::new();
        check.insert("status".into(), json!("missing"));
        report.set_check("openui", check);
        report.add_missing(
            "openui",
            "OpenUI component catalog at the project root",
            "Add openui.json or openui.yaml following openuispec.org draft-01, with name, version, \
             description, and components.",
            "",
        );
        return;
    };
    let relative = rel(root, &path);
    let parsed = if relative.ends_with(".json") {
        std::fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())
            })
    } else {
        std::fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|text| parse_yaml(&text))
    };
    match parsed {
        Err(reason) => {
            let mut check = Map::new();
            check.insert("status".into(), json!("invalid"));
            check.insert("path".into(), Value::String(relative.clone()));
            check.insert("reason".into(), Value::String(reason.clone()));
            report.set_check("openui", check);
            report.add_missing(
                "openui",
                "valid OpenUI component catalog",
                "Fix the OpenUI file so it parses and follows the draft-01 component schema.",
                &format!("{relative}: {reason}"),
            );
        }
        Ok(value) => {
            let checked = check_openui(&value);
            let mut check = Map::new();
            let status = if checked.problems.is_empty() {
                "pass"
            } else {
                "invalid"
            };
            check.insert("status".into(), json!(status));
            check.insert("path".into(), Value::String(relative.clone()));
            if let Some(count) = checked.component_count {
                check.insert("componentCount".into(), json!(count));
            }
            check.insert(
                "problems".into(),
                Value::Array(
                    checked
                        .problems
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
            report.set_check("openui", check);
            if !checked.problems.is_empty() {
                report.add_missing(
                    "openui",
                    "valid OpenUI component catalog",
                    "Fix the OpenUI catalog: require name, version, description, and a non-empty \
                     components map; each component needs description and props.",
                    &format!("{relative}: {}", checked.problems.join("; ")),
                );
            }
        }
    }
}

fn storybook_check(report: &mut Report, root: &Path, tree: &Tree) {
    let mut config = first_file(root, STORYBOOK_CANDIDATES);
    if config.is_none() {
        config = tree
            .glob("**/.storybook/main.*", true)
            .first()
            .map(|found| root.join(found));
    }
    if config.is_none() {
        config = tree
            .glob("**/storybook/main.*", true)
            .first()
            .map(|found| root.join(found));
    }
    let stories = tree
        .glob("**/*.stories.*", false)
        .into_iter()
        .filter(|path| story_file(path))
        .collect::<Vec<_>>();
    let Some(config) = config else {
        let mut check = Map::new();
        check.insert("status".into(), json!("missing"));
        check.insert("config".into(), Value::Null);
        check.insert("storyCount".into(), json!(stories.len()));
        report.set_check("storybook", check);
        report.add_missing(
            "storybook",
            "Storybook config and at least one CSF story",
            "Add .storybook/main.* and at least one *.stories.* CSF file. The page's in-scope \
             components need stories in Step 5.",
            "",
        );
        return;
    };
    if stories.is_empty() {
        let mut check = Map::new();
        check.insert("status".into(), json!("missing"));
        check.insert("config".into(), Value::String(rel(root, &config)));
        check.insert("storyCount".into(), json!(0));
        report.set_check("storybook", check);
        report.add_missing(
            "storybook",
            "Storybook config and at least one CSF story",
            "Add .storybook/main.* and at least one *.stories.* CSF file. The page's in-scope \
             components need stories in Step 5.",
            "",
        );
        return;
    }
    let mut check = Map::new();
    check.insert("status".into(), json!("pass"));
    check.insert("config".into(), Value::String(rel(root, &config)));
    check.insert("storyCount".into(), json!(stories.len()));
    check.insert(
        "sampleStories".into(),
        Value::Array(stories.iter().take(5).cloned().map(Value::String).collect()),
    );
    check.insert(
        "note".into(),
        json!("Per-component story coverage is checked at Step 4 and completed at Step 5."),
    );
    report.set_check("storybook", check);
}

fn story_file(path: &str) -> bool {
    Regex::new(r"\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$")
        .expect("static regex")
        .is_match(path)
}

fn a2ui_check(report: &mut Report, root: &Path) {
    let config_path = root.join(".design/a2ui/config.json");
    let version_path = root.join(".design/a2ui/version");
    let mut raw = "0.9.1".to_string();
    if config_path.is_file() {
        let parsed = std::fs::read_to_string(&config_path)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())
            });
        match parsed {
            Err(error) => {
                let reason = format!("invalid .design/a2ui/config.json: {error}");
                a2ui_invalid(report, reason);
                return;
            }
            Ok(Value::Object(object)) => {
                if let Some(version) = object.get("version").filter(|version| !version.is_null()) {
                    match version.as_str() {
                        Some(text) => raw = text.to_string(),
                        None => {
                            a2ui_invalid(
                                report,
                                format!(
                                    "A2UI version in .design/a2ui/config.json must be a JSON \
                                     string, found {version}"
                                ),
                            );
                            return;
                        }
                    }
                }
            }
            Ok(other) => {
                a2ui_invalid(
                    report,
                    format!(
                        "invalid .design/a2ui/config.json: expected a JSON object, found {other}"
                    ),
                );
                return;
            }
        }
    } else if version_path.is_file() {
        raw = std::fs::read_to_string(&version_path)
            .unwrap_or_default()
            .trim()
            .to_string();
    }
    let version = match raw.strip_prefix('v').or_else(|| raw.strip_prefix('V')) {
        Some(stripped) => stripped,
        None => raw.as_str(),
    };
    if version != "0.9.1" && version != "1.0" {
        a2ui_invalid(report, format!("unsupported A2UI version \"{raw}\""));
        return;
    }
    let mut check = Map::new();
    check.insert("status".into(), json!("provided-by-skill"));
    check.insert("version".into(), Value::String(version.to_string()));
    check.insert(
        "note".into(),
        json!("Step 3 writes A2UI JSONL plus a standalone wireframe."),
    );
    report.set_check("a2ui", check);
}

fn a2ui_invalid(report: &mut Report, reason: String) {
    let mut check = Map::new();
    check.insert("status".into(), json!("invalid"));
    check.insert("reason".into(), Value::String(reason.clone()));
    report.set_check("a2ui", check);
    report.add_missing(
        "a2ui",
        "supported A2UI version",
        "Set .design/a2ui/config.json to {\"version\":\"0.9.1\"} or {\"version\":\"1.0\"}, or \
         remove the pin.",
        &reason,
    );
}

fn mcp_check() -> Map<String, Value> {
    let mut check = Map::new();
    check.insert("status".into(), json!("check-at-mutation"));
    check.insert(
        "requiredTools".into(),
        json!([
            "mcp__designmd_search_design_kits",
            "mcp__designmd_get_design_kit"
        ]),
    );
    check.insert(
        "note".into(),
        json!(
            "Not checked here. Verify before any design-system mutation; no research means no \
             mutation."
        ),
    );
    check
}

fn first_file(root: &Path, candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|candidate| root.join(candidate))
        .find(|path| path.is_file())
}

fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => path.to_path_buf(),
        }
    };
    normalize(&absolute)
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !path.is_absolute() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn rel(root: &Path, path: &Path) -> String {
    let root_text = text(root);
    let target = text(path);
    let prefix = format!("{root_text}/");
    match target.strip_prefix(prefix.as_str()) {
        Some(stripped) => stripped.to_string(),
        None => target,
    }
}

/// Directory prune rules resolved from the scanned root's own `.gitignore`.
///
/// Only `<root>/.gitignore` is read: rules of an enclosing repository never
/// prune this project's tree. Rules apply to a directory's root-relative path
/// in file order and the last match decides, so a later `!` rule re-includes
/// what an earlier one excluded.
struct IgnoreRules {
    rules: Vec<IgnoreRule>,
}

struct IgnoreRule {
    /// The pattern's path components, leading and trailing `/` removed.
    parts: Vec<String>,
    /// A pattern with an internal or leading `/` matches the whole root-relative
    /// path; one without matches a directory name at any depth.
    anchored: bool,
    negated: bool,
}

impl IgnoreRules {
    fn read(root: &Path) -> Self {
        let text = std::fs::read_to_string(root.join(".gitignore")).unwrap_or_default();
        Self {
            rules: text.lines().filter_map(ignore_rule).collect(),
        }
    }

    /// Whether the directory at the root-relative `parts` path is ignored.
    fn ignores(&self, parts: &[String]) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.matches(parts) {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

impl IgnoreRule {
    fn matches(&self, parts: &[String]) -> bool {
        if !self.anchored {
            return parts
                .last()
                .is_some_and(|name| component_match(&self.parts[0], name, true));
        }
        let pattern = self.parts.iter().map(String::as_str).collect::<Vec<_>>();
        glob_match(&pattern, parts, true)
    }
}

/// One `.gitignore` line as a directory rule: blank lines and comments drop, a
/// `!` prefix negates, and a trailing `/` narrows the rule to a directory.
fn ignore_rule(line: &str) -> Option<IgnoreRule> {
    let line = line.trim_end();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (negated, pattern) = match line.strip_prefix('!') {
        Some(rest) => (true, rest),
        None => (false, line),
    };
    let pattern = pattern.strip_suffix('/').unwrap_or(pattern);
    // Git anchors a pattern that holds a `/` anywhere but the removed trailing
    // one; the leading `/` is then redundant.
    let anchored = pattern.contains('/');
    let pattern = pattern.strip_prefix('/').unwrap_or(pattern);
    let parts = pattern
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return None;
    }
    Some(IgnoreRule {
        parts,
        anchored,
        negated,
    })
}

/// Every file under one root, as relative component lists.
struct Tree {
    files: Vec<Vec<String>>,
}

impl Tree {
    fn scan(root: &Path) -> Self {
        let ignore = IgnoreRules::read(root);
        let mut files = Vec::new();
        walk(root, &mut Vec::new(), &mut files, &ignore);
        Self { files }
    }

    fn glob(&self, pattern: &str, dot: bool) -> Vec<String> {
        let parts = pattern.split('/').collect::<Vec<_>>();
        let mut matches = self
            .files
            .iter()
            .filter(|file| glob_match(&parts, file, dot))
            .map(|file| file.join("/"))
            .collect::<Vec<_>>();
        matches.sort();
        matches
    }
}

fn walk(
    directory: &Path,
    prefix: &mut Vec<String>,
    files: &mut Vec<Vec<String>>,
    ignore: &IgnoreRules,
) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if is_dir {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            prefix.push(name);
            if !ignore.ignores(prefix) {
                walk(&path, prefix, files, ignore);
            }
            prefix.pop();
        } else if path.is_file() {
            let mut file = prefix.clone();
            file.push(name);
            files.push(file);
        }
    }
}

fn glob_match(pattern: &[&str], parts: &[String], dot: bool) -> bool {
    match pattern.split_first() {
        None => parts.is_empty(),
        Some((&"**", rest)) => {
            if glob_match(rest, parts, dot) {
                return true;
            }
            match parts.split_first() {
                Some((first, tail)) if dot || !first.starts_with('.') => {
                    glob_match(pattern, tail, dot)
                }
                _ => false,
            }
        }
        Some((head, rest)) => match parts.split_first() {
            Some((first, tail)) => component_match(head, first, dot) && glob_match(rest, tail, dot),
            None => false,
        },
    }
}

fn component_match(pattern: &str, name: &str, dot: bool) -> bool {
    if !dot && name.starts_with('.') && (pattern.contains('*') || pattern.contains('?')) {
        return false;
    }
    wildcard(pattern.as_bytes(), name.as_bytes())
}

fn wildcard(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut star_text = 0usize;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            star_text = t;
            p += 1;
        } else if let Some(start) = star {
            p = start + 1;
            star_text += 1;
            t = star_text;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_display(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn number_display(number: &Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    let value = number.as_f64().unwrap_or(0.0);
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

/// `Number(value)`: `None` is JavaScript `NaN`.
fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            match trimmed {
                "Infinity" | "+Infinity" => Some(f64::INFINITY),
                "-Infinity" => Some(f64::NEG_INFINITY),
                _ => trimmed.parse::<f64>().ok(),
            }
        }
        Value::Array(items) => match items.len() {
            0 => Some(0.0),
            1 => js_number(&items[0]),
            _ => None,
        },
        Value::Object(_) => None,
    }
}

fn number_or_zero(value: Option<&Value>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => Some(0.0),
        Some(value) => js_number(value),
    }
}

fn number_value(value: Option<f64>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::Number(Number::from(value as i64));
    }
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// A YAML subset reader for the OpenUI catalog shape.
///
/// The original script used `Bun.YAML.parse`. The harness carries no YAML
/// dependency, so this reader covers block mappings and sequences (a sequence
/// may sit at its key's own indent), plain, quoted, and block scalars, flow
/// `[]`/`{}` empties, and the YAML 1.2 core scalars. Anchors, aliases, tags,
/// merge keys, and non-empty flow collections are not supported.
struct YamlLine {
    indent: usize,
    content: String,
}

fn yaml_lines(text: &str) -> Vec<YamlLine> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        let trimmed_end = raw.trim_end();
        if trimmed_end.trim().is_empty() || trimmed_end.trim_start().starts_with('#') {
            continue;
        }
        let indent = trimmed_end.len() - trimmed_end.trim_start().len();
        lines.push(YamlLine {
            indent,
            content: trimmed_end.trim_start().to_string(),
        });
    }
    lines
}

fn split_key(content: &str) -> Option<(String, String)> {
    let index = content.find(':')?;
    let key = content[..index].trim();
    let rest = &content[index + 1..];
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    if !(rest.is_empty() || rest.starts_with(' ')) {
        return None;
    }
    Some((key.to_string(), rest.trim().to_string()))
}

fn yaml_sequence_entry(content: &str) -> bool {
    content == "-" || content.starts_with("- ")
}

fn parse_yaml(text: &str) -> Result<Value, String> {
    let lines = yaml_lines(text);
    let Some(first) = lines.first() else {
        return Ok(Value::Null);
    };
    let indent = first.indent;
    let mut index = 0;
    let value = parse_yaml_value(&lines, &mut index, indent)?;
    if let Some(line) = lines.get(index) {
        return Err(format!("unexpected YAML content: {}", line.content));
    }
    Ok(value)
}

fn parse_yaml_value(lines: &[YamlLine], index: &mut usize, indent: usize) -> Result<Value, String> {
    let sequence = lines
        .get(*index)
        .map(|line| yaml_sequence_entry(&line.content))
        .unwrap_or(false);
    if sequence {
        parse_yaml_sequence(lines, index, indent)
    } else {
        parse_yaml_mapping(lines, index, indent)
    }
}

fn parse_yaml_mapping(
    lines: &[YamlLine],
    index: &mut usize,
    indent: usize,
) -> Result<Value, String> {
    let mut out = Map::new();
    while *index < lines.len() {
        let line = &lines[*index];
        if line.indent < indent {
            break;
        }
        if line.indent > indent {
            return Err(format!("unexpected indentation: {}", line.content));
        }
        if yaml_sequence_entry(&line.content) {
            break;
        }
        let Some((key, raw)) = split_key(&line.content) else {
            return Err(format!("invalid YAML line: {}", line.content));
        };
        *index += 1;
        let value = if raw.is_empty() {
            yaml_mapping_value_or_null(lines, index, indent)?
        } else if is_block_scalar(&raw) {
            yaml_block_scalar(lines, index, indent, &raw)?
        } else {
            yaml_scalar(&raw)?
        };
        out.insert(key, value);
    }
    Ok(Value::Object(out))
}

fn parse_yaml_sequence(
    lines: &[YamlLine],
    index: &mut usize,
    indent: usize,
) -> Result<Value, String> {
    let mut out = Vec::new();
    while *index < lines.len() {
        let line = &lines[*index];
        if line.indent < indent {
            break;
        }
        if line.indent > indent {
            return Err(format!("unexpected indentation: {}", line.content));
        }
        if !yaml_sequence_entry(&line.content) {
            break;
        }
        let rest = if line.content == "-" {
            String::new()
        } else {
            line.content[2..].trim().to_string()
        };
        *index += 1;
        if rest.is_empty() {
            out.push(yaml_nested_or_null(lines, index, indent)?);
            continue;
        }
        let quoted = rest.starts_with('"') || rest.starts_with('\'');
        let split = if quoted { None } else { split_key(&rest) };
        let Some((key, raw)) = split else {
            out.push(yaml_scalar(&rest)?);
            continue;
        };
        let mut object = Map::new();
        let value = if raw.is_empty() {
            yaml_nested_or_null(lines, index, indent)?
        } else if is_block_scalar(&raw) {
            yaml_block_scalar(lines, index, indent, &raw)?
        } else {
            yaml_scalar(&raw)?
        };
        object.insert(key, value);
        let field_indent = lines
            .get(*index)
            .filter(|next| next.indent > indent && !yaml_sequence_entry(&next.content))
            .map(|next| next.indent);
        if let Some(field_indent) = field_indent {
            if let Value::Object(fields) = parse_yaml_mapping(lines, index, field_indent)? {
                for (field, value) in fields {
                    object.insert(field, value);
                }
            }
        }
        out.push(Value::Object(object));
    }
    Ok(Value::Array(out))
}

/// A mapping key's value: a deeper-indented node, a block sequence written at
/// the key's own indent (the zero-indented list style, valid YAML), or null.
fn yaml_mapping_value_or_null(
    lines: &[YamlLine],
    index: &mut usize,
    indent: usize,
) -> Result<Value, String> {
    match lines.get(*index) {
        Some(next) if next.indent == indent && yaml_sequence_entry(&next.content) => {
            parse_yaml_sequence(lines, index, indent)
        }
        _ => yaml_nested_or_null(lines, index, indent),
    }
}

fn yaml_nested_or_null(
    lines: &[YamlLine],
    index: &mut usize,
    indent: usize,
) -> Result<Value, String> {
    match lines.get(*index) {
        Some(next) if next.indent > indent => {
            let nested = next.indent;
            parse_yaml_value(lines, index, nested)
        }
        _ => Ok(Value::Null),
    }
}

fn is_block_scalar(raw: &str) -> bool {
    matches!(raw, "|" | "|-" | "|+" | ">" | ">-" | ">+")
}

fn yaml_block_scalar(
    lines: &[YamlLine],
    index: &mut usize,
    indent: usize,
    indicator: &str,
) -> Result<Value, String> {
    let folded = indicator.starts_with('>');
    let chomp = indicator.contains('-');
    let mut collected = Vec::new();
    let mut block_indent = None;
    while *index < lines.len() && lines[*index].indent > indent {
        let line = &lines[*index];
        let start = *block_indent.get_or_insert(line.indent);
        if line.indent < start {
            break;
        }
        collected.push(format!(
            "{}{}",
            " ".repeat(line.indent - start),
            line.content
        ));
        *index += 1;
    }
    let mut joined = if folded {
        collected.join(" ")
    } else {
        collected.join("\n")
    };
    if !chomp && !joined.is_empty() {
        joined.push('\n');
    }
    Ok(Value::String(joined))
}

fn yaml_scalar(raw: &str) -> Result<Value, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(Value::Null);
    }
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        return serde_json::from_str::<String>(text)
            .map(Value::String)
            .map_err(|error| format!("invalid YAML string: {error}"));
    }
    if text.len() >= 2 && text.starts_with('\'') && text.ends_with('\'') {
        return Ok(Value::String(text[1..text.len() - 1].replace("''", "'")));
    }
    match text {
        "null" | "Null" | "NULL" | "~" => return Ok(Value::Null),
        "[]" => return Ok(Value::Array(Vec::new())),
        "{}" => return Ok(Value::Object(Map::new())),
        "true" | "True" | "TRUE" => return Ok(Value::Bool(true)),
        "false" | "False" | "FALSE" => return Ok(Value::Bool(false)),
        _ => {}
    }
    if let Some(number) = yaml_number(text) {
        return Ok(Value::Number(number));
    }
    Ok(Value::String(text.to_string()))
}

fn yaml_number(text: &str) -> Option<Number> {
    if let Ok(value) = text.parse::<i64>() {
        return Some(Number::from(value));
    }
    if let Ok(value) = text.parse::<u64>() {
        return Some(Number::from(value));
    }
    if let Ok(value) = text.parse::<f64>() {
        return Number::from_f64(value);
    }
    None
}
