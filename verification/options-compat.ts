/**
 * Application-facing verification for the documented encoding and decoding
 * options. Imports the built package by its public name, exactly as an
 * adopting application would, and compares every result with
 * msgpack-javascript 3.1.3.
 */
import { createRequire } from "node:module";
import {
  DecodeError as ReferenceDecodeError,
  decode as referenceDecode,
  encode as referenceEncode,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";
import {
  DecodeError,
  decode,
  Decoder,
  encode,
  Encoder,
  ExtensionCodec,
} from "@dsdenes/msgpack";

const require = createRequire(import.meta.url);
const commonJs = require("@dsdenes/msgpack") as {
  encode: typeof encode;
  decode: typeof decode;
  DecodeError: typeof DecodeError;
};

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
    failures.push({ check: name, message: error instanceof Error ? error.message : String(error) });
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function equalBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (hex(actual) !== hex(expected)) {
    throw new Error(`${label}: ${hex(actual)} != ${hex(expected)}`);
  }
}

function equalValue(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof actual !== typeof expected) {
    throw new Error(`${path}: types differ (${typeof actual} vs ${typeof expected})`);
  }
  if (typeof actual === "number" && typeof expected === "number") {
    if (!(Object.is(actual, expected) || actual === expected)) {
      throw new Error(`${path}: numbers differ (${actual} vs ${expected})`);
    }
    return;
  }
  if (actual === expected) {
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      throw new Error(`${path}: array shape differs`);
    }
    for (let i = 0; i < actual.length; i++) {
      equalValue(actual[i], expected[i], `${path}[${i}]`);
    }
    return;
  }
  if (actual instanceof Date || expected instanceof Date) {
    if (!(actual instanceof Date) || !(expected instanceof Date) || actual.getTime() !== expected.getTime()) {
      throw new Error(`${path}: dates differ`);
    }
    return;
  }
  if (actual instanceof Uint8Array || expected instanceof Uint8Array) {
    if (!(actual instanceof Uint8Array) || !(expected instanceof Uint8Array)) {
      throw new Error(`${path}: one side is not a Uint8Array`);
    }
    equalBytes(actual, expected, path);
    return;
  }
  if (typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null) {
    if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) {
      throw new Error(`${path}: prototypes differ`);
    }
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key) => !expectedKeys.includes(key))) {
      throw new Error(`${path}: keys differ (${actualKeys.join(",")} vs ${expectedKeys.join(",")})`);
    }
    for (const key of expectedKeys) {
      equalValue(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
    return;
  }
  throw new Error(`${path}: values differ (${String(actual)} vs ${String(expected)})`);
}

interface ErrorShape {
  name: string;
  constructor: string;
  message: string;
}

function errorShape(run: () => unknown): ErrorShape | null {
  try {
    run();
    return null;
  } catch (error) {
    const typed = error as Error;
    return { name: typed.name, constructor: typed.constructor.name, message: typed.message };
  }
}

