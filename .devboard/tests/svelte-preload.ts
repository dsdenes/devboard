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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { restoreNativeRuntime } from "./native-network";

// Bun runs the suite in one module registry and one global object, so one DOM
// file's `afterAll` unregistration would tear down the document every later
// file mounts into. Keep the one registration alive for the whole run.
GlobalRegistrator.unregister = () => {};

// A DOM test registers happy-dom at module load and leaves its `Response`,
// `AbortSignal`, timers, and `location` in place. Bun's fetch and Bun.serve
// only accept the native objects, and a test that installs its own `location`
// must still be able to replace happy-dom's. Every test starts from the
// captured runtime.
beforeEach(() => {
  restoreNativeRuntime();
});

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
