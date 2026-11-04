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
        Some("install") => install_command(&args).await,
        Some("update") => update_command(&args).await,
        Some("doctor") => doctor_command(&args),
        Some("cleanup") => cleanup_command(&args),
        Some("watchdog") => watchdog_command(&args),
        Some("worker") => worker_command(&args).await,
        Some("acp-stub") => devboard::acp_stub::run_stub(&args[1..]),
        Some("mcp") => devboard::mcp_server::run_server().await,
        Some("bench") => bench_command(&args).await,
        Some("publish") => publish_command(&args).await,
        Some("release-suite") => release_suite_command(&args).await,
        Some("check-runtime") => runtime_command(&args),
        Some("gate-prepush") => {
            let code = devboard::commit_gate::gate_prepush().await?;
            std::process::exit(code);
        }
        Some("hooks") => hooks_command(&args),
        Some("preflight") => preflight_command(&args),
        Some("forge-auth") => std::process::exit(devboard::forge_auth::main(&args[1..]).await),
        Some(other) => anyhow::bail!(
            "unknown command {other}; expected serve, version, install, update, doctor, cleanup, watchdog, worker, acp-stub, mcp, bench, publish, release-suite, check-runtime, gate-prepush, hooks, preflight, or forge-auth"
        ),
    }
}

async fn serve_command(args: &[String]) -> anyhow::Result<()> {
    let harness_dir = devboard::version::running_harness_dir();
    // Discovery runs for the repository this dashboard will serve, never for
    // the launcher's working directory.
    let repo_for_discovery = args
        .iter()
        .position(|arg| arg == "--repo-dir")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::var("REPO_DIR").ok().map(PathBuf::from))
        .or_else(|| {
            std::process::Command::new("git")
                .args(["rev-parse", "--show-toplevel"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
        })
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    discover_source_gitea(&repo_for_discovery).await;
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
    // One orphan-reaping pass before this process serves. It never signals a
    // live recorded child and journals the pass and every kill.
    devboard::workers::watchdog::reap_on_startup(&config.state_dir, &config.repo_dir);
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
    let running_version =
        devboard::version::read_harness_version(&devboard::version::running_harness_dir())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let version_marker = serde_json::json!({
        "running": running_version,
        "pid": std::process::id(),
        "port": config.port,
    });
    let marker_path = config.state_dir.join("version.json");
    let _ = devboard::state::write_file_atomically_sync(
        &marker_path,
        &format!("{}\n", serde_json::to_string(&version_marker)?),
    );
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
    server.app.start_complexity();
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

/// Discovers the loopback Gitea origin of a canonical source checkout whose
/// remote is loopback and whose address is not configured. An explicit
/// `DEVBOARD_GITEA_URL` or `GITEA_URL` wins, and an installed prefix never
/// probes.
async fn discover_source_gitea(repo_dir: &std::path::Path) {
    if std::env::var("DEVBOARD_GITEA_URL")
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
        || std::env::var("GITEA_URL")
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return;
    }
    let options = devboard::forge::SourceCheckoutGiteaOptions {
        repo_dir: repo_dir.to_path_buf(),
        environment: std::env::vars().collect(),
        source_checkout: None,
        ports: None,
        timeout_ms: None,
        transport: None,
    };
    if let Some(url) = devboard::forge::source_checkout_gitea_url(&options).await {
        std::env::set_var("DEVBOARD_GITEA_URL", url);
    }
}

/// The parsed `install`/`update` arguments.
struct InstallOptions {
    host: Option<PathBuf>,
    port: Option<u16>,
    force: bool,
}

/// Parses `[host] [--port N] [--force]` without ever treating an option value
/// as the host path.
fn parse_install_options(args: &[String], usage: &str) -> anyhow::Result<InstallOptions> {
    let mut options = InstallOptions {
        host: None,
        port: None,
        force: false,
    };
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--port" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| anyhow::anyhow!("--port needs a number"))?;
                options.port = Some(value.parse::<u16>()?);
                index += 2;
            }
            "--host" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| anyhow::anyhow!("--host needs a path"))?;
                if options.host.is_some() {
                    anyhow::bail!("the host path is given twice; usage: {usage}");
                }
                options.host = Some(PathBuf::from(value));
                index += 2;
            }
            "--force" => {
                options.force = true;
                index += 1;
            }
            "--help" | "-h" => {
                println!("{usage}");
                std::process::exit(0);
            }
            other if other.starts_with('-') => {
                anyhow::bail!("unknown option {other}; usage: {usage}")
            }
            other => {
                if options.host.is_some() {
                    anyhow::bail!("unexpected argument {other}; usage: {usage}");
                }
                options.host = Some(PathBuf::from(other));
                index += 1;
            }
        }
    }
    Ok(options)
}

