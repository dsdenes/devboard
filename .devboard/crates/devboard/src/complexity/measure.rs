//! Code measurement for the complexity dashboard: a deterministic scanner over
//! application source text.
//!
//! Ported from `.devboard/server/complexity/measure.ts` and extended with the
//! Rust grammar this harness is written in. The rules are the definition every
//! recorded value follows:
//!
//! - comments, strings, character literals, raw strings, and regular
//!   expressions are skipped as single tokens;
//! - a function is a `function` declaration, a method, an arrow whose body is a
//!   brace block (TypeScript and Svelte), or a Rust `fn` and a brace-bodied
//!   closure; its signature is the tokens before that block;
//! - cyclomatic complexity is 1 plus one each for the language's decision
//!   points, counted in the function's own body and never in a nested
//!   function's body;
//! - nesting is the deepest brace block inside the body;
//! - source length is the signature line through the closing brace;
//! - parameters are the top-level comma-separated entries of the parameter
//!   list.

use std::collections::HashMap;

/// The grammar one source file is scanned with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Rust,
    TypeScript,
}

impl Language {
    /// The scanner for one file name: `.rs` is Rust, everything measured is
    /// TypeScript or Svelte.
    pub fn from_name(name: &str) -> Self {
        if name.ends_with(".rs") {
            Self::Rust
        } else {
            Self::TypeScript
        }
    }
}

/// One scanned source token, with the 1-based line it starts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub text: String,
    pub line: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Identifier,
    Keyword,
    Number,
    String,
    Punct,
}

/// The measurements of one function, file-relative.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct FunctionMeasure {
    pub name: String,
    /// The signature's 1-based line.
    pub line: usize,
    /// Signature line through closing brace, inclusive.
    pub lines: usize,
    pub cyclomatic: u64,
    pub nesting: u64,
    pub parameters: u64,
}

/// What one file's tokens contribute to the project-wide duplication count.
#[derive(Clone, Debug, PartialEq)]
pub struct FileMeasureSource {
    pub loc: u64,
    pub functions: Vec<FunctionMeasure>,
    /// A normalized code line to the number of times it occurs in this file.
    pub lines: HashMap<String, u64>,
    pub halstead: HalsteadCounts,
}

/// Halstead operator and operand totals and their distinct counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HalsteadCounts {
    pub operators: u64,
    pub distinct_operators: u64,
    pub operands: u64,
    pub distinct_operands: u64,
}

const KEYWORDS: &[&str] = &[
    "abstract",
    "as",
    "asserts",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "crate",
    "debugger",
    "declare",
    "default",
    "delete",
    "do",
    "dyn",
    "else",
    "enum",
    "export",
    "extends",
    "extern",
    "false",
    "finally",
    "fn",
    "for",
    "from",
    "function",
    "get",
    "if",
    "impl",
    "implements",
    "import",
    "in",
    "infer",
    "instanceof",
    "interface",
    "is",
    "keyof",
    "let",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "namespace",
    "new",
    "null",
    "of",
    "override",
    "private",
    "protected",
    "pub",
    "readonly",
    "ref",
    "return",
    "satisfies",
    "self",
    "set",
    "static",
    "struct",
    "super",
    "switch",
    "this",
    "throw",
    "trait",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "unique",
    "unsafe",
    "use",
    "var",
    "void",
    "where",
    "while",
    "with",
    "yield",
];

/// Punctators from longest to shortest, so one greedy match is exact.
const PUNCTUATORS: &[&str] = &[
    ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??=", ">>>", "..=", "=>",
    "->", "::", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=",
    "%=", "&=", "|=", "^=", "<<", ">>", "**", "..", "+", "-", "*", "/", "%", "<", ">", "=", "!",
    "&", "|", "^", "~", "?", ";", ":", ",", ".", "(", ")", "[", "]", "{", "}", "@", "#", "$",
];

/// A token after which a `/` opens a regular expression, never a division.
const REGEX_PRECEDING_PUNCT: &[&str] = &[
    "(", ")", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">",
    "~", "^", "=>", "??", "&&", "||",
];

const REGEX_PRECEDING_KEYWORDS: &[&str] = &[
    "return",
    "case",
    "typeof",
    "delete",
    "void",
    "in",
    "of",
    "instanceof",
    "new",
    "do",
    "else",
    "yield",
    "await",
    "throw",
];

