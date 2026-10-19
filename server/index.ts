import { join } from "node:path";
import { createApp } from "./app";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);
const adrDir = process.env.ADRS_DIR ?? "/repo/adrs";
const staticDir = process.env.STATIC_DIR ?? join(import.meta.dir, "..", "dist");

const server = createApp({ adrDir, staticDir, hostname, port });

console.log(`ADR interface listening on http://${hostname}:${server.port}`);
