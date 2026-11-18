//! The installed skills a repository ships and the project OMP settings that
//! switch them off.
//!
//! Ported from `.devboard/server/app.ts`: the skills root
//! (`<repo>/.omp/skills`) is the only source of an installed row, and one
//! toggle edits `skills.ignoredSkills` in `<repo>/.omp/settings.json` while
//! every other key of that document survives byte for byte.

use std::cmp::Ordering;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::skill_frontmatter;
use crate::state::write_file_atomically;

/// The project-level settings file OMP reads at the repository root.
pub const PROJECT_SETTINGS_FILE: &str = "settings.json";
/// The OMP array of skill-name glob patterns a session must not load.
pub const SKILL_EXCLUSION_SETTING: &str = "ignoredSkills";

/// The frontmatter field marking a skill this feature wrote itself.
const MANAGED_MARKER: &str = "devboard-managed";
/// The frontmatter field marking a skill the package ships.
const BUILTIN_MARKER: &str = "devboard-builtin";
/// The frontmatter field naming a managed skill's family.
const FAMILY_FIELD: &str = "metadata.devboard-family";
/// The longest skill name OMP accepts.
const SKILL_NAME_MAX: usize = 64;

/// The directory OMP loads a repository's skills from.
pub fn skills_root(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".omp").join("skills")
}

/// The project-level settings document's path.
pub fn project_settings_path(repo_dir: &Path) -> PathBuf {
    repo_dir.join(".omp").join(PROJECT_SETTINGS_FILE)
}

/// Whether one name is a kebab-case skill name OMP accepts.
pub fn is_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= SKILL_NAME_MAX
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
}

/// One directory under the skills root that holds a readable `SKILL.md`.
#[derive(Clone, Debug)]
pub struct InstalledSkillFile {
    /// The directory name, which is the row's name.
    pub name: String,
    /// The whole `SKILL.md`, so an expanded row opens without a second read.
    pub content: String,
    /// The package ships this skill and the frontmatter marks it.
    pub builtin: bool,
    /// A marked prepare-family directory this feature created itself.
    pub deletable: bool,
}

/// Every directory under the skills root OMP can load: a real directory or a
/// symlink to one holding a readable `SKILL.md`.
pub async fn installed_skill_files(root: &Path) -> Result<Vec<InstalledSkillFile>, String> {
    let mut entries = Vec::new();
    let mut reader = match tokio::fs::read_dir(root).await {
        Ok(reader) => reader,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|error| error.to_string())?
    {
        entries.push(entry);
    }

    let mut files = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().await.map_err(|error| error.to_string())?;
        if !entry_is_directory(root, &name, &file_type).await {
            continue;
        }
        let Some(skill) = read_skill_at(root, &name).await? else {
            continue;
        };
        files.push(InstalledSkillFile {
            name,
            content: skill.content,
            builtin: skill.builtin,
            // A link is the operator's entry, so it is never a target this
            // page deletes; only a marked prepare-family directory it created
            // itself is.
            deletable: !skill.builtin
                && skill.managed
                && skill.family == Family::Prepare
                && !file_type.is_symlink(),
        });
    }
    files.sort_by(|left, right| locale_compare(&left.name, &right.name));
    Ok(files)
}

/// Whether one skills-root entry is a directory a `SKILL.md` may be read from.
/// A symlink to a directory counts; a link to a file or a broken link does not.
async fn entry_is_directory(root: &Path, name: &str, file_type: &std::fs::FileType) -> bool {
    if file_type.is_dir() {
        return true;
    }
    if !file_type.is_symlink() {
        return false;
    }
    match tokio::fs::metadata(root.join(name)).await {
        Ok(metadata) => metadata.is_dir(),
        Err(_) => false,
    }
}

/// The two families a managed skill can belong to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    Prepare,
    Discover,
}

/// One `SKILL.md` as the installed-skills feature reads it.
struct ParsedSkill {
    content: String,
    managed: bool,
    builtin: bool,
    family: Family,
}