const TS_DECISION_KEYWORDS: &[&str] = &["if", "for", "while", "do", "catch", "case"];
const TS_DECISION_PUNCT: &[&str] = &["&&", "||", "??"];
const RUST_DECISION_KEYWORDS: &[&str] = &["if", "for", "while", "loop"];
const RUST_DECISION_PUNCT: &[&str] = &["&&", "||", "=>"];

/// The tokens an arrow signature never reaches back past.
const ARROW_SIGNATURE_STOPS: &[&str] = &["=>", "=", ";", "}", "(", ",", "["];

/// The tokens after which a `{` cannot open a function body.
const SIGNATURE_STOPS: &[&str] = &["{", "}", ";", "=>", "=", "(", "[", ","];

/// How far back a signature may reach before the brace is not a function.
const SIGNATURE_WINDOW: usize = 240;

/// A normalized line shorter than this many tokens is never duplication.
const DUPLICATION_MIN_TOKENS: usize = 4;

fn is_identifier_part(value: char) -> bool {
    value.is_ascii_alphanumeric() || value == '_' || value == '$'
}

fn is_identifier_start(value: char) -> bool {
    value.is_ascii_alphabetic() || value == '_' || value == '$'
}

fn token_allowed_after_regex(previous: Option<&Token>) -> bool {
    match previous {
        None => true,
        Some(token) => match token.kind {
            TokenKind::Punct => REGEX_PRECEDING_PUNCT.contains(&token.text.as_str()),
            TokenKind::Keyword => REGEX_PRECEDING_KEYWORDS.contains(&token.text.as_str()),
            _ => false,
        },
    }
}

fn starts_with(chars: &[char], index: usize, text: &str) -> bool {
    let mut cursor = index;
    for character in text.chars() {
        if chars.get(cursor) != Some(&character) {
            return false;
        }
        cursor += 1;
    }
    true
}

