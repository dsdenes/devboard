var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// packages/msgpack/src/index.ts
var exports_src = {};
__export(exports_src, {
  DEFAULT_INITIAL_BUFFER_SIZE: () => DEFAULT_INITIAL_BUFFER_SIZE,
  DecodeError: () => DecodeError,
  Decoder: () => Decoder,
  EXT_TIMESTAMP: () => EXT_TIMESTAMP,
  Encoder: () => Encoder,
  ExtData: () => ExtData,
  ExtensionCodec: () => ExtensionCodec,
  decode: () => decode,
  decodeArrayStream: () => decodeArrayStream,
  decodeAsync: () => decodeAsync,
  decodeMulti: () => decodeMulti,
  decodeMultiStream: () => decodeMultiStream,
  decodeTimestampExtension: () => decodeTimestampExtension,
  decodeTimestampToTimeSpec: () => decodeTimestampToTimeSpec,
  default: () => src_default,
  encode: () => encode,
  encodeDateToTimeSpec: () => encodeDateToTimeSpec,
  encodeTimeSpecToTimestamp: () => encodeTimeSpecToTimestamp,
  encodeTimestampExtension: () => encodeTimestampExtension,
  timestampExtension: () => timestampExtension
});
module.exports = __toCommonJS(exports_src);

// packages/msgpack/src/writer.ts
var DEFAULT_INITIAL_BUFFER_SIZE = 2048;

class Writer {
  bytes;
  view;
  pos = 0;
  constructor(size = DEFAULT_INITIAL_BUFFER_SIZE) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  reset() {
    this.pos = 0;
  }
  ensure(extra) {
    const required = this.pos + extra;
    if (required > this.bytes.length) {
      this.grow(required);
    }
  }
  grow(required) {
    let capacity = this.bytes.length || DEFAULT_INITIAL_BUFFER_SIZE;
    const doubled = capacity * 2;
    capacity = doubled >= required ? doubled : required * 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes.subarray(0, this.pos));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
  copy() {
    return this.bytes.slice(0, this.pos);
  }
  ref() {
    return this.bytes.subarray(0, this.pos);
  }
}

// packages/msgpack/src/utf8.ts
var sharedEncoder = new TextEncoder;
var sharedDecoder = new TextDecoder;
function utf8Count(str) {
  const length = str.length;
  let bytes = 0;
  let i = 0;
  while (i < length) {
    let value = str.charCodeAt(i++);
    if ((value & 4294967168) === 0) {
      bytes += 1;
    } else if ((value & 4294965248) === 0) {
      bytes += 2;
    } else {
      if (value >= 55296 && value <= 56319 && i < length) {
        const extra = str.charCodeAt(i);
        if ((extra & 64512) === 56320) {
          i++;
          value = ((value & 1023) << 10) + (extra & 1023) + 65536;
        }
      }
      bytes += (value & 4294901760) === 0 ? 3 : 4;
    }
  }
  return bytes;
}
function asciiByteLength(str) {
  const length = str.length;
  for (let i = 0;i < length; i++) {
    if (str.charCodeAt(i) > 127) {
      return -1;
    }
  }
  return length;
}
function writeAscii(str, output, offset) {
  const length = str.length;
  for (let i = 0;i < length; i++) {
    output[offset + i] = str.charCodeAt(i);
  }
}
function writeUtf8Js(str, output, offset) {
  const length = str.length;
  let pos = 0;
  while (pos < length) {
    let value = str.charCodeAt(pos++);
    if ((value & 4294967168) === 0) {
      output[offset++] = value;
      continue;
    }
    if ((value & 4294965248) === 0) {
      output[offset++] = value >> 6 & 31 | 192;
    } else {
      if (value >= 55296 && value <= 56319 && pos < length) {
        const extra = str.charCodeAt(pos);
        if ((extra & 64512) === 56320) {
          pos++;
          value = ((value & 1023) << 10) + (extra & 1023) + 65536;
        }
      }
      if ((value & 4294901760) === 0) {
        output[offset++] = value >> 12 & 15 | 224;
        output[offset++] = value >> 6 & 63 | 128;
      } else {
        output[offset++] = value >> 18 & 7 | 240;
        output[offset++] = value >> 12 & 63 | 128;
        output[offset++] = value >> 6 & 63 | 128;
      }
    }
    output[offset++] = value & 63 | 128;
  }
}
var ASCII_CHUNK = 4096;
var TEXT_DECODER_THRESHOLD = 200;
function readUtf8Js(bytes, start, end) {
  let offset = start;
  const units = [];
  let result = "";
  while (offset < end) {
    const byte1 = bytes[offset++];
    if ((byte1 & 128) === 0) {
      units.push(byte1);
    } else if ((byte1 & 224) === 192) {
      const byte2 = bytes[offset++] & 63;
      units.push((byte1 & 31) << 6 | byte2);
    } else if ((byte1 & 240) === 224) {
      const byte2 = bytes[offset++] & 63;
      const byte3 = bytes[offset++] & 63;
      units.push((byte1 & 31) << 12 | byte2 << 6 | byte3);
    } else if ((byte1 & 248) === 240) {
      const byte2 = bytes[offset++] & 63;
      const byte3 = bytes[offset++] & 63;
      const byte4 = bytes[offset++] & 63;
      let unit = (byte1 & 7) << 18 | byte2 << 12 | byte3 << 6 | byte4;
      if (unit > 65535) {
        unit -= 65536;
        units.push(unit >>> 10 & 1023 | 55296);
        unit = 56320 | unit & 1023;
      }
      units.push(unit);
    } else {
      units.push(byte1);
    }
    if (units.length >= ASCII_CHUNK) {
      result += String.fromCharCode.apply(null, units);
      units.length = 0;
    }
  }
  if (units.length > 0) {
    result += String.fromCharCode.apply(null, units);
  }
  return result;
}
function readUtf8(bytes, start, length) {
  if (length === 0) {
    return "";
  }
  const end = start + length;
  if (length > TEXT_DECODER_THRESHOLD) {
    return sharedDecoder.decode(bytes.subarray(start, end));
  }
  let ascii = true;
  for (let i = start;i < end; i++) {
    if (bytes[i] > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    if (length <= 8) {
      let result = "";
      for (let i = start;i < end; i++) {
        result += String.fromCharCode(bytes[i]);
      }
      return result;
    }
    return sharedDecoder.decode(bytes.subarray(start, end));
  }
  return readUtf8Js(bytes, start, end);
}

// packages/msgpack/src/decode-error.ts
class DecodeError extends Error {
  constructor(message) {
    super(message);
    Object.setPrototypeOf(this, DecodeError.prototype);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: DecodeError.name
    });
  }
}

