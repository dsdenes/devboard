# @devboard/msgpack

A byte-compatible, drop-in replacement for `@msgpack/msgpack` (msgpack-javascript)
covering everyday payloads: nulls, booleans, numbers, strings, binary data, arrays,
maps, timestamps, application-registered extension types, and nested combinations
of them. Applications keep importing `encode` and `decode` from
`@msgpack/msgpack`; only the dependency that provides that package changes.

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
- `new ExtensionCodec()` with `register`, `tryToEncode`, and `decode`, plus
  `ExtensionCodec.defaultCodec` and `ExtData`.
- Timestamp helpers: `EXT_TIMESTAMP`, `encodeDateToTimeSpec`,
  `encodeTimeSpecToTimestamp`, `decodeTimestampToTimeSpec`,
  `encodeTimestampExtension`, and `decodeTimestampExtension`.
- `Encoder` and `Decoder` accept `extensionCodec` and `context` options; the
  module-level `encode` and `decode` accept the same options.

Default behaviour matches msgpack-javascript 3.1.3: smallest integer widths,
float64 for non-integers, UTF-8 strings with the same fixstr/str8/str16/str32
thresholds, the same bin/array/map widths, plain-object maps with string or
number keys, `Uint8Array` binary values, and the built-in timestamp extension.

## Extensions

`Date` values encode through the built-in timestamp extension exactly as the
reference does. Application types register on an `ExtensionCodec`, and the
codec is passed to both libraries:

```ts
const codec = new ExtensionCodec();
codec.register({ type: 42, encode, decode });

const bytes = encode(value, { extensionCodec: codec });
const decoded = decode(bytes, { extensionCodec: codec });
```

Custom types nested in arrays and maps use the same codec, unknown extension
types decode to `ExtData`, and `ExtData` values re-encode unchanged.

## Scope

In scope: the value types listed above, the built-in timestamp extension,
application-registered extension types, `context`, and nested combinations.

Out of scope by design, matching the epic's non-goals: non-default
encoder/decoder options other than `extensionCodec` and `context`, streaming and
multi-value decoding, malformed-input error parity, resource limits and
nesting-depth policy, large integers beyond the default, type-declaration
parity, and publishing.

Out-of-scope inputs may be unsupported, but they cannot change the result for an
in-scope payload.

## Verification

```sh
bun install
bun test              # byte identity and decode identity against msgpack-javascript
bun run typecheck
bun run bench         # side-by-side encoding and decoding
bun run verify:adoption
```

`bun test` compares every in-scope fixture and nested combination against the
reference package installed as `msgpack-javascript-original`, including
timestamps at every representation boundary and custom extension types of every
payload width.

`bun run bench` builds the shipped package, then measures both libraries on the
same machine, payloads, and process, with warmup, alternating order, and the
median of nine rounds. It exits non-zero if any measured payload is slower for
either operation.

`bun run verify:server` and `bun run verify:browser` exercise the two adopting
applications in `examples/`. Each script hashes the application source before and
after swapping `@msgpack/msgpack` from the original to the replacement, installs
both variants, starts the application, and compares the results. Both
applications encode and decode timestamps and a registered `GeoPoint` type. The
browser script loads the built application in headless Chrome and reads the
rendered result.

## Measured performance

Bun 1.4.2 on Linux x64, built package entry, same process and payloads for both
libraries. Each number is nanoseconds per operation, median of nine rounds after
warmup, with the measurement order alternating between libraries. `ratio` is
replacement divided by original, so lower is faster.

| Case | Bytes | Encode ref | Encode new | Ratio | Decode ref | Decode new | Ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| null | 1 | 529 | 33 | 0.062 | 128 | 21 | 0.163 |
| boolean | 1 | 580 | 52 | 0.090 | 110 | 26 | 0.233 |
| small int | 1 | 537 | 44 | 0.082 | 112 | 25 | 0.227 |
| large int | 9 | 669 | 116 | 0.173 | 120 | 26 | 0.220 |
| float | 9 | 567 | 53 | 0.093 | 109 | 25 | 0.227 |
| short string | 15 | 628 | 75 | 0.119 | 290 | 105 | 0.361 |
| medium string | 222 | 1025 | 394 | 0.385 | 245 | 127 | 0.518 |
| long string | 5003 | 7413 | 4539 | 0.612 | 707 | 531 | 0.751 |
| unicode string | 187 | 1177 | 423 | 0.359 | 1340 | 1060 | 0.791 |
| binary 256 | 259 | 692 | 113 | 0.163 | 179 | 96 | 0.535 |
| binary 4096 | 4099 | 1815 | 702 | 0.387 | 159 | 59 | 0.369 |
| small array | 7 | 741 | 116 | 0.157 | 305 | 61 | 0.200 |
| integer array | 174 | 1963 | 1472 | 0.750 | 1031 | 640 | 0.621 |
| small map | 21 | 749 | 150 | 0.200 | 477 | 131 | 0.275 |
| large map | 693 | 4555 | 3048 | 0.669 | 36859 | 25752 | 0.699 |
| typical response | 590 | 4499 | 3058 | 0.680 | 6794 | 3102 | 0.457 |
| nested combinations | 1120 | 11526 | 9158 | 0.795 | 21612 | 10374 | 0.480 |
| timestamp | 10 | 988 | 355 | 0.360 | 311 | 142 | 0.458 |
| timestamp before epoch | 15 | 952 | 353 | 0.371 | 346 | 150 | 0.432 |
| timestamp nested | 125 | 5455 | 4129 | 0.757 | 2990 | 2030 | 0.679 |
| custom point | 18 | 1151 | 448 | 0.389 | 295 | 132 | 0.449 |
| custom nested | 228 | 6675 | 6232 | 0.934 | 3345 | 1422 | 0.425 |
| custom array | 363 | 10690 | 9630 | 0.901 | 2369 | 1864 | 0.787 |


No measured payload was slower for either operation; all 23 were faster for both.

## Layout

- `packages/msgpack/src/` — implementation.
- `packages/msgpack/lib/` — built ESM, CommonJS, and declarations.
- `test/` — byte and value parity tests and the fixture corpus.
- `bench/` — side-by-side performance harness.
- `verification/` — server and browser adoption checks.
- `examples/server`, `examples/browser` — applications that adopt the package
  without source changes.
