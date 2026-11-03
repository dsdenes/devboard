#!/bin/sh
# The UI/UX skill preflight gate.
#
# Prints the harness preflight JSON for a project root:
#
#   sh "<skill>/scripts/preflight.sh" [project-root]
#
# `devboard` comes from PATH, then $DEVBOARD_BIN, then
# <project>/.devboard/bin/devboard. No JavaScript runtime is required.

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project=${1:-.}

devboard_bin=
if command -v devboard >/dev/null 2>&1; then
  devboard_bin=$(command -v devboard)
elif [ -n "${DEVBOARD_BIN:-}" ] && [ -x "${DEVBOARD_BIN}" ]; then
  devboard_bin=${DEVBOARD_BIN}
else
  for candidate in \
    "./.devboard/bin/devboard" \
    "$project/.devboard/bin/devboard" \
    "$here/../../../.devboard/bin/devboard" \
    "$here/../../../../.devboard/bin/devboard"
  do
    if [ -x "$candidate" ]; then
      devboard_bin=$candidate
      break
    fi
  done
fi

if [ -z "$devboard_bin" ]; then
  printf '%s\n' "preflight: devboard not found; install it on PATH, set DEVBOARD_BIN, or build .devboard/bin/devboard" >&2
  exit 127
fi

exec "$devboard_bin" preflight ui-ux "$@"