/// `devboard install [host] [--port N] [--force]`.
///
/// Without `--port` the install writes the host tree and prints the serve
/// command; with `--port` it also starts one dashboard on that port,
/// replacing any previous dashboard for the same host.
async fn install_command(args: &[String]) -> anyhow::Result<()> {
    let options =
        parse_install_options(args, "usage: devboard install [host] [--port N] [--force]")?;
    let report = devboard::cli_install::install(options.host.as_deref(), options.force)?;
    println!(
        "installed {} files for {} at {}",
        report.installed_files,
        report.skills.len(),
        report.host.display()
    );
    for line in &report.gitignore_added {
        println!("gitignore: {line}");
    }
    for line in &report.drift {
        println!("drift: {line} (tracked; left unchanged)");
    }
    if report.removed > 0 {
        println!("removed {} stale file(s)", report.removed);
    }
    match options.port {
        Some(port) => start_dashboard(&report.host, port)?,
        None => println!(
            "run: devboard serve --repo-dir {} --port 8080",
            report.host.display()
        ),
    }
    Ok(())
}

/// `devboard update [host] [--port N]`.
///
/// Installs the newest release into `<host>/.devboard` without a browser
/// click, then leaves one dashboard serving. An already-live dashboard
/// replaces itself from the installed version through its own updater; when
/// none is live, this command starts one.
async fn update_command(args: &[String]) -> anyhow::Result<()> {
    let options = parse_install_options(args, "usage: devboard update [host] [--port N]")?;
    let host = devboard::cli_install::resolve_host(options.host.as_deref())?;
    let source = devboard::updates::manifest_source_from_env(&host.join(".devboard/.tmp"))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "update: set DEVBOARD_GITEA_URL or DEVBOARD_RELEASE_URL so a release can be read"
            )
        })?;
    let release = devboard::release::latest_manifest(&source)
        .await
        .map_err(anyhow::Error::msg)?;
    let prefix = host.join(".devboard");
    let installed = devboard::release::installed_version(&prefix);
    if devboard::release::is_newer_version(&release.version, installed.as_deref()) {
        let version = devboard::release::install_release(
            &source,
            &release,
            &prefix,
            &host.join(".devboard/.tmp"),
        )
        .await
        .map_err(anyhow::Error::msg)?;
        println!("update: installed {version}");
    } else {
        println!(
            "update: {} is current",
            installed.as_deref().unwrap_or("unknown")
        );
    }
    let report = devboard::cli_install::install(Some(&host), false)?;
    for line in &report.drift {
        println!("drift: {line} (tracked; left unchanged)");
    }
    let marker = host.join(".devboard").join(".tmp").join("version.json");
    let recorded_live = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("pid").and_then(|value| value.as_u64()))
        .is_some_and(|pid| devboard::supervision::live_process(pid as u32));
    let live = devboard::mcp_server::discover_dashboards(&host);
    if recorded_live {
        println!("update: the dashboard is already serving; it replaces itself from the installed version");
    } else if live.is_empty() {
        let port = options.port.unwrap_or(8080);
        start_dashboard(&host, port)?;
    } else {
        println!(
            "update: {} dashboard(s) already serving; they replace themselves from the installed version",
            live.len()
        );
    }
    Ok(())
}