/// Reads `<root>/<directory>/SKILL.md`, or `None` when the directory has none.
async fn read_skill_at(root: &Path, directory: &str) -> Result<Option<ParsedSkill>, String> {
    let path = root.join(directory).join("SKILL.md");
    // Sampled through the shared cache: a page that polls this list every
    // second reads an unchanged skill document once, not once per poll. The
    // bytes are decoded lossily, so one stray byte changes that row's text
    // instead of making the whole list unreadable.
    let content = match crate::sampling::text_lossy(&path) {
        Some(text) => (*text).clone(),
        None if path.exists() => {
            return Err(format!(
                "the skill document {} could not be read",
                path.display()
            ))
        }
        None => return Ok(None),
    };
    let fields = skill_frontmatter::fields(&content).unwrap_or_default();
    let field = |key: &str| fields.get(key).map(String::as_str).unwrap_or("");
    Ok(Some(ParsedSkill {
        managed: field(&format!("metadata.{MANAGED_MARKER}")) == "true",
        builtin: field(&format!("metadata.{BUILTIN_MARKER}")) == "true",
        // A managed skill without a family belongs to the prepare family, so
        // skills written before the family marker keep working.
        family: if field(FAMILY_FIELD) == "discover" {
            Family::Discover
        } else {
            Family::Prepare
        },
        content,
    }))
}

/// The project-level OMP settings document, or an empty one when the file does
/// not exist. Every other key is returned untouched so a toggle never rewrites
/// a setting this page does not own.
pub async fn read_project_settings(path: &Path) -> Result<Value, String> {
    let source = match crate::sampling::text(path) {
        Some(text) => (*text).clone(),
        None if path.exists() => {
            return Err(format!(
                "the project settings {} could not be read",
                path.display()
            ))
        }
        None => return Ok(empty_document()),
    };
    if skill_frontmatter::js_trim(&source).is_empty() {
        return Ok(empty_document());
    }
    let parsed: Value = serde_json::from_str(&source)
        .map_err(|_| "The project OMP settings are not valid JSON.".to_string())?;
    // `typeof value === "object"` admits an array as well as an object, and the
    // settings reader inherits that looseness.
    if parsed.is_object() || parsed.is_array() {
        Ok(parsed)
    } else {
        Err("The project OMP settings are not a JSON object.".to_string())
    }
}

fn empty_document() -> Value {
    Value::Object(Map::new())
}

/// The one owner of every read-modify-write of a project settings file.
///
/// A toggle and a delete both read the whole document and write it back, with
/// awaits between the read and the write, so they share this guard: without it
/// the second writer publishes a document it read before the first one's entry
/// landed, and that entry disappears while both commands report success.
fn settings_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));
    &LOCK
}

/// The entries of `skills.ignoredSkills`, or none when the document holds no
/// such array.
pub fn project_ignored_skills(document: &Value) -> Vec<Value> {
    document
        .get("skills")
        .and_then(Value::as_object)
        .and_then(|skills| skills.get(SKILL_EXCLUSION_SETTING))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The first `skills.ignoredSkills` entry whose glob matches `name`, or `None`
/// when no string entry does. A non-string entry names no pattern and disables
/// nothing, so it never answers this question.
pub fn first_ignored_skill_pattern(current: &[Value], name: &str) -> Option<String> {
    current.iter().find_map(|value| match value {
        Value::String(pattern) if glob_matches(pattern, name) => Some(pattern.clone()),
        _ => None,
    })
}

/// The array the setting takes when one skill toggles, or `None` when it
/// already holds the requested state. Entries the dashboard did not write are
/// kept as they are, so only the named skill changes.
pub fn next_ignored_skills(current: &[Value], name: &str, enabled: bool) -> Option<Vec<Value>> {
    let present = current.iter().any(|value| value.as_str() == Some(name));
    if enabled {
        if !present {
            return None;
        }
        return Some(
            current
                .iter()
                .filter(|value| value.as_str() != Some(name))
                .cloned()
                .collect(),
        );
    }
    if present {
        return None;
    }
    let mut next = current.to_vec();
    next.push(Value::String(name.to_string()));
    Some(next)
}

/// Removes a deleted skill's name from `skills.ignoredSkills`, reading the
/// document inside the settings guard and only after that skill's directory is
/// gone, so a toggle that landed while the directory was being removed is
/// never dropped. Every other key and entry is carried through untouched, so
/// deleting an enabled skill writes nothing at all.
pub async fn remove_skill_exclusion(
    path: &Path,
    name: &str,
) -> Result<SkillExclusionWrite, String> {
    let _guard = settings_lock().lock().await;
    let document = read_project_settings(path).await?;
    let Some(next) = document_after_removal(&document, name) else {
        return Ok(SkillExclusionWrite::Unchanged);
    };
    let text = format!("{}\n", pretty(&next));
    write_file_atomically(path, &text)
        .await
        .map_err(|error| error.to_string())?;
    Ok(SkillExclusionWrite::Written)
}

/// The settings document after a deleted skill's name leaves
/// `skills.ignoredSkills`, or `None` when the name is not there.
fn document_after_removal(document: &Value, name: &str) -> Option<Value> {
    let mut document = document.clone();
    let Some(Value::Object(skills)) = document.get("skills").cloned() else {
        return None;
    };
    let Some(Value::Array(ignored)) = skills.get(SKILL_EXCLUSION_SETTING).cloned() else {
        return None;
    };
    if !ignored.iter().any(|value| value.as_str() == Some(name)) {
        return None;
    }
    let mut next_skills = skills;
    next_skills.insert(
        SKILL_EXCLUSION_SETTING.to_string(),
        Value::Array(
            ignored
                .into_iter()
                .filter(|value| value.as_str() != Some(name))
                .collect(),
        ),
    );
    if let Value::Object(document) = &mut document {
        document.insert("skills".to_string(), Value::Object(next_skills));
    }
    Some(document)
}

/// What one exclusion write did to the settings document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkillExclusionWrite {
    /// The document already held the requested state; nothing was written.
    Unchanged,
    /// The document was rewritten to hold the requested state.
    Written,
    /// Enabling was refused: this glob pattern still matches the skill, so only
    /// editing that pattern can enable it.
    BlockedByPattern(String),
}

