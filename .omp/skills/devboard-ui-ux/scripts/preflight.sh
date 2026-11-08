#!/bin/sh
# The UI/UX skill preflight gate.
#
# Prints the harness preflight JSON for a project root:
#
#   sh "<skill>/scripts/preflight.sh" [project-root]
#
# The harness executable is resolved in this order, and the first candidate
# wins: $DEVBOARD_BIN, then a harness directory named by
# $DEVBOARD_HARNESS_DIR, then the checkout's .devboard found from the git top
# level, the project root, or the working directory, then the installed prefix
# beside $PI_CODING_AGENT_DIR, then devboard on PATH. A harness directory
# offers bin/devboard, then target/release/devboard, then
# target/debug/devboard. No JavaScript runtime is required.

set -eu

project=${1:-.}

devboard_bin=
if [ -n "${DEVBOARD_BIN:-}" ] && [ -x "${DEVBOARD_BIN}" ] && [ ! -d "${DEVBOARD_BIN}" ]; then
  devboard_bin=$DEVBOARD_BIN
fi
if [ -z "$devboard_bin" ]; then
  top=$(git rev-parse --show-toplevel 2>/dev/null) || top=
  for harness in \
    "${DEVBOARD_HARNESS_DIR:-}" \
    "${top:+$top/.devboard}" \
    "$project/.devboard" \
    "$(pwd)/.devboard" \
    "${PI_CODING_AGENT_DIR:+$PI_CODING_AGENT_DIR/..}"
  do
    [ -n "$harness" ] || continue
    for relative in bin/devboard target/release/devboard target/debug/devboard; do
      if [ -x "$harness/$relative" ] && [ ! -d "$harness/$relative" ]; then
        devboard_bin=$harness/$relative
        break 2
      fi
    done
  done
fi
if [ -z "$devboard_bin" ] && command -v devboard >/dev/null 2>&1; then
  devboard_bin=$(command -v devboard)
fi

if [ -z "$devboard_bin" ]; then
  printf '%s\n' "preflight: no devboard executable found: searched DEVBOARD_BIN, DEVBOARD_HARNESS_DIR, then .devboard/bin/devboard, .devboard/target/release/devboard, and .devboard/target/debug/devboard from the git top level, the project root, the working directory, PI_CODING_AGENT_DIR/.., and PATH; build it with 'cd .devboard && cargo build' or set DEVBOARD_BIN" >&2
  exit 127
fi

exec "$devboard_bin" preflight ui-ux "$@"
