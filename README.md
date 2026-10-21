# @devboard/msgpack

A byte-compatible, drop-in replacement for `@msgpack/msgpack` (msgpack-javascript)
covering everyday payloads: nulls, booleans, numbers, strings, binary data, arrays,
maps, and nested combinations of them. Applications keep importing `encode` and
`decode` from `@msgpack/msgpack`; only the dependency that provides that package
changes.

## Adoption

An adopting project changes its dependency resolution, never its source:

```json
{
  "dependencies": {
    "@msgpack/msgpack": "file:../devboard/packages/msgpack"
  }
}
```

A registry alias to `@devboard/msgpack` would work the same way if the package is
published; this repository installs it from the local path.
The package exposes conditional ESM and CommonJS entry points, so both
`import { encode, decode } from "@msgpack/msgpack"` and
`require("@msgpack/msgpack")` resolve to this implementation.

## API

- `encode(value, options?)` returns the MessagePack encoding as a `Uint8Array`.
- `decode(buffer, options?)` accepts a `Uint8Array`, another `ArrayBufferView`,
  an `ArrayBuffer`, or an array-like of bytes.
- `new Encoder(options?)` with `encode` and `encodeSharedRef`.
- `new Decoder(options?)` with `decode`.

Default behaviour matches msgpack-javascript 3.1.3: smallest integer widths,
float64 for non-integers, UTF-8 strings with the same fixstr/str8/str16/str32
thresholds, the same bin/array/map widths, plain-object maps with string or
number keys, and `Uint8Array` binary values.

## Scope

In scope: the value types listed above, default options, and nested combinations.

Out of scope by design, matching the epic's non-goals: extension types and
timestamps, non-default encoder/decoder options, streaming and multi-value
decoding, malformed-input error parity, resource limits and nesting-depth policy,
large integers beyond the default, type-declaration parity, and publishing.

Out-of-scope inputs may be unsupported, but they cannot change the result for an
in-scope payload. For example, `Date` is encoded as a plain map rather than a
timestamp extension.

## Verification

```sh
bun install
bun test              # byte identity and decode identity against msgpack-javascript
bun run typecheck
bun run bench         # side-by-side encoding and decoding
bun run verify:adoption
```

`bun test` compares every in-scope fixture and nested combination against the
reference package installed as `msgpack-javascript-original`.

`bun run bench` builds the shipped package, then measures both libraries on the
same machine, payloads, and process, with warmup, alternating order, and the
median of nine rounds. It exits non-zero if any measured payload is slower for
either operation.

`bun run verify:server` and `bun run verify:browser` exercise the two adopting
applications in `examples/`. Each script hashes the application source before and
after swapping `@msgpack/msgpack` from the original to the replacement, installs
both variants, starts the application, and compares the results. The browser
script loads the built application in headless Chrome and reads the rendered
result.

## Measured performance

Bun 1.4.2 on Linux x64, built package entry, same process and payloads for both
libraries. Each number is nanoseconds per operation, median of nine rounds after
warmup, with the measurement order alternating between libraries. `ratio` is
replacement divided by original, so lower is faster.

| Case | Bytes | Encode ref | Encode new | Ratio | Decode ref | Decode new | Ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| null | 1 | 555 | 41 | 0.074 | 115 | 27 | 0.239 |
| boolean | 1 | 547 | 46 | 0.084 | 103 | 27 | 0.262 |
| small int | 1 | 567 | 43 | 0.076 | 102 | 23 | 0.226 |
| large int | 9 | 672 | 115 | 0.171 | 105 | 33 | 0.309 |
| float | 9 | 586 | 51 | 0.086 | 101 | 29 | 0.283 |
| short string | 15 | 649 | 66 | 0.102 | 273 | 113 | 0.413 |
| medium string | 222 | 1090 | 438 | 0.402 | 247 | 137 | 0.557 |
| long string | 5003 | 7763 | 4836 | 0.623 | 798 | 539 | 0.675 |
| unicode string | 187 | 1026 | 428 | 0.417 | 1380 | 992 | 0.719 |
| binary 256 | 259 | 939 | 109 | 0.116 | 225 | 79 | 0.351 |
| binary 4096 | 4099 | 2641 | 791 | 0.299 | 162 | 68 | 0.420 |
| small array | 7 | 935 | 143 | 0.153 | 388 | 83 | 0.215 |
| integer array | 174 | 2651 | 1641 | 0.619 | 1214 | 827 | 0.682 |
| small map | 21 | 1055 | 183 | 0.173 | 604 | 172 | 0.285 |
| large map | 693 | 5439 | 4061 | 0.747 | 47024 | 32312 | 0.687 |
| typical response | 590 | 5088 | 3256 | 0.640 | 7668 | 3449 | 0.450 |
| nested combinations | 1120 | 12411 | 7820 | 0.630 | 23738 | 11234 | 0.473 |


No measured payload was slower for either operation; all 17 were faster for both.

## Layout

- `packages/msgpack/src/` — implementation.
- `packages/msgpack/lib/` — built ESM, CommonJS, and declarations.
- `test/` — byte and value parity tests and the fixture corpus.
- `bench/` — side-by-side performance harness.
- `verification/` — server and browser adoption checks.
- `examples/server`, `examples/browser` — applications that adopt the package
  without source changes.
