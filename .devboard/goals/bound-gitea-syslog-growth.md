## Objective

On the machine hosting the `dsdenes/devboard` checkout at `/home/ds/devboard`, Gitea's console INFO
output must stop inflating `/var/log/syslog` (gitea-tagged lines are 113 MB of the current 136 MB
file, 83%; the brief reports 62 MB in 90 minutes after truncation). The host logging path from the
user service `gitea.service` — stdout to journald (`ForwardToSyslog=yes`, `Storage=volatile`) to
rsyslog to `/var/log/syslog` — gains a rule that routes every `gitea`-tagged message to a dedicated
`/var/log/gitea.log`, which a logrotate stanza caps at 100 MB with 14 retained copies and which
`logrotate.timer` checks every hour. The change is applied live with root and proven by a synthetic
220 MB burst plus one hour of real agent load. Gitea itself is neither reconfigured nor restarted:
`MODE = console,file` at `/home/ds/gitea/conf/app.ini` line 47 stays as written, and the surface is
the host logging stack, not repository source.

## Success criteria

1. **Dedicated gitea route.** `/etc/rsyslog.d/10-gitea.conf` exists, is root-owned mode 0644, sorts
   before `50-default.conf`, matches `$programname == "gitea"`, writes `/var/log/gitea.log`, and
   executes `stop`. `rsyslogd -N1` exits 0 and `systemctl is-active rsyslog` prints `active`.
2. **Routing proven in both directions.** After the rsyslog restart, a unique
   `logger -t gitea "<nonce>"` line appears in `/var/log/gitea.log` and not in `/var/log/syslog`,
   while a unique `logger -t syslog-probe "<nonce>"` line still appears in `/var/log/syslog`.
3. **Bounded file rule.** `/etc/logrotate.d/gitea` names `/var/log/gitea.log` with `daily`,
   `maxsize 100M`, `rotate 14`, `compress`, `delaycompress`, and the `postrotate` call to
   `/usr/lib/rsyslog/rsyslog-rotate`. `logrotate -d /etc/logrotate.d/gitea` exits 0 and its output
   reports a 104857600-byte threshold and 14 rotations.
4. **Hourly enforcement.** `/etc/systemd/system/logrotate.timer.d/override.conf` clears the inherited
   calendar, sets `OnCalendar=hourly` and `RandomizedDelaySec=0`; after `systemctl daemon-reload`,
   `systemctl cat logrotate.timer` includes the drop-in, `systemctl show logrotate.timer -p
   TimersCalendar` reports an hourly calendar, and `systemctl list-timers logrotate.timer` shows the
   next elapse at most one hour away.
5. **The size cap triggers through the real unit.** With logrotate state initialized for
   `/var/log/gitea.log`, appending 230686720 bytes to it and running
   `systemctl start logrotate.service` — never `logrotate -f` — leaves `/var/log/gitea.log` below
   1048576 bytes and a `/var/log/gitea.log.1` of at least 230686720 bytes.
6. **One live hour is bounded and gitea-free.** Starting at `SINCE` immediately after that rotation
   and waiting one hour: `/var/log/syslog` contains zero `gitea[` lines with a timestamp after
   `SINCE`; `/var/log/gitea.log` contains at least one line after `SINCE` and is at most 157286400
   bytes; `rsyslog` and `logrotate.timer` are active throughout.
7. **Retention and untouched surfaces.** `/var/log/gitea.log.*` holds at most 14 files.
   `/etc/logrotate.d/rsyslog` and `/home/ds/gitea/conf/app.ini` are byte-identical to the SHA-256
   hashes captured at the start; line 47 still reads `MODE = console,file`; the gitea user service
   is active with the same MainPID; the gitea binary, its unit, and `/home/ds/gitea/log/` are
   untouched.
8. **File shape.** `/var/log/gitea.log` is owned `syslog:adm` with mode 0640.

## Verification

Capture the baselines first; every later check compares against these values, not against memory.

```bash
SYSLOG=/var/log/syslog
GLOG=/var/log/gitea.log
SUDO="$HOME/.local/bin/sudo-ask"
BASE_RSYSLOG=$(sha256sum /etc/logrotate.d/rsyslog | cut -d' ' -f1)
BASE_APPINI=$(sha256sum /home/ds/gitea/conf/app.ini | cut -d' ' -f1)
BASE_PID=$(systemctl --user show gitea -p MainPID --value)
```

Criterion 1 — the route file parses and rsyslog runs:

```bash
cat /etc/rsyslog.d/10-gitea.conf
ls /etc/rsyslog.d
rsyslogd -N1
systemctl is-active rsyslog
```

Criterion 2 — one probe travels each path, after `systemctl restart rsyslog`:

```bash
N1="route-probe-$(date +%s%N)"; N2="syslog-probe-$(date +%s%N)"
logger -t gitea "$N1"; logger -t syslog-probe "$N2"; sleep 3
grep -c "$N1" "$GLOG"      # >= 1
grep -c "$N1" "$SYSLOG"    # 0
grep -c "$N2" "$SYSLOG"    # >= 1
```

Criterion 3 — the rule is valid and carries the cap and retention:

```bash
cat /etc/logrotate.d/gitea
logrotate -d /etc/logrotate.d/gitea 2>&1 | grep -E '104857600|14 rotations'
```

Criterion 4 — the timer resolves to hourly:

