# Devboard ADR interface

Local browser interface for the records in `adrs/`. This slice lists every record, distinguishes records awaiting a decision (`Status: Proposed`) from resolved records, and marks the pending record an agent run would take up first.

## Stack

- Backend: TypeScript on Bun, serving the built client and one WebSocket at `/ws`.
- Client: Svelte built with Vite.
- Records: read from `adrs/` on every `listRecords` command, so files added or removed while the server runs appear without a restart.

## Build and run

```bash
bun install
bun run build
ADRS_DIR="$PWD/adrs" bun run start
```

Open `http://127.0.0.1:8080/`. The server binds to `127.0.0.1` by default; set `HOST`, `PORT`, `ADRS_DIR`, or `STATIC_DIR` to override.

## Container

```bash
docker build -t devboard-adr-ui .
docker run --rm -d --name devboard-adr-ui -p 127.0.0.1:8080:8080 \
  -v "$PWD:/repo:ro" devboard-adr-ui
```

The container reads `/repo/adrs` and listens on port `8080`. Docker publishes the port on the host's loopback interface only. The container process binds `0.0.0.0` because Docker forwards published traffic to the container interface; the local-only access boundary is enforced by the `127.0.0.1` host publish.

## WebSocket contract

The client sends:

```json
{ "type": "listRecords" }
```

The server answers:

```json
{
  "type": "records",
  "records": [
    { "file": "0001-example.md", "title": "Example", "status": "Accepted", "pending": false }
  ],
  "next": null
}
```

- A record's title is its first level-one heading.
- A record is pending exactly when its status is `Proposed`; every other status is resolved.
- Records are ordered by file name, and `next` is the first pending record in that order (the lowest-numbered pending file).

## Tests

```bash
bun test
```
