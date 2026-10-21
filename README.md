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
- `DecodeError`, the error class raised by decoder length limits and the
  default map key converter.
- Timestamp helpers: `EXT_TIMESTAMP`, `encodeDateToTimeSpec`,
  `encodeTimeSpecToTimestamp`, `decodeTimestampToTimeSpec`,
  `encodeTimestampExtension`, and `decodeTimestampExtension`.
- `Encoder` and `Decoder` accept every option listed below; the module-level
  `encode` and `decode` accept the same options.

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

## Options

Options match msgpack-javascript 3.1.3. Every documented option can be passed
to the module functions and to `Encoder`/`Decoder`.

Encoding options:

| Name                  | Type             | Default                       |
| --------------------- | ---------------- | ----------------------------- |
| `extensionCodec`      | `ExtensionCodec` | `ExtensionCodec.defaultCodec` |
| `context`             | user-defined     | -                             |
| `useBigInt64`         | `boolean`        | `false`                       |
| `maxDepth`            | `number`         | `100`                         |
| `initialBufferSize`   | `number`         | `2048`                        |
| `sortKeys`            | `boolean`        | `false`                       |
| `forceFloat32`        | `boolean`        | `false`                       |
| `forceIntegerToFloat` | `boolean`        | `false`                       |
| `ignoreUndefined`     | `boolean`        | `false`                       |

Decoding options:

| Name              | Type                 | Default                                      |
| ----------------- | -------------------- | -------------------------------------------- |
| `extensionCodec`  | `ExtensionCodec`     | `ExtensionCodec.defaultCodec`                |
| `context`         | user-defined         | -                                            |
| `useBigInt64`     | `boolean`            | `false`                                      |
| `rawStrings`      | `boolean`            | `false`                                      |
| `maxStrLength`    | `number`             | `4_294_967_295` (`UINT32_MAX`)               |
| `maxBinLength`    | `number`             | `4_294_967_295` (`UINT32_MAX`)               |
| `maxArrayLength`  | `number`             | `4_294_967_295` (`UINT32_MAX`)               |
| `maxMapLength`    | `number`             | `4_294_967_295` (`UINT32_MAX`)               |
| `maxExtLength`    | `number`             | `4_294_967_295` (`UINT32_MAX`)               |
| `keyDecoder`      | `KeyDecoder \| null` | shared bounded cache                         |
| `mapKeyConverter` | `(key) => string \| number` | throws `DecodeError` for other key types |

`useBigInt64` encodes `bigint` values as int64/uint64 and decodes those formats
as `bigint`; numbers that do not fit a 32-bit integer width become floats in
this mode, as in the reference. `rawStrings` returns `Uint8Array` for string
values while map keys stay strings, and its values are limited by
`maxBinLength`. The `max*Length` options reject input with `DecodeError` at the
same boundary as the reference. `keyDecoder: null` disables the shared key
cache.

## Scope

In scope: the value types listed above, the built-in timestamp extension,
application-registered extension types, `context`, every documented encoding
and decoding option, and nested combinations.

Out of scope by design, matching the epic's non-goals: streaming and multi-value
decoding, malformed-input error parity, type-declaration parity, and
publishing.

Out-of-scope inputs may be unsupported, but they cannot change the result for an
in-scope payload.

## Verification

```sh
bun install
bun test              # byte identity and decode identity against msgpack-javascript
bun run typecheck
bun run bench         # side-by-side encoding and decoding
bun run verify:options
bun run verify:adoption
```

`bun test` compares every in-scope fixture and nested combination against the
reference package installed as `msgpack-javascript-original`, including
timestamps at every representation boundary, custom extension types of every
payload width, every documented option, option combinations, and decoder limits
at and beyond their boundary.

`bun run verify:options` imports the built package by its public name, as an
adopting application does, and compares each documented option, several
combined options, limit boundaries and their `DecodeError` category, the
CommonJS entry point, and no-option encoding and decoding with the reference.

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
| null | 1 | 524 | 36 | 0.068 | 96 | 33 | 0.342 |
| boolean | 1 | 588 | 45 | 0.076 | 101 | 27 | 0.262 |
| small int | 1 | 604 | 52 | 0.086 | 111 | 26 | 0.238 |
| large int | 9 | 681 | 119 | 0.175 | 106 | 27 | 0.258 |
| float | 9 | 591 | 51 | 0.086 | 105 | 25 | 0.236 |
| short string | 15 | 688 | 75 | 0.110 | 285 | 101 | 0.354 |
| medium string | 222 | 988 | 428 | 0.433 | 251 | 137 | 0.547 |
| long string | 5003 | 6415 | 4492 | 0.700 | 708 | 545 | 0.770 |
| unicode string | 187 | 1063 | 404 | 0.380 | 1231 | 920 | 0.747 |
| binary 256 | 259 | 705 | 105 | 0.149 | 183 | 66 | 0.363 |
| binary 4096 | 4099 | 2060 | 677 | 0.329 | 166 | 66 | 0.396 |
| small array | 7 | 700 | 140 | 0.200 | 296 | 78 | 0.265 |
| integer array | 174 | 2061 | 1328 | 0.644 | 974 | 749 | 0.769 |
| small map | 21 | 818 | 164 | 0.200 | 500 | 156 | 0.313 |
| large map | 693 | 4663 | 3315 | 0.711 | 39424 | 28709 | 0.728 |
| typical response | 590 | 4780 | 3203 | 0.670 | 7298 | 3617 | 0.496 |
| nested combinations | 1120 | 13653 | 10396 | 0.761 | 27130 | 13962 | 0.515 |
| timestamp | 10 | 1339 | 436 | 0.326 | 379 | 179 | 0.472 |
| timestamp before epoch | 15 | 1361 | 468 | 0.344 | 437 | 188 | 0.429 |
| timestamp nested | 125 | 7136 | 5508 | 0.772 | 3811 | 2748 | 0.721 |
| custom point | 18 | 1562 | 612 | 0.392 | 365 | 168 | 0.460 |
| custom nested | 228 | 8751 | 7759 | 0.887 | 4213 | 1758 | 0.417 |
| custom array | 363 | 14102 | 12650 | 0.897 | 2926 | 2394 | 0.818 |


No measured payload was slower for either operation; all 23 were faster for both.

## Layout

- `packages/msgpack/src/` — implementation.
- `packages/msgpack/lib/` — built ESM, CommonJS, and declarations.
- `test/` — byte and value parity tests and the fixture corpus.
- `bench/` — side-by-side performance harness.
- `verification/` — server and browser adoption checks.
- `examples/server`, `examples/browser` — applications that adopt the package
  without source changes.
