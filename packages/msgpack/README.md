# @dsdenes/msgpack

A byte-compatible, drop-in replacement for msgpack-javascript 3.1.3 covering
everyday payloads: nulls, booleans, numbers, strings, binary data, arrays,
maps, timestamps, application-registered extension types, and nested
combinations of them.

## Install

```sh
npm install @dsdenes/msgpack
```

The package is ESM and CommonJS compatible, ships its own TypeScript
declarations, and has no runtime dependencies.

## Usage

Named imports:

```ts
import { decode, encode } from "@dsdenes/msgpack";

const bytes = encode({ id: 1, name: "widget" });
const value = decode(bytes);
```

Default import:

```ts
import msgpack from "@dsdenes/msgpack";

const bytes = msgpack.encode({ id: 1, name: "widget" });
const value = msgpack.decode(bytes);
```

The default export holds the named runtime API: each property is the same
reference as the corresponding named export (`msgpack.encode === encode`,
`msgpack.Decoder === Decoder`). The object works with `esModuleInterop`-compiled
CommonJS default imports as well:

```js
const msgpack = require("@dsdenes/msgpack").default;
```

CommonJS destructuring works too:

```js
const { encode, decode } = require("@dsdenes/msgpack");
```

## API

- `encode(value, options?)` returns the MessagePack encoding as a `Uint8Array`.
- `decode(buffer, options?)` accepts a `Uint8Array`, another `ArrayBufferView`,
  an `ArrayBuffer`, or an array-like of bytes, and decodes exactly one message.
- `decodeMulti(buffer, options?)` yields every consecutive message in the
  buffer, in order.
- `decodeMultiStream(streamLike, options?)` and
  `decodeArrayStream(streamLike, options?)` return async generators that decode
  messages, or the items of one array, from an async iterable of chunks or a
  WHATWG `ReadableStream`; `decodeAsync(streamLike, options?)` decodes exactly
  one message from a stream.
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

Default behaviour matches msgpack-javascript 3.1.3: smallest integer widths,
float64 for non-integers, UTF-8 strings with the same fixstr/str8/str16/str32
thresholds, the same bin/array/map widths, plain-object maps with string or
number keys, `Uint8Array` binary values, and the built-in timestamp extension.
The same encoding and decoding options are accepted, with the same defaults and
the same malformed-input failures.

## Subpaths

Besides the package root, these paths resolve:

| Import | Resolves to |
| --- | --- |
| `@dsdenes/msgpack/package.json` | the package manifest |
| `@dsdenes/msgpack/lib/index.mjs` | the ESM bundle |
| `@dsdenes/msgpack/lib/index.cjs` | the CommonJS bundle |
| `@dsdenes/msgpack/lib/index.d.ts` | the TypeScript declarations |
| `@dsdenes/msgpack/lib/msgpack.js` | the plain-script UMD bundle |

`lib/msgpack.js` is built from the same source as the module entry points and
defines the same `MessagePack` global as msgpack-javascript's UMD build, so a
page that loads the library with one plain `<script src>` keeps working:

```html
<script src="https://unpkg.com/@dsdenes/msgpack/lib/msgpack.js"></script>
```

The package `unpkg` and `cdn` fields point at that file.

Reference-internal paths such as `dist.esm/*`, `dist.cjs/*`, and `src/*` are
out of scope: this package does not ship shim directories for them. Use the
root entry point or the `lib/*` subpaths above.

## License

ISC. See `LICENSE`.
