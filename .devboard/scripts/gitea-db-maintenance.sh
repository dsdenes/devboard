#!/usr/bin/env bash
# Hold one Gitea SQLite database inside a byte cap with WAL journaling and
# incremental auto-vacuum, and report what maintenance left behind.
#
# Usage: gitea-db-maintenance.sh [--db <path>] --cap-bytes <n> [--free-pages <n>]
#
# --db defaults to GITEA_DB, then to the database the running Gitea server was
# started with: the [database] PATH of the config file that process names with
# --config. No host path is baked in.
#
# The run sets journal_mode=WAL, converts the database to incremental
# auto-vacuum, and VACUUMs when the file is over the cap, over --free-pages
# (default 8192) of free pages, or still in full or no auto-vacuum mode.
# Otherwise it reclaims the free list incrementally, so a scheduled run stays
# cheap while the bound already holds.
#
# The run prints one JSON object - dbBytes, pageSize, pageCount, freePages,
# journalMode, autoVacuum - and exits 0 only when the database is at or below
# the cap with WAL and incremental auto-vacuum in force. A VACUUM that cannot
# run leaves the database as it was and is reported on stderr; the exit code
# still describes the database that remains.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: gitea-db-maintenance.sh [--db <path>] --cap-bytes <n> [--free-pages <n>]

Keeps one Gitea SQLite database inside a byte cap: WAL journaling, incremental
auto-vacuum, and a bounded free list. Prints one JSON object with dbBytes,
pageSize, pageCount, freePages, journalMode and autoVacuum, and exits 0 only
when the database is at or below the cap with WAL and incremental auto-vacuum.

  --db <path>       database file; defaults to $GITEA_DB, then to the
                    [database] PATH of the running Gitea server's config
  --cap-bytes <n>   largest acceptable database size in bytes
  --free-pages <n>  free pages that still justify a VACUUM (default 8192)
  -h, --help        show this help
EOF
}

die() {
  printf 'gitea-db-maintenance: %s\n' "$1" >&2
  exit 2
}

db="${GITEA_DB:-}"
cap=""
free_page_limit=8192
while [ "$#" -gt 0 ]; do
  case "$1" in
    --db | --cap-bytes | --free-pages)
      [ "$#" -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --db) db=$2 ;;
        --cap-bytes) cap=$2 ;;
        --free-pages) free_page_limit=$2 ;;
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
[ -n "$cap" ] || die "--cap-bytes is required"
case "$cap" in '' | *[!0-9]*) die "--cap-bytes must be a whole number of bytes" ;; esac
case "$free_page_limit" in '' | *[!0-9]*) die "--free-pages must be a whole number" ;; esac

ini_value() {
  # ini_value <section> <key> <file>: first value of key inside [section].
  awk -v want="[$1]" -v key="$2" '
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      sub(/[ \t]+$/, "", line)
      if (line == "" || line ~ /^[#;]/) next
      if (line ~ /^\[/) {
        section = line
        gsub(/[ \t]/, "", section)
        next
      }
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
    case " $args " in
      *" web "*) ;;
      *) continue ;;
    esac
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
    case "$path" in
      /*) printf '%s\n' "$path" ;;
      *) printf '%s\n' "$work/$path" ;;
    esac
    return 0
  done
  return 1
}

if [ -z "$db" ]; then
  db=$(discover_db) || die "no --db, no GITEA_DB, and no running Gitea server to discover one from"
fi
[ -f "$db" ] || die "not a database file: $db"

sqlite() {
  sqlite3 -batch -cmd '.timeout 60000' "$db" "$1"
}

warnings=()
attempt() {
  # attempt <label> <sql>: run maintenance SQL and keep a failed step's reason.
  # A step the bound does not depend on may fail against a busy server without
  # turning a healthy database into a noisy unit, so the reasons are reported
  # only when the run ends outside the bound.
  local err
  if ! err=$(sqlite "$2" 2>&1); then
    warnings+=("$1 failed: $(printf '%s' "$err" | tail -n 1)")
  fi
}

attempt 'enabling WAL' 'pragma journal_mode=wal;'

state=$(sqlite 'pragma page_size; pragma page_count; pragma freelist_count;
pragma journal_mode; pragma auto_vacuum;' | tr '\n' ' ')
read -r page_size page_count free_pages journal_mode auto_vacuum <<<"$state"
db_bytes=$(wc -c <"$db")

if [ "$auto_vacuum" != 2 ]; then
  attempt 'converting to incremental auto-vacuum' 'pragma auto_vacuum=incremental; vacuum;'
elif [ "$db_bytes" -gt "$cap" ] || [ "$free_pages" -gt "$free_page_limit" ]; then
  attempt 'vacuuming' 'vacuum;'
else
  attempt 'reclaiming the free list' 'pragma incremental_vacuum;'
fi
attempt 'optimizing' 'pragma optimize;'
attempt 'truncating the write-ahead log' 'pragma wal_checkpoint(truncate);'

state=$(sqlite 'pragma page_size; pragma page_count; pragma freelist_count;
pragma journal_mode; pragma auto_vacuum;' | tr '\n' ' ')
read -r page_size page_count free_pages journal_mode auto_vacuum <<<"$state"
db_bytes=$(wc -c <"$db")

printf '{"dbBytes":%s,"pageSize":%s,"pageCount":%s,"freePages":%s,' \
  "$db_bytes" "$page_size" "$page_count" "$free_pages"
printf '"journalMode":"%s","autoVacuum":%s}\n' "$journal_mode" "$auto_vacuum"

status=0
if [ "$db_bytes" -gt "$cap" ]; then
  printf 'gitea-db-maintenance: %s bytes exceeds the %s byte cap\n' "$db_bytes" "$cap" >&2
  status=1
fi
if [ "$journal_mode" != wal ]; then
  printf 'gitea-db-maintenance: journal mode is %s, not wal\n' "$journal_mode" >&2
  status=1
fi
if [ "$auto_vacuum" != 2 ]; then
  printf 'gitea-db-maintenance: auto_vacuum is %s, not incremental\n' "$auto_vacuum" >&2
  status=1
fi
if [ "$status" -ne 0 ]; then
  for warning in "${warnings[@]}"; do
    printf 'gitea-db-maintenance: %s\n' "$warning" >&2
  done
fi
exit "$status"
