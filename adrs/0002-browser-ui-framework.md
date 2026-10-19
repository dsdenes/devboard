# Browser UI framework

- Status: Accepted

## Context

The interface is a browser client with a record list, run controls, a live activity log, and an interview view that presents one question at a time. The framework or structure-setting front-end library determines component structure, state handling, build tooling, and how live updates and question transitions are rendered.

The choice must support:

- distinguishing pending records from resolved ones and marking the next pending record;
- updating the activity log and run state while the agent works;
- presenting one question at a time with selectable choices and a free-form answer;
- disabling run-start and record-selection controls while a run is active;
- the runtime in `0001-interface-runtime-and-language.md` and the transport in `0003-browser-server-transport-and-api.md`.

## Decision

Use Svelte with Vite for the browser client.
