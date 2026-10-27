FROM oven/bun:1-slim AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.html tsconfig.json vite.config.ts svelte.config.js ./
COPY lib ./lib
COPY client ./client
COPY server ./server
COPY issues ./issues
COPY watchdog ./watchdog
RUN bun run build

FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/issues ./issues
COPY --from=build /app/watchdog ./watchdog
COPY --from=build /app/lib ./lib

ENV HOST=0.0.0.0
ENV PORT=8080
ENV ADRS_DIR=/repo/adrs
ENV NODE_ENV=production

EXPOSE 8080

CMD ["bun", "run", "server/index.ts"]
