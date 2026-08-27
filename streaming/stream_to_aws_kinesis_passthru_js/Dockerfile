# rtms-sample
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ pkg-config libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY streaming/stream_to_aws_kinesis_passthru_js/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi
COPY streaming/stream_to_aws_kinesis_passthru_js ./

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "index.js"]
