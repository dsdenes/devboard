# Changelog

## 1.0.0

- Rename the package from `@devboard/msgpack` to `@dsdenes/msgpack` and publish
  version `1.0.0` publicly to the npm registry. Consumers install
  `@dsdenes/msgpack` directly and replace the import specifier; no dependency
  alias and no `file:` dependency is needed.
- Add a default export whose own enumerable properties are exactly the named
  runtime exports, each holding the same reference, so
  `import msgpack from "@dsdenes/msgpack"` and
  `require("@dsdenes/msgpack").default` expose the same API as named imports.
  The shipped declarations describe that default export with the same property
  types.
- Expose `./package.json` and `./lib/*` subpaths alongside the conditional root
  entry point, so `@dsdenes/msgpack/package.json`,
  `@dsdenes/msgpack/lib/index.mjs`, `@dsdenes/msgpack/lib/index.cjs`, and
  `@dsdenes/msgpack/lib/msgpack.js` resolve. Reference-internal `dist.esm/*`,
  `dist.cjs/*`, and `src/*` paths remain out of scope with no shims.
- Ship a package README and an ISC LICENSE, and keep the published tarball to
  `package.json`, `README.md`, `LICENSE`, and the four files under `lib/`
  (`index.mjs`, `index.cjs`, `index.d.ts`, `msgpack.js`). The package manifest
  declares the repository, homepage, bugs, keywords, `sideEffects: false`, and
  ISC license.
- Migrate this repository to the new name: the root workspace depends on
  `@dsdenes/msgpack`, the bench and verification scripts import it, every
  example depends on and imports it, and the differential reference remains
  `msgpack-javascript-original@3.1.3`. Adoption verification now generates a
  baseline copy that differs only in the package specifier and proves identical
  output, instead of swapping dependency resolutions in place.
- Add `bun run verify:surface`, which checks the default export, CommonJS
  interop, subpath resolution, the strict TypeScript declaration shape, the
  `npm pack` file list, and encode/decode parity with msgpack-javascript 3.1.3.
- Encoding bytes, decoded values, error types, error messages, options, and
  performance are unchanged from 0.7.0.

## 0.7.0

- Let build tooling that resolves dependencies the traditional way adopt the
  replacement unchanged. The package publishes top-level `main`, `module`, and
  `types` entry points alongside its conditional `exports` map, so classic Node
  module resolution and bundlers that read `main`/`module` instead of `exports`
  find the same CommonJS, ESM, and declaration files they resolved from
  msgpack-javascript. `sideEffects` is marked `false` for tree-shaking bundlers.
- Add `examples/typed-classic`, a strict TypeScript application that uses
  `moduleResolution: "node"` and CommonJS output and is written against the
  original's public API and types, and `bun run verify:classic-typed`, which
  builds and runs it before and after the swap with no diagnostics, no source or
  tsconfig changes, and identical output.
- Add `examples/classic-bundler`, a Browserify application whose bundle resolves
  the package through `main` without reading `exports`, and
  `bun run verify:classic-bundler`, which bundles and runs it before and after
  the swap with identical output and unchanged source.
- Both new adoption checks cover primitives, non-ASCII text, binary data,
  arrays, maps, nested values, timestamps, and a registered extension type, and
  report the same failure type and message for malformed input, an unsupported
  option value, and a decoder length limit.

## 0.6.0

- Keep encoding and decoding faster than msgpack-javascript for moderately
  large messages: long ASCII and non-ASCII text, large binary values, large
  numeric arrays, large maps, and nested responses combining them, spanning
  tens to hundreds of kilobytes.
- Encode long strings with one native `TextEncoder` pass instead of counting
  the UTF-8 length in JavaScript and then encoding it, so long text no longer
  pays for two scans. Bytes remain identical to msgpack-javascript for ASCII,
  non-ASCII, surrogate pairs, and lone surrogates.
- Hand off large encoded buffers instead of copying them, and allocate a grown
  buffer in one step, so large binary values, arrays, maps, and nested
  messages avoid extra passes over the payload.
- Extend the side-by-side benchmark with cases from tens to hundreds of
  kilobytes: 99 KB and 130 KB text, 100 KB mostly-ASCII text, 64 KB and 256 KB
  binary values, a 20,000-element integer array, an 8,000-element float array,
  a 4,000-key map, and two nested responses at 121 KB and 220 KB.
- Measure every case and operation in its own process, time large operations
  call by call with the libraries alternating, and verify encoded bytes and
  decoded values before measuring, so results do not depend on process history
  or a noisy machine. Every measured case is faster for both operations.
- Keep every previously measured small and medium case faster than the
  original for both encoding and decoding.

## 0.5.0

- Match msgpack-javascript 3.1.3 on malformed and externally produced input
  through every decoding entry point: `decode`, `decodeMulti`, `decodeAsync`,
  `decodeMultiStream`, `decodeArrayStream`, and the `Decoder` methods.
- Report the reference's `RangeError` message for extra bytes and its
  `DecodeError` for the reserved type byte, `__proto__` map keys, and
  timestamp extensions of unsupported sizes.
- Decode iteratively, so nesting depth is bounded by memory instead of the
  JavaScript call stack, as in the reference; 30,000-deep arrays and maps now
  decode instead of overflowing.
- Resume stream decoding across chunk boundaries instead of re-decoding
  buffered bytes, so delivered values and terminal failures match the reference
  for every split position, including invalid UTF-8 at the tail of a string and
  input that ends partway through a message.
