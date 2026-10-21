import { describe, expect, test } from "bun:test";
import {
  decodeArrayStream as referenceDecodeArrayStream,
  decodeAsync as referenceDecodeAsync,
  decodeMultiStream as referenceDecodeMultiStream,
  encode as referenceEncode,
  Decoder as ReferenceDecoder,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";
import {
  decodeArrayStream,
  decodeAsync,
  decodeMultiStream,
  Decoder,
  ExtensionCodec,
} from "../packages/msgpack/src/index.ts";
import { allPayloads, binaryPayloads } from "./payloads.ts";
import { extensionPayloads, installExtensionCodec } from "./extensions.ts";

const referenceCodec = new ReferenceExtensionCodec();
installExtensionCodec(referenceCodec);
const replacementCodec = new ExtensionCodec();
installExtensionCodec(replacementCodec);

const referenceOptions = { extensionCodec: referenceCodec };
const replacementOptions = { extensionCodec: replacementCodec };

interface Outcome {
  values: unknown[];
  error: { name: string; message: string } | null;
}

function canonical(value: unknown): unknown {
  if (value === undefined) {
    return { __undefined: true };
  }
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
  if (typeof value === "bigint") {
    return { __bigint: value.toString() };
  }
  if (value instanceof Date) {
    return { __date: Number.isNaN(value.getTime()) ? "NaN" : value.getTime() };
  }
  if (value instanceof Uint8Array) {
    return { __binary: Buffer.from(value).toString("hex") };
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    const prototype: { constructor?: { name?: string } } | null = Object.getPrototypeOf(value);
    const result: Record<string, unknown> = {
      __type: prototype?.constructor?.name ?? "null",
    };
    for (const [key, item] of Object.entries(value)) {
      result[key] = canonical(item);
    }
    return result;
  }
  return { __unsupported: typeof value };
}

async function collect(iterable: AsyncIterable<unknown>): Promise<Outcome> {
  const values: unknown[] = [];
  try {
    for await (const value of iterable) {
      values.push(canonical(value));
    }
    return { values, error: null };
  } catch (error) {
    const typed = error as Error;
    return { values, error: { name: typed.constructor.name, message: typed.message } };
  }
}

function chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    for (const part of parts) {
      yield part;
    }
  })();
}

async function asyncOutcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: canonical(await run()) };
  } catch (error) {
    return { error: { name: (error as Error).constructor.name, message: (error as Error).message } };
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function byteChunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    parts.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
  }
  return parts;
}

const streamValues: unknown[] = [
  ...allPayloads.map((payload) => payload.value).filter((value) => value !== undefined),
  ...binaryPayloads.map((payload) => payload.value),
  ...extensionPayloads.map((payload) => payload.value),
];
const messages = streamValues.map((value) => referenceEncode(value, referenceOptions));
const stream = concat(messages);

// Small messages keep every-boundary checks cheap; the full stream is checked
// at payload boundaries and with chunk sizes typical of a transport.
const compactValues: unknown[] = [
  null,
  true,
  false,
  42,
  -1234,
  1.5,
  "hello, msgpack",
  "a".repeat(32),
  new Uint8Array(0),
  new Uint8Array([1, 2, 3]),
  [1, "two", null],
  { a: 1, b: [2, 3] },
  new Date(0),
  extensionPayloads[0].value,
];
const compactMessages = compactValues.map((value) => referenceEncode(value, referenceOptions));
const compactStream = concat(compactMessages);

async function multiOutcome(
  parts: AsyncIterable<Uint8Array>,
  options: typeof referenceOptions | typeof replacementOptions,
  reference: boolean,
): Promise<Outcome> {
  return reference
    ? collect(referenceDecodeMultiStream(parts, options as typeof referenceOptions))
    : collect(decodeMultiStream(parts, options as typeof replacementOptions));
}

