import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encode as referenceEncode } from "msgpack-javascript-original";
import { fixtures } from "../examples/browser/src/fixtures.ts";

const root = dirname(import.meta.dir);
const appDir = join(root, "examples/browser");
const packageFile = join(appDir, "package.json");
const sourceFiles = ["index.html", "src/main.ts", "src/fixtures.ts"];
const ORIGINAL_SPEC = "npm:@msgpack/msgpack@3.1.3";
const REPLACEMENT_SPEC = "file:../../packages/msgpack";
const CHROME = process.env.CHROME_PATH ?? "google-chrome";

async function sourceHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of sourceFiles) {
    hashes[file] = createHash("sha256").update(await readFile(join(appDir, file))).digest("hex");
  }
  return hashes;
}

async function useDependency(spec: string): Promise<void> {
  await rm(join(appDir, "node_modules"), { recursive: true, force: true });
  await rm(join(appDir, "bun.lock"), { force: true });
  const manifest = JSON.parse(await readFile(packageFile, "utf8"));
  manifest.dependencies["@msgpack/msgpack"] = spec;
  await writeFile(packageFile, JSON.stringify(manifest, null, 2) + "\n");
  const install = Bun.spawnSync(["bun", "install", "--silent"], { cwd: appDir, stdout: "pipe", stderr: "pipe" });
  if (install.exitCode !== 0) {
    throw new Error(`bun install failed: ${install.stderr.toString()}`);
  }
}

async function build(outDir: string): Promise<void> {
  await rm(join(appDir, outDir), { recursive: true, force: true });
  const result = Bun.spawnSync(["bunx", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`vite build failed: ${result.stderr.toString()}${result.stdout.toString()}`);
  }
}

function serve(directory: string): { url: string; stop: () => void } {
  const base = join(appDir, directory);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      const file = Bun.file(join(base, relative));
      if (!file.size) {
        return new Response("not found", { status: 404 });
      }
      return new Response(file);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  };
}

async function loadInBrowser(url: string): Promise<unknown> {
  const chrome = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--virtual-time-budget=5000",
      "--dump-dom",
      url,
    ],
    { stdout: "pipe", stderr: "pipe" },
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
  const dom = stdout;
  const match = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
  if (!match) {
    throw new Error(`no result element in DOM: ${dom.slice(0, 500)}`);
  }
  const text = match[1]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
  if (text === "running") {
    throw new Error("browser application did not finish");
  }
  return JSON.parse(text);
}

interface BrowserCase {
  name: string;
  hex: string;
  decoded: unknown;
  matchesInput: boolean;
}

interface BrowserResult {
  moduleEncodeHex: string;
  sharedRefSame: boolean;
  classDecodeSame: boolean;
  cases: BrowserCase[];
}

async function run(spec: string, outDir: string): Promise<BrowserResult> {
  await useDependency(spec);
  await build(outDir);
  const server = serve(outDir);
  try {
    return (await loadInBrowser(server.url)) as BrowserResult;
  } finally {
    server.stop();
  }
}

const hashesBefore = await sourceHashes();
const baseline = await run(ORIGINAL_SPEC, "dist-baseline");
const replacement = await run(REPLACEMENT_SPEC, "dist-replacement");
const hashesAfter = await sourceHashes();

const sourcesUnchanged = JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter);
const identical = JSON.stringify(baseline) === JSON.stringify(replacement);

const expected: Record<string, string> = {};
for (const [name, value] of fixtures) {
  expected[name] = Buffer.from(referenceEncode(value)).toString("hex");
}
const hexMatchesReference = replacement.cases.every((item) => expected[item.name] === item.hex);
const allRoundTrip = replacement.cases.every((item) => item.matchesInput);
const classApi =
  replacement.sharedRefSame &&
  replacement.classDecodeSame &&
  replacement.moduleEncodeHex === expected["small map"] &&
  baseline.moduleEncodeHex === replacement.moduleEncodeHex;

const report = {
  sourcesUnchanged,
  sourceHashes: hashesAfter,
  identical,
  hexMatchesReference,
  allRoundTrip,
  classApi,
  cases: replacement.cases.map((item) => item.name),
  baselineModuleEncodeHex: baseline.moduleEncodeHex,
  replacementModuleEncodeHex: replacement.moduleEncodeHex,
};

console.log(JSON.stringify(report, null, 2));

if (!sourcesUnchanged || !identical || !hexMatchesReference || !allRoundTrip || !classApi) {
  process.exitCode = 1;
}
