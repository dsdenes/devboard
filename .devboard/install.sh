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
#
# Skills under omp/skills/devboard-* follow the ownership rule instead: the
# package always wins a marked name, so a differing copy is replaced without
# --force, an entry the package does not ship is deleted, and a symlinked
# marked entry becomes a real directory. Every unmarked skill belongs to the
# host and is never read, rewritten, or deleted.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install.sh [--force] [host-path]

Copies every file under omp/ to <host>/.omp/ at the same relative path.
The host path defaults to the git repository root of the current directory.
Skills in omp/skills/devboard-* are package-owned and always replaced.
The install also adds one /.omp/skills/devboard-* line per shipped skill to
the host .gitignore.

  --force      overwrite files outside devboard-* that differ from the installed copy
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

mkdir -p -- "$host/.devboard"

target_omp="$host/.omp"
source_skills="$source_omp/skills"
managed_prefix='devboard-'

# The agent-facing prompt and extension trees live under the host `.devboard`
# payload, at the paths the installed commands and wrappers import.
payload_installed=0
for payload in prompts extensions; do
  source_payload="$source_dir/$payload"
  target_payload="$host/.devboard/$payload"
  [ -d "$source_payload" ] || continue
  mkdir -p -- "$target_payload"
  while IFS= read -r -d '' source_file; do
    relative_path="${source_file#"$source_payload"/}"
    destination="$target_payload/$relative_path"
    if [ -f "$destination" ] && cmp -s -- "$source_file" "$destination"; then
      continue
    fi
    mkdir -p -- "$(dirname -- "$destination")"
    cp -- "$source_file" "$destination"
    payload_installed=$((payload_installed + 1))
  done < <(find "$source_payload" -type f -print0)
done

# An installed host records its version beside the payload. A source checkout
# keeps its checked-in package.json marker instead.
if [ ! -f "$host/.devboard/package.json" ]; then
  version="$(sed -n 's/^version = "\([0-9][0-9.]*\)"$/\1/p' "$source_dir/Cargo.toml" | head -n 1)"
  if [ -n "$version" ]; then
    printf '{"name":"@dsdenes/devboard","version":"%s"}\n' "$version" \
      > "$host/.devboard/devboard.json"
  fi
fi
mkdir -p -- "$host/.omp/extensions" "$host/.devboard/extensions"
# The harness no longer ships runtime extensions: remove the retired
# TypeScript wrappers an older install left behind.
for retired in "$host/.omp/extensions" "$host/.devboard/extensions"; do
  find "$retired" -type f -name '*.ts' -delete
done

# The fixed wrapper files keep the refuse-unless---force rule; the marked
# skills are collected separately because the package owns them outright.
regular_paths=()
managed_skills=()
while IFS= read -r -d '' source_file; do
  relative_path="${source_file#"$source_omp"/}"
  case "$relative_path" in
    "skills/$managed_prefix"*)
      skill_name="${relative_path#skills/}"
      skill_name="${skill_name%%/*}"
      known=0
      for existing in ${managed_skills[@]+"${managed_skills[@]}"}; do
        if [ "$existing" = "$skill_name" ]; then
          known=1
          break
        fi
      done
      if [ "$known" -eq 0 ]; then managed_skills+=("$skill_name"); fi
      ;;
    *) regular_paths+=("$relative_path") ;;
  esac
done < <(find "$source_omp" -type f -print0)

# The binary installs and lists the marked skills sorted by name; sorting here
# keeps the host tree and the ignore file identical between both installers.
if [ "${#managed_skills[@]}" -gt 0 ]; then
  mapfile -t managed_skills < <(printf '%s\n' "${managed_skills[@]}" | LC_ALL=C sort)
fi

if [ "${#regular_paths[@]}" -eq 0 ] && [ "${#managed_skills[@]}" -eq 0 ]; then
  printf 'install: no files under %s\n' "$source_omp" >&2
  exit 1
fi

conflicts=()
for relative_path in ${regular_paths[@]+"${regular_paths[@]}"}; do
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
for relative_path in ${regular_paths[@]+"${regular_paths[@]}"}; do
  destination="$target_omp/$relative_path"
  if [ -f "$destination" ] && cmp -s -- "$source_omp/$relative_path" "$destination"; then
    continue
  fi
  mkdir -p -- "$(dirname -- "$destination")"
  cp -- "$source_omp/$relative_path" "$destination"
  installed=$((installed + 1))
