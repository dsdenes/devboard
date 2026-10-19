import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { readRecords } from "./records";

export interface AppOptions {
  adrDir: string;
  staticDir: string;
  hostname: string;
  port: number;
}

export function createApp(options: AppOptions) {
  const staticRoot = resolve(options.staticDir);

  return Bun.serve({
    hostname: options.hostname,
    port: options.port,

    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(request)) return;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = resolve(staticRoot, relative);
      if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) {
        return new Response("Not Found", { status: 404 });
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response("Not Found", { status: 404 });
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }

      return new Response(request.method === "HEAD" ? null : file, {
        headers: { "Content-Type": file.type },
      });
    },

    websocket: {
      async message(ws, message) {
        let command: unknown;
        try {
          command = JSON.parse(String(message));
        } catch {
          return;
        }

        if (
          typeof command !== "object" ||
          command === null ||
          !("type" in command) ||
          command.type !== "listRecords"
        ) {
          return;
        }

        try {
          const list = await readRecords(options.adrDir);
          ws.send(JSON.stringify({ type: "records", ...list }));
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      },
    },
  });
}
