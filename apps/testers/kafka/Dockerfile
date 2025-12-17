FROM oven/bun:1.1-alpine

WORKDIR /app

# Copy workspace files
COPY package.json ./
COPY ../../packages/core/package.json ./packages/core/
COPY ../../packages/kafka/package.json ./packages/kafka/

# Install dependencies
RUN bun install

# Copy source
COPY . .
COPY ../../packages/core/dist ./packages/core/dist
COPY ../../packages/kafka/dist ./packages/kafka/dist

EXPOSE 3000

CMD ["bun", "run", "start"]
