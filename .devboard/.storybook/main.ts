import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/svelte-vite";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..");

const config: StorybookConfig = {
  stories: ["../../stories/**/*.stories.ts"],
  framework: {
    name: "@storybook/svelte-vite",
    options: {},
  },
  // The DTCG projection lives at the repository root (design/tokens.json), outside this
  // package, so the dev server must be allowed to read it.
  async viteFinal(viteConfig) {
    const server = (viteConfig.server ??= {});
    const fs = (server.fs ??= {});
    fs.allow = [...new Set([...(fs.allow ?? []), appRoot, repoRoot])];
    return viteConfig;
  },
};

export default config;
