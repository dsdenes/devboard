import { readUtf8 } from "./utf8.ts";
import { ExtensionCodec } from "./extension.ts";
import { DecodeError } from "./decode-error.ts";
import { ensureAsyncIterable } from "./stream.ts";
import type { ReadableStreamLike } from "./stream.ts";

export type MapKeyConverter = (key: unknown) => string | number;

export interface KeyDecoder {
  canBeCached(byteLength: number): boolean;
  decode(bytes: Uint8Array, inputOffset: number, byteLength: number): string;
}

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

type Input = ArrayLike<number> | ArrayBufferView | ArrayBuffer | SharedArrayBuffer;

const UINT32_MAX = 0xffff_ffff;
const HEAD_BYTE_REQUIRED = -1;
const EMPTY_BYTES = new Uint8Array(0);

const KEY_MAX_LENGTH = 16;

interface KeyCacheEntry {
  bytes: Uint8Array;
  value: string;
}

const keyCaches: KeyCacheEntry[][] = [];
for (let i = 0; i < KEY_MAX_LENGTH; i++) {
  keyCaches.push([]);
}

function lookupKey(bytes: Uint8Array, start: number, length: number): string | null {
  const entries = keyCaches[length - 1];
  SCAN: for (let i = 0; i < entries.length; i++) {
    const cached = entries[i].bytes;
    for (let j = 0; j < length; j++) {
      if (cached[j] !== bytes[start + j]) {
        continue SCAN;
      }
    }
    return entries[i].value;
  }
  return null;
}

function storeKey(bytes: Uint8Array, start: number, length: number, value: string): void {
  const entries = keyCaches[length - 1];
  const entry = { bytes: bytes.slice(start, start + length), value };
  if (entries.length >= KEY_MAX_LENGTH) {
    // Same bounded-cache policy as the original: replace an arbitrary entry.
    entries[(Math.random() * entries.length) | 0] = entry;
    return;
  }
  entries.push(entry);
}

const defaultKeyDecoder: KeyDecoder = {
  canBeCached(byteLength: number): boolean {
    return byteLength > 0 && byteLength <= KEY_MAX_LENGTH;
  },

  decode(bytes: Uint8Array, start: number, length: number): string {
    const cached = lookupKey(bytes, start, length);
    if (cached !== null) {
      return cached;
    }
    const value = readUtf8(bytes, start, length);
    storeKey(bytes, start, length, value);
    return value;
  },
};

function defaultMapKeyConverter(key: unknown): string | number {
  if (typeof key === "string" || typeof key === "number") {
    return key;
  }
  throw new DecodeError("The type of key must be string or number but " + typeof key);
}

interface DecoderSettings {
  extensionCodec: ExtensionCodec;
  context: unknown;
  useBigInt64: boolean;
  rawStrings: boolean;
  maxStrLength: number;
  maxBinLength: number;
  maxArrayLength: number;
  maxMapLength: number;
  maxExtLength: number;
  keyDecoder: KeyDecoder | null;
  mapKeyConverter: MapKeyConverter;
}

const DEFAULT_DECODER_SETTINGS: DecoderSettings = {
  extensionCodec: ExtensionCodec.defaultCodec,
  context: undefined,
  useBigInt64: false,
  rawStrings: false,
  maxStrLength: UINT32_MAX,
  maxBinLength: UINT32_MAX,
  maxArrayLength: UINT32_MAX,
  maxMapLength: UINT32_MAX,
  maxExtLength: UINT32_MAX,
  keyDecoder: defaultKeyDecoder,
  mapKeyConverter: defaultMapKeyConverter,
};

