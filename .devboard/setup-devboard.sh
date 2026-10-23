#!/usr/bin/env bash
# Install the canonical Devboard harness into a host and start its interface.
#
# Usage: setup-devboard.sh [--force] [--no-ui] [--port N] [host-path]
#
# The host defaults to the current working directory. The harness is never
# copied: <host>/.devboard, <host>/.omp/commands and <host>/.omp/extensions
# become symlinks to the canonical checkout at $DEVBOARD_HOME (default
# ~/devboard), and the links are recorded in <host>/.gitignore. The client is
# then rebuilt and the interface is started in the background for that host.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: setup-devboard.sh [--force] [--no-ui] [--port N] [host-path]

  host-path   install here; defaults to the current working directory
  --force     replace a real directory sitting at a link path
  --no-ui     install the links only; do not build or start the interface
  --port N    interface port; defaults to $PORT or the first free port at 8080
EOF
}

fail() {
  printf 'setup-devboard: %s\n' "$*" >&2
  exit 1
}

force=0
start_ui=1
port=""
port_given=0
host_arg=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      force=1
      ;;
    --no-ui)
      start_ui=0
      ;;
    --port)
      [ "$#" -ge 2 ] || fail "--port needs a value"
      port=$2
      port_given=1
      shift
      ;;
    --port=*)
      port=${1#--port=}
      port_given=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      if [ "$#" -gt 1 ]; then
        fail "accepts at most one host path"
      elif [ "$#" -eq 1 ]; then
        host_arg=$1
      fi
      break
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      [ -z "$host_arg" ] || fail "accepts at most one host path"
      host_arg=$1
      ;;
  esac
  shift
done

home=${DEVBOARD_HOME:-$HOME/devboard}
[ -d "$home/.devboard" ] || fail "canonical harness not found at $home/.devboard"
[ -d "$home/.devboard/omp/commands" ] || fail "missing canonical wrappers under $home/.devboard/omp"
[ -d "$home/.devboard/omp/extensions" ] || fail "missing canonical wrappers under $home/.devboard/omp"

harness=$(cd -- "$home/.devboard" && pwd -P)
home=$(cd -- "$home" && pwd -P)

target=${host_arg:-$PWD}
[ -d "$target" ] || fail "host path does not exist: $target"
host=$(cd -- "$target" && pwd -P)

same_target() {
  local target_path=$1 source=$2
  if readlink -f -- "$target_path" >/dev/null 2>&1; then
    [ "$(readlink -f -- "$target_path")" = "$(readlink -f -- "$source")" ]
  else
    [ "$(readlink -- "$target_path")" = "$source" ]
  fi
}

link_path() {
  local source=$1 target_path=$2
  if [ -L "$target_path" ]; then
    if same_target "$target_path" "$source"; then
      printf 'setup-devboard: %s is already linked\n' "$target_path"
      return 0
    fi
    rm -f -- "$target_path"
  elif [ -e "$target_path" ]; then
    rm -rf -- "$target_path"
  fi
  mkdir -p -- "$(dirname -- "$target_path")"
  ln -s -- "$source" "$target_path"
  printf 'setup-devboard: linked %s -> %s\n' "$target_path" "$source"
}

ensure_ignored() {
  local entry=$1 ignore="$host/.gitignore"
  if [ -f "$ignore" ] && grep -qxF -e "$entry" -- "$ignore"; then
    return 0
  fi
  if [ -s "$ignore" ] && [ -n "$(tail -c 1 -- "$ignore")" ]; then
    printf '\n' >> "$ignore"
  fi
  printf '%s\n' "$entry" >> "$ignore"
}

if [ "$host" = "$home" ]; then
  printf 'setup-devboard: %s is the canonical checkout; no links needed\n' "$host"
else
  # Refuse before touching anything when a link path holds a real directory.
  conflicts=()
  for path in "$host/.devboard" "$host/.omp/commands" "$host/.omp/extensions"; do
    if [ ! -L "$path" ] && [ -e "$path" ]; then
      conflicts+=("$path")
    fi
  done
  if [ "${#conflicts[@]}" -gt 0 ] && [ "$force" -eq 0 ]; then
    printf 'setup-devboard: refusing to replace these paths with symlinks:\n' >&2
    printf '  %s\n' "${conflicts[@]}" >&2
    printf 'setup-devboard: remove them or rerun with --force\n' >&2
    exit 1
  fi

  link_path "$harness" "$host/.devboard"
  link_path "$harness/omp/commands" "$host/.omp/commands"
  link_path "$harness/omp/extensions" "$host/.omp/extensions"
  ensure_ignored "/.devboard"
  ensure_ignored "/.omp/commands"
  ensure_ignored "/.omp/extensions"
  printf 'setup-devboard: recorded the links in %s\n' "$host/.gitignore"
fi

if [ "$start_ui" -eq 0 ]; then
  exit 0
fi

command -v bun >/dev/null 2>&1 || fail "bun is required to build and start the interface"

if [ -n "$port" ]; then
  case "$port" in
    *[!0-9]*|'') fail "invalid port: $port" ;;
  esac
