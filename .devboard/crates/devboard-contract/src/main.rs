//! HTTP table comparison against one running dashboard, and corpus recording
//! against the fixture dashboard the corpus describes.

use std::path::PathBuf;

use anyhow::Context;

use devboard_contract::http_table::{Allowlist, Corpus};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut compare_http: Option<u16> = None;
    let mut record = false;
    let mut contract: Option<PathBuf> = None;
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
            "--record" => {
                record = true;
                index += 1;
            }
            "--contract" => {
                contract = Some(PathBuf::from(
                    args.get(index + 1)
                        .context("--contract needs a directory")?,
                ));
                index += 2;
            }
            other => anyhow::bail!("unknown option {other}"),
        }
    }
    let contract = contract.unwrap_or_else(|| PathBuf::from("contract"));
    if record && compare_http.is_some() {
        anyhow::bail!("--record and --compare-http are exclusive");
    }
    if record {
        let count = devboard_contract::fixture::record(&contract)
            .await
            .map_err(anyhow::Error::msg)?;
        println!(
            "recorded {count} HTTP rows into {}",
            contract.join("http").display()
        );
        return Ok(());
    }
    let Some(port) = compare_http else {
        anyhow::bail!("--compare-http <port> or --record is required");
    };
    let corpus = Corpus::load(&contract.join("http")).map_err(anyhow::Error::msg)?;
    let allowlist =
        Allowlist::load(&contract.join("allowlist.json")).map_err(anyhow::Error::msg)?;
    // The rows a live dashboard answers the same way the corpus recorded them,
    // plus the goal document and the decision records this checkout names:
    // those two name the served installation, so the comparison reads them
    // here instead of from a recording made over the fixture repository.
    let checkout = devboard_contract::fixture::repository_root();
    let installation = devboard_contract::http_table::Installation {
        goal_file: checkout.join("GOAL.md"),
        adrs_dir: checkout.join("adrs"),
    };
    let base = format!("http://127.0.0.1:{port}");
    let results =
        devboard_contract::http_table::run(&base, &corpus, &allowlist, &installation).await;
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
        "the live HTTP table passed against {base} ({} rows): the rows a served checkout \
         answers as recorded, plus {} and {}",
        results.len(),
        installation.goal_file.display(),
        installation.adrs_dir.display()
    );
    Ok(())
}
