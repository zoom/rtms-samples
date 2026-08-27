# rtms-sample
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev libgif-dev librsvg2-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY library/javascript /library/javascript
COPY video/detect_object_using_tensorflow_js/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi
COPY video/detect_object_using_tensorflow_js ./

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies --chown=node:node /library /library
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "index.js"]
