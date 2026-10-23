## Objective

In the `dsdenes/msgpack` repository checked out at `/home/ds/msgpack`, Node.js 24 LTS (Krypton) becomes
the single runtime and toolchain for the host project. Build, typecheck, tests, the benchmark, every
verification script, and every example run with `npm` and `node`; Bun is removed from the repository
(`bun.lock`, `@types/bun`, `bun:test`, every `Bun.*` API, and every `bun`/`bunx` command). The 33-case
benchmark suite runs on Node 24 and every measured payload stays faster than msgpack-javascript 3.1.3
for both encode and decode. The root README and the published package README document Node.js 24 LTS
as the supported runtime, retain browser support through the UMD bundle, and report the Node-measured
benchmark results. Encoded bytes, decoded values, error types and messages, the public API, the
published package contents, and browser behaviour remain unchanged.

## Success criteria

**Runtime pin**

- `node --version` reports major 24.
- Root `package.json` declares `engines.node` that accepts only the 24 major (for example `"24.x"`).
- `.nvmrc` exists at the repo root and contains `24`.
- `packages/msgpack/package.json` has no `engines` field and still versions the package `1.0.0`.
- `package-lock.json` exists at the repo root; `bun.lock` does not exist.

**Bun removal**

- No tracked file contains `Bun.`, `bun:test`, `bunx`, `bun run`, or `bun install`, except historical
  `CHANGELOG.md` entries, which stay unchanged.
- `@types/bun` and `bun-types` appear in no manifest and in no lockfile.
- Every script in the root `package.json` runs through npm/node; `npm ci` exits 0 from a clean
  `node_modules`.

**Build and types**

- `npm run build` exits 0 and writes exactly four files under `packages/msgpack/lib/`: `index.mjs`,
  `index.cjs`, `index.d.ts`, `msgpack.js`.
- `packages/msgpack/lib/msgpack.js` still defines the `MessagePack` global; the ESM and CommonJS
  entry points export the same API as before the migration.
- `npm run typecheck` exits 0.
- `npm pack --dry-run --json` inside `packages/msgpack` lists exactly `package.json`, `README.md`,
  `LICENSE`, and the four `lib/` files.

**Tests**

- `npm test` exits 0 on Node 24 and runs the same 72 test cases, in the same four files
  (`test/compat.test.ts`, `test/options.test.ts`, `test/stream.test.ts`,
  `test/malformed.test.ts`), still comparing behaviour against
  `msgpack-javascript-original@3.1.3`.
- Test assertions remain differential against the reference package; no parity check is removed or
  weakened.

**Benchmark**

- `npm run bench` exits 0 on Node 24.
- The run covers all 33 cases and reports a ratio below `1.000` for encode and for decode of every
  case; the existing non-zero exit on any ratio `>= 1` is preserved.
- The README benchmark section names the exact Node 24 version and machine used, and contains no Bun
  mention.

**Verification**

- Each of these exits 0 on Node 24: `npm run verify:options`, `npm run verify:multi`,
  `npm run verify:stream`, `npm run verify:malformed`, `npm run verify:surface`,
  `npm run verify:typed`, `npm run verify:classic-typed`, `npm run verify:classic-bundler`,
  `npm run verify:server`, `npm run verify:browser`, `npm run verify:browser-script`.
- No verification script invokes `bun` or `bunx`; generated baseline installs use npm.
- Adoption checks still produce identical baseline-versus-replacement values, bytes, error names,
  and error messages.

**Examples**

- `examples/server` starts with `npm start` on Node using `node:http` and serves the same routes and
  values as before.
- `examples/typed` builds with `tsc` and runs on Node; `examples/typed-classic`,
  `examples/classic-bundler`, and `examples/browser` build and run through npm/node.
- No example `package.json` contains a `bun` script.

**Documentation**

- Root `README.md` contains a runtime-support section naming Node.js 24 LTS as the supported runtime
  of the repository and package, keeps the existing msgpack-javascript drop-in compatibility claims,
  retains browser/UMD support, and lists the npm commands.
- No Bun command or Bun measurement remains in `README.md` or `packages/msgpack/README.md`.
- `packages/msgpack/README.md` states Node.js 24 LTS support alongside its existing ESM/CommonJS,
  TypeScript, no-runtime-dependency, and browser claims.
- `CHANGELOG.md` gains one new entry describing the Node 24 migration; historical entries are
  byte-identical to the current file.