function resolveDecoderSettings(options?: DecoderOptions): DecoderSettings {
  if (options === undefined) {
    return DEFAULT_DECODER_SETTINGS;
  }
  return {
    extensionCodec: options.extensionCodec ?? ExtensionCodec.defaultCodec,
    context: options.context,
    useBigInt64: options.useBigInt64 ?? false,
    rawStrings: options.rawStrings ?? false,
    maxStrLength: options.maxStrLength ?? UINT32_MAX,
    maxBinLength: options.maxBinLength ?? UINT32_MAX,
    maxArrayLength: options.maxArrayLength ?? UINT32_MAX,
    maxMapLength: options.maxMapLength ?? UINT32_MAX,
    maxExtLength: options.maxExtLength ?? UINT32_MAX,
    keyDecoder: options.keyDecoder !== undefined ? options.keyDecoder : defaultKeyDecoder,
    mapKeyConverter: options.mapKeyConverter ?? defaultMapKeyConverter,
  };
}

class Reader {
  bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  view: DataView<ArrayBufferLike> = new DataView(new ArrayBuffer(0));
  pos = 0;
  head = HEAD_BYTE_REQUIRED;
  trackHead = false;
  settings: DecoderSettings = DEFAULT_DECODER_SETTINGS;

  set(input: Input): void {
    const bytes = toBytes(input);
    this.bytes = bytes;
    if (this.view.buffer !== bytes.buffer ||
      this.view.byteOffset !== bytes.byteOffset ||
      this.view.byteLength !== bytes.byteLength) {
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    this.pos = 0;
    this.head = HEAD_BYTE_REQUIRED;
  }
}

function toBytes(input: Input): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer || input instanceof SharedArrayBuffer) {
    return new Uint8Array(input);
  }
  return Uint8Array.from(input as ArrayLike<number>);
}

const sharedReader = new Reader();
let sharedReaderEntered = false;

export class Decoder {
  private readonly reader = new Reader();
  private readonly options: DecoderOptions | undefined;
  private readonly settings: DecoderSettings;
  private entered = false;

  constructor(options?: DecoderOptions) {
    this.options = options;
    this.settings = resolveDecoderSettings(options);
  }

  decode(buffer: Input): unknown {
    if (this.entered) {
      return new Decoder(this.options).decode(buffer);
    }
    this.entered = true;
    try {
      const reader = this.reader;
      reader.settings = this.settings;
      reader.trackHead = false;
      reader.set(buffer);
      const value = decodeValue(reader, false);
      if (reader.pos !== reader.bytes.length) {
        throw new RangeError(`Extra ${reader.bytes.length - reader.pos} byte(s) found at buffer[${reader.pos}]`);
      }
      return value;
    } finally {
      this.entered = false;
    }
  }

  *decodeMulti(buffer: Input): Generator<unknown, void, unknown> {
    if (this.entered) {
      yield* new Decoder(this.options).decodeMulti(buffer);
      return;
    }
    this.entered = true;
    try {
      const reader = this.reader;
      reader.settings = this.settings;
      reader.trackHead = false;
      reader.set(buffer);
      while (reader.pos < reader.bytes.length) {
        yield decodeValue(reader, false);
      }
    } finally {
      this.entered = false;
    }
  }

  async decodeAsync(stream: AsyncIterable<Input>): Promise<unknown> {
    if (this.entered) {
      return new Decoder(this.options).decodeAsync(stream);
    }
    this.entered = true;
    try {
      let message: Uint8Array = EMPTY_BYTES;
      let bufferStart = 0;
      let bufferLength = 0;
      let pos = 0;
      let totalPos = 0;
      let decoded = false;
      let object: unknown;
      let head = HEAD_BYTE_REQUIRED;

      for await (const chunk of stream) {
        if (decoded) {
          throw createExtraByteError(bufferLength, pos, totalPos);
        }

        const chunkBytes = toBytes(chunk);
        bufferStart = totalPos;
        bufferLength = bufferLength - pos + chunkBytes.length;
        pos = 0;
        message = concatBytes(message, chunkBytes);

        const reader = this.reader;
        reader.settings = this.settings;
        reader.trackHead = true;
        reader.set(message);
        try {
          object = decodeValue(reader, false);
          decoded = true;
          totalPos = reader.pos;
          pos = totalPos - bufferStart;
        } catch (error) {
          if (!(error instanceof RangeError)) {
            throw error;
          }
          head = reader.head;
          totalPos = reader.pos;
          pos = totalPos - bufferStart;
        }
      }

      if (decoded) {
        if (bufferLength - pos >= 1) {
          throw createExtraByteError(bufferLength, pos, totalPos);
        }
        return object;
      }

      throw new RangeError(
        `Insufficient data in parsing ${prettyByte(head)} at ${totalPos} (${pos} in the current buffer)`,
      );
    } finally {
      this.entered = false;
    }
  }

