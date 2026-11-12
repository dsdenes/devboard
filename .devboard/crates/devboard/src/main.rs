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
        Some("resources") => resources_command(&args[1..]).await,
        Some("instances") => devboard::instances::command(&args[1..]).await,
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
            "unknown command {other}; expected serve, version, install, update, doctor, cleanup, watchdog, worker, resources, instances, acp-stub, mcp, bench, publish, release-suite, check-runtime, gate-prepush, hooks, preflight, or forge-auth"
        ),
    }
}

/// Re-executes this server once without a credential an older harness left in
/// its environment.
///
/// A pre-cutover process started its replacement with the dashboard token in
/// the environment. The new process ignores it, but `/proc/<pid>/environ` is
/// the initial block, so only a fresh `execve` can drop it. The marker keeps a
/// process that already cleaned itself from looping.
fn clear_inherited_credentials() -> anyhow::Result<()> {
    const MARKER: &str = "DEVBOARD_CREDENTIALS_CLEARED";
    if std::env::var_os(MARKER).is_some() {
        return Ok(());
    }
    if devboard::relaunch::inherited_credential_variables().is_empty() {
        return Ok(());
    }
    let args: Vec<String> = std::env::args().collect();
    let repo_dir = args
        .iter()
        .position(|arg| arg == "--repo-dir")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::var("REPO_DIR").ok().map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    let program = devboard::relaunch::harness_program(&repo_dir)
        .map_err(|message| anyhow::anyhow!(message))?;
    let mut command = std::process::Command::new(program);
    command.args(std::env::args_os().skip(1)).env(MARKER, "1");
    devboard::relaunch::drop_obsolete_credential_variables(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        let error = command.exec();
        anyhow::bail!("dropping an inherited dashboard credential: {error}");
    }
    #[cfg(not(unix))]
    {
        let status = command.status()?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

/// A stopping dashboard ends its children, its Discover staging, and its
/// state file before the process goes away.
fn install_signal_shutdown(server: &std::sync::Arc<Server>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let app = std::sync::Arc::clone(&server.app);
        tokio::spawn(async move {
            let mut terminate = signal(SignalKind::terminate()).ok();
            let mut interrupt = signal(SignalKind::interrupt()).ok();
            let wait = async {
                match (&mut terminate, &mut interrupt) {
                    (Some(terminate), Some(interrupt)) => {
                        tokio::select! {
                            _ = terminate.recv() => {}
                            _ = interrupt.recv() => {}
                        }
                    }
                    (Some(terminate), None) => {
                        terminate.recv().await;
                    }
                    (None, Some(interrupt)) => {
                        interrupt.recv().await;
                    }
                    (None, None) => std::future::pending::<()>().await,
                }
            };
            wait.await;
            devboard::app::graceful_shutdown(&app).await;
            std::process::exit(0);
        });
    }
    #[cfg(not(unix))]
    {
        let _ = server;
    }
}

async fn serve_command(args: &[String]) -> anyhow::Result<()> {
    clear_inherited_credentials()?;
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
    let mut repo_dir_supplied = std::env::var_os("REPO_DIR").is_some();
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
                repo_dir_supplied = true;
            }
            "--adrs-dir" => {
                config.adrs_dir = PathBuf::from(value.context("--adrs-dir needs a value")?);
            }
            "--static-dir" => {
                config.static_dir =
                    Some(PathBuf::from(value.context("--static-dir needs a value")?));
            }
            other => anyhow::bail!("unknown serve option {other}"),
        }
        index += 2;
    }
    // The flags are in force now, so the derived defaults are resolved once
    // from the values that actually won: a `--adrs-dir` without `REPO_DIR` or
    // `--repo-dir` moves the repository directory with it, and the goal file
    // follows the final repository directory.
    config.derive_path_defaults(repo_dir_supplied, std::env::var_os("GOAL_FILE").is_some());
    if !config.repo_dir.is_dir() {
        anyhow::bail!(
            "the repository directory {} does not exist",
            config.repo_dir.display()
        );
    }
    // The agent CLI is a startup prerequisite, not a first-Start discovery: a
    // dashboard that cannot spawn its agent fails here, naming the program,
    // before it serves a page whose every run would fail the same way.
    if let Err(message) = config.agent_executable() {
        anyhow::bail!(message);
    }
    std::fs::create_dir_all(&config.state_dir).context("creating the state directory")?;
    // A confirmed replacement answers its own loopback readiness listener
    // until it binds the dashboard port this process still holds. The marker
    // is written before the startup reaping pass, whose process-table scan can
    // take longer than a caller's readiness deadline on a busy host: readiness
    // proves the replacement started and takes the port over, not that every
    // startup step has finished.
    let mut readiness = None;
    if let Ok(ready_file) = std::env::var("DEVBOARD_REPLACEMENT_READY_FILE") {
        if !ready_file.is_empty() {
            let (port, task) = devboard::relaunch::start_readiness_listener()
                .await
                .context("starting the replacement readiness listener")?;
            readiness = Some(task);
            let _ = devboard::relaunch::write_ready_marker(std::path::Path::new(&ready_file), port);
        }
    }
    // One dashboard per host directory. The guard is taken after a confirmed
    // replacement announces readiness — the process it replaces still holds
    // the lock until it exits — and before any listener, state write, or
    // worker. A second start is refused here and never signals the owner.
    let replacement = readiness.is_some();
    std::env::remove_var("DEVBOARD_REPLACEMENT_READY_FILE");
    let guard_owner = devboard::instances::GuardOwner {
        pid: std::process::id(),
        port: config.port,
        repo_dir: devboard::instances::canonical_host_dir(&config.repo_dir)
            .to_string_lossy()
            .into_owned(),
        state_dir: config.state_dir.to_string_lossy().into_owned(),
        started_at: devboard::workers::watchdog::now_iso(),
    };
    let guard = if devboard::instances::fixture_bypass(&config.repo_dir) {
        None
    } else {
        match devboard::instances::acquire_host_guard(&config.repo_dir, replacement, &guard_owner)?
        {
            devboard::instances::GuardAdmission::Acquired(guard) => Some(guard),
            devboard::instances::GuardAdmission::Refused(message) => {
                anyhow::bail!("{message}")
            }
        }
    };
    // Every step below runs before the listener is bound. A bound listener
    // accepts a connection into the kernel backlog, and nothing answers it
    // until this process serves, so a page load that arrives while the
    // dashboard starts must meet a refused connection it retries — never a
    // read that waits out the startup and breaches its budget.
    //
    // The running version is read here because in a source checkout the read
    // spawns git.
    let running_version =
        devboard::version::read_harness_version(&devboard::version::running_harness_dir())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    // One orphan-reaping pass before this process serves. It never signals a
    // live recorded child and journals the pass and every kill. The pass scans
    // the process table, which can outlast a client's budget on a busy host.
    devboard::workers::watchdog::reap_on_startup(&config.state_dir, &config.repo_dir);
    // The governor owns the transient slice before the first client connects,
    // so every child this process starts joins the bounded pool.
    devboard::resources::install_production(&config.state_dir);
    let journal = Journal::open(&config.state_dir, &config.repo_dir, config.port);
    let server = Server::new(config.clone(), journal);
    // Everything below spawns children, and none of them may inherit this
    // instance's port, static root, or the version it was handed: an agent-run
    // server that does looks like this dashboard to publish's inventory.
    devboard::relaunch::forget_instance_environment();
    server.app.start_resource_watcher();
    {
        let app = std::sync::Arc::downgrade(&server.app);
        server.app.set_restart_hook(std::sync::Arc::new(move || {
            let Some(app) = app.upgrade() else {
                return Err("the dashboard is shutting down".to_string());
            };
            app.restart_confirmed()
        }));
    }
    install_signal_shutdown(&server);
    if devboard::version::serves_own_harness(&server.config.repo_dir) {
        server.app.start_source_refresh();
    }
    server.app.start_updater();
    server.app.start_complexity();
    // The version marker and the guard record name the port this process
    // serves on. A configured port is known before the listener is bound, so
    // both are written before it; only an ephemeral port (`--port 0`, used by
    // fixtures) needs the bind first. Nothing but the port resolution then
    // sits between the bind and the serve.
    let marker_path = config.state_dir.join("version.json");
    let configured_port = config.port;
    let record_bound_port = |port: u16| {
        if let Some(guard) = &guard {
            let bound = devboard::instances::GuardOwner {
                port,
                ..guard_owner.clone()
            };
            let _ = guard.record(&bound);
        }
        write_version_marker(&marker_path, &running_version, &guard_owner, port);
    };
    if configured_port != 0 {
        record_bound_port(configured_port);
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
    if let Some(task) = readiness.take() {
        task.abort();
    }
    config.port = listener
        .local_addr()
        .map(|address| address.port())
        .unwrap_or(config.port);
    server.app.set_port(config.port);
    if configured_port == 0 {
        record_bound_port(config.port);
    }
    println!(
        "ADR interface listening on http://{}:{}/",
        config.hostname, config.port
    );
    devboard::http::serve_on(listener, server)
        .await
        .context("serving the dashboard")
}

