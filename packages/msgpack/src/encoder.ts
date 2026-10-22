import { Writer, DEFAULT_INITIAL_BUFFER_SIZE } from "./writer.ts";
import { asciiByteLength, sharedEncoder, utf8Count, writeAscii, writeUtf8Js } from "./utf8.ts";
import { ExtData, ExtensionCodec } from "./extension.ts";

// The reference implementation switches to TextEncoder above this many
// JavaScript string units. The threshold is observable for lone surrogates.
const TEXT_ENCODER_THRESHOLD = 50;

const DEFAULT_MAX_DEPTH = 100;

export interface EncoderOptions {
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

interface EncoderSettings {
  extensionCodec: ExtensionCodec;
  context: unknown;
  useBigInt64: boolean;
  maxDepth: number;
  sortKeys: boolean;
  forceFloat32: boolean;
  forceIntegerToFloat: boolean;
  ignoreUndefined: boolean;
}

const DEFAULT_ENCODER_SETTINGS: EncoderSettings = {
  extensionCodec: ExtensionCodec.defaultCodec,
  context: undefined,
  useBigInt64: false,
  maxDepth: DEFAULT_MAX_DEPTH,
  sortKeys: false,
  forceFloat32: false,
  forceIntegerToFloat: false,
  ignoreUndefined: false,
};

function resolveEncoderSettings(options?: EncoderOptions): EncoderSettings {
  if (options === undefined) {
    return DEFAULT_ENCODER_SETTINGS;
  }
  return {
    extensionCodec: options.extensionCodec ?? ExtensionCodec.defaultCodec,
    context: options.context,
    useBigInt64: options.useBigInt64 ?? false,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    sortKeys: options.sortKeys ?? false,
    forceFloat32: options.forceFloat32 ?? false,
    forceIntegerToFloat: options.forceIntegerToFloat ?? false,
    ignoreUndefined: options.ignoreUndefined ?? false,
  };
}

export class Encoder {
  private readonly writer: Writer;
  private readonly options: EncoderOptions | undefined;
  private readonly settings: EncoderSettings;
  private entered = false;

  constructor(options?: EncoderOptions) {
    this.options = options;
    this.settings = resolveEncoderSettings(options);
    this.writer = new Writer(options?.initialBufferSize ?? DEFAULT_INITIAL_BUFFER_SIZE);
  }

  /** Returns encoded bytes that are safe to keep across later encode calls. */
  encode(value: unknown): Uint8Array<ArrayBuffer> {
    if (this.entered) {
      return new Encoder(this.options).encode(value);
    }
    this.entered = true;
    try {
      this.writer.reset();
      encodeValue(this.writer, value, this.settings, 1);
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
      encodeValue(this.writer, value, this.settings, 1);
      return this.writer.ref();
    } finally {
      this.entered = false;
    }
  }
}

const sharedWriter = new Writer();
let sharedWriterEntered = false;

/**
 * Encodes a value into MessagePack bytes. The return value does not alias the
 * replacement's reusable internal buffer, so later calls cannot change it.
 */
export function encode(value: unknown, options?: EncoderOptions): Uint8Array<ArrayBuffer> {
  const settings = resolveEncoderSettings(options);
  if (!sharedWriterEntered) {
    sharedWriterEntered = true;
    try {
      sharedWriter.reset();
      if (options?.initialBufferSize !== undefined) {
        sharedWriter.ensure(options.initialBufferSize);
      }
      encodeValue(sharedWriter, value, settings, 1);
      return sharedWriter.copy();
    } finally {
      sharedWriterEntered = false;
    }
  }
  return new Encoder(options).encode(value);
}

function encodeValue(writer: Writer, value: unknown, settings: EncoderSettings, depth: number): void {
  if (depth > settings.maxDepth) {
    throw new Error(`Too deep objects in depth ${depth}`);
  }

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
      if (settings.forceIntegerToFloat) {
        encodeNumberAsFloat(writer, value, settings.forceFloat32);
      } else {
        encodeNumber(writer, value, settings);
      }
      return;
    case "string":
      encodeString(writer, value);
      return;
    case "bigint":
      if (settings.useBigInt64) {
        encodeBigInt64(writer, value);
        return;
      }
      break;
    case "object":
      encodeObject(writer, value, settings, depth);
      return;
  }

  // A registered extension may still claim a bigint, function, or symbol.
  const ext = settings.extensionCodec.tryToEncode(value, settings.context);
  if (ext !== null) {
    encodeExtension(writer, ext);
    return;
  }
  // Without a codec these are out of scope and rejected instead of being
  // silently written as something else.
  throw new Error(`Unrecognized object: ${Object.prototype.toString.apply(value)}`);
}

