import { describe, expect, test } from "bun:test";
import {
  decode as referenceDecode,
  decodeMulti as referenceDecodeMulti,
  encode as referenceEncode,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";
import {
  DecodeError,
  decode,
  decodeMulti,
  Decoder,
  encode,
  Encoder,
  ExtensionCodec,
} from "../packages/msgpack/src/index.ts";
import { customPayloads, installExtensionCodec, timestampPayloads } from "./extensions.ts";

const referenceCodec = new ReferenceExtensionCodec();
installExtensionCodec(referenceCodec);
const replacementCodec = new ExtensionCodec();
installExtensionCodec(replacementCodec);

type Options = Record<string, unknown>;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function assertSameValue(actual: unknown, expected: unknown, path = "$"): void {
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
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      throw new Error(`${path}: one side is not an array`);
    }
    if (actual.length !== expected.length) {
      throw new Error(`${path}: lengths differ (${actual.length} vs ${expected.length})`);
    }
    for (let i = 0; i < expected.length; i++) {
      assertSameValue(actual[i], expected[i], `${path}[${i}]`);
    }
    return;
  }
  if (expected instanceof Date || actual instanceof Date) {
    if (!(actual instanceof Date) || !(expected instanceof Date)) {
      throw new Error(`${path}: one side is not a Date`);
    }
    const actualTime = actual.getTime();
    const expectedTime = expected.getTime();
    if (!(actualTime === expectedTime || (Number.isNaN(actualTime) && Number.isNaN(expectedTime)))) {
      throw new Error(`${path}: dates differ (${actualTime} vs ${expectedTime})`);
    }
    return;
  }
  if (expected instanceof Uint8Array || actual instanceof Uint8Array) {
    if (!(actual instanceof Uint8Array) || !(expected instanceof Uint8Array)) {
      throw new Error(`${path}: one side is not a Uint8Array`);
    }
    if (!sameBytes(actual, expected)) {
      throw new Error(`${path}: binary bytes differ`);
    }
    return;
  }
  if (typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null) {
    if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) {
      throw new Error(`${path}: prototypes differ`);
    }
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    if (actualKeys.length !== expectedKeys.length) {
      throw new Error(`${path}: key counts differ`);
    }
    for (const key of expectedKeys) {
      if (!Object.prototype.hasOwnProperty.call(actual, key)) {
        throw new Error(`${path}: missing key ${key}`);
      }
      assertSameValue(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
    return;
  }
  throw new Error(`${path}: values differ (${String(actual)} vs ${String(expected)})`);
}

interface CapturedError {
  name: string;
  constructor: string;
  message: string;
}

function captureError(run: () => unknown): CapturedError | null {
  try {
    run();
    return null;
  } catch (error) {
    const typed = error as Error;
    return {
      name: typed.name,
      constructor: typed.constructor.name,
      message: typed.message,
    };
  }
}

function nestedArray(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  return value;
}

function nestedMap(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) {
    value = { child: value };
  }
  return value;
}

interface EncodeCase {
  name: string;
  value: unknown;
  options: Options;
}

