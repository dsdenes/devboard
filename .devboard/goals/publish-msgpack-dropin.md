## Objective

In this repository's host project — `packages/msgpack`, `scripts/build.ts`, `test/`, `bench/`,
`verification/`, `examples/`, root `package.json`/`bun.lock`, `README.md`, and `CHANGELOG.md` —
turn the replacement library into the real npm package `@dsdenes/msgpack@1.0.0` and publish it
publicly to `registry.npmjs.org`. Consumers install that package directly and replace imports;
they never configure a `@msgpack/msgpack` dependency alias or a `file:` dependency. The published
package keeps the existing byte-identical encoding, value-identical decoding, and error parity
with `msgpack-javascript` 3.1.3, adds a default namespace export and shipped-artifact subpaths,
ships its lib, README, and ISC license, and updates this repository's adoption surfaces,
examples, tests, and documentation to the new name.

## Success criteria

**Package identity and tarball**

- `packages/msgpack/package.json` names the package exactly `@dsdenes/msgpack`, versions it
  exactly `1.0.0`, has no `private` field, sets `"license": "ISC"`, and carries `repository`
  (`git+https://github.com/dsdenes/devboard.git`, directory `packages/msgpack`), `homepage`,
  `bugs`, `keywords`, `sideEffects: false`, and `files` covering `lib`, `README.md`, and
  `LICENSE`.
- `packages/msgpack/README.md` exists and documents `npm install @dsdenes/msgpack`, named and
  default imports from `@dsdenes/msgpack`, and the shipped subpaths. It contains no instruction
  to install or import `@msgpack/msgpack` and no dependency-alias example.
- `packages/msgpack/LICENSE` is byte-identical to
  `node_modules/msgpack-javascript-original/LICENSE` and `package.json` declares ISC.
- `npm pack` produces a tarball whose complete file list is exactly `package/package.json`,
  `package/README.md`, `package/LICENSE`, and files under `package/lib/`; every one of
  `lib/index.mjs`, `lib/index.cjs`, `lib/index.d.ts`, and `lib/msgpack.js` is present, and no
  `src/`, `test/`, `bench/`, `verification/`, `examples/`, `tsconfig`, or workspace file is
  present.

**Module surface**

