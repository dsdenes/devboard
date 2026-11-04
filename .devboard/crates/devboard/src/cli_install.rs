//! Installing the harness agent wrappers into a host, and checking the copies.
//!
//! The package ships its wrappers as `.devboard/omp/` and its root-document
//! template as `.devboard/templates/host-AGENTS.md`. Both are embedded in the
//! binary, so an install never has to find the package on disk. The rules
//! mirror `install.sh` (the copy, the refusal, the ownership of
//! `skills/devboard-*`) and `syncAgents`/`ensureGitignore` in
//! `bin/devboard.mjs` (the `AGENTS.md` drift rule and the idempotent
//! `.gitignore` append).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use anyhow::{anyhow, bail, Context, Result};
use include_dir::{include_dir, Dir, DirEntry};

/// The package tree a host install copies into `<host>/.omp/`.
static OMP: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../omp");

/// The root-document template `syncAgents` copies to `<host>/AGENTS.md`.
static HOST_AGENTS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../templates/host-AGENTS.md"
));

/// The name prefix that marks a skill directory as package-owned. The package
/// always wins a marked name; every unmarked skill belongs to the host and is
/// never read, rewritten, or deleted.
pub const MANAGED_SKILL_PREFIX: &str = "devboard-";

/// How `AGENTS.md` came out of an install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentsOutcome {
    /// The file was absent, or was a symlink, and now holds the template.
    Installed,
    /// The file already held the template byte for byte.
    Current,
    /// The file holds host content; it was left exactly as it was.
    Drift,
    /// Something that is not a regular file sits at `<host>/AGENTS.md`.
    Skipped,
}

impl AgentsOutcome {
    /// The word an install prints for this outcome.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentsOutcome::Installed => "installed",
            AgentsOutcome::Current => "current",
            AgentsOutcome::Drift => "drift",
            AgentsOutcome::Skipped => "unchanged",
        }
    }
}

/// What one install did.
#[derive(Debug)]
pub struct InstallReport {
    /// The canonical host root the install wrote into.
    pub host: PathBuf,
    /// `<host>/.omp`, the tree the install owns.
    pub omp_dir: PathBuf,
    /// Files written under `.omp/`; unchanged files do not count.
    pub installed_files: usize,
    /// The shipped `devboard-*` skill names, sorted.
    pub skills: Vec<String>,
    /// What happened to `<host>/AGENTS.md`.
    pub agents: AgentsOutcome,
    /// The `.gitignore` entries this run appended.
    pub gitignore_added: Vec<String>,
}

/// What one doctor run found.
#[derive(Debug)]
pub struct DoctorReport {
    /// The canonical host root the checks ran against.
    pub host: PathBuf,
    /// The shipped `devboard-*` skill names, sorted.
    pub skills: Vec<String>,
    /// Missing, differing, or extra managed files. Any entry fails the check.
    pub failures: Vec<String>,
    /// Host content that differs from the template but is not a failure.
    pub drift: Vec<String>,
}

impl DoctorReport {
    /// True when no managed file is missing, differs, or is unexpected.
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }
}

/// One shipped skill directory and the files inside it.
struct ShippedSkill {
    name: String,
    files: Vec<(String, &'static [u8])>,
}

/// Everything the embedded package installs.
struct Package {
    /// Regular `.omp/` files: paths relative to `.omp/`, sorted.
    files: Vec<(String, &'static [u8])>,
    skills: Vec<ShippedSkill>,
    names: Vec<String>,
}

fn package() -> &'static Package {
    static PACKAGE: LazyLock<Package> = LazyLock::new(build_package);
    &PACKAGE
}

/// The shipped `devboard-*` skill names, sorted, for CLI help and listings.
pub fn managed_skill_names() -> &'static [String] {
    &package().names
}