done

# True when `destination` is exactly the package tree `source`: every shipped
# file present with identical bytes, no extra entry, no symlink, no extra
# directory. An unchanged skill is left completely untouched.
skill_matches() {
  local source=$1 destination=$2
  [ -d "$destination" ] && [ ! -L "$destination" ] || return 1
  local source_file relative
  while IFS= read -r -d '' source_file; do
    relative="${source_file#"$source"/}"
    [ -f "$destination/$relative" ] && [ ! -L "$destination/$relative" ] || return 1
    cmp -s -- "$source_file" "$destination/$relative" || return 1
  done < <(find "$source" -type f -print0)
  local entry
  while IFS= read -r -d '' entry; do
    relative="${entry#"$destination"/}"
    if [ -L "$entry" ]; then return 1; fi
    if [ -d "$source/$relative" ]; then
      [ -d "$entry" ] || return 1
    else
      [ -f "$entry" ] || return 1
    fi
  done < <(find "$destination" -mindepth 1 -print0)
  return 0
}

for skill_name in ${managed_skills[@]+"${managed_skills[@]}"}; do
  skill_source="$source_skills/$skill_name"
  destination="$target_omp/skills/$skill_name"
  if skill_matches "$skill_source" "$destination"; then
    continue
  fi
  # A marked entry is replaced wholesale: a symlink is unlinked rather than
  # followed, so nothing outside the host tree is ever written.
  if [ -L "$destination" ] || [ -e "$destination" ]; then
    rm -rf -- "$destination"
  fi
  mkdir -p -- "$(dirname -- "$destination")"
  cp -R -- "$skill_source" "$destination"
  copied=$(find "$skill_source" -type f -print | wc -l)
  installed=$((installed + copied))
done

# A marked directory the package no longer ships is package-owned too: prune
# it. Every unmarked name is left exactly as the host wrote it. A package that
# ships no skills/ tree at all is a partial fixture, so nothing is pruned.
if [ -d "$source_skills" ] && [ -d "$target_omp/skills" ]; then
  while IFS= read -r -d '' entry; do
    entry_name=$(basename -- "$entry")
    case "$entry_name" in
      "$managed_prefix"*)
        shipped=0
        for skill_name in ${managed_skills[@]+"${managed_skills[@]}"}; do
          if [ "$entry_name" = "$skill_name" ]; then
            shipped=1
            break
          fi
        done
        if [ "$shipped" -eq 0 ]; then rm -rf -- "$entry"; fi
        ;;
    esac
  done < <(find "$target_omp/skills" -mindepth 1 -maxdepth 1 -print0)
fi

# The ignore lines cover the installed payload and wrappers, so a host's git
# status stays free of them. The write is idempotent: a rerun adds nothing.
ignore_path="$host/.gitignore"
missing=()
for entry in "/.devboard" "/.omp/commands" "/.omp/extensions" "/.omp/mcp.json"; do
  if [ ! -f "$ignore_path" ] || ! grep -Fxq -- "$entry" "$ignore_path"; then
    missing+=("$entry")
  fi
done
for skill_name in ${managed_skills[@]+"${managed_skills[@]}"}; do
  entry="/.omp/skills/$skill_name"
  if [ ! -f "$ignore_path" ] || ! grep -Fxq -- "$entry" "$ignore_path"; then
    missing+=("$entry")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  {
    if [ -s "$ignore_path" ] && [ -n "$(tail -c 1 -- "$ignore_path")" ]; then printf '\n'; fi
    printf '%s\n' "${missing[@]}"
  } >>"$ignore_path"
fi

# The root contract is copied only when absent; host content is left alone.
if [ -f "$source_dir/templates/host-AGENTS.md" ] && [ ! -e "$host/AGENTS.md" ]; then
  cp -- "$source_dir/templates/host-AGENTS.md" "$host/AGENTS.md"
fi

printf 'install: %d file(s) installed into %s\n' "$((installed + payload_installed))" "$target_omp"
