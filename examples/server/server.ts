import { Decoder, Encoder, ExtensionCodec, decode, encode } from "@msgpack/msgpack";
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
      const value = decoder.decode(body);
      return Response.json({ ok: true, kind: typeOf(value) });
    }

    if (url.pathname === "/encode" && request.method === "POST") {
      const payload = await request.json();
      const bytes = encoder.encode(payload);
      return new Response(bytes, {
        headers: { "content-type": "application/msgpack" },
      });
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

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof GeoPoint) return "point";
  if (typeof value === "object") return "map";
  return typeof value;
}

console.log(`PORT=${server.port}`);
