export const sharedEncoder = new TextEncoder();
const sharedDecoder = new TextDecoder();

/** Byte length of the UTF-8 encoding produced by the original JS encoder. */
export function utf8Count(str: string): number {
  const length = str.length;
  let bytes = 0;
  let i = 0;
  while (i < length) {
    let value = str.charCodeAt(i++);
    if ((value & 0xffffff80) === 0) {
      bytes += 1;
    } else if ((value & 0xfffff800) === 0) {
      bytes += 2;
    } else {
      if (value >= 0xd800 && value <= 0xdbff && i < length) {
        const extra = str.charCodeAt(i);
        if ((extra & 0xfc00) === 0xdc00) {
          i++;
          value = ((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000;
        }
      }
      bytes += (value & 0xffff0000) === 0 ? 3 : 4;
    }
  }
  return bytes;
}

/**
 * Whether the string is pure ASCII, and its byte length when it is. The
 * original's JS and TextEncoder paths both produce identical bytes for ASCII,
 * so callers may take the cheaper copy path regardless of string length.
 */
export function asciiByteLength(str: string): number {
  const length = str.length;
  for (let i = 0; i < length; i++) {
    if (str.charCodeAt(i) > 0x7f) {
      return -1;
    }
  }
  return length;
}

/** Direct byte copy for ASCII strings. */
export function writeAscii(str: string, output: Uint8Array, offset: number): void {
  const length = str.length;
  for (let i = 0; i < length; i++) {
    output[offset + i] = str.charCodeAt(i);
  }
}

/**
 * Encodes exactly like the original's utf8EncodeJs, including its handling of
 * lone surrogates and of surrogate pairs.
 */
export function writeUtf8Js(str: string, output: Uint8Array, offset: number): void {
  const length = str.length;
  let pos = 0;
  while (pos < length) {
    let value = str.charCodeAt(pos++);
    if ((value & 0xffffff80) === 0) {
      output[offset++] = value;
      continue;
    }
    if ((value & 0xfffff800) === 0) {
      output[offset++] = ((value >> 6) & 0x1f) | 0xc0;
    } else {
      if (value >= 0xd800 && value <= 0xdbff && pos < length) {
        const extra = str.charCodeAt(pos);
        if ((extra & 0xfc00) === 0xdc00) {
          pos++;
          value = ((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000;
        }
      }
      if ((value & 0xffff0000) === 0) {
        output[offset++] = ((value >> 12) & 0x0f) | 0xe0;
        output[offset++] = ((value >> 6) & 0x3f) | 0x80;
      } else {
        output[offset++] = ((value >> 18) & 0x07) | 0xf0;
        output[offset++] = ((value >> 12) & 0x3f) | 0x80;
        output[offset++] = ((value >> 6) & 0x3f) | 0x80;
      }
    }
    output[offset++] = (value & 0x3f) | 0x80;
  }
}

const ASCII_CHUNK = 0x1000;

// Mirrors the original's utf8DecodeJs. Its handling of encoded lone
// surrogates is observable, so the original's threshold is kept as well.
const TEXT_DECODER_THRESHOLD = 200;

function readUtf8Js(bytes: Uint8Array, start: number, end: number): string {
  let offset = start;
  const units: number[] = [];
  let result = "";

  while (offset < end) {
    const byte1 = bytes[offset++];
    if ((byte1 & 0x80) === 0) {
      units.push(byte1);
    } else if ((byte1 & 0xe0) === 0xc0) {
      const byte2 = bytes[offset++] & 0x3f;
      units.push(((byte1 & 0x1f) << 6) | byte2);
    } else if ((byte1 & 0xf0) === 0xe0) {
      const byte2 = bytes[offset++] & 0x3f;
      const byte3 = bytes[offset++] & 0x3f;
      units.push(((byte1 & 0x1f) << 12) | (byte2 << 6) | byte3);
    } else if ((byte1 & 0xf8) === 0xf0) {
      const byte2 = bytes[offset++] & 0x3f;
      const byte3 = bytes[offset++] & 0x3f;
      const byte4 = bytes[offset++] & 0x3f;
      let unit = ((byte1 & 0x07) << 0x12) | (byte2 << 0x0c) | (byte3 << 0x06) | byte4;
      if (unit > 0xffff) {
        unit -= 0x10000;
        units.push(((unit >>> 10) & 0x3ff) | 0xd800);
        unit = 0xdc00 | (unit & 0x3ff);
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

/** Decodes UTF-8 bytes. Input is assumed to be a complete string. */
export function readUtf8(bytes: Uint8Array, start: number, length: number): string {
  if (length === 0) {
    return "";
  }

  const end = start + length;

  // The original switches to TextDecoder above this byte length. For long
  // strings its SIMD path beats per-unit string building, so keep the same
  // threshold and skip the ASCII scan entirely.
  if (length > TEXT_DECODER_THRESHOLD) {
    return sharedDecoder.decode(bytes.subarray(start, end));
  }

  let ascii = true;
  for (let i = start; i < end; i++) {
    if (bytes[i] > 0x7f) {
      ascii = false;
      break;
    }
  }

  if (ascii) {
    if (length <= 8) {
      let result = "";
      for (let i = start; i < end; i++) {
        result += String.fromCharCode(bytes[i]);
      }
      return result;
    }
    return sharedDecoder.decode(bytes.subarray(start, end));
  }

  return readUtf8Js(bytes, start, end);
}
