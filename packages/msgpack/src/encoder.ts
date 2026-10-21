import { Writer, DEFAULT_INITIAL_BUFFER_SIZE } from "./writer.ts";
import { asciiByteLength, utf8Count, writeAscii, writeUtf8Js, writeUtf8TextEncoder } from "./utf8.ts";
import { ExtData, ExtensionCodec } from "./extension.ts";

// The reference implementation switches to TextEncoder above this many
// JavaScript string units. The threshold is observable for lone surrogates.
const TEXT_ENCODER_THRESHOLD = 50;

export interface EncoderOptions {
  initialBufferSize?: number;
  extensionCodec?: ExtensionCodec;
  context?: unknown;
  [option: string]: unknown;
}

export class Encoder {
  private readonly writer: Writer;
  private readonly options: EncoderOptions | undefined;
  private readonly extensionCodec: ExtensionCodec;
  private readonly context: unknown;
  private entered = false;

  constructor(options?: EncoderOptions) {
    this.options = options;
    this.extensionCodec = options?.extensionCodec ?? ExtensionCodec.defaultCodec;
    this.context = options?.context;
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
      encodeValue(this.writer, value, this.extensionCodec, this.context);
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
      encodeValue(this.writer, value, this.extensionCodec, this.context);
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
      encodeValue(
        sharedWriter,
        value,
        options?.extensionCodec ?? ExtensionCodec.defaultCodec,
        options?.context,
      );
      return sharedWriter.copy();
    } finally {
      sharedWriterEntered = false;
    }
  }
  return new Encoder(options).encode(value);
}

function encodeValue(writer: Writer, value: unknown, codec: ExtensionCodec, context: unknown): void {
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
      encodeObject(writer, value, codec, context);
      return;
    default: {
      // A registered extension may still claim a bigint, function, or symbol.
      const ext = codec.tryToEncode(value, context);
      if (ext !== null) {
        encodeExtension(writer, ext);
        return;
      }
      // Without a codec these are out of scope and rejected instead of being
      // silently written as something else.
      throw new Error(`Unrecognized object: ${Object.prototype.toString.apply(value)}`);
    }
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

function encodeArray(writer: Writer, value: readonly unknown[], codec: ExtensionCodec, context: unknown): void {
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
    encodeValue(writer, value[i], codec, context);
  }
}

function encodeMap(
  writer: Writer,
  value: Record<string, unknown>,
  codec: ExtensionCodec,
  context: unknown,
): void {
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
    encodeValue(writer, value[key], codec, context);
  }
}

function encodeObject(writer: Writer, value: object, codec: ExtensionCodec, context: unknown): void {
  // Extensions take precedence over the built-in object handling, exactly as
  // in the reference implementation.
  const ext = codec.tryToEncode(value, context);
  if (ext !== null) {
    encodeExtension(writer, ext);
    return;
  }
  if (Array.isArray(value)) {
    encodeArray(writer, value, codec, context);
  } else if (ArrayBuffer.isView(value)) {
    encodeBinary(writer, value);
  } else {
    encodeMap(writer, value as Record<string, unknown>, codec, context);
  }
}

function encodeExtension(writer: Writer, ext: ExtData): void {
  if (typeof ext.data === "function") {
    const data = ext.data(writer.pos + 6);
    const size = data.length;
    if (size >= 0x100000000) {
      throw new Error(`Too large extension object: ${size}`);
    }
    writer.ensure(6 + size);
    const pos = writer.pos;
    writer.bytes[pos] = 0xc9;
    writer.view.setUint32(pos + 1, size);
    writer.view.setInt8(pos + 5, ext.type);
    writer.bytes.set(data, pos + 6);
    writer.pos = pos + 6 + size;
    return;
  }

  const size = ext.data.length;
  let head: number;
  let headerSize: number;
  if (size === 1) {
    head = 0xd4; // fixext 1
    headerSize = 1;
  } else if (size === 2) {
    head = 0xd5; // fixext 2
    headerSize = 1;
  } else if (size === 4) {
    head = 0xd6; // fixext 4
    headerSize = 1;
  } else if (size === 8) {
    head = 0xd7; // fixext 8
    headerSize = 1;
  } else if (size === 16) {
    head = 0xd8; // fixext 16
    headerSize = 1;
  } else if (size < 0x100) {
    head = 0xc7; // ext 8
    headerSize = 2;
  } else if (size < 0x10000) {
    head = 0xc8; // ext 16
    headerSize = 3;
  } else if (size < 0x100000000) {
    head = 0xc9; // ext 32
    headerSize = 5;
  } else {
    throw new Error(`Too large extension object: ${size}`);
  }

  writer.ensure(headerSize + 1 + size);
  const pos = writer.pos;
  const bytes = writer.bytes;
  bytes[pos] = head;
  if (headerSize === 2) {
    bytes[pos + 1] = size;
  } else if (headerSize === 3) {
    writer.view.setUint16(pos + 1, size);
  } else if (headerSize === 5) {
    writer.view.setUint32(pos + 1, size);
  }
  writer.view.setInt8(pos + headerSize, ext.type);
  bytes.set(ext.data, pos + headerSize + 1);
  writer.pos = pos + headerSize + 1 + size;
}
