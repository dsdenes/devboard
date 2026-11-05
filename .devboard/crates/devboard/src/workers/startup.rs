//! The versioned-state startup path every background family shares.
//!
//! A worker publishes its state under `<state>/<family>/<repo>/workers/<version>/state.json`
//! and older harnesses published one unversioned `state.json` beside that tree. A
//! starting worker inherits the newest published state: its own versioned file when
//! it has one, otherwise the file with the newest `updatedAt` among every other
//! version's file and the legacy file. Reading the legacy file first would hand a
//! freshly installed version a stale cadence anchor, run id, and limits.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// `<directory>/state.json` for every version directory that publishes one.
pub fn versioned_state_files(directories: &[PathBuf]) -> Vec<PathBuf> {
    directories
        .iter()
        .map(|directory| directory.join("state.json"))
        .filter(|path| path.is_file())
        .collect()
}

/// The state file a starting worker inherits.
///
/// `own` wins whenever it exists, whatever any other timestamp says. Otherwise the
/// candidates are the other versioned files and the legacy file, and the newest
/// `updatedAt` wins; a file without a readable `updatedAt` is not a candidate.
pub fn inherited_state_path(own: &Path, versioned: &[PathBuf], legacy: &Path) -> Option<PathBuf> {
    if own.is_file() {
        return Some(own.to_path_buf());
    }
    let mut newest: Option<(i64, &Path)> = None;
    for path in versioned
        .iter()
        .map(PathBuf::as_path)
        .filter(|path| *path != own)
        .chain(std::iter::once(legacy))
    {
        let Some(updated_at) = published_updated_at(path) else {
            continue;
        };
        let better = match newest {
            None => true,
            Some((newest_at, newest_path)) => (updated_at, path) > (newest_at, newest_path),
        };
        if better {
            newest = Some((updated_at, path));
        }
    }
    newest.map(|(_, path)| path.to_path_buf())
}

/// One published state's `updatedAt`, in milliseconds.
fn published_updated_at(path: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    instant_millis(parsed.get("updatedAt")?.as_str()?)
}

/// Milliseconds since the epoch for an ISO-8601 instant; `None` when the text is
/// not one. Only ordering matters here, so an unreadable instant is skipped.
fn instant_millis(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let number = |start: usize, end: usize| -> Option<i64> {
        let slice = text.get(start..end)?;
        if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        slice.parse().ok()
    };
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if bytes[10] != b'T' && bytes[10] != b' ' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    let mut index = 19;
    let mut millis = 0i64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        let digits = text.get(start..index)?;
        if digits.is_empty() {
            return None;
        }
        let mut padded: String = digits.chars().take(3).collect();
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded.parse().ok()?;
    }
    let mut offset_minutes = 0i64;
    match bytes.get(index) {
        None | Some(b'Z') | Some(b'z') => {}
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            let hours = number(index + 1, index + 3)?;
            let minutes = if bytes.get(index + 3) == Some(&b':') {
                number(index + 4, index + 6)?
            } else {
                number(index + 3, index + 5)?
            };
            offset_minutes = sign * (hours * 60 + minutes);
        }
        _ => return None,
    }
    let days = days_from_civil(year, month, day);
    Some(
        days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis
            - offset_minutes * 60_000,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_state_file(path: &Path, updated_at: &str) {
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
        std::fs::write(path, format!("{{\"updatedAt\": \"{updated_at}\"}}\n")).expect("a state");
    }

    #[test]
    fn the_newest_updated_at_wins_and_the_own_file_always_wins() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(".test-tmp")
            .join(format!("startup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let own = base.join("workers/own/state.json");
        let older = base.join("workers/older/state.json");
        let newer = base.join("workers/newer/state.json");
        let legacy = base.join("state.json");
        write_state_file(&older, "2026-01-01T00:00:00.000Z");
        write_state_file(&newer, "2026-01-03T00:00:00.000Z");
        write_state_file(&legacy, "2026-01-02T00:00:00.000Z");
        let versioned = vec![own.clone(), older, newer.clone()];
        assert_eq!(inherited_state_path(&own, &versioned, &legacy), Some(newer));
        write_state_file(&own, "2025-01-01T00:00:00.000Z");
        assert_eq!(inherited_state_path(&own, &versioned, &legacy), Some(own));
        std::fs::remove_dir_all(&base).expect("the fixture is removed");
    }

    #[test]
    fn an_instant_orders_by_its_offset() {
        assert_eq!(
            instant_millis("2026-01-01T00:00:00.000Z"),
            instant_millis("2026-01-01T01:00:00.000+01:00")
        );
        assert!(
            instant_millis("2026-01-01T00:00:00.500Z").unwrap()
                > instant_millis("2026-01-01T00:00:00Z").unwrap()
        );
        assert_eq!(instant_millis("not an instant"), None);
    }
}