/// Adds or removes one skill's name in the project-level exclusion, writing
/// the whole settings document atomically and creating it when absent. A skill
/// a pattern still excludes is never reported as enabled: the write refuses and
/// names that pattern.
pub async fn write_skill_exclusion(
    path: &Path,
    name: &str,
    enabled: bool,
) -> Result<SkillExclusionWrite, String> {
    let _guard = settings_lock().lock().await;
    let mut document = read_project_settings(path).await?;
    let skills = document.get("skills").cloned();
    if let Some(value) = &skills {
        // A settings object admits arrays here because JavaScript's
        // `typeof null === "object"`-style check does; a scalar refuses.
        if !value.is_object() && !value.is_array() {
            return Err("The project OMP skills setting is not an object.".to_string());
        }
    }
    let existing = match &skills {
        Some(Value::Object(skills)) => skills.get(SKILL_EXCLUSION_SETTING),
        _ => None,
    };
    if let Some(value) = existing {
        if !value.is_array() {
            return Err("The project OMP skill exclusion is not an array.".to_string());
        }
    }
    let current = project_ignored_skills(&document);
    if !enabled && first_ignored_skill_pattern(&current, name).is_some() {
        // Disabled already holds when the array names the skill exactly or a
        // pattern matches it, so no redundant entry is written.
        return Ok(SkillExclusionWrite::Unchanged);
    }
    let Some(next) = next_ignored_skills(&current, name, enabled) else {
        // Enabling already holds through the array's own entries, but a pattern
        // may be the reason the row reports the skill disabled.
        if enabled {
            if let Some(pattern) = first_ignored_skill_pattern(&current, name) {
                return Ok(SkillExclusionWrite::BlockedByPattern(pattern));
            }
        }
        return Ok(SkillExclusionWrite::Unchanged);
    };
    if enabled {
        // Removing the exact entry can still leave a pattern that excludes it.
        if let Some(pattern) = first_ignored_skill_pattern(&next, name) {
            return Ok(SkillExclusionWrite::BlockedByPattern(pattern));
        }
    }
    let mut object = match &skills {
        Some(Value::Object(skills)) => skills.clone(),
        Some(Value::Array(items)) => array_spread(items),
        _ => Map::new(),
    };
    object.insert(SKILL_EXCLUSION_SETTING.to_string(), Value::Array(next));
    // Assigning onto a top-level array keeps the property invisible to
    // `JSON.stringify`, which prints only its elements, so an array document
    // refuses rather than report a write that stored no exclusion.
    let Value::Object(entries) = &mut document else {
        return Err(format!(
            "The project OMP settings {} are not a JSON object, so no skill exclusion can be stored.",
            path.display()
        ));
    };
    entries.insert("skills".to_string(), Value::Object(object));
    let text = format!("{}\n", pretty(&document));
    write_file_atomically(path, &text)
        .await
        .map_err(|error| error.to_string())?;
    Ok(SkillExclusionWrite::Written)
}

