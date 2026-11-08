## Objective

Every Devboard dashboard built from this repository — source checkout, installed host, or container,
on any bind address and any Host name — serves its page, static assets, the WebSocket at `/ws`,
`/ready`, `POST /feedback`, `POST /goal-proposals`, and the goal-draft documents without a dashboard
credential: no bearer token, no cookie, no `?bootstrap=` handshake, no credential prompt, and no 401
from the dashboard's own gate. The harness under `.devboard/` stops generating, persisting, printing,
inheriting, and validating a dashboard token, and `devboard serve` prints a plain
`http://<host>:<port>/` address. The existing Host allowlist and same-origin checks stay in force;
provider API keys and forge credentials are not part of this change.

## Success criteria

- **Credential code is gone.** No live code path, test, fixture, or document under `.devboard/` uses
  `DEVBOARD_DASHBOARD_TOKEN`, `DEVBOARD_BOOTSTRAP_TOKEN`, `--token` on `devboard serve` or
  `devboard bench`, the `devboard_dashboard_<port>` cookie, a dashboard `credentials.json`, a
  `?bootstrap=` URL, or a `WWW-Authenticate` challenge. The only remaining occurrences of the two
  variable names are historical files under `.devboard/goals/`.
- **A fresh server never answers 401.** Started with `devboard serve --port 0`, a fresh `STATE_DIR`,
  and `AGENT_COMMAND=true`, with no cookie and no `Authorization` header, the server answers:
  - `GET /` (Host `127.0.0.1:<port>` and `localhost:<port>`) → 200 `text/html`, no `Set-Cookie`, no
    `WWW-Authenticate`, body containing the application shell;
  - one built asset under `/assets/` → 200;
  - `GET /ready` → 200 JSON carrying `pid`;
  - a same-origin `GET /ws` upgrade → 101 Switching Protocols;
  - `POST /feedback` with a same-origin Origin → the handler's answer (503 when
    `DEVBOARD_GITEA_URL` is unset, 201 against a stub Gitea), never 401;
  - `POST /goal-proposals` with `{"report":"Make the header calm"}` and a same-origin Origin → 201
    with a `Location`, and `GET` on that `Location` → 200 with the draft bytes.
- **No bind or Host changes it.** A listener bound with `HOST=0.0.0.0` and
  `DEVBOARD_ALLOWED_HOSTS=test.invalid` answers the same requests with `Host: test.invalid:<port>`
  and `Origin: http://test.invalid:<port>` without a credential. A Host outside the allowlist still
  answers 421 on `/ws`, and a cross-origin Origin still answers 403; neither becomes 401. No dashboard
  route answers 401 in any configuration.
- **Launcher and install output.** `devboard serve --port <free>` prints one line
  `ADR interface listening on http://<host>:<port>/` with no query string and prints no token line.
  `devboard install <fixture host> --port <free>` exits 0, prints exactly one `dashboard on
  http://…/` URL with no `?bootstrap=`, prints no `devboard: dashboard token` line, leaves exactly one
  dashboard process, and that URL answers 200 with no cookie sent.
- **Internal clients send nothing.** `devboard bench --port <p> --command getProject` runs without
  `--token`; `devboard mcp`'s `devboard_status` plus one control command reach a loopback dashboard;
  `devboard worker watchdog --collect --dry-run` discovers it; and the replacement readiness probe
  answers and validates without a bearer.
- **Replacement needs no credential.** A publish-driven source replacement or an update handover
  starts the new process with no token; the new process serves `GET /` with 200 and no `Set-Cookie`;
  a replacement on a different port needs no new cookie, and the open page reconnects without a
  credential.
- **Contract replay is credential-free.** `cargo test -p devboard-contract` passes; the replay sends
  no `Authorization` header; no `contract/commands/*.json` case and no
  `crates/devboard-contract/src/http_table.rs` row expects a dashboard 401 or a `Bearer` challenge.
  Updating those recorded cases to the new behavior is authorized: this decision supersedes the
  credential expectations of `.devboard/goals/close-catalogued-rust-capability-gaps.md` (P0-1b) and
  `P0-5`.
