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
import { mock } from "bun:test";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Bun's test worker keeps one global object alive across the files it runs, and
 * Happy DOM replaces the network, abort, and timer globals along with the DOM.
 * A file that runs beside a component test then speaks Happy DOM's fetch or
 * timer implementation instead of Bun's. Restore the runtime inside the
 * registration call itself, before any other file can capture a replacement,
 * while leaving the DOM globals Happy DOM installs in place.
 */
const nativeRuntime = {
  fetch: globalThis.fetch,
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
  File: globalThis.File,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  DOMException: globalThis.DOMException,
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  Event: globalThis.Event,
  EventTarget: globalThis.EventTarget,
  MessageEvent: globalThis.MessageEvent,
  WebSocket: globalThis.WebSocket,
  crypto: globalThis.crypto,
  performance: globalThis.performance,
  structuredClone: globalThis.structuredClone,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  queueMicrotask: globalThis.queueMicrotask,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  MessageChannel: globalThis.MessageChannel,
  MessagePort: globalThis.MessagePort,
  BroadcastChannel: globalThis.BroadcastChannel,
};
type RegisterOptions = Parameters<typeof GlobalRegistrator.register>[0];
const registerDom = GlobalRegistrator.register.bind(GlobalRegistrator);
GlobalRegistrator.register = (options?: RegisterOptions): void => {
  registerDom(options);
  Object.assign(globalThis, nativeRuntime);
  // Happy DOM installs `location` as a non-writable accessor on the global.
  // A later test that swaps `location` for its own host then silently keeps
  // Happy DOM's and connects to the wrong server, so give it the writable data
  // property a browser's global also exposes.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  if (descriptor !== undefined && descriptor.writable !== true) {
    Object.defineProperty(globalThis, "location", {
      value: globalThis.location,
      writable: true,
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
    });
  }
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
