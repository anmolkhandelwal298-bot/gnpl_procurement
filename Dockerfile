# Grainspan Procurement Portal — production image (Next.js standalone server + in-process scheduler / realtime listener)
# Build:  docker build -t grainspan-procurement .
# Run  :  see docker-compose.yml and docs/DEPLOYMENT.md

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_APP_TIMEZONE is inlined into the browser bundle at build time
ARG NEXT_PUBLIC_APP_TIMEZONE=Asia/Kolkata
ENV NEXT_PUBLIC_APP_TIMEZONE=$NEXT_PUBLIC_APP_TIMEZONE
RUN npm run build

# One-shot job image: applies db/migrations and (optionally) creates the first admin. Needs the OWNER connection string.
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npx", "tsx", "scripts/migrate.ts"]

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 1001 --no-create-home app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
