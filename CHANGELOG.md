# Changelog

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
