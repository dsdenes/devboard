//! The HTTP table and its recorded cases stay in lockstep.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract")
}

#[test]
fn every_http_table_row_has_a_recording() {
    let directory = corpus().join("http");
    let mut recorded: BTreeMap<String, Value> = BTreeMap::new();
    for entry in std::fs::read_dir(&directory)
        .expect("the HTTP recordings")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("a recording"))
                .expect("valid JSON");
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .expect("a case name")
            .to_string();
        assert_eq!(
            path.file_stem().and_then(|value| value.to_str()),
            Some(name.as_str()),
            "the file name names the case"
        );
        assert!(
            recorded.insert(name.clone(), value).is_none(),
            "one recording per name: {name}"
        );
    }
    let cases = devboard_contract::http_table::all_cases();
    let mut names = std::collections::BTreeSet::new();
    for case in &cases {
        assert!(names.insert(case.name), "one row per name: {}", case.name);
        let recording = recorded
            .get(case.name)
            .unwrap_or_else(|| panic!("{} has a recording", case.name));
        assert_eq!(recording["method"], case.method.as_str());
        assert_eq!(recording["path"], case.path);
        assert_eq!(
            recording["status"].as_u64(),
            Some(u64::from(case.expect_status))
        );
    }
    assert_eq!(recorded.len(), cases.len(), "no extra recording");
}
