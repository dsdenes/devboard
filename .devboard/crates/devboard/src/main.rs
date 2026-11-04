//! The Devboard command line: serve, install, doctor, and version.

use std::path::PathBuf;

use anyhow::Context;
use devboard::config::Config;
use devboard::http::Server;
use devboard::journal::Journal;

fn main() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("starting the runtime")?;
    runtime.block_on(run())
}

async fn run() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") | None => serve_command(&args).await,
        Some("version") | Some("--version") | Some("-V") => {
            println!("devboard {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("install") => install_command(&args),
        Some("doctor") => doctor_command(&args),
        Some("worker") => worker_command(&args).await,
        Some("acp-stub") => devboard::acp_stub::run_stub(&args[1..]),
        Some("mcp") => devboard::mcp_server::run_server().await,
        Some("bench") => bench_command(&args).await,
        Some("publish") => publish_command(&args).await,
        Some("check-runtime") => runtime_command(&args),
        Some("gate-prepush") => {
            let code = devboard::commit_gate::gate_prepush().await?;
            std::process::exit(code);
        }
        Some("hooks") => hooks_command(&args),
        Some("preflight") => preflight_command(&args),
        Some("forge-auth") => std::process::exit(devboard::forge_auth::main(&args[1..]).await),
        Some(other) => {
            anyhow::bail!("unknown command {other}; expected serve, install, doctor, or version")
        }
    }
}