describe("decodeMultiStream", () => {
  test("decodes every message in order for a single chunk", async () => {
    const expected = await multiOutcome(chunks(stream), referenceOptions, true);
    const actual = await multiOutcome(chunks(stream), replacementOptions, false);
    expect(expected.error).toBeNull();
    expect(actual).toEqual(expected);
    expect(actual.values.length).toBe(streamValues.length);
  });

  test("decodes messages identically at every chunk boundary", async () => {
    for (let split = 0; split <= compactStream.length; split++) {
      const parts = [compactStream.subarray(0, split), compactStream.subarray(split)];
      const expected = await multiOutcome(chunks(...parts), referenceOptions, true);
      const actual = await multiOutcome(chunks(...parts), replacementOptions, false);
      expect(actual, `split at ${split}`).toEqual(expected);
    }
  });

  test("decodes the full stream across message boundaries", async () => {
    let offset = 0;
    for (const message of messages) {
      offset += message.length;
      for (const split of [offset - 1, offset]) {
        const parts = [stream.subarray(0, split), stream.subarray(split)];
        const expected = await multiOutcome(chunks(...parts), referenceOptions, true);
        const actual = await multiOutcome(chunks(...parts), replacementOptions, false);
        expect(actual, `split at ${split}`).toEqual(expected);
        expect(actual.error).toBeNull();
      }
    }
  });

  test("decodes messages identically for uneven chunk sizes", async () => {
    for (const size of [257, 1024, 4096]) {
      const expected = await multiOutcome(chunks(...byteChunks(stream, size)), referenceOptions, true);
      const actual = await multiOutcome(chunks(...byteChunks(stream, size)), replacementOptions, false);
      expect(actual, `chunks of ${size}`).toEqual(expected);
      expect(actual.error).toBeNull();
    }
    for (const size of [1, 2, 3, 5, 7]) {
      const expected = await multiOutcome(chunks(...byteChunks(compactStream, size)), referenceOptions, true);
      const actual = await multiOutcome(chunks(...byteChunks(compactStream, size)), replacementOptions, false);
      expect(actual, `compact chunks of ${size}`).toEqual(expected);
    }
  });

  test("one chunk of each message matches the same bytes in one buffer", async () => {
    const expected = await multiOutcome(chunks(stream), referenceOptions, true);
    const actual = await multiOutcome(chunks(...messages), replacementOptions, false);
    expect(actual).toEqual(expected);
  });

  test("empty stream and empty chunks yield no messages and no failure", async () => {
    for (const parts of [[], [new Uint8Array(0)], [new Uint8Array(0), new Uint8Array(0)]]) {
      const expected = await multiOutcome(chunks(...parts), referenceOptions, true);
      const actual = await multiOutcome(chunks(...parts), replacementOptions, false);
      expect(actual).toEqual(expected);
      expect(actual).toEqual({ values: [], error: null });
    }
  });

  test("a stream ending inside a message delivers complete messages, as the reference does", async () => {
    const prefix = messages.slice(0, 3);
    const tails = [messages[3], messages[messages.length - 1], referenceEncode("x".repeat(300), referenceOptions)];
    for (const tail of tails) {
      for (let cut = 1; cut < tail.length; cut++) {
        const parts = [...prefix, tail.subarray(0, cut)];
        const expected = await multiOutcome(chunks(...parts), referenceOptions, true);
        const actual = await multiOutcome(chunks(...parts), replacementOptions, false);
        expect(actual, `tail cut at ${cut}`).toEqual(expected);
        expect(actual.values.length).toBe(3);
      }
    }
  });

  test("Decoder.decodeStream matches the module function and reference", async () => {
    const parts = byteChunks(compactStream, 6);
    const expected = await collect(
      new ReferenceDecoder(referenceOptions).decodeStream(chunks(...parts)),
    );
    const actual = await collect(
      new Decoder(replacementOptions).decodeStream(chunks(...parts)),
    );
    expect(actual).toEqual(expected);
  });

  test("accepts a WHATWG ReadableStream", async () => {
    const parts = byteChunks(compactStream, 9);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });
    const expected = await multiOutcome(chunks(...parts), referenceOptions, true);
    const actual = await collect(decodeMultiStream(readable, replacementOptions));
    expect(actual).toEqual(expected);
  });

  test("accepts a ReadableStream without an async iterator", async () => {
    const parts = byteChunks(compactStream, 13);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });
    Object.defineProperty(readable, Symbol.asyncIterator, { value: undefined });
    const expected = await multiOutcome(chunks(...parts), referenceOptions, true);
    const actual = await collect(decodeMultiStream(readable, replacementOptions));
    expect(actual).toEqual(expected);
  });

  test("applies decoding options to every streamed message", async () => {
    const values = [
      { key: "value", raw: "héllo", big: 1n },
      [">", "héllo wörld — ✓ 😀"],
      new Date(1700000000123),
      extensionPayloads[0].value,
    ];
    const bytes = concat(
      values.map((value) => referenceEncode(value, { ...referenceOptions, useBigInt64: true })),
    );
    const expected = await collect(
      referenceDecodeMultiStream(chunks(...byteChunks(bytes, 4)), {
        extensionCodec: referenceCodec,
        useBigInt64: true,
        rawStrings: true,
      }),
    );
    const actual = await collect(
      decodeMultiStream(chunks(...byteChunks(bytes, 4)), {
        extensionCodec: replacementCodec,
        useBigInt64: true,
        rawStrings: true,
      }),
    );
    expect(actual).toEqual(expected);
  });

  test("rejects length limits like the reference during streaming", async () => {
    const bytes = concat([referenceEncode("prefix"), referenceEncode("x".repeat(40)), referenceEncode("suffix")]);
    const expected = await collect(
      referenceDecodeMultiStream(chunks(...byteChunks(bytes, 3)), { maxStrLength: 4 } as never),
    );
    const actual = await collect(
      decodeMultiStream(chunks(...byteChunks(bytes, 3)), { maxStrLength: 4 }),
    );
    expect(actual).toEqual(expected);
    expect(actual.error?.name).toBe("DecodeError");
  });
});

