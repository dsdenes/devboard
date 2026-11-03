//! Secret redaction for anything the harness prints or files.

use std::collections::BTreeSet;

use regex::Regex;
use std::sync::OnceLock;

/// Values shorter than this are not secrets worth replacing everywhere.
const MIN_SECRET_LENGTH: usize = 8;

fn secret_name() -> &'static Regex {
    static NAME: OnceLock<Regex> = OnceLock::new();
    NAME.get_or_init(|| {
        Regex::new(r"(?i)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH)").expect("a regex")
    })
}

fn token_shapes() -> &'static [Regex] {
    static SHAPES: OnceLock<Vec<Regex>> = OnceLock::new();
    SHAPES.get_or_init(|| {
        [
            r"gh[pousr]_[A-Za-z0-9_]{20,}",
            r"github_pat_[A-Za-z0-9_]{20,}",
            r"glpat-[A-Za-z0-9_-]{20,}",
            r"npm_[A-Za-z0-9]{20,}",
            r"oc_sk_[A-Za-z0-9_-]{16,}",
            r"sk-or-v1-[A-Za-z0-9_-]{16,}",
            r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]{20,}",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("a token regex"))
        .collect()
    })
}

/// Removes credential-looking environment values, exact supplied secrets, and
/// every known token shape.
pub fn redact_secrets(text: &str, environment: &[(String, String)], secrets: &[String]) -> String {
    let mut values: BTreeSet<String> = secrets.iter().cloned().collect();
    for (name, secret) in environment {
        if secret.len() < MIN_SECRET_LENGTH || !secret_name().is_match(name) {
            continue;
        }
        values.insert(secret.clone());
    }
    let mut ordered: Vec<String> = values
        .into_iter()
        .filter(|secret| secret.len() >= MIN_SECRET_LENGTH)
        .collect();
    ordered.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    let mut value = text.to_string();
    for secret in ordered {
        value = value.replace(&secret, "<redacted>");
    }
    for shape in token_shapes() {
        value = shape.replace_all(&value, "<redacted>").into_owned();
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shapes_and_named_environment_values_are_redacted() {
        let environment = vec![("GITEA_TOKEN".to_string(), "s3cret-value".to_string())];
        let redacted = redact_secrets(
            "used s3cret-value and ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
            &environment,
            &[],
        );
        assert!(!redacted.contains("s3cret-value"));
        assert!(!redacted.contains("ghp_"));
        assert!(redacted.contains("<redacted>"));
    }
}
