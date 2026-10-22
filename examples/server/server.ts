import { Decoder, Encoder, ExtensionCodec, decode, decodeMultiStream, encode } from "@dsdenes/msgpack";
import { fixtures, GeoPoint, installExtensionCodec } from "./fixtures.ts";

// A small application that already depended on msgpack-javascript. Its source
// is not edited when the dependency is swapped for the replacement.
const extensionCodec = new ExtensionCodec();
installExtensionCodec(extensionCodec);

const decoder = new Decoder({ extensionCodec });
const encoder = new Encoder({ extensionCodec });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/fixtures") {
      return new Response(encode(fixtures, { extensionCodec }), {
        headers: { "content-type": "application/msgpack" },
      });
    }

    if (url.pathname === "/decode" && request.method === "POST") {
      const body = new Uint8Array(await request.arrayBuffer());
      try {
        const value = decoder.decode(body);
        return Response.json({ ok: true, kind: typeOf(value), value: describeValue(value) });
      } catch (error) {
        return Response.json({ ok: false, error: describeError(error) });
      }
    }

    if (url.pathname === "/multi" && request.method === "POST") {
      const body = new Uint8Array(await request.arrayBuffer());
      const values: unknown[] = [];
      try {
        for (const value of decoder.decodeMulti(body)) {
          values.push(describeValue(value));
        }
        return Response.json({ values });
      } catch (error) {
        return Response.json({ values, error: describeError(error) });
      }
    }

    if (url.pathname === "/encode" && request.method === "POST") {
      const payload = await request.json();
      const bytes = encoder.encode(payload);
      return new Response(bytes, {
        headers: { "content-type": "application/msgpack" },
      });
    }

    if (url.pathname === "/stream" && request.method === "POST") {
      // The request body is a byte stream holding consecutive messages. The
      // application consumes it incrementally, with boundaries inside messages.
      const body = new Uint8Array(await request.arrayBuffer());
      const values: unknown[] = [];
      try {
        for await (const value of decodeMultiStream(chunked(body, 3), { extensionCodec })) {
          values.push(describeValue(value));
        }
        return Response.json({ values });
      } catch (error) {
        return Response.json({ values, error: describeError(error) });
      }
    }

    if (url.pathname === "/roundtrip" && request.method === "POST") {
      const body = new Uint8Array(await request.arrayBuffer());
      const value = decode(body, { extensionCodec });
      return new Response(encode(value, { extensionCodec }), {
        headers: { "content-type": "application/msgpack" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

function describeError(error: unknown): { name: string; message: string } {
  const typed = error as Error;
  return { name: typed.name, message: String(typed.message) };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof GeoPoint) return "point";
  if (typeof value === "object") return "map";
  return typeof value;
}

async function* chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

function describeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return { date: value.getTime() };
  }
  if (value instanceof GeoPoint) {
    return { point: [value.lat, value.lon] };
  }
  if (value instanceof Uint8Array) {
    let encoded = "";
    for (const byte of value) {
      encoded += byte.toString(16).padStart(2, "0");
    }
    return { binary: encoded };
  }
  if (Array.isArray(value)) {
    return value.map(describeValue);
  }
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    record[key] = describeValue(item);
  }
  return record;
}

console.log(`PORT=${server.port}`);
