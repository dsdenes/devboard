import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  encode as referenceEncode,
  ExtensionCodec as ReferenceExtensionCodec,
} from "msgpack-javascript-original";

/**
 * Loads msgpack-javascript into a plain browser page through one script
 * reference and compares the original library with the replacement. The page
 * is the same bytes in both variants except for that one reference: no
 * bundler, no build step, and no change to the page's own code.
 */

class GeoPoint {
  constructor(
    public lat: number,
    public lon: number,
  ) {}
}

const referenceCodec = new ReferenceExtensionCodec();
referenceCodec.register({
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
  decode(data: Uint8Array): unknown {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return new GeoPoint(view.getFloat64(0), view.getFloat64(8));
  },
});

const root = dirname(import.meta.dir);
const pageFile = join(root, "examples/browser-script/page.html");
const originalBundle = join(
  root,
  "node_modules/msgpack-javascript-original/dist.umd/msgpack.min.js",
);
const replacementBundle = join(root, "packages/msgpack/lib/msgpack.js");
const workDir = join(root, ".tmp", "plain-script");
const CHROME = process.env.CHROME_PATH ?? "google-chrome";
const PLACEHOLDER = "__MSGPACK_SCRIPT__";
const BASELINE_SCRIPT = "/original/msgpack.min.js";
const REPLACEMENT_SCRIPT = "/replacement/msgpack.js";

const SOURCE_TYPES: Record<string, string> = {
  encode: "function",
  decode: "function",
  decodeMulti: "function",
  decodeAsync: "function",
  decodeArrayStream: "function",
  decodeMultiStream: "function",
  Decoder: "function",
  Encoder: "function",
  DecodeError: "function",
  ExtensionCodec: "function",
  ExtData: "function",
  EXT_TIMESTAMP: "number",
  encodeDateToTimeSpec: "function",
  encodeTimeSpecToTimestamp: "function",
  decodeTimestampToTimeSpec: "function",
  encodeTimestampExtension: "function",
  decodeTimestampExtension: "function",
};

interface EntryPoint {
  name: string;
  type: string;
}

interface CaseResult {
  name: string;
  hex: string;
  decoded: unknown;
  matchesInput: boolean;
}

interface OptionResult {
  name: string;
  hex: string;
  decoded: unknown;
}

interface TimestampResult {
  ms: number;
  spec: { sec: number; nsec: number };
  payload: string;
  decoded: unknown;
  specRoundTrip: { sec: number; nsec: number };
  encodedThroughSpec: string;
  isTimestampType: number;
}

interface FailureResult {
  name: string;
  ok: boolean;
  value?: unknown;
  error?: { type: string; message: string };
}

interface PageResult {
  global: { name: string; entryPoints: EntryPoint[] };
  cases: CaseResult[];
  options: { encode: OptionResult[]; decode: OptionResult[] };
  timestamps: TimestampResult[];
  classApi: { hex: string; decoded: unknown; matchesInput: boolean; moduleHexSame: boolean };
  multi: { hex: string; values: unknown[] };
  extData: unknown;
  failures: FailureResult[];
}

