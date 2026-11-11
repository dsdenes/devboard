//! The runtime boundary check: no dashboard process executes JavaScript or
//! TypeScript, so no shipped runtime source may import `bun` or a `node:`
//! module. Test fixtures and the client build and test tooling are the
//! exceptions.
//!
//! A violation is decided by the statement's module specifier, never by the
//! line the statement starts on, so a formatter-wrapped
//! `import {\n  x,\n} from "node:fs";` is reported exactly as its one-line
//! form is.

use std::path::{Path, PathBuf};

/// Directories whose contents are exempt.
const EXEMPT_DIRECTORIES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "client",
    "contract",
    "tests",
    "crates",
    ".test-tmp",
    ".tmp",
    ".work",
    ".worktree",
    ".storybook",
    // The harness's test and build tooling runs under Bun by design.
    "e2e",
    "scripts",
];

/// Files that are client build tooling rather than runtime code.
const EXEMPT_FILES: &[&str] = &["vite.config.ts", "svelte.config.js", "tsconfig.json"];

/// One forbidden import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub path: PathBuf,
    pub line: usize,
    pub text: String,
}

impl Violation {
    pub fn describe(&self) -> String {
        format!("{}:{}: {}", self.path.display(), self.line, self.text)
    }
}

/// Every forbidden runtime import under one harness root.
pub fn violations(harness_root: &Path) -> Vec<Violation> {
    let mut found = Vec::new();
    visit(harness_root, harness_root, &mut found);
    found.sort_by(|left, right| left.path.cmp(&right.path).then(left.line.cmp(&right.line)));
    found
}

fn visit(root: &Path, directory: &Path, found: &mut Vec<Violation>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            if EXEMPT_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            visit(root, &path, found);
            continue;
        }
        if EXEMPT_FILES.contains(&name.as_str()) {
            continue;
        }
        let extension = path.extension().and_then(|value| value.to_str());
        if !matches!(extension, Some("ts" | "mjs" | "js" | "svelte")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let relative = path.strip_prefix(root).unwrap_or(&path);
        for (line, statement) in forbidden_imports(&text) {
            found.push(Violation {
                path: relative.to_path_buf(),
                line,
                text: statement,
            });
        }
    }
}

/// Whether one module specifier reaches Node or Bun.
fn forbidden(specifier: &str) -> bool {
    specifier == "bun" || specifier.starts_with("bun:") || specifier.starts_with("node:")
}

/// Every forbidden import in one source file as its keyword line and its
/// statement text with whitespace collapsed.
fn forbidden_imports(source: &str) -> Vec<(usize, String)> {
    let mut scanner = Scanner {
        text: source,
        bytes: source.as_bytes(),
        index: 0,
        line: 1,
    };
    let mut found = Vec::new();
    loop {
        scanner.skip_trivia();
        let Some(byte) = scanner.peek() else {
            break;
        };
        match byte {
            b'"' | b'\'' | b'`' => scanner.skip_string(),
            b if is_identifier_start(b) => {
                let start = scanner.index;
                let line = scanner.line;
                match scanner.ident() {
                    "import" => scanner.import_statement(start, line, &mut found),
                    "export" => scanner.export_statement(start, line, &mut found),
                    "require" => scanner.require_call(start, line, &mut found),
                    _ => {}
                }
            }
            _ => scanner.advance(),
        }
    }
    found
}

/// A byte scanner that skips comments and string literals, so a specifier is
/// read from code and never from a comment or an unrelated literal.
struct Scanner<'a> {
    text: &'a str,
    bytes: &'a [u8],
    index: usize,
    line: usize,
}