/// The object an array spreads into: its index keys, in order.
fn array_spread(items: &[Value]) -> Map<String, Value> {
    let mut object = Map::new();
    for (index, item) in items.iter().enumerate() {
        object.insert(index.to_string(), item.clone());
    }
    object
}

/// The installed rows as `getInstalledSkills` reports them.
pub async fn installed_skill_rows(repo_dir: &Path) -> Result<Vec<Value>, String> {
    let document = read_project_settings(&project_settings_path(repo_dir)).await?;
    let ignored = project_ignored_skills(&document);
    let files = installed_skill_files(&skills_root(repo_dir)).await?;
    Ok(files
        .into_iter()
        .map(|file| {
            let enabled = first_ignored_skill_pattern(&ignored, &file.name).is_none();
            let mut row = Map::new();
            row.insert("name".to_string(), Value::String(file.name));
            row.insert("enabled".to_string(), Value::Bool(enabled));
            row.insert("content".to_string(), Value::String(file.content));
            row.insert("builtin".to_string(), Value::Bool(file.builtin));
            row.insert("deletable".to_string(), Value::Bool(file.deletable));
            Value::Object(row)
        })
        .collect())
}

/// The `installedSkills` frame, or the `error` frame `sendInstalledSkills`
/// sends instead when the skills cannot be read.
pub async fn installed_skills_payload(repo_dir: &Path) -> Value {
    match installed_skill_rows(repo_dir).await {
        Ok(skills) => installed_skills_frame(skills),
        Err(message) => error_frame(format!("Could not read the installed skills: {message}")),
    }
}

fn installed_skills_frame(skills: Vec<Value>) -> Value {
    let mut frame = Map::new();
    frame.insert("type".to_string(), Value::String("installedSkills".into()));
    frame.insert("skills".to_string(), Value::Array(skills));
    Value::Object(frame)
}

fn error_frame(message: impl Into<String>) -> Value {
    let mut frame = Map::new();
    frame.insert("type".to_string(), Value::String("error".into()));
    frame.insert("message".to_string(), Value::String(message.into()));
    Value::Object(frame)
}

/// What one `setInstalledSkillEnabled` command sends, in order.
pub enum ToggleOutcome {
    /// The requested state holds; every client receives this authoritative
    /// frame.
    Changed(Value),
    /// Nothing changed: these frames go to the requesting client only.
    Refused(Vec<Value>),
}

/// Toggles one skill's exclusion, reporting the frames the command sends.
pub async fn toggle_installed_skill(
    repo_dir: &Path,
    name: Option<&Value>,
    enabled: Option<&Value>,
) -> ToggleOutcome {
    let (Some(Value::String(name)), Some(Value::Bool(enabled))) = (name, enabled) else {
        return ToggleOutcome::Refused(vec![error_frame(
            "A skill change needs its name and enabled value.",
        )]);
    };
    if !is_skill_name(name) {
        return ToggleOutcome::Refused(vec![error_frame("Choose an installed skill to change.")]);
    }
    let enabled = *enabled;
    let files = match installed_skill_files(&skills_root(repo_dir)).await {
        Ok(files) => files,
        Err(message) => {
            return refuse_with_rows(
                repo_dir,
                format!("Could not save the skill setting: {message}"),
            )
            .await
        }
    };
    if !files.iter().any(|file| file.name == *name) {
        let message = format!("No skill named \"{name}\" is installed.");
        return refuse_with_rows(repo_dir, message).await;
    }
    match write_skill_exclusion(&project_settings_path(repo_dir), name, enabled).await {
        Ok(SkillExclusionWrite::BlockedByPattern(pattern)) => {
            let message = format!(
                "\"{name}\" stays disabled by the pattern \"{pattern}\" in \
                 .omp/settings.json; edit that pattern to enable it."
            );
            return refuse_with_rows(repo_dir, message).await;
        }
        Ok(SkillExclusionWrite::Unchanged | SkillExclusionWrite::Written) => {}
        Err(message) => {
            return refuse_with_rows(
                repo_dir,
                format!("Could not save the skill setting: {message}"),
            )
            .await
        }
    }
    match installed_skill_rows(repo_dir).await {
        Ok(skills) => ToggleOutcome::Changed(installed_skills_frame(skills)),
        Err(message) => {
            refuse_with_rows(
                repo_dir,
                format!("Could not save the skill setting: {message}"),
            )
            .await
        }
    }
}