  decodeArrayStream(stream: AsyncIterable<Input>): AsyncGenerator<unknown, void, unknown> {
    return this.decodeMultiAsync(stream, true);
  }

  decodeStream(stream: AsyncIterable<Input>): AsyncGenerator<unknown, void, unknown> {
    return this.decodeMultiAsync(stream, false);
  }

  private async *decodeMultiAsync(
    stream: AsyncIterable<Input>,
    isArray: boolean,
  ): AsyncGenerator<unknown, void, unknown> {
    if (this.entered) {
      yield* new Decoder(this.options).decodeMultiAsync(stream, isArray);
      return;
    }
    this.entered = true;
    try {
      let isArrayHeaderRequired = isArray;
      let arrayItemsLeft = -1;

      let pending: Uint8Array = EMPTY_BYTES;
      let pendingStart = 0;
      let bufferStart = 0;
      let bufferLength = 0;
      let pos = 0;
      let totalPos = 0;

      for await (const chunk of stream) {
        if (isArray && arrayItemsLeft === 0) {
          throw createExtraByteError(bufferLength, pos, totalPos);
        }

        const chunkBytes = toBytes(chunk);
        bufferStart = totalPos;
        bufferLength = bufferLength - pos + chunkBytes.length;
        pos = 0;
        pending = concatBytes(pending, chunkBytes);

        const reader = this.reader;
        let offset = 0;

        if (isArrayHeaderRequired) {
          reader.settings = this.settings;
          reader.trackHead = true;
          reader.set(pending);
          arrayItemsLeft = readArraySize(reader);
          isArrayHeaderRequired = false;
          offset = reader.pos;
        }

        let consumed = pendingStart + offset;
        try {
          while (offset < pending.length) {
            reader.settings = this.settings;
            reader.trackHead = true;
            reader.set(pending);
            reader.pos = offset;
            const value = decodeValue(reader, false);
            offset = reader.pos;
            consumed = pendingStart + offset;
            yield value;
            if (--arrayItemsLeft === 0) {
              break;
            }
          }
        } catch (error) {
          if (!(error instanceof RangeError)) {
            throw error;
          }
          consumed = pendingStart + reader.pos;
        }

        if (offset > 0) {
          pending = pending.slice(offset);
          pendingStart += offset;
        }
        totalPos = consumed;
        pos = totalPos - bufferStart;
      }
    } finally {
      this.entered = false;
    }
  }
}

export function decode(buffer: Input, options?: DecoderOptions): unknown {
  const settings = resolveDecoderSettings(options);
  if (!sharedReaderEntered) {
    sharedReaderEntered = true;
    try {
      sharedReader.settings = settings;
      sharedReader.trackHead = false;
      sharedReader.set(buffer);
      const value = decodeValue(sharedReader, false);
      if (sharedReader.pos !== sharedReader.bytes.length) {
        throw new RangeError(
          `Extra ${sharedReader.bytes.length - sharedReader.pos} byte(s) found at buffer[${sharedReader.pos}]`,
        );
      }
      return value;
    } finally {
      sharedReaderEntered = false;
    }
  }
  return new Decoder(options).decode(buffer);
}

