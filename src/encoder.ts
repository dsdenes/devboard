import { Writer, DEFAULT_INITIAL_BUFFER_SIZE } from "./writer.ts";
import { asciiByteLength, utf8Count, writeAscii, writeUtf8Js, writeUtf8TextEncoder } from "./utf8.ts";

// The reference implementation switches to TextEncoder above this many
// JavaScript string units. The threshold is observable for lone surrogates.
const TEXT_ENCODER_THRESHOLD = 50;

export interface EncoderOptions {
  initialBufferSize?: number;
  [option: string]: unknown;
}

export class Encoder {
  private readonly writer: Writer;
  private readonly options: EncoderOptions | undefined;
  private entered = false;

  constructor(options?: EncoderOptions) {
    this.options = options;
    this.writer = new Writer(options?.initialBufferSize ?? DEFAULT_INITIAL_BUFFER_SIZE);
  }

  /** Returns a copy of the encoded bytes. */
  encode(value: unknown): Uint8Array<ArrayBuffer> {
    if (this.entered) {
      return new Encoder(this.options).encode(value);
    }
    this.entered = true;
    try {
      this.writer.reset();
      encodeValue(this.writer, value);
      return this.writer.copy();
    } finally {
      this.entered = false;
    }
  }

  /** Returns an internal-buffer view, valid until the next encode call. */
  encodeSharedRef(value: unknown): Uint8Array<ArrayBuffer> {
    if (this.entered) {
      return new Encoder(this.options).encodeSharedRef(value);
    }
    this.entered = true;
    try {
      this.writer.reset();
      encodeValue(this.writer, value);
      return this.writer.ref();
    } finally {
      this.entered = false;
    }
  }
}

const sharedWriter = new Writer();
let sharedWriterEntered = false;

/**
 * Encodes a value into MessagePack bytes. The return value is a copy, so it
 * does not alias the replacement's reusable internal buffer.
 */
export function encode(value: unknown, options?: EncoderOptions): Uint8Array<ArrayBuffer> {
  if (!sharedWriterEntered) {
    sharedWriterEntered = true;
    try {
      sharedWriter.reset();
      if (options?.initialBufferSize !== undefined) {
        sharedWriter.ensure(options.initialBufferSize);
      }
      encodeValue(sharedWriter, value);
      return sharedWriter.copy();
    } finally {
      sharedWriterEntered = false;
    }
  }
  return new Encoder(options).encode(value);
}

function encodeValue(writer: Writer, value: unknown): void {
  if (value === null || value === undefined) {
    writer.ensure(1);
    writer.bytes[writer.pos++] = 0xc0;
    return;
  }

  switch (typeof value) {
    case "boolean":
      writer.ensure(1);
      writer.bytes[writer.pos++] = value ? 0xc3 : 0xc2;
      return;
    case "number":
      encodeNumber(writer, value);
      return;
    case "string":
      encodeString(writer, value);
      return;
    case "object":
      encodeObject(writer, value);
      return;
    default:
      // Symbols, functions, and bigints are out of scope and rejected instead
      // of being silently written as something else.
      throw new Error(`Unrecognized object: ${Object.prototype.toString.apply(value)}`);
  }
}

function encodeNumber(writer: Writer, value: number): void {
  if (Number.isSafeInteger(value)) {
    if (value >= 0) {
      if (value < 0x80) {
        writer.ensure(1);
        writer.bytes[writer.pos++] = value;
      } else if (value < 0x100) {
        writer.ensure(2);
        writer.bytes[writer.pos] = 0xcc;
        writer.bytes[writer.pos + 1] = value;
        writer.pos += 2;
      } else if (value < 0x10000) {
        writer.ensure(3);
        writer.bytes[writer.pos] = 0xcd;
        writer.view.setUint16(writer.pos + 1, value);
        writer.pos += 3;
      } else if (value < 0x100000000) {
        writer.ensure(5);
        writer.bytes[writer.pos] = 0xce;
        writer.view.setUint32(writer.pos + 1, value);
        writer.pos += 5;
      } else {
        writer.ensure(9);
        writer.bytes[writer.pos] = 0xcf;
        writer.view.setUint32(writer.pos + 1, value / 0x100000000);
        writer.view.setUint32(writer.pos + 5, value);
        writer.pos += 9;
      }
    } else if (value >= -0x20) {
      writer.ensure(1);
      writer.bytes[writer.pos++] = (value + 0x100) & 0xff;
    } else if (value >= -0x80) {
      writer.ensure(2);
      writer.bytes[writer.pos] = 0xd0;
      writer.bytes[writer.pos + 1] = value;
      writer.pos += 2;
    } else if (value >= -0x8000) {
      writer.ensure(3);
      writer.bytes[writer.pos] = 0xd1;
      writer.view.setInt16(writer.pos + 1, value);
      writer.pos += 3;
    } else if (value >= -0x80000000) {
      writer.ensure(5);
      writer.bytes[writer.pos] = 0xd2;
      writer.view.setInt32(writer.pos + 1, value);
      writer.pos += 5;
    } else {
      writer.ensure(9);
      writer.bytes[writer.pos] = 0xd3;
      writer.view.setUint32(writer.pos + 1, Math.floor(value / 0x100000000));
      writer.view.setUint32(writer.pos + 5, value);
      writer.pos += 9;
    }
    return;
  }

  writer.ensure(9);
  writer.bytes[writer.pos] = 0xcb;
  writer.view.setFloat64(writer.pos + 1, value);
  writer.pos += 9;
}

