# @devboard/msgpack

A byte-compatible, drop-in replacement for `@msgpack/msgpack` (msgpack-javascript)
covering everyday payloads: nulls, booleans, numbers, strings, binary data, arrays,
maps, timestamps, application-registered extension types, and nested combinations
of them. Applications keep importing `encode`, `decode`, `decodeMulti`, and the
stream decoders from `@msgpack/msgpack`; only the dependency that provides that
package changes.

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

A page that loads msgpack-javascript with one plain script reference, without a
bundler or a build step, points that reference at the package's UMD bundle and
keeps its markup and inline script unchanged:

```html
<script src="https://unpkg.com/@devboard/msgpack/lib/msgpack.js"></script>
```

The bundle defines the same `MessagePack` global as msgpack-javascript's UMD
build, including `encode`, `decode`, the `Encoder`/`Decoder` classes, the
timestamp helpers, and the extension codec. `packages/msgpack/lib/msgpack.js`
is built from the same source as the module entry points and is what the
package's `unpkg` and `cdn` fields resolve to; adopting a plain-script page
changes only the one `src`.

## API

- `encode(value, options?)` returns the MessagePack encoding as a `Uint8Array`.
- `decode(buffer, options?)` accepts a `Uint8Array`, another `ArrayBufferView`,
  an `ArrayBuffer`, or an array-like of bytes, and decodes exactly one message.
- `decodeMulti(buffer, options?)` accepts the same input forms and returns a
  generator that yields every consecutive message in the buffer, in order.
- `decodeMultiStream(streamLike, options?)` and `decodeArrayStream(streamLike,
  options?)` return async generators that decode messages, or the items of one
  array, from an async iterable of chunks or a WHATWG `ReadableStream`;
  `decodeAsync(streamLike, options?)` decodes exactly one message from a stream.
- `new Encoder(options?)` with `encode` and `encodeSharedRef`.
- `new Decoder(options?)` with `decode`, `decodeMulti`, `decodeStream`,
  `decodeArrayStream`, and `decodeAsync`.
- `new ExtensionCodec()` with `register`, `tryToEncode`, and `decode`, plus
  `ExtensionCodec.defaultCodec` and `ExtData`.
- `DecodeError`, the error class raised by decoder length limits and the
  default map key converter.
- Timestamp helpers: `EXT_TIMESTAMP`, `encodeDateToTimeSpec`,
  `encodeTimeSpecToTimestamp`, `decodeTimestampToTimeSpec`,
  `encodeTimestampExtension`, and `decodeTimestampExtension`.
- `Encoder` and `Decoder` accept every option listed below; the module-level
  `encode`, `decode`, `decodeMulti`, and stream decoders accept the same options.

Default behaviour matches msgpack-javascript 3.1.3: smallest integer widths,
float64 for non-integers, UTF-8 strings with the same fixstr/str8/str16/str32
thresholds, the same bin/array/map widths, plain-object maps with string or
number keys, `Uint8Array` binary values, and the built-in timestamp extension.

## TypeScript

The published declarations reproduce the types msgpack-javascript 3.1.3
publishes, including its generics and type names. A typed consumer swaps the
dependency without touching its source:

```ts
import {
  Encoder,
  ExtensionCodec,
  encode,
  type DecoderOptions,
  type EncoderOptions,
  type ExtensionCodecType,
  type ExtensionDecoderType,
  type ExtensionEncoderType,
} from "@msgpack/msgpack";

interface AppContext {
  requestId: string;
}

const codec = new ExtensionCodec<AppContext>();
codec.register({ type: 42, encode, decode });

const encoderOptions: EncoderOptions<AppContext> = {
  extensionCodec: codec,
  context: { requestId: "req-1" },
};
const encoder = new Encoder<AppContext>(encoderOptions);
const bytes = encode<AppContext>(value, encoderOptions);
```

`EncoderOptions<ContextType>`, `DecoderOptions<ContextType>`,
`Encoder<ContextType>`, `Decoder<ContextType>`, and
`ExtensionCodec<ContextType>` carry the same context generic as the original.
`ExtensionCodecType`, `ExtensionEncoderType`, and `ExtensionDecoderType` name
the codec contract, and `ContextOf`/`SplitUndefined` describe how a context
became required. Defaults and inference match the original, so untyped
consumers and consumers that never mention a context compile unchanged too.

## Multiple messages

`decodeMulti` reads a buffer that holds several consecutive MessagePack values,
the same way msgpack-javascript does:

```ts
import { decodeMulti, encode } from "@msgpack/msgpack";

const buffer = new Uint8Array([...encode("first"), ...encode({ second: 2 })]);
for (const message of decodeMulti(buffer)) {
  console.log(message);
}
```

