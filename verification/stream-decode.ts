/**
 * Application-facing verification for stream-fed decoding.
 *
 * The replacement is imported under the original package name, exactly as an
 * adopting application resolves it. Every byte sequence is produced by
 * msgpack-javascript 3.1.3, delivered in chunks whose boundaries fall at
 * varying positions, and compared with what that library yields for the same
 * chunks.
 */
import { createRequire } from "node:module";
import {
  decodeArrayStream,
  decodeAsync,
  decodeMultiStream,
  Decoder as ReplacementDecoder,
  ExtensionCodec as ReplacementExtensionCodec,
} from "@dsdenes/msgpack";
import {
  decodeArrayStream as referenceDecodeArrayStream,
  decodeAsync as referenceDecodeAsync,
  decodeMultiStream as referenceDecodeMultiStream,
  encode as referenceEncode,
  Decoder as ReferenceDecoder,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";

class Marker {
  constructor(
    public readonly payload: Uint8Array,
    public readonly tag?: string,
  ) {}
}

interface Registerable {
  register(entry: {
    type: number;
    encode: (object: unknown, context?: unknown) => Uint8Array | null;
    decode: (data: Uint8Array, type: number, context?: unknown) => unknown;
  }): void;
}

function tagOf(context: unknown): string | undefined {
  if (
    typeof context === "object" &&
    context !== null &&
    "tag" in context &&
    typeof context.tag === "string"
  ) {
    return context.tag;
  }
  return undefined;
}

function installCodec(codec: Registerable): void {
  codec.register({
    type: 42,
    encode(object: unknown): Uint8Array | null {
      return object instanceof Marker ? object.payload : null;
    },
    decode(data: Uint8Array, _type: number, context?: unknown): Marker {
      return new Marker(data.slice(), tagOf(context));
    },
  });
}

const referenceCodec = new ReferenceExtensionCodec();
const replacementCodec = new ReplacementExtensionCodec();
installCodec(referenceCodec);
installCodec(replacementCodec);

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "undefined") {
    return { __undefined: true };
  }
  if (typeof value === "bigint") {
    return { __bigint: value.toString() };
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { __number: "NaN" };
    if (value === Number.POSITIVE_INFINITY) return { __number: "Infinity" };
    if (value === Number.NEGATIVE_INFINITY) return { __number: "-Infinity" };
    if (Object.is(value, -0)) return { __number: "-0" };
    return value;
  }
  if (value instanceof Date) {
    return { __date: Number.isNaN(value.getTime()) ? "NaN" : value.getTime() };
  }
  if (value instanceof Marker) {
    return { __marker: [hex(value.payload), value.tag ?? null] };
  }
  if (value instanceof Uint8Array) {
    return { __binary: hex(value) };
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = canonical(item);
    }
    return result;
  }
  return { __unsupported: typeof value };
}

interface Outcome {
  values: unknown[];
  error: { name: string; message: string } | null;
}

async function collect(iterable: AsyncIterable<unknown>): Promise<Outcome> {
  const values: unknown[] = [];
  try {
    for await (const value of iterable) {
      values.push(canonical(value));
    }
    return { values, error: null };
  } catch (error) {
    const typed = error as Error;
    return { values, error: { name: typed.constructor.name, message: typed.message } };
  }
}

async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: canonical(await run()) };
  } catch (error) {
    const typed = error as Error;
    return { error: { name: typed.constructor.name, message: typed.message } };
  }
}

function chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    for (const part of parts) {
      yield part;
    }
  })();
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function sliceInto(bytes: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    parts.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
  }
  return parts;
}

const failures: string[] = [];
let checks = 0;

