//! The transient slice and scope properties the resource governor emits.
//!
//! These are pure argument-builder tests: they never start a unit or rewrite a
//! live slice, so they run on every host that compiles the workspace.

use devboard::resources::{io_weight_from, scope_property_arguments, Settings, DEFAULT_IO_WEIGHT};

#[test]
fn io_weight_defaults_to_ten_and_accepts_an_override() {
    assert_eq!(DEFAULT_IO_WEIGHT, 10);
    assert_eq!(io_weight_from(None), 10);
    assert_eq!(io_weight_from(Some("  ")), 10);
    assert_eq!(io_weight_from(Some("25")), 25);
    // A value the kernel would reject keeps the default instead.
    assert_eq!(io_weight_from(Some("0")), 10);
    assert_eq!(io_weight_from(Some("10001")), 10);
    assert_eq!(io_weight_from(Some("heavy")), 10);
}

#[test]
fn the_environment_override_is_read() {
    // This binary's tests are independent; only this one touches the process
    // environment, and the others pass an explicit weight.
    std::env::set_var("DEVBOARD_IO_WEIGHT", "25");
    assert_eq!(devboard::resources::io_weight(), 25);
    std::env::remove_var("DEVBOARD_IO_WEIGHT");
    assert_eq!(devboard::resources::io_weight(), DEFAULT_IO_WEIGHT);
}

#[test]
fn a_transient_scope_carries_the_io_weight_property() {
    let arguments = scope_property_arguments(10, None);
    assert_eq!(arguments, vec!["--property=IOWeight=10".to_string()]);
}

#[test]
fn a_scope_with_a_limit_carries_both_io_and_memory_properties() {
    let limit = Settings {
        max_agent_peers: 2,
        memory_high_mb: 128,
        memory_max_mb: 256,
        memory_reserve_mb: 64,
    };
    let arguments = scope_property_arguments(io_weight_from(Some("25")), Some(limit));
    assert_eq!(
        arguments,
        vec![
            "--property=IOWeight=25".to_string(),
            format!("--property=MemoryHigh={}", 128 * 1024 * 1024),
            format!("--property=MemoryMax={}", 256 * 1024 * 1024),
            "--property=MemorySwapMax=0".to_string(),
        ]
    );
}
