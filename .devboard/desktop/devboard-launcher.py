#!/usr/bin/env python3
"""Start the Devboard dashboard for this checkout from the newest build.

The click target of the desktop icon beside the terminal:

- rebuilds the harness from this checkout, so the process that starts is the
  binary the current source builds;
- restarts a dashboard that already serves this checkout, through the
  dashboard's own `restartServer` handoff, so a live agentic run survives the
  replacement;
- starts a detached dashboard when none serves this checkout and opens its
  page with the launcher credential;
- reports every step and every failure through the desktop's native
  notification service.

A source checkout builds `target/debug/devboard`; an installed host starts its
own `bin/devboard` and is never rebuilt.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
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
RESTART_TIMEOUT = 60.0


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


def is_dashboard(pid: int) -> bool:
    argv = process_argv(pid)
    if not argv:
        return False
    name = Path(argv[0]).name
    return "devboard" in name and any(argument == "serve" for argument in argv[1:])


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


def send_text_frame(stream: socket.socket, payload: bytes) -> None:
    mask = os.urandom(4)
    header = bytearray([0x81])
    length = len(payload)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header += length.to_bytes(2, "big")
    else:
        header.append(0x80 | 127)
        header += length.to_bytes(8, "big")
    header += mask
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    stream.sendall(bytes(header) + masked)


def read_frame(buffer: bytes) -> tuple[tuple[int, bytes] | None, bytes]:
    if len(buffer) < 2:
        return None, buffer
    opcode = buffer[0] & 0x0F
    length = buffer[1] & 0x7F
    index = 2
    if length == 126:
        if len(buffer) < 4:
            return None, buffer
        length = int.from_bytes(buffer[2:4], "big")
        index = 4
    elif length == 127:
        if len(buffer) < 10:
            return None, buffer
        length = int.from_bytes(buffer[2:10], "big")
        index = 10
    if len(buffer) < index + length:
        return None, buffer
    return (opcode, buffer[index:index + length]), buffer[index + length:]


def websocket_restart(port: int, token: str) -> str | None:
    """Ask the running dashboard to replace itself; `None` means it accepted."""
    try:
        stream = socket.create_connection(("127.0.0.1", port), timeout=5)
    except OSError as error:
        return f"the dashboard socket is unreachable: {error}"
    try:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET /ws HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Authorization: Bearer {token}\r\n"
            "\r\n"
        )
        stream.sendall(request.encode("ascii"))
        answer = b""
        while b"\r\n\r\n" not in answer:
            chunk = stream.recv(4096)
            if not chunk:
                break
            answer += chunk
            if len(answer) > 65536:
                break
        status = answer.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        if " 101 " not in f"{status} ":
            return f"the dashboard refused the socket: {status}"
        send_text_frame(stream, b'{"type":"restartServer"}')
        stream.settimeout(0.25)
        pending = b""
        deadline = time.time() + 3.0
        while time.time() < deadline:
            try:
                chunk = stream.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                return None
            if not chunk:
                return None
            pending += chunk
            while True:
                frame, pending = read_frame(pending)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 0x8:
                    return None
                if opcode != 0x1:
                    continue
                try:
                    event = json.loads(payload)
                except ValueError:
                    continue
                if event.get("type") == "error":
                    return str(event.get("message") or "the dashboard refused the restart")
        return None
    finally:
        try:
            stream.close()
        except OSError:
            pass


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


def wait_ready(port: int, token: str, expected_pid: int | None, timeout: float) -> int | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
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


def build() -> tuple[Path | None, str | None]:
    """The binary to start and a failure description, never both."""
    installed = REPO / ".devboard" / "bin" / "devboard"
    if not (HARNESS / "Cargo.toml").is_file():
        if installed.is_file():
            return installed, None
        return None, f"no harness source under {HARNESS} and no installed binary"
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo" / "bin" / "cargo")
    if not Path(cargo).is_file():
        return None, "cargo is not on PATH"
    try:
        result = subprocess.run(
            [cargo, "build", "-p", "devboard"],
            cwd=str(HARNESS),
            check=False,
            capture_output=True,
            text=True,
            timeout=3600,
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
    binary = HARNESS / "target" / "debug" / "devboard"
    if not binary.is_file():
        return None, f"the build produced no binary at {binary}"
    return binary, None


def start(binary: Path, tokens: dict[str, str]) -> subprocess.Popen:
    environment = dict(os.environ)
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


def wait_replacement(
    old_pid: int, port: int, tokens: dict[str, str]
) -> tuple[int, int, dict[str, str]] | None:
    deadline = time.time() + RESTART_TIMEOUT
    while time.time() < deadline:
        marker = version_marker()
        candidate = marker.get("pid")
        if (
            isinstance(candidate, int)
            and candidate != old_pid
            and process_alive(candidate)
        ):
            adopted = adopt_credentials(candidate)
            settled_port = int(marker.get("port") or port)
            remaining = max(1.0, min(10.0, deadline - time.time()))
            if wait_ready(settled_port, adopted["token"], candidate, remaining):
                return candidate, settled_port, adopted
        time.sleep(0.25)
    return None


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


def main() -> int:
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
    notify(TITLE, "Building the latest Devboard from source…")
    binary, error = build()
    if error or binary is None:
        return fail("Devboard did not build", error or "unknown build failure")

    report = sweep_dashboards(binary)
    running = running_dashboard()
    kept = report.get("keptPid")
    if isinstance(kept, int) and process_alive(kept):
        kept_port = report.get("keptPort")
        port = kept_port if isinstance(kept_port, int) and kept_port > 0 else PORT
        if running is None or running[0] != kept:
            running = (kept, port)
    elif running is not None and not process_alive(running[0]):
        running = None

    if running is not None:
        old_pid, old_port = running
        tokens = adopt_credentials(old_pid)
        notify(TITLE, f"Restarting Devboard (pid {old_pid})…")
        refusal = websocket_restart(old_port, tokens["token"])
        if refusal is not None and "already in progress" in refusal.lower():
            log(f"restart: another restart holds the dashboard ({refusal})")
            refusal = None
        if refusal is None:
            log(f"restart: the dashboard at pid {old_pid} accepted the handoff")
            settled = wait_replacement(old_pid, old_port, tokens)
            if settled is None:
                return fail(
                    "Devboard did not restart",
                    "the replacement never became ready; the old process keeps serving",
                )
            new_pid, settled_port, tokens = settled
            version = version_marker().get("running") or "unknown"
            log(f"restart: pid {old_pid} -> {new_pid} on port {settled_port} ({version})")
            notify(
                "Devboard restarted",
                f"Version {version} · pid {new_pid} · http://127.0.0.1:{settled_port}",
            )
            return 0

        log(f"restart: handoff refused ({refusal}); stopping pid {old_pid}")
        if not stop_dashboard(old_pid):
            return fail(
                "Devboard is still running",
                f"pid {old_pid} did not stop after the refused handoff: {refusal}",
            )
        process = start(binary, tokens)
        ready = wait_ready(PORT, tokens["token"], process.pid, READY_TIMEOUT)
        if ready is None:
            return fail(
                "Devboard did not start",
                f"the dashboard on port {PORT} never became ready ({refusal})",
            )
        tokens = adopt_credentials(ready)
        version = version_marker().get("running") or "unknown"
        notify(
            "Devboard restarted",
            f"Version {version} · pid {ready} · http://127.0.0.1:{PORT}",
        )
        return 0

    notify(TITLE, "Starting Devboard…")
    process = start(binary, tokens)
    ready = wait_ready(PORT, tokens["token"], process.pid, READY_TIMEOUT)
    if ready is None:
        return fail(
            "Devboard did not start",
            f"the dashboard on port {PORT} never became ready; see {LOG}",
        )
    tokens = adopt_credentials(ready)
    version = version_marker().get("running") or "unknown"
    log(f"start: pid {ready} on port {PORT} ({version})")
    notify(
        "Devboard is running",
        f"Version {version} · pid {ready} · http://127.0.0.1:{PORT}",
    )
    open_page(PORT, tokens["bootstrap"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
