import { timestampExtension } from "./timestamp.ts";

export type ExtensionEncoder = (
  object: unknown,
  context?: unknown,
) => Uint8Array | ((dataPos: number) => Uint8Array) | null | undefined;

export type ExtensionDecoder = (data: Uint8Array, extensionType: number, context?: unknown) => unknown;

export interface ExtensionCodecEntry {
  type: number;
  encode?: ExtensionEncoder;
  decode?: ExtensionDecoder;
}

/**
 * ExtData is used to handle extension types that are not registered to an
 * ExtensionCodec.
 */
export class ExtData {
  constructor(
    public readonly type: number,
    public readonly data: Uint8Array | ((pos: number) => Uint8Array),
  ) {}
}

export class ExtensionCodec {
  static readonly defaultCodec: ExtensionCodec = new ExtensionCodec();

  // Built-in extensions use negative types; custom extensions use types >= 0.
  private readonly builtInEncoders: (ExtensionEncoder | undefined)[] = [];
  private readonly builtInDecoders: (ExtensionDecoder | undefined)[] = [];
  private readonly encoders: (ExtensionEncoder | undefined)[] = [];
  private readonly decoders: (ExtensionDecoder | undefined)[] = [];

  constructor() {
    this.register(timestampExtension);
  }

  register({ type, encode, decode }: ExtensionCodecEntry): void {
    if (type >= 0) {
      this.encoders[type] = encode;
      this.decoders[type] = decode;
    } else {
      const index = -1 - type;
      this.builtInEncoders[index] = encode;
      this.builtInDecoders[index] = decode;
    }
  }

  tryToEncode(object: unknown, context?: unknown): ExtData | null {
    // Built-in extensions first, then custom extensions in type order.
    for (let i = 0; i < this.builtInEncoders.length; i++) {
      const encodeExt = this.builtInEncoders[i];
      if (encodeExt != null) {
        const data = encodeExt(object, context);
        if (data != null) {
          return new ExtData(-1 - i, data);
        }
      }
    }
    for (let i = 0; i < this.encoders.length; i++) {
      const encodeExt = this.encoders[i];
      if (encodeExt != null) {
        const data = encodeExt(object, context);
        if (data != null) {
          return new ExtData(i, data);
        }
      }
    }
    if (object instanceof ExtData) {
      // Keep ExtData as is.
      return object;
    }
    return null;
  }

  decode(data: Uint8Array, type: number, context?: unknown): unknown {
    const decodeExt = type < 0 ? this.builtInDecoders[-1 - type] : this.decoders[type];
    if (decodeExt) {
      return decodeExt(data, type, context);
    }
    // Decoding does not fail for unknown types; it returns ExtData instead.
    return new ExtData(type, data);
  }
}