The module function and `new Decoder(options).decodeMulti(buffer)` yield the
same values in the same order and accept the same decoding options. An empty
buffer yields no messages. If the final message is incomplete, every complete
message before it is yielded and the iteration then throws `RangeError`, as in
the reference. `decode` keeps decoding exactly one message and rejects a buffer
that holds more.

## Streams

The incremental, stream-fed decoding surface matches msgpack-javascript:
`decodeMultiStream(streamLike, options?)` and
`new Decoder(options).decodeStream(stream)` consume an async iterable of byte
chunks or a WHATWG `ReadableStream` and yield each complete message as soon as
its last byte arrives, in order. Chunk boundaries may fall anywhere inside a
message.

```ts
import { decodeMultiStream, encode } from "@msgpack/msgpack";

const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([...encode("first"), ...encode({ second: 2 })]));
    controller.close();
  },
});

for await (const message of decodeMultiStream(stream)) {
  console.log(message);
}
```

An empty stream yields no messages and does not fail. A stream that ends
partway through a message delivers every complete message before it and then
ends, exactly as the reference does; `decodeAsync(streamLike, options?)` is the
single-message form and throws the reference's `RangeError` for an empty or
incomplete stream. `decodeArrayStream(streamLike, options?)` and
`Decoder.decodeArrayStream` yield the items of one streaming array. All stream
functions accept the same decoding options as `decode`, and the module functions
also accept a WHATWG `ReadableStream` in runtimes where it is not an async
iterable.

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
and decoding option, nested combinations, synchronous multi-message decoding
of a buffer, incremental, stream-fed decoding from async iterables and WHATWG
`ReadableStream`s in browser and server runtimes, and malformed or externally
produced input through every decoding entry point.

Malformed and unusual input matches the reference exactly: the same value when
it decodes, and the same failure type and message when it rejects the bytes.
This includes every single-byte header, every truncation of a supported payload,
alternative encodings the encoders never emit, invalid UTF-8, reserved and
unknown extension bytes, extra bytes after a message, and input that ends
partway through a message. Decoding is iterative, so nesting is bounded by
memory rather than the call stack, and streamed decoding keeps its state across
chunk boundaries, so outcomes do not depend on where chunks split.

Out of scope by design, matching the epic's non-goals: type-declaration parity
and publishing.

Out-of-scope inputs may be unsupported, but they cannot change the result for an
in-scope payload.

## Verification

