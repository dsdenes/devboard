## Objective

In this repository's Devboard harness (`.devboard/`), the browser interface and the dashboard
backend exchange every read, every action, and every workspace state update over a
resource-oriented REST API, while each live ACP agent run has its own WebSocket carrying that
run's state and output and nothing else. The single `/ws` command-and-event protocol, its 80
client commands, its connect-time replay, and its recorded command corpus are removed. Every
resource and action the browser drove with socket frames becomes an HTTP request at a root
path, specified in an OpenAPI document and conforming to the
`devboard-restful-api-implementation` skill. State the server used to push is read by
page-scoped conditional polling. A per-run socket exists only while that ACP run is live,
replays the run's retained journal from a cursor, then follows it live, and is the dashboard's
only WebSocket. `POST /reports` replaces `POST /feedback`. Every in-repo consumer that spoke the
shared socket — the MCP server, the desktop launcher, and the benchmark — uses the same REST
API.

## Success criteria

- No command socket: `crates/devboard/src/protocol.rs`, `COMMAND_NAMES`, `parse_client_message`,
  `IMPLEMENTED_COMMANDS`, the `/ws` route, the per-connection replay, and the broadcast fan-out to
  every connected client are deleted. A GET or upgrade request to `/ws` answers 404 Problem JSON
  and executes nothing, and no socket frame other than a run socket's own frames can change state.
- Per-run endpoint: every live ACP run has exactly one output endpoint, every REST representation
  of that run carries an absolute hypermedia `output` link naming the run, and no endpoint carries
  frames for more than one run. A stopped run holds no open socket; its retained output is
  reachable by connecting to that run's endpoint with a cursor.
- Isolation: with two live stub ACP runs A and B on their own sockets, A never receives a frame
  carrying B's identity and B never receives one carrying A's; two sockets for A receive the same
  frames in the same order.
- Frame allowlist: every frame on a run socket carries that run's identity and, for an output
  entry, a monotonically increasing cursor. The only frame kinds are that run's state snapshot,
  its question, its activity entries, its assistant text chunks, its stderr diagnostics, and its
  terminal status. No frame carries version, replacement, project, providers, resources, skills,
  records, issues-workspace, drafts, flow workspace, discover workspace, goal state, another
  agent's state, or another run's output.
- Cursor replay: connecting without a cursor replays every retained entry of that run in order,
  then follows live; connecting with `after=<cursor>` replays exactly the entries after that
  cursor, then follows; a cursor older than the retained window yields one reset marker naming
  the retained window start, then the retained entries; reconnecting with the last received
  cursor delivers no duplicate and no gap.
- Socket count: a loaded dashboard with no live ACP run opens zero WebSockets across a page load
  and five polling intervals; a stopped agent page opens zero; a page that displays a live run
  opens exactly one socket for that run; stopping the run closes its socket.
- Run state versus workspace state: while a run is live its socket carries that run's state
  (lifecycle, sync, question, prompt state, cadence and limits for that run), and that run's REST
  representation reports the same lifecycle at the next poll. When no run is live, family and
  workspace pages render from REST polling alone. Issue rows, releases, documentation, providers,
  resources, skills, records, drafts, flow widgets, discover contributions, and goal state never
  travel on a run socket.
- Command inventory: `contract/command-map.json` names all 80 retired commands and maps each to
  one HTTP `METHOD /path`; a test asserts the map covers exactly that set, every mapped operation
  exists in the served router and in the OpenAPI document, and no mapping points at a socket.
- OpenAPI: `.devboard/openapi.yaml` is one self-contained OpenAPI 3.1 document carrying title,
  specification version, description, owner contact, API identifier, and audience. Every served
  non-static route appears with its methods, request and response schemas, every 4xx/5xx as
  Problem JSON, and the document states the existing access model truthfully: loopback-only, no
  credential, host and origin guards. A workspace test parses the document and fails when a
  served route is missing from it or a documented route is not served.
- REST style: every API path is served at the root, no path starts with `/api`, none ends with
  `/`, every collection segment is a plural lower-kebab-case noun, no path segment is a verb, and
  query parameters are snake_case. A creation answers 201 with `Location` and honors
  `Idempotency-Key`; every 4xx/5xx is `application/problem+json` with `type`, `title`, `status`,
  and `detail`; a collection that can exceed 200 entries accepts `cursor` and `limit` and answers
  a page object with `self`, `next`, and `prev`; a mutation answers the created or updated
  representation in the same shape its GET returns.
- GET semantics: every resource GET supports `ETag`, answers 304 with no body for a matching
  `If-None-Match`, negotiates gzip, and answers HEAD with the same headers and no body. A wrong
  method answers 405 with `Allow`; an unserved host or a cross-origin request answers 421 or 403
  with Problem JSON on every route; no route is reachable cross-origin.
