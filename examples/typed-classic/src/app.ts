import {
  DecodeError,
  Decoder,
  Encoder,
  ExtensionCodec,
  ExtData,
  decode,
  encode,
  encodeDateToTimeSpec,
  type DecoderOptions,
  type EncoderOptions,
  type ExtensionCodecType,
} from "@dsdenes/msgpack";

/**
 * A strict TypeScript application that already uses msgpack-javascript and
 * resolves packages with classic Node module resolution. Its source and
 * tsconfig are written against the original library's published API and types.
 * Switching which dependency provides `@dsdenes/msgpack` must not require
 * editing either file.
 *
 * It reports every payload's encoded bytes and decoded value, plus the
 * failures it observes for malformed input, an unsupported option value, and
 * a decoder length limit, so the same run can be compared before and after the
 * swap.
 */

class GeoPoint {
  constructor(
    readonly lat: number,
    readonly lon: number,
  ) {}
}

const extensionCodec = new ExtensionCodec();
extensionCodec.register({
  type: 0x42,
  encode(object: unknown): Uint8Array | null {
    if (!(object instanceof GeoPoint)) {
      return null;
    }
    const data = new Uint8Array(16);
    const view = new DataView(data.buffer);
    view.setFloat64(0, object.lat);
    view.setFloat64(8, object.lon);
    return data;
  },
  decode(data: Uint8Array): GeoPoint {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return new GeoPoint(view.getFloat64(0), view.getFloat64(8));
  },
});

const encoderOptions: EncoderOptions = { extensionCodec };
const decoderOptions: DecoderOptions = { extensionCodec };
const codecContract: ExtensionCodecType<undefined> = extensionCodec;

const cases: Array<[string, unknown]> = [
  ["null", null],
  ["boolean true", true],
  ["boolean false", false],
  ["zero", 0],
  ["negative fixint", -32],
  ["positive fixint", 127],
  ["int8", -100],
  ["uint16", 60000],
  ["int32", -70000],
  ["float", -3.25],
  ["max safe integer", Number.MAX_SAFE_INTEGER],
  ["short string", "hello, msgpack"],
  ["non-ASCII text", "héllo wörld — 日本語 ✓ 😀"],
  ["empty string", ""],
  ["binary", new Uint8Array([0, 1, 2, 3, 254, 255])],
  ["empty binary", new Uint8Array(0)],
  ["array", [1, "two", true, null, [3, 4], new Uint8Array([5])]],
  ["map", { id: 1, name: "widget", ok: true, tags: ["a", "b"] }],
  [
    "nested",
    {
      users: [
        { id: 1, name: "Ada", active: true, score: 99.5 },
        { id: 2, name: "Grace", active: false, score: 87.25 },
      ],
      cursor: null,
      blob: new Uint8Array([0, 17, 34, 51, 68, 85]),
    },
  ],
  ["timestamp epoch", new Date(0)],
  ["timestamp recent", new Date(1700000000123)],
  ["timestamp before epoch", new Date(-1)],
  ["registered extension", new GeoPoint(12.5, -7.25)],
  ["extension nested", { at: new Date(1000), where: new GeoPoint(1, 2) }],
];

function hex(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    encoded += byte.toString(16).padStart(2, "0");
  }
  return encoded;
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isNaN(value) ? { __number: "NaN" } : value;
  }
  if (value instanceof Date) {
    return { __date: value.getTime() };
  }
  if (value instanceof GeoPoint) {
    return { __point: [value.lat, value.lon] };
  }
  if (value instanceof Uint8Array) {
    return { __binary: hex(value) };
  }
  if (value instanceof ExtData) {
    return { __ext: value.type };
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object") {
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      record[key] = canonical(item);
    }
    return record;
  }
  return { __unsupported: typeof value };
}

function describeError(error: unknown): { type: string; message: string } {
  let type = "Error";
  if (error instanceof DecodeError) {
    type = "DecodeError";
  } else if (error instanceof RangeError) {
    type = "RangeError";
  } else if (error instanceof TypeError) {
    type = "TypeError";
  }
  return { type, message: String((error as Error)?.message) };
}

const encodedCases = cases.map(([name, value]) => {
  const bytes = encode(value, encoderOptions);
  return {
    name,
    hex: hex(bytes),
    decoded: canonical(decode(bytes, decoderOptions)),
    classBytesSame: hex(new Encoder(encoderOptions).encode(value)) === hex(bytes),
    classDecoded: canonical(new Decoder(decoderOptions).decode(bytes)),
  };
});

const failureCases: Array<[string, () => unknown]> = [
  ["malformed message", () => decode(Uint8Array.from([0xc1]), decoderOptions)],
  ["truncated message", () => decode(Uint8Array.from([0xd9, 0x05, 0x61]), decoderOptions)],
  ["unsupported option", () => encode({ a: { b: 1 } }, { ...encoderOptions, maxDepth: 0 })],
  ["length limit", () => decode(encode("abcdef"), { ...decoderOptions, maxStrLength: 3 })],
];

const failures = failureCases.map(([name, run]) => {
  try {
    return { name, ok: true, value: canonical(run()) };
  } catch (error) {
    return { name, ok: false, error: describeError(error) };
  }
});

const timestamp = new Date(1700000000123);
const timestampReport = {
  spec: encodeDateToTimeSpec(timestamp),
  payload: hex(encode(timestamp)),
  decoded: canonical(decode(encode(timestamp))),
};

const extData = encode(new ExtData(0x7e, Uint8Array.from([1, 2, 3])));
const extDataReport = {
  hex: hex(extData),
  decoded: canonical(decode(extData)),
};

console.log(
  JSON.stringify(
    {
      codecIsContract: codecContract === extensionCodec,
      encodedCases,
      failures,
      timestampReport,
      extDataReport,
    },
    null,
    2,
  ),
);
