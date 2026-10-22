/**
 * Differential verification for malformed and unusual input.
 *
 * Every byte sequence below is decoded by the replacement (imported under the
 * original package name, exactly as an adopting application resolves it) and
 * by msgpack-javascript 3.1.3. Outcomes must match exactly: equal values, or
 * failures with the same error type and description. The comparison covers
 * single-message decoding, consecutive-message decoding, and incremental
 * stream decoding with chunks split at every position, including empty input
 * and input that ends partway through a message.
 */
import {
  decode as replacementDecode,
  decodeMulti as replacementDecodeMulti,
  decodeAsync as replacementDecodeAsync,
  decodeMultiStream as replacementDecodeMultiStream,
  decodeArrayStream as replacementDecodeArrayStream,
  decodeMulti as replacementDecodeMultiModule,
  Decoder as ReplacementDecoder,
  ExtensionCodec as ReplacementExtensionCodec,
} from "@dsdenes/msgpack";
import {
  decode as referenceDecode,
  decodeMulti as referenceDecodeMulti,
  decodeAsync as referenceDecodeAsync,
  decodeMultiStream as referenceDecodeMultiStream,
  decodeArrayStream as referenceDecodeArrayStream,
  encode as referenceEncode,
  Decoder as ReferenceDecoder,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";

interface Failure {
  check: string;
  input: string;
  detail: string;
}

const failures: Failure[] = [];
let checks = 0;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function bytesFromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// --- application extension used by the fixtures ---------------------------

class Marker {
  constructor(public readonly payload: string) {}
}

const referenceCodec = new ReferenceExtensionCodec();
const replacementCodec = new ReplacementExtensionCodec();
for (const codec of [referenceCodec, replacementCodec]) {
  codec.register({
    type: 42,
    encode(object: unknown): Uint8Array | null {
      return object instanceof Marker ? new TextEncoder().encode(object.payload) : null;
    },
    decode(data: Uint8Array, _type: number, context?: unknown): Marker {
      const tag = (context as { tag?: string } | undefined)?.tag ?? "";
      return new Marker(new TextDecoder().decode(data) + "|" + tag);
    },
  });
}

// --- outcome description ---------------------------------------------------

interface ErrorShape {
  constructor: string;
  name: string;
  message: string;
}

interface Outcome {
  value?: unknown;
  values?: unknown[];
  error?: ErrorShape;
}

function errorShape(error: unknown): ErrorShape {
  const typed = error as Error;
  return {
    constructor: typed?.constructor?.name ?? typeof error,
    name: typed?.name ?? typeof error,
    message: String(typed?.message ?? error),
  };
}

type Canonical =
  | null
  | boolean
  | string
  | number
  | Canonical[]
  | { [key: string]: unknown };

function canonical(value: unknown, depth = 0): Canonical {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (depth > 200) {
    return { __deep: true };
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
    return { __marker: value.payload };
  }
  if (value instanceof Uint8Array) {
    return { __binary: hex(value) };
  }
  const record = value as { constructor?: { name?: string }; type?: unknown; data?: unknown };
  if (
    record.constructor?.name === "ExtData" &&
    typeof record.type === "number" &&
    record.data instanceof Uint8Array
  ) {
    return { __ext: [record.type, hex(record.data)] };
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item, depth + 1));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    return {
      __protoIsObject: proto === Object.prototype,
      entries: Object.keys(value as object).map((key) => [
        key,
        canonical((value as Record<string, unknown>)[key], depth + 1),
      ]),
    };
  }
  return { __other: String(value) };
}

function decodeOutcome(run: () => unknown): Outcome {
  try {
    return { value: canonical(run()) };
  } catch (error) {
    return { error: errorShape(error) };
  }
}

function multiOutcome(run: () => Generator<unknown> | Iterable<unknown>): Outcome {
  const values: unknown[] = [];
  try {
    for (const value of run()) {
      values.push(canonical(value));
    }
    return { values };
  } catch (error) {
    return { values, error: errorShape(error) };
  }
}

async function asyncDecodeOutcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { value: canonical(await run()) };
  } catch (error) {
    return { error: errorShape(error) };
  }
}

async function asyncMultiOutcome(run: () => AsyncGenerator<unknown>): Promise<Outcome> {
  const values: unknown[] = [];
  try {
    for await (const value of run()) {
      values.push(canonical(value));
    }
    return { values };
  } catch (error) {
    return { values, error: errorShape(error) };
  }
}