/// Writes the marker naming the running version, this process, the port it
/// serves on, and the repository it serves.
///
/// The repository and the start instant make the marker attributable on its
/// own: a discovery pass can accept a dashboard whose command line no longer
/// names the harness, and reject a record a recycled pid left behind.
fn write_version_marker(
    path: &std::path::Path,
    running_version: &str,
    owner: &devboard::instances::GuardOwner,
    port: u16,
) {
    let marker = serde_json::json!({
        "running": running_version,
        "pid": std::process::id(),
        "port": port,
        "repoDir": owner.repo_dir,
        "startedAt": owner.started_at,
    });
    let Ok(text) = serde_json::to_string(&marker) else {
        return;
    };
    let _ = devboard::state::write_file_atomically_sync(path, &format!("{text}\n"));
}

/// `devboard worker <family> --repo <dir> --state-dir <dir> ...`.
async fn worker_command(args: &[String]) -> anyhow::Result<()> {
    let invocation = devboard::workers::parse(&args[1..])?;
    devboard::workers::run(&invocation).await
}

/// One `--name value` or `--name=value` option in a CLI argument vector.
fn option_value(args: &[String], name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let prefix = format!("--{name}=");
    let mut index = 0;
    while index < args.len() {
        if let Some(value) = args[index].strip_prefix(&prefix) {
            return Some(value.to_string());
        }
        if args[index] == flag {
            return args.get(index + 1).cloned();
        }
        index += 1;
    }
    None
}