/// Splits source text into tokens. Strings, template literals, regular
/// expressions, and comments never contribute their contents: one literal is
/// one token, so braces and operators inside them never move a measurement.
pub fn tokenize(source: &str, language: Language) -> Vec<Token> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens: Vec<Token> = Vec::new();
    let length = chars.len();
    let mut index = 0;
    let mut line = 1;
    while index < length {
        let character = chars[index];
        if character == '\n' {
            line += 1;
            index += 1;
            continue;
        }
        if character.is_whitespace() {
            index += 1;
            continue;
        }
        if character == '/' && chars.get(index + 1) == Some(&'/') {
            while index < length && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if character == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            let mut depth = 1;
            while index < length {
                if chars[index] == '/' && chars.get(index + 1) == Some(&'*') {
                    // Rust block comments nest; scanning them all as one token
                    // is correct for both languages this feature measures.
                    depth += 1;
                    index += 2;
                    continue;
                }
                if chars[index] == '*' && chars.get(index + 1) == Some(&'/') {
                    depth -= 1;
                    index += 2;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                if chars[index] == '\n' {
                    line += 1;
                }
                index += 1;
            }
            continue;
        }
        if language == Language::TypeScript
            && character == '<'
            && starts_with(&chars, index, "<!--")
        {
            let mut cursor = index + 4;
            while cursor < length && !starts_with(&chars, cursor, "-->") {
                if chars[cursor] == '\n' {
                    line += 1;
                }
                cursor += 1;
            }
            index = if cursor < length { cursor + 3 } else { length };
            continue;
        }
        if let Some(end) = raw_string_end(&chars, index, language) {
            tokens.push(Token {
                kind: TokenKind::String,
                text: chars[index..end].iter().collect(),
                line,
            });
            index = end;
            continue;
        }
        if character == '"'
            || (language == Language::TypeScript && (character == '\'' || character == '`'))
        {
            let start_line = line;
            let quote = character;
            let start = index;
            index += 1;
            while index < length {
                let current = chars[index];
                if current == '\\' {
                    if chars.get(index + 1) == Some(&'\n') {
                        line += 1;
                    }
                    index += 2;
                    continue;
                }
                if current == '\n' {
                    line += 1;
                    index += 1;
                    // A single- and double-quoted string never spans a line;
                    // ending it here keeps one stray quote from swallowing the
                    // rest of the file. A template literal does span lines.
                    if quote != '`' {
                        break;
                    }
                    continue;
                }
                if current == quote {
                    index += 1;
                    break;
                }
                index += 1;
            }
            tokens.push(Token {
                kind: TokenKind::String,
                text: chars[start..index].iter().collect(),
                line: start_line,
            });
            continue;
        }
        if language == Language::Rust && character == '\'' {
            if let Some(end) = char_literal_end(&chars, index) {
                tokens.push(Token {
                    kind: TokenKind::String,
                    text: chars[index..end].iter().collect(),
                    line,
                });
                index = end;
                continue;
            }
            // A lifetime tick (`'a`, `'static`) is not a literal: skip the
            // quote and let the identifier that follows be its own token.
            index += 1;
            continue;
        }
        if language == Language::TypeScript
            && character == '/'
            && token_allowed_after_regex(tokens.last())
        {
            let start_line = line;
            let start = index;
            index += 1;
            let mut in_class = false;
            while index < length {
                let current = chars[index];
                if current == '\\' {
                    index += 2;
                    continue;
                }
                if current == '\n' {
                    break;
                }
                if current == '[' {
                    in_class = true;
                } else if current == ']' {
                    in_class = false;
                } else if current == '/' && !in_class {
                    index += 1;
                    break;
                }
                index += 1;
            }
            while index < length && chars[index].is_ascii_alphabetic() {
                index += 1;
            }
            tokens.push(Token {
                kind: TokenKind::String,
                text: chars[start..index].iter().collect(),
                line: start_line,
            });
            continue;
        }
        let following = chars.get(index + 1).copied().unwrap_or('\0');
        if character.is_ascii_digit() || (character == '.' && following.is_ascii_digit()) {
            let start = index;
            let start_line = line;
            index += 1;
            while index < length {
                let current = chars[index];
                if is_identifier_part(current) || current == '.' {
                    index += 1;
                    continue;
                }
                let previous = chars[index - 1];
                if (current == '+' || current == '-') && (previous == 'e' || previous == 'E') {
                    index += 1;
                    continue;
                }
                break;
            }
            tokens.push(Token {
                kind: TokenKind::Number,
                text: chars[start..index].iter().collect(),
                line: start_line,
            });
            continue;
        }
        if is_identifier_start(character) {
            let start = index;
            let start_line = line;
            while index < length && is_identifier_part(chars[index]) {
                index += 1;
            }
            let text: String = chars[start..index].iter().collect();
            tokens.push(Token {
                kind: if KEYWORDS.contains(&text.as_str()) {
                    TokenKind::Keyword
                } else {
                    TokenKind::Identifier
                },
                text,
                line: start_line,
            });
            continue;
        }
        let mut matched = "";
        for punctuator in PUNCTUATORS {
            if starts_with(&chars, index, punctuator) {
                matched = punctuator;
                break;
            }
        }
        if matched.is_empty() {
            // An unknown character is skipped rather than guessed at.
            index += 1;
            continue;
        }
        tokens.push(Token {
            kind: TokenKind::Punct,
            text: matched.to_string(),
            line,
        });
        index += matched.chars().count();
    }
    tokens
}

/// The index just past one Rust character literal, or `None` for a lifetime.
fn char_literal_end(chars: &[char], index: usize) -> Option<usize> {
    let mut cursor = index + 1;
    if chars.get(cursor) == Some(&'\\') {
        cursor += 1;
        if chars.get(cursor) == Some(&'u') && chars.get(cursor + 1) == Some(&'{') {
            cursor += 2;
            while cursor < chars.len() && chars[cursor] != '}' {
                cursor += 1;
            }
            if cursor >= chars.len() {
                return None;
            }
            cursor += 1;
        } else {
            cursor += 1;
        }
        return (chars.get(cursor) == Some(&'\'')).then_some(cursor + 1);
    }
    let value = *chars.get(cursor)?;
    cursor += 1;
    if value == '\n' || value == '\'' {
        return None;
    }
    (chars.get(cursor) == Some(&'\'')).then_some(cursor + 1)
}

