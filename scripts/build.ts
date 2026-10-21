import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const outDir = join(root, "lib");
await mkdir(outDir, { recursive: true });

const targets = [
  { format: "esm", outfile: "lib/index.mjs" },
  { format: "cjs", outfile: "lib/index.cjs" },
] as const;

for (const target of targets) {
  const result = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    outdir: outDir,
    naming: target.outfile.slice("lib/".length),
    format: target.format,
    target: "browser",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

const declarations = `export interface EncoderOptions {
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
`;

await writeFile(join(outDir, "index.d.ts"), declarations);
console.log("built lib/index.mjs, lib/index.cjs, lib/index.d.ts");
