FROM oven/bun:1.4.0-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY migrations ./migrations
# DuckDB database file lives here (single writer: run exactly one bot instance).
VOLUME ["/app/data"]
CMD ["bun", "run", "src/index.ts"]
