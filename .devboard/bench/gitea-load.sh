#!/usr/bin/env bash
# Load test the Gitea forge and the dashboard's read path together.
#
# Usage: bash bench/gitea-load.sh [--clients 8] [--duration 30] [--out <path>]
#                                 [--gitea <url>] [--dashboard <url>]
#                                 [--project <owner/name>] [--writers <n>]
#                                 [--think-ms <n>] [--db <path>]
#
# Every client loops until the deadline: it reads the project's issue list from
# the Gitea API and the dashboard's /issues, and the first --writers clients
# also create an issue in a disposable repository, comment on it, and close it.
# The disposable repository is deleted before the report is written and on
# every exit path, so the forge is left as it was found.
#
# The run prints one JSON object and also writes it to --out: clients,
# durationS, gitea.p50Ms, gitea.p95Ms, dashboard.p50Ms, dashboard.p95Ms,
# lockErrors, httpErrors, writesFailed, dbBytesAfter. It exits 0 only when the
# gitea p95, the dashboard p95, the lock and error counts, and the database
# size are inside the thresholds.
#
# GITEA_TOKEN is required. DEVBOARD_GITEA_URL (then GITEA_URL) names the forge
# when --gitea is absent; --db defaults to GITEA_DB, then to the database the
# running Gitea server names in its own config.
set -euo pipefail
# Latency arithmetic and the JSON report are decimal-point only: a locale
# that writes a comma instead hands the shell a sleep interval it
# rejects and a reader a JSON number it cannot parse, so the run pins
# the C locale.
export LC_ALL=C

harness=$(cd -- "$(dirname -- "$0")/.." && pwd)
host_root=$(cd -- "$harness/.." && pwd)

usage() {
  cat <<'EOF'
Usage: bash bench/gitea-load.sh [options]

  --clients <n>          concurrent clients (default 8)
  --duration <s>         seconds of load (default 30)
  --out <path>           JSON report path (default .devboard/.tmp/gitea-load.json)
  --writers <n>          clients that also write (default clients/8, at least 1)
  --think-ms <n>         pause between a client's cycles (default 500)
  --gitea <url>          forge origin; defaults to DEVBOARD_GITEA_URL, GITEA_URL,
                         then the checkout's HTTP(S) origin
  --dashboard <url>      dashboard origin (default http://127.0.0.1:8080)
  --project <owner/name> project whose issue list is read (default from origin)
  --db <path>            database measured as dbBytesAfter
  -h, --help             show this help

GITEA_TOKEN is required. The run exits 0 only when every threshold holds.
EOF
}

die() {
  printf 'gitea-load: %s\n' "$1" >&2
  exit 2
}

clients=8
duration=30
out="$harness/.tmp/gitea-load.json"
writers=""
think_ms=500
gitea_url=""
dashboard_url=""
project=""
db="${GITEA_DB:-}"
max_time=30
create_time=60
max_gitea_p95_ms=100
max_dashboard_p95_ms=500
max_db_bytes=1073741824
while [ "$#" -gt 0 ]; do
  case "$1" in
    --clients | --duration | --out | --writers | --think-ms | --gitea | --dashboard \
      | --project | --db)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --clients) clients=$2 ;;
        --duration) duration=$2 ;;
        --out) out=$2 ;;
        --writers) writers=$2 ;;
        --think-ms) think_ms=$2 ;;
        --gitea) gitea_url=$2 ;;
        --dashboard) dashboard_url=$2 ;;
        --project) project=$2 ;;
        --db) db=$2 ;;
      esac
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done
case "$clients" in '' | *[!0-9]* | 0) die "--clients must be a positive whole number" ;; esac
case "$duration" in '' | *[!0-9]* | 0) die "--duration must be a positive whole number" ;; esac
case "$think_ms" in '' | *[!0-9]*) die "--think-ms must be a whole number" ;; esac
if [ -z "$writers" ]; then
  writers=$((clients / 8))
  [ "$writers" -ge 1 ] || writers=1