/// The index just past one Rust raw string (`r"…"`, `r#"…"#`, `br#"…"#`),
/// or `None` when the text at `index` is an ordinary identifier.
fn raw_string_end(chars: &[char], index: usize, language: Language) -> Option<usize> {
    if language != Language::Rust {
        return None;
    }
    let mut cursor = index;
    match chars.get(cursor)? {
        'r' => cursor += 1,
        'b' => {
            cursor += 1;
            if chars.get(cursor) == Some(&'r') {
                cursor += 1;
            } else {
                return None;
            }
        }
        _ => return None,
    }
    let mut hashes = 0;
    while chars.get(cursor) == Some(&'#') {
        hashes += 1;
        cursor += 1;
    }
    if chars.get(cursor) != Some(&'"') {
        return None;
    }
    cursor += 1;
    while cursor < chars.len() {
        if chars[cursor] == '"' {
            let mut matched = 0;
            while matched < hashes && chars.get(cursor + 1 + matched) == Some(&'#') {
                matched += 1;
            }
            if matched == hashes {
                return Some(cursor + 1 + hashes);
            }
        }
        cursor += 1;
    }
    Some(chars.len())
}

/// The index of the `open` token matching the `close` token at `index`.
fn matching_open(tokens: &[Token], index: usize, open: &str, close: &str) -> Option<usize> {
    let mut depth = 0i64;
    for cursor in (0..=index).rev() {
        let text = tokens[cursor].text.as_str();
        if text == close {
            depth += 1;
        } else if text == open {
            depth -= 1;
            if depth == 0 {
                return Some(cursor);
            }
        }
    }
    None
}

/// The index of the `<` matching the `>` at `index`, searched only inside the
/// current statement. `;`, `{`, and `}` end the search, so a comparison `>` is
/// never paired with a generic from an earlier function.
fn matching_angle_open(tokens: &[Token], index: usize) -> Option<usize> {
    let mut depth = 0i64;
    for cursor in (0..=index).rev() {
        let text = tokens[cursor].text.as_str();
        if text == ">" {
            depth += 1;
        } else if text == "<" {
            depth -= 1;
            if depth == 0 {
                return Some(cursor);
            }
        } else if text == ";" || text == "{" || text == "}" {
            return None;
        }
    }
    None
}

/// Counts the top-level comma-separated entries between `open` and `close`.
fn parameter_count(tokens: &[Token], open: usize, close: usize) -> u64 {
    let mut entries = 0u64;
    let mut depth = 0i64;
    let mut significant = false;
    let mut cursor = open + 1;
    while cursor < close {
        let text = tokens[cursor].text.as_str();
        if text == "(" || text == "[" || text == "{" {
            depth += 1;
        } else if text == ")" || text == "]" || text == "}" {
            depth -= 1;
        } else if text == "," && depth == 0 {
            entries += 1;
            cursor += 1;
            continue;
        }
        significant = true;
        cursor += 1;
    }
    if !significant {
        0
    } else {
        entries + 1
    }
}

#[derive(Debug)]
struct Signature {
    name: String,
    start_line: usize,
    parameters: u64,
}

/// The identifier a TypeScript signature belongs to, when it is a definition
/// and not a call, a control statement, or a CSS selector.
fn definition_name(tokens: &[Token], open_index: usize) -> Option<(String, usize)> {
    let mut name_index = open_index.checked_sub(1)?;
    // A generic method writes `name<T>(...)`: the name sits before the angle pair.
    if tokens[name_index].text == ">" {
        let angle = matching_open(tokens, name_index, "<", ">")?;
        name_index = angle.checked_sub(1)?;
    }
    let name = tokens.get(name_index)?;
    if name.text != "function" && name.kind != TokenKind::Identifier {
        return None;
    }
    let before = name_index.checked_sub(1).map(|index| &tokens[index]);
    if let Some(before) = before {
        if before.text == "." || before.text == ":" || before.text == "@" || before.text == "?." {
            return None;
        }
    }
    Some((
        if name.text == "function" {
            "function".to_string()
        } else {
            name.text.clone()
        },
        name.line,
    ))
}

/// The identifier a Rust signature belongs to: an identifier whose preceding
/// token is `fn`.
fn definition_name_rust(tokens: &[Token], open_index: usize) -> Option<(String, usize)> {
    let mut name_index = open_index.checked_sub(1)?;
    if tokens[name_index].text == ">" {
        let angle = matching_open(tokens, name_index, "<", ">")?;
        name_index = angle.checked_sub(1)?;
    }
    let name = tokens.get(name_index)?;
    if name.kind != TokenKind::Identifier {
        return None;
    }
    let before = name_index.checked_sub(1).map(|index| &tokens[index])?;
    if before.text != "fn" {
        return None;
    }
    Some((name.text.clone(), name.line))
}

