/**
 * Runs the client's rune modules and components under `bun test`. Bun
 * transpiles TypeScript but leaves `$state` calls untouched, so each
 * `.svelte.ts` module is stripped and compiled with Svelte's module compiler,
 * and each `.svelte` component is preprocessed and compiled for the client
 * before it is evaluated.
 *
 * Bun resolves the bare `svelte` import to the server entry, where `mount` is
 * unavailable. The client entry is resolved from the Svelte package itself and
 * installed as the module mock so component tests can mount.
 */
import { plugin } from "bun";
import { beforeEach, mock } from "bun:test";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreNativeRuntime } from "./native-network";

// A DOM test registers happy-dom at module load and leaves its `Response`,
// `AbortSignal`, timers, and `location` in place. Bun's fetch and Bun.serve
// only accept the native objects, and a test that installs its own `location`
// must still be able to replace happy-dom's. Every test starts from the
// captured runtime.
beforeEach(() => {
  restoreNativeRuntime();
});

// One DOM document for the whole worker run.
//
// Svelte's client runtime binds its DOM operations once, on the first mount:
// `init_operations` captures `window`, `document`, and the `firstChild` and
// `nextSibling` getters from the then-current window and never re-reads them.
// A component's compiled template caches the nodes it parsed on that first
// render too. A test file that unregisters happy-dom on the way out closes that
// window, and the next file mounts into a second document: the runtime keeps
// mutating and walking nodes through the closed one. A branch swap then inserts
// the incoming branch but never removes the outgoing one (a filed notification
// keeps its stale disabled File issue button, and the Discover Overview keeps
// its Start control after the run becomes active).
//
// Holding the first document for the run keeps every cached template and every
// captured getter pointed at the live document. `unregister` still empties the
// body, so one file's rendered markup never reaches the next, but it leaves the
// window open for the rest of the worker.
GlobalRegistrator.unregister = async () => {
  globalThis.document?.body?.replaceChildren();
};

const transpiler = new Bun.Transpiler({ loader: "ts" });

const sveltePackage = fileURLToPath(import.meta.resolve("svelte/package.json"));
const svelteClientEntry = join(dirname(sveltePackage), "src", "index-client.js");
const svelteClient = await import(svelteClientEntry);
mock.module("svelte", () => svelteClient);

plugin({
  name: "svelte-runes",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const result = compileModule(transpiler.transformSync(source), {
        filename: args.path,
        generate: "client",
      });
      return { contents: result.js.code, loader: "js" };
    });
    build.onLoad({ filter: /\.svelte\.js$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const result = compileModule(source, {
        filename: args.path,
        generate: "client",
      });
      return { contents: result.js.code, loader: "js" };
    });
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const preprocessed = await preprocess(source, vitePreprocess(), { filename: args.path });
      const result = compile(preprocessed.code, {
        filename: args.path,
        generate: "client",
        css: "injected",
      });
      return { contents: result.js.code, loader: "js" };
    });
  },
});
