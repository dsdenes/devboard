#!/usr/bin/env bash
# Install the harness agent wrappers into the host's .omp directory.
#
# Usage: install.sh [--force] [host-path]
#
# Copies every file under this directory's omp/ tree to the same relative path
# under <host>/.omp/. The host path is discovered with
# `git rev-parse --show-toplevel` when omitted. Files that already match are left
# untouched, unrelated files in <host>/.omp/ are never removed, and a differing
# file stops the run unless --force is given.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [--force] [host-path]

Copies every file under omp/ to <host>/.omp/ at the same relative path.
The host path defaults to the git repository root of the current directory.

  --force      overwrite files that differ from the installed copy
  -h, --help   show this help
EOF
}

force=0
host_arg=""
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      printf 'install: unknown option: %s\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$host_arg" ]; then
        printf 'install: unexpected extra argument: %s\n' "$arg" >&2
        exit 2
      fi
      host_arg="$arg"
      ;;
  esac
done

source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
source_omp="$source_dir/omp"
if [ ! -d "$source_omp" ]; then
  printf 'install: no omp directory beside %s\n' "$0" >&2
  exit 1
fi

if [ -z "$host_arg" ]; then
  if ! host_arg=$(git rev-parse --show-toplevel 2>/dev/null); then
    printf 'install: no host path given and the working directory is not a git work tree\n' >&2
    exit 1
  fi
fi

if ! host=$(cd -- "$host_arg" 2>/dev/null && pwd); then
  printf 'install: host path does not exist: %s\n' "$host_arg" >&2
  exit 1
fi

if [ ! -d "$host/.devboard" ]; then
  printf 'install: no .devboard directory in %s; install the harness there first\n' "$host" >&2
  exit 1
fi

target_omp="$host/.omp"

relative_paths=()
while IFS= read -r -d '' source_file; do
  relative_paths+=("${source_file#"$source_omp"/}")
done < <(find "$source_omp" -type f -print0)

if [ "${#relative_paths[@]}" -eq 0 ]; then
  printf 'install: no files under %s\n' "$source_omp" >&2
  exit 1
fi

conflicts=()
for relative_path in "${relative_paths[@]}"; do
  destination="$target_omp/$relative_path"
  if [ -e "$destination" ] && ! cmp -s -- "$source_omp/$relative_path" "$destination"; then
    conflicts+=("$relative_path")
  fi
done

if [ "${#conflicts[@]}" -gt 0 ] && [ "$force" -eq 0 ]; then
  printf 'install: refusing to overwrite differing files in %s:\n' "$target_omp" >&2
  printf '  %s\n' "${conflicts[@]}" >&2
  printf 'install: rerun with --force to replace them\n' >&2
  exit 1
fi

installed=0
for relative_path in ${relative_paths[@]+"${relative_paths[@]}"}; do
  destination="$target_omp/$relative_path"
  if [ -f "$destination" ] && cmp -s -- "$source_omp/$relative_path" "$destination"; then
    continue
  fi
  mkdir -p -- "$(dirname -- "$destination")"
  cp -- "$source_omp/$relative_path" "$destination"
  installed=$((installed + 1))
done

printf 'install: %d file(s) installed into %s\n' "$installed" "$target_omp"
