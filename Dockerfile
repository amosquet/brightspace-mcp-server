FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    D2L_TRANSPORT=http \
    D2L_HTTP_HOST=0.0.0.0 \
    D2L_HTTP_PORT=18765 \
    D2L_SESSION_DIR=/data/sessions \
    D2L_DOWNLOAD_ROOTS=/data/downloads \
    D2L_NO_UPDATE_CHECK=1

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && rm -rf src tsconfig.json

RUN ./node_modules/.bin/playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/sessions /data/downloads \
    && chmod 0700 /data/sessions \
    && chown -R node:node /data

USER node

EXPOSE 18765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.D2L_HTTP_PORT || process.env.PORT || 18765) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "build/index.js", "http"]
