//! HTTP table comparison against one running dashboard.

use anyhow::Context;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut compare_http: Option<u16> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--compare-http" => {
                compare_http = Some(
                    args.get(index + 1)
                        .context("--compare-http needs a port")?
                        .parse()?,
                );
                index += 2;
            }
            other => anyhow::bail!("unknown option {other}"),
        }
    }
    let Some(port) = compare_http else {
        anyhow::bail!("--compare-http <port> is required");
    };
    let base = format!("http://127.0.0.1:{port}");
    let results = devboard_contract::http_table::run(&base).await;
    let mut failures = 0;
    for result in &results {
        if let Err(error) = result {
            eprintln!("FAIL {error}");
            failures += 1;
        }
    }
    if failures > 0 {
        anyhow::bail!("{failures} HTTP table rows failed against {base}");
    }
    println!(
        "the HTTP table passed against {base} ({} rows)",
        results.len()
    );
    Ok(())
}
