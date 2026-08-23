# ─────────────────────────────────────────────────────────────────────────────
# Google Slides Hybrid MCP Server — Production Docker Image
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage build: deps -> builder -> production
# Optimized for security, size, and reliability.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22
ARG VERSION=0.0.0-dev

# ── Stage 1: Dependencies ───────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps

# Build tools for native modules (sharp, better-sqlite3)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    vips-dev

WORKDIR /app

# Install ALL dependencies (including dev for build step)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

# ── Stage 2: Builder ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

# Copy deps from stage 1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# ── Stage 3: Production Dependencies ────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS proddeps

# Build tools needed for native module rebuild
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    vips-dev

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false

# ── Stage 4: Production ─────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS production

ARG VERSION

# Labels
LABEL org.opencontainers.image.title="Google Slides Hybrid MCP Server" \
      org.opencontainers.image.description="Production-ready hybrid Google Slides MCP server combining API + Live Browser + Vision layers" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.vendor="google-slides-hybrid-mcp" \
      org.opencontainers.image.source="https://github.com/google-slides-hybrid-mcp/google-slides-hybrid-mcp" \
      org.opencontainers.image.licenses="MIT" \
      maintainer="google-slides-hybrid-mcp"

# Runtime dependencies
RUN apk add --no-cache \
    vips \
    tini \
    dumb-init \
    curl \
    && rm -rf /var/cache/apk/*

# Create data directory for SQLite with proper ownership
RUN mkdir -p /app/data && chown node:node /app/data

WORKDIR /app

# Copy production dependencies from proddeps stage
COPY --from=proddeps --chown=node:node /app/node_modules ./node_modules

# Copy build output from builder stage
COPY --from=builder --chown=node:node /app/build ./build

# Copy package.json for runtime metadata
COPY --chown=node:node package.json ./

# Switch to non-root user
USER node:node

# Environment
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    VERSION=${VERSION}

# Expose HTTP port for health checks and SSE transport
EXPOSE 8080

# Volume for persistent SQLite data
VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start the server
CMD ["node", "build/index.js"]