- Add malformed-input regression tests and `bun run verify:malformed`, which
  compares 1.1 million outcomes between both libraries across every single-byte
  header, every truncation of every supported payload, alternative encodings,
  generated byte sequences, decoding options, and buffered and streamed input.
- Feed corrupted and foreign byte sequences to the server and browser adoption
  applications and compare the reported values and failure descriptions before
  and after the dependency swap.
- Publish the type surface msgpack-javascript 3.1.3 publishes: the context
  generics on `EncoderOptions`, `DecoderOptions`, `Encoder`, `Decoder`, and
  `ExtensionCodec`; the `ExtensionCodecType`, `ExtensionEncoderType`, and
  `ExtensionDecoderType` contracts; `ContextOf`/`SplitUndefined`; and the
  original input, return, and option types. TypeScript applications written
  against the original library build unchanged after the dependency swap.
- Add the strict TypeScript application in `examples/typed`, which refers to
  the original's published types for its options, codec, and values, and
  `bun run verify:typed`, which builds and runs it before and after the swap
  and compares every encoded and decoded result.
- Ship `packages/msgpack/lib/msgpack.js`, a plain-script UMD bundle that
  defines the same `MessagePack` global as msgpack-javascript's UMD build, and
  resolve the package's `unpkg` and `cdn` fields to it. A browser page that
  loads the library through one script reference adopts the replacement by
  changing only that reference, with no bundler and no build step.
- Add `examples/browser-script`, a page whose markup and inline script stay
  fixed, and `bun run verify:browser-script`, which opens the page against the
  original and the replacement in headless Chrome and requires identical entry
  points, encoded bytes, decoded values, options, timestamps, extension types,
  and failure types and messages.

## 0.4.0

- Add the incremental, stream-fed decoding surface: `decodeMultiStream`,
  `decodeAsync`, `decodeArrayStream`, and `Decoder.prototype.decodeStream`,
  `decodeAsync`, and `decodeArrayStream`, matching msgpack-javascript 3.1.3 for
  async iterables and WHATWG `ReadableStream` input.
- Deliver each message as soon as its last byte arrives, with chunk boundaries
  anywhere inside a message. An empty stream yields no messages and no failure.
- Deliver every complete message before a stream ends partway through a message
  and then end like the reference; `decodeAsync` raises the reference's
  `RangeError` for empty and incomplete streams, including its message text.
- Apply every decoding option to streamed messages.
- Keep single-message and whole-buffer decoding, encoding output, option and
  extension behavior unchanged.
- Add stream parity tests and `bun run verify:stream`; extend the server and
  browser adoption applications to consume chunked message streams.

## 0.3.0

- Add `decodeMulti(buffer, options?)` and `Decoder.prototype.decodeMulti`,
  matching msgpack-javascript 3.1.3 for a buffer holding consecutive messages:
  values are delivered in order, an empty buffer yields no messages, and a
  truncated final message delivers the complete messages before it and then
  throws `RangeError`.
- Apply every documented decoding option to multi-message decoding, including
  extension codecs, context, `useBigInt64`, `rawStrings`, the `max*Length`
  limits, `keyDecoder`, and `mapKeyConverter`.
- Match the reference's out-of-bounds and insufficient-data errors while
  decoding fixed-width values, strings, binaries, and extension payloads.
- Keep single-message decoding unchanged, including rejection of extra bytes.
- Add multi-message parity tests and `bun run verify:multi`, which exercises the
  built package under the original package name against the reference.

## 0.2.0

- Support every documented msgpack-javascript 3.1.3 encoding option:
  `useBigInt64`, `maxDepth`, `initialBufferSize`, `sortKeys`, `forceFloat32`,
  `forceIntegerToFloat`, and `ignoreUndefined`, alongside `extensionCodec` and
  `context`.
- Support every documented decoding option: `useBigInt64`, `rawStrings`,
  `maxStrLength`, `maxBinLength`, `maxArrayLength`, `maxMapLength`,
  `maxExtLength`, `keyDecoder`, and `mapKeyConverter`.
- Export `DecodeError` and raise it for length limits and the default map key
  converter, matching the reference error category.
- Match the reference at and beyond each length and nesting boundary, for
  individual options and for combinations.
- Keep no-option encoding and decoding byte- and value-identical to 0.1.0.
- Add option parity tests and `bun run verify:options`, which exercises the
  built package through its public ESM and CommonJS entry points.

## 0.1.0

- Add `@devboard/msgpack`, a byte-compatible drop-in replacement for
  `@msgpack/msgpack` for nulls, booleans, numbers, strings, binary data, arrays,
  maps, timestamps, and nested combinations.
- Match msgpack-javascript 3.1.3 default encoding for every in-scope value,
  including integer width selection, float64 numbers, UTF-8 string thresholds,
  and bin/array/map headers.
- Decode with the same value types and structure, including binary `Uint8Array`
  views and plain-object maps, with a bounded key cache.
- Encode and decode the built-in timestamp extension for 32-, 64-, and 96-bit
  representations, including pre-epoch and boundary dates.
- Add `ExtensionCodec`, `ExtData`, and timestamp helpers, and accept
  `extensionCodec` and `context` options so application-registered types round
  trip through arrays, maps, and mixed payloads.
- Add byte-identity and decode-identity tests against the reference package for
  every timestamp boundary and custom extension payload width.
- Add timestamp and custom-extension cases to the side-by-side benchmark; all 23
  measured payloads are faster with the replacement for both operations.
- Exercise timestamps and a registered custom type in the server and browser
  adoption verification.
