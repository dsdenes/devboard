import { Decoder, Encoder, decode, encode } from "@msgpack/msgpack";
import { fixtures } from "./fixtures.ts";

declare global {
  interface Window {
    __result: unknown;
  }
}

// A browser application that already depended on msgpack-javascript. Its
// source is not edited when the dependency is swapped for the replacement.

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
  const bytes = encode(value);
  const decoded = decode(bytes);
  return {
    name,
    hex: hex(bytes),
    decoded: canonical(decoded),
    matchesInput: JSON.stringify(canonical(decoded)) === JSON.stringify(canonical(value)),
  };
});

const encoder = new Encoder();
const decoder = new Decoder();
const encoderBytes = encoder.encode(fixtures[9][1]);
const encoderSharedBytes = encoder.encodeSharedRef(fixtures[9][1]);
const decoderValue = decoder.decode(encoderSharedBytes);

const result = {
  moduleEncodeHex: hex(encoderBytes),
  sharedRefSame: hex(encoderSharedBytes) === hex(encoderBytes),
  classDecodeSame: JSON.stringify(canonical(decoderValue)) === JSON.stringify(canonical(fixtures[9][1])),
  cases,
};
window.__result = result;
document.getElementById("result")!.textContent = JSON.stringify(result, null, 2);