const encodeCases: EncodeCase[] = [
  {
    name: "useBigInt64 bigints",
    value: [0n, 1n, 123n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn, -1n, -0x80000001n, -0x8000000000000000n],
    options: { useBigInt64: true },
  },
  {
    name: "useBigInt64 numbers outside 32-bit widths",
    value: [0x100000000, -0x80000001, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    options: { useBigInt64: true },
  },
  {
    name: "useBigInt64 with forceFloat32",
    value: [0x100000000, -0x80000001, 1.5],
    options: { useBigInt64: true, forceFloat32: true },
  },
  {
    name: "initialBufferSize",
    value: { text: "x".repeat(300), list: Array.from({ length: 40 }, (_, i) => i) },
    options: { initialBufferSize: 1 },
  },
  {
    name: "initialBufferSize large",
    value: { text: "y".repeat(50) },
    options: { initialBufferSize: 8192 },
  },
  {
    name: "sortKeys",
    value: { b: 1, a: 2, "10": 3, "2": 4, ü: 5, nested: { z: true, y: [3, 2, 1] } },
    options: { sortKeys: true },
  },
  {
    name: "forceFloat32",
    value: [1.5, -1.25, Math.PI, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
    options: { forceFloat32: true },
  },
  {
    name: "forceFloat32 leaves integers alone",
    value: [0, -0, 1, -1, 0x7f, 0xffffffff, Number.MAX_SAFE_INTEGER],
    options: { forceFloat32: true },
  },
  {
    name: "forceIntegerToFloat",
    value: [0, -0, 1, -1, 0x7f, 0x80, 0xffffffff, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    options: { forceIntegerToFloat: true },
  },
  {
    name: "forceIntegerToFloat with forceFloat32",
    value: [0, 1, -1, 0xffffffff, Number.MAX_SAFE_INTEGER],
    options: { forceIntegerToFloat: true, forceFloat32: true },
  },
  {
    name: "ignoreUndefined",
    value: { a: 1, b: undefined, c: { d: undefined, e: 2 }, f: [undefined, 1] },
    options: { ignoreUndefined: true },
  },
  {
    name: "ignoreUndefined with sortKeys",
    value: { z: undefined, c: 3, b: undefined, a: { y: undefined, x: 1 } },
    options: { ignoreUndefined: true, sortKeys: true },
  },
  {
    name: "combined encoder options",
    value: {
      zeta: undefined,
      big: 0x100000000n,
      alpha: { second: 2, first: 1.5 },
      numbers: [1, -1, 0x100000000, 2.25],
      point: customPayloads[0].value,
      when: new Date(1700000000123),
    },
    options: {
      extensionCodec: replacementCodec,
      useBigInt64: true,
      sortKeys: true,
      ignoreUndefined: true,
      forceFloat32: true,
      forceIntegerToFloat: true,
      maxDepth: 20,
    },
  },
];

describe("encoding options match msgpack-javascript", () => {
  for (const item of encodeCases) {
    test(item.name, () => {
      const referenceOptions = item.options.extensionCodec === replacementCodec
        ? { ...item.options, extensionCodec: referenceCodec }
        : item.options;
      const expected = referenceEncode(item.value, referenceOptions as never);
      expect(hex(encode(item.value, item.options))).toBe(hex(expected));
      expect(hex(new Encoder(item.options).encode(item.value))).toBe(hex(expected));
      expect(hex(new Encoder(item.options).encodeSharedRef(item.value))).toBe(hex(expected));
    });
  }

  test("maxDepth accepts the same nesting levels", () => {
    for (let limit = 0; limit <= 6; limit++) {
      for (let depth = 0; depth <= 6; depth++) {
        for (const value of [nestedArray(depth), nestedMap(depth)]) {
          const expectedError = captureError(() => referenceEncode(value, { maxDepth: limit }));
          const actualError = captureError(() => encode(value, { maxDepth: limit }));
          expect(actualError).toEqual(expectedError);
          if (expectedError === null) {
            expect(hex(encode(value, { maxDepth: limit }))).toBe(
              hex(referenceEncode(value, { maxDepth: limit })),
            );
          }
        }
      }
    }
  });

  test("timestamp and registered extensions keep working with options", () => {
    for (const payload of [...timestampPayloads, ...customPayloads]) {
      const options: Options = {
        extensionCodec: replacementCodec,
        sortKeys: true,
        ignoreUndefined: true,
        forceFloat32: true,
        forceIntegerToFloat: true,
        useBigInt64: true,
      };
      const referenceOptions = { ...options, extensionCodec: referenceCodec };
      expect(hex(encode(payload.value, options))).toBe(
        hex(referenceEncode(payload.value, referenceOptions as never)),
      );
    }
  });
});

interface DecodeCase {
  name: string;
  value: unknown;
  encodeOptions?: Options;
  options: Options;
  codec?: boolean;
}

const decodeCases: DecodeCase[] = [
  {
    name: "useBigInt64 int64 and uint64",
    value: [123n, 0x7fffffffffffffffn, -1n, -0x8000000000000000n, 1.5, 0xffffffff],
    encodeOptions: { useBigInt64: true },
    options: { useBigInt64: true },
  },
  {
    name: "useBigInt64 on default-encoded large numbers",
    value: [0x100000000, -0x80000001, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    options: { useBigInt64: true },
  },
  {
    name: "rawStrings",
    value: [">", "héllo wörld — ✓ 😀", "", { key: "value", nested: ["inner"] }],
    options: { rawStrings: true },
  },
  {
    name: "rawStrings leaves map keys decoded",
    value: { "héllo": "wörld", ascii: "value" },
    options: { rawStrings: true },
  },
  {
    name: "mapKeyConverter",
    value: { 1: "one", 2: "two" },
    options: { mapKeyConverter: (key: unknown) => `k${String(key)}` },
  },
  {
    name: "combined decoder options",
    value: {
      key: "abc",
      big: 2n,
      when: new Date(0),
      list: [1, 2],
      raw: "xyz",
    },
    encodeOptions: { useBigInt64: true },
    options: {
      useBigInt64: true,
      rawStrings: true,
      maxStrLength: 5,
      maxBinLength: 5,
      maxArrayLength: 5,
      maxMapLength: 5,
      maxExtLength: 5,
      keyDecoder: {
        canBeCached(byteLength: number) {
          return byteLength > 0;
        },
        decode(bytes: Uint8Array, offset: number, length: number) {
          return `key:${new TextDecoder().decode(bytes.subarray(offset, offset + length))}`;
        },
      },
    },
  },
];

describe("decoding options match msgpack-javascript", () => {
  for (const item of decodeCases) {
    test(item.name, () => {
      const bytes = referenceEncode(item.value, item.encodeOptions as never);
      const expected = referenceDecode(bytes, item.options as never);
      const actual = decode(bytes, item.options);
      assertSameValue(actual, expected);

      const classDecoded = new Decoder(item.options).decode(bytes);
      assertSameValue(classDecoded, expected);
    });
  }

  test("rawStrings accepts invalid UTF-8", () => {
    const value = new Uint8Array([0xa3, 0xff, 0xfe, 0xfd]);
    assertSameValue(
      decode(value, { rawStrings: true }),
      referenceDecode(value, { rawStrings: true }),
    );
    const map = new Uint8Array([0x81, 0xa3, 0xff, 0xfe, 0xfd, 0x01]);
    assertSameValue(decode(map), referenceDecode(map));
  });

  test("useBigInt64 converts 64-bit map keys to bigint keys", () => {
    const bytes = new Uint8Array([0x81, 0xcf, 0, 0, 0, 0, 0, 0, 0, 1, 0x01]);
    expect(captureError(() => referenceDecode(bytes, { useBigInt64: true }))).toEqual(
      captureError(() => decode(bytes, { useBigInt64: true })),
    );
    const options: Options = {
      useBigInt64: true,
      mapKeyConverter: (key: unknown) => String(key),
    };
    assertSameValue(
      decode(bytes, options),
      referenceDecode(bytes, options as never),
    );
  });

  test("default mapKeyConverter rejects unsupported keys with DecodeError", () => {
    // fixmap 1 -> fixarray 0 as the key, then value 1
    const bytes = new Uint8Array([0x81, 0x90, 0x01]);
    const expected = captureError(() => referenceDecode(bytes));
    const actual = captureError(() => decode(bytes));
    expect(actual).toEqual(expected);
    expect(actual?.name).toBe("DecodeError");
    expect(decode(bytes, { mapKeyConverter: () => "array" })).toEqual({ array: 1 });
    expect(new DecodeError("x").name).toBe("DecodeError");
  });

  test("custom and disabled key decoders", () => {
    const bytes = referenceEncode({ alpha: 1, beta: { gamma: 2 } });

    for (const prefix of ["", "cached:"]) {
      let referenceCalls = 0;
      let replacementCalls = 0;
      const referenceKeyDecoder = {
        canBeCached: (length: number) => length > 0,
        decode(bytes: Uint8Array, offset: number, length: number): string {
          referenceCalls++;
          return prefix + new TextDecoder().decode(bytes.subarray(offset, offset + length));
        },
      };
      const replacementKeyDecoder = {
        canBeCached: (length: number) => length > 0,
        decode(bytes: Uint8Array, offset: number, length: number): string {
          replacementCalls++;
          return prefix + new TextDecoder().decode(bytes.subarray(offset, offset + length));
        },
      };
      const expected = referenceDecode(bytes, { keyDecoder: referenceKeyDecoder });
      const actual = decode(bytes, { keyDecoder: replacementKeyDecoder });
      assertSameValue(actual, expected);
      expect(replacementCalls).toBe(referenceCalls);
    }

    assertSameValue(
      decode(bytes, { keyDecoder: null }),
      referenceDecode(bytes, { keyDecoder: null }),
    );
  });
});

describe("decoder maximum length options", () => {
  test("maxStrLength accepts the limit and rejects beyond it", () => {
    for (const limit of [0, 1, 2, 3, 4, 16, 32, 255]) {
      for (const length of [0, limit - 1, limit, limit + 1]) {
        if (length < 0) {
          continue;
        }
        const bytes = referenceEncode("a".repeat(length));
        const options = { maxStrLength: limit };
        expect(captureError(() => decode(bytes, options))).toEqual(
          captureError(() => referenceDecode(bytes, options)),
        );
      }
    }

    for (const [value, limit] of [["é", 1], ["é", 2], ["日本語", 8], ["日本語", 9]] as const) {
      const bytes = referenceEncode(value);
      expect(captureError(() => decode(bytes, { maxStrLength: limit }))).toEqual(
        captureError(() => referenceDecode(bytes, { maxStrLength: limit })),
      );
    }
  });

  test("maxStrLength applies to map keys", () => {
    const bytes = referenceEncode({ longkey: 1, a: 2 });
    for (const limit of [1, 6, 7]) {
      expect(captureError(() => decode(bytes, { maxStrLength: limit }))).toEqual(
        captureError(() => referenceDecode(bytes, { maxStrLength: limit })),
      );
    }
  });

  test("maxBinLength accepts the limit and rejects beyond it", () => {
    for (const limit of [0, 1, 3, 255, 256]) {
      for (const length of [0, limit - 1, limit, limit + 1]) {
        if (length < 0) {
          continue;
        }
        const bytes = referenceEncode(new Uint8Array(length).fill(7));
        const options = { maxBinLength: limit };
        expect(captureError(() => decode(bytes, options))).toEqual(
          captureError(() => referenceDecode(bytes, options)),
        );
      }
    }
  });

  test("raw strings are limited by maxBinLength, not maxStrLength", () => {
    const bytes = referenceEncode("abcdef");
    expect(captureError(() => decode(bytes, { rawStrings: true, maxBinLength: 5 }))).toEqual(
      captureError(() => referenceDecode(bytes, { rawStrings: true, maxBinLength: 5 })),
    );
    expect(captureError(() => decode(bytes, { rawStrings: true, maxStrLength: 0 }))).toBeNull();
    expect(captureError(() => referenceDecode(bytes, { rawStrings: true, maxStrLength: 0 }))).toBeNull();
    assertSameValue(
      decode(bytes, { rawStrings: true, maxStrLength: 0 }),
      referenceDecode(bytes, { rawStrings: true, maxStrLength: 0 }),
    );

    const keyed = referenceEncode({ abcdef: 1 });
    expect(captureError(() => decode(keyed, { rawStrings: true, maxStrLength: 5 }))).toEqual(
      captureError(() => referenceDecode(keyed, { rawStrings: true, maxStrLength: 5 })),
    );
  });

  test("maxArrayLength accepts the limit and rejects beyond it", () => {
    for (const limit of [0, 1, 2, 3, 15, 16]) {
      for (const length of [0, 1, limit - 1, limit, limit + 1]) {
        if (length < 0) {
          continue;
        }
        const bytes = referenceEncode(Array.from({ length }, (_, i) => i));
        const options = { maxArrayLength: limit };
        expect(captureError(() => decode(bytes, options))).toEqual(
          captureError(() => referenceDecode(bytes, options)),
        );
      }
    }
  });

  test("maxMapLength accepts the limit and rejects beyond it", () => {
    for (const limit of [0, 1, 2, 3, 15, 16]) {
      for (const length of [0, 1, limit - 1, limit, limit + 1]) {
        if (length < 0) {
          continue;
        }
        const value: Record<string, number> = {};
        for (let i = 0; i < length; i++) {
          value[`k${i}`] = i;
        }
        const bytes = referenceEncode(value);
        const options = { maxMapLength: limit };
        expect(captureError(() => decode(bytes, options))).toEqual(
          captureError(() => referenceDecode(bytes, options)),
        );
      }
    }
  });

  test("maxBinLength applies to extension payloads", () => {
    for (const value of [new Date(0), new Date(0x100000000 * 1000), new Date(-1000), customPayloads[3].value]) {
      const bytes = referenceEncode(value, { extensionCodec: referenceCodec });
      for (const limit of [0, 1, 2, 3, 4, 7, 8, 11, 12, 16]) {
        const options = { maxBinLength: limit, extensionCodec: replacementCodec };
        const referenceOptions = { maxBinLength: limit, extensionCodec: referenceCodec };
        expect(captureError(() => decode(bytes, options))).toEqual(
          captureError(() => referenceDecode(bytes, referenceOptions)),
        );
      }
    }
  });

  test("maxExtLength accepts the limit and rejects beyond it", () => {
    const values: unknown[] = [
      new Date(0),
      new Date(0x100000000 * 1000),
      new Date(-1000),
      ...customPayloads.slice(1, 9).map((payload) => payload.value),
    ];
    for (const value of values) {
      const bytes = referenceEncode(value, { extensionCodec: referenceCodec });
      for (const limit of [0, 1, 2, 3, 4, 7, 8, 11, 12, 16, 255, 256]) {
        const options = { maxExtLength: limit, extensionCodec: replacementCodec };
        const referenceOptions = { maxExtLength: limit, extensionCodec: referenceCodec };
        expect(captureError(() => decode(bytes, options))).toEqual(
          captureError(() => referenceDecode(bytes, referenceOptions)),
        );
      }
    }
  });
});

describe("no-option behavior is unchanged", () => {
  const value = {
    text: "unchanged",
    numbers: [0, -1, 0xffffffff, 1.5, Number.MAX_SAFE_INTEGER],
    binary: new Uint8Array([1, 2, 3]),
    nested: { list: [true, false, null] },
    when: new Date(1700000000123),
  };

  test("encoding without options still matches the reference", () => {
    expect(hex(encode(value))).toBe(hex(referenceEncode(value)));
    expect(hex(new Encoder().encode(value))).toBe(hex(referenceEncode(value)));
    expect(hex(new Encoder().encodeSharedRef(value))).toBe(hex(referenceEncode(value)));
  });

  test("decoding without options still matches the reference", () => {
    const bytes = referenceEncode(value);
    assertSameValue(decode(bytes), referenceDecode(bytes));
    assertSameValue(new Decoder().decode(bytes), referenceDecode(bytes));
  });
});

interface MultiOutcome {
  values: unknown[];
  error: CapturedError | null;
}

function captureMulti(run: () => Iterable<unknown>): MultiOutcome {
  const values: unknown[] = [];
  try {
    for (const value of run()) {
      values.push(value);
    }
    return { values, error: null };
  } catch (error) {
    return { values, error: captureError(() => { throw error; }) };
  }
}

function concatMessages(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function assertSameMultiOutcome(actual: MultiOutcome, expected: MultiOutcome, label: string): void {
  expect(actual.error).toEqual(expected.error);
  if (actual.error !== null) {
    return;
  }
  expect(actual.values.length).toBe(expected.values.length);
  for (let i = 0; i < expected.values.length; i++) {
    assertSameValue(actual.values[i], expected.values[i], `${label} $[${i}]`);
  }
}

describe("decoding options apply to multi-message decoding", () => {
  function check(
    name: string,
    values: unknown[],
    options: Options,
    encodeOptions: Options = {},
    referenceOptions: Options = options,
  ): void {
    test(name, () => {
      const bytes = concatMessages(values.map((value) => referenceEncode(value, encodeOptions as never)));
      const expected = captureMulti(() => referenceDecodeMulti(bytes, referenceOptions as never));
      const actual = captureMulti(() => decodeMulti(bytes, options));
      assertSameMultiOutcome(actual, expected, name);
      assertSameMultiOutcome(
        captureMulti(() => new Decoder(options).decodeMulti(bytes)),
        expected,
        `${name} (Decoder)`,
      );
    });
  }

  test("useBigInt64", () => {
    const values = [0n, 1n, -1n, 0xffffffffn, 0x100000000n, 1.5];
    const bytes = concatMessages(values.map((value) => referenceEncode(value, { useBigInt64: true })));
    const expected = captureMulti(() => referenceDecodeMulti(bytes, { useBigInt64: true }));
    assertSameMultiOutcome(
      captureMulti(() => decodeMulti(bytes, { useBigInt64: true })),
      expected,
      "useBigInt64",
    );
  });

  check(
    "extensionCodec and context",
    [customPayloads[0].value, { point: customPayloads[0].value, at: new Date(0) }],
    { extensionCodec: replacementCodec, context: { tag: "decode" } },
    { extensionCodec: referenceCodec },
    { extensionCodec: referenceCodec, context: { tag: "decode" } },
  );

  check(
    "rawStrings leaves map keys as strings",
    ["abc", { nested: ["value", ""] }, ["日本語", 1]],
    { rawStrings: true },
  );

  check(
    "mapKeyConverter and keyDecoder null",
    [{ 1: "one", 2: "two" }, { alpha: { beta: 1 } }],
    { mapKeyConverter: (key: unknown) => `k${String(key)}`, keyDecoder: null },
  );

  check(
    "custom keyDecoder",
    [{ alpha: 1, "日本語": 2 }, { nested: { key: "value" } }],
    {
      keyDecoder: {
        canBeCached: (byteLength: number) => byteLength > 0 && byteLength <= 16,
        decode: (bytes: Uint8Array, offset: number, length: number) =>
          "k:" + new TextDecoder().decode(bytes.subarray(offset, offset + length)),
      },
    },
  );

  test("length limits match the reference at and beyond each boundary", () => {
    const scenarios: Array<{ option: string; values: unknown[]; limits: number[]; encodeOptions?: Options }> = [
      {
        option: "maxStrLength",
        values: ["", "a", "aaa", "a".repeat(32), "é", "日本語"],
        limits: [0, 1, 2, 3, 8, 9, 32],
      },
      {
        option: "maxBinLength",
        values: [new Uint8Array(0), new Uint8Array(1), new Uint8Array(3), new Uint8Array(256)],
        limits: [0, 1, 3, 255, 256],
      },
      {
        option: "maxArrayLength",
        values: [[], [1], [1, 2, 3], Array.from({ length: 16 }, (_, index) => index)],
        limits: [0, 1, 2, 3, 16],
      },
      {
        option: "maxMapLength",
        values: [{}, { a: 1 }, { a: 1, b: 2 }],
        limits: [0, 1, 2],
      },
      {
        option: "maxExtLength",
        values: [new Date(0), new Date(0x100000000 * 1000), customPayloads[0].value],
        limits: [0, 1, 3, 4, 8, 11, 12, 16],
        encodeOptions: { extensionCodec: referenceCodec },
      },
    ];

    for (const scenario of scenarios) {
      const bytes = concatMessages(
        [referenceEncode(null), ...scenario.values.map((value) =>
          referenceEncode(value, { ...scenario.encodeOptions, extensionCodec: referenceCodec } as never)
        )],
      );
      for (const limit of scenario.limits) {
        const options = {
          extensionCodec: replacementCodec,
          [scenario.option]: limit,
        };
        const referenceOptions = {
          extensionCodec: referenceCodec,
          [scenario.option]: limit,
        };
        const expected = captureMulti(() => referenceDecodeMulti(bytes, referenceOptions as never));
        assertSameMultiOutcome(
          captureMulti(() => decodeMulti(bytes, options)),
          expected,
          `${scenario.option} ${limit}`,
        );
        assertSameMultiOutcome(
          captureMulti(() => new Decoder(options).decodeMulti(bytes)),
          expected,
          `${scenario.option} ${limit} (Decoder)`,
        );
      }
    }
  });

  check(
    "combined options",
    [
      { key: "abc", big: 2n, when: new Date(0) },
      { list: [1, 2], raw: "xyz" },
    ],
    {
      extensionCodec: replacementCodec,
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
    { useBigInt64: true },
    {
      extensionCodec: referenceCodec,
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
  );
});
