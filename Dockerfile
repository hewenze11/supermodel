# Multi-stage build for SuperModel

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev, needed for tsc)
RUN npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install build tools for native addon rebuild in prod stage
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install all deps (better-sqlite3 requires native build; prune devDeps after)
RUN npm install && npm prune --production

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/schema.sql ./src/db/

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S supermodel -u 1001
USER supermodel

EXPOSE 11451 11435

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:11435/admin/status || exit 1

CMD ["node", "dist/index.js"]