/// `devboard resources <status|admit|stress> --state-dir <dir> ...`.
///
/// `status` prints the live governor view, `admit` asks once (exiting 2 on a
/// deferral), and `stress` drives many starts through the governor for the
/// live proof. All three use the same slot files and slice as the dashboard.
async fn resources_command(args: &[String]) -> anyhow::Result<()> {
    use std::time::Duration;

    let subcommand = args.first().map(String::as_str).unwrap_or("status");
    let state_dir = option_value(args, "state-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".devboard/.tmp"));
    let governor = devboard::resources::install_attached(&state_dir);
    match subcommand {
        "status" => {
            println!("{}", serde_json::to_string_pretty(&governor.status_json())?);
            Ok(())
        }
        "admit" => {
            let label = option_value(args, "label").unwrap_or_else(|| "manual".to_string());
            let kind = option_value(args, "kind").unwrap_or_else(|| "peer".to_string());
            let starter = option_value(args, "starter").unwrap_or_else(|| kind.clone());
            let hold_ms = option_value(args, "hold-ms")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            match governor.try_acquire(&kind, &starter, &label) {
                Ok(slot) => {
                    println!("admitted {}", slot.id());
                    if hold_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(hold_ms)).await;
                    }
                    drop(slot);
                    Ok(())
                }
                Err(reason) => {
                    governor.record_deferral(&kind, &label, &reason);
                    println!("deferred: {}", reason.message());
                    std::process::exit(2);
                }
            }
        }
        "stress" => {
            let count = option_value(args, "count")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(10);
            let hold_ms = option_value(args, "hold-ms")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(3_000);
            let peer = option_value(args, "peer").unwrap_or_else(|| "sleep".to_string());
            let mut argv: Vec<String> = peer.split_whitespace().map(str::to_string).collect();
            if argv.is_empty() {
                anyhow::bail!("--peer names no command");
            }
            argv.push(format!("{:.3}", hold_ms as f64 / 1_000.0));
            let settings = governor.settings();
            let mut pending = count;
            let mut started = 0usize;
            let mut deferred = 0usize;
            let mut max_active = 0usize;
            let mut running: Vec<(devboard::resources::Slot, std::process::Child)> = Vec::new();
            while pending > 0 || !running.is_empty() {
                while pending > 0 {
                    match governor.try_acquire("stress", "Stress", "stress") {
                        Ok(slot) => {
                            let spawn_argv = governor.wrap_argv(argv.clone());
                            let child = std::process::Command::new(&spawn_argv[0])
                                .args(&spawn_argv[1..])
                                .spawn()
                                .with_context(|| format!("starting {}", spawn_argv[0]))?;
                            running.push((slot, child));
                            pending -= 1;
                            started += 1;
                            max_active = max_active.max(running.len());
                        }
                        Err(reason) => {
                            deferred += 1;
                            governor.record_deferral("stress", "stress", &reason);
                            break;
                        }
                    }
                }
                let mut index = 0;
                while index < running.len() {
                    let finished = running[index].1.try_wait().ok().flatten().is_some();
                    if finished {
                        running.remove(index);
                    } else {
                        index += 1;
                    }
                }
                if pending > 0 || !running.is_empty() {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            let report = serde_json::json!({
                "started": started,
                "deferredAttempts": deferred,
                "maxActive": max_active,
                "cap": settings.max_agent_peers,
                "budget": settings.to_json(),
                "live": governor.status_json()["live"].clone(),
            });
            println!("{}", serde_json::to_string_pretty(&report)?);
            if max_active > settings.max_agent_peers as usize {
                anyhow::bail!(
                    "the governor admitted {max_active} active peers above the cap of {}",
                    settings.max_agent_peers
                );
            }
            Ok(())
        }
        other => {
            anyhow::bail!("unknown resources command {other}; expected status, admit, or stress")
        }
    }
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
    devboard::cli_install::refuse_symlinked_prefix(&host)?;
    let source = devboard::updates::manifest_source_from_env(&host.join(".devboard/.tmp"))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "update: set DEVBOARD_GITEA_URL, GITEA_URL, or DEVBOARD_RELEASE_URL so a release can be read"
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
    // The installed binary carries the released payload; it writes the host's
    // commands, extensions, prompts, and skills before this command reports.
    match devboard::cli_install::sync_from_installed_binary(&host) {
        Some(status) if status.success() => {}
        Some(status) => eprintln!(
            "update: the installed binary's install exited with {status}; falling back to this binary's payload"
        ),
        None => {}
    }
    let report = devboard::cli_install::install(Some(&host), true)?;
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

    let state_dir = host.join(".devboard").join(".tmp");
    std::fs::create_dir_all(&state_dir).context("creating the state directory")?;
    // The dashboard's own version marker is the exact record for this host,
    // including a fixture path the `/proc` discovery deliberately ignores.
    let marker = state_dir.join("version.json");
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
                if recorded_port == port && ready_once(recorded_port) {
                    println!(
                        "devboard: dashboard on {} (pid {pid})",
                        dashboard_url(recorded_port)
                    );
                    return Ok(());
                }
                terminate_dashboard(pid);
            }
        }
    }

    for dashboard in devboard::mcp_server::discover_dashboards(host) {
        if dashboard.port == port && ready_once(port) {
            println!(
                "devboard: dashboard on {} (pid {pid})",
                dashboard_url(port),
                pid = dashboard.pid
            );
            return Ok(());
        }
        terminate_dashboard(dashboard.pid);
    }

    let program =
        devboard::relaunch::harness_program(host).map_err(|message| anyhow::anyhow!(message))?;
    let log_path = state_dir.join("dashboard.log");
    let log = std::fs::File::create(&log_path).context("creating the dashboard log")?;
    let mut command = Command::new(&program);
    devboard::relaunch::drop_obsolete_credential_variables(&mut command);
    // The CLI may itself run under an agent shell that inherited a dashboard's
    // instance variables; this start names its own.
    devboard::relaunch::drop_instance_variables(&mut command);
    command
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .arg("--repo-dir")
        .arg(host)
        .env("REPO_DIR", host)
        .env("PORT", port.to_string())
        .env("STATE_DIR", &state_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
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
    let mut child = command
        .spawn()
        .map_err(|error| anyhow::anyhow!("could not start the dashboard: {error}"))?;
    let pid = child.id();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut listening = port;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let detail = tail_of(&log_path);
            anyhow::bail!(
                "the dashboard exited with {status} before it served port {port}: {detail}"
            );
        }
        if let Ok(text) = std::fs::read_to_string(&marker) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                let recorded = value
                    .get("pid")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0) as u32;
                if recorded == pid {
                    if let Some(actual) = value.get("port").and_then(|value| value.as_u64()) {
                        listening = actual as u16;
                    }
                }
            }
        }
        if ready_once(listening) {
            println!(
                "devboard: dashboard on {} (pid {pid})",
                dashboard_url(listening)
            );
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let detail = tail_of(&log_path);
            anyhow::bail!("the dashboard did not serve port {port} in time: {detail}");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn dashboard_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// One `GET /ready` against a loopback listener.
fn ready_once(port: u16) -> bool {
    use std::io::{Read, Write};
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) =
        std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(300))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1_000)));
    let request =
        format!("GET /ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    answer
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "))
}