- The package root has a default export whose own enumerable properties are the named runtime
  exports of `@dsdenes/msgpack`; for every named export that is not `default`, the default
  object's property is the same reference (`default.encode === encode`, `default.Decoder ===
  Decoder`, and so on).
- `packages/msgpack/lib/index.d.ts` declares that default export with the same property types,
  and a strict TypeScript consumer compiles both `import msgpack from "@dsdenes/msgpack"` with
  `msgpack.encode(...)` and `import { encode } from "@dsdenes/msgpack"` without diagnostics.
- Node ESM default import, Node ESM named imports, Bun ESM default and named imports, and
  CommonJS `require("@dsdenes/msgpack")` all resolve. CommonJS `require("@dsdenes/msgpack").default`
  exposes the same named API, so `esModuleInterop`-compiled default imports work.
- `exports` maps `"."` to the existing conditional ESM/CJS/type entry points, `"./package.json"`
  to `"./package.json"`, and `"./lib/*"` to `"./lib/*"`. All of these resolve under Node:
  `@dsdenes/msgpack/package.json`, `@dsdenes/msgpack/lib/index.mjs`,
  `@dsdenes/msgpack/lib/index.cjs`, and `@dsdenes/msgpack/lib/msgpack.js`. The declaration file
  is present at the resolved `lib/index.d.ts`.
- Reference-internal paths (`dist.esm/*`, `dist.cjs/*`, `src/*`) remain unsupported and are
  documented as out of scope; no shim directories are added for them.

**Migration of this repository**

- Root `package.json` has no `@devboard/msgpack` dependency and no `@msgpack/msgpack` dependency.
  It depends on `@dsdenes/msgpack` through the workspace for local tests and keeps
  `msgpack-javascript-original` only as the differential reference.
- No executable source under `packages/`, `test/`, `bench/`, `verification/`, or `examples/`
  imports or requires `@devboard/msgpack` or `@msgpack/msgpack`. Those trees import
  `@dsdenes/msgpack`; `msgpack-javascript-original` remains the only reference-package import.
- Every `examples/*/package.json` depends on `@dsdenes/msgpack`, and every example source imports
  `@dsdenes/msgpack`. Adoption verification rewrites only the package specifier from
  `@msgpack/msgpack` to `@dsdenes/msgpack` in its baseline copy and proves identical output; no
  other source edit is required or performed.
- Root `README.md` replaces the alias/file adoption instructions with direct install and import
  replacement, updates verification commands and package references, and removes the stale
  statement that type-declaration parity and publishing are out of scope. `CHANGELOG.md` gains a
  top `1.0.0` entry covering the rename, publish, default export, subpaths, tarball contents, and
  migration.

**Behavior and publish**

- `bun test`, `bun run typecheck`, and every existing verification script pass after the import
  migration, using `@dsdenes/msgpack` for the replacement and
  `msgpack-javascript-original@3.1.3` for comparison. Encoded bytes, decoded values, error types,
  and error messages remain identical for the existing corpus.
- Before publishing, `npm view @dsdenes/msgpack@1.0.0 version` fails with E404. After publishing,
  it returns `1.0.0`, the registry `dist.integrity` equals the local tarball integrity, and the
  `latest` dist-tag points at `1.0.0`.
- A fresh temporary application installs `@dsdenes/msgpack@1.0.0` from the public registry with
  no alias and no custom registry, then passes the surface checks above and an encode/decode
  parity smoke against `msgpack-javascript-original` covering nulls, booleans, numbers, strings,
  binary, arrays, maps, timestamps, and a registered extension type.
- Exactly one version is published by this goal: `1.0.0`. No other version is published, no
  version is unpublished, and no dist-tag other than `latest` is changed.

## Verification

All implementation work happens in `<repo root>/.worktree/publish-msgpack-dropin/`. Build and test
only there until the worktree is merged, then repeat the full suite on `main` and publish from
`main`. Release artifacts, temporary applications, npm caches, logs, and the temporary npmrc stay
under that worktree.

- In the worktree:

  ```sh
  cd <repo root>/.worktree/publish-msgpack-dropin
  bun install
  bun run build
  bun run typecheck
  bun test
  bun run verify:surface
  bun run verify:options
  bun run verify:multi
  bun run verify:stream
  bun run verify:malformed
  bun run verify:adoption
  ```

  `verify:surface` is a new checked-in script that asserts the default export, CJS interop,
  subpath resolution, declaration shape under `tsc --strict`, and tarball file list.

- Pack the exact artifact and record its integrity:

  ```sh
  cd <repo root>/.worktree/publish-msgpack-dropin
  mkdir -p artifacts
  npm_config_cache="$PWD/.npm-cache" npm_config_logs_dir="$PWD/.npm-logs" \
    npm pack ./packages/msgpack --pack-destination "$PWD/artifacts" --json \
    > artifacts/pack.json
  tar -tzf artifacts/dsdenes-msgpack-1.0.0.tgz
  ```

  The listing is exactly `package/package.json`, `package/README.md`, `package/LICENSE`, and
  `package/lib/index.mjs`, `package/lib/index.cjs`, `package/lib/index.d.ts`,
  `package/lib/msgpack.js`.

- Install that tarball under its real name in a temporary application inside the worktree and run
  the surface script against it:

  ```sh
  cd <repo root>/.worktree/publish-msgpack-dropin
  mkdir -p .verify-app && cd .verify-app
  npm_config_cache="$PWD/../.npm-cache" npm_config_logs_dir="$PWD/../.npm-logs" \
    npm init -y >/dev/null
  npm_config_cache="$PWD/../.npm-cache" npm_config_logs_dir="$PWD/../.npm-logs" \
    npm install "$PWD/../artifacts/dsdenes-msgpack-1.0.0.tgz" --no-save
  node --input-type=module -e \
    'import m,{encode,decode,Encoder,Decoder,ExtensionCodec} from "@dsdenes/msgpack"; if(m.encode!==encode||m.Decoder!==Decoder) process.exit(1)'
  node -e 'const c=require("@dsdenes/msgpack"); if(c.default.encode!==c.encode) process.exit(1)'
  node -e 'require("@dsdenes/msgpack/package.json")'
  node -e 'require("@dsdenes/msgpack/lib/index.cjs")'
  node --input-type=module -e 'await import("@dsdenes/msgpack/lib/index.mjs")'
  node -e 'require.resolve("@dsdenes/msgpack/lib/msgpack.js")'
  ```

- Confirm the version is unpublished before the irreversible write:

  ```sh
  cd <repo root>/.worktree/publish-msgpack-dropin
  ! npm_config_cache="$PWD/.npm-cache" npm_config_logs_dir="$PWD/.npm-logs" \
    npm view @dsdenes/msgpack@1.0.0 version
  ```

  The command must exit 0 because `npm view` exits non-zero with E404. If it returns a version,
  halt without publishing.

- Publish the tested tarball, using a token supplied only through the environment and a
  worktree-local npmrc containing `${NODE_AUTH_TOKEN}`:

  ```sh
  cd <repo root>/.worktree/publish-msgpack-dropin
  printf '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' > .npmrc
  NPM_CONFIG_USERCONFIG="$PWD/.npmrc" npm_config_cache="$PWD/.npm-cache" \
    npm_config_logs_dir="$PWD/.npm-logs" NODE_AUTH_TOKEN="$NPM_TOKEN" \
    npm publish artifacts/dsdenes-msgpack-1.0.0.tgz \
      --access public --registry=https://registry.npmjs.org/
  rm .npmrc
  ```

  The `.npmrc` is never committed and contains no literal token. If `NPM_TOKEN` is unset, the
  publish command is not retried or replaced; halt as a missing prerequisite.

- Prove the registry artifact:

  ```sh
  cd <repo root>/.worktree/publish-msgpack-dropin
  npm_config_cache="$PWD/.npm-cache" npm_config_logs_dir="$PWD/.npm-logs" \
    npm view @dsdenes/msgpack@1.0.0 version dist.integrity dist.tarball dist-tags.latest
  npm_config_cache="$PWD/.npm-cache" npm_config_logs_dir="$PWD/.npm-logs" \
    npm view @dsdenes/msgpack dist-tags.latest
  ```

  The version is `1.0.0`, `dist-tags.latest` is `1.0.0`, and `dist.integrity` equals the integrity
  recorded in `artifacts/pack.json`.

- Install from the public registry in a second temporary application and run the surface and
  parity smoke:

  ```sh
  cd <repo root>/.worktree/publish-msgpack-dropin
  mkdir -p .registry-app && cd .registry-app
  npm_config_cache="$PWD/../.npm-cache" npm_config_logs_dir="$PWD/../.npm-logs" \
    npm init -y >/dev/null
  npm_config_cache="$PWD/../.npm-cache" npm_config_logs_dir="$PWD/../.npm-logs" \
    npm install @dsdenes/msgpack@1.0.0
  # Run the checked-in surface checker and parity smoke against this install.
  ```

  The install uses the default registry, no alias, and no `.npmrc`. The surface checker passes,
  and every fixture yields the same bytes and values as `msgpack-javascript-original@3.1.3`.

- Confirm the migration boundaries:

  ```sh
  cd <repo root>/.worktree/publish-msgpack-dropin
  ! grep -RnE 'from "@devboard/msgpack"|require\("@devboard/msgpack"\)' \
    packages test bench verification examples
  ! grep -RnE 'from "@msgpack/msgpack"|require\("@msgpack/msgpack"\)' \
    packages test bench verification examples
  ! grep -n '"@msgpack/msgpack"\|"@devboard/msgpack"' package.json
  grep -n 'npm install @dsdenes/msgpack' README.md packages/msgpack/README.md
  cmp packages/msgpack/LICENSE node_modules/msgpack-javascript-original/LICENSE
  ```

- After all non-publish checks pass, merge the worktree into `main`, delete the worktree branch
  only after publication verification, and run on `main`:

  ```sh
  cd <repo root>
  bun install
  bun run build
  bun test
  bun run typecheck
  git status --porcelain
  git diff --name-only main -- .devboard
  ```

  `git status --porcelain` is empty, and the `.devboard` diff contains only
  `.devboard/goals/publish-msgpack-dropin.md`.

## Boundaries

Host mode. Every implementation edit, build, and test happens in
`<repo root>/.worktree/publish-msgpack-dropin/`; merge that worktree directly into `main`, then
delete the worktree and its branch after publication verification. Never edit the opened checkout
except by that merge. The only harness change is this goal file,
`.devboard/goals/publish-msgpack-dropin.md`.

Allowed files in the worktree:

- `packages/msgpack/package.json`
- `packages/msgpack/src/index.ts` (default export only)
- `packages/msgpack/lib/` (generated)
- `packages/msgpack/README.md` (new)
- `packages/msgpack/LICENSE` (new)
- `scripts/build.ts` (declaration generation for the default export)
- `scripts/publish.ts` (new, only if a checked-in release guard is used)
- `package.json`, `bun.lock`
- `test/*.ts`, `bench/bench.ts`, `verification/*.ts` (package-name migration and new surface
  checker only)
- `examples/**` (package name and dependency migration only)
- `README.md`, `CHANGELOG.md`
- `.worktree/publish-msgpack-dropin/**` for release artifacts, temporary applications, npm cache,
  logs, and the temporary npmrc

Leave untouched: `.devboard/` except this goal file; `AGENTS.md`; `adrs/`; root `GOAL.md`;
`.omp/`; `.github/`; `WATCHDOG.yml`; `.gitignore`; `packages/msgpack/src/` except `index.ts`;
the reference package under `node_modules/`; and every other file under `.devboard/goals/`.

Do not add a `@msgpack/msgpack` or `@devboard/msgpack` dependency alias. Do not add reference
`dist.esm/*`, `dist.cjs/*`, or `src/*` compatibility paths. Do not change encoding or decoding
behavior, byte output, error text, options, or performance. Do not add dependencies beyond the
already-installed toolchain. Do not publish any version other than `1.0.0`, do not unpublish, do
not retag, and do not write or commit npm credentials. Do not use the global npm cache, global
npm logs, or a home-directory npmrc: all npm writes stay under the worktree. Do not write outside
`<repo root>`.

The registry write is explicitly approved for this goal: one public `npm publish` of the tested
`@dsdenes/msgpack@1.0.0` tarball to `https://registry.npmjs.org/`.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is
verified against the current state, including registry propagation retries.

Halt and surface only for genuine ambiguity this goal and the repository cannot resolve, a risky
or irreversible operation beyond the approved single publish, a missing prerequisite, or a
blocked external dependency. Examples: `NPM_TOKEN` is absent or lacks publish rights for the
`@dsdenes` scope; npm requires an interactive 2FA code; the registry rejects the name or version
because `@dsdenes/msgpack@1.0.0` already exists; authentication or registry access fails; npm
publish returns non-zero; the published integrity does not match the tested tarball; the registry
is unavailable; the merge conflicts with `main` in a way that needs a human decision; or a
required existing test fails for a reason outside this goal.

Do not halt for effort, question count, test cycles, registry propagation delay, or the number of
fix-and-rerun passes before the single publish. Do not work around a failed publish by bumping the
version, unpublishing, retagging, or changing the package name without a human decision.
