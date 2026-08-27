# rtms-sample
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY transcript/send_transcript_to_openrouter_js/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi
COPY transcript/send_transcript_to_openrouter_js ./

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "index.js"]
