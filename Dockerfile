# syntax=docker/dockerfile:1.7

# Multi-arch base for Raspberry Pi (ARM64/ARMv7) and x86_64
FROM --platform=$BUILDPLATFORM node:20-alpine AS base
WORKDIR /app

# Install dependencies only when needed
FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Build minimal runtime image
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Expose port and start
EXPOSE 3000
CMD ["node", "."]


