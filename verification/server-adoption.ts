import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  decode as referenceDecode,
  encode as referenceEncode,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";
import { fixtures, GeoPoint, installExtensionCodec } from "../examples/server/fixtures.ts";

const referenceCodec = new ReferenceExtensionCodec();
installExtensionCodec(referenceCodec);

const root = dirname(import.meta.dir);
const appDir = join(root, "examples/server");
const packageFile = join(appDir, "package.json");
const sourceFiles = ["server.ts", "fixtures.ts"];
const ORIGINAL_SPEC = "npm:@msgpack/msgpack@3.1.3";
const REPLACEMENT_SPEC = "file:../../packages/msgpack";

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

async function useDependency(spec: string): Promise<void> {
  await rm(join(appDir, "node_modules"), { recursive: true, force: true });
  await rm(join(appDir, "bun.lock"), { force: true });
  const manifest = JSON.parse(await readFile(packageFile, "utf8"));
  manifest.dependencies["@msgpack/msgpack"] = spec;
  await writeFile(packageFile, JSON.stringify(manifest, null, 2) + "\n");
  const install = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (install.exitCode !== 0) {
    throw new Error(`bun install failed: ${install.stderr.toString()}`);
  }
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

async function startServer(): Promise<{ url: string; stop: () => void }> {
  const process = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: appDir,
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

  return { steps, encodedFixtures };
}

async function run(spec: string) {
  await useDependency(spec);
  const server = await startServer();
  try {
    return await verify(server.url);
  } finally {
    server.stop();
  }
}

const hashesBefore = await sourceHashes();
const baseline = await run(ORIGINAL_SPEC);
const replacement = await run(REPLACEMENT_SPEC);
const hashesAfter = await sourceHashes();

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
