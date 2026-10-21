import { readUtf8 } from "./utf8.ts";

export interface DecoderOptions {
  [option: string]: unknown;
}

type Input = ArrayLike<number> | ArrayBufferView | ArrayBuffer | SharedArrayBuffer;

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

class Reader {
  bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  view: DataView<ArrayBufferLike> = new DataView(new ArrayBuffer(0));
  pos = 0;

  set(input: Input): void {
    const bytes = toBytes(input);
    this.bytes = bytes;
    if (this.view.buffer !== bytes.buffer ||
      this.view.byteOffset !== bytes.byteOffset ||
      this.view.byteLength !== bytes.byteLength) {
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
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
  if (input instanceof ArrayBuffer || input instanceof SharedArrayBuffer) {
    return new Uint8Array(input);
  }
  return Uint8Array.from(input as ArrayLike<number>);
}

const sharedReader = new Reader();
let sharedReaderEntered = false;

export class Decoder {
  private readonly reader = new Reader();
  private entered = false;

  constructor(_options?: DecoderOptions) {}

  decode(buffer: Input): unknown {
    if (this.entered) {
      return new Decoder().decode(buffer);
    }
    this.entered = true;
    try {
      const reader = this.reader;
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
}

export function decode(buffer: Input, _options?: DecoderOptions): unknown {
  if (!sharedReaderEntered) {
    sharedReaderEntered = true;
    try {
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
  return new Decoder().decode(buffer);
}

function decodeValue(reader: Reader, isMapKey: boolean): unknown {
  const bytes = reader.bytes;
  const head = bytes[reader.pos++];

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
    case 0xcc:
      return bytes[reader.pos++];
    case 0xcd: {
      const value = (bytes[reader.pos] << 8) | bytes[reader.pos + 1];
      reader.pos += 2;
      return value;
    }
    case 0xce: {
      const value = readU32(bytes, reader.pos);
      reader.pos += 4;
      return value;
    }
    case 0xcf: {
      const value = readU32(bytes, reader.pos) * 0x100000000 + readU32(bytes, reader.pos + 4);
      reader.pos += 8;
      return value;
    }
    case 0xd0: {
      const value = (bytes[reader.pos] << 24) >> 24;
      reader.pos += 1;
      return value;
    }
    case 0xd1: {
      const value = ((bytes[reader.pos] << 8) | bytes[reader.pos + 1]) << 16 >> 16;
      reader.pos += 2;
      return value;
    }
    case 0xd2: {
      const value = (bytes[reader.pos] << 24) |
        (bytes[reader.pos + 1] << 16) |
        (bytes[reader.pos + 2] << 8) |
        bytes[reader.pos + 3];
      reader.pos += 4;
      return value;
    }
    case 0xd3: {
      const high = (bytes[reader.pos] << 24) |
        (bytes[reader.pos + 1] << 16) |
        (bytes[reader.pos + 2] << 8) |
        bytes[reader.pos + 3];
      const low = readU32(bytes, reader.pos + 4);
      reader.pos += 8;
      return high * 0x100000000 + low;
    }
    case 0xd9: {
      const length = bytes[reader.pos++];
      return decodeString(reader, length, false);
    }
    case 0xda: {
      const length = (bytes[reader.pos] << 8) | bytes[reader.pos + 1];
      reader.pos += 2;
      return decodeString(reader, length, false);
    }
    case 0xdb: {
      const length = readU32(bytes, reader.pos);
      reader.pos += 4;
      return decodeString(reader, length, false);
    }
    case 0xdc: {
      const size = (bytes[reader.pos] << 8) | bytes[reader.pos + 1];
      reader.pos += 2;
      return decodeArray(reader, size);
    }
    case 0xdd: {
      const size = readU32(bytes, reader.pos);
      reader.pos += 4;
      return decodeArray(reader, size);
    }
    case 0xde: {
      const size = (bytes[reader.pos] << 8) | bytes[reader.pos + 1];
      reader.pos += 2;
      return decodeMap(reader, size);
    }
    case 0xdf: {
      const size = readU32(bytes, reader.pos);
      reader.pos += 4;
      return decodeMap(reader, size);
    }
    case 0xc4:
      return decodeBinary(reader, bytes[reader.pos++]);
    case 0xc5: {
      const size = (bytes[reader.pos] << 8) | bytes[reader.pos + 1];
      reader.pos += 2;
      return decodeBinary(reader, size);
    }
    case 0xc6: {
      const size = readU32(bytes, reader.pos);
      reader.pos += 4;
      return decodeBinary(reader, size);
    }
    default:
      throw new Error(`Unrecognized type byte: 0x${head.toString(16)}`);
  }
}

function readU32(bytes: Uint8Array, pos: number): number {
  return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
}

function decodeString(reader: Reader, length: number, isMapKey: boolean): string {
  const start = reader.pos;
  reader.pos += length;

  if (isMapKey && length > 0 && length <= KEY_MAX_LENGTH) {
    const cached = lookupKey(reader.bytes, start, length);
    if (cached !== null) {
      return cached;
    }
    const value = readUtf8(reader.bytes, start, length);
    storeKey(reader.bytes, start, length, value);
    return value;
  }

  return readUtf8(reader.bytes, start, length);
}

function decodeBinary(reader: Reader, size: number): Uint8Array {
  const start = reader.pos;
  reader.pos += size;
  return reader.bytes.subarray(start, start + size);
}

function decodeArray(reader: Reader, size: number): unknown[] {
  if (size === 0) {
    return [];
  }
  const array = new Array(size);
  for (let i = 0; i < size; i++) {
    array[i] = decodeValue(reader, false);
  }
  return array;
}

function decodeMap(reader: Reader, size: number): Record<string, unknown> {
  if (size === 0) {
    return {};
  }
  const map: Record<string, unknown> = {};
  for (let i = 0; i < size; i++) {
    const key = decodeValue(reader, true);
    if (typeof key !== "string" && typeof key !== "number") {
      throw new Error(`The type of key must be string or number but ${typeof key}`);
    }
    if (key === "__proto__") {
      throw new Error("The key __proto__ is not allowed");
    }
    map[key] = decodeValue(reader, false);
  }
  return map;
}
