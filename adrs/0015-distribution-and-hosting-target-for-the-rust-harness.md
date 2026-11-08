---
schemaVersion: 0.2.0
id: "0015"
title: Distribution and hosting target for the Rust harness
status: accepted
date: 2026-11-03
deciders: ["@dsdenes"]
supersedes: ["0008"]
affects:
  - type: path
    pattern: .devboard/dist-workspace.toml
  - type: path
    pattern: .devboard/Dockerfile
  - type: path
    pattern: .gitea/workflows/**
  - type: path
    pattern: .github/workflows/**
---
# Distribution and hosting target for the Rust harness

## Context

Record `0008-deployment-and-hosting-target.md` fixed the deployment shape: a local container with
the host repository mounted and the developer's omp credentials passed in. The runtime decision in
`0013-interface-runtime-and-language-on-rust.md` changes what has to be distributed. A host installs
the harness, runs it against its own repository, and expects each running dashboard to update itself
without an operator click. The distribution path also carries the installer, the managed wrappers
and skills, and the release metadata every installed dashboard reads.

The npm package `@dsdenes/devboard` is the current carrier. It requires Node, Bun, and npm on the
host, and its release metadata lives in a JavaScript registry, so it cannot serve a host that has no
JavaScript toolchain.

## Decision

Distribute the harness as native binaries built by cargo-dist and published to GitHub Releases, with
Gitea as the forge where version control happens and the authority for release metadata.

- `.devboard/dist-workspace.toml` declares the targets: Linux x64 and arm64 for both the gnu and
  musl libc, and macOS x64 and arm64, plus the shell and PowerShell installers. `dist plan` must
  list exactly those artifacts.
- One release publishes those artifacts to GitHub Releases. The same tag carries a Gitea release
  holding the manifest and checksums, and every installed dashboard reads that manifest at startup
  and every 60 seconds.
- The local container keeps the host-repository mount and the credential passthrough, and its image
  is built on a Rust base; no Bun image and no `bun run server/index.ts` entry point remains.
- The image carries the runtime prerequisites it can package: `git`, which every git-backed action
  spawns by name, and `ca-certificates` for TLS. The agent CLI is the operator's mount, named by
  `AGENT_COMMAND`; `serve` refuses to start, naming the missing program, when it cannot resolve an
  executable the image could spawn, so a container never serves pages whose every Start and
  git-backed action would fail on a missing executable. The image runs as root while the documented
  host-repository mount belongs to the invoking user, so its system git config trusts that mount;
  without it every git-backed action fails with "dubious ownership" instead.
- The installer writes the managed `.omp/skills/devboard-*` directories, commands, and extensions,
  the host `AGENTS.md`, and one `.gitignore` line; a rerun adds nothing, and `doctor` compares each
  managed skill with the released artifact.
- The updater installs a newer version, replaces the running process once, reloads every connected
  page, and leaves a live run or a background worker running on the version that started it.

## Consequences

- A host installs and updates with one command and needs no Node, Bun, or npm at runtime.
- Release metadata is read from Gitea, so a published GitHub release alone is not a finished
  release until the Gitea manifest and checksums are present and verified.
- The container remains the local deployment target, and the binary serves the same HTTP surface
  and the same `/ready` contract the previous image did.
- A container is started with the agent CLI mounted and named by `AGENT_COMMAND`; without it the
  dashboard exits at startup with the program named, instead of serving a UI whose Start, flow
  checkpoint, goal commit, commit gate, and publish would all fail on a missing executable.