/// A name for an arrow function: its assigned identifier, else `arrow`.
fn arrow_name(tokens: &[Token], signature_start: usize) -> String {
    if let Some(before) = signature_start.checked_sub(1).map(|index| &tokens[index]) {
        if before.text == "=" {
            if let Some(assigned) = signature_start.checked_sub(2).map(|index| &tokens[index]) {
                if assigned.kind == TokenKind::Identifier {
                    return assigned.text.clone();
                }
            }
        }
        if before.text == ":" {
            if let Some(key) = signature_start.checked_sub(2).map(|index| &tokens[index]) {
                if key.kind == TokenKind::Identifier {
                    return key.text.clone();
                }
            }
        }
    }
    "arrow".to_string()
}

/// A name for a closure: its assigned identifier, else `closure`.
fn closure_name(tokens: &[Token], signature_start: usize) -> String {
    let mut before = signature_start.checked_sub(1).map(|index| &tokens[index]);
    if let Some(token) = before {
        if token.text == "move" {
            before = signature_start.checked_sub(2).map(|index| &tokens[index]);
        }
    }
    if let Some(token) = before {
        if token.text == "=" {
            if let Some(assigned) = signature_start.checked_sub(2).map(|index| &tokens[index]) {
                if assigned.kind == TokenKind::Identifier {
                    return assigned.text.clone();
                }
            }
        }
        if token.text == ":" {
            if let Some(key) = signature_start.checked_sub(2).map(|index| &tokens[index]) {
                if key.kind == TokenKind::Identifier {
                    return key.text.clone();
                }
            }
        }
    }
    "closure".to_string()
}

/// The arrow signature ending at the body brace.
fn arrow_signature(tokens: &[Token], brace_index: usize) -> Option<Signature> {
    let mut cursor = brace_index.checked_sub(2)? as isize;
    let mut candidate_index: Option<usize> = None;
    for _ in 0..SIGNATURE_WINDOW {
        if cursor < 0 {
            return None;
        }
        let index = cursor as usize;
        let token = &tokens[index];
        if token.text == ")" {
            let open = matching_open(tokens, index, "(", ")")?;
            return Some(Signature {
                name: arrow_name(tokens, open),
                start_line: tokens[open].line,
                parameters: parameter_count(tokens, open, index),
            });
        }
        if token.text == ">" {
            let angle = matching_open(tokens, index, "<", ">")?;
            cursor = angle as isize - 1;
            continue;
        }
        if token.kind == TokenKind::Identifier {
            candidate_index = Some(index);
        }
        if ARROW_SIGNATURE_STOPS.contains(&token.text.as_str()) {
            break;
        }
        cursor -= 1;
    }
    let candidate = tokens.get(candidate_index?)?;
    Some(Signature {
        name: arrow_name(tokens, candidate_index?),
        start_line: candidate.line,
        parameters: 1,
    })
}

/// The Rust closure signature ending at the body brace (`|a, b| {`).
fn closure_signature(tokens: &[Token], brace_index: usize) -> Option<Signature> {
    let close = brace_index.checked_sub(1)?;
    if tokens[close].text == "||" {
        return Some(Signature {
            name: closure_name(tokens, close),
            start_line: tokens[close].line,
            parameters: 0,
        });
    }
    let mut open = None;
    let mut cursor = close.checked_sub(1)? as isize;
    while cursor >= 0 {
        if tokens[cursor as usize].text == "|" {
            open = Some(cursor as usize);
            break;
        }
        cursor -= 1;
    }
    let open = open?;
    Some(Signature {
        name: closure_name(tokens, open),
        start_line: tokens[open].line,
        parameters: parameter_count(tokens, open, close),
    })
}