async function check(name: string, run: () => Promise<void>): Promise<void> {
  checks++;
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function equal(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: ${actualJson} != ${expectedJson}`);
  }
}

function equalOutcome(actual: Outcome, expected: Outcome, label: string): void {
  equal(actual, expected, label);
}

const timestampBoundaries = [
  new Date(0),
  new Date(1),
  new Date(999),
  new Date(1000),
  new Date(-1),
  new Date(-1000),
  new Date((0x100000000 - 1) * 1000),
  new Date(0x100000000 * 1000),
  new Date(8640000000000000),
  new Date(-8640000000000000),
  new Date(Number.NaN),
];

const customWidths = [0, 1, 2, 3, 4, 8, 16, 17, 255, 256, 300].map(
  (length, index) => new Marker(filled(length, index + 1)),
);

const values: unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  42,
  -42,
  0x7f,
  0x80,
  0xff,
  0x100,
  0xffff,
  0x10000,
  0xffffffff,
  0x100000000,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  1.5,
  -1.25,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "",
  "hello, msgpack",
  "a".repeat(31),
  "a".repeat(32),
  "a".repeat(255),
  "a".repeat(256),
  "a".repeat(300),
  "héllo wörld — 日本語 ✓ 😀",
  new Uint8Array(0),
  new Uint8Array([0, 1, 2, 255]),
  new Uint8Array(255).fill(7),
  new Uint8Array(256).fill(8),
  new Uint8Array(300).fill(9),
  [],
  [1, "two", true, null],
  Array.from({ length: 16 }, (_, index) => index),
  {},
  { a: 1, b: "two", c: false, d: null },
  Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`k${index}`, index])),
  {
    nested: { array: [{ deep: [1, 2, 3] }] },
    binary: new Uint8Array([9, 8, 7]),
    unicode: "✓",
  },
  ...timestampBoundaries,
  ...customWidths,
  { points: customWidths.slice(0, 4), when: new Date(1700000000123) },
  new Uint8Array([0xd4, 0x63, 0x2a]),
];

const referenceOptions = { extensionCodec: referenceCodec };
const replacementOptions = { extensionCodec: replacementCodec };
const referenceEncodeOptions = { extensionCodec: referenceCodec };

const messages = values.map((value) => referenceEncode(value, referenceEncodeOptions));
const stream = concat(messages);

const compactValues: unknown[] = [
  null,
  true,
  42,
  -1,
  1.5,
  "hello",
  "a".repeat(32),
  new Uint8Array(0),
  new Uint8Array([1, 2, 3]),
  [1, "two", null],
  { a: 1, b: [2, 3] },
  new Date(0),
  customWidths[3],
];
const compactStream = concat(compactValues.map((value) => referenceEncode(value, referenceEncodeOptions)));

await check("module decodeMultiStream decodes one chunk", async () => {
  const expected = await collect(referenceDecodeMultiStream(chunks(stream), referenceOptions));
  const actual = await collect(decodeMultiStream(chunks(stream), replacementOptions));
  equalOutcome(actual, expected, "single chunk");
  if (expected.error !== null || actual.values.length !== values.length) {
    throw new Error(`expected ${values.length} values, got ${actual.values.length}`);
  }
});

await check("chunk boundaries at every position of a stream", async () => {
  for (let split = 0; split <= compactStream.length; split++) {
    const parts = [compactStream.subarray(0, split), compactStream.subarray(split)];
    const expected = await collect(referenceDecodeMultiStream(chunks(...parts), referenceOptions));
    const actual = await collect(decodeMultiStream(chunks(...parts), replacementOptions));
    equalOutcome(actual, expected, `split ${split}`);
  }
});

await check("chunk boundaries inside every message of the full stream", async () => {
  let offset = 0;
  for (const message of messages) {
    offset += message.length;
    for (const split of [offset - 1, offset]) {
      const parts = [stream.subarray(0, split), stream.subarray(split)];
      const expected = await collect(referenceDecodeMultiStream(chunks(...parts), referenceOptions));
      const actual = await collect(decodeMultiStream(chunks(...parts), replacementOptions));
      equalOutcome(actual, expected, `split ${split}`);
    }
  }
});

await check("every transport chunk size", async () => {
  for (const size of [1, 3, 7, 64, 257, 1024, 4096]) {
    const source = size <= 7 ? compactStream : stream;
    const parts = sliceInto(source, size);
    const expected = await collect(referenceDecodeMultiStream(chunks(...parts), referenceOptions));
    const actual = await collect(decodeMultiStream(chunks(...parts), replacementOptions));
    equalOutcome(actual, expected, `chunks of ${size}`);
  }
});

await check("truncated final message matches the reference", async () => {
  const prefix = messages.slice(0, 3);
  const tails = [
    messages[3],
    messages[10],
    referenceEncode("x".repeat(300), referenceEncodeOptions),
    referenceEncode(new Uint8Array(300), referenceEncodeOptions),
    referenceEncode(customWidths[10], referenceEncodeOptions),
  ];
  for (const tail of tails) {
    for (let cut = 1; cut < tail.length; cut++) {
      const parts = [...prefix, tail.subarray(0, cut)];
      const expected = await collect(referenceDecodeMultiStream(chunks(...parts), referenceOptions));
      const actual = await collect(decodeMultiStream(chunks(...parts), replacementOptions));
      equalOutcome(actual, expected, `tail cut ${cut}`);
      if (actual.values.length !== prefix.length) {
        throw new Error(`tail cut ${cut}: ${actual.values.length} complete messages delivered`);
      }
    }
  }
});

await check("empty stream yields no messages and no failure", async () => {
  for (const parts of [[], [new Uint8Array(0)], [new Uint8Array(0), new Uint8Array(0)]]) {
    const expected = await collect(referenceDecodeMultiStream(chunks(...parts), referenceOptions));
    const actual = await collect(decodeMultiStream(chunks(...parts), replacementOptions));
    equalOutcome(actual, expected, `empty stream of ${parts.length} chunks`);
    if (actual.values.length !== 0 || actual.error !== null) {
      throw new Error(`empty stream produced ${JSON.stringify(actual)}`);
    }
  }
});

await check("Decoder.decodeStream matches the reference", async () => {
  const parts = sliceInto(compactStream, 5);
  const expected = await collect(new ReferenceDecoder(referenceOptions).decodeStream(chunks(...parts)));
  const actual = await collect(new ReplacementDecoder(replacementOptions).decodeStream(chunks(...parts)));
  equalOutcome(actual, expected, "Decoder.decodeStream");

  const again = await collect(new ReplacementDecoder(replacementOptions).decodeStream(chunks(compactStream)));
  equalOutcome(again, expected, "Decoder.decodeStream after reuse");
});

await check("accepts WHATWG ReadableStream input", async () => {
  const parts = sliceInto(compactStream, 8);
  const expected = await collect(referenceDecodeMultiStream(chunks(...parts), referenceOptions));
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
  const actual = await collect(decodeMultiStream(readable, replacementOptions));
  equalOutcome(actual, expected, "ReadableStream");
});

await check("decodeAsync matches the reference", async () => {
  const single = messages[3];
  for (let split = 0; split <= single.length; split++) {
    const parts = [single.subarray(0, split), single.subarray(split)];
    const expected = await settle(() => referenceDecodeAsync(chunks(...parts), referenceOptions));
    const actual = await settle(() => decodeAsync(chunks(...parts), replacementOptions));
    equal(actual, expected, `async split ${split}`);
  }
  for (const parts of [
    [] as Uint8Array[],
    [new Uint8Array(0)],
    [single.subarray(0, 1)],
    [single.subarray(0, single.length - 1)],
    [stream],
    [single, referenceEncode("next", referenceEncodeOptions)],
  ]) {
    const expected = await settle(() => referenceDecodeAsync(chunks(...parts), referenceOptions));
    const actual = await settle(() => decodeAsync(chunks(...parts), replacementOptions));
    equal(actual, expected, `async parts ${parts.map((part) => part.length).join(",")}`);
  }
});

await check("decodeArrayStream matches the reference", async () => {
  const array = referenceEncode(
    [1, "two", { three: [3, 4] }, new Uint8Array([5, 6]), new Date(0)],
    referenceEncodeOptions,
  );
  for (let split = 0; split <= array.length; split++) {
    const parts = [array.subarray(0, split), array.subarray(split)];
    const expected = await collect(referenceDecodeArrayStream(chunks(...parts), referenceOptions));
    const actual = await collect(decodeArrayStream(chunks(...parts), replacementOptions));
    equalOutcome(actual, expected, `array split ${split}`);
  }
  const edgeCases = [
    [concat([referenceEncode([1, 2, 3]), referenceEncode(9)])],
    [referenceEncode([1, 2, 3]), referenceEncode(9)],
    [referenceEncode([1, 2, 3])],
    [referenceEncode([])],
    [concat([referenceEncode([]), referenceEncode(9)])],
    [referenceEncode(null)],
    [new Uint8Array(0)],
  ];
  for (const parts of edgeCases) {
    const expected = await collect(referenceDecodeArrayStream(chunks(...parts), referenceOptions));
    const actual = await collect(decodeArrayStream(chunks(...parts), replacementOptions));
    equalOutcome(actual, expected, `array edge ${parts.map((part) => part.length).join(",")}`);
  }
});

const optionScenarios: Array<{
  name: string;
  values: unknown[];
  encodeOptions?: Record<string, unknown>;
  referenceDecode: Record<string, unknown>;
  replacementDecode: Record<string, unknown>;
}> = [
  {
    name: "rawStrings",
    values: [">", "héllo wörld — ✓ 😀", { key: "value" }],
    referenceDecode: { rawStrings: true },
    replacementDecode: { rawStrings: true },
  },
  {
    name: "useBigInt64",
    values: [0n, 123n, 0x7fffffffffffffffn, -1n],
    encodeOptions: { useBigInt64: true },
    referenceDecode: { useBigInt64: true },
    replacementDecode: { useBigInt64: true },
  },
  {
    name: "extensionCodec and context",
    values: [customWidths[3], { at: new Date(0), marker: customWidths[10] }],
    encodeOptions: { extensionCodec: referenceCodec },
    referenceDecode: { extensionCodec: referenceCodec, context: { tag: "dec" } },
    replacementDecode: { extensionCodec: replacementCodec, context: { tag: "dec" } },
  },
  {
    name: "keyDecoder null",
    values: [{ alpha: 1, beta: 2 }, { nested: { key: "value" } }],
    referenceDecode: { keyDecoder: null },
    replacementDecode: { keyDecoder: null },
  },
  {
    name: "mapKeyConverter",
    values: [{ 1: "one", 2: "two" }],
    referenceDecode: { mapKeyConverter: (key: unknown) => `k${String(key)}` },
    replacementDecode: { mapKeyConverter: (key: unknown) => `k${String(key)}` },
  },
  {
    name: "length limits",
    values: ["a".repeat(40), new Uint8Array(40), { key: "value" }],
    referenceDecode: { maxStrLength: 5, maxBinLength: 5, maxMapLength: 5 },
    replacementDecode: { maxStrLength: 5, maxBinLength: 5, maxMapLength: 5 },
  },
];

for (const scenario of optionScenarios) {
  await check(`option ${scenario.name}`, async () => {
    const bytes = concat(
      scenario.values.map((value) => referenceEncode(value, scenario.encodeOptions as never)),
    );
    const expected = await collect(
      referenceDecodeMultiStream(chunks(...sliceInto(bytes, 4)), scenario.referenceDecode as never),
    );
    const actual = await collect(
      decodeMultiStream(chunks(...sliceInto(bytes, 4)), scenario.replacementDecode as never),
    );
    equalOutcome(actual, expected, scenario.name);
  });
}

await check("CommonJS entry point exposes streamed decoding", async () => {
  const require = createRequire(import.meta.url);
  const commonJs = require("@dsdenes/msgpack") as {
    decodeMultiStream: typeof decodeMultiStream;
    decodeAsync: typeof decodeAsync;
    decodeArrayStream: typeof decodeArrayStream;
    Decoder: typeof ReplacementDecoder;
  };
  const expected = await collect(referenceDecodeMultiStream(chunks(compactStream), referenceOptions));
  const actual = await collect(
    commonJs.decodeMultiStream(chunks(compactStream), { extensionCodec: replacementCodec }),
  );
  equalOutcome(actual, expected, "CommonJS decodeMultiStream");
  const classActual = await collect(
    new commonJs.Decoder({ extensionCodec: replacementCodec }).decodeStream(chunks(compactStream)),
  );
  equalOutcome(classActual, expected, "CommonJS Decoder.decodeStream");
});

const report = {
  checks,
  failures,
  messages: values.length,
  bytes: stream.length,
};

console.log(JSON.stringify(report, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
