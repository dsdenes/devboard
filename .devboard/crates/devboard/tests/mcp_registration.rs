//! The shipped MCP registration and UI/UX preflight resolve a real harness
//! executable on a source checkout and on an installed host, and doctor fails
//! a managed registration that resolves none.
//!
//! Every probe assertion runs the bytes under `.devboard/omp/` against a
//! fixture under `.devboard/.test-tmp/` that is its own git checkout, with a
//! cleared environment so the developer's PATH cannot change what a fixture
//! proves.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

fn package_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn repo_root() -> PathBuf {
    fs::canonicalize(package_dir().join("..")).expect("the repo root")
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The registered `command` and `args` for `mcpServers.devboard`.
fn registration() -> (String, Vec<String>) {
    let text =
        fs::read_to_string(package_dir().join("omp/mcp.json")).expect("the shipped mcp.json");
    let config: serde_json::Value = serde_json::from_str(&text).expect("mcp.json is JSON");
    let server = &config["mcpServers"]["devboard"];
    let command = server["command"].as_str().expect("a command").to_string();
    let args = server["args"]
        .as_array()
        .expect("args")
        .iter()
        .map(|arg| arg.as_str().expect("a string argument").to_string())
        .collect();
    (command, args)
}

fn preflight_script() -> PathBuf {
    package_dir().join("omp/skills/devboard-ui-ux/scripts/preflight.sh")
}

/// Runs the shipped registration probe in `cwd` with a cleared environment and
/// the given extra variables, feeding `stdin`.
fn run_probe(cwd: &Path, environment: &[(&str, &str)], stdin: &[u8]) -> Output {
    let (command, args) = registration();
    let mut child = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .envs(environment.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the shipped probe starts");
    child
        .stdin
        .take()
        .expect("a stdin pipe")
        .write_all(stdin)
        .expect("the probe accepts its input");
    child.wait_with_output().expect("the probe finishes")
}

/// Runs the shipped preflight script in `cwd` with a cleared environment.
fn run_preflight(cwd: &Path, args: &[&str], environment: &[(&str, &str)]) -> Output {
    Command::new("sh")
        .arg(preflight_script())
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .envs(environment.iter().copied())
        .output()
        .expect("the shipped preflight runs")
}

const HANDSHAKE: &[u8] =
    b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n\
{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n";

/// The initialize and tools/list answers, when the probe served the protocol.
fn handshake(output: &Output) -> Option<(String, String, Vec<String>)> {
    let mut name = None;
    let mut version = None;
    let mut tools = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if message["result"]["serverInfo"]["name"].is_string() {
            name = message["result"]["serverInfo"]["name"]
                .as_str()
                .map(str::to_string);
            version = message["result"]["serverInfo"]["version"]
                .as_str()
                .map(str::to_string);
        }
        if let Some(list) = message["result"]["tools"].as_array() {
            tools = list
                .iter()
                .filter_map(|tool| tool["name"].as_str().map(str::to_string))
                .collect();
        }
    }
    Some((name?, version?, tools))
}

/// One git-checkout fixture under `.test-tmp/`.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let base = package_dir().join(".test-tmp");
        fs::create_dir_all(&base).expect("the fixture base");
        let root = fs::canonicalize(&base)
            .expect("a canonical fixture base")
            .join(format!("mcp-registration-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("the fixture root");
        let status = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "--quiet"])
            .status()
            .expect("git starts");
        assert!(status.success(), "the fixture is its own git checkout");
        Self { root }
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("the fixture parent");
        }
        fs::write(&path, contents).expect("the fixture file");
        path
    }

    /// An executable stub that prints its label and every argument.
    fn stub(&self, relative: &str, label: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = self.write(
            relative,
            &format!(
                "#!/bin/sh\nprintf '%s' '{label}'; for a in \"$@\"; do printf ' %s' \"$a\"; done; printf '\\n'\n"
            ),
        );
        let mut permissions = fs::metadata(&path).expect("the stub").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("an executable stub");
        path
    }

    fn mkdir(&self, relative: &str) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(&path).expect("the fixture directory");
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// The doctor environment a fixture proves itself against: only the tools a
/// probe needs, so no inherited forge address or PATH `devboard` decides.
fn clean_environment(fixture: &Fixture) -> HashMap<String, String> {
    let tools = fixture.mkdir("tools");
    fixture.stub("tools/omp", "omp");
    HashMap::from([(
        "PATH".to_string(),
        format!("{}:/usr/bin:/bin", tools.display()),
    )])
}

