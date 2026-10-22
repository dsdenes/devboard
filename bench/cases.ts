export class BenchPoint {
  constructor(
    public lat: number,
    public lon: number,
  ) {}
}

export interface Registerable {
  register(entry: {
    type: number;
    encode: (object: unknown) => Uint8Array | null;
    decode: (data: Uint8Array) => unknown;
  }): void;
}

export function installPointCodec(codec: Registerable): void {
  codec.register({
    type: 0x42,
    encode(object: unknown): Uint8Array | null {
      if (!(object instanceof BenchPoint)) {
        return null;
      }
      const data = new Uint8Array(16);
      const view = new DataView(data.buffer);
      view.setFloat64(0, object.lat);
      view.setFloat64(8, object.lon);
      return data;
    },
    decode(data: Uint8Array): BenchPoint {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return new BenchPoint(view.getFloat64(0), view.getFloat64(8));
    },
  });
}

export interface Case {
  name: string;
  /** Built on demand so each case is measured in a process that only holds it. */
  make: () => unknown;
  custom?: boolean;
}

export const cases: Case[] = [
  { name: "null", make: () => null },
  { name: "boolean", make: () => true },
  { name: "small int", make: () => 42 },
  { name: "large int", make: () => 1234567890123 },
  { name: "float", make: () => 1234.5678 },
  { name: "short string", make: () => "hello, msgpack" },
  {
    name: "medium string",
    make: () => "the quick brown fox jumps over the lazy dog ".repeat(5),
  },
  { name: "long string", make: () => "x".repeat(5000) },
  {
    name: "unicode string",
    make: () => "héllo wörld — 日本語 ✓ 😀 ".repeat(5),
  },
  {
    name: "binary 256",
    make: () => new Uint8Array(256).map((_, i) => i & 0xff),
  },
  {
    name: "binary 4096",
    make: () => new Uint8Array(4096).map((_, i) => i & 0xff),
  },
  { name: "small array", make: () => [1, 2, 3, "x", true] },
  {
    name: "integer array",
    make: () => Array.from({ length: 100 }, (_, i) => i * 3),
  },
  { name: "small map", make: () => ({ id: 7, name: "widget", ok: true }) },
  {
    name: "large map",
    make: () => Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, i])),
  },
  {
    name: "typical response",
    make: () => ({
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
      payload: new Uint8Array(64).map((_, i) => i),
    }),
  },
  {
    name: "nested combinations",
    make: () => ({
      items: Array.from({ length: 20 }, (_, i) => ({
        id: i,
        label: `item ${i}`,
        nested: { a: [i, i + 1, i + 2], b: { c: "value", d: i % 2 === 0 } },
        blob: new Uint8Array([i, i + 1]),
      })),
    }),
  },
  { name: "timestamp", make: () => new Date(1700000000123) },
  { name: "timestamp before epoch", make: () => new Date(-1) },
  {
    name: "timestamp nested",
    make: () => ({
      createdAt: new Date(1700000000000),
      events: Array.from({ length: 10 }, (_, i) => ({ at: new Date(1700000000000 + i * 1000) })),
    }),
  },
  {
    name: "custom point",
    make: () => new BenchPoint(12.5, -7.25),
    custom: true,
  },
  {
    name: "custom nested",
    make: () => ({
      location: new BenchPoint(-33.8688, 151.2093),
      trail: Array.from({ length: 10 }, (_, i) => new BenchPoint(i * 0.5, i * -0.25)),
      at: new Date(1700000000123),
    }),
    custom: true,
  },
  {
    name: "custom array",
    make: () => Array.from({ length: 20 }, (_, i) => new BenchPoint(i, i + 1)),
    custom: true,
  },
  {
    name: "long ascii text",
    make: () => "The quick brown fox jumps over the lazy dog. ".repeat(2200),
  },
  {
    name: "long unicode text",
    make: () => "héllo wörld — 日本語のテキスト ✓ 😀 ".repeat(2500),
  },
  {
    name: "mostly ascii text",
    make: () => "a".repeat(100_000) + "✓",
  },
  {
    name: "binary 64KB",
    make: () => new Uint8Array(64 * 1024).map((_, i) => i & 0xff),
  },
  {
    name: "binary 256KB",
    make: () => new Uint8Array(256 * 1024).map((_, i) => (i * 31) & 0xff),
  },
  {
    name: "integer array 20K",
    make: () => Array.from({ length: 20_000 }, (_, i) => (i * 7919) & 0xffffff),
  },
  {
    name: "float array 8K",
    make: () => Array.from({ length: 8_000 }, (_, i) => i * 0.5 + 0.25),
  },
  {
    name: "large map 4K",
    make: () =>
      Object.fromEntries(
        Array.from({ length: 4_000 }, (_, i) => [`key${i}`, (i * 7919) & 0xffffff]),
      ),
  },
  {
    name: "nested response",
    make: () =>
      Array.from({ length: 300 }, (_, i) => ({
        id: i + 1,
        name: `user-${i}`,
        active: i % 2 === 0,
        balance: i * 12.5,
        roles: ["reader", "writer"],
        note: `record ${i} — ✓ 日本語`,
        metadata: { created: 1700000000000 + i, flags: { beta: i === 2 } },
        payload: new Uint8Array(256).fill(i & 0xff),
      })),
  },
  {
    name: "nested mixed",
    make: () => ({
      title: "combined payload — 日本語 ✓",
      text: "lorem ipsum dolor sit amet ".repeat(2000),
      blob: new Uint8Array(128 * 1024).map((_, i) => (i * 17) & 0xff),
      numbers: Array.from({ length: 5_000 }, (_, i) => (i * 104729) & 0xffffffff),
      items: Array.from({ length: 200 }, (_, i) => ({
        id: i,
        label: `item-${i}`,
        nested: { a: [i, i + 1, i + 2], b: { c: "value", d: i % 2 === 0 } },
      })),
    }),
  },
];
