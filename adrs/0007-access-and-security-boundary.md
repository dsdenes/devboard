---
schemaVersion: 0.2.0
id: "0007"
title: Access and security boundary
status: accepted
date: 2026-10-19
deciders: ["@dsdenes"]
affects:
  - type: path
    pattern: .devboard/Dockerfile
---
# Access and security boundary

## Context

The interface starts agent runs, exposes a live activity log, and accepts answers that cause the agent to act on the repository and change a record's status. The access model — who may reach the interface, from where, and under what authentication or authorization — determines the bind surface and trust boundary.

The choice must support:

- permitting the developer to perform every action the interface requires;
- controlling who can start runs and submit answers;
- defining the network surface the interface binds to and who can reach it;
- permitting the interface to read the record directory, start the agent, and record a resolution;
- the deployment target in `0008-deployment-and-hosting-target.md`.

## Decision

The server binds to 127.0.0.1 and the interface requires no authentication. Only the developer on the local machine can reach it.
