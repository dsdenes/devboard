//! The built Svelte client, embedded in the binary so no client tooling ships
//! to a host and a dashboard never serves a bundle from a half-written install.

use include_dir::{include_dir, Dir};

/// The client build. `scripts/embed-client.mjs` refreshes it from `dist` before
/// a release build; the committed copy lets a fresh checkout build and test
/// without Node, Bun, or npm.
static CLIENT: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/assets");

/// The bytes of one static path, or `None` when the build does not carry it.
pub fn lookup(relative: &str) -> Option<&'static [u8]> {
    CLIENT.get_file(relative).map(|file| file.contents())
}
