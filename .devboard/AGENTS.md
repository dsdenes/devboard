# Harness instructions

## The source tree is not the installed harness

This checkout builds and releases the harness; hosts run an installed copy.

- `<host>/.devboard` is a real npm prefix holding
  `node_modules/@dsdenes/devboard`. It is never a symlink to this checkout and never a copy of
  these sources.
- The public `@dsdenes/devboard` package at this directory carries the CLI and the whole harness.
  `bin/devboard.mjs` installs, updates, and checks hosts; npm is the version and artifact
  authority. The canonical Gitea release is a fallback record, not a second package.
- Fix the harness here, then release it. An installed host picks the release up on its own; do
  not edit an installed package in a host by hand.

## Install, update, and reload

```bash
npx @dsdenes/devboard install   # real prefix, real wrapper dirs, one dashboard
npx @dsdenes/devboard update    # newest release, no restart
npx @dsdenes/devboard doctor    # one PASS or FAIL line per check
```

A running dashboard checks npm for a newer version immediately and every 60 seconds and installs
it into its own prefix without stopping. When npm cannot serve it and `DEVBOARD_GITEA_URL` is
configured, the Gitea tarball and its `.sha256` are the fallback. It keeps serving the
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

Merge into `main` and push. The release workflow tests, packs the complete public package,
publishes `@dsdenes/devboard@<version>` to npmjs, and creates the Gitea release with the fallback
tarball and `.sha256`. Then run `bun run publish` from the integration checkout: it waits for
that workflow, verifies the npm package and release assets, and reports each dashboard without
restarting it.
