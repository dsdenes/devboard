# Access and security boundary

- Status: Proposed

## Context

The interface starts agent runs, exposes a live activity log, and accepts answers that cause the agent to act on the repository and change a record's status. The access model — who may reach the interface, from where, and under what authentication or authorization — determines the bind surface and trust boundary.

The choice must support:

- permitting the developer to perform every action the interface requires;
- controlling who can start runs and submit answers;
- defining the network surface the interface binds to and who can reach it;
- permitting the interface to read the record directory, start the agent, and record a resolution;
- the deployment target in `0008-deployment-and-hosting-target.md`.

## Decision