```bash
cat /etc/systemd/system/logrotate.timer.d/override.conf
systemctl cat logrotate.timer | grep -A3 'logrotate.timer.d'
systemctl show logrotate.timer -p TimersCalendar
systemctl list-timers logrotate.timer --no-pager
```

Criterion 5 — initialize state, inject 220 MB, let the real unit rotate without force:

```bash
$SUDO systemctl start logrotate.service
$SUDO sh -c 'yes "synthetic gitea burst line padding padding padding padding" | head -c 230686720 >> /var/log/gitea.log'
$SUDO systemctl start logrotate.service
stat -c '%s %n' "$GLOG"                        # < 1048576
stat -c '%s %n' /var/log/gitea.log.1          # >= 230686720
```

Criterion 6 — one live hour; `SINCE` is taken immediately after the rotation:

```bash
SINCE=$(date -Iseconds)
sleep 3600
awk -v s="$SINCE" '$1 > s && /gitea\[/' "$SYSLOG" | wc -l   # 0
awk -v s="$SINCE" '$1 > s' "$GLOG" | wc -l                  # >= 1
stat -c %s "$GLOG"                                          # <= 157286400
systemctl is-active rsyslog logrotate.timer                 # active, active
```

Criterion 7 — retention and byte-identical untouched surfaces:

```bash
$SUDO sh -c 'ls /var/log/gitea.log.* | wc -l'                                       # <= 14
[ "$(sha256sum /etc/logrotate.d/rsyslog | cut -d' ' -f1)" = "$BASE_RSYSLOG" ]
[ "$(sha256sum /home/ds/gitea/conf/app.ini | cut -d' ' -f1)" = "$BASE_APPINI" ]
sed -n '47p' /home/ds/gitea/conf/app.ini                                            # MODE = console,file
systemctl --user is-active gitea                                                    # active
[ "$(systemctl --user show gitea -p MainPID --value)" = "$BASE_PID" ]
```

Criterion 8 — ownership and mode, checked after the rotation:

```bash
stat -c '%U:%G %a' "$GLOG"    # syslog:adm 640
```

## Boundaries

Allowed to change, and nothing else:

- create `/etc/rsyslog.d/10-gitea.conf` (root:root 0644), `/etc/logrotate.d/gitea` (root:root 0644),
  and `/etc/systemd/system/logrotate.timer.d/override.conf` (root:root 0644), creating the timer
  drop-in directory if absent;
- let rsyslog create `/var/log/gitea.log` (syslog:adm 0640), logrotate create and rotate
  `/var/log/gitea.log.*`, and logrotate update `/var/lib/logrotate/status`;
- append the synthetic 220 MB burst to `/var/log/gitea.log`;
- run privileged steps only through `"$HOME/.local/bin/sudo-ask"`: `systemctl restart rsyslog`
  (the unit declares no `ExecReload`), `systemctl daemon-reload`, `systemctl restart
  logrotate.timer`, `systemctl start logrotate.service`, the burst append, and the
  `ls /var/log/gitea.log.*` count;
- run read-only checks as `ds`: `rsyslogd -N1`, `logrotate -d`, `logger`, `stat`, `awk`, `grep`,
  `sha256sum`, `systemctl show/cat/list-timers/is-active`.

Stays untouched:

- `/home/ds/gitea/conf/app.ini`, including `MODE = console,file` at line 47; the gitea binary; the
  `gitea.service` unit and user service state; `/home/ds/gitea/log/` and Gitea's own internal
  rotation; Gitea is never restarted or signalled;
- `/etc/logrotate.d/rsyslog`, `/etc/logrotate.conf`, `/etc/rsyslog.conf`,
  `/etc/rsyslog.d/50-default.conf`, and every other existing file under `/etc/rsyslog.d/` and
  `/etc/logrotate.d/`;
- `/var/log/syslog` and its rotated copies: no truncation, deletion, or by-hand rotation. The
  existing weekly rotate-4 schedule may rotate it as it normally would;
- the devboard source, harness, dashboard, and worktrees — this goal's only repository write is its
  own file under `.devboard/goals/`;
- no file, cache, log, or backup outside the paths named above; no `/tmp`, no home-directory
  artifacts, no `sudo -S`, no bare `sudo`.

Operating limits:

- The cap is enforced by the hourly timer together with `maxsize`, so the active file can reach
  100 MB plus up to one hour of Gitea output; the one-hour assertion of 150 MB is the measured
  bound, not a hard real-time ceiling.
- The 220 MB synthetic burst is test data appended to a log; keep it, let compression and retention
  age it out, and never delete other log content to save space.
- If any criterion fails, roll back by removing the three added files, then
  `systemctl daemon-reload`, `systemctl restart rsyslog`, and `systemctl restart logrotate.timer`,
  and report the failure; do not leave a half-applied route or timer.

## Stop conditions

Continue until every criterion above is verified against current state. There is no attempt cap and
no token, time, or cost budget.

Halt and surface only for: the sudo askpass dialog being cancelled, unavailable, or reporting a
headless environment; `rsyslogd -N1` failing or `systemctl restart rsyslog` failing; Gitea's console
output ceasing to reach the journal or the gitea service becoming inactive or changing its MainPID;
`logrotate.service` being locked or rejecting the configuration; any step that would require editing
`app.ini`, restarting Gitea, truncating or deleting existing logs, or changing a system file outside
the allowed list; or a missing prerequisite such as `logger`, `logrotate`, or the systemd timer
directories. Complete every reachable step before halting.