function writeStringHeader(writer: Writer, byteLength: number): void {
  const bytes = writer.bytes;
  if (byteLength < 0x20) {
    bytes[writer.pos++] = 0xa0 + byteLength;
  } else if (byteLength < 0x100) {
    writer.ensure(2);
    bytes[writer.pos] = 0xd9;
    bytes[writer.pos + 1] = byteLength;
    writer.pos += 2;
  } else if (byteLength < 0x10000) {
    writer.ensure(3);
    bytes[writer.pos] = 0xda;
    writer.view.setUint16(writer.pos + 1, byteLength);
    writer.pos += 3;
  } else {
    writer.ensure(5);
    bytes[writer.pos] = 0xdb;
    writer.view.setUint32(writer.pos + 1, byteLength);
    writer.pos += 5;
  }
}

function encodeString(writer: Writer, value: string): void {
  const asciiLength = asciiByteLength(value);
  if (asciiLength >= 0) {
    writer.ensure(5 + asciiLength);
    writeStringHeader(writer, asciiLength);
    if (asciiLength > 256) {
      writeUtf8TextEncoder(value, writer.bytes, writer.pos);
    } else {
      writeAscii(value, writer.bytes, writer.pos);
    }
    writer.pos += asciiLength;
    return;
  }

  const byteLength = utf8Count(value);
  writer.ensure(5 + byteLength);
  writeStringHeader(writer, byteLength);
  if (value.length > TEXT_ENCODER_THRESHOLD) {
    writeUtf8TextEncoder(value, writer.bytes, writer.pos);
  } else {
    writeUtf8Js(value, writer.bytes, writer.pos);
  }
  writer.pos += byteLength;
}

function encodeBinary(writer: Writer, value: ArrayBufferView): void {
  const size = value.byteLength;

  if (size < 0x100) {
    writer.ensure(2 + size);
    writer.bytes[writer.pos] = 0xc4;
    writer.bytes[writer.pos + 1] = size;
    writer.pos += 2;
  } else if (size < 0x10000) {
    writer.ensure(3 + size);
    writer.bytes[writer.pos] = 0xc5;
    writer.view.setUint16(writer.pos + 1, size);
    writer.pos += 3;
  } else {
    writer.ensure(5 + size);
    writer.bytes[writer.pos] = 0xc6;
    writer.view.setUint32(writer.pos + 1, size);
    writer.pos += 5;
  }

  if (value instanceof Uint8Array && value.buffer === writer.bytes.buffer) {
    // A caller could pass a view of the output buffer. Copy through a
    // temporary to preserve the input, though this is not a normal payload.
    writer.bytes.set(new Uint8Array(value), writer.pos);
  } else {
    writer.bytes.set(
      value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      writer.pos,
    );
  }
  writer.pos += size;
}

function encodeArray(writer: Writer, value: readonly unknown[]): void {
  const size = value.length;

  if (size < 0x10) {
    writer.ensure(1);
    writer.bytes[writer.pos++] = 0x90 + size;
  } else if (size < 0x10000) {
    writer.ensure(3);
    writer.bytes[writer.pos] = 0xdc;
    writer.view.setUint16(writer.pos + 1, size);
    writer.pos += 3;
  } else {
    writer.ensure(5);
    writer.bytes[writer.pos] = 0xdd;
    writer.view.setUint32(writer.pos + 1, size);
    writer.pos += 5;
  }

  for (let i = 0; i < size; i++) {
    encodeValue(writer, value[i]);
  }
}

function encodeMap(writer: Writer, value: Record<string, unknown>): void {
  const keys = Object.keys(value);
  const size = keys.length;

  if (size < 0x10) {
    writer.ensure(1);
    writer.bytes[writer.pos++] = 0x80 + size;
  } else if (size < 0x10000) {
    writer.ensure(3);
    writer.bytes[writer.pos] = 0xde;
    writer.view.setUint16(writer.pos + 1, size);
    writer.pos += 3;
  } else {
    writer.ensure(5);
    writer.bytes[writer.pos] = 0xdf;
    writer.view.setUint32(writer.pos + 1, size);
    writer.pos += 5;
  }

  for (let i = 0; i < size; i++) {
    const key = keys[i];
    encodeString(writer, key);
    encodeValue(writer, value[key]);
  }
}

function encodeObject(writer: Writer, value: object): void {
  if (Array.isArray(value)) {
    encodeArray(writer, value);
  } else if (ArrayBuffer.isView(value)) {
    encodeBinary(writer, value);
  } else {
    encodeMap(writer, value as Record<string, unknown>);
  }
}
