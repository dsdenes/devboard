# Harness instructions

## The source tree is not the installed harness

This checkout builds and releases the harness; hosts run an installed copy.

- `<host>/.devboard` is a real npm prefix holding
  `node_modules/@dsdenes/devboard-harness`. It is never a symlink to this checkout and never a
  copy of these sources.
- The public `@dsdenes/devboard` launcher at `launcher/` installs, updates, and checks hosts.
  The harness itself is a private GitHub Release, never a registry package.
- Fix the harness here, then release it. An installed host picks the release up on its own; do
  not edit an installed package in a host by hand.

## Install, update, and reload

```bash
npx @dsdenes/devboard install   # real prefix, real wrapper dirs, one dashboard
npx @dsdenes/devboard update    # newest release, no restart
npx @dsdenes/devboard doctor    # one PASS or FAIL line per check
```

A running dashboard checks for a newer release immediately and every 60 seconds, verifies the
tarball's `.sha256`, and installs it into its own prefix without stopping. It keeps serving the
code it loaded until someone clicks the reload control
(`data-testid="reload-devboard"`), which restarts the server from the installed package and
reloads the page. Never restart a dashboard by hand and never symlink a host.

## Restart the source interface after every change

The canonical source dashboard serves this checkout. After a change under `.devboard/`, rebuild
and restart it so the page reflects the new code:

1. `bun run build` from this directory.
2. Stop the running source server and start it again with the same host paths it was given.
3. Confirm it answers on its port before continuing.

For an installed host, the reload control is the only restart path.

## Verify and release

Before a commit that changes the harness:

```bash
bun run build
bun test
bunx tsc --noEmit
bun run verify:install
bun run verify:update
bun run verify:ui
```

Merge into `main` and push. The release workflow tests, packs `templates/host-AGENTS.md` with the
harness, publishes the launcher version, and creates the GitHub Release. Then run
`bun run publish` from the integration checkout: it waits for that workflow, verifies the release
and launcher version, and reports each dashboard without restarting it.