/// The refusal frame followed by the authoritative rows, as the command sends
/// them to the client that asked.
async fn refuse_with_rows(repo_dir: &Path, message: String) -> ToggleOutcome {
    ToggleOutcome::Refused(vec![
        error_frame(message),
        installed_skills_payload(repo_dir).await,
    ])
}

/// Adds or removes one installed skill's name in the project-level OMP
/// exclusion. On success the returned frame holds the authoritative rows and
/// goes to every client. A refusal is the message for the sender; use
/// [`toggle_installed_skill`] when the exact frame sequence matters, because a
/// refusal that reached the filesystem is followed by the rows.
pub async fn set_installed_skill_enabled(
    repo_dir: &Path,
    name: Option<&Value>,
    enabled: Option<&Value>,
) -> Result<Value, String> {
    match toggle_installed_skill(repo_dir, name, enabled).await {
        ToggleOutcome::Changed(frame) => Ok(frame),
        ToggleOutcome::Refused(frames) => {
            let message = frames
                .first()
                .and_then(|frame| frame.get("message"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Err(message)
        }
    }
}

/// `JSON.stringify(value, null, 2)`.
fn pretty(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

fn write_pretty(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(",\n");
                }
                write_indent(depth + 1, out);
                write_pretty(item, depth + 1, out);
            }
            out.push('\n');
            write_indent(depth, out);
            out.push(']');
        }
        Value::Object(object) if !object.is_empty() => {
            out.push_str("{\n");
            for (index, (key, item)) in object.iter().enumerate() {
                if index > 0 {
                    out.push_str(",\n");
                }
                write_indent(depth + 1, out);
                crate::jsjson::write_string(key, out);
                out.push_str(": ");
                write_pretty(item, depth + 1, out);
            }
            out.push('\n');
            write_indent(depth, out);
            out.push('}');
        }
        Value::Array(_) => out.push_str("[]"),
        Value::Object(_) => out.push_str("{}"),
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(number, out),
        Value::String(text) => crate::jsjson::write_string(text, out),
    }
}

fn write_indent(depth: usize, out: &mut String) {
    for _ in 0..depth * 2 {
        out.push(' ');
    }
}

/// The ECMAScript text of one JSON number.
fn write_number(number: &serde_json::Number, out: &mut String) {
    if let Some(integer) = number.as_i64() {
        out.push_str(&integer.to_string());
        return;
    }
    if let Some(integer) = number.as_u64() {
        out.push_str(&integer.to_string());
        return;
    }
    match number.as_f64() {
        Some(value) => out.push_str(&crate::jsjson::number_f64(value)),
        None => out.push_str(&number.to_string()),
    }
}

/// Whether one `ignoredSkills` pattern matches a skill name, as
/// `new Bun.Glob(pattern).match(name)` does: case-sensitive, whole-string, a
/// brace expands to its alternatives, and an unterminated pattern matches
/// nothing (except that an unterminated brace keeps its first alternative).
pub fn glob_matches(pattern: &str, name: &str) -> bool {
    expand_braces(pattern)
        .iter()
        .any(|alternative| glob_matches_one(alternative, name))
}

fn glob_matches_one(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    if !pattern_is_valid(&pattern) {
        return false;
    }
    let mut pi = 0;
    let mut ni = 0;
    // The pattern position after the most recent star, how many name
    // characters it has consumed, and whether it may cross a `/` (`**` may, a
    // single `*` may not). A skill name never holds `/`, so the distinction
    // only keeps a pattern's behaviour identical to Bun's.
    let mut backtrack: Option<(usize, usize, bool)> = None;
    while ni < name.len() {
        let mut matched = false;
        if pi < pattern.len() {
            match pattern[pi] {
                '*' => {
                    let mut stars = 0;
                    while pi < pattern.len() && pattern[pi] == '*' {
                        pi += 1;
                        stars += 1;
                    }
                    backtrack = Some((pi, ni, stars >= 2));
                    matched = true;
                }
                '?' => {
                    if name[ni] != '/' {
                        pi += 1;
                        ni += 1;
                        matched = true;
                    }
                }
                '[' => {
                    if let Some(end) = class_end(&pattern, pi) {
                        if name[ni] != '/' && class_matches(&pattern[pi + 1..end], name[ni]) {
                            pi = end + 1;
                            ni += 1;
                            matched = true;
                        }
                    }
                }
                '\\' if pi + 1 < pattern.len() => {
                    if pattern[pi + 1] == name[ni] {
                        pi += 2;
                        ni += 1;
                        matched = true;
                    }
                }
                literal => {
                    if literal == name[ni] {
                        pi += 1;
                        ni += 1;
                        matched = true;
                    }
                }
            }
        }
        if matched {
            continue;
        }
        match backtrack {
            Some((star_pi, star_ni, crosses)) => {
                if star_ni + 1 > name.len() || (!crosses && name[star_ni] == '/') {
                    return false;
                }
                pi = star_pi;
                ni = star_ni + 1;
                backtrack = Some((star_pi, ni, crosses));
            }
            None => return false,
        }
    }
    while pi < pattern.len() && pattern[pi] == '*' {
        pi += 1;
    }
    pi == pattern.len()
}

