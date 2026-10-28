/**
 * Runs the client's rune modules under `bun test`. Bun transpiles TypeScript
 * but leaves `$state` calls untouched, so each `.svelte.ts` module is stripped
 * and compiled with Svelte's module compiler before it is evaluated.
 */
import { plugin } from "bun";
import { compileModule } from "svelte/compiler";

const transpiler = new Bun.Transpiler({ loader: "ts" });

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
  },
});
