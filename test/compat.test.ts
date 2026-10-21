import { describe, expect, test } from "bun:test";
import {
  decode as referenceDecode,
  encode as referenceEncode,
  ExtData as ReferenceExtData,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";
import {
  decode,
  Decoder,
  encode,
  Encoder,
  ExtData,
  ExtensionCodec,
} from "../packages/msgpack/src/index.ts";
import { allPayloads, binaryPayloads } from "./payloads.ts";
import { customPayloads, extensionPayloads, installExtensionCodec, timestampPayloads } from "./extensions.ts";

const referenceCodec = new ReferenceExtensionCodec();
installExtensionCodec(referenceCodec);
const replacementCodec = new ExtensionCodec();
installExtensionCodec(replacementCodec);

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

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function assertSameValue(actual: unknown, expected: unknown, path = "$"): void {
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

describe("encoding identity with msgpack-javascript", () => {
  for (const payload of allPayloads) {
    test(payload.name, () => {
      const expected = referenceEncode(payload.value);
      const actual = encode(payload.value);
      expect(hex(actual)).toBe(hex(expected));
    });
  }

  for (const payload of binaryPayloads) {
    test(payload.name, () => {
      const expected = referenceEncode(payload.value);
      const actual = encode(payload.value);
      expect(hex(actual)).toBe(hex(expected));
    });
  }
});

describe("decoding identity with msgpack-javascript", () => {
  for (const payload of allPayloads) {
    test(payload.name, () => {
      const bytes = referenceEncode(payload.value);
      const expected = referenceDecode(bytes);
      const actual = decode(bytes);
      assertSameValue(actual, expected);
      if (payload.value !== undefined && !payload.skipInputComparison) {
        assertSameValue(actual, payload.value);
      }
    });
  }

  for (const payload of binaryPayloads) {
    test(payload.name, () => {
      const bytes = referenceEncode(payload.value);
      const expected = referenceDecode(bytes);
      const actual = decode(bytes);
      if (Buffer.isBuffer(expected)) {
        expect(actual).toBeInstanceOf(Uint8Array);
        expect(hex(actual as Uint8Array)).toBe(hex(expected));
        return;
      }
      assertSameValue(actual, expected);
    });
  }
});

describe("default timestamp extension", () => {
  for (const payload of timestampPayloads) {
    test(`${payload.name} encoding`, () => {
      expect(hex(encode(payload.value))).toBe(hex(referenceEncode(payload.value)));
    });

    test(`${payload.name} decoding`, () => {
      const bytes = referenceEncode(payload.value);
      const expected = referenceDecode(bytes);
      const actual = decode(bytes);
      assertSameValue(actual, expected);
      if (!payload.skipInputComparison) {
        assertSameValue(actual, payload.value);
      }
    });
  }
});

describe("registered extension encoding identity", () => {
  for (const payload of extensionPayloads) {
    test(payload.name, () => {
      const expected = referenceEncode(payload.value, { extensionCodec: referenceCodec });
      const actual = encode(payload.value, { extensionCodec: replacementCodec });
      expect(hex(actual)).toBe(hex(expected));
    });
  }
});

describe("registered extension decoding identity", () => {
  for (const payload of extensionPayloads) {
    test(payload.name, () => {
      const bytes = referenceEncode(payload.value, { extensionCodec: referenceCodec });
      const expected = referenceDecode(bytes, { extensionCodec: referenceCodec });
      const actual = decode(bytes, { extensionCodec: replacementCodec });
      assertSameValue(actual, expected);
      if (!payload.skipInputComparison) {
        assertSameValue(actual, payload.value);
      }
    });
  }
});

describe("unregistered extension values", () => {
  test("unknown types decode as ExtData", () => {
    const bytes = new Uint8Array([0xd4, 0x05, 0x2a]);
    const expected = referenceDecode(bytes) as ReferenceExtData;
    const actual = decode(bytes) as ExtData;
    expect(actual).toBeInstanceOf(ExtData);
    expect(actual.type).toBe(expected.type);
    expect(hex(actual.data as Uint8Array)).toBe(hex(expected.data as Uint8Array));
  });

  test("ExtData re-encodes with the same bytes", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(hex(encode(new ExtData(9, data)))).toBe(hex(referenceEncode(new ReferenceExtData(9, data))));
  });
});

describe("class API with extensions", () => {
  const value = {
    point: customPayloads[0].value,
    when: new Date(1700000000123),
    list: [new Date(0), customPayloads[1].value],
  };

  test("Encoder and Decoder accept an extension codec", () => {
    const encoder = new Encoder({ extensionCodec: replacementCodec });
    const decoder = new Decoder({ extensionCodec: replacementCodec });
    const bytes = encoder.encode(value);
    expect(hex(bytes)).toBe(hex(referenceEncode(value, { extensionCodec: referenceCodec })));
    assertSameValue(decoder.decode(bytes), referenceDecode(bytes, { extensionCodec: referenceCodec }));
  });
});

describe("class API and input forms", () => {
  const value = {
    hello: "world",
    list: [1, 2.5, true, null],
    binary: new Uint8Array([1, 2, 3]),
  };

  test("module encode returns a stable copy", () => {
    const first = encode({ first: 1 });
    const before = hex(first);
    encode({ second: 2 });
    expect(hex(first)).toBe(before);
  });

  test("Encoder.encode matches module encode", () => {
    const encoder = new Encoder();
    expect(hex(encoder.encode(value))).toBe(hex(referenceEncode(value)));
  });

  test("Encoder.encodeSharedRef matches module encode", () => {
    const encoder = new Encoder();
    expect(hex(encoder.encodeSharedRef(value))).toBe(hex(referenceEncode(value)));
  });

  test("Decoder.decode matches module decode", () => {
    const decoder = new Decoder();
    assertSameValue(decoder.decode(referenceEncode(value)), referenceDecode(referenceEncode(value)));
  });

  test("decodes ArrayBuffer input", () => {
    const bytes = referenceEncode(value);
    const buffer = bytes.slice().buffer;
    assertSameValue(decode(buffer), value);
  });

  test("decodes a view with a non-zero byte offset", () => {
    const bytes = referenceEncode(value);
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    assertSameValue(decode(padded.subarray(4, 4 + bytes.length)), value);
  });

  test("rejects trailing bytes", () => {
    const bytes = referenceEncode(value);
    const withExtra = new Uint8Array(bytes.length + 1);
    withExtra.set(bytes);
    expect(() => decode(withExtra)).toThrow(RangeError);
  });

  test("number map keys decode as object properties", () => {
    const bytes = referenceEncode({ 1: "one", 2: "two" });
    assertSameValue(decode(bytes), { 1: "one", 2: "two" });
  });
});