fn build_package() -> Package {
    let mut all = Vec::new();
    collect_files(&OMP, &mut all);
    let mut files = Vec::new();
    let mut skills: BTreeMap<String, Vec<(String, &'static [u8])>> = BTreeMap::new();
    for (relative, contents) in all {
        if let Some(rest) = relative.strip_prefix("skills/") {
            if let Some((name, inside)) = rest.split_once('/') {
                if name.starts_with(MANAGED_SKILL_PREFIX) && !inside.is_empty() {
                    skills
                        .entry(name.to_string())
                        .or_default()
                        .push((inside.to_string(), contents));
                    continue;
                }
            }
        }
        files.push((relative, contents));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let skills: Vec<ShippedSkill> = skills
        .into_iter()
        .map(|(name, mut files)| {
            files.sort_by(|left, right| left.0.cmp(&right.0));
            ShippedSkill { name, files }
        })
        .collect();
    let names = skills.iter().map(|skill| skill.name.clone()).collect();
    Package {
        files,
        skills,
        names,
    }
}

fn collect_files(dir: &Dir<'static>, out: &mut Vec<(String, &'static [u8])>) {
    for entry in dir.entries() {
        match entry {
            DirEntry::Dir(child) => collect_files(child, out),
            DirEntry::File(file) => out.push((relative_path(file.path()), file.contents())),
        }
    }
}

/// A path as `/`-joined components, independent of the host platform.
fn relative_path(path: &Path) -> String {
    let mut out = String::new();
    for component in path.components() {
        if let Component::Normal(part) = component {
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(&part.to_string_lossy());
        }
    }
    out
}

/// Resolve the host root: the argument when given, else the git work tree of
/// the working directory. Fails exactly where `install.sh` fails.
pub fn resolve_host(argument: Option<&Path>) -> Result<PathBuf> {
    match argument {
        Some(path) => fs::canonicalize(path)
            .map_err(|_| anyhow!("install: host path does not exist: {}", path.display())),
        None => {
            let top = std::process::Command::new("git")
                .args(["rev-parse", "--show-toplevel"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .unwrap_or_default();
            if top.is_empty() {
                bail!(
                    "install: no host path given and the working directory is not a git work tree"
                );
            }
            fs::canonicalize(&top)
                .map_err(|error| anyhow!("install: host path does not exist: {top} ({error})"))
        }
    }
}

/// Install the embedded wrappers into `host` (or the git root when `None`).
///
/// Every `.omp/` file is written as a real file at the same relative path.
/// A differing file outside the managed `devboard-*` namespace stops the run
/// unless `force` is set. The marked skills are package-owned and always
/// replaced; unmarked skills are never read. `<host>/AGENTS.md` is copied only
/// when it is absent, a symlink, or absent content, and left alone on drift.
pub fn install(host: Option<&Path>, force: bool) -> Result<InstallReport> {
    let host = resolve_host(host)?;
    install_into(&host, force)
}

fn install_into(host: &Path, force: bool) -> Result<InstallReport> {
    let package = package();
    let omp = host.join(".omp");
    let mut conflicts: Vec<&str> = Vec::new();
    for (relative, contents) in &package.files {
        let destination = omp.join(relative.as_str());
        match fs::symlink_metadata(&destination) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("install: probing {}", destination.display()))
            }
            Ok(meta) if meta.is_file() && fs::read(&destination)?.as_slice() == *contents => {}
            Ok(_) => conflicts.push(relative.as_str()),
        }
    }
    if !conflicts.is_empty() && !force {
        let mut message = format!(
            "install: refusing to overwrite differing files in {}:",
            omp.display()
        );
        for relative in &conflicts {
            message.push_str("\n  ");
            message.push_str(relative);
        }
        message.push_str("\ninstall: rerun with --force to replace them");
        bail!("{message}");
    }

    let mut installed_files = 0usize;
    for (relative, contents) in &package.files {
        let destination = omp.join(relative.as_str());
        if is_identical_file(&destination, contents)? {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(&destination) {
            if meta.is_dir() {
                bail!(
                    "install: cannot replace the directory {} with a file",
                    destination.display()
                );
            }
            fs::remove_file(&destination)
                .with_context(|| format!("install: replacing {}", destination.display()))?;
        }
        let parent = destination.parent().unwrap_or(&omp);
        ensure_real_dir(parent)?;
        fs::write(&destination, contents)
            .with_context(|| format!("install: writing {}", destination.display()))?;
        installed_files += 1;
    }

    let skills_dir = omp.join("skills");
    for skill in &package.skills {
        let destination = skills_dir.join(&skill.name);
        if skill_matches(skill, &destination)? {
            continue;
        }
        remove_entry(&destination)?;
        for (relative, contents) in &skill.files {
            let target = destination.join(relative.as_str());
            let parent = target.parent().unwrap_or(&destination);
            ensure_real_dir(parent)?;
            fs::write(&target, contents)
                .with_context(|| format!("install: writing {}", target.display()))?;
            installed_files += 1;
        }
    }

    let shipped: BTreeSet<&str> = package
        .skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect();
    if let Ok(entries) = fs::read_dir(&skills_dir) {
        for entry in entries {
            let entry =
                entry.with_context(|| format!("install: reading {}", skills_dir.display()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(MANAGED_SKILL_PREFIX) || shipped.contains(name.as_str()) {
                continue;
            }
            remove_entry(&entry.path())?;
        }
    }

    let agents_target = host.join("AGENTS.md");
    let agents = match fs::symlink_metadata(&agents_target) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::write(&agents_target, HOST_AGENTS)
                .with_context(|| format!("install: writing {}", agents_target.display()))?;
            AgentsOutcome::Installed
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("install: probing {}", agents_target.display()))
        }
        Ok(meta) if meta.file_type().is_symlink() => {
            fs::remove_file(&agents_target)
                .with_context(|| format!("install: replacing {}", agents_target.display()))?;
            fs::write(&agents_target, HOST_AGENTS)
                .with_context(|| format!("install: writing {}", agents_target.display()))?;
            AgentsOutcome::Installed
        }
        Ok(meta) if !meta.is_file() => AgentsOutcome::Skipped,
        Ok(_) => {
            if fs::read(&agents_target)?.as_slice() == HOST_AGENTS {
                AgentsOutcome::Current
            } else {
                AgentsOutcome::Drift
            }
        }
    };

    let gitignore_added = ensure_gitignore(host, &package.names)?;

    Ok(InstallReport {
        host: host.to_path_buf(),
        omp_dir: omp,
        installed_files,
        skills: package.names.clone(),
        agents,
        gitignore_added,
    })
}

