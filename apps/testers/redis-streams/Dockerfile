FROM oven/bun:1.1

WORKDIR /app

# Copy workspace files
COPY package.json bun.lockb ./
COPY packages/core/package.json packages/core/
COPY packages/core/dist packages/core/dist/
COPY packages/redis-streams/package.json packages/redis-streams/
COPY packages/redis-streams/dist packages/redis-streams/dist/
COPY apps/testers/redis-streams/package.json apps/testers/redis-streams/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY apps/testers/redis-streams/src apps/testers/redis-streams/src/
COPY apps/testers/redis-streams/tsconfig.json apps/testers/redis-streams/

WORKDIR /app/apps/testers/redis-streams

EXPOSE 3001

CMD ["bun", "src/index.ts"]