export function decodeMulti(buffer: Input, options?: DecoderOptions): Generator<unknown, void, unknown> {
  return new Decoder(options).decodeMulti(buffer);
}

export function decodeAsync(
  streamLike: ReadableStreamLike<Input>,
  options?: DecoderOptions,
): Promise<unknown> {
  return new Decoder(options).decodeAsync(ensureAsyncIterable(streamLike));
}

export function decodeArrayStream(
  streamLike: ReadableStreamLike<Input>,
  options?: DecoderOptions,
): AsyncGenerator<unknown, void, unknown> {
  return new Decoder(options).decodeArrayStream(ensureAsyncIterable(streamLike));
}

export function decodeMultiStream(
  streamLike: ReadableStreamLike<Input>,
  options?: DecoderOptions,
): AsyncGenerator<unknown, void, unknown> {
  return new Decoder(options).decodeStream(ensureAsyncIterable(streamLike));
}

function prettyByte(byte: number): string {
  return `${byte < 0 ? "-" : ""}0x${Math.abs(byte).toString(16).padStart(2, "0")}`;
}

function createExtraByteError(viewLength: number, pos: number, posToShow: number): RangeError {
  return new RangeError(`Extra ${viewLength - pos} of ${viewLength} byte(s) found at buffer[${posToShow}]`);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

function readArraySize(reader: Reader): number {
  const head = reader.view.getUint8(reader.pos);
  reader.pos++;
  reader.head = head;

  switch (head) {
    case 0xdc:
      return readU16(reader);
    case 0xdd:
      return readU32(reader);
    default:
      if (head < 0xa0) {
        return head - 0x90;
      }
      throw new DecodeError(`Unrecognized array type byte: ${prettyByte(head)}`);
  }
}

function readU16(reader: Reader): number {
  const value = reader.view.getUint16(reader.pos);
  reader.pos += 2;
  return value;
}

function readU32(reader: Reader): number {
  const value = reader.view.getUint32(reader.pos);
  reader.pos += 4;
  return value;
}

function decodeValue(reader: Reader, isMapKey: boolean): unknown {
  const head = reader.view.getUint8(reader.pos);
  reader.pos++;
  if (reader.trackHead) {
    reader.head = head;
  }

  if (head < 0x80) {
    return head;
  }
  if (head >= 0xe0) {
    return head - 0x100;
  }
  if (head < 0x90) {
    return decodeMap(reader, head - 0x80);
  }
  if (head < 0xa0) {
    return decodeArray(reader, head - 0x90);
  }
  if (head < 0xc0) {
    return decodeString(reader, head - 0xa0, isMapKey);
  }

  switch (head) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xca: {
      const value = reader.view.getFloat32(reader.pos);
      reader.pos += 4;
      return value;
    }
    case 0xcb: {
      const value = reader.view.getFloat64(reader.pos);
      reader.pos += 8;
      return value;
    }
    case 0xcc: {
      const value = reader.view.getUint8(reader.pos);
      reader.pos++;
      return value;
    }
    case 0xcd: {
      const value = reader.view.getUint16(reader.pos);
      reader.pos += 2;
      return value;
    }
    case 0xce: {
      const value = reader.view.getUint32(reader.pos);
      reader.pos += 4;
      return value;
    }
    case 0xcf: {
      if (reader.settings.useBigInt64) {
        const value = reader.view.getBigUint64(reader.pos);
        reader.pos += 8;
        return value;
      }
      const high = reader.view.getUint32(reader.pos);
      const low = reader.view.getUint32(reader.pos + 4);
      reader.pos += 8;
      return high * 0x100000000 + low;
    }
    case 0xd0: {
      const value = reader.view.getInt8(reader.pos);
      reader.pos += 1;
      return value;
    }
    case 0xd1: {
      const value = reader.view.getInt16(reader.pos);
      reader.pos += 2;
      return value;
    }
    case 0xd2: {
      const value = reader.view.getInt32(reader.pos);
      reader.pos += 4;
      return value;
    }
    case 0xd3: {
      if (reader.settings.useBigInt64) {
        const value = reader.view.getBigInt64(reader.pos);
        reader.pos += 8;
        return value;
      }
      const high = reader.view.getInt32(reader.pos);
      const low = reader.view.getUint32(reader.pos + 4);
      reader.pos += 8;
      return high * 0x100000000 + low;
    }
    case 0xd9: {
      const headerStart = reader.pos;
      const length = reader.view.getUint8(reader.pos);
      reader.pos++;
      return decodeString(reader, length, false, headerStart);
    }
    case 0xda: {
      const headerStart = reader.pos;
      const length = reader.view.getUint16(reader.pos);
      reader.pos += 2;
      return decodeString(reader, length, false, headerStart);
    }
    case 0xdb: {
      const headerStart = reader.pos;
      const length = reader.view.getUint32(reader.pos);
      reader.pos += 4;
      return decodeString(reader, length, false, headerStart);
    }
    case 0xdc: {
      const size = reader.view.getUint16(reader.pos);
      reader.pos += 2;
      return decodeArray(reader, size);
    }
    case 0xdd: {
      const size = reader.view.getUint32(reader.pos);
      reader.pos += 4;
      return decodeArray(reader, size);
    }
    case 0xde: {
      const size = reader.view.getUint16(reader.pos);
      reader.pos += 2;
      return decodeMap(reader, size);
    }
    case 0xdf: {
      const size = reader.view.getUint32(reader.pos);
      reader.pos += 4;
      return decodeMap(reader, size);
    }
    case 0xc4: {
      const headerStart = reader.pos;
      const size = reader.view.getUint8(reader.pos);
      reader.pos++;
      return decodeBinary(reader, size, headerStart);
    }
    case 0xc5: {
      const headerStart = reader.pos;
      const size = reader.view.getUint16(reader.pos);
      reader.pos += 2;
      return decodeBinary(reader, size, headerStart);
    }
    case 0xc6: {
      const headerStart = reader.pos;
      const size = reader.view.getUint32(reader.pos);
      reader.pos += 4;
      return decodeBinary(reader, size, headerStart);
    }
    case 0xd4:
      return decodeExtension(reader, 1);
    case 0xd5:
      return decodeExtension(reader, 2);
    case 0xd6:
      return decodeExtension(reader, 4);
    case 0xd7:
      return decodeExtension(reader, 8);
    case 0xd8:
      return decodeExtension(reader, 16);
    case 0xc7: {
      const headerStart = reader.pos;
      const size = reader.view.getUint8(reader.pos);
      reader.pos++;
      return decodeExtension(reader, size, headerStart);
    }
    case 0xc8: {
      const headerStart = reader.pos;
      const size = reader.view.getUint16(reader.pos);
      reader.pos += 2;
      return decodeExtension(reader, size, headerStart);
    }
    case 0xc9: {
      const headerStart = reader.pos;
      const size = reader.view.getUint32(reader.pos);
      reader.pos += 4;
      return decodeExtension(reader, size, headerStart);
    }
    default:
      throw new Error(`Unrecognized type byte: 0x${head.toString(16)}`);
  }
}