// packages/msgpack/src/timestamp.ts
var EXT_TIMESTAMP = -1;
var TIMESTAMP32_MAX_SEC = 4294967296 - 1;
var TIMESTAMP64_MAX_SEC = 17179869184 - 1;
function setInt64(view, offset, value) {
  view.setUint32(offset, Math.floor(value / 4294967296));
  view.setUint32(offset + 4, value);
}
function getInt64(view, offset) {
  const high = view.getInt32(offset);
  const low = view.getUint32(offset + 4);
  return high * 4294967296 + low;
}
function encodeTimeSpecToTimestamp({ sec, nsec }) {
  if (sec >= 0 && nsec >= 0 && sec <= TIMESTAMP64_MAX_SEC) {
    if (nsec === 0 && sec <= TIMESTAMP32_MAX_SEC) {
      const rv = new Uint8Array(4);
      const view = new DataView(rv.buffer);
      view.setUint32(0, sec);
      return rv;
    }
    const secHigh = sec / 4294967296;
    const secLow = sec & 4294967295;
    const rv = new Uint8Array(8);
    const view = new DataView(rv.buffer);
    view.setUint32(0, nsec << 2 | secHigh & 3);
    view.setUint32(4, secLow);
    return rv;
  }
  const rv = new Uint8Array(12);
  const view = new DataView(rv.buffer);
  view.setUint32(0, nsec);
  setInt64(view, 4, sec);
  return rv;
}
function encodeDateToTimeSpec(date) {
  const msec = date.getTime();
  const sec = Math.floor(msec / 1000);
  const nsec = (msec - sec * 1000) * 1e6;
  const nsecInSec = Math.floor(nsec / 1e9);
  return {
    sec: sec + nsecInSec,
    nsec: nsec - nsecInSec * 1e9
  };
}
function encodeTimestampExtension(object) {
  if (object instanceof Date) {
    const timeSpec = encodeDateToTimeSpec(object);
    return encodeTimeSpecToTimestamp(timeSpec);
  }
  return null;
}
function decodeTimestampToTimeSpec(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (data.byteLength) {
    case 4: {
      const sec = view.getUint32(0);
      return { sec, nsec: 0 };
    }
    case 8: {
      const nsec30AndSecHigh2 = view.getUint32(0);
      const secLow32 = view.getUint32(4);
      const sec = (nsec30AndSecHigh2 & 3) * 4294967296 + secLow32;
      const nsec = nsec30AndSecHigh2 >>> 2;
      return { sec, nsec };
    }
    case 12: {
      return { sec: getInt64(view, 4), nsec: view.getUint32(0) };
    }
    default:
      throw new DecodeError(`Unrecognized data size for timestamp (expected 4, 8, or 12): ${data.length}`);
  }
}
function decodeTimestampExtension(data) {
  const timeSpec = decodeTimestampToTimeSpec(data);
  return new Date(timeSpec.sec * 1000 + timeSpec.nsec / 1e6);
}
var timestampExtension = {
  type: EXT_TIMESTAMP,
  encode: encodeTimestampExtension,
  decode: decodeTimestampExtension
};

