import {
  DecodeError,
  Decoder,
  Encoder,
  ExtensionCodec,
  ExtData,
  decode,
  decodeMulti,
  encode,
  type DecoderOptions,
  type EncoderOptions,
  type ExtensionCodecType,
  type ExtensionDecoderType,
  type ExtensionEncoderType,
} from "@dsdenes/msgpack";

/**
 * A TypeScript application that already uses msgpack-javascript. Its own
 * source is written against the library's published types: the option
 * generics, the context generic on the encoder and decoder, the extension
 * codec contract, and the value classes it registers. Switching which
 * dependency provides `@dsdenes/msgpack` must not require editing this file.
 */

interface AppContext {
  readonly trace: string[];
  counter: number;
}

class Money {
  constructor(
    readonly cents: bigint,
    readonly currency: string,
  ) {}
}

class Tagged {
  constructor(
    readonly id: number,
    readonly label: string,
  ) {}
}

interface CodecBundle<C> {
  codec: ExtensionCodec<C>;
  encoderOptions: EncoderOptions<C>;
  decoderOptions: DecoderOptions<C>;
}

const context: AppContext = { trace: [], counter: 0 };

const encodeMoney: ExtensionEncoderType<AppContext> = (object, appContext) => {
  if (!(object instanceof Money)) {
    return null;
  }
  appContext.counter += 1;
  appContext.trace.push(`money:${object.currency}`);
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, object.cents);
  data[8] = object.currency.length;
  return data;
};

const decodeMoney: ExtensionDecoderType<AppContext> = (data, extensionType, appContext) => {
  if (extensionType !== 0x10) {
    throw new DecodeError(`unexpected money extension type: ${extensionType}`);
  }
  appContext.counter += 1;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return new Money(view.getBigUint64(0), "EUR");
};

const encodeTagged: ExtensionEncoderType<AppContext> = (object, appContext) => {
  if (!(object instanceof Tagged)) {
    return null;
  }
  appContext.trace.push(`tag:${object.label}`);
  const label = new TextEncoder().encode(object.label);
  return (dataPos: number): Uint8Array => {
    const data = new Uint8Array(4 + label.length);
    new DataView(data.buffer).setUint32(0, object.id + dataPos);
    data.set(label, 4);
    return data;
  };
};

const decodeTagged: ExtensionDecoderType<AppContext> = (data, extensionType, appContext) => {
  if (extensionType !== 0x11) {
    throw new DecodeError(`unexpected tag extension type: ${extensionType}`);
  }
  appContext.trace.push("tag-decode");
  const id = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  return new Tagged(id, new TextDecoder().decode(data.subarray(4)));
};

const keyDecoder = {
  canBeCached(byteLength: number): boolean {
    return byteLength > 0 && byteLength <= 8;
  },
  decode(bytes: Uint8Array, inputOffset: number, byteLength: number): string {
    return new TextDecoder().decode(bytes.subarray(inputOffset, inputOffset + byteLength));
  },
};

const mapKeyConverter = (key: unknown): string | number => {
  if (typeof key === "string" || typeof key === "number") {
    return key;
  }
  throw new DecodeError("map key is not a string or a number");
};

function bundleFor(appContext: AppContext, codec: ExtensionCodec<AppContext>): CodecBundle<AppContext> {
  const encoderOptions: EncoderOptions<AppContext> = {
    extensionCodec: codec,
    context: appContext,
    initialBufferSize: 256,
    useBigInt64: true,
    maxDepth: 64,
    sortKeys: true,
    forceFloat32: false,
    forceIntegerToFloat: false,
    ignoreUndefined: true,
  };
  const decoderOptions: DecoderOptions<AppContext> = {
    extensionCodec: codec,
    context: appContext,
    useBigInt64: true,
    rawStrings: false,
    maxStrLength: 1_000_000,
    maxBinLength: 1_000_000,
    maxArrayLength: 10_000,
    maxMapLength: 10_000,
    maxExtLength: 1_000_000,
    keyDecoder,
    mapKeyConverter,
  };
  return { codec, encoderOptions, decoderOptions };
}

