# Deployment and hosting target

- Status: Accepted

## Context

The interface must be reachable from a browser, access the record directory, and start and observe the agent. The deployment target — local machine, container, or remote host — determines how the process runs, how it is reached, and which prerequisites must be provided.

The choice must support:

- serving the interface to a browser;
- giving the process access to the record directory;
- starting and observing the agent;
- the access boundary in `0007-access-and-security-boundary.md`;
- the runtime, UI, transport, and persistence choices in `0001-interface-runtime-and-language.md`, `0002-browser-ui-framework.md`, `0003-browser-server-transport-and-api.md`, and `0006-run-and-interview-state-persistence.md`.

## Decision

Run the backend as a local container on the developer's machine, with the host repository mounted and the developer's omp credentials passed in.
