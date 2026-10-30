import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

/**
 * The Bun server owns every WebSocket frame and both browser endpoints, so a
 * Vite dev page must reach them through the backend rather than answering
 * them itself. `/ws` would otherwise hang in CONNECTING behind Vite's own
 * socket, and the interface would never leave `Connecting`.
 */
const backend = process.env.DEVBOARD_BACKEND ?? "http://127.0.0.1:8080";

/** Forwarded without `changeOrigin`: the backend's Origin check compares the
 * browser's origin with the Host it receives, and both name the dev server. */
const backendProxy = {
  "/ws": { target: backend, ws: true },
  "/api": { target: backend },
};

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: { proxy: backendProxy },
  preview: { proxy: backendProxy },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 12000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("monaco-editor")) return "monaco";
          if (id.includes("@xterm")) return "xterm";
          return undefined;
        },
      },
    },
  },
});
