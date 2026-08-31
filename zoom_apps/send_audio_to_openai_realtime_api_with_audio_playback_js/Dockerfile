# send-audio-to-openai-realtime-api-with-audio-playback
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /workspace/rtms-samples
COPY library/javascript /workspace/rtms-samples/library/javascript
COPY library/javascript /workspace/library/javascript
COPY zoom_apps/send_audio_to_openai_realtime_api_with_audio_playback_js /workspace/rtms-samples/zoom_apps/send_audio_to_openai_realtime_api_with_audio_playback_js
WORKDIR /workspace/rtms-samples/zoom_apps/send_audio_to_openai_realtime_api_with_audio_playback_js
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/rtms-samples/zoom_apps/send_audio_to_openai_realtime_api_with_audio_playback_js
COPY --from=dependencies --chown=node:node /workspace /workspace
USER node
EXPOSE 5050
CMD ["node", "index.js"]
