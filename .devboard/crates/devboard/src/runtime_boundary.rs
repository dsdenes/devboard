//! The runtime boundary check: no dashboard process executes JavaScript or
//! TypeScript, so no shipped runtime source may import `bun` or a `node:`
//! module. Test fixtures and the client build tooling are the two exceptions.

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
];

/// Files that are client build tooling rather than runtime code.
const EXEMPT_FILES: &[&str] = &[
    "vite.config.ts",
    "svelte.config.js",
    "tsconfig.json",
    "embed-client.mjs",
];

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
        for (index, line) in text.lines().enumerate() {
            let trimmed = line.trim_start();
            let forbidden = trimmed.starts_with("import ")
                || trimmed.starts_with("export ")
                || trimmed.contains("import(");
            if !forbidden {
                continue;
            }
            if trimmed.contains("from \"node:")
                || trimmed.contains("from 'node:")
                || trimmed.contains("from \"bun\"")
                || trimmed.contains("from 'bun'")
                || trimmed.contains("import(\"node:")
                || trimmed.contains("import('node:")
                || trimmed.contains("import(\"bun\"")
                || trimmed.contains("import('bun'")
            {
                found.push(Violation {
                    path: path.strip_prefix(root).unwrap_or(&path).to_path_buf(),
                    line: index + 1,
                    text: line.trim().to_string(),
                });
            }
        }
    }
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
}
