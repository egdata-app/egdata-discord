FROM node:22-slim AS deps
WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate

# Install dependencies
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM oven/bun:1 AS runtime
WORKDIR /app

# Install curl for Coolify health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source files
COPY . .

EXPOSE 3000

# Deploy commands and start the bot with Bun runtime
CMD ["bun", "run", "deploy:start"]
