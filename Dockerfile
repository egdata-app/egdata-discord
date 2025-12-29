FROM oven/bun:1 AS base
WORKDIR /app

# Install curl for Coolify health checks and pnpm installation
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN curl -fsSL https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Install dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod

# Copy source files
COPY . .

EXPOSE 3000

# Deploy commands and start the bot with Bun runtime
CMD ["bun", "run", "deploy:start"]
