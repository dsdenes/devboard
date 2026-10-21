export class GeoPoint {
  constructor(
    public lat: number,
    public lon: number,
  ) {}
}

interface Registerable {
  register(entry: {
    type: number;
    encode: (object: unknown) => Uint8Array | null;
    decode: (data: Uint8Array) => unknown;
  }): void;
}

/** Registers the application's custom value type in its extension codec. */
export function installExtensionCodec(codec: Registerable): void {
  codec.register({
    type: 0x42,
    encode(object: unknown): Uint8Array | null {
      if (!(object instanceof GeoPoint)) {
        return null;
      }
      const data = new Uint8Array(16);
      const view = new DataView(data.buffer);
      view.setFloat64(0, object.lat);
      view.setFloat64(8, object.lon);
      return data;
    },
    decode(data: Uint8Array): GeoPoint {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return new GeoPoint(view.getFloat64(0), view.getFloat64(8));
    },
  });
}

export const fixtures: unknown[] = [
  null,
  true,
  false,
  0,
  42,
  -1234,
  1234567890123,
  3.25,
  "hello, msgpack",
  "héllo wörld — 日本語 ✓ 😀",
  new Uint8Array([0, 1, 2, 3, 255]),
  [1, "two", true, null, [3, 4]],
  { id: 1, name: "widget", ok: true, tags: ["a", "b"], meta: { depth: 2 } },
  {
    users: [
      { id: 1, name: "Ada", active: true, score: 99.5 },
      { id: 2, name: "Grace", active: false, score: 87.25 },
    ],
    cursor: null,
    blob: new Uint8Array(300).map((_, index) => index & 0xff),
  },
  new Date(0),
  new Date(1700000000123),
  new Date(-1),
  new GeoPoint(12.5, -7.25),
  [new Date(1000), new GeoPoint(1, 2)],
  {
    createdAt: new Date(1700000000000),
    location: new GeoPoint(-33.8688, 151.2093),
    trail: [new Date(0), new GeoPoint(0, 0), new Date(-1000)],
  },
];