function encodeNumber(writer: Writer, value: number, settings: EncoderSettings): void {
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
      } else if (!settings.useBigInt64) {
        writer.ensure(9);
        writer.bytes[writer.pos] = 0xcf;
        writer.view.setUint32(writer.pos + 1, value / 0x100000000);
        writer.view.setUint32(writer.pos + 5, value);
        writer.pos += 9;
      } else {
        encodeNumberAsFloat(writer, value, settings.forceFloat32);
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
    } else if (!settings.useBigInt64) {
      writer.ensure(9);
      writer.bytes[writer.pos] = 0xd3;
      writer.view.setUint32(writer.pos + 1, Math.floor(value / 0x100000000));
      writer.view.setUint32(writer.pos + 5, value);
      writer.pos += 9;
    } else {
      encodeNumberAsFloat(writer, value, settings.forceFloat32);
    }
    return;
  }

  encodeNumberAsFloat(writer, value, settings.forceFloat32);
}

function encodeNumberAsFloat(writer: Writer, value: number, forceFloat32: boolean): void {
  writer.ensure(9);
  if (forceFloat32) {
    writer.bytes[writer.pos] = 0xca;
    writer.view.setFloat32(writer.pos + 1, value);
    writer.pos += 5;
    return;
  }
  writer.bytes[writer.pos] = 0xcb;
  writer.view.setFloat64(writer.pos + 1, value);
  writer.pos += 9;
}

function encodeBigInt64(writer: Writer, value: bigint): void {
  writer.ensure(9);
  if (value >= 0n) {
    writer.bytes[writer.pos] = 0xcf;
    writer.view.setBigUint64(writer.pos + 1, value);
  } else {
    writer.bytes[writer.pos] = 0xd3;
    writer.view.setBigInt64(writer.pos + 1, value);
  }
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
  // Short strings stay on the direct ASCII/JS paths. Longer strings are
  // encoded by TextEncoder in one pass; counting the length in JavaScript and
  // then writing separately would scan every code unit twice.
  if (value.length <= TEXT_ENCODER_THRESHOLD) {
    const asciiLength = asciiByteLength(value);
    if (asciiLength >= 0) {
      writer.ensure(5 + asciiLength);
      writeStringHeader(writer, asciiLength);
      writeAscii(value, writer.bytes, writer.pos);
      writer.pos += asciiLength;
      return;
    }

    const byteLength = utf8Count(value);
    writer.ensure(5 + byteLength);
    writeStringHeader(writer, byteLength);
    writeUtf8Js(value, writer.bytes, writer.pos);
    writer.pos += byteLength;
    return;
  }

  // One native encode pass beats counting UTF-8 length in JavaScript and
  // then making a second pass to write it. The encoded bytes are copied once
  // into the output buffer.
  const encoded = sharedEncoder.encode(value);
  const byteLength = encoded.length;
  writer.ensure(5 + byteLength);
  writeStringHeader(writer, byteLength);
  writer.bytes.set(encoded, writer.pos);
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

function encodeArray(
  writer: Writer,
  value: readonly unknown[],
  settings: EncoderSettings,
  depth: number,
): void {
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
    encodeValue(writer, value[i], settings, depth + 1);
  }
}

function encodeMap(writer: Writer, value: Record<string, unknown>, settings: EncoderSettings, depth: number): void {
  const keys = Object.keys(value);
  if (settings.sortKeys) {
    keys.sort();
  }

  let size = keys.length;
  if (settings.ignoreUndefined) {
    size = 0;
    for (let i = 0; i < keys.length; i++) {
      if (value[keys[i]] !== undefined) {
        size++;
      }
    }
  }

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

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const entry = value[key];

    if (!(settings.ignoreUndefined && entry === undefined)) {
      encodeString(writer, key);
      encodeValue(writer, entry, settings, depth + 1);
    }
  }
}

function encodeObject(writer: Writer, value: object, settings: EncoderSettings, depth: number): void {
  // Extensions take precedence over the built-in object handling, exactly as
  // in the reference implementation.
  const ext = settings.extensionCodec.tryToEncode(value, settings.context);
  if (ext !== null) {
    encodeExtension(writer, ext);
    return;
  }
  if (Array.isArray(value)) {
    encodeArray(writer, value, settings, depth);
  } else if (ArrayBuffer.isView(value)) {
    encodeBinary(writer, value);
  } else {
    encodeMap(writer, value as Record<string, unknown>, settings, depth);
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
