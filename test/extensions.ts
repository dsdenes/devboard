export interface Payload {
  name: string;
  value: unknown;
  /** The reference encodes an invalid Date as zero and decodes Date(0). */
  skipInputComparison?: boolean;
}

export class GeoPoint {
  constructor(
    public lat: number,
    public lon: number,
  ) {}
}

export class Blob {
  constructor(public bytes: Uint8Array) {}
}

interface Registerable {
  register(entry: {
    type: number;
    encode: (object: unknown) => Uint8Array | null;
    decode: (data: Uint8Array) => unknown;
  }): void;
}

/** Registers the same application types in either library's ExtensionCodec. */
export function installExtensionCodec(codec: Registerable): void {
  codec.register({
    type: 42,
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
  codec.register({
    type: 0,
    encode(object: unknown): Uint8Array | null {
      return object instanceof Blob ? object.bytes : null;
    },
    decode(data: Uint8Array): Blob {
      return new Blob(data);
    },
  });
  codec.register({
    type: 127,
    encode(object: unknown): Uint8Array | null {
      return object instanceof Blob ? object.bytes.slice().reverse() : null;
    },
    decode(data: Uint8Array): Blob {
      return new Blob(data.slice().reverse());
    },
  });
}

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

export const timestampPayloads: Payload[] = [
  { name: "timestamp epoch", value: new Date(0) },
  { name: "timestamp one millisecond", value: new Date(1) },
  { name: "timestamp 999 milliseconds", value: new Date(999) },
  { name: "timestamp one second", value: new Date(1000) },
  { name: "timestamp before epoch", value: new Date(-1) },
  { name: "timestamp one second before epoch", value: new Date(-1000) },
  { name: "timestamp 32 max", value: new Date((0x100000000 - 1) * 1000) },
  { name: "timestamp 64 first", value: new Date(0x100000000 * 1000) },
  { name: "timestamp 64 max", value: new Date((0x400000000 - 1) * 1000) },
  { name: "timestamp 96 first", value: new Date(0x400000000 * 1000) },
  { name: "timestamp date max", value: new Date(8640000000000000) },
  { name: "timestamp date min", value: new Date(-8640000000000000) },
  { name: "timestamp invalid date", value: new Date(Number.NaN), skipInputComparison: true },
  { name: "timestamp array", value: [new Date(1234567890123), new Date(-1)] },
  { name: "timestamp map", value: { created: new Date(1700000000000), updated: new Date(-500) } },
  {
    name: "timestamp nested",
    value: { events: [{ at: new Date(1000) }, { at: new Date(-1000) }], empty: [] },
  },
];

export const customPayloads: Payload[] = [
  { name: "custom fixext 16 point", value: new GeoPoint(12.5, -7.25) },
  { name: "custom ext 8 zero length", value: new Blob(filled(0, 0)) },
  { name: "custom fixext 1", value: new Blob(filled(1, 1)) },
  { name: "custom fixext 2", value: new Blob(filled(2, 2)) },
  { name: "custom ext 8 below fixext", value: new Blob(filled(3, 3)) },
  { name: "custom fixext 4", value: new Blob(filled(4, 4)) },
  { name: "custom fixext 16", value: new Blob(filled(16, 16)) },
  { name: "custom ext 8 first", value: new Blob(filled(17, 17)) },
  { name: "custom ext 8 max", value: new Blob(filled(255, 18)) },
  { name: "custom ext 16 first", value: new Blob(filled(256, 19)) },
  { name: "custom type 127", value: new Blob(filled(5, 20)) },
  { name: "custom in array", value: [new GeoPoint(1, 2), new Blob(filled(4, 9))] },
  { name: "custom in map", value: { point: new GeoPoint(3, 4), blob: new Blob(filled(8, 7)) } },
  {
    name: "custom and timestamp nested",
    value: {
      points: [new GeoPoint(5, 6), { at: new Date(1700000000123), blob: new Blob(filled(2, 1)) }],
      direct: new Date(0),
    },
  },
];

export const extensionPayloads = [...timestampPayloads, ...customPayloads];
