# Changelog

## 0.1.0

- Add `@devboard/msgpack`, a byte-compatible drop-in replacement for
  `@msgpack/msgpack` for nulls, booleans, numbers, strings, binary data, arrays,
  maps, and nested combinations.
- Match msgpack-javascript 3.1.3 default encoding for every in-scope value,
  including integer width selection, float64 numbers, UTF-8 string thresholds,
  and bin/array/map headers.
- Decode with the same value types and structure, including binary `Uint8Array`
  views and plain-object maps, with a bounded key cache.
- Add byte-identity and decode-identity tests against the reference package.
- Add a side-by-side benchmark and server and browser adoption verification.
