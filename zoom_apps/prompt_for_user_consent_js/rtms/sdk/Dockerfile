# RTMS SDK media receiver used by the consent sample.
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY zoom_apps/prompt_for_user_consent_js/rtms/sdk/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi
COPY zoom_apps/prompt_for_user_consent_js/rtms/sdk ./

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 3002
CMD ["node", "index.js"]