- **Gates pass.** `cargo test --workspace`; `cargo clippy --workspace --all-targets -- -D warnings`;
  `bun test`; `bun run check`; `bun run build`; and `bun scripts/embed-client.mjs` whenever the
  bundle changed.
- **Docs match.** `.devboard/README.md` states that the dashboard requires no credential on any bind,
  that a network-exposed bind is guarded only by `DEVBOARD_ALLOWED_HOSTS` and the same-origin checks,
  and no longer documents `DEVBOARD_DASHBOARD_TOKEN`, `DEVBOARD_BOOTSTRAP_TOKEN`, a bootstrap URL, a
  dashboard cookie, or a credentialed `/ready`. The command
  `grep -nE 'DEVBOARD_DASHBOARD_TOKEN|DEVBOARD_BOOTSTRAP_TOKEN|\?bootstrap=|dashboard token|dashboard credential' .devboard/README.md`
  returns nothing.
- **The page renders without a credential.** A fresh browser profile with an empty cookie jar loads
  the fresh server's `http://127.0.0.1:<port>/`: the Unauthorized/problem page is absent, the board
  renders the fixture's records, the status bar shows the socket connected rather than `Connecting`,
  and the profile stores no `devboard_dashboard_*` cookie.
- **Shipped and live.** The change is merged to `main`, pushed, and released by the Release Train. The
  live source dashboard serving this checkout (pid and port from `.devboard/.tmp/version.json`,
  currently `127.0.0.1:8080`) replaces itself through the source-refresh path without operator
  action, answers `GET /` with 200 and no `Set-Cookie` or `WWW-Authenticate`, has neither variable in
  `/proc/<pid>/environ`, and reports the released version in `versionState`.

## Verification

Run from the repository root unless a step says otherwise. Every fixture stays inside
`.devboard/.test-tmp/`; every throwaway server uses a free port and is stopped after its checks.

```bash
cd .devboard
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p devboard-contract
bun install --frozen-lockfile && bun test && bun run check && bun run build
grep -nE 'DEVBOARD_DASHBOARD_TOKEN|DEVBOARD_BOOTSTRAP_TOKEN|\?bootstrap=|dashboard token|dashboard credential' README.md
```

The last command must print nothing. Then start the real binary against a fixture host:

```bash
FIX=.test-tmp/noauth-fixture
rm -rf "$FIX" && mkdir -p "$FIX/repo/adrs" "$FIX/state"
cp ../adrs/*.md "$FIX/repo/adrs/"
printf '# Fixture goal\n' > "$FIX/repo/GOAL.md"
AGENT_COMMAND=true target/debug/devboard serve --port 0 --repo-dir "$FIX/repo" --state-dir "$FIX/state" \
  > "$FIX/server.log" 2>&1 &
PORT=$(sed -n 's#^ADR interface listening on http://127\.0\.0\.1:\([0-9][0-9]*\)/$#\1#p' "$FIX/server.log")
test -n "$PORT"
grep -c '?bootstrap=' "$FIX/server.log"   # 0
test ! -e "$FIX/state/credentials.json"
```

With `BASE=http://127.0.0.1:$PORT`:

```bash
curl -sS -D "$FIX/root.headers" -o "$FIX/root.html" "$BASE/"                       # 200, app shell
! grep -qiE '^(set-cookie|www-authenticate):' "$FIX/root.headers"
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: localhost:'"$PORT" "$BASE/"    # 200
curl -sS "$BASE/ready"                                                             # {"pid":…}
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -H "Origin: $BASE" -d '{"report":"smoke"}' "$BASE/feedback"                     # 503, not 401
curl -sS -D "$FIX/draft.headers" -o /dev/null -X POST -H 'Content-Type: application/json' \
  -H "Origin: $BASE" -d '{"report":"Make the header calm"}' "$BASE/goal-proposals" # 201
DRAFT=$(sed -n 's#^[Ll]ocation: ##p' "$FIX/draft.headers" | tr -d '\r')
curl -sS -o /dev/null -w '%{http_code}\n' "$DRAFT"                                 # 200
curl -sS -i --max-time 2 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H "Origin: $BASE" "$BASE/ws" | sed -n 1p                                      # 101
```

