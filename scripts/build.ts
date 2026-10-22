import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const outDir = join(root, "packages/msgpack/lib");
await mkdir(outDir, { recursive: true });

const targets = [
  { format: "esm", outfile: "packages/msgpack/lib/index.mjs" },
  { format: "cjs", outfile: "packages/msgpack/lib/index.cjs" },
] as const;

for (const target of targets) {
  const result = await Bun.build({
    entrypoints: [join(root, "packages/msgpack/src/index.ts")],
    outdir: outDir,
    naming: target.outfile.slice("packages/msgpack/lib/".length),
    format: target.format,
    target: "browser",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

// A browser page that loads msgpack-javascript with one plain script reference
// receives the UMD bundle, whose global name is `MessagePack`. Wrapping the
// CommonJS bundle keeps the plain-script surface identical to the module entry
// points without introducing a second implementation to keep in sync.
const cjs = await readFile(join(outDir, "index.cjs"), "utf8");
const umd = `/**
 * @dsdenes/msgpack plain-script build.
 *
 * Loaded with one \`<script src>\` reference, it defines \`MessagePack\` on the
 * global object, mirroring msgpack-javascript's UMD bundle. It also assigns
 * \`module.exports\` under CommonJS and calls \`define\` under AMD.
 */
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else if (typeof define === "function" && define.amd) {
    define([], factory);
  } else {
    root.MessagePack = factory();
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function () {
    var module = { exports: {} };
    var exports = module.exports;

${cjs
  .split("\n")
  .map((line) => (line.length === 0 ? line : `    ${line}`))
  .join("\n")}

    return module.exports;
  },
);
`;
await writeFile(join(outDir, "msgpack.js"), umd);

const declarations = `/**
 * The published types mirror the declarations msgpack-javascript 3.1.3
 * publishes, including the context generics on its options, codecs, encoder
 * and decoder, so a TypeScript application written against the original
 * library continues to build when the dependency is swapped.
 */

type SplitTypes<T, U> = U extends T ? (Exclude<T, U> extends never ? T : Exclude<T, U>) : T;
export type SplitUndefined<T> = SplitTypes<T, undefined>;
export type ContextOf<ContextType> = ContextType extends undefined
  ? object
  : {
      context: ContextType;
    };

export type ExtensionDecoderType<ContextType> = (
  data: Uint8Array,
  extensionType: number,
  context: ContextType,
) => unknown;

export type ExtensionEncoderType<ContextType> = (
  input: unknown,
  context: ContextType,
) => Uint8Array | ((dataPos: number) => Uint8Array) | null;

export type ExtensionCodecType<ContextType> = {
  __brand?: ContextType;
  tryToEncode(object: unknown, context: ContextType): ExtData | null;
  decode(data: Uint8Array, extType: number, context: ContextType): unknown;
};

export type ExtensionEncoder = (
  object: unknown,
  context?: unknown,
) => Uint8Array | ((dataPos: number) => Uint8Array) | null | undefined;

export type ExtensionDecoder = (
  data: Uint8Array,
  extensionType: number,
  context?: unknown,
) => unknown;

export interface ExtensionCodecEntry {
  type: number;
  encode?: ExtensionEncoder;
  decode?: ExtensionDecoder;
}

export interface KeyDecoder {
  canBeCached(byteLength: number): boolean;
  decode(bytes: Uint8Array, inputOffset: number, byteLength: number): string;
}

export type MapKeyConverter = (key: unknown) => string | number;

export type EncoderOptions<ContextType = undefined> = Partial<
  Readonly<{
    extensionCodec: ExtensionCodecType<ContextType>;
    /**
     * Encodes bigint as Int64 or Uint64 if it's set to true.
     * Defaults to false.
     */
    useBigInt64: boolean;
    /**
     * The maximum depth in nested objects and arrays.
     * Defaults to 100.
     */
    maxDepth: number;
    /**
     * The initial size of the internal buffer.
     * Defaults to 2048.
     */
    initialBufferSize: number;
    /**
     * If true, the keys of an object are sorted.
     * Defaults to false.
     */
    sortKeys: boolean;
    /**
     * If true, non-integer numbers are encoded in float32.
     * Defaults to false.
     */
    forceFloat32: boolean;
    /**
     * If true, an object property with an undefined value is ignored.
     * Defaults to false.
     */
    ignoreUndefined: boolean;
    /**
     * If true, integer numbers are encoded as floating point numbers.
     * Defaults to false.
     */
    forceIntegerToFloat: boolean;
  }>
> &
  ContextOf<ContextType>;

type MapKeyType = string | number;

export type DecoderOptions<ContextType = undefined> = Readonly<
  Partial<{
    extensionCodec: ExtensionCodecType<ContextType>;
    /**
     * Decodes Int64 and Uint64 as bigint if it's set to true.
     * Defaults to false.
     */
    useBigInt64: boolean;
    /**
     * If true, string values are returned as Uint8Arrays.
     * Defaults to false.
     */
    rawStrings: boolean;
    maxStrLength: number;
    maxBinLength: number;
    maxArrayLength: number;
    maxMapLength: number;
    maxExtLength: number;
    /**
     * An object key decoder. null disables key decoding.
     */
    keyDecoder: KeyDecoder | null;
    /**
     * Converts a decoded map key to a valid JS key type.
     */
    mapKeyConverter: MapKeyConverter;
  }>
> &
  ContextOf<ContextType>;

type ReadableStreamLike<T> = AsyncIterable<T> | ReadableStream<T>;

type StreamInput = ArrayLike<number> | BufferSource;

export declare class DecodeError extends Error {
  constructor(message: string);
}

/**
 * ExtData is used to handle Extension Types that are not registered to
 * ExtensionCodec.
 */
export declare class ExtData {
  readonly type: number;
  readonly data: Uint8Array | ((pos: number) => Uint8Array);
  constructor(type: number, data: Uint8Array | ((pos: number) => Uint8Array));
}

export declare class ExtensionCodec<ContextType = undefined>
  implements ExtensionCodecType<ContextType>
{
  static readonly defaultCodec: ExtensionCodecType<undefined>;
  __brand?: ContextType;
  constructor();
  register(entry: {
    type: number;
    encode: ExtensionEncoderType<ContextType>;
    decode: ExtensionDecoderType<ContextType>;
  }): void;
  tryToEncode(object: unknown, context: ContextType): ExtData | null;
  decode(data: Uint8Array, type: number, context: ContextType): unknown;
}

export interface TimeSpec {
  sec: number;
  nsec: number;
}

export declare const EXT_TIMESTAMP: -1;
export declare const timestampExtension: {
  type: number;
  encode: (object: unknown) => Uint8Array | null;
  decode: (data: Uint8Array) => Date;
};
export declare function encodeTimeSpecToTimestamp(timeSpec: TimeSpec): Uint8Array;
export declare function encodeDateToTimeSpec(date: Date): TimeSpec;
export declare function encodeTimestampExtension(object: unknown): Uint8Array | null;
export declare function decodeTimestampToTimeSpec(data: Uint8Array): TimeSpec;
export declare function decodeTimestampExtension(data: Uint8Array): Date;

export declare class Encoder<ContextType = undefined> {
  constructor(options?: EncoderOptions<ContextType>);
  encodeSharedRef(value: unknown): Uint8Array<ArrayBuffer>;
  encode(value: unknown): Uint8Array<ArrayBuffer>;
}

export declare class Decoder<ContextType = undefined> {
  constructor(options?: DecoderOptions<ContextType>);
  decode(buffer: ArrayLike<number> | ArrayBufferView | ArrayBufferLike): unknown;
  decodeMulti(buffer: ArrayLike<number> | BufferSource): Generator<unknown, void, unknown>;
  decodeAsync(stream: AsyncIterable<ArrayLike<number> | BufferSource>): Promise<unknown>;
  decodeArrayStream(
    stream: AsyncIterable<ArrayLike<number> | BufferSource>,
  ): AsyncGenerator<unknown, void, unknown>;
  decodeStream(
    stream: AsyncIterable<ArrayLike<number> | BufferSource>,
  ): AsyncGenerator<unknown, void, unknown>;
}

export declare const DEFAULT_INITIAL_BUFFER_SIZE: number;

export declare function encode<ContextType = undefined>(
  value: unknown,
  options?: EncoderOptions<SplitUndefined<ContextType>>,
): Uint8Array<ArrayBuffer>;
export declare function decode<ContextType = undefined>(
  buffer: ArrayLike<number> | ArrayBufferView | ArrayBufferLike,
  options?: DecoderOptions<SplitUndefined<ContextType>>,
): unknown;
export declare function decodeMulti<ContextType = undefined>(
  buffer: ArrayLike<number> | BufferSource,
  options?: DecoderOptions<SplitUndefined<ContextType>>,
): Generator<unknown, void, unknown>;
export declare function decodeAsync<ContextType = undefined>(
  streamLike: ReadableStreamLike<StreamInput>,
  options?: DecoderOptions<SplitUndefined<ContextType>>,
): Promise<unknown>;
export declare function decodeArrayStream<ContextType>(
  streamLike: ReadableStreamLike<StreamInput>,
  options?: DecoderOptions<SplitUndefined<ContextType>>,
): AsyncGenerator<unknown, void, unknown>;
export declare function decodeMultiStream<ContextType>(
  streamLike: ReadableStreamLike<StreamInput>,
  options?: DecoderOptions<SplitUndefined<ContextType>>,
): AsyncGenerator<unknown, void, unknown>;

/**
 * The default export carries the named runtime API. Every property has the
 * same type as the named export it references, so msgpack.encode and encode
 * are interchangeable for a typed consumer.
 */
declare const msgpack: {
  encode: typeof encode;
  Encoder: typeof Encoder;
  decode: typeof decode;
  decodeMulti: typeof decodeMulti;
  decodeAsync: typeof decodeAsync;
  decodeArrayStream: typeof decodeArrayStream;
  decodeMultiStream: typeof decodeMultiStream;
  Decoder: typeof Decoder;
  DecodeError: typeof DecodeError;
  DEFAULT_INITIAL_BUFFER_SIZE: typeof DEFAULT_INITIAL_BUFFER_SIZE;
  ExtData: typeof ExtData;
  ExtensionCodec: typeof ExtensionCodec;
  EXT_TIMESTAMP: typeof EXT_TIMESTAMP;
  decodeTimestampExtension: typeof decodeTimestampExtension;
  decodeTimestampToTimeSpec: typeof decodeTimestampToTimeSpec;
  encodeDateToTimeSpec: typeof encodeDateToTimeSpec;
  encodeTimeSpecToTimestamp: typeof encodeTimeSpecToTimestamp;
  encodeTimestampExtension: typeof encodeTimestampExtension;
  timestampExtension: typeof timestampExtension;
};
export default msgpack;
`;

await writeFile(join(outDir, "index.d.ts"), declarations);
console.log("built packages/msgpack/lib/index.mjs, index.cjs, index.d.ts, msgpack.js");
