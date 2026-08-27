# A simple sample to preview the RTMS Node.js SDK
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY library/javascript /library/javascript
COPY boilerplate/working_sdk/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi
COPY boilerplate/working_sdk ./

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /library /library
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "index.js"]