describe("decodeAsync", () => {
  const single = referenceEncode(
    { text: "héllo", list: [1, 2, 3], blob: new Uint8Array([4, 5, 6]), at: new Date(0) },
    referenceOptions,
  );

  test("decodes one message across every chunk boundary", async () => {
    for (let split = 0; split <= single.length; split++) {
      const parts = [single.subarray(0, split), single.subarray(split)];
      const expected = await asyncOutcome(() => referenceDecodeAsync(chunks(...parts), referenceOptions));
      const actual = await asyncOutcome(() => decodeAsync(chunks(...parts), replacementOptions));
      expect(actual, `split at ${split}`).toEqual(expected);
    }
  });

  test("empty and incomplete streams fail with the reference message", async () => {
    const cases: Uint8Array[][] = [
      [],
      [new Uint8Array(0)],
      [single.subarray(0, 1)],
      [single.subarray(0, single.length - 1)],
      [single.subarray(0, 3), single.subarray(3, 4)],
    ];
    for (const parts of cases) {
      const expected = await asyncOutcome(() => referenceDecodeAsync(chunks(...parts), referenceOptions));
      const actual = await asyncOutcome(() => decodeAsync(chunks(...parts), replacementOptions));
      expect(actual).toEqual(expected);
      expect(actual).toMatchObject({ error: { name: "RangeError" } });
    }
  });

  test("rejects extra bytes like the reference", async () => {
    const two = concat([single, referenceEncode("next", referenceOptions)]);
    const cases = [[two], [single, referenceEncode("next", referenceOptions)]];
    for (const parts of cases) {
      const expected = await asyncOutcome(() => referenceDecodeAsync(chunks(...parts), referenceOptions));
      const actual = await asyncOutcome(() => decodeAsync(chunks(...parts), replacementOptions));
      expect(actual).toEqual(expected);
      expect(actual).toMatchObject({ error: { name: "RangeError" } });
    }
  });
});

describe("decodeArrayStream", () => {
  test("yields array items identically at every chunk boundary", async () => {
    const array = referenceEncode(
      [1, "two", { three: [3, 4] }, new Uint8Array([5, 6]), new Date(0)],
      referenceOptions,
    );
    for (let split = 0; split <= array.length; split++) {
      const parts = [array.subarray(0, split), array.subarray(split)];
      const expected = await collect(referenceDecodeArrayStream(chunks(...parts), referenceOptions));
      const actual = await collect(decodeArrayStream(chunks(...parts), replacementOptions));
      expect(actual, `split at ${split}`).toEqual(expected);
    }
  });

  test("matches the reference for extra bytes and non-array headers", async () => {
    const cases = [
      [new Uint8Array([...referenceEncode([1, 2, 3])]), referenceEncode(9)],
      [concat([referenceEncode([1]), referenceEncode(9)])],
      [referenceEncode(null, referenceOptions)],
      [referenceEncode(42)],
      [referenceEncode([])],
      [concat([referenceEncode([]), referenceEncode(9)])],
      [new Uint8Array(0)],
    ];
    for (const parts of cases) {
      const expected = await collect(referenceDecodeArrayStream(chunks(...parts), referenceOptions));
      const actual = await collect(decodeArrayStream(chunks(...parts), replacementOptions));
      expect(actual, `parts of length ${parts.map((part) => part.length).join(",")}`).toEqual(expected);
    }
  });
});