fn tail_of(path: &std::path::Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| {
            text.lines()
                .rev()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "no diagnostic".to_string())
}

fn terminate_dashboard(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while devboard::supervision::live_process(pid) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
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
    let instances = devboard::workers::watchdog::discover_instances_for(&root);
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
    for candidate in &report.worktrees.candidates {
        if dry_run {
            println!(
                "cleanup: would remove worktree {} ({})",
                candidate.path.display(),
                candidate.kind.as_str()
            );
        }
    }
    for candidate in &report.worktrees.removed {
        println!(
            "cleanup: removed worktree {} ({})",
            candidate.path.display(),
            candidate.kind.as_str()
        );
    }
    for error in &report.worktrees.errors {
        eprintln!("cleanup: worktrees: {error}");
    }
    if let Some(skipped) = &report.worktrees.skipped {
        eprintln!("cleanup: worktrees skipped: {skipped}");
    }
    for candidate in &report.builds.candidates {
        if dry_run {
            println!(
                "cleanup: would remove build {} ({})",
                candidate.path.display(),
                candidate.kind.as_str()
            );
        }
    }
    for candidate in &report.builds.removed {
        println!(
            "cleanup: removed build {} ({})",
            candidate.path.display(),
            candidate.kind.as_str()
        );
    }
    for error in &report.builds.errors {
        eprintln!("cleanup: builds: {error}");
    }
    if let Some(skipped) = &report.builds.skipped {
        eprintln!("cleanup: builds skipped: {skipped}");
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
        "dashboards: {} live; source-refresh written {}; failed {}; skipped {}",
        report.dashboards.len(),
        report.source_refresh.written.len(),
        report.source_refresh.failed.len(),
        report.source_refresh.skipped.len()
    );
    for skip in &report.source_refresh.skipped {
        println!(
            "publish: source refresh skipped for pid {} port {}: harness {} is not this checkout's .devboard",
            skip.pid,
            skip.port,
            skip.harness.display()
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
    if !dir.is_dir() && dir.is_relative() {
        // A harness run from its own directory can name the checkout's
        // harness path the way the repository root sees it.
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(top) = devboard::forge::top_level(&cwd) {
                let candidate = PathBuf::from(top).join(&dir);
                if candidate.is_dir() {
                    dir = candidate;
                }
            }
        }
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

/// `devboard bench --port <n> --iterations <n> --command <name>`, or
/// `devboard bench cpu --scenario <runs-view|all-workers> [--json]
/// [--seconds <n>]`.
async fn bench_command(args: &[String]) -> anyhow::Result<()> {
    if args.get(1).map(String::as_str) == Some("cpu") {
        return bench_cpu_command(args).await;
    }
    let mut port: u16 = 0;
    let mut iterations: u64 = 200;
    let mut command = "getProject".to_string();
    let mut index = usize::from(args.first().map(String::as_str) == Some("bench"));
    while index < args.len() {
        let value = args.get(index + 1).cloned();
        match args[index].as_str() {
            "--port" => port = value.context("--port needs a number")?.parse()?,
            "--iterations" => iterations = value.context("--iterations needs a count")?.parse()?,
            "--command" => command = value.context("--command needs a name")?,
            "--help" | "-h" => {
                println!("usage: devboard bench --port <n> [--iterations <n>] [--command <name>]");
                println!("       devboard bench cpu --scenario <runs-view|all-workers> [--json] [--seconds <n>]");
                return Ok(());
            }
            other => anyhow::bail!("unknown bench option {other}"),
        }
        index += 2;
    }
    let result = devboard::bench::measure(port, iterations, &command).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

/// One idle-cost measurement against a scratch host.
async fn bench_cpu_command(args: &[String]) -> anyhow::Result<()> {
    let mut scenario = "runs-view".to_string();
    let mut seconds: u64 = 0;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let value = args.get(index + 1).cloned();
        match args[index].as_str() {
            "--scenario" => scenario = value.context("--scenario needs a name")?,
            "--seconds" => seconds = value.context("--seconds needs a number")?.parse()?,
            "--json" => {
                json = true;
                index += 1;
                continue;
            }
            "--help" | "-h" => {
                println!("usage: devboard bench cpu --scenario <runs-view|all-workers> [--json] [--seconds <n>]");
                return Ok(());
            }
            other => anyhow::bail!("unknown bench cpu option {other}"),
        }
        index += 2;
    }
    let result = devboard::bench::cpu(&devboard::bench::CpuOptions { scenario, seconds }).await?;
    devboard::bench::print(&result, json);
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
    println!("runtime boundary: no Node or Bun import outside test fixtures and build tooling");
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