// packages/msgpack/src/extension.ts
class ExtData {
  type;
  data;
  constructor(type, data) {
    this.type = type;
    this.data = data;
  }
}

class ExtensionCodec {
  static defaultCodec = new ExtensionCodec;
  builtInEncoders = [];
  builtInDecoders = [];
  encoders = [];
  decoders = [];
  constructor() {
    this.register(timestampExtension);
  }
  register({ type, encode, decode }) {
    if (type >= 0) {
      this.encoders[type] = encode;
      this.decoders[type] = decode;
    } else {
      const index = -1 - type;
      this.builtInEncoders[index] = encode;
      this.builtInDecoders[index] = decode;
    }
  }
  tryToEncode(object, context) {
    for (let i = 0;i < this.builtInEncoders.length; i++) {
      const encodeExt = this.builtInEncoders[i];
      if (encodeExt != null) {
        const data = encodeExt(object, context);
        if (data != null) {
          return new ExtData(-1 - i, data);
        }
      }
    }
    for (let i = 0;i < this.encoders.length; i++) {
      const encodeExt = this.encoders[i];
      if (encodeExt != null) {
        const data = encodeExt(object, context);
        if (data != null) {
          return new ExtData(i, data);
        }
      }
    }
    if (object instanceof ExtData) {
      return object;
    }
    return null;
  }
  decode(data, type, context) {
    const decodeExt = type < 0 ? this.builtInDecoders[-1 - type] : this.decoders[type];
    if (decodeExt) {
      return decodeExt(data, type, context);
    }
    return new ExtData(type, data);
  }
}

// packages/msgpack/src/encoder.ts
var TEXT_ENCODER_THRESHOLD = 50;
var DEFAULT_MAX_DEPTH = 100;
var DEFAULT_ENCODER_SETTINGS = {
  extensionCodec: ExtensionCodec.defaultCodec,
  context: undefined,
  useBigInt64: false,
  maxDepth: DEFAULT_MAX_DEPTH,
  sortKeys: false,
  forceFloat32: false,
  forceIntegerToFloat: false,
  ignoreUndefined: false
};
function resolveEncoderSettings(options) {
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
    ignoreUndefined: options.ignoreUndefined ?? false
  };
}