fn stub_stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

#[test]
fn the_real_registration_answers_initialize_and_tools_list_from_the_repo_root() {
    let root = repo_root();
    for cwd in [
        root.clone(),
        root.join(".devboard"),
        root.join(".devboard/crates"),
    ] {
        assert!(cwd.is_dir(), "{} is a directory", cwd.display());
        let output = run_probe(&cwd, &[], HANDSHAKE);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{} exited with {}: {}",
            cwd.display(),
            output.status,
            stderr_text(&output)
        );
        assert_eq!(
            stderr_text(&output),
            "",
            "{} wrote a diagnostic",
            cwd.display()
        );
        let (name, version, tools) =
            handshake(&output).unwrap_or_else(|| panic!("{} served the protocol", cwd.display()));
        assert_eq!(name, "devboard", "from {}", cwd.display());
        // A runner's cached `target` can hand the probe a harness built from
        // another checkout; the registration must resolve a working harness,
        // and its version must be a real release version, not necessarily the
        // exact source version this test binary carries.
        assert!(
            version.split('.').count() == 3
                && version.split('.').all(|part| part.parse::<u64>().is_ok()),
            "{} reported version {version}",
            cwd.display()
        );
        assert!(
            tools.iter().any(|tool| tool == "devboard_status"),
            "the full catalog from {}: {tools:?}",
            cwd.display()
        );
    }
}

#[test]
fn the_registration_arguments_carry_no_client_placeholder_syntax_the_client_would_expand() {
    // The client expands `${NAME}` and `${NAME:-default}` inside a registered
    // argument before it spawns the process. A shell construct of that form is
    // rewritten, not passed through: `b=${b:-$(command -v devboard)}` reached
    // the harness as `b=$(command -v devboard)` and emptied the resolved path,
    // which failed the server at spawn with no diagnostic. The probe therefore
    // uses plain `$NAME` variables only.
    let (command, args) = registration();
    assert_eq!(command, "sh");
    assert_eq!(args.first().map(String::as_str), Some("-c"));
    for argument in &args {
        assert!(
            !argument.contains("${"),
            "a registered argument carries a client placeholder: {argument}"
        );
    }
}

#[test]
fn a_harness_directory_prefers_bin_then_release_then_debug() {
    let fixture = Fixture::new("candidates");
    let bin = fixture.stub(".devboard/bin/devboard", "bin");
    let release = fixture.stub(".devboard/target/release/devboard", "release");
    let debug = fixture.stub(".devboard/target/debug/devboard", "debug");

    let output = run_probe(fixture.path(), &[], HANDSHAKE);
    assert_eq!(output.status.code(), Some(0), "{}", stderr_text(&output));
    assert_eq!(stub_stdout(&output), "bin mcp");

    fs::remove_file(&bin).expect("removing bin");
    let output = run_probe(fixture.path(), &[], HANDSHAKE);
    assert_eq!(stub_stdout(&output), "release mcp");

    fs::remove_file(&release).expect("removing release");
    let output = run_probe(fixture.path(), &[], HANDSHAKE);
    assert_eq!(stub_stdout(&output), "debug mcp");
    assert!(debug.is_file());
}

#[test]
fn devboard_harness_dir_wins_over_the_checkout() {
    let fixture = Fixture::new("harness-dir");
    fixture.stub(".devboard/target/debug/devboard", "checkout");
    let harness = fixture.mkdir("alt");
    fixture.stub("alt/bin/devboard", "env");
    let harness_text = harness.to_string_lossy().to_string();

    let output = run_probe(
        fixture.path(),
        &[("DEVBOARD_HARNESS_DIR", &harness_text)],
        HANDSHAKE,
    );
    assert_eq!(stub_stdout(&output), "env mcp", "{}", stderr_text(&output));
}

