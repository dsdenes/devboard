import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import msgpackDefault, * as msgpackNamespace from "@dsdenes/msgpack";

/**
 * Checks the published module surface of @dsdenes/msgpack:
 *
 * - the default export's own enumerable properties are exactly the named
 *   runtime exports, each holding the same reference;
 * - CommonJS require, including its .default, exposes the same API;
 * - the package root and each documented subpath resolve under Node;
 * - a strict TypeScript consumer compiles with both import forms;
 * - `npm pack` ships exactly the intended files;
 * - encoding and decoding match msgpack-javascript 3.1.3 for a parity corpus.
 *
 * Set SURFACE_TARGET to a directory with @dsdenes/msgpack and
 * msgpack-javascript-original installed to check that install instead of this
 * repository's workspace. Artifact-only checks (manifest fields, tarball
 * contents, TypeScript consumer compile) run only for the workspace default.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targetDir = process.env.SURFACE_TARGET ? resolve(process.env.SURFACE_TARGET) : root;
const isWorkspaceTarget = targetDir === root;
const packageDir = join(root, "packages/msgpack");
const workDir = join(root, ".tmp/surface");
const problems: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    problems.push(message);
  }
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${context}: expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function run(
  command: string[],
  env: Record<string, string> = {},
  cwd = root,
): { code: number; stdout: string; output: string } {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout.toString();
  return {
    code: result.exitCode ?? -1,
    stdout,
    output: `${stdout}${result.stderr.toString()}`.trim(),
  };
}

// --- ESM default export -----------------------------------------------------

if (isWorkspaceTarget) {
  const named = Object.keys(msgpackNamespace).filter((key) => key !== "default");
  const fallback = record(msgpackDefault, "ESM default export");
  const fallbackKeys = Object.keys(fallback);
  check(
    named.every((key) => Object.prototype.propertyIsEnumerable.call(fallback, key)),
    "default export does not expose every named runtime export as an enumerable property",
  );
  check(
    fallbackKeys.length === named.length && named.every((key) => fallbackKeys.includes(key)),
    `default export keys differ from named exports: ${fallbackKeys.join(",")} != ${named.join(",")}`,
  );
  for (const key of named) {
    check(
      fallback[key] === (msgpackNamespace as Record<string, unknown>)[key],
      `default export property ${key} is not the same reference as the named export`,
    );
  }

  // --- CommonJS -------------------------------------------------------------

  const require = createRequire(import.meta.url);
  const commonJs = record(require("@dsdenes/msgpack"), "CommonJS require");
  const commonJsDefault = record(commonJs.default, "CommonJS require(...).default");
  check(commonJs.default !== undefined, "CommonJS require result has no default property");
  check(
    Object.keys(commonJsDefault).length === named.length &&
      named.every((key) => Object.prototype.propertyIsEnumerable.call(commonJsDefault, key)),
    "CommonJS .default does not expose the named API",
  );
  for (const key of named) {
    check(
      commonJsDefault[key] === commonJs[key],
      `CommonJS .default.${key} is not the same reference as require(...).${key}`,
    );
  }
}

// --- Node resolution and parity smoke --------------------------------------

const subpaths = [
  "@dsdenes/msgpack/package.json",
  "@dsdenes/msgpack/lib/index.mjs",
  "@dsdenes/msgpack/lib/index.cjs",
  "@dsdenes/msgpack/lib/index.d.ts",
  "@dsdenes/msgpack/lib/msgpack.js",
];

// The child resolves the package from a runtime-selected directory, so the
// module specifier cannot be a static import of this file.
const nodeScript = `
const { createRequire } = require("node:module");
const requireFromHere = createRequire(process.cwd() + "/index.cjs");
const paths = ${JSON.stringify(subpaths)};
const resolved = {};
for (const path of paths) {
  resolved[path] = requireFromHere.resolve(path);
}

class GeoPoint {
  constructor(lat, lon) {
    this.lat = lat;
    this.lon = lon;
  }
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function installCodec(codec) {
  codec.register({
    type: 0x42,
    encode(object) {
      if (!(object instanceof GeoPoint)) return null;
      const data = new Uint8Array(16);
      const view = new DataView(data.buffer);
      view.setFloat64(0, object.lat);
      view.setFloat64(8, object.lon);
      return data;
    },
    decode(data) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return new GeoPoint(view.getFloat64(0), view.getFloat64(8));
    },
  });
}

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return { __date: value.getTime() };
  if (value instanceof Uint8Array) return { __binary: hex(value) };
  if (value instanceof GeoPoint) return { __point: [value.lat, value.lon] };
  if (Array.isArray(value)) return value.map(canonical);
  const out = {};
  for (const key of Object.keys(value)) out[key] = canonical(value[key]);
  return out;
}

const values = [
  ["null", null],
  ["booleans", [true, false]],
  ["integers", [0, -1, 127, 128, -33, 65535, -70000, 4294967295, Number.MAX_SAFE_INTEGER]],
  ["floats", [3.25, -0.5, Number.MIN_VALUE]],
  ["strings", ["", "hello", "h\\u00e9llo w\\u00f6rld \\u2014 \\u65e5\\u672c\\u8a9e \\u2713 \\ud83d\\ude00"]],
  ["binary", new Uint8Array([0, 1, 2, 3, 254, 255])],
  ["arrays", [1, "two", true, null, [3, 4]]],
  ["maps", { id: 1, name: "widget", ok: true, tags: ["a", "b"] }],
  ["timestamps", [new Date(0), new Date(1700000000123), new Date(-1)]],
  ["extension", new GeoPoint(12.5, -7.25)],
];

(async () => {
  const root = await import("@dsdenes/msgpack");
  const esm = await import("@dsdenes/msgpack/lib/index.mjs");
  if (root.default.encode !== esm.encode) process.exitCode = 3;
  if (root.default.decode !== esm.decode) process.exitCode = 3;

  const cjs = requireFromHere("@dsdenes/msgpack");
  if (cjs.default.decode !== cjs.decode) process.exitCode = 4;
  if (cjs.default.Encoder !== cjs.Encoder) process.exitCode = 4;

  const reference = await import("msgpack-javascript-original");
  const replacementCodec = new root.ExtensionCodec();
  const referenceCodec = new reference.ExtensionCodec();
  installCodec(replacementCodec);
  installCodec(referenceCodec);

  let parity = 0;
  for (const [name, value] of values) {
    const referenceBytes = reference.encode(value, { extensionCodec: referenceCodec });
    const replacementBytes = root.encode(value, { extensionCodec: replacementCodec });
    if (hex(referenceBytes) !== hex(replacementBytes)) {
      process.stderr.write("byte mismatch: " + name + "\\n");
      process.exitCode = 5;
      continue;
    }
    const decodedReference = reference.decode(referenceBytes, { extensionCodec: referenceCodec });
    const decodedReplacement = root.decode(referenceBytes, { extensionCodec: replacementCodec });
    if (JSON.stringify(canonical(decodedReference)) !== JSON.stringify(canonical(decodedReplacement))) {
      process.stderr.write("value mismatch: " + name + "\\n");
      process.exitCode = 6;
      continue;
    }
    parity += 1;
  }

  const cjsParity =
    hex(cjs.encode(values[7][1], { extensionCodec: cjs.ExtensionCodec.defaultCodec })) ===
    hex(reference.encode(values[7][1]));
  if (!cjsParity) process.exitCode = 7;

  if (!process.exitCode) {
    console.log(JSON.stringify({ resolved, parity, cjsParity }));
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(2);
});
`;
const nodeResult = run(["node", "--input-type=commonjs", "-e", nodeScript], {}, targetDir);
check(nodeResult.code === 0, `Node surface/parity check failed: ${nodeResult.output}`);
let parityCount = 0;
if (nodeResult.code === 0) {
  const outcome = JSON.parse(nodeResult.stdout) as {
    resolved: Record<string, string>;
    parity: number;
    cjsParity: boolean;
  };
  parityCount = outcome.parity;
  for (const subpath of subpaths) {
    check(typeof outcome.resolved[subpath] === "string", `Node did not resolve ${subpath}`);
  }
  check(
    outcome.resolved["@dsdenes/msgpack/lib/index.d.ts"]?.endsWith("/lib/index.d.ts") === true,
    "the declaration file is not present at the resolved lib/index.d.ts",
  );
  check(outcome.parity === 10, `parity corpus covered ${outcome.parity}/10 values`);
  check(outcome.cjsParity, "CommonJS entry point does not encode like the reference");
}

const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
  name: string;
  version: string;
  license: string;
  exports: Record<string, unknown>;
  files: string[];
};
const expectedArtifactFiles = [
  "LICENSE",
  "README.md",
  "lib/index.cjs",
  "lib/index.d.ts",
  "lib/index.mjs",
  "lib/msgpack.js",
  "package.json",
];

if (isWorkspaceTarget) {
  check(manifest.name === "@dsdenes/msgpack", `package name is ${manifest.name}`);
  check(manifest.version === "1.0.0", `package version is ${manifest.version}`);
  check(manifest.license === "ISC", `package license is ${manifest.license}`);
  check(
    JSON.stringify(manifest.exports["."]) ===
      JSON.stringify({
        types: "./lib/index.d.ts",
        import: "./lib/index.mjs",
        require: "./lib/index.cjs",
      }),
    'exports["."] does not map to the conditional entry points',
  );
  check(manifest.exports["./package.json"] === "./package.json", "exports lacks ./package.json");
  check(manifest.exports["./lib/*"] === "./lib/*", "exports lacks ./lib/*");
  for (const file of ["lib", "README.md", "LICENSE"]) {
    check(manifest.files.includes(file), `files does not include ${file}`);
  }

  // --- Strict TypeScript consumer ------------------------------------------

  const consumerDir = join(workDir, "consumer");
  await rm(consumerDir, { recursive: true, force: true });
  await mkdir(consumerDir, { recursive: true });
  await writeFile(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM"],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          forceConsistentCasingInFileNames: true,
          types: [],
        },
        include: ["*.ts"],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(consumerDir, "default.ts"),
    `import msgpack from "@dsdenes/msgpack";

const bytes: Uint8Array = msgpack.encode({ value: 1, nested: [true, null] });
const decoded: unknown = msgpack.decode(bytes);
const encoder = new msgpack.Encoder({ sortKeys: true });
const decoder = new msgpack.Decoder({ rawStrings: true });
export const result = [decoded, encoder.encode(bytes), decoder.decode(bytes)];
`,
  );
  await writeFile(
    join(consumerDir, "named.ts"),
    `import { Decoder, Encoder, decode, encode, type DecoderOptions } from "@dsdenes/msgpack";

const options: DecoderOptions = { rawStrings: true };
const bytes: Uint8Array = encode({ value: 1 });
const value: unknown = decode(bytes, options);
export const result = [value, new Encoder().encode(bytes), new Decoder(options).decode(bytes)];
`,
  );
  const tsc = run([
    join(root, "node_modules/typescript/bin/tsc"),
    "-p",
    join(consumerDir, "tsconfig.json"),
  ]);
  check(tsc.code === 0, `strict TypeScript consumer failed to compile: ${tsc.output}`);

  // --- Tarball contents -----------------------------------------------------

  const npmrc = join(workDir, "empty.npmrc");
  await writeFile(npmrc, "");
  const pack = run(
    ["npm", "pack", packageDir, "--dry-run", "--json", "--pack-destination", workDir],
    {
      npm_config_cache: join(root, ".npm-cache"),
      npm_config_logs_dir: join(root, ".npm-logs"),
      npm_config_userconfig: npmrc,
      npm_config_update_notifier: "false",
    },
  );
  check(pack.code === 0, `npm pack --dry-run failed: ${pack.output}`);
  if (pack.code === 0) {
    const parsed = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
    const shipped = parsed[0]?.files?.map((file) => file.path).sort() ?? [];
    check(
      JSON.stringify(shipped) === JSON.stringify(expectedArtifactFiles),
      `tarball file list differs: ${shipped.join(", ")}`,
    );
    for (const path of shipped) {
      const allowed =
        path === "package.json" ||
        path === "README.md" ||
        path === "LICENSE" ||
        path.startsWith("lib/");
      check(allowed, `tarball includes unexpected file ${path}`);
    }
  }
}

console.log(
  JSON.stringify(
    {
      target: targetDir,
      subpaths: subpaths.length,
      parity: parityCount,
      artifactChecks: isWorkspaceTarget,
      problems,
    },
    null,
    2,
  ),
);

if (problems.length > 0) {
  process.exitCode = 1;
}
