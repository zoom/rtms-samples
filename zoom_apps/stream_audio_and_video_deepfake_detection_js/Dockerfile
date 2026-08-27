# rtms-stream-audio-video-deepfake-detection
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /workspace/rtms-samples
COPY library/javascript /workspace/rtms-samples/library/javascript
COPY library/javascript /workspace/library/javascript
COPY zoom_apps/stream_audio_and_video_deepfake_detection_js /workspace/rtms-samples/zoom_apps/stream_audio_and_video_deepfake_detection_js
WORKDIR /workspace/rtms-samples/zoom_apps/stream_audio_and_video_deepfake_detection_js
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/rtms-samples/zoom_apps/stream_audio_and_video_deepfake_detection_js
COPY --from=dependencies --chown=node:node /workspace /workspace
USER node
EXPOSE 5050
CMD ["node", "index.js"]
