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
    "@msgpack/msgpack": "file:../devboard"
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
| null | 1 | 588 | 43 | 0.073 | 111 | 30 | 0.273 |
| boolean | 1 | 607 | 41 | 0.068 | 108 | 25 | 0.236 |
| small int | 1 | 642 | 48 | 0.075 | 105 | 22 | 0.213 |
| large int | 9 | 775 | 129 | 0.167 | 111 | 29 | 0.263 |
| float | 9 | 655 | 51 | 0.078 | 122 | 30 | 0.245 |
| short string | 15 | 698 | 74 | 0.106 | 279 | 237 | 0.850 |
| medium string | 222 | 1099 | 465 | 0.423 | 252 | 122 | 0.483 |
| long string | 5003 | 8569 | 5115 | 0.597 | 832 | 497 | 0.598 |
| unicode string | 187 | 1083 | 406 | 0.375 | 1267 | 1008 | 0.796 |
| binary 256 | 259 | 678 | 109 | 0.161 | 171 | 67 | 0.392 |
| binary 4096 | 4099 | 2047 | 622 | 0.304 | 139 | 58 | 0.421 |
| small array | 7 | 791 | 119 | 0.150 | 290 | 191 | 0.660 |
| integer array | 174 | 2127 | 1396 | 0.656 | 1023 | 704 | 0.688 |
| small map | 21 | 818 | 160 | 0.195 | 500 | 298 | 0.596 |
| large map | 693 | 5206 | 4030 | 0.774 | 43719 | 39039 | 0.893 |
| typical response | 590 | 5501 | 3362 | 0.611 | 7990 | 6447 | 0.807 |
| nested combinations | 1120 | 14348 | 9311 | 0.649 | 26524 | 20065 | 0.756 |

No measured payload was slower for either operation; all 17 were faster for both.

## Layout

- `src/` — implementation; `lib/` — built ESM, CommonJS, and declarations.
- `test/` — byte and value parity tests and the fixture corpus.
- `bench/` — side-by-side performance harness.
- `verification/` — server and browser adoption checks.
- `examples/server`, `examples/browser` — applications that adopt the package
  without source changes.
