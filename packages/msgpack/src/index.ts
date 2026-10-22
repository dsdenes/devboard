import { encode, Encoder } from "./encoder.ts";
import {
  decode,
  decodeArrayStream,
  decodeAsync,
  decodeMulti,
  decodeMultiStream,
  Decoder,
} from "./decoder.ts";
import { DecodeError } from "./decode-error.ts";
import { DEFAULT_INITIAL_BUFFER_SIZE } from "./writer.ts";
import { ExtData, ExtensionCodec } from "./extension.ts";
import {
  EXT_TIMESTAMP,
  decodeTimestampExtension,
  decodeTimestampToTimeSpec,
  encodeDateToTimeSpec,
  encodeTimeSpecToTimestamp,
  encodeTimestampExtension,
  timestampExtension,
} from "./timestamp.ts";

export { encode, Encoder } from "./encoder.ts";
export type { EncoderOptions } from "./encoder.ts";
export { decode, decodeMulti, decodeAsync, decodeArrayStream, decodeMultiStream, Decoder } from "./decoder.ts";
export type { DecoderOptions, KeyDecoder, MapKeyConverter } from "./decoder.ts";
export { DecodeError } from "./decode-error.ts";
export { DEFAULT_INITIAL_BUFFER_SIZE } from "./writer.ts";
export { ExtData, ExtensionCodec } from "./extension.ts";
export type { ExtensionCodecEntry, ExtensionDecoder, ExtensionEncoder } from "./extension.ts";
export {
  EXT_TIMESTAMP,
  decodeTimestampExtension,
  decodeTimestampToTimeSpec,
  encodeDateToTimeSpec,
  encodeTimeSpecToTimestamp,
  encodeTimestampExtension,
  timestampExtension,
} from "./timestamp.ts";
export type { TimeSpec } from "./timestamp.ts";

/**
 * The default export is the same object surface as the named exports: every
 * runtime name is a property holding that exact binding. It lets a consumer
 * write `import msgpack from "@dsdenes/msgpack"` where the original UMD
 * bundle's single `MessagePack` object was used, without a second
 * implementation or a proxy.
 */
export default {
  encode,
  Encoder,
  decode,
  decodeMulti,
  decodeAsync,
  decodeArrayStream,
  decodeMultiStream,
  Decoder,
  DecodeError,
  DEFAULT_INITIAL_BUFFER_SIZE,
  ExtData,
  ExtensionCodec,
  EXT_TIMESTAMP,
  decodeTimestampExtension,
  decodeTimestampToTimeSpec,
  encodeDateToTimeSpec,
  encodeTimeSpecToTimestamp,
  encodeTimestampExtension,
  timestampExtension,
};