function serialize(outcome: Outcome): string {
  return JSON.stringify(outcome);
}

function fail(check: string, input: string, actual: unknown, expected: unknown): void {
  failures.push({
    check,
    input,
    detail: `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  });
}

function compare(check: string, input: string, actual: unknown, expected: unknown): void {
  checks++;
  if (actual !== expected) {
    fail(check, input, actual, expected);
  }
}

type Options = Record<string, unknown>;

function pair(options: Options = {}): [Options, Options] {
  return [
    { ...options, extensionCodec: referenceCodec },
    { ...options, extensionCodec: replacementCodec },
  ];
}

function syncCompare(
  check: string,
  input: Uint8Array,
  options: Options = {},
): void {
  const [referenceOptions, replacementOptions] = pair(options);
  compare(
    `${check}:decode`,
    hex(input),
    serialize(decodeOutcome(() => replacementDecode(input, replacementOptions as never))),
    serialize(decodeOutcome(() => referenceDecode(input, referenceOptions as never))),
  );
  compare(
    `${check}:decodeMulti`,
    hex(input),
    serialize(multiOutcome(() => replacementDecodeMulti(input, replacementOptions as never))),
    serialize(multiOutcome(() => referenceDecodeMulti(input, referenceOptions as never))),
  );
}

function syncCompareBuffered(
  check: string,
  input: Uint8Array,
  options: Options = {},
): void {
  const [referenceOptions, replacementOptions] = pair(options);
  compare(
    `${check}:Decoder.decode`,
    hex(input),
    serialize(decodeOutcome(() => new ReplacementDecoder(replacementOptions as never).decode(input))),
    serialize(decodeOutcome(() => new ReferenceDecoder(referenceOptions as never).decode(input))),
  );
  compare(
    `${check}:Decoder.decodeMulti`,
    hex(input),
    serialize(multiOutcome(() => new ReplacementDecoder(replacementOptions as never).decodeMulti(input))),
    serialize(multiOutcome(() => new ReferenceDecoder(referenceOptions as never).decodeMulti(input))),
  );
}

function asyncIterable(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

function readableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function streamCompare(
  check: string,
  input: Uint8Array,
  chunks: Uint8Array[],
  options: Options = {},
  streamKind: "async" | "web" = "async",
): Promise<void> {
  const [referenceOptions, replacementOptions] = pair(options);
  const source = () => (streamKind === "async" ? asyncIterable(chunks) : readableStream(chunks));
  const description = `${hex(input)} chunks=${chunks.map(hex).join("|")}`;
  compare(
    `${check}:decodeAsync`,
    description,
    serialize(await asyncDecodeOutcome(
      () => replacementDecodeAsync(source() as never, replacementOptions as never),
    )),
    serialize(await asyncDecodeOutcome(
      () => referenceDecodeAsync(source() as never, referenceOptions as never),
    )),
  );
  compare(
    `${check}:decodeMultiStream`,
    description,
    serialize(await asyncMultiOutcome(
      () => replacementDecodeMultiStream(source() as never, replacementOptions as never),
    )),
    serialize(await asyncMultiOutcome(
      () => referenceDecodeMultiStream(source() as never, referenceOptions as never),
    )),
  );
  compare(
    `${check}:decodeArrayStream`,
    description,
    serialize(await asyncMultiOutcome(
      () => replacementDecodeArrayStream(source() as never, replacementOptions as never),
    )),
    serialize(await asyncMultiOutcome(
      () => referenceDecodeArrayStream(source() as never, referenceOptions as never),
    )),
  );
}

// --- corpus ----------------------------------------------------------------

const corpus = new Map<string, Uint8Array>();
function add(bytes: Uint8Array): void {
  corpus.set(hex(bytes), bytes);
}

// Every single-byte header, alone and followed by payload bytes of several
// shapes, so every length field is truncated at several positions.
const payloadPatterns = [
  (length: number) => new Uint8Array(length),
  (length: number) => new Uint8Array(length).fill(0xff),
  (length: number) => new Uint8Array(length).fill(0x01),
  (length: number) => Uint8Array.from({ length }, (_, i) => (i * 37 + 5) & 0xff),
  (length: number) => new Uint8Array(length).fill(0x80),
];
for (let header = 0; header < 256; header++) {
  add(Uint8Array.from([header]));
  for (const length of [1, 2, 3, 4, 5, 8, 9, 16, 17, 32]) {
    for (const pattern of payloadPatterns) {
      add(Uint8Array.from([header, ...pattern(length)]));
    }
  }
}

// Every truncation of every payload the library supports, plus trailing data.
const fixtureValues: unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  0x7f,
  0x80,
  0xff,
  0x100,
  0xffff,
  0x10000,
  0xffffffff,
  0x100000000,
  Number.MAX_SAFE_INTEGER,
  -1,
  -0x20,
  -0x21,
  -0x80,
  -0x81,
  -0x8000,
  -0x8001,
  -0x80000000,
  -0x80000001,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  1.5,
  -1.25,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "",
  "hello, msgpack",
  "a".repeat(31),
  "b".repeat(32),
  "c".repeat(255),
  "d".repeat(256),
  "héllo wörld — ✓ 😀",
  "\ud800",
  "a".repeat(199) + "\ud83d",
  "a".repeat(200) + "\ud83d",
  new Uint8Array(0),
  new Uint8Array([0, 1, 2, 255]),
  new Uint8Array(255).fill(7),
  new Uint8Array(256).fill(8),
  [],
  [1, "two", true, null],
  Array.from({ length: 16 }, (_, i) => i),
  {},
  { a: 1, b: "two", c: false, d: null },
  Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i])),
  { nested: { arrays: [[1, [2, [3]]]], binary: new Uint8Array([9, 8, 7]) } },
  [null, true, false, 0, -1234, 3.25, "", "text", "日本語", new Uint8Array([1, 2, 3]), [], {}],
  new Date(0),
  new Date(1),
  new Date(-1),
  new Date(1700000000123),
  new Date(-8640000000000000),
  new Date(8640000000000000),
  new Marker("payload"),
  [new Marker("a"), new Date(1000)],
  { at: new Date(0), marker: new Marker("m") },
];
for (const value of fixtureValues) {
  let encoded: Uint8Array;
  try {
    encoded = referenceEncode(value, { extensionCodec: referenceCodec });
  } catch {
    continue;
  }
  for (let length = 0; length <= encoded.length; length++) {
    add(encoded.slice(0, length));
  }
  add(Uint8Array.from([...encoded, 0x00]));
  add(Uint8Array.from([...encoded, 0xc1]));
}

// Alternative encodings of the same values, including encodings the
// libraries' own encoders never emit and invalid UTF-8.
const alternatives = [
  "c0", "c2", "c3", "c1", "a0", "a161", "d900", "d90061", "da0000", "da000161",
  "db00000000", "db0000000161", "a1ff", "a180", "a2c080", "a3eda080", "a4f4908080",
  "a2e080", "d90261c3", "d9058080808080", "a4733433e9", "a1e9",
  "c400", "c50000", "c600000000", "c40101", "c5010001", "c60000000101",
  "90", "9101", "dc0000", "dc000101", "dd00000000", "dd0000000101", "919101",
  "80", "81a16101", "de0000", "de0001a16101", "df00000000", "df00000001a16101",
  "81a95f5f70726f746f5f5f01", "81ab636f6e7374727563746f7201", "82a16101a16102",
  "81a001", "81910101", "818001", "81c301", "81c001", "810101", "81a1ff01",
  "d40001", "d5000001", "d60000000001", "d7000000000000000001",
  "d8000000000000000000000000000000000001",
  "d4ff00000000", "d4ff00", "d5ff0000000000", "d5ffffff",
  "d6ff000000000000000000", "d7ff00000000000000000000000000000000",
  "d8ff" + "01".repeat(16), "c700ff", "c80000ff", "c900000000ff",
  "c7002a", "c7012a01", "c800012a01", "c9000000012a01", "c7000100", "c702010001",
  "c704ff00000000", "c708ff" + "00".repeat(8), "c70cff" + "00".repeat(12),
  "c70cff" + "ff".repeat(12), "c70c00" + "ff".repeat(12),
  "ca00000000", "ca80000000", "ca3fc00000", "ca7fc00000", "ca7f800000",
  "caff800000", "ca00000001",
  "cb0000000000000000", "cb8000000000000000", "cb3ff8000000000000",
  "cb7ff8000000000000", "cb7ff0000000000000", "cbfff0000000000000",
  "cf0000000000000000", "cfffffffffffffffff", "cffffffffffffffffe",
  "d30000000000000000", "d38000000000000000", "d3ffffffffffffffff",
  "d37fffffffffffffff", "d080", "d07f", "d10080", "d2ffffffff",
  "cc00", "cd0000", "ce00000000", "d000", "d10000", "d200000000",
];
for (const value of alternatives) {
  const encoded = bytesFromHex(value);
  add(encoded);
  for (let length = 0; length <= encoded.length; length++) {
    add(encoded.slice(0, length));
  }
  add(Uint8Array.from([...encoded, 0x00]));
}

// Length-bearing payloads at every width threshold.
for (const length of [1, 2, 3, 15, 16, 31, 32, 127, 128, 255, 256, 1000]) {
  const payload = new Uint8Array(length).map((_, index) => index & 0xff);
  if (length < 32) add(Uint8Array.from([0xa0 + length, ...payload]));
  if (length < 256) add(Uint8Array.from([0xd9, length, ...payload]));
  add(Uint8Array.from([0xda, length >> 8, length & 0xff, ...payload]));
  add(Uint8Array.from([0xdb, 0, 0, length >> 8, length & 0xff, ...payload]));
  if (length < 256) add(Uint8Array.from([0xc4, length, ...payload]));
  add(Uint8Array.from([0xc5, length >> 8, length & 0xff, ...payload]));
  add(Uint8Array.from([0xc6, 0, 0, length >> 8, length & 0xff, ...payload]));
  if (length < 16) add(Uint8Array.from([0x90 + length, ...new Array(length).fill(0xc0)]));
  add(Uint8Array.from([0xdc, length >> 8, length & 0xff, ...new Array(length).fill(0xc0)]));
  add(Uint8Array.from([0xdd, 0, 0, length >> 8, length & 0xff, ...new Array(length).fill(0xc0)]));
  const pairs = Uint8Array.from(
    Array.from({ length }, (_, index) => [0xa1, 0x61 + (index % 26), 0x01]).flat(),
  );
  if (length < 16) add(Uint8Array.from([0x80 + length, ...pairs]));
  add(Uint8Array.from([0xde, length >> 8, length & 0xff, ...pairs]));
  add(Uint8Array.from([0xdf, 0, 0, length >> 8, length & 0xff, ...pairs]));
  if (length < 256) add(Uint8Array.from([0xc7, length, 0x2a, ...payload]));
  add(Uint8Array.from([0xc8, length >> 8, length & 0xff, 0x2a, ...payload]));
  add(Uint8Array.from([0xc9, 0, 0, length >> 8, length & 0xff, 0x2a, ...payload]));
}

// Deterministic generated sequences: random bytes, plus valid messages with
// bytes mutated so the decoder sees plausible but corrupted structure.
let seed = 0x5eed1234;
function random(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed >>> 8;
}
function randomValue(depth = 0): unknown {
  const choice = random() % (depth > 3 ? 5 : 10);
  switch (choice) {
    case 0:
      return null;
    case 1:
      return random() % 2 === 0;
    case 2:
      return (random() % 0x200000) - 0x100000;
    case 3:
      return (random() / 0x1000000) * (random() % 2 === 0 ? 1 : -1);
    case 4:
      return "s" + (random() % 1000);
    case 5:
      return Uint8Array.from({ length: random() % 8 }, () => random() & 0xff);
    case 6:
      return new Date((random() % 0x100000) * 1000 - 500000000);
    case 7:
      return Array.from({ length: random() % 5 }, () => randomValue(depth + 1));
    case 8:
      return Object.fromEntries(
        Array.from({ length: random() % 5 }, (_, index) => [
          "k" + index + (random() % 10),
          randomValue(depth + 1),
        ]),
      );
    default:
      return new Marker("m" + (random() % 10));
  }
}
for (let index = 0; index < 1000; index++) {
  let encoded: Uint8Array;
  try {
    encoded = referenceEncode(randomValue(), { extensionCodec: referenceCodec });
  } catch {
    continue;
  }
  add(encoded);
  for (let mutation = 0; mutation < 3; mutation++) {
    const mutated = encoded.slice();
    if (mutated.length > 0) {
      mutated[random() % mutated.length] = random() & 0xff;
    }
    add(mutated);
  }
}
for (let index = 0; index < 3000; index++) {
  const length = random() % 20;
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset++) {
    bytes[offset] = random() & 0xff;
  }
  add(bytes);
}

// --- single-message and consecutive-message comparison ---------------------

const entries = [...corpus.values()];
for (const input of entries) {
  syncCompare("buffer", input);
}

// Buffers holding no message, one message, and several consecutive messages,
// with the final message truncated at every position.
const messageValues: unknown[] = [
  1,
  "a",
  { a: 1 },
  [1, "two"],
  new Date(0),
  new Uint8Array([1, 2, 3]),
  new Marker("x"),
  -1234,
];
const messages = messageValues.map((value) =>
  referenceEncode(value, { extensionCodec: referenceCodec })
);
const multiBuffers = new Map<string, Uint8Array>();
function addMulti(bytes: Uint8Array): void {
  multiBuffers.set(hex(bytes), bytes);
}
addMulti(new Uint8Array(0));
for (let index = 0; index < messages.length; index++) {
  addMulti(messages[index]);
  addMulti(concat([messages[index], messages[(index + 1) % messages.length]]));
  addMulti(concat([
    messages[index],
    messages[(index + 1) % messages.length],
    messages[(index + 2) % messages.length],
  ]));
}
for (const buffer of [...multiBuffers.values()]) {
  for (let length = 0; length <= buffer.length; length++) {
    addMulti(buffer.slice(0, length));
  }
}
for (const buffer of [...multiBuffers.values()]) {
  addMulti(Uint8Array.from([...buffer, 0x00]));
  addMulti(Uint8Array.from([...buffer, 0xc1]));
}
for (const input of multiBuffers.values()) {
  syncCompare("multi-buffer", input);
  syncCompareBuffered("multi-buffer", input);
}

// Alternative input forms accepted by the public decoding functions.
const formSources = [bytesFromHex("01"), bytesFromHex("9201a162"), bytesFromHex("81a16101")];
for (let index = 0; index < formSources.length; index++) {
  const bytes = formSources[index];
  const arrayBuffer = bytes.slice().buffer;
  const dataView = new DataView(arrayBuffer);
  const plainArray = [...bytes];
  const nodeBuffer = Buffer.from(bytes);
  const uint16 = new Uint16Array(arrayBuffer, 0, Math.floor(bytes.length / 2));
  const inputs: Array<[string, unknown]> = [
    ["Uint8Array", bytes],
    ["ArrayBuffer", arrayBuffer],
    ["DataView", dataView],
    ["number[]", plainArray],
    ["Buffer", nodeBuffer],
    ["Uint16Array", uint16],
  ];
  if (typeof SharedArrayBuffer !== "undefined") {
    const shared = new SharedArrayBuffer(bytes.length);
    new Uint8Array(shared).set(bytes);
    inputs.push(["SharedArrayBuffer", shared]);
  }
  for (const [name, input] of inputs) {
    const [referenceOptions, replacementOptions] = pair();
    compare(
      `form:${name}`,
      hex(bytes),
      serialize(decodeOutcome(() => replacementDecode(input as never, replacementOptions))),
      serialize(decodeOutcome(() => referenceDecode(input as never, referenceOptions))),
    );
  }
}

// --- stream comparison -----------------------------------------------------

function splitsFor(bytes: Uint8Array): number[][] {
  const splits: number[][] = [[]];
  for (let position = 1; position < bytes.length; position++) {
    splits.push([position]);
  }
  if (bytes.length <= 6) {
    for (let first = 1; first < bytes.length; first++) {
      for (let second = first; second < bytes.length; second++) {
        splits.push([first, second]);
      }
    }
  }
  // Every byte in its own chunk, and two bytes per chunk.
  splits.push(Array.from({ length: Math.max(0, bytes.length - 1) }, (_, index) => index + 1));
  splits.push(Array.from({ length: Math.floor(bytes.length / 2) }, (_, index) => index * 2));
  return splits;
}

function chunksAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let previous = 0;
  for (const cut of cuts) {
    if (cut > previous) {
      chunks.push(bytes.slice(previous, cut));
      previous = cut;
    }
  }
  chunks.push(bytes.slice(previous));
  return chunks;
}

const streamBuffers = [...multiBuffers.values(), ...entries.filter((bytes) => bytes.length <= 20)];
for (const input of streamBuffers) {
  for (const splits of splitsFor(input)) {
    const chunks = chunksAt(input, splits);
    await streamCompare("stream", input, chunks);
  }
}

// Large payloads split at fixed sizes and at sampled positions.
const largeValues: unknown[] = [
  "x".repeat(5000),
  new Uint8Array(4096).map((_, index) => index & 0xff),
  Array.from({ length: 1000 }, (_, index) => (index % 2 === 0 ? index : "s" + index)),
  Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => [
      "key" + index,
      index % 3 === 0 ? "v".repeat(50) : index,
    ]),
  ),
];
for (const value of largeValues) {
  const encoded = referenceEncode(value, { extensionCodec: referenceCodec });
  for (const size of [1, 3, 64, 1000]) {
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < encoded.length; offset += size) {
      chunks.push(encoded.subarray(offset, Math.min(offset + size, encoded.length)));
    }
    await streamCompare("large-stream", encoded, chunks);
  }
  for (let cut = 0; cut <= encoded.length; cut += 97) {
    await streamCompare("large-stream-split", encoded, chunksAt(encoded, [cut]));
  }
}

const largeStream = concat([
  referenceEncode(largeValues[0]),
  referenceEncode(largeValues[2]),
]);
for (const size of [1, 7, 512]) {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < largeStream.length; offset += size) {
    chunks.push(largeStream.subarray(offset, Math.min(offset + size, largeStream.length)));
  }
  await streamCompare("large-multi-stream", largeStream, chunks);
}
for (let length = largeStream.length - 8; length < largeStream.length; length++) {
  const truncated = largeStream.slice(0, length);
  await streamCompare("large-multi-truncated", truncated, chunksAt(truncated, [3, 1000]));
}

// A browser-style WHATWG ReadableStream, including a chunk split inside an
// invalid UTF-8 sequence.
const webBuffers = [
  bytesFromHex("c1"),
  bytesFromHex("01"),
  concat([messages[1], messages[2], messages[3]]),
  bytesFromHex("93a4733433e9d2fff8693a90"),
  bytesFromHex("d90561"),
  new Uint8Array(0),
];
for (const input of webBuffers) {
  for (const splits of splitsFor(input)) {
    await streamCompare("web-stream", input, chunksAt(input, splits), {}, "web");
  }
}

// --- options over malformed input -----------------------------------------

const optionCases: Array<[string, Options]> = [
  ["useBigInt64", { useBigInt64: true }],
  ["rawStrings", { rawStrings: true }],
  ["maxStrLength 0", { maxStrLength: 0 }],
  ["maxStrLength 2", { maxStrLength: 2 }],
  ["maxBinLength 0", { maxBinLength: 0 }],
  ["maxBinLength 2", { maxBinLength: 2 }],
  ["maxArrayLength 0", { maxArrayLength: 0 }],
  ["maxArrayLength 1", { maxArrayLength: 1 }],
  ["maxMapLength 0", { maxMapLength: 0 }],
  ["maxMapLength 1", { maxMapLength: 1 }],
  ["maxExtLength 0", { maxExtLength: 0 }],
  ["maxExtLength 1", { maxExtLength: 1 }],
  ["keyDecoder null", { keyDecoder: null }],
  ["context", { context: { tag: "T" } }],
];
const optionCorpus = [
  ...entries.filter((bytes) => bytes.length <= 8),
  ...multiBuffers.values(),
];
for (const [name, options] of optionCases) {
  for (const input of optionCorpus) {
    syncCompare(`option:${name}`, input, options);
  }
}

const converters: Array<[string, (key: unknown) => string | number]> = [
  ["string keys", (key) => "K" + String(key)],
  ["number keys", (key) => (typeof key === "number" ? key + 1 : 7)],
  [
    "throwing converter",
    () => {
      throw new Error("key rejected");
    },
  ],
];
for (const [name, converter] of converters) {
  for (const input of optionCorpus) {
    syncCompare(`mapKeyConverter:${name}`, input, { mapKeyConverter: converter });
  }
}

// The module-level functions and the class methods must agree with each other
// as well as with the reference.
for (const input of optionCorpus.slice(0, 200)) {
  const [referenceOptions, replacementOptions] = pair();
  compare(
    "module-vs-class:decode",
    hex(input),
    serialize(multiOutcome(() => replacementDecodeMultiModule(input, replacementOptions as never))),
    serialize(multiOutcome(() => replacementDecodeMulti(input, replacementOptions as never))),
  );
  compare(
    "class:decode",
    hex(input),
    serialize(decodeOutcome(() => new ReplacementDecoder(replacementOptions as never).decode(input))),
    serialize(decodeOutcome(() => referenceDecode(input, referenceOptions as never))),
  );
}

console.log(JSON.stringify({
  checks,
  failures: failures.slice(0, 20),
  failureCount: failures.length,
  corpus: entries.length,
  multiBuffers: multiBuffers.size,
}, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