/// Whether every `[` in one pattern is closed. Bun's matcher refuses an
/// unterminated class outright rather than reading it as a literal `[`.
fn pattern_is_valid(pattern: &[char]) -> bool {
    let mut index = 0;
    while index < pattern.len() {
        match pattern[index] {
            '\\' => index += 2,
            '[' => match class_end(pattern, index) {
                Some(_) => index += 1,
                None => return false,
            },
            _ => index += 1,
        }
    }
    true
}

/// The first unescaped `{`, whether or not it closes.
fn first_open_brace(pattern: &[char]) -> Option<usize> {
    let mut index = 0;
    while index < pattern.len() {
        match pattern[index] {
            '\\' => index += 2,
            '{' => return Some(index),
            _ => index += 1,
        }
    }
    None
}

/// The index of the `]` closing the class that opens at `start`, or `None`
/// when the pattern never closes it.
fn class_end(pattern: &[char], start: usize) -> Option<usize> {
    let mut index = start + 1;
    if index < pattern.len() && (pattern[index] == '!' || pattern[index] == '^') {
        index += 1;
    }
    if index < pattern.len() && pattern[index] == ']' {
        index += 1;
    }
    while index < pattern.len() {
        if pattern[index] == ']' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn class_matches(body: &[char], character: char) -> bool {
    let (negated, body) = match body.first() {
        Some('!') | Some('^') => (true, &body[1..]),
        _ => (false, body),
    };
    let mut matched = false;
    let mut index = 0;
    while index < body.len() {
        let mut first = body[index];
        let mut width = 1;
        if first == '\\' && index + 1 < body.len() {
            first = body[index + 1];
            width = 2;
        }
        let range_start = index + width;
        if range_start + 1 < body.len() && body[range_start] == '-' {
            let mut last = body[range_start + 1];
            let mut range_width = 2;
            if last == '\\' && range_start + 2 < body.len() {
                last = body[range_start + 2];
                range_width = 3;
            }
            if first <= character && character <= last {
                matched = true;
            }
            index = range_start + range_width;
            continue;
        }
        if first == character {
            matched = true;
        }
        index += width;
    }
    matched != negated
}

/// Expands every `{a,b}` alternative in one pattern.
fn expand_braces(pattern: &str) -> Vec<String> {
    let mut out = Vec::new();
    expand_braces_into(pattern, &mut out, 0);
    if out.is_empty() {
        out.push(pattern.to_string());
    }
    out
}

fn expand_braces_into(pattern: &str, out: &mut Vec<String>, depth: usize) {
    if depth > 8 || out.len() > 64 {
        out.push(pattern.to_string());
        return;
    }
    let characters: Vec<char> = pattern.chars().collect();
    if let Some((open, close)) = brace_span(&characters) {
        let prefix: String = characters[..open].iter().collect();
        let suffix: String = characters[close + 1..].iter().collect();
        for alternative in split_alternatives(&characters[open + 1..close]) {
            let body: String = alternative.into_iter().collect();
            expand_braces_into(&format!("{prefix}{body}{suffix}"), out, depth + 1);
        }
        return;
    }
    // An unterminated brace contributes only up to its first comma, and an
    // unterminated brace without a comma is no pattern at all.
    let Some(open) = first_open_brace(&characters) else {
        out.push(pattern.to_string());
        return;
    };
    let Some(comma) = characters[open + 1..]
        .iter()
        .position(|character| *character == ',')
    else {
        return;
    };
    let prefix: String = characters[..open].iter().collect();
    let body: String = characters[open + 1..open + 1 + comma].iter().collect();
    expand_braces_into(&format!("{prefix}{body}"), out, depth + 1);
}

/// The first brace span Bun expands: an opening `{` and its matching `}`.
fn brace_span(characters: &[char]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == '\\' {
            index += 2;
            continue;
        }
        if characters[index] == '{' {
            let mut depth = 0;
            let mut cursor = index;
            while cursor < characters.len() {
                match characters[cursor] {
                    '\\' => cursor += 2,
                    '{' => {
                        depth += 1;
                        cursor += 1;
                    }
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some((index, cursor));
                        }
                        cursor += 1;
                    }
                    _ => cursor += 1,
                }
            }
        }
        index += 1;
    }
    None
}

