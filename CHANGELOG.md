# Changelog

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
