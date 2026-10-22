import { isDeepStrictEqual } from "node:util";
import {
  decode as referenceDecode,
  encode as referenceEncode,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";
import { decode, encode, ExtensionCodec } from "@dsdenes/msgpack";
import { cases, installPointCodec } from "./cases.ts";
import type { Case } from "./cases.ts";

const FILTER = process.env.BENCH_FILTER;
const SINGLE_CASE = process.env.BENCH_CASE;
const MODE = process.env.BENCH_MODE;

interface Sample {
  name: string;
  bytes: number;
  mode: "encode" | "decode";
  ref: number;
  next: number;
  ratio: number;
}

interface Result {
  name: string;
  bytes: number;
  encodeRef: number;
  encodeNew: number;
  encodeRatio: number;
  decodeRef: number;
  decodeNew: number;
  decodeRatio: number;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function measure(fn: () => void, iterations: number): number {
  const start = Bun.nanoseconds();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return (Bun.nanoseconds() - start) / iterations;
}

/** Distinguishable call cost for one operation, timer overhead included. */
function timeOne(fn: () => void): number {
  const start = Bun.nanoseconds();
  fn();
  return Bun.nanoseconds() - start;
}

function sample(item: Case, mode: "encode" | "decode"): Sample {
  const referenceCodec = new ReferenceExtensionCodec();
  installPointCodec(referenceCodec);
  const replacementCodec = new ExtensionCodec();
  installPointCodec(replacementCodec);

  const value = item.make();
  const refOptions = item.custom ? { extensionCodec: referenceCodec } : undefined;
  const newOptions = item.custom ? { extensionCodec: replacementCodec } : undefined;
  const runReferenceEncode = () => referenceEncode(value, refOptions);
  const runReplacementEncode = () => encode(value, newOptions);

  const refBytes = runReferenceEncode();
  const newBytes = runReplacementEncode();
  if (refBytes.length !== newBytes.length) {
    throw new Error(`${item.name}: encoded length mismatch`);
  }
  for (let i = 0; i < refBytes.length; i++) {
    if (refBytes[i] !== newBytes[i]) {
      throw new Error(`${item.name}: encoded bytes mismatch at ${i}`);
    }
  }

  const runReferenceDecode = () => referenceDecode(refBytes, refOptions);
  const runReplacementDecode = () => decode(refBytes, newOptions);
  if (!isDeepStrictEqual(runReferenceDecode(), runReplacementDecode())) {
    throw new Error(`${item.name}: decoded values differ`);
  }

  const runReference = mode === "encode" ? runReferenceEncode : runReferenceDecode;
  const runReplacement = mode === "encode" ? runReplacementEncode : runReplacementDecode;
  for (let i = 0; i < 2; i++) {
    measure(runReference, 500);
    measure(runReplacement, 500);
  }
  const pilot = measure(runReference, 500);
  const pairCount = Math.min(5000, Math.max(500, Math.round(800_000_000 / pilot)));

  for (let i = 0; i < 2; i++) {
    const warmup = Math.max(100, Math.min(pairCount, 2000));
    measure(runReference, warmup);
    measure(runReplacement, warmup);
  }
  Bun.gc(true);

  // Time one call at a time, alternating libraries so both see the same CPU
  // state. The median of adjacent pairs does not depend on which library got
  // a quiet millisecond, and slow operations get fewer pairs so one case
  // cannot dominate the run.
  const refTimes: number[] = [];
  const newTimes: number[] = [];
  const ratios: number[] = [];
  for (let i = 0; i < pairCount; i++) {
    let refTime: number;
    let newTime: number;
    if (i % 2 === 0) {
      refTime = timeOne(runReference);
      newTime = timeOne(runReplacement);
    } else {
      newTime = timeOne(runReplacement);
      refTime = timeOne(runReference);
    }
    refTimes.push(refTime);
    newTimes.push(newTime);
    ratios.push(newTime / refTime);
  }

  return {
    name: item.name,
    bytes: refBytes.length,
    mode,
    ref: median(refTimes),
    next: median(newTimes),
    ratio: median(ratios),
  };
}

function row(result: Result): string {
  return [
    result.name.padEnd(24),
    String(result.bytes).padStart(7),
    result.encodeRef.toFixed(0).padStart(10),
    result.encodeNew.toFixed(0).padStart(10),
    result.encodeRatio.toFixed(3).padStart(7),
    result.decodeRef.toFixed(0).padStart(10),
    result.decodeNew.toFixed(0).padStart(10),
    result.decodeRatio.toFixed(3).padStart(7),
  ].join("");
}

function decodeJson(stdout: Uint8Array): string {
  const output = new TextDecoder().decode(stdout).trim().split("\n");
  const line = output.filter((entry) => entry.startsWith("{")).at(-1);
  if (line === undefined) {
    throw new Error("benchmark child produced no result");
  }
  return line;
}

function runChild(item: Case, mode: "encode" | "decode"): Sample {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path],
    env: { ...process.env, BENCH_CASE: item.name, BENCH_MODE: mode, BENCH_FILTER: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    const stderr = new TextDecoder().decode(child.stderr).trim();
    const stdout = new TextDecoder().decode(child.stdout).trim();
    throw new Error(`${item.name} (${mode}) failed:\n${stderr || stdout}`);
  }
  return JSON.parse(decodeJson(child.stdout)) as Sample;
}

function runAll(): void {
  const selected = cases.filter((entry) => !FILTER || entry.name.includes(FILTER));
  const results: Result[] = [];

  for (const item of selected) {
    // Encoding and decoding run in separate processes so one operation's
    // allocations and JIT state cannot slow the other's measurement.
    const encoded = runChild(item, "encode");
    const decoded = runChild(item, "decode");
    results.push({
      name: item.name,
      bytes: encoded.bytes,
      encodeRef: encoded.ref,
      encodeNew: encoded.next,
      encodeRatio: encoded.ratio,
      decodeRef: decoded.ref,
      decodeNew: decoded.next,
      decodeRatio: decoded.ratio,
    });
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

  const slowEncode = results.filter((r) => r.encodeRatio >= 1);
  const slowDecode = results.filter((r) => r.decodeRatio >= 1);
  const fasterEncode = results.filter((r) => r.encodeRatio < 1);
  const fasterDecode = results.filter((r) => r.decodeRatio < 1);

  console.log("");
  console.log(
    `encode: ${fasterEncode.length}/${results.length} faster, ` +
      `decode: ${fasterDecode.length}/${results.length} faster`,
  );
  if (slowEncode.length > 0) {
    const list = slowEncode.map((r) => `${r.name} ${r.encodeRatio.toFixed(3)}x`).join(", ");
    console.log(`encode slower: ${list}`);
  }
  if (slowDecode.length > 0) {
    const list = slowDecode.map((r) => `${r.name} ${r.decodeRatio.toFixed(3)}x`).join(", ");
    console.log(`decode slower: ${list}`);
  }
  if (slowEncode.length > 0 || slowDecode.length > 0) {
    process.exitCode = 1;
  }
}

if (SINGLE_CASE) {
  const item = cases.find((entry) => entry.name === SINGLE_CASE);
  if (item === undefined) {
    throw new Error(`Unknown benchmark case: ${SINGLE_CASE}`);
  }
  const mode = MODE === "encode" || MODE === "decode" ? MODE : undefined;
  if (mode === undefined) {
    throw new Error("BENCH_MODE must be encode or decode");
  }
  // One process per case and operation: no JIT state, heap shape, or CPU
  // history leaks between unrelated payloads.
  Bun.gc(true);
  console.log(JSON.stringify(sample(item, mode)));
} else {
  runAll();
}
