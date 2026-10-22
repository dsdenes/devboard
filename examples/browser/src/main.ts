import {
  Decoder,
  Encoder,
  ExtensionCodec,
  decode,
  decodeArrayStream,
  decodeAsync,
  decodeMultiStream,
  encode,
} from "@dsdenes/msgpack";
import { fixtures, GeoPoint, installExtensionCodec, malformedCases } from "./fixtures.ts";

declare global {
  interface Window {
    __result: unknown;
  }
}

// A browser application that already depended on msgpack-javascript. Its
// source is not edited when the dependency is swapped for the replacement.

const extensionCodec = new ExtensionCodec();
installExtensionCodec(extensionCodec);

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { __number: "NaN" };
    if (value === Number.POSITIVE_INFINITY) return { __number: "Infinity" };
    if (value === Number.NEGATIVE_INFINITY) return { __number: "-Infinity" };
    if (Object.is(value, -0)) return { __number: "-0" };
    return value;
  }
  if (value instanceof Date) {
    return { __date: value.getTime() };
  }
  if (value instanceof GeoPoint) {
    return { __point: [value.lat, value.lon] };
  }
  if (value instanceof Uint8Array) {
    return { __binary: hex(value) };
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = canonical(value[key]);
    }
    return result;
  }
  return { __unsupported: typeof value };
}



const cases = fixtures.map(([name, value]) => {
  const bytes = encode(value, { extensionCodec });
  const decoded = decode(bytes, { extensionCodec });
  return {
    name,
    hex: hex(bytes),
    decoded: canonical(decoded),
    matchesInput: JSON.stringify(canonical(decoded)) === JSON.stringify(canonical(value)),
  };
});

const encoder = new Encoder({ extensionCodec });
const decoder = new Decoder({ extensionCodec });
const smallMap = fixtures.find(([name]) => name === "small map")![1];
const encoderBytes = encoder.encode(smallMap);
const encoderSharedBytes = encoder.encodeSharedRef(smallMap);
const decoderValue = decoder.decode(encoderSharedBytes);

function chunkStream(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
      offset += size;
    },
  });
}

async function* chunkIterable(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of iterable) {
    values.push(canonical(value));
  }
  return values;
}

// The browser application already kept a small map, and now also consumes
// consecutive messages incrementally from a byte stream whose chunk boundaries
// fall inside messages. Its source is not edited when the dependency changes.
async function runStreaming() {
  const names = ["small map", "small array", "binary", "timestamp epoch", "custom point", "extensions nested"];
  const selected = names.map((name) => {
    const entry = fixtures.find(([fixtureName]) => fixtureName === name);
    if (entry === undefined) {
      throw new Error(`missing fixture: ${name}`);
    }
    return entry[1];
  });
  const streamedMessages = selected.map((value) => encode(value, { extensionCodec }));
  const streamedBytes = concatBytes(streamedMessages);
  const truncatedBytes = concatBytes([
    ...streamedMessages,
    streamedMessages[0].subarray(0, 1),
  ]);

  return {
    values: await collect(decodeMultiStream(chunkStream(streamedBytes, 3), { extensionCodec })),
    empty: await collect(
      decodeMultiStream(chunkStream(new Uint8Array(0), 3), { extensionCodec }),
    ),
    truncated: await collect(
      decodeMultiStream(chunkStream(truncatedBytes, 3), { extensionCodec }),
    ),
    single: canonical(await decodeAsync(chunkStream(streamedMessages[0], 2), { extensionCodec })),
    array: await collect(
      decodeArrayStream(chunkStream(encode(selected[1], { extensionCodec }), 2), { extensionCodec }),
    ),
    classStream: await collect(
      new Decoder({ extensionCodec }).decodeStream(chunkIterable(streamedBytes, 5)),
    ),
  };
}

function describeError(error: unknown): { name: string; message: string } {
  const typed = error as Error;
  return { name: typed.name, message: String(typed.message) };
}

function decodeOutcome(bytes: Uint8Array) {
  try {
    return { ok: true, value: canonical(decode(bytes, { extensionCodec })) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

async function streamOutcome(
  bytes: Uint8Array,
  size: number,
  collect: (source: ReadableStream<Uint8Array>) => AsyncIterable<unknown>,
) {
  const values: unknown[] = [];
  try {
    for await (const value of collect(chunkStream(bytes, size))) {
      values.push(canonical(value));
    }
    return { values };
  } catch (error) {
    return { values, error: describeError(error) };
  }
}

async function singleOutcome(bytes: Uint8Array) {
  try {
    return { ok: true, value: canonical(await decodeAsync(chunkStream(bytes, 2), { extensionCodec })) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// Corrupted and externally produced bytes alongside the application's own
// payloads: the application reports the value it decoded or the failure it
// observed, so both outcomes are comparable after a dependency swap.
async function runMalformed() {
  const cases = [];
  for (const [name, bytes] of malformedCases) {
    cases.push({
      name,
      decode: decodeOutcome(bytes),
      multi: await streamOutcome(bytes, 2, (source) => decodeMultiStream(source, { extensionCodec })),
      array: await streamOutcome(bytes, 3, (source) => decodeArrayStream(source, { extensionCodec })),
      single: await singleOutcome(bytes),
    });
  }

  const valid = ["small map", "binary"].map((name) => {
    const entry = fixtures.find(([fixtureName]) => fixtureName === name);
    if (entry === undefined) {
      throw new Error(`missing fixture: ${name}`);
    }
    return encode(entry[1], { extensionCodec });
  });
  const validTail = valid[0].subarray(0, valid[0].length - 2);
  cases.push({
    name: "valid messages then a truncated tail",
    decode: decodeOutcome(concatBytes([...valid, validTail])),
    multi: await streamOutcome(
      concatBytes([...valid, validTail]),
      2,
      (source) => decodeMultiStream(source, { extensionCodec }),
    ),
    array: await streamOutcome(
      concatBytes([...valid, validTail]),
      3,
      (source) => decodeArrayStream(source, { extensionCodec }),
    ),
    single: await singleOutcome(concatBytes([...valid, validTail])),
  });

  return cases;
}

const result = {
  moduleEncodeHex: hex(encoderBytes),
  sharedRefSame: hex(encoderSharedBytes) === hex(encoderBytes),
  classDecodeSame: JSON.stringify(canonical(decoderValue)) === JSON.stringify(canonical(smallMap)),
  cases,
  streaming: await runStreaming(),
  malformed: await runMalformed(),
};
window.__result = result;
document.getElementById("result")!.textContent = JSON.stringify(result, null, 2);
