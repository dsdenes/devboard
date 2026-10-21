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
    while (capacity < required) {
      capacity *= 2;
    }
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
function writeUtf8TextEncoder(str, output, offset) {
  sharedEncoder.encodeInto(str, output.subarray(offset));
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

// packages/msgpack/src/encoder.ts
var TEXT_ENCODER_THRESHOLD = 50;

class Encoder {
  writer;
  options;
  entered = false;
  constructor(options) {
    this.options = options;
    this.writer = new Writer(options?.initialBufferSize ?? DEFAULT_INITIAL_BUFFER_SIZE);
  }
  encode(value) {
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
  encodeSharedRef(value) {
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
var sharedWriter = new Writer;
var sharedWriterEntered = false;
function encode(value, options) {
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
function encodeValue(writer, value) {
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
      encodeNumber(writer, value);
      return;
    case "string":
      encodeString(writer, value);
      return;
    case "object":
      encodeObject(writer, value);
      return;
    default:
      throw new Error(`Unrecognized object: ${Object.prototype.toString.apply(value)}`);
  }
}
function encodeNumber(writer, value) {
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
      } else {
        writer.ensure(9);
        writer.bytes[writer.pos] = 207;
        writer.view.setUint32(writer.pos + 1, value / 4294967296);
        writer.view.setUint32(writer.pos + 5, value);
        writer.pos += 9;
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
    } else {
      writer.ensure(9);
      writer.bytes[writer.pos] = 211;
      writer.view.setUint32(writer.pos + 1, Math.floor(value / 4294967296));
      writer.view.setUint32(writer.pos + 5, value);
      writer.pos += 9;
    }
    return;
  }
  writer.ensure(9);
  writer.bytes[writer.pos] = 203;
  writer.view.setFloat64(writer.pos + 1, value);
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
function encodeArray(writer, value) {
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
    encodeValue(writer, value[i]);
  }
}
function encodeMap(writer, value) {
  const keys = Object.keys(value);
  const size = keys.length;
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
  for (let i = 0;i < size; i++) {
    const key = keys[i];
    encodeString(writer, key);
    encodeValue(writer, value[key]);
  }
}
function encodeObject(writer, value) {
  if (Array.isArray(value)) {
    encodeArray(writer, value);
  } else if (ArrayBuffer.isView(value)) {
    encodeBinary(writer, value);
  } else {
    encodeMap(writer, value);
  }
}
// packages/msgpack/src/decoder.ts
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

class Reader {
  bytes = new Uint8Array(0);
  view = new DataView(new ArrayBuffer(0));
  pos = 0;
  set(input) {
    const bytes = toBytes(input);
    this.bytes = bytes;
    if (this.view.buffer !== bytes.buffer || this.view.byteOffset !== bytes.byteOffset || this.view.byteLength !== bytes.byteLength) {
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
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
  if (input instanceof ArrayBuffer || input instanceof SharedArrayBuffer) {
    return new Uint8Array(input);
  }
  return Uint8Array.from(input);
}
var sharedReader = new Reader;
var sharedReaderEntered = false;

class Decoder {
  reader = new Reader;
  entered = false;
  constructor(_options) {}
  decode(buffer) {
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
function decode(buffer, _options) {
  if (!sharedReaderEntered) {
    sharedReaderEntered = true;
    try {
      sharedReader.set(buffer);
      const value = decodeValue(sharedReader, false);
      if (sharedReader.pos !== sharedReader.bytes.length) {
        throw new RangeError(`Extra ${sharedReader.bytes.length - sharedReader.pos} byte(s) found at buffer[${sharedReader.pos}]`);
      }
      return value;
    } finally {
      sharedReaderEntered = false;
    }
  }
  return new Decoder().decode(buffer);
}
function decodeValue(reader, isMapKey) {
  const bytes = reader.bytes;
  const head = bytes[reader.pos++];
  if (head < 128) {
    return head;
  }
  if (head >= 224) {
    return head - 256;
  }
  if (head < 144) {
    return decodeMap(reader, head - 128);
  }
  if (head < 160) {
    return decodeArray(reader, head - 144);
  }
  if (head < 192) {
    return decodeString(reader, head - 160, isMapKey);
  }
  switch (head) {
    case 192:
      return null;
    case 194:
      return false;
    case 195:
      return true;
    case 202: {
      const value = reader.view.getFloat32(reader.pos);
      reader.pos += 4;
      return value;
    }
    case 203: {
      const value = reader.view.getFloat64(reader.pos);
      reader.pos += 8;
      return value;
    }
    case 204:
      return bytes[reader.pos++];
    case 205: {
      const value = bytes[reader.pos] << 8 | bytes[reader.pos + 1];
      reader.pos += 2;
      return value;
    }
    case 206: {
      const value = readU32(bytes, reader.pos);
      reader.pos += 4;
      return value;
    }
    case 207: {
      const value = readU32(bytes, reader.pos) * 4294967296 + readU32(bytes, reader.pos + 4);
      reader.pos += 8;
      return value;
    }
    case 208: {
      const value = bytes[reader.pos] << 24 >> 24;
      reader.pos += 1;
      return value;
    }
    case 209: {
      const value = (bytes[reader.pos] << 8 | bytes[reader.pos + 1]) << 16 >> 16;
      reader.pos += 2;
      return value;
    }
    case 210: {
      const value = bytes[reader.pos] << 24 | bytes[reader.pos + 1] << 16 | bytes[reader.pos + 2] << 8 | bytes[reader.pos + 3];
      reader.pos += 4;
      return value;
    }
    case 211: {
      const high = bytes[reader.pos] << 24 | bytes[reader.pos + 1] << 16 | bytes[reader.pos + 2] << 8 | bytes[reader.pos + 3];
      const low = readU32(bytes, reader.pos + 4);
      reader.pos += 8;
      return high * 4294967296 + low;
    }
    case 217: {
      const length = bytes[reader.pos++];
      return decodeString(reader, length, false);
    }
    case 218: {
      const length = bytes[reader.pos] << 8 | bytes[reader.pos + 1];
      reader.pos += 2;
      return decodeString(reader, length, false);
    }
    case 219: {
      const length = readU32(bytes, reader.pos);
      reader.pos += 4;
      return decodeString(reader, length, false);
    }
    case 220: {
      const size = bytes[reader.pos] << 8 | bytes[reader.pos + 1];
      reader.pos += 2;
      return decodeArray(reader, size);
    }
    case 221: {
      const size = readU32(bytes, reader.pos);
      reader.pos += 4;
      return decodeArray(reader, size);
    }
    case 222: {
      const size = bytes[reader.pos] << 8 | bytes[reader.pos + 1];
      reader.pos += 2;
      return decodeMap(reader, size);
    }
    case 223: {
      const size = readU32(bytes, reader.pos);
      reader.pos += 4;
      return decodeMap(reader, size);
    }
    case 196:
      return decodeBinary(reader, bytes[reader.pos++]);
    case 197: {
      const size = bytes[reader.pos] << 8 | bytes[reader.pos + 1];
      reader.pos += 2;
      return decodeBinary(reader, size);
    }
    case 198: {
      const size = readU32(bytes, reader.pos);
      reader.pos += 4;
      return decodeBinary(reader, size);
    }
    default:
      throw new Error(`Unrecognized type byte: 0x${head.toString(16)}`);
  }
}
function readU32(bytes, pos) {
  return (bytes[pos] << 24 | bytes[pos + 1] << 16 | bytes[pos + 2] << 8 | bytes[pos + 3]) >>> 0;
}
function decodeString(reader, length, isMapKey) {
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
function decodeBinary(reader, size) {
  const start = reader.pos;
  reader.pos += size;
  return reader.bytes.subarray(start, start + size);
}
function decodeArray(reader, size) {
  if (size === 0) {
    return [];
  }
  const array = new Array(size);
  for (let i = 0;i < size; i++) {
    array[i] = decodeValue(reader, false);
  }
  return array;
}
function decodeMap(reader, size) {
  if (size === 0) {
    return {};
  }
  const map = {};
  for (let i = 0;i < size; i++) {
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
export {
  DEFAULT_INITIAL_BUFFER_SIZE,
  Decoder,
  Encoder,
  decode,
  encode
};