function equalError(actual: ErrorShape | null, expected: ErrorShape | null, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: errors differ (${JSON.stringify(actual)} vs ${JSON.stringify(expected)})`);
  }
}

class Marker {
  constructor(public readonly payload: string) {}
}

const referenceCodec = new ReferenceExtensionCodec();
const replacementCodec = new ExtensionCodec();
const markerExtension = {
  type: 42,
  encode(object: unknown, context?: unknown): Uint8Array | null {
    if (!(object instanceof Marker)) {
      return null;
    }
    return new TextEncoder().encode(`${object.payload}:${(context as { tag?: string } | undefined)?.tag ?? ""}`);
  },
  decode(data: Uint8Array, _type: number, context?: unknown): Marker {
    const payload = new TextDecoder().decode(data);
    return new Marker(`${payload}:${(context as { tag?: string } | undefined)?.tag ?? ""}`);
  },
};
for (const codec of [referenceCodec, replacementCodec]) {
  codec.register(markerExtension);
}
const combinedCodec = new ExtensionCodec<{ tag: string }>();
combinedCodec.register(markerExtension);

function compareEncode(name: string, value: unknown, options: Record<string, unknown>, referenceOptions = options): void {
  check(name, () => {
    equalBytes(encode(value, options), referenceEncode(value, referenceOptions as never), name);
    equalBytes(new Encoder(options).encode(value), referenceEncode(value, referenceOptions as never), `${name} (Encoder)`);
    equalBytes(
      new Encoder(options).encodeSharedRef(value),
      referenceEncode(value, referenceOptions as never),
      `${name} (encodeSharedRef)`,
    );
  });
}

const referenceNamedOptions = { extensionCodec: referenceCodec };

compareEncode("option extensionCodec", { marker: new Marker("m") }, { extensionCodec: replacementCodec }, referenceNamedOptions);
compareEncode("option context", { marker: new Marker("m") }, { extensionCodec: replacementCodec, context: { tag: "ctx" } }, {
  extensionCodec: referenceCodec,
  context: { tag: "ctx" },
});
compareEncode(
  "option useBigInt64",
  [0n, 123n, 0x100000000n, -1n, -0x80000001n, 0x100000000, -0x80000001],
  { useBigInt64: true },
);
compareEncode(
  "option initialBufferSize",
  { text: "z".repeat(300), items: Array.from({ length: 30 }, (_, i) => i) },
  { initialBufferSize: 1 },
);
compareEncode(
  "option sortKeys",
  { b: 1, a: 2, "10": 3, "2": 4, nested: { z: true, y: [2, 1] } },
  { sortKeys: true },
);
compareEncode(
  "option forceFloat32",
  [1.5, -1.25, Math.PI, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 7],
  { forceFloat32: true },
);
compareEncode(
  "option forceIntegerToFloat",
  [0, -0, 1, -1, 0xffffffff, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
  { forceIntegerToFloat: true },
);
compareEncode(
  "option forceIntegerToFloat with forceFloat32",
  [0, 1, -1, 0xffffffff, Number.MAX_SAFE_INTEGER],
  { forceIntegerToFloat: true, forceFloat32: true },
);
compareEncode(
  "option ignoreUndefined",
  { a: 1, b: undefined, c: { d: undefined, e: 2 }, f: [undefined, 1] },
  { ignoreUndefined: true },
);

check("option maxDepth accepts at the limit", () => {
  const value = [[["leaf"]]];
  equalBytes(encode(value, { maxDepth: 4 }), referenceEncode(value, { maxDepth: 4 }), "maxDepth success");
});

check("option maxDepth rejects beyond the limit with the same error", () => {
  const value = [[["leaf"]]];
  const actual = errorShape(() => encode(value, { maxDepth: 3 }));
  const expected = errorShape(() => referenceEncode(value, { maxDepth: 3 }));
  equalError(actual, expected, "maxDepth");
  if (actual?.name !== "Error") {
    throw new Error(`maxDepth error category: ${actual?.name}`);
  }
});

const combinedValue = {
  zeta: undefined,
  big: 0x100000000n,
  alpha: { second: 2, first: 1.5 },
  numbers: [1, -1, 0x100000000, 2.25],
  marker: new Marker("combined"),
  when: new Date(1700000000123),
};

const combinedEncodeOptions = {
  extensionCodec: combinedCodec,
  context: { tag: "ctx" },
  useBigInt64: true,
  sortKeys: true,
  ignoreUndefined: true,
  forceFloat32: true,
  forceIntegerToFloat: true,
  maxDepth: 20,
};
const combinedReferenceEncodeOptions = { ...combinedEncodeOptions, extensionCodec: referenceCodec };

check("combined encoding options", () => {
  equalBytes(
    encode(combinedValue, combinedEncodeOptions),
    referenceEncode(combinedValue, combinedReferenceEncodeOptions as never),
    "combined encode",
  );
});

interface DecodeScenario {
  name: string;
  value: unknown;
  encodeOptions?: Record<string, unknown>;
  referenceEncodeOptions?: Record<string, unknown>;
  options: Record<string, unknown>;
  referenceOptions?: Record<string, unknown>;
}

const decodeScenarios: DecodeScenario[] = [
  {
    name: "option extensionCodec",
    value: { marker: new Marker("d") },
    encodeOptions: { extensionCodec: referenceCodec },
    options: { extensionCodec: replacementCodec },
    referenceOptions: { extensionCodec: referenceCodec },
  },
  {
    name: "option context",
    value: { marker: new Marker("d") },
    encodeOptions: { extensionCodec: referenceCodec, context: { tag: "ctx" } },
    options: { extensionCodec: replacementCodec, context: { tag: "ctx" } },
    referenceOptions: { extensionCodec: referenceCodec, context: { tag: "ctx" } },
  },
  {
    name: "option useBigInt64",
    value: [123n, 0x7fffffffffffffffn, -1n, -0x8000000000000000n, 1.5, 0xffffffff],
    encodeOptions: { useBigInt64: true },
    options: { useBigInt64: true },
  },
  {
    name: "option rawStrings",
    value: ["héllo", "", { key: "value", nested: ["inner"] }],
    options: { rawStrings: true },
  },
  {
    name: "option mapKeyConverter",
    value: { 1: "one", 2: "two" },
    options: { mapKeyConverter: (key: unknown) => `k${String(key)}` },
  },
];

for (const scenario of decodeScenarios) {
  check(scenario.name, () => {
    const bytes = referenceEncode(scenario.value, scenario.encodeOptions as never);
    const expected = referenceDecode(bytes, (scenario.referenceOptions ?? scenario.options) as never);
    equalValue(decode(bytes, scenario.options), expected, scenario.name);
    equalValue(new Decoder(scenario.options).decode(bytes), expected, `${scenario.name} (Decoder)`);
  });
}

function limitScenario(
  name: string,
  values: unknown[],
  option: string,
  limits: number[],
  encodeOptions?: Record<string, unknown>,
  decodeOptions?: Record<string, unknown>,
  referenceDecodeOptions?: Record<string, unknown>,
): void {
  check(name, () => {
    for (const value of values) {
      const bytes = referenceEncode(value, encodeOptions as never);
      for (const limit of limits) {
        const options = { ...decodeOptions, [option]: limit };
        const referenceOptions = { ...(referenceDecodeOptions ?? decodeOptions), [option]: limit };
        const actual = errorShape(() => decode(bytes, options));
        const expected = errorShape(() => referenceDecode(bytes, referenceOptions as never));
        equalError(actual, expected, `${name} limit ${limit}`);
        if (actual === null) {
          equalValue(decode(bytes, options), referenceDecode(bytes, referenceOptions as never), `${name} value`);
        } else if (actual.name !== "DecodeError") {
          throw new Error(`${name}: unexpected error category ${actual.name}`);
        }
      }
    }
  });
}

limitScenario("option maxStrLength", ["", "a", "aaa", "a".repeat(32), "é", "日本語"], "maxStrLength", [0, 1, 2, 3, 8, 9, 32]);
limitScenario("option maxBinLength", [new Uint8Array(0), new Uint8Array(1), new Uint8Array(3), new Uint8Array(256)], "maxBinLength", [0, 1, 3, 255, 256]);
limitScenario("option maxArrayLength", [[], [1], [1, 2, 3], Array.from({ length: 16 }, (_, i) => i)], "maxArrayLength", [0, 1, 2, 3, 16]);
limitScenario("option maxMapLength", [{}, { a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }], "maxMapLength", [0, 1, 2, 3]);
limitScenario(
  "option maxBinLength on extension payloads",
  [new Date(0), new Date(0x100000000 * 1000), new Date(-1000), new Marker("m")],
  "maxBinLength",
  [0, 1, 3, 4, 7, 8, 11, 12, 16],
  { extensionCodec: referenceCodec },
  { extensionCodec: replacementCodec },
  { extensionCodec: referenceCodec },
);
limitScenario(
  "option maxExtLength",
  [new Date(0), new Date(0x100000000 * 1000), new Date(-1000), new Marker("m")],
  "maxExtLength",
  [0, 1, 3, 4, 7, 8, 11, 12, 16],
  { extensionCodec: referenceCodec },
  { extensionCodec: replacementCodec },
  { extensionCodec: referenceCodec },
);

check("option rawStrings accepts invalid UTF-8", () => {
  const bytes = new Uint8Array([0xa3, 0xff, 0xfe, 0xfd]);
  equalValue(decode(bytes, { rawStrings: true }), referenceDecode(bytes, { rawStrings: true }), "raw invalid");
});

check("option rawStrings uses maxBinLength and keeps keys strings", () => {
  const bytes = referenceEncode({ k: "abcdef" });
  const actual = errorShape(() => decode(bytes, { rawStrings: true, maxBinLength: 5 }));
  const expected = errorShape(() => referenceDecode(bytes, { rawStrings: true, maxBinLength: 5 }));
  equalError(actual, expected, "rawStrings maxBinLength");
  equalValue(
    decode(bytes, { rawStrings: true, maxStrLength: 1 }),
    referenceDecode(bytes, { rawStrings: true, maxStrLength: 1 }),
    "rawStrings keys",
  );
});

check("option keyDecoder and keyDecoder null", () => {
  const bytes = referenceEncode({ alpha: 1, beta: { gamma: 2 } });
  let actualCalls = 0;
  let expectedCalls = 0;
  const actualDecoder = {
    canBeCached: () => true,
    decode: (bytes: Uint8Array, offset: number, length: number) => {
      actualCalls++;
      return `k:${new TextDecoder().decode(bytes.subarray(offset, offset + length))}`;
    },
  };
  const expectedDecoder = {
    canBeCached: () => true,
    decode: (bytes: Uint8Array, offset: number, length: number) => {
      expectedCalls++;
      return `k:${new TextDecoder().decode(bytes.subarray(offset, offset + length))}`;
    },
  };
  equalValue(decode(bytes, { keyDecoder: actualDecoder }), referenceDecode(bytes, { keyDecoder: expectedDecoder }), "keyDecoder");
  if (actualCalls === 0 || actualCalls !== expectedCalls) {
    throw new Error(`keyDecoder calls differ (${actualCalls} vs ${expectedCalls})`);
  }
  equalValue(decode(bytes, { keyDecoder: null }), referenceDecode(bytes, { keyDecoder: null }), "keyDecoder null");
});

check("default mapKeyConverter rejects with DecodeError", () => {
  const bytes = new Uint8Array([0x81, 0x90, 0x01]);
  const actual = errorShape(() => decode(bytes));
  const expected = errorShape(() => referenceDecode(bytes));
  equalError(actual, expected, "map key");
  if (actual?.name !== "DecodeError" || !(new DecodeError("x") instanceof Error)) {
    throw new Error(`DecodeError export/category mismatch: ${actual?.name}`);
  }
  if (!(new ReferenceDecodeError("x") instanceof Error)) {
    throw new Error("reference DecodeError unavailable");
  }
});

const combinedDecodeValue = {
  key: "abc",
  big: 2n,
  when: new Date(0),
  list: [1, 2],
  raw: "xyz",
};
const combinedDecodeBytes = referenceEncode(combinedDecodeValue, { useBigInt64: true });
const combinedDecodeOptions = {
  useBigInt64: true,
  rawStrings: true,
  maxStrLength: 5,
  maxBinLength: 5,
  maxArrayLength: 5,
  maxMapLength: 5,
  maxExtLength: 5,
  mapKeyConverter: (key: unknown) => `m${String(key)}`,
  keyDecoder: {
    canBeCached: (length: number) => length > 0,
    decode: (bytes: Uint8Array, offset: number, length: number) =>
      `k${new TextDecoder().decode(bytes.subarray(offset, offset + length))}`,
  },
};

check("combined decoding options", () => {
  equalValue(
    decode(combinedDecodeBytes, combinedDecodeOptions),
    referenceDecode(combinedDecodeBytes, combinedDecodeOptions as never),
    "combined decode",
  );
});

check("no options: encoding unchanged and equal to reference", () => {
  const values: unknown[] = [
    null,
    true,
    -1,
    1.5,
    "hello",
    new Uint8Array([1, 2, 255]),
    [1, "two", false],
    { b: 1, a: [2, 3], nested: { x: null } },
    new Date(1700000000123),
  ];
  for (const value of values) {
    equalBytes(encode(value), referenceEncode(value), `no-option encode ${String(value)}`);
  }
});

check("no options: decoding unchanged and equal to reference", () => {
  const values: unknown[] = [
    null,
    true,
    -1,
    1.5,
    "hello",
    new Uint8Array([1, 2, 255]),
    [1, "two", false],
    { b: 1, a: [2, 3], nested: { x: null } },
    new Date(1700000000123),
  ];
  for (const value of values) {
    const bytes = referenceEncode(value);
    equalValue(decode(bytes), referenceDecode(bytes), `no-option decode ${String(value)}`);
    equalValue(new Decoder().decode(bytes), referenceDecode(bytes), `no-option class decode ${String(value)}`);
  }
});

check("CommonJS entry point supports options", () => {
  const value = { b: 1, a: undefined, c: 2 };
  equalBytes(
    commonJs.encode(value, { sortKeys: true, ignoreUndefined: true }),
    referenceEncode(value, { sortKeys: true, ignoreUndefined: true }),
    "CommonJS encode",
  );
  const bytes = referenceEncode([1n], { useBigInt64: true });
  equalValue(commonJs.decode(bytes, { useBigInt64: true }), referenceDecode(bytes, { useBigInt64: true }), "CommonJS decode");
  if (new commonJs.DecodeError("x").name !== "DecodeError") {
    throw new Error("CommonJS DecodeError mismatch");
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