/// The signature a `{` at `brace_index` opens, or `None` when it is a block.
fn signature_for(tokens: &[Token], brace_index: usize, language: Language) -> Option<Signature> {
    let previous = tokens.get(brace_index.checked_sub(1)?)?;
    if previous.text == "=>" {
        return if language == Language::TypeScript {
            arrow_signature(tokens, brace_index)
        } else {
            None
        };
    }
    if language == Language::Rust && (previous.text == "|" || previous.text == "||") {
        return closure_signature(tokens, brace_index);
    }
    let mut cursor = brace_index.checked_sub(1)? as isize;
    for _ in 0..SIGNATURE_WINDOW {
        if cursor < 0 {
            return None;
        }
        let index = cursor as usize;
        let token = &tokens[index];
        if token.text == ")" {
            let open = matching_open(tokens, index, "(", ")")?;
            let definition = match language {
                Language::TypeScript => definition_name(tokens, open),
                Language::Rust => definition_name_rust(tokens, open),
            };
            if let Some((name, line)) = definition {
                return Some(Signature {
                    name,
                    start_line: line,
                    parameters: parameter_count(tokens, open, index),
                });
            }
            // A parameter list inside a return type is not this brace's
            // signature: skip the whole group and keep looking behind it.
            cursor = open as isize - 1;
            continue;
        }
        if language == Language::Rust && token.text == ">" {
            // The `>` of a signature's own return type pairs with a `<` in the
            // same statement; a comparison `>` has none behind it before the
            // statement boundary, so the brace is not a function body.
            let angle = matching_angle_open(tokens, index)?;
            cursor = angle as isize - 1;
            continue;
        }
        if SIGNATURE_STOPS.contains(&token.text.as_str()) {
            return None;
        }
        cursor -= 1;
    }
    None
}

/// Whether the token at `index` is a decision point for cyclomatic complexity.
fn is_decision(tokens: &[Token], index: usize, language: Language) -> bool {
    let token = &tokens[index];
    match language {
        Language::TypeScript => {
            if token.kind == TokenKind::Keyword {
                return TS_DECISION_KEYWORDS.contains(&token.text.as_str());
            }
            if token.kind != TokenKind::Punct {
                return false;
            }
            if token.text == "?" {
                // `foo?: T` and `(a?: T)` mark an optional member, never a branch.
                return tokens.get(index + 1).map(|next| next.text.as_str()) != Some(":");
            }
            TS_DECISION_PUNCT.contains(&token.text.as_str())
        }
        Language::Rust => {
            if token.kind == TokenKind::Keyword {
                return RUST_DECISION_KEYWORDS.contains(&token.text.as_str());
            }
            if token.kind != TokenKind::Punct {
                return false;
            }
            if token.text == "||"
                && tokens.get(index + 1).map(|next| next.text.as_str()) == Some("{")
            {
                // A zero-parameter closure's own parameter list is not a
                // short-circuit branch.
                return false;
            }
            RUST_DECISION_PUNCT.contains(&token.text.as_str())
        }
    }
}

#[derive(Debug)]
struct FunctionSpan {
    name: String,
    start_line: usize,
    parameters: u64,
    body_start: usize,
    body_end: isize,
    decisions: u64,
    nesting: u64,
    depth: u64,
}

/// Every function span in one forward pass. A brace stack keeps the innermost
/// open function current, so each decision point lands on the function that
/// owns it and each nesting level lands on the enclosing body.
fn function_spans(tokens: &[Token], language: Language) -> Vec<FunctionSpan> {
    let mut spans: Vec<FunctionSpan> = Vec::new();
    let mut braces: Vec<Option<usize>> = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    for index in 0..tokens.len() {
        let token = &tokens[index];
        if token.text == "{" {
            if let Some(&enclosing) = open.last() {
                spans[enclosing].depth += 1;
                let depth = spans[enclosing].depth;
                spans[enclosing].nesting = spans[enclosing].nesting.max(depth);
            }
            match signature_for(tokens, index, language) {
                Some(signature) => {
                    spans.push(FunctionSpan {
                        name: signature.name,
                        start_line: signature.start_line,
                        parameters: signature.parameters,
                        body_start: index,
                        body_end: -1,
                        decisions: 0,
                        nesting: 0,
                        depth: 0,
                    });
                    let id = spans.len() - 1;
                    open.push(id);
                    braces.push(Some(id));
                }
                None => braces.push(None),
            }
            continue;
        }
        if token.text == "}" {
            if let Some(Some(id)) = braces.pop() {
                spans[id].body_end = index as isize;
                if open.last() == Some(&id) {
                    open.pop();
                }
            }
            if let Some(&enclosing) = open.last() {
                spans[enclosing].depth = spans[enclosing].depth.saturating_sub(1);
            }
            continue;
        }
        if let Some(&innermost) = open.last() {
            if is_decision(tokens, index, language) {
                spans[innermost].decisions += 1;
            }
        }
    }
    spans.retain(|span| span.body_end >= 0);
    spans
}