class Encoder {
  writer;
  options;
  settings;
  entered = false;
  constructor(options) {
    this.options = options;
    this.settings = resolveEncoderSettings(options);
    this.writer = new Writer(options?.initialBufferSize ?? DEFAULT_INITIAL_BUFFER_SIZE);
  }
  encode(value) {
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
  encodeSharedRef(value) {
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
var sharedWriter = new Writer;
var sharedWriterEntered = false;
function encode(value, options) {
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
function encodeValue(writer, value, settings, depth) {
  if (depth > settings.maxDepth) {
    throw new Error(`Too deep objects in depth ${depth}`);
  }
  if (value === null || value === undefined) {
    writer.ensure(1);
    writer.bytes[writer.pos++] = 192;
    return;
  }
  switch (typeof value) {
    case "boolean":
      writer.ensure(1);
      writer.bytes[writer.pos++] = value ? 195 : 194;
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
  const ext = settings.extensionCodec.tryToEncode(value, settings.context);
  if (ext !== null) {
    encodeExtension(writer, ext);
    return;
  }
  throw new Error(`Unrecognized object: ${Object.prototype.toString.apply(value)}`);
}
function encodeNumber(writer, value, settings) {
  if (Number.isSafeInteger(value)) {
    if (value >= 0) {
      if (value < 128) {
        writer.ensure(1);
        writer.bytes[writer.pos++] = value;
      } else if (value < 256) {
        writer.ensure(2);
        writer.bytes[writer.pos] = 204;
        writer.bytes[writer.pos + 1] = value;
        writer.pos += 2;
      } else if (value < 65536) {
        writer.ensure(3);
        writer.bytes[writer.pos] = 205;
        writer.view.setUint16(writer.pos + 1, value);
        writer.pos += 3;
      } else if (value < 4294967296) {
        writer.ensure(5);
        writer.bytes[writer.pos] = 206;
        writer.view.setUint32(writer.pos + 1, value);
        writer.pos += 5;
      } else if (!settings.useBigInt64) {
        writer.ensure(9);
        writer.bytes[writer.pos] = 207;
        writer.view.setUint32(writer.pos + 1, value / 4294967296);
        writer.view.setUint32(writer.pos + 5, value);
        writer.pos += 9;
      } else {
        encodeNumberAsFloat(writer, value, settings.forceFloat32);
      }
    } else if (value >= -32) {
      writer.ensure(1);
      writer.bytes[writer.pos++] = value + 256 & 255;
    } else if (value >= -128) {
      writer.ensure(2);
      writer.bytes[writer.pos] = 208;
      writer.bytes[writer.pos + 1] = value;
      writer.pos += 2;
    } else if (value >= -32768) {
      writer.ensure(3);
      writer.bytes[writer.pos] = 209;
      writer.view.setInt16(writer.pos + 1, value);
      writer.pos += 3;
    } else if (value >= -2147483648) {
      writer.ensure(5);
      writer.bytes[writer.pos] = 210;
      writer.view.setInt32(writer.pos + 1, value);
      writer.pos += 5;
    } else if (!settings.useBigInt64) {
      writer.ensure(9);
      writer.bytes[writer.pos] = 211;
      writer.view.setUint32(writer.pos + 1, Math.floor(value / 4294967296));
      writer.view.setUint32(writer.pos + 5, value);
      writer.pos += 9;
    } else {
      encodeNumberAsFloat(writer, value, settings.forceFloat32);
    }
    return;
  }
  encodeNumberAsFloat(writer, value, settings.forceFloat32);
}
function encodeNumberAsFloat(writer, value, forceFloat32) {
  writer.ensure(9);
  if (forceFloat32) {
    writer.bytes[writer.pos] = 202;
    writer.view.setFloat32(writer.pos + 1, value);
    writer.pos += 5;
    return;
  }
  writer.bytes[writer.pos] = 203;
  writer.view.setFloat64(writer.pos + 1, value);
  writer.pos += 9;
}
function encodeBigInt64(writer, value) {
  writer.ensure(9);
  if (value >= 0n) {
    writer.bytes[writer.pos] = 207;
    writer.view.setBigUint64(writer.pos + 1, value);
  } else {
    writer.bytes[writer.pos] = 211;
    writer.view.setBigInt64(writer.pos + 1, value);
  }
  writer.pos += 9;
}
function writeStringHeader(writer, byteLength) {
  const bytes = writer.bytes;
  if (byteLength < 32) {
    bytes[writer.pos++] = 160 + byteLength;
  } else if (byteLength < 256) {
    writer.ensure(2);
    bytes[writer.pos] = 217;
    bytes[writer.pos + 1] = byteLength;
    writer.pos += 2;
  } else if (byteLength < 65536) {
    writer.ensure(3);
    bytes[writer.pos] = 218;
    writer.view.setUint16(writer.pos + 1, byteLength);
    writer.pos += 3;
  } else {
    writer.ensure(5);
    bytes[writer.pos] = 219;
    writer.view.setUint32(writer.pos + 1, byteLength);
    writer.pos += 5;
  }
}
function encodeString(writer, value) {
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
  const encoded = sharedEncoder.encode(value);
  const byteLength = encoded.length;
  writer.ensure(5 + byteLength);
  writeStringHeader(writer, byteLength);
  writer.bytes.set(encoded, writer.pos);
  writer.pos += byteLength;
}
function encodeBinary(writer, value) {
  const size = value.byteLength;
  if (size < 256) {
    writer.ensure(2 + size);
    writer.bytes[writer.pos] = 196;
    writer.bytes[writer.pos + 1] = size;
    writer.pos += 2;
  } else if (size < 65536) {
    writer.ensure(3 + size);
    writer.bytes[writer.pos] = 197;
    writer.view.setUint16(writer.pos + 1, size);
    writer.pos += 3;
  } else {
    writer.ensure(5 + size);
    writer.bytes[writer.pos] = 198;
    writer.view.setUint32(writer.pos + 1, size);
    writer.pos += 5;
  }
  if (value instanceof Uint8Array && value.buffer === writer.bytes.buffer) {
    writer.bytes.set(new Uint8Array(value), writer.pos);
  } else {
    writer.bytes.set(value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength), writer.pos);
  }
  writer.pos += size;
}
function encodeArray(writer, value, settings, depth) {
  const size = value.length;
  if (size < 16) {
    writer.ensure(1);
    writer.bytes[writer.pos++] = 144 + size;
  } else if (size < 65536) {
    writer.ensure(3);
    writer.bytes[writer.pos] = 220;
    writer.view.setUint16(writer.pos + 1, size);
    writer.pos += 3;
  } else {
    writer.ensure(5);
    writer.bytes[writer.pos] = 221;
    writer.view.setUint32(writer.pos + 1, size);
    writer.pos += 5;
  }
  for (let i = 0;i < size; i++) {
    encodeValue(writer, value[i], settings, depth + 1);
  }
}
function encodeMap(writer, value, settings, depth) {
  const keys = Object.keys(value);
  if (settings.sortKeys) {
    keys.sort();
  }
  let size = keys.length;
  if (settings.ignoreUndefined) {
    size = 0;
    for (let i = 0;i < keys.length; i++) {
      if (value[keys[i]] !== undefined) {
        size++;
      }
    }
  }
  if (size < 16) {
    writer.ensure(1);
    writer.bytes[writer.pos++] = 128 + size;
  } else if (size < 65536) {
    writer.ensure(3);
    writer.bytes[writer.pos] = 222;
    writer.view.setUint16(writer.pos + 1, size);
    writer.pos += 3;
  } else {
    writer.ensure(5);
    writer.bytes[writer.pos] = 223;
    writer.view.setUint32(writer.pos + 1, size);
    writer.pos += 5;
  }
  for (let i = 0;i < keys.length; i++) {
    const key = keys[i];
    const entry = value[key];
    if (!(settings.ignoreUndefined && entry === undefined)) {
      encodeString(writer, key);
      encodeValue(writer, entry, settings, depth + 1);
    }
  }
}
function encodeObject(writer, value, settings, depth) {
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
    encodeMap(writer, value, settings, depth);
  }
}
function encodeExtension(writer, ext) {
  if (typeof ext.data === "function") {
    const data = ext.data(writer.pos + 6);
    const size = data.length;
    if (size >= 4294967296) {
      throw new Error(`Too large extension object: ${size}`);
    }
    writer.ensure(6 + size);
    const pos = writer.pos;
    writer.bytes[pos] = 201;
    writer.view.setUint32(pos + 1, size);
    writer.view.setInt8(pos + 5, ext.type);
    writer.bytes.set(data, pos + 6);
    writer.pos = pos + 6 + size;
    return;
  }
  const size = ext.data.length;
  let head;
  let headerSize;
  if (size === 1) {
    head = 212;
    headerSize = 1;
  } else if (size === 2) {
    head = 213;
    headerSize = 1;
  } else if (size === 4) {
    head = 214;
    headerSize = 1;
  } else if (size === 8) {
    head = 215;
    headerSize = 1;
  } else if (size === 16) {
    head = 216;
    headerSize = 1;
  } else if (size < 256) {
    head = 199;
    headerSize = 2;
  } else if (size < 65536) {
    head = 200;
    headerSize = 3;
  } else if (size < 4294967296) {
    head = 201;
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

// packages/msgpack/src/stream.ts
function isAsyncIterable(object) {
  if (!(Symbol.asyncIterator in object)) {
    return false;
  }
  return typeof object[Symbol.asyncIterator] === "function";
}
async function* asyncIterableFromStream(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
function ensureAsyncIterable(streamLike) {
  return isAsyncIterable(streamLike) ? streamLike : asyncIterableFromStream(streamLike);
}

// packages/msgpack/src/decoder.ts
var UINT32_MAX = 4294967295;
var HEAD_BYTE_REQUIRED = -1;
var EMPTY_BYTES = new Uint8Array(0);
var KEY_MAX_LENGTH = 16;
var keyCaches = [];
for (let i = 0;i < KEY_MAX_LENGTH; i++) {
  keyCaches.push([]);
}
function lookupKey(bytes, start, length) {
  const entries = keyCaches[length - 1];
  SCAN:
    for (let i = 0;i < entries.length; i++) {
      const cached = entries[i].bytes;
      for (let j = 0;j < length; j++) {
        if (cached[j] !== bytes[start + j]) {
          continue SCAN;
        }
      }
      return entries[i].value;
    }
  return null;
}
function storeKey(bytes, start, length, value) {
  const entries = keyCaches[length - 1];
  const entry = { bytes: bytes.slice(start, start + length), value };
  if (entries.length >= KEY_MAX_LENGTH) {
    entries[Math.random() * entries.length | 0] = entry;
    return;
  }
  entries.push(entry);
}
var defaultKeyDecoder = {
  canBeCached(byteLength) {
    return byteLength > 0 && byteLength <= KEY_MAX_LENGTH;
  },
  decode(bytes, start, length) {
    const cached = lookupKey(bytes, start, length);
    if (cached !== null) {
      return cached;
    }
    const value = readUtf8(bytes, start, length);
    storeKey(bytes, start, length, value);
    return value;
  }
};
function defaultMapKeyConverter(key) {
  if (typeof key === "string" || typeof key === "number") {
    return key;
  }
  throw new DecodeError("The type of key must be string or number but " + typeof key);
}
var DEFAULT_DECODER_SETTINGS = {
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
  mapKeyConverter: defaultMapKeyConverter
};
function resolveDecoderSettings(options) {
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
    mapKeyConverter: options.mapKeyConverter ?? defaultMapKeyConverter
  };
}
var STATE_ARRAY = 0;
var STATE_MAP_KEY = 1;
var STATE_MAP_VALUE = 2;

class Reader {
  bytes = new Uint8Array(0);
  view = new DataView(new ArrayBuffer(0));
  pos = 0;
  head = HEAD_BYTE_REQUIRED;
  trackHead = false;
  settings = DEFAULT_DECODER_SETTINGS;
  stack = [];
  stackLength = 0;
  set(input) {
    this.setBytes(toBytes(input));
    this.head = HEAD_BYTE_REQUIRED;
    this.stackLength = 0;
  }
  reset() {
    this.setBytes(EMPTY_BYTES);
    this.head = HEAD_BYTE_REQUIRED;
    this.stackLength = 0;
  }
  append(input) {
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
  setBytes(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }
}
function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer || typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer) {
    return new Uint8Array(input);
  }
  return Uint8Array.from(input);
}
var sharedReader = new Reader;
var sharedReaderEntered = false;

class Decoder {
  reader = new Reader;
  options;
  settings;
  entered = false;
  constructor(options) {
    this.options = options;
    this.settings = resolveDecoderSettings(options);
  }
  decode(buffer) {
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
        throw new RangeError(`Extra ${reader.bytes.length - reader.pos} of ${reader.bytes.length} byte(s) found at buffer[${reader.pos}]`);
      }
      return value;
    } finally {
      this.entered = false;
    }
  }
  *decodeMulti(buffer) {
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
  async decodeAsync(stream) {
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
      let object;
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
      throw new RangeError(`Insufficient data in parsing ${prettyByte(reader.head)} at ${totalPos} (${reader.pos} in the current buffer)`);
    } finally {
      this.entered = false;
    }
  }
  decodeArrayStream(stream) {
    return this.decodeMultiAsync(stream, true);
  }
  decodeStream(stream) {
    return this.decodeMultiAsync(stream, false);
  }
  async* decodeMultiAsync(stream, isArray) {
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
function decode(buffer, options) {
  const settings = resolveDecoderSettings(options);
  if (!sharedReaderEntered) {
    sharedReaderEntered = true;
    try {
      sharedReader.settings = settings;
      sharedReader.trackHead = false;
      sharedReader.set(buffer);
      const value = decodeValue(sharedReader);
      if (sharedReader.pos !== sharedReader.bytes.length) {
        throw new RangeError(`Extra ${sharedReader.bytes.length - sharedReader.pos} of ${sharedReader.bytes.length} byte(s) found at buffer[${sharedReader.pos}]`);
      }
      return value;
    } finally {
      sharedReaderEntered = false;
    }
  }
  return new Decoder(options).decode(buffer);
}
function decodeMulti(buffer, options) {
  return new Decoder(options).decodeMulti(buffer);
}
function decodeAsync(streamLike, options) {
  return new Decoder(options).decodeAsync(ensureAsyncIterable(streamLike));
}
function decodeArrayStream(streamLike, options) {
  return new Decoder(options).decodeArrayStream(ensureAsyncIterable(streamLike));
}
function decodeMultiStream(streamLike, options) {
  return new Decoder(options).decodeStream(ensureAsyncIterable(streamLike));
}
function prettyByte(byte) {
  return `${byte < 0 ? "-" : ""}0x${Math.abs(byte).toString(16).padStart(2, "0")}`;
}
function createExtraByteError(viewLength, pos, posToShow) {
  return new RangeError(`Extra ${viewLength - pos} of ${viewLength} byte(s) found at buffer[${posToShow}]`);
}
function readArraySize(reader) {
  const head = reader.view.getUint8(reader.pos);
  reader.pos++;
  reader.head = head;
  switch (head) {
    case 220:
      return readU16(reader);
    case 221:
      return readU32(reader);
    default:
      if (head < 160) {
        return head - 144;
      }
      throw new DecodeError(`Unrecognized array type byte: ${prettyByte(head)}`);
  }
}
function readU16(reader) {
  const value = reader.view.getUint16(reader.pos);
  reader.pos += 2;
  return value;
}
function readU32(reader) {
  const value = reader.view.getUint32(reader.pos);
  reader.pos += 4;
  return value;
}
function stateIsMapKey(reader) {
  return reader.stackLength > 0 && reader.stack[reader.stackLength - 1].type === STATE_MAP_KEY;
}
function completeHead(reader) {
  if (reader.trackHead) {
    reader.head = HEAD_BYTE_REQUIRED;
  }
}
function pushArrayState(reader, size) {
  if (size > reader.settings.maxArrayLength) {
    throw new DecodeError(`Max length exceeded: array length (${size}) > maxArrayLength (${reader.settings.maxArrayLength})`);
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
      readCount: 0
    };
    reader.stack[depth] = state;
  }
  state.type = STATE_ARRAY;
  state.size = size;
  state.array = new Array(size);
  state.position = 0;
}
function pushMapState(reader, size) {
  if (size > reader.settings.maxMapLength) {
    throw new DecodeError(`Max length exceeded: map length (${size}) > maxMapLengthLength (${reader.settings.maxMapLength})`);
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
      readCount: 0
    };
    reader.stack[depth] = state;
  }
  state.type = STATE_MAP_KEY;
  state.size = size;
  state.map = {};
  state.key = null;
  state.readCount = 0;
}
function decodeValue(reader) {
  const stack = reader.stack;
  DECODE:
    while (true) {
      let head;
      if (reader.head !== HEAD_BYTE_REQUIRED) {
        head = reader.head;
      } else {
        head = reader.view.getUint8(reader.pos);
        reader.pos++;
        if (reader.trackHead) {
          reader.head = head;
        }
      }
      let object;
      if (head < 128) {
        object = head;
      } else if (head >= 224) {
        object = head - 256;
      } else if (head < 144) {
        const size = head - 128;
        if (size !== 0) {
          pushMapState(reader, size);
          completeHead(reader);
          continue DECODE;
        }
        object = {};
      } else if (head < 160) {
        const size = head - 144;
        if (size !== 0) {
          pushArrayState(reader, size);
          completeHead(reader);
          continue DECODE;
        }
        object = [];
      } else if (head < 192) {
        object = decodeString(reader, head - 160, stateIsMapKey(reader), 0);
      } else {
        switch (head) {
          case 192:
            object = null;
            break;
          case 194:
            object = false;
            break;
          case 195:
            object = true;
            break;
          case 202: {
            const value = reader.view.getFloat32(reader.pos);
            reader.pos += 4;
            object = value;
            break;
          }
          case 203: {
            const value = reader.view.getFloat64(reader.pos);
            reader.pos += 8;
            object = value;
            break;
          }
          case 204: {
            const value = reader.view.getUint8(reader.pos);
            reader.pos++;
            object = value;
            break;
          }
          case 205: {
            const value = reader.view.getUint16(reader.pos);
            reader.pos += 2;
            object = value;
            break;
          }
          case 206: {
            const value = reader.view.getUint32(reader.pos);
            reader.pos += 4;
            object = value;
            break;
          }
          case 207: {
            if (reader.settings.useBigInt64) {
              const value = reader.view.getBigUint64(reader.pos);
              reader.pos += 8;
              object = value;
            } else {
              const high = reader.view.getUint32(reader.pos);
              const low = reader.view.getUint32(reader.pos + 4);
              reader.pos += 8;
              object = high * 4294967296 + low;
            }
            break;
          }
          case 208: {
            const value = reader.view.getInt8(reader.pos);
            reader.pos += 1;
            object = value;
            break;
          }
          case 209: {
            const value = reader.view.getInt16(reader.pos);
            reader.pos += 2;
            object = value;
            break;
          }
          case 210: {
            const value = reader.view.getInt32(reader.pos);
            reader.pos += 4;
            object = value;
            break;
          }
          case 211: {
            if (reader.settings.useBigInt64) {
              const value = reader.view.getBigInt64(reader.pos);
              reader.pos += 8;
              object = value;
            } else {
              const high = reader.view.getInt32(reader.pos);
              const low = reader.view.getUint32(reader.pos + 4);
              reader.pos += 8;
              object = high * 4294967296 + low;
            }
            break;
          }
          case 217: {
            const length = reader.view.getUint8(reader.pos);
            object = decodeString(reader, length, stateIsMapKey(reader), 1);
            break;
          }
          case 218: {
            const length = reader.view.getUint16(reader.pos);
            object = decodeString(reader, length, stateIsMapKey(reader), 2);
            break;
          }
          case 219: {
            const length = reader.view.getUint32(reader.pos);
            object = decodeString(reader, length, stateIsMapKey(reader), 4);
            break;
          }
          case 220: {
            const size = readU16(reader);
            if (size !== 0) {
              pushArrayState(reader, size);
              completeHead(reader);
              continue DECODE;
            }
            object = [];
            break;
          }
          case 221: {
            const size = readU32(reader);
            if (size !== 0) {
              pushArrayState(reader, size);
              completeHead(reader);
              continue DECODE;
            }
            object = [];
            break;
          }
          case 222: {
            const size = readU16(reader);
            if (size !== 0) {
              pushMapState(reader, size);
              completeHead(reader);
              continue DECODE;
            }
            object = {};
            break;
          }
          case 223: {
            const size = readU32(reader);
            if (size !== 0) {
              pushMapState(reader, size);
              completeHead(reader);
              continue DECODE;
            }
            object = {};
            break;
          }
          case 196: {
            const size = reader.view.getUint8(reader.pos);
            object = decodeBinary(reader, size, 1);
            break;
          }
          case 197: {
            const size = reader.view.getUint16(reader.pos);
            object = decodeBinary(reader, size, 2);
            break;
          }
          case 198: {
            const size = reader.view.getUint32(reader.pos);
            object = decodeBinary(reader, size, 4);
            break;
          }
          case 212:
            object = decodeExtension(reader, 1, 0);
            break;
          case 213:
            object = decodeExtension(reader, 2, 0);
            break;
          case 214:
            object = decodeExtension(reader, 4, 0);
            break;
          case 215:
            object = decodeExtension(reader, 8, 0);
            break;
          case 216:
            object = decodeExtension(reader, 16, 0);
            break;
          case 199: {
            const size = reader.view.getUint8(reader.pos);
            object = decodeExtension(reader, size, 1);
            break;
          }
          case 200: {
            const size = reader.view.getUint16(reader.pos);
            object = decodeExtension(reader, size, 2);
            break;
          }
          case 201: {
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
          const array = state.array;
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
          const map = state.map;
          map[state.key] = object;
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
function decodeExtension(reader, size, headerOffset) {
  const settings = reader.settings;
  if (size > settings.maxExtLength) {
    throw new DecodeError(`Max length exceeded: ext length (${size}) > maxExtLength (${settings.maxExtLength})`);
  }
  const type = reader.view.getInt8(reader.pos + headerOffset);
  const data = decodeBinary(reader, size, headerOffset + 1);
  return settings.extensionCodec.decode(data, type, settings.context);
}
function decodeString(reader, length, isMapKey, headerOffset) {
  const settings = reader.settings;
  if (settings.rawStrings && !isMapKey) {
    return decodeBinary(reader, length, headerOffset);
  }
  if (length > settings.maxStrLength) {
    throw new DecodeError(`Max length exceeded: UTF-8 byte length (${length}) > maxStrLength (${settings.maxStrLength})`);
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
function decodeBinary(reader, size, headerOffset) {
  if (size > reader.settings.maxBinLength) {
    throw new DecodeError(`Max length exceeded: bin length (${size}) > maxBinLength (${reader.settings.maxBinLength})`);
  }
  if (size > reader.bytes.length - reader.pos - headerOffset) {
    throw new RangeError("Insufficient data");
  }
  const start = reader.pos + headerOffset;
  reader.pos = start + size;
  return reader.bytes.subarray(start, start + size);
}

// packages/msgpack/src/index.ts
var src_default = {
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
  timestampExtension
};