fn split_alternatives(body: &[char]) -> Vec<Vec<char>> {
    let mut parts = Vec::new();
    let mut current = Vec::new();
    let mut depth = 0usize;
    let mut index = 0;
    while index < body.len() {
        let character = body[index];
        if character == '\\' && index + 1 < body.len() {
            current.push(character);
            current.push(body[index + 1]);
            index += 2;
            continue;
        }
        match character {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(std::mem::take(&mut current));
                index += 1;
                continue;
            }
            _ => {}
        }
        current.push(character);
        index += 1;
    }
    parts.push(current);
    parts
}

/// Orders two skill names as `localeCompare` orders them: case-folded first,
/// then lowercase before uppercase, which is the root collation's behaviour
/// for the ASCII names a repository uses.
fn locale_compare(left: &str, right: &str) -> Ordering {
    match primary_key(left).cmp(&primary_key(right)) {
        Ordering::Equal => case_key(left).cmp(&case_key(right)),
        other => other,
    }
}

/// The root collation's primary rank for one character: punctuation first in
/// the order ICU gives it, then digits, then letters, then everything else.
fn primary_rank(character: char) -> u32 {
    match character {
        ' ' => 1,
        '_' => 2,
        '-' => 3,
        ',' => 4,
        ';' => 5,
        ':' => 6,
        '!' => 7,
        '?' => 8,
        '.' => 9,
        '\'' => 10,
        '"' => 11,
        '(' => 12,
        ')' => 13,
        '[' => 14,
        ']' => 15,
        '{' => 16,
        '}' => 17,
        '@' => 18,
        '*' => 19,
        '/' => 20,
        '\\' => 21,
        '&' => 22,
        '#' => 23,
        '%' => 24,
        '`' => 25,
        '^' => 26,
        '+' => 27,
        '<' => 28,
        '=' => 29,
        '>' => 30,
        '|' => 31,
        '~' => 32,
        '$' => 33,
        '0'..='9' => 40 + (character as u32 - '0' as u32),
        'a'..='z' => 60 + (character as u32 - 'a' as u32),
        other => 1000 + other as u32,
    }
}

fn primary_key(text: &str) -> Vec<u32> {
    text.chars()
        .map(|character| primary_rank(character.to_lowercase().next().unwrap_or(character)))
        .collect()
}