function decodeExtension(reader: Reader, size: number, headerStart = reader.pos): unknown {
  const settings = reader.settings;
  if (size > settings.maxExtLength) {
    throw new DecodeError(
      `Max length exceeded: ext length (${size}) > maxExtLength (${settings.maxExtLength})`,
    );
  }
  let type: number;
  try {
    type = reader.view.getInt8(reader.pos);
  } catch (error) {
    // The reference leaves pos at the header when the type byte is missing.
    if (error instanceof RangeError) {
      reader.pos = headerStart;
    }
    throw error;
  }
  const start = reader.pos + 1;
  // Extension payloads go through the same binary length limit as bin
  // values and raw strings in the reference implementation.
  if (size > settings.maxBinLength) {
    throw new DecodeError(
      `Max length exceeded: bin length (${size}) > maxBinLength (${settings.maxBinLength})`,
    );
  }
  if (size > reader.bytes.length - start) {
    reader.pos = headerStart;
    throw new RangeError("Insufficient data");
  }
  reader.pos = start + size;
  return settings.extensionCodec.decode(reader.bytes.subarray(start, start + size), type, settings.context);
}

function decodeString(
  reader: Reader,
  length: number,
  isMapKey: boolean,
  headerStart = reader.pos,
): string | Uint8Array {
  const settings = reader.settings;

  // Raw strings apply to values only; map keys remain JavaScript strings and
  // use maxStrLength rather than maxBinLength.
  if (settings.rawStrings && !isMapKey) {
    return decodeBinary(reader, length, headerStart);
  }

  if (length > settings.maxStrLength) {
    throw new DecodeError(
      `Max length exceeded: UTF-8 byte length (${length}) > maxStrLength (${settings.maxStrLength})`,
    );
  }
  if (length > reader.bytes.length - reader.pos) {
    reader.pos = headerStart;
    throw new RangeError("Insufficient data");
  }

  const start = reader.pos;
  reader.pos += length;

  if (isMapKey && settings.keyDecoder !== null && settings.keyDecoder.canBeCached(length)) {
    return settings.keyDecoder.decode(reader.bytes, start, length);
  }

  return readUtf8(reader.bytes, start, length);
}