- Reports endpoint: `POST /reports` replaces `POST /feedback` with the same submission fields,
  201 plus `Location` to the filed issue, `Idempotency-Key` idempotency, 503 without
  `DEVBOARD_GITEA_URL`, and the same guard order. `/feedback` answers 404. The overlay,
  `lib/endpoints.ts`, the Vite proxy, the HTTP table and corpus, tests, README, and AGENTS name
  `/reports`. `/goal-proposals` and `/ready` keep their current request, response, and header
  contracts.
- No command frames in the client: the only WebSocket construction under `client/` is the
  run-output client, and every action a store performs is an HTTP request. A page whose bundle
  predates the server detects one documented REST refusal and reloads once; a second refusal
  after that reload stays a reported error and starts no reload loop.
- Polling: each state view polls its own resource at 1000 ms while the document is visible,
  issues at most one in-flight request per resource, pauses while the document is hidden, and
  resumes on `visibilitychange`. A hidden document issues no polling request for at least 10
  seconds. Version, replacement, and restarting status are polled the same way; after a
  replacement the page waits for `/ready` and reloads exactly once.
- MCP server: `mcp_server.rs` reaches the dashboard over REST only and holds no client command
  socket. `devboard_status` and every other MCP tool return the same fields as before, proven by
  the MCP tests.
- Desktop launcher: `desktop/devboard-launcher.py` restarts a dashboard with exactly one HTTP
  POST to the documented restart resource and contains no WebSocket handshake or frame code; a
  fixture-dashboard smoke calls its restart routine, observes the old pid exit and exactly one
  new pid listen, and exits 0.
- Benchmark: `devboard bench` measures REST read latency, names the method and path in its
  report, and uses no WebSocket.
- Retired dual-run router: `shadow/` is deleted and removed from the workspace members because
  its only input was the retired corpus; no build, test, or README reference remains and
  `cargo build --workspace` succeeds.
- Corpus: `contract/commands/`, `contract/events/`, `contract/cutover.json`, and
  `contract/command-names.txt` are deleted; `contract/http/` and `http_table` remain; every
  served route has a table row and a recording, `cargo test -p devboard-contract` exits 0, and
  `cargo run -p devboard-contract -- --compare-http <port>` exits 0 against a freshly started
  dashboard.
- Tests: `cargo test --workspace` includes and passes `retired_command_frames_change_no_state`,
  `run_sockets_are_isolated_per_run`, `run_socket_frame_allowlist`,
  `run_socket_replays_from_cursor`, `rest_route_inventory_matches_openapi`,
  `every_retired_command_has_an_http_operation`, `conditional_get_answers_304`, and
  `rest_refusals_are_problem_json`. Client tests include and pass `polling_pauses_when_hidden`,
  `no_command_frames`, and `stale_bundle_reloads_once`. The Playwright operator suite asserts
  zero sockets when no run is live and exactly one socket per live run the page displays.
- Documentation: `adrs/0016-rest-transport-and-per-run-output-sockets.md` is accepted and
  supersedes 0014; `0014` carries `status: superseded` and `supersededBy: "0016"`; `bun run
  adr:lint` exits 0. `.devboard/README.md` describes the REST API and per-run sockets and no
  longer documents a command socket. Root `AGENTS.md` and `.devboard/templates/host-AGENTS.md`
  remain byte-identical, and the reporting sentence names `POST /reports`.
- Suites: `cargo fmt --check --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, `bun install --frozen-lockfile`,
  `bun run build && bun scripts/embed-client.mjs`, `bun run check`, `bun test`, and the
  Playwright operator suite all exit 0.
- Release: the work is merged into `main`, pushed, and released by the Release Train;
  `git ls-remote origin refs/heads/main` names the integrated commit, `git status --short
  --branch` reports no commits ahead, the release workflow for that commit concludes
  successfully, and the integration dashboard's `versionState` reports `running === installed`
  and `stale: false` while serving a bundle built from the changed source.

## Verification

Work in `<repo>/.worktree/rest-transport-per-agent-output-sockets`, where `<repo>` is
`git rev-parse --show-toplevel`. Commands run from `<repo>/.devboard` unless they name another
directory. Every fixture, scratch directory, browser profile, log, and screenshot stays under
`<repo>/.devboard/.tmp` or `<repo>/.devboard/.test-tmp`.

- `test ! -e crates/devboard/src/protocol.rs`. A `grep -rn` for `parse_client_message`,
  `COMMAND_NAMES`, and `IMPLEMENTED_COMMANDS` under `crates` prints nothing. A GET and an upgrade
  request to `/ws` both answer 404 with `application/problem+json`, proven by the HTTP table.
- `cargo test --workspace` runs the ten tests named in the criteria; each one exits 0. They prove
  no state change from retired frames, two-run isolation, the frame allowlist, cursor replay with
  a reset marker for a dropped cursor, route inventory versus OpenAPI, the 80-command map, 304
  on `If-None-Match`, and Problem JSON on every refusal.
- `cargo test -p devboard --test mcp` and `cargo test -p devboard --test relaunch` exit 0; the
  MCP tools read over REST and a REST restart replaces the process once.
- `bun test` includes `polling_pauses_when_hidden`, `no_command_frames`, and
  `stale_bundle_reloads_once` and exits 0; `bun run check` exits 0.
- `bun run build && bun scripts/embed-client.mjs` exits 0, and `cargo build --workspace` builds
  without `shadow`.
- `cargo test -p devboard-contract` exits 0 and includes
  `every_http_table_row_has_a_recording`; start a dashboard on a free port with a fixture
  `STATE_DIR`, then `cargo run -p devboard-contract -- --compare-http <port>` exits 0.
- `set -a; . ../.env; set +a; bunx playwright test --config e2e/playwright.config.ts` exits 0.
  Its specs record every WebSocket the page opens and assert: a page with no live run opens
  none, a started family run opens exactly one whose URL names that run, stopping it closes the
  socket, and no page opens a socket that carries another run's frames.
- With a fixture dashboard serving the built bundle, open `http://127.0.0.1:<port>/` in the
  browser: the network log shows REST requests only for reads and actions, the stopped agent
  page shows zero sockets, and starting one background agent adds exactly one socket; the
  activity and state on that page continue while the sidebar's counts update by polling.
