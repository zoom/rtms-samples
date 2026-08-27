# Consent coordination API and Socket.IO server.
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY zoom_apps/prompt_for_user_consent_js/backend/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi
COPY zoom_apps/prompt_for_user_consent_js/backend ./

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
