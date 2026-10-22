import { createHash } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  decode as referenceDecode,
  decodeMulti as referenceDecodeMulti,
  decodeMultiStream as referenceDecodeMultiStream,
  encode as referenceEncode,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";
import {
  fixtures,
  GeoPoint,
  installExtensionCodec,
  malformedCases,
} from "../examples/server/fixtures.ts";

const referenceCodec = new ReferenceExtensionCodec();
installExtensionCodec(referenceCodec);

const root = dirname(import.meta.dir);
const appDir = join(root, "examples/server");
const packageDir = join(root, "packages/msgpack");
const appName = appDir.slice(appDir.lastIndexOf("/") + 1);
const copyDir = (variant: "baseline" | "replacement") =>
  join(root, ".tmp/adoption", `${appName}-${variant}`);
const sourceFiles = ["server.ts", "fixtures.ts"];
const ORIGINAL_NAME = "@msgpack/msgpack";
const ORIGINAL_SPEC = "npm:@msgpack/msgpack@3.1.3";
const REPLACEMENT_NAME = "@dsdenes/msgpack";

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function sourceHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of sourceFiles) {
    hashes[file] = await sha256(join(appDir, file));
  }
  return hashes;
}

/**
 * Copies the application into a generated directory, rewrites the package
 * specifier in the baseline copy only, installs the dependency for that
 * variant, and returns the copy directory. The checked-in application is
 * never modified: the baseline runs exactly the same source with only the
 * specifier changed.
 */
