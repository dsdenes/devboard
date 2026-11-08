## Objective

In this repository — the Devboard harness source checkout at the repo root — every registered
entry point that starts the harness resolves a real harness executable on both an installed host
and a source checkout, so the reported startup failure (`MCP finished with failures … Failed:
devboard … EPIPE: broken pipe, write`) cannot recur. The entry points are the OMP stdio
registration `mcpServers.devboard` in `.devboard/omp/mcp.json` (installed byte-identically as
`.omp/mcp.json`), the UI/UX skill preflight
`.devboard/omp/skills/devboard-ui-ux/scripts/preflight.sh` (installed under
`.omp/skills/devboard-ui-ux/`), and `devboard doctor`. Resolution order:
`DEVBOARD_HARNESS_DIR` / `DEVBOARD_BIN` when set; then the checkout's `.devboard` located from the
current directory's git top level, the explicit project root, or the current directory; then the
installed prefix and `devboard` on `PATH`. Inside a harness directory the candidates are
`bin/devboard`, then `target/release/devboard`, then `target/debug/devboard`. With `devboard`
absent from `PATH`, a fresh interactive OMP session at the repo root connects the `devboard` MCP
server and lists its tools with no MCP failure. When nothing resolves, each surface prints one
stderr line naming the searched candidates and the remedy and exits 127, and `devboard doctor`
reports an unresolvable managed registration as a failure instead of passing.

## Success criteria

- `.devboard/omp/mcp.json` still contains no absolute path, and `.omp/mcp.json` is byte-identical
  to it; every changed skill file's canonical and installed copies are byte-identical; `devboard
  doctor <repo root>` reports neither as drift.
- From the repo root, from `.devboard/`, and from `.devboard/crates/`, with no `devboard` on
  `PATH` and `DEVBOARD_HARNESS_DIR`, `DEVBOARD_BIN`, and `PI_CODING_AGENT_DIR` unset, the exact
  `command` and `args` registered for `mcpServers.devboard` in `.omp/mcp.json` starts a server
  that answers `initialize` with `serverInfo.name` equal to `devboard` and the checkout's reported
  version, answers `tools/list` with the full catalog including `devboard_status`, writes nothing
  to stderr, and exits 0 on stdin EOF.
- Precedence fixtures: `DEVBOARD_HARNESS_DIR` wins over the checkout; a harness directory's
  `bin/devboard` wins over its `target/release/devboard`, which wins over its
  `target/debug/devboard`; the git top level's `.devboard` is found when the current directory is
  a nested subdirectory; a `devboard` on `PATH` is used only when no harness directory yields a
  candidate; the existing `$PI_CODING_AGENT_DIR/..` prefix remains a candidate before `PATH`.
- With no candidate anywhere (no harness directory, no `PATH` `devboard`) the probe writes exactly
  one stderr line naming `.devboard/target/debug`, `.devboard/target/release`,
  `DEVBOARD_HARNESS_DIR`, and the build command, then exits 127.
- A new integration test `.devboard/crates/devboard/tests/mcp_registration.rs` proves every probe
  behavior above by executing the shipped probe against fixtures under `.devboard/.test-tmp/`
  (each fixture is its own git checkout), and one additional test drives the repository's real
  registration from the repo root through `initialize` and `tools/list`.
- The UI/UX preflight, with `devboard` absent from `PATH` and `DEVBOARD_BIN` unset, exits 0 and
  prints the preflight JSON when run from the repo root, from `.devboard/`, and with the repo root
  as its project argument; a fixture `.devboard/target/debug/devboard` stub receives the
  `preflight ui-ux` arguments; `DEVBOARD_BIN` wins over a `PATH` `devboard`; with nothing
  resolvable it prints one stderr line naming `DEVBOARD_BIN`, the build tree, and
  `.devboard/bin/devboard`, then exits 127.
- `devboard doctor <repo root>` exits 0 and reports no MCP-registration failure. On a fixture host
  that carries a harness of its own (`.devboard/Cargo.toml`, `.devboard/devboard.json`, or an
  executable `.devboard/bin/devboard`) but whose managed registration resolves nothing, doctor
  exits nonzero with a failure naming `.omp/mcp.json` and the probe's first stderr line. A host
  that carries no harness of its own still yields `doctor.ok()`, so the existing clean-host
  install fixture keeps passing. The registration check runs the probe with the host as cwd, a
  null stdin, and a deadline of at most 10 seconds.
- A fresh interactive `omp --no-session` session at the repo root, captured through a PTY, prints
  a connected line that names `devboard`, and prints neither `MCP finished with failures` nor a
  `Failed:` server entry.
- `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` pass in
  `.devboard`, including the existing `mcp_server`, `install`, `install_start`, `installed_version`,
  and `ui_preflight` tests.
- The harness reference documents the implemented resolution order, the build-tree candidates,
  the no-match diagnostic, the new doctor check, and names `scripts/preflight.sh` (not the stale
  `scripts/preflight.mjs`).
- The change is merged to `main` and pushed: `git ls-remote origin refs/heads/main` names the
  merged commit and `git status --short --branch` reports no commits ahead of the upstream. The
  Release Train alone releases it; no manual `devboard publish` and no manual release-workflow
  dispatch occurs. The integration checkout ends at the published revision with a rebuilt
  `.devboard/target/debug/devboard`, and the live-session criterion above then passes at the repo
  root.

## Verification

Run from the repo root unless a step says otherwise; every criterion is proven against the current
tree, not against memory.

1. `cd .devboard && cargo test --test mcp_registration` exits 0; its output names the precedence,
   no-match, and real-registration cases.
2. `cd .devboard && cargo test --workspace` exits 0.
3. `cd .devboard && cargo clippy --workspace --all-targets -- -D warnings` exits 0.
4. Registration round trip at the repo root:
   `env -i PATH=/usr/bin:/bin HOME="$HOME" python3 -c 'import json,subprocess;s=json.load(open(".omp/mcp.json"))["mcpServers"]["devboard"];p=subprocess.run([s["command"],*s["args"]],input=b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n",capture_output=True,timeout=60);print(p.returncode);print(p.stdout.decode());print(p.stderr.decode())'`
   prints `0`, a stdout block containing `"name":"devboard"` and `devboard_status`, and an empty
   stderr block.
5. Repeat step 4 with the working directory `.devboard` and then `.devboard/crates`.
6. No-match diagnostic: in a fixture git checkout under `.devboard/.test-tmp/` that has no
   `.devboard` harness and with `PATH` lacking `devboard`, the same subprocess call exits `127`
   and its stderr is exactly one line naming the build tree and `DEVBOARD_HARNESS_DIR`.
7. Preflight: `sh .devboard/omp/skills/devboard-ui-ux/scripts/preflight.sh .` and `cd .devboard &&
   sh omp/skills/devboard-ui-ux/scripts/preflight.sh .` each exit 0 and print JSON; with `PATH`
   lacking `devboard` and `DEVBOARD_BIN=$PWD/.devboard/target/debug/devboard`, the repo-root
   invocation exits 0 as well.
8. Doctor: `cd .devboard && cargo run -p devboard -- doctor ..` exits 0 with no stderr failure
   line; the fixture assertions for the unresolvable-registration and harnessless-host cases are
   in `cargo test --test mcp_registration` (or `--test install`).
9. Docs and bytes: `cmp .devboard/omp/mcp.json .omp/mcp.json` and `cmp
   .devboard/omp/skills/devboard-harness-reference/SKILL.md
   .omp/skills/devboard-harness-reference/SKILL.md` are silent; `grep -n 'target/debug/devboard'
   .devboard/omp/skills/devboard-harness-reference/SKILL.md` names the documented order.
10. Live session: `cd "$(git rev-parse --show-toplevel)" && timeout 25 script -qec "omp
    --no-session" /dev/null > .devboard/.tmp/mcp-live.txt 2>&1`; then `grep -a -o 'Connected to
    MCP[^[:cntrl:]]*' .devboard/.tmp/mcp-live.txt` names `devboard`, and `grep -a -c -e 'MCP
    finished with failures' -e 'Failed: ' .devboard/.tmp/mcp-live.txt` prints `0`. Delete the
    capture afterwards.
