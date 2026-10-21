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

const STATE_ARRAY = 0;
const STATE_MAP_KEY = 1;
const STATE_MAP_VALUE = 2;

interface StackState {
  type: number;
  size: number;
  array: unknown[] | undefined;
  position: number;
  map: Record<string, unknown> | undefined;
  key: string | number | null;
  readCount: number;
}

class Reader {
  bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  view: DataView<ArrayBufferLike> = new DataView(new ArrayBuffer(0));
  pos = 0;
  head = HEAD_BYTE_REQUIRED;
  trackHead = false;
  settings: DecoderSettings = DEFAULT_DECODER_SETTINGS;
  readonly stack: StackState[] = [];
  stackLength = 0;

  set(input: Input): void {
    this.setBytes(toBytes(input));
    this.head = HEAD_BYTE_REQUIRED;
    this.stackLength = 0;
  }

  reset(): void {
    this.setBytes(EMPTY_BYTES);
    this.head = HEAD_BYTE_REQUIRED;
    this.stackLength = 0;
  }

  /** Appends a stream chunk, keeping only the bytes not yet consumed. */
  append(input: Input): void {
    const newBytes = toBytes(input);
    if (this.head === HEAD_BYTE_REQUIRED && this.bytes.length - this.pos < 1) {
      this.setBytes(newBytes);
      return;
    }
    const remaining = this.bytes.subarray(this.pos);
    const merged = new Uint8Array(remaining.length + newBytes.length);
    merged.set(remaining);
    merged.set(newBytes, remaining.length);
    this.setBytes(merged);
  }

  private setBytes(bytes: Uint8Array): void {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }
}