/// Append one `/.omp/skills/devboard-*` line per shipped skill that the host
/// `.gitignore` does not already carry. A rerun appends nothing.
fn ensure_gitignore(host: &Path, names: &[String]) -> Result<Vec<String>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let ignore_path = host.join(".gitignore");
    let existing = match fs::symlink_metadata(&ignore_path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("install: probing {}", ignore_path.display()))
        }
        Ok(meta) if meta.is_file() => fs::read(&ignore_path)
            .with_context(|| format!("install: reading {}", ignore_path.display()))?,
        Ok(_) => bail!("install: {} is not a regular file", ignore_path.display()),
    };
    let lines: Vec<&[u8]> = existing.split(|byte| *byte == b'\n').collect();
    let mut added = Vec::new();
    for name in names {
        let entry = format!("/.omp/skills/{name}");
        if lines.contains(&entry.as_bytes()) {
            continue;
        }
        added.push(entry);
    }
    if added.is_empty() {
        return Ok(added);
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with(b"\n") {
        updated.push(b'\n');
    }
    for entry in &added {
        updated.extend_from_slice(entry.as_bytes());
        updated.push(b'\n');
    }
    fs::write(&ignore_path, &updated)
        .with_context(|| format!("install: writing {}", ignore_path.display()))?;
    Ok(added)
}