#[test]
fn devboard_bin_wins_over_a_harness_directory() {
    let fixture = Fixture::new("bin-env");
    fixture.stub(".devboard/bin/devboard", "checkout");
    fixture.stub("explicit/devboard", "explicit");
    let explicit = canonical(&fixture.path().join("explicit/devboard"));
    let explicit_text = explicit.to_string_lossy().to_string();

    let output = run_probe(
        fixture.path(),
        &[("DEVBOARD_BIN", &explicit_text)],
        HANDSHAKE,
    );
    assert_eq!(
        stub_stdout(&output),
        "explicit mcp",
        "{}",
        stderr_text(&output)
    );
}

#[test]
fn the_git_top_level_finds_the_checkout_from_a_nested_subdirectory() {
    let fixture = Fixture::new("nested");
    fixture.stub(".devboard/target/debug/devboard", "nested");
    let nested = fixture.mkdir("one/two");

    let output = run_probe(&nested, &[], HANDSHAKE);
    assert_eq!(
        stub_stdout(&output),
        "nested mcp",
        "{}",
        stderr_text(&output)
    );
}

#[test]
fn the_pi_coding_agent_prefix_resolves_before_path() {
    let fixture = Fixture::new("pi-prefix");
    fixture.stub("bin/devboard", "prefix");
    fixture.stub("pathbin/devboard", "path");
    let agent = fixture.mkdir("agent");
    let agent_text = agent.to_string_lossy().to_string();
    let path = format!("{}:/usr/bin:/bin", fixture.path().join("pathbin").display());

    let output = run_probe(
        fixture.path(),
        &[("PI_CODING_AGENT_DIR", &agent_text), ("PATH", &path)],
        HANDSHAKE,
    );
    assert_eq!(
        stub_stdout(&output),
        "prefix mcp",
        "{}",
        stderr_text(&output)
    );
}

#[test]
fn a_path_devboard_is_used_only_when_no_harness_directory_yields_a_candidate() {
    let fixture = Fixture::new("path");
    fixture.stub("pathbin/devboard", "path");
    let path = format!("{}:/usr/bin:/bin", fixture.path().join("pathbin").display());

    let output = run_probe(fixture.path(), &[("PATH", &path)], HANDSHAKE);
    assert_eq!(stub_stdout(&output), "path mcp", "{}", stderr_text(&output));

    // A harness directory beats PATH even when the PATH entry comes first.
    fixture.stub(".devboard/bin/devboard", "checkout");
    let output = run_probe(fixture.path(), &[("PATH", &path)], HANDSHAKE);
    assert_eq!(
        stub_stdout(&output),
        "checkout mcp",
        "{}",
        stderr_text(&output)
    );
}

#[test]
fn with_no_candidate_the_probe_names_the_build_tree_and_exits_127() {
    let fixture = Fixture::new("no-match");
    let output = run_probe(fixture.path(), &[], b"");

    assert_eq!(output.status.code(), Some(127));
    assert!(output.stdout.is_empty(), "the probe wrote no stdout");
    let stderr = stderr_text(&output);
    assert_eq!(
        stderr.lines().count(),
        1,
        "exactly one diagnostic line: {stderr:?}"
    );
    let line = stderr.trim_end();
    for expected in [
        ".devboard/target/debug",
        ".devboard/target/release",
        ".devboard/bin/devboard",
        "DEVBOARD_HARNESS_DIR",
        "cargo build",
    ] {
        assert!(line.contains(expected), "{expected} in {line:?}");
    }
}

