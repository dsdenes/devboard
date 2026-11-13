#!/usr/bin/env python3
"""Start, restart, stop, and open the Devboard dashboard for this checkout.

The click target of the desktop icon beside the terminal is the bare
invocation. Every mode shares the same lifecycle:

  --status     print the state and exit 0 only when the dashboard serves
  --start      build and start a dashboard when none serves this checkout
  --restart    rebuild and replace the dashboard that serves this checkout
  --stop       stop the dashboard that serves this checkout
  --open-ui    open the dashboard page, starting the dashboard when needed
  --indicator  run the resident panel indicator that offers these four actions
  (no args)    start or restart, and open the page of a fresh start

A source checkout never runs its own working tree. The lifecycle enumerates
the origin's `v<major>.<minor>.<patch>` tags newest first and selects the first
one whose release is fully published: the public GitHub release manifest for
that tag names exactly its version, and when GitHub is unreachable the Gitea
release manifest for the same tag does. With no such tag nothing is built and
nothing is started, so the stack never runs unpublished code.

The selected tag is checked out in an isolated git worktree under
`.devboard/published/v<version>`, built there with
`cargo build --release -p devboard` from the tag's committed files only, and
the release binary replaces the dashboard that already serves this checkout.
The worktree is reused, never deleted, and lies outside every retention sweep,
so the build the stack runs from cannot be collected. Replacing a dashboard
stops the previous pid and starts the new binary on the same port, and every
step and failure is reported through the desktop's native notification
service.

An installed host starts its own `bin/devboard` and is never rebuilt.
"""

from __future__ import annotations

import argparse
import base64
import filecmp
import json
import math
import os
import re
import shutil
import signal

import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HARNESS = Path(__file__).resolve().parent.parent
REPO = HARNESS.parent
STATE = Path(os.environ.get("STATE_DIR") or (HARNESS / ".tmp"))
PORT = int(os.environ.get("PORT") or 8080)
ICON = HARNESS / "public" / "favicon.svg"
CONTROL_DIR = STATE / "desktop"
LOG = CONTROL_DIR / "launcher.log"
CREDENTIALS = CONTROL_DIR / "credentials.json"
TITLE = "Devboard"
READY_TIMEOUT = 60.0

# Every published release this launcher may run is a worktree of its tag under
# this directory. It sits outside the state directories and `.worktree`, so no
# retention sweep, worktree cleanup, or watchdog pass ever names it, and no
# launcher action deletes a tree here.
PUBLISHED = HARNESS / "published"
MANIFEST_ASSET = "devboard-manifest.json"
# The public download root a GitHub release manifest is read from.
GITHUB_URL = "https://github.com"
RELEASE_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
MANIFEST_TIMEOUT = 20.0
FETCH_TIMEOUT = 300.0
BUILD_TIMEOUT = 3600.0