function decodeBinary(reader: Reader, size: number, headerStart = reader.pos): Uint8Array {
  if (size > reader.settings.maxBinLength) {
    throw new DecodeError(
      `Max length exceeded: bin length (${size}) > maxBinLength (${reader.settings.maxBinLength})`,
    );
  }
  if (size > reader.bytes.length - reader.pos) {
    reader.pos = headerStart;
    throw new RangeError("Insufficient data");
  }
  const start = reader.pos;
  reader.pos += size;
  return reader.bytes.subarray(start, start + size);
}

function decodeArray(reader: Reader, size: number): unknown[] {
  if (size === 0) {
    if (reader.trackHead) {
      reader.head = HEAD_BYTE_REQUIRED;
    }
    return [];
  }
  if (size > reader.settings.maxArrayLength) {
    throw new DecodeError(
      `Max length exceeded: array length (${size}) > maxArrayLength (${reader.settings.maxArrayLength})`,
    );
  }
  if (reader.trackHead) {
    reader.head = HEAD_BYTE_REQUIRED;
  }
  const array = new Array(size);
  for (let i = 0; i < size; i++) {
    array[i] = decodeValue(reader, false);
    if (reader.trackHead) {
      reader.head = HEAD_BYTE_REQUIRED;
    }
  }
  return array;
}

function decodeMap(reader: Reader, size: number): Record<string, unknown> {
  if (size === 0) {
    if (reader.trackHead) {
      reader.head = HEAD_BYTE_REQUIRED;
    }
    return {};
  }
  if (size > reader.settings.maxMapLength) {
    // The reference message contains this spelling; keep it for parity.
    throw new DecodeError(
      `Max length exceeded: map length (${size}) > maxMapLengthLength (${reader.settings.maxMapLength})`,
    );
  }
  if (reader.trackHead) {
    reader.head = HEAD_BYTE_REQUIRED;
  }
  const map: Record<string, unknown> = {};
  for (let i = 0; i < size; i++) {
    const key = decodeValue(reader, true);
    if (reader.trackHead) {
      reader.head = HEAD_BYTE_REQUIRED;
    }
    if (key === "__proto__") {
      throw new Error("The key __proto__ is not allowed");
    }
    map[reader.settings.mapKeyConverter(key)] = decodeValue(reader, false);
    if (reader.trackHead) {
      reader.head = HEAD_BYTE_REQUIRED;
    }
  }
  return map;
}