#[test]
fn the_preflight_resolves_the_checkout_from_the_repo_root_and_its_project_argument() {
    let root = repo_root();
    let cases = [
        (root.clone(), ".".to_string()),
        (root.join(".devboard"), ".".to_string()),
        (root.clone(), root.to_string_lossy().to_string()),
    ];
    for (cwd, argument) in cases {
        let output = run_preflight(&cwd, &[argument.as_str()], &[]);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{} {argument}: {}",
            cwd.display(),
            stderr_text(&output)
        );
        assert_eq!(
            stderr_text(&output),
            "",
            "{} wrote a diagnostic",
            cwd.display()
        );
        let result: serde_json::Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{} printed JSON: {error}", cwd.display()));
        let expected = canonical(&cwd.join(&argument));
        assert_eq!(
            result["root"],
            serde_json::json!(expected.to_string_lossy()),
            "from {}",
            cwd.display()
        );
    }
}

#[test]
fn the_preflight_passes_the_project_argument_to_the_build_tree_stub() {
    let fixture = Fixture::new("preflight-tree");
    fixture.stub(".devboard/target/debug/devboard", "debug");

    let output = run_preflight(fixture.path(), &["sub"], &[]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr_text(&output));
    assert_eq!(stub_stdout(&output), "debug preflight ui-ux sub");
}

#[test]
fn devboard_bin_wins_over_a_path_devboard_in_the_preflight() {
    let fixture = Fixture::new("preflight-bin");
    fixture.stub("pathbin/devboard", "path");
    fixture.stub("explicit/devboard", "explicit");
    let explicit = canonical(&fixture.path().join("explicit/devboard"));
    let explicit_text = explicit.to_string_lossy().to_string();
    let path = format!("{}:/usr/bin:/bin", fixture.path().join("pathbin").display());

    let output = run_preflight(
        fixture.path(),
        &["."],
        &[("DEVBOARD_BIN", &explicit_text), ("PATH", &path)],
    );
    assert_eq!(output.status.code(), Some(0), "{}", stderr_text(&output));
    assert_eq!(stub_stdout(&output), "explicit preflight ui-ux .");
}

#[test]
fn with_nothing_resolvable_the_preflight_exits_127_with_one_line() {
    let fixture = Fixture::new("preflight-no-match");
    let output = run_preflight(fixture.path(), &["."], &[]);

    assert_eq!(output.status.code(), Some(127));
    assert!(output.stdout.is_empty(), "the probe wrote no stdout");
    let stderr = stderr_text(&output);
    assert_eq!(
        stderr.lines().count(),
        1,
        "exactly one diagnostic line: {stderr:?}"
    );
    let line = stderr.trim_end();
    for expected in [
        "DEVBOARD_BIN",
        ".devboard/bin/devboard",
        ".devboard/target/debug",
        "cargo build",
    ] {
        assert!(line.contains(expected), "{expected} in {line:?}");
    }
}

#[test]
fn doctor_fails_a_harness_host_whose_registration_resolves_nothing() {
    use devboard::cli_install;

    let fixture = Fixture::new("doctor-unresolvable");
    fixture.write(
        ".devboard/Cargo.toml",
        "[package]\nname = \"fixture-harness\"\nversion = \"0.1.0\"\n",
    );
    cli_install::install(Some(fixture.path()), false).expect("the fixture host installs");

    let report = cli_install::doctor_with_env(Some(fixture.path()), &clean_environment(&fixture))
        .expect("doctor runs");
    assert!(!report.ok(), "{:?}", report.drift);
    let failures = report.failures.join("\n");
    assert!(failures.contains(".omp/mcp.json"), "{failures}");
    assert!(failures.contains("DEVBOARD_HARNESS_DIR"), "{failures}");
    assert!(
        failures.contains(".devboard/target/debug"),
        "the probe's first stderr line: {failures}"
    );
}

#[test]
fn doctor_passes_a_host_that_carries_no_harness_of_its_own() {
    use devboard::cli_install;

    let fixture = Fixture::new("doctor-no-harness");
    cli_install::install(Some(fixture.path()), false).expect("the fixture host installs");
    assert!(
        fixture.path().join(".devboard/devboard.json").is_file(),
        "the installed payload records its version"
    );

    let report = cli_install::doctor_with_env(Some(fixture.path()), &clean_environment(&fixture))
        .expect("doctor runs");
    assert!(report.ok(), "{:?}", report.failures);
}