# The names that describe one live dashboard instance rather than the process
# that carries them. The server resolves each for itself, so nothing this
# launcher starts may inherit one from the shell it ran in.
INSTANCE_VARIABLES = (
    "HOST",
    "PORT",
    "STATIC_DIR",
    "DEVBOARD_RUNNING_VERSION",
    "DEVBOARD_RUNNING_HARNESS_DIR",
    "DEVBOARD_HARNESS_VERSION",
    "DEVBOARD_REPLACEMENT_READY_FILE",
    "DEVBOARD_CREDENTIALS_CLEARED",
    "DEVBOARD_DASHBOARD_TOKEN",
    "DEVBOARD_BOOTSTRAP_TOKEN",
)


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    line = f"{stamp} {message}"
    print(line, flush=True)
    try:
        CONTROL_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def notify(summary: str, body: str, urgency: str = "normal") -> None:
    program = shutil.which("notify-send") or "/usr/bin/notify-send"
    if not Path(program).exists():
        log(f"notification not sent ({program} missing): {summary}: {body}")
        return
    command = [program, "-a", TITLE, "-u", urgency]
    if ICON.is_file():
        command += ["-i", str(ICON)]
    command += [summary, body]
    try:
        subprocess.run(command, check=False, timeout=10, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as error:
        log(f"notification not sent: {error}: {summary}: {body}")


def load_dotenv(path: Path) -> None:
    """Host data at the repository root: values the dashboard reads."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, separator, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if not separator or not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def fresh_token() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")


def credentials() -> dict[str, str]:
    try:
        data = json.loads(CREDENTIALS.read_text(encoding="utf-8"))
        if data.get("token") and data.get("bootstrap"):
            return {"token": str(data["token"]), "bootstrap": str(data["bootstrap"])}
    except (OSError, ValueError):
        pass
    data = {"token": fresh_token(), "bootstrap": fresh_token()}
    write_credentials(data)
    return data


def write_credentials(data: dict[str, str]) -> None:
    try:
        CONTROL_DIR.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(
            CREDENTIALS, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
            handle.write("\n")
    except OSError as error:
        log(f"could not store the launcher credentials: {error}")


def process_env(pid: int) -> dict[str, str]:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return {}
    environment: dict[str, str] = {}
    for entry in raw.split(b"\0"):
        key, separator, value = entry.partition(b"=")
        if separator:
            environment[key.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
    return environment


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_argv(pid: int) -> list[str]:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return []
    return [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]


def executable_name(pid: int) -> str:
    """The file a pid executes, without the suffix a rebuild leaves behind."""
    try:
        linked = os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return ""
    return linked.rsplit("/", 1)[-1].removesuffix(" (deleted)")


def is_dashboard(pid: int) -> bool:
    argv = process_argv(pid)
    if not argv or not any(argument == "serve" for argument in argv[1:]):
        return False
    names = (Path(argv[0]).name, executable_name(pid))
    return any(name in ("devboard", "devboard.exe") for name in names)


def serves_this_checkout(pid: int) -> bool:
    environment = process_env(pid)
    repo = environment.get("REPO_DIR")
    if repo:
        try:
            return Path(repo).resolve() == REPO
        except OSError:
            return False
    try:
        return Path(os.readlink(f"/proc/{pid}/cwd")).resolve() == REPO
    except OSError:
        return False


def version_marker() -> dict:
    try:
        value = json.loads((STATE / "version.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def port_owners(port: int) -> list[int]:
    program = shutil.which("ss") or "/usr/bin/ss"
    if not Path(program).exists():
        return []
    try:
        result = subprocess.run(
            [program, "-H", "-ltnp", f"sport = :{port}"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    owners = []
    for match in re.finditer(r"pid=(\d+)", result.stdout):
        pid = int(match.group(1))
        if pid not in owners:
            owners.append(pid)
    return owners


def running_dashboard() -> tuple[int, int] | None:
    marker = version_marker()
    pid = marker.get("pid")
    port = marker.get("port")
    if isinstance(pid, int) and process_alive(pid) and is_dashboard(pid) and serves_this_checkout(pid):
        return pid, int(port) if isinstance(port, int) else PORT
    for candidate in port_owners(PORT):
        if is_dashboard(candidate) and serves_this_checkout(candidate):
            return candidate, PORT
    return None


def stop_dashboard(pid: int, timeout: float = 15.0) -> bool:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except OSError as error:
        log(f"could not stop pid {pid}: {error}")
        return False
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not process_alive(pid):
            return True
        time.sleep(0.2)
    return not process_alive(pid)


def wait_ready(
    port: int,
    token: str,
    expected_pid: int | None,
    timeout: float,
    process: subprocess.Popen | None = None,
) -> int | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        # A child that already exited never answers; reporting its exit beats
        # waiting out the whole timeout for a readiness that cannot come.
        if process is not None and process.poll() is not None:
            return None
        try:
            request = Request(
                f"http://127.0.0.1:{port}/ready",
                headers={"Authorization": f"Bearer {token}"},
            )
            with urlopen(request, timeout=2) as response:
                body = json.loads(response.read().decode("utf-8"))
            pid = body.get("pid")
            if isinstance(pid, int) and (expected_pid is None or pid == expected_pid):
                return pid
        except (HTTPError, URLError, OSError, ValueError):
            pass
        time.sleep(0.25)
    return None


def first_line(text: str) -> str:
    """The one line of a command's output a notification can carry."""
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def run_git(*arguments: str, cwd: Path | None = None, timeout: float = 120.0):
    """One git command: its exit status and both streams, never raising."""
    try:
        result = subprocess.run(
            ["git", *arguments],
            cwd=str(cwd or REPO),
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return 127, "", str(error)
    return result.returncode, result.stdout, result.stderr


def remote_reference(remote: str) -> tuple[str, str] | None:
    """The host and `owner/repo` path one git remote names, when it names both."""
    code, out, _ = run_git("remote", "get-url", remote)
    url = out.strip()
    if code != 0 or not url:
        return None
    if "://" in url:
        _, rest = url.split("://", 1)
        host, _, path = rest.partition("/")
        host = host.rsplit("@", 1)[-1]
    elif "@" in url and ":" in url:
        host, _, path = url.split("@", 1)[1].partition(":")
    else:
        return None
    host = host.split("/", 1)[0]
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    parts = [part for part in path.split("/") if part]
    if not host or len(parts) < 2:
        return None
    return host, f"{parts[-2]}/{parts[-1]}"


def github_repository() -> str | None:
    """The public GitHub `owner/repo` whose releases prove this checkout."""
    explicit = (os.environ.get("DEVBOARD_RELEASE_REPOSITORY") or "").strip().strip("/")
    if explicit.endswith(".git"):
        explicit = explicit[:-4]
    if explicit:
        return explicit
    for remote in ("github", "origin"):
        reference = remote_reference(remote)
        if reference is not None and reference[0] == "github.com":
            return reference[1]
    return None


def published_manifest_urls(version: str, github: bool = True) -> list[tuple[str, str]]:
    """Every address that can prove one release is fully published, and the
    forge each one reads.

    The public GitHub release is the proof. The Gitea release for the same tag
    is the fallback the caller uses only when GitHub cannot be reached.
    """
    urls: list[tuple[str, str]] = []
    repository = github_repository() if github else None
    if repository:
        urls.append(
            (
                f"{GITHUB_URL.rstrip('/')}/{repository}/releases/download/"
                f"v{version}/{MANIFEST_ASSET}",
                "github",
            )
        )
    gitea = (os.environ.get("DEVBOARD_GITEA_URL") or "").strip().rstrip("/")
    origin = remote_reference("origin")
    if gitea and origin is not None:
        urls.append(
            (
                f"{gitea}/{origin[1]}/releases/download/v{version}/{MANIFEST_ASSET}",
                "gitea",
            )
        )
    return urls


def read_manifest(url: str) -> tuple[dict | None, str, bool]:
    """One manifest read: the document, why it was unusable, and whether the
    forge could not be reached at all."""
    request = Request(url, headers={"Accept": "application/octet-stream"})
    try:
        with urlopen(request, timeout=MANIFEST_TIMEOUT) as response:
            body = response.read()
    except HTTPError as error:
        return None, f"{url} answered HTTP {error.code}", False
    except (URLError, OSError, ValueError) as error:
        return None, f"{url} is unreachable: {getattr(error, 'reason', error)}", True
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        return None, f"{url} is not JSON: {error}", False
    if not isinstance(document, dict):
        return None, f"{url} is not a release manifest", False
    return document, "", False


def release_proof(
    version: str, github: bool = True
) -> tuple[bool, str, bool, bool]:
    """Whether one release is fully published, the concrete reason, whether any
    address gave a verdict, and whether GitHub was unreachable."""
    urls = published_manifest_urls(version, github)
    if not urls:
        return (
            False,
            "no public release address is known for this checkout",
            False,
            False,
        )
    reason = ""
    answered = False
    github_down = False
    for url, forge in urls:
        document, detail, unreachable = read_manifest(url)
        if document is not None:
            named = document.get("version")
            if named == version:
                return True, "", True, github_down
            return (
                False,
                f"{url} names version {named!r}, not {version!r}",
                True,
                github_down,
            )
        reason = detail
        if unreachable:
            # The next address may still prove this same tag.
            github_down = github_down or forge == "github"
            continue
        answered = True
        break
    return False, reason or "no release manifest answered", answered, github_down


def release_tags() -> tuple[list[str], str]:
    """The origin's release tags, newest first, and a failure description."""
    code, _, error = run_git("fetch", "--tags", "--quiet", "origin",
                             timeout=FETCH_TIMEOUT)
    if code != 0:
        return [], f"git fetch --tags origin failed: {first_line(error) or code}"
    code, out, error = run_git("tag", "--list", "v*")
    if code != 0:
        return [], f"the release tags could not be read: {first_line(error)}"

    def order(tag: str) -> tuple[int, int, int]:
        return tuple(int(part) for part in RELEASE_TAG.match(tag).groups())

    tags = [tag for tag in out.split() if RELEASE_TAG.match(tag)]
    tags.sort(key=order, reverse=True)
    return tags, ""


def select_published_tag() -> tuple[str | None, str]:
    """The newest tag whose release is fully published, never HEAD or a branch."""
    tags, error = release_tags()
    if error:
        return None, error
    if not tags:
        return None, "the origin publishes no v<major>.<minor>.<patch> tag"
    reasons = []
    github = True
    for tag in tags:
        version = tag[1:]
        published, detail, answered, github_down = release_proof(version, github)
        if published:
            log(f"release: {tag} is published")
            return version, ""
        log(f"release: skipping {tag}: {detail}")
        reasons.append(f"{tag}: {detail}")
        if github_down:
            # One unreachable public read proves GitHub is down. The Gitea
            # manifest is then the only proof, and no read of GitHub repeats.
            github = False
            if not answered:
                return None, f"{tag}: the release manifest is unreachable: {detail}"
    return None, (
        f"no published release among {len(tags)} tag(s); newest: {reasons[0]}"
    )


def checkout_problem(path: Path, commit: str, tag: str) -> str:
    """Why one tag worktree is not a clean checkout of its commit, or ''."""
    code, head, error = run_git("rev-parse", "HEAD", cwd=path)
    if code != 0:
        return f"{path} is not a git worktree: {first_line(error)}"
    if head.strip() != commit:
        return f"{path} is checked out at {head.strip()[:12]}, not {tag}"
    code, status, error = run_git("status", "--porcelain", cwd=path)
    if code != 0:
        return f"{path} has no readable status: {first_line(error)}"
    if status.strip():
        return f"{path} carries local changes; refusing to build unpublished code"
    return ""


def worktree_for(version: str) -> tuple[Path | None, str, str]:
    """The clean checkout of one release tag, created once and then reused."""
    tag = f"v{version}"
    path = PUBLISHED / tag
    code, out, _ = run_git("rev-parse", "--verify", "--quiet", f"{tag}^{{commit}}")
    commit = out.strip()
    if code != 0 or not commit:
        return None, "", f"this checkout carries no commit for the tag {tag}"
    if path.exists():
        problem = checkout_problem(path, commit, tag)
        if problem:
            return None, "", problem
        log(f"release: reusing {path}")
        return path, commit, ""
    PUBLISHED.mkdir(parents=True, exist_ok=True)
    code, _, error = run_git(
        "worktree", "add", "--detach", str(path), tag, timeout=FETCH_TIMEOUT
    )
    if code != 0:
        return None, "", f"git worktree add {path} failed: {first_line(error) or code}"
    problem = checkout_problem(path, commit, tag)
    if problem:
        return None, "", problem
    log(f"release: checked out {tag} at {path}")
    return path, commit, ""


def build_release(version: str) -> tuple[Path | None, str]:
    """Builds one published tag's harness and names its release binary."""
    worktree, commit, error = worktree_for(version)
    if error or worktree is None:
        return None, error
    harness = worktree / ".devboard"
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo" / "bin" / "cargo")
    if not Path(cargo).is_file():
        return None, "cargo is not on PATH"
    log(f"build: {cargo} build --release -p devboard in {harness}")
    try:
        result = subprocess.run(
            [cargo, "build", "--release", "-p", "devboard"],
            cwd=str(harness),
            check=False,
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return None, f"the build did not run: {error}"
    tail = (result.stdout + result.stderr).strip().splitlines()[-20:]
    for line in tail:
        log(f"build: {line}")
    if result.returncode != 0:
        reason = next(
            (line.strip() for line in reversed(tail) if "error" in line.lower()),
            tail[-1].strip() if tail else "the build failed",
        )
        return None, reason
    binary = harness / "target" / "release" / "devboard"
    if not binary.is_file():
        return None, f"the build produced no binary at {binary}"
    problem = checkout_problem(worktree, commit, f"v{version}")
    if problem:
        return None, problem
    return binary, ""


def install_canonical(binary: Path) -> str:
    """Copies the built release beside the checkout, where the harness reads it."""
    canonical = HARNESS / "target" / "release" / "devboard"
    try:
        canonical.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(binary, canonical)
        os.chmod(canonical, 0o755)
    except OSError as error:
        return f"the release binary could not be copied to {canonical}: {error}"
    try:
        identical = filecmp.cmp(binary, canonical, shallow=False)
    except OSError as error:
        return f"{canonical} could not be compared: {error}"
    if not identical:
        return f"{canonical} differs from {binary}"
    return ""


def prepare_release() -> tuple[str | None, Path | None, str]:
    """The published version, its release binary, and a failure description."""
    version, error = select_published_tag()
    if error or version is None:
        return None, None, error
    notify(TITLE, f"Building Devboard {version} from v{version}…")
    binary, error = build_release(version)
    if error or binary is None:
        return version, None, error
    problem = install_canonical(binary)
    if problem:
        return version, None, problem
    log(f"release: {version} built from v{version} at {binary}")
    return version, binary, ""


def start(binary: Path, tokens: dict[str, str]) -> subprocess.Popen:
    environment = dict(os.environ)
    # The launcher may itself run under a shell that an agent or an older
    # dashboard started. This process names its own port, repo, and version, so
    # none of an instance's own variables may be carried into it.
    for name in INSTANCE_VARIABLES:
        environment.pop(name, None)
    environment["DEVBOARD_DASHBOARD_TOKEN"] = tokens["token"]
    environment["DEVBOARD_BOOTSTRAP_TOKEN"] = tokens["bootstrap"]
    environment.setdefault("ADRS_DIR", str(REPO / "adrs"))
    environment.setdefault("GOAL_FILE", str(REPO / "GOAL.md"))
    command = [
        str(binary),
        "serve",
        "--repo-dir", str(REPO),
        "--port", str(PORT),
        "--state-dir", str(STATE),
    ]
    with open(LOG, "ab") as handle:
        return subprocess.Popen(
            command,
            cwd=str(REPO),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )


def adopt_credentials(pid: int) -> dict[str, str]:
    environment = process_env(pid)
    token = environment.get("DEVBOARD_DASHBOARD_TOKEN")
    bootstrap = environment.get("DEVBOARD_BOOTSTRAP_TOKEN")
    if not token or not bootstrap:
        return credentials()
    data = {"token": token, "bootstrap": bootstrap}
    write_credentials(data)
    return data


def open_page(port: int, bootstrap: str) -> None:
    program = shutil.which("xdg-open")
    if not program:
        return
    url = f"http://127.0.0.1:{port}/?bootstrap={bootstrap}"
    try:
        subprocess.Popen(
            [program, url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        log(f"could not open the dashboard page: {error}")


def fail(summary: str, detail: str) -> int:
    log(f"failed: {detail}")
    notify(summary, detail, "critical")
    return 1


def acquire_lock(path: Path):
    """One launcher at a time: a double click must not race two restarts."""
    import fcntl

    handle = open(path, "a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def sweep_dashboards(binary: Path) -> dict:
    """Keep this host's newest ready dashboard and stop every other one.

    The dashboard's own command does the work: it signals only another
    dashboard of this host directory after probing `/ready`, then reaps the
    children whose owner is gone. A failed or unparseable sweep returns an
    empty report; the readiness check below still runs.
    """
    command = [
        str(binary),
        "instances",
        "sweep",
        "--repo-dir", str(REPO),
        "--state-dir", str(STATE),
    ]
    try:
        result = subprocess.run(
            command,
            cwd=str(REPO),
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (OSError, subprocess.SubprocessError) as error:
        log(f"instances sweep: could not run: {error}")
        return {}
    line = (result.stdout.strip().splitlines() or [""])[-1]
    try:
        report = json.loads(line)
    except ValueError:
        log(
            "instances sweep: exit %s: %s %s"
            % (result.returncode, result.stdout.strip(), result.stderr.strip())
        )
        return {}
    kept = report.get("keptPid")
    stopped = ",".join(str(pid) for pid in report.get("stoppedPids") or []) or "none"
    log(
        "instances sweep: kept %s stopped %s"
        % (kept if kept is not None else "none", stopped)
    )
    return report


def resolve_start() -> tuple[str | None, Path | None, str]:
    """The release version, the binary to start, and a failure description.

    An installed host runs the binary its prefix carries and is never built.
    A source checkout only ever runs a fully published release tag.
    """
    installed = REPO / ".devboard" / "bin" / "devboard"
    if not (HARNESS / "Cargo.toml").is_file():
        if installed.is_file():
            return None, installed, ""
        return None, None, (
            f"no harness source under {HARNESS} and no installed binary"
        )
    return prepare_release()


def run_lifecycle(open_when_started: bool) -> int:
    CONTROL_DIR.mkdir(parents=True, exist_ok=True)
    load_dotenv(REPO / ".env")
    lock = acquire_lock(CONTROL_DIR / "launcher.lock")
    if lock is None:
        log("launcher: another start or restart is already in flight")
        notify(TITLE, "Devboard is already being started or restarted…")
        return 0
    tokens = credentials()
    running = running_dashboard()
    log(
        "launcher: repo=%s harness=%s state=%s port=%s running=%s"
        % (REPO, HARNESS, STATE, PORT, running)
    )
    version, binary, error = resolve_start()
    if error or binary is None:
        return fail(
            "Devboard has no published release to run"
            if version is None
            else f"Devboard {version} release could not be prepared",
            error or "the release could not be prepared",
        )
    notify(
        TITLE,
        f"Replacing the dashboard with Devboard {version}…"
        if version is not None
        else "Starting Devboard…",
    )

    # The build and its publication proof are done; only now may an existing
    # dashboard leave its port.
    sweep_dashboards(binary)
    running = running_dashboard()
    if running is not None:
        old_pid, old_port = running
        tokens = adopt_credentials(old_pid)
        log(f"restart: stopping pid {old_pid} on port {old_port}")
        if not stop_dashboard(old_pid):
            return fail(
                "Devboard is still running",
                f"pid {old_pid} on port {old_port} did not stop",
            )

    process = start(binary, tokens)
    ready = wait_ready(PORT, tokens["token"], process.pid, READY_TIMEOUT, process)
    if ready is None:
        status = process.poll()
        detail = (
            f"the dashboard exited with status {status} before it became ready"
            if status is not None
            else f"the dashboard on port {PORT} never became ready"
        )
        if status is None:
            # A process that never answered /ready must not keep the port.
            stop_dashboard(process.pid)
        return fail(
            f"Devboard {version} did not start" if version else "Devboard did not start",
            f"{detail}; see {LOG}",
        )
    tokens = adopt_credentials(ready)
    served = version_marker().get("running")
    log(f"start: pid {ready} on port {PORT} ({served or 'unknown'})")
    notify(
        "Devboard is running",
        f"Version {served or 'unknown'} · pid {ready} · http://127.0.0.1:{PORT}",
    )
    if version is not None and served != version:
        return fail(
            f"Devboard {version} reports another version",
            f"pid {ready} answers running {served!r}, not {version!r}",
        )
    if open_when_started:
        open_page(PORT, tokens["bootstrap"])
    return 0


# --------------------------------------------------------------------------
# Component commands
# --------------------------------------------------------------------------


def launcher_busy() -> bool:
    """True while another launcher holds the start or restart lock."""
    import fcntl

    try:
        CONTROL_DIR.mkdir(parents=True, exist_ok=True)
        handle = open(CONTROL_DIR / "launcher.lock", "a+", encoding="utf-8")
    except OSError:
        return False
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return True
    handle.close()
    return False


def dashboard_token(pid: int) -> str:
    """The token a running dashboard accepts, without rewriting stored state."""
    token = process_env(pid).get("DEVBOARD_DASHBOARD_TOKEN")
    if token:
        return token
    return credentials()["token"]


def status_report() -> tuple[str, str]:
    """The panel's state and one line of detail. Never builds or restarts."""
    if launcher_busy():
        return "starting", "a build, start, or restart is in flight"
    running = running_dashboard()
    if running is None:
        return "down", "no dashboard serves this checkout"
    pid, port = running
    if wait_ready(port, dashboard_token(pid), pid, 2.0) is None:
        return "degraded", f"pid {pid} on port {port} stopped answering"
    version = version_marker().get("running")
    detail = f"pid {pid} · port {port}"
    if isinstance(version, str) and version:
        detail = f"v{version} · {detail}"
    return "ready", detail


def status_command() -> int:
    state, detail = status_report()
    print(f"{state}: {detail}", flush=True)
    return 0 if state == "ready" else 1


def start_command() -> int:
    state, detail = status_report()
    if state == "ready":
        print(f"ready: {detail}", flush=True)
        return 0
    return run_lifecycle(open_when_started=False)


def stop_command() -> int:
    running = running_dashboard()
    if running is None:
        print("down: no dashboard serves this checkout", flush=True)
        notify(TITLE, "Devboard is not running")
        return 0
    pid, port = running
    if not stop_dashboard(pid):
        return fail(
            "Devboard is still running",
            f"pid {pid} on port {port} did not stop",
        )
    log(f"stop: pid {pid} on port {port}")
    notify("Devboard stopped", f"pid {pid} on port {port} is no longer serving")
    return 0


def open_ui_command() -> int:
    """Open the page, starting the dashboard first when nothing serves it."""
    running = running_dashboard()
    if running is None:
        return run_lifecycle(open_when_started=True)
    pid, port = running
    tokens = adopt_credentials(pid)
    open_page(port, tokens["bootstrap"])
    log(f"open: pid {pid} on port {port}")
    return 0


# --------------------------------------------------------------------------
# Resident panel indicator
# --------------------------------------------------------------------------

# One colour per state: the panel mark is the Devboard favicon redrawn in the
# colour of the state it reports.
INDICATOR_STATES = {
    "ready": "#2ea043",
    "starting": "#d29922",
    "degraded": "#db6d28",
    "down": "#8b949e",
}
INDICATOR_POLL_SECONDS = 10
INDICATOR_ICON_PIXELS = 64
# The favicon's three bars in its own 64-unit space: x, y, width, height,
# corner radius, and the white opacity each bar carries.
INDICATOR_BARS = (
    (13.0, 26.0, 10.0, 24.0, 3.5, 0.72),
    (27.0, 14.0, 10.0, 36.0, 3.5, 1.0),
    (41.0, 20.0, 10.0, 30.0, 3.5, 0.86),
)


def rounded_rectangle(context, x, y, width, height, radius) -> None:
    """One closed rounded-rectangle sub-path, clockwise from the top right."""
    context.new_sub_path()
    context.arc(x + width - radius, y + radius, radius, -math.pi / 2, 0)
    context.arc(x + width - radius, y + height - radius, radius, 0, math.pi / 2)
    context.arc(x + radius, y + height - radius, radius, math.pi / 2, math.pi)
    context.arc(x + radius, y + radius, radius, math.pi, 3 * math.pi / 2)
    context.close_path()


def render_mark(colour: str, path: Path) -> None:
    """Draw the Devboard mark in one state colour and write it as a PNG."""
    import cairo
    import gi

    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk

    size = INDICATOR_ICON_PIXELS
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    context = cairo.Context(surface)
    context.scale(size / 64.0, size / 64.0)
    context.set_source_rgb(*(int(colour[index:index + 2], 16) / 255.0 for index in (1, 3, 5)))
    rounded_rectangle(context, 0.0, 0.0, 64.0, 64.0, 14.0)
    context.fill()
    # The bars are white and stay inside the square.
    context.save()
    rounded_rectangle(context, 0.0, 0.0, 64.0, 64.0, 14.0)
    context.clip()
    for x, y, width, height, radius, opacity in INDICATOR_BARS:
        context.set_source_rgba(1.0, 1.0, 1.0, opacity)
        rounded_rectangle(context, x, y, width, height, radius)
        context.fill()
    context.restore()
    surface.flush()
    pixbuf = Gdk.pixbuf_get_from_surface(surface, 0, 0, size, size)
    if pixbuf is None:
        raise RuntimeError("the mark could not be copied out of the surface")
    path.parent.mkdir(parents=True, exist_ok=True)
    pixbuf.savev(str(path), "png", [], [])


def indicator_icons() -> dict[str, str]:
    """The four panel marks, drawn once into the dashboard's state directory."""
    fallback = str(ICON) if ICON.is_file() else "applications-internet"
    directory = CONTROL_DIR / "icons"
    icons: dict[str, str] = {}
    for state, colour in INDICATOR_STATES.items():
        path = directory / f"devboard-{state}.png"
        try:
            render_mark(colour, path)
        except Exception as error:  # a headless host still gets the favicon
            log(f"indicator: could not draw the {state} mark: {error}")
            icons[state] = fallback
        else:
            icons[state] = str(path)
    return icons


def indicator_appindicator(gi):
    """The Ayatana typelib, or the older AppIndicator one when only that exists."""
    import importlib

    for namespace in ("AyatanaAppIndicator3", "AppIndicator3"):
        try:
            gi.require_version(namespace, "0.1")
            return importlib.import_module(f"gi.repository.{namespace}")
        except (ImportError, ValueError):
            continue
    return None


def run_indicator() -> int:
    lock = acquire_lock(CONTROL_DIR / "indicator.lock")
    if lock is None:
        print("devboard indicator: already running", flush=True)
        return 0
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        from gi.repository import GLib, Gtk
    except (ImportError, ValueError) as error:
        log(f"indicator: no GTK 3 typelib: {error}")
        notify(TITLE, "The panel indicator needs python3-gi and GTK 3")
        return 1
    app_indicator = indicator_appindicator(gi)
    if app_indicator is None:
        log("indicator: no Ayatana AppIndicator typelib")
        notify(TITLE, "The panel indicator needs the Ayatana AppIndicator library")
        return 1

    icons = indicator_icons()
    indicator = app_indicator.Indicator.new(
        "devboard-indicator",
        icons["starting"],
        app_indicator.IndicatorCategory.APPLICATION_STATUS,
    )
    indicator.set_status(app_indicator.IndicatorStatus.ACTIVE)
    indicator.set_title(f"{TITLE}: starting")

    menu = Gtk.Menu()
    status_item = Gtk.MenuItem(label="starting: checking the dashboard")
    status_item.set_sensitive(False)
    menu.append(status_item)
    menu.append(Gtk.SeparatorMenuItem())
    open_item = Gtk.MenuItem(label="Open UI")
    start_item = Gtk.MenuItem(label="Start stack")
    restart_item = Gtk.MenuItem(label="Restart stack")
    stop_item = Gtk.MenuItem(label="Stop stack")
    for item in (open_item, start_item, restart_item, stop_item):
        menu.append(item)
    menu.append(Gtk.SeparatorMenuItem())
    quit_item = Gtk.MenuItem(label="Quit indicator")
    menu.append(quit_item)
    menu.show_all()
    indicator.set_menu(menu)
    # Middle-click activation opens the UI; the first action item does the same.
    try:
        indicator.set_secondary_activate_target(open_item)
    except AttributeError:
        pass

    check_lock = threading.Lock()
    actions = {
        "open": open_ui_command,
        "start": start_command,
        "restart": lambda: run_lifecycle(open_when_started=False),
        "stop": stop_command,
    }

    def apply_state(state: str, detail: str) -> bool:
        icon = icons.get(state, icons["starting"])
        try:
            indicator.set_icon_full(icon, f"{TITLE} {state}")
        except AttributeError:
            indicator.set_icon(icon)
        indicator.set_title(f"{TITLE}: {state} — {detail}")
        status_item.set_label(f"{state}: {detail}")
        return False

    def check_worker() -> None:
        try:
            state, detail = status_report()
        except Exception as error:  # a failed check never kills the panel icon
            state, detail = "degraded", f"the status check failed: {error}"
        finally:
            check_lock.release()
        GLib.idle_add(apply_state, state, detail)

    def schedule_check() -> bool:
        if check_lock.acquire(blocking=False):
            threading.Thread(target=check_worker, daemon=True).start()
        return True

    def trigger_check() -> bool:
        schedule_check()
        return False

    def run_action(action) -> None:
        def worker() -> None:
            try:
                action()
            finally:
                GLib.idle_add(trigger_check)

        # A build or restart takes minutes; the panel stays responsive while
        # the action runs and the launcher's own lock refuses a second one.
        threading.Thread(target=worker, daemon=True).start()

    open_item.connect("activate", lambda *_: run_action(actions["open"]))
    start_item.connect("activate", lambda *_: run_action(actions["start"]))
    restart_item.connect("activate", lambda *_: run_action(actions["restart"]))
    stop_item.connect("activate", lambda *_: run_action(actions["stop"]))
    quit_item.connect("activate", lambda *_: Gtk.main_quit())

    try:
        gi.require_version("GLibUnix", "2.0")
        from gi.repository import GLibUnix

        signal_add = GLibUnix.signal_add
    except (ImportError, ValueError):
        signal_add = GLib.unix_signal_add
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal_add(GLib.PRIORITY_DEFAULT, signum, Gtk.main_quit)

    schedule_check()
    GLib.timeout_add_seconds(INDICATOR_POLL_SECONDS, schedule_check)
    Gtk.main()
    lock.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Start, restart, stop, and open the Devboard dashboard"
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--status", action="store_true",
                       help="print the state; exit 0 only when the dashboard serves")
    group.add_argument("--start", action="store_true",
                       help="build and start a dashboard when none serves this checkout")
    group.add_argument("--restart", action="store_true",
                       help="rebuild and replace the dashboard that serves this checkout")
    group.add_argument("--stop", action="store_true",
                       help="stop the dashboard that serves this checkout")
    group.add_argument("--open-ui", action="store_true",
                       help="open the dashboard page, starting the dashboard when needed")
    group.add_argument("--indicator", action="store_true",
                       help="run the resident panel indicator")
    arguments = parser.parse_args()

    if arguments.status:
        return status_command()
    if arguments.start:
        return start_command()
    if arguments.restart:
        return run_lifecycle(open_when_started=False)
    if arguments.stop:
        return stop_command()
    if arguments.open_ui:
        return open_ui_command()
    if arguments.indicator:
        return run_indicator()
    return run_lifecycle(open_when_started=True)


if __name__ == "__main__":
    sys.exit(main())
