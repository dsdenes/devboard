export interface Payload {
  name: string;
  value: unknown;
  /** The reference itself cannot round-trip this value (invalid Unicode). */
  skipInputComparison?: boolean;
}

function repeated(ch: string, length: number): string {
  return ch.repeat(length);
}

export const primitivePayloads: Payload[] = [
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "true", value: true },
  { name: "false", value: false },
  { name: "zero", value: 0 },
  { name: "negative zero", value: -0 },
  { name: "positive fixint max", value: 0x7f },
  { name: "uint8 min", value: 0x80 },
  { name: "uint8 max", value: 0xff },
  { name: "uint16 min", value: 0x100 },
  { name: "uint16 max", value: 0xffff },
  { name: "uint32 min", value: 0x10000 },
  { name: "uint32 max", value: 0xffffffff },
  { name: "uint64 first", value: 0x100000000 },
  { name: "max safe integer", value: Number.MAX_SAFE_INTEGER },
  { name: "negative fixint min", value: -0x20 },
  { name: "negative fixint below min", value: -0x21 },
  { name: "int8 min", value: -0x80 },
  { name: "int8 below min", value: -0x81 },
  { name: "int16 min", value: -0x8000 },
  { name: "int16 below min", value: -0x8001 },
  { name: "int32 min", value: -0x80000000 },
  { name: "int32 below min", value: -0x80000001 },
  { name: "min safe integer", value: Number.MIN_SAFE_INTEGER },
  { name: "float", value: 1.5 },
  { name: "negative float", value: -1.25 },
  { name: "small float", value: 5e-324 },
  { name: "large float", value: 1.7976931348623157e308 },
  { name: "NaN", value: Number.NaN },
  { name: "Infinity", value: Number.POSITIVE_INFINITY },
  { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
  { name: "empty string", value: "" },
  { name: "ascii short", value: "hello, msgpack" },
  { name: "fixstr max", value: repeated("a", 31) },
  { name: "str8 min", value: repeated("b", 32) },
  { name: "str8 max", value: repeated("c", 255) },
  { name: "str16 min", value: repeated("d", 256) },
  { name: "unicode", value: "héllo wörld — ✓ 😀" },
  { name: "cjk", value: "日本語のテキスト" },
  { name: "emoji surrogate pair", value: "😀😀😀" },
  { name: "lone surrogate", value: "\ud800" },
  { name: "lone surrogate boundary short", value: "a".repeat(49) + "\ud83d" },
  { name: "lone surrogate boundary long", value: "a".repeat(50) + "\ud83d", skipInputComparison: true },
  { name: "empty binary", value: new Uint8Array(0) },
  { name: "binary small", value: new Uint8Array([0, 1, 2, 255]) },
  { name: "binary bin8 max", value: new Uint8Array(255).fill(7) },
  { name: "binary bin16 min", value: new Uint8Array(256).fill(8) },
  { name: "empty array", value: [] },
  { name: "array small", value: [1, "two", true, null] },
  { name: "array fixarray max", value: Array.from({ length: 15 }, (_, i) => i) },
  { name: "array array16 min", value: Array.from({ length: 16 }, (_, i) => i) },
  { name: "empty map", value: {} },
  { name: "map small", value: { a: 1, b: "two", c: false, d: null } },
  {
    name: "map fixmap max",
    value: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i])),
  },
  {
    name: "map map16 min",
    value: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i])),
  },
];

export const nestedPayloads: Payload[] = [
  {
    name: "nested combinations",
    value: {
      id: 42,
      ok: true,
      tags: ["a", "b", "c"],
      profile: {
        name: "Ada Lovelace",
        score: 99.5,
        flags: [false, true, null],
        note: "unicode ✓",
      },
      binary: new Uint8Array([9, 8, 7, 6]),
    },
  },
  {
    name: "array of every in-scope type",
    value: [
      null,
      true,
      false,
      0,
      -1234,
      3.25,
      "",
      "text",
      "日本語",
      new Uint8Array([1, 2, 3]),
      [],
      {},
      [[1, [2, [3]]]],
      { a: { b: { c: [1, 2, 3] } } },
    ],
  },
  {
    name: "typical api response",
    value: {
      users: Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        name: `user-${i}`,
        active: i % 2 === 0,
        balance: i * 12.5,
        roles: ["reader", "writer"],
        metadata: { created: 1700000000000 + i, flags: { beta: i === 2 } },
      })),
      cursor: null,
      hasMore: false,
    },
  },
  {
    name: "binary inside nested map",
    value: {
      packet: {
        header: { version: 1, kind: "data" },
        body: new Uint8Array(300).map((_, i) => i & 0xff),
        trailers: [new Uint8Array([0]), new Uint8Array([255])],
      },
    },
  },
];

export const allPayloads = [...primitivePayloads, ...nestedPayloads];

export const binaryPayloads: Payload[] = [
  { name: "binary bin32 min", value: new Uint8Array(65536).map((_, i) => i & 0xff) },
  {
    name: "long ascii string str32 min",
    value: repeated("x", 65536),
  },
  {
    name: "array array32 min",
    value: Array.from({ length: 65536 }, (_, i) => i),
  },
];