11. Delivery: `git ls-remote origin refs/heads/main` equals the merged commit; `git status --short
    --branch` shows no ahead commits; the Release Train run reports the version and the release
    URL; `versionState` reports the running version as that released version; `devboard publish`
    and the release workflow were never run by the implementer.

## Boundaries

Allowed files and directories, all inside the repo root:

- `.devboard/omp/mcp.json` and its installed copy `.omp/mcp.json`.
- `.devboard/omp/skills/devboard-ui-ux/scripts/preflight.sh` and the installed copy under
  `.omp/skills/devboard-ui-ux/scripts/`.
- `.devboard/omp/skills/devboard-harness-reference/SKILL.md` and the installed copy.
- `.devboard/crates/devboard/src/cli_install.rs` for the doctor check; the new test
  `.devboard/crates/devboard/tests/mcp_registration.rs`; fixture adjustments in existing tests
  (`.devboard/crates/devboard/tests/install.rs`, `install_start.rs`, `ui_preflight.rs`) only where
  the new checks require them.
- The task worktree `.worktree/mcp-harness-resolution` and its branches; builds and scratch under
  `.devboard/.test-tmp/` and `.devboard/.tmp/`.

Allowed operations: cargo build, test, and clippy in `.devboard`; `bash .devboard/install.sh
--force <repo root>` to refresh installed copies (never hand-edit `.omp/`); git commit, merge, and
push in the worktree; fast-forwarding and rebuilding the integration checkout after the push.

Untouched:

- The `devboard mcp` protocol, its tool catalog, and every tool's behavior; the adrkit and
  designmd registrations.
- The user's uncommitted `.devboard/crates/devboard/src/agents_mode.rs` change and the five
  deleted `.omp/skills/*` files in the main checkout.
- No absolute path in the registration; no `cargo run` fallback inside the probe; no new
  environment variable; no change to `PATH`-installed release behavior on an installed host.
- No manual `devboard publish`, no manual release-workflow dispatch, no dashboard kill, spawn, or
  relaunch, and nothing created, written, or kept outside the repo root (no `/tmp`, no home
  directory).

## Stop conditions

No attempt cap and no token, time, or cost budget applies: continue until every success criterion
is verified against current state. Halt and surface the problem only for genuine ambiguity in this
spec, a risky or irreversible operation not authorized above (such as discarding uncommitted
work), a missing prerequisite (a required tool, provider, remote, or credential), or an external
blocker (an unreachable remote, a Release Train gate that keeps failing, GitHub or Gitea
unavailable). Never report a criterion as met without the current output of its verification
command.
