//! UTF-8 byte budgets. Every size cap the harness reports is a byte count, so
//! truncation measures and cuts in bytes and never splits a code point.

/// One bounded text and whether it was cut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedText {
    pub text: String,
    pub truncated: bool,
}

/// The longest prefix of `bytes` no longer than `budget` bytes that ends on a
/// code point boundary.
fn prefix(bytes: &[u8], budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    if bytes.len() <= budget {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut end = budget;
    let mut lead = end - 1;
    while lead > 0 && (bytes[lead] & 0xc0) == 0x80 {
        lead -= 1;
    }
    let byte = bytes[lead];
    let width = if byte < 0x80 {
        1
    } else if byte >= 0xf0 {
        4
    } else if byte >= 0xe0 {
        3
    } else if byte >= 0xc0 {
        2
    } else {
        1
    };
    if lead + width > budget {
        end = lead;
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// Truncates `text` to at most `max_bytes` UTF-8 bytes, appending `marker` when
/// it cuts. Trailing whitespace is dropped before the marker.
pub fn bound_bytes(text: &str, max_bytes: usize, marker: &str) -> BoundedText {
    let bytes = text.as_bytes();
    if bytes.len() <= max_bytes {
        return BoundedText {
            text: text.to_string(),
            truncated: false,
        };
    }
    let marker_bytes = marker.len();
    if max_bytes < marker_bytes {
        return BoundedText {
            text: prefix(marker.as_bytes(), max_bytes),
            truncated: true,
        };
    }
    let body = prefix(bytes, max_bytes - marker_bytes);
    let body = body.trim_end();
    BoundedText {
        text: format!("{body}{marker}"),
        truncated: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cut_never_splits_a_code_point_or_exceeds_the_budget() {
        let bounded = bound_bytes("héllo wörld", 10, "...");
        assert!(bounded.truncated);
        assert!(bounded.text.len() <= 10);
    }

    #[test]
    fn a_short_text_is_unchanged() {
        let bounded = bound_bytes("short", 10, "...");
        assert_eq!(bounded.text, "short");
        assert!(!bounded.truncated);
    }
}
