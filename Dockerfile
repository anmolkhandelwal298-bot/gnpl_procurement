# Grainspan Procurement Portal — production image (Next.js server + in-process scheduler / realtime listener)
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

# Runtime image. Boots through scripts/boot.ts, which (when MIGRATION_DATABASE_URL is set) migrates the database, optionally creates the
# first admin / demo data, then starts the web server as the restricted database role. With only DATABASE_URL set it just starts the server.
FROM build AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN useradd --system --uid 1001 --no-create-home app && chown -R app:app /app/.next
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "scripts/boot.ts"]