fi
case "$writers" in '' | *[!0-9]*) die "--writers must be a whole number" ;; esac
token=${GITEA_TOKEN:-${DEVBOARD_GITEA_TOKEN:-}}
[ -n "$token" ] || die "GITEA_TOKEN is not set"

origin=$(git -C "$host_root" remote get-url origin 2>/dev/null || true)
# owner/name out of ssh://host/path, http(s)://host/path, or host:path remotes.
origin_project=$(printf '%s\n' "$origin" |
  sed -E 's#^[a-z+]+://[^/]+/##; s#^[^/:]+:##; s#\.git$##; s#^/##')
if [ -z "$project" ]; then
  project=$origin_project
fi
case "$project" in
  */*/* | "") die "no --project and no owner/name in the origin remote" ;;
  */*) ;;
  *) die "no --project and no owner/name in the origin remote" ;;
esac
owner=${project%%/*}
load_repo_name=devboard-load
load_repo="$owner/$load_repo_name"

if [ -z "$gitea_url" ]; then
  gitea_url=${DEVBOARD_GITEA_URL:-${GITEA_URL:-}}
fi
if [ -z "$gitea_url" ]; then
  case "$origin" in
    http://* | https://*)
      gitea_url=$(printf '%s\n' "$origin" | sed -E 's#^([a-z]+://[^/]+)/.*#\1#')
      ;;
    *) gitea_url="" ;;
  esac
fi
[ -n "$gitea_url" ] || die "no --gitea, no DEVBOARD_GITEA_URL, and no HTTP(S) origin"
gitea_url=${gitea_url%/}
if [ -z "$dashboard_url" ]; then
  dashboard_url=${DEVBOARD_URL:-http://127.0.0.1:8080}
fi
dashboard_url=${dashboard_url%/}

ini_value() {  # ini_value <section> <key> <file>: first value of key in [section]
  awk -v want="[$1]" -v key="$2" '
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      sub(/[ \t]+$/, "", line)
      if (line == "" || line ~ /^[#;]/) next
      if (line ~ /^\[/) { section = line; gsub(/[ \t]/, "", section); next }
      if (section != want) next
      equals = index(line, "=")
      if (equals == 0) next
      name = substr(line, 1, equals - 1)
      gsub(/[ \t]/, "", name)
      if (name != key) next
      value = substr(line, equals + 1)
      sub(/^[ \t]+/, "", value)
      sub(/[ \t]+$/, "", value)
      print value
      exit
    }' "$3"
}

discover_db() {
  # The live server is the authority: its --config names the ini, and the ini
  # names the database. GITEA_WORK_DIR resolves a relative PATH.
  local pid args config work path
  command -v pgrep >/dev/null 2>&1 || return 1
  for pid in $(pgrep -f 'gitea' 2>/dev/null || true); do
    [ -r "/proc/$pid/cmdline" ] || continue
    args=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || continue
    case " $args " in *" web "*) ;; *) continue ;; esac
    config=$(printf '%s\n' "$args" | awk '{
      for (i = 1; i < NF; i++) if ($i == "--config") { print $(i + 1); exit }
      for (i = 1; i <= NF; i++) if ($i ~ /^--config=/) { sub(/^--config=/, "", $i); print; exit }
    }')
    work=$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null |
      awk '/^GITEA_WORK_DIR=/ { sub(/^GITEA_WORK_DIR=/, ""); print; exit }')
    if [ -z "$config" ]; then
      [ -n "$work" ] || continue
      config="$work/conf/app.ini"
    fi
    [ -n "$work" ] || work=$(dirname "$(dirname "$config")")
    path=$(ini_value database PATH "$config" || true)
    [ -n "$path" ] || continue
    case "$path" in /*) printf '%s\n' "$path" ;; *) printf '%s\n' "$work/$path" ;; esac
    return 0
  done
  return 1
}

mkdir -p "$harness/.tmp"
scratch=$(mktemp -d "$harness/.tmp/gitea-load.XXXXXX")
created=0
delete_load_repo() {
  curl -sS -o /dev/null --max-time "$create_time" -X DELETE \
    -H "Authorization: token $token" "$gitea_url/api/v1/repos/$load_repo" >/dev/null 2>&1 || true
  created=0
}
cleanup() {
  if [ "$created" = 1 ]; then
    delete_load_repo
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

api() {  # api <method> <path> [json]: body in $scratch/body, status on stdout
  local method=$1 path=$2 body=${3:-} status
  if [ -n "$body" ]; then
    status=$(curl -sS --max-time "$create_time" -o "$scratch/body" -w '%{http_code}' \
      -X "$method" -H "Authorization: token $token" -H 'Content-Type: application/json' \
      -d "$body" "$gitea_url/api/v1/$path" 2>/dev/null) || status=000
  else
    status=$(curl -sS --max-time "$create_time" -o "$scratch/body" -w '%{http_code}' \
      -X "$method" -H "Authorization: token $token" \
      "$gitea_url/api/v1/$path" 2>/dev/null) || status=000
  fi
  printf '%s\n' "$status"
}

probe() {  # probe <surface> <path> <read|write> [method] [json]
  local surface=$1 path=$2 role=$3 method=${4:-GET} body=${5:-} timing status elapsed ms outcome url
  if [ "$surface" = gitea ]; then
    url="$gitea_url/api/v1/$path"
    if [ "$method" = GET ]; then
      timing=$(curl -sS --max-time "$max_time" -o "$scratch/body" \
        -w '%{http_code} %{time_total}' -H "Authorization: token $token" \
        "$url" 2>/dev/null) || timing=""
    else
      timing=$(curl -sS --max-time "$max_time" -o "$scratch/body" -w '%{http_code} %{time_total}' \
        -X "$method" -H "Authorization: token $token" -H 'Content-Type: application/json' \
        -d "$body" "$url" 2>/dev/null) || timing=""
    fi
  else
    url="$dashboard_url/$path"
    timing=$(curl -sS --max-time "$max_time" -o "$scratch/body" \
      -w '%{http_code} %{time_total}' "$url" 2>/dev/null) || timing=""
  fi
  [ -n "$timing" ] || timing="000 0"
  status=${timing%% *}
  elapsed=${timing##* }
  ms=$(awk -v t="$elapsed" 'BEGIN { printf "%.3f", t * 1000 }')
  case "$status" in
    2??) outcome=ok ;;
    *)
      if grep -q -E 'database is locked|SQLITE_BUSY' "$scratch/body" 2>/dev/null; then
        outcome=lock
      else
        outcome=http
      fi
      ;;
  esac
  printf '%s %s %s %s\n' "$ms" "$surface" "$outcome" "$role" >>"$scratch/client.$client"
}

run_client() {
  local client=$1 deadline=$2 number title
  while [ "$(date +%s)" -le "$deadline" ]; do
    probe gitea "repos/$project/issues?state=all&limit=50" read
    probe dashboard issues read
    if [ "$client" -lt "$writers" ]; then
      title="load $(date +%s%N) $client"
      probe gitea "repos/$load_repo/issues" write POST \
        "{\"title\":\"$title\",\"body\":\"load test\"}"
      number=$(jq -r '.number // empty' "$scratch/body" 2>/dev/null || true)
      if [ -n "$number" ]; then
        probe gitea "repos/$load_repo/issues/$number/comments" write POST \
          "{\"body\":\"load test comment\"}"
        probe gitea "repos/$load_repo/issues/$number" write PATCH '{"state":"closed"}'
      fi
    fi
    sleep "$(awk -v ms="$think_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
  done
}

# A leftover repository from an interrupted run would make creation fail.
api DELETE "repos/$load_repo" >/dev/null
repository=$(printf '{"name":"%s","private":true,"auto_init":false}' "$load_repo_name")
status=$(api POST "orgs/$owner/repos" "$repository")
if [ "$status" != 201 ]; then
  status=$(api POST "admin/users/$owner/repos" "$repository")
fi
full_name=$(jq -r '.full_name // empty' "$scratch/body" 2>/dev/null || true)
if [ "$status" != 201 ] || [ "$full_name" != "$load_repo" ]; then
  die "could not create the disposable repository $load_repo (HTTP $status, created '$full_name')"
fi
created=1

start=$(date +%s)
deadline=$((start + duration))
for ((client = 0; client < clients; client++)); do
  : >"$scratch/client.$client"
done
for ((client = 0; client < clients; client++)); do
  run_client "$client" "$deadline" &
done
if ! wait; then
  printf 'gitea-load: a client exited nonzero\n' >&2
fi
duration_s=$(( $(date +%s) - start ))

delete_load_repo
if [ -n "$db" ]; then
  [ -f "$db" ] || die "not a database file: $db"
else
  db=$(discover_db) || die "no --db, no GITEA_DB, and no running Gitea server to discover one from"
fi
db_bytes_after=$(wc -c <"$db")

percentile() {  # percentile <file> <p>: nearest rank over one latency per line
  if [ ! -s "$1" ]; then
    printf '0\n'
    return
  fi
  sort -n "$1" | awk -v p="$2" '
    { value[NR] = $1 }
    END {
      rank = int((p / 100) * NR)
      if (rank * 100 < p * NR) rank++
      if (rank < 1) rank = 1
      if (rank > NR) rank = NR
      print value[rank]
    }'
}

cat "$scratch"/client.* 2>/dev/null | awk '$2 == "gitea" { print $1 }' >"$scratch/gitea.lat"
cat "$scratch"/client.* 2>/dev/null | awk '$2 == "dashboard" { print $1 }' >"$scratch/dashboard.lat"
counts=$(cat "$scratch"/client.* 2>/dev/null | awk '
  $3 == "lock" { locks++ }
  $3 != "ok" { errors++ }
  $3 != "ok" && $4 == "write" { writes++ }
  END { printf "%d %d %d", locks + 0, errors + 0, writes + 0 }')
read -r lock_errors http_errors writes_failed <<<"$counts"
gitea_p50=$(percentile "$scratch/gitea.lat" 50)
gitea_p95=$(percentile "$scratch/gitea.lat" 95)
dashboard_p50=$(percentile "$scratch/dashboard.lat" 50)
dashboard_p95=$(percentile "$scratch/dashboard.lat" 95)

report=$(printf '{"clients":%d,"durationS":%d,"gitea":{"p50Ms":%s,"p95Ms":%s},' \
  "$clients" "$duration_s" "$gitea_p50" "$gitea_p95")
report+=$(printf '"dashboard":{"p50Ms":%s,"p95Ms":%s},"lockErrors":%d,"httpErrors":%d,' \
  "$dashboard_p50" "$dashboard_p95" "$lock_errors" "$http_errors")
report+=$(printf '"writesFailed":%d,"dbBytesAfter":%d}' "$writes_failed" "$db_bytes_after")
mkdir -p "$(dirname -- "$out")"
printf '%s\n' "$report" | tee "$out"

status=0
if awk -v v="$gitea_p95" -v max="$max_gitea_p95_ms" 'BEGIN { exit !(v > max) }'; then
  printf 'gitea-load: gitea p95 %s ms exceeds %s ms\n' "$gitea_p95" "$max_gitea_p95_ms" >&2
  status=1
fi
if awk -v v="$dashboard_p95" -v max="$max_dashboard_p95_ms" 'BEGIN { exit !(v > max) }'; then
  printf 'gitea-load: dashboard p95 %s ms exceeds %s ms\n' \
    "$dashboard_p95" "$max_dashboard_p95_ms" >&2
  status=1
fi
if [ "$lock_errors" -ne 0 ]; then
  printf 'gitea-load: %s lock errors\n' "$lock_errors" >&2
  status=1
fi
if [ "$http_errors" -ne 0 ]; then
  printf 'gitea-load: %s HTTP errors\n' "$http_errors" >&2
  status=1
fi
if [ "$writes_failed" -ne 0 ]; then
  printf 'gitea-load: %s failed writes\n' "$writes_failed" >&2
  status=1
fi
if [ "$db_bytes_after" -gt "$max_db_bytes" ]; then
  printf 'gitea-load: database is %s bytes, over %s\n' "$db_bytes_after" "$max_db_bytes" >&2
  status=1
fi
exit "$status"