function toBytes(input: Input): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (
    input instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer)
  ) {
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
      const value = decodeValue(reader);
      if (reader.pos !== reader.bytes.length) {
        throw new RangeError(
          `Extra ${reader.bytes.length - reader.pos} of ${reader.bytes.length} byte(s) found at buffer[${reader.pos}]`,
        );
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
        yield decodeValue(reader);
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
      const reader = this.reader;
      reader.settings = this.settings;
      reader.trackHead = true;
      reader.reset();

      let decoded = false;
      let object: unknown;
      let totalPos = 0;

      for await (const chunk of stream) {
        if (decoded) {
          throw createExtraByteError(reader.bytes.length, reader.pos, totalPos);
        }

        reader.append(chunk);
        try {
          object = decodeValue(reader);
          decoded = true;
        } catch (error) {
          if (!(error instanceof RangeError)) {
            throw error;
          }
        }
        totalPos += reader.pos;
      }

      if (decoded) {
        if (reader.bytes.length - reader.pos >= 1) {
          throw createExtraByteError(reader.bytes.length, reader.pos, totalPos);
        }
        return object;
      }

      throw new RangeError(
        `Insufficient data in parsing ${prettyByte(reader.head)} at ${totalPos} (${reader.pos} in the current buffer)`,
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
      const reader = this.reader;
      reader.settings = this.settings;
      reader.trackHead = true;
      reader.reset();

      let isArrayHeaderRequired = isArray;
      let arrayItemsLeft = -1;
      let totalPos = 0;

      for await (const chunk of stream) {
        if (isArray && arrayItemsLeft === 0) {
          throw createExtraByteError(reader.bytes.length, reader.pos, totalPos);
        }

        reader.append(chunk);

        if (isArrayHeaderRequired) {
          arrayItemsLeft = readArraySize(reader);
          isArrayHeaderRequired = false;
          completeHead(reader);
        }

        try {
          while (true) {
            yield decodeValue(reader);
            if (--arrayItemsLeft === 0) {
              break;
            }
          }
        } catch (error) {
          if (!(error instanceof RangeError)) {
            throw error;
          }
        }
        totalPos += reader.pos;
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
      const value = decodeValue(sharedReader);
      if (sharedReader.pos !== sharedReader.bytes.length) {
        throw new RangeError(
          `Extra ${sharedReader.bytes.length - sharedReader.pos} of ${sharedReader.bytes.length} byte(s) found at buffer[${sharedReader.pos}]`,
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

function stateIsMapKey(reader: Reader): boolean {
  return reader.stackLength > 0 && reader.stack[reader.stackLength - 1].type === STATE_MAP_KEY;
}

function completeHead(reader: Reader): void {
  if (reader.trackHead) {
    reader.head = HEAD_BYTE_REQUIRED;
  }
}

function pushArrayState(reader: Reader, size: number): void {
  if (size > reader.settings.maxArrayLength) {
    throw new DecodeError(
      `Max length exceeded: array length (${size}) > maxArrayLength (${reader.settings.maxArrayLength})`,
    );
  }
  const depth = reader.stackLength++;
  let state = reader.stack[depth];
  if (state === undefined) {
    state = {
      type: STATE_ARRAY,
      size: 0,
      array: undefined,
      position: 0,
      map: undefined,
      key: null,
      readCount: 0,
    };
    reader.stack[depth] = state;
  }
  state.type = STATE_ARRAY;
  state.size = size;
  state.array = new Array(size);
  state.position = 0;
}

function pushMapState(reader: Reader, size: number): void {
  if (size > reader.settings.maxMapLength) {
    // The reference message contains this spelling; keep it for parity.
    throw new DecodeError(
      `Max length exceeded: map length (${size}) > maxMapLengthLength (${reader.settings.maxMapLength})`,
    );
  }
  const depth = reader.stackLength++;
  let state = reader.stack[depth];
  if (state === undefined) {
    state = {
      type: STATE_MAP_KEY,
      size: 0,
      array: undefined,
      position: 0,
      map: undefined,
      key: null,
      readCount: 0,
    };
    reader.stack[depth] = state;
  }
  state.type = STATE_MAP_KEY;
  state.size = size;
  state.map = {};
  state.key = null;
  state.readCount = 0;
}

/**
 * Decodes one complete message, iteratively. Container state lives on
 * `reader.stack`, so nesting depth is bounded by memory instead of by the
 * JavaScript call stack, exactly as in the reference implementation.
 */
function decodeValue(reader: Reader): unknown {
  const stack = reader.stack;

  DECODE: while (true) {
    let head: number;
    if (reader.head !== HEAD_BYTE_REQUIRED) {
      // Resume at the head byte of a value that was incomplete in the
      // previous chunk; its payload bytes are still in the buffer.
      head = reader.head;
    } else {
      head = reader.view.getUint8(reader.pos);
      reader.pos++;
      if (reader.trackHead) {
        reader.head = head;
      }
    }

    let object: unknown;

    if (head < 0x80) {
      object = head;
    } else if (head >= 0xe0) {
      object = head - 0x100;
    } else if (head < 0x90) {
      const size = head - 0x80;
      if (size !== 0) {
        pushMapState(reader, size);
        completeHead(reader);
        continue DECODE;
      }
      object = {};
    } else if (head < 0xa0) {
      const size = head - 0x90;
      if (size !== 0) {
        pushArrayState(reader, size);
        completeHead(reader);
        continue DECODE;
      }
      object = [];
    } else if (head < 0xc0) {
      object = decodeString(reader, head - 0xa0, stateIsMapKey(reader), 0);
    } else {
      switch (head) {
        case 0xc0:
          object = null;
          break;
        case 0xc2:
          object = false;
          break;
        case 0xc3:
          object = true;
          break;
        case 0xca: {
          const value = reader.view.getFloat32(reader.pos);
          reader.pos += 4;
          object = value;
          break;
        }
        case 0xcb: {
          const value = reader.view.getFloat64(reader.pos);
          reader.pos += 8;
          object = value;
          break;
        }
        case 0xcc: {
          const value = reader.view.getUint8(reader.pos);
          reader.pos++;
          object = value;
          break;
        }
        case 0xcd: {
          const value = reader.view.getUint16(reader.pos);
          reader.pos += 2;
          object = value;
          break;
        }
        case 0xce: {
          const value = reader.view.getUint32(reader.pos);
          reader.pos += 4;
          object = value;
          break;
        }
        case 0xcf: {
          if (reader.settings.useBigInt64) {
            const value = reader.view.getBigUint64(reader.pos);
            reader.pos += 8;
            object = value;
          } else {
            const high = reader.view.getUint32(reader.pos);
            const low = reader.view.getUint32(reader.pos + 4);
            reader.pos += 8;
            object = high * 0x100000000 + low;
          }
          break;
        }
        case 0xd0: {
          const value = reader.view.getInt8(reader.pos);
          reader.pos += 1;
          object = value;
          break;
        }
        case 0xd1: {
          const value = reader.view.getInt16(reader.pos);
          reader.pos += 2;
          object = value;
          break;
        }
        case 0xd2: {
          const value = reader.view.getInt32(reader.pos);
          reader.pos += 4;
          object = value;
          break;
        }
        case 0xd3: {
          if (reader.settings.useBigInt64) {
            const value = reader.view.getBigInt64(reader.pos);
            reader.pos += 8;
            object = value;
          } else {
            const high = reader.view.getInt32(reader.pos);
            const low = reader.view.getUint32(reader.pos + 4);
            reader.pos += 8;
            object = high * 0x100000000 + low;
          }
          break;
        }
        case 0xd9: {
          const length = reader.view.getUint8(reader.pos);
          object = decodeString(reader, length, stateIsMapKey(reader), 1);
          break;
        }
        case 0xda: {
          const length = reader.view.getUint16(reader.pos);
          object = decodeString(reader, length, stateIsMapKey(reader), 2);
          break;
        }
        case 0xdb: {
          const length = reader.view.getUint32(reader.pos);
          object = decodeString(reader, length, stateIsMapKey(reader), 4);
          break;
        }
        case 0xdc: {
          const size = readU16(reader);
          if (size !== 0) {
            pushArrayState(reader, size);
            completeHead(reader);
            continue DECODE;
          }
          object = [];
          break;
        }
        case 0xdd: {
          const size = readU32(reader);
          if (size !== 0) {
            pushArrayState(reader, size);
            completeHead(reader);
            continue DECODE;
          }
          object = [];
          break;
        }
        case 0xde: {
          const size = readU16(reader);
          if (size !== 0) {
            pushMapState(reader, size);
            completeHead(reader);
            continue DECODE;
          }
          object = {};
          break;
        }
        case 0xdf: {
          const size = readU32(reader);
          if (size !== 0) {
            pushMapState(reader, size);
            completeHead(reader);
            continue DECODE;
          }
          object = {};
          break;
        }
        case 0xc4: {
          const size = reader.view.getUint8(reader.pos);
          object = decodeBinary(reader, size, 1);
          break;
        }
        case 0xc5: {
          const size = reader.view.getUint16(reader.pos);
          object = decodeBinary(reader, size, 2);
          break;
        }
        case 0xc6: {
          const size = reader.view.getUint32(reader.pos);
          object = decodeBinary(reader, size, 4);
          break;
        }
        case 0xd4:
          object = decodeExtension(reader, 1, 0);
          break;
        case 0xd5:
          object = decodeExtension(reader, 2, 0);
          break;
        case 0xd6:
          object = decodeExtension(reader, 4, 0);
          break;
        case 0xd7:
          object = decodeExtension(reader, 8, 0);
          break;
        case 0xd8:
          object = decodeExtension(reader, 16, 0);
          break;
        case 0xc7: {
          const size = reader.view.getUint8(reader.pos);
          object = decodeExtension(reader, size, 1);
          break;
        }
        case 0xc8: {
          const size = reader.view.getUint16(reader.pos);
          object = decodeExtension(reader, size, 2);
          break;
        }
        case 0xc9: {
          const size = reader.view.getUint32(reader.pos);
          object = decodeExtension(reader, size, 4);
          break;
        }
        default:
          throw new DecodeError(`Unrecognized type byte: ${prettyByte(head)}`);
      }
    }

    completeHead(reader);

    while (reader.stackLength > 0) {
      const state = stack[reader.stackLength - 1];
      if (state.type === STATE_ARRAY) {
        const array = state.array!;
        array[state.position] = object;
        state.position++;
        if (state.position === state.size) {
          object = array;
          state.array = undefined;
          reader.stackLength--;
        } else {
          continue DECODE;
        }
      } else if (state.type === STATE_MAP_KEY) {
        if (object === "__proto__") {
          throw new DecodeError("The key __proto__ is not allowed");
        }
        state.key = reader.settings.mapKeyConverter(object);
        state.type = STATE_MAP_VALUE;
        continue DECODE;
      } else {
        const map = state.map!;
        map[state.key as string | number] = object;
        state.readCount++;
        if (state.readCount === state.size) {
          object = map;
          state.map = undefined;
          reader.stackLength--;
        } else {
          state.key = null;
          state.type = STATE_MAP_KEY;
          continue DECODE;
        }
      }
    }

    return object;
  }
}

function decodeExtension(reader: Reader, size: number, headerOffset: number): unknown {
  const settings = reader.settings;
  if (size > settings.maxExtLength) {
    throw new DecodeError(
      `Max length exceeded: ext length (${size}) > maxExtLength (${settings.maxExtLength})`,
    );
  }
  // The reference reads the type byte before applying the binary length
  // limit, so a truncated extension reports the same RangeError it would.
  const type = reader.view.getInt8(reader.pos + headerOffset);
  const data = decodeBinary(reader, size, headerOffset + 1);
  return settings.extensionCodec.decode(data, type, settings.context);
}

function decodeString(
  reader: Reader,
  length: number,
  isMapKey: boolean,
  headerOffset: number,
): string | Uint8Array {
  const settings = reader.settings;

  // Raw strings apply to values only; map keys remain JavaScript strings and
  // use maxStrLength rather than maxBinLength.
  if (settings.rawStrings && !isMapKey) {
    return decodeBinary(reader, length, headerOffset);
  }

  if (length > settings.maxStrLength) {
    throw new DecodeError(
      `Max length exceeded: UTF-8 byte length (${length}) > maxStrLength (${settings.maxStrLength})`,
    );
  }
  if (length > reader.bytes.length - reader.pos - headerOffset) {
    throw new RangeError("Insufficient data");
  }

  const start = reader.pos + headerOffset;
  reader.pos = start + length;

  if (isMapKey && settings.keyDecoder !== null && settings.keyDecoder.canBeCached(length)) {
    return settings.keyDecoder.decode(reader.bytes, start, length);
  }

  return readUtf8(reader.bytes, start, length);
}

function decodeBinary(reader: Reader, size: number, headerOffset: number): Uint8Array {
  if (size > reader.settings.maxBinLength) {
    throw new DecodeError(
      `Max length exceeded: bin length (${size}) > maxBinLength (${reader.settings.maxBinLength})`,
    );
  }
  if (size > reader.bytes.length - reader.pos - headerOffset) {
    throw new RangeError("Insufficient data");
  }
  const start = reader.pos + headerOffset;
  reader.pos = start + size;
  return reader.bytes.subarray(start, start + size);
}