else
  port=${PORT:-8080}
  case "$port" in
    *[!0-9]*|'') fail "invalid PORT: $port" ;;
  esac
fi

port_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

cd -- "$harness"
if [ ! -d node_modules ]; then
  printf 'setup-devboard: installing client dependencies\n'
  bun install
fi
printf 'setup-devboard: building the client\n'
bun run build

mkdir -p -- "$harness/.tmp"
slug=$(printf '%s' "$host" | cksum | cut -d ' ' -f 1)
state="$harness/.tmp/devboard-$slug.state"
log="$harness/.tmp/devboard-$slug.log"

if [ -f "$state" ]; then
  read -r state_port state_pid < "$state" || true
  if [ -n "${state_pid:-}" ] && kill -0 "$state_pid" 2>/dev/null; then
    printf 'setup-devboard: interface already running at http://127.0.0.1:%s/ (pid %s)\n' \
      "$state_port" "$state_pid"
    exit 0
  fi
  rm -f -- "$state"
fi

if [ "$port_given" -eq 1 ] || [ -n "${PORT:-}" ]; then
  port_free "$port" || fail "port $port is already in use"
else
  start=8080
  port=""
  candidate=$start
  limit=$((start + 100))
  while [ "$candidate" -le "$limit" ]; do
    if port_free "$candidate"; then
      port=$candidate
      break
    fi
    candidate=$((candidate + 1))
  done
  [ -n "$port" ] || fail "no free port between $start and $limit"
fi

launcher=(bun run start)
if command -v setsid >/dev/null 2>&1; then
  launcher=(setsid -- "${launcher[@]}")
fi

printf 'setup-devboard: starting the interface for %s\n' "$host"
env HOST="${HOST:-127.0.0.1}" PORT="$port" \
  ADRS_DIR="$host/adrs" REPO_DIR="$host" GOAL_FILE="$host/GOAL.md" \
  STATIC_DIR="$harness/dist" AGENT_COMMAND="${AGENT_COMMAND:-omp acp}" \
  nohup "${launcher[@]}" >"$log" 2>&1 </dev/null &
pid=$!
printf '%s %s\n' "$port" "$pid" > "$state"

url="http://127.0.0.1:$port/"
ready=0
for _ in $(seq 1 80); do
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 1 "$url" 2>/dev/null && ready=1 && break
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && ready=1 && break
  fi
  sleep 0.25
done

if [ "$ready" -eq 0 ]; then
  kill "$pid" 2>/dev/null || true
  rm -f -- "$state"
  printf 'setup-devboard: interface did not answer on %s\n' "$url" >&2
  tail -n 20 -- "$log" >&2 || true
  exit 1
fi

printf 'setup-devboard: interface ready at %s (pid %s)\n' "$url" "$pid"