async function makeApp(variant: "baseline" | "replacement"): Promise<string> {
  const dir = copyDir(variant);
  await rm(dir, { recursive: true, force: true });
  await cp(appDir, dir, {
    recursive: true,
    filter: (source) => {
      const rel = relative(appDir, source);
      return (
        rel === "" ||
        (!rel.startsWith("node_modules") && !rel.startsWith("dist") && rel !== "bun.lock")
      );
    },
  });

  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  delete manifest.dependencies[ORIGINAL_NAME];
  delete manifest.dependencies[REPLACEMENT_NAME];
  if (variant === "baseline") {
    manifest.dependencies[ORIGINAL_NAME] = ORIGINAL_SPEC;
    let rewrites = 0;
    for (const file of sourceFiles) {
      const path = join(dir, file);
      const text = await readFile(path, "utf8");
      if (!text.includes(REPLACEMENT_NAME)) {
        continue;
      }
      rewrites += text.split(REPLACEMENT_NAME).length - 1;
      await writeFile(path, text.split(REPLACEMENT_NAME).join(ORIGINAL_NAME));
    }
    if (rewrites === 0) {
      throw new Error(`no source file imports ${REPLACEMENT_NAME}`);
    }
  } else {
    manifest.dependencies[REPLACEMENT_NAME] = `file:${relative(dir, packageDir)}`;
  }
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  const install = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (install.exitCode !== 0) {
    throw new Error(`bun install failed for ${variant}: ${install.stderr.toString()}`);
  }
  return dir;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
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
  if (value instanceof Date) {
    return { __date: value.getTime() };
  }
  if (value instanceof GeoPoint) {
    return { __point: [value.lat, value.lon] };
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

function sameValue(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

async function startServer(cwd: string): Promise<{ url: string; stop: () => void }> {
  const process = Bun.spawn(["bun", "run", "server.ts"], {
    cwd,
    env: { ...Bun.env, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let buffered = "";
  const reader = process.stdout.getReader();
  const timer = setTimeout(() => process.kill(), 15_000);
  let port = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      clearTimeout(timer);
      throw new Error(`server exited before listening: ${await new Response(process.stderr).text()}`);
    }
    buffered += decoder.decode(value, { stream: true });
    const match = buffered.match(/PORT=(\d+)/);
    if (match) {
      clearTimeout(timer);
      port = Number(match[1]);
      break;
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      process.kill();
    },
  };
}

interface Step {
  name: string;
  ok: boolean;
  detail?: string;
}

async function postBytes(url: string, body: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { method: "POST", body });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

interface StreamPayload {
  values: unknown[];
  error?: { name: string; message: string };
}

async function postStream(url: string, body: Uint8Array<ArrayBuffer>): Promise<StreamPayload> {
  const response = await fetch(`${url}/stream`, { method: "POST", body });
  if (!response.ok) {
    throw new Error(`${url}/stream returned ${response.status}`);
  }
  return response.json() as Promise<StreamPayload>;
}

function describeError(error: unknown): { name: string; message: string } {
  const typed = error as Error;
  return { name: typed.name, message: String(typed.message) };
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof GeoPoint) return "point";
  if (typeof value === "object") return "map";
  return typeof value;
}

function expectedDecode(bytes: Uint8Array): unknown {
  try {
    const value = referenceDecode(bytes, { extensionCodec: referenceCodec });
    return { ok: true, kind: kindOf(value), value: describeValue(value) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function expectedMulti(bytes: Uint8Array): unknown {
  const values: unknown[] = [];
  try {
    for (const value of referenceDecodeMulti(bytes, { extensionCodec: referenceCodec })) {
      values.push(describeValue(value));
    }
    return { values };
  } catch (error) {
    return { values, error: describeError(error) };
  }
}

async function* threeByteChunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 3) {
    yield bytes.subarray(offset, Math.min(offset + 3, bytes.length));
  }
}

async function expectedStream(bytes: Uint8Array): Promise<unknown> {
  const values: unknown[] = [];
  try {
    for await (const value of referenceDecodeMultiStream(threeByteChunks(bytes), {
      extensionCodec: referenceCodec,
    })) {
      values.push(describeValue(value));
    }
    return { values };
  } catch (error) {
    return { values, error: describeError(error) };
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
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
    return { binary: hex(value) };
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

async function verify(url: string): Promise<{ steps: Step[]; encodedFixtures: string[] }> {
  const steps: Step[] = [];

  const health = await fetch(`${url}/health`);
  steps.push({ name: "health", ok: health.ok && (await health.text()) === "ok" });

  const encodedFixtures: string[] = [];
  for (let i = 0; i < fixtures.length; i++) {
    const expectedBytes = referenceEncode(fixtures[i], { extensionCodec: referenceCodec });
    const responseBytes = await postBytes(`${url}/roundtrip`, expectedBytes);
    const expectedHex = hex(expectedBytes);
    const actualHex = hex(responseBytes);
    encodedFixtures.push(actualHex);
    const decodedReference = referenceDecode(expectedBytes, { extensionCodec: referenceCodec });
    const decodedResponse = referenceDecode(responseBytes, { extensionCodec: referenceCodec });
    steps.push({
      name: `roundtrip fixture ${i}`,
      ok: actualHex === expectedHex && sameValue(decodedResponse, decodedReference),
      detail: actualHex === expectedHex ? undefined : `${actualHex} != ${expectedHex}`,
    });
  }

  const fixtureBytes = new Uint8Array(await (await fetch(`${url}/fixtures`)).arrayBuffer());
  const servedFixtures = referenceDecode(fixtureBytes, { extensionCodec: referenceCodec });
  steps.push({
    name: "GET /fixtures encodes every fixture",
    ok: sameValue(servedFixtures, fixtures),
  });

  for (let i = 0; i < fixtures.length; i++) {
    const decoded = await fetch(`${url}/decode`, {
      method: "POST",
      body: referenceEncode(fixtures[i], { extensionCodec: referenceCodec }),
    }).then((response) => response.json() as Promise<{ ok: boolean; kind: string }>);
    const expectedKind = Array.isArray(fixtures[i])
      ? "array"
      : fixtures[i] === null
        ? "null"
        : fixtures[i] instanceof Date
          ? "date"
          : fixtures[i] instanceof GeoPoint
            ? "point"
            : typeof fixtures[i] === "object"
              ? "map"
              : typeof fixtures[i];
    steps.push({
      name: `POST /decode fixture ${i}`,
      ok: decoded.ok && decoded.kind === expectedKind,
    });
  }

  const jsonPayload = {
    request: "encode through JSON",
    count: 3,
    values: [1, 2.5, true, null, "text"],
    nested: { a: { b: ["c"] } },
  };
  const encodedResponse = await fetch(`${url}/encode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(jsonPayload),
  });
  const encodedBody = new Uint8Array(await encodedResponse.arrayBuffer());
  steps.push({
    name: "POST /encode",
    ok: hex(encodedBody) === hex(referenceEncode(jsonPayload)),
  });

  const fixtureMessages = fixtures.map((value) =>
    referenceEncode(value, { extensionCodec: referenceCodec })
  );
  const streamedValues = await postStream(url, concatBytes(fixtureMessages));
  steps.push({
    name: "POST /stream decodes every consecutive message",
    ok: JSON.stringify(streamedValues.values) === JSON.stringify(fixtures.map(describeValue)),
  });

  const truncatedTail = fixtureMessages[fixtureMessages.length - 1];
  const truncatedBody = concatBytes([
    ...fixtureMessages.slice(0, -1),
    truncatedTail.subarray(0, truncatedTail.length - 1),
  ]);
  const truncatedValues = await postStream(url, truncatedBody);
  steps.push({
    name: "POST /stream delivers complete messages before a truncated tail",
    ok: JSON.stringify(truncatedValues.values) ===
      JSON.stringify(fixtures.slice(0, -1).map(describeValue)),
  });

  const emptyValues = await postStream(url, new Uint8Array(0));
  steps.push({
    name: "POST /stream empty body yields no messages",
    ok: emptyValues.values.length === 0 && emptyValues.error === undefined,
  });

  for (const [name, bytes] of malformedCases) {
    const body = bytes as Uint8Array<ArrayBuffer>;

    const decoded = await fetch(`${url}/decode`, { method: "POST", body }).then(
      (response) => response.json() as Promise<unknown>,
    );
    const expectedDecoded = expectedDecode(body);
    steps.push({
      name: `malformed /decode: ${name}`,
      ok: JSON.stringify(decoded) === JSON.stringify(expectedDecoded),
      detail: JSON.stringify(decoded) === JSON.stringify(expectedDecoded)
        ? undefined
        : `${JSON.stringify(decoded)} != ${JSON.stringify(expectedDecoded)}`,
    });

    const multi = await fetch(`${url}/multi`, { method: "POST", body }).then(
      (response) => response.json() as Promise<unknown>,
    );
    const expectedMultiOutcome = expectedMulti(body);
    steps.push({
      name: `malformed /multi: ${name}`,
      ok: JSON.stringify(multi) === JSON.stringify(expectedMultiOutcome),
      detail: JSON.stringify(multi) === JSON.stringify(expectedMultiOutcome)
        ? undefined
        : `${JSON.stringify(multi)} != ${JSON.stringify(expectedMultiOutcome)}`,
    });

    const streamed = await postStream(url, body);
    const expectedStreamOutcome = await expectedStream(body);
    steps.push({
      name: `malformed /stream: ${name}`,
      ok: JSON.stringify(streamed) === JSON.stringify(expectedStreamOutcome),
      detail: JSON.stringify(streamed) === JSON.stringify(expectedStreamOutcome)
        ? undefined
        : `${JSON.stringify(streamed)} != ${JSON.stringify(expectedStreamOutcome)}`,
    });
  }

  const corruptedTail = concatBytes([
    fixtureMessages[0],
    fixtureMessages[1].subarray(0, fixtureMessages[1].length - 2),
  ]);
  const corruptedValues = await postStream(url, corruptedTail);
  const expectedCorrupted = await expectedStream(corruptedTail);
  steps.push({
    name: "POST /stream reports the failure after complete messages",
    ok: JSON.stringify(corruptedValues) === JSON.stringify(expectedCorrupted),
    detail: JSON.stringify(corruptedValues) === JSON.stringify(expectedCorrupted)
      ? undefined
      : `${JSON.stringify(corruptedValues)} != ${JSON.stringify(expectedCorrupted)}`,
  });

  return { steps, encodedFixtures };
}

async function run(variant: "baseline" | "replacement") {
  const dir = await makeApp(variant);
  const server = await startServer(dir);
  try {
    return await verify(server.url);
  } finally {
    server.stop();
  }
}

const hashesBefore = await sourceHashes();
const baseline = await run("baseline");
const replacement = await run("replacement");
const hashesAfter = await sourceHashes();
await rm(copyDir("baseline"), { recursive: true, force: true });
await rm(copyDir("replacement"), { recursive: true, force: true });

const sourcesUnchanged = JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter);
const baselineOk = baseline.steps.every((step) => step.ok);
const replacementOk = replacement.steps.every((step) => step.ok);
const identical =
  JSON.stringify(baseline.steps) === JSON.stringify(replacement.steps) &&
  JSON.stringify(baseline.encodedFixtures) === JSON.stringify(replacement.encodedFixtures);

const report = {
  sourcesUnchanged,
  sourceHashes: hashesAfter,
  baselineOk,
  replacementOk,
  identical,
  steps: replacement.steps.filter((step) => !step.ok),
  encodedFixtures: replacement.encodedFixtures,
};

console.log(JSON.stringify(report, null, 2));

if (!sourcesUnchanged || !baselineOk || !replacementOk || !identical) {
  process.exitCode = 1;
}
