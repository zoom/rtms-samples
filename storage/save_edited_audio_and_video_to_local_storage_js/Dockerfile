# rtms-ai-assisted-meeting-video-editor
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /workspace/rtms-samples
COPY library/javascript /workspace/rtms-samples/library/javascript
COPY library/javascript /workspace/library/javascript
COPY storage/save_edited_audio_and_video_to_local_storage_js /workspace/rtms-samples/storage/save_edited_audio_and_video_to_local_storage_js
WORKDIR /workspace/rtms-samples/storage/save_edited_audio_and_video_to_local_storage_js
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/rtms-samples/storage/save_edited_audio_and_video_to_local_storage_js
COPY --from=dependencies --chown=node:node /workspace /workspace
USER node
EXPOSE 3000
CMD ["node", "index.js"]