fn case_key(text: &str) -> Vec<u8> {
    text.chars()
        .map(|character| u8::from(character.is_uppercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_fixture(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!(
                "installed-skills-guard-{label}-{}",
                std::process::id()
            ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".omp")).expect("a fixture settings root");
        root.join(".omp").join(PROJECT_SETTINGS_FILE)
    }

    /// A repository fixture whose skills root holds the written documents.
    fn skills_fixture(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("installed-skills-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".omp").join("skills")).expect("a fixture skills root");
        root
    }

    fn write_skill_document(repo_dir: &Path, name: &str, source: &[u8]) {
        let directory = repo_dir.join(".omp").join("skills").join(name);
        std::fs::create_dir_all(&directory).expect("a skill directory");
        std::fs::write(directory.join("SKILL.md"), source).expect("a SKILL.md");
    }

    /// A document with one invalid UTF-8 byte keeps its row: the list decodes
    /// it lossily instead of answering an `error` frame for every skill.
    #[tokio::test]
    async fn an_invalid_byte_in_one_document_still_lists_every_skill() {
        let repo = skills_fixture("invalid-utf8");
        write_skill_document(&repo, "alpha", b"---\nname: alpha\n---\n\n- Keep alpha.\n");
        write_skill_document(&repo, "beta", b"---\nname: beta\n---\n\n- Keep beta.\n");
        let mut broken = b"---\nname: broken\n---\n\n- caf".to_vec();
        broken.push(0xe9);
        broken.push(b'\n');
        write_skill_document(&repo, "broken", &broken);

        let payload = installed_skills_payload(&repo).await;

        assert_eq!(payload["type"], Value::String("installedSkills".into()));
        let rows = payload["skills"].as_array().expect("the skill rows");
        let names: Vec<&str> = rows.iter().filter_map(|row| row["name"].as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta", "broken"]);
        let content = rows
            .iter()
            .find(|row| row["name"] == "broken")
            .and_then(|row| row["content"].as_str())
            .expect("the broken row's text");
        assert!(content.contains("caf\u{fffd}"), "{content}");
    }

    /// A toggle beside the same document still writes the exclusion and
    /// answers the authoritative rows.
    #[tokio::test]
    async fn a_toggle_beside_an_invalid_document_answers_the_authoritative_rows() {
        let repo = skills_fixture("toggle-invalid-utf8");
        write_skill_document(&repo, "alpha", b"---\nname: alpha\n---\n\n- Keep alpha.\n");
        write_skill_document(&repo, "beta", b"---\nname: beta\n---\n\n- Keep beta.\n");
        write_skill_document(&repo, "broken", b"---\nname: broken\n---\n\n- caf\xe9\n");

        let outcome = toggle_installed_skill(
            &repo,
            Some(&Value::String("alpha".into())),
            Some(&Value::Bool(false)),
        )
        .await;

        let ToggleOutcome::Changed(frame) = outcome else {
            panic!("a toggle must answer the authoritative rows");
        };
        let rows = frame["skills"].as_array().expect("the skill rows");
        assert_eq!(rows.len(), 3);
        let alpha = rows
            .iter()
            .find(|row| row["name"] == "alpha")
            .expect("the alpha row");
        assert_eq!(alpha["enabled"], Value::Bool(false));
        let settings =
            std::fs::read_to_string(project_settings_path(&repo)).expect("the written settings");
        assert!(settings.contains("\"alpha\""), "{settings}");
    }

    /// A toggle and a delete both read-modify-write the whole settings document.
    /// The guard must hold across each pair, so an entry one of them writes
    /// while the other is between its read and its write is never lost.
    #[tokio::test]
    async fn an_overlapping_toggle_and_delete_keep_both_entries() {
        let path = settings_fixture("both-entries");
        std::fs::write(
            &path,
            r#"{
  "skills": {
    "ignoredSkills": [
      "alpha",
      "gone"
    ]
  }
}
"#,
        )
        .expect("a settings fixture");

        let guard = settings_lock().lock().await;
        let toggle = {
            let path = path.clone();
            tokio::spawn(async move { write_skill_exclusion(&path, "beta", false).await })
        };
        let removal = {
            let path = path.clone();
            tokio::spawn(async move { remove_skill_exclusion(&path, "gone").await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !toggle.is_finished(),
            "a toggle must wait for the settings guard"
        );
        assert!(
            !removal.is_finished(),
            "a delete must wait for the settings guard"
        );
        drop(guard);

        assert_eq!(
            toggle.await.expect("the toggle task"),
            Ok(SkillExclusionWrite::Written)
        );
        assert_eq!(
            removal.await.expect("the delete task"),
            Ok(SkillExclusionWrite::Written)
        );
        let document = read_project_settings(&path).await.expect("the settings");
        assert_eq!(
            project_ignored_skills(&document),
            vec![Value::String("alpha".into()), Value::String("beta".into())]
        );
    }

    /// A deletion whose name the exclusion does not carry writes nothing, so an
    /// enabled skill's deletion leaves the document byte-identical.
    #[tokio::test]
    async fn a_removal_of_an_unlisted_skill_writes_nothing() {
        let path = settings_fixture("unlisted");
        let original = r#"{
  "skills": {
    "ignoredSkills": [
      "alpha"
    ]
  }
}
"#;
        std::fs::write(&path, original).expect("a settings fixture");

        assert_eq!(
            remove_skill_exclusion(&path, "gone").await,
            Ok(SkillExclusionWrite::Unchanged)
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("the settings file"),
            original
        );
    }
}
