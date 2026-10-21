import { mkdir, writeFile } from "node:fs/promises";
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

const declarations = `export interface EncoderOptions {
  initialBufferSize?: number;
  extensionCodec?: ExtensionCodec;
  context?: unknown;
  useBigInt64?: boolean;
  maxDepth?: number;
  sortKeys?: boolean;
  forceFloat32?: boolean;
  forceIntegerToFloat?: boolean;
  ignoreUndefined?: boolean;
  [option: string]: unknown;
}

export interface KeyDecoder {
  canBeCached(byteLength: number): boolean;
  decode(bytes: Uint8Array, inputOffset: number, byteLength: number): string;
}

export type MapKeyConverter = (key: unknown) => string | number;

export interface DecoderOptions {
  extensionCodec?: ExtensionCodec;
  context?: unknown;
  useBigInt64?: boolean;
  rawStrings?: boolean;
  maxStrLength?: number;
  maxBinLength?: number;
  maxArrayLength?: number;
  maxMapLength?: number;
  maxExtLength?: number;
  keyDecoder?: KeyDecoder | null;
  mapKeyConverter?: MapKeyConverter;
  [option: string]: unknown;
}

export declare class DecodeError extends Error {
  constructor(message: string);
}

export type ExtensionEncoder = (
  object: unknown,
  context?: unknown,
) => Uint8Array | ((dataPos: number) => Uint8Array) | null | undefined;

export type ExtensionDecoder = (data: Uint8Array, extensionType: number, context?: unknown) => unknown;

export interface ExtensionCodecEntry {
  type: number;
  encode?: ExtensionEncoder;
  decode?: ExtensionDecoder;
}

export declare class ExtData {
  constructor(type: number, data: Uint8Array | ((pos: number) => Uint8Array));
  readonly type: number;
  readonly data: Uint8Array | ((pos: number) => Uint8Array);
}

export declare class ExtensionCodec {
  static readonly defaultCodec: ExtensionCodec;
  constructor();
  register(entry: ExtensionCodecEntry): void;
  tryToEncode(object: unknown, context?: unknown): ExtData | null;
  decode(data: Uint8Array, type: number, context?: unknown): unknown;
}

export interface TimeSpec {
  sec: number;
  nsec: number;
}

export declare const EXT_TIMESTAMP: number;
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

export declare class Encoder {
  constructor(options?: EncoderOptions);
  encode(value: unknown): Uint8Array<ArrayBuffer>;
  encodeSharedRef(value: unknown): Uint8Array<ArrayBuffer>;
}

export declare class Decoder {
  constructor(options?: DecoderOptions);
  decode(buffer: ArrayLike<number> | ArrayBufferView | ArrayBuffer): unknown;
  decodeMulti(
    buffer: ArrayLike<number> | ArrayBufferView | ArrayBuffer,
  ): Generator<unknown, void, unknown>;
}

export declare const DEFAULT_INITIAL_BUFFER_SIZE: number;

export declare function encode(value: unknown, options?: EncoderOptions): Uint8Array<ArrayBuffer>;
export declare function decode(
  buffer: ArrayLike<number> | ArrayBufferView | ArrayBuffer,
  options?: DecoderOptions,
): unknown;
export declare function decodeMulti(
  buffer: ArrayLike<number> | ArrayBufferView | ArrayBuffer,
  options?: DecoderOptions,
): Generator<unknown, void, unknown>;
`;

await writeFile(join(outDir, "index.d.ts"), declarations);
console.log("built packages/msgpack/lib/index.mjs, index.cjs, index.d.ts");