const codec = new ExtensionCodec<AppContext>();
codec.register({ type: 0x10, encode: encodeMoney, decode: decodeMoney });
codec.register({ type: 0x11, encode: encodeTagged, decode: decodeTagged });

const bundle: CodecBundle<AppContext> = bundleFor(context, codec);
const codecContract: ExtensionCodecType<AppContext> = bundle.codec;
const defaultCodec: ExtensionCodecType<undefined> = ExtensionCodec.defaultCodec;

const encoder: Encoder<AppContext> = new Encoder<AppContext>(bundle.encoderOptions);
const decoder: Decoder<AppContext> = new Decoder<AppContext>(bundle.decoderOptions);

const payload = {
  order: new Money(1234n, "EUR"),
  tags: [new Tagged(1, "hot"), new Tagged(2, "new")],
  at: new Date(1700000000123),
  big: 1234567890123456789n,
  note: "héllo wörld — 日本語 ✓ 😀",
  bin: new Uint8Array([0, 1, 2, 3, 255]),
  nested: { b: 2, a: 1, missing: undefined },
  skipped: undefined,
};

function hex(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    encoded += byte.toString(16).padStart(2, "0");
  }
  return encoded;
}

function describe(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return { bigint: value.toString() };
  }
  if (typeof value === "number") {
    return Number.isNaN(value) ? { number: "NaN" } : value;
  }
  if (value instanceof Date) {
    return { date: value.getTime() };
  }
  if (value instanceof Money) {
    return { money: [value.cents.toString(), value.currency] };
  }
  if (value instanceof Tagged) {
    return { tagged: [value.id, value.label] };
  }
  if (value instanceof ExtData) {
    return { ext: [value.type, typeof value.data === "function" ? "lazy" : hex(value.data)] };
  }
  if (value instanceof Uint8Array) {
    return { binary: hex(value) };
  }
  if (Array.isArray(value)) {
    return value.map(describe);
  }
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    record[key] = describe(item);
  }
  return record;
}

function describeError(error: unknown): { name: string; message: string } {
  const typed = error as Error;
  return { name: String(typed?.name), message: String(typed?.message) };
}

const moduleBytes = encode<AppContext>(payload, bundle.encoderOptions);
const instanceBytes = encoder.encode(payload);
const sharedBytes = encoder.encodeSharedRef(payload);
const decoded = decode<AppContext>(moduleBytes, bundle.decoderOptions);
const instanceDecoded = decoder.decode(instanceBytes);

const multiBytes = new Uint8Array([...encode(payload, bundle.encoderOptions), ...encode([1, "two"], bundle.encoderOptions)]);
const multi = [...decodeMulti<AppContext>(multiBytes, bundle.decoderOptions)].map(describe);

const extData = new ExtData(0x7e, Uint8Array.from([1, 2, 3]));
const extDataBytes = encode(extData, bundle.encoderOptions);
const decodedExtData = decode(extDataBytes, bundle.decoderOptions);

const errors: Array<{ name: string; message: string }> = [];
for (const bytes of [new Uint8Array(0), Uint8Array.from([0xc1]), Uint8Array.from([0x81, 0x91, 0x01, 0x02])]) {
  try {
    decode(bytes, bundle.decoderOptions);
    errors.push({ name: "none", message: "" });
  } catch (error) {
    errors.push(describeError(error));
  }
}

const report = {
  moduleBytes: hex(moduleBytes),
  instanceSame: hex(instanceBytes) === hex(moduleBytes),
  sharedSame: hex(sharedBytes) === hex(moduleBytes),
  decoded: describe(decoded),
  instanceDecoded: describe(instanceDecoded),
  multi,
  extData: hex(extDataBytes),
  decodedExtData: describe(decodedExtData),
  errors,
  contextCounter: context.counter,
  trace: context.trace,
  defaultCodecHandlesDates: defaultCodec.tryToEncode(new Date(0), undefined) !== null,
};

console.log(JSON.stringify(report, null, 2));