- `python3` imports `desktop/devboard-launcher.py`, points it at a fixture dashboard, calls its
  restart routine, and prints the old and new pid; the new pid differs, exactly one process
  listens on the port, and the helper issues one POST. The script lives under `.devboard/.tmp`.
- `cargo run -p devboard -- bench --port <port> --iterations 5 --command <name>` exits 0 and its
  output names the HTTP method and path it measured.
- `bun run adr:lint` exits 0; `adrs/0014-browser-to-backend-transport-in-the-rust-runtime.md`
  carries `status: superseded` and `supersededBy: "0016"`;
  `adrs/0016-rest-transport-and-per-run-output-sockets.md` exits with status `accepted`.
- `cargo test -p devboard --test docs` exits 0, proving `AGENTS.md` and
  `.devboard/templates/host-AGENTS.md` are byte-identical; `grep -n "/feedback" ../AGENTS.md`
  prints nothing and `grep -n "POST /reports" ../AGENTS.md` prints the reporting sentence.
- `cargo fmt --check --all`, `cargo clippy --workspace --all-targets -- -D warnings`, and
  `cargo test --workspace` exit 0.
- `git -C <repo> ls-remote origin refs/heads/main` prints the integrated commit;
  `git -C <repo> status --short --branch` reports no commits ahead of the upstream; the release
  workflow run for the pushed commit concludes successfully.
- From the integration checkout, the running dashboard's `versionState` reports
  `running === installed` with `stale: false`, and the served bundle is the one built from the
  pushed commit.

## Boundaries

All edits, builds, tests, and verification runs happen inside one worktree at
`<repo>/.worktree/rest-transport-per-agent-output-sockets`. Merge that worktree into `main`, push
the integrated commit to the canonical upstream, wait for the Release Train to release it, then
remove the worktree and branch. Never edit the opened checkout and never create a file outside
`<repo>`.

Allowed files and directories: `.devboard/crates/devboard/**`,
`.devboard/crates/devboard-contract/**`, `.devboard/client/**`, `.devboard/lib/**`,
`.devboard/contract/**`, a new `.devboard/openapi.yaml`, `.devboard/Cargo.toml`,
`.devboard/Cargo.lock`, `.devboard/vite.config.ts`, `.devboard/package.json`,
`.devboard/bunfig.toml`, `.devboard/README.md`, `.devboard/bench/**`,
`.devboard/desktop/devboard-launcher.py`, deletion of `.devboard/shadow/**` and its workspace
member, root `AGENTS.md`, `.devboard/templates/host-AGENTS.md`, `adrs/0014-*` for its status and
`supersededBy` fields, and a new `adrs/0016-rest-transport-and-per-run-output-sockets.md`.

Adding at most one dev-dependency for YAML parsing is allowed. No runtime dependency is added and
no lockfile is hand-edited.

Leave untouched: `GOAL.md`, `design/`, `stories/`, `.design/`, `openui.json`, `.omp/**`,
`.devboard/omp/**`, agent prompts, worker decisions, cadences, and forge behavior, the install,
update, doctor, publish, and release machinery, the `DEVBOARD_*` environment contract, the
`POST /goal-proposals` and `/ready` contracts, static serving and the SPA fallback, CSS and
visual layout, and every existing `data-testid` and `data-command` value. The harness stays
host-neutral: no host name, path, remote, or language assumption enters `.devboard/`.

The transport change is a cross-boundary change only for `adrs/0014-*`, which records the
superseded harness transport, and for root `AGENTS.md`, which ships byte-identical to its
template. No other host file changes.

## Stop conditions

No attempt cap, token cap, or time budget applies: continue until every criterion is verified.
Halt and surface only for a genuine ambiguity the repository cannot resolve, an operation that is
risky or irreversible, a missing prerequisite such as an unreachable Gitea for the operator
suite, or a blocked external dependency. Never run `devboard publish` or dispatch the release
workflow by hand, never kill or relaunch a dashboard by hand, and never force-push or bypass the
commit gate.