/// Measured spans in the file's reading order.
fn function_measures(tokens: &[Token], language: Language) -> Vec<FunctionMeasure> {
    let mut spans = function_spans(tokens, language);
    spans.sort_by(|left, right| {
        left.start_line
            .cmp(&right.start_line)
            .then(left.body_start.cmp(&right.body_start))
    });
    spans
        .iter()
        .map(|span| {
            let end_line = tokens
                .get(span.body_end.max(0) as usize)
                .map(|token| token.line)
                .unwrap_or(span.start_line);
            FunctionMeasure {
                name: span.name.clone(),
                line: span.start_line,
                lines: end_line.saturating_sub(span.start_line) + 1,
                cyclomatic: 1 + span.decisions,
                nesting: span.nesting,
                parameters: span.parameters,
            }
        })
        .collect()
}

/// One normalized code line: its tokens joined by single spaces.
fn code_lines(tokens: &[Token]) -> HashMap<usize, String> {
    let mut by_line: HashMap<usize, Vec<&str>> = HashMap::new();
    for token in tokens {
        by_line
            .entry(token.line)
            .or_default()
            .push(token.text.as_str());
    }
    by_line
        .into_iter()
        .map(|(line, parts)| (line, parts.join(" ")))
        .collect()
}

/// The lines long enough to count as duplicated code, not punctuation noise.
fn significant_lines(lines: &HashMap<usize, String>) -> HashMap<String, u64> {
    let mut significant: HashMap<String, u64> = HashMap::new();
    for text in lines.values() {
        if text.split(' ').count() >= DUPLICATION_MIN_TOKENS {
            *significant.entry(text.clone()).or_insert(0) += 1;
        }
    }
    significant
}

/// Halstead operator and operand totals over one file's tokens.
fn halstead(tokens: &[Token]) -> HalsteadCounts {
    let mut operators: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut operands: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut operator_total = 0u64;
    let mut operand_total = 0u64;
    for token in tokens {
        if token.kind == TokenKind::Punct || token.kind == TokenKind::Keyword {
            operators.insert(token.text.as_str());
            operator_total += 1;
            continue;
        }
        operands.insert(token.text.as_str());
        operand_total += 1;
    }
    HalsteadCounts {
        operators: operator_total,
        distinct_operators: operators.len() as u64,
        operands: operand_total,
        distinct_operands: operands.len() as u64,
    }
}

/// Every measurement one file's text carries. Two calls on the same text yield
/// the same values: the scanner has no clock, no randomness, and no I/O.
pub fn measure_source(source: &str, language: Language) -> FileMeasureSource {
    let tokens = tokenize(source, language);
    let lines = code_lines(&tokens);
    let loc = lines.len() as u64;
    FileMeasureSource {
        loc,
        functions: function_measures(&tokens, language),
        lines: significant_lines(&lines),
        halstead: halstead(&tokens),
    }
}

/// Rounds to `digits` decimal places without a floating-point surprise.
pub fn round(value: f64, digits: i32) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let factor = 10f64.powi(digits);
    ((value + f64::EPSILON) * factor).round() / factor
}

/// The maintainability index of one file, clamped to 0-100. The classic 1991
/// formula is Halstead volume, mean cyclomatic complexity, and lines of code;
/// a file without code still measures 100, the cleanest possible result.
pub fn maintainability_index(volume: f64, mean_cyclomatic: f64, loc: u64) -> f64 {
    let code = loc.max(1) as f64;
    let mi = 171.0 - 5.2 * volume.max(1.0).ln() - 0.23 * mean_cyclomatic - 16.2 * code.ln();
    round((mi * 100.0 / 171.0).clamp(0.0, 100.0), 2)
}

/// Halstead volume over the operator and operand counts.
pub fn halstead_volume(counts: &HalsteadCounts) -> f64 {
    let distinct = counts.distinct_operators + counts.distinct_operands;
    let total = counts.operators + counts.operands;
    if distinct <= 1 || total == 0 {
        return 0.0;
    }
    total as f64 * (distinct as f64).log2()
}