/// Starts exactly one dashboard for `host` on `port`, replacing a previous
/// dashboard for the same host.
fn start_dashboard(host: &std::path::Path, port: u16) -> anyhow::Result<()> {
    use std::process::{Command, Stdio};

    // The dashboard's own version marker is the exact record for this host,
    // including a fixture path the `/proc` discovery deliberately ignores.
    let marker = host.join(".devboard").join(".tmp").join("version.json");
    if let Ok(text) = std::fs::read_to_string(&marker) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            let pid = value
                .get("pid")
                .and_then(|value| value.as_u64())
                .unwrap_or(0) as u32;
            let recorded_port = value
                .get("port")
                .and_then(|value| value.as_u64())
                .unwrap_or(0) as u16;
            if pid != 0 && devboard::supervision::live_process(pid) {
                if recorded_port == port {
                    println!(
                        "devboard: dashboard already serving http://127.0.0.1:{port} (pid {pid})"
                    );
                    return Ok(());
                }
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                while devboard::supervision::live_process(pid)
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
    }

    for dashboard in devboard::mcp_server::discover_dashboards(host) {
        if dashboard.port == port {
            println!(
                "devboard: dashboard already serving http://127.0.0.1:{port} (pid {})",
                dashboard.pid
            );
            return Ok(());
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(dashboard.pid as i32, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while devboard::supervision::live_process(dashboard.pid)
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    let program = host.join(".devboard").join("bin").join("devboard");
    let program = if program.is_file() {
        program
    } else {
        devboard::relaunch::own_program()
    };
    let mut command = Command::new(&program);
    command
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .arg("--repo-dir")
        .arg(host)
        .env("REPO_DIR", host)
        .env("PORT", port.to_string())
        .env("STATE_DIR", host.join(".devboard").join(".tmp"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let child = command
        .spawn()
        .map_err(|error| anyhow::anyhow!("could not start the dashboard: {error}"))?;
    println!(
        "devboard: dashboard on http://127.0.0.1:{port} (pid {})",
        child.id()
    );
    Ok(())
}

/// `devboard cleanup [--dry-run] [--once] [--root <dir>] [--json]`.
///
/// Sweeps every covered state directory with the documented retention
/// exceptions. `--dry-run` prints candidates and changes nothing; `--once`
/// deletes them.
fn cleanup_command(args: &[String]) -> anyhow::Result<()> {
    let mut dry_run = false;
    let mut once = false;
    let mut json = false;
    let mut root: Option<PathBuf> = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--dry-run" => {
                dry_run = true;
                index += 1;
            }
            "--once" => {
                once = true;
                index += 1;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            "--root" => {
                root =
                    Some(PathBuf::from(args.get(index + 1).ok_or_else(|| {
                        anyhow::anyhow!("--root needs a directory")
                    })?));
                index += 2;
            }
            "--help" | "-h" => {
                println!("usage: devboard cleanup [--dry-run] [--once] [--root <dir>] [--json]");
                return Ok(());
            }
            other => anyhow::bail!("unknown cleanup option {other}"),
        }
    }
    if !dry_run && !once {
        anyhow::bail!("cleanup needs --dry-run or --once");
    }
    if dry_run && once {
        anyhow::bail!("--dry-run and --once are exclusive");
    }
    let root = match root {
        Some(path) => std::fs::canonicalize(&path)
            .map_err(|_| anyhow::anyhow!("cleanup: {} does not exist", path.display()))?,
        None => {
            let output = std::process::Command::new("git")
                .args(["rev-parse", "--show-toplevel"])
                .output()?;
            if !output.status.success() {
                anyhow::bail!("cleanup: run inside a git checkout or pass --root");
            }
            PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
        }
    };
    let instances = devboard::workers::watchdog::discover_instances();
    let report = devboard::workers::watchdog::run_cleanup(
        &root,
        devboard::workers::watchdog::epoch_ms(),
        dry_run,
        &instances,
        None,
        None,
    );
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&devboard::workers::watchdog::cleanup_report_json(
                &report
            ))
            .unwrap_or_default()
        );
        return Ok(());
    }
    for entry in &report.roots {
        for candidate in &entry.candidates {
            println!(
                "cleanup: {} {} ({} byte(s))",
                if dry_run { "would remove" } else { "removed" },
                candidate.path.display(),
                candidate.bytes
            );
        }
        for candidate in &entry.removed {
            if dry_run {
                continue;
            }
            println!(
                "cleanup: removed {} ({} byte(s))",
                candidate.path.display(),
                candidate.bytes
            );
        }
        for error in &entry.errors {
            eprintln!("cleanup: {}: {error}", entry.state_dir.display());
        }
    }
    let roots = report.roots.len();
    let files: u64 = report.roots.iter().map(|entry| entry.files).sum();
    let bytes: u64 = report.roots.iter().map(|entry| entry.bytes).sum();
    println!(
        "cleanup: {roots} state director{} · {files} file(s) · {bytes} byte(s){}",
        if roots == 1 { "y" } else { "ies" },
        if dry_run { " (dry run)" } else { "" }
    );
    Ok(())
}

