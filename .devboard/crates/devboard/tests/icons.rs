//! The raster icons are rendered from `favicon.svg` by one generator.

use std::path::{Path, PathBuf};
use std::process::Command;

fn harness_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the crate sits inside the harness")
        .to_path_buf()
}

/// The tab fallback, the iOS home-screen icon, and the binary's embedded
/// copies must all carry the mark `public/favicon.svg` defines. A raster that
/// was hand-edited, or an SVG edit that never reached its rasters, answers
/// `--check` with the stale paths and fails here.
#[test]
fn the_checked_in_icons_match_their_svg_source() {
    let harness = harness_root();
    let generator = harness.join("scripts").join("generate-icons.py");
    let run = Command::new("python3")
        .arg(&generator)
        .arg("--check")
        .current_dir(&harness)
        .output()
        .unwrap_or_else(|error| panic!("python3 {}: {error}", generator.display()));
    assert!(
        run.status.success(),
        "the icons disagree with public/favicon.svg; run `python3 scripts/generate-icons.py` \
         from .devboard and commit the result:\n{}{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr),
    );
}