async fn serve_command(args: &[String]) -> anyhow::Result<()> {
    let harness_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut config = Config::from_env(&harness_dir);
    let mut index = 1;
    while index < args.len() {
        let value = args.get(index + 1);
        match args[index].as_str() {
            "--port" => {
                config.port = value.context("--port needs a value")?.parse()?;
            }
            "--state-dir" => {
                config.state_dir = PathBuf::from(value.context("--state-dir needs a value")?);
            }
            "--repo-dir" => {
                config.repo_dir = PathBuf::from(value.context("--repo-dir needs a value")?);
            }
            "--adrs-dir" => {
                config.addr_dir = PathBuf::from(value.context("--adrs-dir needs a value")?);
            }
            "--static-dir" => {
                config.static_dir =
                    Some(PathBuf::from(value.context("--static-dir needs a value")?));
            }
            "--token" => {
                config.token = value.context("--token needs a value")?.clone();
            }
            other => anyhow::bail!("unknown serve option {other}"),
        }
        index += 2;
    }
    if std::env::var_os("GOAL_FILE").is_none() {
        config.goal_file = config.repo_dir.join("GOAL.md");
    }
    if !devboard::config::valid_token(&config.token) {
        anyhow::bail!(
            "DEVBOARD_DASHBOARD_TOKEN must carry RFC 6750 characters only: no whitespace, ';', or ','."
        );
    }
    if !devboard::config::valid_token(&config.bootstrap) {
        anyhow::bail!(
            "DEVBOARD_BOOTSTRAP_TOKEN must carry RFC 6750 characters only: no whitespace, ';', or ','."
        );
    }
    if !config.repo_dir.is_dir() {
        anyhow::bail!(
            "the repository directory {} does not exist",
            config.repo_dir.display()
        );
    }
    std::fs::create_dir_all(&config.state_dir).context("creating the state directory")?;
    if let Ok(ready_file) = std::env::var("DEVBOARD_REPLACEMENT_READY_FILE") {
        if !ready_file.is_empty() {
            let _ = devboard::relaunch::write_ready_marker(std::path::Path::new(&ready_file));
        }
    }
    let mut listener = None;
    for _attempt in 0..50 {
        match devboard::http::bind(&config.hostname, config.port).await {
            Ok(bound) => {
                listener = Some(bound);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && _attempt < 49 => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(error) => return Err(error).context("binding the dashboard listener"),
        }
    }
    let listener = listener.context("binding the dashboard listener")?;
    config.port = listener
        .local_addr()
        .map(|address| address.port())
        .unwrap_or(config.port);
    let journal = Journal::open(&config.state_dir, &config.repo_dir, config.port);
    let server = Server::new(config.clone(), journal);
    {
        let app = std::sync::Arc::downgrade(&server.app);
        let config = server.config.clone();
        server.app.set_restart_hook(std::sync::Arc::new(move || {
            let settings = devboard::relaunch::RelaunchSettings::from_config(&config);
            devboard::relaunch::relaunch(&settings, None).map_err(|error| error.to_string())?;
            if let Some(app) = app.upgrade() {
                app.shared.shutdown.notify_waiters();
            }
            std::process::exit(0);
        }));
    }
    if devboard::version::is_harness_source_checkout(&server.config.repo_dir) {
        server.app.start_source_refresh();
    }
    server.app.start_updater();
    println!(
        "ADR interface listening on http://{}:{}/?bootstrap={}",
        config.hostname, config.port, config.bootstrap
    );
    devboard::http::serve_on(listener, server)
        .await
        .context("serving the dashboard")
}

/// `devboard worker <family> --repo <dir> --state-dir <dir> ...`.
async fn worker_command(args: &[String]) -> anyhow::Result<()> {
    let invocation = devboard::workers::parse(&args[1..])?;
    devboard::workers::run(&invocation).await
}

/// `devboard install [--force] [host]`.
fn install_command(args: &[String]) -> anyhow::Result<()> {
    let force = args.iter().any(|arg| arg == "--force");
    let host = args
        .iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .map(PathBuf::from);
    let report = devboard::cli_install::install(host.as_deref(), force)?;
    println!(
        "installed {} files for {} at {}",
        report.installed_files,
        report.skills.len(),
        report.host.display()
    );
    for line in &report.gitignore_added {
        println!("gitignore: {line}");
    }
    Ok(())
}

/// `devboard doctor [host]`.
fn doctor_command(args: &[String]) -> anyhow::Result<()> {
    let host = args
        .iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .map(PathBuf::from);
    let report = devboard::cli_install::doctor(host.as_deref())?;
    for failure in &report.failures {
        eprintln!("doctor: {failure}");
    }
    for drift in &report.drift {
        println!("doctor: {drift}");
    }
    if !report.ok() {
        anyhow::bail!("doctor found {} problem(s)", report.failures.len());
    }
    println!("doctor: {} managed skill(s) match", report.skills.len());
    Ok(())
}

/// `devboard publish [--wait-timeout <seconds>] [--repo <dir>]`.
async fn publish_command(args: &[String]) -> anyhow::Result<()> {
    let mut repo_dir = std::env::current_dir()?;
    let mut harness_root: Option<PathBuf> = None;
    let mut wait_seconds: u64 = 1800;
    let mut index = usize::from(args.first().map(String::as_str) == Some("publish"));
    while index < args.len() {
        let value = args.get(index + 1).cloned();
        match args[index].as_str() {
            "--repo" => repo_dir = PathBuf::from(value.context("--repo needs a path")?),
            "--harness" => {
                harness_root = Some(PathBuf::from(value.context("--harness needs a path")?))
            }
            "--wait-timeout" => {
                wait_seconds = value.context("--wait-timeout needs seconds")?.parse()?
            }
            "--help" | "-h" => {
                println!("usage: devboard publish [--wait-timeout <seconds>] [--repo <dir>] [--harness <dir>]");
                return Ok(());
            }
            other => anyhow::bail!("unknown publish option {other}"),
        }
        index += 2;
    }
    let mut args = devboard::publish::PublishArgs::new(repo_dir.clone());
    if let Some(harness) = harness_root {
        args.harness_root = harness;
    }
    args.wait_timeout = std::time::Duration::from_secs(wait_seconds.max(1));
    let report = devboard::publish::publish(args).await?;
    println!("release: v{} is published", report.version);
    println!("release: commit {}", report.commit);
    if let Ok(base) = std::env::var("DEVBOARD_GITEA_URL") {
        println!(
            "release: {}/dsdenes/devboard/releases/tag/v{}",
            base.trim_end_matches('/'),
            report.version
        );
    }
    if !report.source_refresh.failed.is_empty() {
        for failure in &report.source_refresh.failed {
            eprintln!(
                "publish: source refresh for {} failed: {}",
                failure.state_dir.display(),
                failure.error
            );
        }
        anyhow::bail!(
            "the release shipped, but {} dashboard(s) did not receive a source-refresh request",
            report.source_refresh.failed.len()
        );
    }
    Ok(())
}

/// `devboard bench --port <n> --token <t> --iterations <n> --command <name>`.
async fn bench_command(args: &[String]) -> anyhow::Result<()> {
    let mut port: u16 = 0;
    let mut token = String::new();
    let mut iterations: u64 = 200;
    let mut command = "getProject".to_string();
    let mut index = usize::from(args.first().map(String::as_str) == Some("bench"));
    while index < args.len() {
        let value = args.get(index + 1).cloned();
        match args[index].as_str() {
            "--port" => port = value.context("--port needs a number")?.parse()?,
            "--token" => token = value.context("--token needs a value")?,
            "--iterations" => iterations = value.context("--iterations needs a count")?.parse()?,
            "--command" => command = value.context("--command needs a name")?,
            "--help" | "-h" => {
                println!("usage: devboard bench --port <n> --token <t> [--iterations <n>] [--command <name>]");
                return Ok(());
            }
            other => anyhow::bail!("unknown bench option {other}"),
        }
        index += 2;
    }
    let result = devboard::bench::measure(port, &token, iterations, &command).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

/// `devboard check-runtime [harness-root]`: fail on a forbidden runtime import.
fn runtime_command(args: &[String]) -> anyhow::Result<()> {
    let root = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let violations = devboard::runtime_boundary::violations(&root);
    for violation in &violations {
        eprintln!("{}", violation.describe());
    }
    if !violations.is_empty() {
        anyhow::bail!("{} runtime import(s) reach Node or Bun", violations.len());
    }
    println!("runtime boundary: no Node or Bun import outside fixtures and client tooling");
    Ok(())
}

/// `devboard hooks install [--force]`.
fn hooks_command(args: &[String]) -> anyhow::Result<()> {
    match args.get(1).map(String::as_str) {
        Some("install") => {
            let force = args.iter().any(|arg| arg == "--force");
            let report = devboard::commit_gate::hooks_install(force)?;
            println!("{}", report.message());
            Ok(())
        }
        Some(other) => anyhow::bail!("unknown hooks command {other}; expected install"),
        None => anyhow::bail!("usage: devboard hooks install [--force]"),
    }
}

/// `devboard preflight ui-ux [project-root]`.
fn preflight_command(args: &[String]) -> anyhow::Result<()> {
    if args.get(1).map(String::as_str) != Some("ui-ux") {
        anyhow::bail!("usage: devboard preflight ui-ux [project-root]");
    }
    let root = args
        .get(2)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    println!(
        "{}",
        serde_json::to_string_pretty(&devboard::ui_preflight::preflight(&root))?
    );
    Ok(())
}
