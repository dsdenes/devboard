//! Corpus replay and the HTTP table comparison.

use anyhow::Context;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut corpus = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../contract");
    let mut compare_http: Option<u16> = None;
    let mut play_command: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--corpus" => {
                corpus = PathBuf::from(args.get(index + 1).context("--corpus needs a path")?);
                index += 2;
            }
            "--compare-http" => {
                compare_http = Some(
                    args.get(index + 1)
                        .context("--compare-http needs a port")?
                        .parse()?,
                );
                index += 2;
            }
            "--play-command" => {
                play_command = Some(
                    args.get(index + 1)
                        .context("--play-command needs a name")?
                        .clone(),
                );
                index += 2;
            }
            other => anyhow::bail!("unknown option {other}"),
        }
    }
    if let Some(command) = play_command {
        let corpus = devboard_contract::Corpus::load(&corpus)?;
        let recording = corpus
            .commands
            .iter()
            .find(|recording| recording.command == command)
            .with_context(|| format!("no recording for {command}"))?;
        let mut report = devboard_contract::Report::default();
        devboard_contract::replay_command(
            &corpus,
            recording,
            &devboard::app::is_implemented,
            &mut report,
        )
        .await?;
        println!("{}", serde_json::to_string(&report_to_json(&report))?);
        if !report.mismatches.is_empty() {
            anyhow::bail!("{} scenario(s) diverged", report.mismatches.len());
        }
        return Ok(());
    }
    if let Some(port) = compare_http {
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
        return Ok(());
    }
    let report = devboard_contract::replay_all(&corpus, &devboard::app::is_implemented).await?;
    println!(
        "compared {} scenarios: {} matched, {} mismatched; {} commands unimplemented",
        report.compared,
        report.matched,
        report.mismatches.len(),
        report.unimplemented.len()
    );
    for mismatch in &report.mismatches {
        eprintln!(
            "FAIL {}/{}: {}",
            mismatch.command, mismatch.scenario, mismatch.detail
        );
    }
    if !report.mismatches.is_empty() {
        anyhow::bail!("{} corpus scenarios diverged", report.mismatches.len());
    }
    Ok(())
}

fn report_to_json(report: &devboard_contract::Report) -> serde_json::Value {
    serde_json::json!({
        "compared": report.compared,
        "matched": report.matched,
        "unimplemented": report.unimplemented.iter().collect::<Vec<_>>(),
        "mismatches": report.mismatches.iter().map(|mismatch| serde_json::json!({
            "command": mismatch.command,
            "scenario": mismatch.scenario,
            "detail": mismatch.detail,
        })).collect::<Vec<_>>(),
    })
}
