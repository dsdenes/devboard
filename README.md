# @dsdenes/msgpack

A byte-compatible, drop-in replacement for msgpack-javascript 3.1.3 covering
everyday payloads: nulls, booleans, numbers, strings, binary data, arrays, maps,
timestamps, application-registered extension types, and nested combinations of
them. It is published as `@dsdenes/msgpack@1.0.0`; applications install it
directly and import the same API names.

## Benchmark

`@dsdenes/msgpack` is a drop-in replacement for msgpack-javascript 3.1.3:
same API, same bytes on the wire, and same decoded values. It is also faster.

All 33 measured payloads encode and decode faster than the original, and none is
slower. Median ratios (replacement ÷ original, lower is faster) are 0.44 for
encoding — about 2.3× faster — and 0.73 for decoding — about 1.4× faster. Long
ASCII text encodes about 10× faster, while a typical application response
encodes about 2× and decodes about 1.5× faster. Measured on Bun 1.4.2, Linux
x64, on the same machine and payloads. The cases cover one-byte primitives
through 256 KB binary values, 20,000-element arrays, 4,000-key maps, and 220 KB
nested responses; the full table and methodology are under
[Measured performance](#measured-performance).

## Adoption

Install the package and replace the import specifier:

```sh
npm install @dsdenes/msgpack
```

```ts
import { decode, encode } from "@dsdenes/msgpack";

const bytes = encode({ id: 1, name: "widget" });
const value = decode(bytes);
```

The package root also has a default export that holds the same API, so code
that used a single namespace object can keep that shape:

```ts
import msgpack from "@dsdenes/msgpack";

const bytes = msgpack.encode({ id: 1, name: "widget" });
```

No dependency alias and no `file:` dependency is needed. The package exposes
conditional ESM and CommonJS entry points, so `import ... from
"@dsdenes/msgpack"`, `require("@dsdenes/msgpack")`, and the CommonJS `.default`
property all resolve to this implementation.

Build tooling that resolves dependencies the traditional way — classic Node
module resolution, or a bundler that reads `main`/`module` and never looks at
conditional `exports` — finds the same implementation through the package's
top-level `main`, `module`, and `types` fields. A strict TypeScript application
using `moduleResolution: "node"` and a Browserify bundle both build from an
unchanged source and configuration after the import replacement.

The package ships its declarations, README, and ISC LICENSE, and exposes these
subpaths: `@dsdenes/msgpack/package.json`, `@dsdenes/msgpack/lib/index.mjs`,
`@dsdenes/msgpack/lib/index.cjs`, `@dsdenes/msgpack/lib/index.d.ts`, and
`@dsdenes/msgpack/lib/msgpack.js`. Reference-internal paths (`dist.esm/*`,
`dist.cjs/*`, `src/*`) are out of scope and have no shims.

A page that loads msgpack-javascript with one plain script reference, without a
bundler or a build step, points that reference at the package's UMD bundle and
keeps its markup and inline script unchanged:

```html
<script src="https://unpkg.com/@dsdenes/msgpack/lib/msgpack.js"></script>
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
} from "@dsdenes/msgpack";

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
import { decodeMulti, encode } from "@dsdenes/msgpack";

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
import { decodeMultiStream, encode } from "@dsdenes/msgpack";

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

Type-declaration parity is shipped in `lib/index.d.ts`, and the package is
published as `@dsdenes/msgpack@1.0.0`; neither is out of scope.

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
bun run verify:surface
bun run verify:typed
bun run verify:classic-typed
bun run verify:classic-bundler
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

`bun run verify:multi` imports the built package by its public
`@dsdenes/msgpack` name, encodes varied values with the reference, concatenates
the bytes, and compares `decodeMulti` and `Decoder.decodeMulti` against the
reference for every payload type, every decoding option and limit, an empty
buffer, and every truncation point of a final message. It fails if the delivered
values, order, error category, or error message differ.

`bun run verify:stream` imports the built package by its public
`@dsdenes/msgpack` name, encodes every in-scope payload with the reference, and
feeds the concatenated bytes as chunks whose boundaries fall at every position
of a compact stream and inside every message of a larger stream. It compares
`decodeMultiStream`, `Decoder.decodeStream`, `decodeAsync`, and
`decodeArrayStream` with the reference, including empty streams, truncated final
messages, decoding options, WHATWG `ReadableStream` input, and the CommonJS
entry point. It fails if delivered values, order, error category, or message
differ.

`bun run verify:malformed` imports the built package by its public
`@dsdenes/msgpack` name and compares over a million outcomes with the reference:
every single-byte header with payload bytes of several shapes, every truncation
of every supported payload and of alternative encodings, generated and mutated
byte sequences, buffers with no message, one message, and several concatenated
messages with the final message truncated at every position, decoding options
and key converters, every input form, and streamed input split at every position
through async iterables and WHATWG `ReadableStream`s. It fails if a value
differs, if one library accepts bytes the other rejects, or if an error type or
message differs.

`bun run verify:surface` checks the published package surface. It asserts that
the default export's enumerable properties are exactly the named runtime
exports, each holding the same reference; that CommonJS `require`, including
its `.default`, exposes the same API; that the package root and each documented
subpath resolve under Node; that a strict TypeScript consumer compiles both
import forms; that `npm pack` ships exactly the package manifest, README,
LICENSE, and four `lib/` files; and that a parity corpus covering primitives,
numbers, strings, binary, arrays, maps, timestamps, and a registered extension
type encodes and decodes identically to the reference. Set `SURFACE_TARGET` to
an application directory to run the resolution and parity checks against a
published install.

`bun run bench` builds the shipped package and compares both libraries on the
same machine and payloads. Every case and every operation runs in its own
process; the libraries are timed one call at a time in alternating order, and
the reported ratio is the median of adjacent pairs after warmup, so CPU
frequency drift or a busy neighbor cannot favor either side. Before timing, it
verifies that both libraries produce identical bytes and equal decoded values
for the case. It covers messages from one-byte primitives to 256 KB binary
values and 220 KB nested responses, and exits non-zero if any measured payload
is slower for either operation.

`bun run verify:typed` copies the TypeScript application in `examples/typed`
into a baseline directory, rewrites only the package specifier there, installs
msgpack-javascript 3.1.3 for that baseline and the replacement for the
checked-in application, and builds both with `tsc` under `strict`. The
application's source refers to the published types for its options, extension
codec, and values, including a context generic and annotations that adapt those
types to the application. The script fails if either build reports a diagnostic,
if either run fails, if the two runs encode or decode any value differently, or
if the application source changes between the runs.

`bun run verify:classic-typed` does the same for the strict TypeScript
application in `examples/typed-classic`, whose tsconfig uses classic
`moduleResolution: "node"` and CommonJS output: it builds the baseline copy with
`tsc`, runs the built JavaScript with Node, then builds and runs the
checked-in application. The script fails if either build reports a diagnostic,
if either run fails, if the two runs differ in encoded bytes, decoded values, or
failure types and messages, or if the source or tsconfig changes between builds.

`bun run verify:classic-bundler` does the same for the application in
`examples/classic-bundler`, which Browserify bundles from a CommonJS source
using the package's `main` field and no `exports` support. Both bundles must
build and run, their output must match, and the application source must stay
byte-for-byte identical across the swap.

`bun run verify:server` and `bun run verify:browser` exercise the two adopting
applications in `examples/`. Each script hashes the application source before
and after, runs a baseline copy whose only source change is the package
specifier, runs the checked-in application against the replacement, and
compares the results. Both applications encode and decode timestamps and a
registered `GeoPoint` type, consume consecutive messages incrementally from
chunked byte streams, and report the value or failure for corrupted and
externally produced byte sequences. The browser script loads the built
application in headless Chrome and reads the rendered result.

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

Bun 1.4.2 on Linux x64, built package entry. Each case and operation runs in a
fresh process. The libraries are timed one call at a time, alternating which
one goes first; each number is the median of hundreds to thousands of adjacent
pairs after warmup. Timer overhead of a few tens of nanoseconds is included in
both libraries, so the small-case ratios are conservative. `ratio` is
replacement divided by original, so lower is faster. Before timing, every case
checks that both libraries produce identical bytes and equal decoded values.

| Case | Bytes | Encode ref | Encode new | Ratio | Decode ref | Decode new | Ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| null | 1 | 350 | 80 | 0.235 | 150 | 90 | 0.600 |
| boolean | 1 | 400 | 90 | 0.225 | 140 | 90 | 0.615 |
| small int | 1 | 390 | 100 | 0.290 | 180 | 100 | 0.588 |
| large int | 9 | 680 | 250 | 0.391 | 140 | 90 | 0.615 |
| float | 9 | 330 | 110 | 0.313 | 140 | 90 | 0.615 |
| short string | 15 | 540 | 180 | 0.333 | 520 | 340 | 0.649 |
| medium string | 222 | 730 | 170 | 0.230 | 270 | 190 | 0.730 |
| long string | 5003 | 6760 | 650 | 0.114 | 610 | 540 | 0.889 |
| unicode string | 187 | 1230 | 420 | 0.347 | 1000 | 840 | 0.867 |
| binary 256 | 259 | 640 | 290 | 0.444 | 210 | 140 | 0.667 |
| binary 4096 | 4099 | 1320 | 530 | 0.398 | 190 | 120 | 0.650 |
| small array | 7 | 940 | 300 | 0.339 | 330 | 220 | 0.656 |
| integer array | 174 | 740 | 300 | 0.406 | 790 | 630 | 0.800 |
| small map | 21 | 980 | 440 | 0.438 | 430 | 280 | 0.651 |
| large map | 693 | 2650 | 1950 | 0.736 | 30110 | 24560 | 0.821 |
| typical response | 590 | 4570 | 2350 | 0.506 | 3580 | 2430 | 0.686 |
| nested combinations | 1120 | 5860 | 5450 | 0.944 | 11310 | 7470 | 0.664 |
| timestamp | 10 | 790 | 360 | 0.500 | 340 | 230 | 0.692 |
| timestamp before epoch | 15 | 710 | 360 | 0.519 | 530 | 400 | 0.750 |
| timestamp nested | 125 | 3480 | 3120 | 0.911 | 1630 | 1490 | 0.914 |
| custom point | 18 | 950 | 480 | 0.554 | 230 | 170 | 0.760 |
| custom nested | 228 | 4380 | 4040 | 0.929 | 1660 | 1400 | 0.852 |
| custom array | 363 | 6710 | 6370 | 0.957 | 2710 | 2620 | 0.943 |
| long ascii text | 99005 | 99590 | 10490 | 0.100 | 3970 | 3650 | 0.963 |
| long unicode text | 130005 | 133269 | 48790 | 0.368 | 48750 | 48349 | 0.997 |
| mostly ascii text | 100008 | 107039 | 17900 | 0.169 | 7090 | 6860 | 0.977 |
| binary 64KB | 65541 | 4480 | 2840 | 0.612 | 210 | 140 | 0.658 |
| binary 256KB | 262149 | 15500 | 11580 | 0.744 | 200 | 130 | 0.632 |
| integer array 20K | 99835 | 180619 | 151360 | 0.841 | 134750 | 111079 | 0.828 |
| float array 8K | 72003 | 81189 | 45850 | 0.573 | 58120 | 45800 | 0.790 |
| large map 4K | 50857 | 236969 | 199629 | 0.849 | 1541466 | 1337486 | 0.873 |
| nested response | 120884 | 294779 | 239730 | 0.804 | 317239 | 230080 | 0.730 |
| nested mixed | 219930 | 223729 | 137100 | 0.605 | 139729 | 108779 | 0.781 |

No measured payload was slower for either operation; all 33 were faster for both.
The large cases cover 99 KB and 130 KB text, 100 KB mostly-ASCII text, 64 KB and
256 KB binary values, 20,000- and 8,000-element numeric arrays, a 4,000-key map,
and nested responses of 121 KB and 220 KB.

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
- `examples/typed-classic` — a strict TypeScript application using classic Node
  module resolution, used by `verify:classic-typed`.
- `examples/classic-bundler` — a Browserify application resolved through the
  package's traditional entry fields, used by `verify:classic-bundler`.
