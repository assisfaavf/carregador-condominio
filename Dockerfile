# Build tools are needed here even when the platform sets NODE_ENV=production.
FROM node:24-alpine AS frontend-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:24-alpine AS backend-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine AS production
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=backend-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json config.js server.js tuya_api.js ./
COPY --chown=node:node db/ ./db/
COPY --chown=node:node repositories/ ./repositories/
COPY --chown=node:node services/ ./services/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node migrations/ ./migrations/
COPY --chown=node:node public/ ./public/
COPY --from=frontend-build --chown=node:node /app/web/dist ./web/dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