impl<'a> Scanner<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.index).copied()
    }

    fn advance(&mut self) {
        if self.peek() == Some(b'\n') {
            self.line += 1;
        }
        self.index += 1;
    }

    /// Skip whitespace, line comments, and block comments.
    fn skip_trivia(&mut self) {
        loop {
            match (self.peek(), self.bytes.get(self.index + 1).copied()) {
                (Some(byte), _) if byte.is_ascii_whitespace() => self.advance(),
                (Some(b'/'), Some(b'/')) => {
                    while let Some(byte) = self.peek() {
                        self.advance();
                        if byte == b'\n' {
                            break;
                        }
                    }
                }
                (Some(b'/'), Some(b'*')) => {
                    self.advance();
                    self.advance();
                    while let Some(byte) = self.peek() {
                        let close = byte == b'*' && self.bytes.get(self.index + 1) == Some(&b'/');
                        self.advance();
                        if close {
                            self.advance();
                            break;
                        }
                    }
                }
                _ => return,
            }
        }
    }

    /// Skip one quoted string, honouring backslash escapes.
    fn skip_string(&mut self) {
        let Some(quote) = self.peek() else {
            return;
        };
        if !matches!(quote, b'"' | b'\'' | b'`') {
            return;
        }
        self.advance();
        while let Some(byte) = self.peek() {
            if byte == b'\\' {
                self.advance();
                self.advance();
                continue;
            }
            self.advance();
            if byte == quote {
                return;
            }
        }
    }

    /// Read the identifier at the current position.
    fn ident(&mut self) -> &'a str {
        let start = self.index;
        while let Some(byte) = self.peek() {
            if is_identifier_start(byte) || byte.is_ascii_digit() {
                self.advance();
            } else {
                break;
            }
        }
        &self.text[start..self.index]
    }

    /// Read the quoted module specifier at the current position.
    fn specifier(&mut self) -> Option<&'a str> {
        let quote = self.peek()?;
        if quote != b'"' && quote != b'\'' {
            return None;
        }
        self.advance();
        let start = self.index;
        while let Some(byte) = self.peek() {
            if byte == quote {
                let specifier = &self.text[start..self.index];
                self.advance();
                return Some(specifier);
            }
            self.advance();
        }
        None
    }

    fn record(&self, start: usize, line: usize, found: &mut Vec<(usize, String)>) {
        found.push((line, statement_text(self.text, start, self.index)));
    }

    /// Clauses after `import`: a dynamic call, a side-effect import, or a
    /// static clause whose specifier follows `from`.
    fn import_statement(&mut self, start: usize, line: usize, found: &mut Vec<(usize, String)>) {
        self.skip_trivia();
        match self.peek() {
            Some(b'(') => {
                self.advance();
                self.skip_trivia();
                if let Some(specifier) = self.specifier() {
                    if forbidden(specifier) {
                        self.record(start, line, found);
                    }
                }
            }
            Some(b'"' | b'\'') => {
                if let Some(specifier) = self.specifier() {
                    if forbidden(specifier) {
                        self.record(start, line, found);
                    }
                }
            }
            _ => self.specifier_clause(start, line, found),
        }
    }

    /// Clauses after `export`: only a re-export (`export ... from`, `export
    /// type ... from`) carries a module specifier, so an exported declaration
    /// is skipped without scanning its body.
    fn export_statement(&mut self, start: usize, line: usize, found: &mut Vec<(usize, String)>) {
        self.skip_trivia();
        match self.peek() {
            Some(b'{' | b'*') => self.specifier_clause(start, line, found),
            Some(byte) if is_identifier_start(byte) => {
                if self.ident() == "type" {
                    self.skip_trivia();
                    if matches!(self.peek(), Some(b'{' | b'*')) {
                        self.specifier_clause(start, line, found);
                    }
                }
            }
            _ => {}
        }
    }

    /// A `require` call: the specifier is the call's first argument.
    fn require_call(&mut self, start: usize, line: usize, found: &mut Vec<(usize, String)>) {
        self.skip_trivia();
        if self.peek() != Some(b'(') {
            return;
        }
        self.advance();
        self.skip_trivia();
        if let Some(specifier) = self.specifier() {
            if forbidden(specifier) {
                self.record(start, line, found);
            }
        }
    }

    /// Scan forward to the `from` keyword at the clause's top level and read
    /// the specifier that follows it, crossing line breaks the way a wrapped
    /// import does.
    fn specifier_clause(&mut self, start: usize, line: usize, found: &mut Vec<(usize, String)>) {
        let mut depth = 0usize;
        loop {
            self.skip_trivia();
            let Some(byte) = self.peek() else {
                return;
            };
            match byte {
                b'"' | b'\'' | b'`' => self.skip_string(),
                b'{' => {
                    depth += 1;
                    self.advance();
                }
                b'}' if depth > 0 => {
                    depth -= 1;
                    self.advance();
                }
                b';' | b'=' | b'}' if depth == 0 => return,
                b if depth == 0 && is_identifier_start(b) => {
                    if self.ident() == "from" {
                        self.skip_trivia();
                        if let Some(specifier) = self.specifier() {
                            if forbidden(specifier) {
                                self.record(start, line, found);
                            }
                            return;
                        }
                    }
                }
                _ => self.advance(),
            }
        }
    }
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$' || byte >= 0x80
}

/// The statement's source text with every whitespace run collapsed to one
/// space.
fn statement_text(source: &str, start: usize, end: usize) -> String {
    let mut text = String::new();
    let mut pending_space = false;
    for character in source[start..end].chars() {
        if character.is_whitespace() {
            pending_space = !text.is_empty();
            continue;
        }
        if pending_space {
            text.push(' ');
            pending_space = false;
        }
        text.push(character);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runtime_import_is_reported_and_a_fixture_is_not() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("runtime-boundary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("server")).expect("a server dir");
        std::fs::create_dir_all(root.join("contract")).expect("a fixture dir");
        std::fs::write(
            root.join("server/bad.ts"),
            "import { x } from \"node:fs\";\nimport { y } from \"bun\";\nconst z = 1;\n",
        )
        .expect("a runtime file");
        std::fs::write(
            root.join("contract/fixture.ts"),
            "import { x } from \"node:fs\";\n",
        )
        .expect("a fixture");
        let found = violations(&root);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].line, 1);
        assert_eq!(found[1].line, 2);
    }

    #[test]
    fn a_wrapped_import_is_reported_from_its_first_line() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("runtime-boundary-wrapped-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("server")).expect("a server dir");
        std::fs::write(
            root.join("server/wrapped.ts"),
            "import {\n  readFileSync,\n} from \"node:fs\";\n",
        )
        .expect("a wrapped runtime file");
        let found = violations(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 1);
        assert_eq!(found[0].text, "import { readFileSync, } from \"node:fs\"");
    }

    #[test]
    fn a_comment_or_unrelated_literal_names_no_violation() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("runtime-boundary-prose-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("lib")).expect("a lib dir");
        std::fs::write(
            root.join("lib/prose.ts"),
            "// import fs from \"node:fs\";\n\
             /* export * from \"bun\"; */\n\
             export const example = 'import fs from \"node:fs\"';\n",
        )
        .expect("a runtime file");
        assert!(violations(&root).is_empty());
    }

    #[test]
    fn the_harness_tree_imports_no_node_or_bun_module() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let found = violations(&root);
        let report: Vec<String> = found.iter().map(Violation::describe).collect();
        assert!(
            report.is_empty(),
            "shipped runtime source imports Node or Bun:\n{}",
            report.join("\n")
        );
    }
}