function normalizeReference(html: string): string {
  return html.replace(/(<script src=")[^"]*("><\/script>)/, "$1__SRC__$2");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function serve(
  pages: Record<string, string>,
  requested: string[],
): { url: string; stop: () => void } {
  const scripts: Record<string, string> = {
    [BASELINE_SCRIPT]: originalBundle,
    [REPLACEMENT_SCRIPT]: replacementBundle,
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requested.push(pathname);
      if (pathname in pages) {
        return new Response(pages[pathname], {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (pathname in scripts) {
        return new Response(Bun.file(scripts[pathname]), {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

async function loadInBrowser(url: string): Promise<PageResult> {
  // Relative paths keep Chrome's Unix socket below the kernel's length limit.
  await mkdir(join(root, ".tmp", "chrome"), { recursive: true });
  await mkdir(join(root, ".tmp", "tmp"), { recursive: true });
  const chrome = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--user-data-dir=.tmp/chrome",
      "--virtual-time-budget=5000",
      "--dump-dom",
      url,
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, TMPDIR: ".tmp/tmp" },
    },
  );
  const timer = setTimeout(() => chrome.kill(), 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(chrome.stdout).text(),
    new Response(chrome.stderr).text(),
    chrome.exited,
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new Error(`chrome failed: ${stderr}`);
  }
  const match = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);
  if (!match) {
    throw new Error(`no result element in DOM: ${stdout.slice(0, 500)}`);
  }
  const text = match[1]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
  if (text === "running") {
    throw new Error("browser page did not finish");
  }
  return JSON.parse(text) as PageResult;
}

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });

const template = await readFile(pageFile, "utf8");
const templateHashBefore = await sha256File(pageFile);

const references = template.split(`<script src="${PLACEHOLDER}"></script>`).length - 1;
const otherScriptTags = (template.match(/<script src=/g) ?? []).length - references;
const moduleScripts = (template.match(/<script[^>]*type="module"/g) ?? []).length;
const baselineHtml = template.replace(`<script src="${PLACEHOLDER}">`, `<script src="${BASELINE_SCRIPT}">`);
const replacementHtml = template.replace(
  `<script src="${PLACEHOLDER}">`,
  `<script src="${REPLACEMENT_SCRIPT}">`,
);

const onlyReferenceDiffers =
  baselineHtml !== replacementHtml && normalizeReference(baselineHtml) === normalizeReference(replacementHtml);

await writeFile(join(workDir, "baseline.html"), baselineHtml);
await writeFile(join(workDir, "replacement.html"), replacementHtml);

const bundle = await readFile(replacementBundle, "utf8");
const bundleIsPlainScript =
  !/^\s*import\s/m.test(bundle) &&
  !/^\s*export\s/m.test(bundle) &&
  !/\brequire\s*\(/.test(bundle) &&
  !bundle.includes(PLACEHOLDER) &&
  /root\.MessagePack\s*=\s*factory\(\)/.test(bundle);

const requested: string[] = [];
const server = serve(
  {
    "/baseline.html": baselineHtml,
    "/replacement.html": replacementHtml,
  },
  requested,
);
let baseline: PageResult;
let replacement: PageResult;
try {
  baseline = await loadInBrowser(`${server.url}/baseline.html`);
  replacement = await loadInBrowser(`${server.url}/replacement.html`);
} finally {
  server.stop();
}

const templateHashAfter = await sha256File(pageFile);
const pageSourceUnchanged = templateHashBefore === templateHashAfter;
const identical = JSON.stringify(baseline) === JSON.stringify(replacement);

const originalRequests = requested.filter((path) => path === BASELINE_SCRIPT).length;
const replacementRequests = requested.filter((path) => path === REPLACEMENT_SCRIPT).length;
// Each variant was opened once, so each script must have been fetched exactly
// once: the baseline page cannot have used the replacement and vice versa.
const eachPageLoadedItsOwnScript = originalRequests === 1 && replacementRequests === 1;

const entryPointsOk =
  replacement.global.name === "MessagePack" &&
  Object.entries(SOURCE_TYPES).every(([name, type]) => {
    const entry = replacement.global.entryPoints.find((item) => item.name === name);
    return entry?.type === type;
  }) &&
  replacement.global.entryPoints.filter((item) => item.type === "undefined").length === 0;

const requiredCases = [
  "unicode string",
  "binary",
  "array",
  "map",
  "nested",
  "timestamp recent",
  "timestamp before epoch",
  "custom point",
  "extensions nested",
];
const caseNames = replacement.cases.map((item) => item.name);
const casesOk =
  requiredCases.every((name) => caseNames.includes(name)) &&
  replacement.cases.every(
    (item) => typeof item.hex === "string" && item.hex.length > 0 && item.matchesInput === true,
  );

const optionsOk =
  replacement.options.encode.length >= 6 &&
  replacement.options.decode.length >= 6 &&
  replacement.options.encode.every((item) => item.hex.length > 0 && item.decoded !== undefined) &&
  replacement.options.decode.every((item) => item.hex.length > 0 && item.decoded !== undefined);

const timestampsOk =
  replacement.timestamps.length === 3 &&
  replacement.timestamps.every(
    (item) =>
      item.isTimestampType === -1 &&
      item.payload.length > 0 &&
      item.decoded !== undefined &&
      item.specRoundTrip.sec === item.spec.sec &&
      item.specRoundTrip.nsec === item.spec.nsec &&
      item.encodedThroughSpec === item.payload,
  ) &&
  replacement.timestamps[0]?.payload.length === 8 &&
  replacement.timestamps[1]?.payload.length === 16 &&
  replacement.timestamps[2]?.payload.length === 24;

const classOk =
  replacement.classApi.matchesInput === true &&
  replacement.classApi.moduleHexSame === true &&
  replacement.classApi.hex.length > 0;

const multiOk =
  replacement.multi.values.length === 3 &&
  JSON.stringify(replacement.multi.values[1]) === JSON.stringify("two");

const extDataOk =
  JSON.stringify(replacement.extData) === JSON.stringify({ __ext: 127, data: "2a" });

const failureTypes = new Set(replacement.failures.map((item) => item.error?.type));
const failuresOk =
  replacement.failures.length >= 2 &&
  replacement.failures.every((item) => item.ok === false) &&
  replacement.failures.every(
    (item) => typeof item.error?.type === "string" && (item.error?.message.length ?? 0) > 0,
  ) &&
  failureTypes.has("RangeError") &&
  failureTypes.has("DecodeError");

const expectedHex: Record<string, string> = {
  "unicode string": hexOf(referenceEncode("héllo wörld — 日本語 ✓ 😀")),
  binary: hexOf(referenceEncode(new Uint8Array([0, 1, 2, 3, 254, 255]))),
  map: hexOf(referenceEncode({ id: 1, name: "widget", ok: true, tags: ["a", "b"] })),
  "timestamp recent": hexOf(referenceEncode(new Date(1700000000123))),
  "custom point": hexOf(referenceEncode(new GeoPoint(12.5, -7.25), { extensionCodec: referenceCodec })),
};
const hexMatchesReference = Object.entries(expectedHex).every(([name, hex]) => {
  const item = replacement.cases.find((candidate) => candidate.name === name);
  return item?.hex === hex;
});

const report = {
  onlyReferenceDiffers,
  scriptReferences: references,
  otherScriptTags,
  moduleScripts,
  bundleIsPlainScript,
  pageSourceUnchanged,
  identical,
  originalRequests,
  replacementRequests,
  entryPointsOk,
  casesOk,
  optionsOk,
  timestampsOk,
  classOk,
  multiOk,
  extDataOk,
  failuresOk,
  hexMatchesReference,
  cases: replacement.cases.length,
  encodeOptions: replacement.options.encode.map((item) => item.name),
  decodeOptions: replacement.options.decode.map((item) => item.name),
  failures: replacement.failures.map((item) => ({
    name: item.name,
    ok: item.ok,
    error: item.error,
  })),
};

console.log(JSON.stringify(report, null, 2));

if (
  references !== 1 ||
  otherScriptTags !== 0 ||
  moduleScripts !== 0 ||
  !onlyReferenceDiffers ||
  !bundleIsPlainScript ||
  !pageSourceUnchanged ||
  !identical ||
  !eachPageLoadedItsOwnScript ||
  !entryPointsOk ||
  !casesOk ||
  !optionsOk ||
  !timestampsOk ||
  !classOk ||
  !multiOk ||
  !extDataOk ||
  !failuresOk ||
  !hexMatchesReference
) {
  process.exitCode = 1;
}