/// Compare every shipped managed skill with the host copy. A missing file, a
/// differing byte, an extra entry, or a symlink is a failure; a skill the
/// package does not ship is never inspected.
pub fn doctor(host: Option<&Path>) -> Result<DoctorReport> {
    let host = resolve_host(host)?;
    let package = package();
    let omp = host.join(".omp");
    let mut report = DoctorReport {
        host: host.clone(),
        skills: package.names.clone(),
        failures: Vec::new(),
        drift: Vec::new(),
    };

    for skill in &package.skills {
        let actual = omp.join("skills").join(&skill.name);
        match fs::symlink_metadata(&actual) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                report
                    .failures
                    .push(format!(".omp/skills/{} is missing", skill.name));
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("doctor: probing {}", actual.display()))
            }
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                report.failures.push(format!(
                    ".omp/skills/{} is not a real directory",
                    skill.name
                ));
                continue;
            }
            Ok(_) => {}
        }
        let label = format!(".omp/skills/{}", skill.name);
        compare_tree(&label, &skill.files, &actual, &mut report.failures)?;
    }

    for (label, prefix) in [
        (".omp/commands", "commands/"),
        (".omp/extensions", "extensions/"),
    ] {
        let expected: Vec<(String, &'static [u8])> = package
            .files
            .iter()
            .filter_map(|(relative, contents)| {
                relative
                    .strip_prefix(prefix)
                    .map(|inside| (inside.to_string(), *contents))
            })
            .collect();
        let actual = omp.join(prefix.trim_end_matches('/'));
        match fs::symlink_metadata(&actual) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                report.failures.push(format!("{label} is missing"));
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("doctor: probing {}", actual.display()))
            }
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                report
                    .failures
                    .push(format!("{label} is not a real directory"));
                continue;
            }
            Ok(_) => {}
        }
        compare_tree(label, &expected, &actual, &mut report.failures)?;
    }

    if let Some((_, contents)) = package
        .files
        .iter()
        .find(|(relative, _)| relative == "mcp.json")
    {
        let actual = omp.join("mcp.json");
        match fs::symlink_metadata(&actual) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                report.failures.push(".omp/mcp.json is missing".to_string());
            }
            Err(error) => {
                return Err(error).with_context(|| format!("doctor: probing {}", actual.display()))
            }
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                report
                    .failures
                    .push(".omp/mcp.json is not a real file".to_string());
            }
            Ok(_) => {
                if fs::read(&actual)?.as_slice() != *contents {
                    report
                        .failures
                        .push(".omp/mcp.json differs from the installed copy".to_string());
                }
            }
        }
    }

    let agents = host.join("AGENTS.md");
    match fs::symlink_metadata(&agents) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            report
                .failures
                .push("AGENTS.md is missing; run install".to_string());
        }
        Err(error) => {
            return Err(error).with_context(|| format!("doctor: probing {}", agents.display()))
        }
        Ok(meta) if meta.file_type().is_symlink() => {
            report
                .failures
                .push("AGENTS.md is a symlink; run install".to_string());
        }
        Ok(meta) if !meta.is_file() => {
            report
                .failures
                .push("AGENTS.md is not a regular file".to_string());
        }
        Ok(_) => {
            if fs::read(&agents)?.as_slice() != HOST_AGENTS {
                report
                    .drift
                    .push("AGENTS.md differs from the template (left unchanged)".to_string());
            }
        }
    }

    Ok(report)
}

/// Record every expected file that is missing, differing, or not a real file,
/// then every existing entry the package does not ship.
fn compare_tree(
    label: &str,
    expected: &[(String, &'static [u8])],
    root: &Path,
    failures: &mut Vec<String>,
) -> Result<()> {
    let mut expected_set: BTreeSet<&str> = BTreeSet::new();
    for (relative, contents) in expected {
        expected_set.insert(relative.as_str());
        let target = root.join(relative.as_str());
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                failures.push(format!("{label}/{relative} is missing"));
            }
            Err(error) => {
                return Err(error).with_context(|| format!("doctor: probing {}", target.display()))
            }
            Ok(meta) if meta.file_type().is_symlink() => {
                failures.push(format!("{label}/{relative} is a symlink"));
            }
            Ok(meta) if !meta.is_file() => {
                failures.push(format!("{label}/{relative} is not a real file"));
            }
            Ok(_) => {
                if fs::read(&target)?.as_slice() != *contents {
                    failures.push(format!(
                        "{label}/{relative} differs from the installed copy"
                    ));
                }
            }
        }
    }
    let mut actual = Vec::new();
    collect_entries(root, "", &mut actual)?;
    for relative in actual {
        if !expected_set.contains(relative.as_str()) {
            failures.push(format!("{label}/{relative} is not shipped by the package"));
        }
    }
    Ok(())
}

