FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY src/ src/
COPY data/alias-map.example.json data/alias-map.example.json

# Default environment
ENV RECALLNEST_API_PORT=4318
ENV RECALLNEST_UI_PORT=4317

EXPOSE 4318 4317

# MCP stdio mode (default) — Glama introspection connects here
# Override with CMD ["bun","run","src/api-server.ts"] for HTTP mode
CMD ["bun", "run", "src/mcp-server.ts"]