```sh
bun install
bun test              # byte identity and decode identity against msgpack-javascript
bun run typecheck
bun run bench         # side-by-side encoding and decoding
bun run verify:options
bun run verify:multi
bun run verify:stream
bun run verify:malformed
bun run verify:adoption
bun run verify:browser-script
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

`bun run verify:multi` imports the built package under the original
`@msgpack/msgpack` name, encodes varied values with the reference, concatenates
the bytes, and compares `decodeMulti` and `Decoder.decodeMulti` against the
reference for every payload type, every decoding option and limit, an empty
buffer, and every truncation point of a final message. It fails if the delivered
values, order, error category, or error message differ.

`bun run verify:stream` imports the built package under the original
`@msgpack/msgpack` name, encodes every in-scope payload with the reference, and
feeds the concatenated bytes as chunks whose boundaries fall at every position
of a compact stream and inside every message of a larger stream. It compares
`decodeMultiStream`, `Decoder.decodeStream`, `decodeAsync`, and
`decodeArrayStream` with the reference, including empty streams, truncated final
messages, decoding options, WHATWG `ReadableStream` input, and the CommonJS
entry point. It fails if delivered values, order, error category, or message
differ.

`bun run verify:malformed` imports the built package under the original
`@msgpack/msgpack` name and compares over a million outcomes with the reference:
every single-byte header with payload bytes of several shapes, every truncation
of every supported payload and of alternative encodings, generated and mutated
byte sequences, buffers with no message, one message, and several concatenated
messages with the final message truncated at every position, decoding options
and key converters, every input form, and streamed input split at every position
through async iterables and WHATWG `ReadableStream`s. It fails if a value
differs, if one library accepts bytes the other rejects, or if an error type or
message differs.

`bun run bench` builds the shipped package, then measures both libraries on the
same machine, payloads, and process, with warmup, alternating order, and the
median of nine rounds. It exits non-zero if any measured payload is slower for
either operation.

`bun run verify:typed` installs `npm:@msgpack/msgpack@3.1.3` for the TypeScript
application in `examples/typed`, builds it with `tsc` under `strict`, installs
the replacement in its place, and builds again. The application's source refers
to the original's published types for its options, extension codec, and values,
including a context generic and annotations that adapt those types to the
application. The script fails if either build reports a diagnostic, if either
run fails, if the two runs encode or decode any value differently, or if the
application source changes between the runs.

`bun run verify:server` and `bun run verify:browser` exercise the two adopting
applications in `examples/`. Each script hashes the application source before and
after swapping `@msgpack/msgpack` from the original to the replacement, installs
both variants, starts the application, and compares the results. Both
applications encode and decode timestamps and a registered `GeoPoint` type,
consume consecutive messages incrementally from chunked byte streams, and
report the value or failure for corrupted and externally produced byte
sequences. The browser script loads the built application in headless Chrome and
reads the rendered result.

`bun run verify:browser-script` covers the page that uses no bundler and no build
step. It takes `examples/browser-script/page.html`, whose markup and inline
script are fixed, and produces two variants that differ only in the page's one
`<script src>` reference: one points at msgpack-javascript's UMD bundle, the
other at `packages/msgpack/lib/msgpack.js`. It opens both pages in headless
Chrome and fails unless the pages load their own script, expose the same
`MessagePack` entry points, and render identical results for primitives,
non-ASCII strings, binary data, arrays, maps, nested values, timestamps at each
representation width, a registered extension type, every documented encoding
and decoding option, the class and multi-message APIs, and rejected input and
options with the same failure types and messages. It also checks that the
page's bytes are unchanged and that the replacement bundle is a plain script
with no imports, exports, or `require` calls.

## Measured performance

Bun 1.4.2 on Linux x64, built package entry, same process and payloads for both
libraries. Each number is nanoseconds per operation, median of nine rounds after
warmup, with the measurement order alternating between libraries. `ratio` is
replacement divided by original, so lower is faster.

| Case | Bytes | Encode ref | Encode new | Ratio | Decode ref | Decode new | Ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| null | 1 | 560 | 40 | 0.072 | 99 | 26 | 0.264 |
| boolean | 1 | 550 | 56 | 0.101 | 107 | 27 | 0.257 |
| small int | 1 | 589 | 44 | 0.075 | 110 | 24 | 0.221 |
| large int | 9 | 696 | 116 | 0.166 | 136 | 28 | 0.209 |
| float | 9 | 611 | 52 | 0.085 | 101 | 28 | 0.275 |
| short string | 15 | 711 | 78 | 0.110 | 268 | 114 | 0.425 |
| medium string | 222 | 899 | 445 | 0.495 | 222 | 143 | 0.646 |
| long string | 5003 | 8251 | 4387 | 0.532 | 664 | 505 | 0.761 |
| unicode string | 187 | 1035 | 383 | 0.370 | 1233 | 876 | 0.710 |
| binary 256 | 259 | 637 | 152 | 0.239 | 165 | 61 | 0.372 |
| binary 4096 | 4099 | 2059 | 601 | 0.292 | 147 | 66 | 0.445 |
| small array | 7 | 651 | 127 | 0.196 | 292 | 68 | 0.232 |
| integer array | 174 | 1907 | 1226 | 0.643 | 958 | 743 | 0.776 |
| small map | 21 | 800 | 151 | 0.189 | 460 | 151 | 0.329 |
| large map | 693 | 4399 | 3203 | 0.728 | 39031 | 27422 | 0.703 |
| typical response | 590 | 4955 | 3317 | 0.670 | 7556 | 3684 | 0.488 |
| nested combinations | 1120 | 14085 | 10930 | 0.776 | 25699 | 13955 | 0.543 |
| timestamp | 10 | 1262 | 420 | 0.333 | 364 | 159 | 0.437 |
| timestamp before epoch | 15 | 1245 | 436 | 0.350 | 390 | 214 | 0.548 |
| timestamp nested | 125 | 6481 | 5363 | 0.827 | 3602 | 2501 | 0.694 |
| custom point | 18 | 1375 | 506 | 0.368 | 322 | 174 | 0.541 |
| custom nested | 228 | 7980 | 7240 | 0.907 | 4021 | 1828 | 0.455 |
| custom array | 363 | 12422 | 11326 | 0.912 | 2778 | 2196 | 0.790 |

No measured payload was slower for either operation; all 23 were faster for both.

## Layout

- `packages/msgpack/src/` — implementation.
- `packages/msgpack/lib/` — built ESM, CommonJS, plain-script UMD, and declarations.
- `test/` — byte and value parity tests and the fixture corpus.
- `bench/` — side-by-side performance harness.
- `verification/` — option, multi-message, stream, malformed-input, and adoption
  checks.
- `examples/server`, `examples/browser` — applications that adopt the package
  without source changes.
- `examples/browser-script` — a page that loads the library with one plain
  script reference, used by `verify:browser-script`.
- `examples/typed` — a strict TypeScript application written against the
  original's published types, used by `verify:typed`.
