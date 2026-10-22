/**
 * Application-facing verification for multi-message decoding.
 *
 * The replacement is imported under the original package name, exactly as an
 * adopting application resolves it. Every buffer is produced by
 * msgpack-javascript 3.1.3, and every outcome is compared with what that
 * library returns for the same bytes and options.
 */
import {
  decode as replacementDecode,
  decodeMulti as replacementDecodeMulti,
  Decoder as ReplacementDecoder,
  ExtensionCodec as ReplacementExtensionCodec,
} from "@dsdenes/msgpack";
import {
  decode as referenceDecode,
  decodeMulti as referenceDecodeMulti,
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

function installCodec(codec: Registerable): void {
  codec.register({
    type: 42,
    encode(object: unknown): Uint8Array | null {
      return object instanceof Marker ? object.payload : null;
    },
    decode(data: Uint8Array, _type: number, context?: unknown): Marker {
      return new Marker(data.slice(), (context as { tag?: string } | undefined)?.tag);
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
  const ext = value as { type?: unknown; data?: unknown };
  if (
    typeof ext === "object" && ext !== null &&
    typeof ext.type === "number" &&
    ext.data instanceof Uint8Array &&
    (value as object).constructor?.name === "ExtData"
  ) {
    return { __ext: [ext.type, hex(ext.data)] };
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return { __unsupported: typeof value };
}

interface Failure {
  check: string;
  message: string;
}

const failures: Failure[] = [];
let checks = 0;

function check(name: string, run: () => void): void {
  checks++;
  try {
    run();
  } catch (error) {
    failures.push({ check: name, message: error instanceof Error ? `${error.message}` : String(error) });
  }
}

function equal(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(canonical(actual));
  const expectedJson = JSON.stringify(canonical(expected));
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: ${actualJson} != ${expectedJson}`);
  }
}

interface ErrorShape {
  name: string;
  message: string;
}

interface Outcome {
  values: unknown[];
  error: ErrorShape | null;
}

function collect(run: () => Iterable<unknown>): Outcome {
  const values: unknown[] = [];
  try {
    for (const value of run()) {
      values.push(value);
    }
    return { values, error: null };
  } catch (error) {
    const typed = error as Error;
    return {
      values,
      error: { name: typed.constructor.name, message: typed.message },
    };
  }
}

function equalOutcome(actual: Outcome, expected: Outcome, label: string): void {
  equal(actual.values, expected.values, `${label} values`);
  equal(actual.error, expected.error, `${label} error`);
}

function concat(messages: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const message of messages) {
    length += message.length;
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const message of messages) {
    buffer.set(message, offset);
    offset += message.length;
  }
  return buffer;
}

function encodeAll(values: unknown[], options?: Record<string, unknown>): Uint8Array {
  return concat(values.map((value) => referenceEncode(value, options as never)));
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
  new Date((0x400000000 - 1) * 1000),
  new Date(0x400000000 * 1000),
  new Date(8640000000000000),
  new Date(-8640000000000000),
  new Date(Number.NaN),
];

const customWidths = [0, 1, 2, 3, 4, 8, 16, 17, 255, 256, 300].map(
  (length, index) => new Marker(filled(length, index + 1)),
);

const variedValues: unknown[] = [
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
  "héllo wörld — 日本語 ✓ 😀",
  new Uint8Array(0),
  new Uint8Array([0, 1, 2, 255]),
  new Uint8Array(255).fill(7),
  new Uint8Array(256).fill(8),
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
const variedBytes = encodeAll(variedValues, referenceOptions);

check("decodes every consecutive message in order", () => {
  const expected = collect(() => referenceDecodeMulti(variedBytes, referenceOptions));
  const actual = collect(() => replacementDecodeMulti(variedBytes, replacementOptions));
  equalOutcome(actual, expected, "module decodeMulti");
  if (expected.error !== null) {
    throw new Error(`reference failed: ${JSON.stringify(expected.error)}`);
  }
  if (expected.values.length !== variedValues.length) {
    throw new Error(`message count ${expected.values.length} != ${variedValues.length}`);
  }
  const expectedClass = collect(() => new ReferenceDecoder(referenceOptions).decodeMulti(variedBytes));
  const actualClass = collect(() => new ReplacementDecoder(replacementOptions).decodeMulti(variedBytes));
  equalOutcome(actualClass, expectedClass, "Decoder.decodeMulti");
});

check("empty buffer yields zero messages", () => {
  const empty = new Uint8Array();
  const expected = collect(() => referenceDecodeMulti(empty));
  const actual = collect(() => replacementDecodeMulti(empty));
  equalOutcome(actual, expected, "empty module");
  if (actual.error !== null || actual.values.length !== 0) {
    throw new Error(`empty outcome: ${JSON.stringify(actual)}`);
  }
  equalOutcome(
    collect(() => new ReplacementDecoder().decodeMulti(empty)),
    collect(() => new ReferenceDecoder().decodeMulti(empty)),
    "empty Decoder",
  );
});

check("single-message decoding is unchanged", () => {
  const single = referenceEncode({ hello: "world", list: [1, 2], when: new Date(0) });
  equal(
    replacementDecode(single),
    referenceDecode(single),
    "single decode",
  );
  const two = concat([single, referenceEncode("second")]);
  const expected = collect(() => [referenceDecode(two)]);
  const actual = collect(() => [replacementDecode(two)]);
  if (actual.values.length !== 0 || actual.error?.name !== "RangeError") {
    throw new Error(`single decode accepted multiple messages: ${JSON.stringify(actual)}`);
  }
  if (expected.error?.name !== "RangeError") {
    throw new Error(`reference single decode did not reject multiple messages`);
  }
  if (actual.error !== null && expected.error !== null && actual.error.name !== expected.error.name) {
    throw new Error(`single decode error category differs: ${JSON.stringify(actual.error)}`);
  }
});

const truncationTails = [
  referenceEncode({ nested: { values: [1, "two", new Uint8Array([3, 4])] } }),
  referenceEncode("a".repeat(300)),
  referenceEncode(new Uint8Array(300)),
  referenceEncode(Array.from({ length: 20 }, (_, index) => index)),
  referenceEncode(new Marker(filled(300, 9)), referenceOptions as never),
  referenceEncode(new Date(0x400000000 * 1000)),
];

check("truncated final message delivers complete messages and fails identically", () => {
  for (const tail of truncationTails) {
    for (let cut = 1; cut < tail.length; cut++) {
      const bytes = concat([referenceEncode(null), referenceEncode("prefix"), tail.subarray(0, cut)]);
      const expected = collect(() => referenceDecodeMulti(bytes, referenceOptions));
      const actual = collect(() => replacementDecodeMulti(bytes, replacementOptions));
      equalOutcome(actual, expected, `truncated at ${cut}`);
      if (actual.values.length !== 2) {
        throw new Error(`cut ${cut}: delivered ${actual.values.length} complete messages, expected 2`);
      }
      if (actual.error?.name !== "RangeError") {
        throw new Error(`cut ${cut}: expected RangeError, got ${JSON.stringify(actual.error)}`);
      }
      equalOutcome(
        collect(() => new ReplacementDecoder(replacementOptions).decodeMulti(bytes)),
        collect(() => new ReferenceDecoder(referenceOptions).decodeMulti(bytes)),
        `truncated at ${cut} (Decoder)`,
      );
    }
  }
});

interface DecodeOptions {
  name: string;
  values: unknown[];
  encodeOptions?: Record<string, unknown>;
  decodeOptions: Record<string, unknown>;
  referenceDecodeOptions?: Record<string, unknown>;
}

const bigIntValues = [0n, 1n, 123n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn, -1n, -0x8000000000000000n];
const optionScenarios: DecodeOptions[] = [
  {
    name: "extensionCodec and context",
    values: [new Marker(filled(1, 1)), { at: new Date(0), marker: new Marker(filled(300, 2)) }],
    encodeOptions: { extensionCodec: referenceCodec, context: { tag: "enc" } },
    decodeOptions: { extensionCodec: replacementCodec, context: { tag: "dec" } },
    referenceDecodeOptions: { extensionCodec: referenceCodec, context: { tag: "dec" } },
  },
  {
    name: "useBigInt64",
    values: bigIntValues,
    encodeOptions: { useBigInt64: true },
    decodeOptions: { useBigInt64: true },
  },
  {
    name: "rawStrings",
    values: [">", "héllo wörld — ✓ 😀", "", { key: "value", nested: ["inner"] }],
    decodeOptions: { rawStrings: true },
  },
  {
    name: "rawStrings leaves map keys decoded",
    values: [{ "héllo": "wörld", ascii: "value" }],
    decodeOptions: { rawStrings: true },
  },
  {
    name: "mapKeyConverter",
    values: [{ 1: "one", 2: "two" }, { 3: "three" }],
    decodeOptions: { mapKeyConverter: (key: unknown) => `k${String(key)}` },
  },
  {
    name: "keyDecoder null",
    values: [{ alpha: 1, beta: 2 }, { gamma: { delta: 3 } }],
    decodeOptions: { keyDecoder: null },
  },
  {
    name: "custom keyDecoder",
    values: [{ alpha: 1, "日本語": 2 }, { nested: { key: "value" } }],
    decodeOptions: {
      keyDecoder: {
        canBeCached: (byteLength: number) => byteLength > 0 && byteLength <= 16,
        decode: (bytes: Uint8Array, offset: number, length: number) =>
          "k:" + new TextDecoder().decode(bytes.subarray(offset, offset + length)),
      },
    },
  },
  {
    name: "combined options",
    values: [
      { key: "abc", big: 2n, when: new Date(0) },
      { list: [1, 2], raw: "xyz" },
    ],
    encodeOptions: { useBigInt64: true },
    decodeOptions: {
      useBigInt64: true,
      rawStrings: true,
      maxStrLength: 5,
      maxBinLength: 5,
      maxArrayLength: 5,
      maxMapLength: 5,
      maxExtLength: 5,
      mapKeyConverter: (key: unknown) => `m${String(key)}`,
      keyDecoder: null,
    },
  },
];

for (const scenario of optionScenarios) {
  check(`option ${scenario.name}`, () => {
    const bytes = encodeAll(scenario.values, scenario.encodeOptions);
    const referenceDecodeOptions = scenario.referenceDecodeOptions ?? scenario.decodeOptions;
    const expected = collect(() => referenceDecodeMulti(bytes, referenceDecodeOptions as never));
    const actual = collect(() => replacementDecodeMulti(bytes, scenario.decodeOptions));
    equalOutcome(actual, expected, scenario.name);
    equalOutcome(
      collect(() => new ReplacementDecoder(scenario.decodeOptions).decodeMulti(bytes)),
      collect(() => new ReferenceDecoder(referenceDecodeOptions as never).decodeMulti(bytes)),
      `${scenario.name} (Decoder)`,
    );
  });
}

interface LimitScenario {
  name: string;
  values: unknown[];
  option: string;
  limits: number[];
  encodeOptions?: Record<string, unknown>;
  decodeOptions?: Record<string, unknown>;
  referenceDecodeOptions?: Record<string, unknown>;
}

const limitScenarios: LimitScenario[] = [
  { name: "maxStrLength", values: ["", "a", "aaa", "a".repeat(32), "é", "日本語"], option: "maxStrLength", limits: [0, 1, 2, 3, 8, 9, 32] },
  { name: "maxBinLength", values: [new Uint8Array(0), new Uint8Array(1), new Uint8Array(3), new Uint8Array(256)], option: "maxBinLength", limits: [0, 1, 3, 255, 256] },
  { name: "maxArrayLength", values: [[], [1], [1, 2, 3], Array.from({ length: 16 }, (_, index) => index)], option: "maxArrayLength", limits: [0, 1, 2, 3, 16] },
  { name: "maxMapLength", values: [{}, { a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }], option: "maxMapLength", limits: [0, 1, 2, 3] },
  {
    name: "maxBinLength on extension payloads",
    values: [new Date(0), new Date(0x100000000 * 1000), new Date(-1000), new Marker(filled(16, 6))],
    option: "maxBinLength",
    limits: [0, 1, 3, 4, 7, 8, 11, 12, 16],
    encodeOptions: { extensionCodec: referenceCodec },
    decodeOptions: { extensionCodec: replacementCodec },
    referenceDecodeOptions: { extensionCodec: referenceCodec },
  },
  {
    name: "maxExtLength",
    values: [new Date(0), new Date(0x100000000 * 1000), new Date(-1000), new Marker(filled(16, 6))],
    option: "maxExtLength",
    limits: [0, 1, 3, 4, 7, 8, 11, 12, 16],
    encodeOptions: { extensionCodec: referenceCodec },
    decodeOptions: { extensionCodec: replacementCodec },
    referenceDecodeOptions: { extensionCodec: referenceCodec },
  },
];

for (const scenario of limitScenarios) {
  check(`limit ${scenario.name}`, () => {
    for (const value of scenario.values) {
      const bytes = concat([referenceEncode(1), referenceEncode(value, scenario.encodeOptions as never)]);
      for (const limit of scenario.limits) {
        const decodeOptions = { ...scenario.decodeOptions, [scenario.option]: limit };
        const referenceDecodeOptions = {
          ...(scenario.referenceDecodeOptions ?? scenario.decodeOptions),
          [scenario.option]: limit,
        };
        const expected = collect(() => referenceDecodeMulti(bytes, referenceDecodeOptions as never));
        const actual = collect(() => replacementDecodeMulti(bytes, decodeOptions));
        equalOutcome(actual, expected, `${scenario.name} ${limit}`);
        const classActual = collect(() => new ReplacementDecoder(decodeOptions).decodeMulti(bytes));
        const classExpected = collect(() => new ReferenceDecoder(referenceDecodeOptions as never).decodeMulti(bytes));
        equalOutcome(classActual, classExpected, `${scenario.name} ${limit} (Decoder)`);
      }
    }
  });
}

check("every documented decoding option is exercised", () => {
  const seen = new Set<string>();
  for (const scenario of optionScenarios) {
    for (const key of Object.keys(scenario.decodeOptions)) {
      seen.add(key);
    }
  }
  for (const scenario of limitScenarios) {
    seen.add(scenario.option);
  }
  const documented = [
    "extensionCodec",
    "context",
    "useBigInt64",
    "rawStrings",
    "maxStrLength",
    "maxBinLength",
    "maxArrayLength",
    "maxMapLength",
    "maxExtLength",
    "keyDecoder",
    "mapKeyConverter",
  ];
  const missing = documented.filter((option) => !seen.has(option));
  if (missing.length > 0) {
    throw new Error(`options not exercised through decodeMulti: ${missing.join(", ")}`);
  }
});

const report = {
  checks,
  passed: checks - failures.length,
  failed: failures.length,
  failures,
};

console.log(JSON.stringify(report, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
