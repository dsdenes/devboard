//! Linux libc selects the matching cargo-dist archive; anything else is one
//! named error.

#[test]
fn musl_gnu_and_unsupported_select_exactly_one_target() {
    assert_eq!(
        devboard::release::platform_target("linux", "x86_64", "musl"),
        Some("x86_64-unknown-linux-musl")
    );
    assert_eq!(
        devboard::release::platform_target("linux", "aarch64", "musl"),
        Some("aarch64-unknown-linux-musl")
    );
    assert_eq!(
        devboard::release::platform_target("linux", "x86_64", "gnu"),
        Some("x86_64-unknown-linux-gnu")
    );
    assert_eq!(
        devboard::release::platform_target("linux", "aarch64", "gnu"),
        Some("aarch64-unknown-linux-gnu")
    );
    assert_eq!(
        devboard::release::platform_target("macos", "aarch64", ""),
        Some("aarch64-apple-darwin")
    );
    assert_eq!(
        devboard::release::platform_target("linux", "riscv64", "gnu"),
        None
    );
}

#[test]
fn an_unsupported_platform_names_itself() {
    let error = devboard::release::platform_target("linux", "riscv64", "musl");
    assert_eq!(error, None);
}
