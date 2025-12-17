FROM oven/bun:1.1

WORKDIR /app

# Copy workspace files
COPY package.json bun.lockb ./
COPY packages/core/package.json packages/core/
COPY packages/core/dist packages/core/dist/
COPY packages/memory/package.json packages/memory/
COPY packages/memory/dist packages/memory/dist/
COPY apps/testers/memory/package.json apps/testers/memory/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY apps/testers/memory/src apps/testers/memory/src/
COPY apps/testers/memory/tsconfig.json apps/testers/memory/

WORKDIR /app/apps/testers/memory

EXPOSE 3000

CMD ["bun", "src/index.ts"]
