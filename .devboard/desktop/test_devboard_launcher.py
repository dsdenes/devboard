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
import os
import re
import shutil
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
                                  side_effect=lambda binary, tokens: started.append(str(binary))), \
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