Repeat the `GET /`, `/ready`, and `/ws` rows against a second throwaway server started with
`HOST=0.0.0.0 DEVBOARD_ALLOWED_HOSTS=test.invalid`, sending `Host: test.invalid:<port>` and the
matching Origin; then confirm `Host: other.invalid` answers 421 on `/ws` and a mismatched Origin
answers 403. For the browser proof, drive Chromium (the repository pins `@playwright/test` 1.64.1)
from a throwaway script under `$FIX/`: open `$BASE` in a new context with no cookies, fail on the
`Unauthorized` detail or a `devboard_dashboard_*` cookie, wait for a record title from the copied
ADRs, assert the status bar does not read `Connecting`, and save a screenshot in `$FIX/`.

Prove the internal clients and the launcher with their own checks:
`target/debug/devboard bench --port "$PORT" --command getProject`; a `devboard mcp` control call that
reads `devboard_status` and runs one mutating command against the fixture dashboard;
`target/debug/devboard worker watchdog --collect --dry-run --repo "$FIX/repo"`; and
`target/debug/devboard install <fixture host> --port <free>`, which must print the plain URL and no
token line. Exercise replacement with the existing tests:
`cargo test -p devboard --test relaunch --test restart --test install_start --test discovery --test http_surface`.

After the Release Train publishes: read `.devboard/.tmp/version.json` for the live pid and port, then

```bash
curl -sS -i "http://127.0.0.1:<port>/" | sed -n '1p;/^[Ss]et-[Cc]ookie:/p;/^[Ww][Ww][Ww]-[Aa]uthenticate:/p'
tr '\0' '\n' < /proc/<pid>/environ | grep -E 'DEVBOARD_(DASHBOARD|BOOTSTRAP)_TOKEN'   # no output
```

expect 200 and no cookie or challenge lines, and read the Release Train run under
`.devboard/.tmp/release-train/` to confirm the released tag and URL, with a Gitea release for that tag
carrying `devboard-manifest.json`.

## Boundaries

Allowed: `.devboard/crates/devboard/**`, `.devboard/crates/devboard-contract/**`,
`.devboard/contract/**`, `.devboard/crates/devboard/tests/**`, `.devboard/bench/**`,
`.devboard/e2e/**` (only to keep the operator suite working), `.devboard/README.md`, and the client
under `.devboard/client/**` only if the page itself needs a change. The harness may be built, tested,
and served from worktrees, and the change must be merged, pushed, and released by the Release Train.

Untouched: `adrs/`, `GOAL.md`, the host project's own files, `.devboard/.tmp/` (including an existing
dashboard `credentials.json`, which is ignored, not deleted), provider credentials under
`<STATE_DIR>/providers/`, `GITEA_TOKEN`/`GH_TOKEN` and forge auth, the Host allowlist semantics,
same-origin refusal behavior, the release and source-refresh mechanisms, `AGENTS.md` and
`.devboard/templates/host-AGENTS.md`, and every historical goal document. No new dependency, no
replacement authentication scheme, no TLS, and no new network-binding default.

Do not hand-edit `.omp/`; never copy, symlink, or install the harness outside the repository root; never
delete the running dashboard's state; never hand-run `devboard publish` or dispatch the release
workflow. Network-exposed dashboards are guarded only by `DEVBOARD_ALLOWED_HOSTS` and the same-origin
checks, and the README must say so.

## Stop conditions

There is no attempt cap and no token, time, or cost budget: continue until every success criterion is
verified against the current tree and the released version. Halt and surface only for a genuine
ambiguity in the requested behavior, a risky or irreversible operation (deleting state, force-push,
rewriting history), a missing prerequisite (toolchain, browser automation, Gitea, Release Train,
network), or a blocked external dependency. A failed or stale live replacement is recorded and
surfaced through the supported update, reload-control, or source-refresh path; never kill, spawn, or
relaunch the live dashboard by hand, and never treat a stale bundle or older server as a passing
verification.