/// Every non-directory entry below `root`, as `/`-joined relative paths.
fn collect_entries(root: &Path, prefix: &str, out: &mut Vec<String>) -> Result<()> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("doctor: reading {}", root.display()))
        }
    };
    for entry in entries {
        let entry = entry.with_context(|| format!("doctor: reading {}", root.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let file_type = entry
            .file_type()
            .with_context(|| format!("doctor: probing {}", entry.path().display()))?;
        if file_type.is_dir() {
            collect_entries(&entry.path(), &relative, out)?;
            continue;
        }
        out.push(relative);
    }
    Ok(())
}

/// True when `destination` is exactly the package tree `skill`: every shipped
/// file present with identical bytes, no extra entry, no symlink.
fn skill_matches(skill: &ShippedSkill, destination: &Path) -> Result<bool> {
    match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("install: probing {}", destination.display()))
        }
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return Ok(false),
        Ok(_) => {}
    }
    let mut files: BTreeSet<&str> = BTreeSet::new();
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    for (relative, contents) in &skill.files {
        files.insert(relative.as_str());
        let mut parts: Vec<&str> = relative.split('/').collect();
        parts.pop();
        let mut accumulated = String::new();
        for part in parts {
            if !accumulated.is_empty() {
                accumulated.push('/');
            }
            accumulated.push_str(part);
            dirs.insert(accumulated.clone());
        }
        let target = destination.join(relative.as_str());
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error).with_context(|| format!("install: probing {}", target.display()))
            }
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => return Ok(false),
            Ok(_) => {
                if fs::read(&target)?.as_slice() != *contents {
                    return Ok(false);
                }
            }
        }
    }
    entries_are_expected(destination, "", &files, &dirs)
}

fn entries_are_expected(
    root: &Path,
    prefix: &str,
    files: &BTreeSet<&str>,
    dirs: &BTreeSet<String>,
) -> Result<bool> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error).with_context(|| format!("install: reading {}", root.display()))
        }
    };
    for entry in entries {
        let entry = entry.with_context(|| format!("install: reading {}", root.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let file_type = entry
            .file_type()
            .with_context(|| format!("install: probing {}", entry.path().display()))?;
        if file_type.is_symlink() {
            return Ok(false);
        }
        if file_type.is_dir() {
            if !dirs.contains(&relative) {
                return Ok(false);
            }
            if !entries_are_expected(&entry.path(), &relative, files, dirs)? {
                return Ok(false);
            }
            continue;
        }
        if !files.contains(relative.as_str()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Remove a file, symlink, or directory without ever following a symlink.
fn remove_entry(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("install: probing {}", path.display())),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)
            .with_context(|| format!("install: removing {}", path.display())),
        Ok(_) => {
            fs::remove_file(path).with_context(|| format!("install: removing {}", path.display()))
        }
    }
}

/// True when `path` is a regular, non-symlink file holding `contents`.
fn is_identical_file(path: &Path, contents: &[u8]) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("install: probing {}", path.display())),
        Ok(meta) if meta.is_file() => Ok(fs::read(path)
            .with_context(|| format!("install: reading {}", path.display()))?
            .as_slice()
            == contents),
        Ok(_) => Ok(false),
    }
}

/// Create `path` and every missing ancestor as real directories. A symlink or
/// a file in the way is replaced, so a write can never escape the host root.
fn ensure_real_dir(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.is_dir() => continue,
            Ok(_) => {
                fs::remove_file(&current)
                    .with_context(|| format!("install: replacing {}", current.display()))?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("install: probing {}", current.display()))
            }
        }
        fs::create_dir(&current)
            .with_context(|| format!("install: creating {}", current.display()))?;
    }
    Ok(())
}
