export interface EncoderOptions {
  initialBufferSize?: number;
  [option: string]: unknown;
}

export interface DecoderOptions {
  [option: string]: unknown;
}

export declare class Encoder {
  constructor(options?: EncoderOptions);
  encode(value: unknown): Uint8Array<ArrayBuffer>;
  encodeSharedRef(value: unknown): Uint8Array<ArrayBuffer>;
}

export declare class Decoder {
  constructor(options?: DecoderOptions);
  decode(buffer: ArrayLike<number> | ArrayBufferView | ArrayBuffer): unknown;
}

export declare const DEFAULT_INITIAL_BUFFER_SIZE: number;

export declare function encode(value: unknown, options?: EncoderOptions): Uint8Array<ArrayBuffer>;
export declare function decode(
  buffer: ArrayLike<number> | ArrayBufferView | ArrayBuffer,
  options?: DecoderOptions,
): unknown;