**Unchanged behaviour**

- `packages/msgpack/src/` contains no `node:` imports and no new runtime dependencies; the shipped
  library stays runtime-neutral and browser-capable.
- Byte identity, decoded-value identity, error type and message identity with
  msgpack-javascript 3.1.3 hold for every existing test and verification case.

## Verification

Run from the repository root (or the task worktree root) with Node 24 on `PATH`:

```sh
node --version
node -p 'require("./package.json").engines.node'
cat .nvmrc
test -f package-lock.json && test ! -e bun.lock
npm ci
npm run build
npm run typecheck
npm test
npm run bench
npm run verify:options
npm run verify:multi
npm run verify:stream
npm run verify:malformed
npm run verify:surface
npm run verify:typed
npm run verify:classic-typed
npm run verify:classic-bundler
npm run verify:server
npm run verify:browser
npm run verify:browser-script
git ls-files packages/msgpack/lib
(cd packages/msgpack && npm pack --dry-run --json)
git grep -nE 'Bun\.|bun:test|bunx|bun run|bun install' -- . ':!CHANGELOG.md'
git grep -nE '"(@types/bun|bun-types)"' -- . ':!node_modules'
grep -ni 'bun' README.md packages/msgpack/README.md
node -p 'JSON.stringify(Object.keys(require("./packages/msgpack/lib/index.cjs")).sort())'
node --input-type=module -e 'import("./packages/msgpack/lib/index.mjs").then(m => console.log(typeof m.encode, typeof m.decode))'
```

The grep commands must print nothing (the `@types/bun` grep also matches no lockfile entry). The
`git ls-files` output must be exactly the four `lib/` files. The benchmark command must exit 0 and
its table must show ratios below `1.000` for every case and both operations. The browser
verifications require `google-chrome` on `PATH` and write only under `.tmp/`.

## Boundaries

- Allowed to edit: root `package.json`, new `package-lock.json`, deletion of `bun.lock`, `tsconfig.json`,
  `scripts/build.ts`, `bench/`, `test/`, `verification/`, `examples/`, `README.md`,
  `packages/msgpack/README.md`, `packages/msgpack/package.json` (metadata only; no `engines`), the
  regenerated `packages/msgpack/lib/` files, `CHANGELOG.md`, new `.nvmrc`, and `.gitignore`.
- Allowed new development dependency: `esbuild`, for producing the ESM, CommonJS, and UMD bundles.
  TypeScript remains a development dependency. The shipped package keeps zero runtime dependencies.
- `packages/msgpack/src/` may change only if the every-case-faster benchmark gate cannot otherwise
  be met; any such change must keep bytes, decoded values, error types, error messages, public API,
  and declarations identical, and must be justified by the Node benchmark output.
- The Node 24 pin applies to root tooling only. The published package must not gain an `engines` field;
  browser and non-Node consumers stay unblocked.
- Untouched: `.devboard/`, `.omp/`, root `AGENTS.md`, `GOAL.md`, the reference pin
  `msgpack-javascript-original@3.1.3`, package version `1.0.0`, historical changelog entries, browser
  support, and the UMD global surface.
- No npm publish, no version bump, no CI configuration added, no dependency alias or `file:` dependency
  introduced into the shipped package.
- Every created file, cache, log, and temporary artifact stays inside `/home/ds/msgpack`; work happens
  in a `.worktree/<name>` worktree per `AGENTS.md`, is merged into `main`, and the worktree and branch
  are removed afterwards. Generated scratch data lives under `.tmp/`.

## Stop conditions

- No attempt cap, token budget, or time limit. Continue until every success criterion is verified
  against the current working tree; do not report progress as completion.
- Halt and surface only for: Node 24 missing from `PATH` and unobtainable inside the repository
  without a system install; `google-chrome` missing so browser verifications cannot run; npm registry
  or network unreachable for `npm ci` or example installs; a required change that would alter encoded
  bytes, decoded values, error types or messages, the public API, or the published package contents;
  or the every-case-faster gate still failing after genuine codec optimization, in which case report
  the per-case Node ratios and the evidence and stop for a decision instead of weakening the gate.
- Never weaken a success criterion, skip a verification script, or reintroduce Bun to make a check
  pass.
- Do not publish the package, change its version, delete files unrelated to the migration, or modify
  harness directories.