/// `devboard watchdog uninstall`: stop, disable, and remove the legacy
/// systemd unit and timer. Repository files are never touched.
fn watchdog_command(args: &[String]) -> anyhow::Result<()> {
    match args.get(1).map(String::as_str) {
        Some("uninstall") => {
            if args.iter().any(|arg| arg == "--help" || arg == "-h") {
                println!("usage: devboard watchdog uninstall");
                return Ok(());
            }
            devboard::workers::watchdog::uninstall_legacy_units();
            Ok(())
        }
        Some(other) => anyhow::bail!("unknown watchdog command {other}; expected uninstall"),
        None => anyhow::bail!("usage: devboard watchdog uninstall"),
    }
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
    for dashboard in &report.dashboards {
        println!(
            "dashboard: host={} port={} pid={} running={} installed={} stale={}",
            dashboard.host.display(),
            dashboard.port,
            dashboard.pid,
            dashboard.running.as_deref().unwrap_or("unknown"),
            dashboard.installed.as_deref().unwrap_or("unknown"),
            dashboard.stale
        );
    }
    println!(
        "dashboards: {} live; source-refresh written {}; failed {}",
        report.dashboards.len(),
        report.source_refresh.written.len(),
        report.source_refresh.failed.len()
    );
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

/// `devboard release-suite [--dir <workspace>] [--repo <dir>]`.
///
/// Runs the workspace suite with retries and a quarantine, files one issue per
/// skipped test, and exits with the suite's verdict.
async fn release_suite_command(args: &[String]) -> anyhow::Result<()> {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut repo_dir: Option<PathBuf> = None;
    let mut index = 1;
    while index < args.len() {
        let value = args.get(index + 1).cloned();
        match args[index].as_str() {
            "--dir" => dir = PathBuf::from(value.context("--dir needs a path")?),
            "--repo" => repo_dir = Some(PathBuf::from(value.context("--repo needs a path")?)),
            "--help" | "-h" => {
                println!("usage: devboard release-suite [--dir <workspace>] [--repo <dir>]");
                return Ok(());
            }
            other => anyhow::bail!("unknown release-suite option {other}"),
        }
        index += 2;
    }
    if !dir.is_dir() {
        anyhow::bail!("the suite directory {} does not exist", dir.display());
    }
    let mut options = devboard::release_suite::ReleaseSuiteOptions::new(dir);
    options.forge_dir = repo_dir;
    options.log = Some(std::sync::Arc::new(|line: &str| println!("{line}")));
    let report = devboard::release_suite::run_suite(options).await?;
    if report.code != 0 {
        std::process::exit(report.code);
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
