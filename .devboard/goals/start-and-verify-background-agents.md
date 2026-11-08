## Objective

On the integration checkout `/home/ds/devboard` (repository `dsdenes/devboard`), every background agent is
started and empirically proven to be working: the nine families the Background Agents registry ships — Auto Scout
(`scout`), Watchdog (`watchdog`), Design System (`design`), Dead Code (`dead-code`), MCP optimizer
(`mcp-optimizer`), API Standards (`api-standards`), Single Responsibility (`single-responsibility`), Consistent
Naming (`consistent-naming`), and Release Train (`release-train`) — plus the Issues worker, each attached to the
live dashboard on port 8080 and each having completed two cycles (the nine scheduled families on a temporarily
reduced 1-minute cadence, Issues at its own 10-second poll), with every family's original cadence and limits
restored afterwards. The work is operational: no source, test, config, or documentation file changes, and the
dashboard is never spawned, killed, or restarted by hand.

## Success criteria

1. **Ten families live.** `background_agents_list` lists the nine ids above, and for each id
   `background_agent_get` answers `lifecycle: "running"`, `enabled: true`, `paused: false`, `attached: true`,
   `error: null`. The Issues worker's newest state file (`/home/ds/devboard/.devboard/.tmp/issues/<repo key>/`
   `workers/<version>/state.json` or the legacy `<repo key>/state.json`, newest by mtime) carries
   `lifecycle: "running"`, `enabled: true`, `paused: false`, `poll.error: null`, and its `worker.pid` is alive.
2. **Two completed cycles per repository family.** For `scout`, `design`, `dead-code`, `api-standards`,
   `single-responsibility`, `consistent-naming`: two distinct `detail.scanId` values, each observed at least once
   with `cadence.nextRunAt` non-null, `cadence.lastRunAt` later than the recorded start instant, and `error: null`;
   and each matching cycle directory exists with a non-empty `activity.json`. Artifact path is
   `/home/ds/devboard/.devboard/.tmp/scout/scans/<scanId>/` for `scout` and
   `/home/ds/devboard/.devboard/.tmp/<family>/cycles/<scanId>/` for the other five.
3. **Watchdog and MCP optimizer.** Two distinct `runs/<stamp>/report.json` files under
   `/home/ds/devboard/.devboard/.tmp/watchdog/` and `/home/ds/devboard/.devboard/.tmp/coach/` whose `cycle`
   is later than the recorded start instant, each with `action` neither `failed` nor absent; and two live
   observations of `cadence.lastRunAt` advancing with `cadence.nextRunAt` non-null and `error: null`.
4. **Release Train.** Two distinct `gate.at` values in `/home/ds/devboard/.devboard/.tmp/release-train/state.json`
   later than the recorded start instant, each with `gate.state` equal to `nothing` or `unreleased`; a gate that
   starts a release run is accepted and the run itself need not finish. `state.failure` is null or older than the
   first fresh gate.
5. **Issues polls.** Two distinct `poll.lastPollAt` values later than the recorded start instant in the newest
   Issues state file, with `poll.error: null` at both, and no `checkIssues` command sent.
6. **Cadence and caps restored.** For each of the nine families the final live snapshot's `cadence.minutes`,
   `limits.maxPerHour`, and `limits.maxPending` equal the values captured in
   `/home/ds/devboard/.devboard/.tmp/agents-verification/settings-before.json`; the Issues worker's fixed
   10,000 ms poll interval is unchanged.
7. **Stability.** A fresh `background_agents_list` taken 60 s after the last restoration still reports all nine
   families `running`, `enabled`, `attached`, `error: null`, and the Issues worker still reports a poll no older
   than 60 s with `poll.error: null`.
