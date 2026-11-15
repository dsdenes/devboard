#!/usr/bin/env python3
"""Regression test for the desktop launcher's published-release stack.

The launcher never builds or runs this checkout's working tree. It selects the
newest `v<major>.<minor>.<patch>` tag whose release manifest proves the release
is fully published, checks that tag out under `.devboard/published/`, builds it
with `cargo build --release -p devboard`, and starts that release binary.

Every test here runs without network access: the tag list, the manifest reads,
the git reads, and the build are all injected.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

LAUNCHER = Path(__file__).resolve().with_name("devboard-launcher.py")
TEST_ROOT = LAUNCHER.parent.parent / ".test-tmp"


def load_launcher():
    spec = importlib.util.spec_from_file_location("devboard_launcher", LAUNCHER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LauncherTest(unittest.TestCase):
    def setUp(self) -> None:
        TEST_ROOT.mkdir(parents=True, exist_ok=True)
        self.fixture = Path(tempfile.mkdtemp(prefix="launcher-", dir=TEST_ROOT))
        self.module = load_launcher()

    def tearDown(self) -> None:
        shutil.rmtree(self.fixture, ignore_errors=True)

    # -- selection ---------------------------------------------------------

    def test_newer_tag_without_a_manifest_is_skipped_and_an_older_published_tag_wins(
        self,
    ) -> None:
        module = self.module
        reads: list[str] = []

        def read(url: str):
            reads.append(url)
            if "/v1.49.0/" in url:
                return None, f"{url} answered HTTP 404", False
            return {"version": "1.48.1"}, "", False

        with mock.patch.object(module, "release_tags", return_value=(["v1.49.0", "v1.48.1"], "")), \
                mock.patch.object(module, "github_repository", return_value="dsdenes/devboard"), \
                mock.patch.object(module, "remote_reference", return_value=None), \
                mock.patch.object(module, "read_manifest", side_effect=read), \
                mock.patch.dict(os.environ, {"DEVBOARD_GITEA_URL": ""}, clear=False):
            version, error = module.select_published_tag()

        self.assertEqual(error, "")
        self.assertEqual(version, "1.48.1")
        self.assertEqual(
            reads,
            [
                "https://github.com/dsdenes/devboard/releases/download/"
                "v1.49.0/devboard-manifest.json",
                "https://github.com/dsdenes/devboard/releases/download/"
                "v1.48.1/devboard-manifest.json",
            ],
        )

    def test_unreachable_github_falls_back_to_the_gitea_manifest(self) -> None:
        module = self.module
        urls: list[str] = []
        reads: list[str] = []

        def read(url: str):
            reads.append(url)
            if "github.com" in url:
                return None, f"{url} is unreachable: timed out", True
            return {"version": "1.48.1"}, "", False

        with mock.patch.object(module, "release_tags", return_value=(["v1.48.1"], "")), \
                mock.patch.object(module, "github_repository", return_value="dsdenes/devboard"), \
                mock.patch.object(module, "remote_reference",
                                  return_value=("localhost", "dsdenes/devboard")), \
                mock.patch.object(module, "published_manifest_urls",
                                  side_effect=lambda version, github=True: urls.extend([
                                      (
                                          "https://github.com/dsdenes/devboard/releases/"
                                          f"download/v{version}/devboard-manifest.json",
                                          "github",
                                      ),
                                      (
                                          "http://localhost:3001/dsdenes/devboard/releases/"
                                          f"download/v{version}/devboard-manifest.json",
                                          "gitea",
                                      ),
                                  ]) or list(urls)), \
                mock.patch.object(module, "read_manifest", side_effect=read), \
                mock.patch.dict(os.environ, {"DEVBOARD_GITEA_URL": "http://localhost:3001"}):
            version, error = module.select_published_tag()

        self.assertEqual(error, "")
        self.assertEqual(version, "1.48.1")
        self.assertEqual(len(reads), 2)
        self.assertIn("github.com", reads[0])
        self.assertTrue(reads[1].startswith("http://localhost:3001/"))

    def test_no_qualifying_tag_builds_and_starts_nothing(self) -> None:
        module = self.module
        built: list[str] = []
        started: list[str] = []
        swept: list[str] = []
        notices: list[tuple[str, str]] = []

        def notify(summary: str, body: str, urgency: str = "normal") -> None:
            notices.append((summary, body))

        with mock.patch.object(module, "release_tags", return_value=(["v1.49.0"], "")), \
                mock.patch.object(module, "published_manifest_urls",
                                  return_value=[("http://127.0.0.1:9/devboard-manifest.json",
                                                 "github")]), \
                mock.patch.object(module, "read_manifest",
                                  return_value=(None, "unreachable", True)), \
                mock.patch.object(module, "build_release",
                                  side_effect=lambda version: built.append(version)), \
                mock.patch.object(module, "start",
                                  side_effect=lambda binary, tokens, version=None:
                                  started.append(str(binary))), \
                mock.patch.object(module, "sweep_dashboards",
                                  side_effect=lambda binary: swept.append(str(binary))), \
                mock.patch.object(module, "notify", side_effect=notify), \
                mock.patch.object(module, "log", lambda message: None), \
                mock.patch.object(module, "load_dotenv", lambda path: None), \
                mock.patch.object(module, "acquire_lock", return_value=object()), \
                mock.patch.object(module, "running_dashboard", return_value=None), \
                mock.patch.object(module, "STATE", self.fixture / "state"), \
                mock.patch.object(module, "CONTROL_DIR", self.fixture / "state" / "desktop"), \
                mock.patch.object(module, "CREDENTIALS",
                                  self.fixture / "state" / "desktop" / "credentials.json"), \
                mock.patch.object(module, "LOG", self.fixture / "launcher.log"):
            status = module.run_lifecycle(open_when_started=False)

        self.assertEqual(status, 1)
        self.assertEqual(built, [])
        self.assertEqual(started, [])
        self.assertEqual(swept, [])
        self.assertTrue(notices)
        summary, body = notices[-1]
        self.assertIn("no published release", summary)
        self.assertIn("v1.49.0", body)

    def test_release_tags_are_ordered_newest_first_by_number(self) -> None:
        module = self.module
        listing = "v1.9.0\nv1.10.0\nv1.2.3\nnot-a-release\nv2.0.0-rc1\n"

        def git(*arguments: str, cwd=None, timeout: float = 0.0):
            if arguments[:1] == ("fetch",):
                return 0, "", ""
            return 0, listing, ""

        with mock.patch.object(module, "run_git", side_effect=git):
            tags, error = module.release_tags()

        self.assertEqual(error, "")
        self.assertEqual(tags, ["v1.10.0", "v1.9.0", "v1.2.3"])

    def test_a_failed_fetch_selects_nothing(self) -> None:
        module = self.module
        with mock.patch.object(module, "run_git",
                              return_value=(128, "", "fatal: could not read from remote")), \
                mock.patch.object(module, "build_release",
                                  side_effect=AssertionError("no build may run")):
            version, error = module.select_published_tag()

        self.assertIsNone(version)
        self.assertIn("git fetch --tags origin failed", error)

    def test_an_unreachable_forge_stops_the_selection_after_one_tag(self) -> None:
        module = self.module
        reads: list[str] = []

        def read(url: str):
            reads.append(url)
            return None, f"{url} is unreachable: timed out", True

        with mock.patch.object(module, "release_tags",
                              return_value=(["v1.49.0", "v1.48.1", "v1.47.3"], "")), \
                mock.patch.object(module, "github_repository", return_value="dsdenes/devboard"), \
                mock.patch.object(module, "remote_reference", return_value=None), \
                mock.patch.object(module, "read_manifest", side_effect=read), \
                mock.patch.object(module, "build_release",
                                  side_effect=AssertionError("no build may run")), \
                mock.patch.dict(os.environ, {"DEVBOARD_GITEA_URL": ""}):
            version, error = module.select_published_tag()

        self.assertIsNone(version)
        self.assertIn("unreachable", error)
        self.assertEqual(len(reads), 1)

    def test_a_manifest_naming_another_version_is_skipped(self) -> None:
        module = self.module

        def read(url: str):
            if "/v1.49.0/" in url:
                return {"version": "1.48.9"}, "", False
            return {"version": "1.48.1"}, "", False

        with mock.patch.object(module, "release_tags",
                              return_value=(["v1.49.0", "v1.48.1"], "")), \
                mock.patch.object(module, "github_repository", return_value="dsdenes/devboard"), \
                mock.patch.object(module, "remote_reference", return_value=None), \
                mock.patch.object(module, "read_manifest", side_effect=read), \
                mock.patch.dict(os.environ, {"DEVBOARD_GITEA_URL": ""}):
            version, error = module.select_published_tag()

        self.assertEqual(error, "")
        self.assertEqual(version, "1.48.1")

    # -- build -------------------------------------------------------------

    def test_the_build_argv_is_the_release_profile_and_the_binary_is_a_release(
        self,
    ) -> None:
        module = self.module
        worktree = self.fixture / "published" / "v1.48.1"
        harness = worktree / ".devboard"
        harness.mkdir(parents=True)
        cargo = self.fixture / "bin" / "cargo"
        cargo.parent.mkdir(parents=True)
        cargo.write_text("#!/bin/sh\n", encoding="utf-8")
        cargo.chmod(0o755)
        calls: list[tuple[list[str], str]] = []

        def run(command, **options):
            calls.append((list(command), str(options.get("cwd"))))
            binary = Path(options["cwd"]) / "target" / "release" / "devboard"
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_bytes(b"release")
            return types.SimpleNamespace(returncode=0, stdout="Finished", stderr="")

        with mock.patch.object(module, "worktree_for",
                              return_value=(worktree, "c" * 40, "")), \
                mock.patch.object(module, "checkout_problem", return_value=""), \
                mock.patch.object(module.shutil, "which", lambda name: str(cargo)), \
                mock.patch.object(module.subprocess, "run", side_effect=run), \
                mock.patch.object(module, "log", lambda message: None):
            binary, error = module.build_release("1.48.1")

        self.assertEqual(error, "")
        self.assertEqual(
            binary, worktree / ".devboard" / "target" / "release" / "devboard"
        )
        self.assertEqual(
            calls, [([str(cargo), "build", "--release", "-p", "devboard"], str(harness))]
        )

    def test_a_dirty_tag_worktree_refuses_to_build(self) -> None:
        module = self.module
        published = self.fixture / "published"
        (published / "v1.48.1").mkdir(parents=True)
        commit = "a" * 40
        commands: list[tuple[str, ...]] = []

        def git(*arguments: str, cwd=None, timeout: float = 0.0):
            commands.append(arguments)
            if arguments[:3] == ("rev-parse", "--verify", "--quiet"):
                return 0, commit + "\n", ""
            if arguments[:2] == ("rev-parse", "HEAD"):
                return 0, commit + "\n", ""
            return 0, " M .devboard/src/main.rs\n", ""

        built: list[object] = []
        with mock.patch.object(module, "PUBLISHED", published), \
                mock.patch.object(module, "run_git", side_effect=git), \
                mock.patch.object(module.subprocess, "run",
                                  side_effect=lambda *a, **k: built.append(a)), \
                mock.patch.object(module, "log", lambda message: None):
            path, _, error = module.worktree_for("1.48.1")

        self.assertIsNone(path)
        self.assertIn("local changes", error)
        self.assertNotIn(("worktree", "add", "--detach", str(published / "v1.48.1"),
                          "v1.48.1"), commands)
        self.assertEqual(built, [])

    def test_a_clean_tag_worktree_is_reused_without_a_second_checkout(self) -> None:
        module = self.module
        published = self.fixture / "published"
        worktree = published / "v1.48.1"
        worktree.mkdir(parents=True)
        commit = "b" * 40
        commands: list[tuple[str, ...]] = []

        def git(*arguments: str, cwd=None, timeout: float = 0.0):
            commands.append(arguments)
            if arguments[:3] == ("rev-parse", "--verify", "--quiet"):
                return 0, commit + "\n", ""
            if arguments[:2] == ("rev-parse", "HEAD"):
                return 0, commit + "\n", ""
            return 0, "", ""

        with mock.patch.object(module, "PUBLISHED", published), \
                mock.patch.object(module, "run_git", side_effect=git), \
                mock.patch.object(module, "log", lambda message: None):
            path, found, error = module.worktree_for("1.48.1")

        self.assertEqual(error, "")
        self.assertEqual(path, worktree)
        self.assertEqual(found, commit)
        self.assertFalse(any(command[:2] == ("worktree", "add") for command in commands))

    def test_a_worktree_of_another_commit_is_never_deleted(self) -> None:
        module = self.module
        published = self.fixture / "published"
        worktree = published / "v1.48.1"
        worktree.mkdir(parents=True)

        def git(*arguments: str, cwd=None, timeout: float = 0.0):
            if arguments[:3] == ("rev-parse", "--verify", "--quiet"):
                return 0, "c" * 40, ""
            return 0, "d" * 40, ""

        with mock.patch.object(module, "PUBLISHED", published), \
                mock.patch.object(module, "run_git", side_effect=git), \
                mock.patch.object(module, "log", lambda message: None):
            path, _, error = module.worktree_for("1.48.1")

        self.assertIsNone(path)
        self.assertIn("not v1.48.1", error)
        self.assertTrue(worktree.is_dir())

    # -- the stack ---------------------------------------------------------

    def test_no_debug_build_or_debug_binary_path_remains(self) -> None:
        source = LAUNCHER.read_text(encoding="utf-8")
        self.assertNotIn("target/debug", source)
        self.assertNotIn("target\" / \"debug", source)
        self.assertNotRegex(source, r'"build"\s*,\s*"-p"')
        self.assertRegex(source, r'"build",\s*"--release",\s*"-p",\s*"devboard"')

    def test_the_build_root_is_outside_every_swept_directory(self) -> None:
        module = self.module
        published = module.PUBLISHED.resolve()
        self.assertEqual(published.name, "published")
        self.assertEqual(published.parent.name, ".devboard")
        self.assertEqual(
            (published / "v1.48.1").relative_to(module.HARNESS.resolve()),
            Path("published") / "v1.48.1",
        )
        # No retention sweep walks `.worktree`, the state directory, or the
        # checkout's own target directory for this path.
        for swept in (module.REPO / ".worktree", module.STATE, module.HARNESS / "target"):
            self.assertFalse(
                published.is_relative_to(swept.resolve()),
                f"{published} is inside the swept root {swept}",
            )
        gitignore = (module.HARNESS / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("/published/", gitignore.splitlines())

    def test_the_launcher_never_selects_head_a_branch_or_a_commit(self) -> None:
        module = self.module
        seen: list[str] = []

        def git(*arguments: str, cwd=None, timeout: float = 0.0):
            return 0, "", ""

        def read(url: str):
            seen.append(url)
            return None, "404", False

        with mock.patch.object(module, "run_git", side_effect=git), \
                mock.patch.object(module, "read_manifest", side_effect=read):
            version, error = module.select_published_tag()

        self.assertIsNone(version)
        self.assertIn("no v<major>.<minor>.<patch> tag", error)
        self.assertEqual(seen, [])

    def test_an_installed_host_runs_its_own_binary_without_a_build(self) -> None:
        module = self.module
        installed = self.fixture / "repo" / ".devboard" / "bin" / "devboard"
        installed.parent.mkdir(parents=True)
        installed.write_bytes(b"installed")
        built: list[object] = []

        with mock.patch.object(module, "REPO", self.fixture / "repo"), \
                mock.patch.object(module, "HARNESS", self.fixture / "repo" / ".devboard"), \
                mock.patch.object(module, "prepare_release",
                                  side_effect=lambda: built.append(True)):
            version, binary, error = module.resolve_start()

        self.assertEqual(error, "")
        self.assertIsNone(version)
        self.assertEqual(binary, installed)
        self.assertEqual(built, [])

    def test_install_canonical_replaces_an_executing_binary(self) -> None:
        module = self.module
        harness = self.fixture / "harness"
        canonical = harness / "target" / "release" / "devboard"
        canonical.parent.mkdir(parents=True)
        sleep = Path(shutil.which("sleep") or "/bin/sleep")
        shutil.copyfile(sleep, canonical)
        os.chmod(canonical, 0o755)
        running = subprocess.Popen(
            [str(canonical), "30"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            built = self.fixture / "built" / "devboard"
            built.parent.mkdir(parents=True)
            shutil.copyfile(Path("/bin/true"), built)
            os.chmod(built, 0o755)
            with mock.patch.object(module, "HARNESS", harness):
                problem = module.install_canonical(built)
            self.assertEqual(problem, "")
            self.assertIsNone(
                running.poll(), "the process executing the canonical path survives"
            )
            self.assertEqual(canonical.read_bytes(), built.read_bytes())
        finally:
            running.kill()
            running.wait()

    def test_a_failed_install_keeps_the_canonical_bytes_and_no_temporary(self) -> None:
        module = self.module
        harness = self.fixture / "harness"
        canonical = harness / "target" / "release" / "devboard"
        canonical.parent.mkdir(parents=True)
        canonical.write_bytes(b"canonical bytes")
        built = self.fixture / "built" / "devboard"
        built.parent.mkdir(parents=True)
        built.write_bytes(b"built bytes")

        def refuse(*_args, **_kwargs):
            raise OSError("the rename was refused")

        with mock.patch.object(module, "HARNESS", harness), \
                mock.patch.object(module.os, "replace", side_effect=refuse):
            problem = module.install_canonical(built)
        self.assertIn("could not be copied", problem)
        self.assertEqual(canonical.read_bytes(), b"canonical bytes")
        self.assertEqual(
            sorted(path.name for path in canonical.parent.iterdir()),
            ["devboard"],
            "a failed install leaves no staged file behind",
        )

    def test_start_names_the_published_release_it_launched(self) -> None:
        module = self.module
        spawned: dict = {}

        class Spawned:
            pid = 4242

        def popen(command, **options):
            spawned["command"] = command
            spawned["env"] = options["env"]
            return Spawned()

        with mock.patch.object(module, "REPO", self.fixture / "repo"), \
                mock.patch.object(module, "STATE", self.fixture / "state"), \
                mock.patch.object(module, "LOG", self.fixture / "launcher.log"), \
                mock.patch.object(module.subprocess, "Popen", side_effect=popen):
            module.start(Path("/bin/true"), {"token": "t", "bootstrap": "b"}, "1.56.0")

        environment = spawned["env"]
        self.assertEqual(environment["DEVBOARD_LAUNCHED_RELEASE"], "1.56.0")
        self.assertEqual(environment["DEVBOARD_DASHBOARD_TOKEN"], "t")
        for name in module.INSTANCE_VARIABLES:
            if name in (
                "DEVBOARD_LAUNCHED_RELEASE",
                "DEVBOARD_DASHBOARD_TOKEN",
                "DEVBOARD_BOOTSTRAP_TOKEN",
            ):
                continue
            self.assertNotIn(name, environment)

    def test_an_installed_host_start_names_no_published_release(self) -> None:
        module = self.module
        spawned: dict = {}

        class Spawned:
            pid = 4242

        def popen(command, **options):
            spawned["env"] = options["env"]
            return Spawned()

        with mock.patch.object(module, "REPO", self.fixture / "repo"), \
                mock.patch.object(module, "STATE", self.fixture / "state"), \
                mock.patch.object(module, "LOG", self.fixture / "launcher.log"), \
                mock.patch.object(module.subprocess, "Popen", side_effect=popen):
            module.start(Path("/bin/true"), {"token": "t", "bootstrap": "b"})

        self.assertNotIn("DEVBOARD_LAUNCHED_RELEASE", spawned["env"])

    def test_an_upgrade_record_names_both_versions_and_only_a_change(self) -> None:
        module = self.module
        control = self.fixture / "state" / "desktop"
        with mock.patch.object(module, "CONTROL_DIR", control):
            module.record_upgrade("1.53.0", "1.56.0")
            written = json.loads((control / "upgrade.json").read_text(encoding="utf-8"))
            self.assertEqual(written["from"], "1.53.0")
            self.assertEqual(written["to"], "1.56.0")

            (control / "upgrade.json").unlink()
            module.record_upgrade("1.56.0", "1.56.0")
            module.record_upgrade(None, "1.56.0")
            module.record_upgrade("1.56.0", None)
            self.assertFalse((control / "upgrade.json").exists())

    def test_a_bootstrap_restart_waits_for_the_run_result_then_records_success(self) -> None:
        module = self.module
        result = self.fixture / "run" / "result.json"
        record = self.fixture / "state" / "desktop" / "published-bootstrap.json"
        order: list[str] = []

        def wait(path: Path, timeout: float, settle: float = 0.0) -> bool:
            order.append(f"wait {path}")
            self.assertEqual(path, result)
            self.assertEqual(timeout, module.BOOTSTRAP_WAIT_SECONDS)
            self.assertEqual(settle, module.BOOTSTRAP_SETTLE_SECONDS)
            return True

        def lifecycle(open_when_started: bool) -> int:
            order.append("restart")
            return 0

        def bootstrap(version: str, path: Path) -> None:
            order.append(f"record {version} {path}")

        argv = [
            "devboard-launcher",
            "--restart",
            "--after", str(result),
            "--bootstrap-version", "1.56.0",
            "--bootstrap-record", str(record),
        ]
        with mock.patch.object(module.sys, "argv", argv), \
                mock.patch.object(module, "wait_for_path", side_effect=wait), \
                mock.patch.object(module, "run_lifecycle", side_effect=lifecycle), \
                mock.patch.object(module, "record_bootstrap", side_effect=bootstrap):
            self.assertEqual(module.main(), 0)
        self.assertEqual(
            order,
            [f"wait {result}", "restart", f"record 1.56.0 {record}"],
        )

    def test_a_bootstrap_that_never_sees_its_result_leaves_the_dashboard_serving(self) -> None:
        module = self.module
        argv = [
            "devboard-launcher",
            "--restart",
            "--after", str(self.fixture / "missing.json"),
            "--bootstrap-version", "1.56.0",
            "--bootstrap-record", str(self.fixture / "record.json"),
        ]
        restarts: list[bool] = []
        with mock.patch.object(module.sys, "argv", argv), \
                mock.patch.object(module, "wait_for_path", return_value=False), \
                mock.patch.object(module, "run_lifecycle",
                                  side_effect=lambda open_when_started:
                                  restarts.append(True) or 0), \
                mock.patch.object(module, "log", lambda message: None):
            self.assertEqual(module.main(), 1)
        self.assertEqual(restarts, [])

    def test_wait_for_path_answers_only_when_the_document_exists(self) -> None:
        module = self.module
        missing = self.fixture / "run" / "result.json"
        self.assertFalse(module.wait_for_path(missing, 0))
        missing.parent.mkdir(parents=True)
        missing.write_text("{}\n", encoding="utf-8")
        self.assertTrue(module.wait_for_path(missing, 0))

    def test_wait_for_path_settles_after_the_document_appears(self) -> None:
        module = self.module
        document = self.fixture / "run" / "result.json"
        document.parent.mkdir(parents=True)
        document.write_text("{}\n", encoding="utf-8")
        waits: list[float] = []
        with mock.patch.object(module.time, "sleep", side_effect=waits.append):
            self.assertTrue(module.wait_for_path(document, 0, 60.0))
        self.assertEqual(waits, [60.0])

    def test_the_bootstrap_record_names_success_atomically(self) -> None:
        module = self.module
        record = self.fixture / "state" / "desktop" / "published-bootstrap.json"
        module.record_bootstrap("1.56.0", record)
        written = json.loads(record.read_text(encoding="utf-8"))
        self.assertEqual(written["version"], "1.56.0")
        self.assertIs(written["active"], True)
        self.assertEqual(
            sorted(path.name for path in record.parent.iterdir()),
            ["published-bootstrap.json"],
            "no staged document is left behind",
        )

    def test_a_restart_records_the_upgrade_before_the_new_process_starts(self) -> None:
        module = self.module
        order: list[str] = []

        class Spawned:
            pid = 222

        markers = [
            {"pid": 111, "running": "1.53.0"},
            {"pid": 222, "running": "1.56.0"},
        ]
        tokens = {"token": "t", "bootstrap": "b"}
        with mock.patch.object(module, "REPO", self.fixture / "repo"), \
                mock.patch.object(module, "HARNESS", self.fixture / "repo" / ".devboard"), \
                mock.patch.object(module, "STATE", self.fixture / "state"), \
                mock.patch.object(module, "CONTROL_DIR", self.fixture / "state" / "desktop"), \
                mock.patch.object(module, "LOG", self.fixture / "launcher.log"), \
                mock.patch.object(module, "load_dotenv", lambda path: None), \
                mock.patch.object(module, "acquire_lock", return_value=object()), \
                mock.patch.object(module, "credentials", return_value=tokens), \
                mock.patch.object(module, "running_dashboard", return_value=(111, 8080)), \
                mock.patch.object(module, "version_marker", side_effect=markers), \
                mock.patch.object(module, "sweep_dashboards", lambda binary: {}), \
                mock.patch.object(module, "resolve_start",
                                  return_value=("1.56.0", Path("/bin/true"), "")), \
                mock.patch.object(module, "adopt_credentials", return_value=tokens), \
                mock.patch.object(module, "stop_dashboard", return_value=True), \
                mock.patch.object(module, "record_upgrade",
                                  side_effect=lambda previous, served:
                                  order.append(f"record {previous} {served}")), \
                mock.patch.object(module, "start",
                                  side_effect=lambda binary, tokens, version=None:
                                  order.append(f"start {version}") or Spawned()), \
                mock.patch.object(module, "wait_ready", return_value=222), \
                mock.patch.object(module, "notify", lambda *args: None), \
                mock.patch.object(module, "log", lambda message: None):
            self.assertEqual(module.run_lifecycle(open_when_started=False), 0)
        self.assertEqual(order, ["record 1.53.0 1.56.0", "start 1.56.0"])

    def test_remote_reference_parses_every_remote_form(self) -> None:
        module = self.module
        urls = {
            "github": "https://github.com/dsdenes/devboard.git",
            "origin": "ssh://ds@localhost:2223/dsdenes/devboard.git",
            "scp": "git@github.com:dsdenes/devboard.git",
        }

        def git(*arguments: str, cwd=None, timeout: float = 0.0):
            url = urls.get(arguments[-1])
            return (0, url + "\n", "") if url else (2, "", "no such remote")

        with mock.patch.object(module, "run_git", side_effect=git):
            self.assertEqual(
                module.remote_reference("github"),
                ("github.com", "dsdenes/devboard"),
            )
            self.assertEqual(
                module.remote_reference("origin"),
                ("localhost:2223", "dsdenes/devboard"),
            )
            self.assertEqual(
                module.remote_reference("scp"),
                ("github.com", "dsdenes/devboard"),
            )
            self.assertIsNone(module.remote_reference("missing"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
