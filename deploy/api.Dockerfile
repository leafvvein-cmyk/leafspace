FROM node:22.22.1-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=8787

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/client/package.json apps/client/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --workspace @diary/api --workspace @diary/contracts \
    && npm cache clean --force

COPY apps/api apps/api
COPY packages/contracts packages/contracts
RUN mkdir -p /var/lib/diary/assets /var/lib/diary/exports \
    && chown -R node:node /var/lib/diary

USER node
EXPOSE 8787
CMD ["node", "apps/api/src/server.js"]