8. **No operator mutation.** `git -C /home/ds/devboard status --porcelain` lists no path; the only files the
   operator creates are under `/home/ds/devboard/.devboard/.tmp/agents-verification/` (worker cycle, scan, run, and
   state files are the agents' own output). No dashboard process is started, killed, or restarted by the operator,
   and no `stopAgent`, `pauseIssues`, `resumeIssues`, or `checkIssues` command is sent.
9. **Scheduling proven without manual nudging.** Between each family's first and second completed cycle no
   `startAgent`, `startIssues`, `refreshAgent`, or `checkIssues` command is sent to it, and the second cycle's start
   (`cadence.lastRunAt`, `gate.at`, or `poll.lastPollAt`) is at least 60 s after the first's.

## Verification

All commands run from `/home/ds/devboard`. The MCP server answers from the live dashboard; a read takes about ten
seconds, so poll at ten-second intervals rather than in a tight loop.

Set up the evidence directory, the start instant, and the MCP helper once:

```bash
cd /home/ds/devboard
mkdir -p .devboard/.tmp/agents-verification
python3 -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]+"Z")' \
  | tee .devboard/.tmp/agents-verification/started-at.txt
cat > .devboard/.tmp/agents-verification/mcp.sh <<'SH'
#!/bin/sh
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$1" \
  >> /home/ds/devboard/.devboard/.tmp/agents-verification/commands.log
printf '%s\n' "$1" | REPO_DIR=/home/ds/devboard STATE_DIR=/home/ds/devboard/.devboard/.tmp \
  /home/ds/devboard/.devboard/target/debug/devboard mcp 2>/dev/null
SH
chmod +x .devboard/.tmp/agents-verification/mcp.sh
```

Every tool call goes through `mcp.sh`, so `commands.log` is the exact command history criterion 9 reads.

Capture the pre-change live state and the settings to restore (criterion 6), before changing anything:

```bash
cd /home/ds/devboard
.devboard/.tmp/agents-verification/mcp.sh \
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"background_agents_list","arguments":{}}}' \
  > .devboard/.tmp/agents-verification/agents-before.json
python3 - <<'PY'
import json
raw = json.load(open('.devboard/.tmp/agents-verification/agents-before.json'))
agents = json.loads(raw['result']['content'][0]['text'])['agents']
cap = {a['id']: {'minutes': a['cadence']['minutes'],
                 'maxPerHour': a['limits']['maxPerHour'],
                 'maxPending': a['limits']['maxPending']} for a in agents}
json.dump(cap, open('.devboard/.tmp/agents-verification/settings-before.json', 'w'), indent=1)
print(json.dumps(cap, indent=1))
PY
```

Set every family to a 1-minute cadence, passing its captured caps so they are preserved, then start only the
families that are not already running (criteria 1 and 9). A Start may answer with a timeout while the dashboard
preflight is still running; re-read the snapshot and retry only after it reports `stopped`/`failed` with no error:

```bash
cd /home/ds/devboard
python3 - <<'PY'
import json, subprocess, time

def call(tool, args):
    req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": tool, "arguments": args}})
    out = subprocess.run(['.devboard/.tmp/agents-verification/mcp.sh', req],
                         capture_output=True, text=True).stdout.strip()
    return json.loads(out) if out else {}

def agents():
    text = call('background_agents_list', {})['result']['content'][0]['text']
    return {a['id']: a for a in json.loads(text)['agents']}

cap = json.load(open('.devboard/.tmp/agents-verification/settings-before.json'))
for fid, before in cap.items():
    args = {'id': fid, 'action': 'set_settings', 'minutes': 1,
            'maxPerHour': before['maxPerHour'], 'maxPending': before['maxPending']}
    print(fid, 'cadence', json.dumps(call('background_agent_control', args))[:160])
live = agents()
for fid in cap:
    if live[fid]['lifecycle'] != 'running':
        print(fid, 'start', json.dumps(call('background_agent_control',
                                            {'id': fid, 'action': 'start'}))[:160])

import glob, os
paths = glob.glob('.devboard/.tmp/issues/*/workers/*/state.json') + \
        glob.glob('.devboard/.tmp/issues/*/state.json')
issues_state = json.load(open(max(paths, key=os.path.getmtime)))
if issues_state.get('lifecycle') != 'running':
    print('issues start', json.dumps(call('issues_control', {'action': 'start'}))[:160])
PY
```

The Issues start is sent only when its newest state file is not `running`. Never send `checkIssues`.

Poll until every family holds two completed proofs (criteria 2 to 5 and 9), recording each observation instead of
trusting a final snapshot:

```bash
cd /home/ds/devboard
python3 - <<'PY'
import glob, json, os, subprocess, time

ROOT = '/home/ds/devboard'
TMP = ROOT + '/.devboard/.tmp'
T0 = open(TMP + '/agents-verification/started-at.txt').read().strip()
REPO_FAMILIES = ['scout', 'design', 'dead-code', 'api-standards',
                 'single-responsibility', 'consistent-naming']
proofs = {}

def call(tool, args):
    req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": tool, "arguments": args}})
    out = subprocess.run([TMP + '/agents-verification/mcp.sh', req],
                         capture_output=True, text=True).stdout.strip()
    return json.loads(out) if out else {}

def live():
    text = call('background_agents_list', {})['result']['content'][0]['text']
    return {a['id']: a for a in json.loads(text)['agents']}

def note(fid, key):
    proofs.setdefault(fid, set()).add(key)

def count(fid):
    got = proofs.get(fid, set())
    return (len({k for k in got if not k.startswith(('live:', 'at:'))}),
            len({k for k in got if k.startswith('live:')}))

while True:
    agents = live()
    # Criterion 2: a cycle id observed while nextRunAt is published.
    for fid in REPO_FAMILIES:
        a = agents[fid]
        cid = (a.get('detail') or {}).get('scanId')
        if (cid and cid not in proofs.get(fid, set())
                and a['cadence']['nextRunAt'] and a['cadence']['lastRunAt']
                and a['cadence']['lastRunAt'] > T0 and a['error'] is None):
            base = TMP + '/scout/scans/' + cid if fid == 'scout' else \
                   TMP + '/' + fid + '/cycles/' + cid
            if (os.path.exists(base + '/activity.json')
                    and os.path.getsize(base + '/activity.json') > 0):
                note(fid, cid)
                note(fid, 'at:' + a['cadence']['lastRunAt'])
    # Criterion 3: completed watchdog and MCP optimizer reports.
    for fid, directory in [('watchdog', TMP + '/watchdog'), ('mcp-optimizer', TMP + '/coach')]:
        for path in glob.glob(directory + '/runs/*/report.json'):
            report = json.load(open(path))
            action = report.get('action')
            if (report.get('cycle', '') > T0 and isinstance(action, str)
                    and action != 'failed'):
                note(fid, report['cycle'])
        a = agents[fid]
        if (a['cadence']['nextRunAt'] and a['error'] is None
                and a['cadence']['lastRunAt'] and a['cadence']['lastRunAt'] > T0):
            note(fid, 'live:' + a['cadence']['lastRunAt'])
    # Criterion 4: two fresh gate evaluations.
    state = json.load(open(TMP + '/release-train/state.json'))
    gate = state.get('gate') or {}
    if gate.get('at', '') > T0 and gate.get('state') in ('nothing', 'unreleased'):
        note('release-train', gate['at'])
    # Criterion 5: two fresh Issues polls.
    paths = glob.glob(TMP + '/issues/*/workers/*/state.json') + glob.glob(TMP + '/issues/*/state.json')
    newest = max(paths, key=os.path.getmtime)
    issues = json.load(open(newest))
    poll = issues.get('poll') or {}
    if poll.get('lastPollAt', '') > T0 and poll.get('error') is None:
        note('issues', poll['lastPollAt'])
    print(time.strftime('%H:%M:%S'), {fid: count(fid) for fid in sorted(proofs)}, flush=True)
    ready = (all(count(fid)[0] >= 2 for fid in REPO_FAMILIES + ['release-train', 'issues'])
             and all(count(fid)[0] >= 2 and count(fid)[1] >= 2
                     for fid in ['watchdog', 'mcp-optimizer']))
    if ready:
        json.dump({fid: sorted(got) for fid, got in proofs.items()},
                  open(TMP + '/agents-verification/proofs.json', 'w'), indent=1)
        break
    time.sleep(10)
PY
```

The loop records distinct cycle identifiers, so two observations of the same cycle never count twice. Restore each
family's captured cadence and caps as soon as it holds two proofs, using the same `set_settings` call with the
values from `settings-before.json` in place of `minutes: 1`; then take the final readings:

```bash
cd /home/ds/devboard
.devboard/.tmp/agents-verification/mcp.sh \
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"background_agents_list","arguments":{}}}' \
  > .devboard/.tmp/agents-verification/agents-after.json
sleep 60
.devboard/.tmp/agents-verification/mcp.sh \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"background_agents_list","arguments":{}}}' \
  > .devboard/.tmp/agents-verification/agents-stable.json
python3 - <<'PY'
import glob, json, os, subprocess

def call(tool, args):
    req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": tool, "arguments": args}})
    out = subprocess.run(['.devboard/.tmp/agents-verification/mcp.sh', req],
                         capture_output=True, text=True).stdout.strip()
    return json.loads(out) if out else {}

def snap(path):
    return json.loads(json.load(open(path))['result']['content'][0]['text'])['agents']

cap = json.load(open('.devboard/.tmp/agents-verification/settings-before.json'))
stable = snap('.devboard/.tmp/agents-verification/agents-stable.json')
for a in stable:
    if a['id'] not in cap:
        continue
    want = cap[a['id']]
    ok = (a['lifecycle'] == 'running' and a['enabled'] and a['attached']
          and a['paused'] is False and a['error'] is None
          and a['cadence']['minutes'] == want['minutes']
          and a['limits']['maxPerHour'] == want['maxPerHour']
          and a['limits']['maxPending'] == want['maxPending'])
    print(a['id'], 'ok' if ok else 'FAIL',
          a['cadence'], a['limits'], a['lifecycle'], a['error'])

# Criterion 1, one get per family.
for fid in cap:
    one = call('background_agent_get', {'id': fid}).get('result', {})
    agent = json.loads(one['content'][0]['text']) if one else {}
    ok = (agent.get('lifecycle') == 'running' and agent.get('enabled') is True
          and agent.get('paused') is False and agent.get('attached') is True
          and agent.get('error') is None)
    print('get', fid, 'ok' if ok else 'FAIL')

# Criterion 4, the failure record.
train = json.load(open('.devboard/.tmp/release-train/state.json'))
failure = train.get('failure')
print('release-train failure', failure)
print('release-train gate', train.get('gate'))

# Criterion 5, the Issues interval and newest poll.
paths = glob.glob('.devboard/.tmp/issues/*/workers/*/state.json') + \
        glob.glob('.devboard/.tmp/issues/*/state.json')
issues = json.load(open(max(paths, key=os.path.getmtime)))
poll = issues['poll']
import datetime
now = datetime.datetime.now(datetime.timezone.utc)
last = datetime.datetime.fromisoformat(poll['lastPollAt'].replace('Z', '+00:00'))
fresh = (now - last).total_seconds() <= 60
print('issues', issues['lifecycle'], issues['enabled'], poll['intervalMs'],
      'fresh' if fresh else 'STALE', poll['error'])

# Criterion 9, no nudging command between a family's first two proofs.
proofs = json.load(open('.devboard/.tmp/agents-verification/proofs.json'))
log = [line.split(' ', 1) for line in open('.devboard/.tmp/agents-verification/commands.log')]
for fid, keys in proofs.items():
    completed = sorted(k for k in keys if not k.startswith(('live:', 'at:')))
    stamps = sorted(k[3:] for k in keys if k.startswith('at:')) or completed
    if len(stamps) < 2:
        print('commands', fid, 'FAIL: fewer than two proofs')
        continue
    nudges = []
    for at, body in log:
        if not (stamps[0] < at < stamps[1]):
            continue
        try:
            call_body = json.loads(body)['params']
        except Exception:
            continue
        name, args = call_body.get('name'), call_body.get('arguments') or {}
        if name == 'background_agent_control' and args.get('action') in ('start', 'refresh'):
            nudges.append((at, name, args.get('action')))
        if name == 'issues_control' and fid == 'issues':
            nudges.append((at, name, args.get('action')))
    print('commands', fid, 'ok' if not nudges else ('FAIL ' + json.dumps(nudges)))
PY
```

Criteria 8 and 9: during the run, send only `background_agents_list`, `background_agent_get`,
`background_agent_control` with `start`/`set_settings`, and `issues_control` with `start`. After the run:

```bash
cd /home/ds/devboard
git status --porcelain
ps -eo pid,args | grep -E 'devboard (serve|worker)' | grep /home/ds/devboard
```

`git status --porcelain` prints nothing; the process list names one `serve` plus one worker per started family, with
no second `serve` for `/home/ds/devboard`. A two-cycle history whose second cycle starts within the reduced cadence
and no command between them is criterion 9's evidence.

## Boundaries

- In scope and allowed: the live dashboard for `/home/ds/devboard` on port 8080; the MCP tools
  `background_agents_list`, `background_agent_get`, `background_agent_control` (`start` and `set_settings` only),
  and `issues_control` (`start` only); read access to `/home/ds/devboard/.devboard/.tmp/**`; writes only under
  `/home/ds/devboard/.devboard/.tmp/agents-verification/`.
- Everything else in the repository stays byte-identical: no tracked file is edited, created, or deleted; no source,
  test, `Cargo.toml`, `package.json`, prompt, skill, `AGENTS.md`, `adrs/`, `GOAL.md`, `.omp/`, or `.worktree/` change.
- Never send `stopAgent`, `pauseIssues`, `resumeIssues`, `checkIssues`, `refreshAgent` as proof, or any command that
  drains a worker; never spawn `devboard serve` or `devboard worker` by hand; never kill, restart, or replace the
  dashboard.
- Never run `devboard publish`, dispatch the release workflow, push a commit, edit credentials, or change forge
  settings. If the Design System pushes its own documentation commit and the Release Train consequently publishes,
  let both finish; do not interfere, and if a publish triggers a source-refresh replacement, wait for the new
  dashboard to answer and re-read the snapshot rather than restarting anything.
- Every `set_settings` call carries the family's captured `maxPerHour` and `maxPending`, including explicit nulls,
  so a cadence change never clears a cap. Never finish the run with a family still on the 1-minute cadence; restore
  each family as soon as it holds two proofs, and use `settings-before.json` as the recovery source if the run is
  interrupted.
- Scope is the integration checkout only. Other live dashboards (`/home/ds/devboard/.worktree/issue-1416`,
  `/home/ds/devboard/.worktree/issue-1422`, and the act caches) and their workers are untouched.
- Do not delete or rotate worker state, cycle, scan, or run artifacts; they are the evidence.

## Stop conditions

- No attempt cap, no token budget, and no time limit: keep polling and retrying Start until every criterion is
  verified.
- Halt and report when a Start is refused with a `missing prerequisite` that cannot be satisfied without editing a
  tracked file, changing a credential outside the repository, or changing forge settings; when two or more live
  dashboards serve `/home/ds/devboard` so the control tool refuses to choose; when a family's cycles keep failing
  with one non-transient error (name the family and the exact error); when a worker exits while enabled; or when the
  live snapshot contradicts the durable state (name both values).
- Halt before an irreversible or risky operation not authorized here: stopping or draining a worker, deleting
  worker state, restarting or replacing the dashboard, publishing by hand, or rewriting history.
- A failed cycle or a stopped worker never substitutes for a success criterion. A completed cycle counts even when
  it found nothing, recorded a skip, or was capped by its filing limit.
