import { decode as referenceDecode, encode as referenceEncode } from "msgpack-javascript-original";
import { decode, encode } from "@devboard/msgpack";

interface Case {
  name: string;
  value: unknown;
}

const cases: Case[] = [
  { name: "null", value: null },
  { name: "boolean", value: true },
  { name: "small int", value: 42 },
  { name: "large int", value: 1234567890123 },
  { name: "float", value: 1234.5678 },
  { name: "short string", value: "hello, msgpack" },
  { name: "medium string", value: "the quick brown fox jumps over the lazy dog ".repeat(5) },
  { name: "long string", value: "x".repeat(5000) },
  { name: "unicode string", value: "héllo wörld — 日本語 ✓ 😀 ".repeat(5) },
  { name: "binary 256", value: new Uint8Array(256).map((_, i) => i & 0xff) },
  { name: "binary 4096", value: new Uint8Array(4096).map((_, i) => i & 0xff) },
  { name: "small array", value: [1, 2, 3, "x", true] },
  { name: "integer array", value: Array.from({ length: 100 }, (_, i) => i * 3) },
  { name: "small map", value: { id: 7, name: "widget", ok: true } },
  { name: "large map", value: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, i])) },
  {
    name: "typical response",
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
      payload: new Uint8Array(64).map((_, i) => i),
    },
  },
  {
    name: "nested combinations",
    value: {
      items: Array.from({ length: 20 }, (_, i) => ({
        id: i,
        label: `item ${i}`,
        nested: { a: [i, i + 1, i + 2], b: { c: "value", d: i % 2 === 0 } },
        blob: new Uint8Array([i, i + 1]),
      })),
    },
  },
];

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 9);
const FILTER = process.env.BENCH_FILTER;

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function now(): number {
  return Bun.nanoseconds();
}

function iterationsFor(bytes: number): number {
  if (bytes <= 64) return 200_000;
  if (bytes <= 1024) return 100_000;
  if (bytes <= 16 * 1024) return 20_000;
  return 5_000;
}

function measure(fn: () => void, iterations: number): number {
  const start = now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return (now() - start) / iterations;
}

interface Result {
  name: string;
  bytes: number;
  encodeRef: number;
  encodeNew: number;
  decodeRef: number;
  decodeNew: number;
}

const results: Result[] = [];

for (const item of cases.filter((entry) => !FILTER || entry.name.includes(FILTER))) {
  const refBytes = referenceEncode(item.value);
  const newBytes = encode(item.value);
  if (refBytes.length !== newBytes.length) {
    throw new Error(`${item.name}: encoded length mismatch`);
  }
  for (let i = 0; i < refBytes.length; i++) {
    if (refBytes[i] !== newBytes[i]) {
      throw new Error(`${item.name}: encoded bytes mismatch at ${i}`);
    }
  }

  referenceDecode(refBytes);
  decode(refBytes);

  const iterations = iterationsFor(refBytes.length);

  // Warm both paths so the comparison measures steady-state work.
  for (let i = 0; i < 2; i++) {
    measure(() => referenceEncode(item.value), Math.max(1, iterations >> 2));
    measure(() => encode(item.value), Math.max(1, iterations >> 2));
    measure(() => referenceDecode(refBytes), Math.max(1, iterations >> 2));
    measure(() => decode(refBytes), Math.max(1, iterations >> 2));
  }

  const encodeRef: number[] = [];
  const encodeNew: number[] = [];
  const decodeRef: number[] = [];
  const decodeNew: number[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    if (round % 2 === 0) {
      encodeRef.push(measure(() => referenceEncode(item.value), iterations));
      encodeNew.push(measure(() => encode(item.value), iterations));
      decodeRef.push(measure(() => referenceDecode(refBytes), iterations));
      decodeNew.push(measure(() => decode(refBytes), iterations));
    } else {
      decodeNew.push(measure(() => decode(refBytes), iterations));
      decodeRef.push(measure(() => referenceDecode(refBytes), iterations));
      encodeNew.push(measure(() => encode(item.value), iterations));
      encodeRef.push(measure(() => referenceEncode(item.value), iterations));
    }
  }

  results.push({
    name: item.name,
    bytes: refBytes.length,
    encodeRef: median(encodeRef),
    encodeNew: median(encodeNew),
    decodeRef: median(decodeRef),
    decodeNew: median(decodeNew),
  });
}

function row(result: Result): string {
  const encRatio = result.encodeNew / result.encodeRef;
  const decRatio = result.decodeNew / result.decodeRef;
  return [
    result.name.padEnd(24),
    String(result.bytes).padStart(7),
    result.encodeRef.toFixed(0).padStart(10),
    result.encodeNew.toFixed(0).padStart(10),
    encRatio.toFixed(3).padStart(7),
    result.decodeRef.toFixed(0).padStart(10),
    result.decodeNew.toFixed(0).padStart(10),
    decRatio.toFixed(3).padStart(7),
  ].join("");
}

console.log(
  "case".padEnd(24) +
    "bytes".padStart(7) +
    "enc ref".padStart(10) +
    "enc new".padStart(10) +
    "ratio".padStart(7) +
    "dec ref".padStart(10) +
    "dec new".padStart(10) +
    "ratio".padStart(7),
);
for (const result of results) {
  console.log(row(result));
}

const slowEncode = results.filter((r) => r.encodeNew > r.encodeRef);
const slowDecode = results.filter((r) => r.decodeNew > r.decodeRef);
const fasterEncode = results.filter((r) => r.encodeNew < r.encodeRef);
const fasterDecode = results.filter((r) => r.decodeNew < r.decodeRef);

console.log("");
console.log(
  `encode: ${fasterEncode.length}/${results.length} faster, ` +
    `decode: ${fasterDecode.length}/${results.length} faster`,
);
if (slowEncode.length > 0) {
  console.log(`encode slower: ${slowEncode.map((r) => `${r.name} ${(r.encodeNew / r.encodeRef).toFixed(3)}x`).join(", ")}`);
}
if (slowDecode.length > 0) {
  console.log(`decode slower: ${slowDecode.map((r) => `${r.name} ${(r.decodeNew / r.decodeRef).toFixed(3)}x`).join(", ")}`);
}
if (slowEncode.length > 0 || slowDecode.length > 0) {
  process.exitCode = 1;
}
